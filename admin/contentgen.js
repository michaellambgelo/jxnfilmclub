// Content Gen tab — social media copy + downloadable PNG cards, generated
// from live KV data (events, attendance counts, member Letterboxd watches).
//
// Privacy: everything rendered here is destined for PUBLIC social posts.
// Events flow through socialEventView() (no address/notes/capacity) and
// member watches through buildRoundupData() (no names or handles) — both
// enforced in lib.js, not here. Attendance contributes a count only.
//
// Rendering is hand-rolled canvas (the admin SPA is buildless). Poster
// images load through the same-origin /api/img proxy so the canvas is never
// CORS-tainted; brand fonts load cross-origin from jxnfilm.club (GitHub
// Pages sends ACAO) via the FontFace API, with serif/sans fallbacks.

import {
  escapeHtml, attr, tryParse, qs,
  socialEventView, buildSocialCopy, buildRoundupData, socialFileName,
  fmtSocialDate, fmtShowtime, fmtMonth, daysUntil, countdownLead,
  PLATFORM_LIMITS, PLATFORM_LABELS,
} from './lib.js'

// --- Brand (mirrors css/tokens.css "Night Shift" values) ---

const INK = '#100f0e'
const SURFACE = '#16140f'
const PAPER = '#f0ebe0'
const PAPER_2 = '#c4bdae'
const PAPER_4 = '#8f897d'
const BRAND = '#d7321f'

const FONT_ORIGIN = 'https://jxnfilm.club/fonts'
const DISPLAY = '"JFC Display", Georgia, "Times New Roman", serif'
const LABEL = '"JFC Label", "Helvetica Neue", Arial, sans-serif'

let fontsReady = null
function loadFonts() {
  if (!fontsReady) {
    const add = async (family, file, desc) => {
      const f = new FontFace(family, `url(${FONT_ORIGIN}/${file})`, desc)
      await f.load()
      document.fonts.add(f)
    }
    // allSettled: a failed font load degrades to the fallback stacks above.
    fontsReady = Promise.allSettled([
      add('JFC Display', 'PlayfairDisplay-VariableFont_wght.woff2', { weight: '400 900' }),
      add('JFC Label', 'Oswald-VariableFont_wght.woff2', { weight: '200 700' }),
    ])
  }
  return fontsReady
}

// Same-origin proxy load — resolves null on any failure so cards render
// without the image instead of breaking.
function loadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = `/api/img?${qs({ url })}`
  })
}

const SIZES = {
  'ig-post': { w: 1080, h: 1080, label: 'IG post' },
  'ig-story': { w: 1080, h: 1920, label: 'IG story' },
  'fb': { w: 1200, h: 630, label: 'Facebook' },
  'x': { w: 1200, h: 675, label: 'Bluesky / X' },
}

const KINDS = {
  announce: 'Event announcement',
  countdown: 'Countdown',
  recap: 'Post-event recap',
  lineup: 'Season lineup',
  monthwrap: 'Monthly wrap',
  episode: 'New podcast episode',
  milestone: 'Milestone',
  roundup: 'Member watches roundup',
}

const EPISODES_URL = 'https://jxnfilm.club/data/episodes.json'
const MILESTONE_STATS = {
  members: 'Members',
  screenings: 'Screenings held',
  attendance: 'Total attendance',
}

const centralToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())

const PLATFORMS = ['instagram', 'facebook', 'discord', 'bluesky', 'x']

// --- Module state (survives tab switches, same pattern as the Events tab) ---

let cg = {
  kind: 'announce',
  size: 'ig-post',
  eventId: null,
  limit: 8,
  events: [],          // public views, sorted upcoming-first
  attendCounts: {},    // event id -> attendee count
  roundup: null,       // { films, total } from buildRoundupData
  episodes: null,      // [{ title, date, url }] from the public site
  episodeIdx: 0,
  wrapMonth: null,     // 'YYYY-MM' selected for the monthly wrap
  stat: 'members',     // selected milestone stat
  membersCount: 0,
}

let ctx = null         // { api, env, content, toast } injected by admin.js

// --- Data loading ---

