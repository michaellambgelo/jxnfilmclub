import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isAcceptingEntries, normalizeEmail, parseLetterboxdHandle, parseSources, poolHash,
  secureRandomInt, toCsv, validGiveaway, weightedDraw,
} from '../../worker/src/giveaways.js'

// Giveaways (worker/src/giveaways.js). Contract under test: entries only
// while open and inside the window, only after an explicit opt-in, one per
// member per source (enforced by D1 unique indexes, not by hope), and a draw
// that is weighted, uses the CSPRNG without modulo bias, is logged, and can be
// rerun for a non-responder.

const ADMIN = 'test-admin-token'
const EVENT_ID = '2026-10-22-clayface'
const HOUR = 3600 * 1000

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

// letterboxd.com answers by handle; everything else (Resend, GitHub) is 200.
function letterboxd(profiles = {}) {
  mockFetch(async (url) => {
    const m = /letterboxd\.com\/([^/]+)\/films\//.exec(String(url))
    if (m) {
      const state = profiles[m[1]] ?? 'yes'
      if (state === 'yes') return new Response('<html>films</html>', { status: 200 })
      if (state === 'no') return new Response('nope', { status: 404 })
      return new Response('Just a moment...', { status: 403 })  // bot challenge
    }
    return new Response('{}', { status: 200 })
  })
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

async function member(email, overrides = {}) {
  const m = {
    id: 'id-' + email.split('@')[0], email, name: 'M ' + email.split('@')[0], handle: null,
    pronouns: null, newsletter: false, joined: '2026-01-01', ...overrides,
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(m))
  if (m.handle) await env.MEMBERS_KV.put(`email:${m.handle}`, email)
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  const res = await req('/otp/verify', { method: 'POST', body: { email, code: '111111' } })
  return { ...m, token: (await res.json()).token }
}

async function seedEvent(overrides = {}) {
  const event = {
    id: EVENT_ID, title: 'CLAYFACE Preview Screening', date: '2099-10-22', time: '20:30',
    venue: 'Capri Theater', rsvp: true, ticketed: true, ...overrides,
  }
  await env.ATTENDANCE_KV.put(`event:${EVENT_ID}`, JSON.stringify(event))
  return event
}

function giveawayBody(overrides = {}) {
  const now = Date.now()
  return {
    event_id: EVENT_ID,
    title: 'Clayface waitlist giveaway',
    prize: 'A pair of tickets to the Clayface preview',
    winners: 2,
    tickets_per_winner: 2,
    starts_at: new Date(now - HOUR).toISOString(),
    ends_at: new Date(now + 24 * HOUR).toISOString(),
    status: 'open',
    sources: { waitlist_signup: { weight: 1 }, letterboxd_link: { weight: 1 } },
    count_prior_waitlist: false,
    rules_md: 'Sponsored by the Jackson Film Club.',
    ...overrides,
  }
}

async function putGiveaway(id, overrides = {}) {
  const res = await req(`/admin/giveaways/${id}`, { method: 'PUT', token: ADMIN, body: giveawayBody(overrides) })
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()).giveaway
}

const enter = (id, token, body = { acceptRules: true }) =>
  req(`/giveaways/${id}/enter`, { method: 'POST', token, body })
const me = async (id, token) => (await req(`/giveaways/${id}/me`, { token })).json()
const rsvp = (token) => req(`/events/${EVENT_ID}/rsvp`, { method: 'POST', token })

beforeEach(async () => {
  letterboxd()
  await seedEvent()
})
afterEach(() => { vi.restoreAllMocks() })

// --- pure rules -------------------------------------------------------------

describe('normalizeEmail', () => {
  it('folds case, +tags and gmail dots so one inbox is one person', () => {
    expect(normalizeEmail('Foo.Bar+giveaway@GMail.com')).toBe('foobar@gmail.com')
    expect(normalizeEmail('foo.bar@googlemail.com')).toBe('foobar@gmail.com')
    // Dots only matter to Gmail.
    expect(normalizeEmail('first.last+x@example.org')).toBe('first.last@example.org')
  })
})

describe('parseLetterboxdHandle', () => {
  it('takes a username, @username, or a profile URL', () => {
    expect(parseLetterboxdHandle('michaellamb')).toBe('michaellamb')
    expect(parseLetterboxdHandle('@michaellamb')).toBe('michaellamb')
    expect(parseLetterboxdHandle('https://letterboxd.com/michaellamb/')).toBe('michaellamb')
    expect(parseLetterboxdHandle('letterboxd.com/michaellamb/films/diary/')).toBe('michaellamb')
    expect(parseLetterboxdHandle('https://www.letterboxd.com/Some_One?x=1')).toBe('Some_One')
  })

  it('rejects non-profile URLs and junk', () => {
    expect(parseLetterboxdHandle('https://letterboxd.com/film/clayface/')).toBeNull()
    expect(parseLetterboxdHandle('https://example.com/michaellamb')).toBeNull()
    expect(parseLetterboxdHandle('two words')).toBeNull()
    expect(parseLetterboxdHandle('x'.repeat(31))).toBeNull()
    expect(parseLetterboxdHandle('')).toBeNull()
  })
})

describe('parseSources / validGiveaway', () => {
  it('requires a cap on referral and bounded integer weights', () => {
    expect(() => parseSources({ referral: { weight: 1 } })).toThrow(/cap/)
    expect(() => parseSources({ waitlist_signup: { weight: 0 } })).toThrow(/weight/)
    expect(() => parseSources({ lottery: { weight: 1 } })).toThrow(/unknown source/)
    expect(parseSources({ referral: { weight: 2, cap: 5 } })).toEqual({ referral: { weight: 2, cap: 5 } })
  })

  it('rejects an end before the start, and a voice source with no prompt', () => {
    expect(validGiveaway({ ...giveawayBody(), id: 'g-x', ends_at: '2020-01-01T00:00:00Z' }).error).toMatch(/after/)
    expect(validGiveaway({ ...giveawayBody({ sources: { voice_prompt: { weight: 1 } } }), id: 'g-x' }).error)
      .toMatch(/voice_prompt_id/)
  })
})

