# Navigation & Auth State

The site navigation adapts based on authentication state. The SPA uses client-side routing via Nue's `state` module with URL-based route parameters.

## Nav States

```mermaid
stateDiagram-v2
    [*] --> Anonymous
    Anonymous --> SignedIn: Sign in or sign up
    SignedIn --> Anonymous: Sign out

    state Anonymous {
        [*] --> AnonymousNav
        AnonymousNav: Members | Events | Watched | Join | Log in
    }

    state SignedIn {
        [*] --> SignedInNav
        SignedInNav: Members | Events | Watched | Account Actions
    }
```

- **Anonymous**: "Join" links to `https://join.jxnfilm.club/` (external), "Log in" links to `/signin`
- **Signed in**: "Account Actions" links to `/edit` (on jxnfilm.club, not join.jxnfilm.club). The page name reflects the breadth of actions there — profile edits, Letterboxd link, host-a-screening, membership deletion — beyond just "edit".

## Responsive Behavior

The mastnav is a horizontal flex row above 640px. At `max-width: 640px` it collapses behind a hamburger toggle (`.nav-toggle`); the link group (`.mastnav-links`) is hidden and revealed by toggling `.open` on the nav, driven by a `menuOpen` flag on `index.html`'s root component. The flag is reset to `false` on every route change so the menu auto-closes after navigation.

## Session Management

Sessions are stored in `localStorage.jxnfc_session` with the following structure:

```json
{
  "token": "base64url-encoded JWT",
  "email": "user@example.com",
  "id": "randomId",
  "name": "Display Name",
  "handle": "letterboxd-handle or null",
  "exp": 1234567890000
}
```

Session validity check: `s?.token && s.exp > Date.now()`

## SPA Routing

| URL | View | Route param |
|-----|------|-------------|
| `/` | `home-view` | (default) |
| `/members` | `members-view` | `type=members` |
| `/events` | `events-view` | `type=events` |
| `/watched` | `watched-view` | `type=watched` |
| `/signin` | `sign-in-view` | `type=signin` |
| `/verify` | `verify-view` | `type=verify` |
| `/edit` | `edit-view` | `type=edit` |

### Query Parameters

| Param | Used by | Purpose |
|-------|---------|---------|
| `query` | members, events | Search filter |
| `sort` | members, events | Sort field/direction |
| `venue` | events | Venue filter |
| `email` | verify, signin | Prefill email field |
| `event` | edit | Event ID for attendance removal |

## External Link Handling

Nue's `autolink` intercepts all anchor clicks for SPA routing. A capture-phase click handler prevents this for:
- Cross-origin links (e.g., `join.jxnfilm.club`, `letterboxd.com`)
- Links with `target="_blank"`

## Key Files

| File | Role |
|------|------|
| `index.html` | SPA shell, router setup, nav template |
| `ui/auth.html` | `getSession()`, `setSession()` |
| `ui/views.html` | `getSession()` in events-view |
