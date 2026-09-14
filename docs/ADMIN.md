# Admin runbook

Admin work for jxnfilmclub happens through three surfaces:

- **The hosted admin portal** — `https://admin.jxnfilm.club`, behind
  Cloudflare Access (One-time PIN, allowlisted emails). Primary UI for
  KV state: members, newsletter, pending signups, sessions, rate
  limits, events. See `admin/README.md`.
- **The local admin dashboard** — `npm run admin`, same UI served from
  `127.0.0.1` with your `wrangler` login as the gate. Fallback when
  Cloudflare/Access is having a day, and the only surface that can
  patch `data/members.json` directly.
- **Admin scripts** — the `scripts/admin/*.mjs` runbook below (with
  `wrangler` talking to production KV) plus, when appropriate, a git
  commit to `data/`.

The join Worker also has two token-gated endpoints
(`POST /admin/newsletter/send`, `POST /admin/scrub` — bearer
`ADMIN_TOKEN`); the portal's newsletter send goes through the former.

**Golden rule** for script-driven ops: any admin op that writes to KV is
paired with a companion `data/` commit in the same session so git
history and KV never drift. (Portal writes rely on the 6h snapshot
crons to reconcile `data/*.json` instead.)

## Prerequisites

- `wrangler` authenticated against the Cloudflare account that owns
  `join.jxnfilm.club`. Either:
  ```bash
  cd worker && npx wrangler login
  ```
  or set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in your shell.
- Node 20+ (for the admin scripts).
- Write access to the repo (commits land on `main`).

Admin scripts run from the repo root and invoke wrangler under `worker/`
automatically.

## Operations

### Seed a member

Used when you want a member to exist without going through the public
signup flow (founders, manual onboards, backfilling KV for someone
already present in `data/members.json`).

One entry via flags:
```bash
node scripts/admin/seed-member.mjs \
  --email=person@example.com \
  --name="Given Name" \
  --handle=theirhandle \
  --pronouns=they/them
```

Multiple entries from a file (put it in `.admin/` — gitignored):
```bash
cat > .admin/pending-members.json <<'JSON'
[
  { "email": "a@example.com", "name": "A", "handle": "a-lb" },
  { "email": "b@example.com", "name": "B" }
]
JSON
node scripts/admin/seed-member.mjs
```

The script:
1. Generates a random `id` if you didn't supply one.
2. Appends to `data/members.json` unless the `id` is already there.
3. Writes `member:{email}` to production KV.
4. If `handle` is set, writes `email:{handle}` and `handle:{email}` too.

When it finishes:
```bash
git diff data/members.json   # sanity-check the new rows
git add data/members.json
git commit -m "Seed member: ..."
git push
```

### Backfill KV for an existing `data/members.json` row

Same script. If the `id` is already in JSON, `seed-member.mjs` leaves
JSON alone and only writes the KV rows. Example — the original
michaellamb seed:

```bash
node scripts/admin/seed-member.mjs \
  --id=ml-seed001 \
  --email=michael@michaellamb.dev \
  --name="Michael Lamb" \
  --handle=michaellamb \
  --pronouns=he/him \
  --joined=2026-04-14
```

No commit needed in this case — `data/members.json` didn't change.

### Audit drift between JSON and KV

```bash
node scripts/admin/kv-audit.mjs
```

Lists any `data/members.json` rows without a KV counterpart, and any
KV `member:*` rows whose `id` isn't present in the JSON. Good first step
when something looks off.

### Add or edit an event

**Events are KV-driven.** Use the Events tab in the admin portal — it writes
`event:{id}` and patches the `events:all` aggregate in `ATTENDANCE_KV`, and
the public site reads them through the Worker's `GET /events`, so a save shows
up on `/events` immediately. `data/events.json` is an archival snapshot that
`snapshot-events.yml` rewrites from the Worker every 6h; **editing it by hand
is pointless** — the next cron tick overwrites your change.

Fields (canonical row; `address` and `notes` are private and never reach the
public projection):

```json
{
  "id": "2026-06-12-passion",
  "title": "Summer Screening",
  "film": "The Passion of Joan of Arc",
  "year": 1928,
  "date": "2026-06-12",
  "venue": "Location",
  "poster": "https://...",
  "kind": "social",
  "rsvp": true,
  "ticketUrl": "https://...",
  "time": "19:30",
  "capacity": 40,
  "notes": "Parking round back"
}
```

**Kind** — leave blank for an ordinary club screening. `social` marks an event
with no film (the film fields become optional); `house` and `meetup` are
normally stamped by the member `/host` form, though setting `meetup` on a
curated theater event fixes the home page's House/Venue tag.

**RSVP vs Ticket URL — pick one.** New events created here get RSVP **on** by
default. Ticking RSVP gives the event the full capacity / waitlist /
confirmation-email flow and shows the RSVP list on the card here. Setting a
Ticket URL instead turns RSVP off structurally (the theater keeps box-office
control) and the public card shows a "Get tickets" link. An event with RSVPs
off gets the post-hoc "I was there" attendance toggle instead — never both.

**Creating an event.** The **+ new event** button opens a full form above the
list. Nothing is written until it validates, so a half-made event never exists
in public — the previous flow asked for a slug in a `prompt()` and immediately
published an `Untitled` row dated today, which was live on `/events` until
somebody finished it.

