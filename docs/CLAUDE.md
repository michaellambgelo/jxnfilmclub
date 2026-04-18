# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**jxnfilmclub** is a membership directory for the Jackson Film Club. Membership is email-verified; linking a Letterboxd profile is optional and happens after signup. The site (`jxnfilm.club`) is a Nue SPA on GitHub Pages. The Worker (`join.jxnfilm.club`) is an API backend for signup, OTP, Letterboxd verification, and member edits — plus a tiny signup-form HTML page at its root. All session UI lives on the main site origin so tokens never cross origins.

## Tech Stack

- **Framework**: [Nue](https://nuejs.org) 2.x SPA — `<!doctype dhtml>` HTML components + built-in `state` module.
- **Model layer**: TypeScript (`model/index.ts`)
- **Styling**: Vanilla CSS (`css/`)
- **Backend**: Cloudflare Worker (`worker/`), deploys to `join.jxnfilm.club` + `join-staging.jxnfilm.club`
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
npm run test:e2e      # Playwright: SPA + signup + signin + LB flows
npm run test:e2e:ui   # Playwright interactive UI mode
```

Day-to-day dev: two terminals running `npx nue` + `cd worker && npx wrangler dev`.

## Layout

| Path | Contents |
|------|----------|
| `index.html` | SPA entry — `<!doctype dhtml>`, sets up `state` router, mounts view components |
| `ui/views.html` | `members-view` + `events-view` (`<!doctype dhtml lib>`). `@handle` link is `:if`-gated on `el.handle`. |
| `ui/auth.html` | `sign-in-view`, `verify-view` (signup confirmation), `edit-view` (name/pronouns + Letterboxd panel) |
| `ui/widgets.html` | `avatar` + `timeago` leaf components |
| `css/` | Vanilla CSS — `global`, `form`, `auth`, `widgets`, `table`, `readme` |
| `model/index.ts` | `getMembers` / `getEvents` — read `data/*.json`, paginate, sort, search |
| `data/` | Source-of-truth JSON: `members.json` (id-keyed), `events.json`, and (cron-generated) `watched.json`, `attendance.json` |
| `worker/` | Cloudflare Worker at `join.jxnfilm.club` — all auth + signup + LB + member endpoints, plus `GET /` signup form |
| `worker/src/` | `index.js`, `signup.html`, `privacy.html`. `%SITE_ORIGIN%` in signup.html is replaced at response time. |
| `scripts/refresh_letterboxd.py` | 6-hour cron RSS scraper (feeds `watched.json` + `attendance.json`) |
| `.github/workflows/` | `add-member` + `update-member` (repo_dispatch, id-keyed); `refresh-letterboxd` (cron); `test` (reusable) + `deploy-site` + `deploy-worker` (gated on test) |
| `tests/model/` | Vitest model tests |
| `tests/worker/` | Vitest + Workers pool: `signup.test.js`, `otp.test.js`, `member-update.test.js`, `letterboxd.test.js` |
| `tests/e2e/` | Playwright specs + Letterboxd HTTP stub (`letterboxd-stub.mjs` with a `/__prime` endpoint) |
| `playwright.config.ts` | Boots nue, wrangler dev, and the LB stub as three webServers |
| `site.yaml` | Nue config: `meta.title`, `import_map`, include/exclude for the SPA bundler |

## Architecture Notes

- **Two origins**: `jxnfilm.club` owns every UI view including code entry and sessions. `join.jxnfilm.club` hosts the top-level signup form and the API. After `POST /signup` the Worker redirects the browser to `jxnfilm.club/verify?email=...`, so session creation (`/signup/verify`) and `localStorage` live in one origin.
- **Data model**: members are keyed by a random `id` string, not by Letterboxd handle. `data/members.json` rows have `{ id, name, joined, pronouns, handle? }`. Handle is populated only after Letterboxd verification succeeds.
- **KV schema**:
  - `pending:{email}` — `{ name, handle?, code }`, 10min TTL. Written on `/signup`, consumed by `/signup/verify`.
  - `member:{email}` — `{ id, email, name, pronouns, handle, joined }`. Authoritative member row (source-of-truth for the Worker; `data/members.json` is the public projection).
  - `session:{id}` — full member snapshot keyed by member id, 1h TTL (matches JWT exp). Write-through overlay refreshed on `/signup/verify`, `/otp/verify`, `/member/update`, `/letterboxd/verify`, `/letterboxd/unlink`. `/member/me` reads this first and falls back to `member:{email}` on miss, reseeding — same baseline-on-miss pattern as `readAttendees`.
  - `lb_token:{email}` — `{ token, handle?, exp }`, 48h TTL. Issued on signup and on `/letterboxd/request`.
  - `email:{handle}` / `handle:{email}` — bidirectional handle ↔ email link, written on `/letterboxd/verify`.
  - `otp:{email}` — 6-digit login code for returning members, 10min TTL.
- **Routing (SPA)**: `state.setup({ route: '/:type', query: ['query', 'sort', 'email'], autolink: true })`. `state.on('type', ...)` dispatches to `members-view` (default), `events-view`, `sign-in-view`, `verify-view`, or `edit-view`.
- **Conditional nav**: `index.html`'s root component derives `signedIn` from `localStorage.jxnfc_session`. Nav renders Join + Log in when signed out, Edit account when signed in. Refreshed on every route change.
- **Session**: `localStorage.jxnfc_session = { token, email, id, handle?, exp }`. The `token` is `base64url(JSON(claims)).HMAC-SHA256`, signed with `OTP_SIGNING_KEY`. Claims include `email`, `id`, and `exp`. The Worker mirrors an authoritative snapshot at `session:{id}` (see KV schema) so `/member/me` reads are fast and reflect the latest mutation immediately.
- **Server-resolved identity**: `/member/update` and `/letterboxd/verify` look up the member from the bearer token's email, not from request body fields. Clients can't edit anyone else's entry.
- **Email templates**: two — `sendSignupEmail` (OTP + 48h LB tag + instructions) and `sendLoginEmail` (OTP only). Different Resend subjects.

## dhtml Component Gotchas

Nue's dhtml compiler has sharp edges worth remembering:

- **Top-level field initializers are NOT bound to `this`.** `step = 'email'` at the top of a `<script>` block does nothing; referencing `step` in the template throws `ReferenceError`. Initialize state inside `mounted()` via `this.update({ step: 'email', ... })` — that's the only pattern that reactively binds. Methods (`async foo() {}`) do get hoisted.
- **`{...}` in attribute values is template syntax.** `pattern="[0-9]{6}"` becomes `pattern="[0-9]6"` at render. Escape via JS (`'[0-9]' + '{6}'`) or drop the attribute.
- **`:if` on a `<form>` unmounts the form on toggle, and `:onsubmit` does not re-bind on remount.** Prefer a single form with `:if`-gated fields and a single `:onsubmit` router that branches internally (see `sign-in-view` and `edit-view` in `ui/auth.html`).
- **`autolink: true` intercepts every anchor click, including cross-origin ones and `target="_blank"`.** `index.html` installs a capture-phase `document` click listener that calls `stopImmediatePropagation()` for cross-origin or `target="_blank"` anchors before autolink's bubble-phase listener sees them, so the browser handles those clicks natively. No per-component `:onclick` workaround is needed. If you add a new external anchor, it just works — as long as `href` is absolute (cross-origin) or `target="_blank"` is set. Don't try to remove this capture listener.

## Testing

### Unit + Workers (Vitest)
`tests/model/` and `tests/worker/`. Worker tests use `@cloudflare/vitest-pool-workers` (`SELF.fetch`, direct KV binding access). Patterns in `tests/worker/signup.test.js` and `letterboxd.test.js` are the template for new endpoint tests.

### E2E (Playwright)
`tests/e2e/` — `site.spec.ts`, `signup.spec.ts`, `signin.spec.ts`, `letterboxd.spec.ts`. `playwright.config.ts` boots three webServers:

| Port | Service | Notes |
|------|---------|-------|
| 8083 | `nue serve` | Static site |
| 8787 | `wrangler dev` | Worker with `E2E_MODE=true` + `LETTERBOXD_BASE=http://localhost:8788` + `OTP_SIGNING_KEY=e2e-test-signing-key` + `SITE_ORIGIN=http://localhost:8083` |
| 8788 | `tests/e2e/letterboxd-stub.mjs` | Stub Letterboxd HTTP responses; `POST /__prime { token }` arms the next RSS fetch to contain a specific token |

**E2E-only Worker shims** (gated by `env.E2E_MODE === 'true'`):
- `/__test/kv` supports `POST { key, value, ttl }`, `DELETE { key }` or `DELETE ?prefix=...`, and `GET ?key=...` or `GET ?prefix=...`. Use `seedKv()` / `wipeKv()` helpers from `tests/e2e/fixtures.ts`.
- Resend + GitHub dispatch are short-circuited; last call stashed at KV sentinels `__last_email__` / `__last_dispatch__`.

**Site-side override**: `ui/auth.html` reads `window.JXNFC_WORKER_ORIGIN` so tests can retarget cross-origin fetches at the local Worker. `fixtures.ts` injects this via `page.addInitScript`.

**Worker-side override**: `worker/src/signup.html` contains literal `%SITE_ORIGIN%` strings that are substituted with `env.SITE_ORIGIN` at response time, so the signup form's redirect + back-link target the correct origin in tests / staging / prod.

**State isolation**: reused wrangler-dev instances would otherwise carry KV state between test runs, so `fixtures.ts` has a `beforeEach` that wipes all `pending:/member:/otp:/lb_token:/email:/handle:/__last_*` prefixes.

**OTP sequencing**: `POST /otp/request` overwrites whatever's at `otp:{email}`, so the helper pattern in `signInAs()` is: click "Email me a code" → immediately re-seed `otp:{email}` with a known value → then submit. `POST /signup` behaves similarly with `pending:{email}`.

### CI gate
`.github/workflows/test.yml` exposes `workflow_call` with `unit` + `e2e` jobs. `deploy-site.yml` and `deploy-worker.yml` declare `test: uses: ./.github/workflows/test.yml` + `deploy: needs: [test]`, so failing tests block deploys. Bot-driven site redeploys (via `workflow_run`) skip the test job — no code change to validate.

## Gotchas

- **Do not add TS/JS config files at the repo root without excluding them from `site.yaml`.** Nue's SPA bundler will pick them up and emit a broken `<script src="//<name>.js">` tag into the HTML `<head>` (the leading `//` is protocol-relative — DNS fails and the Nue runtime can wedge, leaving CSS unapplied). `playwright.config.ts`, `vitest.config.ts`, `vitest.workspace.ts` are already excluded; add any new root configs to the `exclude:` list.
- **`nue serve` HMR can get into a bad state** after certain edits. If the local page looks unstyled or half-rendered, run `npx nue build && npx nue preview` for a clean review against the production build.
- **Worker secrets in wrangler dev**: production secrets (`OTP_SIGNING_KEY`, `RESEND_API_KEY`, `GITHUB_TOKEN`) aren't read locally. Pass them via `--var` (see `playwright.config.ts`) or a `worker/.dev.vars` file.
- **GitHub Pages returns HTTP 404 for every path that isn't a real file.** The `deploy-site.yml` workflow copies `index.html` to `404.html` so the SPA still renders, but the response status stays 404 and the browser logs a console error for `signin:1 / verify:1 / edit:1` on cold loads. Harmless — the SPA takes over after the HTML lands.
- **RSS scraper is a scaffold** — `scripts/refresh_letterboxd.py` walks the members list but the Letterboxd RSS field names (`letterboxd_filmtitle`, etc.) need verification against a real feed.
- **`model/mocks/`** is dead code left over from the template — safe to delete.
- **Don't hand-edit `.dist/`** — build output.
