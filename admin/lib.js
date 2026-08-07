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

// Email-safe standalone poster block for the newsletter composer: one
// centered TMDB poster in the same white-card shell as the sections below,
// optionally wrapped in a link the admin supplies (event page, Letterboxd,
// tickets — anything).
export function buildPosterBlockHtml({ poster, link, title, year }) {
  const caption = `${title || ''}${year ? ` (${year})` : ''}`
  const img = `<img src="${attr(poster)}" width="220" alt="${attr(caption ? caption + ' poster' : 'poster')}" style="display:block;border:0;border-radius:4px;max-width:100%">`
  const inner = link
    ? `<a href="${attr(link)}" style="text-decoration:none">${img}</a>`
    : img
  const captionHtml = caption
    ? `<p style="margin:10px 0 0;font-size:14px;color:#6b675f">${link
        ? `<a href="${attr(link)}" style="color:#d7321f;text-decoration:none">${escapeHtml(caption)}</a>`
        : escapeHtml(caption)}</p>`
    : ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ea;padding:12px 0 24px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff">
      <tr>
        <td align="center" style="padding:28px 32px;font-family:Georgia,'Times New Roman',serif;color:#1c1a17">
          ${inner}${captionHtml}
        </td>
      </tr>
    </table>
  </td></tr>
</table>`
}

export function buildPosterBlockText({ link, title, year }) {
  const caption = `${title || ''}${year ? ` (${year})` : ''}`.trim()
  return link ? (caption ? `${caption}: ${link}` : link) : caption
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

// --- Content Gen (social media) builders ---
//
// Everything below is fed to PUBLIC social posts. Two hard rules, enforced
// here at the source rather than in the UI:
//   1. Events pass through socialEventView() — a house host's private
//      `address`/`notes` (and `capacity`) can never reach generated content.
//   2. Member watches pass through buildRoundupData() — aggregate only:
//      film titles/posters survive, member names and handles do not.

// Public-safe view of a canonical `event:` KV row for social content.
// Mirrors the Worker's publicEventProjection field list, minus capacity.
export function socialEventView(e) {
  if (!e) return null
  const out = {}
  for (const k of ['id', 'title', 'film', 'year', 'date', 'venue', 'poster',
                   'letterboxd_uri', 'hostName', 'hostId', 'kind', 'time']) {
    if (e[k] !== undefined && e[k] !== null && e[k] !== '') out[k] = e[k]
  }
  return out
}

// 'YYYY-MM-DD' -> 'Saturday, June 12'. Parses as a local calendar day (the
// T00:00:00 suffix) so the day never shifts across timezones; anything that
// isn't a bare date echoes back unchanged.
export function fmtSocialDate(iso, { short = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return String(iso || '')
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', short
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'long', month: 'long', day: 'numeric' })
}

// Post-length ceilings per platform; null = no practical limit.
export const PLATFORM_LIMITS = {
  instagram: null,
  facebook: null,
  discord: 2000,
  bluesky: 300,
  x: 280,
}

export const PLATFORM_LABELS = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  discord: 'Discord',
  bluesky: 'Bluesky',
  x: 'X',
}

const EVENTS_URL = 'https://jxnfilm.club/events'
const WATCHED_URL = 'https://jxnfilm.club/watched'
const IG_TAGS = '#JacksonFilmClub #JXN #FilmClub'

// Shared phrasing pieces for an event, built from the public view only.
function eventBits(event) {
  const e = socialEventView(event) || {}
  const name = e.film || e.title || ''
  const titled = name + (e.year ? ` (${e.year})` : '')
  const when = fmtSocialDate(e.date) + (e.time ? ` · ${fmtShowtime(e.time)}` : '')
  const whenShort = fmtSocialDate(e.date, { short: true }) + (e.time ? ` · ${fmtShowtime(e.time)}` : '')
  const venue = e.venue || (e.hostId ? 'a member-hosted screening' : '')
  return { e, name, titled, when, whenShort, venue }
}

// kind: announce | weekof | dayof | recap | roundup
// platform: instagram | facebook | discord | bluesky | x
// data: { event?, count?, films?, total? } — count is the attendance count
// for recaps; films/total come from buildRoundupData().
export function buildSocialCopy(kind, platform, data = {}) {
  if (kind === 'roundup') return roundupCopy(platform, data)
  const { e, titled, when, whenShort, venue } = eventBits(data.event)
  const lead = { announce: 'NEXT SCREENING', weekof: 'THIS WEEK', dayof: 'TONIGHT' }[kind]

  if (kind === 'recap') {
    const n = Number(data.count) || 0
    const crowd = n > 0 ? `${n} of us came out${venue ? ` to ${venue}` : ''}. ` : ''
    if (platform === 'instagram') {
      return `🎬 That's a wrap on ${titled}. ${crowd}Thanks for watching with us — see what's next at the link in bio.\n\n${IG_TAGS}`
    }
    if (platform === 'discord') {
      return `🎬 That's a wrap on **${titled}**. ${crowd}Thanks for watching with us!${e.letterboxd_uri ? `\n${e.letterboxd_uri}` : ''}`
    }
    if (platform === 'bluesky' || platform === 'x') {
      return `🎬 That's a wrap on ${titled}. ${crowd}See what's next: ${EVENTS_URL}`
    }
    return `🎬 That's a wrap on ${titled}. ${crowd}Thanks for watching with us — see what's next: ${EVENTS_URL}`
  }

  // announce / weekof / dayof
  if (platform === 'instagram') {
    return `🎬 ${lead}\n\n${titled}\n📅 ${when}${venue ? `\n📍 ${venue}` : ''}\n\nJoin us — RSVP at the link in bio.\n\n${IG_TAGS}`
  }
  if (platform === 'discord') {
    return `🎬 **${lead}: ${titled}**\n📅 ${when}${venue ? `\n📍 ${venue}` : ''}\n\nRSVP: ${EVENTS_URL}${e.letterboxd_uri ? `\n${e.letterboxd_uri}` : ''}`
  }
  if (platform === 'bluesky' || platform === 'x') {
    return `🎬 ${lead}: ${titled}\n📅 ${whenShort}${venue ? ` · ${venue}` : ''}\n\nRSVP: ${EVENTS_URL}`
  }
  // facebook
  return `🎬 ${lead}\n\n${titled}\n📅 ${when}${venue ? `\n📍 ${venue}` : ''}\n\nJoin us — RSVP and details: ${EVENTS_URL}`
}

