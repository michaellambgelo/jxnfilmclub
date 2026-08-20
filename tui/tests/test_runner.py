"""The archive job — the one action with no CLI behind it."""

from __future__ import annotations

import pathlib
import sys

import pytest

from jxnfilm_tui.actions.runner import ArchiveJob, ProcessJob, job_for
from jxnfilm_tui.actions.catalog import BY_ID, defaults_for
from jxnfilm_tui.data.parsers import group_rounds, parse_voice_row
from jxnfilm_tui.data.wrangler import MissingObject, WranglerError
from jxnfilm_tui.settings import Settings


def _round(*specs):
    return group_rounds([
        parse_voice_row(
            f"voice:general:{member}",
            f'{{"memberId":"{member}","name":"{member.title()}","status":"{status}",'
            f'"r2Key":"voice/general/{member}.webm","size":5,'
            f'"at":"2026-08-0{i + 1}T00:00:00.000Z"}}',
        )
        for i, (member, status) in enumerate(specs)
    ])[0]


async def test_archive_says_so_when_nothing_is_approved(tmp_path):
    job = ArchiveJob(_round(("alice", "pending")), Settings(repo_root=tmp_path))
    lines = []
    assert await job.run(lines.append) == 0
    assert any("nothing to archive" in line for line in lines)
    assert any("admin Voice tab" in line for line in lines)


async def test_archive_pulls_each_approved_clip(tmp_path, monkeypatch):
    pulled = []

    def fake_get(settings, r2_key, dest, **kwargs):
        pulled.append((r2_key, dest.name))
        dest.write_bytes(b"audio")
        return "r2"

    monkeypatch.setattr("jxnfilm_tui.actions.runner.r2_get", fake_get)
    rnd = _round(("alice", "approved"), ("bo", "pending"), ("cass", "approved"))
    job = ArchiveJob(rnd, Settings(repo_root=tmp_path))
    lines = []
    assert await job.run(lines.append) == 0

    # Approved only, in submission order, named by member id + the r2 suffix.
    assert pulled == [("voice/general/alice.webm", "alice.webm"),
                      ("voice/general/cass.webm", "cass.webm")]
    assert (tmp_path / "out" / "archive" / "general" / "alice.webm").exists()


async def test_an_aged_out_clip_is_reported_not_fatal(tmp_path, monkeypatch):
    def fake_get(settings, r2_key, dest, **kwargs):
        if "alice" in r2_key:
            raise MissingObject("gone", output="404")
        dest.write_bytes(b"audio")
        return "r2"

    monkeypatch.setattr("jxnfilm_tui.actions.runner.r2_get", fake_get)
    job = ArchiveJob(_round(("alice", "approved"), ("cass", "approved")),
                     Settings(repo_root=tmp_path))
    lines = []
    # The whole point: one expired clip must not abort the rest of the round.
    assert await job.run(lines.append) == 0
    assert any("GONE" in line for line in lines)
    assert any("Downloaded 1, already had 0, gone 1, failed 0." in line for line in lines)


async def test_a_real_failure_makes_the_job_fail(tmp_path, monkeypatch):
    def fake_get(settings, r2_key, dest, **kwargs):
        raise WranglerError("401 Unauthorized", output="401")

    monkeypatch.setattr("jxnfilm_tui.actions.runner.r2_get", fake_get)
    job = ArchiveJob(_round(("alice", "approved")), Settings(repo_root=tmp_path))
    assert await job.run(lambda _: None) == 1


def test_job_for_picks_the_right_job_type(tmp_path):
    settings = Settings(repo_root=tmp_path)
    rnd = _round(("alice", "approved"))
    assert isinstance(job_for(BY_ID["archive_round"], settings, {}, round_=rnd), ArchiveJob)
    action = BY_ID["audiogram_round"]
    job = job_for(action, settings, defaults_for(action), round_=rnd)
    assert isinstance(job, ProcessJob)
    assert "--prompt" in job.argv


def test_archive_without_a_round_is_refused(tmp_path):
    with pytest.raises(ValueError):
        job_for(BY_ID["archive_round"], Settings(repo_root=tmp_path), {})


async def test_process_job_runs_from_the_repo_root(tmp_path):
    """Both CLIs default --out to the relative path `out/`."""
    settings = Settings(repo_root=tmp_path)
    job = ProcessJob(["python3", "-c", "import os; print(os.getcwd())"], settings)
    lines = []
    assert await job.run(lines.append) == 0
    assert str(tmp_path) in lines[-1]


