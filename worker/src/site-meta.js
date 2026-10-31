// Link previews and search metadata for the public site (jxnfilm.club).
// docs/features/link-previews.md.
//
// GitHub Pages serves the single-page app, so every deep link comes back as
// the same 404.html shell: HTTP 404, title "Jackson Film Club", and Nue's
// one name="og:title" tag that preview bots ignore. Crawlers and link
// unfurlers never run the app, so that is all they ever saw.
//
// The join Worker sits on the site's HTML routes (worker/wrangler.toml) and,
// for each page the app owns, fetches the shell from GitHub Pages as before,
// promotes the 404 to 200, and rewrites the head: a real title, description,
// canonical URL, Open Graph and Twitter tags. A film page reads its title,
// poster and club counts from FILMS_DB; an event link (/events?event=ID) and
// the bare /events tab read the public events from ATTENDANCE_KV. Everything
// here is public: counts, the average, dates, theater names, never a member
// name or review. House screenings never get a preview of their own.
//
// Fail-open: any error returns the shell exactly as GitHub Pages sent it, so
// a bug here costs the previews, never the site.

import { filmDetail, FILM_SLUG_RE } from './films.js'
import { isMembersOnly } from './event-visibility.js'

const SITE_NAME = 'Jackson Film Club'
const DEFAULT_DESCRIPTION = 'A community space for analytical conversations about cinema, founded in Jackson, Mississippi in 2018. We watch discussion-worthy films, together.'
const DEFAULT_IMAGE = { path: '/img/logo.png', width: 500, height: 500, alt: 'Jackson Film Club logo' }

// One entry per top-level page the app routes (index.html, the type switch).
// A new tab needs a line here AND a route in worker/wrangler.toml.
const PAGES = {
  '': { title: SITE_NAME, description: DEFAULT_DESCRIPTION },
  events: { title: 'Events', description: 'Upcoming screenings, house nights and socials from the Jackson Film Club, and the ones we have already watched together.' },
  watched: { title: 'Watched', description: 'What Jackson Film Club members have been watching lately, straight from their Letterboxd diaries.' },
  reviews: { title: 'Hot Takes', description: 'Recent reviews from the Letterboxd diaries of Jackson Film Club members, newest first.' },
  members: { title: 'Members', description: 'The members of the Jackson Film Club and their Letterboxd profiles.' },
  map: { title: 'Map', description: 'Where the Jackson Film Club screens films around Jackson, Mississippi.' },
  speak: { title: 'Speak', description: 'Record a voice clip for the Jackson Film Club podcast, or send the hosts a message.' },
  giveaways: { title: 'Giveaways', description: 'Event giveaways from the Jackson Film Club.' },
  feedback: { title: 'Feedback', description: 'Tell the Jackson Film Club what is working on the site and what is not.' },
  // Account pages: real pages, but nothing worth a search result.
  signin: { title: 'Log in', description: DEFAULT_DESCRIPTION, noindex: true },
  verify: { title: 'Confirm your email', description: DEFAULT_DESCRIPTION, noindex: true },
  edit: { title: 'Account', description: DEFAULT_DESCRIPTION, noindex: true },
  host: { title: 'Host a screening', description: DEFAULT_DESCRIPTION, noindex: true },
}

// Event ids usually lead with the date (2026-12-17-dune-part-three), but the
// admin types them freehand, so this only bounds the lookup key.
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,160}$/
// A venue named after somebody's home. Legacy rows carry these with no kind.
const HOME_VENUE_RE = /\b(house|home)\b/i

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// "2026-10-24-you-can-see-everything" -> "Oct 24, 2026". Event ids lead with
// the event date; strings only, never a Date, so no timezone can shift it.
function screeningDate(eventId) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(eventId || ''))
  if (!m || !MONTHS[Number(m[2]) - 1]) return null
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`
}

// "18:00" -> "6:00 PM". Event times are local wall-clock strings.
function eventTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''))
  if (!m || Number(m[1]) > 23) return null
  const h = Number(m[1])
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`
}

// The venue, only where it is a public place: a theater meetup or a social.
// Legacy rows (no kind) are mostly "Somebody's house", so they never show one.
function publicVenue(e) {
  if (!e.kind || !e.venue || HOME_VENUE_RE.test(e.venue)) return null
  return String(e.venue)
}

