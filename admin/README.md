# Admin dashboard

A browser-based admin panel for the jxnfilmclub Worker's remote KV. One SPA
(`index.html` + `admin.js` + `style.css`), two ways to serve it:

- **Hosted (primary)** — `https://admin.jxnfilm.club`, served by the Worker
  in `admin/worker/` with direct KV bindings. Deployed by
  `.github/workflows/deploy-admin.yml`; the Nue site build still excludes
  `admin/` (see `site.yaml`).
- **Local (fallback)** — `npm run admin` serves it from `127.0.0.1` via
  `server.mjs`, which shells to `wrangler kv …` for every operation.

`admin.js` detects which mode it's in from the hostname (`HOSTED`).

## Trust model

**Hosted**: two independent gates. Cloudflare Access (One-time PIN against
an email allowlist, 1-week sessions) fronts the hostname at the edge, and
the Worker separately verifies the `Cf-Access-Jwt-Assertion` JWT (RS256
against the team JWKS, aud + issuer + expiry) before serving anything —
including the static files. No valid JWT → 403, so a misconfigured Access
app fails closed rather than open. There is no workers.dev URL.

**Local**: no auth in the server process. It binds to `127.0.0.1` only and
shells to `wrangler kv …`. Whoever can run `wrangler` on your machine
(against your Cloudflare account) can use the dashboard. Whoever can't,
can't. That's the gate. If it returns "wrangler … exited 1 / not
authenticated", run `npx wrangler login` in `worker/` first.

## Run

Hosted: open `https://admin.jxnfilm.club`, request a PIN for an allowlisted
email.

Local:

```bash
npm run admin                       # http://localhost:5174
ADMIN_PORT=4000 npm run admin       # custom port
```

The env toggle in the header picks between `production` (default — red
topbar) and `staging` for the next KV call. The switch also re-loads the
current tab so you don't accidentally act on the wrong namespace.

The active tab is remembered per browser (`localStorage.jxnfc_admin_tab`),
so a refresh reopens where you left off; unknown stored names fall back to
Members.

### Sending newsletters

Recipient toggles are plain KV writes. **Sending** goes through the join
Worker's `/admin/newsletter/send`, which requires the bearer `ADMIN_TOKEN`.
The browser never holds it in either mode:

- **Hosted**: the admin Worker proxies the send over service bindings
  (`JOIN_WORKER` / `JOIN_WORKER_STAGING`) using its `ADMIN_TOKEN` /
  `ADMIN_TOKEN_STAGING` secrets. Nothing to export.
- **Local**: `server.mjs` proxies the send and reads the token from its own
  environment. Export it before `npm run admin`, matching the join Worker
  secret(s) you set with `wrangler secret put ADMIN_TOKEN`:

```bash
export ADMIN_TOKEN=<prod value>
export ADMIN_TOKEN_STAGING=<staging value>   # only if you send from the staging env
npm run admin
```

If the token for the selected env isn't set, the Send buttons return a clear
error instead of failing silently. Always "Send test" to yourself first.

