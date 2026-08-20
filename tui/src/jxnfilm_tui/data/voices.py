"""Collector: every `voice:*` row in KV → rounds, annotated with local renders.

One `kv key list`, then one `kv key get` per submission — the same burst the
audiogram CLI does, except each get retries the spurious 401 instead of
aborting the run, and a row that fails outright becomes a visible broken row
rather than a silently shorter round.
"""

from __future__ import annotations

from dataclasses import replace

from ..model.state import LoadResult, Round, utcnow
from ..settings import Settings
from .parsers import group_rounds, parse_voice_row
from .renders import scan_all
from .wrangler import WranglerError, kv_get, kv_list

VOICE_PREFIX = "voice:"


def load_rounds(settings: Settings, *, progress=None) -> LoadResult:
    """Read the whole voice keyspace for one env.

    `progress(done, total, label)` is called between gets so the UI can show
    movement — a round with a dozen clips is a dozen sequential round-trips.
    """
    try:
        entries = kv_list(settings, VOICE_PREFIX)
    except WranglerError as exc:
        return LoadResult(error=str(exc), fetched_at=utcnow())

    warnings: list[str] = []
    clips = []
    total = len(entries)
    for index, entry in enumerate(entries, start=1):
        if progress:
            progress(index, total, entry.key)
        try:
            raw = kv_get(settings, entry.key)
        except WranglerError as exc:
            warnings.append(f"{entry.key}: {exc}")
            continue
        clip = parse_voice_row(entry.key, raw, listed_expiry=entry.expiration)
        if clip.error:
            warnings.append(f"{clip.key}: {clip.error}")
        clips.append(clip)

    rounds = group_rounds(clips)
    rounds = attach_renders(rounds, settings)
    return LoadResult(rounds=rounds, warnings=tuple(warnings), fetched_at=utcnow())


def attach_renders(rounds, settings: Settings) -> tuple[Round, ...]:
    """Mark each clip with the formats already sitting in out/audiogram/."""
    rendered = scan_all(settings.audiogram_out)
    out = []
    for rnd in rounds:
        render_set = rendered.get(rnd.prompt_id)
        if render_set is None:
            out.append(rnd)
            continue
        # make_audiogram names files by safeName(memberId), so the lookup is by
        # member id, not by display name.
        clips = tuple(
            replace(clip, rendered=render_set.formats_for(clip.member_id))
            for clip in rnd.clips
        )
        out.append(replace(rnd, clips=clips))
    return tuple(out)