async function loadEvents() {
  const perEvent = await ctx.api('GET', `/api/kv?${qs({ env: ctx.env(), binding: 'ATTENDANCE_KV', prefix: 'event:' })}`)
  let events
  if (perEvent.keys.length) {
    events = perEvent.keys.map(k => tryParse(perEvent.values[k.name])).filter(Boolean)
  } else {
    const aggRaw = await ctx.api('GET', `/api/kv?${qs({ env: ctx.env(), binding: 'ATTENDANCE_KV', prefix: 'events:all' })}`)
    events = tryParse(aggRaw.values['events:all']) || []
  }
  // Strip private fields immediately — nothing below this line ever holds a
  // host address. Dates are YYYY-MM-DD strings; compare as strings against a
  // Central-time today, never via new Date().
  const pub = events.map(socialEventView).filter(Boolean)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
  const upcoming = pub.filter(e => String(e.date || '') >= today)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
  const past = pub.filter(e => String(e.date || '') < today)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
  cg.events = [...upcoming, ...past]

  const attRaw = await ctx.api('GET', `/api/kv?${qs({ env: ctx.env(), binding: 'ATTENDANCE_KV', prefix: 'attend:' })}`)
  cg.attendCounts = {}
  for (const k of attRaw.keys) {
    const id = k.name.slice('attend:'.length)
    cg.attendCounts[id] = (tryParse(attRaw.values[k.name]) || []).length
  }
}

async function loadRoundup() {
  const map = await ctx.api('GET', `/api/watched?${qs({ env: ctx.env() })}`)
  cg.roundup = buildRoundupData(map, { limit: cg.limit })
}

// Episodes source, KV first: the operator override `config:podcast` in
// MEMBERS_KV (edited on the Config tab, same { featured_id, episodes }
// shape) wins when present; otherwise the built site's data/episodes.json
// (served with ACAO:*, so both admin origins fetch it directly). Cached per
// env — production and staging can hold different overrides.
async function loadEpisodes() {
  const envName = ctx.env()
  if (cg.episodes && cg.episodesEnv === envName) return
  try {
    const raw = await ctx.api('GET', `/api/kv?${qs({ env: envName, binding: 'MEMBERS_KV', prefix: 'config:podcast' })}`)
    const cfgPod = tryParse(raw.values['config:podcast'])
    if (cfgPod && Array.isArray(cfgPod.episodes)) {
      cg.episodes = cfgPod.episodes
      cg.episodesEnv = envName
      return
    }
  } catch { /* KV unavailable — fall through to the URL fetch */ }
  try {
    const res = await fetch(EPISODES_URL, { signal: AbortSignal.timeout(3000) })
    cg.episodes = (await res.json()).episodes || []
  } catch {
    cg.episodes = []
  }
  cg.episodesEnv = envName
}

// members:all length — only needed for the milestone card.
async function loadMembersCount() {
  const raw = await ctx.api('GET', `/api/kv?${qs({ env: ctx.env(), binding: 'MEMBERS_KV', prefix: 'members:all' })}`)
  cg.membersCount = (tryParse(raw.values['members:all']) || []).length
}

const currentEvent = () => cg.events.find(e => e.id === cg.eventId) || cg.events[0] || null
const upcomingEvents = () => cg.events.filter(e => String(e.date || '') >= centralToday())
const pastEvents = () => cg.events.filter(e => String(e.date || '') < centralToday())

// Past-event months (YYYY-MM), newest first, for the monthly wrap selector.
const wrapMonths = () =>
  [...new Set(pastEvents().map(e => String(e.date || '').slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m)))].sort().reverse()

function monthwrapData() {
  const month = cg.wrapMonth || wrapMonths()[0]
  const evs = pastEvents().filter(e => String(e.date || '').startsWith(month + '-'))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  return {
    month,
    monthLabel: fmtMonth(month),
    events: evs,
    films: evs.map(e => (e.film || e.title || '') + (e.year ? ` (${e.year})` : '')),
    screenings: evs.length,
    attendees: evs.reduce((sum, e) => sum + (cg.attendCounts[e.id] || 0), 0),
  }
}

function milestoneValue(stat) {
  if (stat === 'members') return cg.membersCount
  if (stat === 'screenings') return pastEvents().length
  return Object.values(cg.attendCounts).reduce((a, b) => a + b, 0)
}

function copyData() {
  if (cg.kind === 'roundup') return cg.roundup || { films: [], total: 0 }
  if (cg.kind === 'episode') return { episode: (cg.episodes || [])[cg.episodeIdx] || null }
  if (cg.kind === 'lineup') return { events: upcomingEvents().slice(0, 4) }
  if (cg.kind === 'monthwrap') return monthwrapData()
  if (cg.kind === 'milestone') return { stat: cg.stat, value: milestoneValue(cg.stat) }
  const event = currentEvent()
  return { event, count: event ? (cg.attendCounts[event.id] || 0) : 0, today: centralToday() }
}

// --- Canvas plumbing ---

function wrapText(c, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const w of words) {
    const probe = line ? `${line} ${w}` : w
    if (line && c.measureText(probe).width > maxWidth) {
      lines.push(line)
      line = w
    } else {
      line = probe
    }
  }
  if (line) lines.push(line)
  return lines
}

// object-fit: cover crop into the destination rect.
function drawCover(c, img, x, y, w, h) {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const sw = w / scale
  const sh = h / scale
  const sx = (img.naturalWidth - sw) / 2
  const sy = (img.naturalHeight - sh) / 2
  c.drawImage(img, sx, sy, sw, sh, x, y, w, h)
}

