# Setup

One-time setup for wiring the `join.jxnfilm.club` signup flow end-to-end.

Ordered so each step can be verified before moving on.

---

## 0. Prerequisites

- `jxnfilm.club` is already in Cloudflare with DNS under your control. ✓
- You're `michaellambgelo` on GitHub. ✓
- Local tools: `bun`, `node`, `npm`, `openssl`.

---

## 1. Create the GitHub repository

```bash
cd /Users/michael/Workspace/jxnfilmclub
git init
git add .
git commit -m "Initial scaffold"
gh repo create michaellambgelo/jxnfilmclub --public --source=. --push
```

Create the `staging` branch at the same commit:

```bash
git branch staging
git push -u origin staging
```

---

## 2. Create the GitHub Personal Access Token

The Worker uses this to call `repo_dispatch` when a signup arrives.

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new.
2. Repo access: `michaellambgelo/jxnfilmclub` only.
3. Permissions:
   - **Contents**: Read and Write (needed by the Actions that commit to `data/members.json`).
   - **Metadata**: Read (required).
4. Copy the token — you'll feed it to `wrangler secret put GITHUB_TOKEN` in step 5.

---

## 3. Cloudflare: API token + account id

**API token** (for the GH Actions deploy workflow):

1. Cloudflare dashboard → My Profile → API Tokens → Create Token.
2. Template: **"Edit Cloudflare Workers"**.
3. Account Resources: your account. Zone Resources: `jxnfilm.club`.
4. Copy the token.

**Account ID**: Cloudflare dashboard sidebar → any zone → Overview → right column → "Account ID".

Add both to your GitHub repo secrets (`gh secret set` or repo Settings → Secrets → Actions):

```bash
gh secret set CLOUDFLARE_API_TOKEN     # paste token
gh secret set CLOUDFLARE_ACCOUNT_ID    # paste account id
```

---

## 4. Create KV namespaces (production + staging)

```bash
cd worker
npx wrangler kv:namespace create MEMBERS_KV
npx wrangler kv:namespace create MEMBERS_KV --env staging
```

Each command prints an `id = "..."`. Paste them into `worker/wrangler.toml`:

- Top-level `[[kv_namespaces]]` → production
- `[[env.staging.kv_namespaces]]` → staging

Replace the two `TODO_...` placeholders.

---

## 5. Sign up at Resend + verify domain

MailChannels ended free Worker sending in 2024; we use Resend instead (3k emails/month free).

1. Create a free Resend account: <https://resend.com/signup>.
2. Dashboard → **Domains** → Add Domain → `jxnfilm.club`.
3. Resend shows 3 DNS records (MX for bounce handling, TXT for SPF, TXT for DKIM). Add each to Cloudflare for `jxnfilm.club`.
4. Click **Verify Domain** in Resend. Wait for green checkmarks.
5. Dashboard → **API Keys** → Create → copy the `re_...` key.

Set Worker secrets:

```bash
cd worker

# Production
npx wrangler secret put GITHUB_TOKEN      # paste PAT from step 2
npx wrangler secret put RESEND_API_KEY    # paste re_... from Resend
npx wrangler secret put OTP_SIGNING_KEY   # paste output of: openssl rand -hex 32

# Staging (repeat)
npx wrangler secret put GITHUB_TOKEN     --env staging
npx wrangler secret put RESEND_API_KEY   --env staging
npx wrangler secret put OTP_SIGNING_KEY  --env staging
```

---

## 6. DMARC record (optional but recommended)

Resend handles SPF + DKIM via step 5's records. Add DMARC on top:

| Type | Name     | Value                                                             |
|------|----------|-------------------------------------------------------------------|
| TXT  | `_dmarc` | `v=DMARC1; p=none; rua=mailto:postmaster@jxnfilm.club`            |

The Worker routes (`join.jxnfilm.club`, `join-staging.jxnfilm.club`) are created automatically on `wrangler deploy`.

---

## 7. First deploy

Push to `main` — this fires `.github/workflows/deploy-site.yml` and `.github/workflows/deploy-worker.yml`.

```bash
git push origin main
```

Watch the runs:

```bash
gh run watch
```

Expected results:
- `deploy-site` → `https://michaellambgelo.github.io/jxnfilmclub/` (until custom domain is set).
- `deploy-worker` → `https://join.jxnfilm.club/` serves the signup form.

---

## 8. Smoke test the signup flow

```bash
# 1. Signup form loads
curl -I https://join.jxnfilm.club/
# expect: 200, content-type: text/html

# 2. Privacy policy
curl -I https://join.jxnfilm.club/privacy
# expect: 200

# 3. Sign up (Letterboxd handle is optional)
curl -X POST https://join.jxnfilm.club/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","name":"Test User"}'
# expect: { "ok": true }

# 4. Rejects an already-registered email
curl -X POST https://join.jxnfilm.club/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","name":"Dupe"}'
# expect: 409 { "error": "this email is already a member — try signing in" }
```

Open the 6-digit code from the email on
`https://jxnfilm.club/verify?email=you@example.com`. On success, the
`add-member` Action fires:

```bash
gh run list --workflow=add-member.yml
```

Once green, `data/members.json` has the new `id`-keyed entry and the
site rebuilds via `deploy-site.yml`.

---

## 9. Smoke test returning-member sign-in

```bash
# Request a login code (check inbox — separate from the signup email)
curl -X POST https://join.jxnfilm.club/otp/request \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
# expect: { "ok": true } — silent-200s for unknown emails too

# Verify (replace CODE with the 6 digits you received)
curl -X POST https://join.jxnfilm.club/otp/verify \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","code":"CODE"}'
# expect: { "token": "...", "email": "...", "id": "...", "handle": null|"..." }
```

---

## 10. Smoke test Letterboxd verification (optional)

All four endpoints require the bearer token from step 9. Replace
`$TOKEN` and `$HANDLE` below.

```bash
# Current state (verified / pending / none)
curl https://join.jxnfilm.club/letterboxd/status \
  -H "Authorization: Bearer $TOKEN"

# Mint a fresh 48h tag for a handle
curl -X POST https://join.jxnfilm.club/letterboxd/request \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"handle\":\"$HANDLE\"}"
# → { "token": "jxnfc-verify-...", "handle": "...", "exp": ... }

# Paste that tag into a diary entry or list on Letterboxd, then:
curl -X POST https://join.jxnfilm.club/letterboxd/verify \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json'
# → { "ok": true, "handle": "..." } and dispatches update-member
```

If the email never arrives: check `npx wrangler tail` and confirm
Resend's SPF + DKIM records are green in the Resend dashboard.

---

## Troubleshooting

- **`wrangler deploy` fails with "route not found"** — zone isn't reachable. Confirm `jxnfilm.club` is active in Cloudflare.
- **Resend 401** — API key wrong or unset. `cd worker && npx wrangler secret list` should show `RESEND_API_KEY`.
- **Resend 403 "domain not verified"** — DNS records from Resend dashboard aren't fully propagated or weren't added. Re-check in Resend → Domains.
- **Email never arrives** — check `cd worker && npx wrangler tail` and confirm SPF + DKIM records in Resend are green.
- **`add-member` workflow doesn't fire** — PAT permissions are wrong. It needs **Contents: Read and Write** on this repo.
- **Tests pass but staging signup adds to prod `data/members.json`** — staging `GITHUB_TOKEN` is scoped to the same repo. That's expected; if you want full isolation, create a `jxnfilmclub-staging` repo and change staging's `GITHUB_REPO` var.
