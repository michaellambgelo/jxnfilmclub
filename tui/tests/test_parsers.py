"""Parsers over wrangler's stdout — the part most likely to drift."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from conftest import fixture
from jxnfilm_tui.data.parsers import (
    ParseError, fmt_bytes, fmt_days, fmt_duration, group_rounds, is_missing,
    is_transient, parse_bucket_info, parse_kv_list, parse_voice_key,
    parse_voice_row,
)
from jxnfilm_tui.model.state import APPROVED, Clip


def test_kv_list_skips_the_wrangler_banner():
    entries = parse_kv_list(fixture("kv_list.txt"))
    assert [e.key for e in entries] == [
        "voice:general:mem_alice",
        "voice:general:mem_bob",
        "voice:noir-november:mem_alice",
    ]
    assert entries[0].expiration == datetime.fromtimestamp(1793491200, tz=timezone.utc)
    assert entries[1].expiration is None


def test_kv_list_rejects_output_with_no_payload():
    with pytest.raises(ParseError):
        parse_kv_list("⛅️ wrangler 4.114.0\nAuthentication error")


def test_voice_key_split_keeps_colons_in_the_member_id():
    assert parse_voice_key("voice:general:mem_alice") == ("general", "mem_alice")
    assert parse_voice_key("voice:general:a:b") == ("general", "a:b")
    with pytest.raises(ParseError):
        parse_voice_key("member:alice@example.com")


def test_voice_row_reads_the_fields_the_pipeline_uses():
    clip = parse_voice_row("voice:general:mem_alice", fixture("voice_row.json"))
    assert clip.name == "Alice"
    assert clip.status == APPROVED
    assert clip.r2_key == "voice/general/mem_alice.webm"
    assert clip.error is None
    assert clip.at == datetime(2026, 8, 1, 18, 4, 11, 221000, tzinfo=timezone.utc)
    # 212.5s of audio, but a render only ever contains the first 180.
    assert clip.duration == 212.5
    assert clip.capped_seconds == 180


def test_unparseable_row_survives_as_a_visible_broken_row():
    clip = parse_voice_row("voice:general:mem_bob", "{not json")
    assert clip.member_id == "mem_bob"
    assert clip.error and "unparseable" in clip.error
    # The point: it is still a Clip, so the round it belongs to isn't silently
    # one clip shorter.
    assert clip.prompt_id == "general"


def test_row_without_an_r2key_is_flagged_not_dropped():
    clip = parse_voice_row("voice:general:mem_bob", '{"status":"approved"}')
    assert clip.error == "no r2Key — nothing to render"


def test_expiry_falls_back_to_the_listings_ttl():
    listed = datetime(2026, 10, 1, tzinfo=timezone.utc)
    clip = parse_voice_row("voice:general:mem_bob", '{"status":"pending"}',
                           listed_expiry=listed)
    assert clip.expires_at == listed


def test_deadline_falls_back_to_submission_plus_sixty_days():
    at = datetime(2026, 6, 1, tzinfo=timezone.utc)
    clip = Clip(key="voice:g:m", prompt_id="g", member_id="m", at=at)
    assert clip.deadline() == at + timedelta(days=60)
    assert round(clip.days_remaining(now=at + timedelta(days=50))) == 10


def test_rounds_group_in_submission_order_newest_round_first():
    def row(prompt, member, at, status=APPROVED):
        return parse_voice_row(
            f"voice:{prompt}:{member}",
            f'{{"status":"{status}","r2Key":"voice/{prompt}/{member}.webm","at":"{at}"}}',
        )

    rounds = group_rounds([
        row("general", "b", "2026-08-02T00:00:00.000Z"),
        row("noir", "z", "2026-09-01T00:00:00.000Z"),
        row("general", "a", "2026-08-01T00:00:00.000Z"),
    ])
    assert [r.prompt_id for r in rounds] == ["noir", "general"]
    # Submission order inside a round IS the order a rendered segment plays.
    assert [c.member_id for c in rounds[1].clips] == ["a", "b"]


def test_round_counts_and_segment_estimate():
    def row(member, status, seconds):
        return parse_voice_row(
            f"voice:g:{member}",
            f'{{"status":"{status}","r2Key":"voice/g/{member}.webm",'
            f'"duration":{seconds},"at":"2026-08-0{member}T00:00:00.000Z"}}',
        )

    rnd = group_rounds([row("1", APPROVED, 60), row("2", "pending", 30),
                        row("3", APPROVED, 240)])[0]
    assert rnd.counts[APPROVED] == 2
    assert rnd.counts["pending"] == 1
    # 60 + capped 180 + one 0.5s gap
    assert rnd.approved_seconds == pytest.approx(240.5)


def test_bucket_info_parses_the_key_value_block():
    info = parse_bucket_info(fixture("bucket_info.txt"))
    assert info.name == "jxnfilm-voice"
    assert info.object_count == 7
    assert info.size == "12.4 MB"


def test_transient_classification_retries_401_but_not_404():
    assert is_transient("Authentication error [code: 10000] 401")
    assert is_transient("fetch failed")
    assert not is_transient("The specified key does not exist. 404")
    assert not is_transient("")
    assert is_missing("NoSuchKey")
    assert not is_missing("401 Unauthorized")


def test_display_helpers():
    assert fmt_duration(125) == "2:05"
    assert fmt_duration(None) == "—"
    assert fmt_bytes(None) == "—"
    assert fmt_bytes(900) == "900 B"
    assert fmt_bytes(1536) == "1.5 KB"
    # Floored, so "0d" means today — never rounds a nearly-dead clip up to 1d.
    assert fmt_days(0.9) == "0d"
    assert fmt_days(-1) == "expired"
    assert fmt_days(None) == "—"