The compose box prefills a branded, email-safe HTML template (the Worker
appends the unsubscribe/postal footer — don't add one). The preview pane is
**editable**: type directly into it or use the formatting toolbar (bold,
italic, headings, list, link), and edits sync back into the HTML textarea,
which remains what actually gets sent. Scripts never execute in the preview
(`sandbox` without `allow-scripts`).

## Tabs

| Tab | What it shows | Write ops |
|-----|---------------|-----------|
| **Members** | All `member:{email}` rows | clear rate limits, force-unlink Letterboxd (proxies the join Worker's `POST /admin/member/unlink` — full cascade incl. `members:all` + `update-member` dispatch; shows as "repair LB" when only the aggregate still carries a handle), evict session snapshot |
| **Newsletter** | Compose/send a newsletter, opted-in recipients (with per-member opt-in/out toggles), and send history (`newsletter:sent:{ts}`) | toggle a member's `newsletter` flag (evicts their session), insert an "Upcoming events" section (all events with `date` >= Central today from `event:` KV rows, soonest first; the formatter whitelists public-projection fields only — a house host's private address/notes never reach the newsletter), insert a "Latest from members on Letterboxd" section (live diary entries via `GET /api/watched`, count configurable, appended to both HTML and text bodies), insert a linked TMDB poster (search via `GET /api/tmdb/search`, pick a thumbnail, optional link URL wraps the poster; a caption line lands in the plain-text body), send a test to one address, send to all opted-in members |
| **Pending** | `pending:{email}` signups with their OTP code | delete (use for stuck signups) |
| **Sessions** | `session:{id}` cached snapshots + `refresh:{id}:{secret}` remembered devices | evict snapshot (does NOT revoke the JWT — use the Worker's `/session/revoke` for that); revoke a remembered device (deletes the 30-day refresh record, forcing that browser back through the email-code flow) |
| **Revoked** | `revoked:{jti}` tombstones | read-only (auto-expire) |
| **Rate limits** | All `rate:*` counters; lockouts (≥5) are highlighted | delete a counter to unblock a user |
| **Events** | `event:{id}` rows + `events:all` aggregate from `ATTENDANCE_KV`, live attendance from `attend:{id}`; sortable (upcoming first / newest / oldest / title / most attended) | add / edit / delete events (writes KV directly; `GET /events` surfaces the change immediately on the public site), remove attendees |
| **Config** | Purpose-built editors for the operator overrides under `config:*` in `MEMBERS_KV` (see [Config tab](#config-tab)) | save/delete `config:theaters`, `config:podcast`, `config:newsletter_template`, `config:copy` |
| **Content Gen** | Social media content built from live KV data: per-platform copy (Instagram / Facebook / Discord / Bluesky / X, with character counters against each platform's limit) and canvas-rendered PNG cards (IG post/story, FB, Bluesky/X sizes) in the Night Shift brand. Post types: event announcement + countdown (dynamic tonight/tomorrow/N-days lead from the event date), post-event recap (`attend:{id}` count), season lineup (next ≤4 upcoming events, poster wall + date list), monthly wrap (screenings + summed attendance for a selected past month), new podcast episode (typographic card; episodes fetched from `jxnfilm.club/data/episodes.json`, which GitHub Pages serves with `ACAO:*`), milestone (big-numeral card: member count from `members:all`, screenings held, or total attendance), member-watches roundup (`GET /api/watched` poster collage, windowed to the last 7 days — undated entries dropped). Public-safe by construction: events pass through `socialEventView` (no address/notes/capacity) and watches through `buildRoundupData` (film titles/posters only — zero member names or handles). Poster images load via the same-origin `GET /api/img` proxy (https-only host allowlist) so the canvas stays untainted and PNG export works. | read-only against KV — output is copy-to-clipboard text + downloaded PNGs |

## Config tab

Edits the operator config the join Worker and public SPA read from
`MEMBERS_KV` under `config:*`. The governing mental model, surfaced in every
section: **a missing key means "use the hardcoded defaults"**. Saving a
section creates/overwrites the override; each section's "reset to defaults"
deletes the key (after a confirm), and the site/Worker fall back
automatically — there is no "empty override" state to get stuck in. Every
section badges its current source: `KV override` when the key exists,
`defaults — no KV key` otherwise.

Like every other tab, all reads and writes follow the env toggle
(production/staging); the tab header names the env being edited.

| Section | Key | Edits |
|---------|-----|-------|
| **Theaters** | `config:theaters` | The venue allowlist/dropdown for theater meetups, as a JSON array of names — row order is dropdown order. Per-row edit, add, remove, move up/down. When no override exists the editor prefills the hardcoded list (mirrored from `worker/src/index.js` / `ui/views.html`) as the starting point. Saving an all-empty list is refused — use reset instead. |
| **Podcast** | `config:podcast` | Episode list + featured episode, same shape as `data/episodes.json` (`{ featured_id, episodes: [{ title, date, url }] }`). No override yet → prefilled from the live site's `data/episodes.json`. Unknown fields (top-level and per-episode) survive a save untouched. `featured_id` is the **Spotify episode ID** driving the homepage embed — it is *not* derivable from the Anchor episode URLs, so the ID is a text input; the per-episode "featured" radio uses an episode's stored `id` field, prompting once for the Spotify ID if the row doesn't have one yet (it is then kept on the episode). |
| **Newsletter template** | `config:newsletter_template` | `{ subject, html }` — what the Newsletter compose tab prefills instead of its built-in branded template. Saving with both fields empty deletes the key (same as reset). |
| **Homepage copy** | `config:copy` | Per-field overrides for the homepage prose (hero headline/lede/label, join kicker/heading/body, podcast lede, section headings). Each input's **placeholder shows the current site default** — what an override replaces. Only non-empty fields are stored; leave a field empty to keep its default. Saving with every field empty deletes the key. |

Related consumers inside the dashboard itself: the Newsletter compose tab
prefills subject/body from `config:newsletter_template` when it exists, and
Content Gen's episode picker prefers `config:podcast` over the site's
`data/episodes.json`.

## What it does NOT do

- Doesn't dispatch the `add-member` GitHub workflow or patch `data/*.json`
  itself. The one exception is indirect: "unlink LB" proxies the join
  Worker's cascade, which dispatches `update-member` (committing
  `handle: null` to `data/members.json` on main) — `git pull` afterward if
  you're working from a local checkout. Everything else reconciles via the
  6h snapshot crons.
- Doesn't write to `attendance:all` aggregate independently of `attend:{id}`;
  the "remove attendee" action does keep them consistent, but raw KV writes
  via wrangler don't.
- Doesn't compose transactional/OTP email (Resend handles those) or revoke
  individual JWTs (no jti index). The Newsletter tab is the one email surface
  it does drive, and only via the token-guarded Worker endpoint.

## Why both a hosted portal and a local dashboard?

The dashboard started local-only — wrangler as the gate meant no dashboard
auth to build, no secrets in CI, no extra CORS origins. The tradeoff was
that it didn't work away from the laptop, so the hosted portal now fronts
the same SPA with Cloudflare Access supplying the auth (One-time PIN
allowlist) and a JWT check in the Worker backing it up. Auth still isn't
hand-rolled, tokens still never reach the browser (sends proxy through
service bindings), and CORS never entered the picture — the admin origin
serves both UI and API. The local dashboard stays as the fallback and as
the only surface that can patch `data/members.json` directly.
