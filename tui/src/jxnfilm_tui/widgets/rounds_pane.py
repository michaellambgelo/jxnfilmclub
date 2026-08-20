"""Master-detail over the voice rounds: rounds → clips → the selected row.

The clip table is deliberately ordered the way a rendered segment plays, and
its two loudest columns are the ones that cost money to get wrong: `status`
(only `approved` clips are ever rendered) and `left` (days until the audio is
deleted, whatever its moderation state).
"""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import DataTable, Label, Static

from ..data.parsers import fmt_bytes, fmt_days, fmt_duration
from ..model.state import APPROVED, LoadResult, Round

# Below this many days remaining, the row is called out — the clip is close
# enough to the 60-day deletion that "render it later" stops being safe.
WARN_DAYS = 14


def _status_cell(status: str) -> str:
    if status == APPROVED:
        return "[b green]approved[/]"
    if status == "rejected":
        return "[dim]rejected[/]"
    return f"[yellow]{status or 'no status'}[/]"


def _days_cell(days) -> str:
    text = fmt_days(days)
    if days is None:
        return "[dim]—[/]"
    if days <= 0:
        return "[b red]expired[/]"
    if days <= WARN_DAYS:
        return f"[b yellow]{text}[/]"
    return text


class RoundsPane(Vertical):
    """Rounds list + clips table + a detail block for the highlighted clip."""

    def __init__(self) -> None:
        super().__init__()
        self._result = LoadResult()
        self._rounds: tuple[Round, ...] = ()

    def compose(self) -> ComposeResult:
        with Horizontal(id="rounds-split"):
            with Vertical(id="rounds-col"):
                yield Label("Rounds", classes="pane-title")
                yield DataTable(id="rounds-table", cursor_type="row", zebra_stripes=True)
            with Vertical(id="clips-col"):
                yield Label("Clips — segment order", classes="pane-title")
                yield DataTable(id="clips-table", cursor_type="row", zebra_stripes=True)
        with VerticalScroll(id="detail-box"):
            yield Static("", id="clip-detail")

    def on_mount(self) -> None:
        rounds = self.query_one("#rounds-table", DataTable)
        rounds.add_columns("prompt", "clips", "ok", "soonest")
        clips = self.query_one("#clips-table", DataTable)
        clips.add_columns("#", "member", "status", "len", "left", "rendered")
        self._render_detail(None)

    # --- state ------------------------------------------------------------

    @property
    def rounds(self) -> tuple[Round, ...]:
        return self._rounds

    @property
    def selected_round(self) -> Round | None:
        table = self.query_one("#rounds-table", DataTable)
        index = table.cursor_row
        if index is None or not (0 <= index < len(self._rounds)):
            return None
        return self._rounds[index]

    @property
    def selected_clip(self):
        rnd = self.selected_round
        if rnd is None:
            return None
        table = self.query_one("#clips-table", DataTable)
        index = table.cursor_row
        if index is None or not (0 <= index < len(rnd.clips)):
            return None
        return rnd.clips[index]

    def update_result(self, result: LoadResult) -> None:
        self._result = result
        self._rounds = result.rounds
        table = self.query_one("#rounds-table", DataTable)
        previous = table.cursor_row or 0
        table.clear()
        for rnd in self._rounds:
            counts = rnd.counts
            table.add_row(
                rnd.prompt_id,
                str(len(rnd.clips)),
                f"[b green]{counts[APPROVED]}[/]" if counts[APPROVED] else "[dim]0[/]",
                _days_cell(rnd.soonest_days()),
            )
        if self._rounds:
            table.move_cursor(row=min(previous, len(self._rounds) - 1))
        self._refresh_clips()

    # --- events -----------------------------------------------------------

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        if event.data_table.id == "rounds-table":
            self._refresh_clips()
        else:
            self._render_detail(self.selected_clip)

    # --- rendering --------------------------------------------------------

    def _refresh_clips(self) -> None:
        table = self.query_one("#clips-table", DataTable)
        table.clear()
        rnd = self.selected_round
        if rnd is None:
            self._render_detail(None)
            return
        for index, clip in enumerate(rnd.clips, start=1):
            rendered = ", ".join(clip.rendered) if clip.rendered else "[dim]—[/]"
            table.add_row(
                str(index),
                clip.label,
                _status_cell(clip.status),
                fmt_duration(clip.capped_seconds),
                _days_cell(clip.days_remaining()),
                rendered,
            )
        self._render_detail(self.selected_clip)

    def _render_detail(self, clip) -> None:
        target = self.query_one("#clip-detail", Static)
        rnd = self.selected_round
        if clip is None:
            if rnd is None:
                target.update(self._empty_message())
                return
            target.update(f"[b]{rnd.prompt_id}[/]  ·  no clip selected")
            return

        lines = [
            f"[b]{clip.label}[/]"
            + (f"  [dim]@{clip.handle}[/]" if clip.handle else ""),
            f"[dim]{clip.key}[/]",
            "",
            f"status     {_status_cell(clip.status)}",
            f"submitted  {clip.at.strftime('%Y-%m-%d %H:%M UTC') if clip.at else '—'}",
            f"audio left {_days_cell(clip.days_remaining())}"
            + (f"  [dim](until {clip.deadline().strftime('%Y-%m-%d')})[/]" if clip.deadline() else ""),
            f"length     {fmt_duration(clip.duration)}"
            + ("  [dim](capped to 3:00 when rendered)[/]"
               if clip.duration and clip.duration > 180 else ""),
            f"size       {fmt_bytes(clip.size)}  {clip.content_type or ''}",
            f"r2Key      {clip.r2_key or '[red]missing[/]'}",
            f"rendered   {', '.join(clip.rendered) if clip.rendered else '[dim]not yet[/]'}",
        ]
        if clip.prompt_text:
            lines += ["", f"[dim]prompt:[/] {clip.prompt_text}"]
        if clip.error:
            lines += ["", f"[b red]{clip.error}[/]"]
        if clip.status != APPROVED:
            lines += ["", "[dim]Only approved clips are rendered or archived — "
                          "approve in the admin Voice tab.[/]"]
        target.update("\n".join(lines))

    def _empty_message(self) -> str:
        if self._result.error:
            return (f"[b red]Could not read KV.[/]\n\n{self._result.error}\n\n"
                    "[dim]Check `npx wrangler whoami` from worker/, then press r.[/]")
        if self._result.fetched_at is None:
            return "[dim]Loading voice rows…[/]"
        return ("[dim]No voice submissions in this environment.[/]\n\n"
                "Clips arrive via /speak and auto-delete 60 days later, so an "
                "empty list can mean either.")
