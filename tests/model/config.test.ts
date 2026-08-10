import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// getConfig caches its result in a module-level promise, and the module
// decides browser-vs-node at import time (is_browser + resolveWorkerOrigin).
// So each test stubs a browser-ish global env FIRST, then re-imports the
// model fresh via vi.resetModules() to get an empty cache.

const ORIGIN = 'https://join.test'

const CONFIG = {
  theaters: ['The Capri Theater', 'Cinemark XD in Pearl'],
  podcast: { featured_id: 'abc123', episodes: [{ title: 'Ep', date: '2026-01-01', url: 'https://x' }] },
  copy: { heroLede: 'Custom lede', sectionProgram: 'On the Slate' },
}

async function loadModel() {
  vi.resetModules()
  return await import('../../model/index.ts')
}

beforeEach(() => {
  // Make the module treat the env as a browser and short-circuit origin
  // resolution before it touches location.
  vi.stubGlobal('window', {})
  vi.stubGlobal('JXNFC_WORKER_ORIGIN', ORIGIN)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getConfig', () => {
  it('fetches <worker origin>/config and returns the parsed object', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url)
      // /config is handled distinctly — anything else fails loudly.
      if (u === `${ORIGIN}/config`) {
        return new Response(JSON.stringify(CONFIG), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getConfig } = await loadModel()
    const cfg = await getConfig()

    expect(fetchMock).toHaveBeenCalledWith(`${ORIGIN}/config`)
    expect(cfg).toEqual(CONFIG)
  })

  it('returns null when the fetch rejects (network failure)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    const { getConfig } = await loadModel()
    await expect(getConfig()).resolves.toBeNull()
  })

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))

    const { getConfig } = await loadModel()
    await expect(getConfig()).resolves.toBeNull()
  })

  it('returns null on malformed (non-object) JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(['not', 'an', 'object']), { headers: { 'Content-Type': 'application/json' } })))

    const { getConfig } = await loadModel()
    await expect(getConfig()).resolves.toBeNull()
  })

  it('single-flight: two calls share one fetch and resolve to the same data', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === `${ORIGIN}/config`) {
        return new Response(JSON.stringify(CONFIG), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getConfig } = await loadModel()
    // Fire both before awaiting either — the in-flight promise must be shared.
    const [a, b] = await Promise.all([getConfig(), getConfig()])
    // And a later sequential call still reuses the cache.
    const c = await getConfig()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toEqual(CONFIG)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })
})
