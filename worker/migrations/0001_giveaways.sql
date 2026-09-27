-- Giveaways (docs/features/giveaways.md). D1 rather than KV for one reason:
-- the rules here are uniqueness rules — one entry per member per source, one
-- credit per referred email, a referral cap — and KV has no atomic
-- check-then-write (members:all lost a signup to exactly that race). Unique
-- indexes make each rule a database guarantee instead of a best effort.
--
-- Members, events and voice clips stay in KV. Rows here reference members by
-- their KV member id; name/email are copied onto `participants` at entry time
-- because KV has no id -> email index and the winner export needs both.

CREATE TABLE giveaways (
  id                    TEXT PRIMARY KEY,           -- slug, e.g. 2026-10-22-clayface-waitlist
  event_id              TEXT NOT NULL,              -- KV event:{id}
  title                 TEXT NOT NULL,
  prize                 TEXT NOT NULL,              -- prize description
  winners               INTEGER NOT NULL CHECK (winners >= 1),
  tickets_per_winner    INTEGER NOT NULL DEFAULT 2 CHECK (tickets_per_winner >= 1),
  starts_at             TEXT NOT NULL,              -- ISO 8601 UTC
  ends_at               TEXT NOT NULL,              -- ISO 8601 UTC
  rules_md              TEXT NOT NULL DEFAULT '',   -- giveaway-specific terms; the fixed legal lines are rendered around it
  status                TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'open', 'closed', 'drawn')),
  -- { "waitlist_signup": { "weight": 1 }, "letterboxd_link": { "weight": 1 },
  --   "voice_prompt": { "weight": 1 }, "referral": { "weight": 1, "cap": 10 } }
  -- A source absent from this object does not count for this giveaway.
  sources               TEXT NOT NULL DEFAULT '{}',
  -- Undecided policy, so a per-giveaway flag rather than code: do RSVPs made
  -- before starts_at earn the waitlist entry?
  count_prior_waitlist  INTEGER NOT NULL DEFAULT 0 CHECK (count_prior_waitlist IN (0, 1)),
  voice_prompt_id       TEXT,                       -- config:voice_prompt id this giveaway counts
  voice_max_seconds     INTEGER NOT NULL DEFAULT 180,
  voice_max_bytes       INTEGER NOT NULL DEFAULT 8388608,
  winner_response_days  INTEGER NOT NULL DEFAULT 3,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX giveaways_event ON giveaways (event_id);

-- Explicit opt-in: a member taps Enter once per giveaway, accepting the rules.
-- Qualifying actions only earn entries for participants.
CREATE TABLE participants (
  giveaway_id     TEXT NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  member_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  comms_consent   INTEGER NOT NULL DEFAULT 0 CHECK (comms_consent IN (0, 1)),
  rules_accepted_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (giveaway_id, member_id)
);

CREATE TABLE entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id  TEXT NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL,
  source       TEXT NOT NULL
               CHECK (source IN ('waitlist_signup', 'letterboxd_link', 'voice_prompt', 'referral')),
  weight       INTEGER NOT NULL CHECK (weight >= 1),   -- snapshot of the source weight when earned
  ref_id       INTEGER REFERENCES referrals (id),      -- referral entries only
  detail       TEXT,                                   -- e.g. the Letterboxd handle, the voice key
  flagged      INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
  flag_reason  TEXT,
  excluded     INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  created_at   TEXT NOT NULL
);
-- One entry per member per source ...
CREATE UNIQUE INDEX entries_one_per_source
  ON entries (giveaway_id, member_id, source) WHERE source != 'referral';
-- ... except referral: one entry per credited referral (cap enforced in the
-- insert itself, see creditReferral).
CREATE UNIQUE INDEX entries_one_per_referral
  ON entries (giveaway_id, ref_id) WHERE source = 'referral';
CREATE INDEX entries_member ON entries (giveaway_id, member_id);

-- One stable code per member, reused across giveaways.
CREATE TABLE referral_codes (
  code        TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE referrals (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id        TEXT NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  referrer_member_id TEXT NOT NULL,
  referee_member_id  TEXT,
  referee_email_norm TEXT NOT NULL,          -- lowercased, +tag stripped, gmail dots removed
  ip_hash            TEXT,                   -- HMAC of the signup IP; never the raw address
  status             TEXT NOT NULL
                     CHECK (status IN ('credited', 'flagged', 'rejected', 'capped')),
  reason             TEXT,
  created_at         TEXT NOT NULL
);
-- A person can be referred into a giveaway once, by whoever got there first.
CREATE UNIQUE INDEX referrals_one_per_referee ON referrals (giveaway_id, referee_email_norm);
CREATE INDEX referrals_referrer ON referrals (giveaway_id, referrer_member_id);
CREATE INDEX referrals_ip ON referrals (giveaway_id, ip_hash, created_at);

-- Append-only audit log of every draw and redraw.
CREATE TABLE draws (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id       TEXT NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('draw', 'redraw')),
  run_by            TEXT NOT NULL,           -- admin email from Cloudflare Access
  run_at            TEXT NOT NULL,
  exclude_flagged   INTEGER NOT NULL CHECK (exclude_flagged IN (0, 1)),
  pool_members      INTEGER NOT NULL,        -- distinct members in the pool
  pool_entries      INTEGER NOT NULL,        -- total weight in the pool
  snapshot_sha256   TEXT NOT NULL,           -- hash of the sorted (member_id, weight) pool
  random_values     TEXT NOT NULL,           -- JSON array of the CSPRNG integers used, in order
  winners           TEXT NOT NULL,           -- JSON array of member ids, in draw order
  replaces_member   TEXT                     -- redraw only: the forfeited winner
);

CREATE TABLE winners (
  giveaway_id  TEXT NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL,
  draw_id      INTEGER NOT NULL REFERENCES draws (id),
  status       TEXT NOT NULL DEFAULT 'selected' CHECK (status IN ('selected', 'forfeited')),
  tickets      INTEGER NOT NULL,
  selected_at  TEXT NOT NULL,
  PRIMARY KEY (giveaway_id, member_id)
);
