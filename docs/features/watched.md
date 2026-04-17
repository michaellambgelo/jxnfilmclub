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