function label(c, text, x, y, px, color = BRAND) {
  c.font = `600 ${px}px ${LABEL}`
  c.letterSpacing = `${Math.round(px * 0.22)}px`
  c.fillStyle = color
  c.fillText(text.toUpperCase(), x, y)
  c.letterSpacing = '0px'
}

// `x` defaults to the bottom padding; pass it separately when the footer
// belongs to a side panel rather than the card's left edge.
function footer(c, W, H, pad, url, x = pad) {
  c.fillStyle = BRAND
  c.fillRect(x, H - pad - 6, Math.round(W * 0.075), 6)
  c.font = `500 ${Math.round(W * 0.024)}px ${LABEL}`
  c.letterSpacing = '2px'
  c.fillStyle = PAPER_4
  c.textBaseline = 'alphabetic'
  c.fillText(url.toUpperCase(), x, H - pad - 22)
  c.letterSpacing = '0px'
}

// --- Card templates ---

async function drawEventCard(c, W, H, event, lead) {
  const e = event || {}
  const name = e.film || e.title || 'Untitled'
  const poster = await loadImage(e.poster)
  const landscape = W > H
  const pad = Math.round(W * 0.065)

  c.fillStyle = INK
  c.fillRect(0, 0, W, H)

  // Poster panel: left column on landscape, top band otherwise.
  let tx = pad, ty, tw
  if (poster && landscape) {
    const pw = Math.round(W * 0.36)
    c.fillStyle = SURFACE
    c.fillRect(0, 0, pw, H)
    drawCover(c, poster, 0, 0, pw, H)
    tx = pw + pad
    tw = W - pw - pad * 2
    ty = Math.round(H * 0.2)
  } else if (poster) {
    const ph = Math.round(H * (H > W ? 0.52 : 0.5))
    drawCover(c, poster, 0, 0, W, ph)
    // Fade the poster into the ink panel below it.
    const fade = c.createLinearGradient(0, ph - 160, 0, ph)
    fade.addColorStop(0, 'rgba(16,15,14,0)')
    fade.addColorStop(1, 'rgba(16,15,14,1)')
    c.fillStyle = fade
    c.fillRect(0, ph - 160, W, 160)
    tw = W - pad * 2
    ty = ph + Math.round(H * 0.05)
  } else {
    tw = W - pad * 2
    ty = Math.round(H * 0.24)
  }

  label(c, `Jackson Film Club · ${lead || 'Next screening'}`, tx, ty, Math.round(W * 0.021))
  ty += Math.round(W * 0.02)

  // Film title — Playfair, wrapped, shrink-to-fit.
  let titlePx = Math.round(W * (landscape ? 0.062 : 0.072))
  c.font = `800 ${titlePx}px ${DISPLAY}`
  let lines = wrapText(c, name, tw)
  while (lines.length > 3 && titlePx > Math.round(W * 0.04)) {
    titlePx = Math.round(titlePx * 0.88)
    c.font = `800 ${titlePx}px ${DISPLAY}`
    lines = wrapText(c, name, tw)
  }
  c.fillStyle = PAPER
  c.textBaseline = 'top'
  for (const line of lines) {
    c.fillText(line, tx, ty)
    ty += Math.round(titlePx * 1.12)
  }
  if (e.year) {
    c.font = `italic 500 ${Math.round(titlePx * 0.5)}px ${DISPLAY}`
    c.fillStyle = PAPER_4
    c.fillText(String(e.year), tx, ty + Math.round(titlePx * 0.1))
    ty += Math.round(titlePx * 0.75)
  }
  ty += Math.round(H * 0.035)

  const metaPx = Math.round(W * 0.031)
  c.font = `500 ${metaPx}px ${LABEL}`
  c.fillStyle = PAPER_2
  const when = fmtSocialDate(e.date) + (e.time ? `  ·  ${fmtShowtime(e.time)}` : '')
  if (when.trim()) {
    c.fillText(when, tx, ty)
    ty += Math.round(metaPx * 1.5)
  }
  const venue = e.venue || (e.hostId ? 'Member-hosted screening' : '')
  if (venue) {
    c.fillStyle = PAPER_4
    c.fillText(venue, tx, ty)
  }

  footer(c, W, H, pad, 'jxnfilm.club/events')
}

