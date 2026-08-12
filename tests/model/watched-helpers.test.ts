import { describe, expect, it } from 'vitest'
import { buildWatchedPage, centralDayCutoff, filterFilms } from '../../model/index.ts'

// All watched_date values are bare YYYY-MM-DD strings, compared lexically —
// these tests pass explicit `today` anchors so nothing depends on wall time.
const TODAY = '2026-08-12'

const members = [
  { id: 'a', name: 'Alex', handle: 'alex', joined: '2026-01-01' },
  { id: 's', name: 'Sam', handle: 'sam', joined: '2026-02-01' },
  { id: 'j', name: 'Jo', handle: 'jo', joined: '2026-03-01' },
  { id: 'n', name: 'NoHandle One', joined: '2026-04-01' },
  { id: 'm', name: 'NoHandle Two', joined: '2026-05-01' },
]

function film(over: any = {}) {
  return {
    title: 'Weapons', year: '2025', link: 'https://letterboxd.com/x/film/weapons/',
    watched_date: '2026-08-10', ...over,
  }
}

describe('centralDayCutoff', () => {
  it('returns the day (days-1) back from the given anchor, as a string', () => {
    expect(centralDayCutoff(7, '2026-08-12')).toBe('2026-08-06')
    expect(centralDayCutoff(1, '2026-08-12')).toBe('2026-08-12')
  })

  it('crosses month boundaries without day shift', () => {
    expect(centralDayCutoff(7, '2026-08-03')).toBe('2026-07-28')
  })
})

describe('buildWatchedPage sections', () => {
  it('orders members by most recent watched_date, undated-only members last', () => {
    const page = buildWatchedPage(members, {
      alex: [film({ watched_date: '2026-08-01' })],
      sam: [film({ watched_date: '2026-08-09' }), film({ title: 'Heat', watched_date: '2026-07-01' })],
      jo: [{ title: 'Undated', link: 'https://letterboxd.com/jo/film/u/' }],
    }, [], { today: TODAY })
    expect(page.sections.map((s: any) => s.handle)).toEqual(['sam', 'alex', 'jo'])
  })

  it('drops members with no handle or no films, and counts handleless members', () => {
    const page = buildWatchedPage(members, { alex: [film()] }, [], { today: TODAY })
    expect(page.sections.map((s: any) => s.handle)).toEqual(['alex'])
    expect(page.handleless).toBe(2)
  })

  it('precomputes stars including the half star', () => {
    const page = buildWatchedPage(members, {
      alex: [film({ rating: '4.5' }), film({ title: 'Heat', rating: '3' }), film({ title: 'NoRate' })],
    }, [], { today: TODAY })
    expect(page.sections[0].films.map((f: any) => f.stars)).toEqual(['★★★★½', '★★★', ''])
  })

  it('passes rewatch through untouched', () => {
    const page = buildWatchedPage(members, { alex: [film({ rewatch: true })] }, [], { today: TODAY })
    expect(page.sections[0].films[0].rewatch).toBe(true)
  })
})

describe('buildWatchedPage take matching', () => {
  it('matches a take by diary link, scoped to the member', () => {
    const takes = [{ handle: 'alex', title: 'Weapons', year: '2025', link: film().link, review: 'Loud and great.' }]
    const page = buildWatchedPage(members, { alex: [film()], sam: [film()] }, takes, { today: TODAY })
    const alex = page.sections.find((s: any) => s.handle === 'alex')
    const sam = page.sections.find((s: any) => s.handle === 'sam')
    expect(alex.films[0].take).toBe('Loud and great.')
    // Same film, different member: no cross-member attribution.
    expect(sam.films[0].take).toBeUndefined()
  })

  it('falls back to title+year when links differ', () => {
    const takes = [{ handle: 'alex', title: 'Weapons', year: '2025', link: 'https://letterboxd.com/other/', review: 'Still great.' }]
    const page = buildWatchedPage(members, { alex: [film()] }, takes, { today: TODAY })
    expect(page.sections[0].films[0].take).toBe('Still great.')
  })

  it('truncates long reviews at a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(60).trim()
    const takes = [{ handle: 'alex', link: film().link, title: 'Weapons', review: long }]
    const page = buildWatchedPage(members, { alex: [film()] }, takes, { today: TODAY })
    const take = page.sections[0].films[0].take
    expect(take.length).toBeLessThanOrEqual(141)
    expect(take.endsWith('…')).toBe(true)
  })
})