function roundupCopy(platform, { films = [], total = 0 } = {}) {
  const names = films.map(f => f.title + (f.year ? ` (${f.year})` : ''))
  // "recently", not "this week" — /watched serves each member's last four
  // diary entries regardless of date, so a weekly claim could overstate.
  const logged = `${total} film${total === 1 ? '' : 's'} logged by members recently.`
  if (platform === 'instagram') {
    return `📽️ WHAT THE CLUB IS WATCHING\n\n${names.join('\n')}\n\n${logged} Follow along at the link in bio.\n\n${IG_TAGS}`
  }
  if (platform === 'discord') {
    return `📽️ **What the club is watching**\n${names.map(n => `- ${n}`).join('\n')}\n\n${logged} ${WATCHED_URL}`
  }
  if (platform === 'bluesky' || platform === 'x') {
    const limit = PLATFORM_LIMITS[platform]
    let list = names.join(' · ')
    const wrap = (l) => `📽️ Recently watched by the club: ${l}\n\n${WATCHED_URL}`
    let used = names.length
    while (used > 1 && wrap(list).length > limit) {
      used--
      list = names.slice(0, used).join(' · ') + ` + ${names.length - used} more`
    }
    return wrap(list)
  }
  // facebook
  return `📽️ What the club is watching\n\n${names.join('\n')}\n\n${logged} See all member activity: ${WATCHED_URL}`
}

// Aggregate a /watched handle-keyed map into public-safe roundup data.
// Member identity is dropped HERE — nothing downstream ever sees a handle
// or name. Films watched by several members appear once; `total` counts the
// underlying diary entries. watched_date is a bare YYYY-MM-DD — sorted as
// strings, never Dates.
export function buildRoundupData(watchedMap, { limit = 8 } = {}) {
  const entries = []
  for (const films of Object.values(watchedMap || {})) {
    for (const f of (films || [])) {
      if (f && f.title) entries.push(f)
    }
  }
  entries.sort((a, b) => String(b.watched_date || '').localeCompare(String(a.watched_date || '')))
  const seen = new Set()
  const films = []
  for (const f of entries) {
    const key = `${String(f.title).toLowerCase()}|${f.year || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const out = { title: f.title }
    if (f.year) out.year = f.year
    if (f.link) out.link = f.link
    if (f.poster) out.poster = f.poster
    if (f.watched_date) out.watched_date = f.watched_date
    films.push(out)
  }
  return { films: films.slice(0, limit), total: entries.length }
}

// 'jfc-announce-2026-06-12-passion-ig-post.png'
export function socialFileName(kind, sizeKey, event) {
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const parts = ['jfc', kind, slug(event && (event.id || event.film || event.title)), sizeKey]
  return parts.filter(Boolean).join('-') + '.png'
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
