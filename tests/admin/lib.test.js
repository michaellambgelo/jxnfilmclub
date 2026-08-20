import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  qs, escapeHtml, attr, tryParse, fmtAge, fmtJoined, fmtExpiry,
  buildWatchedSectionHtml, buildWatchedSectionText, starsOf,
  buildVoiceCtaHtml, buildVoiceCtaText,
  fmtShowtime, buildEventsSectionHtml, buildEventsSectionText,
  buildPosterBlockHtml, buildPosterBlockText,
  attendanceWithHosts, buildStatsContext, computeMemberStats, ordinal,
} from '../../admin/lib.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('tryParse', () => {
  it('parses valid JSON', () => {
    expect(tryParse('{"a":1}')).toEqual({ a: 1 })
    expect(tryParse('[1,2]')).toEqual([1, 2])
  })

  it('returns null for garbage, null, and undefined', () => {
    expect(tryParse('{nope')).toBeNull()
    expect(tryParse(null)).toBeNull()
    expect(tryParse(undefined)).toBeNull()
  })
})

describe('escapeHtml / attr', () => {
  it('escapes the five HTML entities', () => {
    expect(escapeHtml(`<img src="x" onerror='a'> & more`))
      .toBe('&lt;img src=&quot;x&quot; onerror=&#39;a&#39;&gt; &amp; more')
  })

  it('returns empty string for null/undefined and stringifies non-strings', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })

  it('attr is the same escaping (attribute context)', () => {
    expect(attr('"quoted"')).toBe('&quot;quoted&quot;')
  })
})

describe('qs', () => {
  it('serializes params and URL-encodes values', () => {
    expect(qs({ env: 'production', key: 'member:a@b.com' }))
      .toBe('env=production&key=member%3Aa%40b.com')
  })
})

describe('fmtJoined', () => {
  it('does NOT roll a bare YYYY-MM-DD back a day (legacy-row regression)', () => {
    // Parsed as a UTC instant and reformatted in America/Chicago this would
    // display Dec 31 — the exact bug the bareDate branch guards against.
    expect(fmtJoined('2026-01-01')).toBe('Jan 1, 2026')
  })

  it('formats a full ISO timestamp in America/Chicago', () => {
    // 03:00 UTC = 21:00 or 22:00 the previous day Central — date rolls back.
    expect(fmtJoined('2026-01-01T03:00:00Z')).toBe('Dec 31, 2025')
  })

  it('falls through to escaped input for garbage, em-dash for empty', () => {
    expect(fmtJoined('not-a-date')).toBe('not-a-date')
    expect(fmtJoined('<script>')).toBe('&lt;script&gt;')
    expect(fmtJoined('')).toBe('—')
    expect(fmtJoined(null)).toBe('—')
  })
})

describe('fmtAge', () => {
  it('formats seconds/minutes/hours/days boundaries', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T12:00:00Z'))
    const now = Date.now()
    expect(fmtAge(now - 30_000)).toBe('30s ago')
    expect(fmtAge(now - 90_000)).toBe('1m ago')
    expect(fmtAge(now - 2 * 3_600_000)).toBe('2h ago')
    expect(fmtAge(now - 3 * 86_400_000)).toBe('3d ago')
  })

  it('em-dash for falsy input', () => {
    expect(fmtAge(0)).toBe('—')
    expect(fmtAge(null)).toBe('—')
  })
})

describe('fmtExpiry', () => {
  it('formats remaining time and expiry boundaries', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T12:00:00Z'))
    const nowSec = Math.floor(Date.now() / 1000)
    expect(fmtExpiry(nowSec - 10)).toBe('expired')
    expect(fmtExpiry(nowSec + 30)).toBe('30s')
    expect(fmtExpiry(nowSec + 5 * 60)).toBe('5m')
    expect(fmtExpiry(nowSec + 3 * 3600)).toBe('3h')
    expect(fmtExpiry(nowSec + 10 * 86400)).toBe('10d')
  })

  it('em-dash for falsy input', () => {
    expect(fmtExpiry(0)).toBe('—')
    expect(fmtExpiry(undefined)).toBe('—')
  })
})