async function drawRecapCard(c, W, H, event, count) {
  const e = event || {}
  const name = e.film || e.title || 'Untitled'
  const poster = await loadImage(e.poster)
  const pad = Math.round(W * 0.065)

  c.fillStyle = INK
  c.fillRect(0, 0, W, H)
  if (poster) {
    c.globalAlpha = 0.18
    drawCover(c, poster, 0, 0, W, H)
    c.globalAlpha = 1
    const veil = c.createLinearGradient(0, 0, 0, H)
    veil.addColorStop(0, 'rgba(16,15,14,0.55)')
    veil.addColorStop(1, 'rgba(16,15,14,0.95)')
    c.fillStyle = veil
    c.fillRect(0, 0, W, H)
  }

  let ty = Math.round(H * 0.2)
  label(c, "Jackson Film Club · That's a wrap", pad, ty, Math.round(W * 0.021))
  ty += Math.round(W * 0.025)
  c.textBaseline = 'top'

  if (count > 0) {
    const numPx = Math.round(Math.min(W, H) * 0.3)
    c.font = `800 ${numPx}px ${DISPLAY}`
    c.fillStyle = BRAND
    c.fillText(String(count), pad, ty)
    const numW = c.measureText(String(count)).width
    const ofPx = Math.round(W * 0.033)
    c.font = `500 ${ofPx}px ${LABEL}`
    c.fillStyle = PAPER_2
    c.fillText('OF US', pad + numW + Math.round(W * 0.02), ty + Math.round(numPx * 0.42))
    c.fillText('WATCHED', pad + numW + Math.round(W * 0.02), ty + Math.round(numPx * 0.42) + Math.round(ofPx * 1.4))
    ty += Math.round(numPx * 1.18)
  } else {
    const wePx = Math.round(W * 0.035)
    c.font = `500 ${wePx}px ${LABEL}`
    c.fillStyle = PAPER_2
    c.fillText('WE WATCHED', pad, ty)
    ty += Math.round(wePx * 1.9)
  }

  let titlePx = Math.round(W * 0.06)
  c.font = `800 ${titlePx}px ${DISPLAY}`
  let lines = wrapText(c, name + (e.year ? ` (${e.year})` : ''), W - pad * 2)
  while (lines.length > 3 && titlePx > Math.round(W * 0.035)) {
    titlePx = Math.round(titlePx * 0.88)
    c.font = `800 ${titlePx}px ${DISPLAY}`
    lines = wrapText(c, name + (e.year ? ` (${e.year})` : ''), W - pad * 2)
  }
  c.fillStyle = PAPER
  for (const line of lines) {
    c.fillText(line, pad, ty)
    ty += Math.round(titlePx * 1.12)
  }

  footer(c, W, H, pad, 'jxnfilm.club/events')
}

// Aspect-correct poster wall: 2:3 tiles with gutters and rounded corners,
// grid centered in its area, incomplete last row centered. Posters are
// natively 2:3, so drawCover here is a near-no-op crop — no more chopped
// heads from arbitrary cell shapes.
function drawPosterWall(c, posters, area) {
  const n = posters.length
  if (!n) return
  const g = Math.max(10, Math.round(area.w * 0.018))
  // Pick the column count that yields the biggest tiles that still fit.
  let best = null
  for (let cols = 1; cols <= Math.min(n, 4); cols++) {
    const rows = Math.ceil(n / cols)
    let tw = (area.w - g * (cols + 1)) / cols
    const fit = (area.h - g * (rows + 1)) / (rows * tw * 1.5)
    if (fit < 1) tw *= fit
    if (!best || tw > best.tw) best = { cols, rows, tw }
  }
  const { cols, rows, tw } = best
  const th = tw * 1.5
  const gridH = rows * th + g * (rows - 1)
  const y0 = area.y + (area.h - gridH) / 2
  let i = 0
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, n - r * cols)
    const rowW = inRow * tw + g * (inRow - 1)
    let x = area.x + (area.w - rowW) / 2
    const y = y0 + r * (th + g)
    for (let k = 0; k < inRow; k++, i++) {
      c.save()
      if (c.roundRect) {
        c.beginPath()
        c.roundRect(x, y, tw, th, Math.round(tw * 0.035))
        c.clip()
      }
      c.fillStyle = SURFACE
      c.fillRect(x, y, tw, th)
      drawCover(c, posters[i], x, y, tw, th)
      c.restore()
      x += tw + g
    }
  }
}

