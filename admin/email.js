// Email-safe HTML for everything the club mails: the newsletter compose
// default (admin/admin.js) and every transactional send from the join Worker
// (worker/src/index.js imports this file directly). One shell, so the RSVP
// confirmation and the newsletter can never drift into two different brands.
//
// Pure string builders — no DOM, no fetch, no imports — because this file runs
// in three places: the browser (admin SPA, served as a Text module by the
// hosted admin Worker), node (tests/admin), and the join Worker bundle.
//
// Email-client rules every builder here follows: tables for layout, inline
// styles only, absolute https image URLs, no data: URIs (Gmail strips them at
// render time), and every caller-supplied string escaped. Palette mirrors
// css/tokens.css: ink #100f0e, paper #f0ebe0, brand #d7321f.

const BG = '#f5f2ea'
const CARD = '#ffffff'
const INK = '#100f0e'
const PAPER = '#f0ebe0'
const TEXT = '#1c1a17'
const MUTED = '#6b675f'
const BRAND = '#d7321f'
const RULE = '#e6e0d2'
const SERIF = "Georgia,'Times New Roman',serif"

const LOGO_URL = 'https://jxnfilm.club/img/logo.png'
const PRIVACY_URL = 'https://join.jxnfilm.club/privacy'

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

// Only http(s) ever reaches an href or src. Event fields are host- and
// admin-entered; a javascript: or data: value must render as nothing rather
// than as a live link in someone's inbox.
function safeUrl(u) {
  const s = String(u || '').trim()
  return /^https?:\/\//i.test(s) ? s : ''
}

// Event posters are stored as TMDB `original` renditions — megabytes each, for
// a 104px slot that mail clients re-fetch on every open. w342 is still 3x
// that slot. Any other host passes through untouched.
function emailPoster(u) {
  return safeUrl(u).replace(/^(https:\/\/image\.tmdb\.org\/t\/p\/)original\//, '$1w342/')
}

// Escape first, then keep the writer's line breaks — host notes are free
// text (parking, buzzer codes) where the newlines carry meaning.
function multiline(s) {
  return esc(s).replace(/\r?\n/g, '<br>')
}

// Google Maps search URL. The query is the place as written: a venue name or
// a house address. Named in the privacy policy's Third parties list — if this
// ever points somewhere else, change that line in the same commit.
export function mapUrl(place) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(place || '').trim())}`
}

// 'YYYY-MM-DD' -> 'Saturday, January 15, 2099'. UTC on both ends so the
// calendar day never shifts with the runtime's timezone; anything that is not
// a bare date echoes back unchanged.
export function fmtEmailDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return String(iso || '')
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
}

// '19:30' -> '7:30 pm'. Same output as the Worker's fmtTime, so the HTML and
// text parts of one email never disagree about the showtime.
export function fmtEmailTime(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return ''
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`
}

// --- Shell ---

const SHELL_OPEN = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 0">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${CARD}">`

export const EMAIL_HEADER_ROW = `      <tr>
        <td align="center" style="background:${INK};padding:28px 24px">
          <img src="${LOGO_URL}" width="96" height="96" alt="Jackson Film Club" style="display:block;border:0">
          <p style="margin:14px 0 0;font-family:${SERIF};font-size:22px;letter-spacing:1px;color:${PAPER}">Jackson Film Club</p>
        </td>
      </tr>`

// The branded frame: cream page, 600px white card, ink header band. `rows` is
// one or more <tr> rows for the card; `after` is markup below the card (the
// transactional footer). With no `after`, the output is byte-identical to the
// newsletter template this was extracted from — tests/admin/email.test.js
// pins that.
export function emailShellHtml(rows, { after = '' } = {}) {
  return `${SHELL_OPEN}
${EMAIL_HEADER_ROW}
${rows}
    </table>${after}
  </td></tr>
