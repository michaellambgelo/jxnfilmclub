# Admin runbook

Admin work for jxnfilmclub stays in this repo. There is no admin UI and
no admin endpoint on the Worker — every state change is a script run
(with `wrangler` talking to production KV) plus, when appropriate, a
git commit to `data/`.

**Golden rule:** any admin op that writes to KV is paired with a
companion `data/` commit in the same session so git history and KV
never drift.

## Prerequisites

- `wrangler` authenticated against the Cloudflare account that owns
  `join.jxnfilm.club`. Either:
  ```bash
  cd worker && npx wrangler login
  ```
  or set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in your shell.
- Node 20+ (for the admin scripts).
- Write access to the repo (commits land on `main`).

Admin scripts run from the repo root and invoke wrangler under `worker/`
automatically.

## Operations

### Seed a member

Used when you want a member to exist without going through the public
signup flow (founders, manual onboards, backfilling KV for someone
already present in `data/members.json`).

One entry via flags:
```bash
node scripts/admin/seed-member.mjs \
  --email=person@example.com \
  --name="Given Name" \
  --handle=theirhandle \
  --pronouns=they/them
```

Multiple entries from a file (put it in `.admin/` — gitignored):
```bash
cat > .admin/pending-members.json <<'JSON'
[
  { "email": "a@example.com", "name": "A", "handle": "a-lb" },
  { "email": "b@example.com", "name": "B" }
]
JSON
node scripts/admin/seed-member.mjs
```

The script:
1. Generates a random `id` if you didn't supply one.
2. Appends to `data/members.json` unless the `id` is already there.
3. Writes `member:{email}` to production KV.
4. If `handle` is set, writes `email:{handle}` and `handle:{email}` too.

When it finishes:
```bash
git diff data/members.json   # sanity-check the new rows
git add data/members.json
git commit -m "Seed member: ..."
git push
```

### Backfill KV for an existing `data/members.json` row

Same script. If the `id` is already in JSON, `seed-member.mjs` leaves
JSON alone and only writes the KV rows. Example — the original
michaellamb seed:

```bash
node scripts/admin/seed-member.mjs \
  --id=ml-seed001 \
  --email=michael@michaellamb.dev \
  --name="Michael Lamb" \
  --handle=michaellamb \
  --pronouns=he/him \
  --joined=2026-04-14
```

No commit needed in this case — `data/members.json` didn't change.

### Audit drift between JSON and KV

```bash
node scripts/admin/kv-audit.mjs
```

Lists any `data/members.json` rows without a KV counterpart, and any
KV `member:*` rows whose `id` isn't present in the JSON. Good first step
when something looks off.

### Add or edit an event

Events are fully repo-driven, no KV involved.

1. Edit `data/events.json` in your editor.
2. Commit and push.
3. `deploy-site.yml` rebuilds and the new event shows up on `/events`.

Schema (see `ui/views.html` for what renders):

```json
{
  "id": "2026-06-12-passion",
  "title": "Summer Screening",
  "film": "The Passion of Joan of Arc",
  "year": 1928,
  "date": "2026-06-12",
  "venue": "Location",
  "poster": "https://..."
}
```

### Remove a member (moderation)

No script yet — do it manually, paired:

```bash
# 1. Drop KV rows
cd worker
npx wrangler kv key delete --binding MEMBERS_KV "member:their@email"
npx wrangler kv key delete --binding MEMBERS_KV "handle:their@email"
# If they had a verified Letterboxd handle, also:
npx wrangler kv key delete --binding MEMBERS_KV "email:theirhandle"

# 2. Drop any transient state
npx wrangler kv key delete --binding MEMBERS_KV "otp:their@email"
npx wrangler kv key delete --binding MEMBERS_KV "lb_token:their@email"
npx wrangler kv key delete --binding MEMBERS_KV "pending:their@email"

# 3. Remove from data/members.json (by id), commit, push.
```

If this becomes routine, turn it into `scripts/admin/remove-member.mjs`.

### Force-link a Letterboxd handle (skip RSS check)

Rare. Used only if a member can't complete the tag dance.

```bash
cd worker
npx wrangler kv key put --binding MEMBERS_KV "email:theirhandle" "their@email"
npx wrangler kv key put --binding MEMBERS_KV "handle:their@email" "theirhandle"
# Also update the `handle` field on member:{email} — easiest:
node scripts/admin/seed-member.mjs \
  --id=<existing-id> \
  --email=their@email \
  --name="..." \
  --handle=theirhandle
# Then commit the resulting data/members.json diff (the handle column appears).
```

## Troubleshooting

- **"member not found" / silent-200 on `/otp/request`** — the member
  row is missing from KV. Run `kv-audit.mjs` to confirm, then
  `seed-member.mjs` with the existing id to backfill.
- **`wrangler kv key put` fails with auth error** — re-run
  `cd worker && npx wrangler login` or rotate `CLOUDFLARE_API_TOKEN`.
- **Seed script complains "invalid handle format"** — handle must match
  `[a-zA-Z0-9_-]+`, matching the Worker's `HANDLE_RE` in
  `worker/src/index.js`.

## What this deliberately doesn't do

- No `workflow_dispatch` admin actions — the repo is public and workflow
  run inputs + logs are publicly readable, which would leak emails.
- No encrypted in-repo admin data — scale doesn't justify age/sops yet.
- No admin endpoint on the Worker — nothing to secure against misuse if
  it doesn't exist.

If any of the above stops making sense (second admin without CLI
access, more than a handful of ops per month, incident retention
needs), revisit.
