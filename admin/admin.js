// jxnfilmclub local admin dashboard — vanilla JS, no build step.
//
// All KV ops route through `/api/kv` which shells to `wrangler kv key …` on
// the server. The trust boundary is your local `wrangler` login; this UI has
// no auth of its own. Binds to 127.0.0.1 only.

const $ = (sel) => document.querySelector(sel)
const env = () => $('#env').value
const content = () => $('#content')

// --- API plumbing ---

async function api(method, path, body) {
  const opts = { method, headers: {} }
  if (body !== undefined) {
    opts.body = body
    opts.headers['Content-Type'] = 'text/plain'
  }
  const res = await fetch(path, opts)
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { error: text || `HTTP ${res.status}` } }
  if (!res.ok) throw new Error(data.error || `${method} ${path} → ${res.status}`)
  return data
}

const qs = (params) => new URLSearchParams(params).toString()
const kvUrl = (params) => `/api/kv?${qs({ env: env(), binding: 'MEMBERS_KV', ...params })}`

const loadKv  = (prefix, binding = 'MEMBERS_KV') =>
  api('GET', `/api/kv?${qs({ env: env(), binding, prefix })}`)
const putKv   = (key, value, binding = 'MEMBERS_KV') =>
  api('PUT', `/api/kv?${qs({ env: env(), binding, key })}`, value)
const delKv   = (key, binding = 'MEMBERS_KV') =>
  api('DELETE', `/api/kv?${qs({ env: env(), binding, key })}`)
const getFile = (path) => api('GET', `/api/file?${qs({ path })}`).then(r => r.content)
const putFile = (path, content) => api('PUT', `/api/file?${qs({ path })}`, content)

// --- UI helpers ---

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function attr(s) { return escapeHtml(s) }

function toast(msg, isErr = false) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.toggle('err', isErr)
  el.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { el.hidden = true }, 3500)
}

async function withBusy(fn) {
  const prev = content().innerHTML
  content().innerHTML = '<p class="muted">Loading…</p>'
  try { await fn() }
  catch (e) {
    content().innerHTML = prev
    toast(e.message || String(e), true)
  }
}

function showModal(title, body) {
  $('#modal-title').textContent = title
  $('#modal-body').textContent = body
  $('#modal').showModal()
}

function tryParse(s) {
  if (s == null) return null
  try { return JSON.parse(s) } catch { return null }
}

