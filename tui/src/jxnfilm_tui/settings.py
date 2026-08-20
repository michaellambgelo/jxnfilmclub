"""Where things live and what the pipeline's fixed constants are.

Everything here mirrors values that already exist elsewhere in the repo —
`scripts/lib/voices.mjs` (buckets, KV binding), `worker/src/index.js`
(VOICE_TTL), `worker/wrangler.toml` (envs). The TUI never invents its own;
`tests/test_settings.py` guards the copies that matter against their source.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

# Retention: worker/src/index.js `const VOICE_TTL = 60 * 86400`, matched by a
# bucket-wide R2 lifecycle rule. Approval is a moderation state, NOT a
# retention extension — an approved clip still evaporates on day 60.
VOICE_TTL_DAYS = 60

# scripts/lib/voices.mjs BUCKETS
VOICE_BUCKETS = {
    "production": "jxnfilm-voice",
    "staging": "jxnfilm-voice-staging",
}
ENVS = tuple(VOICE_BUCKETS)

KV_BINDING = "MEMBERS_KV"

# The KV keyspace, as browsed by the KV tab. Order is display order.
# `aggregate` rows are read-modify-write hazards — the browser labels them so
# nobody hand-patches one (admin/README.md; a concurrent signup was lost that
# way once). This TUI is read-only, so it's a caption, not a guard.
@dataclass(frozen=True)
class Prefix:
    prefix: str
    label: str
    note: str = ""
    aggregate: bool = False


KV_PREFIXES: tuple[Prefix, ...] = (
    Prefix("voice:", "Voice clips", "voice:{promptId}:{memberId} — the audiogram source rows"),
    Prefix("config:", "Config overrides", "delete-key-means-defaults; absent key = site default"),
    Prefix("member:", "Members (by email)", "member:{email}"),
    Prefix("members:", "Members aggregate", "members:all — rebuilt by cron, never hand-patched", True),
    Prefix("event:", "Events", "event:{id}"),
    Prefix("events:", "Events aggregate", "events:all", True),
    Prefix("rsvp:", "RSVPs", "scrubbed 30 days after the event"),
    Prefix("attend:", "Attendance", "attend:{id}"),
    Prefix("attendance:", "Attendance aggregate",
           "attendance:all omits hosts — the Worker overlays them at read time, "
           "so this raw row is correctly incomplete", True),
    Prefix("feedback:", "Beta feedback", "90-day TTL — export before it ages out"),
)


def find_repo_root(start: Path | None = None) -> Path:
    """Walk up from this file to the jxnfilmclub checkout.

    Identified by the two things the TUI actually drives: the Worker config
    that resolves the MEMBERS_KV binding, and the audiogram script.
    """
    here = (start or Path(__file__).resolve()).resolve()
    for candidate in (here, *here.parents):
        if (candidate / "worker" / "wrangler.toml").is_file() and (
            candidate / "scripts" / "make_audiogram.mjs"
        ).is_file():
            return candidate
    raise RuntimeError(
        "could not locate the jxnfilmclub checkout "
        "(looked for worker/wrangler.toml + scripts/make_audiogram.mjs above "
        f"{here}) — run the TUI from inside the repo"
    )


@dataclass(frozen=True)
class Settings:
    repo_root: Path
    env_name: str = "production"
    # `out/` is gitignored and is where both CLIs already write.
    out_dirname: str = "out"

    @classmethod
    def discover(cls, env_name: str = "production") -> "Settings":
        return cls(repo_root=find_repo_root(), env_name=env_name)

    # wrangler resolves the MEMBERS_KV binding from worker/wrangler.toml, so
    # every wrangler call runs with cwd=worker/ (same as voices.mjs).
    @property
    def worker_dir(self) -> Path:
        return self.repo_root / "worker"

    @property
    def out_dir(self) -> Path:
        return self.repo_root / self.out_dirname

    @property
    def audiogram_out(self) -> Path:
        return self.out_dir / "audiogram"

    @property
    def archive_out(self) -> Path:
        return self.out_dir / "archive"

    @property
    def bucket(self) -> str:
        return VOICE_BUCKETS[self.env_name]

    @property
    def make_audiogram(self) -> Path:
        return self.repo_root / "scripts" / "make_audiogram.mjs"

    @property
    def compile_voices(self) -> Path:
        return self.repo_root / "scripts" / "compile_voices.mjs"

    def with_env(self, env_name: str) -> "Settings":
        if env_name not in VOICE_BUCKETS:
            raise ValueError(f"unknown env: {env_name}")
        return Settings(repo_root=self.repo_root, env_name=env_name,
                        out_dirname=self.out_dirname)
