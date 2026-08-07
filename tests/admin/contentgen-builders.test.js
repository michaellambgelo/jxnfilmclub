import { describe, expect, it } from 'vitest'
import {
  socialEventView, buildSocialCopy, buildRoundupData, socialFileName,
  fmtSocialDate, PLATFORM_LIMITS,
} from '../../admin/lib.js'

// A canonical hosted-event KV row — includes every private field that must
// never surface in social output.
const HOSTED_EVENT = {
  id: '2026-06-12-passion',
  title: 'Summer Screening',
  film: 'The Passion of Joan of Arc',
  year: 1928,
  date: '2026-06-12',
  time: '19:00',
  venue: 'The Vault',
  poster: 'https://image.tmdb.org/t/p/w500/x.jpg',
  letterboxd_uri: 'https://letterboxd.com/film/the-passion-of-joan-of-arc/',
  hostId: 'ml-seed001',
  hostName: 'Michael',
  kind: 'house',
  capacity: 12,
  address: '123 Secret Street, Jackson MS',
  notes: 'Gate code is 4471, park on the side street',
}

const EVENT_KINDS = ['announce', 'weekof', 'dayof', 'recap']
const PLATFORMS = ['instagram', 'facebook', 'discord', 'bluesky', 'x']

describe('socialEventView', () => {
  it('strips address, notes, and capacity; keeps public fields', () => {
    const v = socialEventView(HOSTED_EVENT)
    expect(v.address).toBeUndefined()
    expect(v.notes).toBeUndefined()
    expect(v.capacity).toBeUndefined()
    expect(v).toMatchObject({ film: 'The Passion of Joan of Arc', year: 1928, venue: 'The Vault' })
  })

  it('drops empty values and handles null', () => {
    expect(socialEventView(null)).toBeNull()
    expect(socialEventView({ id: 'x', venue: '', poster: null }).venue).toBeUndefined()
  })
})

describe('buildSocialCopy privacy', () => {
  it('never leaks address or notes in any kind × platform combination', () => {
    for (const kind of EVENT_KINDS) {
      for (const platform of PLATFORMS) {
        const text = buildSocialCopy(kind, platform, { event: HOSTED_EVENT, count: 12 })
        expect(text, `${kind}/${platform}`).not.toContain('Secret Street')
        expect(text, `${kind}/${platform}`).not.toContain('4471')
      }
    }
  })
})

describe('buildSocialCopy content', () => {
  it('announce includes title, year, date, venue, and the events URL (facebook)', () => {
    const text = buildSocialCopy('announce', 'facebook', { event: HOSTED_EVENT })
    expect(text).toContain('The Passion of Joan of Arc (1928)')
    expect(text).toContain('Friday, June 12')
    expect(text).toContain('7:00 pm')
    expect(text).toContain('The Vault')
    expect(text).toContain('https://jxnfilm.club/events')
  })

  it('instagram uses link-in-bio phrasing and hashtags, no raw URL', () => {
    const text = buildSocialCopy('announce', 'instagram', { event: HOSTED_EVENT })
    expect(text).toContain('link in bio')
    expect(text).toContain('#JacksonFilmClub')
    expect(text).not.toContain('https://')
  })

  it('discord announce is markdown with the letterboxd link', () => {
    const text = buildSocialCopy('dayof', 'discord', { event: HOSTED_EVENT })
    expect(text).toContain('**')
    expect(text).toContain('TONIGHT')
    expect(text).toContain(HOSTED_EVENT.letterboxd_uri)
  })

  it('recap includes the attendance count, and omits it when zero', () => {
    expect(buildSocialCopy('recap', 'facebook', { event: HOSTED_EVENT, count: 12 }))
      .toContain('12 of us came out to The Vault')
    expect(buildSocialCopy('recap', 'facebook', { event: HOSTED_EVENT, count: 0 }))
      .not.toContain('of us')
  })

  it('falls back to a member-hosted label when there is no venue', () => {
    const e = { ...HOSTED_EVENT, venue: '' }
    expect(buildSocialCopy('announce', 'facebook', { event: e })).toContain('a member-hosted screening')
  })
})

