import { SELF, env, createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../worker/src/index.js'
import {
  anonymizeFilmLogs, centralDayCutoff, CLUB_ERA_START, filmDetail, filmSlugFromUrl, filmStats, ingestLogs,
  ingestMany, linkScreenings, purgeFilmLogs, relinkFilmLogs, REVIEW_MAX,
} from '../../worker/src/films.js'

// Film stats (worker/src/films.js, docs/features/film-stats.md). Contract
// under test: club-era diary entries accumulate in FILMS_DB idempotently,
// keyed on the slug from the entry URL; a version is appended only when
// rating/liked/review change; departures keep counts but lose identity and
// review text; counts are public and names need a session.

const T1 = '2026-10-01T00:00:00.000Z'
const T2 = '2026-10-02T00:00:00.000Z'
const T3 = '2026-10-03T00:00:00.000Z'

afterEach(() => { vi.restoreAllMocks() })

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

function entry(handle, slug, date, extra = {}) {
  return {
    title: extra.title || slug.replace(/-/g, ' '),
    link: `https://letterboxd.com/${handle}/film/${slug}/${extra.n ? extra.n + '/' : ''}`,
    watched_date: date,
    ...extra,
  }
}

const db = () => env.FILMS_DB
const count = async (sql, ...args) => (await db().prepare(sql).bind(...args).first()).n

function req(path, { method = 'GET', body, token } = {}) {
  return SELF.fetch(`https://join.jxnfilm.club${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// Canonical row + members:all projection + a live session token.
async function member(email, overrides = {}) {
  const local = email.split('@')[0]
  const m = {
    id: 'id-' + local, email, name: 'M ' + local, handle: null,
    pronouns: null, newsletter: false, joined: '2026-01-01', ...overrides,
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(m))
  if (m.handle) await env.MEMBERS_KV.put(`email:${m.handle}`, email)
  const all = JSON.parse(await env.MEMBERS_KV.get('members:all') || '[]')
  all.push({ id: m.id, name: m.name, joined: m.joined, ...(m.handle ? { handle: m.handle } : {}) })
  await env.MEMBERS_KV.put('members:all', JSON.stringify(all))
  await env.MEMBERS_KV.put('members:bootstrapped', '1')
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  const res = await req('/otp/verify', { method: 'POST', body: { email, code: '111111' } })
  return { ...m, token: (await res.json()).token }
}

describe('filmSlugFromUrl', () => {
  it('takes the slug from a diary entry link, with or without a rewatch counter', () => {
    expect(filmSlugFromUrl('https://letterboxd.com/michaellamb/film/clayface/')).toBe('clayface')
    expect(filmSlugFromUrl('https://letterboxd.com/michaellamb/film/nosferatu-2024/3/')).toBe('nosferatu-2024')
    expect(filmSlugFromUrl('https://letterboxd.com/some_one/film/8-1-2/1/')).toBe('8-1-2')
  })

  it('is null for anything else', () => {
    for (const url of [
      undefined, '', 'https://letterboxd.com/qa/list/x/', 'https://letterboxd.com/film/clayface/',
      'https://letterboxd.com/qa/film/clayface', 'http://letterboxd.com/qa/film/clayface/',
      'https://letterboxd.com/qa/film/clayface/reviews/', 'https://letterboxd.com/qa/film/Clay/',
      'https://boxd.it/1saJEP', 'https://evil.example/qa/film/clayface/',
    ]) expect(filmSlugFromUrl(url)).toBeNull()
  })
})

describe('centralDayCutoff', () => {
  it('counts back inclusive of today, across a month boundary', () => {
    expect(centralDayCutoff(7, '2026-10-23')).toBe('2026-10-17')
    expect(centralDayCutoff(7, '2026-03-03')).toBe('2026-02-25')
    expect(centralDayCutoff(1, '2026-10-23')).toBe('2026-10-23')
  })
})

describe('ingestLogs', () => {
  const M = { id: 'm1', handle: 'qa' }

  it('is idempotent: re-ingesting the same feed adds no films, logs or versions', async () => {
    const feed = [
      entry('qa', 'clayface', '2026-10-22', { title: 'Clayface', year: '2026', rating: '4.0', liked: true, tmdb_id: '1400940', poster: 'https://a.ltrbxd.com/c.jpg' }),
      entry('qa', 'nosferatu-2024', '2026-10-19', { n: 3, rewatch: true, rating: '4.5' }),
    ]
    await ingestLogs(db(), M, feed, T1)
    await ingestLogs(db(), M, feed, T2)
    expect(await count('SELECT COUNT(*) n FROM films')).toBe(2)
    expect(await count('SELECT COUNT(*) n FROM logs')).toBe(2)
    expect(await count('SELECT COUNT(*) n FROM log_versions')).toBe(2)
    const film = await db().prepare('SELECT * FROM films WHERE slug = ?').bind('clayface').first()
    expect(film).toMatchObject({ title: 'Clayface', year: '2026', tmdb_id: '1400940', poster: 'https://a.ltrbxd.com/c.jpg', first_seen: T1 })
    const log = await db().prepare('SELECT * FROM logs WHERE film_slug = ?').bind('nosferatu-2024').first()
    expect(log).toMatchObject({ member_key: 'm1', handle: 'qa', watched_date: '2026-10-19', rewatch: 1, event_id: null })
  })

  it('appends a version only when rating, liked or review change', async () => {
    const at = (extra) => [entry('qa', 'clayface', '2026-10-22', extra)]
    await ingestLogs(db(), M, at({ rating: '4.0' }), T1)
    await ingestLogs(db(), M, at({ rating: '4.0' }), T2)
    expect(await count('SELECT COUNT(*) n FROM log_versions')).toBe(1)
    await ingestLogs(db(), M, at({ rating: '4.5' }), T2)
    await ingestLogs(db(), M, at({ rating: '4.5', liked: true }), T3)
    await ingestLogs(db(), M, at({ rating: '4.5', liked: true, review: 'Great.' }), '2026-10-04T00:00:00.000Z')
    await ingestLogs(db(), M, at({ rating: '4.5', liked: true, review: 'Great.' }), '2026-10-05T00:00:00.000Z')
    const { results } = await db().prepare('SELECT rating, liked, review FROM log_versions ORDER BY seen_at').all()
    expect(results).toEqual([
      { rating: 4, liked: 0, review: null },
      { rating: 4.5, liked: 0, review: null },
      { rating: 4.5, liked: 1, review: null },
      { rating: 4.5, liked: 1, review: 'Great.' },
    ])
  })

  it('keeps only the club era, dated entries and parseable film links', async () => {
    await ingestLogs(db(), M, [
      entry('qa', 'before', '2020-11-09'),
      entry('qa', 'first-day', CLUB_ERA_START),
      { title: 'Undated', link: 'https://letterboxd.com/qa/film/undated/' },
      { title: 'A list', link: 'https://letterboxd.com/qa/list/x/', watched_date: '2026-10-01' },
      entry('qa', 'bad-date', '10/01/2026'),
    ], T1)
    const { results } = await db().prepare('SELECT film_slug FROM logs').all()
    expect(results.map(r => r.film_slug)).toEqual(['first-day'])
    expect(await count('SELECT COUNT(*) n FROM films')).toBe(1)
  })

  it('a renamed handle re-serving old entries does not duplicate them', async () => {
    await ingestLogs(db(), { id: 'm1', handle: 'old' }, [entry('old', 'clayface', '2026-10-22', { rating: '3.0' })], T1)
    await ingestLogs(db(), { id: 'm1', handle: 'new' }, [entry('new', 'clayface', '2026-10-22', { rating: '3.5' })], T2)
    expect(await count('SELECT COUNT(*) n FROM logs')).toBe(1)
    // ... but a changed rating on the renamed feed still versions the log.
    expect(await count('SELECT COUNT(*) n FROM log_versions')).toBe(2)
  })

  it('a rewatch is its own log; one batch carries many members', async () => {
    const n = await ingestMany(db(), [
      { member: { id: 'm1', handle: 'a' }, films: [entry('a', 'jaws', '2026-10-01'), entry('a', 'jaws', '2026-10-08', { n: 1, rewatch: true })] },
      { member: { id: 'm2', handle: 'b' }, films: [entry('b', 'jaws', '2026-10-02')] },
      { member: { handle: 'no-id' }, films: [entry('no-id', 'jaws', '2026-10-02')] },
    ], T1)
    expect(n).toEqual({ candidates: 3, changed: 3, earliest: '2026-10-01' })
    expect(await count('SELECT COUNT(*) n FROM logs')).toBe(3)
    expect(await count('SELECT COUNT(DISTINCT member_key) n FROM logs')).toBe(2)
  })

  it('reports only newly inserted logs, so a re-ingest has nothing to link', async () => {
    const feed = [entry('qa', 'jaws', '2026-10-01')]
    expect(await ingestLogs(db(), M, feed, T1)).toEqual({ candidates: 1, changed: 1, earliest: '2026-10-01' })
    expect(await ingestLogs(db(), M, feed, T2)).toEqual({ candidates: 1, changed: 0, earliest: null })
  })

  it('an edited diary date moves the log, and later changes still version it', async () => {
    await ingestLogs(db(), M, [entry('qa', 'jaws', '2026-10-01', { rating: '3.0' })], T1)
    await db().prepare(`UPDATE logs SET event_id = 'ev-1'`).run()
    const res = await ingestLogs(db(), M, [entry('qa', 'jaws', '2026-10-02', { rating: '5.0' })], T2)
    expect(res).toMatchObject({ changed: 1, earliest: '2026-10-02' })
    const { results } = await db().prepare('SELECT watched_date, event_id FROM logs').all()
    expect(results).toEqual([{ watched_date: '2026-10-02', event_id: null }])
    const v = await db().prepare('SELECT rating FROM log_versions ORDER BY seen_at DESC').first()
    expect(v.rating).toBe(5)
  })

  it('caps stored review length', async () => {
    await ingestLogs(db(), M, [entry('qa', 'long', '2026-10-01', { review: 'x'.repeat(REVIEW_MAX + 50) })], T1)
    const v = await db().prepare('SELECT review FROM log_versions').first()
    expect(v.review).toHaveLength(REVIEW_MAX)
  })
})

describe('linkScreenings', () => {
  const event = { id: '2026-10-22-clayface', title: 'CLAYFACE Preview Screening', film: 'Clayface', year: 2026, date: '2026-10-22' }
  const attendance = { [event.id]: [{ id: 'm1', name: 'A' }, { id: 'm2', name: 'B' }] }

  it('links an attended same-film log on the event date or the day after', async () => {
    await ingestMany(db(), [
      { member: { id: 'm1', handle: 'a' }, films: [entry('a', 'clayface', '2026-10-23', { title: 'Clayface', year: '2026' })] },
      { member: { id: 'm2', handle: 'b' }, films: [entry('b', 'clayface', '2026-10-24', { title: 'Clayface', year: '2026' })] }, // too late
      { member: { id: 'm3', handle: 'c' }, films: [entry('c', 'clayface', '2026-10-22', { title: 'Clayface', year: '2026' })] }, // not attending
      { member: { id: 'm1', handle: 'a' }, films: [entry('a', 'other', '2026-10-22', { title: 'Other' })] },                      // wrong film
    ], T1)
    expect(await linkScreenings(db(), [event], attendance, { since: '2026-10-01' })).toBe(1)
    const { results } = await db().prepare('SELECT member_key, film_slug, event_id FROM logs WHERE event_id IS NOT NULL').all()
    expect(results).toEqual([{ member_key: 'm1', film_slug: 'clayface', event_id: event.id }])
    // Already-linked logs aren't touched again.
    expect(await linkScreenings(db(), [event], attendance, { since: '2026-10-01' })).toBe(0)
  })

  it('prefers an explicit letterboxd slug on the event, and respects since', async () => {
    await ingestLogs(db(), { id: 'm1', handle: 'a' }, [entry('a', 'clayface-2026', '2026-10-22', { title: 'Something Else' })], T1)
    expect(await linkScreenings(db(), [{ ...event, letterboxd: 'clayface-2026' }], attendance, { since: '2026-10-23' })).toBe(0)
    expect(await linkScreenings(db(), [{ ...event, letterboxd: 'clayface-2026' }], attendance, { since: '2026-10-08' })).toBe(1)
  })
})

describe('anonymizeFilmLogs', () => {
  it('keeps counts and ratings, drops handle and review, one former key per member', async () => {
    await ingestMany(db(), [
      { member: { id: 'm1', handle: 'alice' }, films: [
        entry('alice', 'jaws', '2026-10-01', { rating: '4.0', review: 'Shark!' }),
        entry('alice', 'alien', '2026-10-02', { rating: '5.0', review: 'Space!' }),
      ] },
      { member: { id: 'm2', handle: 'bob' }, films: [entry('bob', 'jaws', '2026-10-03', { rating: '2.0', review: 'Meh' })] },
    ], T1)
    await ingestLogs(db(), { id: 'm1', handle: 'alice' }, [entry('alice', 'jaws', '2026-10-01', { rating: '4.5', review: 'Shark!!' })], T2)

    expect(await anonymizeFilmLogs(db(), 'm1')).toBe(2)

    expect(await count('SELECT COUNT(*) n FROM logs')).toBe(3)
    expect(await count('SELECT COUNT(*) n FROM log_versions')).toBe(4) // every rating version kept
    expect(await count(`SELECT COUNT(*) n FROM logs WHERE member_key = 'm1'`)).toBe(0)
    const { results } = await db().prepare(`SELECT DISTINCT member_key FROM logs WHERE member_key LIKE 'former:%'`).all()
    expect(results).toHaveLength(1)
    expect(results[0].member_key).toMatch(/^former:[0-9a-f]{16}$/)
    expect(await count(`SELECT COUNT(*) n FROM logs WHERE member_key LIKE 'former:%' AND handle IS NOT NULL`)).toBe(0)
    expect(await count(`SELECT COUNT(*) n FROM logs WHERE entry_url LIKE '%alice%'`)).toBe(0)
    const reviews = (await db().prepare('SELECT review FROM log_versions WHERE review IS NOT NULL').all()).results
    expect(reviews).toEqual([{ review: 'Meh' }])

    // Still two people, one vote each.
    const jaws = await filmDetail(db(), 'jaws')
    expect(jaws).toMatchObject({ members: 2, logs: 2, avg: 3.25 })

    // A second departure gets its own key.
    await anonymizeFilmLogs(db(), 'm2')
    expect(await count(`SELECT COUNT(DISTINCT member_key) n FROM logs`)).toBe(2)
  })

  it('a departed member is tombstoned: a stale or in-flight ingest adds nothing', async () => {
    const feed = [entry('alice', 'jaws', '2026-10-01', { rating: '4.0', review: 'Shark!' })]
    await ingestLogs(db(), { id: 'm1', handle: 'alice' }, feed, T1)
    await anonymizeFilmLogs(db(), 'm1')
    const res = await ingestLogs(db(), { id: 'm1', handle: 'alice' }, [...feed, entry('alice', 'alien', '2026-10-05')], T2)
    expect(res.changed).toBe(0)
    expect(await count('SELECT COUNT(*) n FROM logs')).toBe(1)
    expect(await count(`SELECT COUNT(*) n FROM logs WHERE member_key = 'm1'`)).toBe(0)
    expect(await count('SELECT COUNT(*) n FROM log_versions WHERE review IS NOT NULL')).toBe(0)
  })

  it('account deletion after an unlink forgets the mapping but keeps the rows anonymous', async () => {
    await ingestLogs(db(), { id: 'm1', handle: 'alice' }, [entry('alice', 'jaws', '2026-10-01', { rating: '4.0' })], T1)
    await anonymizeFilmLogs(db(), 'm1')
    await anonymizeFilmLogs(db(), 'm1', { forget: true })
    expect(await count('SELECT COUNT(*) n FROM departures WHERE former_key IS NULL')).toBe(1)
    expect(await count(`SELECT COUNT(*) n FROM logs WHERE member_key LIKE 'former:%'`)).toBe(1)
    expect(await relinkFilmLogs(db(), 'm1')).toBe(0)
  })

  it('a repeat departure keeps the first former key', async () => {
    await ingestLogs(db(), { id: 'm1', handle: 'alice' }, [entry('alice', 'jaws', '2026-10-01')], T1)
    await anonymizeFilmLogs(db(), 'm1')
    await anonymizeFilmLogs(db(), 'm1')
    expect(await count('SELECT COUNT(*) n FROM departures')).toBe(1)
    expect(await count(`SELECT COUNT(DISTINCT member_key) n FROM logs`)).toBe(1)
  })

  it('a relink after departure starts fresh, without counting the member twice', async () => {
    const feed = [entry('alice', 'jaws', '2026-10-01', { rating: '4.0' })]
    await ingestMany(db(), [
      { member: { id: 'm1', handle: 'alice' }, films: feed },
      { member: { id: 'm2', handle: 'bob' }, films: [entry('bob', 'jaws', '2026-10-02', { rating: '2.0' })] },
    ], T1)
    await anonymizeFilmLogs(db(), 'm1')
    expect(await relinkFilmLogs(db(), 'm1')).toBe(1)
    expect(await count('SELECT COUNT(*) n FROM departures')).toBe(0)
    await ingestLogs(db(), { id: 'm1', handle: 'alice' }, feed, T2)
    expect(await count('SELECT COUNT(*) n FROM logs')).toBe(2)
    expect(await filmDetail(db(), 'jaws')).toMatchObject({ members: 2, logs: 2, avg: 3 })
    // A member who never departed has nothing to clear.
    expect(await relinkFilmLogs(db(), 'm2')).toBe(0)
  })

  it('purgeFilmLogs deletes one member’s logs and versions only', async () => {
    await ingestMany(db(), [
      { member: { id: 'm1', handle: 'a' }, films: [entry('a', 'jaws', '2026-10-01', { rating: '4.0' })] },
      { member: { id: 'm2', handle: 'b' }, films: [entry('b', 'jaws', '2026-10-02', { rating: '2.0' })] },
    ], T1)
    expect(await purgeFilmLogs(db(), 'm1')).toBe(1)
    expect(await count('SELECT COUNT(*) n FROM logs')).toBe(1)
    expect(await count('SELECT COUNT(*) n FROM log_versions')).toBe(1)
  })
})

describe('stats queries', () => {
  it('filmStats counts members, logs, this week and you', async () => {
    await ingestMany(db(), [
      { member: { id: 'm1', handle: 'a' }, films: [entry('a', 'jaws', '2026-10-20'), entry('a', 'jaws', '2026-09-01', { n: 1 })] },
      { member: { id: 'm2', handle: 'b' }, films: [entry('b', 'jaws', '2026-10-01')] },
    ], T1)
    expect(await filmStats(db(), ['jaws', 'nope'], null, '2026-10-23')).toEqual({ jaws: { members: 2, logs: 3, thisWeek: 1 } })
    expect(await filmStats(db(), ['jaws'], 'm2', '2026-10-23')).toEqual({ jaws: { members: 2, logs: 3, thisWeek: 1, you: true } })
    expect(await filmStats(db(), ['jaws'], 'm9', '2026-10-23')).toEqual({ jaws: { members: 2, logs: 3, thisWeek: 1, you: false } })
  })

  it('a rating cleared on Letterboxd stops counting', async () => {
    await ingestMany(db(), [
      { member: { id: 'm1', handle: 'a' }, films: [entry('a', 'jaws', '2026-10-01', { rating: '1.0', liked: true })] },
      { member: { id: 'm2', handle: 'b' }, films: [entry('b', 'jaws', '2026-10-02', { rating: '4.0' })] },
    ], T1)
    await ingestLogs(db(), { id: 'm1', handle: 'a' }, [entry('a', 'jaws', '2026-10-01')], T2)
    const d = await filmDetail(db(), 'jaws', { viewer: { id: 'm1', membersById: { m1: { name: 'A' } } } })
    expect(d).toMatchObject({ members: 2, avg: 4, liked: 0 })
    expect(d.histogram['1']).toBe(0)
    expect(d.watchers[0]).toMatchObject({ name: 'A', rating: null, liked: false })
  })

  it('filmDetail scores each member once, on their most recent rated log', async () => {
    await ingestMany(db(), [
      { member: { id: 'm1', handle: 'a' }, films: [
        entry('a', 'jaws', '2026-10-20', { n: 1 }),                                  // newest, unrated
        entry('a', 'jaws', '2026-10-10', { rating: '5.0', liked: true }),            // the vote
      ] },
      { member: { id: 'm2', handle: 'b' }, films: [entry('b', 'jaws', '2026-10-01', { rating: '2.5', review: 'ok' })] },
      { member: { id: 'm3', handle: 'c' }, films: [entry('c', 'jaws', '2026-10-02', { rating: '3.0' })] },
    ], T1)
    const d = await filmDetail(db(), 'jaws', { today: '2026-10-23' })
    expect(d.members).toBe(3)
    expect(d.logs).toBe(4)
    expect(d.thisWeek).toBe(1)
    expect(d.avg).toBe(3.5)
    expect(d.liked).toBe(1)
    expect(d.histogram).toEqual({ '0.5': 0, '1': 0, '1.5': 0, '2': 0, '2.5': 1, '3': 1, '3.5': 0, '4': 0, '4.5': 0, '5': 1 })
    expect(d.watchers).toBeUndefined()
    expect(await filmDetail(db(), 'nope')).toBeNull()
  })
})

describe('GET /films/*', () => {
  async function seedFilm() {
    const today = centralDayCutoff(1)
    await ingestMany(db(), [
      { member: { id: 'id-alice', handle: 'alice' }, films: [
        entry('alice', 'jaws', today, { title: 'Jaws', year: '1975', rating: '4.0', liked: true, review: 'Shark!' }),
        entry('alice', 'jaws', '2026-01-02', { n: 1, title: 'Jaws', year: '1975', rating: '3.0' }),
      ] },
      { member: { id: 'id-gone', handle: 'gone' }, films: [entry('gone', 'jaws', '2026-02-01', { title: 'Jaws', year: '1975', rating: '2.0', review: 'bye' })] },
    ], T1)
    await anonymizeFilmLogs(db(), 'id-gone')
    await db().prepare(`UPDATE logs SET event_id = 'ev-1' WHERE member_key = 'id-alice' AND watched_date = '2026-01-02'`).run()
    return today
  }

  it('/films/stats is public counts with an edge cache; a session adds you, privately', async () => {
    await seedFilm()
    const alice = await member('alice@example.com', { handle: 'alice' })
    const bob = await member('bob@example.com')

    const pub = await req('/films/stats?slugs=jaws,unknown,jaws')
    expect(pub.status).toBe(200)
    expect(pub.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(await pub.json()).toEqual({ stats: { jaws: { members: 2, logs: 3, thisWeek: 1 } } })

    const mine = await req('/films/stats?slugs=jaws', { token: alice.token })
    expect(mine.headers.get('Cache-Control')).toBe('private, no-store')
    expect((await mine.json()).stats.jaws.you).toBe(true)
    expect((await (await req('/films/stats?slugs=jaws', { token: bob.token })).json()).stats.jaws.you).toBe(false)

    // A bad bearer is just a public caller.
    const bad = await req('/films/stats?slugs=jaws', { token: 'nope.nope' })
    expect(bad.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect((await bad.json()).stats.jaws.you).toBeUndefined()

    expect((await req('/films/stats')).status).toBe(200)
    const many = Array.from({ length: 41 }, (_, i) => 'f' + i).join(',')
    expect((await req('/films/stats?slugs=' + many)).status).toBe(400)
  })

  it('/films/:slug: public aggregates, watchers only for members, former members never listed', async () => {
    const today = await seedFilm()
    const alice = await member('alice@example.com', { handle: 'alice' })

    expect((await req('/films/nope')).status).toBe(404)
    expect(await (await req('/films/nope')).json()).toEqual({ error: 'not found' })
    expect((await req('/films/Bad_Slug')).status).toBe(404)

    const pub = await req('/films/jaws')
    expect(pub.headers.get('Cache-Control')).toBe('public, max-age=60')
    const body = await pub.json()
    expect(body).toEqual({
      film: { slug: 'jaws', title: 'Jaws', year: '1975', poster: null },
      members: 2, logs: 3, thisWeek: 1, avg: 3, liked: 1,
      histogram: { '0.5': 0, '1': 0, '1.5': 0, '2': 1, '2.5': 0, '3': 0, '3.5': 0, '4': 1, '4.5': 0, '5': 0 },
      screenings: ['ev-1'],
    })

    const authed = await req('/films/jaws', { token: alice.token })
    expect(authed.headers.get('Cache-Control')).toBe('private, no-store')
    const a = await authed.json()
    expect(a.you).toBe(true)
    expect(a.watchers).toEqual([
      { name: 'M alice', handle: 'alice', rating: 4, liked: true, dates: [today, '2026-01-02'], review: 'Shark!' },
    ])
    expect(JSON.stringify(a)).not.toContain('bye')
  })

  it('503s without the FILMS_DB binding', async () => {
    for (const path of ['/films/stats?slugs=jaws', '/films/jaws']) {
      const ctx = createExecutionContext()
      const res = await worker.fetch(new Request('https://join.jxnfilm.club' + path), { ...env, FILMS_DB: undefined }, ctx)
      await waitOnExecutionContext(ctx)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'unavailable' })
    }
  })
})

const FEED = `<?xml version="1.0"?><rss><channel><title>feed</title>
  <item> <title>Clayface, 2026</title> <link>https://letterboxd.com/alice/film/clayface/</link>
    <guid isPermaLink="false">letterboxd-review-1</guid> <letterboxd:watchedDate>2026-10-22</letterboxd:watchedDate>
    <letterboxd:filmTitle>Clayface</letterboxd:filmTitle> <letterboxd:filmYear>2026</letterboxd:filmYear>
    <letterboxd:memberRating>4.0</letterboxd:memberRating> <letterboxd:memberLike>Yes</letterboxd:memberLike>
    <tmdb:movieId>1400940</tmdb:movieId>
    <description><![CDATA[ <p><img src="https://a.ltrbxd.com/c.jpg"/></p> <p>it&#039;s  <i>great</i> &amp; weird</p> ]]></description> </item>
  <item> <title>Spoiled</title> <link>https://letterboxd.com/alice/film/spoiled/</link>
    <guid isPermaLink="false">letterboxd-review-2</guid> <letterboxd:watchedDate>2026-10-21</letterboxd:watchedDate>
    <letterboxd:filmTitle>Spoiled</letterboxd:filmTitle>
    <description><![CDATA[ <p><em>This review may contain spoilers.</em></p> <p>The twist!</p> ]]></description> </item>
  <item> <title>Plain</title> <link>https://letterboxd.com/alice/film/plain/1/</link>
    <guid isPermaLink="false">letterboxd-watch-3</guid> <letterboxd:watchedDate>2026-10-20</letterboxd:watchedDate>
    <letterboxd:filmTitle>Plain</letterboxd:filmTitle> <letterboxd:rewatch>Yes</letterboxd:rewatch>
    <description><![CDATA[ <p><img src="https://a.ltrbxd.com/p.jpg"/></p> <p>Watched on Tuesday October 20, 2026.</p> ]]></description> </item>
</channel></rss>`

describe('ingest from the /watched rebuild', () => {
  async function seedAlice() {
    await env.MEMBERS_KV.put('members:bootstrapped', '1')
    await env.MEMBERS_KV.put('members:all', JSON.stringify([{ id: 'id-alice', name: 'Alice', handle: 'alice' }, { id: 'id-x', name: 'X' }]))
  }

  it('ingests reviews and the TMDB id, but keeps both out of the served payload', async () => {
    await seedAlice()
    mockFetch(async () => new Response(FEED, { status: 200 }))
    const ctx = createExecutionContext()
    const res = await worker.fetch(new Request('https://join.jxnfilm.club/watched'), env, ctx)
    await waitOnExecutionContext(ctx)

    const served = await res.json()
    expect(served.alice.map(f => f.title)).toEqual(['Clayface', 'Spoiled', 'Plain'])
    for (const f of served.alice) {
      expect(f.review).toBeUndefined()
      expect(f.tmdb_id).toBeUndefined()
    }
    // The Watched map never carries review text. Hot Takes (rec.takes) does —
    // the public, truncated take card, which is what GET /takes serves.
    const rec = JSON.parse(await env.MEMBERS_KV.get('watched:cache'))
    expect(JSON.stringify(rec.map)).not.toContain('weird')
    expect(rec.takes.map(t => t.review)).toEqual(["it's great & weird"])

    const { results } = await db().prepare(
      `SELECT l.film_slug, l.member_key, l.rewatch, v.review, f.tmdb_id FROM logs l
       JOIN log_versions v ON v.log_id = l.id JOIN films f ON f.slug = l.film_slug ORDER BY l.watched_date DESC`,
    ).all()
    expect(results).toEqual([
      { film_slug: 'clayface', member_key: 'id-alice', rewatch: 0, review: "it's great & weird", tmdb_id: '1400940' },
      { film_slug: 'spoiled', member_key: 'id-alice', rewatch: 0, review: null, tmdb_id: null },
      { film_slug: 'plain', member_key: 'id-alice', rewatch: 1, review: null, tmdb_id: null },
    ])
  })

  it('links newly ingested logs of old screenings, past the 14-day window', async () => {
    await seedAlice()
    mockFetch(async (url) => String(url).includes('letterboxd.com')
      ? new Response(FEED, { status: 200 })
      : new Response('{}', { status: 200 }))
    // Admin-set exact slug survives the events:all projection.
    await env.ATTENDANCE_KV.put('events:bootstrapped', '1')
    await env.ATTENDANCE_KV.put('events:all', JSON.stringify([{ id: 'ev-old', film: 'Not The Title', letterboxd: 'clayface', date: '2026-10-22' }]))
    await env.ATTENDANCE_KV.put('attendance:bootstrapped', '1')
    await env.ATTENDANCE_KV.put('attendance:all', JSON.stringify({ 'ev-old': [{ id: 'id-alice', name: 'Alice' }] }))
    const ctx = createExecutionContext()
    await worker.fetch(new Request('https://join.jxnfilm.club/watched'), env, ctx)
    await waitOnExecutionContext(ctx)
    const log = await db().prepare(`SELECT event_id FROM logs WHERE film_slug = 'clayface'`).first()
    expect(log.event_id).toBe('ev-old')
  })

  it('the daily cron rebuilds, ingests and links recent screenings', async () => {
    await seedAlice()
    const date = centralDayCutoff(2)
    const feed = FEED.replace('<letterboxd:watchedDate>2026-10-22<', `<letterboxd:watchedDate>${date}<`)
    mockFetch(async (url) => String(url).includes('letterboxd.com')
      ? new Response(feed, { status: 200 })
      : new Response('{}', { status: 200 }))
    const event = { id: 'ev-clay', title: 'Preview', film: 'Clayface', year: 2026, date }
    await env.ATTENDANCE_KV.put('events:bootstrapped', '1')
    await env.ATTENDANCE_KV.put('events:all', JSON.stringify([event]))
    await env.ATTENDANCE_KV.put('attendance:bootstrapped', '1')
    await env.ATTENDANCE_KV.put('attendance:all', JSON.stringify({ 'ev-clay': [{ id: 'id-alice', name: 'Alice' }] }))

    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '17 8 * * *' }), env, ctx)
    await waitOnExecutionContext(ctx)

    const log = await db().prepare(`SELECT event_id FROM logs WHERE film_slug = 'clayface'`).first()
    expect(log.event_id).toBe('ev-clay')
  })
})

describe('departure cascades', () => {
  async function seedLogs() {
    await ingestLogs(db(), { id: 'id-alice', handle: 'alice' }, [entry('alice', 'jaws', '2026-10-01', { rating: '4.0', review: 'Shark!' })], T1)
  }

  async function assertAnonymized() {
    expect(await count(`SELECT COUNT(*) n FROM logs`)).toBe(1)
    expect(await count(`SELECT COUNT(*) n FROM logs WHERE member_key = 'id-alice' OR handle IS NOT NULL`)).toBe(0)
    expect(await count(`SELECT COUNT(*) n FROM log_versions WHERE review IS NOT NULL`)).toBe(0)
    expect(await count(`SELECT COUNT(*) n FROM log_versions WHERE rating = 4`)).toBe(1)
  }

  it('/letterboxd/unlink anonymizes the member’s film logs', async () => {
    mockFetch(async () => new Response('{}', { status: 200 }))
    const alice = await member('alice@example.com', { handle: 'alice' })
    await seedLogs()
    const res = await req('/letterboxd/unlink', { method: 'POST', body: {}, token: alice.token })
    expect(res.status).toBe(200)
    await assertAnonymized()
  })

  it('relinking clears the tombstone and the former logs; a handle switch drops the old handle’s logs', async () => {
    mockFetch(async () => new Response('{}', { status: 200 }))
    const alice = await member('alice@example.com', { handle: 'alice' })
    await seedLogs()
    await req('/letterboxd/unlink', { method: 'POST', body: {}, token: alice.token })
    let res = await req('/member/update', { method: 'POST', body: { handle: 'alice' }, token: alice.token })
    expect(res.status).toBe(200)
    expect(await count('SELECT COUNT(*) n FROM logs')).toBe(0)
    expect(await count('SELECT COUNT(*) n FROM departures')).toBe(0)

    await seedLogs()
    res = await req('/member/update', { method: 'POST', body: { handle: 'alice2' }, token: alice.token })
    expect(res.status).toBe(200)
    expect(await count('SELECT COUNT(*) n FROM logs')).toBe(0)
    expect(await count('SELECT COUNT(*) n FROM log_versions')).toBe(0)
  })

  it('/member/delete anonymizes the member’s film logs', async () => {
    mockFetch(async () => new Response('{}', { status: 200 }))
    const alice = await member('alice@example.com', { handle: 'alice' })
    await seedLogs()
    const res = await req('/member/delete', { method: 'POST', body: {}, token: alice.token })
    expect(res.status).toBe(200)
    await assertAnonymized()
    // The id stays tombstoned (no stale ingest can re-add it) but no longer
    // maps to the former key.
    const dep = await db().prepare('SELECT member_key, former_key FROM departures').first()
    expect(dep).toEqual({ member_key: 'id-alice', former_key: null })
    await ingestLogs(db(), { id: 'id-alice', handle: 'alice' }, [entry('alice', 'alien', '2026-10-05')], T2)
    expect(await count('SELECT COUNT(*) n FROM logs')).toBe(1)
  })
})
