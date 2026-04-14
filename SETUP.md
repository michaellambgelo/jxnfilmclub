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
# 1. Form loads
curl -I https://join.jxnfilm.club/
# expect: 200, content-type: text/html

# 2. Privacy policy
curl -I https://join.jxnfilm.club/privacy
# expect: 200

# 3. Signup with a real Letterboxd handle (use your own for the first test)
curl -X POST https://join.jxnfilm.club/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","handle":"davidehrlich","name":"Test User"}'
# expect: { "ok": true }

# 4. Invalid handle is rejected
curl -X POST https://join.jxnfilm.club/signup \
  -H 'content-type: application/json' \
  -d '{"email":"x@y.com","handle":"this-handle-does-not-exist-12345","name":"X"}'
# expect: 400 { "error": "Letterboxd profile not found" }
```

After a successful signup, the `add-member` Action fires. Watch:

```bash
gh run list --workflow=add-member.yml
```

Once green, `data/members.json` has the new entry and the site rebuilds via `deploy-site.yml`.

---

## 9. Smoke test OTP

```bash
# Request a code (check inbox)
curl -X POST https://join.jxnfilm.club/otp/request \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'

# Verify (replace CODE with the 6 digits you received)
curl -X POST https://join.jxnfilm.club/otp/verify \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","code":"CODE"}'
# expect: { "token": "<payload>.<sig>" }
```

If the email never arrives: check `npx wrangler tail` and confirm DKIM + MailChannels lockdown records have propagated (`dig TXT _mailchannels.jxnfilm.club`).

---

## Troubleshooting

- **`wrangler deploy` fails with "route not found"** — zone isn't reachable. Confirm `jxnfilm.club` is active in Cloudflare.
- **Resend 401** — API key wrong or unset. `cd worker && npx wrangler secret list` should show `RESEND_API_KEY`.
- **Resend 403 "domain not verified"** — DNS records from Resend dashboard aren't fully propagated or weren't added. Re-check in Resend → Domains.
- **`add-member` workflow doesn't fire** — PAT permissions are wrong. It needs **Contents: Read and Write** on this repo.
- **Tests pass but staging signup adds to prod `data/members.json`** — staging `GITHUB_TOKEN` is scoped to the same repo. That's expected; if you want full isolation, create a `jxnfilmclub-staging` repo and change staging's `GITHUB_REPO` var.
