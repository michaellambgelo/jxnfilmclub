import { afterEach, describe, expect, it, vi } from 'vitest'
import { filmCountLine, filmSlug, shapeFilmPage, shapeStrip, shapeStripCard } from '../../model/index.ts'

// docs/features/film-stats.md. The slug rule is mirrored in the Worker's
// ingest, so its edge cases are pinned here explicitly.

describe('filmSlug', () => {
  it('takes the slug from a diary entry link', () => {
    expect(filmSlug('https://letterboxd.com/michaellamb/film/clayface/')).toBe('clayface')
    expect(filmSlug('https://letterboxd.com/michaellamb/film/visitor-3/')).toBe('visitor-3')
  })

  it('drops a trailing rewatch counter', () => {
    expect(filmSlug('https://letterboxd.com/michaellamb/film/nosferatu-2024/3/')).toBe('nosferatu-2024')
    expect(filmSlug('https://letterboxd.com/a_b/film/1917/12/')).toBe('1917')
  })

  it('returns null for anything that is not a diary entry link', () => {
    expect(filmSlug('https://letterboxd.com/film/clayface/')).toBeNull()
    expect(filmSlug('https://letterboxd.com/michaellamb/film/clayface')).toBeNull()
    expect(filmSlug('https://letterboxd.com/michaellamb/film/clayface/3')).toBeNull()
    expect(filmSlug('https://letterboxd.com/michaellamb/film/clayface/reviews/')).toBeNull()
    expect(filmSlug('https://letterboxd.com/michaellamb/list/clayface/')).toBeNull()
    expect(filmSlug('https://boxd.it/abc')).toBeNull()
    expect(filmSlug('https://example.com/x/film/clayface/')).toBeNull()
    // Same edges as worker/src/films.js: https only, bare host, lowercase slug.
    expect(filmSlug('http://letterboxd.com/a/film/clayface/')).toBeNull()
    expect(filmSlug('https://www.letterboxd.com/a/film/clayface/')).toBeNull()
    expect(filmSlug('https://letterboxd.com/a/film/Clayface/')).toBeNull()
    expect(filmSlug('https://letterboxd.com/a/film/clayface/?x=1')).toBeNull()
    expect(filmSlug('')).toBeNull()
    expect(filmSlug(undefined)).toBeNull()
    expect(filmSlug(42)).toBeNull()
  })
})

describe('filmCountLine', () => {
  it('leads with You when the viewer logged it', () => {
    expect(filmCountLine(9, 3, true)).toEqual({ lead: 'You', tail: ' + 8 others have logged it ', week: '· 3 this week', line: 'You + 8 others have logged it · 3 this week', others: 8 })
    expect(filmCountLine(2, 0, true).line).toBe('You + 1 other have logged it')
  })

  it('says only you when nobody else has', () => {
    expect(filmCountLine(1, 1, true)).toEqual({ lead: '', tail: 'Only you have logged it', week: '', line: 'Only you have logged it', others: 0 })
  })

  it('drops the week part when every logger is from this week', () => {
    expect(filmCountLine(7, 7, true).line).toBe('You + 6 others have logged it')
    expect(filmCountLine(3, 3, false)).toEqual({ lead: '', tail: '3 members have logged it', week: '', line: '3 members have logged it', others: 3 })
    expect(filmCountLine(3, 1, false).week).toBe('· 1 this week')
  })

  it('counts members otherwise, singular for one', () => {
    expect(filmCountLine(9, 3, false).line).toBe('9 members have logged it · 3 this week')
    expect(filmCountLine(1, 0, false).line).toBe('1 member has logged it')
  })
})

const card = (watchers: any[], over: any = {}) => ({
  key: 'clayface|2026', title: 'Clayface', year: '2026', watched_date: '2026-10-22',
  link: 'https://letterboxd.com/' + (watchers[0] ? watchers[0].handle : 'x') + '/film/clayface/',
  watchers, byline: 'Watched by ' + watchers.map(w => w.name).join(', '), ...over,
})
const W = (n: number) => Array.from({ length: n }, (_, i) => ({ name: 'M' + i, handle: 'm' + i }))

