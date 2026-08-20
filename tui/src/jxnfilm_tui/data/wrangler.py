"""The one place the TUI shells out to wrangler.

Two rules, both learned the hard way in this repo:

* **`--remote` on every call.** wrangler v4 flipped KV and R2 operations to
  default *local* (the `.wrangler/` simulator). Without the flag you get a
  confident, entirely fictional empty listing instead of production.
* **Retry the transient 401.** A burst of per-key `kv key get` calls draws a
  spurious 401 partway through even though the credentials are fine. The
  audiogram CLI treats any non-zero exit as fatal, so a burst 401 there kills
  the whole run; here it costs one retry.

Everything raises `WranglerError`; the collectors above decide what's fatal
and what's a row-level warning.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

from ..model.state import BucketInfo, KvEntry
from ..settings import KV_BINDING, Settings
from .parsers import is_missing, is_transient, parse_bucket_info, parse_kv_list

DEFAULT_TIMEOUT = 120
RETRY_ATTEMPTS = 3
RETRY_BASE_DELAY = 0.75


class WranglerError(RuntimeError):
    def __init__(self, message: str, *, output: str = "", argv=()):
        super().__init__(message)
        self.output = output
        self.argv = tuple(argv)


class MissingObject(WranglerError):
    """The R2 object is gone — the expected day-60 state, not a failure."""


def _env_flags(env_name: str) -> list[str]:
    # worker/wrangler.toml keeps staging in an [env.staging] block; production
    # is the top-level config and takes no flag.
    return ["--env", "staging"] if env_name == "staging" else []


def _first_line(text: str) -> str:
    for line in (text or "").splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return "no output"


def run_wrangler(settings: Settings, args, *, timeout: int = DEFAULT_TIMEOUT,
                 capture_binary: bool = False):
    """One `npx wrangler …` invocation from worker/ (so MEMBERS_KV resolves)."""
    argv = ["npx", "wrangler", *args]
    try:
        proc = subprocess.run(
            argv,
            cwd=settings.worker_dir,
            capture_output=True,
            timeout=timeout,
            text=not capture_binary,
        )
    except FileNotFoundError as exc:
        raise WranglerError("npx not found on PATH — is Node installed?", argv=argv) from exc
    except subprocess.TimeoutExpired as exc:
        raise WranglerError(f"wrangler timed out after {timeout}s", argv=argv) from exc

    if proc.returncode != 0:
        stderr = proc.stderr if isinstance(proc.stderr, str) else proc.stderr.decode("utf8", "replace")
        stdout = proc.stdout if isinstance(proc.stdout, str) else ""
        blob = f"{stderr}\n{stdout}".strip()
        message = f"wrangler {' '.join(args)} → {_first_line(blob)}"
        if is_missing(blob):
            raise MissingObject(message, output=blob, argv=argv)
        raise WranglerError(message, output=blob, argv=argv)
    return proc


def _with_retry(call, *, attempts: int = RETRY_ATTEMPTS, sleep=time.sleep):
    """Retry only what `is_transient` blesses; a 404 or a real auth failure
    fails on the first attempt rather than burning three round-trips."""
    last: WranglerError | None = None
    for attempt in range(attempts):
        try:
            return call()
        except MissingObject:
            raise
        except WranglerError as exc:
            last = exc
            if attempt == attempts - 1 or not is_transient(exc.output or str(exc)):
                raise
            sleep(RETRY_BASE_DELAY * (2 ** attempt))
    assert last is not None
    raise last


# --- KV -------------------------------------------------------------------

def kv_list(settings: Settings, prefix: str) -> list[KvEntry]:
    def call():
        proc = run_wrangler(settings, [
            "kv", "key", "list", "--binding", KV_BINDING, "--remote",
            "--prefix", prefix, *_env_flags(settings.env_name),
        ])
        return parse_kv_list(proc.stdout)
    return _with_retry(call)


def kv_get(settings: Settings, key: str) -> str:
    def call():
        proc = run_wrangler(settings, [
            "kv", "key", "get", "--binding", KV_BINDING, "--remote",
            key, *_env_flags(settings.env_name),
        ])
        return proc.stdout
    return _with_retry(call)


# --- R2 -------------------------------------------------------------------
# wrangler has NO `r2 object list` — buckets can only be inspected in
# aggregate (`bucket info`) or one key at a time. That's why the R2 view is
# projected from the KV rows' r2Key values instead of listed directly, and why
# presence is an explicit on-demand probe rather than a background poll.

def bucket_info(settings: Settings) -> BucketInfo:
    def call():
        proc = run_wrangler(settings, ["r2", "bucket", "info", settings.bucket])
        return parse_bucket_info(proc.stdout, fallback_name=settings.bucket)
    return _with_retry(call)


def is_complete_copy(path: Path, expected_size) -> bool:
    """Is `path` a byte-complete copy?

    The KV row's `size` is the exact uploaded byte count and the only integrity
    signal available — wrangler exposes no ETag and no HEAD. Without one we
    can't claim completeness, so we don't.
    """
    if not isinstance(expected_size, int) or expected_size <= 0:
        return False
    try:
        return path.is_file() and path.stat().st_size == expected_size
    except OSError:
        return False


def r2_get(settings: Settings, r2_key: str, dest: Path, *, expected_size=None,
           timeout: int = 300) -> str:
    """Download one clip, idempotently. Returns 'cache' or 'r2'.

    Mirrors `pullClip` in scripts/lib/voices.mjs: an already-complete file at
    `dest` costs no request at all, and the transfer lands via a `.part`
    rename so an interrupted pull can never leave a truncated file sitting at
    the real path looking finished. Raises MissingObject when the object has
    already aged out.
    """
    # Absolute, always: run_wrangler uses cwd=worker/ so the MEMBERS_KV
    # binding resolves, which means a relative --file would download under
    # worker/ while this process renames relative to its own cwd. The JS side
    # hit exactly that (scripts/lib/voices.mjs r2GetArgs).
    dest = Path(dest).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)
    if is_complete_copy(dest, expected_size):
        return "cache"

    part = dest.with_name(dest.name + ".part")
    part.unlink(missing_ok=True)

    def call():
        run_wrangler(settings, [
            "r2", "object", "get", f"{settings.bucket}/{r2_key}",
            "--file", str(part), "--remote",
        ], timeout=timeout)
        return "r2"

    try:
        source = _with_retry(call)
        if not part.is_file():
            raise WranglerError(f"wrangler reported success but wrote nothing to {part}")
    except WranglerError:
        part.unlink(missing_ok=True)
        raise
    part.replace(dest)
    return source


def r2_exists(settings: Settings, r2_key: str, *, timeout: int = 300) -> bool:
    """Presence probe.

    This genuinely downloads the object — wrangler exposes no HEAD — so it is
    only ever run on demand, never on a poll timer. Clips are capped at 8MB by
    the Worker, so the cost is bounded but not nothing.
    """
    import tempfile

    with tempfile.TemporaryDirectory(prefix="jxnfc-probe-") as tmp:
        try:
            r2_get(settings, r2_key, Path(tmp) / "probe.bin", timeout=timeout)
            return True
        except MissingObject:
            return False


# --- preflight ------------------------------------------------------------

def missing_tools(settings: Settings) -> list[str]:
    """Which of the pipeline's binaries aren't installed.

    Mirrors the CLIs' own preflight so the TUI can say "ffmpeg is missing"
    before you pick a round and wait on a KV read.
    """
    missing = []
    for tool, hint in (("node", "install Node"), ("npx", "install Node"),
                       ("ffmpeg", "brew install ffmpeg")):
        if shutil.which(tool) is None:
            missing.append(f"{tool} ({hint})")
    if not settings.make_audiogram.is_file():
        missing.append(f"scripts/make_audiogram.mjs (not at {settings.make_audiogram})")
    return missing