</table>`
}

// --- Transactional blocks (each returns an HTML fragment for the body cell) ---

export function paragraphHtml(text, { muted = false } = {}) {
  return `<p style="margin:0 0 16px;font-size:${muted ? 14 : 16}px;line-height:1.6;color:${muted ? MUTED : TEXT}">${multiline(text)}</p>`
}

// A run of buttons: brand-filled, or outlined with `secondary: true` (the
// way out — cancel — should never look like the thing to click). Entries with
// no usable URL are dropped, so a caller can pass `{ href: event.ticketUrl }`
// without checking it first.
export function buttonsHtml(buttons) {
  const cells = (buttons || [])
    .map(b => ({ ...b, href: safeUrl(b.href) }))
    .filter(b => b.href)
    .map(b => {
      const style = !b.secondary
        ? `display:inline-block;background:${BRAND};color:#ffffff;border:1px solid ${BRAND}`
        : `display:inline-block;background:${CARD};color:${BRAND};border:1px solid ${BRAND}`
      return `<a href="${esc(b.href)}" style="${style};text-decoration:none;font-family:${SERIF};font-size:15px;padding:11px 22px;border-radius:4px;margin:0 8px 8px 0">${esc(b.label)}</a>`
    })
  return cells.length ? `<p style="margin:8px 0 16px">${cells.join('')}</p>` : ''
}

// A boxed caution — "this is a headcount, not a ticket" and its kin. Text the
// reader must not skim past, set apart from the running copy.
export function noticeHtml(text) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr>
            <td style="border-left:3px solid ${BRAND};background:${BG};padding:12px 16px;font-size:14px;line-height:1.5;color:${TEXT}">${multiline(text)}</td>
          </tr></table>`
}

export function notesHtml(label, text) {
  return `<p style="margin:0 0 4px;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:${MUTED}">${esc(label)}</p>
          ${paragraphHtml(text)}`
}

const capitalize = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1)

// What an update changed: one row per field, the old value struck through in
// grey and the new one in bold. Empty values print as "(blank)", matching the
// text part.
export function changesHtml(changes) {
  if (!changes || !changes.length) return ''
  const rows = changes.map(c => `
            <tr>
              <td style="padding:6px 12px 6px 0;vertical-align:top;font-size:14px;color:${MUTED};white-space:nowrap">${esc(capitalize(c.field))}</td>
              <td style="padding:6px 0;vertical-align:top;font-size:15px;line-height:1.5"><s style="color:${MUTED}">${esc(c.from || '(blank)')}</s> &rarr; <strong style="color:${INK}">${esc(c.to || '(blank)')}</strong></td>
            </tr>`).join('')
  return `<p style="margin:0 0 4px;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:${MUTED}">What changed</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-top:1px solid ${RULE};border-bottom:1px solid ${RULE}">${rows}
          </table>`
}

// A one-time code: big, spaced, monospaced, easy to read off a phone and to
// copy. The expiry line sits directly under it.
export function codeBlockHtml(code, expiry) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr>
            <td align="center" style="background:${BG};border:1px solid ${RULE};border-radius:6px;padding:20px 12px">
              <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:bold;letter-spacing:10px;color:${INK}">${esc(code)}</p>
              ${expiry ? `<p style="margin:8px 0 0;font-size:13px;color:${MUTED}">${esc(expiry)}</p>` : ''}
            </td>
          </tr></table>`
}

