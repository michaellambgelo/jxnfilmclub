import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

function req(path) {
  return SELF.fetch(`https://join.jxnfilm.club${path}`)
}

async function seedMembers(members) {
  await env.MEMBERS_KV.put('members:bootstrapped', '1')
  await env.MEMBERS_KV.put('members:all', JSON.stringify(members))
}

function rssFeed(films) {
  const items = films.map(f => `<item>
    <title>${f.title}</title>
    <link>https://letterboxd.com/${f.handle}/film/${f.slug}/</link>
    <guid isPermaLink="false">letterboxd-watch-${f.slug}</guid>
    <letterboxd:filmTitle>${f.title}</letterboxd:filmTitle>
    <letterboxd:watchedDate>2026-07-26</letterboxd:watchedDate>
  </item>`)
  return `<?xml version="1.0"?><rss><channel><title>feed</title>${items.join('\n')}</channel></rss>`
}

const AVATAR_HTML = '<img src="https://a.ltrbxd.com/resized/avatar/upload/1/2/avtr-0-48-0-48-crop.jpg?v=1" />'

// Dates relative to the real UTC clock — no fake timers in the Workers pool.
const daysAgo = n => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10)

// Parse exposition text into { 'name{labels}': value } for exact lookups.
function parseProm(text) {
  const out = {}
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const i = line.lastIndexOf(' ')
    out[line.slice(0, i)] = Number(line.slice(i + 1))
  }
  return out
}

// Routes each handle to a scripted upstream behavior.
function scriptedFetch(byHandle) {
  return async (url) => {
    const handle = new URL(String(url)).pathname.split('/')[1]
    const b = byHandle[handle]
    if (b === 'throw') throw new TypeError('network down')
    if (b === 403) return new Response('<title>Just a moment...</title>', { status: 403 })
    if (b === 500) return new Response('nope', { status: 500 })
    return new Response(b, { status: 200 })
  }
}

const MEMBERS = [
  { id: 'a', name: 'A', handle: 'okay' },
  { id: 'b', name: 'B', handle: 'blocked' },
  { id: 'c', name: 'C', handle: 'broken' },
  { id: 'd', name: 'D', handle: 'offline' },
  { id: 'e', name: 'E' },
]

beforeEach(async () => {
  await env.MEMBERS_KV.delete('watched:cache')
  await env.MEMBERS_KV.delete('avatars:cache')
  await env.MEMBERS_KV.delete('members:all')
})

afterEach(() => { vi.restoreAllMocks() })

describe('cache builds record per-build fetch stats', () => {
  it('watched:cache counts ok / 403 / 500 / throw, and carried for handles with history', async () => {
    await seedMembers(MEMBERS)
    // Prior record: `blocked` and `offline` have last-good data, `broken` doesn't.
    const prior = [{ title: 'Old', link: 'https://letterboxd.com/x/film/old/' }]
    await env.MEMBERS_KV.put('watched:cache', JSON.stringify({
      map: { blocked: prior, offline: prior }, fetchedAt: Date.now() - 3600_000,
    }))
    mockFetch(scriptedFetch({
      okay: rssFeed([{ handle: 'okay', slug: 'one', title: 'One' }]),
      blocked: 403, broken: 500, offline: 'throw',
    }))
    const before = Date.now()
    expect((await req('/watched')).status).toBe(200)
    const rec = JSON.parse(await env.MEMBERS_KV.get('watched:cache'))
    expect(rec.stats).toEqual({ ok: 1, forbidden: 1, http_error: 1, network_error: 1, carried: 2 })
    expect(rec.builtAt).toBeGreaterThanOrEqual(before)
    expect(rec.fetchedAt).toBe(rec.builtAt) // one success → a fresh build
    expect(rec.missAt).toBeUndefined()
    expect(Object.keys(rec.map).sort()).toEqual(['blocked', 'offline', 'okay'])
  })

  it('a total miss still stamps builtAt + stats while fetchedAt stays on the last good build', async () => {
    await seedMembers([{ id: 'b', name: 'B', handle: 'blocked' }])
    const lastGood = Date.now() - 3600_000
    await env.MEMBERS_KV.put('watched:cache', JSON.stringify({
      map: { blocked: [{ title: 'Old', link: 'https://letterboxd.com/blocked/film/old/' }] }, fetchedAt: lastGood,
    }))
    mockFetch(scriptedFetch({ blocked: 403 }))
    await req('/watched')
    const rec = JSON.parse(await env.MEMBERS_KV.get('watched:cache'))
    expect(rec.fetchedAt).toBe(lastGood)
    expect(rec.missAt).toBe(rec.builtAt)
    expect(rec.stats).toEqual({ ok: 0, forbidden: 1, http_error: 0, network_error: 0, carried: 1 })
  })

  it('avatars:cache records the same outcome counts', async () => {
    await seedMembers(MEMBERS)
    await env.MEMBERS_KV.put('avatars:cache', JSON.stringify({
      sig: 'stale', map: { offline: 'https://a.ltrbxd.com/old.jpg' }, fetchedAt: 0,
    }))
    mockFetch(scriptedFetch({ okay: AVATAR_HTML, blocked: 403, broken: 500, offline: 'throw' }))
    expect((await req('/avatars')).status).toBe(200)
    const rec = JSON.parse(await env.MEMBERS_KV.get('avatars:cache'))
    expect(rec.stats).toEqual({ ok: 1, forbidden: 1, http_error: 1, network_error: 1, carried: 1 })
    expect(typeof rec.builtAt).toBe('number')
  })
})