describe('buildWatchedSectionHtml', () => {
  const entry = {
    title: 'The Third Man', year: '1949', handle: 'moviefan',
    name: 'Mo V. Fan', link: 'https://letterboxd.com/moviefan/film/the-third-man/',
    poster: 'https://a.ltrbxd.com/poster.jpg', watched_date: '2026-07-20',
  }

  it('renders poster cell, linked title, year, name, and date', () => {
    const html = buildWatchedSectionHtml([entry])
    expect(html).toContain('src="https://a.ltrbxd.com/poster.jpg"')
    expect(html).toContain('<strong>The Third Man</strong>')
    expect(html).toContain('(1949)')
    expect(html).toContain('Mo V. Fan')
    expect(html).toContain('Jul 20, 2026')
    expect(html).toContain('href="https://letterboxd.com/moviefan/film/the-third-man/"')
  })

  it('omits optional segments and falls back to @handle when name is missing', () => {
    const html = buildWatchedSectionHtml([{ title: 'Film', handle: 'someuser', link: 'https://x.example/' }])
    expect(html).not.toContain('<img')
    expect(html).not.toContain('()')
    expect(html).toContain('@someuser')
  })

  it('escapes hostile titles and attribute-injecting links', () => {
    const html = buildWatchedSectionHtml([{
      title: '<script>alert(1)</script>', handle: 'x',
      link: 'https://x.example/"><script>', year: '<b>',
    }])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('https://x.example/&quot;&gt;')
  })

  it('renders the star/heart verdict only when rating or liked is present', () => {
    const rated = buildWatchedSectionHtml([{ ...entry, rating: '4.5', liked: true }])
    expect(rated).toContain('★★★★½')
    expect(rated).toContain('&hearts;')

    const likedOnly = buildWatchedSectionHtml([{ ...entry, liked: true }])
    expect(likedOnly).toContain('&hearts;')
    expect(likedOnly).not.toContain('★')

    const plain = buildWatchedSectionHtml([entry])
    expect(plain).not.toContain('★')
    expect(plain).not.toContain('&hearts;')
  })
})

describe('buildWatchedSectionText', () => {
  it('renders full and minimal line shapes', () => {
    const text = buildWatchedSectionText([
      { title: 'The Third Man', year: '1949', name: 'Mo', watched_date: '2026-07-20', link: 'https://l/1', handle: 'mo' },
      { title: 'Film', handle: 'someuser', link: 'https://l/2' },
    ])
    expect(text).toContain('- The Third Man (1949) — Mo, 2026-07-20\n  https://l/1')
    expect(text).toContain('- Film — @someuser\n  https://l/2')
    expect(text).toContain('See all member activity: https://jxnfilm.club/watched')
  })

  it('appends the verdict after the year when present', () => {
    const text = buildWatchedSectionText([
      { title: 'Pillion', year: '2025', rating: '4.5', liked: true, name: 'Mo', watched_date: '2026-08-10', link: 'https://l/3', handle: 'mo' },
      { title: 'Film', rating: '3.0', handle: 'someuser', link: 'https://l/4' },
    ])
    expect(text).toContain('- Pillion (2025) ★★★★½ ♥ — Mo, 2026-08-10')
    expect(text).toContain('- Film ★★★ — @someuser')
  })
})

describe('buildVoiceCta', () => {
  it('quotes the prompt, links /speak, escapes hostile text', () => {
    const html = buildVoiceCtaHtml({ text: 'Best <b>snack</b>?' })
    expect(html).toContain('href="https://jxnfilm.club/speak"')
    expect(html).toContain('Best &lt;b&gt;snack&lt;/b&gt;?')
    expect(html).not.toContain('<b>snack</b>')
    expect(html).toContain('Your voice on the podcast')

    const text = buildVoiceCtaText({ text: 'Best snack?' })
    expect(text).toContain('"Best snack?"')
    expect(text).toContain('https://jxnfilm.club/speak')
  })
})

describe('starsOf', () => {
  it('maps ratings to Letterboxd half-star strings', () => {
    expect(starsOf('5.0')).toBe('★★★★★')
    expect(starsOf('4.5')).toBe('★★★★½')
    expect(starsOf('3.0')).toBe('★★★')
    expect(starsOf('0.5')).toBe('½')
    expect(starsOf(undefined)).toBe('')
    expect(starsOf('junk')).toBe('')
  })
})

