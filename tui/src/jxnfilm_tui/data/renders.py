"""What the pipeline has already produced under `out/`.

Read-only filesystem scan. Its job is to answer "have I already rendered
this?" in the clip table, so a round that's half-done is obvious before you
spend another ten minutes of ffmpeg on it.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..model.state import RenderSet

# Mirrors FORMATS in scripts/lib/audiogram.mjs. Guarded by tests/test_settings.py.
FORMATS = ("16x9", "1x1", "9x16")


def split_render_name(filename: str) -> tuple[str, str] | None:
    """`alice-16x9.mp4` → ('alice', '16x9').

    Split on the LAST hyphen, since member ids and audio basenames may contain
    their own (`safeName` in audiogram.mjs keeps hyphens).
    """
    if not filename.endswith(".mp4"):
        return None
    stem = filename[: -len(".mp4")]
    head, sep, fmt = stem.rpartition("-")
    if not sep or fmt not in FORMATS:
        return None
    return head, fmt


def scan_round(directory: Path, prompt_id: str) -> RenderSet:
    files: dict[str, dict[str, Path]] = {}
    manifest = None
    if not directory.is_dir():
        return RenderSet(prompt_id=prompt_id, directory=directory)
    for path in sorted(directory.iterdir()):
        if path.name == "manifest.json":
            try:
                manifest = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                manifest = None
            continue
        parsed = split_render_name(path.name)
        if parsed:
            stem, fmt = parsed
            files.setdefault(stem, {})[fmt] = path
    return RenderSet(prompt_id=prompt_id, directory=directory, files=files, manifest=manifest)


def scan_all(audiogram_out: Path) -> dict[str, RenderSet]:
    """Every out/audiogram/<promptId>/ directory, keyed by prompt id."""
    if not audiogram_out.is_dir():
        return {}
    out = {}
    for child in sorted(audiogram_out.iterdir()):
        if child.is_dir():
            out[child.name] = scan_round(child, child.name)
    return out


def loose_renders(audiogram_out: Path) -> dict[str, dict[str, Path]]:
    """File-mode output: out/audiogram/<name>-<fmt>.mp4, no prompt round."""
    if not audiogram_out.is_dir():
        return {}
    out: dict[str, dict[str, Path]] = {}
    for path in sorted(audiogram_out.iterdir()):
        if path.is_file():
            parsed = split_render_name(path.name)
            if parsed:
                stem, fmt = parsed
                out.setdefault(stem, {})[fmt] = path
    return out
