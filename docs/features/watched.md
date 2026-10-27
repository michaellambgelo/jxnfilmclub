# Last Four Watched

A member-discovery page at `/watched` showing the most recent four films watched by each verified member, pulled from Letterboxd RSS feeds.

## Page Layout

Top to bottom:

1. **"This week in the club" strip** — a club-wide view of the last 7 days
   (Central time): every dated diary entry in the window, most recent first,
   deduped on title|year so a film watched by several members becomes one
   card. Each card adds the all-time club count from
   [Film Stats](film-stats.md) (`GET /films/stats`, fetched with a 3s budget
   that covers the session refresh too): "**You** + 8 others have logged it ·
   3 this week" with a "You too" stamp when the signed-in viewer logged it
   and someone else logged it this week,
   otherwise "9 members have logged it · 3 this week". The line is left off
   when only one member has logged the film, and the week part when it
   equals the all-time count. This week's watcher
   names follow, the viewer first; past six they collapse behind a "+N more"
   button that opens the card in place and moves focus to the first revealed
   name. Names are buttons that scroll to that member's section. The title
   links to the film page (`/film?slug=<slug>`). If the stats call fails or
   the film is not ingested yet, the card falls back to the old byline
   ("Watched by Alex, Sam") with no count and no link. The section hides
   itself via CSS (`:not(:has(.ws-card))`) when the week is empty.
2. **Filter pills** — `Liked` / `Rated 4+` / `This week`, AND-combined,
   persisted as comma-joined tokens in `?filter=` (e.g.
   `/watched?filter=liked,week`). Filters prune films inside each member
   section; a section with no matches drops while a filter is active. The
   strip is not filtered. Tokens are deliberately non-numeric strings
   (nuestate coerces numeric-looking query values).
3. **Nudge line** — "N members have not linked Letterboxd yet", linking to
   `/edit`, hidden when every member has a handle.
4. **Per-member sections** (`watched-member` child component), ordered by
   each member's most recent `watched_date` descending — most recently
   active member first; members with only undated entries sort last.
   - Member header: avatar, display name, @handle link, "logged &lt;timeago&gt;"
   - Film grid: responsive grid (2 columns on mobile)
   - Each film card: poster, title, year, star/heart verdict, watched date
     (timeago), a `Rewatch` badge when the diary entry is a rewatch, and the
     member's review snippet (~140 chars) when `GET /takes` has one for
     that entry.

Members without a Letterboxd handle or without watched data get no section
(the nudge line is the only trace of the former).

**Deep links**: `/watched#<handle>` scrolls to that member's section on page
load. Load-time only, by design — the SPA router (nuestate) drops URL hashes
on every state change, and autolink both swallows and side-effects in-page
hash anchors, so in-page navigation uses `:onclick` scroll handlers instead.
Do not "fix" this by adding bare `#` anchors.

**Data shaping** lives in `model/index.ts` (`buildWatchedPage`,
`filterFilms`, `centralDayCutoff`, `getTakes`), unit-tested in
`tests/model/watched-helpers.test.ts` — the dhtml components stay thin.
Review matching is scoped by handle (link match, title|year fallback) so one
member's review never lands on another's card. All `watched_date` values are
bare `YYYY-MM-DD` strings compared lexically, never as Date objects.

## Data source: the Worker, and only the Worker

`getWatched()` in `model/index.ts` calls the Worker's public `GET /watched`,
which fetches each linked member's RSS on demand and caches the aggregate at
`watched:cache` in `MEMBERS_KV`, treated as fresh for 15 minutes — a
code-checked window, not a KV TTL (per-feed fetches are additionally
edge-cached). Letterboxd sees at most one fetch per feed per window. A total
upstream miss is deliberately not cached so an outage never gets pinned for a
full TTL. Consumers: home "The Last Four", the `/watched` view, and the host
panel's diary quick-picks.

The same rebuild also extracts **Hot Takes** — up to 3 recent public reviews
per member (`takesFromFeed`: spoiler-flagged and plain "Watched on" entries
skipped, decorative quotes stripped, cut at 300 chars on a word boundary) —
into the record's `takes` array, served newest-first by public `GET /takes`
(`getTakes()`). The Watched map itself never carries review text.

There is **no static fallback**. Until 2026-10-26 a 6-hour GitHub Actions
scraper (`scripts/refresh_letterboxd.py`) committed `data/watched.json` and
`data/takes.json` to the public repo as an offline fallback; that made the
repo's history an archive of diary entries and reviews, contradicting the
privacy policy's "mirror, not an archive". Both files, the script and the
workflow are gone; if the Worker is down the sections render empty. Unlink
and account deletion both call `evictHandleFromCaches`, which drops the
handle from the map **and** from `takes`.

## Metrics (`GET /metrics`)

A public, aggregate-only Prometheus scrape target (text format 0.0.4,
`Cache-Control: public, max-age=60`) that Grafana Alloy on node0 scrapes every
5 minutes. It reads only the existing KV records (`watched:cache`,
`avatars:cache`, raw `members:all`) and never fetches Letterboxd or triggers a
rebuild. Every label is a closed set — `cache` (watched/avatars), `outcome`
(ok/forbidden/http_error/network_error/carried), `window` (7d/30d) and
`rating` (the ten half-star values) — so no handle, name, email or film title
can reach a series. Both cache builds store `builtAt` and per-handle fetch
`stats` on the record they already write, so a burst of 403s (Letterboxd's
Cloudflare challenge) shows up as `jxnfc_letterboxd_last_build_fetches`
rather than only as a stale `fetchedAt`.