// Shared wall-card layout: poster wall + label/heading/sub-lines text block
// + footer. Used by the roundup, season lineup, and monthly wrap.
async function drawWallCard(c, W, H, { posterUrls = [], heading, subLines = [], footerUrl }) {
  const pad = Math.round(W * 0.065)
  const landscape = W > H
  c.fillStyle = INK
  c.fillRect(0, 0, W, H)

  const posters = (await Promise.all(posterUrls.map(loadImage))).filter(Boolean).slice(0, 8)

  // Landscape: wall fills the left, text panel on the right (footer inside
  // the panel). Portrait/square: wall on top, text centered below, footer
  // bottom-left as on the other cards.
  const tall = H >= W * 1.5   // story-shaped: give the wall more room, scale type up
  let wall, text, footX
  if (landscape) {
    const panelW = Math.round(W * 0.42)
    wall = { x: 0, y: 0, w: W - panelW, h: H }
    text = { x: W - panelW + Math.round(pad * 0.4), y: 0, w: panelW - Math.round(pad * 0.4) - pad, h: H - (pad + Math.round(W * 0.045)) }
    footX = text.x
  } else {
    const wallH = Math.round(H * (tall ? 0.68 : 0.62))
    wall = { x: 0, y: 0, w: W, h: wallH }
    text = { x: pad, y: wallH, w: W - pad * 2, h: H - wallH - (pad + Math.round(W * 0.045)) }
    footX = pad
  }
  if (posters.length) drawPosterWall(c, posters, wall)
  else if (!landscape) text = { x: pad, y: 0, w: W - pad * 2, h: H - (pad + Math.round(W * 0.045)) }

  // Measure the text block, then center it vertically in its area.
  const labelPx = Math.round(W * (landscape ? 0.016 : tall ? 0.023 : 0.019))
  const hPx = Math.round(W * (landscape ? 0.036 : tall ? 0.064 : 0.052))
  const countPx = Math.round(W * (landscape ? 0.019 : tall ? 0.031 : 0.026))
  // Measure at full size; if the block overflows its area (e.g. a 4-line
  // lineup on a square card), shrink the whole block to fit rather than
  // colliding with the footer.
  const fit = (k) => {
    const L = Math.round(labelPx * k)
    const Hh = Math.round(hPx * k)
    const C = Math.round(countPx * k)
    c.font = `800 ${Hh}px ${DISPLAY}`
    const lines = wrapText(c, heading, text.w)
    const gap = Math.round(Hh * 0.55)
    const subH = Math.round(C * 1.55)
    return { L, Hh, C, lines, gap, subH, blockH: L + gap + lines.length * Math.round(Hh * 1.12) + gap + subLines.length * subH }
  }
  let m = fit(1)
  if (m.blockH > text.h) m = fit(Math.max(0.6, text.h / m.blockH))
  let ty = text.y + Math.max(0, Math.round((text.h - m.blockH) / 2))

  c.textBaseline = 'top'
  label(c, 'Jackson Film Club', text.x, ty, m.L)
  ty += m.L + m.gap
  c.font = `800 ${m.Hh}px ${DISPLAY}`
  c.fillStyle = PAPER
  for (const line of m.lines) {
    c.fillText(line, text.x, ty)
    ty += Math.round(m.Hh * 1.12)
  }
  ty += m.gap
  c.font = `500 ${m.C}px ${LABEL}`
  c.fillStyle = PAPER_2
  for (const sub of subLines) {
    c.fillText(sub, text.x, ty)
    ty += m.subH
  }

  footer(c, W, H, pad, footerUrl, footX)
}

const eventDisplayName = (e) => (e.film || e.title || '') + (e.year ? ` (${e.year})` : '')

async function drawRoundupCard(c, W, H, { films = [], total = 0 } = {}) {
  return drawWallCard(c, W, H, {
    posterUrls: films.map(f => f.poster),
    heading: 'What the club is watching',
    subLines: [`${total} film${total === 1 ? '' : 's'} logged by members in the last week`],
    footerUrl: 'jxnfilm.club/watched',
  })
}

async function drawLineupCard(c, W, H, { events = [] } = {}) {
  return drawWallCard(c, W, H, {
    posterUrls: events.map(e => e.poster),
    heading: 'Coming up at the club',
    subLines: events.map(e => `${fmtSocialDate(e.date, { short: true })} — ${eventDisplayName(e)}`),
    footerUrl: 'jxnfilm.club/events',
  })
}

async function drawMonthwrapCard(c, W, H, d) {
  const stats = `${d.screenings} screening${d.screenings === 1 ? '' : 's'}` +
    (d.attendees > 0 ? ` · ${d.attendees} attendee${d.attendees === 1 ? '' : 's'}` : '')
  return drawWallCard(c, W, H, {
    posterUrls: (d.events || []).map(e => e.poster),
    heading: `That was ${d.monthLabel}`,
    subLines: [stats],
    footerUrl: 'jxnfilm.club/events',
  })
}

// Big-numeral stat card, recap-style: brand-red value + stacked unit words.
const MILESTONE_UNITS = {
  members: ['MEMBERS', 'STRONG'],
  screenings: ['SCREENINGS', 'AND COUNTING'],
  attendance: ['SEATS', 'FILLED'],
}