describe('shapeStripCard', () => {
  it('viewer logged it: You first, You + N others, this week suffix', () => {
    const c = card([{ name: 'Alex', handle: 'alex' }, { name: 'Sam', handle: 'sam' }])
    const s = shapeStripCard(c, { members: 9, logs: 12, thisWeek: 3, you: true }, { handle: 'sam' })
    expect(s.fallback).toBe(false)
    expect(s.you).toBe(true)
    expect(s.countLine).toBe('You + 8 others have logged it · 3 this week')
    expect(s.othersCount).toBe(8)
    expect(s.names.map(n => n.label)).toEqual(['You', 'Alex'])
    expect(s.names.map(n => n.sep)).toEqual([',', ''])
    expect(s.names[0].you).toBe(true)
    expect(s.slug).toBe('clayface')
  })

  it('viewer alone: no count line, the You name says it', () => {
    const s = shapeStripCard(card([{ name: 'Sam', handle: 'sam' }]), { members: 1, logs: 1, thisWeek: 1, you: true }, { handle: 'sam' })
    expect(s.fallback).toBe(false)
    expect(s.you).toBe(true)
    expect(s.countLine).toBe('')
    expect(s.countWeek).toBe('')
    expect(s.othersCount).toBe(0)
    expect(s.names.map(n => n.label)).toEqual(['You'])
  })

  it('signed in, not logged: M members have logged it', () => {
    const c = card([{ name: 'Alex', handle: 'alex' }])
    const s = shapeStripCard(c, { members: 9, logs: 9, thisWeek: 3, you: false }, { handle: 'sam' })
    expect(s.you).toBe(false)
    expect(s.countLine).toBe('9 members have logged it · 3 this week')
    expect(s.othersCount).toBe(9)
    expect(s.names.map(n => n.label)).toEqual(['Alex'])
  })

  it('one member: no count line, the one name says it', () => {
    const c = card([{ name: 'Alex', handle: 'alex' }])
    const s = shapeStripCard(c, { members: 1, logs: 1, thisWeek: 1 }, null)
    expect(s.fallback).toBe(false)
    expect(s.countLine).toBe('')
    expect(s.names[0].label).toBe('Alex')
  })

  it('the viewer named this week counts as logged even if ingest lags', () => {
    const c = card([{ name: 'Alex', handle: 'alex' }, { name: 'Sam', handle: 'Sam' }])
    const s = shapeStripCard(c, { members: 1, logs: 1, thisWeek: 1, you: false }, { handle: 'sam' })
    expect(s.you).toBe(true)
    expect(s.countLine).toBe('You + 1 other have logged it')
  })

  it('does not inject the viewer when they are not among this week', () => {
    const c = card([{ name: 'Alex', handle: 'alex' }])
    const s = shapeStripCard(c, { members: 5, logs: 6, thisWeek: 1, you: true }, { handle: 'sam' })
    expect(s.names.map(n => n.label)).toEqual(['Alex'])
    expect(s.countLine).toBe('You + 4 others have logged it · 1 this week')
  })

  it('no stats: falls back to the weekly byline', () => {
    const c = card([{ name: 'Alex', handle: 'alex' }, { name: 'Sam', handle: 'sam' }])
    for (const stats of [undefined, null, {}, { members: 0 }]) {
      const s = shapeStripCard(c, stats, { handle: 'sam' })
      expect(s.fallback).toBe(true)
      expect(s.countLine).toBe('')
      expect(s.you).toBe(false)
      expect(s.names.map(n => n.name)).toEqual(['Sam', 'Alex'])
    }
  })

  it('shows six names and folds the rest behind +N more', () => {
    const s = shapeStripCard(card(W(9)), { members: 12, logs: 12, thisWeek: 9 }, null)
    expect(s.overflow).toBe(3)
    expect(s.names.filter(n => !n.extra)).toHaveLength(6)
    expect(s.names.filter(n => n.extra).map(n => n.name)).toEqual(['M6', 'M7', 'M8'])
    expect(s.names.filter(n => n.cut).map(n => n.name)).toEqual(['M5'])
    expect(s.names[8].sep).toBe('')
  })

  it('no fold at exactly six', () => {
    const s = shapeStripCard(card(W(6)), { members: 6, logs: 6, thisWeek: 6 }, null)
    expect(s.overflow).toBe(0)
    expect(s.names.some(n => n.cut || n.extra)).toBe(false)
  })
})

