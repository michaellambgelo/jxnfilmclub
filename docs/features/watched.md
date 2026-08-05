# Last Four Watched

A gallery page at `/watched` showing the most recent four films watched by each verified member, pulled from Letterboxd RSS feeds.

## Page Layout

For each member with a linked Letterboxd handle and watched data:
- Member header: avatar, display name, @handle link
- Film grid: 4-column responsive grid (2 columns on mobile)
- Each film card: poster image, title, year, link to Letterboxd film page

Members without a Letterboxd handle or without watched data are excluded.

## Data Pipeline

```mermaid
flowchart LR
    A[GitHub Actions cron<br/>every 6 hours] --> B[refresh_letterboxd.py]
    B --> C[Read data/members.json]
    C --> D{For each member<br/>with handle}
    D --> E[Fetch letterboxd.com/{handle}/rss/]
    E --> F[Extract last 4 entries:<br/>title, year, link,<br/>watched_date, poster]
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

## Key Files

| File | Role |
|------|------|
| `ui/views.html` | `watched-view` component |
| `scripts/refresh_letterboxd.py` | RSS fetch + poster extraction |
| `.github/workflows/refresh-letterboxd.yml` | Cron every 6 hours |
| `data/watched.json` | Cached film data keyed by handle |
| `data/members.json` | Source of member handles |
