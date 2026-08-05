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

const CUSTOM_AVATAR = 'https://a.ltrbxd.com/resized/avatar/upload/1/2/3/shard/avtr-0-1000-0-1000-crop.jpg?v=abc'
const DEFAULT_AVATAR = 'https://s.ltrbxd.com/static/img/avatar1000-BdGBhe59.png'

function profileHtml(ogImage) {
  return `<!doctype html><html><head><title>Profile</title>
    <meta property="og:type" content="profile">
    ${ogImage ? `<meta property="og:image" content="${ogImage}">` : ''}
    </head><body></body></html>`
}

beforeEach(async () => {
  await env.MEMBERS_KV.delete('avatars:cache')
})

afterEach(() => { vi.restoreAllMocks() })

describe('GET /avatars — Letterboxd avatar map via og:image', () => {
  it('returns a handle-keyed url map; unlinked members and default avatars skipped', async () => {
    await seedMembers([
      { id: 'a', name: 'A', handle: 'qa' },
      { id: 'b', name: 'B' },                    // no handle → skipped
      { id: 'c', name: 'C', handle: 'plain' },   // default avatar → skipped
    ])
    mockFetch(async (url) => {
      if (String(url) === 'https://letterboxd.com/qa/') return new Response(profileHtml(CUSTOM_AVATAR), { status: 200 })
      if (String(url) === 'https://letterboxd.com/plain/') return new Response(profileHtml(DEFAULT_AVATAR), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    })

    const res = await req('/avatars')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ qa: CUSTOM_AVATAR })
  })

  it('profiles without og:image or with non-OK responses are omitted', async () => {
    await seedMembers([
      { id: 'a', name: 'A', handle: 'noimg' },
      { id: 'b', name: 'B', handle: 'gone' },
    ])
    mockFetch(async (url) =>
      String(url).includes('/gone/') ? new Response('nope', { status: 404 }) : new Response(profileHtml(''), { status: 200 }))
    expect(await (await req('/avatars')).json()).toEqual({})
  })

  it('caches the map: second request makes no Letterboxd fetches', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const fetcher = vi.fn(async () => new Response(profileHtml(CUSTOM_AVATAR), { status: 200 }))
    mockFetch(fetcher)
    const res1 = await req('/avatars')
    expect(res1.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const res2 = await req('/avatars')
    expect(fetcher).toHaveBeenCalledTimes(1) // served from avatars:cache
    expect(await res2.json()).toEqual({ qa: CUSTOM_AVATAR })
  })

  it('a changed handle set invalidates the cache immediately (signature check)', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const fetcher = vi.fn(async (url) => {
      const handle = String(url).replace('https://letterboxd.com/', '').replace('/', '')
      return new Response(profileHtml(`https://a.ltrbxd.com/${handle}.jpg`), { status: 200 })
    })
    mockFetch(fetcher)
    expect(await (await req('/avatars')).json()).toEqual({ qa: 'https://a.ltrbxd.com/qa.jpg' })

    // A new member links a handle — the stale 7-day cache must not hide them.
    await seedMembers([
      { id: 'a', name: 'A', handle: 'qa' },
      { id: 'b', name: 'B', handle: 'newbie' },
    ])
    const data = await (await req('/avatars')).json()
    expect(data).toEqual({ qa: 'https://a.ltrbxd.com/qa.jpg', newbie: 'https://a.ltrbxd.com/newbie.jpg' })
  })

  it('concurrent cold-cache requests coalesce into one upstream fan-out', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const fetcher = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 100))
      return new Response(profileHtml(CUSTOM_AVATAR), { status: 200 })
    })
    mockFetch(fetcher)
    const [r1, , r3] = await Promise.all([req('/avatars'), req('/avatars'), req('/avatars')])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await r1.json()).toEqual({ qa: CUSTOM_AVATAR })
    expect(await r3.json()).toEqual({ qa: CUSTOM_AVATAR })
  })

  it('a total miss is not cached — the next request retries upstream', async () => {
    await seedMembers([{ id: 'a', name: 'A', handle: 'qa' }])
    const failing = vi.fn(async () => new Response('nope', { status: 500 }))
    mockFetch(failing)
    expect(await (await req('/avatars')).json()).toEqual({})
    expect(await env.MEMBERS_KV.get('avatars:cache')).toBeNull()
    await req('/avatars')
    expect(failing).toHaveBeenCalledTimes(2) // no poisoned cache
  })

  it('no linked handles → empty map, no upstream fetches', async () => {
    await seedMembers([{ id: 'b', name: 'B' }])
    const fetcher = vi.fn(async () => { throw new Error('should not be called') })
    mockFetch(fetcher)
    expect(await (await req('/avatars')).json()).toEqual({})
    expect(fetcher).not.toHaveBeenCalled()
  })
})