// "DOOMSDAY preview screening · Avengers: Doomsday · Dec 17, 2026 at 6:00 PM
// · Legacy Theaters Parkway". No host name, attendees or notes.
export function eventSummary(e) {
  const parts = []
  if (e.film && e.film !== e.title) parts.push(e.year ? `${e.film} (${e.year})` : String(e.film))
  const day = screeningDate(e.date)
  const time = eventTime(e.time)
  if (day) parts.push(time ? `${day} at ${time}` : day)
  const venue = publicVenue(e)
  if (venue) parts.push(venue)
  return parts.join(' · ')
}

// Every event an anonymous visitor may see, from the public aggregate the
// join API serves. Never bootstraps or writes: no aggregate, no previews.
async function publicEvents(env) {
  if (!env.ATTENDANCE_KV) return []
  const raw = await env.ATTENDANCE_KV.get('events:all')
  if (!raw) return []
  let all
  try { all = JSON.parse(raw) } catch { return [] }
  return Array.isArray(all) ? all.filter(e => e && e.id && !isMembersOnly(e)) : []
}

// Today in Jackson, as YYYY-MM-DD, compared as a string like every date here.
function centralToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

function eventImage(e) {
  if (!e.poster || !/^https:\/\//.test(e.poster)) return null
  // Event posters come in whatever size the admin pasted, so no dimensions.
  return { url: e.poster, alt: `${e.title} poster` }
}

export function filmDescription(d) {
  const name = d.film.year ? `${d.film.title} (${d.film.year})` : d.film.title
  const parts = []
  parts.push(d.members === 1
    ? `1 Jackson Film Club member has logged ${name}`
    : `${d.members} Jackson Film Club members have logged ${name}`)
  if (d.avg != null) parts.push(`club average ${(Math.round(d.avg * 10) / 10).toFixed(1)}★`)
  const dates = (d.screenings || []).map(screeningDate).filter(Boolean).sort()
  if (dates.length) parts.push(`screened by the club ${dates[dates.length - 1]}`)
  return parts.join(' · ') + '.'
}

// The page key for a path: '' for the root, 'film' for /film and /film/SLUG,
// else the first segment. null for anything that is not an app page (an
// asset that happened to match a route pattern), which passes through.
function pageKey(pathname) {
  const seg = pathname.split('/')[1] || ''
  if (seg === 'film') return 'film'
  if (pathname !== '/' && pathname !== `/${seg}`) return null
  return seg in PAGES ? seg : null
}

// Head for one page: { title, description, url, image, type, noindex, status }.
async function pageMeta(url, env) {
  const key = pageKey(url.pathname)
  if (key === null) return null
  const origin = env.SITE_ORIGIN || url.origin
  if (key === 'film') {
    const slug = url.searchParams.get('slug') || url.pathname.split('/')[2] || ''
    const d = FILM_SLUG_RE.test(slug) && env.FILMS_DB ? await filmDetail(env.FILMS_DB, slug) : null
    if (!d) return { ...PAGES[''], title: 'Film not found', url: `${origin}/film`, noindex: true, status: 404 }
    const name = d.film.year ? `${d.film.title} (${d.film.year})` : d.film.title
    return {
      title: name,
      description: filmDescription(d),
      url: `${origin}/film?slug=${encodeURIComponent(slug)}`,
      type: 'video.movie',
      image: d.film.poster ? { url: d.film.poster, width: 600, height: 900, alt: `${name} poster` } : null,
      status: 200,
    }
  }
  if (key === 'events') return eventsMeta(url, env, origin)
  const page = PAGES[key]
  return { ...page, url: `${origin}/${key}`, status: 200 }
}

// /events?event=ID previews that event when it is public. Anything else, an
// unknown id, a house screening, a search, gets the tab preview, byte for byte
// the same either way, so the response never confirms a private event exists.
// The tab preview leads with the next public screening.
async function eventsMeta(url, env, origin) {
  const tab = { ...PAGES.events, url: `${origin}/events`, status: 200 }
  const id = url.searchParams.get('event') || ''
  const events = await publicEvents(env)
  const e = EVENT_ID_RE.test(id) ? events.find(x => x.id === id) : null
  if (e && e.title) {
    const summary = eventSummary(e)
    return {
      title: String(e.title),
      description: summary ? `${summary}. A Jackson Film Club event.` : 'A Jackson Film Club event.',
      url: `${origin}/events?event=${encodeURIComponent(e.id)}`,
      image: eventImage(e),
      status: 200,
    }
  }
  const today = centralToday()
  const next = events
    .filter(x => x.title && typeof x.date === 'string' && x.date >= today)
    .sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`))[0]
  if (!next) return tab
  const summary = eventSummary(next)
  return {
    ...tab,
    description: `Next up: ${next.title}${summary ? ` · ${summary}` : ''}. ${PAGES.events.description}`,
    image: eventImage(next),
  }
}

function headHtml(meta, origin) {
  const fullTitle = meta.title === SITE_NAME ? SITE_NAME : `${meta.title} · ${SITE_NAME}`
  const img = meta.image || { ...DEFAULT_IMAGE, url: origin + DEFAULT_IMAGE.path }
  const tags = [
    ['name', 'description', meta.description],
    ['property', 'og:site_name', SITE_NAME],
    ['property', 'og:type', meta.type || 'website'],
    ['property', 'og:title', meta.title],
    ['property', 'og:description', meta.description],
    ['property', 'og:url', meta.url],
    ['property', 'og:image', img.url],
    img.width ? ['property', 'og:image:width', img.width] : null,
    img.height ? ['property', 'og:image:height', img.height] : null,
    ['property', 'og:image:alt', img.alt],
    ['property', 'og:locale', 'en_US'],
    // summary, not summary_large_image: a 2:3 poster or the square logo
    // crops badly into the wide card.
    ['name', 'twitter:card', 'summary'],
    ['name', 'twitter:title', fullTitle],
    ['name', 'twitter:description', meta.description],
    ['name', 'twitter:image', img.url],
    ['name', 'twitter:image:alt', img.alt],
  ]
  if (meta.noindex) tags.push(['name', 'robots', 'noindex'])
  const lines = tags.filter(Boolean).map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeAttr(value)}">`)
  lines.push(`<link rel="canonical" href="${escapeAttr(meta.url)}">`)
  return { fullTitle, html: '\n' + lines.join('\n') + '\n' }
}