- **Title and date are required**, matching what the Worker enforces. Every
  other field is optional and editable afterwards.
- **The id derives from date + film** as you type
  (`2026-10-22` + `Clayface` → `2026-10-22-clayface`, the convention the 42
  curated rows already follow) and is editable, since two events can share a
  date and a film. A duplicate is caught in the form.
- **The film field searches TMDB.** Picking a result fills film, year and
  poster; it only seeds the title if you have not written one, because the
  event title is editorial (*CLAYFACE Preview Screening*), not the film's.
- Creating publishes immediately. There is deliberately no draft state.

**Venue-ticketed events.** Tick **Tickets: sold by the venue** for a screening
the club markets but does not run — a preview sold through the theater's own
box office. Leave **Ticket URL** blank until tickets are actually on sale:
RSVPs queue in that window, and members are told tickets are not on sale yet
rather than that they are confirmed. **Saving a Ticket URL releases the whole
queue and emails everyone the box office link**, so add it once and only once
sales are live. After that the card offers *RSVP and get tickets*, which opens
the box office and records the headcount in one click. An RSVP on these events
never implies a seat, and the card and emails say so.

**Notifying RSVPs.** When an event has RSVPs, the form grows a checkbox
naming its audience — *"Email 12 confirmed + 3 waitlisted about this change"*.
It is **off by default**, so fixing a typo mails nobody. Tick it and the save
emails everyone holding a spot, confirmed and waitlisted, with a diff of what
moved. You get a confirm dialog showing the change and the count first;
mailing people is not undoable. Ticking it with nothing changed re-sends the
current details, which is what you want after a phone call.

Waitlisted members never receive the private address — they hold no seat.

**Deleting an event always notifies.** Cancellation notices go to confirmed
and waitlisted alike before the row is torn down; the confirm dialog names the
count. A past event mails nobody (its RSVP list was scrubbed 30 days after it
happened) but still cleans up.

Both paths run through the join Worker rather than a raw KV write, so the
capacity guard and waitlist promotion apply: raising capacity promotes from
the waitlist and emails whoever moved up, whether or not you ticked notify.
Lowering it below the already-confirmed count is refused.

**A save merges, it does not replace.** `PUT /admin/events/:id` layers the
body over the stored row, so a field the payload omits keeps its value —
which is why a script that forgets `capacity` cannot silently uncap an event
and promote its whole waitlist. Clearing is therefore explicit: send `""`
(the dashboard does this for any field you blank in the form). `id` is taken
from the path and `hostId`/`hostName` from the stored row, so an admin edit
can never reassign who hosted an event.

Older events predating the toggle carry no `rsvp` field; they read as RSVP-off
and keep taking attendance, which is why the flag is stamped explicitly rather
than defaulted on read.

### Remove a member (moderation)

No script yet — do it manually, paired:

```bash
# 1. Drop KV rows
cd worker
npx wrangler kv key delete --binding MEMBERS_KV "member:their@email"
npx wrangler kv key delete --binding MEMBERS_KV "handle:their@email"
# If they had a verified Letterboxd handle, also:
npx wrangler kv key delete --binding MEMBERS_KV "email:theirhandle"

# 2. Drop any transient state
npx wrangler kv key delete --binding MEMBERS_KV "otp:their@email"
npx wrangler kv key delete --binding MEMBERS_KV "pending:their@email"

# 3. Remove from data/members.json (by id), commit, push.
```

If this becomes routine, turn it into `scripts/admin/remove-member.mjs`.

### Force-link a Letterboxd handle on someone's behalf

Rare. Used only if a member can't reach the `/edit` form themselves.

```bash
cd worker
npx wrangler kv key put --binding MEMBERS_KV "email:theirhandle" "their@email"
npx wrangler kv key put --binding MEMBERS_KV "handle:their@email" "theirhandle"
# Also update the `handle` field on member:{email} — easiest:
node scripts/admin/seed-member.mjs \
  --id=<existing-id> \
  --email=their@email \
  --name="..." \
  --handle=theirhandle
# Then commit the resulting data/members.json diff (the handle column appears).
```

## Troubleshooting

- **"member not found" / silent-200 on `/otp/request`** — the member
  row is missing from KV. Run `kv-audit.mjs` to confirm, then
  `seed-member.mjs` with the existing id to backfill.
- **`wrangler kv key put` fails with auth error** — re-run
  `cd worker && npx wrangler login` or rotate `CLOUDFLARE_API_TOKEN`.
- **Seed script complains "invalid handle format"** — handle must match
  `[a-zA-Z0-9_-]+`, matching the Worker's `HANDLE_RE` in
  `worker/src/index.js`.

## What this deliberately doesn't do

- No `workflow_dispatch` admin actions — the repo is public and workflow
  run inputs + logs are publicly readable, which would leak emails.
- No encrypted in-repo admin data — scale doesn't justify age/sops yet.
- No admin API surface beyond the two token-gated join-Worker endpoints
  and the Access-gated admin Worker — everything else stays scripts +
  `wrangler`.

If any of the above stops making sense (more than a handful of ops per
month, incident retention needs), revisit.
