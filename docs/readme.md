# jxnfilmclub

Public membership directory for the Jackson Film Club. Joining the club
only requires an email. Members who have a Letterboxd profile can
optionally verify it to surface a link to their profile on the public
directory, last-four-watched films, and other features coming soon. Any
logged-in member can mark their attendance at an event. This feature is
self-reported for now, but may evolve some moderation controls over time.

This site is in an active public beta. Please open an issue or start a discussion 
for bug reports or feature requests, respectively.

## Stack

- [Nue.js](https://nuejs.org) 2.x SPA — `<!doctype dhtml>` HTML components + built-in `state` module
- TypeScript model layer (`model/`)
- Vanilla CSS (`css/`)
- Auth + signup backend: Cloudflare Worker (`worker/`), deploys to `join.jxnfilm.club`
- Live data: the Worker's KV is the read source for members + events (`GET /members`, `GET /events`); `data/*.json` are 6-hourly snapshots that bootstrap fresh KV and act as the SPA's offline fallback
- Podcast: `data/episodes.json` synced weekly from the club's Anchor/Spotify RSS feed
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

The Worker's KV is the live source of truth, served via `GET /members`;
the SPA fetches it on every page load so new signups and admin edits
appear immediately. `data/members.json` is a 6-hourly snapshot (keyed by
a stable random `id` per row) that bootstraps a cold KV namespace and is
the SPA's fallback when the Worker is unreachable. Rendered by
`ui/views.html` (`members-view`) with search + sort, URL-bound via Nue's
`state` module. The `@handle` Letterboxd link is conditionally rendered —
members without a verified Letterboxd simply don't show one.

### 2. Signup flow (email-first)

1. User visits `https://join.jxnfilm.club/` and submits a form with
   name + email + optional Letterboxd handle.
2. Worker `POST /signup` writes `pending:{email}` (10min OTP code,
   carries the optional handle).
3. Worker sends a 6-digit OTP email.
4. User is redirected to `https://jxnfilm.club/verify?email=<email>`.
5. User enters the code; the `verify-view` calls `POST /signup/verify`.
   Worker promotes `pending:{email}` → `member:{email}` (promoting the
   handle and writing the `email:{handle}` reverse index in the same
   pass), dispatches `add-member` to GH Actions, returns an HMAC-signed
   session token.
6. Session is stored in `localStorage` on `jxnfilm.club` and the user
   is sent to `/edit`. `data/members.json` picks up the new row on the
   next site redeploy (~30s).

### 3. Letterboxd handle (optional, self-asserted)

From `/edit`, a signed-in member can type a Letterboxd handle and click
"Save handle". `POST /member/update { handle }` validates format and
uniqueness, writes the `email:{handle}` reverse index, refreshes the
session snapshot, and dispatches `update-member` so the public row
picks up the handle on the next redeploy. There is no automated
ownership check — disputes go through the local admin dashboard
(`admin/`), which can force-unlink a handle. A **Remove Letterboxd
link** button on the linked panel clears the link via
`POST /letterboxd/unlink`; membership is kept, the `@handle` just
disappears from the public row.

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

### 6. Events

`GET /events` (KV-backed, snapshotted to `data/events.json`) drives the
`events-view`. Each event row carries `{ id, title, film, year, date,
venue, poster, letterboxd_uri }`. Poster wells render at a 2:3 aspect
ratio (full movie-poster proportions). The directory supports a `venue`
filter (in addition to search + sort), URL-bound via the `state` module.

### 7. Podcast

The home view (`ui/views.html` → `home-podcast` section) embeds the
club's Spotify show and lists every episode from `data/episodes.json`
(`{ featured_id, episodes: [{ title, date, url }] }`).
`scripts/refresh_spotify.py` syncs it weekly (Mondays 12:00 UTC via
`.github/workflows/refresh-spotify.yml`) from the Anchor RSS feed.

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

Other GitHub Actions workflows:

- **Member mutations** — `add-member.yml`, `update-member.yml`,
  `remove-member.yml` (repo_dispatch from the Worker, id-keyed).
- **Data refresh (cron)** — `refresh-letterboxd.yml` (6h, watched +
  attendance) and `refresh-spotify.yml` (weekly, podcast episodes).
- **Snapshots (cron)** — `snapshot-members.yml`, `snapshot-events.yml`,
  `snapshot-attendance.yml` mirror live KV back into `data/*.json` every
  6h so the static fallback stays current.
- **CI** — `test.yml` (reusable suite) + `build-check.yml`.
