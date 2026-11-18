import { describe, it, expect } from 'vitest'
import jsQR from 'jsqr'
import { qrMatrix, flyerEventUrl } from '../../admin/lib.js'

// The only test of a QR code that means anything: an independent decoder
// reads back what went in. Rendered the way the flyer draws it, dark modules
// on white with a four-module quiet zone.
function decode(matrix, scale = 4, quiet = 4) {
  const n = matrix.length
  const size = (n + quiet * 2) * scale
  const px = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4
          px[i] = px[i + 1] = px[i + 2] = 0
        }
      }
    }
  }
  const hit = jsQR(px, size, size)
  return hit ? hit.data : null
}

describe('qrMatrix', () => {
  it('round-trips through an independent decoder at every supported version', () => {
    // Lengths chosen to land in each of versions 1-9 at level M.
    const seen = new Set()
    for (const len of [5, 14, 20, 40, 60, 80, 100, 120, 150, 180]) {
      const text = ('https://jxnfilm.club/events?event=' + 'a-b_c.0123456789'.repeat(12)).slice(0, len)
      const m = qrMatrix(text)
      expect(m, `length ${len}`).not.toBeNull()
      expect(m.length).toBe(m[0].length)
      seen.add((m.length - 17) / 4)
      expect(decode(m), `length ${len}`).toBe(text)
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('round-trips real event links, short and long', () => {
    // Literal ids rather than data/events.json: the snapshot bot rewrites
    // that file, and a test that gates deploys must not change under it.
    for (const id of ['2026-11-28-chef', '2026-12-17-avengers-doomsday-capri', '2021-09-11-the-lord-of-the-rings-the-fellowship-of-the-ring']) {
      const url = flyerEventUrl({ id })
      expect(decode(qrMatrix(url)), id).toBe(url)
    }
  })

  it('handles non-ASCII text as UTF-8', () => {
    const text = 'https://jxnfilm.club/events?event=amélie-夜'
    expect(decode(qrMatrix(text))).toBe(text)
  })

  it('refuses text too long for the versions it supports', () => {
    expect(qrMatrix('x'.repeat(180))).not.toBeNull()
    expect(qrMatrix('x'.repeat(181))).toBeNull()
  })
})

describe('flyerEventUrl', () => {
  it('links a public event by id', () => {
    expect(flyerEventUrl({ id: '2026-11-28-chef' })).toBe('https://jxnfilm.club/events?event=2026-11-28-chef')
    expect(flyerEventUrl({ id: 'a b', kind: 'meetup', hostId: 'm1' })).toBe('https://jxnfilm.club/events?event=a%20b')
  })

  it('gives no link for a house screening, which has no public page', () => {
    expect(flyerEventUrl({ id: 'h1', kind: 'house' })).toBe('')
    expect(flyerEventUrl({ id: 'h2', hostId: 'm1' })).toBe('')
    expect(flyerEventUrl(null)).toBe('')
    expect(flyerEventUrl({})).toBe('')
  })
})
