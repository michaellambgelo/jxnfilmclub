// Events tab of the admin dashboard — vanilla JS, no build step.
//
// Split out of admin.js the way contentgen.js is: admin.js owns the shell
// (tabs, env switch, toast, the fetch wrapper) and hands them in as `ctx`;
// this module owns everything about events and imports only lib.js, never
// admin.js. It registers its own delegated click listener, like Giveaways.
//
// A NEW ADMIN FILE MUST BE REGISTERED in four places or it works locally and
// 404s on admin.jxnfilm.club: the import + STATIC map in
// admin/worker/src/index.js, the Text rule in admin/worker/wrangler.toml,
// isText in tests/admin-worker/vitest.config.ts, and the gated-path list in
// tests/admin-worker/admin-worker.test.js.
import {
  qs, escapeHtml, attr, tryParse, normalizeAttendees, rsvpEnabled,
  sanitizeAdminEvent, eventIdFrom, newEventIssues } from './lib.js'

const $ = (sel) => document.querySelector(sel)

// Set on every render. Null until the tab has been opened once, which is also
// what keeps the click listener below inert on every other tab.
let ctx = null
const api = (...args) => ctx.api(...args)
const env = () => ctx.env()
const content = () => ctx.content()
const toast = (...args) => ctx.toast(...args)

const loadKv = (prefix, binding) =>
  api('GET', `/api/kv?${qs({ env: env(), binding, prefix })}`)
const putKv = (key, value, binding) =>
  api('PUT', `/api/kv?${qs({ env: env(), binding, key })}`, value)

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
// Same-day events order by start time; a missing time sorts first in its day.
const eventWhen = (e) => String(e.date || '') + 'T' + String(e.time || '')
const EVENT_SORTS = {
  'date-asc': (a, b) => eventWhen(a).localeCompare(eventWhen(b)),
  'date-desc': (a, b) => eventWhen(b).localeCompare(eventWhen(a)),
  title: (a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id), undefined, { sensitivity: 'base' }),
  attendance: (a, b) => attendeeCount(b) - attendeeCount(a) || eventWhen(b).localeCompare(eventWhen(a)),
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