Series: `jxnfc_letterboxd_cache_{fetched,built}_timestamp_seconds`,
`jxnfc_letterboxd_cache_miss_active`, `jxnfc_letterboxd_last_build_fetches`,
`jxnfc_letterboxd_cache_handles`, `jxnfc_members_{total,linked}`, and the club
activity gauges `jxnfc_club_{diary_entries,active_members,liked_entries,rewatch_entries,shared_films,rated_entries,rating_sum}`.
Windows compare `watched_date` strings against UTC dates: 7d is today-6
through today, 30d is today-29 through today. They inherit the cache's
rolling 50-per-member depth, so a member logging more than 50 films in 30
days would be undercounted. The privacy policy names Grafana Labs for these
counts — keep the two in sync.

## Avatars (`GET /avatars`)

A sibling endpoint with the same architecture: Letterboxd has no API and RSS
carries no profile avatar, so the Worker scrapes each linked member's profile
page (`letterboxd.com/{handle}/`) for its `og:image` meta tag and serves a
handle-keyed URL map. Cached at `avatars:cache` in `MEMBERS_KV` for **7 days**
as `{ sig, map }` — `sig` is the sorted linked-handle list, recomputed on every
hit so a newly linked handle rebuilds immediately instead of waiting out the
TTL. Letterboxd's grey default avatar (asset path contains `/static/img/`) is
filtered out so those members keep the letter avatar. A total miss is not
cached (same outage guard as watched). `E2E_MODE` returns `{}` so e2e specs
keep asserting letter avatars.

A member's uploaded profile photo takes precedence over this map everywhere
(`avatarsById()` in `model/index.ts`; see [member-profile.md § Profile Photo](member-profile.md#profile-photo)).
Consumers via `getAvatars()` in `model/index.ts` (no static fallback — the
letter `<avatar>` in `ui/widgets.html` is the fallback, via its `:src` prop +
onerror handler): member directory cards, `/watched` member headers, the
event card's "Hosted by" line, and the `/edit` Letterboxd panel (direct
Worker fetch). Tests: `tests/worker/avatars.test.js`.

## Poster Image Extraction

Poster URLs are extracted from the RSS entry's `<description>` HTML via regex:
```
<img src="https://a.ltrbxd.com/resized/film-poster/...">
```

If no poster is found, the card renders a placeholder with the film title as text.

## Film Shape

Per-film shape (both parsers, optional fields omitted when absent):
`{ title, link, year?, watched_date?, rating?, liked?, rewatch?, poster? }` —
`rewatch: true` comes from `<letterboxd:rewatch>Yes</letterboxd:rewatch>`
(the Worker's `parseLetterboxdRss` and the Python scraper's
`letterboxd_rewatch` feedparser key both read it).

**Two depths.** The Worker caches `WATCHED_FEED_DEPTH = 50` per member and
serves `WATCHED_PUBLIC_DEPTH = 12` to unauthenticated callers.

- **50** is the ceiling Letterboxd's RSS actually serves — an active member's
  feed carries exactly 50 diary entries (100 items, the rest other activity).
  Taking all of them costs no extra request, since the whole feed is
  downloaded either way.
- **12** is what any public caller gets. Member sections and the host panel's
  diary quick-picks slice to the last four, and the weekly strip only reaches
  back 7 days, so the site renders nothing below 12; shipping 50 to every
  visitor would multiply the payload for data no page draws.
- `?depth=full` on `GET /watched`, bearer-authenticated with `ADMIN_TOKEN`,
  returns the whole cached map. Only the admin uses it — Content Gen's paged
  diary cards and the Stats tab's film counts. It is gated on payload, not
  secrecy: the films are public on the site and on Letterboxd.

Depth is not 4 because an active member can push a film out of their last
four within a day, which used to silently drop their name from a shared-watch
cluster ("watched it together, only one name shown").

**The feed is a rolling window, not an archive.** Depth is capped per member,
never by date, so how much history 50 entries buys depends entirely on how
often that member logs: at ~21 films/month the busiest member's 50 span about
12 weeks, while a member who last logged in 2023 keeps their entries
indefinitely. Anything that falls out of the RSS window is gone for good —
Letterboxd is the archive, this only mirrors what it still serves. Nothing
here accumulates: the KV cache (map and takes) is a full replacement on every
refresh. The one deliberate archive of feed entries is the club film log
(FILMS_DB, [film-stats.md](film-stats.md)), disclosed separately.

Dates in the window math are bare `YYYY-MM-DD` diary dates (Letterboxd RSS
carries no times); the 7-day cutoff is computed in America/Chicago.

## Key Files

| File | Role |
|------|------|
| `ui/views.html` | `watched-view` + `watched-member` components |
| `model/index.ts` | `buildWatchedPage` / `filterFilms` / `centralDayCutoff` / `getTakes`; strip count line via `getFilmStats` / `filmCountLine` |
| `css/watched.css` | Page styles incl. strip (`.ws-*`), filters, badges |
| `worker/src/index.js` | `GET /watched` + `GET /takes`, `buildWatched`, `takesFromFeed`, `evictHandleFromCaches` |
| `data/members.json` | Source of member handles |
