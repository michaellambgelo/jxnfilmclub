"""Run an action and stream its output line by line.

Two job kinds behind one interface:

* `ProcessJob` — `node scripts/…`, spawned with **cwd = repo root**, because
  both CLIs default `--out` to the relative path `out/`. Run them from
  anywhere else and the MP4s land somewhere else.
* `ArchiveJob` — the one action with no CLI behind it: pull each approved
  clip's original audio to `out/archive/<promptId>/` before the 60-day
  lifecycle deletes it. A clip that's already gone is reported and skipped,
  never fatal — same discipline as the audiogram CLI's prompt mode.

  Archiving is **idempotent and never destructive**: a clip whose file is
  already byte-complete costs no request, and nothing here deletes or
  truncates an existing archive. The path it writes is the same one the CLIs
  read to skip a download (`archivePathFor` in scripts/lib/voices.mjs), so
  archiving a round makes every later render of it free.
"""

from __future__ import annotations

import asyncio
import os
import signal
from pathlib import Path

from ..data.wrangler import MissingObject, WranglerError, r2_get
from ..settings import Settings
from .argv import render_command


def archive_path_for(settings: Settings, prompt_id: str, clip) -> Path:
    """out/archive/<promptId>/<memberId><ext>.

    Must stay identical to `archivePathFor` in scripts/lib/voices.mjs — that
    shared location is the whole reason an archived round makes later renders
    free. Guarded by tests/test_settings.py.
    """
    suffix = Path(clip.r2_key or "").suffix or ".bin"
    return settings.archive_out / prompt_id / f"{clip.member_id}{suffix}"


class Job:
    """Something runnable that emits lines and returns an exit code."""

    command: str = ""

    async def run(self, emit) -> int:  # pragma: no cover - interface
        raise NotImplementedError

    async def cancel(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError


class ProcessJob(Job):
    def __init__(self, argv, settings: Settings) -> None:
        self.argv = list(argv)
        self.settings = settings
        self.command = render_command(self.argv, settings.repo_root)
        self._proc: asyncio.subprocess.Process | None = None

    async def run(self, emit) -> int:
        emit(f"$ {self.command}")
        emit(f"  (cwd: {self.settings.repo_root})")
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self.argv,
                cwd=str(self.settings.repo_root),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env={**os.environ, "FORCE_COLOR": "0"},
                # Own process group: the node script spawns ffmpeg with
                # spawnSync, and node's default SIGTERM handling skips its
                # cleanup, so signalling node alone leaves an ffmpeg encode
                # running orphaned and the tmpdir behind. Cancel signals the
                # group.
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            emit(f"error: {exc}")
            return 127

        assert self._proc.stdout is not None
        while True:
            raw = await self._proc.stdout.readline()
            if not raw:
                break
            emit(raw.decode("utf8", "replace").rstrip("\n"))
        return await self._proc.wait()

    async def cancel(self) -> None:
        if self._proc is None or self._proc.returncode is not None:
            return
        try:
            os.killpg(os.getpgid(self._proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            # Already reaped, or no group to signal — fall back to the child.
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass


class ArchiveJob(Job):
    """Pull the approved clips of one round to disk, in submission order."""

    def __init__(self, round_, settings: Settings) -> None:
        self.round = round_
        self.settings = settings
        self.dest = settings.archive_out / round_.prompt_id
        self.command = (f"archive {len(round_.approved_clips)} approved clip(s) "
                        f"→ {self.dest}")
        self._cancelled = False

    async def run(self, emit) -> int:
        clips = self.round.approved_clips
        if not clips:
            emit(f"No approved clips for {self.round.prompt_id} — nothing to archive.")
            emit("(Approve them in the admin Voice tab first.)")
            return 0

        self.dest.mkdir(parents=True, exist_ok=True)
        emit(f"Archiving {len(clips)} approved clip(s) → {self.dest}")
        emit("Already-archived clips are reused, not re-downloaded; "
             "nothing here overwrites or deletes.")
        pulled = reused = missing = failed = 0

        for index, clip in enumerate(clips, start=1):
            if self._cancelled:
                emit("Cancelled.")
                return 130
            if not clip.r2_key:
                emit(f"  {index}. {clip.label}: no r2Key — skipped")
                failed += 1
                continue
            target = archive_path_for(self.settings, self.round.prompt_id, clip)
            emit(f"  {index}. {clip.label} → {target.name}")
            try:
                source = await asyncio.to_thread(
                    r2_get, self.settings, clip.r2_key, target,
                    expected_size=clip.size,
                )
                if source == "cache":
                    emit("     already archived — no request")
                    reused += 1
                else:
                    pulled += 1
            except MissingObject:
                # The expected day-60 state: the KV row outlived its audio.
                emit(f"     GONE — {clip.r2_key} is no longer in R2 (aged out)")
                missing += 1
            except WranglerError as exc:
                emit(f"     FAILED — {exc}")
                failed += 1

        emit("")
        emit(f"Downloaded {pulled}, already had {reused}, gone {missing}, failed {failed}.")
        if missing:
            emit("Clips auto-delete 60 days after submission — those are past it.")
        # Missing audio is an outcome, not an error; a genuine failure isn't.
        return 1 if failed else 0

    async def cancel(self) -> None:
        self._cancelled = True


def job_for(action, settings: Settings, bindings: dict, *, round_=None,
            member_id: str = "") -> Job:
    """Catalog action + bindings → the Job that carries it out."""
    from .catalog import build

    if action.id == "archive_round":
        if round_ is None:
            raise ValueError("archive_round needs a round")
        return ArchiveJob(round_, settings)
    prompt_id = round_.prompt_id if round_ is not None else ""
    argv = build(action, settings, bindings, prompt_id=prompt_id, member_id=member_id)
    return ProcessJob(argv, settings)
