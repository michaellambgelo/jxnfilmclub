import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  qs, escapeHtml, attr, tryParse, fmtAge, fmtJoined, fmtExpiry,
  buildWatchedSectionHtml, buildWatchedSectionText,
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
})
