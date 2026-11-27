// iCalendar (RFC 5545) text for one event, attached to the mails a confirmed
// RSVP gets so a mail client can offer "add to calendar".
//
// Pure and dependency-free. The caller decides what goes in: this module never
// sees an event row, only the strings it is handed, so the private-address
// rule stays where every other mail enforces it (the sender).

const enc = new TextEncoder()

// TEXT value escaping (RFC 5545 §3.3.11). CRs are dropped so a pasted Windows
// line ending becomes one escaped newline, and every other control character
// but tab is removed: TEXT forbids them, the event validators do not, and a
// strict parser may throw the whole file away over one.
export function icsEscape(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

// Content lines are capped at 75 octets, not characters; a continuation line
// starts with one space, which counts toward its own 75. Folding walks code
// points so a multi-byte character is never split across lines.
export function icsFold(line) {
  const out = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = enc.encode(ch).length
    if (bytes + n > 75) {
      out.push(cur)
      cur = ' '
      bytes = 1
    }
    cur += ch
    bytes += n
  }
  out.push(cur)
  return out.join('\r\n')
}

const pad = (n) => String(n).padStart(2, '0')

// UTC "basic" form, e.g. 20260716T003000Z. UTC throughout means no VTIMEZONE
// block; the reader's calendar converts to its own zone.
export function icsUtc(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

const icsDate = (ymd) => ymd.replaceAll('-', '')

// One VEVENT in one VCALENDAR.
//
// Timed:   { startMs, durationMs }
// All-day: { allDayDate: 'YYYY-MM-DD', allDayEnd: 'YYYY-MM-DD' } — DTEND is
//          exclusive, so a one-day event ends on the following date.
//
// `uid` must be stable for the life of the event and `sequence` must not go
// down: that pair is what lets a later file (an update, a cancellation)
// replace the entry an earlier one created instead of adding a second.
export function buildIcs({
  uid, title, description = '', location = '', url = '',
  startMs, durationMs, allDayDate, allDayEnd,
  sequence = 0, nowMs = Date.now(), cancelled = false,
}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jackson Film Club//jxnfilm.club//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${String(uid).replace(/[\s\x00-\x1f]/g, '')}`,
    `DTSTAMP:${icsUtc(nowMs)}`,
    `SEQUENCE:${sequence}`,
  ]
  if (allDayDate) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(allDayDate)}`, `DTEND;VALUE=DATE:${icsDate(allDayEnd)}`)
  } else {
    lines.push(`DTSTART:${icsUtc(startMs)}`, `DTEND:${icsUtc(startMs + durationMs)}`)
  }
  lines.push(`SUMMARY:${icsEscape(title)}`)
  if (location) lines.push(`LOCATION:${icsEscape(location)}`)
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`)
  // URL is a URI value, not TEXT: it is not escaped.
  if (url) lines.push(`URL:${url}`)
  lines.push(
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  )
  return lines.map(icsFold).join('\r\n') + '\r\n'
}

// Base64 of the UTF-8 bytes. TextEncoder + btoa rather than Buffer: the
// production Worker runs without nodejs_compat (the test pool has it), so
// Buffer would pass every test and throw on the first real send.
export function icsBase64(text) {
  let bin = ''
  for (const b of enc.encode(text)) bin += String.fromCharCode(b)
  return btoa(bin)
}

// The Resend attachment entry. Deliberately no content type: Resend derives
// text/calendar from the .ics filename, and its docs do not pin the raw-JSON
// name of the override field. A key the API rejected would fail the whole
// send, and the mail matters more than the file. The METHOD a client needs is
// inside the file either way.
export function icsAttachment(text) {
  return { filename: 'event.ics', content: icsBase64(text) }
}
