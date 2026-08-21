"""Argv building. What the launch modal previews is what runs."""

from __future__ import annotations

import pytest

from jxnfilm_tui.actions.argv import (
    audiogram_file_argv, audiogram_round_argv, compile_argv, render_command,
)
from jxnfilm_tui.actions.catalog import BY_ID, build, defaults_for


def test_round_render_defaults(settings):
    argv = audiogram_round_argv(settings, "general")
    assert argv[0] == "node"
    assert argv[1].endswith("scripts/make_audiogram.mjs")
    assert argv[2:] == ["--prompt", "general", "--env", "production", "--format", "16x9"]


def test_round_render_flags(settings):
    argv = audiogram_round_argv(settings, "noir", fmt="all", with_prompt=True,
                                scope="segment-only")
    assert "--with-prompt" in argv and "--segment-only" in argv
    assert "--clips-only" not in argv
    assert argv[argv.index("--format") + 1] == "all"


def test_staging_env_reaches_the_cli(settings):
    argv = audiogram_round_argv(settings.with_env("staging"), "general")
    assert argv[argv.index("--env") + 1] == "staging"


def test_bad_inputs_are_refused_before_anything_spawns(settings):
    with pytest.raises(ValueError):
        audiogram_round_argv(settings, "general", fmt="4x3")
    with pytest.raises(ValueError):
        audiogram_round_argv(settings, "general", scope="only-the-good-bits")
    with pytest.raises(ValueError):
        audiogram_round_argv(settings, "")
    with pytest.raises(ValueError):
        compile_argv(settings, "")


def test_file_mode_omits_empty_text_options(settings):
    argv = audiogram_file_argv(settings, "/tmp/clip.wav")
    assert "--title" not in argv and "--name" not in argv
    argv = audiogram_file_argv(settings, "/tmp/clip.wav", title="Night Shift", name="Alice")
    assert argv[argv.index("--title") + 1] == "Night Shift"
    assert argv[argv.index("--name") + 1] == "Alice"
    # File mode never talks to KV or R2, so it must not carry an env flag.
    assert "--env" not in argv


def test_catalog_build_matches_the_direct_builders(settings):
    action = BY_ID["audiogram_round"]
    bindings = defaults_for(action)
    assert build(action, settings, bindings, prompt_id="general") == \
        audiogram_round_argv(settings, "general")


def test_member_flag_narrows_the_round(settings):
    argv = audiogram_round_argv(settings, "general", members=("alice", "cass"))
    assert argv.count("--member") == 2
    assert argv[argv.index("--member") + 1] == "alice"


def test_blank_member_is_refused(settings):
    with pytest.raises(ValueError):
        audiogram_round_argv(settings, "general", members=("",))


def test_clip_action_renders_one_member_and_no_segment(settings):
    """The finer grain: one clip, one R2 download, no segment file."""
    action = BY_ID["audiogram_clip"]
    argv = build(action, settings, defaults_for(action),
                 prompt_id="general", member_id="alice")
    assert argv[argv.index("--member") + 1] == "alice"
    assert "--clips-only" in argv
    assert "--segment-only" not in argv


def test_clip_action_without_a_member_is_refused(settings):
    action = BY_ID["audiogram_clip"]
    with pytest.raises(ValueError):
        build(action, settings, defaults_for(action), prompt_id="general")


def test_round_action_still_renders_everything(settings):
    """The other grain: no --member at all means the whole approved round."""
    action = BY_ID["audiogram_round"]
    argv = build(action, settings, defaults_for(action), prompt_id="general")
    assert "--member" not in argv
    assert "--clips-only" not in argv and "--segment-only" not in argv


def test_full_segment_only_is_reachable_from_the_round_action(settings):
    action = BY_ID["audiogram_round"]
    bindings = defaults_for(action) | {"scope": "segment-only"}
    argv = build(action, settings, bindings, prompt_id="general")
    assert "--segment-only" in argv
    assert "--member" not in argv


def test_internal_actions_have_no_argv(settings):
    with pytest.raises(ValueError):
        build(BY_ID["archive_round"], settings, {}, prompt_id="general")


def test_render_command_quotes_only_what_needs_it():
    assert render_command(["node", "a.mjs", "--title", "Night Shift"]) == \
        'node a.mjs --title "Night Shift"'


def test_render_command_shortens_repo_paths_for_display(settings):
    """Display only — the argv that runs keeps the absolute path."""
    argv = audiogram_round_argv(settings, "general")
    shown = render_command(argv, settings.repo_root)
    assert shown.startswith("node scripts/make_audiogram.mjs --prompt general")
    assert str(settings.repo_root) not in shown
    assert argv[1].startswith(str(settings.repo_root))


