import { describe, expect, it } from 'vitest'
import {
  coverRect, panFocal, normalizeLayout, isDefaultLayout, cardLayoutKey, DEFAULT_LAYOUT,
  CARD_THEMES, LAYOUT_THEMES, contrastRatio, accentFromPixels,
  placeBlock, textBounds, rgbTriplet,
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

  it('keeps the type sizes when the poster changes: only the crop is tied to the image', () => {
    const l = normalizeLayout({ poster: 'https://image.tmdb.org/old.jpg', fy: 0.1, zoom: 2, mode: 'full', text: 1.2, title: 0.8, meta: 1.3, label: 0.9 }, poster)
    expect(l).toEqual({ ...DEFAULT_LAYOUT, text: 1.2, title: 0.8, meta: 1.3, label: 0.9, stale: true })
  })

  it('an event with no poster can still save type sizes', () => {
    const l = normalizeLayout({ title: 0.7 }, undefined)
    expect(l).toMatchObject({ title: 0.7, stale: false })
    expect(isDefaultLayout(l)).toBe(false)
    expect(isDefaultLayout(normalizeLayout({ title: 1, meta: 1, label: 1 }, ''))).toBe(true)
  })

  it('clamps the per-element sizes', () => {
    expect(normalizeLayout({ poster, title: 9, meta: 0.1, label: 'x' }, poster))
      .toMatchObject({ title: 1.6, meta: 0.6, label: 1 })
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

describe('normalizeLayout: placement and poster mode', () => {
  const poster = 'https://image.tmdb.org/p.jpg'

  it('round-trips text placement, alignment and the whole-poster mode', () => {
    const l = normalizeLayout({ poster, vpos: 'middle', align: 'center', mode: 'fit' }, poster)
    expect(l).toMatchObject({ vpos: 'middle', align: 'center', mode: 'fit' })
    expect(isDefaultLayout(l)).toBe(false)
  })

  it('defaults to the card\'s own placement and rejects junk', () => {
    expect(normalizeLayout({ poster }, poster)).toMatchObject({ vpos: 'auto', align: 'left', mode: 'band' })
    expect(normalizeLayout({ poster, vpos: 'sideways', align: 7, mode: null }, poster))
      .toMatchObject({ vpos: 'auto', align: 'left', mode: 'band' })
  })

  it('keeps placement when the poster changes, but not the poster mode', () => {
    const l = normalizeLayout({ poster: 'https://image.tmdb.org/old.jpg', vpos: 'top', align: 'center', mode: 'fit', fy: 0 }, poster)
    expect(l).toMatchObject({ stale: true, vpos: 'top', align: 'center', mode: 'band', fy: 0.5 })
  })

  it('a placement alone is worth saving', () => {
    expect(isDefaultLayout(normalizeLayout({ vpos: 'bottom' }, ''))).toBe(false)
    expect(isDefaultLayout(normalizeLayout({ vpos: 'auto', align: 'left' }, ''))).toBe(true)
  })
})

describe('card themes', () => {
  const poster = 'https://image.tmdb.org/p.jpg'

  it('every theme keeps its text and accent readable on its background', () => {
    for (const [name, t] of Object.entries(CARD_THEMES)) {
      for (const k of ['text', 'text2', 'text4']) {
        expect(contrastRatio(t[k], t.bg), `${name}.${k}`).toBeGreaterThanOrEqual(4.5)
      }
      // The accent sets a small eyebrow as well as the big numeral, but the
      // brand red on ink is 3.98, and that pairing is the club's own look.
      expect(contrastRatio(t.accent, t.bg), `${name}.accent`).toBeGreaterThanOrEqual(3)
    }
  })

  it('contrastRatio matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })

  it('stores a theme, treats junk as "the size default", and keeps it across a poster change', () => {
    expect(LAYOUT_THEMES).toEqual(['night', 'paper', 'red', 'mono', 'poster'])
    expect(normalizeLayout({ poster }, poster).theme).toBeNull()
    expect(normalizeLayout({ poster, theme: 'neon' }, poster).theme).toBeNull()
    expect(normalizeLayout({ poster, theme: 'paper' }, poster).theme).toBe('paper')
    expect(normalizeLayout({ poster: 'https://image.tmdb.org/old.jpg', theme: 'red' }, poster)).toMatchObject({ stale: true, theme: 'red' })
    expect(isDefaultLayout(normalizeLayout({ theme: 'night' }, ''))).toBe(false)
    expect(isDefaultLayout(normalizeLayout({ theme: null }, ''))).toBe(true)
  })

  const pixels = (...colours) => {
    const out = []
    for (const [rgb, n] of colours) for (let i = 0; i < n; i++) out.push(...rgb, 255)
    return new Uint8ClampedArray(out)
  }

  it('takes the dominant vivid hue from a poster and makes it readable on ink', () => {
    const hex = accentFromPixels(pixels([[30, 60, 200], 60], [[40, 40, 40], 30], [[220, 30, 30], 10]))
    expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
    expect(contrastRatio(hex, '#100f0e')).toBeGreaterThanOrEqual(4.5)
  })

  it('gives up on near-grey artwork, missing data and transparent pixels', () => {
    expect(accentFromPixels(pixels([[120, 118, 116], 100]))).toBeNull()
    expect(accentFromPixels(pixels([[20, 20, 20], 99], [[255, 0, 0], 1]))).toBeNull()
    expect(accentFromPixels(null)).toBeNull()
    expect(accentFromPixels(new Uint8ClampedArray([255, 0, 0, 0]))).toBeNull()
  })
})

describe('placeBlock', () => {
  // A 200px block in a region running 100..900, whose own default start is 300.
  const at = (vpos, blockH = 200, autoTop = 300) => placeBlock(vpos, 100, 900, blockH, autoTop)

  it('puts each preset where it says', () => {
    expect(at('top')).toBe(100)
    expect(at('middle')).toBe(400)
    expect(at('bottom')).toBe(700)
  })

  it('auto is the card\'s own start, not an alias for a preset', () => {
    expect(at('auto')).toBe(300)
    expect(at(undefined)).toBe(300)
  })

  it('auto slides up to make room rather than running past the limit', () => {
    expect(at('auto', 700)).toBe(200)
    expect(at('auto', 200, 850)).toBe(700)
  })

  it('never starts above the region, even when the block is taller than it', () => {
    for (const v of ['auto', 'top', 'middle', 'bottom']) expect(at(v, 1200), v).toBe(100)
  })
})

describe('textBounds', () => {
  it('keeps story text out of the top and bottom 13% that Instagram covers', () => {
    const { edge, footH } = textBounds(1080, 1920, 70)
    expect(edge).toBe(250)
    // The footer is drawn `pad` above footH, so it lands on the safe line.
    expect(footH - 70).toBe(1920 - 250)
  })

  it('leaves every other shape on its plain padding', () => {
    for (const [w, h] of [[1080, 1080], [1080, 1350], [1200, 630], [1200, 675], [800, 1200], [1275, 1650]]) {
      expect(textBounds(w, h, 70), `${w}x${h}`).toEqual({ edge: 70, footH: h })
    }
  })
})

describe('rgbTriplet', () => {
  it('turns a theme colour into the r,g,b an rgba() string takes', () => {
    expect(rgbTriplet('#100f0e')).toBe('16,15,14')
    expect(rgbTriplet(CARD_THEMES.paper.bg)).toBe('240,235,224')
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
