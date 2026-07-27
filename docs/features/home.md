# Home Page

The landing page at `/` introduces Jackson Film Club and features the podcast.

## Sections

### Hero
- "Jackson Film Club" heading
- Description of the community and how membership works
- Privacy emphasis: emails are always private, Letterboxd is optional, anonymous display names are welcome
- "Join Jackson Film Club" button linking to `https://join.jxnfilm.club/`

### Podcast
- Description of the audio series (launched 2021)
- Spotify video embed of the featured (latest) episode
- Full episode list loaded from `data/episodes.json`
- "Follow on Spotify" link

### Hot Takes
- Up to 3 random recent member reviews from Letterboxd, loaded from `data/takes.json`
- Each card links to the review on Letterboxd (film title tape, floated poster, review excerpt, member name)
- Section is hidden entirely when no takes are available (missing file, no linked members, no reviews)
- The section renders unconditionally and is collapsed via CSS `.takes:not(:has(.take-card))` —
  a `:if` on the section crashes nuedom's index-based DOM diff when it appears after mount
  (siblings shift and `diffChildrenByKey` throws on text nodes), taking out every section below it

## Hot Takes Data Pipeline

`scripts/refresh_letterboxd.py` (the same 6-hourly cron that writes `data/watched.json`) also
extracts reviews from each linked member's RSS feed into `data/takes.json`:

- Skips Letterboxd list entries (`letterboxd-list-*` guids), spoiler-flagged reviews
  ("This review may contain spoilers"), and plain diary entries ("Watched on …" with no review text)
- Strips HTML tags and the poster `<img>`, unescapes entities, collapses whitespace,
  drops wrapping quotation marks (the card adds its own), truncates to ~300 chars
  at a word boundary
- Keeps up to 3 reviews per member (`TAKES_PER_MEMBER`), array sorted newest-first
- Stores `handle`, `title`, `year`, `link`, `review`, `watched_date`, `poster`, and `rating`
  (rating is stored for future use but not rendered)

Client-side, `home-view` joins takes to members by `handle` (dropping takes from unlinked
handles), then picks **member-first**: shuffle members that have reviews (Fisher–Yates),
take up to 3, and pick one random review from each — so one prolific reviewer never fills
multiple cards. The pick re-randomizes on every page load.

## Podcast Embed

The Spotify embed is injected via JavaScript in `mounted()` because Nue's DHTML renderer strips static `<iframe>` tags. (Static `<img>` tags are safe — verified via the Letterboxd decal in `edit-view`.)

```mermaid
flowchart TD
    A[home-view mounted] --> B[Fetch /data/episodes.json]
    B --> C{featured_id exists?}
    C -->|Yes| D[Create iframe:<br/>open.spotify.com/embed/episode/{id}/video]
    C -->|No| E[Create iframe:<br/>open.spotify.com/embed/show/{showId}]
    D --> F[Append to #spotify-embed div]
    E --> F
    B --> G[Render episode list with :each]
```

## Podcast Data Pipeline

```mermaid
flowchart LR
    A[GitHub Actions cron<br/>weekly Monday noon UTC] --> B[refresh_spotify.py]
    B --> C[Fetch Anchor RSS feed]
    C --> D[Extract episodes:<br/>title, date, URL]
    B --> E[Scrape Spotify embed page]
    E --> F[Extract featured episode ID<br/>via spotify:episode:{id}]
    D --> G[Write data/episodes.json<br/>with featured_id + episodes array]
    G --> H{Data changed?}
    H -->|Yes| I[Commit + push]
    I --> J[Triggers deploy-site]
```

## Key Files

| File | Role |
|------|------|
| `ui/views.html` | `home-view` component |
| `scripts/refresh_spotify.py` | RSS fetch + featured ID scrape |
| `.github/workflows/refresh-spotify.yml` | Weekly cron |
| `data/episodes.json` | `{ featured_id, episodes }` |
| `scripts/refresh_letterboxd.py` | Letterboxd RSS fetch → watched + takes |
| `.github/workflows/refresh-letterboxd.yml` | 6-hourly cron |
| `data/takes.json` | Array of recent member reviews (Hot Takes) |
