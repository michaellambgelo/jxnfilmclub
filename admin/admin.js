// jxnfilmclub admin dashboard — vanilla JS, no build step.
//
// Dual-mode: served by admin/server.mjs on 127.0.0.1 (local — KV ops shell
// to `wrangler`, trust boundary is your wrangler login) or by the admin
// Worker at admin.jxnfilm.club (hosted — direct KV bindings behind
// Cloudflare Access + a JWT gate). Same /api surface either way, except
// /api/file (members.json patching) which is local-only.
const HOSTED = !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)

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

function fmtJoined(iso) {
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

function fmtExpiry(unixSec) {
  if (!unixSec) return '—'
  const ms = unixSec * 1000
  const rem = ms - Date.now()
  if (rem < 0) return 'expired'
  if (rem < 60_000) return `${Math.floor(rem / 1000)}s`
  if (rem < 3_600_000) return `${Math.floor(rem / 60_000)}m`
  if (rem < 86_400_000) return `${Math.floor(rem / 3_600_000)}h`
  return `${Math.floor(rem / 86_400_000)}d`
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
            <td>${fmtJoined(m.joined)}</td>
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

// Default compose template — email-safe (single table, inline styles, no
// external CSS) so it renders in Gmail/Outlook/Apple Mail as-is. The Worker
// appends the unsubscribe + postal footer automatically; don't add one here.
// Palette mirrors css/tokens.css: ink #100f0e, paper #f0ebe0, brand #d7321f.
const NEWSLETTER_TEMPLATE_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ea;padding:24px 0">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff">
      <tr>
        <td align="center" style="background:#100f0e;padding:28px 24px">
          <img src="https://jxnfilm.club/img/logo.png" width="96" height="96" alt="Jackson Film Club" style="display:block;border:0">
          <p style="margin:14px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:1px;color:#f0ebe0">Jackson Film Club</p>
        </td>
      </tr>
      <tr>
        <td style="padding:32px 32px 24px;font-family:Georgia,'Times New Roman',serif;color:#1c1a17">
          <h1 style="margin:0 0 16px;font-size:26px;line-height:1.25;color:#100f0e">This month at the club</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6">Hi everyone — here's what's coming up. Replace this copy with the announcement: the film, the date, the venue, and anything folks should bring.</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6"><strong>Next screening:</strong> <em>Film Title</em> (Year) — Saturday, Month 0 at 7:00 PM.</p>
          <p style="margin:0 0 24px;font-size:16px;line-height:1.6">RSVP and details are on the events page.</p>
          <p style="margin:0"><a href="https://jxnfilm.club/events" style="display:inline-block;background:#d7321f;color:#ffffff;text-decoration:none;font-size:16px;padding:12px 24px;border-radius:4px">See upcoming events</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`

// handle → display name for the "latest watches" section; refreshed on every
// Newsletter tab render so inserts use the same member list the tab shows.
let nlHandleNames = {}

// Email-safe "latest from members" section. Mirrors the compose template's
// structure (bg band + centered 600px white card, Georgia, brand red) so the
// inserted block reads as a continuation of the card above it.
function buildWatchedSectionHtml(entries) {
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

function buildWatchedSectionText(entries) {
  const lines = entries.map(e =>
    `- ${e.title}${e.year ? ` (${e.year})` : ''} — ${e.name || '@' + e.handle}${e.watched_date ? ', ' + e.watched_date : ''}\n  ${e.link}`)
  return `Latest from members on Letterboxd:\n${lines.join('\n')}\n\nSee all member activity: https://jxnfilm.club/watched`
}

async function renderNewsletter() {
  const [membersRes, historyRes] = await Promise.all([
    loadKv('member:'),
    loadKv('newsletter:sent:'),
  ])

  const members = membersRes.keys.map(k => tryParse(membersRes.values[k.name])).filter(Boolean)
  const optedIn = members.filter(m => m.newsletter === true)
  nlHandleNames = Object.fromEntries(members.filter(m => m.handle).map(m => [m.handle, m.name]))

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
          <label>HTML body<textarea id="nl-html" rows="12" placeholder="<h1>…</h1>">${escapeHtml(NEWSLETTER_TEMPLATE_HTML)}</textarea></label>
          <label>Plain-text body <span class="muted">— fallback</span><textarea id="nl-text" rows="6" placeholder="…"></textarea></label>
        </div>
        <div class="nl-preview-wrap">
          <label>Preview <span class="muted">— editable; edits sync back to the HTML</span></label>
          <div class="nl-fmt" id="nl-fmt">
            <button type="button" data-cmd="bold" title="Bold"><strong>B</strong></button>
            <button type="button" data-cmd="italic" title="Italic"><em>I</em></button>
            <button type="button" data-cmd="h1" title="Heading">H1</button>
            <button type="button" data-cmd="h2" title="Subheading">H2</button>
            <button type="button" data-cmd="p" title="Paragraph">¶</button>
            <button type="button" data-cmd="insertUnorderedList" title="Bulleted list">• list</button>
            <button type="button" data-cmd="createLink" title="Turn selection into a link">link</button>
            <button type="button" data-cmd="removeFormat" title="Clear inline formatting">clear</button>
          </div>
          <iframe id="nl-preview" sandbox="allow-same-origin" title="HTML preview — editable"></iframe>
        </div>
      </div>
      <div class="toolbar">
        <input id="nl-watched-count" type="number" min="1" max="30" value="8" title="How many entries to insert" style="width:64px">
        <button data-action="nl-insert-watched" title="Append the latest member Letterboxd diary entries as a styled section">Insert member watches</button>
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

  wireNewsletterPreview($('#nl-html'), $('#nl-preview'), $('#nl-fmt'))
  wireFilter($('#nl-filter'), '#nl-table tbody tr')
}

// Two-way compose editing: the textarea stays the source of truth (sends
// read its value), the preview iframe doubles as a WYSIWYG surface over the
// same HTML. sandbox=allow-same-origin lets this script drive the iframe
// document while still refusing to execute anything in pasted HTML (no
// allow-scripts).
function wireNewsletterPreview(htmlField, preview, toolbar) {
  // textarea → preview. Replaces the iframe document, so the editing
  // wiring re-attaches on every load below.
  const syncToPreview = () => { preview.srcdoc = htmlField.value }

  // preview → textarea. Serializes the parsed body — the parser normalizes
  // the source formatting, which is fine: the DOM is what gets emailed.
  const syncFromPreview = () => { htmlField.value = preview.contentDocument.body.innerHTML }

  htmlField.addEventListener('input', syncToPreview)

  preview.addEventListener('load', () => {
    const doc = preview.contentDocument
    doc.designMode = 'on'
    doc.addEventListener('input', syncFromPreview)
  })

  // mousedown would move focus out of the iframe and drop its text
  // selection before the command runs — suppress it for the toolbar.
  toolbar.addEventListener('mousedown', (e) => e.preventDefault())
  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]')
    if (!btn) return
    const doc = preview.contentDocument
    const cmd = btn.dataset.cmd
    preview.contentWindow.focus()
    if (cmd === 'h1' || cmd === 'h2' || cmd === 'p') {
      doc.execCommand('formatBlock', false, '<' + cmd + '>')
    } else if (cmd === 'createLink') {
      const url = prompt('Link URL (https://…):')
      if (url) doc.execCommand('createLink', false, url)
    } else {
      doc.execCommand(cmd, false, null)
    }
    syncFromPreview()
  })

  syncToPreview()
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
  const [{ keys, values }, { keys: refreshKeys, values: refreshValues }] =
    await Promise.all([loadKv('session:'), loadKv('refresh:')])

  const rows = keys.map(k => ({
    keyName: k.name,
    id: k.name.slice('session:'.length),
    expires: k.expiration,
    s: tryParse(values[k.name]),
  }))

  // refresh:{id}:{secret} — split on the LAST colon; ids are opaque.
  const devices = refreshKeys.map(k => {
    const rest = k.name.slice('refresh:'.length)
    const cut = rest.lastIndexOf(':')
    return {
      keyName: k.name,
      id: rest.slice(0, cut),
      secret: rest.slice(cut + 1),
      expires: k.expiration,
      r: tryParse(refreshValues[k.name]),
    }
  })

  const snapshotsTable = rows.length ? `
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
  ` : '<p class="empty">No active session snapshots.</p>'

  const devicesTable = devices.length ? `
    <table><thead><tr><th>Member ID</th><th>Email</th><th>Token</th><th>Expires in</th><th>Actions</th></tr></thead><tbody>
      ${devices.map(({ keyName, id, secret, expires, r }) => `
        <tr>
          <td><code class="id">${escapeHtml(id)}</code></td>
          <td>${escapeHtml(r?.email) || '—'}</td>
          <td><code>${escapeHtml(secret.slice(0, 6))}…</code></td>
          <td>${fmtExpiry(expires)}</td>
          <td class="actions">
            <button class="danger" data-action="revoke-device" data-key="${attr(keyName)}">revoke</button>
          </td>
        </tr>
      `).join('')}
    </tbody></table>
  ` : '<p class="empty">No remembered devices.</p>'

  content().innerHTML = `
    <h2>Session snapshots <span class="muted">(${rows.length})</span></h2>
    <p class="section-hint">Cached member snapshots, 1h TTL. Evicting one forces the next <code>/member/me</code> to re-read <code>member:{email}</code>. Does not revoke the bearer token — for that use the Worker's <code>/session/revoke</code> route (requires the token).</p>
    ${snapshotsTable}
    <h2>Remembered devices <span class="muted">(${devices.length})</span></h2>
    <p class="section-hint">30-day device refresh tokens from the <i>Remember my login on this device</i> checkbox — one row per opted-in browser, TTL slides forward on each silent refresh. Revoking sends that device back through the email-code flow; a bearer token it already holds stays valid until exp (max 1h).</p>
    ${devicesTable}
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
let eventsSort = 'upcoming'   // module scope — survives tab switches

const attendeeCount = (e) => (attendanceCache[e.id] || []).length

// Dates are YYYY-MM-DD strings — compare them as strings, never as Dates
// (parsing them as UTC instants shifts them a day in America/Chicago).
const EVENT_SORTS = {
  'date-asc': (a, b) => String(a.date || '').localeCompare(String(b.date || '')),
  'date-desc': (a, b) => String(b.date || '').localeCompare(String(a.date || '')),
  title: (a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id), undefined, { sensitivity: 'base' }),
  attendance: (a, b) => attendeeCount(b) - attendeeCount(a) || String(b.date || '').localeCompare(String(a.date || '')),
}

function sortEvents() {
  if (eventsSort === 'upcoming') {
    // Next screening on top (soonest first), then the past newest-first.
    // Undated events sort into the past group, at the bottom.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
    const upcoming = eventsCache.filter(e => String(e.date || '') >= today).sort(EVENT_SORTS['date-asc'])
    const past = eventsCache.filter(e => String(e.date || '') < today).sort(EVENT_SORTS['date-desc'])
    eventsCache = [...upcoming, ...past]
  } else {
    eventsCache.sort(EVENT_SORTS[eventsSort])
  }
}

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
  const attendanceRaw = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'attend:' })}`)
  attendanceCache = {}
  for (const k of attendanceRaw.keys) {
    const eventId = k.name.slice('attend:'.length)
    attendanceCache[eventId] = tryParse(attendanceRaw.values[k.name]) || []
  }

  // Sorted after attendance loads — the attendance sort needs the counts.
  sortEvents()

  content().innerHTML = `
    <h2>Events <span class="muted">(${eventsCache.length})</span></h2>
    <p class="section-hint">Edits write directly to <code>ATTENDANCE_KV</code> and appear on <code>/events</code> immediately via the Worker. <code>data/events.json</code> is the cron-snapshotted archive (every 6h).</p>
    <div class="toolbar">
      <button class="primary" data-action="event-new">+ new event</button>
      <label class="ev-sort-label">sort
        <select id="ev-sort">
          <option value="upcoming">upcoming first</option>
          <option value="date-desc">newest first</option>
          <option value="date-asc">oldest first</option>
          <option value="title">title A–Z</option>
          <option value="attendance">most attended</option>
        </select>
      </label>
    </div>
    <div id="events-list">${renderEventCards()}</div>
  `
  $('#ev-sort').value = eventsSort
  $('#ev-sort').addEventListener('change', () => {
    eventsSort = $('#ev-sort').value
    sortEvents()
    $('#events-list').innerHTML = renderEventCards()
  })
}

