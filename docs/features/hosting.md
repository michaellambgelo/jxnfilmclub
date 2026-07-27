# Hosting: Screenings & Theater Meetups

Members create their own events at `/host` (`events-new-view` in `ui/views.html`).
One form, two kinds, chosen by a location toggle:

| | `kind: 'house'` | `kind: 'meetup'` |
|---|---|---|
| Location | Private `address` (required) | Public theater from the `THEATERS` allowlist (required) |
| Address visibility | Never public — only emailed to confirmed RSVPs | N/A (no address stored, even if submitted) |
| Public venue label | Optional "Public label" field; defaults to `{hostName}'s house`, matching the curated-list convention | The theater name itself |
| Capacity | Required (1–1000), waitlist when full | Optional; no cap → every RSVP confirms, no waitlist |
| Showtime | — | Optional `time` (HH:MM, rendered h:mm am/pm) |
| Framing | "Your living room is a cinema" | Self-organized — buy your own ticket; the club just shows up together |

Both kinds share the RSVP flow (`POST/DELETE /events/:id/rsvp`, confirmation
emails with one-click cancel token, waitlist auto-promotion) and the host-only
view (`GET /events/:id/host`).

## Privacy model

The public/private boundary is `publicEventProjection()` (`worker/src/index.js`)
— an allowlist that includes `venue`, `kind`, `time` and never `address` **or
`notes`** (the form promises notes are RSVP-email-only, and hosts put
parking/entry details there). The canonical full row lives at `event:{id}` in
`ATTENDANCE_KV`; the public aggregate `events:all`, `GET /events`, and the
`data/events.json` snapshot only ever carry projections. A house host's address
and notes leave the Worker exclusively inside RSVP/update emails to confirmed
RSVPs (plus the host-only `GET /events/:id/host` view and the local admin
dashboard, which read the canonical row). Meetups store no address at all: the
validator ignores one on create, and PATCH deletes any stale one.

## Theater allowlist

Meetup venues are validated server-side against `THEATERS` in
`worker/src/index.js`, mirrored in the form's `<select>` in `ui/views.html`
(**keep both copies in lockstep** — drift fails loudly with a 400). Additions
go through **venues@jxnfilm.club** review; the form invites suggestions. The
list (7 venues): Patton House & Gallery · The Capri Theater · Legacy Parkway
Theaters · Cinemark XD in Pearl · Malco Renaissance in Ridgeland · Malco
Grandview & IMAX in Madison · B&B Theaters at Northpark in Ridgeland.

Note: historical curated rows in `data/events.json` use older free-text
spellings ("Capri Theatre", "Cinemark Pearl", "Malco Grandview"…). These
coexist with the canonical names in the events-page venue filter dropdown;
an admin bulk-rename is an optional future cleanup.

## `kind` semantics

- New hosted events are always stamped `'house'` or `'meetup'` by
  `validScreeningInput`. `kind` is **immutable on PATCH** (400) — converting a
  house screening whose address was already emailed into a public meetup (or
  vice versa) is a semantic mess.
- Back-compat: hosted rows without `kind` predate meetups and are treated as
  `'house'` everywhere (and get stamped on their first PATCH). Curated events
  (no `hostId`) normally carry no `kind`; an admin can set `kind: 'meetup'` on
  a curated theater event to fix the home page's House/Venue tag (the legacy
  heuristic regex `/house|porch|backyard|home/i` would otherwise mislabel
  venues like "Patton House & Gallery").
- On meetups, PATCH treats an explicit `''`/`null` for `capacity` or `time` as
  a clear; un-capping promotes the entire waitlist.

## Poster search (TMDB)

Typing in the Film field (≥2 chars, debounced 300ms) queries
`GET /tmdb/search?q=…` — an authenticated Worker proxy over TMDB movie search
(`worker/src/index.js` `handleTmdbSearch`). The proxy keeps the API key
server-side (`TMDB_API_KEY` secret; accepts a v3 key or a v4 read token),
returns the top 8 results that have posters (`{ id, title, year, poster,
thumb }` with `w500`/`w92` image URLs), and caches TMDB responses at the edge
for a day. Picking a suggestion fills the film + year inputs, attaches the
`poster` URL to the submission, and shows a preview with a Remove button. If
the secret is unset the endpoint returns 503 and the form quietly degrades
(no suggestions). Under `E2E_MODE` the endpoint returns a canned Matrix
fixture so Playwright and local UI work never hit TMDB.

Setup per environment: `cd worker && npx wrangler secret put TMDB_API_KEY`
(repeat with `--env staging`); locally add it to `worker/.dev.vars`.

## Form UX constraint (nuedom)

`/host` opens on a venue-type chooser — two plain buttons, "My house" and
"A theater" (`.host-option` in `css/auth.css`: ghost until selected, standard
brand fill when selected), each with its explanatory copy in a paragraph
beneath the button. The form is fully hidden (`:hidden="!kind"`) until a
button is picked; picking sets `kind` and reveals the matching field group.

Everything stays **always mounted** and swaps via `:hidden`/`:required`
attribute bindings. Do not convert the form or the field groups to `:if`
blocks: toggling nodes that shift later siblings crashes nuedom's
`diffChildrenByKey` (see [home.md](home.md), Hot Takes). Static `required`
attributes were removed from address/capacity because a required hidden input
blocks native form submission, and `.auth form[hidden]` / `.auth label[hidden]`
CSS exists because the author-level `display: grid` rules outrank the UA's
`[hidden]` default.

## Key Files

| File | Role |
|------|------|
| `ui/views.html` | `events-new-view` form (toggle, THEATERS mirror), `event-card` RSVP/meetup copy |
| `worker/src/index.js` | `THEATERS`, `validScreeningInput`, projection, RSVP/waitlist, email templates |
| `admin/admin.js` | `projectEvent` mirror (incl. `kind`/`time`), Kind/Time inputs on hosted events |
| `tests/worker/screenings.test.js` | House + meetup suites (`createScreening` / `createMeetup` fixtures) |
| `tests/e2e/screenings.spec.ts` | /host form specs incl. the meetup toggle |