describe('GET /metrics', () => {
  async function seedActivity() {
    await seedMembers([
      { id: 'a', name: 'Alice Secretname', email: 'alice@example.com', handle: 'zzsecrethandle' },
      { id: 'b', name: 'B', handle: 'bee' },
      { id: 'c', name: 'C', handle: 'sea' },
      { id: 'd', name: 'D' },
    ])
    const lb = (h, slug, extra = {}) => ({ title: `Title ${slug}`, year: '2026', link: `https://letterboxd.com/${h}/film/${slug}/`, ...extra })
    await env.MEMBERS_KV.put('watched:cache', JSON.stringify({
      map: {
        zzsecrethandle: [
          lb('zzsecrethandle', 'unmistakable-film-title', { watched_date: daysAgo(0), rating: '4.5', liked: true }),
          lb('zzsecrethandle', 'shared-one', { watched_date: daysAgo(6), rating: '3.0' }), // 7d boundary: in
          lb('zzsecrethandle', 'month-only', { watched_date: daysAgo(7), rewatch: true }),  // 7d boundary: out
          lb('zzsecrethandle', 'ancient', { watched_date: daysAgo(45), rating: '5.0' }),    // neither window
          lb('zzsecrethandle', 'undated'),                                                  // no watched_date
        ],
        bee: [
          // Same film as zzsecrethandle, logged a second time (/1/ suffix).
          { title: 'Title shared-one', link: 'https://letterboxd.com/bee/film/shared-one/1/', watched_date: daysAgo(2), rating: '4', liked: true },
          lb('bee', 'month-only', { watched_date: daysAgo(29) }), // 30d boundary: in
        ],
        sea: [
          lb('sea', 'way-back', { watched_date: daysAgo(30), rating: '9' }), // 30d boundary: out; bogus rating
        ],
      },
      fetchedAt: 1_760_000_000_000,
      builtAt: 1_760_000_300_000,
      missAt: 1_760_000_300_000,
      stats: { ok: 0, forbidden: 3, http_error: 0, network_error: 0, carried: 3 },
    }))
    await env.MEMBERS_KV.put('avatars:cache', JSON.stringify({
      sig: 'bee,sea,zzsecrethandle', map: { bee: 'https://a.ltrbxd.com/b.jpg' }, fetchedAt: 1_760_000_000_000,
    }))
  }

  it('serves Prometheus text from KV only, with no Letterboxd fetches and no Origin needed', async () => {
    await seedActivity()
    const fetcher = vi.fn(async () => { throw new Error('metrics must not fetch upstream') })
    mockFetch(fetcher)
    const res = await req('/metrics')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/plain; version=0.0.4')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(fetcher).not.toHaveBeenCalled()
    const text = await res.text()
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('# TYPE jxnfc_club_diary_entries gauge')

    // Every sample's metric name is preceded by its own HELP/TYPE header,
    // and a name's samples are contiguous.
    const seen = new Set()
    let current = null
    for (const line of text.trim().split('\n')) {
      const t = /^# TYPE (\S+) gauge$/.exec(line)
      if (t) { expect(seen.has(t[1])).toBe(false); seen.add(t[1]); current = t[1]; continue }
      if (line.startsWith('#')) continue
      expect(line.split(/[{ ]/)[0]).toBe(current)
    }
  })

  it('reports cache health from the stored records', async () => {
    await seedActivity()
    const m = parseProm(await (await req('/metrics')).text())
    expect(m['jxnfc_letterboxd_cache_fetched_timestamp_seconds{cache="watched"}']).toBe(1_760_000_000)
    expect(m['jxnfc_letterboxd_cache_built_timestamp_seconds{cache="watched"}']).toBe(1_760_000_300)
    expect(m['jxnfc_letterboxd_cache_miss_active{cache="watched"}']).toBe(1)
    expect(m['jxnfc_letterboxd_cache_miss_active{cache="avatars"}']).toBe(0)
    expect(m['jxnfc_letterboxd_cache_built_timestamp_seconds{cache="avatars"}']).toBe(0) // pre-stats record
    expect(m['jxnfc_letterboxd_last_build_fetches{cache="watched",outcome="forbidden"}']).toBe(3)
    expect(m['jxnfc_letterboxd_last_build_fetches{cache="watched",outcome="carried"}']).toBe(3)
    expect(m['jxnfc_letterboxd_last_build_fetches{cache="watched",outcome="ok"}']).toBe(0)
    // No stats on the avatars record yet → its outcome series are omitted.
    expect(Object.keys(m).some(k => k.startsWith('jxnfc_letterboxd_last_build_fetches{cache="avatars"'))).toBe(false)
    expect(m['jxnfc_letterboxd_cache_handles{cache="watched"}']).toBe(3)
    expect(m['jxnfc_letterboxd_cache_handles{cache="avatars"}']).toBe(1)
    expect(m['jxnfc_members_total']).toBe(4)
    expect(m['jxnfc_members_linked']).toBe(3)
  })

  it('windows club activity by watched_date: 7d = today-6..today, 30d = today-29..today', async () => {
    await seedActivity()
    const m = parseProm(await (await req('/metrics')).text())
    // 7d: unmistakable(0), shared-one(6), bee shared-one(2)
    expect(m['jxnfc_club_diary_entries{window="7d"}']).toBe(3)
    expect(m['jxnfc_club_active_members{window="7d"}']).toBe(2)
    expect(m['jxnfc_club_liked_entries{window="7d"}']).toBe(2)
    expect(m['jxnfc_club_rewatch_entries{window="7d"}']).toBe(0)
    expect(m['jxnfc_club_shared_films{window="7d"}']).toBe(1) // shared-one, keyed by slug despite /1/
    expect(m['jxnfc_club_rated_entries{window="7d",rating="4.5"}']).toBe(1)
    expect(m['jxnfc_club_rated_entries{window="7d",rating="3.0"}']).toBe(1)
    expect(m['jxnfc_club_rated_entries{window="7d",rating="4.0"}']).toBe(1) // "4" normalized
    expect(m['jxnfc_club_rated_entries{window="7d",rating="5.0"}']).toBe(0)
    expect(m['jxnfc_club_rating_sum{window="7d"}']).toBe(11.5)
    // 30d adds month-only(7, rewatch) and bee month-only(29); sea's day-30 entry is out.
    expect(m['jxnfc_club_diary_entries{window="30d"}']).toBe(5)
    expect(m['jxnfc_club_active_members{window="30d"}']).toBe(2)
    expect(m['jxnfc_club_rewatch_entries{window="30d"}']).toBe(1)
    expect(m['jxnfc_club_shared_films{window="30d"}']).toBe(2)
    expect(m['jxnfc_club_rating_sum{window="30d"}']).toBe(11.5)
    // The rating label is a closed set of ten half-star values per window.
    const ratingLabels = Object.keys(m).filter(k => k.startsWith('jxnfc_club_rated_entries{window="30d"'))
    expect(ratingLabels).toHaveLength(10)
  })

  it('never leaks a handle, name, email or film title', async () => {
    await seedActivity()
    const text = await (await req('/metrics')).text()
    for (const s of ['zzsecrethandle', 'bee', 'sea', 'Secretname', 'alice@', 'unmistakable', 'Title', 'letterboxd.com', 'shared-one']) {
      expect(text).not.toContain(s)
    }
    // Only the four bounded label keys ever appear.
    const keys = new Set([...text.matchAll(/[{,]([a-z_]+)="/g)].map(x => x[1]))
    expect([...keys].sort()).toEqual(['cache', 'outcome', 'rating', 'window'])
  })

  it('renders zeros (not an error) with empty KV', async () => {
    const res = await req('/metrics')
    expect(res.status).toBe(200)
    const m = parseProm(await res.text())
    expect(m['jxnfc_letterboxd_cache_fetched_timestamp_seconds{cache="watched"}']).toBe(0)
    expect(m['jxnfc_members_total']).toBe(0)
    expect(m['jxnfc_club_diary_entries{window="7d"}']).toBe(0)
  })
})
