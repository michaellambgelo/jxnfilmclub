import { describe, expect, it } from 'vitest'
import {
  coverRect, panFocal, normalizeLayout, isDefaultLayout, cardLayoutKey, DEFAULT_LAYOUT,
} from '../../admin/lib.js'

// A 2:3 poster into a 1080x562 band (the IG-post announce card's top half).
const NW = 600, NH = 900, W = 1080, H = 562

describe('coverRect', () => {
  it('defaults to a centred object-fit: cover crop', () => {
    const r = coverRect(NW, NH, W, H)
    expect(r.scale).toBeCloseTo(1.8)
    expect(r.sw).toBeCloseTo(600)
    expect(r.sx).toBeCloseTo(0)
    expect(r.sh).toBeCloseTo(H / 1.8)
    expect(r.sy).toBeCloseTo((NH - H / 1.8) / 2)
  })

  it('moves the window to the focal point', () => {
    const r = coverRect(NW, NH, W, H, { fy: 0 })
    expect(r.sy).toBe(0)
    const b = coverRect(NW, NH, W, H, { fy: 1 })
    expect(b.sy + b.sh).toBeCloseTo(NH)
  })

  it('never lets the window leave the image', () => {
    for (const fx of [-1, 0, 0.5, 1, 2]) {
      for (const fy of [-1, 0, 0.5, 1, 2]) {
        for (const zoom of [1, 1.7, 3]) {
          const r = coverRect(NW, NH, W, H, { fx, fy, zoom })
          expect(r.sx).toBeGreaterThanOrEqual(-1e-9)
          expect(r.sy).toBeGreaterThanOrEqual(-1e-9)
          expect(r.sx + r.sw).toBeLessThanOrEqual(NW + 1e-9)
          expect(r.sy + r.sh).toBeLessThanOrEqual(NH + 1e-9)
        }
      }
    }
  })

  it('zooms in and floors zoom at 1 (a cover crop never exposes the canvas)', () => {
    expect(coverRect(NW, NH, W, H, { zoom: 2 }).sw).toBeCloseTo(300)
    expect(coverRect(NW, NH, W, H, { zoom: 0.5 }).sw).toBeCloseTo(600)
  })
})

describe('panFocal', () => {
  const base = { ...DEFAULT_LAYOUT }

  it('dragging down reveals the top of the poster', () => {
    const { fy } = panFocal(NW, NH, W, H, base, 0, 100)
    expect(fy).toBeLessThan(0.5)
  })

  it('stops at the edge instead of banking travel', () => {
    const far = panFocal(NW, NH, W, H, base, 0, 100000)
    const r = coverRect(NW, NH, W, H, { ...base, ...far })
    expect(r.sy).toBeCloseTo(0)
    // One pixel back from the clamped position moves it immediately.
    const back = panFocal(NW, NH, W, H, { ...base, ...far }, 0, -1)
    expect(back.fy).toBeGreaterThan(far.fy)
  })

  it('cannot pan along an axis the crop already fills at zoom 1', () => {
    expect(panFocal(NW, NH, W, H, base, 500, 0).fx).toBeCloseTo(0.5)
  })
})

describe('normalizeLayout', () => {
  const poster = 'https://image.tmdb.org/a.jpg'

  it('returns defaults for nothing saved', () => {
    expect(normalizeLayout(null, poster)).toEqual({ ...DEFAULT_LAYOUT, stale: false })
  })

  it('ignores a layout tuned against a different poster', () => {
    const l = normalizeLayout({ poster: 'https://image.tmdb.org/old.jpg', fy: 0.1, zoom: 2 }, poster)
    expect(l).toEqual({ ...DEFAULT_LAYOUT, stale: true })
  })

  it('clamps and rejects garbage', () => {
    const l = normalizeLayout({
      poster, fx: 'x', fy: -3, zoom: 99, band: 0.01, fade: -5, mode: 'weird', text: 9,
    }, poster)
    expect(l).toMatchObject({ fx: 0.5, fy: 0, zoom: 3, band: 0.2, fade: 0, mode: 'band', text: 1.4 })
  })

  it('keeps null band/fade as "use the card default"', () => {
    const l = normalizeLayout({ poster, band: null, fade: undefined, mode: 'full' }, poster)
    expect(l.band).toBeNull()
    expect(l.fade).toBeNull()
    expect(l.mode).toBe('full')
  })
})

describe('isDefaultLayout / cardLayoutKey', () => {
  it('detects a no-op layout', () => {
    expect(isDefaultLayout(normalizeLayout(null, ''))).toBe(true)
    expect(isDefaultLayout(normalizeLayout({ poster: 'p', fy: 0.2 }, 'p'))).toBe(false)
  })

  it('keys by event and size', () => {
    expect(cardLayoutKey('ev-1', 'ig-story')).toBe('cardlayout:ev-1:ig-story')
  })
})
