# Members Directory

A public, searchable, sortable directory of all club members at `/members`.

## Page Layout

Members render as a responsive card grid (`.card-grid.member-grid` in
`css/cards.css`), using CSS `grid-template-columns: repeat(auto-fit,
minmax(220px, 1fr))` so the column count follows viewport width without
explicit breakpoints — one column on phones, three to five on desktop.

Each card shows:
- Avatar (deterministic background color from first letter of name)
- Display name
- Letterboxd handle (linked to profile, if verified; or muted
  "no Letterboxd" label otherwise)
- "Joined {relative time}" via `<timeago>` widget

Above the grid: a result-count line ("{N} members") plus the search +
sort header.

## Interaction Flow

```mermaid
flowchart TD
    A[User navigates to /members] --> B[Load members from data/members.json]
    B --> C[Render card grid]

    C --> D{Search field}
    D -->|Type query| E[Filter by name or handle<br/>Updates ?query= param]

    C --> F{Sort dropdown}
    F -->|Join date| G[Sort by joined date]
    F -->|Name| H[Sort alphabetically by name]
    F -->|Letterboxd handle| I[Sort by handle]
```

## Avatar Widget

Each member gets a deterministic avatar with a colored background:
- Color is derived from the first letter of the member's name
- 16 colors total (8 dark + 8 light), indexed by `(charCode - 97) / 2`
- Dark backgrounds get white text, light backgrounds get black text

## URL Parameters

| Param | Effect | Example |
|-------|--------|---------|
| `query` | Filters by name or handle | `?query=michael` |
| `sort` | Sort field | `?sort=name` or `?sort=handle` |

## Key Files

| File | Role |
|------|------|
| `ui/views.html` | `members-view` component |
| `ui/widgets.html` | `avatar` and `timeago` widgets |
| `css/cards.css` | `.member-grid` + `.member-card` layout |
| `model/index.ts` | `getMembers()` with search and sort |
| `data/members.json` | Member records |
| `tests/e2e/site.spec.ts` | 4 members-view + 1 avatar test |
| `tests/model/model.test.ts` | 4 getMembers tests |
