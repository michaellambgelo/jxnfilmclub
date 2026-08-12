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

function rssItem({ guid, title, link, film, year, date, poster, rating, liked, rewatch }) {
  return `<item>
    <title>${title}</title>
    <link>${link}</link>
    <guid isPermaLink="false">${guid}</guid>
    ${film ? `<letterboxd:filmTitle>${film}</letterboxd:filmTitle>` : ''}
    ${year ? `<letterboxd:filmYear>${year}</letterboxd:filmYear>` : ''}
    ${date ? `<letterboxd:watchedDate>${date}</letterboxd:watchedDate>` : ''}
    ${rating ? `<letterboxd:memberRating>${rating}</letterboxd:memberRating>` : ''}
    ${liked !== undefined ? `<letterboxd:memberLike>${liked}</letterboxd:memberLike>` : ''}
    ${rewatch !== undefined ? `<letterboxd:rewatch>${rewatch}</letterboxd:rewatch>` : ''}
    <description><![CDATA[${poster ? `<p><img src="${poster}"/></p>` : ''}<p>Watched.</p>]]></description>
  </item>`
}

function rssFeed(items) {
  return `<?xml version="1.0"?><rss><channel><title>feed</title>${items.join('\n')}</channel></rss>`
}

const QA_FEED = rssFeed([
  rssItem({ guid: 'letterboxd-list-1', title: 'A list', link: 'https://letterboxd.com/qa/list/x/' }),
  rssItem({ guid: 'letterboxd-review-1', title: 'Film One, 2026', link: 'https://letterboxd.com/qa/film/film-one/',
    film: 'Film One &amp; a Half', year: '2026', date: '2026-07-26', poster: 'https://a.ltrbxd.com/one.jpg',
    rating: '4.5', liked: 'Yes', rewatch: 'Yes' }),
  rssItem({ guid: 'letterboxd-watch-2', title: 'Film Two', link: 'https://letterboxd.com/qa/film/film-two/',
    film: 'Film Two', year: '2025', date: '2026-07-25', liked: 'No', rewatch: 'No' }),
  rssItem({ guid: 'letterboxd-watch-3', title: 'Film Three', link: 'https://letterboxd.com/qa/film/film-three/', film: 'Film Three' }),
  rssItem({ guid: 'letterboxd-watch-4', title: 'Film Four', link: 'https://letterboxd.com/qa/film/film-four/', film: 'Film Four' }),
  rssItem({ guid: 'letterboxd-watch-5', title: 'Film Five', link: 'https://letterboxd.com/qa/film/film-five/', film: 'Film Five' }),
])

beforeEach(async () => {
  await env.MEMBERS_KV.delete('watched:cache')
})

afterEach(() => { vi.restoreAllMocks() })

