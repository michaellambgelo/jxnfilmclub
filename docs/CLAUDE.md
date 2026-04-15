# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**jxnfilmclub** is a membership list app for the Jackson Film Club. Members list their Letterboxd profile; the site surfaces last-four-watched films and event attendance (Letterboxd diary entries tagged `jxnfilmclub`). Signup and OTP auth live in a Cloudflare Worker at `join.jxnfilm.club` (source in `worker/`).

## Tech Stack

- **Framework**: [Nue](https://nuejs.org) 2.x SPA — `<!doctype dhtml>` HTML components + built-in `state` module.
- **Model layer**: TypeScript (`model/index.ts`)
- **Styling**: Vanilla CSS (`css/`)
- **Signup/auth backend**: Cloudflare Worker (`worker/`), deploys to `join.jxnfilm.club`
- **Email provider**: Resend (3k/mo free tier)
- **Tests**: Vitest + `@cloudflare/vitest-pool-workers` + Playwright

## Commands

```bash
# Site (default port 4000)
npx nue            # dev server with HMR
npx nue build      # static build → .dist/
npx nue preview    # serve .dist/ locally (use if `nue serve` misbehaves)

# Worker (runs in parallel during dev)
cd worker && npx wrangler dev     # http://localhost:8787
cd worker && npx wrangler deploy  # production
cd worker && npx wrangler deploy --env staging

# Tests
npm test              # Vitest: model + worker endpoints
npm run test:e2e      # Playwright: SPA + signup + OTP+edit flows
npm run test:e2e:ui   # Playwright interactive UI mode
```

Day-to-day dev: two terminals running `npx nue` + `cd worker && npx wrangler dev`.

## Layout

| Path | Contents |
|------|----------|
| `index.html` | SPA entry — `<!doctype dhtml>`, sets up `state` router, mounts view components |
| `ui/views.html` | `members-view` + `events-view` (`<!doctype dhtml lib>`) |
| `ui/auth.html` | `sign-in-view` (email + OTP code) + `edit-view` (authenticated entry edit) |
| `ui/widgets.html` | `avatar` + `timeago` leaf components |
| `css/` | Vanilla CSS — `global`, `form`, `auth`, `widgets`, `table`, `readme` |
| `model/index.ts` | `getMembers` / `getEvents` — read `data/*.json`, paginate, sort, search |
| `data/` | Source-of-truth JSON: `members.json`, `events.json`, and (cron-generated) `watched.json`, `attendance.json` |
| `worker/` | Cloudflare Worker at `join.jxnfilm.club` — signup, OTP, privacy, GH dispatch |
| `worker/src/` | `index.js`, `signup.html`, `privacy.html` (HTML imported via `rules = [{ type = "Text" }]`) |
| `scripts/refresh_letterboxd.py` | 6-hour cron RSS scraper (feeds `watched.json` + `attendance.json`) |
| `.github/workflows/` | `add-member`, `update-member` (repo_dispatch); `refresh-letterboxd` (cron); `test` (reusable) + `deploy-site` + `deploy-worker` (gated on test) |
| `tests/model/` | Vitest model tests |
| `tests/worker/` | Vitest + Workers pool tests for Worker endpoints |
| `tests/e2e/` | Playwright specs + Letterboxd HTTP stub (`letterboxd-stub.mjs`) |
| `playwright.config.ts` | Boots nue, wrangler dev, and the LB stub as three webServers |
| `site.yaml` | Nue config: `meta.title`, `import_map`, include/exclude for the SPA bundler |

## Architecture Notes

- **Routing**: `state.setup({ route: '/:type', query: ['query', 'sort'], autolink: true })` in `index.html`. `state.on('type', ...)` dispatches to `members-view` (default), `events-view`, `sign-in-view`, or `edit-view`. Search and sort are URL-bound query params.
- **Data flow**: components import `{ getMembers, getEvents } from 'app'` (bare import via `import_map`). Each view reloads its data on `state.on('query sort', ...)`.
- **Data source**: flat JSON in `data/`. `members.json` + `events.json` are hand-edited or written by GH Actions via `repo_dispatch`. `watched.json` / `attendance.json` are regenerated every 6 hours.
- **Signup/auth loop**: the Worker at `worker/` receives `POST /signup`, validates the Letterboxd profile + handle uniqueness, stores a verification token in KV. After the member places the token on Letterboxd, `POST /signup/verify` scrapes their profile, writes KV bidirectionally (email ↔ handle), and dispatches `add-member`. OTP login via Resend issues an HMAC-signed token that authorizes `POST /member/update`.
- **Server-resolved handle**: `/member/update` looks up the handle from the token's email (KV `handle:<email>`) — the client can't specify a handle, so users can only edit their own entry.
- **Avatars**: deterministic background color derived from the first letter of the name (`ui/widgets.html` → `avatar`).

## dhtml Component Gotchas

Nue's dhtml compiler has sharp edges worth remembering:

- **Top-level field initializers are NOT bound to `this`.** `step = 'email'` at the top of a `<script>` block does nothing; reference-ing `step` in the template throws `ReferenceError`. Initialize state inside `mounted()` via `this.update({ step: 'email', ... })` — that's the only pattern that reactively binds. Methods (`async foo() {}`) do get hoisted.
- **`{...}` in attribute values is template syntax.** `pattern="[0-9]{6}"` becomes `pattern="[0-9]6"` at render. Escape via JS (`'[0-9]' + '{6}'`) or drop the attribute.
- **`:if` on a `<form>` unmounts the form on toggle, and `:onsubmit` does not re-bind on remount.** Prefer a single form with `:if`-gated fields and a single `:onsubmit` router that branches internally (see `sign-in-view` in `ui/auth.html`).

## Testing

### Unit + Workers (Vitest)
`tests/model/` and `tests/worker/`. Worker tests use `@cloudflare/vitest-pool-workers` (`SELF.fetch`, direct KV binding access). Patterns in `tests/worker/signup.test.js` are the template for new endpoint tests.

### E2E (Playwright)
`tests/e2e/` — `site.spec.ts`, `signup.spec.ts`, `signin.spec.ts`. `playwright.config.ts` boots three webServers:

| Port | Service | Notes |
|------|---------|-------|
| 8083 | `nue serve` | Static site |
| 8787 | `wrangler dev` | Worker with `E2E_MODE=true` + `LETTERBOXD_BASE=http://localhost:8788` + `OTP_SIGNING_KEY=e2e-test-signing-key` |
| 8788 | `tests/e2e/letterboxd-stub.mjs` | Stub Letterboxd HTTP responses |

**E2E-only Worker shims** (gated by `env.E2E_MODE === 'true'`):
- `POST /__test/kv` seeds KV directly (use `seedKv(page, key, value, ttl)` from `tests/e2e/fixtures.ts`).
- Resend + GitHub dispatch are short-circuited (the last call is stashed to KV sentinels `__last_otp__` / `__last_dispatch__`).

**Site-side override**: `ui/auth.html` reads `window.JXNFC_WORKER_ORIGIN` so tests can retarget cross-origin fetches at the local Worker. `fixtures.ts` injects this via `page.addInitScript`.

**OTP sequencing**: `POST /otp/request` overwrites whatever's at `otp:<email>`, so the E2E pattern is: click "Email me a code" → immediately seed `otp:<email>` with a known value → then submit. See `requestCode()` in `signin.spec.ts`.

### CI gate
`.github/workflows/test.yml` exposes `workflow_call`. `deploy-site.yml` and `deploy-worker.yml` declare `test: uses: ./.github/workflows/test.yml` + `deploy: needs: [test]`, so failing tests block deploys. Bot-driven redeploys (via `workflow_run`) skip the test job — no code change to validate.

## Gotchas

- **Do not add TS/JS config files at the repo root without excluding them from `site.yaml`.** Nue's SPA bundler will pick them up and emit a broken `<script src="//<name>.js">` tag into the HTML `<head>` (the leading `//` is protocol-relative — DNS fails and the Nue runtime can wedge, leaving CSS unapplied). `playwright.config.ts`, `vitest.config.ts`, `vitest.workspace.ts` are already excluded; add any new root configs to the `exclude:` list.
- **`nue serve` HMR can get into a bad state** after certain edits. If the local page looks unstyled or half-rendered, run `npx nue build && npx nue preview` for a clean review against the production build.
- **Worker secrets in wrangler dev**: production secrets (`OTP_SIGNING_KEY`, `RESEND_API_KEY`, `GITHUB_TOKEN`) aren't read locally. Pass them via `--var` (see `playwright.config.ts`) or a `worker/.dev.vars` file.
- **RSS scraper is a scaffold** — `scripts/refresh_letterboxd.py` walks the members list but the Letterboxd RSS field names (`letterboxd_filmtitle`, etc.) need verification against a real feed.
- **`model/mocks/`** is dead code left over from the template — safe to delete.
- **Don't hand-edit `.dist/`** — build output.
