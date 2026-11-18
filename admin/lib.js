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
          <p style="margin:0 0 14px;font-size:14px;color:#6b675f">Members can record or upload up to three minutes.</p>
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

// Fit a source image into a box, preserving aspect and NEVER upscaling.
// Returns the drawn pixel size plus the display width the email should use.
//
// The height cap is why this is not a one-liner: a 2:3 portrait flyer at the
// full 536px content width renders ~804px tall and swallows the whole email,
// so the height binds first and the width follows from it.
export function fitBox(srcW, srcH, { maxW = 1072, maxH = 1440, displayMax = IMAGE_BLOCK_MAX_WIDTH } = {}) {
  const w = Math.max(0, Math.round(Number(srcW) || 0))
  const h = Math.max(0, Math.round(Number(srcH) || 0))
  if (!w || !h) return { width: 0, height: 0, displayWidth: 0 }
  // <= 1 always: scale down to fit, or leave alone.
  const scale = Math.min(1, maxW / w, maxH / h)
  const width = Math.max(1, Math.round(w * scale))
  const height = Math.max(1, Math.round(h * scale))
  // The rendered slot is half the drawn pixels (2x for retina), capped by the
  // card's content box and by a portrait height budget.
  const displayW = Math.min(displayMax, Math.round(width / 2))
  const displayH = Math.round(displayW * (height / width))
  const displayWidth = displayH > 720
    ? Math.max(1, Math.round(displayW * (720 / displayH)))
    : displayW
  return { width, height, displayWidth }
}

// --- Content Gen poster layout ---
//
// Per-(event, card size) adjustments to how a single-poster card is composed:
// where the poster is cropped (focal point + zoom), how much of the card it
// takes, the fade into the ink panel, band vs full-bleed, and a text-size
// nudge. Saved as `cardlayout:<eventId>:<size>` in ATTENDANCE_KV — one key
// per pair so a save is a blind overwrite, never a read-modify-write.
//
// The saved row carries the poster URL it was tuned against. A focal point is
// meaningless against a different image, so if the event's poster has since
// changed the saved layout is ignored (reported as `stale`) rather than
// silently producing a wrong crop.

export const CARD_LAYOUT_PREFIX = 'cardlayout:'
export const cardLayoutKey = (eventId, size) => `${CARD_LAYOUT_PREFIX}${eventId}:${size}`

export const LAYOUT_LIMITS = {
  zoom: [1, 3],
  band: [0.2, 0.8],
  fade: [0, 600],
  text: [0.7, 1.4],
  // Per-element size nudges, multiplied onto `text`: the title alone, the
  // detail lines (date, venue, extra), and the eyebrow label.
  title: [0.5, 1.6],
  meta: [0.6, 1.6],
  label: [0.6, 1.6],
}

// The knobs that size type rather than crop the poster. They mean the same
// thing whatever the artwork is, so they survive a poster change (and exist
// for an event with no poster at all).
export const LAYOUT_TYPE_KEYS = ['text', 'title', 'meta', 'label']

// `band`/`fade: null` mean "the card's own default for its shape and mode"
// (resolved by resolveLayout in contentgen.js) — kept distinct from any number
// so a later change to that default still reaches layouts that never touched
// the knob.
export const DEFAULT_LAYOUT = Object.freeze({
  fx: 0.5, fy: 0.5, zoom: 1, band: null, fade: null, mode: 'band', text: 1,
  title: 1, meta: 1, label: 1, vpos: 'auto', align: 'left', theme: null,
})

// How the poster is shown: cropped into a band, cropped across the whole card,
// or whole and uncropped ('fit') inside the band.
export const LAYOUT_MODES = ['band', 'full', 'fit']
// Where the text block sits. 'auto' is each card's own default, which is not
// the same as any of the three presets.
export const LAYOUT_VPOS = ['auto', 'top', 'middle', 'bottom']
export const LAYOUT_ALIGN = ['left', 'center']
const oneOf = (v, list) => (list.includes(v) ? v : list[0])

// --- Card themes ---
//
// A theme is a whole palette, never one colour, so every combination on offer
// has been checked for contrast (tests/admin/card-layout.test.js holds each
// one to WCAG ratios). `text4` is the faintest text a card sets; `accent` is
// the eyebrow, footer rule, count numeral and extra line.
export const CARD_THEMES = Object.freeze({
  night: { label: 'Night', bg: '#100f0e', surface: '#16140f', text: '#f0ebe0', text2: '#c4bdae', text4: '#8f897d', accent: '#d7321f' },
  paper: { label: 'Paper', light: true, bg: '#f0ebe0', surface: '#e8e3d8', text: '#100f0e', text2: '#3a352d', text4: '#55524a', accent: '#b52a19' },
  red: { label: 'Red', bg: '#c42d1b', surface: '#b52a19', text: '#fff6ea', text2: '#f0ebe0', text4: '#f0ebe0', accent: '#100f0e' },
  mono: { label: 'Mono', bg: '#100f0e', surface: '#16140f', text: '#f0ebe0', text2: '#c4bdae', text4: '#8f897d', accent: '#f0ebe0' },
  // Night with the accent sampled from the poster (accentFromPixels); the
  // accent here is the fallback when there is nothing usable to sample.
  poster: { label: 'From poster', bg: '#100f0e', surface: '#16140f', text: '#f0ebe0', text2: '#c4bdae', text4: '#8f897d', accent: '#d7321f' },
})
export const LAYOUT_THEMES = Object.keys(CARD_THEMES)

const hexRgb = (hex) => [1, 3, 5].map(i => parseInt(String(hex).slice(i, i + 2), 16))
const rgbHex = (rgb) => '#' + rgb.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
// "r,g,b" for building rgba() strings from a theme colour.
export const rgbTriplet = (hex) => hexRgb(hex).join(',')

const luminance = (hex) => {
  const [r, g, b] = hexRgb(hex).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
// WCAG contrast ratio between two #rrggbb colours, 1..21.
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Picks an accent out of a poster's pixels (`data`: RGBA bytes, as from
// getImageData on a small thumbnail). Takes the dominant vivid hue, then
// lightens it until it reads on `bg`. Returns null when the artwork is
// near-grey, so the caller keeps the brand accent rather than a muddy one.
export function accentFromPixels(data, bg = '#100f0e', minContrast = 4.5) {
  if (!data || data.length < 4) return null
  const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }))
  let total = 0, vivid = 0
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    total++
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const sat = max === 0 ? 0 : (max - min) / max
    if (sat < 0.4 || max < 90) continue
    vivid++
    const d = max - min
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    if (h < 0) h += 6
    const k = buckets[Math.min(11, Math.floor(h * 2))]
    const w = sat * (max / 255)
    k.w += w; k.r += r * w; k.g += g * w; k.b += b * w
  }
  if (!total || vivid / total < 0.04) return null
  const top = buckets.reduce((a, b) => (b.w > a.w ? b : a))
  let rgb = [top.r / top.w, top.g / top.w, top.b / top.w]
  // Toward white in small steps: keeps the hue, raises the contrast on ink.
  for (let i = 0; i < 40 && contrastRatio(rgbHex(rgb), bg) < minContrast; i++) {
    rgb = rgb.map(v => v + (255 - v) * 0.08)
  }
  const hex = rgbHex(rgb)
  return contrastRatio(hex, bg) >= minContrast ? hex : null
}

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

