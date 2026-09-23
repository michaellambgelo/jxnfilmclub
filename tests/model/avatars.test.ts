import { describe, expect, it } from 'vitest'
import { avatarsById, customAvatarUrl } from '../../model/index'

const ORIGIN = 'https://join.jxnfilm.club'
const FILE = 'a'.repeat(64) + '.webp'

describe('customAvatarUrl', () => {
  it('builds the Worker URL from the member id and file', () => {
    expect(customAvatarUrl({ id: 'abc123', avatar: FILE }, ORIGIN)).toBe(`${ORIGIN}/av/abc123/${FILE}`)
  })

  it('is empty without an origin, an id, or a well-formed file', () => {
    expect(customAvatarUrl({ id: 'abc123', avatar: FILE }, null)).toBe('')
    expect(customAvatarUrl({ avatar: FILE }, ORIGIN)).toBe('')
    for (const avatar of [undefined, '', 'x.webp', 'a'.repeat(64) + '.gif', '../' + FILE, { file: FILE }]) {
      expect(customAvatarUrl({ id: 'abc123', avatar }, ORIGIN)).toBe('')
    }
  })
})

describe('avatarsById', () => {
  const lb = { mlamb: 'https://a.ltrbxd.com/lb-mlamb.jpg', other: 'https://a.ltrbxd.com/lb-other.jpg' }

  it('prefers a custom photo, then Letterboxd, and omits everyone else', () => {
    const map = avatarsById([
      { id: 'm1', handle: 'mlamb', avatar: FILE },
      { id: 'm2', handle: 'other' },
      { id: 'm3', avatar: FILE },
      { id: 'm4', handle: 'nobody' },
      { id: 'm5' },
    ], lb, ORIGIN)
    expect(map).toEqual({
      m1: `${ORIGIN}/av/m1/${FILE}`,
      m2: lb.other,
      m3: `${ORIGIN}/av/m3/${FILE}`,
    })
  })

  it('tolerates missing inputs', () => {
    expect(avatarsById(undefined as any, undefined, ORIGIN)).toEqual({})
    expect(avatarsById([null, { name: 'no id' }] as any, lb, ORIGIN)).toEqual({})
  })
})
