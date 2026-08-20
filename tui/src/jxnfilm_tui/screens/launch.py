"""Bind an action's options, and show the exact command before it runs.

The preview is built by the same pure `catalog.build` the runner uses, so what
you read here is what executes — no second code path to drift.
"""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Select, Static, Switch

from ..actions.argv import render_command
from ..actions.catalog import Action, build, defaults_for


class LaunchScreen(ModalScreen):
    """→ the option bindings dict, or None."""

    BINDINGS = [("escape", "cancel", "Cancel")]

    def __init__(self, action: Action, settings, *, prompt_id: str = "",
                 member_id: str = "", subject: str = "") -> None:
        super().__init__()
        self.action = action
        self.settings = settings
        self.prompt_id = prompt_id
        self.member_id = member_id
        self.subject = subject or prompt_id
        self.bindings_values = defaults_for(action)

    def compose(self) -> ComposeResult:
        with Vertical(id="launch-box"):
            yield Label(f"[b]{self.action.title}[/] — {self.subject}", classes="pane-title")
            yield Static(self.action.summary, classes="note")
            with VerticalScroll(id="launch-options"):
                for opt in self.action.options:
                    with Horizontal(classes="opt-row"):
                        yield Label(opt.label, classes="opt-label")
                        if opt.kind == "choice":
                            yield Select(
                                [(choice, choice) for choice in opt.choices],
                                value=opt.default, allow_blank=False,
                                id=f"opt-{opt.name}",
                            )
                        elif opt.kind == "bool":
                            yield Switch(value=bool(opt.default), id=f"opt-{opt.name}")
                        else:
                            yield Input(value=str(opt.default), placeholder=opt.help,
                                        id=f"opt-{opt.name}")
                    if opt.help and opt.kind != "text":
                        yield Static(f"[dim]{opt.help}[/]", classes="opt-help")
            yield Static("", id="command-preview", classes="command")
            if self.action.cost:
                yield Static(f"[dim]cost: {self.action.cost}[/]", classes="note")
            with Horizontal(id="launch-buttons"):
                yield Button("Run", variant="primary", id="run")
                yield Button("Cancel", id="cancel")

    def on_mount(self) -> None:
        self._update_preview()

    # --- option changes ---------------------------------------------------

    def _record(self, widget_id: str | None, value) -> None:
        if widget_id and widget_id.startswith("opt-"):
            self.bindings_values[widget_id[len("opt-"):]] = value
            self._update_preview()

    def on_select_changed(self, event: Select.Changed) -> None:
        self._record(event.select.id, event.value)

    def on_switch_changed(self, event: Switch.Changed) -> None:
        self._record(event.switch.id, event.value)

    def on_input_changed(self, event: Input.Changed) -> None:
        self._record(event.input.id, event.value)

    def _update_preview(self) -> None:
        target = self.query_one("#command-preview", Static)
        if self.action.internal:
            target.update("[dim]runs in-process — one `wrangler r2 object get` per "
                          "approved clip[/]")
            return
        try:
            argv = build(self.action, self.settings, self.bindings_values,
                         prompt_id=self.prompt_id, member_id=self.member_id)
        except ValueError as exc:
            target.update(f"[red]{exc}[/]")
            return
        target.update(f"$ {render_command(argv, self.settings.repo_root)}\n[dim]cwd {self.settings.repo_root}[/]")

    # --- buttons ----------------------------------------------------------

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "run":
            self.dismiss(dict(self.bindings_values))
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)
