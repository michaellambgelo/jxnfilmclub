# Events Directory

A public listing of all club screenings and events with search, venue filtering, date sorting, and attendance tracking.

## The three card modes

A card offers exactly one bottom affordance, chosen by `rsvpEnabled(event)`:

| Mode | When | Affordance |
|------|------|-----------|
| **Attendance** | `rsvpEnabled()` is false | "I was there" / "Remove me" |
| **RSVP** | `rsvpEnabled()` is true | RSVP meter, RSVP / Join waitlist / Cancel |
| **Tickets** | `ticketUrl` is set | "Get tickets" link out, plus the attendance toggle |

```js
function rsvpEnabled(e) {
  if (!e) return false
  if (e.ticketUrl) return false                   // box office sells the seats
  if (typeof e.rsvp === 'boolean') return e.rsvp  // explicit admin toggle wins
  return !!e.hostId                               // legacy: hosted = RSVP
}
```

The `hostId` fallback is what keeps every pre-existing row behaving as it did:
the curated rows in `data/events.json` carry no `rsvp` field and no host, so
they stay on attendance, and every member-hosted screening stays on RSVP.
**Absence therefore has to keep meaning "off"** — which is why the admin
portal stamps `rsvp: true` explicitly at create time rather than relying on a
default. A ticket link short-circuiting to false is structural on purpose, the
same reasoning as `isMembersOnly()`: it cannot be misconfigured into offering
an RSVP for a seat the club does not control.

Mirrored in three places, which must move in lockstep:
`worker/src/index.js`, `model/index.ts` (imported by both SPA lib files), and
`admin/lib.js` (exported and unit-tested in `tests/admin/events-rsvp.test.js`).

## The title card — what fills the poster slot

`.event-poster-wrap` is a 2:3 well sized for a film poster. A screening
borrows the film's; a drinks night at Banner Hall has nothing to borrow, and
an empty well reads as a broken image rather than a design. So **any event
with no `poster` draws its own title card instead** — there is no longer a
state that renders a grey rectangle.

It is built from the same vocabulary as the printed-poster treatment in the
admin Content Gen card: a brand hairline along the top edge, a label eyebrow,
then the title and date stamp anchored to the bottom the way a film poster
sets its title.

The eyebrow tells the truth about who is running it:

| Event | Eyebrow |
|---|---|
| Club event (no `hostId`) | `JXN FILM CLUB PRESENTS` |
| Member-hosted (`hostId` set) | `HOSTED BY {hostName}` |

`hostName` resolves off `hostId` on every read, so a rename follows it here
like everywhere else.

**The title card owns the heading.** When it is showing, the card body's `h3`
and its date/time are `:if`-gated off — rendering both put the same title in
the same typeface twice, back to back, which reads as a bug. `.event-film`
still renders below, so a screening whose poster is merely missing keeps its
film name and Letterboxd link. Both conditions come off the event prop and
never toggle after mount, so neither trips nuedom's diff.

Helpers: `evEyebrow` / `evPosterMeta` in the `ui/views.html` lib script
(thunked into `event-card` as `eyebrow()` / `posterMeta()`); styles in
`css/cards.css` under `.event-titlecard`.

### Making it a real image

The CSS card exists only on the site. To put the same artwork in the
newsletter or a social post, the admin Content Gen tab has an **Event poster
(no film)** type: it draws the identical composition at 800×1200 with
`drawTitleCard()`, and **Use as event poster** uploads the PNG to the
content-addressed store the newsletter already uses (`POST /admin/newsletter/
image` → `GET /nl/img/{sha}.png`) and PUTs a one-field `{ poster }` onto the
event. Because an admin PUT merges, nothing else on the row is touched.

Once set, the card shows the artwork and everything that consumes `poster` —
the newsletter events table, the social cards — gets it for free.

Keep `drawTitleCard()` and `.event-titlecard` in step; the eyebrow wording is
duplicated between `evEyebrow()` and that drawer.

