"""Retry policy. No subprocesses — `_with_retry` is exercised directly."""

from __future__ import annotations

import pytest

from jxnfilm_tui.data.wrangler import MissingObject, WranglerError, _with_retry


def test_transient_401_is_retried_and_succeeds():
    """The burst-401: credentials are fine, the next attempt works."""
    calls = []

    def call():
        calls.append(1)
        if len(calls) == 1:
            raise WranglerError("kv get failed", output="Authentication error 401")
        return "ok"

    assert _with_retry(call, sleep=lambda _: None) == "ok"
    assert len(calls) == 2


def test_a_real_failure_is_not_retried():
    calls = []

    def call():
        calls.append(1)
        raise WranglerError("bad flag", output="Unknown argument: --nope")

    with pytest.raises(WranglerError):
        _with_retry(call, sleep=lambda _: None)
    assert len(calls) == 1, "a deterministic failure must not burn three round-trips"


def test_missing_object_short_circuits():
    """An aged-out clip is an outcome, not something to wait on."""
    calls = []

    def call():
        calls.append(1)
        raise MissingObject("gone", output="The specified key does not exist. 404")

    with pytest.raises(MissingObject):
        _with_retry(call, sleep=lambda _: None)
    assert len(calls) == 1


def test_retries_are_bounded():
    calls = []

    def call():
        calls.append(1)
        raise WranglerError("flaky", output="503 Service Unavailable")

    with pytest.raises(WranglerError):
        _with_retry(call, attempts=3, sleep=lambda _: None)
    assert len(calls) == 3