export function normalizeLayout(raw, poster) {
  const base = { ...DEFAULT_LAYOUT }
  if (!raw || typeof raw !== 'object') return { ...base, stale: false }
  const type = {}
  for (const k of LAYOUT_TYPE_KEYS) type[k] = clampNum(raw[k], ...LAYOUT_LIMITS[k], base[k])
  type.vpos = oneOf(raw.vpos, LAYOUT_VPOS)
  type.align = oneOf(raw.align, LAYOUT_ALIGN)
  // `null` is "this size's own default theme", like band and fade.
  type.theme = LAYOUT_THEMES.includes(raw.theme) ? raw.theme : null
  // A crop tuned against a different image is meaningless; the type sizes and
  // the text placement are not, so only the crop is dropped.
  if ((raw.poster || '') !== (poster || '')) return { ...base, ...type, stale: true }
  return {
    fx: clampNum(raw.fx, 0, 1, base.fx),
    fy: clampNum(raw.fy, 0, 1, base.fy),
    zoom: clampNum(raw.zoom, ...LAYOUT_LIMITS.zoom, base.zoom),
    band: clampNum(raw.band, ...LAYOUT_LIMITS.band, null),
    fade: clampNum(raw.fade, ...LAYOUT_LIMITS.fade, null),
    mode: oneOf(raw.mode, LAYOUT_MODES),
    ...type,
    stale: false,
  }
}

// --- Card text geometry (pure, so it can be unit-tested without a canvas) ---

// Where a text block of height `blockH` starts inside [regionTop, limit] for
// a placement preset. `autoTop` is the card's own default start.
export function placeBlock(vpos, regionTop, limit, blockH, autoTop) {
  const last = Math.max(regionTop, limit - blockH)
  if (vpos === 'top') return regionTop
  if (vpos === 'middle') return Math.max(regionTop, Math.round((regionTop + limit - blockH) / 2))
  if (vpos === 'bottom') return last
  return Math.min(autoTop, last)
}

// Instagram draws its own header over the top of a story and its reply bar
// over the bottom, about 250px of 1920 each. On that shape the event cards
// keep their text (not the artwork) clear of both. Returns the top edge for
// text and the height to hand footer()/footerTop() so the footer sits above
// the reply bar; on every other shape these are just `pad` and `H`.
export function textBounds(W, H, pad) {
  const safe = H / W > 1.7 ? Math.round(H * 0.13) : 0
  return { edge: Math.max(pad, safe), footH: H - Math.max(0, safe - pad) }
}

// True when a layout renders identically to the defaults — nothing to save.
export function isDefaultLayout(l) {
  return !!l && Object.keys(DEFAULT_LAYOUT).every(k => l[k] === DEFAULT_LAYOUT[k])
}

// object-fit: cover with a movable focal point and a zoom >= 1. (fx, fy) is
// the point of the source image, in 0..1, that the crop is centred on; the
// window is then clamped so it never leaves the image (a cover crop must not
// expose the canvas behind it). Returns the source rect for drawImage plus
// the source->destination scale the pointer handler needs to map drags.
export function coverRect(nw, nh, w, h, { fx = 0.5, fy = 0.5, zoom = 1 } = {}) {
  const scale = Math.max(w / nw, h / nh) * Math.max(1, Number(zoom) || 1)
  const sw = w / scale
  const sh = h / scale
  const sx = Math.min(nw - sw, Math.max(0, fx * nw - sw / 2))
  const sy = Math.min(nh - sh, Math.max(0, fy * nh - sh / 2))
  return { sx, sy, sw, sh, scale }
}

// Move a focal point by a destination-space drag. Dragging right moves the
// image right, i.e. the crop window (and its centre) left. The result is
// re-expressed as the centre of the CLAMPED window, so dragging past an edge
// doesn't bank invisible travel that has to be undone before it moves back.
export function panFocal(nw, nh, w, h, layout, dx, dy) {
  const { sw, sh, scale } = coverRect(nw, nh, w, h, layout)
  const fx = layout.fx - dx / scale / nw
  const fy = layout.fy - dy / scale / nh
  const r = coverRect(nw, nh, w, h, { ...layout, fx, fy })
  return { fx: (r.sx + sw / 2) / nw, fy: (r.sy + sh / 2) / nh }
}

// --- Newsletter body size + safety guards ---
//
// Three independent failure modes live on this one path, and two of them are
// silent:
//
//   Gmail strips data: image sources at RENDER time — the message arrives
//   intact and looks correct in the preview, in Resend's dashboard, and in a
//   test send to an Apple Mail address, then shows most of the club a blank
//   gap. That is why a data: URI is refused outright rather than warned about.
//
//   Gmail clips the text/html part around 102KB, at an arbitrary byte offset,
//   hiding the unsubscribe footer behind "View entire message".
//
//   sendBatch JSON.stringify's a chunk of 100 messages, and stringify flattens
//   each .html in place while the flat copies stay reachable — peak heap is
//   roughly twice the stringified length, so a ~640KB body already approaches
//   the 128MB isolate ceiling. That failure surfaces as "internal server
//   error" after the whole newsletter has been composed.

// UTF-8 bytes, not .length — .length undercounts every non-ASCII character,
// and these bodies carry curly quotes, em dashes and emoji.
export function utf8Bytes(s) {
  return new TextEncoder().encode(String(s || '')).length
}

// 92KB is a deliberate margin under Gmail's ~102KB clip, not a derivation: the
// per-recipient unsubscribe footer is concatenated AFTER any check here, and
// transfer encoding expands the body further.
export const NL_HTML_WARN_BYTES = 72 * 1024
export const NL_HTML_BLOCK_BYTES = 92 * 1024
export const NL_TEXT_BLOCK_BYTES = 32 * 1024

export function newsletterSizeReport(html, text) {
  const htmlBytes = utf8Bytes(html)
  const textBytes = utf8Bytes(text)
  const level = htmlBytes >= NL_HTML_BLOCK_BYTES || textBytes >= NL_TEXT_BLOCK_BYTES ? 'over'
    : htmlBytes >= NL_HTML_WARN_BYTES ? 'warn'
    : 'ok'
  return { htmlBytes, textBytes, level }
}

