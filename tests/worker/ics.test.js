import { describe, expect, it } from 'vitest'
import { buildIcs, icsAttachment, icsBase64, icsEscape, icsFold, icsUtc } from '../../worker/src/ics.js'

const utf8 = (s) => new TextEncoder().encode(s).length
const decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))

const base = {
  uid: 'e1@jxnfilm.club', title: 'House Night',
  startMs: Date.UTC(2099, 6, 16, 0, 30), durationMs: 3 * 3600_000,
  sequence: 7, nowMs: Date.UTC(2026, 10, 25, 12, 0, 5),
}

describe('icsEscape', () => {
  it('escapes backslash, semicolon, comma and newlines', () => {
    expect(icsEscape('a\\b; c, d\ne\r\nf')).toBe('a\\\\b\\; c\\, d\\ne\\nf')
  })
  it('drops control characters other than tab', () => {
    expect(icsEscape('Bell\u0007Night\u000bTab\there\u007f')).toBe('BellNightTab\there')
  })
  it('renders a missing value as empty', () => {
    expect(icsEscape(undefined)).toBe('')
  })
})

describe('icsFold', () => {
  it('leaves a short line alone', () => {
    expect(icsFold('SUMMARY:Short')).toBe('SUMMARY:Short')
  })

  it('folds at 75 octets, continuation lines led by one space', () => {
    const line = 'SUMMARY:' + 'x'.repeat(200)
    const parts = icsFold(line).split('\r\n')
    expect(parts.length).toBeGreaterThan(2)
    for (const p of parts) expect(utf8(p)).toBeLessThanOrEqual(75)
    for (const p of parts.slice(1)) expect(p.startsWith(' ')).toBe(true)
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line)
  })

  it('counts octets, not characters, and never splits a multi-byte character', () => {
    const line = 'SUMMARY:' + 'é🎬'.repeat(40)
    const folded = icsFold(line)
    for (const p of folded.split('\r\n')) expect(utf8(p)).toBeLessThanOrEqual(75)
    expect(folded.replace(/\r\n /g, '')).toBe(line)
    expect(folded).not.toContain('�')
  })
})

describe('icsUtc', () => {
  it('formats a UTC instant in basic form', () => {
    expect(icsUtc(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('20260102T030405Z')
  })
})

describe('buildIcs', () => {
  it('builds a timed, published event with CRLF line endings throughout', () => {
    const ics = buildIcs({ ...base, location: '9 Private Rd, Jackson', description: 'Film: Crash\nhttps://x.test', url: 'https://x.test' })
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(ics.split('\r\n')).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Jackson Film Club//jxnfilm.club//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:e1@jxnfilm.club',
      'DTSTAMP:20261125T120005Z',
      'SEQUENCE:7',
      'DTSTART:20990716T003000Z',
      'DTEND:20990716T033000Z',
      'SUMMARY:House Night',
      'LOCATION:9 Private Rd\\, Jackson',
      'DESCRIPTION:Film: Crash\\nhttps://x.test',
      'URL:https://x.test',
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ])
  })

  it('builds an all-day event with an exclusive end date', () => {
    const ics = buildIcs({ uid: 'e2', title: 'T', allDayDate: '2099-12-31', allDayEnd: '2100-01-01', nowMs: base.nowMs })
    expect(ics).toContain('DTSTART;VALUE=DATE:20991231\r\n')
    expect(ics).toContain('DTEND;VALUE=DATE:21000101\r\n')
    expect(ics).not.toContain('DTSTART:')
  })

  it('omits the optional lines when there is nothing to put in them', () => {
    const ics = buildIcs(base)
    expect(ics).not.toContain('LOCATION')
    expect(ics).not.toContain('DESCRIPTION')
    expect(ics).not.toContain('URL')
  })

  it('marks a cancellation in both the method and the status', () => {
    const ics = buildIcs({ ...base, cancelled: true })
    expect(ics).toContain('METHOD:CANCEL\r\n')
    expect(ics).toContain('STATUS:CANCELLED\r\n')
    expect(ics).toContain('UID:e1@jxnfilm.club\r\n')
  })
})

describe('icsAttachment', () => {
  it('base64s the UTF-8 bytes, so a non-ASCII title survives', () => {
    const ics = buildIcs({ ...base, title: 'Amélie — 20th 🎬' })
    expect(decode(icsBase64(ics))).toBe(ics)
    const file = icsAttachment(ics)
    expect(file.filename).toBe('event.ics')
    expect(Object.keys(file).sort()).toEqual(['content', 'filename'])
    expect(decode(file.content)).toContain('SUMMARY:Amélie — 20th 🎬')
  })
})