function fmtAge(ms) {
  if (!ms) return '—'
  const sec = Math.floor((Date.now() - ms) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

function fmtExpiry(unixSec) {
  if (!unixSec) return '—'
  const ms = unixSec * 1000
  const rem = ms - Date.now()
  if (rem < 0) return 'expired'
  if (rem < 60_000) return `${Math.floor(rem / 1000)}s`
  if (rem < 3_600_000) return `${Math.floor(rem / 60_000)}m`
  return `${Math.floor(rem / 3_600_000)}h`
}

// --- Tab dispatch ---

const TABS = {
  members: renderMembers,
  newsletter: renderNewsletter,
  pending: renderPending,
  sessions: renderSessions,
  revoked: renderRevoked,
  rate: renderRate,
  events: renderEvents,
}

let currentTab = 'members'

async function switchTab(tab) {
  currentTab = tab
  document.querySelectorAll('#tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab)
  })
  await withBusy(() => TABS[tab]())
}

// --- Renderers ---

async function renderMembers() {
  const { keys, values } = await loadKv('member:')
  if (!keys.length) return content().innerHTML = '<p class="empty">No members in KV.</p>'

  const rows = keys.map(k => ({
    keyName: k.name,
    m: tryParse(values[k.name]),
  })).filter(r => r.m)

  content().innerHTML = `
    <h2>Members <span class="muted">(${rows.length})</span></h2>
    <div class="search">
      <input id="filter" type="text" placeholder="filter by name / email / handle / id">
    </div>
    <table id="members-table">
      <thead><tr>
        <th>Name</th><th>Email</th><th>Handle</th><th>Pronouns</th><th>Joined</th><th>ID</th><th>Actions</th>
      </tr></thead>
      <tbody>
        ${rows.map(({ keyName, m }) => `
          <tr data-search="${attr([m.name, m.email, m.handle, m.id].filter(Boolean).join(' ').toLowerCase())}">
            <td>${escapeHtml(m.name)}</td>
            <td>${escapeHtml(m.email)}</td>
            <td>${m.handle ? `<code>@${escapeHtml(m.handle)}</code>` : '<span class="muted">—</span>'}</td>
            <td>${escapeHtml(m.pronouns) || '<span class="muted">—</span>'}</td>
            <td>${escapeHtml(m.joined) || '—'}</td>
            <td><code class="id">${escapeHtml(m.id)}</code></td>
            <td class="actions">
              <button data-action="member-view" data-key="${attr(keyName)}">view</button>
              <button data-action="clear-rate" data-email="${attr(m.email)}">clear rate limits</button>
              ${m.handle ? `<button class="danger" data-action="unlink-lb" data-email="${attr(m.email)}" data-id="${attr(m.id)}" data-handle="${attr(m.handle)}">unlink LB</button>` : ''}
              <button class="danger" data-action="evict-session" data-id="${attr(m.id)}">evict session</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `
  wireFilter($('#filter'), '#members-table tbody tr')
}

async function renderNewsletter() {
  const [membersRes, historyRes] = await Promise.all([
    loadKv('member:'),
    loadKv('newsletter:sent:'),
  ])

  const members = membersRes.keys.map(k => tryParse(membersRes.values[k.name])).filter(Boolean)
  const optedIn = members.filter(m => m.newsletter === true)

  const history = historyRes.keys
    .map(k => tryParse(historyRes.values[k.name]))
    .filter(Boolean)
    .sort((a, b) => (b.at || 0) - (a.at || 0))

  content().innerHTML = `
    <h2>Newsletter</h2>

    <section class="nl-compose">
      <h3>Compose</h3>
      <p class="section-hint">Sends through the Worker (<code>/admin/newsletter/send</code>) for the
        <strong>${escapeHtml(env())}</strong> env. Every email automatically gets a one-click unsubscribe
        link, <code>List-Unsubscribe</code> headers, and the CAN-SPAM postal footer.</p>
      <label>Subject<input id="nl-subject" type="text" placeholder="This month at Jackson Film Club"></label>
      <div class="nl-body">
        <div class="nl-fields">
          <label>HTML body<textarea id="nl-html" rows="12" placeholder="<h1>…</h1>"></textarea></label>
          <label>Plain-text body <span class="muted">— fallback</span><textarea id="nl-text" rows="6" placeholder="…"></textarea></label>
        </div>
        <div class="nl-preview-wrap">
          <label>Preview</label>
          <iframe id="nl-preview" sandbox="" title="HTML preview"></iframe>
        </div>
      </div>
      <div class="toolbar">
        <input id="nl-test-email" type="email" placeholder="you@example.com">
        <button data-action="nl-test">Send test</button>
        <button class="primary" data-action="nl-send">Send to all (${optedIn.length})</button>
      </div>
    </section>

    <section class="nl-recipients">
      <h3>Recipients <span class="muted">(${optedIn.length} opted in / ${members.length} members)</span></h3>
      <div class="search"><input id="nl-filter" type="text" placeholder="filter by name / email / handle"></div>
      <table id="nl-table"><thead><tr>
        <th>Name</th><th>Email</th><th>Newsletter</th><th>Actions</th>
      </tr></thead><tbody>
        ${members.map(m => `
          <tr data-search="${attr([m.name, m.email, m.handle].filter(Boolean).join(' ').toLowerCase())}">
            <td>${escapeHtml(m.name)}</td>
            <td>${escapeHtml(m.email)}</td>
            <td>${m.newsletter === true
              ? '<span class="pill on">✓ opted in</span>'
              : '<span class="pill off">— opted out</span>'}</td>
            <td class="actions">
              <button data-action="nl-toggle" data-email="${attr(m.email)}" data-id="${attr(m.id)}" data-on="${m.newsletter === true ? '1' : ''}">
                ${m.newsletter === true ? 'opt out' : 'opt in'}
              </button>
            </td>
          </tr>
        `).join('')}
      </tbody></table>
    </section>

    <section class="nl-history">
      <h3>Sent history <span class="muted">(${history.length})</span></h3>
      ${history.length ? `
      <table><thead><tr><th>When</th><th>Subject</th><th>Recipients</th></tr></thead><tbody>
        ${history.map(h => `
          <tr>
            <td>${fmtAge(h.at)}</td>
            <td>${escapeHtml(h.subject)}</td>
            <td>${escapeHtml(String(h.count))}</td>
          </tr>
        `).join('')}
      </tbody></table>` : '<p class="empty">Nothing sent yet.</p>'}
    </section>
  `

  // Live HTML preview — mirror the HTML body into the sandboxed iframe.
  const htmlField = $('#nl-html')
  const preview = $('#nl-preview')
  const sync = () => { preview.srcdoc = htmlField.value }
  htmlField.addEventListener('input', sync)
  sync()

  wireFilter($('#nl-filter'), '#nl-table tbody tr')
}

async function renderPending() {
  const { keys, values } = await loadKv('pending:')
  if (!keys.length) return content().innerHTML = '<p class="empty">No pending signups.</p>'

  const rows = keys.map(k => ({
    keyName: k.name,
    email: k.name.slice('pending:'.length),
    expires: k.expiration,
    p: tryParse(values[k.name]),
  }))

  content().innerHTML = `
    <h2>Pending signups <span class="muted">(${rows.length})</span></h2>
    <p class="section-hint">These are signups that haven't completed OTP verification. Cleared automatically after the 10-min TTL — only delete here if a user got stuck.</p>
    <table><thead><tr><th>Email</th><th>Name</th><th>Handle</th><th>Code</th><th>Expires in</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(({ keyName, email, expires, p }) => `
        <tr>
          <td>${escapeHtml(email)}</td>
          <td>${escapeHtml(p?.name) || '—'}</td>
          <td>${p?.handle ? `<code>@${escapeHtml(p.handle)}</code>` : '<span class="muted">—</span>'}</td>
          <td><code>${escapeHtml(p?.code) || '—'}</code></td>
          <td>${fmtExpiry(expires)}</td>
          <td class="actions">
            <button class="danger" data-action="del-key" data-key="${attr(keyName)}">delete</button>
          </td>
        </tr>
      `).join('')}
    </tbody></table>
  `
}

async function renderSessions() {
  const { keys, values } = await loadKv('session:')
  if (!keys.length) return content().innerHTML = '<p class="empty">No active session snapshots.</p>'

  const rows = keys.map(k => ({
    keyName: k.name,
    id: k.name.slice('session:'.length),
    expires: k.expiration,
    s: tryParse(values[k.name]),
  }))

  content().innerHTML = `
    <h2>Session snapshots <span class="muted">(${rows.length})</span></h2>
    <p class="section-hint">Cached member snapshots, 1h TTL. Evicting one forces the next <code>/member/me</code> to re-read <code>member:{email}</code>. Does not revoke the bearer token — for that use the Worker's <code>/session/revoke</code> route (requires the token).</p>
    <table><thead><tr><th>Member ID</th><th>Email</th><th>Name</th><th>Handle</th><th>Expires in</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(({ keyName, id, expires, s }) => `
        <tr>
          <td><code class="id">${escapeHtml(id)}</code></td>
          <td>${escapeHtml(s?.email) || '—'}</td>
          <td>${escapeHtml(s?.name) || '—'}</td>
          <td>${s?.handle ? `<code>@${escapeHtml(s.handle)}</code>` : '<span class="muted">—</span>'}</td>
          <td>${fmtExpiry(expires)}</td>
          <td class="actions">
            <button data-action="member-view" data-key="${attr(keyName)}">view</button>
            <button class="danger" data-action="del-key" data-key="${attr(keyName)}">evict</button>
          </td>
        </tr>
      `).join('')}
    </tbody></table>
  `
}

async function renderRevoked() {
  const { keys } = await loadKv('revoked:')
  if (!keys.length) return content().innerHTML = '<p class="empty">No revoked sessions.</p>'

  content().innerHTML = `
    <h2>Revoked tokens <span class="muted">(${keys.length})</span></h2>
    <p class="section-hint">Tokens explicitly revoked via <code>POST /session/revoke</code>. Auto-expire when the underlying JWT exp passes. Read-only.</p>
    <table><thead><tr><th>JTI</th><th>Expires in</th></tr></thead><tbody>
      ${keys.map(k => `
        <tr>
          <td><code>${escapeHtml(k.name.slice('revoked:'.length))}</code></td>
          <td>${fmtExpiry(k.expiration)}</td>
        </tr>
      `).join('')}
    </tbody></table>
  `
}

async function renderRate() {
  const { keys, values } = await loadKv('rate:')
  if (!keys.length) return content().innerHTML = '<p class="empty">No active rate-limit counters.</p>'

  content().innerHTML = `
    <h2>Rate limits <span class="muted">(${keys.length})</span></h2>
    <p class="section-hint">Live counters and throttles. Delete a specific entry to unblock a user. <code>otp_verify_fail</code> counters with value ≥ 5 are the lockouts.</p>
    <table><thead><tr><th>Key</th><th>Value</th><th>Expires in</th><th>Actions</th></tr></thead><tbody>
      ${keys.map(k => {
        const raw = values[k.name] ?? ''
        const isLockout = k.name.includes('verify_fail') && Number(raw) >= 5
        return `
        <tr ${isLockout ? 'style="background:#fff3e0"' : ''}>
          <td><code>${escapeHtml(k.name)}</code>${isLockout ? ' <strong style="color:var(--warn)">⚠ lockout</strong>' : ''}</td>
          <td>${escapeHtml(raw)}</td>
          <td>${fmtExpiry(k.expiration)}</td>
          <td class="actions">
            <button class="danger" data-action="del-key" data-key="${attr(k.name)}">clear</button>
          </td>
        </tr>
      `}).join('')}
    </tbody></table>
  `
}

// --- Events tab (ATTENDANCE_KV: event:{id} canonical + events:all aggregate) ---
//
// Events are now KV-driven. The public site reads them via the Worker's
// `GET /events` endpoint, so saves here appear immediately on `/events`.
// snapshot-events.yml commits data/events.json from the Worker every 6h
// as the archival / fallback source.

let eventsCache = null
let attendanceCache = null

async function renderEvents() {
  // Read per-event KV rows first; if the namespace is empty, bootstrap from
  // the events:all aggregate (which the Worker seeded from data/events.json).
  const perEvent = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'event:' })}`)
  if (perEvent.keys.length) {
    eventsCache = perEvent.keys.map(k => tryParse(perEvent.values[k.name])).filter(Boolean)
  } else {
    const aggRaw = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'events:all' })}`)
    const aggValue = aggRaw.values['events:all']
    eventsCache = tryParse(aggValue) || []
  }
  // Sort by date for a stable, readable list.
  eventsCache.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))

  const attendanceRaw = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'attend:' })}`)
  attendanceCache = {}
  for (const k of attendanceRaw.keys) {
    const eventId = k.name.slice('attend:'.length)
    attendanceCache[eventId] = tryParse(attendanceRaw.values[k.name]) || []
  }

  content().innerHTML = `
    <h2>Events <span class="muted">(${eventsCache.length})</span></h2>
    <p class="section-hint">Edits write directly to <code>ATTENDANCE_KV</code> and appear on <code>/events</code> immediately via the Worker. <code>data/events.json</code> is the cron-snapshotted archive (every 6h).</p>
    <div class="toolbar">
      <button class="primary" data-action="event-new">+ new event</button>
    </div>
    <div id="events-list">${renderEventCards()}</div>
  `
}

