"""Entry point: `uv run jxnfilm-tui` (or `python -m jxnfilm_tui`)."""

from __future__ import annotations

import sys

from .app import JxnFilmTui
from .settings import ENVS, Settings


def main() -> int:
    env_name = "production"
    argv = sys.argv[1:]
    if argv:
        if argv[0] in ("-h", "--help"):
            print(f"usage: jxnfilm-tui [{'|'.join(ENVS)}]")
            return 0
        if argv[0] not in ENVS:
            print(f"error: env must be one of {', '.join(ENVS)} (got {argv[0]!r})",
                  file=sys.stderr)
            return 2
        env_name = argv[0]
    try:
        settings = Settings.discover(env_name)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    JxnFilmTui(settings).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
