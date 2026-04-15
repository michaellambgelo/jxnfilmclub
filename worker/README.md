# worker

Cloudflare Worker backing `join.jxnfilm.club` (prod, from `main`) and
`join-staging.jxnfilm.club` (from `staging`). Serves the signup form +
privacy policy, handles OTP email login via Resend, and dispatches GitHub
Actions to update `data/members.json` in this repo.

## Dev

```bash
cd worker
npm install
npx wrangler dev                 # http://localhost:8787
npx wrangler deploy              # production (jxnfilmclub-join)
npx wrangler deploy --env staging
```

Local `wrangler dev` uses Miniflare — KV is in-memory, `fetch()` hits the
real internet. Pass secrets as `--var NAME:value` or drop a
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

Email domain (`jxnfilm.club`) must be verified in Resend — SPF + DKIM DNS
records are printed in the Resend dashboard.

## Routes

| Method      | Path              | Purpose |
|-------------|-------------------|---------|
| GET         | `/`               | Signup form (HTML) |
| GET         | `/privacy`        | Privacy policy (HTML) |
| POST        | `/signup`         | Validate Letterboxd profile + issue verify token, store pending claim in KV |
| POST        | `/signup/verify` | Scrape Letterboxd for token → dispatch `add-member`, write KV bidirectionally |
| POST        | `/otp/request`    | Email a 6-digit code via Resend, store in KV with 10-min TTL |
| POST        | `/otp/verify`     | Exchange code for an HMAC-signed session token |
| POST        | `/member/update`  | Authenticated edit-own-entry (dispatches `update-member`; handle resolved server-side from token email) |
| POST/DELETE | `/__test/kv`      | **Dev only** (`E2E_MODE=true`): seed/clear KV for Playwright |

## Env vars

Set in `wrangler.toml` per env:

| Name              | Purpose |
|-------------------|---------|
| `SITE_ORIGIN`     | CORS allow-origin (e.g. `https://jxnfilm.club`) |
| `GITHUB_OWNER`    | Dispatch target repo owner |
| `GITHUB_REPO`     | Dispatch target repo name |
| `LETTERBOXD_BASE` | Optional override (defaults to `https://letterboxd.com`); E2E points at a local stub |
| `E2E_MODE`        | When `"true"`, enables `/__test/kv` and short-circuits Resend + GitHub dispatch (writes last-call details to KV sentinels `__last_otp__` / `__last_dispatch__`). Never set in prod. |

## Tests

```bash
# From the repo root:
npm test              # Vitest incl. tests/worker/
npm run test:e2e      # Playwright boots this Worker with E2E_MODE + LETTERBOXD_BASE
```

`tests/worker/` uses `@cloudflare/vitest-pool-workers` (`SELF.fetch`, direct
KV binding access, mocked `fetch()` for Letterboxd/Resend/GitHub).
