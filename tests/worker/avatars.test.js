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

// The scrape targets /{handle}/films/ (the profile root is behind
// Letterboxd's bot challenge since Aug 2026). The page's og:image is a
// generic share card — the real avatar is the header <img>. The worker
// rewrites the size segment to 80px.
const AVATAR_IMG = (id) => `https://a.ltrbxd.com/resized/avatar/upload/${id}/shard/avtr-0-48-0-48-crop.jpg?v=abc`
const UPSIZED = (id) => `https://a.ltrbxd.com/resized/avatar/upload/${id}/shard/avtr-0-80-0-80-crop.jpg?v=abc`
const DEFAULT_AVATAR = 'https://s.ltrbxd.com/static/img/avatar1000-BdGBhe59.png'

function filmsHtml(avatarSrc) {
  return `<!doctype html><html><head><title>Films</title>
    <meta property="og:image" content="https://s.ltrbxd.com/static/img/default-share-7md9L34t.png">
    </head><body>
    ${avatarSrc ? `<img src="${avatarSrc}" alt="Member" width="24" height="24" />` : ''}
    </body></html>`
}

beforeEach(async () => {
  await env.MEMBERS_KV.delete('avatars:cache')
})

afterEach(() => { vi.restoreAllMocks() })

describe('GET /avatars — Letterboxd avatar map via the films subpage', () => {
  it('returns a handle-keyed 80px url map; unlinked members and default avatars skipped', async () => {
    await seedMembers([
      { id: 'a', name: 'A', handle: 'qa' },
      { id: 'b', name: 'B' },                    // no handle → skipped
      { id: 'c', name: 'C', handle: 'plain' },   // default avatar → skipped
    ])
    mockFetch(async (url) => {
      if (String(url) === 'https://letterboxd.com/qa/films/') return new Response(filmsHtml(AVATAR_IMG('1/2/3')), { status: 200 })
      if (String(url) === 'https://letterboxd.com/plain/films/') return new Response(filmsHtml(DEFAULT_AVATAR), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    })

    const res = await req('/avatars')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ qa: UPSIZED('1/2/3') })
  })

  it('the generic og:image share card is never mistaken for an avatar; non-OK responses omitted', async () => {
    await seedMembers([
      { id: 'a', name: 'A', handle: 'noimg' },
      { id: 'b', name: 'B', handle: 'gone' },
    ])
    mockFetch(async (url) =>
      String(url).includes('/gone/') ? new Response('nope', { status: 404 }) : new Response(filmsHtml(''), { status: 200 }))
    expect(await (await req('/avatars')).json()).toEqual({})
  })

  it('caches the map: second request makes no Letterboxd fetches', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const fetcher = vi.fn(async () => new Response(filmsHtml(AVATAR_IMG('1/2/3')), { status: 200 }))
    mockFetch(fetcher)
    const res1 = await req('/avatars')
    expect(res1.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const res2 = await req('/avatars')
    expect(fetcher).toHaveBeenCalledTimes(1) // served from avatars:cache
    expect(await res2.json()).toEqual({ qa: UPSIZED('1/2/3') })
  })

  it('a changed handle set invalidates the cache immediately (signature check)', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const fetcher = vi.fn(async (url) => {
      const handle = String(url).replace('https://letterboxd.com/', '').replace('/films/', '')
      return new Response(filmsHtml(AVATAR_IMG(handle)), { status: 200 })
    })
    mockFetch(fetcher)
    expect(await (await req('/avatars')).json()).toEqual({ qa: UPSIZED('qa') })

    // A new member links a handle — the stale 7-day cache must not hide them.
    await seedMembers([
      { id: 'a', name: 'A', handle: 'qa' },
      { id: 'b', name: 'B', handle: 'newbie' },
    ])
    const data = await (await req('/avatars')).json()
    expect(data).toEqual({ qa: UPSIZED('qa'), newbie: UPSIZED('newbie') })
  })

  it('concurrent cold-cache requests coalesce into one upstream fan-out', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const fetcher = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 100))
      return new Response(filmsHtml(AVATAR_IMG('1/2/3')), { status: 200 })
    })
    mockFetch(fetcher)
    const [r1, , r3] = await Promise.all([req('/avatars'), req('/avatars'), req('/avatars')])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await r1.json()).toEqual({ qa: UPSIZED('1/2/3') })
    expect(await r3.json()).toEqual({ qa: UPSIZED('1/2/3') })
  })

  it('a total miss is negative-cached briefly — page loads stop re-firing the fan-out', async () => {
    // Pre-challenge behavior never cached a total miss, which meant every
    // /avatars request re-fired one doomed fetch per member while Letterboxd
    // was unreachable. Now the empty map is cached (short TTL) and the sig
    // check still busts it when membership changes.
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const failing = vi.fn(async () => new Response('nope', { status: 403 }))
    mockFetch(failing)
    expect(await (await req('/avatars')).json()).toEqual({})
    expect(await env.MEMBERS_KV.get('avatars:cache')).not.toBeNull()
    await req('/avatars')
    expect(failing).toHaveBeenCalledTimes(1) // served from the negative cache
  })

  it('no linked handles → empty map, no upstream fetches', async () => {
    await seedMembers([{ id: 'b', name: 'B' }])
    const fetcher = vi.fn(async () => { throw new Error('should not be called') })
    mockFetch(fetcher)
    expect(await (await req('/avatars')).json()).toEqual({})
    expect(fetcher).not.toHaveBeenCalled()
  })
})
