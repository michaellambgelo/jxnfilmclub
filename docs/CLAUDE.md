# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**jxnfilmclub** is a membership directory for the Jackson Film Club. Membership is email-verified; linking a Letterboxd profile is optional and happens after signup. The site (`jxnfilm.club`) is a Nue SPA on GitHub Pages. The Worker (`join.jxnfilm.club`) is an API backend for signup, OTP, Letterboxd verification, and member edits — plus a tiny signup-form HTML page at its root. All session UI lives on the main site origin so tokens never cross origins. A third origin, `admin.jxnfilm.club` (`admin/worker/`), hosts the operator dashboard behind Cloudflare Access — member session tokens never exist there.

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

# Admin worker (admin.jxnfilm.club — single env, binds prod + staging KV)
cd admin/worker && npx wrangler deploy

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
| `worker/` | Cloudflare Worker at `join.jxnfilm.club` — all auth + signup + LB + member endpoints, plus `GET /` signup form. Daily cron (`17 8 * * *`, both envs) runs `scrubPastEvents()` — the privacy policy's 30-day retention promise (strips address/notes off past hosted events, deletes their `rsvp:*` records; manual trigger `POST /admin/scrub` behind `ADMIN_TOKEN`). Account deletion purges the member from all `rsvp:*` records (`purgeRsvps`). |
| `worker/src/` | `index.js`, `signup.html`, `privacy.html` (the canonical privacy policy, served at `/privacy`; keep it in sync with actual data practices). `%SITE_ORIGIN%` and `%BRAND_CSS%` are replaced at response time by `render()`. `brand.css` is the Worker's shared "Night Shift" brand layer — token names/values mirrored verbatim from `css/tokens.css`, enforced by `tests/model/brand-sync.test.ts` (which also byte-compares `favicon.ico` against `img/favicon.ico`; the Worker serves it at `GET /favicon.ico`). JS-built pages (unsubscribe, RSVP cancel, browser 404) share the `page()` shell in `index.js`. |
| `fonts/` | Self-hosted variable woff2 fonts (Playfair/Oswald/Newsreader + Fira Code) — `@font-face` in `css/tokens.css`; worker pages load them cross-origin from `jxnfilm.club/fonts/`. **No Google Fonts anywhere** — the privacy policy promises no third-party font requests. |
| `admin/` | Admin dashboard SPA (`index.html`, `admin.js`, `style.css`) + two servers for it: `server.mjs` (local, shells to wrangler) and `admin/worker/` (hosted at `admin.jxnfilm.club` behind Cloudflare Access; binds all four KV namespaces + service bindings to both join Workers; Access-JWT gate fails closed). Excluded from the Nue build. See `admin/README.md`. |
| `scripts/refresh_letterboxd.py` | 6-hour cron RSS scraper (feeds `watched.json` + `attendance.json`) |
| `.github/workflows/` | `add-member` + `update-member` (repo_dispatch, id-keyed); `refresh-letterboxd` (cron); `test` (reusable) + `deploy-site` + `deploy-worker` (gated on test) |
| `tests/model/` | Vitest model tests |
| `tests/worker/` | Vitest + Workers pool: `signup.test.js`, `otp.test.js`, `member-update.test.js`, `letterboxd.test.js` |
| `tests/e2e/` | Playwright specs + Letterboxd HTTP stub (`letterboxd-stub.mjs` with a `/__prime` endpoint) |
| `playwright.config.ts` | Boots nue, wrangler dev, and the LB stub as three webServers |
| `site.yaml` | Nue config: `meta.title`, `import_map`, include/exclude for the SPA bundler |

## Architecture Notes