const DATA_SRC = /src\s*=\s*["']?\s*data:/i
const HOSTED_IMG = /https?:\/\/[^"'\s>]*\/nl\/img\/[^"'\s>]*/gi

// The single highest-priority reason this body must not be sent, or null.
// Returns a reason rather than a boolean so the UI can say WHY rather than a
// button merely refusing.
//
// `expectedOrigin` is the join Worker origin for the selected env; a body
// composed against staging carries staging image URLs that 404 for every
// recipient once it is sent from production.
export function newsletterSendBlocker(html, text, { expectedOrigin } = {}) {
  const body = String(html || '')
  if (DATA_SRC.test(body)) {
    return {
      code: 'data_uri',
      message: 'This body has an embedded image. Gmail strips those, so most members would see nothing — host the image and insert it as a flyer instead.',
    }
  }
  if (expectedOrigin) {
    const wrong = (body.match(HOSTED_IMG) || []).find(u => !u.startsWith(expectedOrigin + '/'))
    if (wrong) {
      return {
        code: 'cross_env',
        message: `This body references an image on another environment (${wrong}). Recompose the flyer with the environment you are sending from.`,
      }
    }
  }
  const { htmlBytes, textBytes, level } = newsletterSizeReport(html, text)
  if (level === 'over') {
    const over = htmlBytes >= NL_HTML_BLOCK_BYTES
      ? `The HTML body is ${Math.round(htmlBytes / 1024)}KB`
      : `The plain-text body is ${Math.round(textBytes / 1024)}KB`
    return {
      code: 'too_large',
      message: `${over}. Gmail clips messages over about 102KB, cutting off the unsubscribe footer — trim it before sending.`,
    }
  }
  if ((body + String(text || '')).includes('[Write your review or announcement here')) {
    return {
      code: 'placeholder',
      message: 'The poster block still has its placeholder text — replace it in the preview before sending.',
    }
  }
  return null
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
                   'letterboxd_uri', 'hostName', 'hostId', 'kind', 'time', 'ticketUrl',
                   'ticketed', 'admission']) {
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
const SPEAK_URL = 'https://jxnfilm.club/speak'
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
function eventBits(event, text) {
  const e = socialEventView(event) || {}
  const name = e.film || e.title || ''
  const titled = name + (e.year ? ` (${e.year})` : '')
  const when = fmtSocialDate(e.date) + (e.time ? ` · ${fmtShowtime(e.time)}` : '')
  const whenShort = fmtSocialDate(e.date, { short: true }) + (e.time ? ` · ${fmtShowtime(e.time)}` : '')
  const venue = e.venue || (e.hostId ? 'a member-hosted screening' : '')
  // Reworded image text (cardTextForCopy) wins, field by field. An empty
  // override is honoured too: a venue line removed from the image is removed
  // from the caption.
  const t = text && typeof text === 'object' ? text : {}
  const has = (k) => typeof t[k] === 'string'
  const outName = has('name') ? t.name : name
  const outYear = has('year') ? t.year : (e.year ? String(e.year) : '')
  return {
    e,
    name: outName,
    titled: outName + (outYear ? ` (${outYear})` : ''),
    when: has('when') ? t.when : when,
    whenShort: has('whenShort') ? t.whenShort : whenShort,
    venue: has('venue') ? t.venue : venue,
  }
}

// kind: announce | countdown | recap | roundup | diary | episode | voice | lineup | monthwrap | milestone
// platform: instagram | facebook | discord | bluesky | x
// data by kind:
//   announce/recap — { event, count?, text? } (count = attendance, recap only;
//                    text = reworded image lines from cardTextForCopy)
//   countdown      — { event, today? }        (today = YYYY-MM-DD anchor for tests)
//   roundup        — { films, total }         (from buildRoundupData)
//   diary          — { films, from, to, page, pageCount }  (one buildDiaryPages page)
//   episode        — { episode: { title, date?, url } }
//   voice          — { prompt: { id, text, deadline? } }  (config:voice_prompt)
//   lineup         — { events: [...] }        (upcoming, already sorted)
//   monthwrap      — { monthLabel, films: [names], screenings, attendees }
//   milestone      — { stat: members|screenings|attendance, value }
export function buildSocialCopy(kind, platform, data = {}) {
  if (kind === 'roundup') return roundupCopy(platform, data)
  if (kind === 'diary') return diaryCopy(platform, data)
  if (kind === 'episode') return episodeCopy(platform, data.episode || {})
  if (kind === 'voice') return voicePromptCopy(platform, data)
  if (kind === 'lineup') return lineupCopy(platform, data.events || [])
  if (kind === 'monthwrap') return monthwrapCopy(platform, data)
  if (kind === 'milestone') return milestoneCopy(platform, data)
  const { e, titled, when, whenShort, venue } = eventBits(data.event, data.text)
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

  // announce / countdown. The date and venue lines drop out when empty (a
  // line removed from the image is removed here), which never happens for an
  // event that has not been reworded.
  const where = venue ? `\n📍 ${venue}` : ''
  const details = (when ? `\n📅 ${when}` : '') + where
  const detailsShort = whenShort ? `\n📅 ${whenShort}${venue ? ` · ${venue}` : ''}` : where
  if (platform === 'instagram') {
    return `🎬 ${lead}\n\n${titled}${details}\n\nJoin us — RSVP at the link in bio.\n\n${IG_TAGS}`
  }
  if (platform === 'discord') {
    return `🎬 **${lead}: ${titled}**${details}\n\nRSVP: ${EVENTS_URL}${e.letterboxd_uri ? `\n${e.letterboxd_uri}` : ''}`
  }
  if (platform === 'bluesky' || platform === 'x') {
    return `🎬 ${lead}: ${titled}${detailsShort}\n\nRSVP: ${EVENTS_URL}`
  }
  // facebook
  return `🎬 ${lead}\n\n${titled}${details}\n\nJoin us — RSVP and details: ${EVENTS_URL}`
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

// Social copy for the current voice prompt — the podcast call-out, driven by
// whatever config:voice_prompt holds (or the generic default the site falls
// back to). The newsletter equivalent is buildVoiceCtaHtml above; this is the
// same invitation shaped for a social post rather than an email.
//
// The prompt TEXT is the payload, so it survives the per-platform truncation
// while the surrounding invitation gives way first — a post that trims the
// question is asking members to answer nothing.
function voicePromptCopy(platform, { prompt } = {}) {
  const text = String((prompt && prompt.text) || '').trim()
  const deadline = (prompt && prompt.deadline) || ''
  const by = deadline ? ` by ${fmtSocialDate(deadline)}` : ''
  const quoted = `\u201c${text}\u201d`

  if (platform === 'instagram') {
    return `\ud83c\udf99\ufe0f THIS ROUND'S PROMPT\n\n${quoted}\n\n` +
      `Record up to three minutes${by}. Link in bio.\n\n${IG_TAGS}`
  }
  if (platform === 'discord') {
    return `\ud83c\udf99\ufe0f **This round's prompt**\n> ${text}\n\n` +
      `Record or upload up to three minutes${by}.\n${SPEAK_URL}`
  }
  if (platform === 'bluesky' || platform === 'x') {
    const limit = PLATFORM_LIMITS[platform]
    // Shed the invitation before the question. If even the bare prompt plus
    // the link will not fit, the prompt itself is trimmed last.
    const forms = [
      `\ud83c\udf99\ufe0f This round's prompt: ${quoted}\n\nRecord up to three minutes${by}: ${SPEAK_URL}`,
      `\ud83c\udf99\ufe0f This round's prompt: ${quoted}\n\n${SPEAK_URL}`,
      `${quoted}\n\n${SPEAK_URL}`,
    ]
    const fits = forms.find(f => f.length <= limit)
    if (fits) return fits
    const room = limit - `\u201c\u2026\u201d\n\n${SPEAK_URL}`.length
    return `\u201c${text.slice(0, Math.max(0, room))}\u2026\u201d\n\n${SPEAK_URL}`
  }
  // facebook
  return `\ud83c\udf99\ufe0f This round's prompt: ${quoted}\n\n` +
    `Members can record or upload up to three minutes${by}.\n\n${SPEAK_URL}`
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

// --- Content Gen card wording ---
//
// Every line of text a card draws is a SLOT: an id, a field label, and a
// default TEMPLATE. Templates carry {tokens} for the parts that come from
// data ({date}, {countdown}, {films}), so the operator can reword a line and
// keep the live value in it. A countdown reworded on Monday must still count
// down on Tuesday, and a roundup saved this week must not quote this week's
// film count next week.
//
// Saved wording is `cardtext:<item>` in ATTENDANCE_KV: a flat map of slot
// store-key to template, holding ONLY the slots that differ from the default.
// An absent slot follows the default, so a later change to a default reaches
// every card that never reworded that line. An empty string is a real value:
// it removes the line.
//
// Which item a card saves under:
//   announce / countdown / recap  cardtext:event:<eventId>   (title, date,
//       venue and footer are shared by the three; each keeps its own eyebrow)
//   episode     cardtext:episode:<slug>     monthwrap  cardtext:monthwrap:<YYYY-MM>
//   milestone   cardtext:milestone:<stat>   voice      cardtext:voice:<promptId>
//   lineup / roundup / diary      cardtext:<kind>
// The no-film event poster (titlecard) has no slots: it mirrors
// .event-titlecard on the site and must keep saying what the site says.

export const CARD_TEXT_PREFIX = 'cardtext:'
export const CARD_TEXT_MAX = 160

const EVENT_TEXT_KINDS = new Set(['announce', 'countdown', 'recap'])
const textSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
const textSlugTail = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-80).replace(/^-+/, '')
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

export function cardTextKey(kind, data = {}) {
  const d = data || {}
  if (EVENT_TEXT_KINDS.has(kind)) return d.event && d.event.id ? `${CARD_TEXT_PREFIX}event:${d.event.id}` : null
  if (kind === 'episode') {
    const ep = d.episode || {}
    // The TAIL of the slug: episode URLs share a long host-and-show prefix,
    // and it is the end that tells one episode from the next.
    const slug = textSlugTail(ep.id || ep.url || `${ep.date || ''} ${ep.title || ''}`)
    return slug ? `${CARD_TEXT_PREFIX}episode:${slug}` : null
  }
  if (kind === 'monthwrap') return d.month ? `${CARD_TEXT_PREFIX}monthwrap:${d.month}` : null
  if (kind === 'milestone') return `${CARD_TEXT_PREFIX}milestone:${MILESTONE_WORDS[d.stat] ? d.stat : 'members'}`
  if (kind === 'voice') return `${CARD_TEXT_PREFIX}voice:${textSlug((d.prompt || {}).id) || 'general'}`
  if (kind === 'lineup' || kind === 'roundup' || kind === 'diary') return `${CARD_TEXT_PREFIX}${kind}`
  return null
}

const MILESTONE_WORDS = {
  members: ['MEMBERS', 'STRONG'],
  screenings: ['SCREENINGS', 'AND COUNTING'],
  attendance: ['SEATS', 'FILLED'],
}

// Token values for a card. `short` gives the abbreviated date the short-form
// captions use, so one reworded template serves the image and every caption.
export function cardTextValues(kind, data = {}, { short = false } = {}) {
  const d = data || {}
  if (EVENT_TEXT_KINDS.has(kind)) {
    const e = socialEventView(d.event) || {}
    const count = Number(d.count) || 0
    return {
      title: e.film || e.title || 'Untitled',
      year: e.year ? String(e.year) : '',
      date: fmtSocialDate(e.date, { short }),
      time: e.time ? fmtShowtime(e.time) : '',
      venue: e.venue || (e.hostId ? 'Member-hosted screening' : ''),
      countdown: countdownLead(daysUntil(e.date, d.today)),
      count: count > 0 ? String(count) : '',
    }
  }
  if (kind === 'episode') {
    const ep = d.episode || {}
    return { title: ep.title || 'New episode', date: ep.date ? fmtSocialDate(ep.date, { short }) : '' }
  }
  if (kind === 'monthwrap') {
    const s = Number(d.screenings) || 0
    const a = Number(d.attendees) || 0
    return {
      month: d.monthLabel || '',
      screenings: plural(s, 'screening', 'screenings'),
      attendees: a > 0 ? plural(a, 'attendee', 'attendees') : '',
    }
  }
  if (kind === 'roundup') return { films: plural(Number(d.total) || 0, 'film', 'films') }
  if (kind === 'diary') {
    return { range: fmtDiaryRange(d.from, d.to), page: `Page ${d.page || 1} of ${d.pageCount || 1}` }
  }
  if (kind === 'voice') {
    const p = d.prompt || {}
    return { deadline: p.deadline ? fmtSocialDate(p.deadline, { short: true }) : '' }
  }
  if (kind === 'milestone') return { value: String(Number(d.value) || 0) }
  return {}
}

// The slots a card has for this data, in the order the fields are shown.
// `store` is the key inside the saved map; it differs from `id` where cards
// that share one saved item must not share a line.
export function cardTextSlots(kind, data = {}) {
  const d = data || {}
  const v = cardTextValues(kind, d)
  const slot = (id, label, def, extra = {}) => ({ id, store: id, label, def, ...extra })
  const BRAND_NAME = 'Jackson Film Club'
  const extra = (store = 'extra') => slot('extra', 'Extra line', '', { store, hint: 'Optional, e.g. Free with RSVP' })

  if (kind === 'announce' || kind === 'countdown') {
    return [
      slot('eyebrow', 'Eyebrow', kind === 'countdown' ? `${BRAND_NAME} · {countdown}` : `${BRAND_NAME} · Next screening`,
        { store: `${kind}.eyebrow` }),
      slot('title', 'Title', '{title}', { copy: true, multiline: true }),
      slot('year', 'Year', '{year}', { copy: true }),
      slot('when', 'Date line', v.time ? '{date} · {time}' : '{date}', { copy: true }),
      slot('venue', 'Venue line', '{venue}', { copy: true }),
      extra(),
      slot('footer', 'Footer', 'jxnfilm.club/events'),
    ]
  }
  if (kind === 'recap') {
    return [
      slot('eyebrow', 'Eyebrow', `${BRAND_NAME} · That's a wrap`, { store: 'recap.eyebrow' }),
      ...(v.count
        ? [slot('unit1', 'Beside the count, line 1', 'OF US', { store: 'recap.unit1' }),
           slot('unit2', 'Beside the count, line 2', 'WATCHED', { store: 'recap.unit2' })]
        : [slot('lead', 'Lead-in', 'WE WATCHED', { store: 'recap.lead' })]),
      slot('title', 'Title', '{title}', { copy: true, multiline: true }),
      slot('year', 'Year', '{year}', { copy: true }),
      extra('recap.extra'),
      slot('footer', 'Footer', 'jxnfilm.club/events'),
    ]
  }
  if (kind === 'lineup') {
    return [
      slot('eyebrow', 'Eyebrow', BRAND_NAME),
      slot('heading', 'Heading', 'Coming up at the club'),
      extra(),
      slot('footer', 'Footer', 'jxnfilm.club/events'),
    ]
  }
  if (kind === 'roundup') {
    return [
      slot('eyebrow', 'Eyebrow', BRAND_NAME),
      slot('heading', 'Heading', 'What the club is watching'),
      slot('sub', 'Count line', '{films} logged by members in the last week'),
      extra(),
      slot('footer', 'Footer', 'jxnfilm.club/watched'),
    ]
  }
  if (kind === 'monthwrap') {
    return [
      slot('eyebrow', 'Eyebrow', BRAND_NAME),
      slot('heading', 'Heading', 'That was {month}'),
      slot('sub', 'Stats line', v.attendees ? '{screenings} · {attendees}' : '{screenings}'),
      extra(),
      slot('footer', 'Footer', 'jxnfilm.club/events'),
    ]
  }
  if (kind === 'diary') {
    return [
      slot('eyebrow', 'Eyebrow', BRAND_NAME),
      slot('heading', 'Heading', 'From the club diary'),
      slot('meta', 'Range line', v.range ? '{range} · {page}' : '{page}'),
      slot('footer', 'Footer', 'jxnfilm.club/watched'),
    ]
  }
  if (kind === 'voice') {
    return [
      slot('eyebrow', 'Eyebrow', `${BRAND_NAME} · Podcast`),
      slot('sub', 'Invitation', v.deadline ? 'Record or upload up to three minutes by {deadline}.' : 'Record or upload up to three minutes.'),
      extra(),
      slot('footer', 'Footer', 'jxnfilm.club/speak'),
    ]
  }
  if (kind === 'milestone') {
    const units = MILESTONE_WORDS[d.stat] || MILESTONE_WORDS.members
    return [
      slot('eyebrow', 'Eyebrow', `${BRAND_NAME} · Milestone`),
      slot('unit1', 'Beside the number, line 1', units[0]),
      slot('unit2', 'Beside the number, line 2', units[1]),
      slot('thanks', 'Closing line', 'Thank you, Jackson.'),
      slot('footer', 'Footer', 'jxnfilm.club'),
    ]
  }
  if (kind === 'episode') {
    return [
      slot('eyebrow', 'Eyebrow', `${BRAND_NAME} · New podcast episode`),
      slot('title', 'Title', '{title}', { multiline: true }),
      slot('date', 'Date line', '{date}'),
      slot('cta', 'Call to action', 'LISTEN WHEREVER YOU GET PODCASTS'),
      extra(),
      slot('footer', 'Footer', 'jxnfilm.club'),
    ]
  }
  return []
}

// One line of card text: no control characters or line breaks, capped. A
// `multiline` slot (a title) keeps the operator's own line breaks, up to
// CARD_TEXT_MAX_BREAKS of them; any further ones become spaces.
export const CARD_TEXT_MAX_BREAKS = 3
export function cleanCardText(s, { multiline = false } = {}) {
  let out = String(s ?? '').replace(/\r\n?/g, '\n')
  if (!multiline) out = out.replace(/\n+/g, ' ')
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
  if (multiline) {
    let seen = 0
    out = out.replace(/\n+/g, () => (++seen <= CARD_TEXT_MAX_BREAKS ? '\n' : ' '))
  }
  return out.slice(0, CARD_TEXT_MAX)
}

// A saved row as read from KV -> a flat map of strings. Anything else (a
// number, a nested object, a hand-edited row) is dropped rather than drawn.
export function normalizeCardText(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, val] of Object.entries(raw)) {
    // Line breaks are kept here and dropped per slot at resolve time, since
    // only the slot table knows which lines may carry them.
    if (typeof val === 'string' && /^[a-z0-9.]{1,40}$/.test(k)) out[k] = cleanCardText(val, { multiline: true })
  }
  return out
}

// Substitute {tokens}. An unknown token is left as typed, so a brace the
// operator meant literally survives. A token that resolved to nothing can
// strand its separator ("June 12 · "), so separators left dangling at either
// end, or doubled up in the middle, are tidied away.
export function fillCardText(template, values = {}) {
  let emptied = false
  const s = String(template ?? '').replace(/\{([a-z]+)\}/g, (m, name) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return m
    const val = String(values[name] ?? '')
    if (!val) emptied = true
    return val
  })
  if (!emptied) return s.trim()
  return s
    .replace(/([^\S\n]*[·|—–-][^\S\n]*){2,}/g, ' · ')
    .replace(/^[\s·|—–,-]+|[\s·|—–,-]+$/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim()
}

// The card's text, resolved. `text` is what the canvas draws (slot id ->
// final string); `slots` adds, per slot, the template in effect and whether
// it has been reworded, for the editor.
export function resolveCardText(kind, data, saved, opts) {
  const map = normalizeCardText(saved)
  const values = cardTextValues(kind, data, opts)
  const text = {}
  const slots = cardTextSlots(kind, data).map(s => {
    const edited = Object.prototype.hasOwnProperty.call(map, s.store) && map[s.store] !== s.def
    const template = edited ? cleanCardText(map[s.store], { multiline: !!s.multiline }) : s.def
    text[s.id] = fillCardText(template, values)
    return { ...s, template, edited }
  })
  return { text, slots, tokens: Object.keys(values) }
}

// A saved map with one slot set. Typing a line back to its default removes it
// from the map (it follows the default again); the result may be empty, which
// the caller turns into a KV delete.
export function setCardText(saved, slot, value) {
  const next = { ...normalizeCardText(saved) }
  const val = cleanCardText(value, { multiline: !!slot.multiline })
  if (val === slot.def) delete next[slot.store]
  else next[slot.store] = val
  return next
}

// A saved map with every slot of THIS card cleared. Lines belonging to the
// other cards that share the item (a recap's eyebrow, when resetting the
// announcement) are left alone unless they are the shared ones.
export function clearCardText(saved, slots) {
  const next = { ...normalizeCardText(saved) }
  for (const s of slots) delete next[s.store]
  return next
}

// What the captions take from reworded image text: only the event's title,
// year, date line and venue, and only where they were actually reworded, so
// an untouched card's captions read exactly as before. `whenShort` resolves
// the same template against the abbreviated date.
export function cardTextForCopy(kind, data, saved) {
  if (!EVENT_TEXT_KINDS.has(kind)) return null
  const long = resolveCardText(kind, data, saved)
  const short = resolveCardText(kind, data, saved, { short: true })
  const out = {}
  // Slots the card itself does not show (a recap has no date line) still
  // follow the event's shared wording.
  const map = normalizeCardText(saved)
  const values = cardTextValues(kind, data)
  const shortValues = cardTextValues(kind, data, { short: true })
  const shared = { title: '{title}', year: '{year}', venue: '{venue}', when: values.time ? '{date} · {time}' : '{date}' }
  for (const id of Object.keys(shared)) {
    const slot = long.slots.find(s => s.id === id)
    const edited = slot ? slot.edited
      : Object.prototype.hasOwnProperty.call(map, id) && map[id] !== shared[id]
    if (!edited) continue
    const tpl = slot ? slot.template : map[id]
    if (id === 'when') {
      out.when = fillCardText(tpl, values)
      out.whenShort = slot ? short.text.when : fillCardText(tpl, shortValues)
    } else out[id === 'title' ? 'name' : id] = fillCardText(tpl, values)
  }
  // A caption is running text: the title's line breaks are for the image.
  for (const k of Object.keys(out)) out[k] = out[k].replace(/\s*\n\s*/g, ' ')
  return Object.keys(out).length ? out : null
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

// --- Map venues (config:venues; docs/features/map.md) ---

// MIRRORS venueKey() in worker/src/venues.js, which decides what the public
// map pins. Here it only powers the unmatched-names hint, but a drift would
// make that hint lie. Guarded by tests/admin/venues-sync.test.js.
export function venueKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/theatre/g, 'theater')
    .replace(/^[^a-z0-9]*the\s+/, '')
    .replace(/[^a-z0-9]+/g, '')
}