async def test_cancel_kills_the_whole_process_group(tmp_path):
    """The node script spawns ffmpeg; SIGTERM to node alone orphans the encode.

    Stand-in: a child that spawns its own long-lived grandchild. Cancelling
    must take both down, not just the one we hold a handle to.
    """
    import asyncio
    import os

    marker = tmp_path / "grandchild.pid"
    script = (
        "import subprocess, sys, time\n"
        "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        f"open({str(marker)!r}, 'w').write(str(p.pid))\n"
        "print('started', flush=True)\n"
        "time.sleep(30)\n"
    )
    job = ProcessJob([sys.executable, "-c", script], Settings(repo_root=tmp_path))

    lines = []
    task = asyncio.create_task(job.run(lines.append))
    for _ in range(100):
        if marker.exists() and any("started" in line for line in lines):
            break
        await asyncio.sleep(0.05)
    assert marker.exists(), "the child never spawned its grandchild"
    grandchild = int(marker.read_text())

    await job.cancel()
    await asyncio.wait_for(task, timeout=10)

    for _ in range(100):
        try:
            os.kill(grandchild, 0)
        except (ProcessLookupError, PermissionError):
            break
        await asyncio.sleep(0.05)
    else:
        os.kill(grandchild, 9)
        pytest.fail("the grandchild survived cancel — only the direct child was signalled")


async def test_archiving_twice_downloads_nothing_the_second_time(tmp_path):
    """Idempotent: a byte-complete archive costs no request at all.

    Uses the REAL r2_get so the skip decision under test is the shipped one;
    only the wrangler subprocess underneath it is faked.
    """
    from jxnfilm_tui.data import wrangler as wrangler_module

    calls = []

    def fake_run(settings, args, **kwargs):
        calls.append(args)
        # `--file <path>` is where wrangler would have written the object.
        target = pathlib.Path(args[args.index("--file") + 1])
        target.write_bytes(b"audio")          # 5 bytes == the row's size
        return None

    settings = Settings(repo_root=tmp_path)
    rnd = _round(("alice", "approved"), ("cass", "approved"))

    import pytest as _pytest
    mp = _pytest.MonkeyPatch()
    mp.setattr(wrangler_module, "run_wrangler", fake_run)
    try:
        first, second = [], []
        assert await ArchiveJob(rnd, settings).run(first.append) == 0
        assert len(calls) == 2
        assert await ArchiveJob(rnd, settings).run(second.append) == 0
        assert len(calls) == 2, "the second archive re-downloaded"
    finally:
        mp.undo()

    assert any("Downloaded 2, already had 0" in line for line in first)
    assert any("Downloaded 0, already had 2" in line for line in second)


async def test_a_truncated_archive_is_repaired_not_trusted(tmp_path):
    """A half-written file from an interrupted run must not pass as complete."""
    from jxnfilm_tui.data import wrangler as wrangler_module

    settings = Settings(repo_root=tmp_path)
    rnd = _round(("alice", "approved"))
    target = settings.archive_out / "general" / "alice.webm"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"ab")                  # 2 bytes, row says 5

    def fake_run(settings_, args, **kwargs):
        pathlib.Path(args[args.index("--file") + 1]).write_bytes(b"audio")
        return None

    import pytest as _pytest
    mp = _pytest.MonkeyPatch()
    mp.setattr(wrangler_module, "run_wrangler", fake_run)
    try:
        assert await ArchiveJob(rnd, settings).run(lambda _: None) == 0
    finally:
        mp.undo()
    assert target.read_bytes() == b"audio"


async def test_a_failed_pull_leaves_no_truncated_file(tmp_path):
    """The .part rename: a failed transfer must not land at the real path."""
    from jxnfilm_tui.data import wrangler as wrangler_module

    settings = Settings(repo_root=tmp_path)
    target = settings.archive_out / "general" / "alice.webm"

    def fake_run(settings_, args, **kwargs):
        pathlib.Path(args[args.index("--file") + 1]).write_bytes(b"half")
        raise WranglerError("connection reset", output="ECONNRESET")

    import pytest as _pytest
    mp = _pytest.MonkeyPatch()
    mp.setattr(wrangler_module, "run_wrangler", fake_run)
    try:
        with pytest.raises(WranglerError):
            wrangler_module.r2_get(settings, "voice/general/alice.webm", target,
                                   expected_size=5)
    finally:
        mp.undo()
    assert not target.exists()
    assert not target.with_name(target.name + ".part").exists()


def test_the_archive_path_matches_the_one_the_clis_read(tmp_path):
    """Both sides must agree, or archiving stops saving the CLIs a download."""
    from jxnfilm_tui.actions.runner import archive_path_for

    settings = Settings(repo_root=tmp_path)
    clip = _round(("alice", "approved")).clips[0]
    assert archive_path_for(settings, "general", clip) == \
        tmp_path / "out" / "archive" / "general" / "alice.webm"