export async function renderEvents(c) {
  ctx = c
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
    // Entries are { id, name } keyed on member id; normalizeAttendees also
    // accepts the pre-migration [name] rows still sitting in KV.
    attendanceCache[eventId] = normalizeAttendees(tryParse(attendanceRaw.values[k.name]))
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
    ${renderNewEventForm()}
    <div id="events-list">${renderEventCards()}</div>
  `
  $('#ev-sort').value = eventsSort
  $('#ev-sort').addEventListener('change', () => {
    eventsSort = $('#ev-sort').value
    sortEvents()
    $('#events-list').innerHTML = renderEventCards()
  })
  wireNewEventForm()
}

// Event writes go through the join Worker (PUT /admin/events/:id), never the
// raw /api/kv shim. A KV write cannot promote a waitlist, cannot enforce the
// capacity guard, and cannot tell twenty people the date moved — and once
// club events could take RSVPs, all three became things an event save has to
// do. Guest RSVPs have proxied for the same reason since they shipped.
//
// `notify` is an explicit opt-in: fixing a typo should not mail the room.
// Returns { event, changes, notified } so the caller can report what went out.
async function saveEvent(raw, notify = false) {
  const ev = sanitizeAdminEvent(raw)
  return api('PUT', `/api/events?${qs({ env: env(), id: ev.id })}`, JSON.stringify({ event: ev, notify: !!notify }))
}

// Cancellation notices then teardown, all Worker-side: event:, rsvp:, attend:
// and both aggregates. Always notifies — the event is gone, and the failure
// mode of staying quiet is somebody standing outside a venue.
async function deleteEventKv(id) {
  return api('DELETE', `/api/events?${qs({ env: env(), id })}`)
}

// "3 confirmed + 2 waitlisted" — the audience for a notification, phrased for
// a confirm() dialog. Empty string when there is nobody to mail.
function rsvpAudience(id) {
  const r = (rsvpCache && rsvpCache[id]) || { confirmed: [], waitlist: [] }
  const withEmail = (list) => (list || []).filter(x => x && x.email).length
  const c = withEmail(r.confirmed), w = withEmail(r.waitlist)
  if (!c && !w) return ''
  const parts = []
  if (c) parts.push(`${c} confirmed`)
  if (w) parts.push(`${w} waitlisted`)
  return parts.join(' + ')
}

// Human-readable diff of the fields the Worker will put in the email body.
// Kept in step with diffEventNotifiable() in worker/src/index.js — this is
// the preview, that is the authority.
function describeEventChanges(before, after) {
  const out = []
  for (const f of ['date', 'time', 'venue', 'address', 'title']) {
    const a = (before && before[f]) || '', b = (after && after[f]) || ''
    if (a !== b) out.push(`${f}: ${a || '(blank)'} → ${b || '(blank)'}`)
  }
  return out
}

// Creating an event used to be a prompt() for a slug, which immediately wrote
// an "Untitled" row dated today — and since the public GET /events reads the
// same aggregate, that placeholder was live on the site until somebody
// finished it. This form is the editorial gate: nothing is written until every
// required field is present and the id is free, so a half-made event cannot
// exist in public. Open/closed state is module scope, because the tab
// re-renders on every save.
let newEventOpen = false
let newEventTmdb = []

function renderNewEventForm() {
  if (!newEventOpen) return ''
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
  return `
    <section class="event-new-panel" id="event-new-panel">
      <h3>New event</h3>
      <p class="section-hint">Creating publishes straight to <code>/events</code>. Title and date are required; everything else can be edited afterwards.</p>
      <div class="grid">
        <div style="grid-column:1/-1">
          <label>Film <span class="muted">— search TMDB to fill title, year and poster</span></label>
          <div class="toolbar">
            <input type="text" name="film" id="ne-film" placeholder="Clayface">
            <button type="button" data-action="event-new-tmdb">search</button>
          </div>
        </div>
        <div id="ne-tmdb-results" class="nl-poster-strip" hidden></div>
        <div><label>Title <span class="req">*</span></label><input type="text" name="title" id="ne-title" placeholder="CLAYFACE Preview Screening"></div>
        <div><label>Date <span class="req">*</span></label><input type="date" name="date" id="ne-date" value="${attr(today)}"></div>
        <div><label>Year</label><input type="number" name="year" id="ne-year" placeholder="2026"></div>
        <div><label>Venue</label><input type="text" name="venue" id="ne-venue" placeholder="Capri Theater"></div>
        <div><label>Kind</label><select name="kind" id="ne-kind">
          ${['', 'house', 'meetup', 'social'].map(k => `<option value="${attr(k)}">${k || '(none — club screening)'}</option>`).join('')}
        </select></div>
        <div><label>Time <span class="muted">— showtime</span></label><input type="time" name="time" id="ne-time"></div>
        <div><label>Capacity <span class="muted">— blank = uncapped</span></label><input type="number" name="capacity" id="ne-capacity" min="1"></div>
        <div><label>Poster URL</label><input type="url" name="poster" id="ne-poster" placeholder="https://..."></div>
        <div><label>Letterboxd URI</label><input type="url" name="letterboxd_uri" id="ne-lb" placeholder="https://boxd.it/..."></div>
        <div><label>Tickets</label>
          <label class="cfg-inline"><input type="checkbox" name="ticketed" id="ne-ticketed">
            <span class="muted">sold by the venue, not the club</span></label></div>
        <div><label>Ticket URL <span class="muted">— box office link; leave blank until tickets go on sale</span></label>
          <input type="url" name="ticketUrl" id="ne-ticket" placeholder="https://..."></div>
        <div><label>RSVP</label>
          <label class="cfg-inline"><input type="checkbox" name="rsvp" id="ne-rsvp" checked>
            <span class="muted">collect RSVPs instead of post-hoc attendance</span></label></div>
        <div style="grid-column:1/-1"><label>Notes <span class="muted">— included in every RSVP email; never public</span></label>
          <textarea name="notes" id="ne-notes" rows="2"></textarea></div>
        <div style="grid-column:1/-1"><label>ID <span class="muted">— derived from date + film; edit if two events share both</span></label>
          <input type="text" name="id" id="ne-id" placeholder="2026-10-22-clayface"></div>
      </div>
      <p class="ne-issues" id="ne-issues" hidden></p>
      <div class="toolbar">
        <button class="primary" data-action="event-create">Create event</button>
        <button type="button" data-action="event-new-cancel">Cancel</button>
      </div>
    </section>`
}

// Read the panel back into a row. Blank strings are dropped rather than sent:
// this is a CREATE, so there is no stored value for an empty field to clear.
function readNewEventForm() {
  const v = (id) => ($(id) ? $(id).value.trim() : '')
  const row = {
    id: v('#ne-id'), title: v('#ne-title'), date: v('#ne-date'), film: v('#ne-film'),
    year: v('#ne-year'), venue: v('#ne-venue'), kind: v('#ne-kind'), time: v('#ne-time'),
    capacity: v('#ne-capacity'), poster: v('#ne-poster'), letterboxd_uri: v('#ne-lb'),
    ticketUrl: v('#ne-ticket'), notes: v('#ne-notes'),
    rsvp: !!($('#ne-rsvp') && $('#ne-rsvp').checked),
    ticketed: !!($('#ne-ticketed') && $('#ne-ticketed').checked),
  }
  for (const k of Object.keys(row)) if (row[k] === '') delete row[k]
  if (row.year) row.year = Number(row.year)
  if (row.capacity) row.capacity = Number(row.capacity)
  return row
}

// Re-derive the id from date + film/title, unless the operator has typed their
// own. Tracked on the element so a re-render cannot lose the fact.
function syncNewEventId() {
  const idEl = $('#ne-id')
  if (!idEl || idEl.dataset.touched === '1') return
  idEl.value = eventIdFrom(
    $('#ne-date') ? $('#ne-date').value : '',
    ($('#ne-film') && $('#ne-film').value.trim()) || ($('#ne-title') && $('#ne-title').value.trim()) || '',
  )
}

function wireNewEventForm() {
  if (!newEventOpen) return
  for (const sel of ['#ne-date', '#ne-film', '#ne-title']) {
    const el = $(sel)
    if (el) el.addEventListener('input', syncNewEventId)
  }
  const idEl = $('#ne-id')
  if (idEl) idEl.addEventListener('input', () => { idEl.dataset.touched = '1' })
  syncNewEventId()
  const first = $('#ne-film')
  if (first) first.focus()
}

function renderEventCards() {
  if (!eventsCache.length) return '<p class="empty">No events yet.</p>'
  return eventsCache.map((e, i) => {
    const hosted = !!e.hostId
    return `
    <div class="event-form" data-idx="${i}">
      ${hosted ? `<p class="muted" style="margin:0 0 0.5rem">🏠 Member-hosted (host id <code>${attr(e.hostId)}</code>)</p>` : ''}
      ${e.kind === 'social' ? `<p class="muted" style="margin:0 0 0.5rem">🥂 Social event — the film fields below are optional.</p>` : ''}
      <div class="grid">
        <div><label>ID</label><input type="text" name="id" value="${attr(e.id)}" readonly></div>
        <div><label>Title</label><input type="text" name="title" value="${attr(e.title || '')}"></div>
        <div><label>Film</label><input type="text" name="film" value="${attr(e.film || '')}"></div>
        <div><label>Year</label><input type="number" name="year" value="${attr(e.year || '')}"></div>
        <div><label>Date</label><input type="date" name="date" value="${attr(e.date || '')}"></div>
        <div><label>Venue</label><input type="text" name="venue" value="${attr(e.venue || '')}"></div>
        <div><label>Poster URL</label><input type="url" name="poster" value="${attr(e.poster || '')}"></div>
        <div><label>Letterboxd URI</label><input type="url" name="letterboxd_uri" value="${attr(e.letterboxd_uri || '')}"></div>
        <div><label>Kind</label><select name="kind">
          ${['', 'house', 'meetup', 'social'].map(k => `<option value="${attr(k)}"${(e.kind || '') === k ? ' selected' : ''}>${k || '(none)'}</option>`).join('')}
        </select></div>
        <div><label>Time <span class="muted">— showtime</span></label><input type="time" name="time" value="${attr(e.time || '')}"></div>
        <div><label>Capacity <span class="muted">— blank = uncapped</span></label><input type="number" name="capacity" min="1" value="${attr(e.capacity || '')}"></div>
        <div><label>Tickets</label>
          <label class="cfg-inline"><input type="checkbox" name="ticketed"${e.ticketed ? ' checked' : ''}>
            <span class="muted">sold by the venue, not the club</span></label></div>
        <div><label>Ticket URL <span class="muted">— box office link; adding it releases the pre-sale list</span></label>
          <input type="url" name="ticketUrl" value="${attr(e.ticketUrl || '')}" placeholder="https://..."></div>
        <div><label>RSVP</label>
          <label class="cfg-inline"><input type="checkbox" name="rsvp"${rsvpEnabled(e) ? ' checked' : ''}>
            <span class="muted">${e.ticketed ? 'collect a headcount — never implies a seat' : 'collect RSVPs instead of post-hoc attendance'}</span></label></div>
        ${hosted ? `
        <div><label>Host name</label><input type="text" name="hostName" value="${attr(e.hostName || '')}"></div>
        <div style="grid-column:1/-1"><label>Address <span class="muted">— private; only emailed to confirmed RSVPs</span></label>
          <input type="text" name="address" value="${attr(e.address || '')}"></div>
        ` : ''}
        <div style="grid-column:1/-1"><label>Notes <span class="muted">— included in every RSVP email; never public</span></label>
          <textarea name="notes" rows="3">${escapeHtml(e.notes || '')}</textarea></div>
      </div>
      ${e.ticketed && !e.ticketUrl && rsvpEnabled(e) ? `<p class="muted" style="margin:0.5rem 0 0">🎟️ Tickets are not on sale yet, so RSVPs are queueing. Saving a <strong>Ticket URL</strong> releases the whole list and emails everyone the box office link.</p>` : ''}
      ${rsvpEnabled(e) && rsvpAudience(e.id) ? `
      <label class="cfg-inline notify-rsvps" style="margin:0.5rem 0 0">
        <input type="checkbox" name="notify-rsvps">
        <span>Email ${escapeHtml(rsvpAudience(e.id))} about this change</span>
      </label>` : ''}
      <div class="toolbar">
        <button class="primary" data-action="event-save" data-idx="${i}">save</button>
        <button class="danger" data-action="event-del" data-idx="${i}">delete event</button>
      </div>
      <div class="attendance">
        <strong>Attendance (${(attendanceCache[e.id] || []).length})</strong>
        <ul>
          ${(attendanceCache[e.id] || []).map((a, ai) => `
            <li>${escapeHtml(a.name)}${a.id ? '' : ' <span class="stat-flag" title="No member id on this row — it predates the id migration, or matched no member">unlinked</span>'}
              <button class="danger" data-action="attend-rm" data-event="${attr(e.id)}" data-idx="${ai}">remove</button>
            </li>
          `).join('') || '<li class="muted">no attendees</li>'}
        </ul>
      </div>
      ${rsvpEnabled(e) ? renderRsvpSection(e) : ''}
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

// --- Action dispatch ---

const EVENT_ACTIONS = new Set([
  'event-save', 'event-del', 'event-new', 'event-new-cancel', 'event-new-tmdb',
  'event-new-tmdb-pick', 'event-create', 'guest-add', 'guest-rm', 'attend-rm',
])

document.addEventListener('click', async (e) => {
  if (!ctx) return
  const btn = e.target.closest('button[data-action]')
  if (!btn || !EVENT_ACTIONS.has(btn.dataset.action)) return
  const a = btn.dataset.action

  try {
    if (a === 'event-save') {
      const idx = Number(btn.dataset.idx)
      const form = btn.closest('.event-form')
      const updated = { ...eventsCache[idx] }
      // Scoped to .grid, which holds exactly the event fields. An unscoped
      // scrape also swept up the guest-add inputs that renderRsvpSection()
      // renders lower down inside this same .event-form — and since a
      // checkbox's .value is the string "on" whether or not it is ticked,
      // that wrote a junk guest-force: "on" onto every hosted event row.
      //
      // `select` is in the list because Kind is one: a scrape of only
      // input+textarea would silently never read it, leaving kind stuck at
      // whatever it already was while the UI showed the new choice.
      form.querySelectorAll('.grid input, .grid select, .grid textarea').forEach(input => {
        // A checkbox carries its state in .checked; .value is the string "on"
        // when ticked and absent when not, which is never what we want stored.
        if (input.type === 'checkbox') { updated[input.name] = input.checked; return }
        // A blank field is sent as '' rather than dropped from the payload.
        // The Worker MERGES a PUT over the stored row (so a body that forgets
        // a field cannot wipe it, or silently uncap the event and promote the
        // waitlist), which means clearing has to be said out loud.
        const v = (input.value || '').trim()
        if (input.name === 'year' || input.name === 'capacity') {
          updated[input.name] = v ? Number(v) : ''
        }
        else updated[input.name] = v
      })
      // The notify box lives outside .grid (it is an instruction about this
      // save, not a field of the event), so it is read separately.
      const notifyBox = form.querySelector('input[name="notify-rsvps"]')
      const notify = !!(notifyBox && notifyBox.checked)

      // Mailing people is not undoable, so name the count and the change
      // before it happens rather than reporting it afterwards.
      if (notify) {
        const audience = rsvpAudience(updated.id)
        if (!audience) { toast('Nobody has RSVPed yet — nothing to notify', true); return }
        const diff = describeEventChanges(eventsCache[idx], updated)
        const what = diff.length ? diff.map(c => `  • ${c}`).join('\n') : '  • (no where/when change — this re-sends the details)'
        if (!confirm(`Email ${audience} about "${updated.title || updated.id}"?\n\n${what}\n\nThis cannot be undone.`)) return
      }

      const res = await saveEvent(updated, notify)
      // Cache what the Worker actually stored, not the raw scrape, so the
      // re-render shows the truth (e.g. a ticket link having cleared rsvp).
      eventsCache[idx] = { ...updated, ...res.event }
      toast(res.notified
        ? `Saved "${updated.title || updated.id}" — emailed ${res.notified} ${res.notified === 1 ? 'person' : 'people'}`
        : `Saved event "${updated.title || updated.id}"`)
      await ctx.reload()
    }
    else if (a === 'event-del') {
      const idx = Number(btn.dataset.idx)
      const ev = eventsCache[idx]
      const audience = rsvpAudience(ev.id)
      const warn = audience
        ? `\n\n⚠️ ${audience} will be emailed a cancellation notice. This cannot be undone.`
        : ''
      if (!confirm(`Delete event "${ev.title || ev.id}"?\n\nClears event:${ev.id}, rsvp:${ev.id} and attend:${ev.id}, and removes it from both aggregates.${warn}`)) return
      const res = await deleteEventKv(ev.id)
      eventsCache.splice(idx, 1)
      toast(res.notified ? `Deleted event — emailed ${res.notified}` : 'Deleted event')
      await ctx.reload()
    }
    else if (a === 'event-new') {
      newEventOpen = true
      newEventTmdb = []
      await ctx.reload()
      const panel = $('#event-new-panel')
      if (panel) panel.scrollIntoView()
    }
    else if (a === 'event-new-cancel') {
      newEventOpen = false
      newEventTmdb = []
      await ctx.reload()
    }
    else if (a === 'event-new-tmdb') {
      const q = $('#ne-film').value.trim()
      if (!q) { toast('Enter a film title to search', true); return }
      const r = await api('GET', `/api/tmdb/search?${qs({ env: env(), q })}`)
      newEventTmdb = r.results || []
      const strip = $('#ne-tmdb-results')
      if (!newEventTmdb.length) {
        strip.hidden = true
        toast(`No results for "${q}"`, true)
        return
      }
      strip.innerHTML = newEventTmdb.map((p, i) => `
        <button type="button" class="nl-poster-thumb" data-action="event-new-tmdb-pick" data-idx="${i}"
          title="Use this film">
          <img src="${attr(p.thumb)}" alt="">
          <span>${escapeHtml(p.title)}${p.year ? ` (${escapeHtml(p.year)})` : ''}</span>
        </button>`).join('')
      strip.hidden = false
    }
    else if (a === 'event-new-tmdb-pick') {
      const p = newEventTmdb[Number(btn.dataset.idx)]
      if (!p) return
      $('#ne-film').value = p.title
      if (p.year) $('#ne-year').value = p.year
      if (p.poster) $('#ne-poster').value = p.poster
      // The event title is editorial ("CLAYFACE Preview Screening"), so it is
      // only seeded when still blank — never overwritten from TMDB.
      if (!$('#ne-title').value.trim()) $('#ne-title').value = p.title
      $('#ne-tmdb-results').hidden = true
      syncNewEventId()
      toast(`Filled from ${p.title}`)
    }
    else if (a === 'event-create') {
      const row = readNewEventForm()
      // Nothing is written until this passes: the whole point is that a
      // half-made event never exists in public.
      const issues = newEventIssues({ ...row, id: row.id || '' }, eventsCache.map(e => e.id))
      const box = $('#ne-issues')
      if (issues.length) {
        box.textContent = issues[0]
        box.hidden = false
        toast(issues[0], true)
        return
      }
      box.hidden = true
      const created = await saveEvent(row)
      newEventOpen = false
      newEventTmdb = []
      eventsCache.push({ ...row, ...created.event })
      toast(`Created "${row.title}" — live on /events`)
      await ctx.reload()
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
      await ctx.reload()
    }
    else if (a === 'guest-rm') {
      const { event: eventId, id } = btn.dataset
      if (!confirm(`Remove this guest from ${eventId}?\n\nIf they were confirmed and a waitlist exists, the next person is promoted and emailed.`)) return
      await api('DELETE', `/api/rsvp/guest?${qs({ env: env(), event: eventId })}`, JSON.stringify({ id }))
      toast('Guest removed')
      await ctx.reload()
    }
    else if (a === 'attend-rm') {
      // Index, not name: two attendees can share a display name, and only the
      // one the operator clicked should go.
      const eventId = btn.dataset.event
      const idx = Number(btn.dataset.idx)
      const current = attendanceCache[eventId] || []
      const entry = current[idx]
      if (!entry) return
      if (!confirm(`Remove ${entry.name} from attendance for ${eventId}?`)) return
      const list = current.filter((_, i) => i !== idx)
      await putKv(`attend:${eventId}`, JSON.stringify(list), 'ATTENDANCE_KV')
      // Patch the aggregate too so /events/attendance reflects the change.
      const aggregateRaw = await loadKv('attendance:all', 'ATTENDANCE_KV')
      const aggregateValue = aggregateRaw.values['attendance:all']
      const aggregate = tryParse(aggregateValue) || {}
      aggregate[eventId] = list
      await putKv('attendance:all', JSON.stringify(aggregate), 'ATTENDANCE_KV')
      toast(`Removed ${entry.name} from ${eventId}`)
      await ctx.reload()
    }
  } catch (err) {
    toast(err.message || String(err), true)
  }
})