// Parse a pasted "lat, lng" pair, the form a map app copies to the
// clipboard. Returns { lat, lng } or null.
export function parseCoords(text) {
  const m = String(text || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/)
  if (!m) return null
  const lat = Number(m[1]), lng = Number(m[2])
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

// Editor rows ({ name, address, coords, aliases } as typed) → the stored
// config:venues list, plus one message per problem. Blank rows are skipped.
// Stores only what the Worker's validVenueList() accepts, so a save can never
// silently void the whole list and drop the map back to its defaults.
export function buildVenueList(rows) {
  const venues = []
  const errors = []
  ;(Array.isArray(rows) ? rows : []).forEach((r, i) => {
    const name = String(r?.name ?? '').trim()
    const address = String(r?.address ?? '').trim()
    const coordsText = String(r?.coords ?? '').trim()
    const aliases = String(r?.aliases ?? '').split(/[\n;]/).map(s => s.trim()).filter(Boolean)
    if (!name && !address && !coordsText && !aliases.length) return
    const label = name || `row ${i + 1}`
    if (!name) errors.push(`${label}: name is required`)
    if (name.length > 200 || address.length > 200) errors.push(`${label}: name and address must be 200 characters or fewer`)
    const coords = parseCoords(coordsText)
    if (!coords) errors.push(`${label}: coordinates must be "lat, lng", e.g. 32.33554, -90.17678`)
    if (aliases.length > 20 || aliases.some(a => a.length > 200)) errors.push(`${label}: at most 20 aliases of 200 characters each`)
    if (name && coords) venues.push({ name, address, lat: coords.lat, lng: coords.lng, aliases })
  })
  if (!errors.length && !venues.length) errors.push('Add at least one venue, or use reset to fall back to the defaults')
  if (venues.length > 100) errors.push('At most 100 venues')
  return { venues, errors }
}

// Venue names used by public events that no map venue (name or alias)
// matches, most used first. These events are missing from the map. House
// screenings are skipped: they are never pinned, so listing them would only
// invite someone to alias a member's home onto a public map. The curated
// history predates the kind field, so its home screenings are recognized by
// name instead (they all end in house, apartment or home).
const HOME_VENUE_RE = /\b(house|apartment|home)$/i
export function unmatchedVenueNames(events, venues) {
  const known = new Set()
  for (const v of venues || []) {
    for (const label of [v.name, ...(v.aliases || [])]) known.add(venueKey(label))
  }
  const counts = new Map()
  for (const e of events || []) {
    if (!e || !e.venue) continue
    if (e.kind === 'house' || (!e.kind && e.hostId)) continue
    if (HOME_VENUE_RE.test(e.venue.trim())) continue
    if (known.has(venueKey(e.venue))) continue
    counts.set(e.venue, (counts.get(e.venue) || 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
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
// A free-form message carries a server-minted promptId of its own, so grouping
// by promptId would turn five messages into five one-clip "rounds" and bury the
// actual round in the noise. They collapse into one synthetic Messages group
// instead — the inbox they are — sorted newest-first and pinned just under the
// current round.
//
// The group is marked `messages: true` rather than detected by id prefix at
// every call site, and it carries no publishable promptId, because publication
// is round-scoped (config:voice_published) and a message belongs to no round.
export const VOICE_MESSAGES_GROUP = 'Messages'

export function isVoiceMessage(row) {
  return !!row && row.kind === 'message'
}

export function groupVoiceClips(rows, currentPromptId) {
  const groups = new Map()
  let messages = null
  for (const r of rows || []) {
    if (!r || !r.promptId) continue
    if (isVoiceMessage(r)) {
      if (!messages) messages = { promptId: '', promptText: VOICE_MESSAGES_GROUP, messages: true, clips: [] }
      messages.clips.push(r)
      continue
    }
    if (!groups.has(r.promptId)) {
      groups.set(r.promptId, { promptId: r.promptId, promptText: '', clips: [] })
    }
    const g = groups.get(r.promptId)
    if (!g.promptText && r.promptText) g.promptText = r.promptText
    g.clips.push(r)
  }
  const all = [...groups.values()]
  if (messages) all.push(messages)
  for (const g of all) {
    g.clips.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  }
  const newest = (g) => String(g.clips[0]?.at || '')
  const rank = (g) => (g.messages ? 1 : (g.promptId === currentPromptId ? 2 : 0))
  return all.sort((a, b) => {
    const r = rank(b) - rank(a)
    return r !== 0 ? r : newest(b).localeCompare(newest(a))
  })
}

// Normalize the config:voice_prompt form into its stored shape
// ({ id, text, deadline? }) — id is slugified, text trimmed, deadline must
// be a bare YYYY-MM-DD when present. Returns null when the result would be
// unusable (no id/text survives, or a malformed deadline) so the caller can
// refuse the save instead of storing junk.
export function sanitizeVoicePrompt(fields) {
  const src = fields || {}
  const raw = String(src.id ?? '').toLowerCase().trim()
  // msg_ is reserved for members' free-form messages (worker: isMessageId).
  // Checked on the RAW input, not the slug: the slugifier would quietly turn
  // msg_spring into msg-spring, and an operator who typed one thing and got
  // another is worse off than one who was told no.
  if (/^msg_/.test(raw)) return null
  const id = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
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

// --- Review badge counts (the Voice / Feedback pills on the tab strip) ---
//
// "Needs review" is derived, never stored. A voice clip is pending until it
// is approved or rejected; a feedback row exists until it is deleted
// ("delete = handled"). Nothing records what an operator has already looked
// at, on purpose — a seen-marker would live in one browser's localStorage
// and would quietly clear the badge on items nobody actually dealt with.
//
// Both helpers mirror the filter their tab renders with, so the badge and
// the heading count can never disagree.

// Voice rows ({ keyName, ...value }) still awaiting moderation. Anything
// that isn't approved/rejected counts — including a row with no status at
// all, which is exactly what voiceStatusPill renders as "pending".
export function countPendingVoice(rows) {
  return (rows || []).filter(r =>
    r && r.promptId && r.r2Key && r.status !== 'approved' && r.status !== 'rejected'
  ).length
}

// Open feedback = every row the tab would render. Counted off the parsed
// values rather than the raw key list so an unparseable row (which the tab
// drops) doesn't inflate the badge.
export function countOpenFeedback(keys, values) {
  return (keys || []).filter(k => k && tryParse((values || {})[k.name])).length
}

// --- Events: RSVP mode + write-time sanitation -----------------------------

// Does this event collect RSVPs, or take the post-hoc "I was there" toggle?
// The two are mutually exclusive: when RSVPs are on the attendee list IS the
// confirmed list, so offering both gives one event two sources of truth.
//
// Precedence, and why:
//  1. An explicit `rsvp` boolean wins.
//
// A `ticketUrl` used to short-circuit this to false; that is now carried by
// copy rather than structure. The Events tab stamps `rsvp: true` on
//     every event it creates, which is what makes "on by default" true for
//     new club events without making ABSENCE mean on.
//  2. Otherwise fall back to `hostId` — member-hosted screenings have always
//     taken RSVPs, the curated rows have always taken attendance, and neither
//     carries an `rsvp` field.
//
// MIRRORED in worker/src/index.js and model/index.ts — keep all three in
// lockstep (see docs/features/hosting.md).
export function rsvpEnabled(e) {
  if (!e) return false
  if (typeof e.rsvp === 'boolean') return e.rsvp
  return !!e.hostId
}

// How people get in: 'free' | 'ticketed' | 'own', or '' when nobody has said.
// Rows that predate `admission` fall back to the `ticketed` flag, then to
// "a meetup is self-organized". 'free' is never derived.
//
// MIRRORED in worker/src/event-visibility.js and model/index.ts — all three
// run against tests/fixtures/admission-cases.json.
export const ADMISSIONS = ['free', 'ticketed', 'own']
export const ADMISSION_LABELS = { free: 'Free', ticketed: 'Ticketed', own: 'Buy your own' }
export function eventAdmission(e) {
  if (!e) return ''
  if (ADMISSIONS.includes(e.admission)) return e.admission
  if (e.ticketed) return 'ticketed'
  return e.kind === 'meetup' ? 'own' : ''
}

// Coerce the one thing the Worker cannot see: a form checkbox.
//
// An unchecked checkbox is absent from a scrape and a checked one yields the
// string "on", so a row that stored "on" would read truthy forever but never
// equal true. Everything else an admin can type — the https rule, the kind
// allowlist, the house-screening admission rule — is validated Worker-side by
// validAdminEvent(), which is the authority. Duplicating those checks here
// only re-creates the failure this function exists to prevent: a value the
// client silently drops, so the operator never sees the error.
//
// Empty strings are passed through deliberately. A PUT merges over the stored
// row, so '' is how the dashboard says "clear this field".
export function sanitizeAdminEvent(row) {
  const out = { ...(row || {}) }
  for (const k of ['rsvp', 'ticketed']) {
    if (out[k] === undefined || out[k] === null || out[k] === '') delete out[k]
    else out[k] = out[k] === true || out[k] === 'on' || out[k] === 'true'
  }
  return out
}

// Event id from the date plus the film (or the title, when there is no film).
//
// Mirrors slugifyForId() in worker/src/index.js, which is what stamps ids for
// member-hosted screenings — and matches the convention the 42 curated rows
// already follow (2021-01-13-whiplash, 2023-08-25-bar-snakes). The create
// form derives this as you type and lets it be overridden, because two events
// can legitimately share a date and a film.
//
// Returns '' when there is not enough to build one, so the form can say so
// rather than offering a slug like "2026-10-22-".
export function eventIdFrom(date, name) {
  const d = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(date || '')) ? date : ''
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  if (!d || !slug) return ''
  return `${d}-${slug}`
}

// What is wrong with this event, in the order an operator should fix it.
// The Worker's validAdminEvent() is the authority and rejects the same shapes
// — this exists so the form can refuse before writing anything, rather than
// surfacing a 400 after the fact.
//
// One checker for both modes. A NEW event must also have a free id and an
// answer to "how do people get in" — that question is the whole reason old
// rows are unlabelled, so a new one does not get to skip it. An EDIT checks
// neither: its id is fixed, and a legacy row may stay unanswered.
function eventIssues(row, { create, existingIds = [] }) {
  const out = []
  const s = (k) => String((row || {})[k] ?? '').trim()
  if (!s('title')) out.push('Title is required.')
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s('date'))) out.push('Date is required (YYYY-MM-DD).')
  if (create) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s('id'))) {
      out.push('ID must be lowercase letters, numbers and hyphens.')
    } else if ((existingIds || []).includes(s('id'))) {
      out.push(`An event with the id "${s('id')}" already exists.`)
    }
    if (!ADMISSIONS.includes(s('admission'))) out.push('Choose an admission: Free, Ticketed or Buy your own.')
  } else if (s('admission') && !ADMISSIONS.includes(s('admission'))) {
    out.push('Unknown admission.')
  }
  if (s('year') && !/^[0-9]{4}$/.test(s('year'))) out.push('Year must be four digits.')
  if (s('time') && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s('time'))) out.push('Time must be HH:MM.')
  if (s('capacity') && !/^[1-9][0-9]*$/.test(s('capacity'))) out.push('Capacity must be a whole number, 1 or more.')
  for (const [k, label] of [['poster', 'Poster URL'], ['ticketUrl', 'Ticket link'], ['letterboxd_uri', 'Letterboxd URI']]) {
    if (s(k) && !/^https:\/\/\S+$/.test(s(k))) out.push(`${label} must be an https link.`)
  }
  if (s('letterboxd_uri') && !/^https:\/\/(www\.)?(letterboxd\.com|boxd\.it)\//.test(s('letterboxd_uri'))) {
    out.push('Letterboxd URI must be a letterboxd.com or boxd.it link.')
  }
  if (s('kind') && !['house', 'meetup', 'social'].includes(s('kind'))) out.push('Unknown kind.')
  // Mirrors the Worker: nobody sells tickets to a living room.
  if (s('kind') === 'house' && ['ticketed', 'own'].includes(s('admission'))) {
    out.push('A house screening cannot be ticketed — choose Free.')
  }
  return out
}
export const newEventIssues = (row, existingIds = []) => eventIssues(row, { create: true, existingIds })
export const editEventIssues = (row) => eventIssues(row, { create: false })

