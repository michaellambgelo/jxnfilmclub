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

// Letterboxd half-star string: '4.5' renders as four stars and a half mark;
// missing/invalid ratings render as ''.
export function starsOf(rating) {
  const n = Number(rating) || 0
  let s = ''
  for (let i = 0; i < Math.floor(n); i++) s += '★'
  return n - Math.floor(n) >= 0.5 ? s + '½' : s
}

// Star rating + like heart as an email-safe inline suffix for a title line.
// Mirrors the site's .lb-verdict (muted stars, brand-red heart).
function watchedVerdictHtml(e) {
  const stars = starsOf(e.rating)
  if (!stars && !e.liked) return ''
  const heart = e.liked ? `${stars ? ' ' : ''}<span style="color:#d7321f;font-size:1.3em">&hearts;</span>` : ''
  return ` <span style="color:#6b675f;white-space:nowrap">${stars}${heart}</span>`
}

// Email-safe "latest from members" section. Mirrors the compose template's
// structure (bg band + centered 600px white card, Georgia, brand red) so the
// inserted block reads as a continuation of the card above it.
export function buildWatchedSectionHtml(entries) {
  const rows = entries.map(e => `
        <tr>
          <td width="56" style="padding:8px 12px 8px 0;vertical-align:top">${e.poster ? `<img src="${attr(e.poster)}" width="48" height="72" alt="" style="display:block;border:0;border-radius:3px">` : ''}</td>
          <td style="padding:8px 0;vertical-align:top">
            <p style="margin:0;font-size:16px;line-height:1.4"><a href="${attr(e.link)}" style="color:#d7321f;text-decoration:none"><strong>${escapeHtml(e.title)}</strong></a>${e.year ? ` <span style="color:#6b675f">(${escapeHtml(e.year)})</span>` : ''}${watchedVerdictHtml(e)}</p>
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
  const lines = entries.map(e => {
    const stars = starsOf(e.rating)
    const verdict = `${stars ? ' ' + stars : ''}${e.liked ? ' ♥' : ''}`
    return `- ${e.title}${e.year ? ` (${e.year})` : ''}${verdict} — ${e.name || '@' + e.handle}${e.watched_date ? ', ' + e.watched_date : ''}\n  ${e.link}`
  })
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
const SITE_URL = 'https://jxnfilm.club'
const IG_TAGS = '#JacksonFilmClub #JXN #FilmClub'

// Whole days from `today` until `date` — both bare YYYY-MM-DD strings,
// parsed as local calendar days so the count never shifts across timezones.
export function daysUntil(date, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return null
  return Math.round((new Date(date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000)
}

// Countdown lead phrase. Past/undated events fall back to the announce lead.
export function countdownLead(days) {
  if (days == null || days < 0) return 'Next screening'
  if (days === 0) return 'Tonight'
  if (days === 1) return 'Tomorrow'
  return `${days} days away`
}

// '2026-08' -> 'August 2026'
export function fmtMonth(ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return String(ym || '')
  return new Date(ym + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

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

// kind: announce | countdown | recap | roundup | episode | lineup | monthwrap | milestone
// platform: instagram | facebook | discord | bluesky | x
// data by kind:
//   announce/recap — { event, count? }        (count = attendance, recap only)
//   countdown      — { event, today? }        (today = YYYY-MM-DD anchor for tests)
//   roundup        — { films, total }         (from buildRoundupData)
//   episode        — { episode: { title, date?, url } }
//   lineup         — { events: [...] }        (upcoming, already sorted)
//   monthwrap      — { monthLabel, films: [names], screenings, attendees }
//   milestone      — { stat: members|screenings|attendance, value }
export function buildSocialCopy(kind, platform, data = {}) {
  if (kind === 'roundup') return roundupCopy(platform, data)
  if (kind === 'episode') return episodeCopy(platform, data.episode || {})
  if (kind === 'lineup') return lineupCopy(platform, data.events || [])
  if (kind === 'monthwrap') return monthwrapCopy(platform, data)
  if (kind === 'milestone') return milestoneCopy(platform, data)
  const { e, titled, when, whenShort, venue } = eventBits(data.event)
  const lead = kind === 'countdown'
    ? countdownLead(daysUntil(e.date, data.today || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()))).toUpperCase()
    : 'NEXT SCREENING'

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

  // announce / countdown
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

function episodeCopy(platform, { title = '', date, url = '' }) {
  const dated = date ? ` (${fmtSocialDate(date, { short: true })})` : ''
  if (platform === 'instagram') {
    return `🎙️ NEW EPISODE\n\n${title}\n\nListen at the link in bio.\n\n${IG_TAGS} #Podcast`
  }
  if (platform === 'discord') {
    return `🎙️ **New episode: ${title}**${dated}\n${url}`
  }
  if (platform === 'bluesky' || platform === 'x') {
    return `🎙️ New episode: ${title}\n\n${url}`
  }
  return `🎙️ New episode of the Jackson Film Club podcast\n\n${title}\n\nListen: ${url}`
}

