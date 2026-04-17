# Events Directory

A public listing of all club screenings and events with search, venue filtering, date sorting, and attendance tracking.

## Page Layout

The events view at `/events` displays a table with:
- Event poster thumbnail (if available)
- Event title
- Film name (linked to Letterboxd if URI available)
- Venue
- Date (formatted as "Mon DD, YYYY")
- Attendance count + attendee names + action button

## Interaction Flow

```mermaid
flowchart TD
    A[User navigates to /events] --> B[Load events + attendance data]
    B --> C[Render table with filters]

    C --> D{Search field}
    D -->|Type query| E[Filter by title, film, or venue<br/>Updates ?query= param]

    C --> F{Sort dropdown}
    F -->|Select option| G[Sort by date desc or asc<br/>Updates ?sort= param]

    C --> H{Venue dropdown}
    H -->|Select venue| I[Filter to single venue<br/>Updates ?venue= param]

    C --> J{Signed in?}
    J -->|No| K[View only - no buttons]
    J -->|Yes| L{Already attended?}
    L -->|No| M["I was there" button]
    L -->|Yes| N[Name in list + "Remove me" button]
    M -->|Click| O[POST Worker /events/:id/attend<br/>KV updated]
    N -->|Click Remove me| Q[DELETE Worker /events/:id/attend<br/>KV updated]
```

## Data Sources

| Data | Source | Refresh |
|------|--------|---------|
| Events | `data/events.json` | Manual commits |
| Attendance | Worker `GET /events/attendance` (KV + JSON overlay) | Live on click; JSON snapshot committed every 10 min |
| Members (for handle lookup) | `data/members.json` | On member changes |

## URL Parameters

| Param | Effect | Example |
|-------|--------|---------|
| `query` | Filters by title, film, or venue | `?query=whiplash` |
| `sort` | Sort direction | `?sort=date-asc` or `?sort=date-desc` |
| `venue` | Filter to one venue | `?venue=Capri+Theatre` |

## Key Files

| File | Role |
|------|------|
| `ui/views.html` | `events-view` component |
| `model/index.ts` | `getEvents()` with search, sort, venue filter |
| `data/events.json` | Event records |
| `data/attendance.json` | Attendance lists by event ID |
| `tests/e2e/site.spec.ts` | 2 e2e tests |
| `tests/model/model.test.ts` | 4 getEvents tests |