// Write per-event row + patch events:all aggregate in lockstep so the
// Worker's GET /events reflects the change on the next read.
async function writeEventKv(ev) {
  await putKv(`event:${ev.id}`, JSON.stringify(ev), 'ATTENDANCE_KV')
  const aggRaw = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'events:all' })}`)
  const agg = tryParse(aggRaw.values['events:all']) || []
  const idx = agg.findIndex(e => e.id === ev.id)
  if (idx === -1) agg.push(ev)
  else agg[idx] = ev
  await putKv('events:all', JSON.stringify(agg), 'ATTENDANCE_KV')
}

async function deleteEventKv(id) {
  await delKv(`event:${id}`, 'ATTENDANCE_KV').catch(() => {})
  const aggRaw = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'events:all' })}`)
  const agg = tryParse(aggRaw.values['events:all']) || []
  const next = agg.filter(e => e.id !== id)
  await putKv('events:all', JSON.stringify(next), 'ATTENDANCE_KV')
}

function renderEventCards() {
  if (!eventsCache.length) return '<p class="empty">No events yet.</p>'
  return eventsCache.map((e, i) => `
    <div class="event-form" data-idx="${i}">
      <div class="grid">
        <div><label>ID</label><input type="text" name="id" value="${attr(e.id)}" readonly></div>
        <div><label>Title</label><input type="text" name="title" value="${attr(e.title || '')}"></div>
        <div><label>Film</label><input type="text" name="film" value="${attr(e.film || '')}"></div>
        <div><label>Year</label><input type="number" name="year" value="${attr(e.year || '')}"></div>
        <div><label>Date</label><input type="date" name="date" value="${attr(e.date || '')}"></div>
        <div><label>Venue</label><input type="text" name="venue" value="${attr(e.venue || '')}"></div>
        <div><label>Poster URL</label><input type="url" name="poster" value="${attr(e.poster || '')}"></div>
        <div><label>Letterboxd URI</label><input type="url" name="letterboxd_uri" value="${attr(e.letterboxd_uri || '')}"></div>
      </div>
      <div class="toolbar">
        <button class="primary" data-action="event-save" data-idx="${i}">save</button>
        <button class="danger" data-action="event-del" data-idx="${i}">delete event</button>
      </div>
      <div class="attendance">
        <strong>Attendance (${(attendanceCache[e.id] || []).length})</strong>
        <ul>
          ${(attendanceCache[e.id] || []).map(name => `
            <li>${escapeHtml(name)}
              <button class="danger" data-action="attend-rm" data-event="${attr(e.id)}" data-name="${attr(name)}">remove</button>
            </li>
          `).join('') || '<li class="muted">no attendees</li>'}
        </ul>
      </div>
    </div>
  `).join('')
}