function lineupCopy(platform, events) {
  // Double-enforce the public projection even though callers already do.
  const rows = events.map(ev => {
    const e = socialEventView(ev) || {}
    const name = (e.film || e.title || '') + (e.year ? ` (${e.year})` : '')
    return { name, when: fmtSocialDate(e.date, { short: true }) }
  })
  const lines = rows.map(r => `${r.when} — ${r.name}`)
  if (platform === 'instagram') {
    return `🎬 COMING UP AT THE CLUB\n\n${lines.join('\n')}\n\nRSVP at the link in bio.\n\n${IG_TAGS}`
  }
  if (platform === 'discord') {
    return `🎬 **Coming up**\n${lines.map(l => `- ${l}`).join('\n')}\n\nRSVP: ${EVENTS_URL}`
  }
  if (platform === 'bluesky' || platform === 'x') {
    const limit = PLATFORM_LIMITS[platform]
    const wrap = (l) => `🎬 Coming up: ${l}\n\nRSVP: ${EVENTS_URL}`
    let used = rows.length
    let list = lines.join(' · ')
    while (used > 1 && wrap(list).length > limit) {
      used--
      list = lines.slice(0, used).join(' · ') + ` + ${lines.length - used} more`
    }
    return wrap(list)
  }
  return `🎬 Coming up at Jackson Film Club\n\n${lines.join('\n')}\n\nRSVP and details: ${EVENTS_URL}`
}

function monthwrapCopy(platform, { monthLabel = '', films = [], screenings = 0, attendees = 0 } = {}) {
  const stats = `${screenings} screening${screenings === 1 ? '' : 's'}` +
    (attendees > 0 ? ` · ${attendees} attendee${attendees === 1 ? '' : 's'}` : '')
  if (platform === 'instagram') {
    return `🎬 THAT WAS ${monthLabel.toUpperCase()}\n\n${films.join('\n')}\n\n${stats}. See what's next at the link in bio.\n\n${IG_TAGS}`
  }
  if (platform === 'discord') {
    return `🎬 **That was ${monthLabel}**\n${films.map(f => `- ${f}`).join('\n')}\n\n${stats}. Up next: ${EVENTS_URL}`
  }
  if (platform === 'bluesky' || platform === 'x') {
    return `🎬 That was ${monthLabel} at the film club: ${stats}.\n\nWhat's next: ${EVENTS_URL}`
  }
  return `🎬 That was ${monthLabel} at Jackson Film Club\n\n${films.join('\n')}\n\n${stats}. See what's next: ${EVENTS_URL}`
}

const MILESTONE_PHRASES = {
  members: (v) => `We're now ${v} members strong.`,
  screenings: (v) => `${v} screenings and counting.`,
  attendance: (v) => `${v} seats filled since our first screening.`,
}

