# jxnfilmclub

Public membership directory for the Jackson Film Club. Each member lists their
Letterboxd profile; the site surfaces their last-four-watched films and event
attendance (Letterboxd diary entries tagged `jxnfilmclub`).

> **Status: scaffolded, not yet functional.** The app is currently the stock
> Nue.js `simple-admin` template populated with ~7k fake members and
> "customers". None of the film-club features below are implemented yet. See
> the [roadmap](#roadmap) for the completion plan.

## Stack

- [Nue.js](https://nuejs.org) — component-driven SSG (`.nue` single-file components)
- TypeScript model layer (`model/`)
- Vanilla CSS (`style/`)
- Deploys to GitHub Pages

## Develop

No `package.json` — install the Nue CLI globally, then:

```bash
nue           # dev server
nue build     # compile to .dist/nuejs/
```

## Architecture (current)

- `view/index.nue` — layout + client-side router (simple-admin controller)
- `view/people.nue` — list view: search, sort, paginate
- `view/avatar.nue`, `view/timeago.nue` — leaf components
- `model/index.ts` — `fetchPeople` / `getPeople`; loads `model/mocks/*.json` +
  lazy-loads `*-tail.csv` into `sessionStorage`
- `site.yaml` — defines the `members` and `customers` views + sort columns
- `nuejs.yaml` — `base: /@simple-admin`, `dist: .dist/nuejs`, `inline_css: true`

## Roadmap

MVP is three features plus a Cloudflare-Worker-backed signup flow. Target
deploy is GitHub Pages; data refresh runs on GitHub Actions.

### 1. Signup pipeline (`join.jxnfilm.club`)

The signup app is a Cloudflare Worker living in `/worker` in this repo.
The Worker serves:

- `GET /` — signup form (Letterboxd handle + email).
- `POST /signup` — verifies the Letterboxd profile exists, then dispatches
  a `repo_dispatch` event to this repo's GitHub Actions.
- `POST /otp/request`, `POST /otp/verify` — email-OTP login (see §4).
- `GET /privacy` — serves `worker/privacy.html`.

The GitHub Action triggered by `repo_dispatch` appends the new member to
`data/members.json` and commits to `main`.

### 2. Last Four Watched

- Replace `model/mocks/members.json` with a real `data/members.json`.
- Add a GitHub Actions cron (every 6 hours, matching `letterboxd-viewer`) that
  walks each member's Letterboxd RSS, extracts the four most recent diary
  entries, and writes `data/watched.json`.
- Render a poster row per member in `view/people.nue`.

### 3. Events + attendance (replaces Customers view)

- Rename the `customers` view in `site.yaml` to `events`.
- Add `data/events.json` — manually curated (film, date, venue, poster).
- The same 6-hour cron scans each member's RSS for diary entries tagged
  `jxnfilmclub`, matches them to known events by film + date, and writes
  `data/attendance.json` (event → member list).
- New `view/events.nue` renders events with attending-member avatars.

### 4. Email/OTP auth (edit-your-own-entry)

GitHub Pages is static, so auth needs a Worker backend.

1. Member clicks "Edit my entry" → prompts for email → Worker emails a
   one-time code via **Resend** (free tier: 3k emails/month).
2. Member enters code → Worker returns a short-lived signed token.
3. Authenticated requests to the Worker update `data/members.json` via the
   same GitHub Actions `repo_dispatch` pattern.
4. Client stores the token in `sessionStorage` until expiry.

Resend setup is documented in [SETUP.md](SETUP.md#5-sign-up-at-resend--verify-domain).

### 5. Cleanup

- Remove `model/mocks/` once real data exists.
- Drop `customers-tail.csv`, `members-tail.csv` and the `setupMocks` /
  `PLANS` / `CARDS` mock logic in `model/index.ts`.
- `git init` and push to GitHub (the repo is not yet under version control).

## Privacy

Member emails are stored only in Cloudflare Workers KV (Worker-side). The
public `data/members.json` never contains email addresses. Full policy is
served at `join.jxnfilm.club/privacy` (source: `worker/src/privacy.html`).

## Deploy

One-time setup (DNS, Cloudflare token, GitHub PAT, KV namespaces, DKIM) is
documented in [SETUP.md](SETUP.md). After that, `git push origin main`
triggers the site + worker deploys via GitHub Actions.