## Social events

`kind: 'social'` is a club event with no film — a meetup at Banner Hall, a
members drinks night. Created in the admin portal only (`/host` stays
films-only). The film, year, poster and Letterboxd fields are simply absent,
and the card omits the film line entirely rather than rendering an empty one.

Social events are **public**: `isMembersOnly()` returns true only for
`kind === 'house'`, so no change was needed there. The home page's hero skips
them (its stamp reads "Next screening", so it must name a screening) while The
Program lists them with a `Social` tag.

## Attendance and RSVP are never both offered

This doc covers the curated listing + post-hoc attendance ("I was there").
Events that take RSVPs (house screenings, theater meetups, and admin club
events with the RSVP box ticked) swap the attendance toggle for an
RSVP/waitlist affordance and are documented in
[hosting.md](hosting.md); member-hosted cards additionally show a "Hosted by"
line
with the host's avatar (Letterboxd avatar via `GET /avatars` when the host
has a linked handle, letter avatar otherwise — see
[watched.md](watched.md)), the RSVP meter, an optional showtime (either
kind), and meetup self-organized copy.

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
| Events | Worker `GET /events` (KV `events:all` aggregate; admin dashboard writes per-event KV rows) | Live on admin edit; JSON snapshot committed every 6h by `snapshot-events.yml` |
| Attendance | Worker `GET /events/attendance` (KV `attendance:all` overlay) | Live on click; JSON snapshot committed every 6h |
| Members (for handle lookup) | Worker `GET /members` | Live on signup/update; JSON snapshot every 6h |

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
| `model/index.ts` | `getEvents()` fetches `GET /events` from the Worker; falls back to `/data/events.json` on error |
| `worker/src/index.js` | `GET /events` reads `events:all`; `bootstrapEvents` seeds from `data/events.json` on cold KV |
| `admin/admin.js` | Events tab; owns the Kind / RSVP / Ticket URL / notify fields and proxies every write to the Worker |
| `admin/lib.js` | `rsvpEnabled()` (rendering), `sanitizeAdminEvent()` (checkbox coercion only — the Worker validates), `eventIdFrom()` + `newEventIssues()` (the create form's derived slug and its pre-write gate) |
| `worker/src/index.js` | `PUT`/`DELETE /admin/events/:id` — the admin write path (`validAdminEvent`, capacity guard, waitlist promotion, RSVP notification emails). See [hosting.md](hosting.md#admin-event-writes-go-through-the-worker) |
| `data/events.json` | Archival snapshot, refreshed every 6h by `.github/workflows/snapshot-events.yml` |
| `data/attendance.json` | Attendance archival snapshot (separate cron) |
| `tests/worker/members-events.test.js` | Worker-side coverage of `GET /events` (bootstrap + per-event read paths) |
| `tests/e2e/site.spec.ts` | 2 e2e tests |
| `tests/e2e/club-events.spec.ts` | social / ticketed / club-RSVP card modes |
| `tests/admin/events-rsvp.test.js` | `rsvpEnabled` + `sanitizeAdminEvent` semantics |
| `tests/worker/admin-events.test.js` | the admin write path, incl. the postponement notification |
| `tests/model/model.test.ts` | 4 getEvents tests |

### Why `event-card` is its own component

Every `:onclick` handler in Nue auto-calls `update()` on the component that owns it (`node_modules/nuedom/src/dom/node.js:98–102`). If the attend button lived in `events-view`, each click would trigger a parent update, and `diffChildrenByKey` (`node_modules/nuedom/src/dom/diff.js:69–79`) would detach every keyed card from the grid before re-appending them — which collapses the document briefly and causes the browser to clamp `scrollY` to 0. Scoping the click handler to a per-card subcomponent means the post-click update diffs only the card's own subtree (non-keyed children → positional diff, no detach), so the scroll position is preserved.
