# worker

Cloudflare Worker backing `join.jxnfilm.club` (prod, from `main`) and
`join-staging.jxnfilm.club` (from `staging`). Serves a static signup
form at `/`, handles email/OTP membership verification, Letterboxd tag
verification, session tokens, and repo-dispatch calls that commit
updates to `data/members.json` in this repo. **No session UI lives on
this origin** — the signup form redirects to `jxnfilm.club/verify` for
code entry so sessions stay single-origin.

## Dev

```bash
cd worker
npm install
npx wrangler dev                 # http://localhost:8787
npx wrangler deploy              # production (jxnfilmclub-join)
npx wrangler deploy --env staging
```

Local `wrangler dev` uses Miniflare — KV is in-memory, `fetch()` hits
the real internet. Pass secrets as `--var NAME:value` or drop a
`worker/.dev.vars` file.

## One-time setup

See [../docs/SETUP.md](../docs/SETUP.md) for the full walkthrough.
Summary:

```bash
# KV namespaces (prod + staging)
npx wrangler kv:namespace create MEMBERS_KV
npx wrangler kv:namespace create MEMBERS_KV --env staging
# → paste returned ids into wrangler.toml

# Secrets (repeat with --env staging for the staging Worker)
npx wrangler secret put GITHUB_TOKEN     # fine-grained PAT, Contents: Write
npx wrangler secret put RESEND_API_KEY   # re_... from resend.com
npx wrangler secret put OTP_SIGNING_KEY  # openssl rand -hex 32
npx wrangler secret put TMDB_API_KEY     # themoviedb.org v3 key or v4 read token (poster search)
```

Email domain (`jxnfilm.club`) must be verified in Resend — SPF + DKIM
DNS records are printed in the Resend dashboard.

## Routes

### Static

| Method | Path        | Purpose |
|--------|-------------|---------|
| GET    | `/`         | Signup form. `%SITE_ORIGIN%` placeholder is substituted at response time so links target the right origin. |
| GET    | `/privacy`  | Privacy policy (HTML). |

### Signup + session (anonymous)

| Method | Path                | Purpose |
|--------|---------------------|---------|
| POST   | `/signup`           | `(email, name, handle?)` → writes `pending:{email}` (carries optional handle), sends OTP-only email. |
| POST   | `/signup/verify`    | `(email, code)` → promotes pending → `member:{email}`, dispatches `add-member`, returns session token. |
| POST   | `/otp/request`      | `(email)` — returning members only; silently 200s for unknown emails so the endpoint can't enumerate. |
| POST   | `/otp/verify`       | `(email, code)` → returns session token + member `id`/`handle`. |

### Public live reads (no auth; SPA consumes these on every page load)

| Method | Path                       | Purpose |
|--------|----------------------------|---------|
| GET    | `/members`                 | Array of public member projections `[{ id, name, joined, pronouns?, handle? }]`. Emails are never on the wire. Reads from `members:all` aggregate; bootstraps from `data/members.json` on cold KV. |
| GET    | `/events`                  | Array of public event projections `[{ id, title, film, year, date, venue, poster, letterboxd_uri, hostId?, hostName?, capacity?, kind?, time? }]` — never `address` or `notes` (both are RSVP-email/host-only). Reads from `events:all` aggregate (in `ATTENDANCE_KV`); bootstraps from `data/events.json` on cold KV. |
| GET    | `/events/attendance`       | Bulk attendance map (existing). |
| GET    | `/watched`                 | Live Last Four: handle-keyed map of linked members' recent Letterboxd diary entries, fetched from RSS on demand and KV-cached 15 min (`watched:cache`). Empty map under `E2E_MODE`. |
| GET    | `/events/:id/attendance`   | Per-event attendees (existing). |

### Authenticated (bearer token from `/signup/verify` or `/otp/verify`)

| Method | Path                  | Purpose |
|--------|-----------------------|---------|
| GET    | `/member/me`          | Full `member:{email}` row (authoritative copy). |
| POST   | `/member/update`      | `(name?, pronouns?, handle?)` → writes KV + dispatches `update-member`. Patches the `members:all` aggregate in lockstep so the next public `/members` read reflects the change. Handle is self-asserted; uniqueness via `email:{handle}` reverse index. |
| POST   | `/letterboxd/unlink`  | Remove the Letterboxd link. Clears `email:/handle:` rows, nulls `member.handle`, patches `members:all`, dispatches `update-member` with `{ handle: null }`. |

### Member-hosted screenings & meetups (bearer token; see docs/features/hosting.md)

