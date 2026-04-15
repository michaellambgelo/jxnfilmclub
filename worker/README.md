# worker

Cloudflare Worker backing `join.jxnfilm.club` (prod, from `main`) and
`join-staging.jxnfilm.club` (from `staging`). Serves a static signup
form at `/`, handles email/OTP membership verification, Letterboxd tag
verification, session tokens, and repo-dispatch calls that commit
updates to `data/members.json` in this repo. **No session UI lives on
this origin** — the signup form redirects to `jxnfilm.club/verify` for
code entry so sessions stay single-origin.

## Dev

```bash
cd worker
npm install
npx wrangler dev                 # http://localhost:8787
npx wrangler deploy              # production (jxnfilmclub-join)
npx wrangler deploy --env staging
```

Local `wrangler dev` uses Miniflare — KV is in-memory, `fetch()` hits
the real internet. Pass secrets as `--var NAME:value` or drop a
`worker/.dev.vars` file.

## One-time setup

See [../docs/SETUP.md](../docs/SETUP.md) for the full walkthrough.
Summary:

```bash
# KV namespaces (prod + staging)
npx wrangler kv:namespace create MEMBERS_KV
npx wrangler kv:namespace create MEMBERS_KV --env staging
# → paste returned ids into wrangler.toml

# Secrets (repeat with --env staging for the staging Worker)
npx wrangler secret put GITHUB_TOKEN     # fine-grained PAT, Contents: Write
npx wrangler secret put RESEND_API_KEY   # re_... from resend.com
npx wrangler secret put OTP_SIGNING_KEY  # openssl rand -hex 32
```

Email domain (`jxnfilm.club`) must be verified in Resend — SPF + DKIM
DNS records are printed in the Resend dashboard.

## Routes

### Static

| Method | Path        | Purpose |
|--------|-------------|---------|
| GET    | `/`         | Signup form. `%SITE_ORIGIN%` placeholder is substituted at response time so links target the right origin. |
| GET    | `/privacy`  | Privacy policy (HTML). |

### Signup + session (anonymous)

| Method | Path                | Purpose |
|--------|---------------------|---------|
| POST   | `/signup`           | `(email, name, handle?)` → writes `pending:{email}` + `lb_token:{email}`, sends combined code+LB-tag email. |
| POST   | `/signup/verify`    | `(email, code)` → promotes pending → `member:{email}`, dispatches `add-member`, returns session token. |
| POST   | `/otp/request`      | `(email)` — returning members only; silently 200s for unknown emails so the endpoint can't enumerate. |
| POST   | `/otp/verify`       | `(email, code)` → returns session token + member `id`/`handle`. |

### Authenticated (bearer token from `/signup/verify` or `/otp/verify`)

| Method | Path                  | Purpose |
|--------|-----------------------|---------|
| GET    | `/member/me`          | Full `member:{email}` row (authoritative copy). |
| POST   | `/member/update`      | `(name?, pronouns?)` → writes KV + dispatches `update-member`. Handle is ignored on this endpoint — it's set only via the Letterboxd flow. |
| GET    | `/letterboxd/status`  | `{ verified, handle }` / `{ pending, handle, token, exp }` / `{ none: true }`. |
| POST   | `/letterboxd/request` | `(handle)` → mints a fresh 48h `lb_token:{email}` for the given handle. |
| POST   | `/letterboxd/verify`  | Scrapes `letterboxd.com/{handle}/rss/` for the pending token; on match commits the link + dispatches `update-member` with the handle. |
| POST   | `/letterboxd/unlink`  | Remove the verified Letterboxd link. Clears `email:/handle:/lb_token:` rows, nulls `member.handle`, dispatches `update-member` with `{ handle: null }` so the public row drops the field. |

### Dev-only (E2E)

| Method | Path          | Purpose |
|--------|---------------|---------|
| ALL    | `/__test/kv`  | Enabled only when `env.E2E_MODE === 'true'`. `POST { key, value, ttl }`, `GET ?key=...` / `GET ?prefix=...`, `DELETE { key }` (JSON) or `DELETE ?prefix=...`. |

## Env vars

Set in `wrangler.toml` per env:

| Name              | Purpose |
|-------------------|---------|
| `SITE_ORIGIN`     | CORS allow-origin + substituted into signup.html links (e.g. `https://jxnfilm.club`). |
| `GITHUB_OWNER`    | Dispatch target repo owner. |
| `GITHUB_REPO`     | Dispatch target repo name. |
| `LETTERBOXD_BASE` | Optional override (defaults to `https://letterboxd.com`); E2E points at a local stub. |
| `E2E_MODE`        | When `"true"`, enables `/__test/kv` and short-circuits Resend + GitHub dispatch (writes last-call details to KV sentinels `__last_email__` / `__last_dispatch__`). Never set in prod. |

## KV schema

- `pending:{email}` — `{ name, handle?, code }`, 10min TTL. Consumed by `/signup/verify`.
- `member:{email}` — `{ id, email, name, pronouns, handle, joined }`. Authoritative member row.
- `lb_token:{email}` — `{ token, handle?, exp }`, 48h TTL. Issued on signup + `/letterboxd/request`.
- `email:{handle}` / `handle:{email}` — bidirectional link, written on `/letterboxd/verify`.
- `otp:{email}` — 6-digit login code, 10min TTL.

## Tests

```bash
# From the repo root:
npm test              # Vitest, incl. tests/worker/
npm run test:e2e      # Playwright boots this Worker with E2E_MODE + LETTERBOXD_BASE
```

`tests/worker/` uses `@cloudflare/vitest-pool-workers` with `SELF.fetch`,
direct KV binding access, and mocked `fetch()` for Letterboxd / Resend /
GitHub. Four suites: `signup`, `otp`, `member-update`, `letterboxd`.
