"""Guards: the constants this TUI copies must match their source of truth.

Same discipline as tests/scripts/audiogram.test.js, which guards the CLI's
hardcoded brand hexes against css/tokens.css. A copy nobody checks is a copy
that drifts.
"""

from __future__ import annotations

import re

from jxnfilm_tui.data.renders import FORMATS
from jxnfilm_tui.settings import VOICE_BUCKETS, VOICE_TTL_DAYS


def test_buckets_match_voices_mjs(repo_root):
    source = (repo_root / "scripts" / "lib" / "voices.mjs").read_text()
    block = re.search(r"export const BUCKETS = \{(.*?)\}", source, re.S)
    assert block, "BUCKETS moved in scripts/lib/voices.mjs"
    pairs = dict(re.findall(r"(\w+):\s*'([^']+)'", block.group(1)))
    assert pairs == VOICE_BUCKETS


def test_ttl_matches_the_worker(repo_root):
    source = (repo_root / "worker" / "src" / "index.js").read_text()
    match = re.search(r"const VOICE_TTL = (\d+) \* 86400", source)
    assert match, "VOICE_TTL moved in worker/src/index.js"
    assert int(match.group(1)) == VOICE_TTL_DAYS


def test_formats_match_the_audiogram_lib(repo_root):
    source = (repo_root / "scripts" / "lib" / "audiogram.mjs").read_text()
    block = re.search(r"export const FORMATS = \{(.*?)\n\}", source, re.S)
    assert block, "FORMATS moved in scripts/lib/audiogram.mjs"
    keys = re.findall(r"'([\dx]+)':\s*\{", block.group(1))
    assert tuple(keys) == FORMATS


def test_every_flag_we_pass_still_exists_in_the_cli(repo_root):
    """The TUI's whole contract with make_audiogram.mjs is its flag list."""
    source = (repo_root / "scripts" / "lib" / "audiogram.mjs").read_text()
    for flag in ("--prompt", "--env", "--format", "--title", "--name",
                 "--with-prompt", "--segment-only", "--clips-only"):
        assert f"'{flag}'" in source, f"{flag} is gone from parseArgs"


def test_compile_cli_still_takes_the_env_flag(repo_root):
    source = (repo_root / "scripts" / "compile_voices.mjs").read_text()
    assert "'--env'" in source


def test_env_switch_rebuilds_settings_rather_than_mutating(settings):
    staging = settings.with_env("staging")
    assert staging is not settings
    assert settings.env_name == "production"
    assert staging.bucket == VOICE_BUCKETS["staging"]


def test_output_paths_are_gitignored(repo_root):
    """The hard guarantee: nothing the pipeline writes can be committed.

    Asked of git itself rather than of .gitignore's text, so a future edit that
    reorders or negates a rule still gets caught.
    """
    import subprocess

    paths = [
        "out/audiogram/general/alice-16x9.mp4",
        "out/audiogram/general/segment-9x16.mp4",
        "out/audiogram/general/manifest.json",
        "out/audiogram/tone-1x1.mp4",
        "out/archive/general/alice.webm",
        "out/archive/general/alice.webm.part",
        "out/general-segment.wav",
        "tui/.venv/bin/python",
    ]
    result = subprocess.run(
        ["git", "check-ignore", "--stdin"],
        cwd=repo_root, input="\n".join(paths), capture_output=True, text=True,
    )
    ignored = set(result.stdout.split())
    assert set(paths) - ignored == set(), "these output paths are NOT gitignored"


def test_the_archive_location_is_defined_identically_in_js(repo_root):
    """The CLIs read the location the TUI writes; both must agree."""
    source = (repo_root / "scripts" / "lib" / "voices.mjs").read_text()
    assert "export function archivePathFor(outDir, promptId, clip)" in source
    assert "join(outDir, 'archive', promptId, `${clip.memberId}${ext}`)" in source


def test_the_clis_still_accept_the_force_flag(repo_root):
    """The TUI's force toggle is only real if the CLIs still parse it."""
    assert "'--force'" in (repo_root / "scripts" / "lib" / "audiogram.mjs").read_text()
    assert "'--force'" in (repo_root / "scripts" / "compile_voices.mjs").read_text()


def test_transcribe_cli_still_accepts_the_flags_the_tui_passes(repo_root):
    """The TUI's whole contract with transcribe.mjs is its flag list."""
    source = (repo_root / "scripts" / "transcribe.mjs").read_text()
    for flag in ("--prompt", "--env", "--member", "--model", "--force",
                 "--upload", "--upload-only"):
        assert f"'{flag}'" in source, f"{flag} is gone from transcribe.mjs"


def test_the_transcript_location_is_defined_identically_in_js(repo_root):
    """The renderer reads the path the TUI reports; both must agree."""
    source = (repo_root / "scripts" / "lib" / "voices.mjs").read_text()
    assert "export function transcriptPathFor(outDir, promptId, clip)" in source
    assert "export function transcriptKeyFor(clip)" in source
