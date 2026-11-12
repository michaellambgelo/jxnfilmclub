// Events tab of the admin dashboard — vanilla JS, no build step.
//
// Split out of admin.js the way contentgen.js is: admin.js owns the shell
// (tabs, env switch, toast, the fetch wrapper) and hands them in as `ctx`;
// this module owns everything about events and imports only lib.js, never
// admin.js. It registers its own delegated listeners, like Giveaways.
//
// A NEW ADMIN FILE MUST BE REGISTERED in four places or it works locally and
// 404s on admin.jxnfilm.club: the import + STATIC map in
// admin/worker/src/index.js, the Text rule in admin/worker/wrangler.toml,
// isText in tests/admin-worker/vitest.config.ts, and the gated-path list in
// tests/admin-worker/admin-worker.test.js.
//
// Shape of the tab: a compact list (upcoming, then past) where ONE event is
// open at a time, and one form shared by create, edit and duplicate. The pure
// half — ordering, validation, what a save sends — lives in lib.js and is
// unit-tested there; this file is DOM and network only.
import {
  qs, escapeHtml, attr, tryParse, normalizeAttendees, rsvpEnabled, sanitizeAdminEvent,
  eventIdFrom, newEventIssues, editEventIssues, groupEvents, eventSearchText,
  eventFormValues, eventPutDiff, applyEventDiff, duplicateSeed, eventAdmission,
  ADMISSION_LABELS, EVENT_TEXT_FIELDS, fmtShowtime } from './lib.js'

const $ = (sel) => document.querySelector(sel)

// Set on every render. Null until the tab has been opened once, which is also
// what keeps the listeners below inert on every other tab.
let ctx = null
const api = (...args) => ctx.api(...args)
const env = () => ctx.env()
const content = () => ctx.content()
const toast = (...args) => ctx.toast(...args)

const loadKv = (prefix, binding) =>
  api('GET', `/api/kv?${qs({ env: env(), binding, prefix })}`)
const putKv = (key, value, binding) =>
  api('PUT', `/api/kv?${qs({ env: env(), binding, key })}`, value)

// --- State (ATTENDANCE_KV: event:{id} canonical + events:all aggregate) ---
//
// The public site reads events through the Worker's GET /events, so a save
// here is live on /events immediately. snapshot-events.yml commits
// data/events.json from the Worker every 6h as the archive / fallback.

const NEW = '\u0000new'        // openId for the create panel; never a real id
const PAST_PREVIEW = 15

let events = []
let attendance = {}
let rsvps = {}
let openId = null              // an event id, NEW, or null
let newSeed = null             // { values, from } when the create panel is a copy
let snapshot = ''              // the open form as rendered, for the dirty check
let showAllPast = false
let tmdbResults = []

const centralToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
const eventById = (id) => events.find(e => e.id === id)
const rsvpOf = (id) => rsvps[id] || { confirmed: [], waitlist: [] }
const preSale = (e) => !!(e && e.ticketed && !e.ticketUrl && rsvpEnabled(e))

// --- Load + shell ---

export async function renderEvents(c) {
  ctx = c
  // Per-event rows first; if the namespace is empty, fall back to the
  // events:all aggregate (which the Worker seeds from data/events.json).
  const perEvent = await loadKv('event:', 'ATTENDANCE_KV')
  if (perEvent.keys.length) {
    events = perEvent.keys.map(k => tryParse(perEvent.values[k.name])).filter(Boolean)
  } else {
    const agg = await loadKv('events:all', 'ATTENDANCE_KV')
    events = tryParse(agg.values['events:all']) || []
  }
  const attendRaw = await loadKv('attend:', 'ATTENDANCE_KV')
  attendance = {}
  for (const k of attendRaw.keys) {
    // Entries are { id, name } keyed on member id; normalizeAttendees also
    // accepts the pre-migration [name] rows still sitting in KV.
    attendance[k.name.slice('attend:'.length)] = normalizeAttendees(tryParse(attendRaw.values[k.name]))
  }
  const rsvpRaw = await loadKv('rsvp:', 'ATTENDANCE_KV')
  rsvps = {}
  for (const k of rsvpRaw.keys) {
    rsvps[k.name.slice('rsvp:'.length)] = tryParse(rsvpRaw.values[k.name]) || { confirmed: [], waitlist: [] }
  }

  // A reload (refresh button, env switch) starts clean: a half-filled form
  // must not follow the operator from staging to production.
  openId = null
  newSeed = null
  showAllPast = false
  tmdbResults = []

  content().innerHTML = `
    <h2>Events <span class="muted" id="ev-count"></span></h2>
    <p class="section-hint">Saves go through the join Worker and are live on <code>/events</code> immediately. Pick an event to edit it; one is open at a time.</p>
    <div class="toolbar">
      <button class="primary" data-action="event-new">+ new event</button>
      <input type="search" id="ev-search" class="list-search" placeholder="Search title, film, venue, date…" aria-label="Search events">
    </div>
    <div id="ev-new"></div>
    <div id="ev-list"></div>
  `
  $('#ev-search').addEventListener('input', applySearch)
  renderList()
}

