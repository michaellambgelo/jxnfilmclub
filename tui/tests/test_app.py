"""Pilot smoke tests. No wrangler, no network, no ffmpeg.

Both collectors are stubbed at the module boundary the app imports them
through, so mounting the app can't reach Cloudflare even by accident.
"""

from __future__ import annotations

import pytest

from jxnfilm_tui import app as app_module
from jxnfilm_tui.app import JxnFilmTui
from jxnfilm_tui.data.parsers import group_rounds, parse_voice_row
from jxnfilm_tui.model.state import BucketInfo, LoadResult, utcnow
from jxnfilm_tui.settings import Settings
from jxnfilm_tui.widgets import kv_pane as kv_pane_module
from jxnfilm_tui.widgets.rounds_pane import RoundsPane


def _clip(prompt, member, status="approved", at="2026-08-01T00:00:00.000Z"):
    return parse_voice_row(
        f"voice:{prompt}:{member}",
        f'{{"memberId":"{member}","name":"{member.title()}","status":"{status}",'
        f'"r2Key":"voice/{prompt}/{member}.webm","at":"{at}","duration":90}}',
    )


def _result():
    return LoadResult(
        rounds=group_rounds([
            _clip("general", "alice"),
            _clip("general", "bob", status="pending", at="2026-08-02T00:00:00.000Z"),
            _clip("noir", "cass", at="2026-09-01T00:00:00.000Z"),
        ]),
        fetched_at=utcnow(),
    )


@pytest.fixture
def stubbed(monkeypatch, repo_root):
    monkeypatch.setattr(app_module, "load_rounds",
                        lambda settings, progress=None: _result())
    monkeypatch.setattr(app_module, "missing_tools", lambda settings: [])
    # Without this the Pilot tests make a real `r2 bucket info` call.
    monkeypatch.setattr(
        app_module, "bucket_info",
        lambda settings: BucketInfo(name=settings.bucket, object_count=3, size="4.2 MB"),
    )
    monkeypatch.setattr(kv_pane_module, "list_prefix", lambda settings, prefix: ([], None))
    monkeypatch.setattr(kv_pane_module, "read_value", lambda settings, key: ("{}", None))
    return JxnFilmTui(Settings(repo_root=repo_root))


async def test_rounds_render_newest_first(stubbed):
    async with stubbed.run_test() as pilot:
        await pilot.pause()
        pane = stubbed.query_one(RoundsPane)
        assert [r.prompt_id for r in pane.rounds] == ["noir", "general"]
        assert pane.selected_round.prompt_id == "noir"


async def test_selecting_a_round_swaps_the_clip_table(stubbed):
    async with stubbed.run_test() as pilot:
        await pilot.pause()
        pane = stubbed.query_one(RoundsPane)
        table = pane.query_one("#rounds-table")
        table.move_cursor(row=1)
        await pilot.pause()
        assert pane.selected_round.prompt_id == "general"
        # Submission order, and both statuses present.
        assert [c.member_id for c in pane.selected_round.clips] == ["alice", "bob"]
        assert pane.selected_clip.member_id == "alice"


async def test_env_toggle_swaps_bucket_and_rebuilds_settings(stubbed):
    async with stubbed.run_test() as pilot:
        await pilot.pause()
        before = stubbed.settings
        await pilot.press("e")
        await pilot.pause()
        assert stubbed.settings is not before
        assert stubbed.settings.env_name == "staging"
        assert stubbed.settings.bucket == "jxnfilm-voice-staging"
        await pilot.press("e")
        await pilot.pause()
        assert stubbed.settings.env_name == "production"


async def test_action_picker_offers_both_grains(stubbed):
    """Clip actions first (the cursor is on one), then the round actions."""
    from jxnfilm_tui.screens.action_picker import ActionPicker

    async with stubbed.run_test() as pilot:
        await pilot.pause()
        await pilot.press("a")
        await pilot.pause()
        assert isinstance(stubbed.screen, ActionPicker)
        scopes = [a.scope for a, _ in stubbed.screen.entries]
        assert scopes[0] == "clip"
        assert "round" in scopes
        # The clip entry is labelled with the speaker, not the prompt id.
        assert stubbed.screen.entries[0][1] == "Cass"
        await pilot.press("escape")
        await pilot.pause()
        assert not isinstance(stubbed.screen, ActionPicker)


async def test_no_clip_action_offered_for_an_unapproved_clip(stubbed):
    """A pending clip can't be rendered — the CLI would refuse it."""
    from jxnfilm_tui.screens.action_picker import ActionPicker
    from jxnfilm_tui.widgets.rounds_pane import RoundsPane

    async with stubbed.run_test() as pilot:
        await pilot.pause()
        pane = stubbed.query_one(RoundsPane)
        pane.query_one("#rounds-table").move_cursor(row=1)   # "general"
        await pilot.pause()
        pane.query_one("#clips-table").move_cursor(row=1)    # bob, pending
        await pilot.pause()
        assert pane.selected_clip.status == "pending"
        await pilot.press("a")
        await pilot.pause()
        assert isinstance(stubbed.screen, ActionPicker)
        assert {a.scope for a, _ in stubbed.screen.entries} == {"round"}


async def test_kv_tab_mounts_without_touching_the_network(stubbed):
    async with stubbed.run_test() as pilot:
        await pilot.pause()
        from textual.widgets import TabbedContent
        stubbed.query_one("#tabs", TabbedContent).active = "tab-kv"
        await pilot.pause()
        from jxnfilm_tui.widgets.kv_pane import KvPane
        assert stubbed.query_one(KvPane).is_mounted


async def test_read_failure_is_shown_not_swallowed(stubbed, monkeypatch):
    monkeypatch.setattr(
        app_module, "load_rounds",
        lambda settings, progress=None: LoadResult(error="401 Unauthorized",
                                                   fetched_at=utcnow()),
    )
    async with stubbed.run_test() as pilot:
        await pilot.pause()
        pane = stubbed.query_one(RoundsPane)
        assert pane.rounds == ()
        detail = pane.query_one("#clip-detail")
        assert "Could not read KV" in str(detail.content)


async def test_status_bar_is_visible_and_not_under_the_footer(stubbed):
    """A second bottom-docked widget lands in the Footer's row and vanishes."""
    from textual.widgets import Footer

    async with stubbed.run_test(size=(120, 30)) as pilot:
        await pilot.pause()
        status = stubbed.query_one("#status")
        footer = stubbed.query_one(Footer)
        assert status.region.height == 1
        assert status.region.y < footer.region.y
        assert "production" in str(status.content)


async def test_bucket_counts_reach_the_status_bar(stubbed):
    """`r2 bucket info` is the only aggregate read R2 offers — surface it."""
    async with stubbed.run_test() as pilot:
        await pilot.pause()
        for _ in range(20):
            if stubbed.bucket is not None:
                break
            await pilot.pause()
        status = str(stubbed.query_one("#status").content)
        assert "jxnfilm-voice (3 obj · 4.2 MB)" in status


async def test_a_failed_bucket_read_leaves_the_rows_alone(stubbed, monkeypatch):
    """R2 is fetched after the rows so it can never delay or blank the table."""
    from jxnfilm_tui.data.wrangler import WranglerError

    def boom(settings):
        raise WranglerError("503 Service Unavailable")

    monkeypatch.setattr(app_module, "bucket_info", boom)
    async with stubbed.run_test() as pilot:
        await pilot.pause()
        pane = stubbed.query_one(RoundsPane)
        assert [r.prompt_id for r in pane.rounds] == ["noir", "general"]
        assert stubbed.bucket is None
