# Events Directory

A public listing of all club screenings and events with search, venue filtering, date sorting, and attendance tracking.

## Page Layout

Events render as a responsive card grid (`.card-grid.event-grid` in
`css/cards.css`), using CSS `grid-template-columns: repeat(auto-fit,
minmax(300px, 1fr))` so the layout flows from a single column on phones
to two or three across on desktop.

Each card stacks:
- Event poster in a fixed 16:9 banner (`object-fit: cover`), with a
  neutral placeholder when no image is available
- Event title as the heading
- Film name (linked to Letterboxd if URI available)
- Venue + date row
- Attendance block at the bottom: count, comma-separated attendee list
  (handles linked to Letterboxd), and the "I was there" / "Remove me"
  action button anchored full-width

Above the grid: a result-count line (`N events`) plus the search +
sort + venue filter header.

## Interaction Flow

```mermaid
flowchart TD
    A[User navigates to /events] --> B[Load events + attendance data]
    B --> C[Render card grid with filters]

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
| Attendance | Worker `GET /events/attendance` (KV `attendance:all` overlay) | Live on click; JSON snapshot committed every 10 min |
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
| `ui/views.html` | `events-view` (list + filters) + `event-card` (per-event subcomponent that owns attendees / busy state) |
| `css/cards.css` | `.event-grid` + `.event-card` layout |
| `model/index.ts` | `getEvents()` with search, sort, venue filter |
| `data/events.json` | Event records |
| `data/attendance.json` | Attendance lists by event ID |
| `tests/e2e/site.spec.ts` | 2 e2e tests |
| `tests/model/model.test.ts` | 4 getEvents tests |

### Why `event-card` is its own component

Every `:onclick` handler in Nue auto-calls `update()` on the component that owns it (`node_modules/nuedom/src/dom/node.js:98–102`). If the attend button lived in `events-view`, each click would trigger a parent update, and `diffChildrenByKey` (`node_modules/nuedom/src/dom/diff.js:69–79`) would detach every keyed card from the grid before re-appending them — which collapses the document briefly and causes the browser to clamp `scrollY` to 0. Scoping the click handler to a per-card subcomponent means the post-click update diffs only the card's own subtree (non-keyed children → positional diff, no detach), so the scroll position is preserved.
