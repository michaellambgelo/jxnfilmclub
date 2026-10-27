# Reviews (Hot Takes page)

`/reviews`, the **Reviews** tab in the masthead: every Hot Take the join Worker
has cached, as one long column, newest first. The home page shows three of
them at random; this page shows them all.

## Data

One fetch of public `GET /takes` (see [watched.md](watched.md) § Data source
and [home.md](home.md) § Hot Takes): every public Letterboxd review in each
linked member's feed (their 50 most recent diary entries), spoiler-flagged and plain diary entries skipped, cut at 300
characters, already sorted newest first by `watched_date`. The page keeps that
order. Like the home page, it joins takes to `GET /members` by handle and drops
any take whose handle is no longer a member's. Avatars come from
`avatarsById` (custom photo, else Letterboxd avatar, else the letter).

Each card: diary date on the tape, film title (linked to `/film?slug=` when the
review URL yields a slug) and year, the review, the member, their rating and
like, and **Read on Letterboxd** (the review itself, new tab).

## Lazy loading, five at a time

`ui/reviews.html` renders every card in **one** update, all carrying `-pending`
(`display: none`), then reveals five at a time:

- An `IntersectionObserver` on the `.rv-more` block (400px root margin)
  reveals the next batch as the reader nears the bottom; after each batch it
  keeps going while the block is still on screen, so a tall viewport fills.
- **Show more** does the same for keyboards and browsers without the
  observer. It is bound by document delegation behind a global once-guard,
  not `:onclick`.
- When nothing is left, the button hides and "That is every review we have
  right now." shows.

Why the reveal is a class flip and not an `update()`: nuedom replaces the
component root on update, which would re-render every card back to hidden and
orphan the observer; and every `:onclick` handler runs an update afterwards.
The status lines use `:hidden` rather than `:if` for the same no-sibling-shift
reason as everywhere else (see `docs/CLAUDE.md` § dhtml gotchas). Posters are
`loading="lazy"` inside `display: none` cards, so none is fetched until its
card is revealed. The data itself is one small JSON response (~70 takes).

## Nav width

Adding the seventh tab made the masthead wrap **Log in** onto a second row
from 901px to 1161px. `css/global.css` now applies the tight spacing up to
1180px (Join and Log in padding included) and hides the "Est. JXN MS" stamp
from 901px to 960px. Measured with Playwright at every width from 901 to
1400px, signed in and out: no wrap. Re-measure when a tab is added.

## Tests

`tests/e2e/reviews.spec.ts` — the tab, the first five, scrolling to ten then
twelve, the end line, Show more, the empty state, and the dropped non-member
take. E2E's `GET /takes` serves whatever a test seeds into `watched:cache`
(`takes`) and never fetches Letterboxd.

## Key files

| File | Role |
|------|------|
| `ui/reviews.html` | `reviews-view` |
| `css/reviews.css` | Page styles (`.rv-*`) |
| `ui/masthead.html` | The Reviews tab |
| `index.html` | `/reviews` → `reviews-view` |
| `worker/src/index.js` | `GET /takes` (`handleTakesGet`, `takesFromFeed`) |

## Back to top

A fixed **↑ Top** button (`.rv-top`) fades in once the reader is two screens
down and scrolls back to the heading (smoothly, unless reduced motion is on),
moving focus there. It sits bottom left because the beta Feedback button and
its panel own the bottom-right corner. Like the reveal, it is pure DOM: a
passive scroll listener (`rvTopSync`, bound once) toggles `-on`, and the click
rides the same document delegation as Show more.