describe('fmtShowtime', () => {
  it('converts 24h HH:MM to h:mm am/pm', () => {
    expect(fmtShowtime('19:30')).toBe('7:30 pm')
    expect(fmtShowtime('00:05')).toBe('12:05 am')
    expect(fmtShowtime('12:00')).toBe('12:00 pm')
    expect(fmtShowtime('09:15')).toBe('9:15 am')
  })

  it('returns empty string for missing/malformed input', () => {
    expect(fmtShowtime('')).toBe('')
    expect(fmtShowtime(undefined)).toBe('')
    expect(fmtShowtime('7pm')).toBe('')
  })
})

describe('buildEventsSectionHtml', () => {
  const houseEvent = {
    id: '2099-06-15-test', title: 'June Screening', film: 'Crash', year: 1996,
    date: '2099-06-15', time: '19:00', venue: "Mo's house", poster: 'https://img.tmdb.org/p.jpg',
    letterboxd_uri: 'https://boxd.it/abc', hostId: 'm1', hostName: 'Mo',
    capacity: 8, address: '123 Secret St, Jackson, MS', notes: 'Gate code 4321',
  }

  it('renders poster, linked film, year, date+showtime, venue, host — never private fields', () => {
    const html = buildEventsSectionHtml([houseEvent])
    expect(html).toContain('src="https://img.tmdb.org/p.jpg"')
    expect(html).toContain('href="https://boxd.it/abc"')
    expect(html).toContain('<strong>Crash</strong>')
    expect(html).toContain('(1996)')
    expect(html).toContain('Jun 15, 2099')
    expect(html).toContain('at 7:00 pm')
    expect(html).toContain('Mo&#39;s house')
    expect(html).toContain('Hosted by Mo')
    expect(html).toContain('https://jxnfilm.club/events')
    // Canonical event: rows carry the private address/notes — they must
    // never reach the newsletter.
    expect(html).not.toContain('123 Secret St')
    expect(html).not.toContain('Gate code')
    expect(html).not.toContain('4321')
    expect(html).not.toContain('capacity')
  })

  it('unlinked film renders plain; venue falls back for hosted rows without one', () => {
    const html = buildEventsSectionHtml([{
      title: 'Mystery Night', date: '2099-07-01', hostId: 'm2', hostName: 'Sam',
    }])
    // Title renders plain — the only anchor is the See-all footer link.
    expect(html).toContain('<strong>Mystery Night</strong>')
    expect(html.match(/<a href/g)).toHaveLength(1)
    expect(html).toContain('Member-hosted screening')
    expect(html).not.toContain(' at ')  // no time segment
  })

  it('renders bare dates without a day shift and escapes hostile fields', () => {
    const html = buildEventsSectionHtml([{
      title: '<script>alert(1)</script>', date: '2099-09-01',
      venue: '<b>x</b>', hostName: '"><img onerror=1>', hostId: 'm3',
      letterboxd_uri: 'https://x.example/"><script>',
    }])
    expect(html).toContain('Sep 1, 2099')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('https://x.example/&quot;&gt;')
  })
})

describe('buildEventsSectionText', () => {
  it('renders full and minimal line shapes, never private fields', () => {
    const text = buildEventsSectionText([
      { title: 'June Screening', film: 'Crash', year: 1996, date: '2099-06-15', time: '19:00',
        venue: "Mo's house", hostId: 'm1', hostName: 'Mo', letterboxd_uri: 'https://boxd.it/abc',
        address: '123 Secret St', notes: 'Gate code' },
      { title: 'Mystery Night', date: '2099-07-01', hostId: 'm2' },
    ])
    expect(text).toContain("- Crash (1996) — 2099-06-15 at 7:00 pm, Mo's house, hosted by Mo\n  https://boxd.it/abc")
    expect(text).toContain('- Mystery Night — 2099-07-01, Member-hosted screening')
    expect(text).toContain('See all events: https://jxnfilm.club/events')
    expect(text).not.toContain('Secret St')
    expect(text).not.toContain('Gate code')
  })
})

