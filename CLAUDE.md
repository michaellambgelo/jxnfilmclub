# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**jxnfilmclub** is a membership list app for the Jackson Film Club. Members list their Letterboxd profile; the site surfaces last-four-watched films and event attendance (Letterboxd diary entries tagged `jxnfilmclub`). Signup and OTP auth live in a separate Cloudflare Worker at `join.jxnfilm.club` (source in `worker/`).

## Tech Stack

- **Framework**: [Nue](https://nuejs.org) SPA — `<!doctype dhtml>` HTML components + built-in `state` module. Based on the `spa` template from `nuejs/nue`.
- **Model layer**: TypeScript (`model/index.ts`)
- **Styling**: Vanilla CSS (`style/`)
- **Signup/auth backend**: Cloudflare Worker (`worker/`), deploys to `join.jxnfilm.club`
- **Tests**: Vitest + `@cloudflare/vitest-pool-workers`

## Commands

```bash
# Site (port 8083 by default)
nue              # dev server with HMR
nue build        # static build to .dist/dev/ (or .dist/prod/ with --prod)

# Worker (runs in parallel during dev)
cd worker && npx wrangler dev     # local worker at :8787
cd worker && npx wrangler deploy  # ship to Cloudflare

# Tests
npm test         # runs model + worker Vitest suites
```

Day-to-day dev runs two terminals: `nue` + `cd worker && npx wrangler dev`.

## Layout

| Path | Contents |
|------|----------|
| `index.html` | SPA entry — `<!doctype dhtml>`, sets up `state` router, mounts view components |
| `ui/views.html` | `members-view` + `events-view` components (`<!doctype dhtml lib>`) |
| `ui/widgets.html` | `avatar` + `timeago` components |
| `model/index.ts` | `getMembers` / `getEvents` — read from `data/*.json`, paginate, sort, search |
| `data/` | Source-of-truth JSON: `members.json`, `events.json`, and (cron-generated) `watched.json`, `attendance.json` |
| `worker/` | Cloudflare Worker at `join.jxnfilm.club` — signup form, OTP, privacy, GitHub dispatch |
| `worker/src/` | `index.js`, `signup.html`, `privacy.html` (HTML imported via `rules = [{ type = "Text", globs = ["**/*.html"] }]`) |
| `scripts/refresh_letterboxd.py` | Cron-driven RSS scraper (feeds `watched.json` + `attendance.json`) |
| `.github/workflows/` | `add-member`, `update-member` (repo_dispatch) + `refresh-letterboxd` (6h cron) |
| `tests/model/` | Vitest suite for model data-layer |
| `tests/worker/` | Vitest + Workers pool suite for Worker endpoints |
| `style/` | Global CSS (legacy, simple-admin era) — may need reconciling against the new SPA layout |
| `img/` | SVG assets |
| `site.yaml` | Nue config: `meta.title`, `import_map` (exposes `model/index.ts` as `app`) |

## Architecture Notes

- **Routing**: `state.setup({ route: '/:type', query: ['query', 'sort'], autolink: true })` in `index.html`. `state.on('type', ...)` dispatches to `members-view` (default) or `events-view`. Search and sort are URL-bound query params, not component state.
- **Data flow**: components import `{ getMembers, getEvents } from 'app'` (bare import via `import_map`). Each view component reloads its data on `state.on('query sort', ...)`.
- **Data source**: flat JSON in `data/`. `members.json` and `events.json` are hand-edited or written by GH Actions via `repo_dispatch`. `watched.json` / `attendance.json` are regenerated every 6 hours.
- **Signup/auth loop**: the Worker at `worker/` receives `POST /signup`, verifies the Letterboxd profile, stores email in Workers KV (private — never in public JSON), and dispatches the `add-member` GH Action. OTP login via MailChannels issues an HMAC-signed token that authorizes `/member/update`, which dispatches the `update-member` workflow.
- **Avatars**: deterministic background color derived from the first letter of the name (`ui/widgets.html` → `avatar`).

## Gotchas

- **Not a git repository yet** — run `git init` + push to GitHub before any Action workflow can fire.
- **Worker secrets are TODO** — `worker/wrangler.toml` has placeholder `GITHUB_OWNER` and a `TODO_CREATE_VIA_WRANGLER` KV namespace id. See `worker/README.md` for one-time setup.
- **RSS scraper is a scaffold** — `scripts/refresh_letterboxd.py` walks the members list but the Letterboxd RSS field names (`letterboxd_filmtitle`, etc.) need verification against a real feed.
- **Old `simple-admin` CSS** in `style/` predates the SPA port; some selectors (table, `credit-card`, `.country-flag`, `.tag plan-*`) are unused now and can be trimmed.
- **`model/mocks/`** is dead code left over from the template — safe to delete.
- **Don't hand-edit `.dist/`** — build output.
