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

function rssItem({ guid, title, link, film, year, date, poster }) {
  return `<item>
    <title>${title}</title>
    <link>${link}</link>
    <guid isPermaLink="false">${guid}</guid>
    ${film ? `<letterboxd:filmTitle>${film}</letterboxd:filmTitle>` : ''}
    ${year ? `<letterboxd:filmYear>${year}</letterboxd:filmYear>` : ''}
    ${date ? `<letterboxd:watchedDate>${date}</letterboxd:watchedDate>` : ''}
    <description><![CDATA[${poster ? `<p><img src="${poster}"/></p>` : ''}<p>Watched.</p>]]></description>
  </item>`
}

function rssFeed(items) {
  return `<?xml version="1.0"?><rss><channel><title>feed</title>${items.join('\n')}</channel></rss>`
}

const QA_FEED = rssFeed([
  rssItem({ guid: 'letterboxd-list-1', title: 'A list', link: 'https://letterboxd.com/qa/list/x/' }),
  rssItem({ guid: 'letterboxd-review-1', title: 'Film One, 2026', link: 'https://letterboxd.com/qa/film/film-one/',
    film: 'Film One &amp; a Half', year: '2026', date: '2026-07-26', poster: 'https://a.ltrbxd.com/one.jpg' }),
  rssItem({ guid: 'letterboxd-watch-2', title: 'Film Two', link: 'https://letterboxd.com/qa/film/film-two/',
    film: 'Film Two', year: '2025', date: '2026-07-25' }),
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
    expect(data.qa).toHaveLength(4) // list item skipped, capped at 4 (Five dropped)
    expect(data.qa[0]).toEqual({
      title: 'Film One & a Half',
      year: '2026',
      link: 'https://letterboxd.com/qa/film/film-one/',
      watched_date: '2026-07-26',
      poster: 'https://a.ltrbxd.com/one.jpg',
    })
    expect(data.qa[1].poster).toBeUndefined()
    expect(data.qa.map(f => f.title)).toEqual(['Film One & a Half', 'Film Two', 'Film Three', 'Film Four'])
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

  it('a failing feed drops only that handle; a total miss is not cached', async () => {
    await seedMembers([
      { id: 'a', name: 'A', handle: 'qa' },
      { id: 'b', name: 'B', handle: 'down' },
    ])
    mockFetch(async (url) =>
      String(url).includes('/down/') ? new Response('nope', { status: 500 }) : new Response(QA_FEED, { status: 200 }))
    const data = await (await req('/watched')).json()
    expect(Object.keys(data)).toEqual(['qa'])

    // Total outage: nothing cached, so the next request retries upstream.
    await env.MEMBERS_KV.delete('watched:cache')
    const failing = vi.fn(async () => new Response('nope', { status: 500 }))
    mockFetch(failing)
    expect(await (await req('/watched')).json()).toEqual({})
    expect(await env.MEMBERS_KV.get('watched:cache')).toBeNull()
    await req('/watched')
    expect(failing).toHaveBeenCalledTimes(4) // 2 handles × 2 requests — no poisoned cache
  })

  it('no linked handles → empty map, no upstream fetches', async () => {
    await seedMembers([{ id: 'b', name: 'B' }])
    const fetcher = vi.fn(async () => { throw new Error('should not be called') })
    mockFetch(fetcher)
    expect(await (await req('/watched')).json()).toEqual({})
    expect(fetcher).not.toHaveBeenCalled()
  })
})
