"""The app: two tabs over one environment, plus the action pipeline.

Structure follows cluster-tui — the app owns the data layer and the env
toggle, the panes only render what they're handed, and every mutating thing
the TUI can do is a catalog action that shells out to a script this repo
already ships. Nothing here reimplements normalization, rendering, or KV
access.
"""

from __future__ import annotations

import subprocess
import sys

from textual import work
from textual.app import App, ComposeResult
from textual.widgets import Footer, Header, Static, TabbedContent, TabPane

from .actions.catalog import BY_ID, CATALOG
from .actions.runner import job_for
from .data.voices import load_rounds
from .data.wrangler import WranglerError, bucket_info, missing_tools, r2_exists
from .model.state import LoadResult
from .screens.action_picker import ActionPicker
from .screens.launch import LaunchScreen
from .screens.run_output import RunScreen
from .settings import ENVS, Settings


class JxnFilmTui(App):
    CSS_PATH = "app.tcss"
    TITLE = "JXN Film Club — audiograms"

    BINDINGS = [
        ("r", "refresh", "Refresh"),
        ("e", "toggle_env", "Env"),
        ("a", "run_action", "Actions"),
        ("f", "render_file", "Render file"),
        ("p", "probe_clip", "Probe audio"),
        ("o", "open_out", "Open out/"),
        ("q", "quit", "Quit"),
    ]

    def __init__(self, settings: Settings | None = None) -> None:
        super().__init__()
        self.settings = settings or Settings.discover()
        self.voice_result = LoadResult()
        self.bucket = None

    def compose(self) -> ComposeResult:
        from .widgets.kv_pane import KvPane
        from .widgets.rounds_pane import RoundsPane

        yield Header()
        with TabbedContent(id="tabs"):
            with TabPane("Rounds", id="tab-rounds"):
                yield RoundsPane()
            with TabPane("KV", id="tab-kv"):
                yield KvPane()
        yield Static("", id="status", classes="status")
        yield Footer()

    def on_mount(self) -> None:
        missing = missing_tools(self.settings)
        if missing:
            self.notify(
                "Missing: " + ", ".join(missing),
                title="Pipeline prerequisites",
                severity="warning",
                timeout=12,
            )
        self._update_status("loading…")
        self.load_voices()

    # --- data -------------------------------------------------------------

    @work(thread=True, exclusive=True, group="voice")
    def load_voices(self) -> None:
        settings = self.settings

        def progress(done, total, key):
            self.call_from_thread(self._update_status, f"reading {done}/{total} — {key}")

        result = load_rounds(settings, progress=progress)
        # Dropped if the env was toggled while this read was in flight.
        if settings is not self.settings:
            return
        self.call_from_thread(self._apply_voices, result)

        # Bucket-level counts, fetched after the rows so a slow/failed R2 read
        # never delays the table. `bucket info` is the ONLY aggregate read
        # wrangler offers for R2 — there is no object listing.
        try:
            info = bucket_info(settings)
        except WranglerError:
            info = None
        if settings is self.settings:
            self.call_from_thread(self._apply_bucket, info)

    def _apply_bucket(self, info) -> None:
        self.bucket = info
        self._update_status()

    def _apply_voices(self, result: LoadResult) -> None:
        from .widgets.rounds_pane import RoundsPane

        self.voice_result = result
        self.query_one(RoundsPane).update_result(result)
        self._update_status()
        if result.warnings:
            self.notify(
                f"{len(result.warnings)} row(s) had problems — first: {result.warnings[0]}",
                title="Partial read",
                severity="warning",
                timeout=10,
            )

    def _update_status(self, message: str = "") -> None:
        env = self.settings.env_name
        env_markup = "[b red]production[/]" if env == "production" else "[b yellow]staging[/]"
        bucket_text = self.settings.bucket
        if self.bucket is not None and self.bucket.object_count is not None:
            bucket_text += f" ({self.bucket.object_count} obj · {self.bucket.size})"
        parts = [f"env {env_markup}", f"bucket [dim]{bucket_text}[/]"]
        if message:
            parts.append(f"[dim]{message}[/]")
        else:
            result = self.voice_result
            if result.error:
                parts.append("[b red]read failed[/]")
            else:
                clips = sum(len(r.clips) for r in result.rounds)
                approved = sum(len(r.approved_clips) for r in result.rounds)
                parts.append(f"{len(result.rounds)} round(s) · {clips} clip(s) · "
                             f"[green]{approved} approved[/]")
            if result.fetched_at:
                parts.append(f"[dim]read {result.fetched_at.strftime('%H:%M:%SZ')}[/]")
        self.query_one("#status", Static).update("  ·  ".join(parts))

    # --- actions ----------------------------------------------------------

    def action_refresh(self) -> None:
        from .widgets.kv_pane import KvPane

        self._update_status("refreshing…")
        self.load_voices()
        if self.query_one("#tabs", TabbedContent).active == "tab-kv":
            self.query_one(KvPane).refresh_data()

    def action_toggle_env(self) -> None:
        from .widgets.kv_pane import KvPane

        index = ENVS.index(self.settings.env_name)
        # Replacing Settings (rather than mutating) is what lets in-flight
        # workers detect that their answer is stale — identity is the check.
        self.settings = self.settings.with_env(ENVS[(index + 1) % len(ENVS)])
        self.voice_result = LoadResult()
        self.bucket = None
        self._update_status("switching env…")
        self.load_voices()
        self.query_one(KvPane).refresh_data()

    @work
    async def action_run_action(self) -> None:
        from .widgets.rounds_pane import RoundsPane

        if self.query_one("#tabs", TabbedContent).active != "tab-rounds":
            self.notify("Actions run on a round — switch to the Rounds tab.",
                        severity="information")
            return
        pane = self.query_one(RoundsPane)
        rnd = pane.selected_round
        if rnd is None:
            self.notify("No round selected.", severity="information")
            return
        clip = pane.selected_clip

        # One list, both grains: the highlighted clip on its own, or the whole
        # round. Clip actions come first because the cursor is already on one.
        entries = []
        if clip is not None and clip.approved:
            entries += [(a, clip.label) for a in CATALOG if a.scope == "clip"]
        entries += [(a, rnd.prompt_id) for a in CATALOG if a.scope == "round"]

        chosen = await self.push_screen_wait(
            ActionPicker(entries, f"Run on [b]{rnd.prompt_id}[/]")
        )
        if chosen is None:
            return
        action, subject = chosen
        member_id = clip.member_id if (clip is not None and action.scope == "clip") else ""

        if action.scope == "round" and not rnd.renderable:
            self.notify(
                f"{rnd.prompt_id} has no approved clips — both CLIs will refuse. "
                "Approve them in the admin Voice tab first.",
                severity="warning", timeout=10,
            )
        bindings = await self.push_screen_wait(
            LaunchScreen(action, self.settings, prompt_id=rnd.prompt_id,
                         member_id=member_id, subject=subject)
        )
        if bindings is None:
            return
        await self._run(action, bindings, round_=rnd, subject=subject,
                        member_id=member_id)

    @work
    async def action_render_file(self) -> None:
        action = BY_ID["audiogram_file"]
        bindings = await self.push_screen_wait(
            LaunchScreen(action, self.settings, subject="local file")
        )
        if bindings is None:
            return
        if not str(bindings.get("audio_path", "")).strip():
            self.notify("No audio file given.", severity="warning")
            return
        await self._run(action, bindings, subject="local file")

    async def _run(self, action, bindings, *, round_=None, subject: str = "",
                   member_id: str = "") -> None:
        try:
            job = job_for(action, self.settings, bindings, round_=round_,
                          member_id=member_id)
        except ValueError as exc:
            self.notify(str(exc), severity="error")
            return
        await self.push_screen_wait(RunScreen(job, f"{action.title} — {subject}"))
        # Renders and archives both change what's on disk; re-read so the
        # clip table's "rendered" column reflects it.
        self.load_voices()

    def action_probe_clip(self) -> None:
        """Is this clip's audio still in R2?

        wrangler has no HEAD and no object listing, so the only way to answer
        is to fetch the object — hence a deliberate keypress rather than a
        background poll. Clips are capped at 8MB, so it's bounded.
        """
        from .widgets.rounds_pane import RoundsPane

        if self.query_one("#tabs", TabbedContent).active != "tab-rounds":
            return
        clip = self.query_one(RoundsPane).selected_clip
        if clip is None or not clip.r2_key:
            self.notify("No clip with an r2Key selected.", severity="information")
            return
        self.notify(f"Downloading {clip.r2_key} to check it's still there…",
                    title="Probing R2", timeout=6)
        self._probe(clip.r2_key, clip.label)

    @work(thread=True, group="probe")
    def _probe(self, r2_key: str, label: str) -> None:
        settings = self.settings
        try:
            present = r2_exists(settings, r2_key)
            message = (f"{label}: audio present" if present
                       else f"{label}: GONE from R2 — aged out (60-day lifecycle)")
            severity = "information" if present else "warning"
        except WranglerError as exc:
            message, severity = f"{label}: probe failed — {exc}", "error"
        if settings is self.settings:
            self.call_from_thread(self.notify, message, severity=severity, timeout=10)

    def action_open_out(self) -> None:
        target = self.settings.out_dir
        if not target.exists():
            self.notify(f"{target} doesn't exist yet — nothing rendered.",
                        severity="information")
            return
        opener = {"darwin": "open", "win32": "explorer"}.get(sys.platform, "xdg-open")
        try:
            subprocess.Popen([opener, str(target)])
        except OSError as exc:
            self.notify(f"could not open {target}: {exc}", severity="error")


def run() -> None:
    JxnFilmTui().run()