// The event at a glance: poster on the left (column dropped when there is no
// poster), then title, film, when, where and host.
//
// `address` is an explicit argument and `event.address` is NEVER read here.
// A house address goes only to people holding a seat, so each caller decides
// whether to pass it — the waitlist mail simply doesn't. `cancelled` dims the
// poster and labels the card, for the cancellation mail.
export function eventCardHtml(event, { address = '', cancelled = false } = {}) {
  const e = event || {}
  const poster = emailPoster(e.poster)
  const rows = []
  if (e.film) {
    const film = `${esc(e.film)}${e.year ? ` <span style="color:${MUTED}">(${esc(e.year)})</span>` : ''}`
    const lb = safeUrl(e.letterboxd_uri)
    rows.push(['Film', lb ? `<a href="${esc(lb)}" style="color:${BRAND};text-decoration:none">${film}</a>` : film])
  }
  const when = e.date ? fmtEmailDate(e.date) + (e.time ? ` at ${fmtEmailTime(e.time)}` : '') : 'TBD'
  rows.push(['When', esc(when)])
  const place = address || e.venue || ''
  if (place) {
    rows.push([address ? 'Address' : 'Venue',
      `<a href="${esc(mapUrl(place))}" style="color:${BRAND};text-decoration:none">${multiline(place)}</a>`])
  }
  if (e.hostId) rows.push(['Host', esc(e.hostName || 'a member')])

  const detailRows = rows.map(([label, value]) => `
                  <tr>
                    <td style="padding:3px 12px 3px 0;vertical-align:top;font-size:13px;color:${MUTED};white-space:nowrap">${label}</td>
                    <td style="padding:3px 0;vertical-align:top;font-size:15px;line-height:1.45;color:${TEXT}">${value}</td>
                  </tr>`).join('')

  const label = cancelled
    ? `<p style="margin:0 0 6px;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${BRAND}">Cancelled</p>`
    : ''
  const posterCell = poster
    ? `
              <td width="120" style="padding:16px 0 16px 16px;vertical-align:top"><img src="${esc(poster)}" width="104" alt="" style="display:block;border:0;border-radius:3px;max-width:104px${cancelled ? ';opacity:0.35' : ''}"></td>`
    : ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid ${RULE};border-radius:6px">
            <tr>${posterCell}
              <td style="padding:16px;vertical-align:top">
                ${label}<p style="margin:0 0 8px;font-size:19px;line-height:1.3;font-weight:bold;color:${cancelled ? MUTED : INK}">${esc(e.title || e.film || 'Club event')}</p>
                <table role="presentation" cellpadding="0" cellspacing="0">${detailRows}
                </table>
              </td>
            </tr>
          </table>`
}

// --- Whole message ---

// The footer under the card: why this arrived (one sentence, per email), then
// the events page and the privacy policy. Deliberately no unsubscribe link —
// these are mails the reader triggered, not announcements.
function footerHtml({ why, siteOrigin }) {
  const events = `${safeUrl(siteOrigin) || 'https://jxnfilm.club'}/events`
  const link = (href, text) => `<a href="${esc(href)}" style="color:${MUTED}">${text}</a>`
  return `
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
      <tr>
        <td align="center" style="padding:20px 32px 0;font-family:${SERIF};font-size:12px;line-height:1.6;color:${MUTED}">
          ${why ? `${esc(why)}<br>` : ''}${link(events, 'Upcoming events')} &middot; ${link(PRIVACY_URL, 'Privacy policy')}
        </td>
      </tr>
    </table>`
}

// A complete transactional message. `eyebrow` is the small status line over
// the heading ("You're in", "Updated"); `blocks` are fragments from the
// builders above, in reading order. `preheader` is the inbox preview line.
export function transactionalEmailHtml({ subject, preheader, eyebrow, heading, blocks = [], why, siteOrigin }) {
  const eyebrowHtml = eyebrow
    ? `<p style="margin:0 0 6px;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${BRAND}">${esc(eyebrow)}</p>\n          `
    : ''
  const body = `      <tr>
        <td style="padding:32px 32px 16px;font-family:${SERIF};color:${TEXT}">
          ${eyebrowHtml}<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:${INK}">${esc(heading)}</h1>
          ${blocks.filter(Boolean).join('\n          ')}
        </td>
      </tr>`
  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(preheader)}</div>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject || 'Jackson Film Club')}</title>
</head>
<body style="margin:0;padding:0;background:${BG}">
${preheaderHtml}${emailShellHtml(body, { after: footerHtml({ why, siteOrigin }) })}
</body>
</html>`
}
