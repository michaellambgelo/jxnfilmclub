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
npm test              # Vitest workspace: model + worker + admin-worker + admin (4 projects)
npm run test:e2e      # Playwright: SPA + signup + signin + LB + admin dashboard flows
npm run test:e2e:ui   # Playwright interactive UI mode

# Deploy (normally via the /deploy router skill, which gates on the above)
scripts/deploy.sh     # rebase + push to main; targets site|worker|admin ride
                      # the push via deploy-*.yml (worker/admin path-filtered)
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
| `worker/` | Cloudflare Worker at `join.jxnfilm.club` — all auth + signup + LB + member endpoints, plus `GET /` signup form. Daily cron (`17 8 * * *`, both envs) runs `scrubPastEvents()` — the privacy policy's 30-day retention promise (strips address/notes off past hosted events, deletes their `rsvp:*` records) — and `reconcileMembersAll()` so aggregate drift self-heals; manual trigger for both is `POST /admin/scrub` behind `ADMIN_TOKEN`. Account deletion purges the member from all `rsvp:*` records (`purgeRsvps`). Hosts/admins can add non-member guests to a screening's RSVP list (`POST/DELETE /events/:id/rsvp/guest`); guest entries carry a synthetic `guest:xxxxxxxx` memberId — see `docs/features/hosting.md` § Guest RSVPs. |
| `worker/src/` | `index.js`, `signup.html`, `privacy.html` (the canonical privacy policy, served at `/privacy`; keep it in sync with actual data practices). `%SITE_ORIGIN%` and `%BRAND_CSS%` are replaced at response time by `render()`. `brand.css` is the Worker's shared "Night Shift" brand layer — token names/values mirrored verbatim from `css/tokens.css`, enforced by `tests/model/brand-sync.test.ts` (which also byte-compares `favicon.ico` against `img/favicon.ico`; the Worker serves it at `GET /favicon.ico`). JS-built pages (unsubscribe, RSVP cancel, browser 404) share the `page()` shell in `index.js`. |
| `fonts/` | Self-hosted variable woff2 fonts (Playfair/Oswald/Newsreader + Fira Code) — `@font-face` in `css/tokens.css`; worker pages load them cross-origin from `jxnfilm.club/fonts/`. **No Google Fonts anywhere** — the privacy policy promises no third-party font requests. |
| `admin/` | Admin dashboard SPA (`index.html`, `admin.js`, `contentgen.js` — Content Gen tab: social copy + canvas PNG cards from KV events/attendance/watched + site-served `data/episodes.json` (8 post types: announce, countdown, recap, lineup, monthly wrap, episode, milestone, roundup), posters via the Access-gated `/api/img` allowlisted proxy, `lib.js` — pure helpers incl. the social builders (`socialEventView`/`buildRoundupData` enforce no-address/no-member-attribution), unit-tested in `tests/admin/`, `style.css`) + two servers for it: `server.mjs` (local, shells to wrangler; `ADMIN_E2E_WORKER_ORIGIN` switches KV ops to a local worker's `/__test/kv` for e2e) and `admin/worker/` (hosted at `admin.jxnfilm.club` behind Cloudflare Access; binds all four KV namespaces + service bindings to both join Workers; Access-JWT gate fails closed). Member moderation (force-unlink Letterboxd) goes through the join Worker's `POST /admin/member/unlink` (ADMIN_TOKEN bearer), never raw KV writes. Excluded from the Nue build. See `admin/README.md`. |
| `scripts/refresh_letterboxd.py` | 6-hour cron RSS scraper (feeds `watched.json` + `attendance.json`) |
| `scripts/compile_voices.mjs` | Stitches a prompt round's APPROVED `/speak` voice clips (KV `voice:*` rows + R2 `jxnfilm-voice` objects) into one loudness-normalized segment WAV. Shared plumbing in `scripts/lib/voices.mjs` — incl. `pullClip` (idempotent: skips a byte-complete file, reuses `out/archive/<promptId>/` before hitting R2, downloads via `.part` rename), `ensureWritable` (no-clobber, `--force` only), `archivePathFor` (one definition, shared with the TUI). Clips auto-delete 60 days after submission — see `admin/README.md` §"Compiling a podcast segment". |
| `scripts/make_audiogram.mjs` | Renders branded audiogram MP4s (16:9/1:1/9:16) from any audio file or a prompt round (`--prompt`, per-clip + segment + `manifest.json`; `--member ID` narrows to specific approved clips — filtered *before* the R2 pulls, implies `--clips-only`). The frame headlines the **speaker credit** (display slot, or pinned above the waveform when `--with-prompt` supplies a prompt line) — attribution is the format's purpose, not a footer. **Output is append-only**: `ensureWritable()` refuses to land on existing MP4s (naming them, *before* any pull or encode) unless `--force`; nothing ever deletes from `out/`. `manifest.json` is the one exception and it *merges* (`mergeManifest`) — a derived index that accumulates formats/files/runs and drops nothing. **Pulled source audio is kept** at `out/archive/<promptId>/` by default (`--no-keep-audio` opts out), so re-rendering a round makes zero R2 requests; the 60-day promise binds the service (KV + R2), not an operator's local export. Frame = Playwright screenshot of `scripts/assets/audiogram.html` (links the real `css/tokens.css`; Homebrew ffmpeg has no `drawtext`); waveform + encode = ffmpeg. Pure helpers in `scripts/lib/audiogram.mjs` (brand hexes guarded against `tokens.css` by `tests/scripts/`). |
| `tui/` | Python + Textual TUI (`uv run jxnfilm-tui`) over the voice pipeline: browse `voice:*` rounds with per-clip days-until-deletion + which formats are already rendered, browse the KV keyspace read-only, and run the audiogram / compile / archive jobs with live streamed output — at either grain (one highlighted clip, or the whole round). Pure orchestration — it shells to `make_audiogram.mjs`, `compile_voices.mjs` and `wrangler` and reimplements none of them. **Read-only against KV and R2**; moderation stays in `admin/`. Excluded from the Nue build (`site.yaml` + `postbuild`). `tui/tests/test_settings.py` guards the constants it copies from JS (buckets, the 60-day TTL, the format list, the CLI flag names). See `tui/README.md`. |
| `.github/workflows/` | `add-member` + `update-member` (repo_dispatch, id-keyed); `refresh-letterboxd` (cron); `test` (reusable) + `deploy-site` + `deploy-worker` (gated on test) |
| `tests/model/` | Vitest model tests (node env) + `brand-sync.test.ts` + `dhtml-script-cap.test.ts` (guards every component `<script>` against Nue's ~10k silent-truncation cliff) |
| `tests/worker/` | Vitest + Workers pool — 19 endpoint/behavior suites: signup, otp, letterboxd (self-service + admin unlink), member-update, member-delete, members-events, members-reconcile, newsletter, scrub, screenings, attendance, watched, avatars, security, session-refresh, tmdb, pages, voice, feedback |
| `tests/admin-worker/` | Vitest + Workers pool for the admin Worker: Access-JWT gate, `/api/kv`, join-worker proxies (newsletter, member unlink, watched), routing fallthrough |
| `tests/admin/` | Plain-node Vitest for the admin SPA's pure helpers (`admin/lib.js`) |
| `tests/scripts/` | Plain-node Vitest for the scripts CLIs' pure helpers (`scripts/lib/audiogram.mjs`) incl. the ffmpeg-color ↔ `tokens.css` brand guard — no ffmpeg/Chromium needed |
| `tests/e2e/` | Playwright specs (`fixtures.ts` + site/signup/signin/letterboxd/member-delete/remember-me/screenings/revocation/rate-limit/admin/speak/account-stats) |
| `playwright.config.ts` | Boots nue (8083), wrangler dev (8787), and the admin server in E2E mode (5175) as three webServers |
| `site.yaml` | Nue config: `meta.title`, `import_map`, include/exclude for the SPA bundler |

## Architecture Notes

- **Three origins**: `jxnfilm.club` owns every UI view including code entry and sessions. `join.jxnfilm.club` hosts the top-level signup form and the API. After `POST /signup` the Worker redirects the browser to `jxnfilm.club/verify?email=...`, so session creation (`/signup/verify`) and `localStorage` live in one origin. `admin.jxnfilm.club` (the admin Worker) is a deliberate, isolated third origin: it's operator-only (Cloudflare Access One-time PIN + an in-Worker Access-JWT check), serves its own UI and API from the same origin (no CORS), and never sees a member bearer token — the invariant that member tokens don't cross origins still holds.
- **Data model**: members are keyed by a random `id` string, not by Letterboxd handle. The Worker's KV is the live source of truth for both members and events — the SPA fetches `GET /members` and `GET /events` on every page load, so new signups + admin edits appear immediately. `data/members.json` and `data/events.json` are cron-snapshotted archives (every 6h) that also serve as the bootstrap baseline for fresh KV namespaces and the SPA's fallback when the Worker is unreachable.
- **KV schema**:
  - `pending:{email}` — `{ name, handle?, code }`, 10min TTL. Written on `/signup`, consumed by `/signup/verify`.
  - `member:{email}` — `{ id, email, name, pronouns, handle, joined }`. Canonical per-member row (holds the email, which never leaves KV).
  - `members:all` — array of public projections `[{ id, name, joined, pronouns?, handle? }]` served verbatim by `GET /members`. Every mutating handler (`/signup/verify`, `/member/update`, `/letterboxd/unlink`, `/admin/member/unlink`, `/member/delete`) writes it via `reconcileMembersAll`: union of the current aggregate and all canonical `member:` rows (canonical wins) plus the caller's own just-written row — never a bare read-modify-write, which lost a concurrent signup to a clobber race on 2026-08-05. The daily cron and `POST /admin/scrub` run a bare reconcile, so any race-dropped row self-heals within a day. Aggregate rows without a canonical KV row (baseline members, e2e seeds) are preserved. Bootstrapped from `data/members.json` on cold KV via `bootstrapMembers` (mirrors `bootstrapAttendance`).
  - `members:bootstrapped` — `'1'` marker; presence means the JSON→KV seed has run.
  - `session:{id}` — full member snapshot keyed by member id, 1h TTL (matches JWT exp). Write-through overlay refreshed on `/signup/verify`, `/otp/verify`, `/member/update`, `/letterboxd/unlink`. `/member/me` reads this first and falls back to `member:{email}` on miss, reseeding — same baseline-on-miss pattern as `readAttendees`. `/session/revoke` deletes this so a stale snapshot can't be replayed before revocation propagates.
  - `email:{handle}` / `handle:{email}` — bidirectional handle ↔ email link. Written on `/signup/verify` (when the signup payload carried a handle) and on `/member/update` whenever a member sets or changes their handle. The reverse index enforces handle uniqueness across the directory.
  - `otp:{email}` — 6-digit login code for returning members, 10min TTL.
  - `rate:otp_send:{email}` / `rate:signup_send:{email}` — single-cell throttle, 60s TTL. Bounds email-spam abuse from `/otp/request` and `/signup`. (S1)
  - `rate:otp_verify_fail:{email}` / `rate:signup_verify_fail:{email}` — integer counter, OTP-window TTL. Increments on wrong codes; >=5 returns 429 from `/otp/verify` and `/signup/verify`. Cleared on success. (S1)
  - `revoked:{jti}` — `'1'` marker, TTL = remaining JWT lifetime. Written by `/session/revoke`; consulted by every authenticated request. Tokens issued before S2 lack a jti and can't be revoked server-side, but they still expire on schedule. (S2)
  - `watched:cache` — `{ map, fetchedAt, missAt? }`: handle-keyed recent diary entries (up to 12/member, `WATCHED_FEED_DEPTH`) from Letterboxd RSS; `/watched` sections and host quick-picks slice to 4, the weekly strip clusters over the full depth. **Stale-while-error**: no KV expiration — freshness (900s) is checked in code, a rebuild carries the last good entry forward for any feed it fails to refetch, and a TOTAL miss stamps `missAt` (120s retry backoff) without discarding data, so the Watched page survives arbitrarily long Letterboxd outages. Rebuilds filter to current membership handles; the unlink cascade surgically evicts just the unlinked handle (`evictHandleFromCaches`) so that member stops serving immediately without blanking everyone else's last-good data.
  - `avatars:cache` — `{ sig, map, fetchedAt, missAt? }`: handle-keyed Letterboxd avatar URLs scraped from the `/{handle}/films/` subpage header (`parseProfileAvatar`; the profile ROOT page is behind Letterboxd's Cloudflare bot challenge since ~Aug 2026, and the subpage og:image is a generic share card). Size segment rewritten to 80px. **Stale-while-error**, same scheme as `watched:cache`: no KV expiration, 7-day freshness window checked in code, per-handle carry-forward on failed fetches, 1h `missAt` backoff on a TOTAL miss — the last good map persists through any outage. `sig` (sorted linked-handle list) still forces a rebuild the moment a handle links/unlinks, and the unlink cascade surgically evicts the handle. Members without a custom upload (`/static/img/` defaults) never match the parser, so they keep the letter avatar.
  - `feedback:{ts}:{rand8}` — `{ at, category, message, page?, member?, expiresAt }`, 90-day TTL. Beta feedback from `POST /feedback` (widget + `/feedback` page). `member` is `null` for anonymous/opted-out submissions; otherwise `{ id, email, name }` resolved server-side from the bearer token. `expiresAt` mirrors the key's absolute expiry into the value so `stripFeedbackIdentity` (the `/member/delete` cascade) can rewrite the record with `{ expiration }` instead of clearing its TTL. Triaged (and deleted = handled) from the admin portal's Feedback tab; see `docs/features/feedback.md` for the export runbook.
  - `rate:feedback:{ip}` — single-cell throttle, 60s TTL, keyed on `CF-Connecting-IP`. The only IP-keyed limiter (anonymous feedback has no email to key on).
  - `refresh:{id}:{secret}` — `{ email }`, 30-day sliding TTL. "Remember my login on this device": written by `/otp/verify` + `/signup/verify` when the request carries `remember: true` (client credential is `{id}.{secret}`, secret = 32-char alnum). `POST /session/refresh` trades a live record for a fresh 1h bearer token and re-puts the record with a full 30-day TTL (no rotation — rotation would let one tab invalidate another's stored token). Presence in KV is the sole validity check, so deletion revokes instantly: `/session/revoke` deletes the record passed in its body, `/member/delete` prefix-purges `refresh:{id}:` (every remembered device dies with the account), and a refresh for a deleted member 401s + self-cleans.
- **Routing (SPA)**: `state.setup({ route: '/:type', query: ['query', 'sort', 'email'], autolink: true })`. `state.on('type', ...)` dispatches to `members-view` (default), `events-view`, `sign-in-view`, `verify-view`, or `edit-view`.
- **Conditional nav**: `index.html`'s root component derives `signedIn` from `localStorage.jxnfc_session`. Nav renders Join + Log in when signed out, Account Actions (links to `/edit`) when signed in. Refreshed on every route change.
- **Session**: `localStorage.jxnfc_session = { token, email, id, handle?, exp }`. The `token` is `base64url(JSON(claims)).HMAC-SHA256`, signed with `OTP_SIGNING_KEY`. Claims include `email`, `id`, `exp`, and a random `jti` (S2 — addressable for server-side revocation). The Worker mirrors an authoritative snapshot at `session:{id}` (see KV schema) so `/member/me` reads are fast and reflect the latest mutation immediately. `POST /session/revoke` writes `revoked:{jti}` so the bearer token (and its session snapshot) can't be replayed for the remaining lifetime; the edit-view "Sign out" button calls this before clearing `localStorage`.
- **Remember my login (device refresh tokens)**: opting in at sign-in/signup adds `refresh` to `jxnfc_session` (see `refresh:{id}:{secret}` in the KV schema). `ui/auth.html`'s module script owns the logic — `ensureSession()` returns the stored session if its token is live, silently POSTs `/session/refresh` when only the device token remains, and clears the session when the server rejects it (network failures keep it). It's exported as `globalThis.jxnfcEnsureSession` so `ui/views.html` (events RSVP gate, host form) shares it without cross-lib imports; `index.html`'s `isSignedIn()` counts a stored `refresh` as signed-in optimistically. Sign-out passes `refresh` in the `/session/revoke` body so the device token dies with the session. The privacy policy's retention section names the 30-day opt-in — keep them in sync.
- **OTP in-flight**: `localStorage.jxnfc_otp_inflight = { email, sentAt }` — written by `sign-in-view` after `/otp/request`, expires client-side after 10 minutes, lets returning users resume the code-entry step without re-typing their email.
- **Privacy-update toast**: `localStorage.jxnfc_privacy_ack = 'YYYY-MM-DD'` — the policy revision date this browser has seen. `index.html`'s module script fetches `GET /privacy/version` (the join Worker parses the date out of `privacy.html`, so there is exactly one date to bump) and shows a one-time toast when the stored ack is older; the ack is re-stamped at fetch time, so the toast fires once per revision even if never dismissed. First visit stores silently — no toast for someone with no earlier policy to compare. The policy's localStorage enumeration names this key; keep them in sync.
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
- **A component `<script>` over 10,000 characters gets silently truncated in the compiled bundle.** The serializer runs component scripts through `util.inspect`, whose default `maxStringLength` is 10k — the bundle ends with `... N more characters` mid-function and every view in the lib file dies with `SyntaxError`. Confirmed 2026-08-09 when `event-card` hit 12.4k chars. Split big components into child components (each script is serialized separately — this is why `host-guests` is its own component instead of living in `event-card`); `node --check` on the built bundle catches it.
- **Multi-line `{ ... }` interpolations in templates emit literal `\n` into the compiled JS** (the `fn:` compile path doesn't unescape newlines the way the `script:` path does) — the whole lib file fails to parse. Keep every `{ expression }` on one line, however long.
- **After editing a dhtml lib file, syntax-check the compiled bundle** — the build "succeeds" even when the output doesn't parse: `curl -s http://localhost:4000/ui/views.html.js -o /tmp/v.mjs && node --check /tmp/v.mjs` (or the equivalent file under `.dist/` after `nue build`).
- **An `:onclick` inside a nested `:each` (a loop within a loop) never fires.** Confirmed on `/watched`'s strip (watcher buttons inside `:each="c in strip"` → `:each="w in c.watchers"`): the handler silently never binds. Bind by delegation instead — one `document.addEventListener` in `mounted` behind a module-scope once-guard, matching on a page-unique class (see `watched-view`). Don't bind to `this.root`: **nuedom replaces the component's root element on `update()`**, orphaning any root-bound listener.
- **Clearing the last query param rewrites the URL path.** nuestate's `pushURLState` does `replaceState(search || './')`; with an empty query that `./` resolves `/watched` → `/`. If a control can empty the whole query (e.g. toggling off the last filter), repair with `history.replaceState(true, 0, '/<route>')` right after the state write (see `toggleFilter` in `watched-view`).
- **`scrollIntoView({ behavior: 'smooth' })` silently no-ops on the SPA** (Chrome, verified on `/watched`); the instant form always works. Use `el.scrollIntoView()`.
- **`autolink: true` intercepts every anchor click, including cross-origin ones and `target="_blank"`.** `index.html` installs a capture-phase `document` click listener that calls `stopImmediatePropagation()` for cross-origin or `target="_blank"` anchors before autolink's bubble-phase listener sees them, so the browser handles those clicks natively. No per-component `:onclick` workaround is needed. If you add a new external anchor, it just works — as long as `href` is absolute (cross-origin) or `target="_blank"` is set. Don't try to remove this capture listener.

## Testing

### Unit + Workers (Vitest)
Four workspace projects: `tests/model/` (node), `tests/worker/` + `tests/admin-worker/` (`@cloudflare/vitest-pool-workers` — `SELF.fetch` / `worker.fetch`, direct KV binding access), and `tests/admin/` (node, for `admin/lib.js`). Patterns in `tests/worker/signup.test.js` and `letterboxd.test.js` are the template for new endpoint tests; the proxy tests in `tests/admin-worker/admin-worker.test.js` are the template for new admin-worker routes.

### E2E (Playwright)
`tests/e2e/` — SPA/member specs plus `admin.spec.ts` (the admin dashboard against the local admin server). `playwright.config.ts` boots three webServers:

| Port | Service | Notes |
|------|---------|-------|
| 8083 | `nue serve` | Static site |
| 8787 | `wrangler dev` | Worker with `E2E_MODE=true` + `OTP_SIGNING_KEY=e2e-test-signing-key` + `ADMIN_TOKEN=e2e-admin-token` + `SITE_ORIGIN=http://localhost:8083` |
| 5175 | `node admin/server.mjs` | Admin dashboard with `ADMIN_E2E_WORKER_ORIGIN=http://localhost:8787` — KV ops go through the join worker's `/__test/kv` shim (shared simulated KV) instead of `wrangler kv --remote`, and the newsletter/unlink/watched proxies target the local worker. The hosted admin Worker (Access JWT, service bindings) is not e2e-testable — it stays covered by `tests/admin-worker/`. |

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
- **Don't hand-edit `.dist/`** — build output.
