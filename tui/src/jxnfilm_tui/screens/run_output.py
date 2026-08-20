"""Live output for one running job.

ffmpeg's own chatter is swallowed by the CLIs (they capture it and only
surface failures), so what streams here is the script's progress narration —
"Pulling…", "Normalizing…", "Rendering…", then the written-file list. That is
the useful signal for a render that takes minutes.
"""

from __future__ import annotations

from textual import work
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Footer, Header, Label, RichLog, Static


class RunScreen(Screen):
    BINDINGS = [
        ("escape", "close", "Close"),
        ("c", "cancel", "Cancel run"),
    ]

    def __init__(self, job, title: str) -> None:
        super().__init__()
        self.job = job
        self.title_text = title
        self.exit_code: int | None = None

    def compose(self) -> ComposeResult:
        yield Header()
        with Vertical(id="run-box"):
            yield Label(f"[b]{self.title_text}[/]", classes="pane-title")
            yield RichLog(id="run-output", highlight=False, markup=False, wrap=True)
            yield Static("[dim]running…[/]", id="run-status", classes="note")
        yield Footer()

    def on_mount(self) -> None:
        self.run_job()

    @work(exclusive=True)
    async def run_job(self) -> None:
        log = self.query_one("#run-output", RichLog)
        code = await self.job.run(log.write)
        self.exit_code = code
        status = self.query_one("#run-status", Static)
        if code == 0:
            status.update("[b green]done[/] — esc to close")
        elif code == 130:
            status.update("[yellow]cancelled[/] — esc to close")
        else:
            status.update(f"[b red]exit {code}[/] — esc to close")

    async def action_cancel(self) -> None:
        if self.exit_code is None:
            self.query_one("#run-status", Static).update("[yellow]cancelling…[/]")
            await self.job.cancel()

    async def action_close(self) -> None:
        if self.exit_code is None:
            await self.job.cancel()
        self.dismiss(self.exit_code)
