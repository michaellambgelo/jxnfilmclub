"""Collector: read-only KV browsing by prefix.

Deliberately thin. The TUI lists keys under a prefix and shows one value at a
time on demand — it never bulk-reads a prefix, because the two big aggregates
(`members:all`, `attendance:all`) are single fat values and the per-key
prefixes are exactly the burst that draws the 401.
"""

from __future__ import annotations

import json

from ..model.state import utcnow
from ..settings import Settings
from .wrangler import WranglerError, kv_get, kv_list


def list_prefix(settings: Settings, prefix: str):
    """→ (entries, error). Never raises; the pane renders the error itself."""
    try:
        return kv_list(settings, prefix), None
    except WranglerError as exc:
        return [], str(exc)


def read_value(settings: Settings, key: str):
    """→ (pretty_text, error). JSON is re-indented; anything else is verbatim."""
    try:
        raw = kv_get(settings, key)
    except WranglerError as exc:
        return "", str(exc)
    try:
        return json.dumps(json.loads(raw), indent=2, sort_keys=True), None
    except json.JSONDecodeError:
        return raw.rstrip("\n"), None


def stamp() -> str:
    return utcnow().strftime("%H:%M:%SZ")
