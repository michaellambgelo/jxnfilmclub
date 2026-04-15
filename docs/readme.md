# jxnfilmclub

Public membership directory for the Jackson Film Club. Each member lists their
Letterboxd profile; the site surfaces their last-four-watched films and event
attendance (Letterboxd diary entries tagged `jxnfilmclub`).

## Stack

- [Nue.js](https://nuejs.org) 2.x SPA — `<!doctype dhtml>` HTML components + built-in `state` module
- TypeScript model layer (`model/`)
- Vanilla CSS (`css/`)
- Signup/auth backend: Cloudflare Worker (`worker/`), deploys to `join.jxnfilm.club`
- Email: [Resend](https://resend.com) (3k/mo free tier)
- Tests: Vitest (unit + Workers) + Playwright (E2E)
- Deploys: GitHub Pages (site) + Cloudflare (Worker), both via GitHub Actions

## Develop

Two terminals in parallel:

```bash
# Terminal 1 — static site
npx nue            # dev server on http://localhost:4000 (HMR)

# Terminal 2 — Worker (signup/OTP backend)
cd worker
npx wrangler dev   # http://localhost:8787
```

If `nue` dev server misbehaves, use the production build instead:

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

See [CLAUDE.md](CLAUDE.md) for layout + architecture, [SETUP.md](SETUP.md) for
one-time deploy setup.

## Features

### 1. Members directory

`data/members.json` is the source of truth. Rendered by `ui/views.html`
(`members-view`) with search + sort, URL-bound via Nue's `state` module.

### 2. Signup pipeline (`join.jxnfilm.club`)

Cloudflare Worker at `worker/`. Two-step flow:

1. `POST /signup` — validates handle format + Letterboxd profile exists, issues
   a `jxnfc-verify-<token>` and stores the pending claim in KV (1-hour TTL).
2. Member places the token on their Letterboxd profile (diary-entry tag or
   list name).
3. `POST /signup/verify` — scrapes the profile for the token, writes KV
   bidirectionally (`email:<handle>`, `handle:<email>`), dispatches
   `add-member` to GitHub Actions.
4. Action appends the entry to `data/members.json` and commits to `main`,
   which triggers the site redeploy.

### 3. Last Four Watched + event attendance

`scripts/refresh_letterboxd.py` runs on a 6-hour GitHub Actions cron
(`.github/workflows/refresh-letterboxd.yml`). Walks each member's Letterboxd
RSS, writes `data/watched.json` (4 most recent diary entries per member) and
`data/attendance.json` (events → member list, matched by the `jxnfilmclub`
diary tag). *RSS field mapping needs verification against a real feed.*

### 4. Email/OTP edit flow

`/signin` → `POST /otp/request` → Resend emails a 6-digit code → `/signin`
code step → `POST /otp/verify` returns an HMAC-signed session token stored in
`localStorage`. `/edit` view uses the token to authorize
`POST /member/update`, which dispatches the `update-member` Action. The
resolved handle is derived server-side from the token's email — clients
cannot edit arbitrary entries.

## Testing

- **Unit + Workers** (`tests/model/`, `tests/worker/`): Vitest with
  `@cloudflare/vitest-pool-workers` for realistic KV + fetch mocking.
- **E2E** (`tests/e2e/`): Playwright boots `nue`, `wrangler dev`, and a
  Letterboxd fixture HTTP stub; covers SPA views, signup form, OTP → edit
  flow. CI gates both deploy workflows on these suites passing. See
  [playwright.config.ts](../playwright.config.ts) for the multi-server setup.

The Worker exposes a dev-only `/__test/kv` endpoint gated by
`env.E2E_MODE === 'true'` for seeding KV directly from tests.

## Privacy

Member emails live only in Workers KV. The public `data/members.json` never
contains emails. Policy served at `join.jxnfilm.club/privacy`.

## Deploy

One-time setup (DNS, Cloudflare token, GitHub PAT, KV namespaces, Resend
DKIM) is in [SETUP.md](SETUP.md). After that, `git push origin main`
triggers `deploy-site.yml` + `deploy-worker.yml`, both gated on `test.yml`
(Vitest + Playwright) passing. `staging` branch deploys a parallel Worker at
`join-staging.jxnfilm.club`.
