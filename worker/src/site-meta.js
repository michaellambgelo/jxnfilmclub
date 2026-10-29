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
// poster and club counts from FILMS_DB. Everything here is public: counts,
// the average and the screening date, never a member name or review.
//
// Fail-open: any error returns the shell exactly as GitHub Pages sent it, so
// a bug here costs the previews, never the site.

import { filmDetail, FILM_SLUG_RE } from './films.js'

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
  verify: { title: 'Log in', description: DEFAULT_DESCRIPTION, noindex: true },
  edit: { title: 'Account', description: DEFAULT_DESCRIPTION, noindex: true },
  host: { title: 'Host a screening', description: DEFAULT_DESCRIPTION, noindex: true },
}

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
  const page = PAGES[key]
  return { ...page, url: `${origin}/${key}`, status: 200 }
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
    ['property', 'og:image:width', img.width],
    ['property', 'og:image:height', img.height],
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
  const lines = tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeAttr(value)}">`)
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