function milestoneCopy(platform, { stat, value = 0 } = {}) {
  const phrase = (MILESTONE_PHRASES[stat] || MILESTONE_PHRASES.members)(value)
  if (platform === 'instagram') {
    return `🎉 MILESTONE\n\n${phrase}\n\nThank you, Jackson. Come join us — link in bio.\n\n${IG_TAGS}`
  }
  if (platform === 'discord') {
    return `🎉 **${phrase}** Thanks for being here, y'all.`
  }
  if (platform === 'bluesky' || platform === 'x') {
    return `🎉 ${phrase} Thank you, Jackson.\n\n${SITE_URL}`
  }
  return `🎉 ${phrase} Thank you, Jackson — come join us: ${SITE_URL}`
}

function roundupCopy(platform, { films = [], total = 0 } = {}) {
  const names = films.map(f => f.title + (f.year ? ` (${f.year})` : ''))
  // buildRoundupData windows entries to the last 7 days, so the weekly
  // claim is accurate.
  const logged = `${total} film${total === 1 ? '' : 's'} logged by members in the last week.`
  if (platform === 'instagram') {
    return `📽️ WHAT THE CLUB IS WATCHING\n\n${names.join('\n')}\n\n${logged} Follow along at the link in bio.\n\n${IG_TAGS}`
  }
  if (platform === 'discord') {
    return `📽️ **What the club is watching**\n${names.map(n => `- ${n}`).join('\n')}\n\n${logged} ${WATCHED_URL}`
  }
  if (platform === 'bluesky' || platform === 'x') {
    const limit = PLATFORM_LIMITS[platform]
    let list = names.join(' · ')
    const wrap = (l) => `📽️ Watched by the club this week: ${l}\n\n${WATCHED_URL}`
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
// underlying diary entries. watched_date is a bare YYYY-MM-DD — sorted and
// compared as strings, never Dates.
//
// Windowed to the last `days` calendar days (default 7, Central time,
// inclusive of today) so the copy's weekly claim is honest — /watched serves
// each member's last-four entries regardless of age. Undated entries are
// dropped: recency can't be verified, and this feeds public posts.
export function buildRoundupData(watchedMap, { limit = 8, days = 7, today } = {}) {
  const ref = /^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))
    ? today
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
  // Parse + reformat in the same (local) frame, so the day never shifts.
  const cut = new Date(ref + 'T00:00:00')
  cut.setDate(cut.getDate() - (days - 1))
  const cutoff = cut.toLocaleDateString('en-CA')

  const entries = []
  for (const films of Object.values(watchedMap || {})) {
    for (const f of (films || [])) {
      if (f && f.title && f.watched_date && String(f.watched_date) >= cutoff) entries.push(f)
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

// --- Config tab helpers (operator config stored under config:* in MEMBERS_KV) ---

// Move arr[idx] by delta (-1 up / +1 down). Always returns a NEW array;
// out-of-bounds moves return an unchanged clone.
export function moveItem(arr, idx, delta) {
  const next = [...(Array.isArray(arr) ? arr : [])]
  const to = idx + delta
  if (idx < 0 || idx >= next.length || to < 0 || to >= next.length) return next
  const [item] = next.splice(idx, 1)
  next.splice(to, 0, item)
  return next
}

// Trim entries and drop empties, preserving order. Always a new array of
// strings — this is what config:theaters stores.
export function normalizeStringList(list) {
  return (Array.isArray(list) ? list : [])
    .map(s => String(s ?? '').trim())
    .filter(Boolean)
}

// Prune a copy-override form into the stored config:copy blob: keep only
// allowed keys whose trimmed value is non-empty (empty = fall back to the
// hardcoded site default). Returns null when nothing survives — the caller
// deletes the key instead of storing {}.
export function buildCopyOverrides(fields, allowedKeys) {
  const out = {}
  for (const k of (allowedKeys || [])) {
    const v = fields ? fields[k] : undefined
    const t = typeof v === 'string' ? v.trim() : ''
    if (t) out[k] = t
  }
  return Object.keys(out).length ? out : null
}

// Normalize a config:podcast blob for saving. Same shape as
// data/episodes.json ({ featured_id, episodes: [...] }). Unknown fields are
// preserved at both levels (top-level and per-episode) so future site fields
// survive an admin round-trip; the editable string fields are trimmed, and
// episodes left with neither title nor url are dropped.
export function sanitizePodcastConfig(data) {
  const src = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {}
  const out = { ...src }
  const featured = typeof src.featured_id === 'string' ? src.featured_id.trim() : ''
  if (featured) out.featured_id = featured
  else delete out.featured_id
  out.episodes = (Array.isArray(src.episodes) ? src.episodes : [])
    .filter(ep => ep && typeof ep === 'object')
    .map(ep => {
      const e = { ...ep }
      for (const k of ['id', 'title', 'date', 'url']) {
        if (typeof e[k] === 'string') e[k] = e[k].trim()
        if (e[k] === '' || e[k] == null) delete e[k]
      }
      return e
    })
    .filter(e => e.title || e.url)
  return out
}

// --- Voice tab helpers (voice:{promptId}:{memberId} rows in MEMBERS_KV) ---

// Seconds → 'm:ss'. Invalid/missing durations render as an em-dash.
export function fmtDuration(sec) {
  const n = Number(sec)
  if (!isFinite(n) || n < 0 || sec == null || sec === '') return '—'
  const whole = Math.round(n)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

// Bytes → human size. Whole KB below 1 MB, one decimal above.
export function fmtBytes(n) {
  const b = Number(n)
  if (!isFinite(b) || b < 0 || n == null || n === '') return '—'
  if (b < 1024) return `${Math.round(b)} B`
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

// Whole days until an expiry (unix seconds), rounded up — companion to
// fmtExpiry for the Voice tab's prominent countdown. 0 = already expired;
// anything still in the future is at least 1. null for missing/invalid.
export function voiceDaysLeft(unixSec, now = Date.now()) {
  const n = Number(unixSec)
  if (!isFinite(n) || n <= 0 || unixSec == null) return null
  return Math.max(0, Math.ceil((n * 1000 - now) / 86_400_000))
}

// Group parsed voice rows ({ keyName, ...value }) by promptId. The current
// prompt's group sorts first, then groups by most-recent submission; clips
// within a group are newest-first. promptText is taken from the first row
// that carries one.
export function groupVoiceClips(rows, currentPromptId) {
  const groups = new Map()
  for (const r of rows || []) {
    if (!r || !r.promptId) continue
    if (!groups.has(r.promptId)) {
      groups.set(r.promptId, { promptId: r.promptId, promptText: '', clips: [] })
    }
    const g = groups.get(r.promptId)
    if (!g.promptText && r.promptText) g.promptText = r.promptText
    g.clips.push(r)
  }
  for (const g of groups.values()) {
    g.clips.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  }
  const newest = (g) => String(g.clips[0]?.at || '')
  return [...groups.values()].sort((a, b) => {
    const cur = (a.promptId === currentPromptId ? 1 : 0) - (b.promptId === currentPromptId ? 1 : 0)
    return cur !== 0 ? -cur : newest(b).localeCompare(newest(a))
  })
}

// Normalize the config:voice_prompt form into its stored shape
// ({ id, text, deadline? }) — id is slugified, text trimmed, deadline must
// be a bare YYYY-MM-DD when present. Returns null when the result would be
// unusable (no id/text survives, or a malformed deadline) so the caller can
// refuse the save instead of storing junk.
export function sanitizeVoicePrompt(fields) {
  const src = fields || {}
  const id = String(src.id ?? '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const text = String(src.text ?? '').trim()
  if (!id || !text) return null
  const out = { id, text }
  const deadline = String(src.deadline ?? '').trim()
  if (deadline) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return null
    out.deadline = deadline
  }
  return out
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