async function drawMilestoneCard(c, W, H, { stat, value = 0 } = {}) {
  const pad = Math.round(W * 0.065)
  c.fillStyle = INK
  c.fillRect(0, 0, W, H)

  const units = MILESTONE_UNITS[stat] || MILESTONE_UNITS.members
  const numPx = Math.round(Math.min(W, H) * 0.34)
  const ofPx = Math.round(W * 0.035)
  const thanksPx = Math.round(W * 0.028)
  const gap = Math.round(H * 0.05)
  const blockH = Math.round(W * 0.021) + Math.round(W * 0.025) + Math.round(numPx * 1.05) + gap + thanksPx
  let ty = Math.max(pad, Math.round((H - (pad + Math.round(W * 0.045)) - blockH) / 2))

  c.textBaseline = 'top'
  label(c, 'Jackson Film Club · Milestone', pad, ty, Math.round(W * 0.021))
  ty += Math.round(W * 0.025) + Math.round(W * 0.01)

  c.font = `800 ${numPx}px ${DISPLAY}`
  c.fillStyle = BRAND
  c.fillText(String(value), pad, ty)
  const numW = c.measureText(String(value)).width
  c.font = `500 ${ofPx}px ${LABEL}`
  c.fillStyle = PAPER_2
  c.fillText(units[0], pad + numW + Math.round(W * 0.025), ty + Math.round(numPx * 0.42))
  c.fillText(units[1], pad + numW + Math.round(W * 0.025), ty + Math.round(numPx * 0.42) + Math.round(ofPx * 1.4))
  ty += Math.round(numPx * 1.05) + gap

  c.font = `italic 500 ${thanksPx}px ${DISPLAY}`
  c.fillStyle = PAPER
  c.fillText('Thank you, Jackson.', pad, ty)

  footer(c, W, H, pad, 'jxnfilm.club')
}

// Typographic episode card — the podcast has no per-episode artwork the
// admin can legally rehost, so the type carries it.
async function drawEpisodeCard(c, W, H, { episode } = {}) {
  const e = episode || {}
  const pad = Math.round(W * 0.065)
  const landscape = W > H
  c.fillStyle = INK
  c.fillRect(0, 0, W, H)

  const labelPx = Math.round(W * 0.021)
  let titlePx = Math.round(W * (landscape ? 0.052 : 0.062))
  const metaPx = Math.round(W * 0.027)
  const tw = W - pad * 2

  c.font = `800 ${titlePx}px ${DISPLAY}`
  let lines = wrapText(c, e.title || 'New episode', tw)
  while (lines.length > 4 && titlePx > Math.round(W * 0.038)) {
    titlePx = Math.round(titlePx * 0.88)
    c.font = `800 ${titlePx}px ${DISPLAY}`
    lines = wrapText(c, e.title || 'New episode', tw)
  }
  const gap = Math.round(titlePx * 0.6)
  const blockH = labelPx + gap + lines.length * Math.round(titlePx * 1.12) + gap + metaPx * 2 + Math.round(metaPx * 0.8)
  let ty = Math.max(pad, Math.round((H - (pad + Math.round(W * 0.045)) - blockH) / 2))

  c.textBaseline = 'top'
  label(c, 'Jackson Film Club · New podcast episode', pad, ty, labelPx)
  ty += labelPx + gap
  c.font = `800 ${titlePx}px ${DISPLAY}`
  c.fillStyle = PAPER
  for (const line of lines) {
    c.fillText(line, pad, ty)
    ty += Math.round(titlePx * 1.12)
  }
  ty += gap
  if (e.date) {
    c.font = `500 ${metaPx}px ${LABEL}`
    c.fillStyle = PAPER_2
    c.fillText(fmtSocialDate(e.date), pad, ty)
    ty += Math.round(metaPx * 1.8)
  }
  c.font = `500 ${Math.round(metaPx * 0.85)}px ${LABEL}`
  c.letterSpacing = '2px'
  c.fillStyle = PAPER_4
  c.fillText('LISTEN WHEREVER YOU GET PODCASTS', pad, ty)
  c.letterSpacing = '0px'

  footer(c, W, H, pad, 'jxnfilm.club')
}

async function renderCanvas() {
  const canvas = document.querySelector('#cg-canvas')
  if (!canvas) return
  const { w, h } = SIZES[cg.size]
  canvas.width = w
  canvas.height = h
  const c = canvas.getContext('2d')
  await loadFonts()
  c.textBaseline = 'alphabetic'
  const data = copyData()
  if (cg.kind === 'roundup') await drawRoundupCard(c, w, h, data)
  else if (cg.kind === 'lineup') await drawLineupCard(c, w, h, data)
  else if (cg.kind === 'monthwrap') await drawMonthwrapCard(c, w, h, data)
  else if (cg.kind === 'episode') await drawEpisodeCard(c, w, h, data)
  else if (cg.kind === 'milestone') await drawMilestoneCard(c, w, h, data)
  else if (cg.kind === 'recap') await drawRecapCard(c, w, h, data.event, data.count)
  else if (cg.kind === 'countdown') await drawEventCard(c, w, h, data.event, countdownLead(daysUntil(data.event && data.event.date, data.today)))
  else await drawEventCard(c, w, h, data.event, 'Next screening')
}

