# Signup (New Member Registration)

New users join Jackson Film Club by providing a display name, email, and optionally a Letterboxd username. The flow spans two domains: the signup form lives on `join.jxnfilm.club` (Cloudflare Worker), and email verification completes on `jxnfilm.club` (static site).

## User Flow

```mermaid
sequenceDiagram
    actor User
    participant Join as join.jxnfilm.club
    participant Worker as Cloudflare Worker
    participant Email as Resend (email)
    participant Site as jxnfilm.club
    participant GH as GitHub Actions

    User->>Join: Fills name, email, optional Letterboxd handle
    User->>Join: Clicks "Email me a code"
    Join->>Worker: POST /signup
    Worker->>Worker: Generate 6-digit OTP (10 min TTL)
    Worker->>Worker: Generate jxnfc-verify-XXXXXXXX tag (48h TTL)
    Worker->>Worker: Store pending:{email} in KV
    Worker->>Email: Send signup email with code + LB tag
    Worker-->>Join: 200 OK
    Join->>Site: Redirect to /verify?email={email}

    Site->>User: "Enter the 6-digit code we sent to {email}.<br/>It expires in 10 minutes."
    User->>Site: Enters code, clicks "Confirm membership"
    Site->>Worker: POST /signup/verify
    Worker->>Worker: Validate code against pending:{email}
    Worker->>Worker: Create member:{email} in KV
    Worker->>Worker: Generate session token (1h expiry)
    Worker->>GH: Dispatch add-member workflow
    Worker-->>Site: { token, email, id, name, handle }
    Site->>Site: Store session in localStorage
    Site->>Site: Redirect to /edit

    GH->>GH: Append member to data/members.json
    GH->>GH: Commit + push
    Note over GH,Site: Public site rebuilds in ~30 seconds
```

## Error States

| Condition | HTTP | User sees |
|-----------|------|-----------|
| Email already registered | 409 | "this email is already a member -- try signing in" |
| Letterboxd handle claimed | 409 | "this Letterboxd handle is already claimed" |
| Invalid handle format | 400 | Form validation error |
| Missing name or email | 400 | "email required" / "name required" |
| Wrong verification code | 401 | "invalid code" |
| Expired or missing pending signup | 404 | "no pending signup -- start over" |

## Timing

- OTP code expires in **10 minutes**
- Letterboxd verification tag persists for **48 hours** (so the user can verify later from /edit)
- Session token expires in **1 hour**

## Key Files

| File | Role |
|------|------|
| `worker/src/index.js` | `handleSignup()`, `handleSignupVerify()` |
| `worker/src/signup.html` | Signup form template at join.jxnfilm.club |
| `ui/auth.html` | `verify-view` component |
| `.github/workflows/add-member.yml` | Commits new member to data/members.json |
| `tests/worker/signup.test.js` | 9 unit tests |
| `tests/e2e/signup.spec.ts` | 7 e2e tests |