// --- List ---

function fmtDay(date) {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(date || ''))
  if (!m) return { day: 'No date', year: '' }
  // Built from parts, so it is local midnight and cannot roll back a day.
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return { day: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), year: m[1] }
}

const KIND_LABELS = { house: 'House', meetup: 'Meetup', social: 'Social' }

function pillsHtml(e) {
  const out = []
  const kind = e.kind || (e.hostId ? 'house' : '')
  if (KIND_LABELS[kind]) out.push(`<span class="pill off">${KIND_LABELS[kind]}</span>`)
  // The effective admission, so a legacy ticketed row still reads as one.
  // Nothing at all when the question has never been answered.
  const adm = eventAdmission(e)
  if (adm) out.push(`<span class="pill ${adm === 'free' ? 'on' : 'off'}">${ADMISSION_LABELS[adm]}</span>`)
  const r = rsvpOf(e.id)
  if (rsvpEnabled(e)) {
    if (preSale(e)) {
      out.push(`<span class="pill warn">Pre-sale · ${r.waitlist.length} queued</span>`)
    } else {
      const cap = e.capacity ? `/${e.capacity}` : ''
      const wl = r.waitlist.length ? ` · ${r.waitlist.length} waitlisted` : ''
      out.push(`<span class="pill off">${r.confirmed.length}${cap} RSVPed${wl}</span>`)
    }
  } else {
    const n = (attendance[e.id] || []).length
    if (n) out.push(`<span class="pill off">${n} ${String(e.date || '') >= centralToday() ? 'going' : 'attended'}</span>`)
  }
  return out.join('')
}

function rowInnerHtml(e) {
  const { day, year } = fmtDay(e.date)
  const time = fmtShowtime(e.time)
  const sub = []
  if (e.film && e.film !== e.title) sub.push(escapeHtml(e.film) + (e.year ? ` (${escapeHtml(e.year)})` : ''))
  if (e.venue) sub.push(escapeHtml(e.venue))
  if (e.hostId) sub.push(`hosted by ${escapeHtml(e.hostName || 'a member')}`)
  return `
      <span class="list-row-when"><b>${escapeHtml(day)}</b><span>${escapeHtml([year, time].filter(Boolean).join(' · '))}</span></span>
      <span class="list-row-main"><strong>${escapeHtml(e.title || e.id)}</strong><span>${sub.join(' · ')}</span></span>
      <span class="list-row-pills">${pillsHtml(e)}</span>`
}

function itemHtml(e, more) {
  const open = openId === e.id
  return `
    <div class="list-item${open ? ' -open' : ''}${more && !open ? ' -more' : ''}" data-id="${attr(e.id)}" data-search="${attr(eventSearchText(e))}">
      <button type="button" class="list-row" data-action="event-open" data-id="${attr(e.id)}" aria-expanded="${open}">${rowInnerHtml(e)}</button>
      ${open ? detailHtml(e) : ''}
    </div>`
}

function groupHtml(title, list, { preview = Infinity, empty }) {
  const rows = list.map((e, i) => itemHtml(e, i >= preview)).join('')
  const more = list.length > preview
    ? `<button type="button" class="list-more" data-action="event-past-all">Show all ${list.length} past events</button>`
    : ''
  return `
    <section class="list-group">
      <h3>${title} <span class="muted">(${list.length})</span></h3>
      ${rows || `<p class="empty">${empty}</p>`}
      <p class="empty list-none" hidden>No ${title.toLowerCase()} events match.</p>
      ${more}
    </section>`
}

function renderList() {
  const { upcoming, past } = groupEvents(events, centralToday())
  $('#ev-count').textContent = `(${events.length})`
  $('#ev-new').innerHTML = openId === NEW ? newPanelHtml() : ''
  $('#ev-list').innerHTML =
    groupHtml('Upcoming', upcoming, { empty: 'Nothing scheduled.' }) +
    groupHtml('Past', past, { preview: PAST_PREVIEW, empty: 'No past events.' })
  applySearch()
  afterFormRender()
}