describe('shapeStrip', () => {
  const a = card([{ name: 'Alex', handle: 'alex' }], { key: 'a', link: 'https://letterboxd.com/alex/film/a/' })
  const b = card([{ name: 'Sam', handle: 'sam' }], { key: 'b', link: 'https://letterboxd.com/sam/film/b/2/' })
  const c = card([{ name: 'Jo', handle: 'jo' }], { key: 'c', link: 'https://letterboxd.com/jo/film/c/' })

  it('promotes the most-shared film to the front as the hero', () => {
    const out = shapeStrip([a, b, c], { a: { members: 3, thisWeek: 1 }, b: { members: 7, thisWeek: 1 } }, null)
    expect(out.map(x => x.key)).toEqual(['b', 'a', 'c'])
    expect(out.map(x => x.hero)).toEqual([true, false, false])
    expect(out[2].fallback).toBe(true)
  })

  it('no hero without stats or below two members', () => {
    expect(shapeStrip([a, b], {}, null).some(x => x.hero)).toBe(false)
    expect(shapeStrip([a, b], { a: { members: 1 } }, null).some(x => x.hero)).toBe(false)
  })
})

describe('shapeFilmPage', () => {
  const body = {
    film: { slug: 'clayface', title: 'Clayface', year: '2026', poster: 'https://p' },
    members: 4, logs: 5, thisWeek: 2, avg: 3.75, liked: 2,
    histogram: { '0.5': 0, '1': 0, '1.5': 0, '2': 0, '2.5': 0, '3': 1, '3.5': 0, '4': 2, '4.5': 0, '5': 1 },
    screenings: ['ev1', 'ev2'],
  }

  it('public: counts, rating summary, bars, no watcher list', () => {
    const f = shapeFilmPage(body, { ev1: { id: 'ev1', title: 'Clayface preview', film: 'Clayface', date: '2026-10-22', venue: 'Capri' } })
    expect(f.countLine).toBe('4 members have logged it · 2 this week')
    expect(f.avgLabel).toBe('3.75')
    expect(f.avgStars).toBe('★★★★')
    expect(f.likedLabel).toBe('2 hearts')
    expect(f.votes).toBe(4)
    expect(f.bars).toHaveLength(10)
    expect(f.bars.find(b => b.key === '4')!.pct).toBe(100)
    expect(f.bars.find(b => b.key === '3')!.pct).toBe(50)
    expect(f.bars.map(b => b.step)).toEqual([0, 0, 0, 0, 0, 5, 0, 10, 0, 5])
    expect(f.signedIn).toBe(false)
    expect(f.watchers).toEqual([])
    expect(f.screenings[0]).toEqual({ id: 'ev1', label: 'Clayface preview · Oct 22, 2026 · Capri', query: 'Clayface' })
    expect(f.screenings[1]).toEqual({ id: 'ev2', label: 'Club screening', query: '' })
  })

  it('no ratings: null average, empty labels', () => {
    const f = shapeFilmPage({ ...body, avg: null, liked: 0, histogram: {} })
    expect(f.avg).toBeNull()
    expect(f.avgLabel).toBe('')
    expect(f.likedLabel).toBe('')
    expect(f.votes).toBe(0)
  })

  it('signed in: watcher rows and the former-member remainder', () => {
    const f = shapeFilmPage({
      ...body, you: true,
      watchers: [{ name: 'Alex', handle: 'alex', rating: 4.5, liked: true, dates: ['2026-10-22', '2026-01-03'], review: 'Great.' }],
    })
    expect(f.countLine).toBe('You + 3 others have logged it · 2 this week')
    expect(f.signedIn).toBe(true)
    expect(f.watchers[0]).toEqual({ name: 'Alex', handle: 'alex', stars: '★★★★½', liked: true, dates: 'Oct 22, 2026, Jan 3, 2026', review: 'Great.' })
    expect(f.unnamed).toBe(3)
  })
})

