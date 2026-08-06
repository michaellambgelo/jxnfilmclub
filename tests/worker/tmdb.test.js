import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

function req(path, { method = 'GET', body, token, headers = {} } = {}) {
  return SELF.fetch(`https://join.jxnfilm.club${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function getTokenFor(email) {
  const member = {
    id: 'id-' + email, email, name: 'M-' + email.split('@')[0], handle: null,
    pronouns: null, newsletter: false, joined: '2026-01-01',
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await req('/otp/verify', { method: 'POST', body: { email, code: '111111' } })
  return (await res.json()).token
}

const TMDB_FIXTURE = {
  results: [
    { id: 603, title: 'The Matrix', release_date: '1999-03-31', poster_path: '/matrix.jpg' },
    { id: 604, title: 'The Matrix Reloaded', release_date: '2003-05-15', poster_path: null },
    { id: 605, title: 'The Matrix Revolutions', release_date: '2003-11-05', poster_path: '/revolutions.jpg' },
  ],
}

afterEach(() => { vi.restoreAllMocks() })

describe('GET /tmdb/search — poster search proxy', () => {
  it('requires auth', async () => {
    const res = await req('/tmdb/search?q=matrix')
    expect(res.status).toBe(401)
  })

  it('empty query → empty results, no TMDB call', async () => {
    const token = await getTokenFor('poster@example.com')
    const fetchSpy = mockFetch(async () => { throw new Error('should not be called') })
    const res = await req('/tmdb/search?q=', { token })
    expect(res.status).toBe(200)
    expect((await res.json()).results).toEqual([])
  })

  it('returns trimmed results — poster-less entries dropped, full image URLs built', async () => {
    const token = await getTokenFor('poster@example.com')
    let calledUrl = null
    mockFetch(async (url) => {
      calledUrl = String(url)
      return new Response(JSON.stringify(TMDB_FIXTURE), { status: 200 })
    })
    const res = await req('/tmdb/search?q=matrix', { token })
    expect(res.status).toBe(200)
    const { results } = await res.json()
    expect(results).toHaveLength(2) // Reloaded (no poster_path) dropped
    expect(results[0]).toEqual({
      id: 603, title: 'The Matrix', year: '1999',
      poster: 'https://image.tmdb.org/t/p/w500/matrix.jpg',
      thumb: 'https://image.tmdb.org/t/p/w92/matrix.jpg',
    })
    // v3-style key rides as a query param; the query is passed through.
    expect(calledUrl).toContain('api.themoviedb.org/3/search/movie')
    expect(calledUrl).toContain('query=matrix')
    expect(calledUrl).toContain('api_key=test-tmdb-key')
  })

  it('TMDB failure → 502', async () => {
    const token = await getTokenFor('poster@example.com')
    mockFetch(async () => new Response('nope', { status: 500 }))
    const res = await req('/tmdb/search?q=matrix', { token })
    expect(res.status).toBe(502)
  })

  it('the API key never appears in the response', async () => {
    const token = await getTokenFor('poster@example.com')
    mockFetch(async () => new Response(JSON.stringify(TMDB_FIXTURE), { status: 200 }))
    const res = await req('/tmdb/search?q=matrix', { token })
    expect(await res.text()).not.toContain('test-tmdb-key')
  })
})

describe('GET /admin/tmdb/search — newsletter poster picker (ADMIN_TOKEN gate)', () => {
  it('rejects a missing or wrong bearer token', async () => {
    expect((await req('/admin/tmdb/search?q=matrix')).status).toBe(401)
    expect((await req('/admin/tmdb/search?q=matrix', { token: 'wrong' })).status).toBe(401)
  })

  it('returns the same trimmed results as the member route', async () => {
    mockFetch(async () => new Response(JSON.stringify(TMDB_FIXTURE), { status: 200 }))
    const res = await req('/admin/tmdb/search?q=matrix', { token: 'test-admin-token' })
    expect(res.status).toBe(200)
    const { results } = await res.json()
    expect(results).toHaveLength(2) // Reloaded (no poster_path) dropped
    expect(results[0]).toEqual({
      id: 603, title: 'The Matrix', year: '1999',
      poster: 'https://image.tmdb.org/t/p/w500/matrix.jpg',
      thumb: 'https://image.tmdb.org/t/p/w92/matrix.jpg',
    })
  })

  it('a member session token is not an admin token', async () => {
    const token = await getTokenFor('poster@example.com')
    mockFetch(async () => new Response(JSON.stringify(TMDB_FIXTURE), { status: 200 }))
    expect((await req('/admin/tmdb/search?q=matrix', { token })).status).toBe(401)
  })
})

const POSTERS_FIXTURE = {
  posters: [
    { file_path: '/main.jpg', iso_639_1: 'en' },
    { file_path: '/textless.jpg', iso_639_1: null },
    { file_path: null },
    ...Array.from({ length: 15 }, (_, i) => ({ file_path: `/alt${i}.jpg`, iso_639_1: 'en' })),
  ],
}

describe('GET /tmdb/posters — alternate posters for a confirmed film', () => {
  it('requires auth', async () => {
    const res = await req('/tmdb/posters?id=603')
    expect(res.status).toBe(401)
  })

  it('rejects a missing or non-numeric id', async () => {
    const token = await getTokenFor('poster@example.com')
    expect((await req('/tmdb/posters', { token })).status).toBe(400)
    expect((await req('/tmdb/posters?id=matrix', { token })).status).toBe(400)
    expect((await req('/tmdb/posters?id=../evil', { token })).status).toBe(400)
  })

  it('returns capped, mapped posters from the images endpoint', async () => {
    const token = await getTokenFor('poster@example.com')
    let calledUrl = null
    mockFetch(async (url) => {
      calledUrl = String(url)
      return new Response(JSON.stringify(POSTERS_FIXTURE), { status: 200 })
    })
    const res = await req('/tmdb/posters?id=603', { token })
    expect(res.status).toBe(200)
    const { posters } = await res.json()
    expect(posters).toHaveLength(12) // capped; null file_path dropped
    expect(posters[0]).toEqual({
      full: 'https://image.tmdb.org/t/p/w500/main.jpg',
      thumb: 'https://image.tmdb.org/t/p/w185/main.jpg',
    })
    expect(calledUrl).toContain('/movie/603/images')
    expect(calledUrl).toContain('api_key=test-tmdb-key')
  })

  it('TMDB failure → 502', async () => {
    const token = await getTokenFor('poster@example.com')
    mockFetch(async () => new Response('nope', { status: 500 }))
    const res = await req('/tmdb/posters?id=603', { token })
    expect(res.status).toBe(502)
  })
})
