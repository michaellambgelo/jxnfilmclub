import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { filmDescription, eventSummary } from '../../worker/src/site-meta.js'

// worker/src/site-meta.js: the join Worker on jxnfilm.club's page routes
// rewrites the GitHub Pages shell's head for link previews and search.

// What GitHub Pages serves for every deep link: 404.html, a copy of the app
// shell, with Nue's one og:title in the name= form.
const SHELL = `<!doctype html><html lang="en"><head>
<title>Jackson Film Club</title>
<meta charset="utf-8">
<meta name="og:title" content="Jackson Film Club">
<script type="importmap">{"imports":{"app":"/model/index.js"}}</script>
</head><body><main><article></article></main></body></html>`

function originServes(status = 404, body = SHELL, type = 'text/html; charset=utf-8') {
  const seen = []
  globalThis.fetch = vi.fn(async (input) => {
    seen.push(input instanceof Request ? input : new Request(input))
    return new Response(body, { status, headers: { 'Content-Type': type, ETag: '"shell"', 'Cache-Control': 'max-age=600' } })
  })
  return seen
}

const page = path => SELF.fetch('https://jxnfilm.club' + path)

function metaMap(html) {
  const out = {}
  for (const m of html.matchAll(/<meta (name|property)="([^"]+)" content="([^"]*)">/g)) {
    (out[m[2]] = out[m[2]] || []).push(m[3])
  }
  return out
}

async function seedFilm() {
  const db = env.FILMS_DB
  const now = new Date().toISOString()
  const stmts = [db.prepare(
    "INSERT INTO films (slug, title, year, poster, first_seen) VALUES ('you-can-see-everything', 'You Can See Everything', '2026', 'https://a.ltrbxd.com/p.jpg', ?1)",
  ).bind(now)]
  const logs = [
    [1, 'm1', 'Alice Secretname', 5, '2026-10-24-you-can-see-everything', 'A secret review'],
    [2, 'm2', null, 4.5, null, null],
    [3, 'former:x', null, 5, null, null],
  ]
  for (const [id, member, handle, rating, eventId, review] of logs) {
    stmts.push(db.prepare(
      "INSERT INTO logs (id, entry_url, film_slug, member_key, handle, watched_date, event_id, first_seen) VALUES (?1, ?2, 'you-can-see-everything', ?3, ?4, '2026-10-24', ?5, ?6)",
    ).bind(id, 'u' + id, member, handle, eventId, now))
    stmts.push(db.prepare('INSERT INTO log_versions (log_id, seen_at, rating, liked, review) VALUES (?1, ?2, ?3, 1, ?4)').bind(id, now, rating, review))
  }
  await db.batch(stmts)
}

afterEach(() => { vi.restoreAllMocks() })

