# Hosting: Screenings & Theater Meetups

Members create their own events at `/host` (`events-new-view` in `ui/views.html`).
One form, two kinds, chosen by a location toggle:

| | `kind: 'house'` | `kind: 'meetup'` |
|---|---|---|
| Location | Private `address` (required) | Public theater from the `THEATERS` allowlist (required) |
| Address visibility | Never public — only emailed to confirmed RSVPs | N/A (no address stored, even if submitted) |
| Public venue label | Optional "Public label" field; defaults to `{hostName}'s house`, matching the curated-list convention | The theater name itself |
| Capacity | Required (1–1000), waitlist when full | Optional; no cap → every RSVP confirms, no waitlist |
| Showtime | Optional `time` (HH:MM, rendered h:mm am/pm) | Optional `time` (HH:MM, rendered h:mm am/pm) |
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

## Retention: the 30-day post-event scrub

The privacy policy (`worker/src/privacy.html`) promises that 30 days after a
screening, its RSVP list (attendee emails) and the host's address/notes are
deleted. `scrubPastEvents()` in `worker/src/index.js` delivers on that:

- Runs daily via the cron trigger (`[triggers]` in `wrangler.toml`, 08:17 UTC,
  declared separately for `[env.staging.triggers]` — envs don't inherit
  triggers). Also triggerable manually as `POST /admin/scrub` (same
  `ADMIN_TOKEN` bearer gate as the newsletter send) for ops/staging checks.
- The 30-day cutoff itself is computed in **America/Chicago** (`centralToday()`
  in `worker/src/index.js`), not UTC — screening `date` values are Central-time
  calendar days (the club meets in Jackson, MS), so comparing against a UTC
  "today" would flip the boundary up to 6 hours early each evening. The same
  helper backs the "date must be today or later" check on event creation and
  the "this screening has already happened" RSVP-gating check below.
- For hosted events with `date` >30 days past: strips `address`/`notes` off
  the canonical `event:{id}` row, stamps `scrubbedAt`, re-projects into
  `events:all` via `writeEvent`, and deletes `rsvp:{id}`.
- Sweeps orphaned `rsvp:{id}` records whose event row is gone (the admin
  dashboard writes KV directly and can orphan one; `handleDeleteEvent` cleans
  up after itself).
- The names-only `attend:{eventId}` history and the public event listing are
  untouched — they never contained emails or addresses.
- `POST /events/:id/rsvp` rejects screenings whose `date` is past (409), so a
  late RSVP can't recreate a scrubbed record.
- Account deletion also purges the member's entries from every `rsvp:*` record
  immediately (see [member-profile.md](member-profile.md)).

Tests: `tests/worker/scrub.test.js`.

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
- PATCH treats an explicit `''`/`null` for `time` (both kinds) or `capacity`
  (meetups only — house capacity is required) as a clear; un-capping a meetup
  promotes the entire waitlist.

## Poster search (TMDB)

A two-step picker. Step 1: typing in the Film field (≥2 chars, debounced
300ms) queries `GET /tmdb/search?q=…` — an authenticated Worker proxy over
TMDB movie search (`worker/src/index.js` `handleTmdbSearch`) returning the
top 8 results that have posters (`{ id, title, year, poster, thumb }`).
Picking a suggestion confirms the film: it fills the film + year inputs and
preselects the film's primary poster. Step 2: the form then queries
`GET /tmdb/posters?id=…` (`handleTmdbPosters`) for up to 12 alternate posters
(English/textless, TMDB vote-ranked) rendered as a thumbnail grid — clicking
one swaps the selection, shown in the preview with a Remove button. The
chosen `w500` URL rides the submission as `poster`.

Both endpoints keep the API key server-side (`TMDB_API_KEY` secret; v3 key or
v4 read token), edge-cache TMDB responses for a day, return 503 when the
secret is unset (the form quietly degrades), and serve canned Matrix fixtures
under `E2E_MODE` so Playwright and local UI work never hit TMDB.

Setup per environment: `cd worker && npx wrangler secret put TMDB_API_KEY`
(repeat with `--env staging`); locally add it to `worker/.dev.vars`.

## Linking a Letterboxd diary entry

On the Events tab, the host-only panel on their own event card has a
"Letterboxd" block: quick-pick buttons for the host's recent diary entries
(from `/data/watched.json`, keyed by their linked handle — empty when no
handle is linked) plus a manual URL field. Picking or saving PATCHes
`letterboxd_uri` (host-auth; validated server-side to `letterboxd.com` /
`boxd.it` URLs; not a where/when change, so no RSVP notification emails),
and the card's film title then links to the entry. Uses the same
`publicEventProjection` field curated events already use.

Once linked, the quick-picks and URL field are hidden — the block shows only
the confirmation line plus an "Unlink Diary Entry" button. One click PATCHes
an empty `letterboxd_uri`, which the Worker treats as delete-on-empty (same
pattern as meetup `capacity`/`time`), and the picker returns.

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
