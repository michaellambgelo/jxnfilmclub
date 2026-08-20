"""Pure parsers over wrangler's stdout and the pipeline's on-disk artifacts.

Nothing in here spawns a process or touches the network, so every wrinkle
below is unit-tested from a fixture in tests/fixtures/ with no wrangler, no
ffmpeg and no Cloudflare account. That is the point: the fiddly, drifty part
of shelling out is the OUTPUT parsing, and it's the part that's cheapest to
pin down.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from ..model.state import BucketInfo, Clip, KvEntry, Round, parse_iso


class ParseError(ValueError):
    """Wrangler printed something we can't make sense of."""


def _json_after(text: str, opener: str) -> str:
    """Slice from the first `opener` char.

    wrangler shares stdout with its own banner ("⛅️ wrangler 4.101.0") and
    the occasional update notice, so the payload rarely starts at byte 0.
    scripts/lib/voices.mjs does exactly this; keeping the same tolerance means
    the TUI and the CLI can't disagree about what wrangler said.
    """
    idx = text.find(opener)
    if idx == -1:
        raise ParseError(f"no {opener!r} in wrangler output:\n{text[:400]}")
    return text[idx:]


def parse_kv_list(stdout: str) -> list[KvEntry]:
    """`wrangler kv key list` → entries, with the TTL expiry when KV reports it."""
    try:
        rows = json.loads(_json_after(stdout, "["))
    except json.JSONDecodeError as exc:
        raise ParseError(f"could not parse kv key list output: {exc}") from exc
    if not isinstance(rows, list):
        raise ParseError("kv key list did not return an array")
    entries = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("name"), str):
            continue
        expiration = row.get("expiration")
        when = None
        if isinstance(expiration, (int, float)):
            when = datetime.fromtimestamp(expiration, tz=timezone.utc)
        entries.append(KvEntry(key=row["name"], expiration=when))
    return entries


def parse_voice_key(key: str) -> tuple[str, str]:
    """`voice:{promptId}:{memberId}` → (promptId, memberId).

    Only the first two colons are structural — anything after stays with the
    member id rather than being silently truncated.
    """
    parts = key.split(":", 2)
    if len(parts) != 3 or parts[0] != "voice":
        raise ParseError(f"not a voice key: {key!r}")
    return parts[1], parts[2]


def parse_voice_row(key: str, raw: str, listed_expiry: datetime | None = None) -> Clip:
    """One KV value → a Clip.

    A row that won't parse still comes back as a Clip carrying `error`, so a
    single corrupt value can't blank out the round it belongs to.
    """
    prompt_id, member_id = parse_voice_key(key)
    try:
        row = json.loads(raw)
        if not isinstance(row, dict):
            raise ValueError("value is not an object")
    except (json.JSONDecodeError, ValueError) as exc:
        return Clip(key=key, prompt_id=prompt_id, member_id=member_id,
                    expires_at=listed_expiry, error=f"unparseable value: {exc}")

    expires_at = None
    raw_expiry = row.get("expiresAt")
    if isinstance(raw_expiry, (int, float)):
        expires_at = datetime.fromtimestamp(raw_expiry, tz=timezone.utc)

    duration = row.get("duration")
    if not isinstance(duration, (int, float)):
        duration = None

    size = row.get("size")
    if not isinstance(size, int):
        size = None

    error = None
    if not row.get("r2Key"):
        # compile_voices.mjs skips these outright; surfacing why beats a blank.
        error = "no r2Key — nothing to render"

    return Clip(
        key=key,
        prompt_id=str(row.get("promptId") or prompt_id),
        member_id=str(row.get("memberId") or member_id),
        name=row.get("name") or None,
        handle=row.get("handle") or None,
        status=str(row.get("status") or ""),
        r2_key=row.get("r2Key") or None,
        content_type=row.get("contentType") or None,
        size=size,
        duration=duration,
        at=parse_iso(row.get("at")),
        # The listing's own expiry is the same TTL seen from the other side;
        # keep it as the fallback when a row predates the expiresAt field.
        expires_at=expires_at or listed_expiry,
        prompt_text=row.get("promptText") or None,
        raw=row,
        error=error,
    )


def group_rounds(clips) -> tuple[Round, ...]:
    """Clips → rounds, each in submission order.

    Sorting by the `at` string is a plain lexicographic compare of ISO stamps —
    identical to `compile_voices.mjs`, so the TUI's displayed order IS the
    order a rendered segment will play in. Rows without `at` sort first by key
    so the ordering stays deterministic instead of depending on KV's paging.
    """
    by_prompt: dict[str, list[Clip]] = {}
    for clip in clips:
        by_prompt.setdefault(clip.prompt_id, []).append(clip)

    rounds = []
    for prompt_id, group in by_prompt.items():
        # Rows without `at` sort first (empty string), then by key — deterministic
        # either way, never dependent on the order KV happened to page them in.
        group.sort(key=lambda c: (c.at.isoformat() if c.at else "", c.key))
        text = next((c.prompt_text for c in group if c.prompt_text), None)
        rounds.append(Round(prompt_id=prompt_id, prompt_text=text, clips=tuple(group)))

    # Newest round first: by the most recent submission it contains.
    rounds.sort(key=lambda r: max((c.at.isoformat() for c in r.clips if c.at), default=""),
                reverse=True)
    return tuple(rounds)


_INFO_LINE = re.compile(r"^([a-z_]+):\s+(.*)$")


def parse_bucket_info(stdout: str, fallback_name: str = "") -> BucketInfo:
    """`wrangler r2 bucket info` → BucketInfo (key: value lines under a banner)."""
    fields: dict[str, str] = {}
    for line in stdout.splitlines():
        match = _INFO_LINE.match(line.strip())
        if match:
            fields[match.group(1)] = match.group(2).strip()
    count = None
    if fields.get("object_count", "").isdigit():
        count = int(fields["object_count"])
    return BucketInfo(
        name=fields.get("name") or fallback_name,
        object_count=count,
        size=fields.get("bucket_size"),
        location=fields.get("location"),
        created=parse_iso(fields.get("created")),
    )


# A burst of per-key `kv key get` calls draws a spurious 401 partway through —
# the credentials are fine, the next attempt succeeds. Everything else
# (a real auth failure, a missing object) must NOT be retried into a hang.
_TRANSIENT = re.compile(
    r"\b(401|429|500|502|503|504)\b|Unauthorized|Authentication error|"
    r"fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN",
    re.IGNORECASE,
)
_NOT_FOUND = re.compile(r"\b404\b|not\s*found|does not exist|NoSuchKey", re.IGNORECASE)


def is_transient(text: str) -> bool:
    """Worth one more try? False for 404s even though they match nothing else."""
    if not text:
        return False
    if _NOT_FOUND.search(text):
        return False
    return bool(_TRANSIENT.search(text))


def is_missing(text: str) -> bool:
    """An R2 object that isn't there — the expected end state after 60 days."""
    return bool(text) and bool(_NOT_FOUND.search(text))


# --- display helpers ------------------------------------------------------

def fmt_duration(seconds) -> str:
    """m:ss, matching the CLIs' fmtDur."""
    if seconds is None:
        return "—"
    whole = round(float(seconds))
    return f"{whole // 60}:{whole % 60:02d}"


def fmt_bytes(size) -> str:
    if size is None:
        return "—"
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def fmt_days(days) -> str:
    """Days-remaining, floored — 0.9 days left is '0d', not 'about a day'."""
    if days is None:
        return "—"
    if days <= 0:
        return "expired"
    return f"{int(days)}d"