describe('isAcceptingEntries', () => {
  const g = { status: 'open', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-10-09T00:00:00Z' }
  it('needs status open AND the clock inside the window', () => {
    expect(isAcceptingEntries(g, Date.parse('2026-10-05T00:00:00Z'))).toBe(true)
    expect(isAcceptingEntries(g, Date.parse('2026-09-30T23:59:59Z'))).toBe(false)
    // The end is exclusive, and a forgotten status flip does not extend it.
    expect(isAcceptingEntries(g, Date.parse('2026-10-09T00:00:00Z'))).toBe(false)
    expect(isAcceptingEntries({ ...g, status: 'closed' }, Date.parse('2026-10-05T00:00:00Z'))).toBe(false)
    expect(isAcceptingEntries({ ...g, status: 'draft' }, Date.parse('2026-10-05T00:00:00Z'))).toBe(false)
  })
})

describe('secureRandomInt', () => {
  it('rejects the biased top of the range instead of taking a modulo', () => {
    // n = 3: 2^32 is not a multiple of 3, so the top value would favour 0.
    const seq = [2 ** 32 - 1, 7]
    const rand = () => seq.shift()
    expect(secureRandomInt(3, rand)).toBe(7 % 3)
    expect(seq).toEqual([])
  })

  it('stays in range with the real CSPRNG', () => {
    for (let i = 0; i < 500; i++) {
      const x = secureRandomInt(7)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(7)
    }
  })
})

describe('weightedDraw', () => {
  it('never picks the same member twice', () => {
    const pool = [{ member_id: 'a', weight: 5 }, { member_id: 'b', weight: 1 }, { member_id: 'c', weight: 1 }]
    for (let i = 0; i < 200; i++) {
      const { winners } = weightedDraw(pool, 3)
      expect(new Set(winners).size).toBe(3)
    }
  })

  it('maps tickets to members by cumulative weight', () => {
    const pool = [{ member_id: 'a', weight: 1 }, { member_id: 'b', weight: 3 }]
    // ticket 0 -> a; tickets 1..3 -> b.
    expect(weightedDraw(pool, 1, () => 0).winners).toEqual(['a'])
    expect(weightedDraw(pool, 1, () => 1).winners).toEqual(['b'])
    expect(weightedDraw(pool, 1, () => 3).winners).toEqual(['b'])
  })

  it('is weighted: 3 entries win about 3x as often as 1', () => {
    const pool = [{ member_id: 'heavy', weight: 3 }, { member_id: 'light', weight: 1 }]
    let heavy = 0
    const N = 4000
    for (let i = 0; i < N; i++) if (weightedDraw(pool, 1).winners[0] === 'heavy') heavy++
    // Expected 0.75; 4000 trials puts 5 standard deviations at about +/-0.034.
    expect(heavy / N).toBeGreaterThan(0.71)
    expect(heavy / N).toBeLessThan(0.79)
  })

  it('stops at the pool size when there are fewer members than winners', () => {
    expect(weightedDraw([{ member_id: 'a', weight: 1 }], 5).winners).toEqual(['a'])
  })
})

describe('poolHash / toCsv', () => {
  it('fingerprints the pool independent of row order', async () => {
    const a = await poolHash([{ member_id: 'x', weight: 1 }, { member_id: 'y', weight: 2 }])
    const b = await poolHash([{ member_id: 'y', weight: 2 }, { member_id: 'x', weight: 1 }])
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('quotes CSV and defuses spreadsheet formulas', () => {
    expect(toCsv(['name'], [['=HYPERLINK("x")'], ['Doe, Jane']]))
      .toBe('name\r\n"\'=HYPERLINK(""x"")"\r\n"Doe, Jane"\r\n')
  })
})

// --- entry rules over HTTP ---------------------------------------------------

describe('entering', () => {
  it('RSVP after entering earns the waitlist entry; entering is free and explicit', async () => {
    await putGiveaway('clay-wait')
    const m = await member('a@example.com')
    expect((await enter('clay-wait', m.token)).status).toBe(200)
    expect((await me('clay-wait', m.token)).total).toBe(0)

    expect((await rsvp(m.token)).status).toBe(200)
    const after = await me('clay-wait', m.token)
    expect(after.bySource.waitlist_signup).toEqual({ count: 1, entries: 1 })
    expect(after.total).toBe(1)
  })

  it('needs the rules accepted, and a session', async () => {
    await putGiveaway('clay-wait')
    const m = await member('b@example.com')
    expect((await enter('clay-wait', m.token, {})).status).toBe(400)
    expect((await enter('clay-wait', m.token, { acceptRules: 'yes' })).status).toBe(400)
    expect((await enter('clay-wait', null)).status).toBe(401)
  })

  it('an RSVP by someone who never entered earns nothing', async () => {
    await putGiveaway('clay-wait')
    const m = await member('c@example.com')
    expect((await rsvp(m.token)).status).toBe(200)
    const { results } = await env.GIVEAWAYS_DB.prepare('SELECT * FROM entries').all()
    expect(results).toEqual([])
  })

  it('refuses entries outside the window or when not open', async () => {
    const m = await member('d@example.com')
    await putGiveaway('clay-future', { starts_at: new Date(Date.now() + HOUR).toISOString() })
    expect((await enter('clay-future', m.token)).status).toBe(409)
    await putGiveaway('clay-closed', { status: 'closed' })
    expect((await enter('clay-closed', m.token)).status).toBe(409)
  })

  it('drafts are invisible to members', async () => {
    await putGiveaway('clay-draft', { status: 'draft' })
    const m = await member('e@example.com')
    expect((await enter('clay-draft', m.token)).status).toBe(404)
    const list = await (await req(`/giveaways?event=${EVENT_ID}`)).json()
    expect(list.giveaways.map(g => g.id)).not.toContain('clay-draft')
  })

  describe('count_prior_waitlist', () => {
    it('off: an RSVP made before the giveaway opened does not count', async () => {
      const m = await member('prior-off@example.com')
      expect((await rsvp(m.token)).status).toBe(200)
      // Backdate the RSVP to before the giveaway window.
      const raw = JSON.parse(await env.ATTENDANCE_KV.get(`rsvp:${EVENT_ID}`))
      raw.waitlist[0].at = Date.now() - 5 * HOUR
      await env.ATTENDANCE_KV.put(`rsvp:${EVENT_ID}`, JSON.stringify(raw))

      await putGiveaway('clay-prior-off', { count_prior_waitlist: false })
      await enter('clay-prior-off', m.token)
      expect((await me('clay-prior-off', m.token)).total).toBe(0)
    })

    it('on: the same earlier RSVP counts the moment they enter', async () => {
      const m = await member('prior-on@example.com')
      expect((await rsvp(m.token)).status).toBe(200)
      const raw = JSON.parse(await env.ATTENDANCE_KV.get(`rsvp:${EVENT_ID}`))
      raw.waitlist[0].at = Date.now() - 5 * HOUR
      await env.ATTENDANCE_KV.put(`rsvp:${EVENT_ID}`, JSON.stringify(raw))

      await putGiveaway('clay-prior-on', { count_prior_waitlist: true })
      await enter('clay-prior-on', m.token)
      expect((await me('clay-prior-on', m.token)).bySource.waitlist_signup.count).toBe(1)
    })
  })
})

describe('duplicate prevention', () => {
  it('one entry per member per source, however many times they act', async () => {
    await putGiveaway('clay-dupe')
    const m = await member('dupe@example.com', { handle: 'dupe_lb' })
    await enter('clay-dupe', m.token)
    await rsvp(m.token)
    await rsvp(m.token)
    await enter('clay-dupe', m.token)
    await enter('clay-dupe', m.token)
    const summary = await me('clay-dupe', m.token)
    expect(summary.bySource).toEqual({
      waitlist_signup: { count: 1, entries: 1 },
      letterboxd_link: { count: 1, entries: 1 },
    })
  })

  it('the database itself refuses a second row for the same source', async () => {
    await putGiveaway('clay-idx')
    const ins = () => env.GIVEAWAYS_DB.prepare(`INSERT INTO entries (giveaway_id, member_id, source, weight, created_at)
      VALUES ('clay-idx', 'm1', 'waitlist_signup', 1, '2026-10-01T00:00:00Z')`).run()
    await ins()
    await expect(ins()).rejects.toThrow(/UNIQUE/)
  })

  it('concurrent enters from one member still produce one entry per source', async () => {
    await putGiveaway('clay-race')
    const m = await member('race@example.com', { handle: 'race_lb' })
    await Promise.all(Array.from({ length: 8 }, () => enter('clay-race', m.token)))
    const { results } = await env.GIVEAWAYS_DB.prepare(
      "SELECT source, COUNT(*) AS n FROM entries WHERE giveaway_id = 'clay-race' GROUP BY source").all()
    expect(results).toEqual([{ source: 'letterboxd_link', n: 1 }])
  })
})

describe('letterboxd bonus entry', () => {
  it('a linked, existing profile is one entry', async () => {
    await putGiveaway('clay-lb')
    const m = await member('lb@example.com')
    await enter('clay-lb', m.token)
    const res = await req('/member/update', { method: 'POST', token: m.token, body: { handle: 'https://letterboxd.com/lb_person/' } })
    expect(res.status).toBe(200)
    const row = JSON.parse(await env.MEMBERS_KV.get('member:lb@example.com'))
    expect(row.handle).toBe('lb_person')   // the URL was reduced to the username
    expect((await me('clay-lb', m.token)).bySource.letterboxd_link.count).toBe(1)
  })

  it('a profile that does not exist is refused at link time', async () => {
    letterboxd({ ghost_user: 'no' })
    const m = await member('ghost@example.com')
    const res = await req('/member/update', { method: 'POST', token: m.token, body: { handle: 'ghost_user' } })
    expect(res.status).toBe(422)
  })

  it('a bot challenge does not block linking; the entry is flagged for review', async () => {
    letterboxd({ walled: 'challenge' })
    await putGiveaway('clay-lb-flag')
    const m = await member('walled@example.com')
    await enter('clay-lb-flag', m.token)
    expect((await req('/member/update', { method: 'POST', token: m.token, body: { handle: 'walled' } })).status).toBe(200)
    const e = await env.GIVEAWAYS_DB.prepare(
      "SELECT flagged, flag_reason FROM entries WHERE giveaway_id = 'clay-lb-flag' AND source = 'letterboxd_link'").first()
    expect(e.flagged).toBe(1)
    expect(e.flag_reason).toMatch(/could not be verified/)
  })
})

// --- admin + draw ----------------------------------------------------------

async function closedGiveawayWithEntrants(id, members, overrides = {}) {
  await putGiveaway(id, overrides)
  const people = []
  for (const email of members) {
    const m = await member(email)
    await enter(id, m.token)
    await rsvp(m.token)
    people.push(m)
  }
  const now = Date.now()
  await putGiveaway(id, {
    ...overrides, status: 'closed',
    starts_at: new Date(now - 2 * HOUR).toISOString(),
    ends_at: new Date(now - 60 * 1000).toISOString(),
  })
  return people
}

// A closed giveaway whose pool is written straight into D1. For the race
// tests only: they exercise the draw's transaction, and the real entry path
// (sign in, enter, RSVP) is covered above and is too slow to repeat 40 times.
async function seedClosedPool(id, n, overrides = {}, memberIds = null) {
  const now = Date.now()
  await putGiveaway(id, {
    ...overrides, status: 'closed',
    starts_at: new Date(now - 2 * HOUR).toISOString(), ends_at: new Date(now - 60 * 1000).toISOString(),
  })
  const ts = new Date(now - HOUR).toISOString()
  await env.GIVEAWAYS_DB.batch(Array.from({ length: n }, (_, i) => [
    env.GIVEAWAYS_DB.prepare(`INSERT INTO participants (giveaway_id, member_id, name, email, rules_accepted_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(id, memberIds ? memberIds[i] : `${id}-m${i}`, `M${i}`, `m${i}@example.com`, ts, ts),
    env.GIVEAWAYS_DB.prepare(`INSERT INTO entries (giveaway_id, member_id, source, weight, created_at)
      VALUES (?, ?, 'waitlist_signup', 1, ?)`).bind(id, memberIds ? memberIds[i] : `${id}-m${i}`, ts),
  ]).flat())
}

const draw = (id, body = {}, headers = { 'X-Admin-Email': 'michael@michaellamb.dev' }) =>
  req(`/admin/giveaways/${id}/draw`, { method: 'POST', token: ADMIN, body, headers })

describe('admin', () => {
  it('every admin route needs the admin token', async () => {
    await putGiveaway('clay-auth')
    for (const [path, method] of [
      ['/admin/giveaways', 'GET'], ['/admin/giveaways/clay-auth', 'PUT'],
      ['/admin/giveaways/clay-auth/entries', 'GET'], ['/admin/giveaways/clay-auth/draw', 'POST'],
      ['/admin/giveaways/clay-auth/winners.csv', 'GET'],
    ]) {
      expect((await req(path, { method, body: method === 'GET' ? undefined : {} })).status, path).toBe(401)
    }
  })

  it('entries view counts by source and can exclude an entry', async () => {
    await putGiveaway('clay-view')
    const m = await member('view@example.com', { handle: 'view_lb' })
    await enter('clay-view', m.token)
    await rsvp(m.token)
    const data = await (await req('/admin/giveaways/clay-view/entries', { token: ADMIN })).json()
    expect(data.participants).toBe(1)
    expect(Object.fromEntries(data.bySource.map(r => [r.source, r.entries])))
      .toEqual({ waitlist_signup: 1, letterboxd_link: 1 })

    const target = data.entries.find(e => e.source === 'letterboxd_link')
    expect((await req(`/admin/giveaways/clay-view/entries/${target.id}`, { method: 'POST', token: ADMIN, body: { excluded: true } })).status).toBe(200)
    expect((await me('clay-view', m.token)).total).toBe(1)
  })

  it('a drawn giveaway cannot be reopened, and "drawn" is only reachable by drawing', async () => {
    await putGiveaway('clay-status')
    const res = await req('/admin/giveaways/clay-status', { method: 'PUT', token: ADMIN, body: giveawayBody({ status: 'drawn' }) })
    expect(res.status).toBe(409)
  })
})

describe('draw', () => {
  it('only runs once the giveaway is closed and over', async () => {
    await putGiveaway('clay-early')
    expect((await draw('clay-early')).status).toBe(409)
  })

  it('picks distinct winners, logs the run, and marks the giveaway drawn', async () => {
    await closedGiveawayWithEntrants('clay-draw', ['w1@example.com', 'w2@example.com', 'w3@example.com'])
    const res = await draw('clay-draw')
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.winners).toHaveLength(2)
    expect(new Set(out.winners).size).toBe(2)
    expect(out.poolMembers).toBe(3)

    const log = await env.GIVEAWAYS_DB.prepare("SELECT * FROM draws WHERE giveaway_id = 'clay-draw'").first()
    expect(log.run_by).toBe('michael@michaellamb.dev')
    expect(log.kind).toBe('draw')
    expect(log.pool_entries).toBe(3)
    expect(log.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(log.random_values)).toHaveLength(2)
    expect(JSON.parse(log.winners)).toEqual(out.winners)

    const g = (await (await req('/admin/giveaways/clay-draw', { token: ADMIN })).json()).giveaway
    expect(g.status).toBe('drawn')
    // And not twice.
    expect((await draw('clay-draw')).status).toBe(409)
  })

  it('concurrent draws with room for disjoint winner sets still commit exactly one', async () => {
    // 10 entrants and 2 winners: two racing draws usually pick different
    // people, so only the transaction guard (not a key collision) can stop
    // the second one. Several rounds, because the race is probabilistic.
    for (let round = 0; round < 4; round++) {
      const id = `clay-race-draw-${round}`
      await seedClosedPool(id, 10)
      const results = await Promise.all([draw(id), draw(id), draw(id)])
      expect(results.filter(r => r.status === 200)).toHaveLength(1)
      const { results: winners } = await env.GIVEAWAYS_DB.prepare('SELECT * FROM winners WHERE giveaway_id = ?').bind(id).all()
      expect(winners).toHaveLength(2)
    }
  })

  it('concurrent redraws of one forfeit draw exactly one replacement', async () => {
    await seedClosedPool('clay-race-redraw', 10, { winners: 1 })
    const first = await (await draw('clay-race-redraw')).json()
    const gone = first.winners[0]
    const redraw = () => req('/admin/giveaways/clay-race-redraw/redraw', { method: 'POST', token: ADMIN, body: { memberId: gone } })
    const results = await Promise.all([redraw(), redraw(), redraw()])
    expect(results.filter(r => r.status === 200)).toHaveLength(1)
    const { results: selected } = await env.GIVEAWAYS_DB.prepare(
      "SELECT * FROM winners WHERE giveaway_id = 'clay-race-redraw' AND status = 'selected'").all()
    expect(selected).toHaveLength(1)
  })

  it('concurrent draws produce exactly one set of winners', async () => {
    await closedGiveawayWithEntrants('clay-twice', ['t1@example.com', 't2@example.com', 't3@example.com'])
    const results = await Promise.all([draw('clay-twice'), draw('clay-twice')])
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    const { results: winners } = await env.GIVEAWAYS_DB.prepare(
      "SELECT * FROM winners WHERE giveaway_id = 'clay-twice'").all()
    expect(winners).toHaveLength(2)
  })

  it('excluded entries never win, and flagged ones are out by default', async () => {
    const [a, b, c] = await closedGiveawayWithEntrants('clay-excl',
      ['x1@example.com', 'x2@example.com', 'x3@example.com'], { winners: 3 })
    await env.GIVEAWAYS_DB.prepare("UPDATE entries SET excluded = 1 WHERE member_id = ?").bind(a.id).run()
    await env.GIVEAWAYS_DB.prepare("UPDATE entries SET flagged = 1, flag_reason = 'test' WHERE member_id = ?").bind(b.id).run()
    const out = await (await draw('clay-excl')).json()
    expect(out.winners).toEqual([c.id])
  })

  it('an admin can choose to keep flagged entries in the pool', async () => {
    const [a] = await closedGiveawayWithEntrants('clay-keepflag', ['k1@example.com'], { winners: 1 })
    await env.GIVEAWAYS_DB.prepare("UPDATE entries SET flagged = 1 WHERE member_id = ?").bind(a.id).run()
    const out = await (await draw('clay-keepflag', { excludeFlagged: false })).json()
    expect(out.winners).toEqual([a.id])
  })

  it('redraw forfeits a non-responder and picks someone new', async () => {
    await closedGiveawayWithEntrants('clay-redraw',
      ['r1@example.com', 'r2@example.com', 'r3@example.com'], { winners: 1 })
    const first = await (await draw('clay-redraw')).json()
    const gone = first.winners[0]
    const res = await req('/admin/giveaways/clay-redraw/redraw', { method: 'POST', token: ADMIN, body: { memberId: gone } })
    expect(res.status).toBe(200)
    const second = await res.json()
    expect(second.winners).toHaveLength(1)
    expect(second.winners[0]).not.toBe(gone)

    const { winners, draws } = await (await req('/admin/giveaways/clay-redraw/winners', { token: ADMIN })).json()
    expect(winners.find(w => w.member_id === gone).status).toBe('forfeited')
    expect(winners.filter(w => w.status === 'selected').map(w => w.member_id)).toEqual(second.winners)
    expect(draws.map(d => d.kind)).toEqual(['draw', 'redraw'])
    expect(draws[1].replaces_member).toBe(gone)
    // Redrawing someone who is not a current winner is refused.
    expect((await req('/admin/giveaways/clay-redraw/redraw', { method: 'POST', token: ADMIN, body: { memberId: gone } })).status).toBe(404)
  })

  it('exports winners: full CSV for the admin, names only for the box office', async () => {
    const people = await closedGiveawayWithEntrants('clay-csv', ['c1@example.com', 'c2@example.com'])
    await draw('clay-csv')
    const full = await (await req('/admin/giveaways/clay-csv/winners.csv', { token: ADMIN })).text()
    const lines = full.trim().split('\r\n')
    expect(lines[0]).toBe('name,email,tickets')
    expect(lines).toHaveLength(3)
    for (const p of people) expect(full).toContain(`${p.name},${p.email},2`)

    const box = await (await req('/admin/giveaways/clay-csv/winners.csv?format=boxoffice', { token: ADMIN })).text()
    expect(box.split('\r\n')[0]).toBe('name,tickets')
    expect(box).not.toContain('@example.com')
  })
})

describe('rules page', () => {
  it('states no purchase necessary, eligibility, dates, method and contact', async () => {
    await putGiveaway('clay-rules', { winner_response_days: 4 })
    const res = await req('/giveaways/clay-rules/rules', { headers: { Accept: 'text/html' } })
    expect(res.status).toBe(200)
    const page = await res.text()
    expect(page).toMatch(/NO PURCHASE OR PAYMENT OF ANY KIND IS NECESSARY/)
    expect(page).toMatch(/Eligibility/)
    expect(page).toMatch(/Membership is free/)
    expect(page).toMatch(/Entries open .* Central and close .* Central/)
    expect(page).toMatch(/cryptographically secure/)
    expect(page).toMatch(/within 4 days/)
    expect(page).toMatch(/Sponsored by the Jackson Film Club/)
  })

  it('says which RSVPs count, following count_prior_waitlist', async () => {
    await putGiveaway('clay-rules-prior', { count_prior_waitlist: true })
    await putGiveaway('clay-rules-window', { count_prior_waitlist: false })
    expect(await (await req('/giveaways/clay-rules-prior/rules')).text()).toMatch(/made before entries opened counts too/)
    expect(await (await req('/giveaways/clay-rules-window/rules')).text()).toMatch(/made before entries opened does not count/)
  })

  it('escapes admin-written text', async () => {
    await putGiveaway('clay-xss', { rules_md: '<script>alert(1)</script>' })
    const page = await (await req('/giveaways/clay-xss/rules')).text()
    expect(page).not.toContain('<script>alert(1)</script>')
  })
})

describe('account deletion', () => {
  it('removes the member from every giveaway', async () => {
    await putGiveaway('clay-del')
    const m = await member('del@example.com', { handle: 'del_lb' })
    await enter('clay-del', m.token)
    expect((await req('/member/delete', { method: 'POST', token: m.token, body: {} })).status).toBe(200)
    const e = await env.GIVEAWAYS_DB.prepare('SELECT COUNT(*) AS n FROM entries WHERE member_id = ?').bind(m.id).first()
    const p = await env.GIVEAWAYS_DB.prepare('SELECT COUNT(*) AS n FROM participants WHERE member_id = ?').bind(m.id).first()
    expect(e.n + p.n).toBe(0)
  })
})

// --- referrals (phase 2) ------------------------------------------------------

async function signupWithRef(email, ref, { ip = '203.0.113.9', name = 'New ' + email.split('@')[0] } = {}) {
  const res = await req('/signup', { method: 'POST', body: { email, name, ref } })
  if (res.status !== 200) return { status: res.status, body: await res.json() }
  const pending = JSON.parse(await env.MEMBERS_KV.get(`pending:${email}`))
  const verify = await req('/signup/verify', {
    method: 'POST', body: { email, code: pending.code }, headers: { 'CF-Connecting-IP': ip },
  })
  return { status: verify.status, body: await verify.json(), pending }
}

async function referralGiveaway(id, cap = 10, extra = {}) {
  return putGiveaway(id, { sources: { waitlist_signup: { weight: 1 }, referral: { weight: 1, cap } }, ...extra })
}

async function referrerFor(id, email = 'referrer@example.com') {
  const m = await member(email)
  const res = await enter(id, m.token)
  const body = await res.json()
  return { ...m, code: body.referral.code, link: body.referral.link }
}

const referralEntries = (id, memberId) => env.GIVEAWAYS_DB.prepare(
  "SELECT * FROM entries WHERE giveaway_id = ? AND member_id = ? AND source = 'referral' ORDER BY id").bind(id, memberId).all()
  .then(r => r.results)
const referralRows = (id) => env.GIVEAWAYS_DB.prepare(
  'SELECT * FROM referrals WHERE giveaway_id = ? ORDER BY id').bind(id).all().then(r => r.results)

describe('referral link', () => {
  it('appears once the member enters, is stable, and points at the giveaway page', async () => {
    await referralGiveaway('clay-ref')
    const r = await referrerFor('clay-ref')
    expect(r.code).toMatch(/^[a-z0-9]{8}$/)
    expect(r.link).toBe(`https://jxnfilm.club/giveaways?event=${EVENT_ID}&ref=${r.code}`)
    const again = await me('clay-ref', r.token)
    expect(again.referral.code).toBe(r.code)
    expect(again.referral).toMatchObject({ credited: 0, cap: 10 })
  })

  it('is absent for a giveaway that does not count referrals', async () => {
    await putGiveaway('clay-noref')
    const m = await member('noref@example.com')
    const body = await (await enter('clay-noref', m.token)).json()
    expect(body.referral).toBeUndefined()
  })
})

describe('referral credit', () => {
  it('counts only once the referred email is verified', async () => {
    await referralGiveaway('clay-ref-verify')
    const r = await referrerFor('clay-ref-verify')
    expect((await req('/signup', { method: 'POST', body: { email: 'friend@example.com', name: 'Friend', ref: r.code } })).status).toBe(200)
    // Signed up but not verified: nothing yet.
    expect(await referralEntries('clay-ref-verify', r.id)).toEqual([])
    const pending = JSON.parse(await env.MEMBERS_KV.get('pending:friend@example.com'))
    expect(pending.ref).toBe(r.code)
    await req('/signup/verify', { method: 'POST', body: { email: 'friend@example.com', code: pending.code } })
    expect(await referralEntries('clay-ref-verify', r.id)).toHaveLength(1)
    expect((await me('clay-ref-verify', r.token)).referral.credited).toBe(1)
  })

  it('an email that already belongs to a member cannot be referred', async () => {
    await referralGiveaway('clay-ref-existing')
    const r = await referrerFor('clay-ref-existing')
    await member('taken@example.com')
    const out = await signupWithRef('taken@example.com', r.code)
    expect(out.status).toBe(409)
    expect(await referralRows('clay-ref-existing')).toEqual([])
  })

  it('blocks an alias of an existing member (case, +tag, gmail dots)', async () => {
    await referralGiveaway('clay-ref-alias')
    const r = await referrerFor('clay-ref-alias')
    await member('jane.doe@gmail.com')
    const out = await signupWithRef('JaneDoe+win@gmail.com', r.code)
    expect(out.status).toBe(200)   // signing up is still allowed ...
    const [row] = await referralRows('clay-ref-alias')
    expect(row.status).toBe('rejected')   // ... it just earns nothing
    expect(row.reason).toMatch(/alias of an existing member/)
    expect(await referralEntries('clay-ref-alias', r.id)).toEqual([])
  })

  it('blocks self-referral, including through an alias of your own address', async () => {
    await referralGiveaway('clay-ref-self')
    const r = await referrerFor('clay-ref-self', 'me.myself@gmail.com')
    await signupWithRef('memyself+second@gmail.com', r.code)
    const [row] = await referralRows('clay-ref-self')
    expect(row.status).toBe('rejected')
    expect(row.reason).toMatch(/self-referral/)
    expect(await referralEntries('clay-ref-self', r.id)).toEqual([])
  })

  it('stops at the cap and records the overflow as capped', async () => {
    await referralGiveaway('clay-ref-cap', 2)
    const r = await referrerFor('clay-ref-cap')
    for (const [i, email] of ['c1@example.com', 'c2@example.com', 'c3@example.com'].entries()) {
      await signupWithRef(email, r.code, { ip: `198.51.100.${i + 1}` })
    }
    expect(await referralEntries('clay-ref-cap', r.id)).toHaveLength(2)
    expect((await referralRows('clay-ref-cap')).map(x => x.status)).toEqual(['credited', 'credited', 'capped'])
    expect((await me('clay-ref-cap', r.token)).bySource.referral).toEqual({ count: 2, entries: 2 })
  })

  it('holds the cap when referrals are credited concurrently', async () => {
    await referralGiveaway('clay-ref-race', 2)
    const r = await referrerFor('clay-ref-race')
    const emails = ['r1@example.com', 'r2@example.com', 'r3@example.com', 'r4@example.com', 'r5@example.com']
    for (const e of emails) await req('/signup', { method: 'POST', body: { email: e, name: 'R', ref: r.code } })
    const codes = await Promise.all(emails.map(async e => JSON.parse(await env.MEMBERS_KV.get(`pending:${e}`)).code))
    await Promise.all(emails.map((e, i) => req('/signup/verify', {
      method: 'POST', body: { email: e, code: codes[i] }, headers: { 'CF-Connecting-IP': `192.0.2.${i + 1}` },
    })))
    expect(await referralEntries('clay-ref-race', r.id)).toHaveLength(2)
  })

  it('does not credit a referrer who never entered the giveaway', async () => {
    await referralGiveaway('clay-ref-noentry')
    const other = await referrerFor('clay-ref-noentry', 'entered@example.com')
    // A second giveaway the code owner never entered.
    await referralGiveaway('clay-ref-other')
    await signupWithRef('pal@example.com', other.code)
    expect(await referralEntries('clay-ref-other', other.id)).toEqual([])
    expect(await referralEntries('clay-ref-noentry', other.id)).toHaveLength(1)
  })

  it('ignores an unknown or malformed code', async () => {
    await referralGiveaway('clay-ref-bogus')
    await referrerFor('clay-ref-bogus')
    expect((await signupWithRef('who@example.com', 'zzzzzzzz')).status).toBe(200)
    expect((await signupWithRef('who2@example.com', '<script>')).status).toBe(200)
    expect(await referralRows('clay-ref-bogus')).toEqual([])
  })
})

describe('suspicious referrals are flagged, not rejected', () => {
  it('a disposable email domain', async () => {
    await referralGiveaway('clay-ref-disp')
    const r = await referrerFor('clay-ref-disp')
    await signupWithRef('burner@mailinator.com', r.code)
    const [entry] = await referralEntries('clay-ref-disp', r.id)
    expect(entry.flagged).toBe(1)
    expect(entry.flag_reason).toMatch(/disposable/)
    expect((await referralRows('clay-ref-disp'))[0].status).toBe('flagged')
  })

  it('many referral signups from one network', async () => {
    await referralGiveaway('clay-ref-ip')
    const r = await referrerFor('clay-ref-ip')
    for (let i = 1; i <= 4; i++) await signupWithRef(`net${i}@example.com`, r.code, { ip: '203.0.113.77' })
    const rows = await referralRows('clay-ref-ip')
    expect(rows.map(x => x.status)).toEqual(['credited', 'credited', 'credited', 'flagged'])
    expect(rows[3].reason).toMatch(/from one network/)
    // The raw IP is never stored.
    expect(JSON.stringify(rows)).not.toContain('203.0.113.77')
    expect(rows[0].ip_hash).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('a burst of referrals from one member (rate limit)', async () => {
    await referralGiveaway('clay-ref-rate', 50)
    const r = await referrerFor('clay-ref-rate')
    for (let i = 1; i <= 6; i++) await signupWithRef(`burst${i}@example.com`, r.code, { ip: `198.18.0.${i}` })
    const rows = await referralRows('clay-ref-rate')
    expect(rows.slice(0, 5).every(x => x.status === 'credited')).toBe(true)
    expect(rows[5].status).toBe('flagged')
    expect(rows[5].reason).toMatch(/in an hour/)
  })

  it('flagged referral entries stay out of the draw unless the admin keeps them', async () => {
    await referralGiveaway('clay-ref-draw', 10, { winners: 1 })
    const r = await referrerFor('clay-ref-draw')
    await signupWithRef('only@mailinator.com', r.code)
    // Close it and draw: the referrer's only entry is flagged.
    const now = Date.now()
    await putGiveaway('clay-ref-draw', {
      sources: { waitlist_signup: { weight: 1 }, referral: { weight: 1, cap: 10 } }, winners: 1, status: 'closed',
      starts_at: new Date(now - 2 * HOUR).toISOString(), ends_at: new Date(now - 60 * 1000).toISOString(),
    })
    expect((await draw('clay-ref-draw')).status).toBe(409)   // empty pool
  })
})

// --- voice prompt (phase 2) ---------------------------------------------------

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])
function postClip(token, { duration = 30 } = {}) {
  return SELF.fetch('https://join.jxnfilm.club/voice', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/webm', 'X-Voice-Consent': 'yes', 'X-Voice-Duration': String(duration) },
    body: WEBM,
  })
}

async function voiceGiveaway(id, extra = {}) {
  return putGiveaway(id, {
    sources: { voice_prompt: { weight: 2 } }, voice_prompt_id: 'general', voice_max_seconds: 60, ...extra,
  })
}

describe('voice prompt entries', () => {
  it('a clip for the giveaway prompt earns its weight; length pending until measured', async () => {
    await voiceGiveaway('clay-voice')
    const m = await member('voice@example.com')
    await enter('clay-voice', m.token)
    expect((await postClip(m.token)).status).toBe(200)
    const e = await env.GIVEAWAYS_DB.prepare(
      "SELECT * FROM entries WHERE giveaway_id = 'clay-voice' AND source = 'voice_prompt'").first()
    expect(e.weight).toBe(2)
    expect(e.flagged).toBe(1)
    expect(e.flag_reason).toMatch(/not yet measured/)

    // node0 reports the real length: under the limit clears the flag.
    const row = JSON.parse(await env.MEMBERS_KV.get(`voice:general:${m.id}`))
    const res = await req('/transcriber/measure', {
      method: 'POST', token: 'test-transcribe-token', body: { key: `voice:general:${m.id}`, at: row.at, seconds: 42.3 },
    })
    expect(res.status).toBe(200)
    const after = await env.GIVEAWAYS_DB.prepare(
      "SELECT flagged FROM entries WHERE giveaway_id = 'clay-voice' AND source = 'voice_prompt'").first()
    expect(after.flagged).toBe(0)
    expect((await me('clay-voice', m.token)).total).toBe(2)
  })

  it('a measured length over the limit keeps the entry flagged', async () => {
    await voiceGiveaway('clay-voice-long')
    const m = await member('long@example.com')
    await enter('clay-voice-long', m.token)
    await postClip(m.token)
    const row = JSON.parse(await env.MEMBERS_KV.get(`voice:general:${m.id}`))
    await req('/transcriber/measure', {
      method: 'POST', token: 'test-transcribe-token', body: { key: `voice:general:${m.id}`, at: row.at, seconds: 95 },
    })
    const e = await env.GIVEAWAYS_DB.prepare(
      "SELECT flagged, flag_reason FROM entries WHERE giveaway_id = 'clay-voice-long' AND source = 'voice_prompt'").first()
    expect(e.flagged).toBe(1)
    expect(e.flag_reason).toMatch(/length 95 s > 60 s/)
  })

  it('needs a logged-in member (the voice upload itself requires one)', async () => {
    await voiceGiveaway('clay-voice-anon')
    const res = await SELF.fetch('https://join.jxnfilm.club/voice', {
      method: 'POST', headers: { 'Content-Type': 'audio/webm', 'X-Voice-Consent': 'yes' }, body: WEBM,
    })
    expect(res.status).toBe(401)
  })

  it('deleting the clip withdraws the entry while the giveaway is open', async () => {
    await voiceGiveaway('clay-voice-del')
    const m = await member('vdel@example.com')
    await enter('clay-voice-del', m.token)
    await postClip(m.token)
    expect((await me('clay-voice-del', m.token)).bySource.voice_prompt).toBeTruthy()
    expect((await req('/voice', { method: 'DELETE', token: m.token })).status).toBe(200)
    expect((await me('clay-voice-del', m.token)).bySource.voice_prompt).toBeUndefined()
  })
})

// --- Instagram (external) giveaways -------------------------------------------

const IG_HOW = 'Follow @jxnfilmclub, @offbeat and @msfilmsociety\nTag a friend in the comments; each comment tagging a different friend is one entry'

async function igGiveaway(id, extra = {}) {
  return putGiveaway(id, {
    winners: 2, sources: { instagram: { how: IG_HOW, post_url: 'https://www.instagram.com/p/ABC123/' } }, ...extra,
  })
}
const record = (id, body) => req(`/admin/giveaways/${id}/record-winners`, {
  method: 'POST', token: ADMIN, body, headers: { 'X-Admin-Email': 'michael@michaellamb.dev' },
})
async function closeIt(id, extra = {}) {
  const now = Date.now()
  await igGiveaway(id, { ...extra, status: 'closed',
    starts_at: new Date(now - 2 * HOUR).toISOString(), ends_at: new Date(now - 60 * 1000).toISOString() })
}

describe('instagram giveaways', () => {
  it('cannot be mixed with portal sources, and needs how-to-enter text', async () => {
    expect(() => parseSources({ instagram: { how: 'x' }, referral: { weight: 1, cap: 2 } })).toThrow(/cannot also take portal entries/)
    expect(() => parseSources({ instagram: {} })).toThrow(/instagram.how/)
    expect(() => parseSources({ instagram: { how: 'x', post_url: 'https://evil.example/p/1' } })).toThrow(/post_url/)
  })

  it('refuses portal entry', async () => {
    await igGiveaway('clay-ig-enter')
    const m = await member('igenter@example.com')
    const res = await enter('clay-ig-enter', m.token)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/Instagram/)
  })

  it('has its own official rules: Instagram entry, no membership needed, DM contact', async () => {
    await igGiveaway('clay-ig-rules', { rules_md: 'Eligibility: 18+, Mississippi residents.' })
    const page = await (await req('/giveaways/clay-ig-rules/rules')).text()
    expect(page).toMatch(/NO PURCHASE OR PAYMENT OF ANY KIND IS NECESSARY/)
    expect(page).toMatch(/You do not need to be a club member/)
    expect(page).toMatch(/Tag a friend in the comments/)
    expect(page).toMatch(/instagram.com\/p\/ABC123/)
    expect(page).toMatch(/comment-picker/)
    expect(page).toMatch(/Instagram direct message/)
    expect(page).toMatch(/18\+, Mississippi residents/)
    expect(page).not.toMatch(/Log in, open the giveaway/)
  })

  it('records the comment-picker winners into the CSV; the log holds no handle', async () => {
    await closeIt('clay-ig-win')
    const res = await record('clay-ig-win', { winners: ['Jane Doe, @JaneDoe', 'Sam Roe @sam.roe'], note: 'commentpicker, 212 comments' })
    expect(res.status).toBe(200)
    const box = await (await req('/admin/giveaways/clay-ig-win/winners.csv?format=boxoffice', { token: ADMIN })).text()
    expect(box).toBe('name,tickets\r\nJane Doe (@janedoe),2\r\nSam Roe (@sam.roe),2\r\n')
    const log = await env.GIVEAWAYS_DB.prepare("SELECT * FROM draws WHERE giveaway_id = 'clay-ig-win'").first()
    expect(log.run_by).toBe('michael@michaellamb.dev')
    expect(log.winners).not.toMatch(/janedoe|sam/)
    expect(JSON.parse(log.random_values).note).toMatch(/212 comments/)
    const g = (await (await req('/admin/giveaways/clay-ig-win', { token: ADMIN })).json()).giveaway
    expect(g.status).toBe('drawn')
  })

  it('refuses to record before the giveaway is closed and over, or more winners than it has', async () => {
    await igGiveaway('clay-ig-early')
    expect((await record('clay-ig-early', { winners: ['A B, @ab'] })).status).toBe(409)
    await closeIt('clay-ig-many')
    expect((await record('clay-ig-many', { winners: ['A, @a1', 'B, @b1', 'C, @c1'] })).status).toBe(400)
    expect((await record('clay-ig-many', { winners: ['no handle here'] })).status).toBe(400)
  })

  it('replaces a winner who did not reply', async () => {
    await closeIt('clay-ig-swap')
    const first = await (await record('clay-ig-swap', { winners: ['Jane Doe, @janedoe', 'Sam Roe, @samroe'] })).json()
    const res = await record('clay-ig-swap', { replaces: first.winners[0], winners: ['Pat Poe, @patpoe'] })
    expect(res.status).toBe(200)
    const box = await (await req('/admin/giveaways/clay-ig-swap/winners.csv?format=boxoffice', { token: ADMIN })).text()
    expect(box).toContain('Pat Poe (@patpoe),2')
    expect(box).not.toContain('Jane Doe')
  })

  it('cannot be drawn by the portal', async () => {
    await closeIt('clay-ig-draw')
    expect((await draw('clay-ig-draw')).status).toBe(409)
  })
})

describe('one prize per person per event', () => {
  it('a member who already won one giveaway for the event is out of the next pool', async () => {
    // Same two members in two giveaways for one event; the pool is seeded
    // directly (the entry path is covered above and is slow on CI runners).
    const people = ['pp-one', 'pp-two']
    await seedClosedPool('clay-first', 2, { winners: 1 }, people)
    const first = await (await draw('clay-first')).json()
    const winner = first.winners[0]
    await seedClosedPool('clay-second', 2, { winners: 1 }, people)
    const second = await (await draw('clay-second')).json()
    expect(second.poolMembers).toBe(1)
    expect(second.winners).toEqual(people.filter(p => p !== winner))
  })
})