// --- Events tab: list + shared form helpers (pure; tested in tests/admin) ---

// Dates are YYYY-MM-DD strings — compared as strings, never as Dates (parsing
// them as UTC instants shifts them a day in America/Chicago). Same-day events
// order by start time; a missing time sorts first in its day.
const eventWhenKey = (e) => String((e && e.date) || '') + 'T' + String((e && e.time) || '')

// Upcoming soonest-first, then past newest-first. Undated rows fall into the
// past group, at the bottom. `today` is a Central YYYY-MM-DD.
export function groupEvents(events, today) {
  const list = (events || []).filter(Boolean)
  const upcoming = list.filter(e => String(e.date || '') >= today)
    .sort((a, b) => eventWhenKey(a).localeCompare(eventWhenKey(b)))
  // !a.date - !b.date first: a bare 'T' key would otherwise sort ABOVE every
  // real date in descending order.
  const past = list.filter(e => String(e.date || '') < today)
    .sort((a, b) => (!a.date - !b.date) || eventWhenKey(b).localeCompare(eventWhenKey(a)))
  return { upcoming, past }
}

// What the search box matches against, lowercased.
export function eventSearchText(e) {
  if (!e) return ''
  return [e.title, e.film, e.venue, e.id, e.date, e.hostName, e.kind]
    .filter(Boolean).join(' ').toLowerCase()
}

