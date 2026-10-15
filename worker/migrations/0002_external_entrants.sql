-- Instagram giveaway entrants, recorded by hand in the admin portal
-- (docs/features/giveaways.md, "Instagram entrants"). Entering happens on
-- Instagram, which offers no export, so an admin pastes handles in as the
-- comments come in. One row per handle per giveaway: a re-paste updates it.
--
-- Personal data (a handle, optionally a name): the 60-day scrub deletes these
-- rows with the giveaway's other personal data (scrubGiveaways).

CREATE TABLE external_entrants (
  giveaway_id  TEXT NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  handle       TEXT NOT NULL,              -- Instagram handle, lowercased, no @
  name         TEXT NOT NULL DEFAULT '',   -- optional; a winner needs one for will-call
  entries      INTEGER NOT NULL DEFAULT 1 CHECK (entries >= 1 AND entries <= 1000),
  note         TEXT NOT NULL DEFAULT '',   -- e.g. "tagged 3 friends"
  created_by   TEXT NOT NULL,              -- admin identity, as on the draw log
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (giveaway_id, handle)
);