describe('GET /watched — live Last Four via the Worker', () => {
  it('returns a handle-keyed map: last four non-list items, parsed fields, entities unescaped', async () => {
    await seedMembers([
      { id: 'a', name: 'A', handle: 'qa' },
      { id: 'b', name: 'B' }, // no handle → skipped
    ])
    mockFetch(async (url) => {
      expect(String(url)).toBe('https://letterboxd.com/qa/rss/')
      return new Response(QA_FEED, { status: 200 })
    })

    const res = await req('/watched')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Object.keys(data)).toEqual(['qa'])
    expect(data.qa).toHaveLength(5) // list item skipped; depth 12 keeps all five films
    expect(data.qa[0]).toEqual({
      title: 'Film One & a Half',
      year: '2026',
      link: 'https://letterboxd.com/qa/film/film-one/',
      watched_date: '2026-07-26',
      rating: '4.5',
      liked: true,
      rewatch: true,
      poster: 'https://a.ltrbxd.com/one.jpg',
    })
    expect(data.qa[1].poster).toBeUndefined()
    // memberLike No → no liked field; absent memberRating → no rating field.
    expect(data.qa[1].liked).toBeUndefined()
    expect(data.qa[1].rating).toBeUndefined()
    // rewatch No → no field; absent tag (Film Three) → no field either.
    expect(data.qa[1].rewatch).toBeUndefined()
    expect(data.qa[2].rewatch).toBeUndefined()
    expect(data.qa.map(f => f.title)).toEqual(['Film One & a Half', 'Film Two', 'Film Three', 'Film Four', 'Film Five'])
  })

  it('caps each feed at 12 films so the club strip sees a full active week', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const items = []
    for (let i = 1; i <= 15; i++) {
      items.push(rssItem({ guid: `letterboxd-watch-${i}`, title: `Film ${i}`,
        link: `https://letterboxd.com/qa/film/f${i}/`, film: `Film ${i}` }))
    }
    mockFetch(async () => new Response(rssFeed(items), { status: 200 }))
    const data = await (await req('/watched')).json()
    expect(data.qa).toHaveLength(12)
    expect(data.qa[0].title).toBe('Film 1')
    expect(data.qa[11].title).toBe('Film 12')
  })

  it('caches the aggregate: a second request makes no Letterboxd fetches', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const fetcher = vi.fn(async () => new Response(QA_FEED, { status: 200 }))
    mockFetch(fetcher)
    const res1 = await req('/watched')
    expect(res1.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const res2 = await req('/watched')
    expect(fetcher).toHaveBeenCalledTimes(1) // served from watched:cache
    expect(Object.keys(await res2.json())).toEqual(['qa'])
  })

  it('concurrent cold-cache requests coalesce into one upstream fan-out', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const fetcher = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 100))
      return new Response(QA_FEED, { status: 200 })
    })
    mockFetch(fetcher)
    const [r1, r2, r3] = await Promise.all([req('/watched'), req('/watched'), req('/watched')])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(Object.keys(await r1.json())).toEqual(['qa'])
    expect(Object.keys(await r3.json())).toEqual(['qa'])
  })

  it('a failing feed with no history drops only that handle', async () => {
    await seedMembers([
      { id: 'a', name: 'A', handle: 'qa' },
      { id: 'b', name: 'B', handle: 'down' },
    ])
    mockFetch(async (url) =>
      String(url).includes('/down/') ? new Response('nope', { status: 500 }) : new Response(QA_FEED, { status: 200 }))
    const data = await (await req('/watched')).json()
    expect(Object.keys(data)).toEqual(['qa'])
  })

  it('stale-while-error: a total miss serves the last good map, keeps it stored, and backs off retries', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const lastGood = { qa: [{ title: 'Old Film', link: 'https://letterboxd.com/qa/film/old/' }] }
    // Stale record (fetchedAt beyond the 900s window) from before the outage.
    await env.MEMBERS_KV.put('watched:cache', JSON.stringify({ map: lastGood, fetchedAt: Date.now() - 3600_000 }))

    const failing = vi.fn(async () => new Response('nope', { status: 500 }))
    mockFetch(failing)
    expect(await (await req('/watched')).json()).toEqual(lastGood)
    expect(failing).toHaveBeenCalledTimes(1)

    // The record survives the failed rebuild — stamped with missAt, map intact.
    const rec = JSON.parse(await env.MEMBERS_KV.get('watched:cache'))
    expect(rec.map).toEqual(lastGood)
    expect(rec.missAt).toBeTruthy()

    // Backoff: the next request serves stale without re-firing the fan-out.
    expect(await (await req('/watched')).json()).toEqual(lastGood)
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('stale-while-error: a partial outage carries failed handles forward and updates the rest', async () => {
    // gonefromclub is in the old cache but no longer in the membership.
    await seedMembers([
      { id: 'a', name: 'A', handle: 'qa' },
      { id: 'b', name: 'B', handle: 'down' },
    ])
    const downOld = [{ title: 'Down Old', link: 'https://letterboxd.com/down/film/x/' }]
    const goneOld = [{ title: 'Gone', link: 'https://letterboxd.com/gonefromclub/film/y/' }]
    await env.MEMBERS_KV.put('watched:cache', JSON.stringify({
      map: { qa: [{ title: 'Qa Old', link: 'https://letterboxd.com/qa/film/z/' }], down: downOld, gonefromclub: goneOld },
      fetchedAt: Date.now() - 3600_000,
    }))
    mockFetch(async (url) =>
      String(url).includes('/down/') ? new Response('nope', { status: 500 }) : new Response(QA_FEED, { status: 200 }))

    const data = await (await req('/watched')).json()
    expect(data.qa.map(f => f.title)[0]).toBe('Film One & a Half')  // refetched fresh
    expect(data.down).toEqual(downOld)                              // carried forward
    expect(data.gonefromclub).toBeUndefined()                       // no longer a member handle

    // Any successful fetch counts as a fresh build — no missAt stamp.
    const rec = JSON.parse(await env.MEMBERS_KV.get('watched:cache'))
    expect(rec.missAt).toBeUndefined()
  })

  it('legacy bare-map records read as stale-but-present and upgrade on rebuild', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    await env.MEMBERS_KV.put('watched:cache', JSON.stringify({ qa: [{ title: 'Legacy', link: 'https://letterboxd.com/qa/film/l/' }] }))
    const fetcher = vi.fn(async () => new Response(QA_FEED, { status: 200 }))
    mockFetch(fetcher)
    const data = await (await req('/watched')).json()
    expect(fetcher).toHaveBeenCalledTimes(1)  // legacy = stale → rebuilt
    expect(data.qa[0].title).toBe('Film One & a Half')
    const rec = JSON.parse(await env.MEMBERS_KV.get('watched:cache'))
    expect(rec.fetchedAt).toBeTruthy()        // upgraded to the new shape
  })

  it('no linked handles → empty map, no upstream fetches', async () => {
    await seedMembers([{ id: 'b', name: 'B' }])
    const fetcher = vi.fn(async () => { throw new Error('should not be called') })
    mockFetch(fetcher)
    expect(await (await req('/watched')).json()).toEqual({})
    expect(fetcher).not.toHaveBeenCalled()
  })
})
