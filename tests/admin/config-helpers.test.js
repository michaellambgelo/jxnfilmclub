import { describe, expect, it } from 'vitest'
import {
  moveItem, normalizeStringList, buildCopyOverrides, sanitizePodcastConfig,
} from '../../admin/lib.js'

describe('moveItem', () => {
  const base = ['a', 'b', 'c', 'd']

  it('moves an item up and down', () => {
    expect(moveItem(base, 2, -1)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveItem(base, 1, 1)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveItem(base, 3, -1)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('never mutates the input', () => {
    const copy = [...base]
    moveItem(base, 0, 1)
    expect(base).toEqual(copy)
  })

  it('clamps out-of-bounds moves to a no-op clone', () => {
    expect(moveItem(base, 0, -1)).toEqual(base)
    expect(moveItem(base, 3, 1)).toEqual(base)
    expect(moveItem(base, -1, 1)).toEqual(base)
    expect(moveItem(base, 9, -1)).toEqual(base)
  })

  it('tolerates non-array input', () => {
    expect(moveItem(null, 0, 1)).toEqual([])
    expect(moveItem(undefined, 0, -1)).toEqual([])
  })
})

describe('normalizeStringList', () => {
  it('trims entries and drops empties, preserving order', () => {
    expect(normalizeStringList(['  The Capri Theater ', '', '  ', 'Cinemark XD in Pearl']))
      .toEqual(['The Capri Theater', 'Cinemark XD in Pearl'])
  })

  it('stringifies non-strings and drops null/undefined entries', () => {
    expect(normalizeStringList([42, null, undefined, ' x '])).toEqual(['42', 'x'])
  })

  it('returns [] for non-array input', () => {
    expect(normalizeStringList(null)).toEqual([])
    expect(normalizeStringList('not a list')).toEqual([])
  })
})

describe('buildCopyOverrides', () => {
  const KEYS = ['heroHeadline', 'heroLede', 'joinKicker']

  it('keeps only allowed, non-empty trimmed fields', () => {
    expect(buildCopyOverrides({
      heroHeadline: '  New headline  ',
      heroLede: '',
      joinKicker: '   ',
      notAllowed: 'nope',
    }, KEYS)).toEqual({ heroHeadline: 'New headline' })
  })

  it('returns null when nothing survives — caller deletes the key', () => {
    expect(buildCopyOverrides({ heroHeadline: '', heroLede: '  ' }, KEYS)).toBeNull()
    expect(buildCopyOverrides({}, KEYS)).toBeNull()
    expect(buildCopyOverrides(null, KEYS)).toBeNull()
  })

  it('ignores non-string values rather than storing them', () => {
    expect(buildCopyOverrides({ heroHeadline: 42, heroLede: 'ok' }, KEYS))
      .toEqual({ heroLede: 'ok' })
  })
})

describe('sanitizePodcastConfig', () => {
  it('trims editable fields and keeps the episodes.json shape', () => {
    const out = sanitizePodcastConfig({
      featured_id: '  2lTN7uSNEil7AoTEDzbEZs ',
      episodes: [
        { title: '  Ep One ', date: ' 2026-07-31 ', url: ' https://x.example/e1 ' },
      ],
    })
    expect(out).toEqual({
      featured_id: '2lTN7uSNEil7AoTEDzbEZs',
      episodes: [{ title: 'Ep One', date: '2026-07-31', url: 'https://x.example/e1' }],
    })
  })

  it('drops an empty featured_id and episodes with neither title nor url', () => {
    const out = sanitizePodcastConfig({
      featured_id: '   ',
      episodes: [
        { title: '', date: '2026-01-01', url: '  ' },   // fully blank row
        { title: 'Kept', url: '' },
        null,
        'garbage',
      ],
    })
    expect(out.featured_id).toBeUndefined()
    expect(out.episodes).toEqual([{ title: 'Kept' }])
  })

  it('preserves unknown fields at both levels', () => {
    const out = sanitizePodcastConfig({
      featured_id: 'abc',
      show_url: 'https://open.spotify.com/show/xyz',   // unknown top-level
      episodes: [
        { title: 'Ep', url: 'https://x.example/e', duration_s: 1234, guests: ['Mo'] },
      ],
    })
    expect(out.show_url).toBe('https://open.spotify.com/show/xyz')
    expect(out.episodes[0]).toEqual({
      title: 'Ep', url: 'https://x.example/e', duration_s: 1234, guests: ['Mo'],
    })
  })

  it('keeps a captured per-episode Spotify id and drops blank ones', () => {
    const out = sanitizePodcastConfig({
      episodes: [
        { id: ' 2lTN7uSNEil7AoTEDzbEZs ', title: 'Featured ep' },
        { id: '   ', title: 'No id ep' },
      ],
    })
    expect(out.episodes[0].id).toBe('2lTN7uSNEil7AoTEDzbEZs')
    expect(out.episodes[1].id).toBeUndefined()
  })

  it('does not mutate its input and tolerates garbage', () => {
    const src = { featured_id: ' x ', episodes: [{ title: ' t ' }] }
    const copy = JSON.parse(JSON.stringify(src))
    sanitizePodcastConfig(src)
    expect(src).toEqual(copy)

    expect(sanitizePodcastConfig(null)).toEqual({ episodes: [] })
    expect(sanitizePodcastConfig([1, 2])).toEqual({ episodes: [] })
    expect(sanitizePodcastConfig('nope')).toEqual({ episodes: [] })
  })
})