describe('buildPosterBlockHtml / buildPosterBlockText', () => {
  const block = {
    poster: 'https://image.tmdb.org/t/p/w500/x.jpg',
    link: 'https://jxnfilm.club/events',
    title: 'Halloween', year: '1978',
  }

  it('wraps the poster and caption in the link when one is given', () => {
    const html = buildPosterBlockHtml(block)
    expect(html).toContain('<a href="https://jxnfilm.club/events"')
    expect(html).toContain('src="https://image.tmdb.org/t/p/w500/x.jpg"')
    expect(html).toContain('alt="Halloween (1978) poster"')
    expect(html).toContain('Halloween (1978)')
  })

  it('renders an unlinked poster when no link is given', () => {
    const html = buildPosterBlockHtml({ ...block, link: '' })
    expect(html).not.toContain('<a ')
    expect(html).toContain('src="https://image.tmdb.org/t/p/w500/x.jpg"')
  })

  it('escapes attacker-controlled title and link values', () => {
    const html = buildPosterBlockHtml({
      poster: 'https://image.tmdb.org/t/p/w500/x.jpg',
      link: 'https://x.example/"onmouseover="a',
      title: '<script>alert(1)</script>', year: '',
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('https://x.example/&quot;onmouseover=&quot;a')
  })

  it('assumes body copy follows: centered poster, left-aligned body seed', () => {
    const html = buildPosterBlockHtml(block)
    // The card td itself is NOT centered — only the inner poster table is —
    // so review paragraphs typed after the seed inherit left alignment.
    expect(html).not.toMatch(/<td align="center" style="padding:28px/)
    expect(html).toContain('About Halloween (1978)')
    expect(html).toContain('[Write your review or announcement here')
    // No caption → generic headline placeholder.
    expect(buildPosterBlockHtml({ ...block, title: '', year: '' })).toContain('Your headline here')
  })

  it('text fallback is "caption: link" plus the body placeholder', () => {
    expect(buildPosterBlockText(block)).toBe(
      'Halloween (1978): https://jxnfilm.club/events\n[Write your review or announcement here — replace this placeholder before sending.]')
    expect(buildPosterBlockText({ ...block, link: '' })).toContain('Halloween (1978)\n[Write')
    expect(buildPosterBlockText({ link: 'https://x.example', title: '', year: '' })).toContain('https://x.example\n[Write')
  })
})

// --- Member stats -----------------------------------------------------------
//
// These pin the semantics that computeAccountStats() in ui/auth.html also
// implements. The two cannot share code, so parity is a test obligation.

const STATS_EVENTS = [
  { id: 'e-past-1',  date: '2026-01-10' },
  { id: 'e-past-2',  date: '2026-02-10' },
  // Member-hosted screening in the past; the host never got mirrored into
  // attend:{id}, which is exactly what the read-time overlay exists to fix.
  { id: 'e-hosted',  date: '2026-03-10', hostId: 'id-hosty', hostName: 'Hosty McHost' },
  { id: 'e-future',  date: '2099-01-01' },
  { id: 'e-future2', date: '2099-06-01' },
]

const STATS_ATTENDANCE = {
  'e-past-1': ['Ann Attendee', 'Bob Buff', 'Cara Cinema'],
  'e-past-2': ['Ann Attendee', 'Bob Buff'],
  'e-hosted': ['Ann Attendee'],
}

function ctxFor(overrides = {}) {
  return buildStatsContext({
    attendance: STATS_ATTENDANCE,
    events: STATS_EVENTS,
    rsvps: {
      'rsvp:e-future': { confirmed: [{ memberId: 'id-ann' }], waitlist: [{ memberId: 'id-bob' }] },
      'rsvp:e-future2': { confirmed: [{ memberId: 'id-ann' }], waitlist: [] },
      // Past event — must not count toward "upcoming".
      'rsvp:e-past-1': { confirmed: [{ memberId: 'id-ann' }], waitlist: [] },
    },
    voiceKeys: ['voice:general:id-ann', 'voice:muppets:id-ann', 'voice:general:id-bob'],
    watched: { michaellamb: [1, 2, 3], MixedCase: [1] },
    ...overrides,
  }, new Date('2026-08-19T12:00:00Z'))
}

describe('attendanceWithHosts', () => {
  it('overlays the host onto their own screening', () => {
    const out = attendanceWithHosts(STATS_ATTENDANCE, STATS_EVENTS)
    expect(out['e-hosted']).toEqual(['Hosty McHost', 'Ann Attendee'])
  })

  it('is idempotent — a host already present is not duplicated', () => {
    const already = { 'e-hosted': ['Hosty McHost', 'Ann Attendee'] }
    expect(attendanceWithHosts(already, STATS_EVENTS)['e-hosted'])
      .toEqual(['Hosty McHost', 'Ann Attendee'])
  })

  it('leaves club screenings (no host) untouched and does not mutate the input', () => {
    const input = { 'e-past-1': ['Ann Attendee'] }
    const out = attendanceWithHosts(input, STATS_EVENTS)
    expect(out['e-past-1']).toEqual(['Ann Attendee'])
    expect(input['e-hosted']).toBeUndefined()
  })
})

describe('computeMemberStats', () => {
  it('counts attendance, and credits a host for their own screening', () => {
    const ctx = ctxFor()
    // Without the overlay this host would score 0 and contradict their card.
    const hosty = computeMemberStats({ id: 'id-hosty', name: 'Hosty McHost' }, ctx)
    expect(hosty.attended).toBe(1)
    expect(hosty.hosted).toBe(1)
  })

  it('ranks ties to the better position, leaving the next place vacant', () => {
    const ctx = ctxFor()
    // Ann 3, Bob 2, Cara 1, Hosty 1 → Cara and Hosty tie for 3rd; no 4th.
    expect(computeMemberStats({ id: 'id-ann', name: 'Ann Attendee' }, ctx).rankLabel).toBe('1st')
    expect(computeMemberStats({ id: 'id-bob', name: 'Bob Buff' }, ctx).rankLabel).toBe('2nd')
    expect(computeMemberStats({ id: 'id-cara', name: 'Cara Cinema' }, ctx).rankLabel).toBe('3rd')
    expect(computeMemberStats({ id: 'id-hosty', name: 'Hosty McHost' }, ctx).rankLabel).toBe('3rd')
  })

  it('gives no rank to a member with no attendance', () => {
    const s = computeMemberStats({ id: 'id-new', name: 'Nora New' }, ctxFor())
    expect(s.rank).toBe(0)
    expect(s.rankLabel).toBe('')
  })

  it('counts only upcoming RSVPs, confirmed and waitlisted alike', () => {
    const ctx = ctxFor()
    // Ann holds two upcoming seats plus one on a past event, which is excluded.
    expect(computeMemberStats({ id: 'id-ann', name: 'Ann Attendee' }, ctx).rsvps).toBe(2)
    // Bob is waitlisted on one upcoming event — a waitlist place still counts.
    expect(computeMemberStats({ id: 'id-bob', name: 'Bob Buff' }, ctx).rsvps).toBe(1)
  })

  it('looks up watched films by exact handle case and reports 0 when unlinked', () => {
    const ctx = ctxFor()
    expect(computeMemberStats({ id: 'x', name: 'X', handle: 'michaellamb' }, ctx).logged).toBe(3)
    expect(computeMemberStats({ id: 'x', name: 'X', handle: 'MixedCase' }, ctx).logged).toBe(1)
    // Wrong case must not match — the public watched view does not normalize.
    expect(computeMemberStats({ id: 'x', name: 'X', handle: 'mixedcase' }, ctx).logged).toBe(0)
    expect(computeMemberStats({ id: 'x', name: 'X' }, ctx).logged).toBe(0)
  })

  it('counts voice clips by the trailing member id of voice:{prompt}:{id}', () => {
    const ctx = ctxFor()
    expect(computeMemberStats({ id: 'id-ann', name: 'Ann Attendee' }, ctx).clips).toBe(2)
    expect(computeMemberStats({ id: 'id-bob', name: 'Bob Buff' }, ctx).clips).toBe(1)
    expect(computeMemberStats({ id: 'id-cara', name: 'Cara Cinema' }, ctx).clips).toBe(0)
  })

  it('flags a likely rename: joined before past screenings, yet attended none', () => {
    const ctx = ctxFor()
    const renamed = computeMemberStats({ id: 'id-ghost', name: 'New Name', joined: '2026-01-01' }, ctx)
    expect(renamed.renamed).toBe(true)

    // Joined after every past screening — a zero is simply "not been yet".
    const fresh = computeMemberStats({ id: 'id-fresh', name: 'Fresh', joined: '2026-08-01' }, ctx)
    expect(fresh.renamed).toBe(false)

    // Attendance on the board is never a rename, whenever they joined.
    const present = computeMemberStats({ id: 'id-ann', name: 'Ann Attendee', joined: '2026-01-01' }, ctx)
    expect(present.renamed).toBe(false)
  })
})

describe('ordinal', () => {
  it('handles the teens exception and the 1/2/3 suffixes', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th'])
  })
})