// Search and "show all past" only toggle `hidden`. They never re-render,
// because a re-render would throw away whatever is typed into the open form.
function applySearch() {
  const q = ($('#ev-search') ? $('#ev-search').value : '').toLowerCase().trim()
  document.querySelectorAll('#ev-list .list-group').forEach(group => {
    let shown = 0
    const items = group.querySelectorAll('.list-item')
    items.forEach(item => {
      const match = !q || item.dataset.search.includes(q)
      // A search looks through every past event, not just the first screenful.
      const folded = !q && !showAllPast && item.classList.contains('-more')
      item.hidden = !match || folded
      if (!item.hidden) shown++
    })
    const none = group.querySelector('.list-none')
    if (none) none.hidden = !(q && items.length && !shown)
    const more = group.querySelector('.list-more')
    if (more) more.hidden = !!q || showAllPast
  })
}

// Row + people block only — for guest and attendance changes, which must not
// disturb unsaved edits in the form sitting right above them.
async function refreshPeople(id) {
  const [r, a] = await Promise.all([
    loadKv(`rsvp:${id}`, 'ATTENDANCE_KV'), loadKv(`attend:${id}`, 'ATTENDANCE_KV'),
  ])
  // Exact key: a prefix read of rsvp:x also returns rsvp:x-2.
  rsvps[id] = tryParse(r.values[`rsvp:${id}`]) || { confirmed: [], waitlist: [] }
  attendance[id] = normalizeAttendees(tryParse(a.values[`attend:${id}`]))
  const e = eventById(id)
  const item = document.querySelector(`#ev-list .list-item[data-id="${CSS.escape(id)}"]`)
  if (!e || !item) return
  item.querySelector('.list-row').innerHTML = rowInnerHtml(e)
  const people = item.querySelector('[data-people]')
  if (people) people.innerHTML = peopleHtml(e)
}

// --- The shared form (create, edit, duplicate) ---

const KIND_OPTIONS = [
  ['', 'Club screening'], ['house', 'House screening'], ['meetup', 'Theater meetup'], ['social', 'Social (no film)'],
]

const ADMISSION_CHOICES = [
  ['free', 'Free', 'Nothing to buy. Tagged Free on the site and in RSVP emails.'],
  ['ticketed', 'Ticketed', 'The venue sells admission. RSVPs queue until you add a ticket link, then everyone on the list is emailed it.'],
  ['own', 'Buy your own', 'Self-organized: everyone gets their own ticket. No pre-sale list.'],
]

function admissionHtml(mode, v, e) {
  const choices = [...ADMISSION_CHOICES]
  // "Not set" exists only for a row that has never been asked. Once an
  // answer is stored the option is gone, so the form cannot un-answer it —
  // and a new event never gets it at all.
  if (mode === 'edit' && !v.admission) {
    const eff = eventAdmission(e)
    choices.unshift(['', 'Not set', eff
      ? `Behaves as ${ADMISSION_LABELS[eff]}, which is what this event already meant. Pick one to say so.`
      : 'No label. This event predates the admission choice and nothing changes unless you pick one.'])
  }
  return `<div class="choices" role="radiogroup" aria-label="Admission">${choices.map(([value, label, hint]) => `
        <label class="choice">
          <input type="radio" name="admission" value="${attr(value)}"${v.admission === value && (value || mode === 'edit') ? ' checked' : ''}>
          <span><strong>${label}</strong><span class="muted">${hint}</span></span>
        </label>`).join('')}
      </div>`
}

