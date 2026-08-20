"""Pure argv builders for the two CLIs this TUI drives.

The TUI is an orchestration layer, exactly like cluster-tui over cluster-ops:
it never reimplements normalization, rendering or KV access — it builds the
command line and streams the result. Keeping the builders pure means the
command shown in the confirm modal is provably the command that runs, and the
flag combinations are testable without ffmpeg or a Cloudflare account.
"""

from __future__ import annotations

from pathlib import Path

from ..data.renders import FORMATS
from ..settings import ENVS, Settings

SCOPES = ("all", "clips-only", "segment-only")


def _check(fmt: str, env_name: str) -> None:
    if fmt not in (*FORMATS, "all"):
        raise ValueError(f"format must be one of {', '.join((*FORMATS, 'all'))} (got {fmt!r})")
    if env_name not in ENVS:
        raise ValueError(f"env must be one of {', '.join(ENVS)} (got {env_name!r})")


def audiogram_round_argv(settings: Settings, prompt_id: str, *, fmt: str = "16x9",
                         with_prompt: bool = False, scope: str = "all",
                         members=(), force: bool = False) -> list[str]:
    """`make_audiogram.mjs --prompt <id>` — the round render.

    `members` narrows it to specific approved clips. The CLI filters before it
    pulls from R2, so one member costs one download rather than the round.
    """
    _check(fmt, settings.env_name)
    if scope not in SCOPES:
        raise ValueError(f"scope must be one of {', '.join(SCOPES)} (got {scope!r})")
    if not prompt_id:
        raise ValueError("a prompt id is required")
    argv = ["node", str(settings.make_audiogram), "--prompt", prompt_id,
            "--env", settings.env_name, "--format", fmt]
    for member in members:
        if not str(member).strip():
            raise ValueError("a member id cannot be blank")
        argv += ["--member", str(member)]
    if with_prompt:
        argv.append("--with-prompt")
    if force:
        argv.append("--force")
    if scope == "clips-only":
        argv.append("--clips-only")
    elif scope == "segment-only":
        argv.append("--segment-only")
    return argv


def audiogram_file_argv(settings: Settings, audio_path, *, fmt: str = "16x9",
                        title: str = "", name: str = "",
                        force: bool = False) -> list[str]:
    """`make_audiogram.mjs <audio-file>` — file mode, no KV or R2 involved."""
    _check(fmt, settings.env_name)
    path = Path(audio_path).expanduser()
    if not str(path):
        raise ValueError("an audio file is required")
    argv = ["node", str(settings.make_audiogram), str(path), "--format", fmt]
    if title:
        argv += ["--title", title]
    if name:
        argv += ["--name", name]
    if force:
        argv.append("--force")
    return argv


def compile_argv(settings: Settings, prompt_id: str, *,
                 force: bool = False) -> list[str]:
    """`compile_voices.mjs <promptId>` — the broadcast WAV, no video."""
    if not prompt_id:
        raise ValueError("a prompt id is required")
    if settings.env_name not in ENVS:
        raise ValueError(f"env must be one of {', '.join(ENVS)}")
    argv = ["node", str(settings.compile_voices), prompt_id, "--env", settings.env_name]
    if force:
        argv.append("--force")
    return argv


def render_command(argv, root=None) -> str:
    """One-line display form. Quotes only what actually needs it.

    `root` shortens paths inside the repo to the form the docs use
    (`node scripts/make_audiogram.mjs …`). The argv itself stays absolute —
    only the rendering is shortened, and the run screen prints the cwd those
    relative paths resolve against.
    """
    prefix = f"{Path(root)}/" if root else None
    parts = []
    for arg in argv:
        text = arg[len(prefix):] if prefix and arg.startswith(prefix) else arg
        parts.append(f'"{text}"' if (" " in text or not text) else text)
    return " ".join(parts)
