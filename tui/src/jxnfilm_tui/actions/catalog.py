"""The runnable actions, as data.

Same crux as cluster-tui's playbook catalog: the UI doesn't know what any
action *means*, it just renders options and hands the bindings back. Adding an
action is a table entry plus a branch in `build`, not a new screen.

Everything here is read-side or produces local files. No action writes to KV
or R2 — moderation stays in the admin dashboard, where the Worker's cascade
logic (and the ADMIN_TOKEN it needs) already lives.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..data.renders import FORMATS
from ..settings import Settings
from .argv import (
    SCOPES, WHISPER_MODELS, audiogram_file_argv, audiogram_round_argv,
    compile_argv, transcribe_argv,
)


@dataclass(frozen=True)
class Option:
    name: str
    label: str
    kind: str  # "choice" | "bool" | "text"
    default: object = ""
    choices: tuple[str, ...] = ()
    help: str = ""


@dataclass(frozen=True)
class Action:
    id: str
    title: str
    summary: str
    scope: str  # "round" | "clip" | "file" — what the action needs selected
    options: tuple[Option, ...] = ()
    cost: str = ""
    # Internal actions run in-process (wrangler pulls) rather than as one
    # subprocess; the runner picks the right job type off this flag.
    internal: bool = False
    defaults: dict = field(default_factory=dict)


# Off by default, everywhere. The CLIs refuse to land on existing output and
# name the conflicts; this is the only way past, and it must always be a
# deliberate tick rather than something a default quietly does for you.
FORCE_OPTION = Option(
    name="force", label="Overwrite existing output", kind="bool", default=False,
    help="Off: a run that would replace files already in out/ stops and lists them",
)

FORMAT_OPTION = Option(
    name="format", label="Format", kind="choice", default="16x9",
    choices=(*FORMATS, "all"),
    help="16x9 = video-podcast import · 1x1 = feed · 9x16 = story/reel",
)

CATALOG: tuple[Action, ...] = (
    Action(
        id="audiogram_round",
        title="Render the whole round",
        summary="Every approved clip in this round → branded MP4s, one per "
                "member plus the compiled segment.",
        scope="round",
        cost="minutes per clip per format — ffmpeg encodes at CRF 18",
        options=(
            FORMAT_OPTION,
            Option(name="scope", label="Render", kind="choice", default="all",
                   choices=SCOPES,
                   help="all = clips + segment · clips-only · segment-only"),
            Option(name="with_prompt", label="Show the prompt text", kind="bool",
                   default=False,
                   help="Adds the question being answered to the frame"),
            FORCE_OPTION,
        ),
    ),
    Action(
        id="audiogram_clip",
        title="Render this clip only",
        summary="Just the highlighted member's clip → a branded MP4. One R2 "
                "download, no segment.",
        scope="clip",
        cost="minutes per format",
        options=(
            FORMAT_OPTION,
            Option(name="with_prompt", label="Show the prompt text", kind="bool",
                   default=False,
                   help="Adds the question being answered to the frame"),
            FORCE_OPTION,
        ),
    ),
    Action(
        id="transcribe_clip",
        title="Transcribe this clip",
        summary="Whisper locally → a caption SRT beside the audio. A DRAFT: "
                "read it and fix what it misheard before uploading.",
        scope="clip",
        cost="under a minute for a 3-minute clip once the model is cached",
        options=(
            Option(name="model", label="Whisper model", kind="choice", default="small",
                   choices=WHISPER_MODELS,
                   help="Bigger models mishear fewer proper nouns; small is usually enough"),
            FORCE_OPTION,
        ),
    ),
    Action(
        id="upload_transcript",
        title="Upload transcript (mark reviewed)",
        summary="Push the edited SRT to R2 beside the audio. This is the review "
                "gate — captions render from the R2 copy, never the local draft.",
        scope="clip",
        cost="one small upload; runs no model",
    ),
    Action(
        id="pull_transcript",
        title="Pull reviewed transcript",
        summary="Fetch the transcript from R2, overwriting the local copy. Do "
                "this after editing it in the admin panel — R2 is the source "
                "of truth.",
        scope="clip",
        cost="one small download; overwrites the local file without asking",
    ),
    Action(
        id="transcribe_round",
        title="Transcribe the whole round",
        summary="Whisper every approved clip in this round into draft SRTs.",
        scope="round",
        cost="under a minute per clip",
        options=(
            Option(name="model", label="Whisper model", kind="choice", default="small",
                   choices=WHISPER_MODELS,
                   help="Bigger models mishear fewer proper nouns; small is usually enough"),
            FORCE_OPTION,
        ),
    ),
    Action(
        id="compile_segment",
        title="Compile segment WAV",
        summary="Approved clips → one loudness-normalized 48kHz mono WAV with "
                "0.5s gaps. No video.",
        scope="round",
        cost="seconds per clip — one ffmpeg pass, no encode",
        options=(FORCE_OPTION,),
    ),
    Action(
        id="archive_round",
        title="Archive source clips",
        summary="Pull every approved clip's original audio to out/archive/ "
                "before the 60-day lifecycle deletes it. Renders keep it there "
                "too — this just does it up front.",
        scope="round",
        cost="one download per clip (8MB max each); already-archived clips are free",
        internal=True,
    ),
    Action(
        id="audiogram_file",
        title="Render from a file",
        summary="Any local audio file → a branded MP4. Skips KV and R2 "
                "entirely.",
        scope="file",
        cost="minutes per format",
        options=(
            FORMAT_OPTION,
            Option(name="audio_path", label="Audio file", kind="text", default="",
                   help="Path to the audio — relative paths resolve from the repo root"),
            Option(name="name", label="Credit line", kind="text", default="",
                   help="Who to credit on the frame (default: JXN Film Club)"),
            Option(name="title", label="Display line", kind="text", default="",
                   help="Optional big line above the credit — leave empty for logo + name only"),
            FORCE_OPTION,
        ),
    ),
)

BY_ID = {action.id: action for action in CATALOG}


def defaults_for(action: Action) -> dict:
    return {opt.name: opt.default for opt in action.options}


def build(action: Action, settings: Settings, bindings: dict, *,
          prompt_id: str = "", member_id: str = "") -> list[str]:
    """Action + option bindings → the argv that will run.

    Internal actions have no argv; the runner handles those directly, and
    calling this on one is a programming error rather than a silent no-op.
    """
    if action.internal:
        raise ValueError(f"{action.id} runs in-process and has no argv")
    if action.id == "audiogram_round":
        return audiogram_round_argv(
            settings, prompt_id,
            fmt=str(bindings.get("format", "16x9")),
            with_prompt=bool(bindings.get("with_prompt", False)),
            scope=str(bindings.get("scope", "all")),
            force=bool(bindings.get("force", False)),
        )
    if action.id == "audiogram_clip":
        if not member_id:
            raise ValueError("audiogram_clip needs a member id")
        # --member alone already implies --clips-only in the CLI; passing the
        # scope explicitly keeps the previewed command self-explanatory.
        return audiogram_round_argv(
            settings, prompt_id, members=(member_id,), scope="clips-only",
            fmt=str(bindings.get("format", "16x9")),
            with_prompt=bool(bindings.get("with_prompt", False)),
            force=bool(bindings.get("force", False)),
        )
    if action.id in ("transcribe_clip", "upload_transcript", "pull_transcript"):
        if not member_id:
            raise ValueError(f"{action.id} needs a member id")
        return transcribe_argv(
            settings, prompt_id, members=(member_id,),
            model=str(bindings.get("model", "small")),
            force=bool(bindings.get("force", False)),
            upload_only=action.id == "upload_transcript",
            pull=action.id == "pull_transcript",
        )
    if action.id == "transcribe_round":
        return transcribe_argv(
            settings, prompt_id,
            model=str(bindings.get("model", "small")),
            force=bool(bindings.get("force", False)),
        )
    if action.id == "compile_segment":
        return compile_argv(settings, prompt_id, force=bool(bindings.get("force", False)))
    if action.id == "audiogram_file":
        return audiogram_file_argv(
            settings, bindings.get("audio_path", ""),
            fmt=str(bindings.get("format", "16x9")),
            title=str(bindings.get("title", "")),
            name=str(bindings.get("name", "")),
            force=bool(bindings.get("force", False)),
        )
    raise ValueError(f"unknown action: {action.id}")
