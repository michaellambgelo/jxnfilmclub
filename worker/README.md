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
| GET    | `/events`                  | Array of events `[{ id, title, film, year, date, venue, poster, letterboxd_uri }]`. Reads from `events:all` aggregate (in `ATTENDANCE_KV`); bootstraps from `data/events.json` on cold KV. |
| GET    | `/events/attendance`       | Bulk attendance map (existing). |
| GET    | `/events/:id/attendance`   | Per-event attendees (existing). |

### Authenticated (bearer token from `/signup/verify` or `/otp/verify`)

| Method | Path                  | Purpose |
|--------|-----------------------|---------|
| GET    | `/member/me`          | Full `member:{email}` row (authoritative copy). |
| POST   | `/member/update`      | `(name?, pronouns?, handle?)` → writes KV + dispatches `update-member`. Patches the `members:all` aggregate in lockstep so the next public `/members` read reflects the change. Handle is self-asserted; uniqueness via `email:{handle}` reverse index. |
| POST   | `/letterboxd/unlink`  | Remove the Letterboxd link. Clears `email:/handle:` rows, nulls `member.handle`, patches `members:all`, dispatches `update-member` with `{ handle: null }`. |

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

**ATTENDANCE_KV:**
- `attend:{eventId}` / `attendance:all` / `attendance:bootstrapped` — attendance live + snapshot (unchanged).
- `event:{id}` — canonical per-event row written by the admin dashboard.
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