// --- Copy panel ---

function renderCopyPanel() {
  const data = copyData()
  const wrap = document.querySelector('#cg-copy')
  wrap.innerHTML = PLATFORMS.map(p => {
    const text = buildSocialCopy(cg.kind, p, data)
    const limit = PLATFORM_LIMITS[p]
    return `
      <div class="cg-copy-card" data-platform="${attr(p)}">
        <div class="cg-copy-head">
          <strong>${escapeHtml(PLATFORM_LABELS[p])}</strong>
          <span class="cg-count ${limit && text.length > limit ? 'over' : ''}">${text.length}${limit ? ` / ${limit}` : ''}</span>
          <button type="button" class="cg-copy-btn">copy</button>
        </div>
        <textarea rows="${p === 'bluesky' || p === 'x' ? 4 : 8}" data-limit="${limit || ''}">${escapeHtml(text)}</textarea>
      </div>`
  }).join('')

  wrap.querySelectorAll('textarea').forEach(ta => {
    ta.addEventListener('input', () => {
      const card = ta.closest('.cg-copy-card')
      const count = card.querySelector('.cg-count')
      const limit = Number(ta.dataset.limit) || 0
      count.textContent = `${ta.value.length}${limit ? ` / ${limit}` : ''}`
      count.classList.toggle('over', !!limit && ta.value.length > limit)
    })
  })
  wrap.querySelectorAll('.cg-copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.cg-copy-card')
      await navigator.clipboard.writeText(card.querySelector('textarea').value)
      ctx.toast(`${PLATFORM_LABELS[card.dataset.platform]} copy copied to clipboard`)
    })
  })
}

// --- Tab renderer (called by admin.js) ---