| Method | Path                    | Purpose |
|--------|-------------------------|---------|
| POST   | `/events`               | Create a hosted event. `kind: 'house'` (default): required private `address` + `capacity`; public `venue` label defaults to `{hostName}'s house` when not given. `kind: 'meetup'`: required `venue` from the `THEATERS` allowlist, optional `capacity`/`time` (HH:MM); no address stored. |
| PATCH  | `/events/:id`           | Host-only edit. `kind` immutable (400). date/time/address/venue changes email confirmed RSVPs; raising or clearing capacity auto-promotes the waitlist. |
| DELETE | `/events/:id`           | Host-only cancel; emails confirmed RSVPs, tears down `event:/rsvp:/attend:` state. |
| POST   | `/events/:id/rsvp`      | Confirm (emails house address or meetup venue) or waitlist when at capacity; uncapped meetups always confirm. |
| DELETE | `/events/:id/rsvp`      | Cancel own RSVP; promotes the waitlist head. |
| GET    | `/events/:id/rsvp/me`   | `{ status: 'confirmed' \| 'waitlisted' \| 'none', position? }`. |
| GET    | `/events/:id/host`      | Host-only: `{ kind, capacity, address, venue, time, notes, confirmed: [names], waitlist: [names] }` — never attendee emails. |
| GET    | `/tmdb/search?q=`       | Poster search proxy for the /host form (step 1). Top 8 TMDB movie matches with posters: `{ results: [{ id, title, year, poster, thumb }] }`. 503 when `TMDB_API_KEY` is unset; canned fixture under `E2E_MODE`. |
| GET    | `/tmdb/posters?id=`     | Step 2: up to 12 alternate posters for a TMDB movie id: `{ posters: [{ full, thumb }] }`. Same key/503/E2E semantics as `/tmdb/search`. |
| GET/POST | `/rsvp/cancel?token=` | One-click cancel from email (HMAC token, purpose-tagged; GET renders a confirm page). |

### Dev-only (E2E)

| Method | Path          | Purpose |
|--------|---------------|---------|
| ALL    | `/__test/kv`  | Enabled only when `env.E2E_MODE === 'true'`. `POST { key, value, ttl }`, `GET ?key=...` / `GET ?prefix=...`, `DELETE { key }` (JSON) or `DELETE ?prefix=...`. |

## Env vars

Set in `wrangler.toml` per env:

| Name              | Purpose |
|-------------------|---------|
| `SITE_ORIGIN`     | CORS allow-origin + substituted into signup.html links (e.g. `https://jxnfilm.club`). |
| `GITHUB_OWNER`    | Dispatch target repo owner. |
| `GITHUB_REPO`     | Dispatch target repo name. |
| `E2E_MODE`        | When `"true"`, enables `/__test/kv` and short-circuits Resend + GitHub dispatch (writes last-call details to KV sentinels `__last_email__` / `__last_dispatch__`). Never set in prod. |

## KV schema

**MEMBERS_KV:**
- `pending:{email}` — `{ name, handle?, code }`, 10min TTL. Consumed by `/signup/verify`.
- `member:{email}` — `{ id, email, name, pronouns, handle, joined }`. Canonical per-member row (holds the email).
- `members:all` — public projection array served by `GET /members`. Patched in lockstep by every mutating handler.
- `members:bootstrapped` — `'1'` marker; presence means JSON→KV seed has run.
- `email:{handle}` / `handle:{email}` — bidirectional link, written on `/signup/verify` (when the signup carried a handle) and on `/member/update`.
- `otp:{email}` — 6-digit login code, 10min TTL.
- `watched:cache` — aggregated Last Four RSS results, 15min `expirationTtl`.

**ATTENDANCE_KV:**
- `attend:{eventId}` / `attendance:all` / `attendance:bootstrapped` — attendance live + snapshot (unchanged). For hosted events, `attend:{id}` is a names-only write-through mirror of `rsvp:{id}.confirmed`.
- `event:{id}` — canonical per-event row (admin dashboard or hosted-event handlers). Hosted rows carry `hostId`/`hostName` and `kind` (`'house'` with private `address`, or `'meetup'` with public `venue`/optional `time`; rows without `kind` predate meetups = house).
- `rsvp:{eventId}` — `{ confirmed: [{ memberId, name, email, at }], waitlist: [...] }` for hosted events.
- `events:all` — public projection array served by `GET /events`. Patched in lockstep by `event:{id}` writes.
- `events:bootstrapped` — `'1'` marker.

## Tests

```bash
# From the repo root:
npm test              # Vitest, incl. tests/worker/
npm run test:e2e      # Playwright boots this Worker with E2E_MODE
```

`tests/worker/` uses `@cloudflare/vitest-pool-workers` with `SELF.fetch`,
direct KV binding access, and mocked `fetch()` for Resend / GitHub.
Suites: `signup`, `otp`, `member-update`, `member-delete`, `letterboxd`
(unlink only), `attendance`, `security`.
