# Sign-in (Returning Members)

Returning members authenticate with a passwordless email OTP flow. The system intentionally does not reveal whether an email address is registered (anti-enumeration).

## User Flow

```mermaid
sequenceDiagram
    actor User
    participant Site as jxnfilm.club/signin
    participant Worker as Cloudflare Worker
    participant Email as Resend (email)

    User->>Site: Navigates to /signin
    alt Already has valid session
        Site->>Site: Redirect to /edit
    end

    Site->>User: "Enter the email you signed up with."
    User->>Site: Enters email, clicks "Email me a code"
    Site->>Worker: POST /otp/request

    alt Email is a member
        Worker->>Worker: Generate 6-digit OTP (10 min TTL)
        Worker->>Worker: Store otp:{email} in KV
        Worker->>Email: Send login email
    else Email is NOT a member
        Worker->>Worker: Do nothing (no OTP stored, no email sent)
    end
    Worker-->>Site: 200 OK (always, regardless of membership)

    Site->>User: "Enter the 6-digit code we sent to {email}."
    Note over Site: "Use a different email" link available
    User->>Site: Enters code, clicks "Verify"
    Site->>Worker: POST /otp/verify

    alt Valid code
        Worker->>Worker: Delete otp:{email}
        Worker->>Worker: Load member record from KV
        Worker->>Worker: Generate session token (1h expiry)
        Worker-->>Site: { token, email, id, name, handle }
        Site->>Site: Store session in localStorage
        Site->>Site: Redirect to /edit
    else Wrong code
        Worker-->>Site: 401 "invalid code"
        Site->>User: Shows error, OTP preserved for retry
    end
```

## Anti-Enumeration Design

The `POST /otp/request` endpoint always returns `200 OK` whether or not the email is registered. This prevents attackers from discovering which emails are club members.

## Error States

| Condition | HTTP | User sees |
|-----------|------|-----------|
| Unknown email | 200 | Normal code-entry step (but no email arrives) |
| Wrong code | 401 | "invalid code" |
| Correct code but no member record | 403 | "no member linked to this email" |
| Missing email | 400 | "email required" |
| Tampered/expired token | 401 | Unauthorized |

## Timing

- OTP code expires in **10 minutes**
- Session token expires in **1 hour**
- OTP is preserved on wrong-code attempts (user can retry)

## Key Files

| File | Role |
|------|------|
| `worker/src/index.js` | `handleOtpRequest()`, `handleOtpVerify()` |
| `ui/auth.html` | `sign-in-view` component |
| `tests/worker/otp.test.js` | 7 unit tests |
| `tests/e2e/signin.spec.ts` | 4 e2e tests |