describe('getFilmStats / getFilm', () => {
  const ORIGIN = 'https://join.test'

  async function loadModel() {
    vi.resetModules()
    vi.stubGlobal('window', {})
    vi.stubGlobal('JXNFC_WORKER_ORIGIN', ORIGIN)
    vi.stubGlobal('localStorage', {})
    return await import('../../model/index.ts')
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('requests the deduped slugs with a bearer token when a session exists', async () => {
    const m = await loadModel()
    vi.stubGlobal('jxnfcEnsureSession', async () => ({ token: 'tok' }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ stats: { a: { members: 2, logs: 2, thisWeek: 1, you: true } } })))
    vi.stubGlobal('fetch', fetchMock)
    const out = await m.getFilmStats(['a', 'b', 'a', null])
    expect(out).toEqual({ a: { members: 2, logs: 2, thisWeek: 1, you: true } })
    const call = fetchMock.mock.calls[0] as any[]
    expect(call[0]).toBe(ORIGIN + '/films/stats?slugs=a,b')
    expect(call[1].headers).toEqual({ Authorization: 'Bearer tok' })
  })

  it('caps the request at 40 slugs and skips the fetch for none', async () => {
    const m = await loadModel()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ stats: {} })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await m.getFilmStats([])).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
    await m.getFilmStats(Array.from({ length: 50 }, (_, i) => 's' + i))
    const url = String((fetchMock.mock.calls[0] as any[])[0])
    expect(url.split('=')[1].split(',')).toHaveLength(40)
    expect((fetchMock.mock.calls[0] as any[])[1].headers).toBeUndefined()
  })

  it('returns {} on network failure, non-ok and malformed bodies', async () => {
    const m = await loadModel()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect(await m.getFilmStats(['a'])).toEqual({})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })))
    expect(await m.getFilmStats(['a'])).toEqual({})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json')))
    expect(await m.getFilmStats(['a'])).toEqual({})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ stats: [] }))))
    expect(await m.getFilmStats(['a'])).toEqual({})
  })

  it('a throwing session helper still makes the public call', async () => {
    const m = await loadModel()
    vi.stubGlobal('jxnfcEnsureSession', async () => { throw new Error('nope') })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ stats: { a: { members: 1 } } })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await m.getFilmStats(['a'])).toEqual({ a: { members: 1 } })
  })

  it('a hanging session refresh cannot hold the strip past the time budget', async () => {
    const m = await loadModel()
    vi.useFakeTimers()
    try {
      vi.stubGlobal('jxnfcEnsureSession', () => new Promise(() => {}))
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ stats: { a: { members: 1 } } })))
      vi.stubGlobal('fetch', fetchMock)
      const p = m.getFilmStats(['a'])
      await vi.advanceTimersByTimeAsync(3000)
      expect(await p).toEqual({ a: { members: 1 } })
      expect((fetchMock.mock.calls[0] as any[])[1].headers).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('trusts a null session verdict over a stored, lapsed token', async () => {
    const m = await loadModel()
    vi.stubGlobal('localStorage', { jxnfc_session: JSON.stringify({ token: 'old', exp: Date.now() + 60e3 }) })
    vi.stubGlobal('jxnfcEnsureSession', async () => null)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ stats: {} })))
    vi.stubGlobal('fetch', fetchMock)
    await m.getFilmStats(['a'])
    expect((fetchMock.mock.calls[0] as any[])[1].headers).toBeUndefined()
  })

  it('without the session helper, sends only a live stored token', async () => {
    const m = await loadModel()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ stats: {} })))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('localStorage', { jxnfc_session: JSON.stringify({ token: 'live', exp: Date.now() + 60e3 }) })
    await m.getFilmStats(['a'])
    expect((fetchMock.mock.calls[0] as any[])[1].headers).toEqual({ Authorization: 'Bearer live' })
    vi.stubGlobal('localStorage', { jxnfc_session: JSON.stringify({ token: 'dead', exp: Date.now() - 1 }) })
    await m.getFilmStats(['a'])
    expect((fetchMock.mock.calls[1] as any[])[1].headers).toBeUndefined()
  })

  it('getFilm discriminates 404, 503, network and success', async () => {
    const m = await loadModel()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })))
    expect(await m.getFilm('x')).toEqual({ status: 404 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })))
    expect(await m.getFilm('x')).toEqual({ status: 503 })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect(await m.getFilm('x')).toEqual({ status: 0 })
    const body = { film: { slug: 'x', title: 'X' }, members: 1 }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)))
    vi.stubGlobal('fetch', fetchMock)
    expect(await m.getFilm('a b')).toEqual({ status: 200, data: body })
    expect((fetchMock.mock.calls[0] as any[])[0]).toBe(ORIGIN + '/films/a%20b')
  })
})