// Removed so the rewritten tags are the only ones: Nue's name="og:title" and
// anything a later build might add under the names written above.
const REPLACED = [
  'meta[name="og:title"]', 'meta[name="description"]', 'meta[property^="og:"]',
  'meta[name^="twitter:"]', 'meta[name="robots"]', 'link[rel="canonical"]',
]

export async function handleSitePage(request, env, ctx) {
  // The shell, from GitHub Pages. fetch() of this same URL goes to the
  // origin, not back through this Worker. Conditional headers are dropped:
  // the origin ETag belongs to the shared 404.html, so a 304 would leave a
  // browser holding another page's head.
  const headers = new Headers(request.headers)
  headers.delete('If-None-Match')
  headers.delete('If-Modified-Since')
  const shell = await fetch(new Request(request, { headers }))
  if (request.method !== 'GET' && request.method !== 'HEAD') return shell
  const type = shell.headers.get('Content-Type') || ''
  if (!type.includes('text/html') || (shell.status !== 200 && shell.status !== 404)) return shell

  let meta
  try {
    meta = await pageMeta(new URL(request.url), env)
  } catch (err) {
    console.error('site meta failed', err && err.stack || err)
    return shell
  }
  if (!meta) return shell

  const origin = env.SITE_ORIGIN || new URL(request.url).origin
  const { fullTitle, html } = headHtml(meta, origin)
  const out = new Headers(shell.headers)
  out.delete('ETag')
  out.delete('Last-Modified')
  out.delete('Content-Length')
  out.set('Cache-Control', 'public, max-age=300')
  let rewriter = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(fullTitle) } })
    .on('head', { element(el) { el.append(html, { html: true }) } })
  for (const sel of REPLACED) rewriter = rewriter.on(sel, { element(el) { el.remove() } })
  return rewriter.transform(new Response(shell.body, { status: meta.status, statusText: meta.status === 200 ? 'OK' : 'Not Found', headers: out }))
}
