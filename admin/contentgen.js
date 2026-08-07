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
  fmtSocialDate, fmtShowtime, PLATFORM_LIMITS, PLATFORM_LABELS,
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
  weekof: 'Week-of reminder',
  dayof: 'Day-of reminder',
  recap: 'Post-event recap',
  roundup: 'Member watches roundup',
}

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

const currentEvent = () => cg.events.find(e => e.id === cg.eventId) || cg.events[0] || null

function copyData() {
  if (cg.kind === 'roundup') return cg.roundup || { films: [], total: 0 }
  const event = currentEvent()
  return { event, count: event ? (cg.attendCounts[event.id] || 0) : 0 }
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

function footer(c, W, H, pad, url) {
  c.fillStyle = BRAND
  c.fillRect(pad, H - pad - 6, Math.round(W * 0.075), 6)
  c.font = `500 ${Math.round(W * 0.024)}px ${LABEL}`
  c.letterSpacing = '2px'
  c.fillStyle = PAPER_4
  c.fillText(url.toUpperCase(), pad, H - pad - 22)
  c.letterSpacing = '0px'
}

// --- Card templates ---

async function drawEventCard(c, W, H, event, kind) {
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

  const leads = { announce: 'Next screening', weekof: 'This week', dayof: 'Tonight' }
  label(c, `Jackson Film Club · ${leads[kind] || leads.announce}`, tx, ty, Math.round(W * 0.021))
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

async function drawRoundupCard(c, W, H, { films = [], total = 0 } = {}) {
  const pad = Math.round(W * 0.065)
  c.fillStyle = INK
  c.fillRect(0, 0, W, H)

  const posters = (await Promise.all(films.map(f => loadImage(f.poster)))).filter(Boolean)
  const bandH = Math.round(H * (H > W ? 0.3 : 0.38))
  const gridH = H - bandH

  if (posters.length) {
    const tall = H > W * 1.2
    const n = Math.min(posters.length, 8)
    const cols = tall ? 2 : n >= 6 ? Math.min(4, n) : n >= 4 ? 2 : n
    const rows = Math.ceil(n / cols)
    const cw = W / cols
    const ch = gridH / rows
    for (let i = 0; i < n; i++) {
      const gx = (i % cols) * cw
      const gy = Math.floor(i / cols) * ch
      c.fillStyle = SURFACE
      c.fillRect(gx, gy, Math.ceil(cw), Math.ceil(ch))
      drawCover(c, posters[i], gx, gy, Math.ceil(cw), Math.ceil(ch))
    }
    const fade = c.createLinearGradient(0, gridH - 120, 0, gridH)
    fade.addColorStop(0, 'rgba(16,15,14,0)')
    fade.addColorStop(1, 'rgba(16,15,14,1)')
    c.fillStyle = fade
    c.fillRect(0, gridH - 120, W, 120)
  }

  let ty = gridH + Math.round(bandH * 0.16)
  c.textBaseline = 'top'
  label(c, 'Jackson Film Club', pad, ty, Math.round(W * 0.019))
  ty += Math.round(W * 0.022)

  let hPx = Math.round(W * 0.052)
  c.font = `800 ${hPx}px ${DISPLAY}`
  let lines = wrapText(c, 'What the club is watching', W - pad * 2)
  c.fillStyle = PAPER
  for (const line of lines) {
    c.fillText(line, pad, ty)
    ty += Math.round(hPx * 1.12)
  }
  ty += Math.round(hPx * 0.35)

  c.font = `500 ${Math.round(W * 0.026)}px ${LABEL}`
  c.fillStyle = PAPER_2
  c.fillText(`${total} film${total === 1 ? '' : 's'} logged by members in the last week`, pad, ty)

  footer(c, W, H, pad, 'jxnfilm.club/watched')
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
  else if (cg.kind === 'recap') await drawRecapCard(c, w, h, data.event, data.count)
  else await drawEventCard(c, w, h, data.event, cg.kind)
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
  if (!cg.events.some(e => e.id === cg.eventId)) cg.eventId = cg.events[0]?.id || null

  const isEventKind = cg.kind !== 'roundup'
  const roundupEmpty = !isEventKind && !(cg.roundup && cg.roundup.films.length)
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
      ${isEventKind ? `
      <label>Event
        <select id="cg-event">
          ${cg.events.map(e => `<option value="${attr(e.id)}" ${e.id === cg.eventId ? 'selected' : ''}>${escapeHtml(`${e.date || '????'} — ${e.film || e.title || e.id}`)}</option>`).join('')}
        </select>
      </label>` : `
      <label>Films in collage
        <input id="cg-limit" type="number" min="1" max="8" value="${attr(cg.limit)}" style="width:64px">
      </label>`}
    </section>

    ${roundupEmpty ? '<p class="empty">No member watches logged in the last 7 days — nothing to round up.</p>'
      : !cg.events.length && isEventKind ? '<p class="empty">No events in KV — create one on the Events tab first.</p>' : `
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
  const evSel = document.querySelector('#cg-event')
  if (evSel) evSel.addEventListener('change', () => {
    cg.eventId = evSel.value
    renderCopyPanel()
    renderCanvas().catch(e => ctx.toast(e.message || String(e), true))
  })
  const limitInput = document.querySelector('#cg-limit')
  if (limitInput) limitInput.addEventListener('change', async () => {
    cg.limit = Math.max(1, Math.min(8, Number(limitInput.value) || 8))
    limitInput.value = cg.limit
    await loadRoundup()
    renderCopyPanel()
    renderCanvas().catch(e => ctx.toast(e.message || String(e), true))
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
      a.download = socialFileName(cg.kind, cg.size, cg.kind === 'roundup' ? null : currentEvent())
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    }, 'image/png')
  })

  if ((isEventKind && cg.events.length) || (!isEventKind && !roundupEmpty)) {
    renderCopyPanel()
    renderCanvas().catch(e => ctx.toast(e.message || String(e), true))
  }
}
