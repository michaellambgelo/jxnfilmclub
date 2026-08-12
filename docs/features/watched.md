# Last Four Watched

A member-discovery page at `/watched` showing the most recent four films watched by each verified member, pulled from Letterboxd RSS feeds.

## Page Layout

Top to bottom:

1. **"This week in the club" strip** — a club-wide view of the last 7 days
   (Central time): every dated diary entry in the window, most recent first,
   deduped on title|year so a film watched by several members becomes one
   card with a combined byline ("Watched by Alex, Sam"). Watcher names are
   buttons that scroll to that member's section. The section hides itself
   via CSS (`:not(:has(.ws-card))`) when the week is empty.
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
     member's review snippet (~140 chars) when `data/takes.json` has one for
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

## Data Pipeline

```mermaid
flowchart LR
    A[GitHub Actions cron<br/>every 6 hours] --> B[refresh_letterboxd.py]
    B --> C[Read data/members.json]
    C --> D{For each member<br/>with handle}
    D --> E[Fetch letterboxd.com/{handle}/rss/]
    E --> F[Extract last 4 entries:<br/>title, year, link, watched_date,<br/>rating, liked, rewatch, poster]
    F --> G[Write data/watched.json]
    G --> H{Data changed?}
    H -->|Yes| I[Commit + push]
    H -->|No| J[No-op]
    I --> K[Triggers deploy-site]
```

The same script/workflow also writes `data/takes.json` (recent member reviews) for the
home page's Hot Takes section — see [home.md](home.md).

## Live endpoint (primary source)

The SPA no longer reads `data/watched.json` first: `getWatched()` in
`model/index.ts` calls the Worker's public `GET /watched`, which fetches each
linked member's RSS on demand and caches the aggregate at `watched:cache` in
`MEMBERS_KV` for 15 minutes (per-feed fetches are additionally edge-cached).
That keeps diaries minutes-fresh instead of up to 6 hours stale, while
Letterboxd sees at most one fetch per feed per window. A total upstream miss
is deliberately not cached so an outage never gets pinned for a full TTL.
`data/watched.json` (this cron) remains the offline fallback and the Hot
Takes source. Consumers: home "The Last Four", the `/watched` view, and the
host panel's diary quick-picks.

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

## Key Files

| File | Role |
|------|------|
| `ui/views.html` | `watched-view` + `watched-member` components |
| `model/index.ts` | `buildWatchedPage` / `filterFilms` / `centralDayCutoff` / `getTakes` |
| `css/watched.css` | Page styles incl. strip (`.ws-*`), filters, badges |
| `scripts/refresh_letterboxd.py` | RSS fetch + poster extraction |
| `.github/workflows/refresh-letterboxd.yml` | Cron every 6 hours |
| `data/watched.json` | Cached film data keyed by handle |
| `data/members.json` | Source of member handles |
