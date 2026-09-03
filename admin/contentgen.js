// Content Gen tab — social media copy + downloadable PNG cards, generated
// from live KV data (events, attendance counts, member Letterboxd watches).
//
// Privacy: everything rendered here is destined for PUBLIC social posts.
// Events flow through socialEventView() (no address/notes/capacity) and
// member watches through buildRoundupData()/buildDiaryPages() (no names or
// handles — and buildDiaryPages also drops the diary `link`, which embeds
// the handle) — all enforced in lib.js, not here. Attendance contributes a
// count only, and a diary row's rating is the club average, never one
// member's score.
//
// Rendering is hand-rolled canvas (the admin SPA is buildless). Poster
// images load through the same-origin /api/img proxy so the canvas is never
// CORS-tainted; brand fonts load cross-origin from jxnfilm.club (GitHub
// Pages sends ACAO) via the FontFace API, with serif/sans fallbacks.

import {
  escapeHtml, attr, tryParse, qs,
  socialEventView, buildSocialCopy, buildRoundupData, buildDiaryPages, diarySeriesCopy, socialFileName,
  fmtSocialDate, fmtShowtime, fmtMonth, fmtDiaryRange, daysUntil, countdownLead,
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
//
// Memoized on the URL: a "download all pages" run redraws every diary page,
// and each size-button click redraws again, so an uncached load would refetch
// the same ~130 posters through /api/img on every pass. Failures are evicted
// so one transient proxy hiccup doesn't blank a poster for the whole session.
const imgCache = new Map()
function loadImage(url) {
  if (!url) return Promise.resolve(null)
  const hit = imgCache.get(url)
  if (hit) return hit
  const p = new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = `/api/img?${qs({ url })}`
  }).then((img) => {
    if (!img) imgCache.delete(url)
    return img
  })
  imgCache.set(url, p)
  return p
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
  voice: 'Voice prompt',
  milestone: 'Milestone',
  roundup: 'Member watches roundup',
  diary: 'Member diary (paged)',
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

// Films per diary card. The 2x5 grid in drawDiaryCard is built around this
// number — changing it means re-deriving that layout, not just this constant.
const DIARY_PER_PAGE = 10

// --- Module state (survives tab switches, same pattern as the Events tab) ---

let cg = {
  kind: 'announce',
  size: 'ig-post',
  eventId: null,
  limit: 8,
  events: [],          // public views, sorted upcoming-first
  attendCounts: {},    // event id -> attendee count
  roundup: null,       // { films, total } from buildRoundupData
  diary: null,         // { pages, total, entries, pageCount, availablePages }
  diaryMap: null,      // raw /watched map, cached per env so re-scoping never refetches
  diaryPage: 0,        // index into cg.diary.pages
  // Defaults to the trailing week: the weekly post is the job, and the deep
  // pages reach back years, so opening on the whole feed starts the operator
  // somewhere they almost never want to post from.
  diaryDays: 7,        // null = whole feed; 7 / 30 = trailing window
  diaryMaxPages: null, // null = every page; N = stop after N
  batching: false,     // a "download all pages" run is in flight
  rendering: false,    // a canvas paint is outstanding (downloads are unsafe)
  renderSeq: 0,        // monotonic token; only the newest paint may land
  episodes: null,      // [{ title, date, url }] from the public site
  episodeIdx: 0,
  wrapMonth: null,     // 'YYYY-MM' selected for the monthly wrap
  stat: 'members',     // selected milestone stat
  membersCount: 0,
  voicePrompt: null,   // config:voice_prompt, or the site's generic default
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

// Same source as the roundup, paged instead of windowed. Note the pages are
// held in module state and the batch export reads them from there — never
// re-fetching mid-run, since /watched is live behind a 15-minute cache and a
// refresh between pages would shift the boundaries and duplicate or skip films
// across the series.
async function loadDiary() {
  // The map is cached per env (same pattern as loadEpisodes): re-scoping to a
  // different window or page cap is a local rebuild, not another round trip.
  if (!cg.diaryMap || cg.diaryMapEnv !== ctx.env()) {
    cg.diaryMap = await ctx.api('GET', `/api/watched?${qs({ env: ctx.env() })}`)
    cg.diaryMapEnv = ctx.env()
  }
  rebuildDiary()
}

function rebuildDiary() {
  cg.diary = buildDiaryPages(cg.diaryMap, {
    perPage: DIARY_PER_PAGE,
    days: cg.diaryDays,
    maxPages: cg.diaryMaxPages,
  })
  // A narrower window or a lower cap can strand the selected page.
  if (cg.diaryPage >= cg.diary.pageCount) cg.diaryPage = 0
}

const DIARY_RANGES = [
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: 'all', label: 'All time', days: null },
]

