// jxnfilmclub admin dashboard — vanilla JS, no build step.
//
// Dual-mode: served by admin/server.mjs on 127.0.0.1 (local — KV ops shell
// to `wrangler`, trust boundary is your wrangler login) or by the admin
// Worker at admin.jxnfilm.club (hosted — direct KV bindings behind
// Cloudflare Access + a JWT gate). Same /api surface either way, except
// /api/file (members.json patching) which is local-only.
const HOSTED = !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)

// Pure helpers live in lib.js so tests/admin/lib.test.js can import them
// without booting the SPA.
import {
  qs, escapeHtml, attr, tryParse, fmtAge, fmtJoined, fmtExpiry,
  buildWatchedSectionHtml, buildWatchedSectionText,
  buildVoiceCtaHtml, buildVoiceCtaText,
  buildEventsSectionHtml, buildEventsSectionText,
  buildPosterBlockHtml, buildPosterBlockText,
  moveItem, normalizeStringList, buildCopyOverrides, sanitizePodcastConfig,
  fmtDuration, fmtBytes, voiceDaysLeft, groupVoiceClips, sanitizeVoicePrompt,
  buildStatsContext, computeMemberStats,
} from './lib.js'
import { renderContentGen } from './contentgen.js'

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
  $('#modal-body').classList.remove('rich')
  $('#modal-body').textContent = body
  $('#modal').showModal()
}

// Rendered-markup variant of showModal. Callers own escaping — every value
// that reaches here goes through escapeHtml/attr first, same as the tables.
function showModalHtml(title, html) {
  $('#modal-title').textContent = title
  $('#modal-body').classList.add('rich')
  $('#modal-body').innerHTML = html
  $('#modal').showModal()
}

// --- Tab dispatch ---

const TABS = {
  members: renderMembers,
  newsletter: renderNewsletter,
  auth: renderAuth,
  events: renderEvents,
  feedback: renderFeedback,
  voice: renderVoice,
  contentgen: () => renderContentGen({ api, env, content, toast, withBusy }),
  config: renderConfig,
  stats: renderStats,
}

// Tab names that existed before Pending/Sessions/Revoked/Rate limits were
// collapsed into Auth — remembered-tab restores from before the collapse
// land on the merged tab instead of falling back to Members.
const LEGACY_AUTH_TABS = ['pending', 'sessions', 'revoked', 'rate']

let currentTab = 'members'