function formHtml(mode, v, e) {
  const create = mode === 'create'
  const hosted = !!(e && e.hostId)
  const audience = !create && rsvpEnabled(e) ? rsvpAudience(e.id) : ''
  const req = '<span class="req">*</span>'
  return `
    <div class="form" data-form="${mode}"${hosted ? ' data-hosted="1"' : ''}>
      <fieldset class="form-section">
        <legend>Film</legend>
        <div class="form-grid">
          <div class="-wide"><label>Film <span class="muted">— search TMDB to fill the year and poster</span></label>
            <div class="form-inline">
              <input type="text" name="film" value="${attr(v.film)}" placeholder="Clayface">
              <button type="button" data-action="event-tmdb">search</button>
            </div></div>
          <div class="nl-poster-strip -wide" data-tmdb hidden></div>
          <div><label>Year</label><input type="number" name="year" value="${attr(v.year)}" placeholder="2026"></div>
        </div>
      </fieldset>

      <fieldset class="form-section">
        <legend>Basics</legend>
        <div class="form-grid">
          <div class="-wide"><label>Title ${req}</label><input type="text" name="title" value="${attr(v.title)}" placeholder="CLAYFACE Preview Screening"></div>
          <div><label>Kind${hosted ? ' <span class="muted">— fixed on a member-hosted screening</span>' : ''}</label>
            <select name="kind"${hosted ? ' disabled' : ''}>
              ${KIND_OPTIONS.map(([k, label]) => `<option value="${attr(k)}"${v.kind === k ? ' selected' : ''}>${label}</option>`).join('')}
            </select></div>
        </div>
      </fieldset>

      <fieldset class="form-section">
        <legend>When &amp; where</legend>
        <div class="form-grid">
          <div><label>Date ${req}</label><input type="date" name="date" value="${attr(v.date)}"></div>
          <div><label>Time <span class="muted">— showtime</span></label><input type="time" name="time" value="${attr(v.time)}"></div>
          <div class="-wide"><label>Venue</label><input type="text" name="venue" value="${attr(v.venue)}" placeholder="Capri Theater"></div>
        </div>
      </fieldset>

      <fieldset class="form-section">
        <legend>Admission &amp; RSVP${create ? ` ${req}` : ''}</legend>
        ${admissionHtml(mode, v, e)}
        ${!create && preSale(e) ? `<p class="form-banner">Tickets are not on sale yet, so RSVPs are queueing (${rsvpOf(e.id).waitlist.length} so far). Saving a ticket link confirms the whole list and emails everyone the link.</p>` : ''}
        <div class="form-grid">
          <div class="-wide" data-when="ticket"><label>Ticket link <span class="muted">— box office URL; leave blank until tickets go on sale</span></label>
            <input type="url" name="ticketUrl" value="${attr(v.ticketUrl)}" placeholder="https://...">
            <p class="form-warn" data-when="free-link" hidden>This event is Free but has a ticket link, so members will see both. Clear the link if that is not what you mean.</p></div>
          <div><label>RSVP</label>
            <label class="cfg-inline"><input type="checkbox" name="rsvp"${v.rsvp ? ' checked' : ''}>
              <span>Collect RSVPs</span></label>
            <p class="muted form-hint">Off: members mark their own attendance instead.</p></div>
          <div><label>Capacity <span class="muted">— blank = no limit</span></label><input type="number" name="capacity" min="1" value="${attr(v.capacity)}"></div>
        </div>
      </fieldset>

      <fieldset class="form-section">
        <legend>Private</legend>
        <div class="form-grid">
          <div class="-wide" data-when="address"><label>Address <span class="muted">— only ever emailed to confirmed RSVPs; deleted 30 days after the event</span></label>
            <input type="text" name="address" value="${attr(v.address)}"></div>
          <div class="-wide"><label>Notes <span class="muted">— included in every RSVP email; never public</span></label>
            <textarea name="notes" rows="3">${escapeHtml(v.notes)}</textarea></div>
        </div>
      </fieldset>

      <details class="form-section form-advanced"${create ? ' open' : ''}>
        <summary>Advanced</summary>
        <div class="form-grid">
          ${create
            ? `<div class="-wide"><label>ID <span class="muted">— derived from date + film; edit if two events share both. It cannot be changed later.</span></label>
                <input type="text" name="id" placeholder="2026-10-22-clayface"></div>`
            : `<div class="-wide"><label>ID</label><p class="form-static"><code>${escapeHtml(e.id)}</code></p></div>`}
          <div><label>Poster URL</label><input type="url" name="poster" value="${attr(v.poster)}" placeholder="https://..."></div>
          <div><label>Letterboxd URI</label><input type="url" name="letterboxd_uri" value="${attr(v.letterboxd_uri)}" placeholder="https://boxd.it/..."></div>
        </div>
      </details>

      <ul class="form-issues" data-issues hidden></ul>
      ${audience ? `
      <label class="cfg-inline notify-rsvps">
        <input type="checkbox" name="notify-rsvps">
        <span>Email ${escapeHtml(audience)} about this change</span>
      </label>` : ''}
      <div class="form-foot">
        ${create
          ? `<button class="primary" data-action="event-create">Create event</button>
             <button type="button" data-action="event-close">Cancel</button>`
          : `<button class="primary" data-action="event-save" data-id="${attr(e.id)}">Save</button>
             <button type="button" data-action="event-close">Close</button>
             <span class="form-foot-gap"></span>
             <button type="button" data-action="event-dup" data-id="${attr(e.id)}">Duplicate</button>
             <button class="danger" data-action="event-del" data-id="${attr(e.id)}">Delete event</button>`}
      </div>
    </div>`
}

