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

## Podcast Embed

The Spotify embed is injected via JavaScript in `mounted()` because Nue's DHTML renderer strips static `<iframe>` tags.

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