export async function renderContentGen(context) {
  ctx = context
  await loadEvents()
  if (cg.kind === 'roundup') await loadRoundup()
  if (cg.kind === 'episode') await loadEpisodes()
  if (cg.kind === 'milestone') await loadMembersCount()
  if (!cg.events.some(e => e.id === cg.eventId)) cg.eventId = cg.events[0]?.id || null
  if (!wrapMonths().includes(cg.wrapMonth)) cg.wrapMonth = wrapMonths()[0] || null
  if (cg.episodes && cg.episodeIdx >= cg.episodes.length) cg.episodeIdx = 0

  const needsEvent = ['announce', 'countdown', 'recap'].includes(cg.kind)
  const emptyMsg =
    needsEvent && !cg.events.length ? 'No events in KV — create one on the Events tab first.'
    : cg.kind === 'roundup' && !(cg.roundup && cg.roundup.films.length) ? 'No member watches logged in the last 7 days — nothing to round up.'
    : cg.kind === 'lineup' && !upcomingEvents().length ? 'No upcoming events — the lineup needs at least one.'
    : cg.kind === 'monthwrap' && !cg.wrapMonth ? 'No past events yet — nothing to wrap.'
    : cg.kind === 'episode' && !(cg.episodes && cg.episodes.length) ? 'Could not load episodes from jxnfilm.club/data/episodes.json.'
    : null

  const controls = {
    event: () => `
      <label>Event
        <select id="cg-event">
          ${cg.events.map(e => `<option value="${attr(e.id)}" ${e.id === cg.eventId ? 'selected' : ''}>${escapeHtml(`${e.date || '????'} — ${e.film || e.title || e.id}`)}</option>`).join('')}
        </select>
      </label>`,
    limit: () => `
      <label>Films in collage
        <input id="cg-limit" type="number" min="1" max="8" value="${attr(cg.limit)}" style="width:64px">
      </label>`,
    episode: () => `
      <label>Episode
        <select id="cg-episode">
          ${(cg.episodes || []).map((ep, i) => `<option value="${i}" ${i === cg.episodeIdx ? 'selected' : ''}>${escapeHtml(`${ep.date || ''} — ${ep.title}`)}</option>`).join('')}
        </select>
      </label>`,
    month: () => `
      <label>Month
        <select id="cg-month">
          ${wrapMonths().map(m => `<option value="${attr(m)}" ${m === cg.wrapMonth ? 'selected' : ''}>${escapeHtml(fmtMonth(m))}</option>`).join('')}
        </select>
      </label>`,
    stat: () => `
      <label>Stat
        <select id="cg-stat">
          ${Object.entries(MILESTONE_STATS).map(([k, v]) => `<option value="${attr(k)}" ${k === cg.stat ? 'selected' : ''}>${escapeHtml(`${v} (${milestoneValue(k)})`)}</option>`).join('')}
        </select>
      </label>`,
  }
  const kindControls =
    needsEvent ? controls.event()
    : cg.kind === 'roundup' ? controls.limit()
    : cg.kind === 'episode' && cg.episodes && cg.episodes.length ? controls.episode()
    : cg.kind === 'monthwrap' && cg.wrapMonth ? controls.month()
    : cg.kind === 'milestone' ? controls.stat()
    : ''

  ctx.content().innerHTML = `
    <h2>Content Gen</h2>
    <p class="section-hint">Social media copy + downloadable cards from live ${escapeHtml(ctx.env())} data.
      Output is public-safe by construction: host addresses/notes never leave KV, and member watches
      are aggregated over the last 7 days — film titles and posters only, no names or handles.</p>

    <section class="cg-controls">
      <label>Post type
        <select id="cg-kind">
          ${Object.entries(KINDS).map(([k, v]) => `<option value="${attr(k)}" ${k === cg.kind ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
        </select>
      </label>
      ${kindControls}
    </section>

    ${emptyMsg ? `<p class="empty">${escapeHtml(emptyMsg)}</p>` : `
    <div class="cg-body">
      <section class="cg-graphic">
        <h3>Card</h3>
        <div class="toolbar">
          ${Object.entries(SIZES).map(([k, s]) => `<button type="button" class="cg-size ${k === cg.size ? 'active' : ''}" data-size="${attr(k)}">${escapeHtml(s.label)} <span class="muted">${s.w}×${s.h}</span></button>`).join('')}
        </div>
        <div class="cg-canvas-wrap"><canvas id="cg-canvas"></canvas></div>
        <div class="toolbar">
          <button type="button" class="primary" id="cg-download">Download PNG</button>
        </div>
      </section>
      <section class="cg-copy-panel">
        <h3>Copy</h3>
        <div id="cg-copy"></div>
      </section>
    </div>`}
  `

  const kindSel = document.querySelector('#cg-kind')
  kindSel.addEventListener('change', async () => {
    cg.kind = kindSel.value
    await ctx.withBusy(() => renderContentGen(ctx))
  })
  const refresh = () => {
    renderCopyPanel()
    renderCanvas().catch(e => ctx.toast(e.message || String(e), true))
  }
  const evSel = document.querySelector('#cg-event')
  if (evSel) evSel.addEventListener('change', () => {
    cg.eventId = evSel.value
    refresh()
  })
  const limitInput = document.querySelector('#cg-limit')
  if (limitInput) limitInput.addEventListener('change', async () => {
    cg.limit = Math.max(1, Math.min(8, Number(limitInput.value) || 8))
    limitInput.value = cg.limit
    await loadRoundup()
    refresh()
  })
  const epSel = document.querySelector('#cg-episode')
  if (epSel) epSel.addEventListener('change', () => {
    cg.episodeIdx = Number(epSel.value) || 0
    refresh()
  })
  const monthSel = document.querySelector('#cg-month')
  if (monthSel) monthSel.addEventListener('change', () => {
    cg.wrapMonth = monthSel.value
    refresh()
  })
  const statSel = document.querySelector('#cg-stat')
  if (statSel) statSel.addEventListener('change', () => {
    cg.stat = statSel.value
    refresh()
  })
  document.querySelectorAll('.cg-size').forEach(btn => {
    btn.addEventListener('click', () => {
      cg.size = btn.dataset.size
      document.querySelectorAll('.cg-size').forEach(b => b.classList.toggle('active', b === btn))
      renderCanvas().catch(e => ctx.toast(e.message || String(e), true))
    })
  })
  const dl = document.querySelector('#cg-download')
  if (dl) dl.addEventListener('click', () => {
    const canvas = document.querySelector('#cg-canvas')
    canvas.toBlob(blob => {
      if (!blob) return ctx.toast('PNG export failed', true)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      const fileTag =
        needsEvent ? currentEvent()
        : cg.kind === 'episode' ? { title: ((cg.episodes || [])[cg.episodeIdx] || {}).title }
        : cg.kind === 'monthwrap' ? { title: cg.wrapMonth }
        : cg.kind === 'milestone' ? { title: cg.stat }
        : null
      a.download = socialFileName(cg.kind, cg.size, fileTag)
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    }, 'image/png')
  })

  if (!emptyMsg) {
    renderCopyPanel()
    renderCanvas().catch(e => ctx.toast(e.message || String(e), true))
  }
}

// Exported for the headless visual-QA harness and future tests; admin.js
// only uses renderContentGen.
export {
  loadFonts, drawEventCard, drawRecapCard, drawRoundupCard,
  drawLineupCard, drawMonthwrapCard, drawEpisodeCard, drawMilestoneCard,
}
