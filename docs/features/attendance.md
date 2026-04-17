# Event Attendance

Authenticated members can self-report attendance at events. Marking attendance is a one-click action on the events page; removing attendance is a deliberate action on the edit page.

## Mark Attendance

```mermaid
sequenceDiagram
    actor User
    participant Events as jxnfilm.club/events
    participant Worker as Cloudflare Worker
    participant GH as GitHub Actions

    User->>Events: Sees "I was there" button on an event
    User->>Events: Clicks "I was there"
    Events->>Worker: POST /events/{id}/attend (with session token)
    Worker->>Worker: Append member name to ATTENDANCE_KV
    Worker->>GH: Dispatch update-attendance { name, action: "add" }
    Worker-->>Events: { attendees: [...] }
    Events->>User: Button disappears,<br/>name appears in attendee list,<br/>"Edit" link appears
```

## Remove Attendance

```mermaid
sequenceDiagram
    actor User
    participant Events as jxnfilm.club/events
    participant Edit as jxnfilm.club/edit?event={id}
    participant Worker as Cloudflare Worker
    participant GH as GitHub Actions

    User->>Events: Sees "Edit" link on an attended event
    User->>Events: Clicks "Edit"
    Events->>Edit: Navigate to /edit?event={event-id}

    Edit->>Edit: Load event details from data/events.json
    Edit->>Edit: Verify user is in attendee list
    Edit->>User: "You marked attendance for {title}<br/>({film}) on {date}."

    User->>Edit: Clicks "Remove my attendance"
    Edit->>Worker: DELETE /events/{id}/attend (with session token)
    Worker->>Worker: Remove member name from ATTENDANCE_KV
    Worker->>GH: Dispatch update-attendance { name, action: "remove" }
    Worker-->>Edit: { attendees: [...] }
    Edit->>User: "Removed. Returning to events..."
    Note over Edit,Events: 1.5 second delay
    Edit->>Events: Redirect to /events
```

## Button States

```mermaid
stateDiagram-v2
    [*] --> NotSignedIn: Anonymous visitor

    NotSignedIn --> NotSignedIn: No button shown

    [*] --> NotAttended: Signed-in member
    NotAttended --> Attended: Click "I was there"
    Attended --> EditPage: Click "Edit"
    EditPage --> NotAttended: "Remove my attendance"
```

## Data Flow

Attendance is stored in two places:
1. **ATTENDANCE_KV** (Worker KV) -- source of truth for real-time reads
2. **data/attendance.json** (git) -- committed by the update-attendance workflow for the static site

The attendee identifier is the member's **display name** (not Letterboxd handle), so members without Letterboxd can participate.

## Attendee Display

- Members with a linked Letterboxd handle: name rendered as a link to their Letterboxd profile
- Members without Letterboxd: name rendered as plain text

## Error States

| Condition | HTTP | Behavior |
|-----------|------|----------|
| Not authenticated | 401 | Button not shown (frontend guard) |
| Member not found | 404 | "member not found" |
| Already attending (re-click) | 200 | Idempotent, no duplicate, no re-dispatch |
| Not attending (re-remove) | 200 | No-op, no dispatch |

## Key Files

| File | Role |
|------|------|
| `worker/src/index.js` | `handleAttend()`, `handleUnattend()`, `handleAttendanceGet()` |
| `ui/views.html` | events-view attendance buttons + "Edit" link |
| `ui/auth.html` | edit-view attendance panel (removal) |
| `.github/workflows/update-attendance.yml` | Commits attendance changes |
| `data/attendance.json` | Static attendance data |
| `tests/worker/attendance.test.js` | 8 unit tests |