// The pager is a SIBLING of #cg-copy, not part of it: renderCopyPanel()
// replaces that node's innerHTML wholesale, which would destroy the very
// button being clicked and force a refocus dance on every step. Updating text
// and disabled flags in place instead keeps focus on the arrow, so holding
// Enter walks the series.
//
// syncPager is the SOLE formatter for these strings — the template emits them
// empty — so there is no second copy free to drift.
function syncPager() {
  const d = cg.diary
  if (!d || !d.pageCount) return
  const now = document.querySelector('#cg-page-now')
  const range = document.querySelector('#cg-page-range')
  const prev = document.querySelector('#cg-page-prev')
  const next = document.querySelector('#cg-page-next')
  const page = d.pages[cg.diaryPage]
  if (now) now.textContent = `Page ${cg.diaryPage + 1} / ${d.pageCount}`
  if (range) range.textContent = page ? fmtDiaryRange(page.from, page.to) : ''
  // Ends disable rather than wrap: wrapping from the last page to the first is
  // indistinguishable from a mis-click, and this tool's whole job is not
  // posting the wrong page.
  if (prev) prev.disabled = cg.diaryPage <= 0
  if (next) next.disabled = cg.diaryPage >= d.pageCount - 1
  // The jump list is the same state seen another way; keep it honest.
  const sel = document.querySelector('#cg-diary-page')
  if (sel && Number(sel.value) !== cg.diaryPage) sel.value = String(cg.diaryPage)
  const badge = `${cg.diaryPage + 1}/${d.pageCount}`
  document.querySelectorAll('.cg-copy-page').forEach(el => { el.textContent = badge })
}

// Left/right step the pager. Bound once at module scope behind a latch: this
// module's render function runs on every tab visit, and binding per render
// would fire the handler N times after N visits.
//
// `diaryRefresh` is the current render's refresh closure, restamped each
// render — the listener outlives any one of them.
let keysBound = false
let diaryRefresh = null
function bindDiaryKeys() {
  if (keysBound) return
  keysBound = true
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    // Arrow keys move a caret in a textarea and change a <select>'s value —
    // five textareas and three selects live on this tab.
    const tag = (document.activeElement && document.activeElement.tagName) || ''
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return
    // The pager only exists on the diary kind with pages, so its presence
    // covers every other tab, kind, and the single-page and empty states.
    if (!document.querySelector('#cg-pager') || !diaryRefresh) return
    e.preventDefault()
    gotoDiaryPage(cg.diaryPage + (e.key === 'ArrowRight' ? 1 : -1), diaryRefresh)
  })
}

// Single entry point for every page change — arrows, jump list, keyboard.
function gotoDiaryPage(n, refresh) {
  const d = cg.diary
  if (!d || !d.pageCount) return
  const next = Math.max(0, Math.min(d.pageCount - 1, n))
  if (next === cg.diaryPage) return
  cg.diaryPage = next
  syncPager()
  refresh()
}

