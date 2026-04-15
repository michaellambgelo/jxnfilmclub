# jxnfilmclub

Public membership directory for the Jackson Film Club. Joining the club
only requires an email. Members who have a Letterboxd profile can
optionally verify it to surface a link to their profile on the public
directory, last-four-watched films, and event attendance (diary entries
tagged `jxnfilmclub`).

## Stack

- [Nue.js](https://nuejs.org) 2.x SPA — `<!doctype dhtml>` HTML components + built-in `state` module
- TypeScript model layer (`model/`)
- Vanilla CSS (`css/`)
- Auth + signup backend: Cloudflare Worker (`worker/`), deploys to `join.jxnfilm.club`
- Email: [Resend](https://resend.com) (3k/mo free tier)
- Tests: Vitest (unit + Workers) + Playwright (E2E)
- Deploys: GitHub Pages (site) + Cloudflare (Worker), both via GitHub Actions, gated on tests

## Develop

Two terminals in parallel:

```bash
# Terminal 1 — static site
npx nue            # dev server on http://localhost:4000 (HMR)

# Terminal 2 — Worker (signup / OTP / Letterboxd / session)
cd worker
npx wrangler dev   # http://localhost:8787
```

If `nue serve` HMR misbehaves, use the production build instead:

```bash
npx nue build
npx nue preview    # serves .dist/ on http://localhost:4000
```

## Commands

```bash
npm test              # vitest (model + worker endpoints)
npm run test:e2e      # Playwright E2E (boots nue + wrangler + LB stub)
npm run test:e2e:ui   # Playwright interactive UI mode
npx nue build         # static build → .dist/
```

See [CLAUDE.md](CLAUDE.md) for layout + architecture,
[SETUP.md](SETUP.md) for one-time deploy setup.

## Architecture

Two origins, one shared domain:

- **`jxnfilm.club`** (GitHub Pages) — the SPA. Hosts every page the user
  actually interacts with: `/` (members), `/events`, `/signin`,
  `/verify`, `/edit`.
- **`join.jxnfilm.club`** (Cloudflare Worker) — the backend API. Also
  serves a small signup-form HTML entry point at its root. Every
  verification, session, and Letterboxd check hits the Worker as an
  API call; no session UI lives here.

## Features

### 1. Members directory

`data/members.json` is the source of truth, keyed by a stable random
`id` on each row. Rendered by `ui/views.html` (`members-view`) with
search + sort, URL-bound via Nue's `state` module. The `@handle`
Letterboxd link is conditionally rendered — members without a verified
Letterboxd simply don't show one.

### 2. Signup flow (email-first)

1. User visits `https://join.jxnfilm.club/` and submits a form with
   name + email + optional Letterboxd handle.
2. Worker `POST /signup` writes `pending:{email}` (10min OTP code) and
   `lb_token:{email}` (48h Letterboxd tag — issued even when no handle
   is supplied, so the user can add one later).
3. Worker sends a single email with both the 6-digit code and the
   Letterboxd tag instructions.
4. User is redirected to `https://jxnfilm.club/verify?email=<email>`.
5. User enters the code; the `verify-view` calls `POST /signup/verify`.
   Worker promotes `pending:{email}` → `member:{email}`, dispatches
   `add-member` to GH Actions, returns an HMAC-signed session token.
6. Session is stored in `localStorage` on `jxnfilm.club` and the user
   is sent to `/edit`. `data/members.json` picks up the new row on the
   next site redeploy (~30s).

### 3. Letterboxd verification (optional)

From `/edit`, a signed-in member can add (or replace) a Letterboxd
handle. Worker mints a fresh 48h `jxnfc-verify-<token>` tied to the
member's email; the user pastes the tag into a diary entry or list on
their Letterboxd profile, then clicks Verify. Worker scrapes
`letterboxd.com/<handle>/rss/` — which picks up both tagged diary
entries and new lists — and, on match, commits the link and dispatches
`update-member` to add the handle to the public entry.

### 4. Sign-in (returning members)

`/signin` collects an email, calls `POST /otp/request` (login-only
email — no Letterboxd content), then `POST /otp/verify` with the
6-digit code. Returns a session token; identical storage + redirect
behavior to signup.

`/otp/request` silently 200s for unknown emails so the endpoint can't
be used to enumerate members.

### 5. Last Four Watched + event attendance

`scripts/refresh_letterboxd.py` runs on a 6-hour GitHub Actions cron
(`.github/workflows/refresh-letterboxd.yml`). Walks each member's
Letterboxd RSS, writes `data/watched.json` (4 most recent diary
entries per member) and `data/attendance.json` (events → member list,
matched by the `jxnfilmclub` diary tag). *RSS field mapping needs
verification against a real feed.*

## Testing

- **Unit + Workers** (`tests/model/`, `tests/worker/`): Vitest with
  `@cloudflare/vitest-pool-workers` for realistic KV + `fetch` mocking.
- **E2E** (`tests/e2e/`): Playwright boots `nue`, `wrangler dev`, and a
  scriptable Letterboxd HTTP stub; covers SPA views, the cross-origin
  signup handoff, OTP + verify flows, Letterboxd-panel states on `/edit`,
  and the auth-aware nav. CI (`test.yml`) gates both deploy workflows
  on these suites passing.

The Worker exposes dev-only helpers behind `env.E2E_MODE === 'true'`:
`/__test/kv` (GET/POST/DELETE with key or prefix) for seeding + wiping,
and short-circuited Resend/GitHub calls so tests never make network
calls. See [playwright.config.ts](../playwright.config.ts) for the
three-server setup.

## Privacy

Member emails live only in Workers KV. `data/members.json` never
contains emails. The `id` field in public JSON is a random token with
no connection to the email. Policy served at
`join.jxnfilm.club/privacy`.

## Deploy

One-time setup (DNS, Cloudflare token, GitHub PAT, KV namespaces, Resend
DNS) is in [SETUP.md](SETUP.md). After that, `git push origin main`
triggers `deploy-site.yml` + `deploy-worker.yml`, both gated on
`test.yml` passing. `staging` branch deploys a parallel Worker at
`join-staging.jxnfilm.club`.
