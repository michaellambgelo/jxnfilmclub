# Local admin dashboard

A browser-based admin panel for the jxnfilmclub Worker's remote KV. Lives in
this repo for convenience but **never deploys** — the Nue build excludes
`admin/` (see `site.yaml`) and there's no CI hook for it.

## Trust model

There is no auth in this code. The dashboard binds to `127.0.0.1` only and
shells to `wrangler kv …` for every operation. Whoever can run `wrangler` on
your machine (against your Cloudflare account) can use the dashboard.
Whoever can't, can't. That's the gate.

If the dashboard returns "wrangler … exited 1 / not authenticated", run
`npx wrangler login` in `worker/` first.

## Run

```bash
npm run admin                       # http://localhost:5174
ADMIN_PORT=4000 npm run admin       # custom port
```

The env toggle in the header picks between `production` (default — red
topbar) and `staging` for the next KV call. The switch also re-loads the
current tab so you don't accidentally act on the wrong namespace.

## Tabs

| Tab | What it shows | Write ops |
|-----|---------------|-----------|
| **Members** | All `member:{email}` rows | clear rate limits, force-unlink Letterboxd (also patches `data/members.json`), evict session snapshot |
| **Pending** | `pending:{email}` signups with their OTP code | delete (use for stuck signups) |
| **Sessions** | `session:{id}` cached snapshots | evict (does NOT revoke the JWT — use the Worker's `/session/revoke` for that) |
| **Revoked** | `revoked:{jti}` tombstones | read-only (auto-expire) |
| **Rate limits** | All `rate:*` counters; lockouts (≥5) are highlighted | delete a counter to unblock a user |
| **Letterboxd** | `lb_token:{email}` in-flight verifications | delete to cancel |
| **Events** | `data/events.json` rows + live attendance from `ATTENDANCE_KV` | add / edit / delete events, remove attendees |

## What it does NOT do

- Doesn't dispatch the `add-member` / `update-member` GitHub workflows. If
  you edit `data/members.json` here (via "unlink LB"), commit the diff
  manually — the public site picks it up on the next deploy.
- Doesn't write to `attendance:all` aggregate independently of `attend:{id}`;
  the "remove attendee" action does keep them consistent, but raw KV writes
  via wrangler don't.
- Doesn't manage email (Resend) or revoke individual JWTs (no jti index).

## Why a local dashboard, not a hosted admin route?

A hosted admin route would need its own auth, audit log, and CSRF. By keeping
this local-only with wrangler as the gate, the surface stays tiny — no
secrets in CI, no admin-token rotation, no extra cors origins to maintain.
The tradeoff: it doesn't work from your phone.
