"""Scanning out/ for work already done."""

from __future__ import annotations

import json

from jxnfilm_tui.data.renders import loose_renders, scan_all, split_render_name
from jxnfilm_tui.data.voices import attach_renders
from jxnfilm_tui.data.parsers import group_rounds, parse_voice_row
from jxnfilm_tui.settings import Settings


def test_split_render_name_uses_the_last_hyphen():
    assert split_render_name("mem-alice-16x9.mp4") == ("mem-alice", "16x9")
    assert split_render_name("segment-9x16.mp4") == ("segment", "9x16")
    assert split_render_name("mem_alice.mp4") is None
    assert split_render_name("mem_alice-720p.mp4") is None
    assert split_render_name("manifest.json") is None


def test_scan_all_collects_formats_and_manifest(tmp_path):
    round_dir = tmp_path / "audiogram" / "general"
    round_dir.mkdir(parents=True)
    (round_dir / "mem_alice-16x9.mp4").write_bytes(b"")
    (round_dir / "mem_alice-1x1.mp4").write_bytes(b"")
    (round_dir / "segment-16x9.mp4").write_bytes(b"")
    (round_dir / "manifest.json").write_text(json.dumps({"promptId": "general"}))

    found = scan_all(tmp_path / "audiogram")
    assert set(found) == {"general"}
    assert found["general"].formats_for("mem_alice") == ("16x9", "1x1")
    assert found["general"].formats_for("segment") == ("16x9",)
    assert found["general"].manifest["promptId"] == "general"


def test_scan_all_tolerates_a_missing_out_dir(tmp_path):
    assert scan_all(tmp_path / "nope") == {}


def test_bad_manifest_does_not_break_the_scan(tmp_path):
    round_dir = tmp_path / "audiogram" / "general"
    round_dir.mkdir(parents=True)
    (round_dir / "manifest.json").write_text("{oops")
    assert scan_all(tmp_path / "audiogram")["general"].manifest is None


def test_loose_renders_picks_up_file_mode_output(tmp_path):
    out = tmp_path / "audiogram"
    out.mkdir(parents=True)
    (out / "interview-16x9.mp4").write_bytes(b"")
    assert loose_renders(out) == {"interview": {"16x9": (out / "interview-16x9.mp4")}}


def test_attach_renders_matches_by_member_id_not_display_name(tmp_path):
    """make_audiogram names files safeName(memberId) — the lookup must agree.

    Alice's row carries a display name; her MP4 is named for her member id.
    Matching on the wrong one leaves the "rendered" column permanently blank.
    """
    (tmp_path / "out" / "audiogram" / "general").mkdir(parents=True)
    (tmp_path / "out" / "audiogram" / "general" / "mem_alice-16x9.mp4").write_bytes(b"")

    rounds = group_rounds([parse_voice_row(
        "voice:general:mem_alice",
        '{"memberId":"mem_alice","name":"Alice","status":"approved",'
        '"r2Key":"voice/general/mem_alice.webm","at":"2026-08-01T00:00:00.000Z"}',
    )])
    # repo_root points at the tmp tree so out/ resolves there, not at the real
    # (gitignored) one.
    annotated = attach_renders(rounds, Settings(repo_root=tmp_path))
    assert annotated[0].clips[0].rendered == ("16x9",)


def test_transcript_draft_is_detected_beside_the_audio(tmp_path):
    """Local SRT = whisper wrote one. Reviewed is R2 presence, not this."""
    from jxnfilm_tui.data.voices import transcript_path

    (tmp_path / "out" / "archive" / "general").mkdir(parents=True)
    (tmp_path / "out" / "archive" / "general" / "mem_alice.srt").write_text("1\n")

    rounds = group_rounds([parse_voice_row(
        "voice:general:mem_alice",
        '{"memberId":"mem_alice","status":"approved",'
        '"r2Key":"voice/general/mem_alice.webm","at":"2026-08-01T00:00:00.000Z"}',
    )])
    settings = Settings(repo_root=tmp_path)
    assert transcript_path(settings, "general", rounds[0].clips[0]).name == "mem_alice.srt"

    annotated = attach_renders(rounds, settings)
    assert annotated[0].clips[0].transcript_draft is True


def test_no_transcript_draft_when_none_written(tmp_path):
    rounds = group_rounds([parse_voice_row(
        "voice:general:mem_bo",
        '{"memberId":"mem_bo","status":"approved",'
        '"r2Key":"voice/general/mem_bo.webm","at":"2026-08-01T00:00:00.000Z"}',
    )])
    annotated = attach_renders(rounds, Settings(repo_root=tmp_path))
    assert annotated[0].clips[0].transcript_draft is False
