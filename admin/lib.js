// Pure helpers for the admin dashboard — no DOM, no fetch, no globals beyond
// Date.now(). Extracted from admin.js so they can be unit-tested in a plain
// node environment (tests/admin/lib.test.js) without booting the SPA.
// Loaded as a browser-native ES module by admin.js (no build step) and as a
// Text-module static file by the hosted admin Worker.

export const qs = (params) => new URLSearchParams(params).toString()

export function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export function attr(s) { return escapeHtml(s) }

export function tryParse(s) {
  if (s == null) return null
  try { return JSON.parse(s) } catch { return null }
}

export function fmtAge(ms) {
  if (!ms) return '—'
  const sec = Math.floor((Date.now() - ms) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

export function fmtJoined(iso) {
  if (!iso) return '—'
  // Legacy rows stored a bare YYYY-MM-DD (no time-of-day) — parsing that as
  // a UTC instant and reformatting in America/Chicago would roll it back a
  // day, so only run real timestamps through the timezone conversion.
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(iso)
  const d = new Date(bareDate ? iso + 'T00:00:00' : iso)
  if (isNaN(d)) return escapeHtml(iso)
  const opts = { year: 'numeric', month: 'short', day: 'numeric' }
  if (!bareDate) opts.timeZone = 'America/Chicago'
  return d.toLocaleDateString('en-US', opts)
}

export function fmtExpiry(unixSec) {
  if (!unixSec) return '—'
  const ms = unixSec * 1000
  const rem = ms - Date.now()
  if (rem < 0) return 'expired'
  if (rem < 60_000) return `${Math.floor(rem / 1000)}s`
  if (rem < 3_600_000) return `${Math.floor(rem / 60_000)}m`
  if (rem < 86_400_000) return `${Math.floor(rem / 3_600_000)}h`
  return `${Math.floor(rem / 86_400_000)}d`
}

// Email-safe "latest from members" section. Mirrors the compose template's
// structure (bg band + centered 600px white card, Georgia, brand red) so the
// inserted block reads as a continuation of the card above it.
export function buildWatchedSectionHtml(entries) {
  const rows = entries.map(e => `
        <tr>
          <td width="56" style="padding:8px 12px 8px 0;vertical-align:top">${e.poster ? `<img src="${attr(e.poster)}" width="48" height="72" alt="" style="display:block;border:0;border-radius:3px">` : ''}</td>
          <td style="padding:8px 0;vertical-align:top">
            <p style="margin:0;font-size:16px;line-height:1.4"><a href="${attr(e.link)}" style="color:#d7321f;text-decoration:none"><strong>${escapeHtml(e.title)}</strong></a>${e.year ? ` <span style="color:#6b675f">(${escapeHtml(e.year)})</span>` : ''}</p>
            <p style="margin:2px 0 0;font-size:14px;color:#6b675f">${escapeHtml(e.name || '@' + e.handle)}${e.watched_date ? ' — ' + escapeHtml(fmtJoined(e.watched_date)) : ''}</p>
          </td>
        </tr>`).join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ea;padding:12px 0 24px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff">
      <tr>
        <td style="padding:28px 32px;font-family:Georgia,'Times New Roman',serif;color:#1c1a17">
          <h2 style="margin:0 0 12px;font-size:20px;color:#100f0e">Latest from members on Letterboxd</h2>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
          </table>
          <p style="margin:12px 0 0;font-size:14px"><a href="https://jxnfilm.club/watched" style="color:#d7321f">See all member activity &rarr;</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`
}

export function buildWatchedSectionText(entries) {
  const lines = entries.map(e =>
    `- ${e.title}${e.year ? ` (${e.year})` : ''} — ${e.name || '@' + e.handle}${e.watched_date ? ', ' + e.watched_date : ''}\n  ${e.link}`)
  return `Latest from members on Letterboxd:\n${lines.join('\n')}\n\nSee all member activity: https://jxnfilm.club/watched`
}

// '19:30' -> '7:30 pm'. Port of the worker's fmtTime; empty-safe.
export function fmtShowtime(hhmm) {
  if (typeof hhmm !== 'string' || !/^\d{2}:\d{2}$/.test(hhmm)) return ''
  const h = Number(hhmm.slice(0, 2))
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return `${h12}:${hhmm.slice(3)} ${ampm}`
}

// Email-safe "upcoming events" section — same shell as the watched section
// above. IMPORTANT: callers pass canonical `event:` KV rows, which include a
// house host's private address and notes. Read ONLY the public-projection
// fields (poster, film, title, year, date, time, venue, letterboxd_uri,
// hostName, hostId) — never address, notes, or capacity.
export function buildEventsSectionHtml(events) {
  const rows = events.map(e => {
    const name = e.film || e.title || ''
    const venue = e.venue || (e.hostId ? 'Member-hosted screening' : '')
    const when = fmtJoined(e.date) + (e.time ? ` at ${fmtShowtime(e.time)}` : '')
    const meta = [when, venue, e.hostName ? `Hosted by ${e.hostName}` : ''].filter(Boolean)
    const titled = e.letterboxd_uri
      ? `<a href="${attr(e.letterboxd_uri)}" style="color:#d7321f;text-decoration:none"><strong>${escapeHtml(name)}</strong></a>`
      : `<strong>${escapeHtml(name)}</strong>`
    return `
        <tr>
          <td width="56" style="padding:8px 12px 8px 0;vertical-align:top">${e.poster ? `<img src="${attr(e.poster)}" width="48" height="72" alt="" style="display:block;border:0;border-radius:3px">` : ''}</td>
          <td style="padding:8px 0;vertical-align:top">
            <p style="margin:0;font-size:16px;line-height:1.4">${titled}${e.year ? ` <span style="color:#6b675f">(${escapeHtml(e.year)})</span>` : ''}</p>
            <p style="margin:2px 0 0;font-size:14px;color:#6b675f">${meta.map(escapeHtml).join(' — ')}</p>
          </td>
        </tr>`
  }).join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ea;padding:12px 0 24px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff">
      <tr>
        <td style="padding:28px 32px;font-family:Georgia,'Times New Roman',serif;color:#1c1a17">
          <h2 style="margin:0 0 12px;font-size:20px;color:#100f0e">Upcoming events</h2>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
          </table>
          <p style="margin:12px 0 0;font-size:14px"><a href="https://jxnfilm.club/events" style="color:#d7321f">See all events &rarr;</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`
}

export function buildEventsSectionText(events) {
  const lines = events.map(e => {
    const name = e.film || e.title || ''
    const venue = e.venue || (e.hostId ? 'Member-hosted screening' : '')
    const when = e.date + (e.time ? ` at ${fmtShowtime(e.time)}` : '')
    const meta = [when, venue, e.hostName ? `hosted by ${e.hostName}` : ''].filter(Boolean)
    return `- ${name}${e.year ? ` (${e.year})` : ''} — ${meta.join(', ')}${e.letterboxd_uri ? `\n  ${e.letterboxd_uri}` : ''}`
  })
  return `Upcoming events:\n${lines.join('\n')}\n\nSee all events: https://jxnfilm.club/events`
}
