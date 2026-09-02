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

// Email-safe voice-clip CTA for the newsletter: invites members to record a
// clip for the podcast at jxnfilm.club/speak, quoting the current prompt
// (the caller resolves config:voice_prompt vs the generic default).
export function buildVoiceCtaHtml({ text }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ea;padding:12px 0 24px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff">
      <tr>
        <td align="center" style="padding:28px 32px;font-family:Georgia,'Times New Roman',serif;color:#1c1a17">
          <h2 style="margin:0 0 8px;font-size:20px;color:#100f0e">Your voice on the podcast</h2>
          <p style="margin:0 0 6px;font-size:16px;line-height:1.5">This round&rsquo;s prompt: <em style="color:#d7321f">&ldquo;${escapeHtml(text)}&rdquo;</em></p>
          <p style="margin:0 0 14px;font-size:14px;color:#6b675f">Members can record or upload up to three minutes &mdash; the best clips get aired on the show.</p>
          <a href="https://jxnfilm.club/speak" style="display:inline-block;background:#d7321f;color:#ffffff;text-decoration:none;padding:10px 22px;font-size:15px">Record a clip</a>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`
}

export function buildVoiceCtaText({ text }) {
  return `Your voice on the podcast — this round's prompt: "${text}"\nMembers can record or upload up to three minutes: https://jxnfilm.club/speak`
}

// Email-safe poster block for the newsletter composer, built on the
// assumption that a review or announcement FOLLOWS the poster (learned from
// the 2026-08-11 digest, where the review had to be hand-fought into a
// centered standalone card): the poster + caption are centered inside the
// card, then a left-aligned body area is seeded with bracketed placeholder
// copy the admin overwrites in the editable preview. The outer td is NOT
// centered, so typed paragraphs inherit normal left alignment and the
// compose template's body styles — no per-paragraph overrides needed.
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
  const headline = caption ? `About ${escapeHtml(caption)}` : 'Your headline here'
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ea;padding:12px 0 24px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff">
      <tr>
        <td style="padding:28px 32px;font-family:Georgia,'Times New Roman',serif;color:#1c1a17">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
            ${inner}${captionHtml}
          </td></tr></table>
          <h2 style="margin:20px 0 12px;font-size:20px;color:#100f0e">${headline}</h2>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6">[Write your review or announcement here — replace this placeholder in the preview before sending.]</p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`
}

// --- Pasted/uploaded image announcement block ---
//
// A flyer is a COMPLEX IMAGE in the WCAG sense: the one the club actually gets
// carries two films, two showtimes, a date, an RSVP number and a deadline, all
// as pixels. Alt text cannot carry that — a listener can't pause inside alt,
// navigate it by section, or replay part of it, and some clients truncate it.
// So this block follows the same shape buildPosterBlockHtml already uses for
// exactly this reason: a CONCISE alt naming the image, and the real
// information as adjacent text that a screen reader, a plain-text reader, and
// anyone with images off all receive.
//
// `src` must be a hosted https URL, never a data: URI. Two independent reasons:
// major webmail strips data: image sources outright, and the arithmetic rules
// it out anyway — a 600px-wide JPEG of a real flyer is ~250-440KB as base64
// against Gmail's ~102KB clipping threshold, so there is no quality setting
// that both fits and stays legible.