function newPanelHtml() {
  const values = newSeed ? newSeed.values : { ...eventFormValues({}), date: centralToday(), rsvp: true }
  return `
    <section class="detail -new" id="event-new-panel">
      <h3>${newSeed ? `New event <span class="muted">— a copy of ${escapeHtml(newSeed.from)}</span>` : 'New event'}</h3>
      <p class="section-hint">Creating publishes straight to <code>/events</code>.${newSeed ? ' Private notes, the address, the ticket link and RSVPs were not copied. Set the new date.' : ''}</p>
      ${formHtml('create', values, null)}
    </section>`
}

function detailHtml(e) {
  return `
      <div class="detail">
        ${e.hostId ? `<p class="detail-note">Member-hosted by ${escapeHtml(e.hostName || 'a member')} <span class="muted">(host id <code>${escapeHtml(e.hostId)}</code>). The host cannot be changed here.</span></p>` : ''}
        ${formHtml('edit', eventFormValues(e), e)}
        <div data-people>${peopleHtml(e)}</div>
      </div>`
}

// Everything the form holds, as lib.js's eventPutDiff expects it. Scoped to
// the [data-form] element, which holds exactly the event fields: the guest-add
// inputs live in the people block beside it, never inside it.
function readForm(form) {
  const out = {}
  for (const f of EVENT_TEXT_FIELDS) {
    const el = form.querySelector(`[name="${f}"]`)
    if (el) out[f] = (el.value || '').trim()
  }
  // A hidden field is one this event should not carry. For the address that
  // matters: the 30-day scrub only reaches events that take RSVPs or have a
  // host, so an address must not survive on a row that is neither.
  const hidden = (when) => { const w = form.querySelector(`[data-when="${when}"]`); return !!w && w.hidden }
  if (hidden('address')) out.address = ''
  if (hidden('ticket')) out.ticketUrl = ''
  out.rsvp = !!form.querySelector('[name="rsvp"]').checked
  const adm = form.querySelector('[name="admission"]:checked')
  out.admission = adm ? adm.value : ''
  const id = form.querySelector('[name="id"]')
  if (id) out.id = (id.value || '').trim()
  return out
}

// Show/hide the fields that depend on other fields. Runs on every input.
function syncForm(form) {
  const val = (name) => { const el = form.querySelector(`[name="${name}"]`); return el ? (el.value || '').trim() : '' }
  const hosted = form.dataset.hosted === '1'
  const house = val('kind') === 'house' || (hosted && !val('kind'))
  // Nobody sells tickets to a living room: a house screening is Free or unset.
  form.querySelectorAll('[name="admission"]').forEach(r => {
    if (r.value === 'ticketed' || r.value === 'own') {
      r.disabled = house
      if (house && r.checked) form.querySelector('[name="admission"][value="free"]').checked = true
    }
  })
  const picked = form.querySelector('[name="admission"]:checked')
  const adm = picked ? picked.value : ''
  const link = val('ticketUrl')
  const show = (when, on) => { const w = form.querySelector(`[data-when="${when}"]`); if (w) w.hidden = !on }
  show('ticket', !house && (adm !== 'free' || !!link))
  show('free-link', adm === 'free' && !!link)
  show('address', house && (hosted || form.querySelector('[name="rsvp"]').checked))
}

// Re-derive the id from date + film/title, unless the operator typed their own.
function syncNewId(form) {
  const id = form.querySelector('[name="id"]')
  if (!id || id.dataset.touched === '1') return
  const val = (name) => (form.querySelector(`[name="${name}"]`).value || '').trim()
  id.value = eventIdFrom(val('date'), val('film') || val('title'))
}

function openForm() { return document.querySelector('#content [data-form]') }

function afterFormRender() {
  const form = openForm()
  if (!form) { snapshot = ''; return }
  syncForm(form)
  if (form.dataset.form === 'create') syncNewId(form)
  snapshot = JSON.stringify(readForm(form))
}

// True when it is safe to throw the open form away.
function confirmDiscard() {
  const form = openForm()
  if (!form || JSON.stringify(readForm(form)) === snapshot) return true
  return confirm('Discard the unsaved changes in the open event?')
}

function showIssues(form, issues) {
  const box = form.querySelector('[data-issues]')
  box.innerHTML = issues.map(i => `<li>${escapeHtml(i)}</li>`).join('')
  box.hidden = !issues.length
  if (issues.length) {
    box.scrollIntoView({ block: 'nearest' })
    toast(issues.length === 1 ? issues[0] : `${issues.length} things need fixing before this can be saved`, true)
  }
  return issues.length
}

// --- People: RSVPs or attendance ---

// "3 confirmed + 2 waitlisted" — the audience for a notification. Empty when
// there is nobody to mail.
function rsvpAudience(id) {
  const r = rsvpOf(id)
  const withEmail = (list) => (list || []).filter(x => x && x.email).length
  const c = withEmail(r.confirmed), w = withEmail(r.waitlist)
  const parts = []
  if (c) parts.push(`${c} confirmed`)
  if (w) parts.push(`${w} waitlisted`)
  return parts.join(' + ')
}

