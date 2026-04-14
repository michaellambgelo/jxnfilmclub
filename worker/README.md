# worker

Cloudflare Worker backing `join.jxnfilm.club`. Serves the signup form +
privacy policy, handles OTP email login, and dispatches GitHub Actions to
update `data/members.json` in this repo.

## Dev

```bash
cd worker
npm install
npx wrangler dev         # local dev on http://localhost:8787
npx wrangler deploy      # ship it
```

## One-time setup

```bash
# 1. Create the KV namespace, then paste the id into wrangler.toml
npx wrangler kv:namespace create MEMBERS_KV

# 2. Secrets
npx wrangler secret put GITHUB_TOKEN      # fine-grained PAT, repo_dispatch
npx wrangler secret put DKIM_PRIVATE_KEY  # PEM, single line, for MailChannels
npx wrangler secret put OTP_SIGNING_KEY   # random string, e.g. openssl rand -hex 32
```

## DNS (on `jxnfilm.club`)

- `_mailchannels` TXT → `v=mc1 cfid=<your-workers-subdomain>` (MailChannels domain lockdown).
- `mailchannels._domainkey` TXT → DKIM public key (pair of the secret above).
- SPF TXT on apex → `v=spf1 include:relay.mailchannels.net ~all`.

## Routes

| Method | Path              | Purpose |
|--------|-------------------|---------|
| GET    | `/`               | Signup form (HTML) |
| GET    | `/privacy`        | Privacy policy (HTML) |
| POST   | `/signup`         | Verify Letterboxd profile + dispatch `add-member` |
| POST   | `/otp/request`    | Email a 6-digit code (MailChannels) |
| POST   | `/otp/verify`     | Exchange code for a signed session token |
| POST   | `/member/update`  | Authenticated edit-own-entry (dispatches `update-member`) |