// The fields the shared event form edits as text. `rsvp` and `admission` are
// handled apart from these because neither is a plain stored string: rsvp has
// a fallback (rsvpEnabled) and admission has a "not set" state.
export const EVENT_TEXT_FIELDS = ['title', 'film', 'year', 'date', 'time', 'venue', 'kind',
  'capacity', 'ticketUrl', 'address', 'notes', 'poster', 'letterboxd_uri']
const EVENT_NUMBER_FIELDS = ['year', 'capacity']

// A stored row as the form shows it: every text field a string, rsvp as the
// EFFECTIVE boolean, admission as the STORED value ('' when never answered).
export function eventFormValues(e) {
  const out = {}
  for (const f of EVENT_TEXT_FIELDS) out[f] = e && e[f] != null ? String(e[f]) : ''
  out.rsvp = rsvpEnabled(e)
  out.admission = e && ADMISSIONS.includes(e.admission) ? e.admission : ''
  return out
}

// The body of the PUT. The Worker merges a PUT over the stored row, so an edit
// sends ONLY what changed, with '' meaning "clear this".
//
// That is what keeps absent absent. The old form scraped every input on every
// save, so opening a 2021 row to fix a typo stamped `rsvp: false` and
// `ticketed: false` onto it. Here an untouched RSVP box is compared against
// what the row already MEANT (rsvpEnabled), an untouched admission against
// what it STORED, and `ticketed` is never sent at all — the Worker derives it
// from admission.
//
// A field missing from `values` (undefined) was not on the form, and is left
// alone. A create sends everything that has a value.
export function eventPutDiff(before, values, { create = false } = {}) {
  const v = values || {}
  const out = {}
  const typed = (f, s) => (EVENT_NUMBER_FIELDS.includes(f) ? Number(s) : s)
  if (create) {
    for (const f of EVENT_TEXT_FIELDS) {
      const s = v[f] == null ? '' : String(v[f]).trim()
      if (s) out[f] = typed(f, s)
    }
    out.rsvp = !!v.rsvp
    if (ADMISSIONS.includes(v.admission)) out.admission = v.admission
    return out
  }
  const was = eventFormValues(before)
  for (const f of EVENT_TEXT_FIELDS) {
    if (v[f] === undefined) continue
    const s = String(v[f]).trim()
    if (s !== was[f]) out[f] = s === '' ? '' : typed(f, s)
  }
  if (typeof v.rsvp === 'boolean' && v.rsvp !== was.rsvp) out.rsvp = v.rsvp
  if (v.admission !== undefined && v.admission !== was.admission) out.admission = v.admission
  return out
}

