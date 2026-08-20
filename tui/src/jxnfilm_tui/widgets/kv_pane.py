"""Read-only KV browser: prefix → keys → one value.

Read-only on purpose. Two of these prefixes are aggregates that the Worker and
its crons rebuild from canonical rows, and hand-patching one has already cost
this project a signup. Editing lives in the admin dashboard, behind the
Worker's own endpoints; this pane is for looking.

Values are fetched one at a time on selection rather than bulk-read, both
because `members:all` is a single fat value and because a rapid burst of
per-key gets is exactly what draws the spurious 401.
"""

from __future__ import annotations

from textual import work
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import DataTable, Label, ListItem, ListView, Static

from ..data.kv import list_prefix, read_value
from ..settings import KV_PREFIXES

# Guard against pasting a novel into the value pane; KV values can be large.
MAX_VALUE_CHARS = 200_000


class KvPane(Vertical):
    def __init__(self) -> None:
        super().__init__()
        self._entries = []
        self._prefix = KV_PREFIXES[0]

    def compose(self) -> ComposeResult:
        with Horizontal(id="kv-split"):
            with Vertical(id="kv-prefixes"):
                yield Label("Prefix", classes="pane-title")
                yield ListView(
                    *[ListItem(Label(p.label), id=f"pfx-{index}")
                      for index, p in enumerate(KV_PREFIXES)],
                    id="kv-prefix-list",
                )
            with Vertical(id="kv-keys"):
                yield Label("Keys", classes="pane-title")
                yield DataTable(id="kv-key-table", cursor_type="row", zebra_stripes=True)
            with Vertical(id="kv-value"):
                yield Label("Value", classes="pane-title")
                with VerticalScroll():
                    yield Static("", id="kv-value-body")
        yield Static("", id="kv-note", classes="note")

    def on_mount(self) -> None:
        table = self.query_one("#kv-key-table", DataTable)
        table.add_columns("key", "expires")
        self._set_note()
        self.load_prefix()

    # --- events -----------------------------------------------------------

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        if event.item is None or event.list_view.id != "kv-prefix-list":
            return
        index = event.list_view.index or 0
        if 0 <= index < len(KV_PREFIXES):
            self._prefix = KV_PREFIXES[index]
            self._set_note()
            self.load_prefix()

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        if event.data_table.id != "kv-key-table":
            return
        index = event.cursor_row
        if index is None or not (0 <= index < len(self._entries)):
            return
        self.load_value(self._entries[index].key)

    # --- workers ----------------------------------------------------------

    @work(thread=True, exclusive=True, group="kv-list")
    def load_prefix(self) -> None:
        settings = self.app.settings
        prefix = self._prefix.prefix
        self.app.call_from_thread(self._set_keys_loading, prefix)
        entries, error = list_prefix(settings, prefix)
        # The env or prefix may have changed while we were waiting; a stale
        # answer must not overwrite what the user is now looking at.
        if prefix != self._prefix.prefix or settings is not self.app.settings:
            return
        self.app.call_from_thread(self._apply_keys, entries, error)

    @work(thread=True, exclusive=True, group="kv-value")
    def load_value(self, key: str) -> None:
        settings = self.app.settings
        text, error = read_value(settings, key)
        if settings is not self.app.settings:
            return
        self.app.call_from_thread(self._apply_value, key, text, error)

    # --- rendering --------------------------------------------------------

    def _set_keys_loading(self, prefix: str) -> None:
        self.query_one("#kv-key-table", DataTable).clear()
        self._entries = []
        self.query_one("#kv-value-body", Static).update(f"[dim]Listing {prefix}…[/]")

    def _apply_keys(self, entries, error) -> None:
        self._entries = list(entries)
        table = self.query_one("#kv-key-table", DataTable)
        table.clear()
        body = self.query_one("#kv-value-body", Static)
        if error:
            body.update(f"[b red]Could not list {self._prefix.prefix}[/]\n\n{error}")
            return
        for entry in self._entries:
            table.add_row(
                entry.key,
                entry.expiration.strftime("%Y-%m-%d") if entry.expiration else "[dim]—[/]",
            )
        if not self._entries:
            body.update(f"[dim]No keys under {self._prefix.prefix} in "
                        f"{self.app.settings.env_name}.[/]")
        else:
            body.update("[dim]Select a key to read its value.[/]")

    def _apply_value(self, key: str, text: str, error) -> None:
        body = self.query_one("#kv-value-body", Static)
        if error:
            body.update(f"[b red]{key}[/]\n\n{error}")
            return
        truncated = ""
        if len(text) > MAX_VALUE_CHARS:
            text = text[:MAX_VALUE_CHARS]
            truncated = f"\n\n[dim]… truncated at {MAX_VALUE_CHARS:,} chars[/]"
        # Escape markup — KV values are data, and a stray [b] in one would
        # otherwise be interpreted as formatting.
        escaped = text.replace("[", r"\[")
        body.update(f"[b]{key}[/]\n\n{escaped}{truncated}")

    def _set_note(self) -> None:
        note = self._prefix.note
        if self._prefix.aggregate:
            note = f"[yellow]aggregate[/] · {note}"
        self.query_one("#kv-note", Static).update(f"[dim]{self._prefix.prefix}[/] {note}")

    def refresh_data(self) -> None:
        self.load_prefix()