// An event takes RSVPs or the post-hoc attendance toggle, never both: when
// RSVPs are on, the attendance list is only a mirror of the confirmed list.
function peopleHtml(e) {
  if (!rsvpEnabled(e)) {
    const list = attendance[e.id] || []
    return `
      <div class="attendance">
        <strong>Attendance (${list.length})</strong>
        <ul>
          ${list.map((a, ai) => `
            <li>${escapeHtml(a.name)}${a.id ? '' : ' <span class="stat-flag" title="No member id on this row — it predates the id migration, or matched no member">unlinked</span>'}
              <button class="danger" data-action="attend-rm" data-event="${attr(e.id)}" data-idx="${ai}">remove</button>
            </li>`).join('') || '<li class="muted">no attendees</li>'}
        </ul>
      </div>`
  }
  // Emails are visible: this dashboard already reads raw KV behind Access.
  // Adds/removes go through /api/rsvp/guest → join Worker, NOT raw KV, so
  // capacity, the waitlist, the emails and the attendance mirror all hold.
  const rsvp = rsvpOf(e.id)
  const isGuest = r => typeof r.memberId === 'string' && r.memberId.startsWith('guest:')
  const entry = (r, tag) => `
          <li>${escapeHtml(r.name || '(no name)')}${r.email ? ` &lt;${escapeHtml(r.email)}&gt;` : ''}${tag ? ` <span class="muted">${tag}</span>` : ''}${isGuest(r) ? ' <span class="muted">[guest]</span>' : ''}
            ${isGuest(r) ? `<button class="danger" data-action="guest-rm" data-event="${attr(e.id)}" data-id="${attr(r.memberId)}">remove guest</button>` : ''}
          </li>`
  return `
      <div class="attendance rsvp-admin">
        <strong>RSVPs (${rsvp.confirmed.length} confirmed${rsvp.waitlist.length ? `, ${rsvp.waitlist.length} ${preSale(e) ? 'queued for tickets' : 'waitlisted'}` : ''})</strong>
        <ul>
          ${rsvp.confirmed.map(r => entry(r, '')).join('') || '<li class="muted">no confirmed RSVPs</li>'}
          ${rsvp.waitlist.map(r => entry(r, preSale(e) ? '(pre-sale list)' : '(waitlist)')).join('')}
        </ul>
        <div class="guest-add form-inline">
          <input type="text" name="guest-name" placeholder="Guest name">
          <input type="email" name="guest-email" placeholder="Email (optional)">
          <label class="muted"><input type="checkbox" name="guest-force"> force over capacity</label>
          <button class="primary" data-action="guest-add" data-event="${attr(e.id)}">add guest</button>
        </div>
      </div>`
}

// --- Writes ---

// Event writes go through the join Worker (PUT /admin/events/:id), never the
// raw /api/kv shim. A KV write cannot promote a waitlist, cannot enforce the
// capacity guard, and cannot tell twenty people the date moved.
//
// `notify` is an explicit opt-in: fixing a typo should not mail the room.
// `create` makes the Worker 409 instead of overwriting an id that already
// exists — the form checks too, but only against the list it loaded.
async function saveEvent(row, { notify = false, create = false } = {}) {
  const ev = sanitizeAdminEvent(row)
  return api('PUT', `/api/events?${qs({ env: env(), id: ev.id })}`,
    JSON.stringify({ event: ev, notify: !!notify, ...(create ? { create: true } : {}) }))
}

// Cancellation notices then teardown, all Worker-side: event:, rsvp:, attend:
// and both aggregates. Always notifies — the event is gone, and the failure
// mode of staying quiet is somebody standing outside a venue.
const deleteEvent = (id) => api('DELETE', `/api/events?${qs({ env: env(), id })}`)

// Human-readable diff of what the Worker will put in the email body. Kept in
// step with diffEventNotifiable() in worker/src/index.js — this is the
// preview, that is the authority.
function describeEventChanges(before, after) {
  const out = []
  for (const f of ['date', 'time', 'venue', 'address', 'title']) {
    const a = (before && before[f]) || '', b = (after && after[f]) || ''
    if (a !== b) out.push(`${f}: ${a || '(blank)'} → ${b || '(blank)'}`)
  }
  const a = eventAdmission(before), b = eventAdmission(after)
  if (a !== b) out.push(`admission: ${ADMISSION_LABELS[a] || '(blank)'} → ${ADMISSION_LABELS[b] || '(blank)'}`)
  return out
}

