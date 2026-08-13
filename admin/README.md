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

The Voice tab's approve/reject/delete actions proxy the join Worker the same
way and read the same `ADMIN_TOKEN` / `ADMIN_TOKEN_STAGING` variables in
local mode — without one they return a 501 pointing at the hosted portal,
where the secrets are already set.

The compose box prefills a branded, email-safe HTML template (the Worker
appends the unsubscribe footer — plus a postal line only if
`NEWSLETTER_POSTAL_ADDRESS` is configured — so don't add one). The preview pane is
**editable**: type directly into it or use the formatting toolbar (bold,
italic, headings, list, link), and edits sync back into the HTML textarea,
which remains what actually gets sent. Scripts never execute in the preview
(`sandbox` without `allow-scripts`).

## Tabs

| Tab | What it shows | Write ops |
|-----|---------------|-----------|
| **Members** | All `member:{email}` rows | clear rate limits, force-unlink Letterboxd (proxies the join Worker's `POST /admin/member/unlink` — full cascade incl. `members:all` + `update-member` dispatch; shows as "repair LB" when only the aggregate still carries a handle), evict session snapshot |
| **Newsletter** | Compose/send a newsletter, opted-in recipients (with per-member opt-in/out toggles), and send history (`newsletter:sent:{ts}`) | toggle a member's `newsletter` flag (evicts their session), insert an "Upcoming events" section (all events with `date` >= Central today from `event:` KV rows, soonest first; the formatter whitelists public-projection fields only — a house host's private address/notes never reach the newsletter), insert a "Latest from members on Letterboxd" section (live diary entries via `GET /api/watched`, count configurable, appended to both HTML and text bodies), insert a linked TMDB poster (search via `GET /api/tmdb/search`, pick a thumbnail, optional link URL wraps the poster; the block assumes a review or announcement follows — centered poster, then a left-aligned headline + bracketed placeholder body to overwrite in the preview; sending is blocked while the placeholder text remains), send a test to one address, send to all opted-in members |
| **Auth** | The auth lifecycle in one view, four sections: `pending:{email}` signups with their OTP code; `session:{id}` cached snapshots + `refresh:{id}:{secret}` remembered devices; `revoked:{jti}` tombstones (read-only, auto-expire); all `rate:*` counters with lockouts (≥5) highlighted | delete a stuck pending signup; evict a snapshot (does NOT revoke the JWT — use the Worker's `/session/revoke` for that); revoke a remembered device (deletes the 30-day refresh record, forcing that browser back through the email-code flow); delete a rate counter to unblock a user |
| **Events** | `event:{id}` rows + `events:all` aggregate from `ATTENDANCE_KV`, live attendance from `attend:{id}`; sortable (upcoming first / newest / oldest / title / most attended) | add / edit / delete events (writes KV directly; `GET /events` surfaces the change immediately on the public site), remove attendees |
| **Voice** | Member-submitted podcast voice clips (≤3 min): `voice:{promptId}:{memberId}` metadata rows from `MEMBERS_KV`, grouped by prompt (current prompt first), with an inline audio player + download streaming the R2 object through `GET /api/voice` (buckets `jxnfilm-voice` / `-staging`). Each clip shows submitter, submitted-at, duration, size, status pill, and a **prominent days-remaining countdown** from the row's `expiresAt` — everything auto-deletes 60 days after submission (see [the 60-day reality](#compiling-a-podcast-segment)). A clip whose audio has already aged out renders an inline "audio gone" note instead of a broken player (`/api/voice` 404s with `{ error: "expired" }` — an expected state, since the R2 lifecycle deletes on a daily cadence while the KV TTL is exact). | approve / reject / delete — all proxied through the join Worker's `/admin/voice*` routes (never raw KV writes: a `/api/kv` PUT would rewrite the row without its TTL and make it persistent) |
| **Config** | Purpose-built editors for the operator overrides under `config:*` in `MEMBERS_KV` (see [Config tab](#config-tab)) | save/delete `config:theaters`, `config:podcast`, `config:newsletter_template`, `config:copy`, `config:voice_prompt` |
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
| **Voice prompt** | `config:voice_prompt` | `{ id, text, deadline? }` — the question members answer when recording a podcast voice clip. The id is a slug that keys the submissions (`voice:{id}:…`), so changing it starts a fresh collection; the optional deadline (YYYY-MM-DD) is display-only. Reset deletes the key and the site falls back to the generic default prompt (id `general`, "Tell us what you're watching"). |

Related consumers inside the dashboard itself: the Newsletter compose tab
prefills subject/body from `config:newsletter_template` when it exists, and
Content Gen's episode picker prefers `config:podcast` over the site's
`data/episodes.json`.

## Compiling a podcast segment

Approved voice clips are stitched into one broadcast-ready file locally:

```bash
node scripts/compile_voices.mjs <promptId> [--env production|staging] [--out DIR]
```

The script (node + wrangler + ffmpeg, no other deps) lists the
`voice:{promptId}:*` rows from remote `MEMBERS_KV`, keeps only
`status: "approved"` in submission order, pulls each clip from R2, runs a
two-pass EBU R128 loudness normalization (`I=-16:TP=-1.5:LRA=11`) with a hard
3-minute cap per clip, and concatenates them with 0.5 s gaps into
`out/<promptId>-segment.wav` (48 kHz mono), printing a manifest of who's in
the segment and in what order. If ffmpeg is missing it says so up front
(`brew install ffmpeg`).

### Branded audiogram videos

Any clip — or a whole prompt round — can also be rendered as a branded
audiogram MP4 (animated waveform + Night Shift branding + member credit), so
audio can travel with the club's visual identity into a video-podcast edit or
an IG/story promo:

```bash
# one audio file → out/audiogram/<name>-<format>.mp4
node scripts/make_audiogram.mjs <audio-file> [--format 16x9|1x1|9x16|all] \
    [--title T] [--name N] [--out DIR]

# a prompt round → out/audiogram/<promptId>/{<memberId>-<fmt>.mp4,
#                  segment-<fmt>.mp4, manifest.json}
node scripts/make_audiogram.mjs --prompt <promptId> [--env production|staging] \
    [--format ...] [--with-prompt] [--segment-only|--clips-only] [--out DIR]
```

Formats: `16x9` (1920×1080, video-podcast import), `1x1` (1080×1080 feed),
`9x16` (1080×1920 story/reel); default `16x9`. The frame is the club wordmark
plus the speaker's name; `--with-prompt` (prompt mode) or `--title` (file
mode) additionally displays the prompt being answered. Prompt mode reuses the
compile pipeline (approved-only, submission order, same loudnorm), renders one
video per member clip credited with the member's name, plus a compiled segment
video, and writes a `manifest.json`. A clip whose R2 object already aged out
is **skipped with a warning**, not fatal.

The branded frame is screenshotted by headless Chromium (the repo's existing
Playwright — run `npx playwright install chromium` if the browser binaries
are missing) from `scripts/assets/audiogram.html`, which links the real
`css/tokens.css` + self-hosted fonts; Homebrew's ffmpeg has no `drawtext`
(the formula dropped freetype), so the browser renders all type and ffmpeg
only draws the waveform and encodes (H.264/AAC, faststart).

**The 60-day reality**: both voice buckets carry a bucket-wide lifecycle rule
that deletes objects 60 days after upload, and the KV rows carry a matching
TTL. That includes **approved** clips — approval is a moderation state, not a
retention extension. If production slips, an approved clip an operator meant
to use silently vanishes at day 60. The Voice tab surfaces a per-clip
days-remaining countdown for exactly this reason: **run the compile script
(or download the clips) well before the countdown runs out.** The R2 sweep is
a daily cadence while the KV TTL is exact, so a metadata row can briefly
outlive its audio (the tab shows "audio gone" for those) and vice versa.

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