- **Three origins**: `jxnfilm.club` owns every UI view including code entry and sessions. `join.jxnfilm.club` hosts the top-level signup form and the API. After `POST /signup` the Worker redirects the browser to `jxnfilm.club/verify?email=...`, so session creation (`/signup/verify`) and `localStorage` live in one origin. `admin.jxnfilm.club` (the admin Worker) is a deliberate, isolated third origin: it's operator-only (Cloudflare Access One-time PIN + an in-Worker Access-JWT check), serves its own UI and API from the same origin (no CORS), and never sees a member bearer token — the invariant that member tokens don't cross origins still holds.
- **Data model**: members are keyed by a random `id` string, not by Letterboxd handle. The Worker's KV is the live source of truth for both members and events — the SPA fetches `GET /members` and `GET /events` on every page load, so new signups + admin edits appear immediately. `data/members.json` and `data/events.json` are cron-snapshotted archives (every 6h) that also serve as the bootstrap baseline for fresh KV namespaces and the SPA's fallback when the Worker is unreachable.
- **KV schema**:
  - `pending:{email}` — `{ name, handle?, code }`, 10min TTL. Written on `/signup`, consumed by `/signup/verify`.
  - `member:{email}` — `{ id, email, name, pronouns, handle, joined }`. Canonical per-member row (holds the email, which never leaves KV).
  - `members:all` — array of public projections `[{ id, name, joined, pronouns?, handle? }]` served verbatim by `GET /members`. Patched in lockstep by every mutating handler (`/signup/verify`, `/member/update`, `/letterboxd/unlink`, `/member/delete`). Bootstrapped from `data/members.json` on cold KV via `bootstrapMembers` (mirrors `bootstrapAttendance`).
  - `members:bootstrapped` — `'1'` marker; presence means the JSON→KV seed has run.
  - `session:{id}` — full member snapshot keyed by member id, 1h TTL (matches JWT exp). Write-through overlay refreshed on `/signup/verify`, `/otp/verify`, `/member/update`, `/letterboxd/unlink`. `/member/me` reads this first and falls back to `member:{email}` on miss, reseeding — same baseline-on-miss pattern as `readAttendees`. `/session/revoke` deletes this so a stale snapshot can't be replayed before revocation propagates.
  - `email:{handle}` / `handle:{email}` — bidirectional handle ↔ email link. Written on `/signup/verify` (when the signup payload carried a handle) and on `/member/update` whenever a member sets or changes their handle. The reverse index enforces handle uniqueness across the directory.
  - `otp:{email}` — 6-digit login code for returning members, 10min TTL.
  - `rate:otp_send:{email}` / `rate:signup_send:{email}` — single-cell throttle, 60s TTL. Bounds email-spam abuse from `/otp/request` and `/signup`. (S1)
  - `rate:otp_verify_fail:{email}` / `rate:signup_verify_fail:{email}` — integer counter, OTP-window TTL. Increments on wrong codes; >=5 returns 429 from `/otp/verify` and `/signup/verify`. Cleared on success. (S1)
  - `revoked:{jti}` — `'1'` marker, TTL = remaining JWT lifetime. Written by `/session/revoke`; consulted by every authenticated request. Tokens issued before S2 lack a jti and can't be revoked server-side, but they still expire on schedule. (S2)
  - `refresh:{id}:{secret}` — `{ email }`, 30-day sliding TTL. "Remember my login on this device": written by `/otp/verify` + `/signup/verify` when the request carries `remember: true` (client credential is `{id}.{secret}`, secret = 32-char alnum). `POST /session/refresh` trades a live record for a fresh 1h bearer token and re-puts the record with a full 30-day TTL (no rotation — rotation would let one tab invalidate another's stored token). Presence in KV is the sole validity check, so deletion revokes instantly: `/session/revoke` deletes the record passed in its body, `/member/delete` prefix-purges `refresh:{id}:` (every remembered device dies with the account), and a refresh for a deleted member 401s + self-cleans.
- **Routing (SPA)**: `state.setup({ route: '/:type', query: ['query', 'sort', 'email'], autolink: true })`. `state.on('type', ...)` dispatches to `members-view` (default), `events-view`, `sign-in-view`, `verify-view`, or `edit-view`.
- **Conditional nav**: `index.html`'s root component derives `signedIn` from `localStorage.jxnfc_session`. Nav renders Join + Log in when signed out, Account Actions (links to `/edit`) when signed in. Refreshed on every route change.
- **Session**: `localStorage.jxnfc_session = { token, email, id, handle?, exp }`. The `token` is `base64url(JSON(claims)).HMAC-SHA256`, signed with `OTP_SIGNING_KEY`. Claims include `email`, `id`, `exp`, and a random `jti` (S2 — addressable for server-side revocation). The Worker mirrors an authoritative snapshot at `session:{id}` (see KV schema) so `/member/me` reads are fast and reflect the latest mutation immediately. `POST /session/revoke` writes `revoked:{jti}` so the bearer token (and its session snapshot) can't be replayed for the remaining lifetime; the edit-view "Sign out" button calls this before clearing `localStorage`.
- **Remember my login (device refresh tokens)**: opting in at sign-in/signup adds `refresh` to `jxnfc_session` (see `refresh:{id}:{secret}` in the KV schema). `ui/auth.html`'s module script owns the logic — `ensureSession()` returns the stored session if its token is live, silently POSTs `/session/refresh` when only the device token remains, and clears the session when the server rejects it (network failures keep it). It's exported as `globalThis.jxnfcEnsureSession` so `ui/views.html` (events RSVP gate, host form) shares it without cross-lib imports; `index.html`'s `isSignedIn()` counts a stored `refresh` as signed-in optimistically. Sign-out passes `refresh` in the `/session/revoke` body so the device token dies with the session. The privacy policy's retention section names the 30-day opt-in — keep them in sync.
- **OTP in-flight**: `localStorage.jxnfc_otp_inflight = { email, sentAt }` — written by `sign-in-view` after `/otp/request`, expires client-side after 10 minutes, lets returning users resume the code-entry step without re-typing their email.
- **Server-resolved identity**: `/member/update` and `/letterboxd/unlink` look up the member from the bearer token's email, not from request body fields. Clients can't edit anyone else's entry.
- **Email templates**: OTP (`sendSignupEmail` / `sendLoginEmail`), screening transactional (`sendRsvpEmail` — carries the host address — plus update/cancellation variants, all with one-click cancel tokens), and the opt-in newsletter broadcast (`buildNewsletterMessage`, List-Unsubscribe + CAN-SPAM footer). All via Resend; `E2E_MODE` short-circuits to KV sentinels.

## dhtml Component Gotchas

Nue's dhtml compiler has sharp edges worth remembering:

- **Top-level field initializers are NOT bound to `this`.** `step = 'email'` at the top of a `<script>` block does nothing; referencing `step` in the template throws `ReferenceError`. Initialize state inside `mounted()` via `this.update({ step: 'email', ... })` — that's the only pattern that reactively binds. Methods (`async foo() {}`) do get hoisted.
- **`{...}` in attribute values is template syntax.** `pattern="[0-9]{6}"` becomes `pattern="[0-9]6"` at render. Escape via JS (`'[0-9]' + '{6}'`) or drop the attribute.
- **`:if` on a `<form>` unmounts the form on toggle, and `:onsubmit` does not re-bind on remount.** Prefer a single form with `:if`-gated fields and a single `:onsubmit` router that branches internally (see `sign-in-view` and `edit-view` in `ui/auth.html`).
- **Optional-chained method invocations in `<script>` blocks silently wedge the dhtml compiler.** Patterns like `e?.preventDefault()` or `foo.get('x')?.toString()` cause Nue to bail mid-parse and serialize the rest of the component script as a string literal — the build "succeeds" but the browser runs gibberish and the view renders blank. Use `if (e && e.preventDefault) e.preventDefault()` or `(x || '').toString()` instead. Optional chaining on *property* access (`s?.token`, `this.lb?.handle`) is fine; only the method-call form breaks.
- **An apostrophe inside a double-quoted attribute value fails the build.** `placeholder="Michael's house"` → tokenizer `SyntaxError: Unclosed tag` (it treats the `'` as opening a quoted value). Reword to avoid apostrophes in attribute values; text content and `{ }` expressions are fine.
- **`this` is not a stable identity across `update()`** — nuedom hands handlers a fresh context object after each update, so ad-hoc instance fields (`this._seq = 1`) written in one handler are invisible to closures created in another. Sequence counters, debounce timers, and any cross-handler mutable state must live at module scope in the component `<script>` (fine for single-instance views) or on `this.root` (a real DOM node that survives updates). QA proved `this._seq`-style race guards are silent no-ops.
- **Backslashes in component `<script>` code get DOUBLED in the compiled bundle** — the serializer escapes them and only `\n` is unescaped on the way out. `/^\d{4}/` compiles to `/^\\d{4}/` (a regex matching a literal backslash), which never throws and passes `node --check`, so the bug is silent: vitest imports the source (green) while the shipped bundle misbehaves. Write regexes with character classes (`[0-9]` not `\d`, `[ ]` not `\s`) and avoid `\`-escapes entirely in dhtml scripts. This silently broke the b54de13 local-date fix until runtime QA caught dates rendering a day early.
- **A backtick anywhere in a component `<script>` — even inside a comment — can blank the entire site.** The compiler serializes scripts with `util.inspect`, which normally delimits them with backticks; a literal backtick forces a `'`-quoted fallback with `\'` escapes, and nuedom's `RE_FN` regex (`[^\2]` is not a backreference) then truncates the script mid-expression. Every view in the lib file dies with `SyntaxError: Invalid or unexpected token`. No template literals, no backticks in comments.
- **A double-quoted string inside a `//` comment triggers the same truncation as a stray backtick** — confirmed by bisecting a real break in `ui/widgets.html`'s `timeago` component: a comment reading `having joined "Yesterday"` corrupted the compiled bundle at that exact position (`node --check` on the built `.dist/**/*.html.js` caught it — actual code was unaffected, `{n}` regex quantifiers were not the cause, only the quoted comment was). Plain single-quoted or unquoted comments compiled fine. Avoid *any* quote marks — single, double, or backtick — in dhtml `<script>` comments; when in doubt, rephrase without quoting anything. Since `bun` isn't preinstalled in every dev environment, verify with `brew install bun` (or equivalent) + `npx nue build` + `node --check .dist/**/*.html.js` before trusting a lib-file edit compiled cleanly — `nue serve`'s HMR can silently keep serving a stale bundle instead of surfacing the break.
- **Multi-line `{ ... }` interpolations in templates emit literal `\n` into the compiled JS** (the `fn:` compile path doesn't unescape newlines the way the `script:` path does) — the whole lib file fails to parse. Keep every `{ expression }` on one line, however long.
- **After editing a dhtml lib file, syntax-check the compiled bundle** — the build "succeeds" even when the output doesn't parse: `curl -s http://localhost:4000/ui/views.html.js -o /tmp/v.mjs && node --check /tmp/v.mjs` (or the equivalent file under `.dist/` after `nue build`).
- **`autolink: true` intercepts every anchor click, including cross-origin ones and `target="_blank"`.** `index.html` installs a capture-phase `document` click listener that calls `stopImmediatePropagation()` for cross-origin or `target="_blank"` anchors before autolink's bubble-phase listener sees them, so the browser handles those clicks natively. No per-component `:onclick` workaround is needed. If you add a new external anchor, it just works — as long as `href` is absolute (cross-origin) or `target="_blank"` is set. Don't try to remove this capture listener.

## Testing

### Unit + Workers (Vitest)
`tests/model/` and `tests/worker/`. Worker tests use `@cloudflare/vitest-pool-workers` (`SELF.fetch`, direct KV binding access). Patterns in `tests/worker/signup.test.js` and `letterboxd.test.js` are the template for new endpoint tests.

### E2E (Playwright)
`tests/e2e/` — `site.spec.ts`, `signup.spec.ts`, `signin.spec.ts`, `letterboxd.spec.ts`. `playwright.config.ts` boots three webServers:

| Port | Service | Notes |
|------|---------|-------|
| 8083 | `nue serve` | Static site |
| 8787 | `wrangler dev` | Worker with `E2E_MODE=true` + `OTP_SIGNING_KEY=e2e-test-signing-key` + `SITE_ORIGIN=http://localhost:8083` |

**E2E-only Worker shims** (gated by `env.E2E_MODE === 'true'`):
- `/__test/kv` supports `POST { key, value, ttl }`, `DELETE { key }` or `DELETE ?prefix=...`, and `GET ?key=...` or `GET ?prefix=...`. Use `seedKv()` / `wipeKv()` helpers from `tests/e2e/fixtures.ts`.
- Resend + GitHub dispatch are short-circuited; last call stashed at KV sentinels `__last_email__` / `__last_dispatch__`.

**Site-side override**: `ui/auth.html` reads `window.JXNFC_WORKER_ORIGIN` so tests can retarget cross-origin fetches at the local Worker. `fixtures.ts` injects this via `page.addInitScript`.

**Worker-side override**: `worker/src/signup.html` contains literal `%SITE_ORIGIN%` strings that are substituted with `env.SITE_ORIGIN` at response time, so the signup form's redirect + back-link target the correct origin in tests / staging / prod.

**State isolation**: reused wrangler-dev instances would otherwise carry KV state between test runs, so `fixtures.ts` has a `beforeEach` that wipes all `pending:/member:/members:/otp:/email:/handle:/session:/rate:/revoked:/__last_*` prefixes in MEMBERS_KV and `attend:/attendance:/event:/events:/rsvp:` in ATTENDANCE_KV. After the wipe it re-seeds `members:all` and `events:all` from `data/{members,events}.json` so SPA tests that expect the production directory contents work the same way they did when the SPA read those files directly.

**OTP sequencing**: `POST /otp/request` overwrites whatever's at `otp:{email}`, so the helper pattern in `signInAs()` is: click "Log in" → immediately re-seed `otp:{email}` with a known value → then submit. `POST /signup` behaves similarly with `pending:{email}`.

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