// --- Actions ---

async function onSave(btn) {
  const form = btn.closest('[data-form]')
  const before = eventById(btn.dataset.id)
  if (!before) return
  const values = readForm(form)
  if (showIssues(form, editEventIssues(values))) return
  const diff = eventPutDiff(before, values)
  const notifyBox = form.querySelector('[name="notify-rsvps"]')
  const notify = !!(notifyBox && notifyBox.checked)
  if (!Object.keys(diff).length && !notify) { toast('No changes to save'); return }

  const after = applyEventDiff(before, diff)
  // `ticketed` follows admission Worker-side; mirror it so the preview below
  // and the cache agree with what will be stored.
  if (diff.admission) after.ticketed = diff.admission === 'ticketed'
  const name = after.title || after.id

  // Mailing people is not undoable, so name the count and the change before
  // it happens rather than reporting it afterwards.
  if (notify) {
    const audience = rsvpAudience(before.id)
    if (!audience) { toast('Nobody has RSVPed yet — nothing to notify', true); return }
    const changes = describeEventChanges(before, after)
    const what = changes.length ? changes.map(c => `  • ${c}`).join('\n') : '  • (no where/when change — this re-sends the details)'
    if (!confirm(`Email ${audience} about "${name}"?\n\n${what}\n\nThis cannot be undone.`)) return
  }

  const res = await saveEvent({ id: before.id, ...diff }, { notify })
  // Cache what the Worker stored, not what the form sent.
  events[events.indexOf(before)] = { ...after, ...res.event }
  // A save can move people: a raised cap or a landed ticket link promotes.
  await refreshPeople(before.id)
  renderList()
  toast(res.ticketsOnSale
    ? `Saved "${name}" — tickets on sale, emailed ${res.notified} ${res.notified === 1 ? 'person' : 'people'} the link`
    : res.notified
      ? `Saved "${name}" — emailed ${res.notified} ${res.notified === 1 ? 'person' : 'people'}`
      : `Saved "${name}"`)
}

async function onCreate(btn) {
  const form = btn.closest('[data-form]')
  const values = readForm(form)
  // Nothing is written until this passes: a half-made event must never exist
  // in public.
  if (showIssues(form, newEventIssues(values, events.map(e => e.id)))) return
  const row = { id: values.id, ...eventPutDiff(null, values, { create: true }) }
  const res = await saveEvent(row, { create: true })
  events.push({ ...row, ...res.event })
  openId = null
  newSeed = null
  renderList()
  toast(`Created "${row.title}" — live on /events`)
  const item = document.querySelector(`#ev-list .list-item[data-id="${CSS.escape(row.id)}"]`)
  if (item) item.scrollIntoView({ block: 'center' })
}

async function onDelete(btn) {
  const ev = eventById(btn.dataset.id)
  if (!ev) return
  const audience = rsvpAudience(ev.id)
  const warn = audience ? `\n\n⚠️ ${audience} will be emailed a cancellation notice. This cannot be undone.` : ''
  if (!confirm(`Delete event "${ev.title || ev.id}"?\n\nClears event:${ev.id}, rsvp:${ev.id} and attend:${ev.id}, and removes it from both aggregates.${warn}`)) return
  const res = await deleteEvent(ev.id)
  events.splice(events.indexOf(ev), 1)
  openId = null
  renderList()
  toast(res.notified ? `Deleted event — emailed ${res.notified}` : 'Deleted event')
}

function openPanel(id, seed = null) {
  if (!confirmDiscard()) return false
  openId = id
  newSeed = seed
  tmdbResults = []
  renderList()
  return true
}

async function onTmdb(btn) {
  const form = btn.closest('[data-form]')
  const q = (form.querySelector('[name="film"]').value || '').trim()
  if (!q) { toast('Enter a film title to search', true); return }
  const r = await api('GET', `/api/tmdb/search?${qs({ env: env(), q })}`)
  tmdbResults = r.results || []
  const strip = form.querySelector('[data-tmdb]')
  if (!tmdbResults.length) { strip.hidden = true; toast(`No results for "${q}"`, true); return }
  strip.innerHTML = tmdbResults.map((p, i) => `
    <button type="button" class="nl-poster-thumb" data-action="event-tmdb-pick" data-idx="${i}" title="Use this film">
      <img src="${attr(p.thumb)}" alt="">
      <span>${escapeHtml(p.title)}${p.year ? ` (${escapeHtml(p.year)})` : ''}</span>
    </button>`).join('')
  strip.hidden = false
}