describe('buildRoundupData', () => {
  // Anchor the 7-day window so these tests never age out.
  const TODAY = { today: '2026-08-07' }
  const watchedMap = {
    michaellamb: [
      { title: 'Chungking Express', year: '1994', link: 'https://boxd.it/a', poster: 'https://a.ltrbxd.com/p1.jpg', watched_date: '2026-08-05' },
      { title: 'Paris, Texas', year: '1984', link: 'https://boxd.it/b', watched_date: '2026-08-01' },
    ],
    otherperson: [
      // Same film as above — must dedupe (case-insensitive), still count in total.
      { title: 'chungking express', year: '1994', link: 'https://boxd.it/a2', watched_date: '2026-08-06' },
      { title: 'Stalker', year: '1979', link: 'https://boxd.it/c', watched_date: '2026-08-03' },
    ],
  }

  it('aggregates with zero member attribution', () => {
    const { films } = buildRoundupData(watchedMap, TODAY)
    for (const f of films) {
      expect(Object.keys(f).every(k => ['title', 'year', 'link', 'poster', 'watched_date'].includes(k))).toBe(true)
    }
    expect(JSON.stringify(films)).not.toContain('michaellamb')
    expect(JSON.stringify(films)).not.toContain('otherperson')
  })

  it('dedupes by title+year, counts all entries in total, sorts newest-first', () => {
    const { films, total } = buildRoundupData(watchedMap, TODAY)
    expect(total).toBe(4)
    expect(films).toHaveLength(3)
    expect(films[0].watched_date).toBe('2026-08-06')
    expect(films.map(f => f.title.toLowerCase())).toEqual(['chungking express', 'stalker', 'paris, texas'])
  })

  it('windows to the last 7 days inclusive and drops undated entries', () => {
    const map = {
      someone: [
        { title: 'In Window Edge', watched_date: '2026-08-01' },   // cutoff day — included
        { title: 'Too Old', watched_date: '2026-07-31' },          // 8 days back — excluded
        { title: 'Ancient', watched_date: '2026-07-01' },
        { title: 'No Date At All' },                               // unverifiable — excluded
      ],
    }
    const { films, total } = buildRoundupData(map, TODAY)
    expect(films.map(f => f.title)).toEqual(['In Window Edge'])
    expect(total).toBe(1)
  })

  it('honors a custom window length', () => {
    const map = { someone: [{ title: 'Old But Wanted', watched_date: '2026-07-15' }] }
    expect(buildRoundupData(map, TODAY).films).toHaveLength(0)
    expect(buildRoundupData(map, { ...TODAY, days: 30 }).films).toHaveLength(1)
  })

  it('respects limit and tolerates empty/absent input', () => {
    expect(buildRoundupData(watchedMap, { ...TODAY, limit: 1 }).films).toHaveLength(1)
    expect(buildRoundupData(null, TODAY)).toEqual({ films: [], total: 0 })
    expect(buildRoundupData({}, TODAY)).toEqual({ films: [], total: 0 })
  })
})

describe('roundup copy', () => {
  const films = [
    { title: 'Chungking Express', year: '1994' },
    { title: 'A Film With A Really Quite Extraordinarily Long Title That Goes On', year: '2001' },
    { title: 'Stalker', year: '1979' },
    { title: 'Another Substantially Verbose Motion Picture Name Here', year: '2010' },
    { title: 'Paris, Texas', year: '1984' },
    { title: 'Yet A Third Impressively Wordy And Ornamented Feature Presentation', year: '1997' },
    { title: 'The Continuing Adventures Of Extremely Protracted Nomenclature', year: '2019' },
    { title: 'Close-Up', year: '1990' },
  ]

  it('stays within the bluesky and x character limits by shrinking the list', () => {
    for (const p of ['bluesky', 'x']) {
      const text = buildSocialCopy('roundup', p, { films, total: 14 })
      expect(text.length, p).toBeLessThanOrEqual(PLATFORM_LIMITS[p])
      expect(text).toContain('more')
      expect(text).toContain('https://jxnfilm.club/watched')
    }
  })

  it('lists all films with the logged total on facebook', () => {
    const text = buildSocialCopy('roundup', 'facebook', { films, total: 14 })
    expect(text).toContain('Chungking Express (1994)')
    expect(text).toContain('14 films logged by members in the last week')
  })
})

describe('fmtSocialDate / socialFileName', () => {
  it('formats a bare date without timezone day-shift', () => {
    expect(fmtSocialDate('2026-06-12')).toBe('Friday, June 12')
    expect(fmtSocialDate('2026-06-12', { short: true })).toBe('Fri, Jun 12')
    expect(fmtSocialDate('')).toBe('')
    expect(fmtSocialDate('not-a-date')).toBe('not-a-date')
  })

  it('builds a slugged filename', () => {
    expect(socialFileName('announce', 'ig-post', HOSTED_EVENT)).toBe('jfc-announce-2026-06-12-passion-ig-post.png')
    expect(socialFileName('roundup', 'x', null)).toBe('jfc-roundup-x.png')
  })
})