describe('site link previews (jxnfilm.club pages)', () => {
  it('a film page gets 200, its own title, poster and public club counts', async () => {
    await seedFilm()
    const seen = originServes()
    const res = await page('/film?slug=you-can-see-everything')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('ETag')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    const html = await res.text()
    const m = metaMap(html)
    expect(html).toContain('<title>You Can See Everything (2026) · Jackson Film Club</title>')
    expect(m['og:title']).toEqual(['You Can See Everything (2026)'])
    expect(m['og:type']).toEqual(['video.movie'])
    expect(m['og:image']).toEqual(['https://a.ltrbxd.com/p.jpg'])
    expect(m['og:image:height']).toEqual(['900'])
    expect(m['og:url']).toEqual(['https://jxnfilm.club/film?slug=you-can-see-everything'])
    expect(m['twitter:card']).toEqual(['summary'])
    expect(m.description[0]).toBe('3 Jackson Film Club members have logged You Can See Everything (2026) · club average 4.8★ · screened by the club Oct 24, 2026.')
    expect(html).toContain('<link rel="canonical" href="https://jxnfilm.club/film?slug=you-can-see-everything">')
    // Nue's name= og:title is gone; the import map and app shell are untouched.
    expect(html).not.toContain('name="og:title"')
    expect(html).toContain('<script type="importmap">')
    expect(html).toContain('<article></article>')
    // Nothing a session would gate.
    for (const secret of ['Alice', 'Secretname', 'secret review', 'former:']) expect(html).not.toContain(secret)
    // The shell came from the origin, without conditional headers.
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://jxnfilm.club/film?slug=you-can-see-everything')
  })

  it('accepts the /film/SLUG form and points it at the canonical ?slug= URL', async () => {
    await seedFilm()
    originServes()
    const res = await page('/film/you-can-see-everything')
    expect(res.status).toBe(200)
    expect(metaMap(await res.text())['og:url']).toEqual(['https://jxnfilm.club/film?slug=you-can-see-everything'])
  })

  it('an unknown film stays a 404, noindex, with the default image', async () => {
    originServes()
    const res = await page('/film?slug=no-such-film')
    expect(res.status).toBe(404)
    const html = await res.text()
    const m = metaMap(html)
    expect(m.robots).toEqual(['noindex'])
    expect(m['og:image']).toEqual(['https://jxnfilm.club/img/logo.png'])
    expect(html).toContain('<title>Film not found · Jackson Film Club</title>')
  })

  it('tabs get 200 and their own title; account pages are noindex', async () => {
    originServes()
    const res = await page('/reviews')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<title>Hot Takes · Jackson Film Club</title>')
    expect(metaMap(html)['og:url']).toEqual(['https://jxnfilm.club/reviews'])
    expect(metaMap(html).robots).toBeUndefined()

    originServes()
    expect(metaMap(await (await page('/signin?next=/speak')).text()).robots).toEqual(['noindex'])
  })

  it('the home page keeps the site name as its title', async () => {
    originServes(200)
    const res = await page('/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<title>Jackson Film Club</title>')
    expect(metaMap(html)['og:url']).toEqual(['https://jxnfilm.club/'])
  })

  it('passes through anything that is not an app page or not HTML', async () => {
    originServes(404, 'nope', 'text/plain')
    const res = await page('/members/extra/segments')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('nope')

    originServes(200, 'body{}', 'text/css')
    const css = await page('/events')
    expect(await css.text()).toBe('body{}')
  })

  it('fails open: a broken film lookup serves the shell untouched', async () => {
    originServes()
    const worker = (await import('../../worker/src/index.js')).default
    const ctx = { waitUntil() {}, passThroughOnException() {} }
    const brokenDb = { prepare() { throw new Error('D1 down') } }
    const res = await worker.fetch(new Request('https://jxnfilm.club/film?slug=you-can-see-everything'), { ...env, FILMS_DB: brokenDb }, ctx)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(SHELL)
  })

  it('escapes titles in attributes', async () => {
    const now = new Date().toISOString()
    await env.FILMS_DB.batch([
      env.FILMS_DB.prepare(`INSERT INTO films (slug, title, first_seen) VALUES ('tom-jerry', 'Tom & Jerry "Live" <b>', ?1)`).bind(now),
      env.FILMS_DB.prepare("INSERT INTO logs (id, entry_url, film_slug, member_key, watched_date, first_seen) VALUES (9, 'u9', 'tom-jerry', 'm1', '2026-10-01', ?1)").bind(now),
    ])
    originServes()
    const html = await (await page('/film?slug=tom-jerry')).text()
    expect(html).toContain('<meta property="og:title" content="Tom &amp; Jerry &quot;Live&quot; &lt;b&gt;">')
    expect(html).toContain('content="1 Jackson Film Club member has logged Tom &amp; Jerry &quot;Live&quot; &lt;b&gt;."')
    expect(html).not.toContain('<b>')
    expect(filmDescription({ film: { title: 'X', year: '1999' }, members: 2, avg: 3.04, screenings: [] }))
      .toBe('2 Jackson Film Club members have logged X (1999) · club average 3.0★.')
  })

  describe('events', () => {
    const MEETUP = {
      id: '2099-12-17-dune-part-three', title: 'DUNE Part 3 preview screening', film: 'Dune: Part Three', year: 2026,
      date: '2099-12-17', time: '15:05', venue: 'Malco Grandview & IMAX', kind: 'meetup',
      hostId: 'm-host', hostName: 'Hosty McHostface', poster: 'https://image.tmdb.org/t/p/w500/dune.jpg',
    }
    const EARLIER = { ...MEETUP, id: '2099-11-02-sooner', title: 'Sooner Screening', film: 'Sooner', date: '2099-11-02', time: '18:00', poster: '' }
    const HOUSE = { id: '2099-11-01-secret-night', title: 'Secret Night', film: 'Hidden', date: '2099-11-01', venue: "Alice Secretname's house", kind: 'house', hostId: 'm1', hostName: 'Alice Secretname' }
    const LEGACY_HOUSE = { id: '2099-10-30-old-house', title: 'Old Hosted Night', date: '2099-10-30', venue: 'Somewhere', hostId: 'm2' }
    const PAST_CLUB = { id: '2020-11-10-boys-state', title: 'November 2020 Screening', film: 'Boys State', year: 2020, date: '2020-11-10', venue: "Michael Lamb's house" }
    const seed = events => env.ATTENDANCE_KV.put('events:all', JSON.stringify(events))

    it('an event link previews that event: title, film, date, venue, poster', async () => {
      await seed([MEETUP, HOUSE, PAST_CLUB])
      originServes()
      const res = await page('/events?event=2099-12-17-dune-part-three')
      expect(res.status).toBe(200)
      const html = await res.text()
      const m = metaMap(html)
      expect(html).toContain('<title>DUNE Part 3 preview screening · Jackson Film Club</title>')
      expect(m.description).toEqual(['Dune: Part Three (2026) · Dec 17, 2099 at 3:05 PM · Malco Grandview &amp; IMAX. A Jackson Film Club event.'])
      expect(m['og:image']).toEqual(['https://image.tmdb.org/t/p/w500/dune.jpg'])
      // Unknown size, so no dimensions are claimed.
      expect(m['og:image:width']).toBeUndefined()
      expect(m['og:url']).toEqual(['https://jxnfilm.club/events?event=2099-12-17-dune-part-three'])
      expect(html).not.toContain('Hosty')
    })

    it('a house screening id gets exactly the tab preview an unknown id gets', async () => {
      await seed([MEETUP, EARLIER, HOUSE, LEGACY_HOUSE])
      const bodies = []
      for (const id of ['2099-11-01-secret-night', '2099-10-30-old-house', '2099-01-01-no-such-event', 'NOT AN ID']) {
        originServes()
        const res = await page('/events?event=' + encodeURIComponent(id))
        expect(res.status).toBe(200)
        bodies.push(await res.text())
      }
      expect(new Set(bodies).size).toBe(1)
      for (const secret of ['Secret Night', 'Secretname', 'Hidden', 'Old Hosted Night', 'Somewhere']) expect(bodies[0]).not.toContain(secret)
      expect(metaMap(bodies[0])['og:url']).toEqual(['https://jxnfilm.club/events'])
    })

    it('the Events tab leads with the next public screening, never a house one', async () => {
      await seed([MEETUP, EARLIER, HOUSE, PAST_CLUB])
      originServes()
      const m = metaMap(await (await page('/events')).text())
      expect(m['og:title']).toEqual(['Events'])
      expect(m.description[0]).toMatch(/^Next up: Sooner Screening · Sooner \(2026\) · Nov 2, 2099 at 6:00 PM · Malco Grandview &amp; IMAX\. Upcoming screenings/)
      // Sooner has no poster, so the logo stands in.
      expect(m['og:image']).toEqual(['https://jxnfilm.club/img/logo.png'])
      expect(m['og:image:width']).toEqual(['500'])
    })

    it('the Events tab falls back to its fixed description with nothing upcoming', async () => {
      await seed([PAST_CLUB, HOUSE])
      originServes()
      const m = metaMap(await (await page('/events')).text())
      expect(m.description[0]).toMatch(/^Upcoming screenings, house nights/)
    })

    it('a legacy club event shows no venue: those were mostly homes', () => {
      expect(eventSummary(PAST_CLUB)).toBe('Boys State (2020) · Nov 10, 2020')
      expect(eventSummary({ ...MEETUP, venue: "Jo's house" })).toBe('Dune: Part Three (2026) · Dec 17, 2099 at 3:05 PM')
      expect(eventSummary({ title: 'Trivia', kind: 'social', date: '2099-01-05', time: '09:00', venue: 'Fertile Ground' })).toBe('Jan 5, 2099 at 9:00 AM · Fertile Ground')
    })
  })

  it('leaves the join API alone', async () => {
    const res = await SELF.fetch('https://join.jxnfilm.club/privacy')
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('og:type')
  })
})
