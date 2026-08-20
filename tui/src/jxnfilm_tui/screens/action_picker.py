"""Pick an action for the current selection."""

from __future__ import annotations

import textwrap

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Label, ListItem, ListView, Static

from ..actions.catalog import Action

# The box is 84 wide; wrap here rather than relying on the layout, which
# clips a long summary instead of growing the row.
SUMMARY_WIDTH = 72


def _item_text(action: Action, subject: str) -> str:
    summary = "\n".join(textwrap.wrap(action.summary, SUMMARY_WIDTH))
    return f"[b]{action.title}[/]  [dim]· {subject}[/]\n[dim]{summary}[/]"


class ActionPicker(ModalScreen):
    """→ the chosen (Action, subject) pair, or None.

    Entries are passed in rather than filtered by scope here, so one list can
    mix "this clip" and "this whole round" actions — which is the choice the
    operator is actually making.
    """

    BINDINGS = [("escape", "dismiss_none", "Cancel")]

    def __init__(self, entries, heading: str) -> None:
        super().__init__()
        self.entries = tuple(entries)
        self.heading = heading

    def compose(self) -> ComposeResult:
        with Vertical(id="picker-box"):
            yield Label(self.heading, classes="pane-title")
            yield ListView(
                *[ListItem(Label(_item_text(a, subject)), id=f"act-{i}")
                  for i, (a, subject) in enumerate(self.entries)],
                id="action-list",
            )
            yield Static("[dim]enter to choose · esc to cancel[/]", classes="note")

    def on_mount(self) -> None:
        if not self.entries:
            self.dismiss(None)

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        index = event.list_view.index or 0
        if 0 <= index < len(self.entries):
            self.dismiss(self.entries[index])

    def action_dismiss_none(self) -> None:
        self.dismiss(None)