async function switchTab(tab) {
  currentTab = tab
  localStorage.jxnfc_admin_tab = tab
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

  // The public aggregate (what GET /members serves). A handle here without a
  // matching canonical handle means drifted state — surface a "repair LB"
  // button so the canonical unlink cascade can scrub it.
  const aggRes = await loadKv('members:all')
  const agg = Object.fromEntries(
    (tryParse(aggRes.values['members:all']) || []).filter(r => r.handle).map(r => [r.id, r.handle]))

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
              <button data-action="member-stats" data-id="${attr(m.id)}">stats</button>
              <button data-action="member-view" data-key="${attr(keyName)}">view</button>
              <button data-action="clear-rate" data-email="${attr(m.email)}">clear rate limits</button>
              ${(m.handle || agg[m.id]) ? `<button class="danger" data-action="unlink-lb" data-email="${attr(m.email)}" data-id="${attr(m.id)}" data-handle="${attr(m.handle || agg[m.id])}">${m.handle ? 'unlink LB' : 'repair LB'}</button>` : ''}
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

const NEWSLETTER_SUBJECT_PLACEHOLDER = 'This month at Jackson Film Club'

// handle → display name for the "latest watches" section; refreshed on every
// Newsletter tab render so inserts use the same member list the tab shows.
let nlHandleNames = {}
let nlPosterResults = []

async function renderNewsletter() {
  const [membersRes, historyRes, tmplRes] = await Promise.all([
    loadKv('member:'),
    loadKv('newsletter:sent:'),
    loadKv('config:newsletter_template'),
  ])

  // Operator-saved template (Config tab) beats the hardcoded literals.
  const tmpl = tryParse(tmplRes.values['config:newsletter_template']) || {}
  const prefillSubject = typeof tmpl.subject === 'string' ? tmpl.subject : ''
  const prefillHtml = typeof tmpl.html === 'string' && tmpl.html ? tmpl.html : NEWSLETTER_TEMPLATE_HTML

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
      <label>Subject<input id="nl-subject" type="text" value="${attr(prefillSubject)}" placeholder="${attr(NEWSLETTER_SUBJECT_PLACEHOLDER)}"></label>
      <div class="nl-body">
        <div class="nl-fields">
          <label>HTML body<textarea id="nl-html" rows="12" placeholder="<h1>…</h1>">${escapeHtml(prefillHtml)}</textarea></label>
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
      <!-- Compose controls, in insertion order: poster block, upcoming
           events, member watches, voice CTA — then the send row last. -->
      <div class="toolbar nl-poster-bar">
        <input id="nl-poster-q" type="text" placeholder="film title…" title="Search TMDB for a poster">
        <button data-action="nl-poster-search">Find poster</button>
        <input id="nl-poster-link" type="url" placeholder="link URL — where the poster points (optional)">
      </div>
      <div id="nl-poster-results" class="nl-poster-results" hidden></div>
      <div class="toolbar">
        <button data-action="nl-insert-events" title="Append all upcoming events as a styled section">Insert upcoming events</button>
        <input id="nl-watched-count" type="number" min="1" max="30" value="8" title="How many entries to insert" style="width:64px">
        <button data-action="nl-insert-watched" title="Append the latest member Letterboxd diary entries as a styled section">Insert member watches</button>
        <button data-action="nl-insert-voice" title="Append a record-a-clip CTA for the podcast, quoting the current voice prompt">Insert voice CTA</button>
      </div>
      <div class="toolbar nl-send-bar">
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

// --- Auth tab: pending signups + sessions/devices + revocations + rate
// limits, one section each. Every section builder returns HTML (with its
// own empty state) so the combined tab always shows all four groups.

async function pendingSection() {
  const { keys, values } = await loadKv('pending:')
  if (!keys.length) return '<h2>Pending signups <span class="muted">(0)</span></h2><p class="empty">No pending signups.</p>'

  const rows = keys.map(k => ({
    keyName: k.name,
    email: k.name.slice('pending:'.length),
    expires: k.expiration,
    p: tryParse(values[k.name]),
  }))

  return `
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

async function sessionsSection() {
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

  return `
    <h2>Session snapshots <span class="muted">(${rows.length})</span></h2>
    <p class="section-hint">Cached member snapshots, 1h TTL. Evicting one forces the next <code>/member/me</code> to re-read <code>member:{email}</code>. Does not revoke the bearer token — for that use the Worker's <code>/session/revoke</code> route (requires the token).</p>
    ${snapshotsTable}
    <h2>Remembered devices <span class="muted">(${devices.length})</span></h2>
    <p class="section-hint">30-day device refresh tokens from the <i>Remember my login on this device</i> checkbox — one row per opted-in browser, TTL slides forward on each silent refresh. Revoking sends that device back through the email-code flow; a bearer token it already holds stays valid until exp (max 1h).</p>
    ${devicesTable}
  `
}

async function revokedSection() {
  const { keys } = await loadKv('revoked:')
  if (!keys.length) return '<h2>Revoked tokens <span class="muted">(0)</span></h2><p class="empty">No revoked sessions.</p>'

  return `
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

async function renderFeedback() {
  const { keys, values } = await loadKv('feedback:')
  if (!keys.length) return content().innerHTML = '<p class="empty">No feedback.</p>'

  // Every field here is site-visitor-controlled free text — the message
  // especially — so everything goes through escapeHtml/attr. Newest first.
  const rows = keys.map(k => ({ k, v: tryParse(values[k.name]) })).filter(r => r.v)
  rows.sort((a, b) => String(b.v.at || '').localeCompare(String(a.v.at || '')))

  content().innerHTML = `
    <h2>Feedback <span class="muted">(${rows.length})</span></h2>
    <p class="section-hint">Beta feedback from the site widget and <code>/feedback</code>. Records auto-expire after 90 days — <b>export before they age out</b> (this tab's data is <code>GET /api/kv?prefix=feedback:</code> as JSON). Delete = handled. "From" is empty for anonymous submissions; identity is stripped automatically if the member deletes their account.</p>
    <table><thead><tr><th>When</th><th>Type</th><th>From</th><th>Page</th><th>Message</th><th>Expires in</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(({ k, v }) => `
        <tr>
          <td title="${attr(v.at)}">${fmtAge(Date.parse(v.at) || 0)}</td>
          <td>${escapeHtml(v.category)}</td>
          <td>${v.member ? `${escapeHtml(v.member.name || '')} <span class="muted">${escapeHtml(v.member.email || '')}</span>` : '<span class="muted">anonymous</span>'}</td>
          <td><code>${escapeHtml(v.page || '')}</code></td>
          <td class="prewrap">${escapeHtml(v.message)}</td>
          <td>${fmtExpiry(k.expiration)}</td>
          <td class="actions">
            <button class="danger" data-action="del-key" data-key="${attr(k.name)}">handled</button>
          </td>
        </tr>
      `).join('')}
    </tbody></table>
  `
}

// --- Voice tab (MEMBERS_KV: voice:{promptId}:{memberId} rows + R2 audio) ---
//
// Member-submitted podcast voice clips. The KV row is metadata; the audio
// lives in R2 (jxnfilm-voice / -staging) behind GET /api/voice. Both sides
// age out ~60 days after submission: the KV key via its TTL (exact), the R2
// object via a bucket-wide lifecycle rule (daily cadence) — so a row can
// briefly outlive its object and vice versa. Reads here are raw KV; every
// MUTATION goes through the join Worker (approve/reject/delete), because a
// raw /api/kv PUT would rewrite the row without its TTL and make it
// persistent.

// Mirrors the join Worker's fallback when config:voice_prompt is absent.
const DEFAULT_VOICE_PROMPT = { id: 'general', text: "Tell us what you're watching" }

function voiceExpiryPill(expiresAt) {
  const days = voiceDaysLeft(expiresAt)
  if (days == null) return '<span class="pill off">no expiry?</span>'
  if (days === 0) return '<span class="pill danger" title="The 60-day window has passed — the R2 audio is likely already deleted">expired</span>'
  const urgent = days <= 7
  return `<span class="pill ${urgent ? 'warn' : 'off'}" title="Auto-deletes ${days} day(s) from now (60-day retention) — download or compile before then">${days}d left</span>`
}

function voiceStatusPill(status) {
  if (status === 'approved') return '<span class="pill on">approved</span>'
  if (status === 'rejected') return '<span class="pill danger">rejected</span>'
  return '<span class="pill warn">pending</span>'
}

function voiceClipCard(c) {
  const src = `/api/voice?${qs({ env: env(), key: c.r2Key })}`
  return `
    <div class="voice-clip">
      <div class="voice-meta">
        <strong>${escapeHtml(c.name || c.memberId)}</strong>
        ${c.handle ? `<code>@${escapeHtml(c.handle)}</code>` : ''}
        <span class="muted" title="${attr(c.at)}">${fmtAge(Date.parse(c.at) || 0)}</span>
        <span class="muted">${fmtDuration(c.duration)} · ${fmtBytes(c.size)}</span>
        ${voiceStatusPill(c.status)}
        ${voiceExpiryPill(c.expiresAt)}
        ${c.consent ? '' : '<span class="pill danger" title="The row has no consent flag — do not publish">⚠ no consent</span>'}
      </div>
      <div class="voice-player">
        <audio controls preload="metadata" src="${attr(src)}"></audio>
        <span class="voice-expired-note muted" hidden>audio gone — the R2 object hit the 60-day lifecycle (or upload failed); only this metadata row remains</span>
      </div>
      <div class="toolbar">
        <a class="voice-dl" href="${attr(src + '&download=1')}">download</a>
        ${c.status !== 'approved' ? `<button class="primary" data-action="voice-status" data-key="${attr(c.keyName)}" data-status="approved">approve</button>` : ''}
        ${c.status !== 'rejected' ? `<button data-action="voice-status" data-key="${attr(c.keyName)}" data-status="rejected">reject</button>` : ''}
        <button class="danger" data-action="voice-delete" data-key="${attr(c.keyName)}">delete</button>
      </div>
    </div>`
}

async function renderVoice() {
  const [voiceRes, promptRes] = await Promise.all([
    loadKv('voice:'),
    loadKv('config:voice_prompt'),
  ])
  const prompt = tryParse(promptRes.values['config:voice_prompt']) || DEFAULT_VOICE_PROMPT

  const rows = voiceRes.keys
    .map(k => ({ keyName: k.name, ...(tryParse(voiceRes.values[k.name]) || {}) }))
    .filter(r => r.promptId && r.r2Key)
  const groups = groupVoiceClips(rows, prompt.id)

  content().innerHTML = `
    <h2>Voice clips <span class="muted">(${rows.length})</span></h2>
    <p class="section-hint">Member voice submissions for the podcast (≤3 min each; audio in R2, metadata in
      <code>voice:*</code>). <b>Everything — approved clips included — auto-deletes 60 days after
      submission</b> (R2 bucket lifecycle + KV TTL), so compile or download before the countdown runs
      out. Approve/reject/delete go through the join Worker to keep the KV TTLs intact. Compile the
      approved set with <code>node scripts/compile_voices.mjs &lt;promptId&gt;</code>, or render branded
      audiogram videos with <code>node scripts/make_audiogram.mjs --prompt &lt;promptId&gt;</code>.</p>
    <p class="section-hint">Current prompt: <code>${escapeHtml(prompt.id)}</code> —
      “${escapeHtml(prompt.text)}”${prompt.deadline ? ` (deadline ${escapeHtml(prompt.deadline)})` : ''}
      · edit in the Config tab.</p>
    ${groups.length ? groups.map(g => `
      <section class="voice-group">
        <h3><code>${escapeHtml(g.promptId)}</code>
          ${g.promptId === prompt.id ? '<span class="pill on">current prompt</span>' : ''}
          <span class="muted">(${g.clips.length})</span></h3>
        ${g.promptText ? `<p class="section-hint">“${escapeHtml(g.promptText)}”</p>` : ''}
        ${g.clips.map(voiceClipCard).join('')}
      </section>`).join('') : '<p class="empty">No voice clips yet.</p>'}
  `

  // Audio error events don't bubble — attach per element. A 404 body of
  // { error: 'expired' } is the EXPECTED post-lifecycle state, so it renders
  // as a note, never a broken player. preload="metadata" makes the 404
  // surface on render rather than on first play.
  document.querySelectorAll('#content .voice-clip audio').forEach(a => {
    a.addEventListener('error', () => {
      const wrap = a.closest('.voice-player')
      a.hidden = true
      wrap.querySelector('.voice-expired-note').hidden = false
      wrap.closest('.voice-clip').querySelector('.voice-dl')?.remove()
    }, { once: true })
  })
}

async function rateSection() {
  const { keys, values } = await loadKv('rate:')
  if (!keys.length) return '<h2>Rate limits <span class="muted">(0)</span></h2><p class="empty">No active rate-limit counters.</p>'

  return `
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

// The four sections are independent KV reads — load them in parallel, in
// auth-lifecycle order: signup → live sessions/devices → revocations →
// throttles.
async function renderAuth() {
  const sections = await Promise.all([
    pendingSection(), sessionsSection(), revokedSection(), rateSection(),
  ])
  content().innerHTML = sections.join('\n')
}

// --- Config tab (MEMBERS_KV: config:* operator overrides) ---
//
// Purpose-built editors for the config keys the join Worker and public SPA
// consume. The mental model surfaced everywhere in this tab: a missing key
// means "use the hardcoded defaults" — deleting a key is the reset, and the
// site/Worker fall back automatically. Each section badges its current
// source (KV override vs defaults) from whether the key exists.

// Mirrors THEATERS in worker/src/index.js and ui/views.html (the hardcoded
// fallback when config:theaters is absent). Shown as the starting point /
// reset target here — keep in lockstep if the hardcoded lists change.
const DEFAULT_THEATERS = [
  'Patton House & Gallery',
  'The Capri Theater',
  'Legacy Parkway Theaters',
  'Cinemark XD in Pearl',
  'Malco Renaissance in Ridgeland',
  'Malco Grandview & IMAX in Madison',
  'B&B Theaters at Northpark in Ridgeland',
]

// config:copy fields — placeholders are the current hardcoded site copy
// (ui/views.html), shown so the operator sees exactly what an override
// replaces. Empty input = fall back to that default.
const COPY_FIELDS = [
  { key: 'heroLabel', label: 'Hero label', multiline: false,
    def: 'A community cinema · Jackson MS' },
  // No heroHeadline entry: the site h1 carries inline markup the config
  // pipeline deliberately does not override (see ui/views.html home-view).
  { key: 'heroLede', label: 'Hero lede', multiline: true,
    def: 'A community space for analytical conversations about cinema, founded in Jackson, Mississippi in 2018. Bring a chair. Stay for the argument.' },
  { key: 'joinKicker', label: 'Join kicker', multiline: false,
    def: 'Free · Sign up with email · Jackson MS' },
  { key: 'joinHeading', label: 'Join heading', multiline: false,
    def: 'Get in the room.' },
  { key: 'joinBody', label: 'Join body', multiline: true,
    def: 'No more than one dispatch a week — screenings, hosts, and what the club is watching. Membership is public, but pick any display name you like; your email address is always private, and Letterboxd is optional.' },
  { key: 'podcastLede', label: 'Podcast lede', multiline: true,
    def: 'The audio series launched in 2021 to extend JXN Film Club discussions to a broader audience.' },
  { key: 'sectionProgram', label: 'Section heading — Program', multiline: false, def: 'The Program' },
  { key: 'sectionWatches', label: 'Section heading — Watches', multiline: false, def: 'Recent Watches from Members' },
  { key: 'sectionTakes', label: 'Section heading — Takes', multiline: false, def: 'Hot Takes' },
  { key: 'sectionPodcast', label: 'Section heading — Podcast', multiline: false, def: 'The Podcast' },
]

const EPISODES_JSON_URL = 'https://jxnfilm.club/data/episodes.json'

// Working state for the tab. Rebuilt on every render (loadKv is the source
// of truth); mutated in place by the add/remove/move actions between saves.
let cfgTheaters = []
let cfgTheatersKv = false
let cfgPodcast = { episodes: [] }
let cfgPodcastKv = false
let cfgPodcastSeedFailed = false

const cfgBadge = (fromKv) => fromKv
  ? '<span class="pill on">KV override</span>'
  : '<span class="pill off">defaults — no KV key</span>'

async function renderConfig() {
  const { keys, values } = await loadKv('config:')
  const has = (k) => keys.some(x => x.name === k)

  cfgTheatersKv = has('config:theaters')
  cfgTheaters = cfgTheatersKv
    ? normalizeStringList(tryParse(values['config:theaters']))
    : [...DEFAULT_THEATERS]

  cfgPodcastKv = has('config:podcast')
  cfgPodcastSeedFailed = false
  if (cfgPodcastKv) {
    cfgPodcast = tryParse(values['config:podcast']) || { episodes: [] }
    if (!Array.isArray(cfgPodcast.episodes)) cfgPodcast.episodes = []
  } else {
    // No override yet — start from the live site data so "save" begins an
    // override at the current published state, not from scratch. Bounded
    // fetch: a slow/unreachable jxnfilm.club must not hang the tab.
    try {
      cfgPodcast = await (await fetch(EPISODES_JSON_URL, { signal: AbortSignal.timeout(3000) })).json()
      if (!cfgPodcast || !Array.isArray(cfgPodcast.episodes)) cfgPodcast = { episodes: [] }
      if (!cfgPodcast.episodes.length) cfgPodcastSeedFailed = true
    } catch {
      cfgPodcast = { featured_id: '', episodes: [] }
      cfgPodcastSeedFailed = true
    }
  }

  const copy = (has('config:copy') && tryParse(values['config:copy'])) || {}
  const nl = (has('config:newsletter_template') && tryParse(values['config:newsletter_template'])) || null
  const vp = (has('config:voice_prompt') && tryParse(values['config:voice_prompt'])) || null

  content().innerHTML = `
    <h2>Config <span class="muted">— editing <strong>${escapeHtml(env())}</strong></span></h2>
    <p class="section-hint">Operator overrides stored under <code>config:*</code> in <code>MEMBERS_KV</code>,
      consumed by the join Worker and the public site. A section saved here overrides the hardcoded
      defaults; <b>deleting the key (reset) restores them automatically</b> — nothing stored means
      "use the defaults". All reads/writes follow the env toggle above.</p>

    <section class="cfg-section" id="cfg-theaters">
      <h3>Theaters ${cfgBadge(cfgTheatersKv)}</h3>
      <p class="section-hint"><code>config:theaters</code> — the venue allowlist/dropdown for theater
        meetups. Row order is dropdown order. Save writes the full list; reset deletes the key so the
        Worker and site fall back to their hardcoded list (shown here when no override exists).</p>
      <div id="cfg-theaters-list">${renderTheaterRows()}</div>
      <div class="toolbar">
        <button data-action="cfg-theater-add">+ add theater</button>
        <button class="primary" data-action="cfg-theaters-save">save list</button>
        <button class="danger" data-action="cfg-theaters-reset">reset to defaults</button>
      </div>
    </section>

    <section class="cfg-section" id="cfg-podcast">
      <h3>Podcast ${cfgBadge(cfgPodcastKv)}</h3>
      <p class="section-hint"><code>config:podcast</code> — same shape as <code>data/episodes.json</code>
        (<code>{ featured_id, episodes }</code>). ${cfgPodcastKv
          ? 'Editing the KV override.'
          : 'No override yet — prefilled from the live site\'s <code>data/episodes.json</code>; saving creates the override.'}
        The featured episode drives the homepage Spotify embed. Fields this editor doesn't know about
        are preserved on save.</p>
      ${cfgPodcastSeedFailed ? '<p class="cfg-warn">⚠ Could not load the live <code>data/episodes.json</code> seed — this list started <b>empty</b>. Saving now would publish an empty episode list; reload the tab to retry the seed first.</p>' : ''}
      <label class="cfg-label">Featured episode — Spotify episode ID <span class="muted">(the 22-char ID from open.spotify.com/episode/…; or use a "featured" radio below)</span>
        <input id="cfg-featured" type="text" value="${attr(cfgPodcast.featured_id || '')}" placeholder="e.g. 2lTN7uSNEil7AoTEDzbEZs" style="max-width:340px">
      </label>
      <div id="cfg-episodes-list">${renderEpisodeRows()}</div>
      <div class="toolbar">
        <button data-action="cfg-ep-add">+ add episode</button>
        <button class="primary" data-action="cfg-podcast-save">save podcast</button>
        <button class="danger" data-action="cfg-podcast-reset">reset to defaults</button>
      </div>
    </section>

    <section class="cfg-section" id="cfg-nl-template">
      <h3>Newsletter template ${cfgBadge(!!nl)}</h3>
      <p class="section-hint"><code>config:newsletter_template</code> — the subject + HTML the
        Newsletter compose tab prefills. Reset deletes the key; compose then falls back to the
        built-in branded template.</p>
      <label class="cfg-label">Subject
        <input id="cfg-nl-subject" type="text" value="${attr(nl?.subject || '')}" placeholder="${attr(NEWSLETTER_SUBJECT_PLACEHOLDER)}">
      </label>
      <label class="cfg-label">HTML body
        <textarea id="cfg-nl-html" rows="12">${escapeHtml(nl?.html || NEWSLETTER_TEMPLATE_HTML)}</textarea>
      </label>
      <div class="toolbar">
        <button class="primary" data-action="cfg-nl-save">save template</button>
        <button class="danger" data-action="cfg-nl-reset">reset to defaults</button>
      </div>
    </section>

    <section class="cfg-section" id="cfg-copy">
      <h3>Homepage copy ${cfgBadge(has('config:copy'))}</h3>
      <p class="section-hint"><code>config:copy</code> — per-field overrides for the homepage prose.
        Placeholders show the current site defaults, i.e. what an override replaces. Only non-empty
        fields are stored — leave a field empty to keep its default. Saving with every field empty
        deletes the key entirely.</p>
      <div class="cfg-copy-grid">
        ${COPY_FIELDS.map(f => `
          <label class="cfg-label">${escapeHtml(f.label)} <code class="muted">${escapeHtml(f.key)}</code>
            ${f.multiline
              ? `<textarea data-copy-field="${attr(f.key)}" rows="3" placeholder="${attr(f.def)}">${escapeHtml(copy[f.key] || '')}</textarea>`
              : `<input type="text" data-copy-field="${attr(f.key)}" value="${attr(copy[f.key] || '')}" placeholder="${attr(f.def)}">`}
          </label>`).join('')}
      </div>
      <div class="toolbar">
        <button class="primary" data-action="cfg-copy-save">save copy overrides</button>
        <button class="danger" data-action="cfg-copy-reset">reset to defaults</button>
      </div>
    </section>

    <section class="cfg-section" id="cfg-voice-prompt">
      <h3>Voice prompt ${cfgBadge(!!vp)}</h3>
      <p class="section-hint"><code>config:voice_prompt</code> — the question members answer when they
        record a podcast voice clip. Submissions are keyed by the prompt id, so changing the id starts
        a fresh collection (the Voice tab groups by it). Reset deletes the key; the site falls back to
        the generic default prompt (<code>${escapeHtml(DEFAULT_VOICE_PROMPT.id)}</code> —
        “${escapeHtml(DEFAULT_VOICE_PROMPT.text)}”).</p>
      <label class="cfg-label">Prompt id <span class="muted">— slug; groups the submissions and names the compiled segment</span>
        <input id="cfg-vp-id" type="text" value="${attr(vp?.id || '')}" placeholder="${attr(DEFAULT_VOICE_PROMPT.id)}" style="max-width:260px">
      </label>
      <label class="cfg-label">Prompt text
        <textarea id="cfg-vp-text" rows="2" placeholder="${attr(DEFAULT_VOICE_PROMPT.text)}">${escapeHtml(vp?.text || '')}</textarea>
      </label>
      <label class="cfg-label">Deadline <span class="muted">— optional YYYY-MM-DD shown to members; submissions stay open regardless</span>
        <input id="cfg-vp-deadline" type="date" value="${attr(vp?.deadline || '')}" style="max-width:200px">
      </label>
      <div class="toolbar">
        <button class="primary" data-action="cfg-vp-save">save prompt</button>
        <button class="danger" data-action="cfg-vp-reset">reset to defaults</button>
      </div>
    </section>
  `

  // Featured-episode radios live inside the re-renderable episodes list, so
  // delegate from the section element (survives list re-renders; dies with
  // the tab's innerHTML, so no listener accumulation).
  $('#cfg-podcast').addEventListener('change', (e) => {
    const radio = e.target.closest('input[name="cfg-featured-pick"]')
    if (!radio) return
    syncPodcastInputs()
    const ep = cfgPodcast.episodes[Number(radio.dataset.idx)]
    let id = ep && typeof ep.id === 'string' ? ep.id.trim() : ''
    if (!id) {
      // Episodes from data/episodes.json carry no Spotify ID (their anchor
      // URLs can't be converted) — capture it once and keep it on the row.
      id = (prompt('Spotify episode ID for this episode (from open.spotify.com/episode/…):') || '').trim()
      if (!id) { $('#cfg-episodes-list').innerHTML = renderEpisodeRows(); return }
      ep.id = id
    }
    cfgPodcast.featured_id = id
    $('#cfg-featured').value = id
    $('#cfg-episodes-list').innerHTML = renderEpisodeRows()
  })
}

function renderTheaterRows() {
  if (!cfgTheaters.length) return '<p class="empty">No theaters — add one below.</p>'
  return cfgTheaters.map((v, i) => `
    <div class="cfg-row">
      <input type="text" data-theater value="${attr(v)}" placeholder="Theater name">
      <button data-action="cfg-theater-up" data-idx="${i}" title="move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button data-action="cfg-theater-down" data-idx="${i}" title="move down" ${i === cfgTheaters.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="danger" data-action="cfg-theater-rm" data-idx="${i}">remove</button>
    </div>`).join('')
}

function renderEpisodeRows() {
  if (!cfgPodcast.episodes.length) return '<p class="empty">No episodes — add one below.</p>'
  const featured = String(cfgPodcast.featured_id || '')
  return cfgPodcast.episodes.map((ep, i) => `
    <div class="cfg-episode" data-idx="${i}">
      <label class="cfg-feat" title="Feature this episode on the homepage embed">
        <input type="radio" name="cfg-featured-pick" data-idx="${i}"
          ${ep.id && featured && ep.id === featured ? 'checked' : ''}> featured
      </label>
      <input type="text" data-ep-field="title" value="${attr(ep.title || '')}" placeholder="Episode title">
      <input type="date" data-ep-field="date" value="${attr(ep.date || '')}">
      <input type="url" data-ep-field="url" value="${attr(ep.url || '')}" placeholder="https://podcasters.spotify.com/…">
      <button class="danger" data-action="cfg-ep-rm" data-idx="${i}">delete</button>
    </div>`).join('')
}

// DOM → working state, called before any mutation or save so in-progress
// typing is never lost by a list re-render.
function readTheaterInputs() {
  cfgTheaters = [...document.querySelectorAll('#cfg-theaters-list input[data-theater]')].map(i => i.value)
}

function syncPodcastInputs() {
  const feat = $('#cfg-featured')
  if (feat) cfgPodcast.featured_id = feat.value
  document.querySelectorAll('#cfg-episodes-list .cfg-episode').forEach(row => {
    const ep = cfgPodcast.episodes[Number(row.dataset.idx)]
    if (!ep) return
    row.querySelectorAll('[data-ep-field]').forEach(inp => { ep[inp.dataset.epField] = inp.value })
  })
}

// --- Stats tab (derived; reads only, writes nothing) ---
//
// Every number here is computed from KV the admin already has, so the whole
// club costs one pass over five bulk reads rather than a per-member fan-out.
// The semantics mirror computeAccountStats() in ui/auth.html so the admin
// never contradicts what a member sees on /edit — see the parity note in
// lib.js and the fixtures in tests/admin/lib.test.js.

let statsCache = null   // { rows, ctx } for the current env; cleared on refresh

async function loadStats() {
  // events:all, not the canonical event: rows — the aggregate is the projected
  // shape with hosts private addresses stripped, and none of that belongs in
  // the stats DOM.
  const [members, attendanceAgg, eventsAgg, rsvpRaw, voiceRaw, watched] = await Promise.all([
    loadKv('member:'),
    loadKv('attendance:all', 'ATTENDANCE_KV'),
    loadKv('events:all', 'ATTENDANCE_KV'),
    loadKv('rsvp:', 'ATTENDANCE_KV'),
    loadKv('voice:'),
    api('GET', `/api/watched?${qs({ env: env() })}`),
  ])

  const rsvps = {}
  for (const k of rsvpRaw.keys) {
    const parsed = tryParse(rsvpRaw.values[k.name])
    if (parsed) rsvps[k.name] = parsed
  }

  const ctx = buildStatsContext({
    attendance: tryParse(attendanceAgg.values['attendance:all']) || {},
    events: tryParse(eventsAgg.values['events:all']) || [],
    rsvps,
    voiceKeys: voiceRaw.keys.map(k => k.name),
    watched: watched || {},
  })

  const rows = members.keys
    .map(k => tryParse(members.values[k.name]))
    .filter(Boolean)
    .map(m => computeMemberStats(m, ctx))

  statsCache = { rows, ctx }
  return statsCache
}

const STATS_SORTS = {
  attended: (a, b) => b.attended - a.attended || a.name.localeCompare(b.name),
  hosted:   (a, b) => b.hosted - a.hosted || a.name.localeCompare(b.name),
  logged:   (a, b) => b.logged - a.logged || a.name.localeCompare(b.name),
  rsvps:    (a, b) => b.rsvps - a.rsvps || a.name.localeCompare(b.name),
  clips:    (a, b) => b.clips - a.clips || a.name.localeCompare(b.name),
  name:     (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
}
let statsSort = 'attended'

// The card a single member sees, rebuilt from admin-side data. Shared by the
// Stats tab detail and the Members tab stats button.
function statsCardHtml(s) {
  const tile = (value, label, muted) =>
    `<div class="stat-tile"><b class="${muted ? 'stat-value muted-value' : 'stat-value'}">${escapeHtml(String(value))}</b>` +
    `<span class="stat-label">${escapeHtml(label)}</span></div>`

  const meta = [
    s.joined ? `Member since ${fmtJoined(s.joined)}` : '',
    `${s.clips} voice ${s.clips === 1 ? 'clip' : 'clips'}`,
    `Newsletter ${s.newsletter ? 'on' : 'off'}`,
    s.handle ? `<code>@${escapeHtml(s.handle)}</code>` : 'No Letterboxd linked',
  ].filter(Boolean)

  return `
    <div class="stat-card">
      <div class="stat-grid">
        ${tile(s.attended, 'Attended')}
        ${tile(s.hosted, 'Hosted')}
        ${tile(s.handle ? s.logged : '—', 'Films logged', !s.handle)}
        ${tile(s.rsvps, 'Upcoming RSVPs')}
      </div>
      ${s.rankLabel ? `<p class="stat-rank">★ ${escapeHtml(s.rankLabel)} most screenings attended</p>` : ''}
      <p class="stat-meta">${meta.join(' · ')}</p>
      ${s.renamed ? `<p class="stat-warn">No attendance is filed under <b>${escapeHtml(s.name)}</b>, though screenings have happened since they joined. Attendance is keyed by display name and a rename does not rewrite past rows — the earlier ones are likely under the old name.</p>` : ''}
    </div>`
}

async function renderStats() {
  const { rows } = statsCache || await loadStats()
  if (!rows.length) return content().innerHTML = '<p class="empty">No members in KV.</p>'

  const sorted = [...rows].sort(STATS_SORTS[statsSort])
  const num = (v, muted) => muted ? '<span class="muted">—</span>' : escapeHtml(String(v))

  content().innerHTML = `
    <h2>Stats <span class="muted">(${rows.length})</span></h2>
    <p class="section-hint">Derived from KV — nothing here is stored. Mirrors what each
      member sees on <code>/edit</code>; hosts are credited for their own screenings the
      same way <code>/events/attendance</code> credits them. Read-only.</p>
    <div class="search">
      <input id="filter" type="text" placeholder="filter by name / handle / id">
      <label class="env-label">sort
        <select id="stats-sort">
          ${Object.keys(STATS_SORTS).map(k =>
            `<option value="${k}"${k === statsSort ? ' selected' : ''}>${k}</option>`).join('')}
        </select>
      </label>
    </div>
    <table id="stats-table">
      <thead><tr>
        <th>Name</th><th>Attended</th><th>Rank</th><th>Hosted</th>
        <th>Films</th><th>RSVPs</th><th>Clips</th><th>Actions</th>
      </tr></thead>
      <tbody>
        ${sorted.map(s => `
          <tr data-search="${attr([s.name, s.handle, s.id].filter(Boolean).join(' ').toLowerCase())}">
            <td>${escapeHtml(s.name)}${s.renamed ? ' <span class="stat-flag" title="No attendance filed under this name — possible rename">rename?</span>' : ''}</td>
            <td>${escapeHtml(String(s.attended))}</td>
            <td>${s.rankLabel ? escapeHtml(s.rankLabel) : '<span class="muted">—</span>'}</td>
            <td>${escapeHtml(String(s.hosted))}</td>
            <td>${num(s.logged, !s.handle)}</td>
            <td>${escapeHtml(String(s.rsvps))}</td>
            <td>${escapeHtml(String(s.clips))}</td>
            <td class="actions"><button data-action="member-stats" data-id="${attr(s.id)}">card</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `
  wireFilter($('#filter'), '#stats-table tbody tr')
  $('#stats-sort').addEventListener('change', (e) => {
    statsSort = e.target.value
    withBusy(() => renderStats())
  })
}

// --- Events tab (ATTENDANCE_KV: event:{id} canonical + events:all aggregate) ---
//
// Events are now KV-driven. The public site reads them via the Worker's
// `GET /events` endpoint, so saves here appear immediately on `/events`.
// snapshot-events.yml commits data/events.json from the Worker every 6h
// as the archival / fallback source.

let eventsCache = null
let attendanceCache = null
let rsvpCache = null
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
  const rsvpRaw = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'rsvp:' })}`)
  rsvpCache = {}
  for (const k of rsvpRaw.keys) {
    const eventId = k.name.slice('rsvp:'.length)
    rsvpCache[eventId] = tryParse(rsvpRaw.values[k.name]) || { confirmed: [], waitlist: [] }
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
        <div><label>Time <span class="muted">— showtime</span></label><input type="time" name="time" value="${attr(e.time || '')}"></div>
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
      ${hosted ? renderRsvpSection(e) : ''}
    </div>
  `
  }).join('')
}

