-- Film stats (worker/src/films.js, docs/features/film-stats.md). A club-owned,
-- accumulating record of members' Letterboxd diary entries from the club era
-- on. Its own database (jxnfilm-films) and migrations_dir, so this schema
-- never shares a numbering sequence with GIVEAWAYS_DB.

-- One row per film the club has logged. Keyed on the Letterboxd slug from the
-- entry URL; tmdb_id (from the feed's tmdb:movieId tag) is a secondary key
-- that survives a slug change on Letterboxd's side.
CREATE TABLE films (
  slug       TEXT PRIMARY KEY,     -- Letterboxd film slug, e.g. 'digger-2026'
  title      TEXT NOT NULL,
  year       TEXT,
  poster     TEXT,
  tmdb_id    TEXT,
  first_seen TEXT NOT NULL         -- RFC 3339, when ingest first saw it
);
CREATE INDEX films_tmdb ON films(tmdb_id);

-- One row per diary entry (a rewatch is its own row).
CREATE TABLE logs (
  id           INTEGER PRIMARY KEY,
  entry_url    TEXT NOT NULL UNIQUE, -- RSS <link>; opaque 'former:...' after departure
  film_slug    TEXT NOT NULL REFERENCES films(slug),
  member_key   TEXT NOT NULL,        -- member id; 'former:<random>' after departure
  handle       TEXT,                 -- NULL after departure
  watched_date TEXT NOT NULL,        -- bare YYYY-MM-DD, never a Date
  rewatch      INTEGER NOT NULL DEFAULT 0,
  event_id     TEXT,                 -- linked club screening, if any
  first_seen   TEXT NOT NULL,
  UNIQUE (member_key, film_slug, watched_date)
);
CREATE INDEX logs_film ON logs(film_slug, watched_date);
CREATE INDEX logs_member ON logs(member_key);
CREATE INDEX logs_unlinked ON logs(watched_date) WHERE event_id IS NULL;

-- Append-only: a new row only when rating/liked/review differ from the latest.
CREATE TABLE log_versions (
  log_id  INTEGER NOT NULL REFERENCES logs(id),
  seen_at TEXT NOT NULL,
  rating  REAL,                      -- 0.5–5, NULL = unrated
  liked   INTEGER NOT NULL DEFAULT 0,
  review  TEXT,                      -- NULL after departure
  PRIMARY KEY (log_id, seen_at)
);

-- Departure tombstones, one per member who unlinked Letterboxd or deleted
-- their account. Ingest skips any row whose member id is listed here, so a
-- /watched rebuild reading a stale members:all (KV is eventually consistent)
-- can never re-insert a departed member's feed. former_key is the opaque key
-- their logs moved to; a repeat departure reuses it so one person never
-- becomes two former members, and relinking (handle set again) deletes the
-- former logs and this row, so the log starts fresh. Account deletion NULLs
-- former_key: the id can never return, and the anonymized rows must not stay
-- linkable to it.
CREATE TABLE departures (
  member_key TEXT PRIMARY KEY,       -- the departed member's id
  former_key TEXT,                   -- 'former:<random>'; NULL after account deletion
  at         TEXT NOT NULL
);