// What a save leaves in the local cache, before the Worker's reply is merged
// over it: the diff applied to the stored row, with cleared fields removed.
export function applyEventDiff(before, diff) {
  const out = { ...(before || {}) }
  for (const [k, val] of Object.entries(diff || {})) {
    if (val === '' || val === null) delete out[k]
    else out[k] = val
  }
  return out
}

// Starting values for "duplicate this event". An explicit allowlist, because
// the default for a new field must be NOT copied: the private address and
// notes, the host, the box-office link (it is for the other screening) and
// every RSVP stay behind. The date is blank on purpose — a copy that keeps
// its date is the mistake this button would otherwise invite.
//
// Admission and RSVP carry over as what the source row MEANT, so duplicating
// a legacy meetup gives a new event that already answers the question.
export function duplicateSeed(e) {
  const src = e || {}
  const out = eventFormValues({})
  for (const f of ['title', 'film', 'year', 'venue', 'kind', 'time', 'capacity', 'poster', 'letterboxd_uri']) {
    if (src[f] != null) out[f] = String(src[f])
  }
  out.rsvp = rsvpEnabled(src)
  out.admission = eventAdmission(src)
  // A copied house row would otherwise carry an admission the Worker rejects.
  if (out.kind === 'house') out.admission = 'free'
  return out
}