function onTmdbPick(btn) {
  const p = tmdbResults[Number(btn.dataset.idx)]
  if (!p) return
  const form = btn.closest('[data-form]')
  const set = (name, value) => { form.querySelector(`[name="${name}"]`).value = value }
  set('film', p.title)
  if (p.year) set('year', p.year)
  if (p.poster) set('poster', p.poster)
  // The event title is editorial ("CLAYFACE Preview Screening"), so it is
  // only seeded when still blank — never overwritten from TMDB.
  if (!form.querySelector('[name="title"]').value.trim()) set('title', p.title)
  form.querySelector('[data-tmdb]').hidden = true
  if (form.dataset.form === 'create') syncNewId(form)
  toast(`Filled from ${p.title}`)
}

const ACTIONS = {
  'event-open': (btn) => { openPanel(openId === btn.dataset.id ? null : btn.dataset.id) },
  'event-new': () => {
    if (!openPanel(NEW)) return
    $('#event-new-panel').scrollIntoView({ block: 'start' })
    $('#event-new-panel [name="film"]').focus()
  },
  'event-dup': (btn) => {
    const src = eventById(btn.dataset.id)
    if (!src || !openPanel(NEW, { values: duplicateSeed(src), from: src.title || src.id })) return
    $('#event-new-panel').scrollIntoView({ block: 'start' })
    $('#event-new-panel [name="date"]').focus()
  },
  'event-close': () => { openPanel(null) },
  'event-past-all': () => { showAllPast = true; applySearch() },
  'event-tmdb': onTmdb,
  'event-tmdb-pick': onTmdbPick,
  'event-save': onSave,
  'event-create': onCreate,
  'event-del': onDelete,
  'guest-add': async (btn) => {
    const wrap = btn.closest('.guest-add')
    const name = (wrap.querySelector('input[name="guest-name"]').value || '').trim()
    const email = (wrap.querySelector('input[name="guest-email"]').value || '').trim()
    const force = wrap.querySelector('input[name="guest-force"]').checked
    if (!name) { toast('Guest name is required', true); return }
    const body = { name }
    if (email) body.email = email
    if (force) body.force = true
    const r = await api('POST', `/api/rsvp/guest?${qs({ env: env(), event: btn.dataset.event })}`, JSON.stringify(body))
    await refreshPeople(btn.dataset.event)
    toast(`Added ${name} (${r.status})${email ? ' — confirmation emailed' : ''}`)
  },
  'guest-rm': async (btn) => {
    const { event: eventId, id } = btn.dataset
    if (!confirm(`Remove this guest from ${eventId}?\n\nIf they were confirmed and a waitlist exists, the next person is promoted and emailed.`)) return
    await api('DELETE', `/api/rsvp/guest?${qs({ env: env(), event: eventId })}`, JSON.stringify({ id }))
    await refreshPeople(eventId)
    toast('Guest removed')
  },
  'attend-rm': async (btn) => {
    // Index, not name: two attendees can share a display name, and only the
    // one the operator clicked should go.
    const eventId = btn.dataset.event
    const idx = Number(btn.dataset.idx)
    const current = attendance[eventId] || []
    const entry = current[idx]
    if (!entry) return
    if (!confirm(`Remove ${entry.name} from attendance for ${eventId}?`)) return
    const list = current.filter((_, i) => i !== idx)
    await putKv(`attend:${eventId}`, JSON.stringify(list), 'ATTENDANCE_KV')
    // Patch the aggregate too so /events/attendance reflects the change.
    const aggregateRaw = await loadKv('attendance:all', 'ATTENDANCE_KV')
    const aggregate = tryParse(aggregateRaw.values['attendance:all']) || {}
    aggregate[eventId] = list
    await putKv('attendance:all', JSON.stringify(aggregate), 'ATTENDANCE_KV')
    await refreshPeople(eventId)
    toast(`Removed ${entry.name} from ${eventId}`)
  },
}

document.addEventListener('click', async (e) => {
  if (!ctx) return
  const btn = e.target.closest('button[data-action]')
  const run = btn && ACTIONS[btn.dataset.action]
  if (!run) return
  try { await run(btn) }
  catch (err) { toast(err.message || String(err), true) }
})

// Dependent fields follow the form as it is typed into; nothing is re-rendered.
for (const type of ['input', 'change']) {
  document.addEventListener(type, (e) => {
    if (!ctx || !e.target.closest) return
    const form = e.target.closest('#content [data-form]')
    if (!form) return
    syncForm(form)
    if (form.dataset.form !== 'create') return
    if (e.target.name === 'id') e.target.dataset.touched = '1'
    else if (['date', 'film', 'title'].includes(e.target.name)) syncNewId(form)
  })
}