// RSVP section for hosted events: real confirmed/waitlist entries (emails
// visible — this dashboard already reads raw KV behind Access), guest tags,
// and a manual guest add form. Adds/removes go through /api/rsvp/guest →
// join Worker, NOT raw KV, so capacity/waitlist/emails/mirrors all hold.
function renderRsvpSection(e) {
  const rsvp = (rsvpCache && rsvpCache[e.id]) || { confirmed: [], waitlist: [] }
  const isGuest = r => typeof r.memberId === 'string' && r.memberId.startsWith('guest:')
  const renderEntry = (r, tag) => `
    <li>${escapeHtml(r.name || '(no name)')}${r.email ? ` &lt;${escapeHtml(r.email)}&gt;` : ''}${tag ? ` <span class="muted">${tag}</span>` : ''}${isGuest(r) ? ' <span class="muted">[guest]</span>' : ''}
      ${isGuest(r) ? `<button class="danger" data-action="guest-rm" data-event="${attr(e.id)}" data-id="${attr(r.memberId)}">remove guest</button>` : ''}
    </li>`
  return `
      <div class="attendance rsvp-admin">
        <strong>RSVPs (${rsvp.confirmed.length} confirmed${rsvp.waitlist.length ? `, ${rsvp.waitlist.length} waitlisted` : ''})</strong>
        <ul>
          ${rsvp.confirmed.map(r => renderEntry(r, '')).join('') || '<li class="muted">no RSVPs</li>'}
          ${rsvp.waitlist.map(r => renderEntry(r, '(waitlist)')).join('')}
        </ul>
        <div class="guest-add toolbar">
          <input type="text" name="guest-name" placeholder="Guest name">
          <input type="email" name="guest-email" placeholder="Email (optional)">
          <label class="muted"><input type="checkbox" name="guest-force"> force over capacity</label>
          <button class="primary" data-action="guest-add" data-event="${attr(e.id)}">add guest</button>
        </div>
      </div>`
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
    else if (a === 'member-stats') {
      // Reachable from Members as well as Stats, so the shared load may not
      // have run yet. loadStats() fills the cache either way, and the button
      // is disabled meanwhile because the fan-out is five KV reads.
      const id = btn.dataset.id
      btn.disabled = true
      try {
        const { rows } = statsCache || await loadStats()
        const row = rows.find(r => r.id === id)
        if (!row) { toast(`No stats for member id ${id}`, true); return }
        showModalHtml(row.name || id, statsCardHtml(row))
      } finally {
        btn.disabled = false
      }
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
      const { email, handle } = btn.dataset
      if (!confirm(`Force-unlink @${handle} from ${email}?\n\nRuns the full unlink cascade on the join Worker (member row + reverse indices + pending token + members:all projection + session snapshot + update-member commit).`)) return
      await api('POST', `/api/member/unlink?${qs({ env: env() })}`, JSON.stringify({ email }))
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
    else if (a === 'nl-insert-events') {
      // Fetch fresh rather than relying on eventsCache — the Events tab may
      // never have rendered this session. Same per-event → aggregate
      // fallback as renderEvents().
      const perEvent = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'event:' })}`)
      let events
      if (perEvent.keys.length) {
        events = perEvent.keys.map(k => tryParse(perEvent.values[k.name])).filter(Boolean)
      } else {
        const aggRaw = await api('GET', `/api/kv?${qs({ env: env(), binding: 'ATTENDANCE_KV', prefix: 'events:all' })}`)
        events = tryParse(aggRaw.values['events:all']) || []
      }
      // Dates are bare YYYY-MM-DD Central-time calendar days — compare as
      // strings against a Central "today", never via new Date().
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
      const upcoming = events
        .filter(e => String(e.date || '') >= today)
        .sort((x, y) => String(x.date).localeCompare(String(y.date)))
      if (!upcoming.length) { toast('No upcoming events to insert', true); return }

      const htmlField = $('#nl-html')
      const textField = $('#nl-text')
      htmlField.value = htmlField.value.trimEnd() + '\n' + buildEventsSectionHtml(upcoming)
      htmlField.dispatchEvent(new Event('input'))  // sync the WYSIWYG preview
      textField.value = (textField.value.trim() ? textField.value.trimEnd() + '\n\n' : '') + buildEventsSectionText(upcoming)
      toast(`Inserted ${upcoming.length} upcoming ${upcoming.length === 1 ? 'event' : 'events'} — edit or trim in the preview`)
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
    else if (a === 'nl-insert-voice') {
      // Current prompt from KV (env-aware); the generic default when unset —
      // same resolution the site and Voice tab use.
      const { values } = await loadKv('config:voice_prompt')
      const vp = tryParse(values['config:voice_prompt'])
      const text = (vp && typeof vp.text === 'string' && vp.text.trim()) || DEFAULT_VOICE_PROMPT.text
      const htmlField = $('#nl-html')
      const textField = $('#nl-text')
      htmlField.value = htmlField.value.trimEnd() + '\n' + buildVoiceCtaHtml({ text })
      htmlField.dispatchEvent(new Event('input'))  // sync the WYSIWYG preview
      textField.value = (textField.value.trim() ? textField.value.trimEnd() + '\n\n' : '') + buildVoiceCtaText({ text })
      toast('Inserted the voice-clip CTA — edit in the preview')
    }
    else if (a === 'nl-poster-search') {
      const query = $('#nl-poster-q').value.trim()
      if (!query) { toast('Enter a film title to search', true); return }
      const r = await api('GET', `/api/tmdb/search?${qs({ env: env(), q: query })}`)
      nlPosterResults = r.results || []
      const strip = $('#nl-poster-results')
      if (!nlPosterResults.length) {
        strip.hidden = true
        toast(`No posters found for "${query}"`, true)
        return
      }
      strip.innerHTML = nlPosterResults.map((p, i) => `
        <button type="button" class="nl-poster-thumb" data-action="nl-poster-pick" data-idx="${i}"
          title="Insert this poster">
          <img src="${attr(p.thumb)}" alt="">
          <span>${escapeHtml(p.title)}${p.year ? ` (${escapeHtml(p.year)})` : ''}</span>
        </button>`).join('')
      strip.hidden = false
    }
    else if (a === 'nl-poster-pick') {
      const p = nlPosterResults[Number(btn.dataset.idx)]
      if (!p) return
      const link = $('#nl-poster-link').value.trim()
      const block = { poster: p.poster, link, title: p.title, year: p.year }
      const htmlField = $('#nl-html')
      const textField = $('#nl-text')
      htmlField.value = htmlField.value.trimEnd() + '\n' + buildPosterBlockHtml(block)
      htmlField.dispatchEvent(new Event('input'))  // sync the WYSIWYG preview
      const textLine = buildPosterBlockText(block)
      if (textLine) textField.value = (textField.value.trim() ? textField.value.trimEnd() + '\n\n' : '') + textLine
      $('#nl-poster-results').hidden = true
      toast(`Inserted ${p.title} poster${link ? ' (linked)' : ''} — edit or move it in the preview`)
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
      // The poster insert seeds bracketed placeholder copy — block a real
      // send that still contains it.
      if ((html + text).includes('[Write your review or announcement here')) {
        toast('The body still contains the poster placeholder text — replace it before sending', true)
        return
      }
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
    else if (a === 'guest-add') {
      const wrap = btn.closest('.guest-add')
      const name = (wrap.querySelector('input[name="guest-name"]').value || '').trim()
      const email = (wrap.querySelector('input[name="guest-email"]').value || '').trim()
      const force = wrap.querySelector('input[name="guest-force"]').checked
      if (!name) { toast('Guest name is required', true); return }
      const body = { name }
      if (email) body.email = email
      if (force) body.force = true
      const r = await api('POST', `/api/rsvp/guest?${qs({ env: env(), event: btn.dataset.event })}`, JSON.stringify(body))
      toast(`Added ${name} (${r.status})${email ? ' — confirmation emailed' : ''}`)
      await switchTab(currentTab)
    }
    else if (a === 'guest-rm') {
      const { event: eventId, id } = btn.dataset
      if (!confirm(`Remove this guest from ${eventId}?\n\nIf they were confirmed and a waitlist exists, the next person is promoted and emailed.`)) return
      await api('DELETE', `/api/rsvp/guest?${qs({ env: env(), event: eventId })}`, JSON.stringify({ id }))
      toast('Guest removed')
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
    // --- Voice tab actions (mutations via the join Worker — never raw KV,
    // --- a /api/kv PUT would drop the row's TTL and make it persistent) ---
    else if (a === 'voice-status') {
      const { key, status } = btn.dataset
      await api('POST', `/api/voice/status?${qs({ env: env() })}`, JSON.stringify({ key, status }))
      toast(`Marked ${status}`)
      await switchTab(currentTab)
    }
    else if (a === 'voice-delete') {
      const key = btn.dataset.key
      if (!confirm(`Delete this voice clip?\n${key}\n\nRemoves the R2 audio and the KV row via the join Worker. This is permanent.`)) return
      await api('DELETE', `/api/voice?${qs({ env: env() })}`, JSON.stringify({ key }))
      toast('Voice clip deleted')
      await switchTab(currentTab)
    }
    // --- Config tab actions ---
    else if (a === 'cfg-theater-add') {
      readTheaterInputs()
      cfgTheaters.push('')
      $('#cfg-theaters-list').innerHTML = renderTheaterRows()
      const inputs = document.querySelectorAll('#cfg-theaters-list input[data-theater]')
      inputs[inputs.length - 1]?.focus()
    }
    else if (a === 'cfg-theater-rm') {
      readTheaterInputs()
      cfgTheaters.splice(Number(btn.dataset.idx), 1)
      $('#cfg-theaters-list').innerHTML = renderTheaterRows()
    }
    else if (a === 'cfg-theater-up' || a === 'cfg-theater-down') {
      readTheaterInputs()
      cfgTheaters = moveItem(cfgTheaters, Number(btn.dataset.idx), a === 'cfg-theater-up' ? -1 : 1)
      $('#cfg-theaters-list').innerHTML = renderTheaterRows()
    }
    else if (a === 'cfg-theaters-save') {
      readTheaterInputs()
      const list = normalizeStringList(cfgTheaters)
      if (!list.length) { toast('Add at least one theater — or use reset to fall back to the defaults', true); return }
      await putKv('config:theaters', JSON.stringify(list))
      toast(`Saved ${list.length} theater(s) to config:theaters (${env()})`)
      await switchTab(currentTab)
    }
    else if (a === 'cfg-theaters-reset') {
      if (!confirm(`Delete config:theaters on ${env()}?\n\nThe Worker and site fall back to the hardcoded theater list.`)) return
      await delKv('config:theaters').catch(() => {})
      toast('config:theaters deleted — defaults are back in effect')
      await switchTab(currentTab)
    }
    else if (a === 'cfg-ep-add') {
      syncPodcastInputs()
      cfgPodcast.episodes.unshift({ title: '', date: '', url: '' })
      $('#cfg-episodes-list').innerHTML = renderEpisodeRows()
      document.querySelector('#cfg-episodes-list input[data-ep-field="title"]')?.focus()
    }
    else if (a === 'cfg-ep-rm') {
      syncPodcastInputs()
      const idx = Number(btn.dataset.idx)
      const ep = cfgPodcast.episodes[idx]
      if (ep && (ep.title || ep.url) && !confirm(`Delete episode "${ep.title || ep.url}" from the list?`)) return
      cfgPodcast.episodes.splice(idx, 1)
      $('#cfg-episodes-list').innerHTML = renderEpisodeRows()
    }
    else if (a === 'cfg-podcast-save') {
      syncPodcastInputs()
      const out = sanitizePodcastConfig(cfgPodcast)
      // An empty override WINS over data/episodes.json and blanks the
      // homepage podcast section — never let that happen silently.
      if (!out.episodes.length && !confirm(`Save an EMPTY episode list to ${env()}?\n\nThe homepage podcast section will show no episodes. If you meant to fall back to data/episodes.json, cancel and use reset instead.`)) return
      await putKv('config:podcast', JSON.stringify(out))
      toast(`Saved config:podcast (${out.episodes.length} episode(s)) on ${env()}`)
      await switchTab(currentTab)
    }
    else if (a === 'cfg-podcast-reset') {
      if (!confirm(`Delete config:podcast on ${env()}?\n\nThe site falls back to data/episodes.json.`)) return
      await delKv('config:podcast').catch(() => {})
      toast('config:podcast deleted — data/episodes.json is back in effect')
      await switchTab(currentTab)
    }
    else if (a === 'cfg-nl-save') {
      const subject = $('#cfg-nl-subject').value.trim()
      const html = $('#cfg-nl-html').value
      if (!subject && !html.trim()) {
        // Storing nothing means "use defaults" — treat an all-empty save
        // as the reset it is.
        await delKv('config:newsletter_template').catch(() => {})
        toast('Empty template — config:newsletter_template deleted, compose uses the built-in default')
      } else {
        await putKv('config:newsletter_template', JSON.stringify({ subject, html }))
        toast(`Saved config:newsletter_template on ${env()}`)
      }
      await switchTab(currentTab)
    }
    else if (a === 'cfg-nl-reset') {
      if (!confirm(`Delete config:newsletter_template on ${env()}?\n\nThe Newsletter compose tab falls back to the built-in template.`)) return
      await delKv('config:newsletter_template').catch(() => {})
      toast('config:newsletter_template deleted — built-in template is back')
      await switchTab(currentTab)
    }
    else if (a === 'cfg-copy-save') {
      const fields = {}
      document.querySelectorAll('#cfg-copy [data-copy-field]').forEach(inp => {
        fields[inp.dataset.copyField] = inp.value
      })
      const blob = buildCopyOverrides(fields, COPY_FIELDS.map(f => f.key))
      if (blob) {
        await putKv('config:copy', JSON.stringify(blob))
        toast(`Saved ${Object.keys(blob).length} copy override(s) on ${env()}`)
      } else {
        await delKv('config:copy').catch(() => {})
        toast('All fields empty — config:copy deleted, site uses its defaults')
      }
      await switchTab(currentTab)
    }
    else if (a === 'cfg-copy-reset') {
      if (!confirm(`Delete config:copy on ${env()}?\n\nEvery homepage copy field falls back to the hardcoded site text.`)) return
      await delKv('config:copy').catch(() => {})
      toast('config:copy deleted — site defaults are back in effect')
      await switchTab(currentTab)
    }
    else if (a === 'cfg-vp-save') {
      const out = sanitizeVoicePrompt({
        id: $('#cfg-vp-id').value,
        text: $('#cfg-vp-text').value,
        deadline: $('#cfg-vp-deadline').value,
      })
      if (!out) { toast('Prompt needs an id (slug) and text — or use reset for the generic default', true); return }
      await putKv('config:voice_prompt', JSON.stringify(out))
      toast(`Saved config:voice_prompt (${out.id}) on ${env()}`)
      await switchTab(currentTab)
    }
    else if (a === 'cfg-vp-reset') {
      if (!confirm(`Delete config:voice_prompt on ${env()}?\n\nThe site falls back to the generic default prompt ("${DEFAULT_VOICE_PROMPT.text}", id "${DEFAULT_VOICE_PROMPT.id}").`)) return
      await delKv('config:voice_prompt').catch(() => {})
      toast('config:voice_prompt deleted — generic default prompt is back')
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
  // Stats are derived from whichever namespace was read — never show
  // production numbers under a staging header, or vice versa.
  statsCache = null
  switchTab(currentTab)
})
$('#refresh').addEventListener('click', () => {
  statsCache = null
  switchTab(currentTab)
})
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

// Reopen on the tab from the last visit; pre-collapse auth tab names map to
// the merged Auth tab, other unknown/stale names fall back to members.
const storedTab = localStorage.jxnfc_admin_tab
switchTab(TABS[storedTab] ? storedTab : LEGACY_AUTH_TABS.includes(storedTab) ? 'auth' : 'members')