describe('buildWatchedPage strip', () => {
  it('clusters the same film across members with a combined byline, most recent first', () => {
    const page = buildWatchedPage(members, {
      alex: [film({ watched_date: '2026-08-10' })],
      sam: [film({ watched_date: '2026-08-09' }), film({ title: 'Heat', year: '1995', watched_date: '2026-08-11' })],
    }, [], { today: TODAY })
    expect(page.strip.map((c: any) => c.title)).toEqual(['Heat', 'Weapons'])
    const weapons = page.strip[1]
    expect(weapons.watchers.map((w: any) => w.name)).toEqual(['Alex', 'Sam'])
    expect(weapons.byline).toBe('Watched by Alex, Sam')
    expect(weapons.watched_date).toBe('2026-08-10') // most recent entry wins the card
  })

  it('windows to the last 7 days inclusive and drops undated entries', () => {
    const page = buildWatchedPage(members, {
      alex: [
        film({ title: 'Edge', watched_date: '2026-08-06' }),   // cutoff day — in
        film({ title: 'Old', watched_date: '2026-08-05' }),    // out
        { title: 'Undated', link: 'https://letterboxd.com/u/' }, // out
      ],
    }, [], { today: TODAY })
    expect(page.strip.map((c: any) => c.title)).toEqual(['Edge'])
  })

  it('solo watches still appear as single-watcher cards', () => {
    const page = buildWatchedPage(members, { jo: [film({ title: 'Solo' })] }, [], { today: TODAY })
    expect(page.strip[0].watchers).toHaveLength(1)
    expect(page.strip[0].byline).toBe('Watched by Jo')
  })

  it('clusters from the full feed depth while sections stay capped at four', () => {
    // Alex logged 6 films this week; Deep Water is his 6th-most-recent
    // entry. It must still cluster with Sam even though it fell out of his
    // last four (the real-world miss this depth exists for).
    const alexFilms = [1, 2, 3, 4, 5].map(i =>
      film({ title: 'Filler ' + i, link: 'https://letterboxd.com/alex/film/f' + i + '/', watched_date: '2026-08-1' + i }))
    alexFilms.push(film({ title: 'Deep Water', watched_date: '2026-08-07', link: 'https://letterboxd.com/alex/film/deep-water/' }))
    const page = buildWatchedPage(members, {
      alex: alexFilms,
      sam: [film({ title: 'Deep Water', watched_date: '2026-08-07', link: 'https://letterboxd.com/sam/film/deep-water/' })],
    }, [], { today: TODAY })
    const alexSection = page.sections.find((s: any) => s.handle === 'alex')
    expect(alexSection.films).toHaveLength(4)
    const dw = page.strip.find((c: any) => c.title === 'Deep Water')
    expect(dw.watchers.map((w: any) => w.name).sort()).toEqual(['Alex', 'Sam'])
  })
})

describe('filterFilms', () => {
  const films = [
    film({ title: 'LikedHi', liked: true, rating: '4.5', watched_date: centralDayCutoff(2) }),
    film({ title: 'LikedLo', liked: true, rating: '2', watched_date: '2020-01-01' }),
    film({ title: 'Hi', rating: '4', watched_date: '2020-01-01' }),
    film({ title: 'Plain', watched_date: undefined }),
  ]

  it('returns everything when no tokens are active', () => {
    expect(filterFilms(films, [])).toHaveLength(4)
  })

  it('filters each token', () => {
    expect(filterFilms(films, ['liked']).map(f => f.title)).toEqual(['LikedHi', 'LikedLo'])
    expect(filterFilms(films, ['rated4']).map(f => f.title)).toEqual(['LikedHi', 'Hi'])
    expect(filterFilms(films, ['week']).map(f => f.title)).toEqual(['LikedHi'])
  })

  it('AND-combines tokens', () => {
    expect(filterFilms(films, ['liked', 'rated4']).map(f => f.title)).toEqual(['LikedHi'])
  })
})
