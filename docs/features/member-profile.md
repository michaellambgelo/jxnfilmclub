# Member Profile

Authenticated members manage their display name, pronouns, and Letterboxd link from the `/edit` page. Changes propagate to the public site via GitHub Actions.

## Profile Editing

```mermaid
sequenceDiagram
    actor User
    participant Site as jxnfilm.club/edit
    participant Worker as Cloudflare Worker
    participant GH as GitHub Actions

    Site->>Worker: GET /member/me (with session token)
    Worker->>Worker: Read session:{id} (fall back to<br/>member:{email} on miss; reseed)
    Worker-->>Site: { name, pronouns, handle, ... }
    Site->>User: Prefills form fields

    User->>Site: Edits name/pronouns, clicks "Save"
    Site->>Worker: POST /member/update { name, pronouns }
    Worker->>Worker: Update member:{email} in KV
    Worker->>Worker: Refresh session:{id} snapshot
    Worker->>GH: Dispatch update-member workflow
    Worker-->>Site: 200 OK

    Site->>User: "Saved. The public site rebuilds in ~30 seconds."

    GH->>GH: Update data/members.json
    GH->>GH: Commit + push
    Note over GH: Triggers deploy-site workflow
```

### Race with `add-member` for brand-new members

A member who edits their profile within moments of verifying signup (e.g.
landing straight on `/edit` and hitting Save) fires `update-member` almost
back-to-back with the `add-member` dispatch from `/signup/verify`. Both
workflows independently checkout, edit, commit, and push `data/members.json`
— if `update-member`'s checkout lands before `add-member`'s commit is pushed,
the row doesn't exist yet. `update-member.yml`'s edit step detects this (the
python script exits `42` when the id isn't found) and retries up to 6 times,
re-fetching + hard-resetting to `origin/main` with a 5s pause between
attempts, before failing for real. `remove-member.yml` has the analogous race
but treats a missing row as an idempotent no-op instead, since "member not in
the projection" is already the desired end state for a removal.

## Letterboxd Handle

Members link a Letterboxd profile by typing their username on `/edit` and
clicking *Save handle*. Trust model: the handle is self-asserted; a club
organizer can force-unlink a disputed handle via the local admin
dashboard (`admin/`). There is no automated proof-of-ownership step —
the previous diary-tag verification flow was removed when Letterboxd
remained API-less and admin moderation became sufficient.

```mermaid
sequenceDiagram
    actor User
    participant Site as jxnfilm.club/edit
    participant Worker as Cloudflare Worker

    User->>Site: Types Letterboxd username, clicks "Save handle"
    Site->>Worker: POST /member/update { handle }
    Worker->>Worker: Validate format (HANDLE_RE)
    Worker->>Worker: Check email:{handle} reverse index
    alt Claimed by another email
        Worker-->>Site: 409 "this Letterboxd handle is already claimed"
        Site->>User: Error shown; pick a different handle
    else Available
        Worker->>Worker: Write email:{handle} + handle:{email}
        Worker->>Worker: Update member.handle, refresh session:{id}
        Worker-->>Site: { ok: true }
        Site->>User: "Linked as @{handle}" with profile link
    end
```

Handles set at signup time are promoted onto the member row inside
`/signup/verify` (same uniqueness check, same reverse-index write) — no
separate post-signup step.

Linking a handle also surfaces the member's **Letterboxd avatar**: the
Worker's `GET /avatars` scrapes the profile page's `og:image` (7-day KV
cache; see [watched.md](watched.md)) and the `/edit` panel shows it beside
"Linked as @{handle}", as do the member directory, watched headers, and
event host lines. Members without a custom Letterboxd avatar (or without a
handle) keep the letter avatar.

### Unlink Confirmation

When removing a Letterboxd link, the user sees:
> "Remove your Letterboxd link? Your membership stays -- only the @handle disappears from the public directory."

## Remove Membership

Members can self-service delete their entire membership from the `/edit`
"Remove membership" danger-zone section. The submit button stays disabled
until the typed email exactly matches the signed-in email
(type-to-confirm gate). On submit:

1. **Worker** (`POST /member/delete`, authenticated) first purges the
   member's entries from every `rsvp:{eventId}` record in
   `ATTENDANCE_KV` (`purgeRsvps` — those records carry the email).
   Upcoming-event cancellations go through `cancelRsvp`, so a freed
   slot promotes the waitlist head with the usual confirmation email;
   past/orphaned records get a direct filtered write that leaves the
   names-only `attend:{eventId}` history alone. The purge runs before
   the cascade and is deliberately not error-swallowed: a failure 500s
   so the user can retry, rather than deleting the account while
   leaving their email behind.
2. It then cascades all `MEMBERS_KV` state for that member:
   `member:{email}`, `session:{id}`, `email:{handle}` +
   `handle:{email}` (if Letterboxd was linked — the handle becomes
   claimable again immediately).
3. The current bearer token is recorded in `revoked:{jti}` so a copy
   can't be replayed during the remaining JWT lifetime.
4. `dispatchGithub('remove-member', { id })` triggers
   `.github/workflows/remove-member.yml` which drops the row from
   `data/members.json` (idempotent — replays are a no-op).
5. **Client** clears `localStorage.jxnfc_session`, the OTP in-flight
   marker, and redirects to `/`.

**Past attendance defaults to kept.** `attend:{eventId}` arrays in
`ATTENDANCE_KV` are NOT touched by default — event-by-event attendance
lists are part of the club archive.

**Opt-in attendance scrub.** The danger-zone form includes an
*"Also remove my name from past event attendance"* checkbox that is
disabled until the typed-email gate clears. When ticked, the client
posts `{ anonymize: true }` to `/member/delete`; the Worker then walks
every `attend:*` key in `ATTENDANCE_KV`, replaces the member's display
name with the literal label `former member`, and patches the
`attendance:all` aggregate to match. Event counts stay intact; the
identity is gone.

Implementation notes:

- The scrub matches on `member.name`, not `member.id` (attendance is
  name-keyed). Members sharing a display name would be conflated; the
  signup flow does not enforce unique display names.
- Idempotent: if a previous departing member already left a
  `former member` token in the same event, the new scrub doesn't add a
  duplicate.
- The standalone "kept as historical record" option is still the
  default — anonymization is strictly opt-in.

## Error States

| Condition | HTTP | User sees |
|-----------|------|-----------|
| Handle claimed by another member | 409 | "this Letterboxd handle is already claimed" |
| Invalid handle format on `/member/update` | 400 | "invalid handle format" |
| No Letterboxd to unlink | 400 | "no Letterboxd linked" |
| `name` longer than 80 chars on `/member/update` | 400 | "name too long" |
| `pronouns` longer than 32 chars on `/member/update` | 400 | "pronouns too long" |
| `/member/delete` called but the row was already gone (stale tab) | 404 | "member not found" |

## Timing

- `session:{id}` snapshot expires in **1 hour** (matches JWT exp); refreshed on every member-mutating write so the client sees its own updates on the next `/member/me`.

## Key Files

| File | Role |
|------|------|
| `worker/src/index.js` | `handleMemberMe()`, `handleMemberUpdate()` (now owns handle setting), `handleLbUnlink()` |
| `ui/auth.html` | `edit-view` component (profile form + `.lb-panel`) |
| `.github/workflows/update-member.yml` | Commits profile changes; retries if the row isn't in `data/members.json` yet (race with `add-member`) |
| `tests/worker/member-update.test.js` | unit tests covering name/pronouns/handle paths |
| `tests/worker/letterboxd.test.js` | unlink unit tests |
| `tests/e2e/letterboxd.spec.ts` | handle add / claim / unlink e2e |