// Mirrors worker/src/index.js:publicEventProjection — strips the host's
// private `address` so it never lands in the public events:all aggregate.
function projectEvent(e) {
  if (!e || !e.id) return null
  const out = { id: e.id }
  for (const k of ['title', 'film', 'year', 'date', 'venue', 'poster', 'letterboxd_uri',
                   'hostId', 'hostName', 'capacity', 'kind', 'time']) {
    if (e[k] !== undefined && e[k] !== null && e[k] !== '') out[k] = e[k]
  }
  return out
}

// Write per-event row (full, with private address) + patch events:all with
// the public projection so the Worker's GET /events reflects the change on
// the next read AND can't leak the address.
async function writeEventKv(ev) {
  await putKv(`event:${ev.id}`, JSON.stringify(ev), 'ATTENDANCE_KV')
  const aggRaw = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'events:all' })}`)
  const agg = tryParse(aggRaw.values['events:all']) || []
  const proj = projectEvent(ev)
  const idx = agg.findIndex(e => e.id === ev.id)
  if (idx === -1) agg.push(proj)
  else agg[idx] = proj
  await putKv('events:all', JSON.stringify(agg), 'ATTENDANCE_KV')
}

async function deleteEventKv(id) {
  await delKv(`event:${id}`, 'ATTENDANCE_KV').catch(() => {})
  // Tear down RSVP state too — for hosted screenings these are the canonical
  // attendee list. (.catch swallows "not found" so unhosted events still work.)
  await delKv(`rsvp:${id}`, 'ATTENDANCE_KV').catch(() => {})
  await delKv(`attend:${id}`, 'ATTENDANCE_KV').catch(() => {})
  const aggRaw = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'events:all' })}`)
  const agg = tryParse(aggRaw.values['events:all']) || []
  const next = agg.filter(e => e.id !== id)
  await putKv('events:all', JSON.stringify(next), 'ATTENDANCE_KV')
  // Also prune from the attendance:all aggregate so /events/attendance bulk
  // read doesn't keep returning a phantom entry.
  const attRaw = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'attendance:all' })}`)
  const att = tryParse(attRaw.values['attendance:all']) || {}
  if (att[id] != null) {
    delete att[id]
    await putKv('attendance:all', JSON.stringify(att), 'ATTENDANCE_KV')
  }
}

function renderEventCards() {
  if (!eventsCache.length) return '<p class="empty">No events yet.</p>'
  return eventsCache.map((e, i) => {
    const hosted = !!e.hostId
    return `
    <div class="event-form" data-idx="${i}">
      ${hosted ? `<p class="muted" style="margin:0 0 0.5rem">🏠 Member-hosted (host id <code>${attr(e.hostId)}</code>)</p>` : ''}
      <div class="grid">
        <div><label>ID</label><input type="text" name="id" value="${attr(e.id)}" readonly></div>
        <div><label>Title</label><input type="text" name="title" value="${attr(e.title || '')}"></div>
        <div><label>Film</label><input type="text" name="film" value="${attr(e.film || '')}"></div>
        <div><label>Year</label><input type="number" name="year" value="${attr(e.year || '')}"></div>
        <div><label>Date</label><input type="date" name="date" value="${attr(e.date || '')}"></div>
        <div><label>Venue</label><input type="text" name="venue" value="${attr(e.venue || '')}"></div>
        <div><label>Poster URL</label><input type="url" name="poster" value="${attr(e.poster || '')}"></div>
        <div><label>Letterboxd URI</label><input type="url" name="letterboxd_uri" value="${attr(e.letterboxd_uri || '')}"></div>
        ${hosted ? `
        <div><label>Host name</label><input type="text" name="hostName" value="${attr(e.hostName || '')}"></div>
        <div><label>Kind <span class="muted">— house | meetup</span></label><input type="text" name="kind" value="${attr(e.kind || '')}" placeholder="house | meetup"></div>
        <div><label>Time <span class="muted">— meetup showtime</span></label><input type="time" name="time" value="${attr(e.time || '')}"></div>
        <div><label>Capacity</label><input type="number" name="capacity" min="1" value="${attr(e.capacity || '')}"></div>
        <div style="grid-column:1/-1"><label>Address <span class="muted">— private; only emailed to confirmed RSVPs</span></label>
          <input type="text" name="address" value="${attr(e.address || '')}"></div>
        <div style="grid-column:1/-1"><label>Notes <span class="muted">— included in every RSVP email</span></label>
          <textarea name="notes" rows="3">${escapeHtml(e.notes || '')}</textarea></div>
        ` : ''}
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
  `
  }).join('')
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
      const fileNote = HOSTED
        ? 'data/members.json reconciles via the snapshot cron (≤6h).'
        : 'AND data/members.json in this checkout — commit the JSON diff afterward.'
      if (!confirm(`Force-unlink @${handle} from ${email}?\n\nThis updates MEMBERS_KV (member row + reverse indices + pending token + session snapshot). ${fileNote}`)) return
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
      // JSON projection — local checkout only; the hosted Worker has no
      // filesystem and the 6h snapshot-members cron self-heals the file.
      if (!HOSTED) {
        const raw = await getFile('data/members.json')
        const all = JSON.parse(raw)
        const idx = all.findIndex(m => m.id === id)
        if (idx !== -1) {
          delete all[idx].handle
          await putFile('data/members.json', JSON.stringify(all, null, 2) + '\n')
        }
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
    else if (a === 'revoke-device') {
      const key = btn.dataset.key
      if (!confirm(`Revoke this remembered device?\n\n${key}\n\nIts next silent refresh fails and that browser must log in with an email code again. A bearer token it already holds stays valid until exp (max 1h).`)) return
      await delKv(key)
      toast('Remembered device revoked')
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
    else if (a === 'nl-insert-watched') {
      const limit = Math.max(1, Math.min(30, Number($('#nl-watched-count').value) || 8))
      const map = await api('GET', `/api/watched?${qs({ env: env() })}`)
      const entries = []
      for (const [handle, films] of Object.entries(map || {})) {
        for (const f of (films || [])) {
          if (f && f.title && f.link) entries.push({ ...f, handle, name: nlHandleNames[handle] })
        }
      }
      if (!entries.length) { toast('No member Letterboxd activity to insert', true); return }
      // watched_date is a bare YYYY-MM-DD — sort as strings (never Dates);
      // undated entries sink to the end.
      entries.sort((x, y) => String(y.watched_date || '').localeCompare(String(x.watched_date || '')))
      const top = entries.slice(0, limit)

      const htmlField = $('#nl-html')
      const textField = $('#nl-text')
      htmlField.value = htmlField.value.trimEnd() + '\n' + buildWatchedSectionHtml(top)
      htmlField.dispatchEvent(new Event('input'))  // sync the WYSIWYG preview
      textField.value = (textField.value.trim() ? textField.value.trimEnd() + '\n\n' : '') + buildWatchedSectionText(top)
      toast(`Inserted ${top.length} ${top.length === 1 ? 'entry' : 'entries'} — edit or trim in the preview`)
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
      form.querySelectorAll('input, textarea').forEach(input => {
        const v = (input.value || '').trim()
        if (input.name === 'year' || input.name === 'capacity') {
          updated[input.name] = v ? Number(v) : undefined
        }
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
      const fresh = { id, title: 'Untitled', date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()) }
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

api('GET', '/api/whoami').then(({ wrangler, email }) => {
  // Hosted: the Access-verified email. Local: first line of `wrangler
  // whoami` output — usually the account email or "Not logged in".
  $('#whoami').textContent = email || (wrangler || '').split('\n').find(l => l.trim()) || ''
}).catch(() => {
  $('#whoami').textContent = HOSTED ? '(whoami failed)' : '(wrangler check failed)'
})

switchTab('members')