// Everything wrong with a proposed image block, as operator-facing strings.
// The UI gates insertion on this being empty; it is exported separately from
// the builders so the reason can be shown rather than the button just failing.
export function imageBlockIssues({ src, alt, details } = {}) {
  const issues = []
  const url = String(src || '').trim()
  if (!url) issues.push('No image yet.')
  else if (/^data:/i.test(url)) issues.push('Image must be hosted, not embedded — a data: URI is stripped by most mail clients and blows past Gmail\u2019s size limit.')
  else if (!/^https:\/\//i.test(url)) issues.push('Image URL must be https.')

  const altText = String(alt || '').trim()
  if (!altText) issues.push('Alt text is required — it is what a screen reader announces and what shows when images are blocked.')
  // Long alt is its own accessibility failure, not a nitpick: it cannot be
  // navigated or replayed. The details field is where the content belongs.
  else if (altText.length > 140) issues.push('Alt text is too long — describe the image briefly and put the details in the text below it.')

  if (!String(details || '').trim()) issues.push('Add the details in text — the date, time and RSVP info must not live only inside the image.')
  return issues
}

// 536, not 600: the card is <table width="600"> with td padding 28px 32px, so
// the content box is 600 - 32 - 32. Word-engine Outlook honours the width
// ATTRIBUTE and ignores max-width, so a 600 here renders 64px wider than its
// own cell — reproducing the overflow this block exists to fix.
export const IMAGE_BLOCK_MAX_WIDTH = 536

export function buildImageBlockHtml({ src, alt, details, link, width = IMAGE_BLOCK_MAX_WIDTH } = {}) {
  const safeAlt = String(alt || '').trim()
  // The width attribute is what actually sizes an image in Outlook's Word
  // engine, and it reserves layout space when images are blocked. max-width
  // only ever SHRINKS — width:100% would stretch a narrow source to fill the
  // slot, upscaling and blurring it. height:auto stops a scaled image from
  // distorting.
  const img = `<img src="${attr(src)}" width="${attr(width)}" alt="${attr(safeAlt)}" style="display:block;border:0;max-width:100%;height:auto">`
  const inner = link ? `<a href="${attr(link)}">${img}</a>` : img
  const detailHtml = String(details || '').trim()
    .split(/\n{2,}/)
    .map(par => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6">${escapeHtml(par.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ea;padding:12px 0 24px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff">
      <tr>
        <td style="padding:28px 32px;font-family:Georgia,'Times New Roman',serif;color:#1c1a17">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
            ${inner}
          </td></tr></table>
          <div style="margin-top:20px">${detailHtml}</div>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`
}

// The plain-text half. The details are the payload here — the alt only names
// what the image was, since a text reader never sees it.
export function buildImageBlockText({ alt, details, link } = {}) {
  const lines = []
  const safeAlt = String(alt || '').trim()
  const body = String(details || '').trim()
  if (body) lines.push(body)
  if (safeAlt) lines.push(`[Image: ${safeAlt}]`)
  if (link) lines.push(link)
  return lines.join('\n\n')
}

export function buildPosterBlockText({ link, title, year }) {
  const caption = `${title || ''}${year ? ` (${year})` : ''}`.trim()
  const header = link ? (caption ? `${caption}: ${link}` : link) : caption
  return `${header}\n[Write your review or announcement here — replace this placeholder before sending.]`
}

// --- Newsletter compose: body append rules ---
// Every "insert" button appends a generated block to the two compose bodies.
// The join rules live here (rather than inline in the four handlers) so they
// stay identical across inserts and can be unit-tested without the SPA.

// HTML bodies join with a single newline after trimming trailing whitespace —
// the blocks are self-contained <table> cards, so no blank line is needed.
export function appendHtmlChunk(current, chunk) {
  return String(current ?? '').trimEnd() + '\n' + chunk
}

// Plain-text bodies join with a blank line, but seed a still-empty field
// without a leading one. An empty chunk is a no-op — the poster block's text
// line is optional.
export function appendTextChunk(current, chunk) {
  const cur = String(current ?? '')
  if (!chunk) return cur
  return (cur.trim() ? cur.trimEnd() + '\n\n' : '') + chunk
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

// 'Mar 12 – Apr 3, 2026' / 'Dec 28, 2025 – Jan 4, 2026' / 'Apr 3, 2026'.
// Display only — diary date comparisons stay lexical on the bare YYYY-MM-DD.
// The year is carried on the left half only when the range straddles two
// years, so the common case stays short. Parsed with the T00:00:00 suffix so
// the day never shifts, exactly as fmtSocialDate does.
export function fmtDiaryRange(from, to) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
  if (!ok(from) || !ok(to)) return ''
  const f = (iso, withYear) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US',
    withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' })
  if (from === to) return f(to, true)
  return `${f(from, from.slice(0, 4) !== to.slice(0, 4))} – ${f(to, true)}`
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

// kind: announce | countdown | recap | roundup | diary | episode | lineup | monthwrap | milestone
// platform: instagram | facebook | discord | bluesky | x
// data by kind:
//   announce/recap — { event, count? }        (count = attendance, recap only)
//   countdown      — { event, today? }        (today = YYYY-MM-DD anchor for tests)
//   roundup        — { films, total }         (from buildRoundupData)
//   diary          — { films, from, to, page, pageCount }  (one buildDiaryPages page)
//   episode        — { episode: { title, date?, url } }
//   lineup         — { events: [...] }        (upcoming, already sorted)
//   monthwrap      — { monthLabel, films: [names], screenings, attendees }
//   milestone      — { stat: members|screenings|attendance, value }
export function buildSocialCopy(kind, platform, data = {}) {
  if (kind === 'roundup') return roundupCopy(platform, data)
  if (kind === 'diary') return diaryCopy(platform, data)
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

// Copy for one page of buildDiaryPages. Never says "this week" or "recent":
// pages deep in the stack are months or years old, so the date range IS the
// claim. Ratings are the club average (see buildDiaryPages) and appear only
// where there's room — bluesky/x drop them, since every character saved buys
// another title before the "+ N more" truncation kicks in.
function diaryCopy(platform, { films = [], from, to, page = 1, pageCount = 1 } = {}) {
  const half = (n) => Math.round(n * 2) / 2
  const named = (f, withStars) => {
    const base = f.title + (f.year ? ` (${f.year})` : '')
    if (!withStars || !(f.avgRating > 0)) return base
    const stars = starsOf(half(f.avgRating))
    if (!stars) return base
    return `${base} ${stars}` + (f.ratedCount > 1 ? ` (${f.avgRating.toFixed(1)} avg, ${f.ratedCount} members)` : '')
  }
  const names = films.map(f => named(f, true))
  const range = fmtDiaryRange(from, to)
  const lead = range ? `From the club's Letterboxd diary, ${range}` : "From the club's Letterboxd diary"
  const pageTag = pageCount > 1 ? ` (${page}/${pageCount})` : ''

  if (platform === 'instagram') {
    return `📖 ${lead.toUpperCase()}${pageTag}\n\n${names.join('\n')}\n\nFollow along at the link in bio.\n\n${IG_TAGS}`
  }
  if (platform === 'discord') {
    return `📖 **${lead}**${pageTag}\n${names.map(n => `- ${n}`).join('\n')}\n\n${WATCHED_URL}`
  }
  if (platform === 'bluesky' || platform === 'x') {
    const limit = PLATFORM_LIMITS[platform]
    const short = films.map(f => named(f, false))
    const wrap = (l) => `📖 ${lead}${pageTag}: ${l}\n\n${WATCHED_URL}`
    let used = short.length
    let list = short.join(' · ')
    while (used > 1 && wrap(list).length > limit) {
      used--
      list = short.slice(0, used).join(' · ') + ` + ${short.length - used} more`
    }
    return wrap(list)
  }
  // facebook
  return `📖 ${lead}${pageTag}\n\n${names.join('\n')}\n\nSee all member activity: ${WATCHED_URL}`
}

// Every diary page's copy for one platform, as a single clipboard payload.
//
// The counterpart to "Download all N pages" on the PNG side: preparing a
// series otherwise costs N x 5 copy-button presses. One clipboard write is
// instant and ungated, unlike the N spaced downloads.
//
// Per-page character counts are what matter (each page is its own post), so
// this deliberately does NOT respect PLATFORM_LIMITS as a total — the blob is
// a transport for N separate posts, not one. The separator carries the page
// number and its date range so a paste can be split without recounting.
export function diarySeriesCopy(platform, pages = []) {
  return (pages || []).map((p, i) => {
    const range = fmtDiaryRange(p.from, p.to)
    const head = `\u2500\u2500\u2500\u2500\u2500 page ${i + 1}/${pages.length}${range ? ` \u00b7 ${range}` : ''} \u2500\u2500\u2500\u2500\u2500`
    const body = buildSocialCopy('diary', platform, { ...p, page: i + 1, pageCount: pages.length })
    return `${head}\n${body}`
  }).join('\n\n')
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
// Inclusive 'YYYY-MM-DD' floor for a `days`-long window ending on `today`
// (Central time unless a test pins it). Shared by buildRoundupData and
// buildDiaryPages so the two windows can never drift apart.
export function centralCutoff(days, today) {
  const ref = /^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))
    ? today
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
  // Parse + reformat in the same (local) frame, so the day never shifts.
  const cut = new Date(ref + 'T00:00:00')
  cut.setDate(cut.getDate() - (days - 1))
  return cut.toLocaleDateString('en-CA')
}

export function buildRoundupData(watchedMap, { limit = 8, days = 7, today } = {}) {
  const cutoff = centralCutoff(days, today)

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

// Page the club's Letterboxd diary into fixed-size, public-safe cards.
//
// Identity is dropped HERE, same contract as buildRoundupData above — and one
// step further: `link` is deliberately NOT carried through. A diary-entry link
// is https://letterboxd.com/<handle>/film/<slug>/, so it *is* the handle. With
// it omitted, "no diary page output contains a member handle" is provable by
// inspection of the returned shape.
//
// `days` windows the pool like buildRoundupData does (null = no window, the
// default). Unwindowed, the deep pages are genuinely old — feed depth is
// capped per member, not by date, so a dormant member's entries can reach back
// years while an active member's span weeks. Each page therefore carries its
// own `from`/`to` so callers can state the real range instead of implying
// recency.
//
// `maxPages` truncates the result. The full feed runs to ~40 pages, of which
// only the first few are postable, so the cap is what keeps "download all"
// from emitting a folder nobody wanted. It's applied HERE rather than in the
// UI so pageCount, the picker, the batch button and the copy's "(3/5)" can't
// disagree; `availablePages` still reports what was there before the cut.
//
// `rating` is one member's opinion, so a deduped row must never show it as if
// it were the club's. Instead every rating for the film is averaged:
// `avgRating` is the mean over `ratedCount` raters, which is <= `count`, the
// number of members who logged it (some log without rating).
//
// watched_date is a bare YYYY-MM-DD compared lexically, never via Date.
export function buildDiaryPages(watchedMap, { perPage = 10, days = null, today, maxPages = null } = {}) {
  const dated = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
  // Undated entries are dropped either way — unverifiable recency feeding a
  // public post — so a window only ever tightens an already-dated floor.
  const cutoff = days > 0 ? centralCutoff(days, today) : null
  const entries = []
  for (const films of Object.values(watchedMap || {})) {
    for (const f of (films || [])) {
      if (!f || !f.title || !dated(f.watched_date)) continue
      if (cutoff && String(f.watched_date) < cutoff) continue
      entries.push(f)
    }
  }

  // Newest first. Same-day order is undefined in the source (per-member feeds
  // are merged, and Letterboxd gives no intra-day time), so the tiebreak is the
  // title|year key ascending: total, stable across reloads, independent of
  // member iteration order, and locale-independent (plain < / >, not
  // localeCompare, whose collation is ICU-dependent). Without a total order the
  // page boundaries drift between renders and a batch export isn't reproducible.
  const keyOf = (f) => `${String(f.title).toLowerCase()}|${f.year == null ? '' : String(f.year)}`
  entries.sort((a, b) => {
    const d = String(b.watched_date).localeCompare(String(a.watched_date))
    if (d) return d
    const ka = keyOf(a), kb = keyOf(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  // First occurrence wins = newest watched_date, by the sort above. Map
  // preserves insertion order, so the deduped list stays sorted.
  const byKey = new Map()
  for (const f of entries) {
    const k = keyOf(f)
    let row = byKey.get(k)
    if (!row) {
      row = {
        title: String(f.title),
        ...(f.year == null || f.year === '' ? {} : { year: String(f.year) }),
        ...(f.poster ? { poster: f.poster } : {}),
        watched_date: String(f.watched_date),
        count: 0,
        ratedCount: 0,
      }
      row._sum = 0
      byKey.set(k, row)
    }
    row.count++
    if (f.liked) row.liked = true
    const r = Number(f.rating)
    if (r > 0) { row.ratedCount++; row._sum += r }
  }

  const films = []
  for (const row of byKey.values()) {
    if (row.ratedCount > 0) row.avgRating = row._sum / row.ratedCount
    delete row._sum
    films.push(row)
  }

  const size = Math.max(1, Math.floor(Number(perPage)) || 10)
  const pages = []
  for (let i = 0; i < films.length; i += size) {
    const chunk = films.slice(i, i + size)
    pages.push({
      films: chunk,
      to: chunk[0].watched_date,
      from: chunk[chunk.length - 1].watched_date,
    })
  }
  const availablePages = pages.length
  const cap = maxPages > 0 ? Math.floor(maxPages) : null
  const kept = cap ? pages.slice(0, cap) : pages

  return {
    pages: kept,
    films: cap ? films.slice(0, cap * size) : films,
    total: films.length,          // unique films in scope, before the page cap
    entries: entries.length,      // diary entries behind them
    pageCount: kept.length,
    availablePages,
    days: days > 0 ? days : null,
  }
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

// --- Member stats ---
//
// PARITY NOTE. These mirror computeAccountStats() in ui/auth.html, which is
// what a member sees on /edit. The two cannot share code — that one lives in
// Nue dhtml module scope, this one in the admin's plain-module SPA — so the
// semantics are pinned by tests/admin/lib.test.js instead. Change one, change
// both: rank ties, the upcoming-events window and the exact-key watched
// lookup all have to agree or the admin will quietly contradict the member's
// own page.
//
// The inputs are the raw KV shapes the admin already bulk-loads, so a whole
// club costs the same handful of reads as one member.

// Attendance entries are { id, name } keyed on member id; the name is only a
// fallback for rows no member row resolves (guests, deleted members, rows that
// predate the id migration). Mirrors normalizeAttendees in worker/src/index.js
// and model/index.ts - the admin reads raw KV, so it meets both shapes.
export function normalizeAttendees(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const v of value) {
    if (typeof v === 'string') {
      if (v) out.push({ id: null, name: v })
    } else if (v && typeof v === 'object') {
      const id = typeof v.id === 'string' && v.id ? v.id : null
      const name = typeof v.name === 'string' ? v.name : ''
      if (id || name) out.push({ id, name })
    }
  }
  return out
}

// Hosts are overlaid onto attendance at READ time by the join Worker
// (handleAttendanceMap), because screenings created before that change never
// got the host mirrored into attend:{id}. data/attendance.json - the snapshot
// the member card reads - is taken off that endpoint, so it already has them.
// Raw attendance:all does NOT. Without this the admin undercounts every host
// against their own card. Dedupe is by hostId, with a name fallback for the
// pre-migration mirror that wrote the host as a bare string.
export function attendanceWithHosts(attendance, events) {
  const out = {}
  for (const id of Object.keys(attendance || {})) out[id] = normalizeAttendees(attendance[id])
  for (const e of events || []) {
    if (!e || !e.hostId) continue
    const list = out[e.id] || []
    if (list.some(a => a.id === e.hostId)) { out[e.id] = list; continue }
    const legacy = e.hostName ? list.findIndex(a => !a.id && a.name === e.hostName) : -1
    if (legacy !== -1) {
      const next = list.slice()
      next[legacy] = { id: e.hostId, name: e.hostName }
      out[e.id] = next
    } else if (e.hostName) {
      out[e.id] = [{ id: e.hostId, name: e.hostName }, ...list]
    } else {
      out[e.id] = list
    }
  }
  return out
}

// Central-time today as YYYY-MM-DD. Event dates are bare date strings and are
// compared lexically, never parsed into Dates - see fmtJoined above for the
// same reasoning about day-rolling.
export function clubToday(now) {
  const d = now || new Date()
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d)
}

// One pass over the raw reads, shared by every member. Returns the derived
// lookups computeMemberStats needs, so a club of N costs one pass, not N.
export function buildStatsContext({ attendance, events, rsvps, voiceKeys, watched, members }, now) {
  const evs = events || []
  const withHosts = attendanceWithHosts(attendance, evs)

  // Reverse name index, for rows that have no id yet: a row written before the
  // backfill still belongs to whoever answers to that name today. Names shared
  // by two members are dropped rather than guessed at. Mirrors idsByName() in
  // model/index.ts.
  const idsByName = {}
  const dupeNames = new Set()
  for (const m of members || []) {
    if (!m || !m.id || !m.name) continue
    const k = String(m.name).trim().toLowerCase()
    if (idsByName[k] && idsByName[k] !== m.id) dupeNames.add(k)
    idsByName[k] = m.id
  }
  for (const k of dupeNames) delete idsByName[k]

  // Keyed on member id (name as the key of last resort for guests and
  // unmatched legacy rows), so a rename no longer splits one member's history
  // across two buckets.
  const counts = {}
  for (const id of Object.keys(withHosts)) {
    for (const a of withHosts[id] || []) {
      const resolved = a.id || idsByName[String(a.name).trim().toLowerCase()] || null
      const key = resolved ? `id:${resolved}` : `name:${a.name}`
      counts[key] = (counts[key] || 0) + 1
    }
  }

  const today = clubToday(now)
  const upcomingIds = new Set(evs.filter(e => (e.date || '') >= today).map(e => e.id))

  // rsvps is { "rsvp:{eventId}": {confirmed:[],waitlist:[]} } straight off the
  // prefix read. Flatten to memberId -> count of upcoming events they hold a
  // seat or a waitlist place on, matching what /rsvp/me reports per event.
  const rsvpByMember = {}
  for (const key of Object.keys(rsvps || {})) {
    const eventId = key.startsWith('rsvp:') ? key.slice(5) : key
    if (!upcomingIds.has(eventId)) continue
    const row = rsvps[key] || {}
    for (const r of [...(row.confirmed || []), ...(row.waitlist || [])]) {
      if (r && r.memberId) rsvpByMember[r.memberId] = (rsvpByMember[r.memberId] || 0) + 1
    }
  }

  // voice:{promptId}:{memberId} - count the rows whose trailing segment is
  // this member. Same 60-day-retention meaning as the member-facing count.
  const clipsByMember = {}
  for (const key of voiceKeys || []) {
    const memberId = String(key).split(':').slice(2).join(':')
    if (memberId) clipsByMember[memberId] = (clipsByMember[memberId] || 0) + 1
  }

  return { counts, events: evs, today, rsvpByMember, clipsByMember, watched: watched || {} }
}

export function computeMemberStats(member, ctx) {
  const m = member || {}
  const attended = (m.id && ctx.counts[`id:${m.id}`]) || 0

  // Ties share the better position: two members on 4 are both 2nd, nobody 3rd.
  const rank = attended > 0
    ? Object.keys(ctx.counts).filter(k => ctx.counts[k] > attended).length + 1
    : 0

  // Exact-key lookup on the handle. watched keys carry Letterboxd display
  // case, and watched-view on the public site does not normalize either.
  //
  // This is NOT a films-logged total and must never be shown as one. The feed
  // parser stops at WATCHED_FEED_DEPTH (50 — the RSS ceiling) per handle, so a
  // member who has logged more than that still reads exactly 50. It stays here because the
  // admin uses it to source newsletter content, and atFilmCap lets the table
  // render 12+ rather than lie. The member-facing card does not show it at all.
  const logged = (m.handle && ctx.watched[m.handle]) ? ctx.watched[m.handle].length : 0
  const atFilmCap = logged >= WATCHED_FEED_DEPTH

  return {
    id: m.id || '',
    name: m.name || '',
    handle: m.handle || null,
    joined: m.joined || null,
    newsletter: !!m.newsletter,
    attended,
    rank,
    rankLabel: rank ? ordinal(rank) : '',
    hosted: ctx.events.filter(e => e.hostId && e.hostId === m.id).length,
    logged,
    atFilmCap,
    rsvps: ctx.rsvpByMember[m.id] || 0,
    clips: ctx.clipsByMember[m.id] || 0,
  }
}

// Mirrors WATCHED_FEED_DEPTH in worker/src/index.js — the point at which the
// RSS parser stops, and therefore the point at which a count becomes "or more".
// The admin reads /api/watched at full depth, so this is the cache depth (50),
// NOT the public projection (WATCHED_PUBLIC_DEPTH = 12).
export const WATCHED_FEED_DEPTH = 50

export function ordinal(n) {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  const ones = n % 10
  if (ones === 1) return `${n}st`
  if (ones === 2) return `${n}nd`
  if (ones === 3) return `${n}rd`
  return `${n}th`
}