// --- QR code (print flyer) ---
//
// A small encoder for the one job the flyer has: a URL, byte mode, error
// correction level M, versions 1-9 (up to 180 bytes). Written here rather
// than vendored because admin files are served unbundled and every new file
// needs four registrations. tests/admin/qr.test.js decodes its output with an
// independent decoder, which is the only proof a QR code is worth anything.

// [ec codewords per block, [blocks, data codewords]...] per version, level M.
const QR_BLOCKS = [null,
  [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
  [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]],
]
const QR_ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46]]

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) {
  GF_EXP[i] = x
  GF_LOG[x] = i
  x <<= 1
  if (x & 0x100) x ^= 0x11d
}
for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
const gfMul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0)

// Reed-Solomon remainder of `data` for `n` error-correction codewords.
function rsRemainder(data, n) {
  let gen = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array(gen.length + 1).fill(0)
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j]
      next[j + 1] ^= gfMul(gen[j], GF_EXP[i])
    }
    gen = next
  }
  const rem = new Array(n).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem.shift()
    rem.push(0)
    for (let j = 0; j < n; j++) rem[j] ^= gfMul(gen[j + 1], factor)
  }
  return rem
}

// BCH remainder used by the format (15,5) and version (18,6) information.
function bch(value, poly, bits) {
  const top = 31 - Math.clz32(poly)
  let v = value << top
  for (let i = bits - 1; i >= top; i--) if ((v >>> i) & 1) v ^= poly << (i - top)
  return (value << top) | v
}

const QR_MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

function qrPenalty(m) {
  const n = m.length
  let score = 0, dark = 0
  const line = (get) => {
    for (let i = 0; i < n; i++) {
      let run = 1
      for (let j = 1; j <= n; j++) {
        if (j < n && get(i, j) === get(i, j - 1)) run++
        else { if (run >= 5) score += run - 2; run = 1 }
      }
      for (let j = 0; j + 10 < n; j++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(i, j + k) ? 1 : 0)).join('')
        if (s === '10111010000' || s === '00001011101') score += 40
      }
    }
  }
  line((i, j) => m[i][j])
  line((i, j) => m[j][i])
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) dark++
      if (r + 1 < n && c + 1 < n && m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3
    }
  }
  return score + Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10
}

// Encodes `text` as a QR code. Returns a square array of rows of booleans
// (true = dark module), without the quiet zone, or null when the text is too
// long for the versions supported here.
export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text)))
  let version = 0, dataLen = 0
  for (let v = 1; v < QR_BLOCKS.length; v++) {
    const [, ...groups] = QR_BLOCKS[v]
    const cap = groups.reduce((a, [count, len]) => a + count * len, 0)
    if (bytes.length + 2 <= cap) { version = v; dataLen = cap; break }
  }
  if (!version) return null

  // Bit stream: byte mode, 8-bit count, data, terminator, pad to capacity.
  const bits = []
  const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  push(0b0100, 4)
  push(bytes.length, 8)
  for (const b of bytes) push(b, 8)
  push(0, Math.min(4, dataLen * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  for (let pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad)

  // Split into blocks, add error correction, interleave.
  const [ecLen, ...groups] = QR_BLOCKS[version]
  const blocks = []
  let at = 0
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(at, at + len)
      at += len
      blocks.push({ d, e: rsRemainder(d, ecLen) })
    }
  }
  const codewords = []
  const longest = Math.max(...blocks.map(b => b.d.length))
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.d.length) codewords.push(b.d[i])
  for (let i = 0; i < ecLen; i++) for (const b of blocks) codewords.push(b.e[i])

  const n = version * 4 + 17
  const m = Array.from({ length: n }, () => new Array(n).fill(false))
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false))
  const set = (r, c, dark) => { if (r >= 0 && r < n && c >= 0 && c < n) { m[r][c] = dark; fixed[r][c] = true } }

  // Finder patterns with their separators.
  for (const [fr, fc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
        set(fr + r, fc + c, ring !== 2 && ring <= 3)
      }
    }
  }
  // Alignment patterns, skipping the three that would land on a finder.
  const centres = QR_ALIGN[version]
  for (const r of centres) {
    for (const c of centres) {
      if (fixed[r][c]) continue
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
    }
  }
  // Timing patterns.
  for (let i = 8; i < n - 8; i++) {
    if (!fixed[6][i]) set(6, i, i % 2 === 0)
    if (!fixed[i][6]) set(i, 6, i % 2 === 0)
  }
  // Reserve the format areas and the dark module; version info from v7.
  for (let i = 0; i < 9; i++) { if (!fixed[8][i]) set(8, i, false); if (!fixed[i][8]) set(i, 8, false) }
  for (let i = 0; i < 8; i++) { set(8, n - 1 - i, false); set(n - 1 - i, 8, false) }
  set(n - 8, 8, true)
  if (version >= 7) {
    const info = bch(version, 0x1f25, 18)
    for (let i = 0; i < 18; i++) {
      const dark = ((info >>> i) & 1) === 1
      set(Math.floor(i / 3), n - 11 + (i % 3), dark)
      set(n - 11 + (i % 3), Math.floor(i / 3), dark)
    }
  }

  // Data, zig-zagging up and down in two-module columns from the right.
  const stream = []
  for (const cw of codewords) for (let i = 7; i >= 0; i--) stream.push((cw >>> i) & 1)
  let k = 0
  for (let right = n - 1, up = true; right > 0; right -= 2, up = !up) {
    if (right === 6) right = 5
    for (let i = 0; i < n; i++) {
      const r = up ? n - 1 - i : i
      for (const c of [right, right - 1]) {
        if (fixed[r][c]) continue
        m[r][c] = k < stream.length ? stream[k] === 1 : false
        k++
      }
    }
  }

  // Try every mask and keep the one that scores best.
  let best = null
  for (let mask = 0; mask < 8; mask++) {
    const out = m.map((row, r) => row.map((dark, c) => (fixed[r][c] ? dark : dark !== QR_MASKS[mask](r, c))))
    const format = bch(mask, 0x537, 15) ^ 0x5412   // level M is 00, so the data is just the mask
    for (let i = 0; i < 15; i++) {
      const dark = ((format >>> i) & 1) === 1
      // Around the top-left finder...
      if (i < 6) out[i][8] = dark
      else if (i < 8) out[i + 1][8] = dark
      else if (i === 8) out[8][7] = dark
      else out[8][14 - i] = dark
      // ...and split between the other two.
      if (i < 8) out[8][n - 1 - i] = dark
      else out[n - 15 + i][8] = dark
    }
    const score = qrPenalty(out)
    if (!best || score < best.score) best = { score, out }
  }
  return best.out
}

// The page a flyer's QR code opens, or '' when the event has no public page
// (a house screening is never advertised to the open internet).
export function flyerEventUrl(event) {
  if (!event || !event.id) return ''
  if (event.kind === 'house' || (!event.kind && event.hostId)) return ''
  return `https://jxnfilm.club/events?event=${encodeURIComponent(event.id)}`
}