def test_every_catalog_action_declares_a_known_scope():
    for action in BY_ID.values():
        assert action.scope in ("round", "clip", "file")
        for opt in action.options:
            assert opt.kind in ("choice", "bool", "text")
            if opt.kind == "choice":
                assert opt.default in opt.choices


def test_force_is_off_unless_ticked(settings):
    """Every render action defaults to refusing to overwrite."""
    for action_id in ("audiogram_round", "audiogram_clip", "compile_segment",
                      "audiogram_file"):
        action = BY_ID[action_id]
        bindings = defaults_for(action) | {"audio_path": "/tmp/x.wav"}
        argv = build(action, settings, bindings, prompt_id="general", member_id="alice")
        assert "--force" not in argv, action_id


def test_force_reaches_every_cli_when_ticked(settings):
    for action_id in ("audiogram_round", "audiogram_clip", "compile_segment",
                      "audiogram_file"):
        action = BY_ID[action_id]
        bindings = defaults_for(action) | {"force": True, "audio_path": "/tmp/x.wav"}
        argv = build(action, settings, bindings, prompt_id="general", member_id="alice")
        assert "--force" in argv, action_id


def test_transcribe_defaults(settings):
    from jxnfilm_tui.actions.argv import transcribe_argv

    argv = transcribe_argv(settings, "general", members=("alice",))
    assert argv[1].endswith("scripts/transcribe.mjs")
    assert argv[argv.index("--member") + 1] == "alice"
    assert argv[argv.index("--model") + 1] == "small"
    # Not uploaded by default: a machine transcript is a draft.
    assert "--upload" not in argv and "--upload-only" not in argv
    assert "--force" not in argv


def test_upload_only_runs_no_model(settings):
    """Re-transcribing at upload time would overwrite the very edits the
    upload exists to publish."""
    from jxnfilm_tui.actions.argv import transcribe_argv

    argv = transcribe_argv(settings, "general", members=("alice",), upload_only=True)
    assert "--upload-only" in argv
    assert "--model" not in argv
    assert "--force" not in argv


def test_transcribe_rejects_an_unknown_model(settings):
    from jxnfilm_tui.actions.argv import transcribe_argv

    with pytest.raises(ValueError):
        transcribe_argv(settings, "general", model="enormous")
    with pytest.raises(ValueError):
        transcribe_argv(settings, "")


def test_transcribe_actions_wire_through_the_catalog(settings):
    clip_action = BY_ID["transcribe_clip"]
    argv = build(clip_action, settings, defaults_for(clip_action),
                 prompt_id="general", member_id="alice")
    assert "--prompt" in argv and argv[argv.index("--member") + 1] == "alice"

    upload = BY_ID["upload_transcript"]
    argv = build(upload, settings, defaults_for(upload),
                 prompt_id="general", member_id="alice")
    assert "--upload-only" in argv

    rnd = BY_ID["transcribe_round"]
    argv = build(rnd, settings, defaults_for(rnd), prompt_id="general")
    assert "--member" not in argv


def test_clip_scoped_transcribe_needs_a_member(settings):
    for action_id in ("transcribe_clip", "upload_transcript"):
        action = BY_ID[action_id]
        with pytest.raises(ValueError):
            build(action, settings, defaults_for(action), prompt_id="general")


def test_pull_overwrites_and_runs_no_model(settings):
    """R2 wins: the admin panel edits there, so local is stale once round-tripped."""
    from jxnfilm_tui.actions.argv import transcribe_argv

    argv = transcribe_argv(settings, "general", members=("alice",), pull=True)
    assert "--pull" in argv
    assert "--model" not in argv and "--upload-only" not in argv


def test_pull_and_upload_are_refused_together(settings):
    from jxnfilm_tui.actions.argv import transcribe_argv

    with pytest.raises(ValueError, match="opposite directions"):
        transcribe_argv(settings, "general", members=("a",), pull=True, upload_only=True)


def test_the_three_transcript_actions_are_clip_scoped(settings):
    for action_id in ("transcribe_clip", "upload_transcript", "pull_transcript"):
        assert BY_ID[action_id].scope == "clip"
        action = BY_ID[action_id]
        argv = build(action, settings, defaults_for(action),
                     prompt_id="general", member_id="alice")
        assert argv[argv.index("--member") + 1] == "alice"
