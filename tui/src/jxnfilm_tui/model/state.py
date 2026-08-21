"""The shapes the TUI renders. No I/O, no subprocesses — pure data.

A `Clip` is one `voice:{promptId}:{memberId}` KV row; a `Round` is every clip
for one prompt. Both carry their own provenance so a half-broken row (bad
JSON, missing r2Key) still renders as a row with an error instead of
disappearing or crashing the collector.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..settings import VOICE_TTL_DAYS

APPROVED = "approved"
PENDING = "pending"
REJECTED = "rejected"

# The hard per-clip cap both CLIs apply (`-t 180` in normalizeClip).
CLIP_CAP_SECONDS = 180


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(value) -> datetime | None:
    """Parse the Worker's `new Date().toISOString()` stamps.

    Python < 3.11 chokes on the trailing `Z`; normalize it either way so the
    parse doesn't depend on the interpreter version.
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


@dataclass(frozen=True)
class Clip:
    """One voice submission: its KV row plus what we know locally about it."""

    key: str
    prompt_id: str
    member_id: str
    name: str | None = None
    handle: str | None = None
    status: str = ""
    r2_key: str | None = None
    content_type: str | None = None
    size: int | None = None
    duration: float | None = None
    at: datetime | None = None
    expires_at: datetime | None = None
    prompt_text: str | None = None
    raw: dict = field(default_factory=dict)
    error: str | None = None
    # Filled in by data/renders.py — formats already rendered for this clip.
    rendered: tuple[str, ...] = ()
    # A local draft SRT sits beside the archived audio. Its presence in R2 is
    # what marks it reviewed, and that is not knowable without an R2 read, so
    # this only ever means "whisper has written one here".
    transcript_draft: bool = False
    # From the KV row: set when an admin SAVES the transcript in the panel.
    # Uploading a draft does not set it — that is the whole point of the gate.
    transcript_reviewed: datetime | None = None

    @property
    def label(self) -> str:
        return self.name or self.member_id or self.key

    @property
    def approved(self) -> bool:
        return self.status == APPROVED

    @property
    def capped_seconds(self) -> float | None:
        """Runtime as it will appear in a render, i.e. after the 180s cap."""
        if self.duration is None:
            return None
        return min(float(self.duration), CLIP_CAP_SECONDS)

    def deadline(self) -> datetime | None:
        """When the audio goes away.

        Prefers the row's own `expiresAt` (the KV TTL, exact) and falls back to
        submission + 60 days (the R2 lifecycle, swept daily). They can disagree
        by up to a day in either direction — hence "audio gone" rows whose
        metadata is still listable, and vice versa.
        """
        if self.expires_at is not None:
            return self.expires_at
        if self.at is not None:
            return self.at + timedelta(days=VOICE_TTL_DAYS)
        return None

    def days_remaining(self, now: datetime | None = None) -> float | None:
        deadline = self.deadline()
        if deadline is None:
            return None
        return (deadline - (now or utcnow())).total_seconds() / 86400


@dataclass(frozen=True)
class Round:
    """Every submission for one prompt id, in submission order."""

    prompt_id: str
    prompt_text: str | None
    clips: tuple[Clip, ...] = ()

    @property
    def approved_clips(self) -> tuple[Clip, ...]:
        return tuple(c for c in self.clips if c.approved)

    @property
    def counts(self) -> dict[str, int]:
        out = {APPROVED: 0, PENDING: 0, REJECTED: 0, "other": 0}
        for clip in self.clips:
            out[clip.status if clip.status in out else "other"] += 1
        return out

    @property
    def renderable(self) -> bool:
        return bool(self.approved_clips)

    @property
    def approved_seconds(self) -> float:
        """Rough segment length: capped clip runtimes + 0.5s gaps between."""
        clips = self.approved_clips
        known = [c.capped_seconds for c in clips if c.capped_seconds is not None]
        gaps = 0.5 * max(0, len(clips) - 1)
        return sum(known) + gaps

    def soonest_days(self, now: datetime | None = None) -> float | None:
        """Days until the FIRST clip in this round loses its audio."""
        now = now or utcnow()
        days = [c.days_remaining(now) for c in self.clips]
        live = [d for d in days if d is not None]
        return min(live) if live else None


@dataclass(frozen=True)
class BucketInfo:
    """`wrangler r2 bucket info` — the only bucket-wide read wrangler offers."""

    name: str
    object_count: int | None = None
    size: str | None = None
    location: str | None = None
    created: datetime | None = None


@dataclass(frozen=True)
class KvEntry:
    key: str
    expiration: datetime | None = None


@dataclass(frozen=True)
class RenderSet:
    """What's already on disk under out/audiogram/<promptId>/."""

    prompt_id: str
    directory: Path
    # memberId (or 'segment') → format → mp4 path
    files: dict[str, dict[str, Path]] = field(default_factory=dict)
    manifest: dict | None = None

    def formats_for(self, stem: str) -> tuple[str, ...]:
        return tuple(sorted(self.files.get(stem, {})))


@dataclass(frozen=True)
class LoadResult:
    """A collector's output: what it got, plus what went wrong on the way.

    Warnings are per-row and non-fatal (an unparseable value, a row without an
    r2Key); `error` means the whole read failed and the pane should say so
    rather than render a convincing empty state.
    """

    rounds: tuple[Round, ...] = ()
    warnings: tuple[str, ...] = ()
    error: str | None = None
    fetched_at: datetime | None = None

    @property
    def ok(self) -> bool:
        return self.error is None