// --- Filter helper ---

function wireFilter(input, rowSelector) {
  if (!input) return
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim()
    document.querySelectorAll(rowSelector).forEach(tr => {
      tr.hidden = q && !tr.dataset.search.includes(q)
    })
  })
}

// --- Action dispatch ---

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]')
  if (!btn) return
  const a = btn.dataset.action

  try {
    if (a === 'del-key') {
      const key = btn.dataset.key
      if (!confirm(`Delete KV key:\n${key}\n\nThis is permanent.`)) return
      await delKv(key, currentTab === 'events' ? 'ATTENDANCE_KV' : 'MEMBERS_KV')
      toast(`Deleted ${key}`)
      await switchTab(currentTab)
    }
    else if (a === 'member-view') {
      const key = btn.dataset.key
      const { values } = await loadKv(key)
      showModal(key, JSON.stringify(tryParse(values[key]) ?? values[key], null, 2))
    }
    else if (a === 'clear-rate') {
      const email = btn.dataset.email
      if (!confirm(`Clear all rate-limit counters for ${email}?`)) return
      const prefixes = [
        'rate:otp_send:', 'rate:signup_send:',
        'rate:otp_verify_fail:', 'rate:signup_verify_fail:',
      ]
      let cleared = 0
      for (const p of prefixes) {
        try { await delKv(p + email); cleared++ } catch (e) { /* may not exist */ }
      }
      toast(`Cleared ${cleared} counter(s) for ${email}`)
    }
    else if (a === 'unlink-lb') {
      const { email, handle, id } = btn.dataset
      if (!confirm(`Force-unlink @${handle} from ${email}?\n\nThis updates MEMBERS_KV (member row + reverse indices + pending token + session snapshot) AND data/members.json in this checkout. Commit the JSON diff afterward.`)) return
      // KV side
      const { values } = await loadKv(`member:${email}`)
      const member = tryParse(values[`member:${email}`])
      if (member) {
        delete member.handle
        await putKv(`member:${email}`, JSON.stringify(member))
      }
      await delKv(`email:${handle}`).catch(() => {})
      await delKv(`handle:${email}`).catch(() => {})
      if (id) await delKv(`session:${id}`).catch(() => {})
      // JSON projection
      const raw = await getFile('data/members.json')
      const all = JSON.parse(raw)
      const idx = all.findIndex(m => m.id === id)
      if (idx !== -1) {
        delete all[idx].handle
        await putFile('data/members.json', JSON.stringify(all, null, 2) + '\n')
      }
      toast(`Unlinked @${handle} from ${email}`)
      await switchTab(currentTab)
    }
    else if (a === 'evict-session') {
      const id = btn.dataset.id
      if (!confirm(`Evict session:${id}?\n\nDeletes the cached snapshot only. Bearer token stays valid until exp (max 1h).`)) return
      try { await delKv(`session:${id}`) } catch { /* may not exist */ }
      toast(`Evicted session:${id}`)
      await switchTab(currentTab)
    }
    else if (a === 'nl-toggle') {
      const { email, id } = btn.dataset
      const turningOn = btn.dataset.on !== '1'
      const { values } = await loadKv(`member:${email}`)
      const member = tryParse(values[`member:${email}`])
      if (!member) { toast(`No member row for ${email}`, true); return }
      member.newsletter = turningOn
      await putKv(`member:${email}`, JSON.stringify(member))
      // Evict the cached snapshot so the next /member/me re-reads the flag.
      if (id) await delKv(`session:${id}`).catch(() => {})
      toast(`${email} ${turningOn ? 'opted in' : 'opted out'}`)
      await switchTab(currentTab)
    }
    else if (a === 'nl-test') {
      const subject = $('#nl-subject').value.trim()
      const html = $('#nl-html').value
      const text = $('#nl-text').value
      const testTo = $('#nl-test-email').value.trim()
      if (!subject || (!html && !text)) { toast('Subject and a body are required', true); return }
      if (!testTo) { toast('Enter a test email address', true); return }
      const body = JSON.stringify({ subject, html: html || undefined, text: text || undefined, testTo })
      const r = await api('POST', `/api/newsletter/send?${qs({ env: env() })}`, body)
      toast(`Test sent to ${testTo} (${r.sent})`)
    }
    else if (a === 'nl-send') {
      const subject = $('#nl-subject').value.trim()
      const html = $('#nl-html').value
      const text = $('#nl-text').value
      if (!subject || (!html && !text)) { toast('Subject and a body are required', true); return }
      const count = document.querySelectorAll('#nl-table .pill.on').length
      if (!confirm(`Send "${subject}" to ${count} opted-in member(s) on ${env()}?\n\nThis emails real people.`)) return
      const body = JSON.stringify({ subject, html: html || undefined, text: text || undefined })
      const r = await api('POST', `/api/newsletter/send?${qs({ env: env() })}`, body)
      toast(`Sent to ${r.sent} member(s)`)
      await switchTab(currentTab)
    }
    else if (a === 'event-save') {
      const idx = Number(btn.dataset.idx)
      const form = btn.closest('.event-form')
      const updated = { ...eventsCache[idx] }
      form.querySelectorAll('input').forEach(input => {
        const v = input.value.trim()
        if (input.name === 'year') updated.year = v ? Number(v) : undefined
        else if (v) updated[input.name] = v
        else delete updated[input.name]
      })
      eventsCache[idx] = updated
      await writeEventKv(updated)
      toast(`Saved event "${updated.title || updated.id}"`)
    }
    else if (a === 'event-del') {
      const idx = Number(btn.dataset.idx)
      const ev = eventsCache[idx]
      if (!confirm(`Delete event "${ev.title || ev.id}"?\n\nClears event:${ev.id} from ATTENDANCE_KV and removes it from the events:all aggregate. Attendance (attend:${ev.id}) is kept — clear it separately if desired.`)) return
      await deleteEventKv(ev.id)
      eventsCache.splice(idx, 1)
      toast(`Deleted event`)
      await switchTab(currentTab)
    }
    else if (a === 'event-new') {
      const id = prompt('Event id (slug, e.g. "2026-03-screening"):')
      if (!id) return
      if (eventsCache.some(e => e.id === id)) {
        toast(`Event id "${id}" already exists`, true)
        return
      }
      const fresh = { id, title: 'Untitled', date: new Date().toISOString().slice(0, 10) }
      eventsCache.push(fresh)
      await writeEventKv(fresh)
      toast(`Created event "${id}"`)
      await switchTab(currentTab)
    }
    else if (a === 'attend-rm') {
      const { event: eventId, name } = btn.dataset
      if (!confirm(`Remove ${name} from attendance for ${eventId}?`)) return
      const list = (attendanceCache[eventId] || []).filter(n => n !== name)
      await putKv(`attend:${eventId}`, JSON.stringify(list), 'ATTENDANCE_KV')
      // Patch the aggregate too so /events/attendance reflects the change.
      const aggregateRaw = await loadKv('attendance:all', 'ATTENDANCE_KV')
      const aggregateValue = aggregateRaw.values['attendance:all']
      const aggregate = tryParse(aggregateValue) || {}
      aggregate[eventId] = list
      await putKv('attendance:all', JSON.stringify(aggregate), 'ATTENDANCE_KV')
      toast(`Removed ${name} from ${eventId}`)
      await switchTab(currentTab)
    }
  } catch (err) {
    toast(err.message || String(err), true)
  }
})

// --- Bootstrap ---

document.body.dataset.env = env()
$('#env').addEventListener('change', () => {
  document.body.dataset.env = env()
  switchTab(currentTab)
})
$('#refresh').addEventListener('click', () => switchTab(currentTab))
document.querySelectorAll('#tabs button').forEach(b => {
  b.addEventListener('click', () => switchTab(b.dataset.tab))
})

api('GET', '/api/whoami').then(({ wrangler }) => {
  // First line of `wrangler whoami` output: usually the account email or "Not logged in".
  $('#whoami').textContent = (wrangler || '').split('\n').find(l => l.trim()) || ''
}).catch(() => {
  $('#whoami').textContent = '(wrangler check failed)'
})

switchTab('members')