const diaryPageData = () => {
  const pages = (cg.diary && cg.diary.pages) || []
  const page = pages[cg.diaryPage] || { films: [] }
  return { ...page, page: cg.diaryPage + 1, pageCount: pages.length }
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

// The prompt members answer when they record a clip. Same source the site and
// the newsletter's voice CTA read, so a card can never quote a stale prompt:
// config:voice_prompt when it carries both id and text, else the generic
// default the Worker falls back to.
const DEFAULT_VOICE_PROMPT = { id: 'general', text: "Tell us what you're watching" }

async function loadVoicePrompt() {
  const envName = ctx.env()
  if (cg.voicePrompt && cg.voicePromptEnv === envName) return
  const raw = await ctx.api('GET', `/api/kv?${qs({ env: envName, binding: 'MEMBERS_KV', prefix: 'config:voice_prompt' })}`)
  const cfg = tryParse(raw.values['config:voice_prompt'])
  cg.voicePrompt = (cfg && cfg.id && cfg.text) ? cfg : DEFAULT_VOICE_PROMPT
  cg.voicePromptEnv = envName
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
  if (cg.kind === 'diary') return diaryPageData()
  if (cg.kind === 'episode') return { episode: (cg.episodes || [])[cg.episodeIdx] || null }
  if (cg.kind === 'voice') return { prompt: cg.voicePrompt || DEFAULT_VOICE_PROMPT }
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

// Single-line truncation for grid cells too tight to wrap.
function ellipsize(c, text, maxWidth) {
  let s = String(text || '')
  if (c.measureText(s).width <= maxWidth) return s
  while (s.length > 1 && c.measureText(s + '…').width > maxWidth) s = s.slice(0, -1)
  return s.replace(/[\s.,;:—–-]+$/, '') + '…'
}

// Largest type size at or below `px` whose wrap of `text` fits inside the
// row. Returns { px, lines }.
//
// Titles vary enormously ("M" vs "Dr. Strangelove or: How I Learned to Stop
// Worrying and Love the Bomb") and a fixed size can only serve one of them.
// Scanning down 1px at a time is ~20 iterations over a handful of words —
// trivial beside the poster fetches, and it keeps the search obvious.
//
// `softMaxLines` is the line count a full-size title is expected to use. A
// SHRINKING title may exceed it, but only while the block still fits `budgetH`
// — the row's vertical space once the year/stars line is reserved. That's what
// lets a very long title take a third line instead of losing its ending, while
// still never pushing its row taller or shifting the column beside it.
function fitTitle(c, text, maxWidth, px, softMaxLines, budgetH) {
  const floor = Math.round(px * 0.6)
  for (let size = px; size >= floor; size--) {
    c.font = `700 ${size}px ${DISPLAY}`
    const lines = wrapText(c, text, maxWidth)
    // A single unbreakable word can still overflow at any size.
    if (lines.some(l => c.measureText(l).width > maxWidth)) continue
    const lineH = Math.round(size * 1.14)
    const allowed = Math.max(softMaxLines, Math.floor(budgetH / lineH))
    if (lines.length <= allowed) return { px: size, lines }
  }
  // Genuinely unfittable — an unbreakable word wider than the column, or a
  // title longer than the row can hold at any legible size. Clip it, and make
  // the clip VISIBLE: ellipsize() only trims a line that overflows, so the
  // ' …' is appended first to force it over and guarantee the mark survives.
  // Without that the title just stops mid-phrase with no sign it was cut.
  c.font = `700 ${floor}px ${DISPLAY}`
  const lineH = Math.round(floor * 1.14)
  const allowed = Math.max(softMaxLines, Math.floor(budgetH / lineH))
  const lines = wrapText(c, text, maxWidth).slice(0, allowed)
  lines[lines.length - 1] = ellipsize(c, lines[lines.length - 1] + ' …', maxWidth)
  return { px: floor, lines }
}

// One five-pointed star as a path, centred on (cx, cy) with circumradius r.
function starPath(c, cx, cy, r) {
  c.beginPath()
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5
    const rad = i % 2 ? r * 0.42 : r
    const x = cx + Math.cos(a) * rad
    const y = cy + Math.sin(a) * rad
    i ? c.lineTo(x, y) : c.moveTo(x, y)
  }
  c.closePath()
}

// Advance width drawStars() will consume for a rating — same arithmetic, no
// drawing, so a layout pass can measure a row before committing to it.
function starsWidth(rating, px) {
  const n = Number(rating) || 0
  if (!(n > 0)) return 0
  const drawn = Math.floor(n) + (n - Math.floor(n) >= 0.5 ? 1 : 0)
  return drawn * Math.round(px * 1.15)
}

// Letterboxd half-star rating drawn as VECTOR stars, not text. '★' (U+2605)
// is in neither Oswald nor Playfair, so a text star falls back per-glyph to
// whatever symbol font the machine has — which moves the baseline and the
// measureText width out from under the layout, and makes the same card render
// differently in headless QA than in the operator's browser. starsOf() in
// lib.js stays the formatter for the copy panel, where that doesn't matter.
//
// `y` is the TOP of the star box (paths ignore textBaseline). Only filled
// stars are drawn — no empty outlines — matching starsOf()'s text form.
// Returns the drawn width; a missing or zero rating draws nothing, returns 0.
function drawStars(c, rating, x, y, px, color = BRAND) {
  const n = Number(rating) || 0
  if (!(n > 0)) return 0
  const full = Math.floor(n)
  const half = n - full >= 0.5
  const r = px / 2
  const step = Math.round(px * 1.15)
  c.fillStyle = color
  let cx = x + r
  for (let i = 0; i < full; i++) {
    starPath(c, cx, y + r, r)
    c.fill()
    cx += step
  }
  if (half) {
    // A bare left-half star reads as a clipping artifact at row size, so the
    // full outline is ghosted behind it — the glyph still says "star", the
    // solid half still says "half". starsOf() renders the same value as '½'.
    c.save()
    c.globalAlpha = 0.3
    starPath(c, cx, y + r, r)
    c.fill()
    c.globalAlpha = 1
    c.beginPath()
    c.rect(cx - r, y, r, px)
    c.clip()
    starPath(c, cx, y + r, r)
    c.fill()
    c.restore()
    cx += step
  }
  return cx - r - x
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

// One page of the club diary: two columns of five poster+title+stars rows.
// `films` is a page from buildDiaryPages (<= 10, already newest-first).
//
// 2x5 at every size, including the landscape ones. Transposing to 5x2 on
// 1200x630 looks like the obvious fix for the short grid and isn't: five
// columns makes each cell ~190px wide, and a 2:3 poster at that width wants
// to be 285px tall against a ~350px grid — it doesn't fit even one row, and
// shrinking it to fit two gives a smaller thumb AND a narrower title column
// than 2x5 does. What actually buys the vertical budget is dropping the big
// display heading on landscape (two compact label lines instead), which frees
// ~65px and lands ~70px rows.
async function drawDiaryCard(c, W, H, { films = [], from, to, page = 1, pageCount = 1 } = {}) {
  // The grid follows the page's actual film count. A full page is 2x5, but
  // the last page is whatever's left over — 121 films over 10 leaves ONE on
  // page 13, and a lone thumbnail parked in the top-left of an empty 2x5 is
  // not a postable card. Collapsing to a single column (and only as many rows
  // as there are films) lets the pitch cap scale the poster up and centre it.
  const shown = films.slice(0, DIARY_PER_PAGE)
  const cols = shown.length > 5 ? 2 : 1
  const rows = Math.max(1, Math.ceil(shown.length / cols))
  const landscape = W > H
  const tall = H >= W * 1.5
  const pad = Math.round(W * 0.055)
  const footReserve = pad + Math.round(W * 0.045)   // matches drawWallCard's reserve

  c.fillStyle = INK
  c.fillRect(0, 0, W, H)

  const labelPx = Math.round(W * (landscape ? 0.018 : tall ? 0.022 : 0.020))
  const headPx = landscape ? 0 : Math.round(W * (tall ? 0.058 : 0.050))
  const metaPx = Math.round(W * (landscape ? 0.016 : tall ? 0.022 : 0.019))
  const range = fmtDiaryRange(from, to)
  const pageStr = `Page ${page} of ${pageCount}`
  const headGap = Math.round((headPx || labelPx) * 0.45)

  c.textBaseline = 'top'
  let hy = pad
  label(c, landscape ? 'Jackson Film Club · From the club diary' : 'Jackson Film Club', pad, hy, labelPx)
  hy += labelPx + headGap
  if (headPx) {
    c.font = `800 ${headPx}px ${DISPLAY}`
    c.fillStyle = PAPER
    c.fillText('From the club diary', pad, hy)
    hy += Math.round(headPx * 1.05) + Math.round(headGap * 0.5)
  }
  // The range is the honest claim: feed depth is capped per member, not by
  // date, so a deep page can be years old. Never imply recency here.
  c.font = `500 ${metaPx}px ${LABEL}`
  c.fillStyle = PAPER_2
  c.fillText(range ? `${range} · ${pageStr}` : pageStr, pad, hy)
  hy += metaPx

  const grid = { x: pad, y: hy + Math.round(pad * (landscape ? 0.3 : 0.5)), w: W - pad * 2 }
  grid.h = H - footReserve - grid.y

  const gut = Math.round(W * 0.022)
  const colW = Math.round((grid.w - gut) / cols)
  // Cap the row pitch so five rows don't stretch to 313px each on the story;
  // the block is then centred in the slack, as drawWallCard does with text.
  const pitchMax = Math.round(colW * (tall ? 0.62 : 0.34))
  const rowH = Math.min(Math.floor(grid.h / rows), pitchMax)
  const gridTop = grid.y + Math.max(0, Math.round((grid.h - rowH * rows) / 2))

  // The colW cap keeps the poster from crowding the title column. The story
  // gets a looser cap: its rows are tall enough that the 0.33 used elsewhere
  // leaves the posters stranded in the middle of a lot of empty row.
  const posterH = Math.min(Math.round(rowH * 0.84), Math.round(colW * (tall ? 0.42 : 0.33)))
  const posterW = Math.round(posterH * 2 / 3)
  const gapX = Math.round(W * 0.016)
  const textW = colW - posterW - gapX
  // Floor keeps the title from dropping below the footer's own size
  // (footer() hardcodes W*0.024) — smaller type there reads as a bug.
  const titlePx = Math.max(
    Math.round(W * 0.024),
    Math.min(Math.round(W * (tall ? 0.040 : 0.034)), Math.round(rowH * 0.38)),
  )
  const subPx = Math.round(titlePx * 0.66)
  const starPx = Math.round(titlePx * 0.56)
  const subH = Math.max(subPx, starPx)
  const maxLines = landscape ? 1 : 2

  // Pick ONE annotation form for the whole card, sized to the tightest row
  // that needs it. Choosing per row instead makes a single card carry both
  // "4.6 avg · 8 members" and "1.8 · 2", which reads as a glitch.
  const NOTE_FORMS = [
    (a, n) => `${a} avg · ${n} members`,
    (a, n) => `${a} avg · ${n}`,
    (a, n) => `${a} · ${n}`,
  ]
  let noteForm = 0
  c.font = `500 ${subPx}px ${LABEL}`
  for (const f of shown) {
    if (!(f.ratedCount > 1) || !(f.avgRating > 0)) continue
    let used = f.year ? c.measureText(String(f.year)).width + Math.round(titlePx * 0.35) : 0
    used += starsWidth(Math.round(f.avgRating * 2) / 2, starPx) + Math.round(titlePx * 0.28)
    const room = textW - used
    while (noteForm < NOTE_FORMS.length - 1
           && c.measureText(NOTE_FORMS[noteForm](f.avgRating.toFixed(1), f.ratedCount)).width > room) {
      noteForm++
    }
  }

  // Load every poster up front: loadImage is memoized and resolves null on
  // failure, so a dead URL just leaves the surface block behind the tile.
  const posters = await Promise.all(shown.map(f => loadImage(f.poster)))

  for (let i = 0; i < shown.length; i++) {
    const f = shown[i]
    const col = Math.floor(i / rows)          // column-major: 1-5 left, 6-10 right
    const rx = grid.x + col * (colW + gut)
    const ry = gridTop + (i % rows) * rowH

    const py = ry + Math.round((rowH - posterH) / 2)
    c.save()
    if (c.roundRect) {
      c.beginPath()
      c.roundRect(rx, py, posterW, posterH, Math.round(posterW * 0.06))
      c.clip()
    }
    c.fillStyle = SURFACE
    c.fillRect(rx, py, posterW, posterH)
    if (posters[i]) drawCover(c, posters[i], rx, py, posterW, posterH)
    c.restore()

    const tx = rx + posterW + gapX
    c.textBaseline = 'top'
    // Fit the title by SHRINKING, not truncating — a clipped title is worse
    // than a slightly smaller one, and "The Ministry of Ungentlemanly …" tells
    // the reader nothing. Row geometry is untouched: the block is centred in a
    // fixed rowH beside a fixed poster, so a long title costs type size only
    // and never shifts its neighbours or its column.
    const hasSub = !!(f.year || f.avgRating > 0)
    // Gaps and the sub-line stay keyed to the ORIGINAL titlePx so a shrunk
    // title doesn't drag its year/stars out of line with the rows around it.
    const subReserve = hasSub ? Math.round(titlePx * 0.30) + subH : 0
    // Keep a gutter so a title that grows into an extra line stops short of
    // the row boundary. Without it a 3-line title fills rowH exactly and the
    // rows read as touching even though nothing actually overlaps.
    const gutter = Math.round(titlePx * 0.32)
    const fitted = fitTitle(c, f.title, textW, titlePx, maxLines, rowH - subReserve - gutter)
    const lineH = Math.round(fitted.px * 1.14)
    const blockH = fitted.lines.length * lineH + subReserve
    let ty = ry + Math.max(0, Math.round((rowH - blockH) / 2))

    c.font = `700 ${fitted.px}px ${DISPLAY}`
    c.fillStyle = PAPER
    for (const line of fitted.lines) {
      c.fillText(line, tx, ty)
      ty += lineH
    }

    if (hasSub) {
      ty += Math.round(titlePx * 0.30)
      let sx = tx
      const midY = (px) => ty + Math.round((subH - px) / 2)
      if (f.year) {
        c.font = `500 ${subPx}px ${LABEL}`
        c.fillStyle = PAPER_4
        c.fillText(String(f.year), sx, midY(subPx))
        sx += c.measureText(String(f.year)).width + Math.round(titlePx * 0.35)
      }
      // Club average, rounded to Letterboxd's own half-star granularity.
      if (f.avgRating > 0) {
        sx += drawStars(c, Math.round(f.avgRating * 2) / 2, sx, midY(starPx), starPx)
        // Multi-rater films show the exact mean and the sample size, so a
        // rounded 4.5 never passes for a unanimous one. The bare pair
        // "4.6 · 8" doesn't say what either number is, so spell it out and
        // fall back only when the row genuinely can't hold it.
        if (f.ratedCount > 1) {
          c.font = `500 ${subPx}px ${LABEL}`
          c.fillStyle = PAPER_4
          const nx = sx + Math.round(titlePx * 0.28)
          const note = NOTE_FORMS[noteForm](f.avgRating.toFixed(1), f.ratedCount)
          if (c.measureText(note).width <= tx + textW - nx) c.fillText(note, nx, midY(subPx))
        }
      }
    }
  }

  c.textBaseline = 'alphabetic'
  footer(c, W, H, pad, 'jxnfilm.club/watched')
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

// The current voice prompt as a card. Typographic like the episode card — the
// prompt IS the artwork, so it gets the display face at the largest size that
// still fits, with the invitation and deadline as supporting lines.
async function drawVoicePromptCard(c, W, H, { prompt } = {}) {
  const p = prompt || {}
  const text = String(p.text || '').trim() || 'What are you watching?'
  const pad = Math.round(W * 0.065)
  const landscape = W > H
  const tall = H >= W * 1.5
  c.fillStyle = INK
  c.fillRect(0, 0, W, H)

  const labelPx = Math.round(W * 0.021)
  const metaPx = Math.round(W * (landscape ? 0.022 : 0.027))
  const tw = W - pad * 2

  // Shrink to fit rather than clip: a truncated question cannot be answered,
  // which is the entire purpose of the card.
  let quotePx = Math.round(W * (landscape ? 0.055 : tall ? 0.072 : 0.064))
  const floor = Math.round(quotePx * 0.55)
  const maxLines = landscape ? 3 : 5
  let lines
  for (;;) {
    c.font = `800 ${quotePx}px ${DISPLAY}`
    lines = wrapText(c, `“${text}”`, tw)
    if (lines.length <= maxLines || quotePx <= floor) break
    quotePx = Math.round(quotePx * 0.92)
  }

  const gap = Math.round(quotePx * 0.55)
  const lineH = Math.round(quotePx * 1.14)
  const subLines = [
    `Record or upload up to three minutes${p.deadline ? ` by ${fmtSocialDate(p.deadline, { short: true })}` : ''}.`,
    'The best clips get aired on the podcast.',
  ]
  const blockH = labelPx + gap + lines.length * lineH + gap + subLines.length * Math.round(metaPx * 1.5)
  let ty = Math.max(pad, Math.round((H - (pad + Math.round(W * 0.045)) - blockH) / 2))

  c.textBaseline = 'top'
  label(c, 'Jackson Film Club · Podcast', pad, ty, labelPx)
  ty += labelPx + gap

  c.font = `800 ${quotePx}px ${DISPLAY}`
  c.fillStyle = PAPER
  for (const line of lines) {
    c.fillText(line, pad, ty)
    ty += lineH
  }
  ty += gap

  c.font = `500 ${metaPx}px ${LABEL}`
  for (let i = 0; i < subLines.length; i++) {
    c.fillStyle = i === 0 ? PAPER_2 : PAPER_4
    c.fillText(subLines[i], pad, ty)
    ty += Math.round(metaPx * 1.5)
  }

  footer(c, W, H, pad, 'jxnfilm.club/speak')
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

// Renders are async (fonts, then posters through /api/img) and the prev/next
// pager makes overlapping renders the NORMAL interaction, not a rarity — a
// dropdown produced one every so often, arrows produce one per click. Without
// a token the slower of two interleaved paints wins and the canvas ends up
// showing a page the operator already stepped past.
//
// The posters are warmed BEFORE the canvas is resized (resizing clears the
// bitmap synchronously). Two things fall out of that order: a superseded
// render bails without ever having touched the visible canvas, and the
// previous page stays up instead of flashing empty checkerboard. Because
// loadImage is memoized, drawDiaryCard's own await then resolves from cache in
// the same macrotask, so the page swaps atomically.
//
// The catch, and why cg.rendering exists: the copy panel repaints
// SYNCHRONOUSLY while this is still awaiting, so for a moment every text
// artifact says page N while the canvas still shows N-1. #cg-download names
// its file from cg.diaryPage, which is already N — so a download landing in
// that window would save the PREVIOUS page's card under the NEW page's name.
// Silent, plausible, and exactly the mis-post this feature guards against
// everywhere else. The download buttons are therefore disabled while a render
// is outstanding.
async function renderCanvas() {
  const seq = ++cg.renderSeq
  const canvas = document.querySelector('#cg-canvas')
  if (!canvas) return
  const { w, h } = SIZES[cg.size]
  const data = copyData()
  setRenderBusy(true)
  try {
    await loadFonts()
    if (cg.kind === 'diary') await Promise.all((data.films || []).map(f => loadImage(f.poster)))
    if (seq !== cg.renderSeq) return          // superseded — leave the bitmap alone
    canvas.width = w
    canvas.height = h
    const c = canvas.getContext('2d')
    c.textBaseline = 'alphabetic'
    await drawForKind(c, w, h, data)
  } finally {
    // Only the newest render clears the flag; an older one finishing late must
    // not re-enable the buttons while the current paint is still in flight.
    if (seq === cg.renderSeq) setRenderBusy(false)
  }
}

// Downloads read cg.diaryPage/cg.size at click time, so they are only honest
// once the canvas matches. Batch export drives its own detached canvas and
// manages these buttons itself, so it is left alone while batching.
function setRenderBusy(on) {
  cg.rendering = on
  const wrap = document.querySelector('.cg-canvas-wrap')
  if (wrap) wrap.classList.toggle('loading', on)
  if (cg.batching) return
  for (const id of ['#cg-download', '#cg-download-all']) {
    const b = document.querySelector(id)
    if (b) b.disabled = on
  }
}

async function drawForKind(c, w, h, data) {
  if (cg.kind === 'roundup') await drawRoundupCard(c, w, h, data)
  else if (cg.kind === 'diary') await drawDiaryCard(c, w, h, data)
  else if (cg.kind === 'lineup') await drawLineupCard(c, w, h, data)
  else if (cg.kind === 'monthwrap') await drawMonthwrapCard(c, w, h, data)
  else if (cg.kind === 'episode') await drawEpisodeCard(c, w, h, data)
  else if (cg.kind === 'voice') await drawVoicePromptCard(c, w, h, data)
  else if (cg.kind === 'milestone') await drawMilestoneCard(c, w, h, data)
  else if (cg.kind === 'recap') await drawRecapCard(c, w, h, data.event, data.count)
  else if (cg.kind === 'countdown') await drawEventCard(c, w, h, data.event, countdownLead(daysUntil(data.event && data.event.date, data.today)))
  else await drawEventCard(c, w, h, data.event, 'Next screening')
}

const toBlobAsync = (canvas) => new Promise(r => canvas.toBlob(r, 'image/png'))

function saveBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

const diaryFileTag = (i) => ({ title: `page-${String(i + 1).padStart(2, '0')}` })

// Render every diary page and hand them to the browser one at a time.
//
// Draws to a DETACHED canvas so the on-screen preview never flickers, and
// reads cg.diary.pages rather than re-fetching, so the page boundaries can't
// shift mid-run. Size is snapshotted up front — otherwise clicking a size
// button mid-batch would silently change the dimensions of later pages.
//
// Browsers gate rapid programmatic downloads: Chrome prompts once on the
// second file, and if that prompt is dismissed the remaining clicks fail
// silently and undetectably. Hence the spacing, and hence the closing toast
// naming that failure mode rather than claiming success.
async function downloadAllDiaryPages(btn) {
  const pages = (cg.diary && cg.diary.pages) || []
  if (cg.batching || !pages.length) return
  cg.batching = true
  const restore = btn.textContent
  const alive = () => document.contains(btn)   // a kind change rebuilds innerHTML mid-loop
  btn.disabled = true
  document.querySelectorAll('.cg-size, #cg-pager button, .cg-copy-all, #cg-diary-page, #cg-download')
    .forEach(b => { b.disabled = true })

  const { w, h } = SIZES[cg.size]
  const off = document.createElement('canvas')
  off.width = w
  off.height = h
  const c = off.getContext('2d')
  await loadFonts()

  try {
    for (let i = 0; i < pages.length; i++) {
      if (alive()) btn.textContent = `Generating ${i + 1} / ${pages.length}…`
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.clearRect(0, 0, w, h)
      c.textBaseline = 'alphabetic'
      await drawDiaryCard(c, w, h, { ...pages[i], page: i + 1, pageCount: pages.length })
      const blob = await toBlobAsync(off)
      if (!blob) throw new Error(`page ${i + 1} failed to encode`)
      saveBlob(blob, socialFileName('diary', cg.size, diaryFileTag(i)))
      await new Promise(r => setTimeout(r, 350))
    }
    ctx.toast(`${pages.length} cards sent — if only the first arrived, allow multiple downloads for this site.`)
  } catch (e) {
    ctx.toast(e.message || String(e), true)
  } finally {
    cg.batching = false
    if (alive()) {
      btn.textContent = restore
      btn.disabled = false
    }
    document.querySelectorAll('.cg-size, #cg-pager button, .cg-copy-all, #cg-diary-page, #cg-download')
      .forEach(b => { b.disabled = false })
    // The blanket re-enable above would resurrect an arrow that syncPager had
    // correctly disabled at an end of the range, leaving a live-looking
    // control that does nothing. Restore the real end-state.
    syncPager()
    if (cg.rendering) setRenderBusy(true)
  }
}

// --- Copy panel ---

function renderCopyPanel() {
  const data = copyData()
  const wrap = document.querySelector('#cg-copy')
  // renderCopyPanel is reachable from a hoisted refresh() and a document-level
  // key handler, either of which can fire after a tab switch has torn this
  // node out mid-async.
  if (!wrap) return
  const d = cg.diary
  const paged = cg.kind === 'diary' && d && d.pageCount > 1
  wrap.innerHTML = PLATFORMS.map(p => {
    const text = buildSocialCopy(cg.kind, p, data)
    const limit = PLATFORM_LIMITS[p]
    return `
      <div class="cg-copy-card" data-platform="${attr(p)}">
        <div class="cg-copy-head">
          <strong>${escapeHtml(PLATFORM_LABELS[p])}</strong>
          ${paged ? `<span class="cg-copy-page">${escapeHtml(`${cg.diaryPage + 1}/${d.pageCount}`)}</span>` : ''}
          <span class="cg-count ${limit && text.length > limit ? 'over' : ''}">${text.length}${limit ? ` / ${limit}` : ''}</span>
          <button type="button" class="cg-copy-btn">copy</button>
          ${paged ? `<button type="button" class="cg-copy-all" title="Copies all ${attr(d.pageCount)} pages as generated — not your edits">all ${escapeHtml(String(d.pageCount))}</button>` : ''}
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
      // Every post type discards edits on the next refresh and always has.
      // Mark the card so that loss is visible rather than silent — applied to
      // all nine kinds, since scoping it to diary would invent a new
      // inconsistency rather than remove one.
      card.classList.add('dirty')
    })
  })
  wrap.querySelectorAll('.cg-copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.cg-copy-card')
      await navigator.clipboard.writeText(card.querySelector('textarea').value)
      ctx.toast(`${PLATFORM_LABELS[card.dataset.platform]} copy copied to clipboard`)
    })
  })
  // Deliberately NOT .cg-copy-btn: that selector above would bind the
  // single-page handler to this button too, and its clipboard write would
  // immediately overwrite the series with one page.
  wrap.querySelectorAll('.cg-copy-all').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.cg-copy-card')
      const platform = card.dataset.platform
      await navigator.clipboard.writeText(diarySeriesCopy(platform, cg.diary.pages))
      ctx.toast(`${PLATFORM_LABELS[platform]} · all ${cg.diary.pageCount} pages copied — split on the ───── page lines`)
    })
  })
}

// --- Tab renderer (called by admin.js) ---

export async function renderContentGen(context) {
  ctx = context
  await loadEvents()
  if (cg.kind === 'roundup') await loadRoundup()
  if (cg.kind === 'diary') await loadDiary()
  if (cg.kind === 'episode') await loadEpisodes()
  if (cg.kind === 'voice') await loadVoicePrompt()
  if (cg.kind === 'milestone') await loadMembersCount()
  if (!cg.events.some(e => e.id === cg.eventId)) cg.eventId = cg.events[0]?.id || null
  if (!wrapMonths().includes(cg.wrapMonth)) cg.wrapMonth = wrapMonths()[0] || null
  if (cg.episodes && cg.episodeIdx >= cg.episodes.length) cg.episodeIdx = 0
  // Switching env (prod <-> staging) or a data refresh can shrink pageCount
  // below a stored index, same hazard episodeIdx has above.
  if (!cg.diary || cg.diaryPage >= cg.diary.pageCount) cg.diaryPage = 0

  const needsEvent = ['announce', 'countdown', 'recap'].includes(cg.kind)
  const emptyMsg =
    needsEvent && !cg.events.length ? 'No events in KV — create one on the Events tab first.'
    : cg.kind === 'roundup' && !(cg.roundup && cg.roundup.films.length) ? 'No member watches logged in the last 7 days — nothing to round up.'
    : cg.kind === 'diary' && !(cg.diary && cg.diary.pageCount)
      ? (cg.diaryDays
          ? `No member watches logged in the last ${cg.diaryDays} days — widen the range to page the whole feed.`
          : 'No dated member watches — nothing to page.')
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
    diary: () => {
      const d = cg.diary
      const pages = d.pages || []
      const shownFilms = pages.reduce((n, p) => n + p.films.length, 0)
      const capped = d.pageCount < d.availablePages
      // "30 of 121 films" when capped — the count must describe what will
      // actually be generated, not the scope it was drawn from.
      const count = `${capped ? `${shownFilms} of ${d.total}` : d.total} film${d.total === 1 ? '' : 's'} · ${d.entries} entries`
      const rangeSel = cg.diaryDays == null ? 'all' : String(cg.diaryDays)
      // The Range select renders even when the window came back empty —
      // otherwise picking "Last 7 days" in a quiet week hides the only
      // control that could widen it again.
      const range = `
      <label>Range
        <select id="cg-diary-range">
          ${DIARY_RANGES.map(r => `<option value="${attr(r.value)}" ${r.value === rangeSel ? 'selected' : ''}>${escapeHtml(r.label)}</option>`).join('')}
        </select>
      </label>`
      if (!d.pageCount) return range
      return `${range}
      <label>Max pages
        <input id="cg-diary-pages" type="number" min="1" max="${attr(d.availablePages)}"
               value="${attr(cg.diaryMaxPages || d.availablePages)}" style="width:64px">
      </label>
      <label>Jump to page
        <select id="cg-diary-page">
          ${pages.map((p, i) => {
            // Label every option with its real date range, so a stale page is
            // visible BEFORE it's generated rather than after it's posted.
            const range = fmtDiaryRange(p.from, p.to)
            return `<option value="${i}" ${i === cg.diaryPage ? 'selected' : ''}>${escapeHtml(`Page ${i + 1}${range ? ` · ${range}` : ''}`)}</option>`
          }).join('')}
        </select>
      </label>
      <span class="cg-diary-count muted">${escapeHtml(`${count}${capped ? ` · ${d.availablePages} pages available` : ''}`)}</span>`
    },
    voice: () => {
      const p = cg.voicePrompt || DEFAULT_VOICE_PROMPT
      const isDefault = p.id === DEFAULT_VOICE_PROMPT.id && p.text === DEFAULT_VOICE_PROMPT.text
      // Read-only on purpose: one prompt is live at a time and the site, the
      // newsletter CTA and this card must all quote the same one. Editing it
      // here would fork that.
      return `<span class="cg-voice-prompt muted">Prompt <code>${escapeHtml(p.id)}</code>${isDefault ? ' (site default)' : ''}${p.deadline ? ` · due ${escapeHtml(fmtSocialDate(p.deadline, { short: true }))}` : ''} — change it on the Config tab</span>`
    },
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
    : cg.kind === 'diary' && cg.diary ? controls.diary()
    : cg.kind === 'voice' ? controls.voice()
    : cg.kind === 'episode' && cg.episodes && cg.episodes.length ? controls.episode()
    : cg.kind === 'monthwrap' && cg.wrapMonth ? controls.month()
    : cg.kind === 'milestone' ? controls.stat()
    : ''

  ctx.content().innerHTML = `
    <h2>Content Gen</h2>
    <p class="section-hint">Social media copy + downloadable cards from live ${escapeHtml(ctx.env())} data.
      Output is public-safe by construction: host addresses/notes never leave KV, and member watches carry
      film titles and posters only — no names, no handles. The roundup aggregates the last 7 days; the diary
      pages the whole feed newest-first, labelling each page with its real date range, and shows the club's
      average rating rather than any one member's. The voice prompt card quotes whatever is live in Config.</p>

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
          ${cg.kind === 'diary' && cg.diary && cg.diary.pageCount > 1
            ? `<button type="button" id="cg-download-all">Download all ${cg.diary.pageCount} pages</button>`
            : ''}
        </div>
      </section>
      <section class="cg-copy-panel">
        <h3>Copy</h3>
        ${cg.kind === 'diary' && cg.diary && cg.diary.pageCount ? `
        <div class="cg-pager" id="cg-pager">
          <button type="button" id="cg-page-prev" aria-label="Previous page" title="Previous page">&lsaquo;</button>
          <strong id="cg-page-now" aria-live="polite"></strong>
          <span class="muted" id="cg-page-range"></span>
          <button type="button" id="cg-page-next" aria-label="Next page" title="Next page">&rsaquo;</button>
        </div>` : ''}
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
  const diaryRange = document.querySelector('#cg-diary-range')
  if (diaryRange) diaryRange.addEventListener('change', async () => {
    const pick = DIARY_RANGES.find(r => r.value === diaryRange.value) || DIARY_RANGES[2]
    cg.diaryDays = pick.days
    cg.diaryPage = 0
    // A new window changes how many pages exist, so an existing cap may now
    // exceed them — drop it rather than silently clamping to a stale number.
    cg.diaryMaxPages = null
    await ctx.withBusy(() => renderContentGen(ctx))
  })
  const diaryPages = document.querySelector('#cg-diary-pages')
  if (diaryPages) diaryPages.addEventListener('change', async () => {
    const avail = cg.diary.availablePages
    const n = Math.max(1, Math.min(avail, Math.floor(Number(diaryPages.value)) || avail))
    cg.diaryMaxPages = n >= avail ? null : n
    cg.diaryPage = 0
    await ctx.withBusy(() => renderContentGen(ctx))
  })
  const diarySel = document.querySelector('#cg-diary-page')
  if (diarySel) diarySel.addEventListener('change', () => {
    gotoDiaryPage(Number(diarySel.value) || 0, refresh)
  })
  const prevBtn = document.querySelector('#cg-page-prev')
  if (prevBtn) prevBtn.addEventListener('click', () => gotoDiaryPage(cg.diaryPage - 1, refresh))
  const nextBtn = document.querySelector('#cg-page-next')
  if (nextBtn) nextBtn.addEventListener('click', () => gotoDiaryPage(cg.diaryPage + 1, refresh))
  diaryRefresh = refresh
  bindDiaryKeys()
  syncPager()
  const dlAll = document.querySelector('#cg-download-all')
  if (dlAll) dlAll.addEventListener('click', () => downloadAllDiaryPages(dlAll))
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
        : cg.kind === 'voice' ? { title: (cg.voicePrompt || DEFAULT_VOICE_PROMPT).id }
        : cg.kind === 'milestone' ? { title: cg.stat }
        : cg.kind === 'diary' ? diaryFileTag(cg.diaryPage)
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
  loadFonts, drawEventCard, drawRecapCard, drawRoundupCard, drawDiaryCard, drawVoicePromptCard,
  drawLineupCard, drawMonthwrapCard, drawEpisodeCard, drawMilestoneCard,
}
