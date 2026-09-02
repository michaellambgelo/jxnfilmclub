import { describe, expect, it } from 'vitest'
import {
  socialEventView, buildSocialCopy, buildRoundupData, buildDiaryPages, diarySeriesCopy, socialFileName,
  imageBlockIssues, buildImageBlockHtml, buildImageBlockText,
  newsletterSendBlocker, newsletterSizeReport, utf8Bytes, fitBox,
  NL_HTML_WARN_BYTES, NL_HTML_BLOCK_BYTES, NL_TEXT_BLOCK_BYTES,
  fmtSocialDate, fmtDiaryRange, fmtMonth, daysUntil, countdownLead, centralCutoff, PLATFORM_LIMITS,
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

const EVENT_KINDS = ['announce', 'countdown', 'recap']
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
        const text = buildSocialCopy(kind, platform, { event: HOSTED_EVENT, count: 12, today: '2026-06-01' })
        expect(text, `${kind}/${platform}`).not.toContain('Secret Street')
        expect(text, `${kind}/${platform}`).not.toContain('4471')
      }
    }
  })

  it('lineup never leaks private fields either', () => {
    for (const platform of PLATFORMS) {
      const text = buildSocialCopy('lineup', platform, { events: [HOSTED_EVENT] })
      expect(text, platform).not.toContain('Secret Street')
      expect(text, platform).not.toContain('4471')
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

  it('discord countdown is markdown with the letterboxd link and a dynamic lead', () => {
    const tonight = buildSocialCopy('countdown', 'discord', { event: HOSTED_EVENT, today: '2026-06-12' })
    expect(tonight).toContain('**')
    expect(tonight).toContain('TONIGHT')
    expect(tonight).toContain(HOSTED_EVENT.letterboxd_uri)
    expect(buildSocialCopy('countdown', 'instagram', { event: HOSTED_EVENT, today: '2026-06-11' })).toContain('TOMORROW')
    expect(buildSocialCopy('countdown', 'facebook', { event: HOSTED_EVENT, today: '2026-06-07' })).toContain('5 DAYS AWAY')
    // Past event: fall back to the announce lead rather than a negative count.
    expect(buildSocialCopy('countdown', 'facebook', { event: HOSTED_EVENT, today: '2026-07-01' })).toContain('NEXT SCREENING')
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

describe('daysUntil / countdownLead / fmtMonth', () => {
  it('counts whole calendar days from bare date strings', () => {
    expect(daysUntil('2026-06-12', '2026-06-12')).toBe(0)
    expect(daysUntil('2026-06-12', '2026-06-11')).toBe(1)
    expect(daysUntil('2026-06-12', '2026-06-01')).toBe(11)
    expect(daysUntil('2026-06-12', '2026-07-01')).toBe(-19)
    expect(daysUntil('', '2026-06-12')).toBeNull()
    expect(daysUntil('2026-06-12', 'nope')).toBeNull()
  })

  it('phrases the lead per distance, falling back for past/undated', () => {
    expect(countdownLead(0)).toBe('Tonight')
    expect(countdownLead(1)).toBe('Tomorrow')
    expect(countdownLead(5)).toBe('5 days away')
    expect(countdownLead(-1)).toBe('Next screening')
    expect(countdownLead(null)).toBe('Next screening')
  })

  it('formats YYYY-MM as a month name', () => {
    expect(fmtMonth('2026-08')).toBe('August 2026')
    expect(fmtMonth('garbage')).toBe('garbage')
  })
})

describe('episode copy', () => {
  const episode = { title: 'The Muppets — Appreciating the Original Films', date: '2026-07-31', url: 'https://podcasters.spotify.com/pod/show/jxnfilmclub/episodes/x' }

  it('carries the listen URL everywhere except instagram', () => {
    for (const p of ['facebook', 'discord', 'bluesky', 'x']) {
      expect(buildSocialCopy('episode', p, { episode }), p).toContain(episode.url)
    }
    const ig = buildSocialCopy('episode', 'instagram', { episode })
    expect(ig).toContain('link in bio')
    expect(ig).not.toContain('https://')
    expect(ig).toContain(episode.title)
  })

  it('fits bluesky and x limits with a real-length title', () => {
    for (const p of ['bluesky', 'x']) {
      expect(buildSocialCopy('episode', p, { episode }).length, p).toBeLessThanOrEqual(PLATFORM_LIMITS[p])
    }
  })
})

describe('lineup copy', () => {
  const events = [
    { ...HOSTED_EVENT },
    { id: 'e2', film: 'Sherlock Jr.', year: 1924, date: '2026-06-20' },
    { id: 'e3', film: 'Cape Fear', year: 1991, date: '2026-06-28' },
  ]

  it('lists each event with its date on facebook', () => {
    const text = buildSocialCopy('lineup', 'facebook', { events })
    expect(text).toContain('Fri, Jun 12 — The Passion of Joan of Arc (1928)')
    expect(text).toContain('Sat, Jun 20 — Sherlock Jr. (1924)')
    expect(text).toContain('https://jxnfilm.club/events')
  })

  it('shrinks to fit bluesky/x limits', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, film: `A Considerably Overlong Film Title Number ${i}`, year: 2000 + i, date: `2026-07-0${i + 1}` }))
    for (const p of ['bluesky', 'x']) {
      const text = buildSocialCopy('lineup', p, { events: many })
      expect(text.length, p).toBeLessThanOrEqual(PLATFORM_LIMITS[p])
      expect(text).toContain('more')
    }
  })
})

describe('monthwrap copy', () => {
  const data = { monthLabel: 'August 2026', films: ['Jaws (1975)', 'Cape Fear (1991)'], screenings: 2, attendees: 19 }

  it('carries films and stats on facebook, stats-only on x', () => {
    const fb = buildSocialCopy('monthwrap', 'facebook', data)
    expect(fb).toContain('That was August 2026')
    expect(fb).toContain('Jaws (1975)')
    expect(fb).toContain('2 screenings · 19 attendees')
    const x = buildSocialCopy('monthwrap', 'x', data)
    expect(x.length).toBeLessThanOrEqual(PLATFORM_LIMITS.x)
    expect(x).toContain('2 screenings · 19 attendees')
  })

  it('omits the attendee clause when zero', () => {
    expect(buildSocialCopy('monthwrap', 'facebook', { ...data, attendees: 0 })).not.toContain('attendee')
  })
})

describe('milestone copy', () => {
  it('phrases each stat', () => {
    expect(buildSocialCopy('milestone', 'facebook', { stat: 'members', value: 25 })).toContain("We're now 25 members strong")
    expect(buildSocialCopy('milestone', 'discord', { stat: 'screenings', value: 12 })).toContain('12 screenings and counting')
    expect(buildSocialCopy('milestone', 'x', { stat: 'attendance', value: 150 })).toContain('150 seats filled')
    expect(buildSocialCopy('milestone', 'x', { stat: 'attendance', value: 150 }).length).toBeLessThanOrEqual(PLATFORM_LIMITS.x)
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

// --- Diary pages -----------------------------------------------------------
//
// A handle-keyed /watched map. Handles and diary links are the identity this
// feature must never emit, so they're deliberately realistic here.
const DIARY_MAP = {
  Ada: [
    { title: 'The Odyssey', year: '2026', rating: '5', poster: 'p/odyssey.jpg',
      watched_date: '2026-08-07', link: 'https://letterboxd.com/ada/film/the-odyssey-2026/' },
    { title: 'Blade', year: '1998', rating: '3.5', watched_date: '2026-08-05',
      link: 'https://letterboxd.com/ada/film/blade/' },
    { title: 'No Date Here', year: '1999', rating: '4' },
    { title: 'Bad Date', year: '1999', watched_date: '08/11/2026' },
    { year: '2001', watched_date: '2026-08-04' },
  ],
  Bo: [
    // Same film as Ada's, logged a day earlier and rated lower — the dedupe
    // must keep Ada's newer date but average both ratings.
    { title: 'The Odyssey', year: '2026', rating: '4', poster: 'p/odyssey.jpg',
      watched_date: '2026-08-06', link: 'https://letterboxd.com/bo/film/the-odyssey-2026/' },
    // Logged but never rated: counts toward `count`, not `ratedCount`.
    { title: 'Warfare', year: '2025', watched_date: '2026-08-03', liked: true },
  ],
  Cy: [
    { title: 'Warfare', year: '2025', rating: '2', watched_date: '2026-08-02' },
    // Same title, different year — a different film, never deduped together.
    { title: 'The Odyssey', year: '1997', rating: '3.5', watched_date: '2026-08-05' },
  ],
}

describe('buildDiaryPages', () => {
  it('drops undated, malformed-date and untitled entries', () => {
    const { films, entries } = buildDiaryPages(DIARY_MAP)
    expect(entries).toBe(6)   // 9 raw, minus no-date, bad-date and no-title
    expect(films.map(f => f.title)).not.toContain('No Date Here')
    expect(films.map(f => f.title)).not.toContain('Bad Date')
  })

  it('never emits a handle, name or diary link', () => {
    // The diary link embeds the member handle, so its absence is the whole
    // privacy contract — assert on the serialized output, not just the keys.
    const { films } = buildDiaryPages(DIARY_MAP)
    const json = JSON.stringify(films)
    for (const handle of Object.keys(DIARY_MAP)) expect(json).not.toContain(handle)
    expect(json).not.toContain('letterboxd.com')
    for (const f of films) {
      expect(f).not.toHaveProperty('link')
      expect(f).not.toHaveProperty('handle')
      expect(f).not.toHaveProperty('name')
    }
  })

  it('dedupes on title|year, keeping the newest date and counting members', () => {
    const { films, total } = buildDiaryPages(DIARY_MAP)
    const odyssey = films.filter(f => f.title === 'The Odyssey')
    expect(odyssey).toHaveLength(2)                    // 2026 and 1997 stay apart
    const nolan = odyssey.find(f => f.year === '2026')
    expect(nolan.count).toBe(2)
    expect(nolan.watched_date).toBe('2026-08-07')      // Ada's, the newer one
    expect(total).toBe(4)
  })

  it('averages the rating over raters, not loggers', () => {
    const { films } = buildDiaryPages(DIARY_MAP)
    const nolan = films.find(f => f.title === 'The Odyssey' && f.year === '2026')
    expect(nolan.avgRating).toBe(4.5)                  // (5 + 4) / 2
    expect(nolan.ratedCount).toBe(2)

    // Two members logged Warfare; only one rated it. The average is that one
    // rating, and ratedCount says so rather than implying a 2-person consensus.
    const warfare = films.find(f => f.title === 'Warfare')
    expect(warfare.count).toBe(2)
    expect(warfare.ratedCount).toBe(1)
    expect(warfare.avgRating).toBe(2)
  })

  it('leaves avgRating absent when nobody rated the film', () => {
    const { films } = buildDiaryPages({ Ada: [{ title: 'Unrated', watched_date: '2026-08-01' }] })
    expect(films[0]).not.toHaveProperty('avgRating')
    expect(films[0].ratedCount).toBe(0)
    expect(films[0].count).toBe(1)
  })

  it('orders newest-first with a deterministic same-day tiebreak', () => {
    // Same date across every entry: order must come from the title|year key,
    // not from member iteration order, or paging isn't reproducible.
    const d = '2026-08-08'
    const a = buildDiaryPages({ X: [{ title: 'Zodiac', watched_date: d }, { title: 'Amelie', watched_date: d }],
                                Y: [{ title: 'Mulholland Drive', watched_date: d }] })
    const b = buildDiaryPages({ Y: [{ title: 'Mulholland Drive', watched_date: d }],
                                X: [{ title: 'Amelie', watched_date: d }, { title: 'Zodiac', watched_date: d }] })
    expect(a.films.map(f => f.title)).toEqual(['Amelie', 'Mulholland Drive', 'Zodiac'])
    expect(b.films.map(f => f.title)).toEqual(a.films.map(f => f.title))
  })

  it('chunks into pages carrying their own date range', () => {
    const { pages, pageCount } = buildDiaryPages(DIARY_MAP, { perPage: 2 })
    expect(pageCount).toBe(2)
    expect(pages[0].films).toHaveLength(2)
    expect(pages[0].to).toBe('2026-08-07')     // newest on the page
    expect(pages[0].from).toBe('2026-08-05')   // oldest on the page
    for (const p of pages) expect(p.from <= p.to).toBe(true)
  })

  it('survives empty and malformed input', () => {
    for (const bad of [null, undefined, {}, { A: null }, { A: [null, undefined] }]) {
      expect(buildDiaryPages(bad)).toEqual({
        pages: [], films: [], total: 0, entries: 0, pageCount: 0, availablePages: 0, days: null,
      })
    }
  })

  it('clamps a nonsense perPage instead of dividing by zero', () => {
    expect(buildDiaryPages(DIARY_MAP, { perPage: 0 }).pageCount).toBe(1)     // falls back to 10
    expect(buildDiaryPages(DIARY_MAP, { perPage: -3 }).pageCount).toBe(4)    // clamps to 1 per page
    expect(buildDiaryPages(DIARY_MAP, { perPage: 2.7 }).pageCount).toBe(2)   // floors to 2
  })
})

describe('fmtDiaryRange', () => {
  it('omits the year on the left half within one year', () => {
    expect(fmtDiaryRange('2026-03-12', '2026-04-03')).toBe('Mar 12 – Apr 3, 2026')
  })

  it('carries both years across a year boundary', () => {
    expect(fmtDiaryRange('2025-12-28', '2026-01-04')).toBe('Dec 28, 2025 – Jan 4, 2026')
  })

  it('collapses a single-day range', () => {
    expect(fmtDiaryRange('2026-04-03', '2026-04-03')).toBe('Apr 3, 2026')
  })

  it('returns empty for anything that is not a bare date', () => {
    for (const [a, b] of [['', '2026-01-01'], ['nope', '2026-01-01'], ['2026-01-01', null],
                          ['2026-1-1', '2026-01-02']]) {
      expect(fmtDiaryRange(a, b)).toBe('')
    }
  })
})

describe('buildSocialCopy — diary', () => {
  const page = (perPage = 10) => {
    const built = buildDiaryPages(DIARY_MAP, { perPage })
    return { ...built.pages[0], page: 1, pageCount: built.pageCount }
  }

  it('leads with the real date range and never claims recency', () => {
    for (const p of PLATFORMS) {
      const text = buildSocialCopy('diary', p, page())
      // Aug 3, not Cy's Aug 2: the dedupe keeps Warfare's NEWEST log date, so
      // the range describes the rows actually on the card. Case-insensitive
      // because Instagram uppercases its whole lead line, as the roundup does.
      expect(text.toLowerCase()).toContain('aug 3 – aug 7, 2026')
      // Deep pages are years old, so any "this week"/"recent" phrasing lies.
      expect(text).not.toMatch(/this week|recent/i)
    }
  })

  it('shows the club average with its sample size, not a lone score', () => {
    const text = buildSocialCopy('diary', 'discord', page())
    expect(text).toContain('The Odyssey (2026)')
    expect(text).toContain('4.5 avg, 2 members')
    // A single rater gets stars only — no misleading "1 members" annotation.
    expect(text).not.toContain('1 members')
  })

  it('stays under every platform ceiling with ten long titles', () => {
    const long = {}
    for (let i = 0; i < 10; i++) {
      long['m' + i] = [{
        title: `The Assassination of Jesse James by the Coward Robert Ford ${i}`,
        year: '2007', rating: '4.5', watched_date: `2026-08-${String(10 + i).padStart(2, '0')}`,
      }]
    }
    const built = buildDiaryPages(long)
    const data = { ...built.pages[0], page: 1, pageCount: built.pageCount }
    for (const p of PLATFORMS) {
      const limit = PLATFORM_LIMITS[p]
      if (limit) expect(buildSocialCopy('diary', p, data).length).toBeLessThanOrEqual(limit)
    }
  })

  it('drops the page tag when there is only one page', () => {
    const one = buildDiaryPages(DIARY_MAP, { perPage: 100 })
    const text = buildSocialCopy('diary', 'facebook', { ...one.pages[0], page: 1, pageCount: 1 })
    expect(text).not.toContain('(1/1)')
  })
})

describe('buildDiaryPages — scoping', () => {
  // Dates are pinned via `today` so the Central-time window never makes this
  // suite time-dependent.
  const TODAY = '2026-08-23'
  // A 7-day window ending 2026-08-23 floors at 2026-08-17 (day 7 counting the
  // end date), so 08-17 is the last day IN and 08-16 the first day OUT.
  const SCOPED = {
    Ada: [
      { title: 'Today', watched_date: '2026-08-23' },
      { title: 'Window Edge', watched_date: '2026-08-17' },
      { title: 'Well Outside', watched_date: '2026-08-10' },
      { title: 'Last Year', watched_date: '2025-08-23' },
    ],
    Bo: [
      { title: 'Just Outside', watched_date: '2026-08-16' },
      { title: 'Ancient', watched_date: '2023-01-01' },
    ],
  }

  it('windows to a trailing N days, inclusive of the boundary day', () => {
    const week = buildDiaryPages(SCOPED, { days: 7, today: TODAY })
    expect(week.films.map(f => f.title)).toEqual(['Today', 'Window Edge'])
    expect(week.films.map(f => f.title)).not.toContain('Just Outside')
    expect(week.days).toBe(7)
  })

  it('pages the whole feed when no window is given', () => {
    const all = buildDiaryPages(SCOPED, { today: TODAY })
    expect(all.total).toBe(6)
    expect(all.days).toBeNull()
  })

  it('shares its cutoff with buildRoundupData, so the two windows cannot drift', () => {
    const week = buildDiaryPages(SCOPED, { days: 7, today: TODAY })
    const roundup = buildRoundupData(SCOPED, { days: 7, today: TODAY, limit: 99 })
    expect(week.films.map(f => f.title).sort()).toEqual(roundup.films.map(f => f.title).sort())
    expect(centralCutoff(7, TODAY)).toBe('2026-08-17')
  })

  it('caps the page count while still reporting what was available', () => {
    const capped = buildDiaryPages(SCOPED, { perPage: 2, maxPages: 2, today: TODAY })
    expect(capped.pageCount).toBe(2)
    expect(capped.availablePages).toBe(3)
    expect(capped.films).toHaveLength(4)     // trimmed to the kept pages
    expect(capped.total).toBe(6)             // scope size, before the cut
  })

  it('is a no-op when the cap meets or exceeds the pages available', () => {
    const uncapped = buildDiaryPages(SCOPED, { perPage: 2, today: TODAY })
    for (const maxPages of [3, 99, null, 0, -1]) {
      const r = buildDiaryPages(SCOPED, { perPage: 2, maxPages, today: TODAY })
      expect(r.pageCount).toBe(uncapped.pageCount)
      expect(r.availablePages).toBe(uncapped.availablePages)
    }
  })

  it('composes the window and the cap', () => {
    const r = buildDiaryPages(SCOPED, { perPage: 1, days: 7, maxPages: 1, today: TODAY })
    expect(r.total).toBe(2)              // two films in the window
    expect(r.availablePages).toBe(2)     // one per page
    expect(r.pageCount).toBe(1)          // capped to one
    expect(r.films.map(f => f.title)).toEqual(['Today'])
  })

  it('returns an empty result for a window with nothing in it', () => {
    const r = buildDiaryPages({ Ada: [{ title: 'Old', watched_date: '2020-01-01' }] }, { days: 7, today: TODAY })
    expect(r.pageCount).toBe(0)
    expect(r.availablePages).toBe(0)
    expect(r.pages).toEqual([])
  })

  it('keeps the club average scoped to the window', () => {
    // Two members logged the same film, one inside the window and one outside.
    // Only the in-window rating counts, or the card would average a score the
    // page never shows.
    const map = {
      Ada: [{ title: 'Split', year: '2026', rating: '5', watched_date: '2026-08-22' }],
      Bo: [{ title: 'Split', year: '2026', rating: '1', watched_date: '2026-01-01' }],
    }
    const week = buildDiaryPages(map, { days: 7, today: TODAY })
    expect(week.films[0].avgRating).toBe(5)
    expect(week.films[0].ratedCount).toBe(1)
    expect(week.films[0].count).toBe(1)

    const all = buildDiaryPages(map, { today: TODAY })
    expect(all.films[0].avgRating).toBe(3)   // (5 + 1) / 2
    expect(all.films[0].count).toBe(2)
  })
})

describe('diarySeriesCopy', () => {
  const TODAY = '2026-08-23'
  const built = () => buildDiaryPages(DIARY_MAP, { perPage: 2, today: TODAY })

  it('emits every page, in order, each with its own page tag', () => {
    const { pages, pageCount } = built()
    const text = diarySeriesCopy('discord', pages)
    for (let i = 1; i <= pageCount; i++) expect(text).toContain(`(${i}/${pageCount})`)
    // Order matters: the operator pastes this and posts top to bottom.
    expect(text.indexOf('(1/')).toBeLessThan(text.indexOf(`(${pageCount}/`))
  })

  it('separates pages with a splittable marker carrying the page and range', () => {
    const { pages, pageCount } = built()
    const text = diarySeriesCopy('facebook', pages)
    const marks = text.match(/───── page \d+\/\d+ · [^─]+─────/g) || []
    expect(marks).toHaveLength(pageCount)
    expect(marks[0]).toContain('page 1/' + pageCount)
  })

  it('matches buildSocialCopy page for page — it is a transport, not a rewrite', () => {
    const { pages, pageCount } = built()
    const series = diarySeriesCopy('x', pages)
    pages.forEach((p, i) => {
      const single = buildSocialCopy('diary', 'x', { ...p, page: i + 1, pageCount })
      expect(series).toContain(single)
    })
  })

  it('never leaks a member handle, even across the whole series', () => {
    const text = diarySeriesCopy('discord', built().pages)
    for (const handle of Object.keys(DIARY_MAP)) {
      expect(text).not.toContain(`letterboxd.com/${handle}`)
    }
    expect(text).not.toContain('/film/')
  })

  it('survives an empty or missing page list', () => {
    expect(diarySeriesCopy('discord', [])).toBe('')
    expect(diarySeriesCopy('discord')).toBe('')
  })

  it('is not bound by PLATFORM_LIMITS — each page is its own post', () => {
    // The blob carries N posts; only the per-page copy has to fit a ceiling.
    const { pages, pageCount } = built()
    expect(pageCount).toBeGreaterThan(1)
    const series = diarySeriesCopy('x', pages)
    expect(series.length).toBeGreaterThan(PLATFORM_LIMITS.x)
    pages.forEach((p, i) => {
      expect(buildSocialCopy('diary', 'x', { ...p, page: i + 1, pageCount }).length)
        .toBeLessThanOrEqual(PLATFORM_LIMITS.x)
    })
  })
})

// --- Newsletter image announcement block ------------------------------------
//
// A flyer is a complex image: the club's real one carries two showtimes, a
// date, an RSVP number and a deadline entirely as pixels. These tests pin the
// rule that the information must exist as TEXT as well — for screen readers,
// for plain-text readers, and for the majority of clients that block images.
describe('imageBlockIssues', () => {
  const OK = { src: 'https://img.jxnfilm.club/abc123.jpg', alt: 'Double feature poster', details: 'Sunday Sept 13. Yojimbo 2PM.' }

  it('accepts a hosted image with concise alt and real details', () => {
    expect(imageBlockIssues(OK)).toEqual([])
  })

  it('rejects a data: URI — the exact thing a browser paste produces', () => {
    const issues = imageBlockIssues({ ...OK, src: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatch(/hosted/i)
  })

  it('requires https, not http or a bare path', () => {
    for (const src of ['http://x/y.jpg', '/img/y.jpg', 'y.jpg']) {
      expect(imageBlockIssues({ ...OK, src })).not.toEqual([])
    }
  })

  it('requires alt text', () => {
    for (const alt of ['', '   ', undefined]) {
      const issues = imageBlockIssues({ ...OK, alt })
      expect(issues.some(i => /alt text is required/i.test(i))).toBe(true)
    }
  })

  it('rejects alt long enough to be unnavigable by a screen reader', () => {
    // Cramming the whole flyer into alt is the failure mode this guards.
    const crammed = 'Men With No Names double feature: Yojimbo by Akira Kurosawa at 2PM and ' +
      'A Fistful of Dollars by Sergio Leone at 5PM, Sunday September 13th, text 502-387-7503 to RSVP by 09/07/26'
    const issues = imageBlockIssues({ ...OK, alt: crammed })
    expect(issues.some(i => /too long/i.test(i))).toBe(true)
  })

  it('requires the details, so the content never lives only inside the image', () => {
    const issues = imageBlockIssues({ ...OK, details: '' })
    expect(issues.some(i => /must not live only inside the image/i.test(i))).toBe(true)
  })

  it('reports every problem at once rather than one at a time', () => {
    expect(imageBlockIssues({}).length).toBeGreaterThanOrEqual(3)
  })
})

describe('buildImageBlockHtml / buildImageBlockText', () => {
  const BLOCK = {
    src: 'https://img.jxnfilm.club/abc123.jpg',
    alt: 'Men With No Names double feature poster',
    details: 'Yojimbo 2PM, A Fistful of Dollars 5PM.\n\nText 502-387-7503 to RSVP by 09/07/26.',
  }

  it('carries the alt into the markup', () => {
    expect(buildImageBlockHtml(BLOCK)).toContain('alt="Men With No Names double feature poster"')
  })

  // Assert on the <img> alone — the surrounding shell legitimately carries
  // width="600" and width:100%, and matching the whole document would pass
  // on those instead of on the image.
  const imgTag = (html) => (html.match(/<img\b[^>]*>/) || [''])[0]

  it('sizes to the card content box, not the card', () => {
    const img = imgTag(buildImageBlockHtml(BLOCK))
    // The shell is width="600" with 32px td padding either side, so anything
    // wider than 536 overflows its own cell in Outlook — which honours the
    // width ATTRIBUTE and ignores max-width. 600 here would reproduce the very
    // overflow this block exists to fix.
    expect(img).toMatch(/width="536"/)
    expect(img).not.toMatch(/width="600"/)
  })

  it('shrinks but never stretches', () => {
    const img = imgTag(buildImageBlockHtml(BLOCK))
    // width:100% would scale a narrow source UP to fill the slot, blurring it.
    expect(img).toContain('max-width:100%')
    expect(img).not.toMatch(/[;"]width:100%/)
    expect(img).toContain('height:auto')            // else a fluid image distorts
    expect(img).not.toMatch(/\sheight="/)           // fixed height + fluid width distorts
  })

  it('honours an explicit narrower width', () => {
    // A 2:3 portrait at 536 wide renders ~804px tall and swallows the email,
    // so callers cap on height and pass the resulting width down.
    expect(imgTag(buildImageBlockHtml({ ...BLOCK, width: 480 }))).toMatch(/width="480"/)
  })

  it('renders the details as real text, not as part of the image', () => {
    const html = buildImageBlockHtml(BLOCK)
    expect(html).toContain('Yojimbo 2PM')
    expect(html).toContain('502-387-7503')
    expect((html.match(/<p style/g) || [])).toHaveLength(2)   // blank line splits paragraphs
  })

  it('escapes details rather than trusting them as markup', () => {
    const html = buildImageBlockHtml({ ...BLOCK, details: '<script>alert(1)</script> & more' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&amp; more')
  })

  it('marks layout tables presentational so screen readers skip them', () => {
    // Nested layout tables announced as data tables are a classic email a11y
    // failure — every one of ours must carry role="presentation".
    const html = buildImageBlockHtml(BLOCK)
    const tables = html.match(/<table[^>]*>/g) || []
    expect(tables.length).toBeGreaterThan(0)
    for (const t of tables) expect(t).toContain('role="presentation"')
  })

  it('puts the details first in the plain-text half, with the image named after', () => {
    const text = buildImageBlockText(BLOCK)
    expect(text.indexOf('Yojimbo 2PM')).toBeLessThan(text.indexOf('[Image:'))
    expect(text).toContain('502-387-7503')
    expect(text).toContain('[Image: Men With No Names double feature poster]')
  })

  it('wraps the image in the link when one is given', () => {
    const html = buildImageBlockHtml({ ...BLOCK, link: 'https://jxnfilm.club/events' })
    expect(html).toMatch(/<a href="https:\/\/jxnfilm\.club\/events"><img/)
    expect(buildImageBlockText({ ...BLOCK, link: 'https://jxnfilm.club/events' })).toContain('https://jxnfilm.club/events')
  })
})

// --- Newsletter send guards -------------------------------------------------
describe('utf8Bytes / newsletterSizeReport', () => {
  it('counts UTF-8 bytes, not code units', () => {
    // Curly quotes, em dashes and emoji all appear in real newsletter copy,
    // and .length undercounts every one of them.
    expect(utf8Bytes('café—')).toBeGreaterThan('café—'.length)
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes(null)).toBe(0)
  })

  it('grades ok / warn / over on the byte thresholds', () => {
    expect(newsletterSizeReport('x'.repeat(1000), '').level).toBe('ok')
    expect(newsletterSizeReport('x'.repeat(NL_HTML_WARN_BYTES), '').level).toBe('warn')
    expect(newsletterSizeReport('x'.repeat(NL_HTML_BLOCK_BYTES), '').level).toBe('over')
    expect(newsletterSizeReport('x'.repeat(NL_HTML_WARN_BYTES - 1), '').level).toBe('ok')
  })

  it('grades the plain-text body too, independently of the HTML', () => {
    expect(newsletterSizeReport('', 'x'.repeat(NL_TEXT_BLOCK_BYTES)).level).toBe('over')
  })
})

describe('newsletterSendBlocker', () => {
  const ORIGIN = 'https://join.jxnfilm.club'
  const opts = { expectedOrigin: ORIGIN }

  it('passes a clean body', () => {
    expect(newsletterSendBlocker('<p>Hello</p>', 'Hello', opts)).toBeNull()
  })

  it('blocks an embedded data: image at any size', () => {
    // Gmail's sanitizer is size-blind, so a small inline image is exactly as
    // invisible as a huge one — there is no threshold that makes this safe.
    const tiny = '<img src="data:image/png;base64,iVBORw0KGgo=">'
    expect(newsletterSendBlocker(tiny, '', opts).code).toBe('data_uri')
    expect(newsletterSendBlocker(tiny, '', opts).message).toMatch(/gmail/i)
  })

  it('catches data: however the attribute is written', () => {
    for (const body of ["<img src='data:image/png;base64,AA'>", '<img src = "data:image/gif;base64,AA">', '<img SRC="DATA:image/png;base64,AA">']) {
      expect(newsletterSendBlocker(body, '', opts)?.code).toBe('data_uri')
    }
  })

  it('blocks an image hosted on another environment', () => {
    const staging = '<img src="https://join-staging.jxnfilm.club/nl/img/abc.jpg">'
    expect(newsletterSendBlocker(staging, '', opts).code).toBe('cross_env')
    // ...and allows the matching one.
    expect(newsletterSendBlocker(`<img src="${ORIGIN}/nl/img/abc.jpg">`, '', opts)).toBeNull()
  })

  it('blocks a body over the size ceiling, naming which body', () => {
    const big = newsletterSendBlocker('x'.repeat(NL_HTML_BLOCK_BYTES), '', opts)
    expect(big.code).toBe('too_large')
    expect(big.message).toMatch(/HTML body/)
    expect(newsletterSendBlocker('', 'x'.repeat(NL_TEXT_BLOCK_BYTES), opts).message).toMatch(/plain-text body/)
  })

  it('still catches the poster placeholder', () => {
    expect(newsletterSendBlocker('<p>[Write your review or announcement here — x]</p>', '', opts).code).toBe('placeholder')
  })

  it('reports the most serious reason when several apply', () => {
    // A data URI is both oversized AND unrenderable; the unrenderable half is
    // what the operator needs to hear, because trimming will not fix it.
    const both = '<img src="data:image/png;base64,AA">' + 'x'.repeat(NL_HTML_BLOCK_BYTES)
    expect(newsletterSendBlocker(both, '', opts).code).toBe('data_uri')
  })

  it('works without an expectedOrigin', () => {
    expect(newsletterSendBlocker('<img src="https://anywhere/nl/img/a.jpg">', '', {})).toBeNull()
  })
})

describe('fitBox', () => {
  it('scales the real flyer down to a display width the card can hold', () => {
    // 1024x1536 is the actual flyer. The 720px HEIGHT budget binds before the
    // 536px width does — a 2:3 portrait at full width renders ~804px tall and
    // swallows the whole email.
    const r = fitBox(1024, 1536)
    expect(r.width).toBe(960)
    expect(r.height).toBe(1440)
    expect(r.displayWidth).toBe(480)
    expect(Math.round(r.displayWidth * (r.height / r.width))).toBeLessThanOrEqual(720)
  })

  it('lets a landscape image use the full content width', () => {
    expect(fitBox(3000, 2000).displayWidth).toBe(536)
  })

  it('never upscales a small source', () => {
    const r = fitBox(400, 300)
    expect(r.width).toBe(400)
    expect(r.height).toBe(300)
    expect(r.displayWidth).toBeLessThanOrEqual(400)
  })

  it('caps display width at the card content box', () => {
    for (const [w, h] of [[4000, 3000], [8000, 1000], [1072, 1440]]) {
      expect(fitBox(w, h).displayWidth).toBeLessThanOrEqual(536)
    }
  })

  it('is safe on degenerate input', () => {
    for (const [w, h] of [[0, 0], [NaN, 100], [-5, -5], [undefined, undefined]]) {
      expect(fitBox(w, h)).toEqual({ width: 0, height: 0, displayWidth: 0 })
    }
  })
})
