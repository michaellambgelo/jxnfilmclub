# Link previews and search metadata

> Live since 2026-10-28. `worker/src/site-meta.js`, tests in
> `tests/worker/site-meta.test.js`.

## Why

The site is a single-page app on GitHub Pages. Every deep link
(`/film?slug=…`, `/events`, `/reviews`) is served as `404.html`, a copy of
the app shell, so before this:

- every page answered **HTTP 404**, which search engines drop and some
  unfurlers refuse;
- every page had the same head: `<title>Jackson Film Club</title>` and Nue's
  single `<meta name="og:title">` (the `name=` form, which Facebook, iMessage,
  Slack and Discord ignore). No description, image or Twitter card.

Crawlers and link unfurlers never run the app, so the head GitHub Pages sends
is all they ever see. GitHub Pages cannot vary it by URL.

## How

jxnfilm.club is proxied by Cloudflare, so the join Worker also takes the
site's **page** routes (production only, `worker/wrangler.toml`): `/` plus
`/film*`, `/events*`, `/watched*`, `/reviews*`, `/members*`, `/map*`,
`/speak*`, `/giveaways*`, `/feedback*`, `/signin*`, `/verify*`, `/edit*`,
`/host*`. Assets (`/css`, `/model`, `/img`, `/data`, …) never touch the
Worker. Patterns end in `*` because Cloudflare matches routes against the
whole URL, query string included.

`fetch()` at the very top of the Worker sends any request for the site's host
(`SITE_ORIGIN`) to `handleSitePage`, ahead of the join API's Origin and CORS
rules. It:

1. fetches the same URL (Cloudflare sends a Worker's same-URL subrequest to
   the origin, not back through the Worker), with `If-None-Match` /
   `If-Modified-Since` dropped: the origin ETag belongs to the shared
   `404.html`, so a 304 would leave a browser with another page's head;
2. passes through anything that is not HTML, not a 200/404, not GET/HEAD, or
   not an app page (a path with extra segments, say);
3. builds the page's head and streams the shell through `HTMLRewriter`:
   replaces `<title>`, removes Nue's `name="og:title"` and any earlier copy of
   the tags it writes, and appends `description`, `og:*` (`property=`),
   `twitter:*`, `canonical`, and `robots: noindex` where set;
4. sets the status (200 for app pages, 404 for an unknown film) and
   `Cache-Control: public, max-age=300`, with no ETag.

Fail-open: an error building the head returns the shell exactly as GitHub
Pages sent it, and `ctx.passThroughOnException()` plus a catch in `fetch()`
cover anything later. A broken deploy costs the previews, not the site.

## What each page gets

| Page | Title | Status | Notes |
|---|---|---|---|
| `/` | Jackson Film Club | 200 | Hero lede as the description |
| `/film?slug=SLUG` (or `/film/SLUG`) | `Title (Year) · Jackson Film Club` | 200 | `og:type video.movie`, the poster (600×900) as the image, canonical `?slug=` form |
| `/film?slug=unknown`, `/film` | Film not found | 404 | `noindex` |
| `/events`, `/watched`, `/reviews` (Hot Takes), `/members`, `/map`, `/speak`, `/giveaways`, `/feedback` | Tab name | 200 | Fixed description per tab (`PAGES`) |
| `/events?event=ID` (public event) | The event title | 200 | Film, date and time, theater, the event poster (no size claimed). Canonical `?event=` form |
| `/events`, `/events?event=` house, unknown or malformed id, `/events?query=…` | Events | 200 | Byte-identical for all of these. Leads with "Next up:" the next public event (by Central date) and its poster, else the fixed description |
| `/signin`, `/verify`, `/edit`, `/host` | Log in / Account / Host a screening | 200 | `noindex` |

Default image: `/img/logo.png` (500×500). `twitter:card` is `summary`, not
`summary_large_image`: a 2:3 poster and a square logo both crop badly into
the wide card.

A film's description uses only what `GET /films/:slug` already gives an
anonymous caller: member count, the club average (one decimal), and the most
recent screening date (from the event id's date prefix). Never names,
handles or review text; those need a session on the film page, and the
tests assert none of them reach the head.

Events come from the `events:all` aggregate in `ATTENDANCE_KV`, filtered by
`isMembersOnly()` (`worker/src/event-visibility.js`, the same function
`GET /events` uses for anonymous callers). A house screening never gets a
preview of its own, and its id gets exactly the response an unknown id gets,
so a preview cannot confirm a private event exists. An event description
carries the film, the date and time, and the venue only for a meetup or
social whose venue is not a home: legacy rows (no `kind`) were mostly
"Somebody's house", so they show none. No host name, attendees or notes.

The app side: each event card has `id="event-ID"` and a **Copy link** button
(`data-ev-share`, delegated in the `ui/views.html` lib script). On first
paint, `evFocusTarget()` scrolls to the card named by `?event=` and outlines
it (`.event-card.-target`). Signed out, a house screening has no card, so the
link just shows the list.

## Maintenance

- **A new app tab** needs a route pattern in `worker/wrangler.toml` and an
  entry in `PAGES` in `site-meta.js`, or its links keep the old 404 + generic
  head.
- Staging has no site domain, so these routes exist in production only;
  `tests/worker/site-meta.test.js` is the pre-deploy check.
- The privacy policy's Cloudflare entry says the membership service adds
  each page's title and preview details, and that page requests are logged
  (2026-10-28).

## Checking a preview

`curl -s https://jxnfilm.club/film?slug=SLUG | grep -E '<title>|og:|twitter:'`
shows exactly what an unfurler gets. Platforms cache previews; Facebook's
Sharing Debugger and the Twitter/X card validator can force a re-scrape of a
URL that was shared before this went live.
