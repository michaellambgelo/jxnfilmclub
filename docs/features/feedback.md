# Beta Feedback

Active feedback capture for the beta period. Visitors — signed in or not —
can send freeform feedback from a floating launcher on every page or from the
dedicated `/feedback` route. Records land in KV and are triaged from the
admin portal. Homegrown on purpose: the data stays first-party (no
third-party widget script, nothing new in the privacy policy's third-party
list), and the clean JSON shape exports into whatever public feedback forum
the club adopts post-beta.

## Surfaces

| Surface | Component | Where |
|---------|-----------|-------|
| Floating launcher + panel | `feedback-widget` (`ui/feedback.html`) | Mounted globally from `index.html`, bottom-right, below the policy toast's z-index |
| `/feedback` page | `feedback-view` (`ui/feedback.html`) | Router branch in `index.html`; linked from the site footer |
| Shared form | `feedback-form` (`ui/feedback.html`) | Embedded by both surfaces |
| Admin triage | Feedback tab (`admin/admin.js` → `renderFeedback`) | admin.jxnfilm.club, reads `GET /api/kv?prefix=feedback:` |

## Flow

```mermaid
sequenceDiagram
    participant V as Visitor
    participant S as SPA (feedback-form)
    participant W as join Worker
    participant KV as MEMBERS_KV

    V->>S: category + message (+ Send anonymously)
    S->>S: jxnfcEnsureSession() — attach bearer if signed in
    S->>W: POST /feedback {category, message, page, anonymous}
    W->>W: validate; throttle rate:feedback:{ip} (60s)
    W->>W: authorize() — identity from token only, never the body
    W->>KV: put feedback:{ts}:{rand} (expirationTtl 90d, expiresAt in value)
    W-->>S: {ok: true}
```

## Data

Key `feedback:{Date.now()}:{rand8}` in `MEMBERS_KV`, value:

```json
{
  "at": "2026-08-09T14:00:00.000Z",
  "category": "bug | idea | other",
  "message": "1..2000 chars",
  "page": "/events",
  "member": { "id": "...", "email": "...", "name": "..." },
  "expiresAt": 1762696800
}
```

- `member` is `null` for signed-out visitors and for signed-in members who
  ticked *Send anonymously*. Identity is always server-resolved from the
  bearer token (`authorize()` + `readSession()`); body identity is ignored.
- `expiresAt` duplicates the key's absolute expiry into the value so the
  account-deletion identity strip can rewrite the record **without clearing
  its TTL** — a bare `put()` would make the record permanent.
- First IP-keyed throttle in the Worker (`rate:feedback:{CF-Connecting-IP}`,
  60s window); every other limiter is email-keyed.

## Privacy sync points (worker/src/privacy.html)

1. **Collection** — "Beta feedback" bullet under *What we collect*.
2. **Retention** — 90-day auto-delete under *How long we keep things*
   (enforced by `expirationTtl`, no scrub-cron involvement).
3. **Deletion** — `handleMemberDelete` calls `stripFeedbackIdentity()`:
   the member's feedback keeps its text, loses `member` on the spot.

Touching any of these behaviors means updating the policy in the same
change and bumping its `Last updated:` date.

## Admin triage

The Feedback tab lists newest-first with expiry countdown. **Delete =
handled** — there is no status field. Every rendered field goes through
`escapeHtml` (feedback messages are attacker-controlled free text; this is
the first place site visitors' prose reaches the admin SPA).

## Post-beta export / off-boarding runbook

Feedback records expire at 90 days, so **export before any record ages out**
(set a reminder if beta runs long):

1. Export: admin portal → `GET /api/kv?env=production&binding=MEMBERS_KV&prefix=feedback:`
   returns `{keys, values}` JSON — the full schema above, ready to transform
   into any forum's import format (Fider, Featurebase, CSV, …).
2. When the club adopts a public feedback forum:
   - remove `<feedback-widget/>` and the `feedback` router branch from
     `index.html`; delete `ui/feedback.html` + `css/feedback.css`
   - repoint the footer "Feedback" link at the forum
   - keep `POST /feedback` returning 410 (or drop it) and keep
     `stripFeedbackIdentity` in the delete cascade until the last
     `feedback:*` key has expired
   - update the privacy policy: drop the collection/retention/deletion
     bullets, add the forum to *Third parties* if it's embedded or linked
     with data flow

## Tests

- `tests/worker/feedback.test.js` — validation, throttle, identity
  attach/ignore/opt-out, delete-cascade strip with TTL preservation.
- `tests/e2e/fixtures.ts` wipes `feedback:` between e2e runs.
