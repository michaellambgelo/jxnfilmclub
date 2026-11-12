// Config tab of the admin dashboard — vanilla JS, no build step.
//
// Split out of admin.js the way events-tab.js is: admin.js owns the shell
// (tabs, env switch, toast, the fetch wrapper) and hands them in as `ctx`;
// this module owns the config:* editors and imports only lib.js, never
// admin.js. It registers its own delegated click listener.
//
// A NEW ADMIN FILE MUST BE REGISTERED in four places or it works locally and
// 404s on admin.jxnfilm.club: the import + STATIC map in
// admin/worker/src/index.js, the Text rule in admin/worker/wrangler.toml,
// isText in tests/admin-worker/vitest.config.ts, and the gated-path list in
// tests/admin-worker/admin-worker.test.js.
import {
  qs, escapeHtml, attr, tryParse, moveItem, normalizeStringList, buildCopyOverrides,
  sanitizePodcastConfig, sanitizeVoicePrompt, buildVenueList, unmatchedVenueNames } from './lib.js'

const $ = (sel) => document.querySelector(sel)

// Set on every render. Null until the tab has been opened once, which is also
// what keeps the listener below inert on every other tab. `ctx.defaults`
// carries the three built-in values other tabs own (the generic voice prompt
// and the newsletter template + subject), so they are not mirrored here.
let ctx = null
const api = (...args) => ctx.api(...args)
const env = () => ctx.env()
const content = () => ctx.content()
const toast = (...args) => ctx.toast(...args)

const loadKv = (prefix, binding = 'MEMBERS_KV') =>
  api('GET', `/api/kv?${qs({ env: env(), binding, prefix })}`)
const putKv = (key, value, binding = 'MEMBERS_KV') =>
  api('PUT', `/api/kv?${qs({ env: env(), binding, key })}`, value)
const delKv = (key, binding = 'MEMBERS_KV') =>
  api('DELETE', `/api/kv?${qs({ env: env(), binding, key })}`)

// --- Config tab (MEMBERS_KV: config:* operator overrides) ---
//
// Purpose-built editors for the config keys the join Worker and public SPA
// consume. The mental model surfaced everywhere in this tab: a missing key
// means "use the built-in default" — deleting a key is the reset, and the
// site/Worker fall back automatically. Each section's pill says which is in
// effect (Custom vs Default) from whether the key exists.
//
// Shape of the tab, borrowed from events-tab.js: a short list of sections
// where ONE is open at a time, each row summarising what is in effect.

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

// Mirrors DEFAULT_VENUES in worker/src/venues.js: what /map pins when
// config:venues is absent, and this editor's starting point / reset target.
// Guarded by tests/admin/venues-sync.test.js.
const DEFAULT_VENUES = [
  { name: 'The Capri Theatre', address: '3023 N State St, Jackson, MS 39216', lat: 32.33554, lng: -90.17678, aliases: [] },
  { name: 'Duling Hall', address: '622 Duling Ave, Jackson, MS 39216', lat: 32.33620, lng: -90.17523, aliases: [] },
  { name: 'Fertile Ground Beer Co.', address: '800 Manship St, Jackson, MS 39202', lat: 32.31417, lng: -90.17575, aliases: [] },
  { name: 'Urban Foxes', address: '826 North St, Jackson, MS 39202', lat: 32.30873, lng: -90.17681, aliases: [] },
  { name: 'Patton House & Gallery', address: '512 N State St, Jackson, MS 39201', lat: 32.30367, lng: -90.17947, aliases: [] },
  { name: 'Two Mississippi Museums', address: '222 North St, Jackson, MS 39201', lat: 32.30058, lng: -90.17948, aliases: [] },
  { name: 'Mississippi Museum of Art', address: '380 S Lamar St, Jackson, MS 39201', lat: 32.29631, lng: -90.18562, aliases: [] },
  { name: 'Vibe Studio', address: '1700 University Blvd #21, Jackson, MS 39204', lat: 32.28362, lng: -90.20717, aliases: [] },
  { name: 'Malco Grandview & IMAX', address: '221 Grandview Blvd, Madison, MS 39110', lat: 32.46329, lng: -90.13812, aliases: ['Malco Grandview & IMAX in Madison'] },
  { name: 'Malco Renaissance Cinema Grill', address: '1000 Highland Colony Pkwy, Ridgeland, MS 39157', lat: 32.43659, lng: -90.14663, aliases: ['Malco Renaissance', 'Malco Renaissance in Ridgeland'] },
  { name: 'B&B Theatres Northpark 14', address: '250 Ring Rd, Ridgeland, MS 39157', lat: 32.40278, lng: -90.12921, aliases: ['B&B Theaters at Northpark in Ridgeland'] },
  { name: 'Legacy Theaters Parkway', address: '1075 Parkway Blvd, Flowood, MS 39232', lat: 32.33733, lng: -90.09068, aliases: ['Legacy Parkway Theaters'] },
  { name: 'Cinemark Pearl and XD', address: '411 Riverwind Dr, Pearl, MS 39208', lat: 32.26810, lng: -90.14061, aliases: ['Cinemark Pearl', 'Cinemark XD in Pearl'] },
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

// --- State ---
//
// `store` is what KV holds (key -> raw string), reloaded after every save or
// reset. The three list editors work on copies (`theaters`, `venues`,
// `podcast`) that the add / remove / move buttons mutate between saves; they
// are rebuilt from `store` whenever a section is opened, so closing a section
// throws its unsaved edits away.

let store = {}
let unmatched = []             // public events whose venue is not on the map
let podcastSeed                // live episodes.json; undefined = not fetched, null = failed
let openId = null              // a SECTIONS id, or null
let snapshot = ''              // the open section as rendered, for the dirty check

let theaters = []
let venues = []                // editor rows, as typed: { name, address, coords, aliases }
let podcast = { episodes: [] }

const has = (key) => key in store
const stored = (key) => (has(key) ? tryParse(store[key]) : null)
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

function storedVenues() {
  const v = stored('config:venues')
  return Array.isArray(v) ? v : DEFAULT_VENUES
}

// The podcast override, or the live site's list when there is none - so the
// first save starts an override at what is published, not from nothing.
function podcastSource() {
  const v = has('config:podcast') ? stored('config:podcast') : podcastSeed
  const out = v && typeof v === 'object' && !Array.isArray(v) ? structuredClone(v) : {}
  if (!Array.isArray(out.episodes)) out.episodes = []
  return out
}
// True when the list on screen is empty only because the live one never loaded.
const podcastSeedFailed = () => !has('config:podcast') && !podcastSource().episodes.length

async function load() {
  const { keys, values } = await loadKv('config:')
  store = {}
  for (const k of keys) store[k.name] = values[k.name]

  // events:all is the public projection, so no host address reaches this tab.
  const agg = await loadKv('events:all', 'ATTENDANCE_KV').catch(() => null)
  unmatched = unmatchedVenueNames(tryParse(agg?.values?.['events:all']) || [], storedVenues())

  if (!has('config:podcast') && podcastSeed === undefined) {
    // Bounded fetch: a slow or unreachable jxnfilm.club must not hang the tab.
    try {
      podcastSeed = await (await fetch(EPISODES_JSON_URL, { signal: AbortSignal.timeout(3000) })).json()
    } catch {
      podcastSeed = null
    }
  }
}

function seedWorking() {
  theaters = has('config:theaters') ? normalizeStringList(stored('config:theaters')) : [...DEFAULT_THEATERS]
  venues = storedVenues().map(venueToRow)
  podcast = podcastSource()
}

// --- Sections ---
//
// `act` is the prefix of the section's save / reset action names, which the
// browser tests address by name.

const SECTIONS = [
  { id: 'voice-prompt', key: 'config:voice_prompt', act: 'vp', title: 'Voice prompt' },
  { id: 'theaters', key: 'config:theaters', act: 'theaters', title: 'Theaters' },
  { id: 'venues', key: 'config:venues', act: 'venues', title: 'Map venues' },
  { id: 'podcast', key: 'config:podcast', act: 'podcast', title: 'Podcast' },
  { id: 'nl-template', key: 'config:newsletter_template', act: 'nl', title: 'Newsletter template' },
  { id: 'copy', key: 'config:copy', act: 'copy', title: 'Homepage copy' },
]
const sectionById = (id) => SECTIONS.find(s => s.id === id)

// One line under the title saying what is in effect right now.
const SUMMARY = {
  'voice-prompt': () => {
    const vp = stored('config:voice_prompt')
    if (!vp) return `Generic prompt: “${ctx.defaults.voicePrompt.text}”`
    return `“${vp.text || ''}”` + (vp.deadline ? ` · until ${vp.deadline}` : '')
  },
  theaters: () => {
    const n = has('config:theaters') ? normalizeStringList(stored('config:theaters')).length : DEFAULT_THEATERS.length
    return `${plural(n, 'theater')} offered to members hosting a meetup`
  },
  venues: () => `${plural(storedVenues().length, 'venue')} pinned on the public map`,
  podcast: () => {
    const p = podcastSource()
    return `${plural(p.episodes.length, 'episode')}${p.featured_id ? ' · one featured on the homepage' : ''}`
  },
  'nl-template': () => {
    const nl = stored('config:newsletter_template')
    return nl ? `Compose starts from “${nl.subject || 'your saved template'}”` : 'Compose starts from the built-in template'
  },
  copy: () => {
    const copy = stored('config:copy') || {}
    const n = COPY_FIELDS.filter(f => copy[f.key]).length
    return n ? `${n} of ${COPY_FIELDS.length} homepage texts replaced` : 'The homepage shows its built-in text'
  },
}

function pillsHtml(sec) {
  const out = []
  if (sec.id === 'venues' && unmatched.length) {
    out.push(`<span class="pill warn">${plural(unmatched.length, 'venue')} not on the map</span>`)
  }
  if (sec.id === 'podcast' && podcastSeedFailed()) out.push('<span class="pill warn">Live list not loaded</span>')
  out.push(has(sec.key)
    ? '<span class="pill on" data-source="custom">Custom</span>'
    : '<span class="pill off" data-source="default">Default</span>')
  return out.join('')
}

const BODY = {
  'voice-prompt': () => {
    const vp = stored('config:voice_prompt')
    const def = ctx.defaults.voicePrompt
    return `
      <p class="detail-note muted">The question members answer when they record a podcast voice clip. Clips are
        grouped by the prompt id, so a new id starts a fresh collection on the Voice tab. With nothing saved,
        the site asks the generic prompt (“${escapeHtml(def.text)}”, id <code>${escapeHtml(def.id)}</code>).</p>
      <label class="cfg-label">Prompt id <span class="muted">— a short slug; groups the clips and names the compiled segment</span>
        <input id="cfg-vp-id" type="text" value="${attr(vp?.id || '')}" placeholder="${attr(def.id)}" style="max-width:260px">
      </label>
      <label class="cfg-label">Prompt text
        <textarea id="cfg-vp-text" rows="2" placeholder="${attr(def.text)}">${escapeHtml(vp?.text || '')}</textarea>
      </label>
      <label class="cfg-label">Deadline <span class="muted">— optional; shown to members, but clips stay open after it</span>
        <input id="cfg-vp-deadline" type="date" value="${attr(vp?.deadline || '')}" style="max-width:200px">
      </label>`
  },
  theaters: () => `
      <p class="detail-note muted">The theaters a member can pick when hosting a meetup, in this order.
        ${has('config:theaters') ? '' : 'This is the built-in list; saving makes it yours to change.'}</p>
      <div id="cfg-theaters-list">${theaterRowsHtml()}</div>
      <div class="toolbar"><button data-action="cfg-theater-add">+ add theater</button></div>`,
  venues: () => `
      <p class="detail-note muted">The pins on the public <a href="https://jxnfilm.club/map" target="_blank" rel="noopener">map</a>.
        This is separate from Theaters: a venue here is on the map but is <b>not</b> offered to members hosting a
        meetup. An event lands on a pin when its venue matches the name or an alias (case, punctuation, a leading
        “The”, &amp;/and and theatre/theater are ignored). House screenings are never pinned.</p>
      ${unmatched.length
        ? `<p class="form-banner"><b>Not on the map:</b>
            ${unmatched.map(u => `<code>${escapeHtml(u.name)}</code> (${plural(u.count, 'event')})`).join(', ')}.
            Add the venue, or add that spelling as an alias of one already here.</p>`
        : '<p class="detail-note muted">Every public event matches a venue here.</p>'}
      <p class="detail-note muted">Coordinates are “lat, lng” as copied from a map app; “check” opens them on
        OpenStreetMap. Separate aliases with semicolons.</p>
      <div id="cfg-venues-list">${venueRowsHtml()}</div>
      <div class="toolbar"><button data-action="cfg-venue-add">+ add venue</button></div>`,
  podcast: () => `
      <p class="detail-note muted">The episode list on the homepage, and which episode the Spotify player shows.
        ${has('config:podcast')
          ? ''
          : 'Nothing is saved yet, so this is the live site\'s list; saving makes it yours to change.'}
        Anything this editor does not show is kept as it is.</p>
      ${podcastSeedFailed() ? '<p class="cfg-warn">⚠ The live episode list could not be loaded, so this one started <b>empty</b>. Saving now would publish an empty list; reload the tab to try again first.</p>' : ''}
      <label class="cfg-label">Featured episode — Spotify episode ID <span class="muted">(the 22 characters after open.spotify.com/episode/, or pick “featured” on a row below)</span>
        <input id="cfg-featured" type="text" value="${attr(podcast.featured_id || '')}" placeholder="e.g. 2lTN7uSNEil7AoTEDzbEZs" style="max-width:340px">
      </label>
      <div id="cfg-episodes-list">${episodeRowsHtml()}</div>
      <div class="toolbar"><button data-action="cfg-ep-add">+ add episode</button></div>`,
  'nl-template': () => {
    const nl = stored('config:newsletter_template')
    return `
      <p class="detail-note muted">The subject and HTML the Newsletter tab starts a new issue from.
        ${nl ? '' : 'Nothing is saved yet, so this is the built-in template.'}</p>
      <label class="cfg-label">Subject
        <input id="cfg-nl-subject" type="text" value="${attr(nl?.subject || '')}" placeholder="${attr(ctx.defaults.newsletterSubject)}">
      </label>
      <label class="cfg-label">HTML body
        <textarea id="cfg-nl-html" rows="12">${escapeHtml(nl?.html || ctx.defaults.newsletterHtml)}</textarea>
      </label>`
  },
  copy: () => {
    const copy = stored('config:copy') || {}
    return `
      <p class="detail-note muted">Replace individual pieces of homepage text. The grey text in each box is
        what the site shows now; leave a box empty to keep it.</p>
      <div class="cfg-copy-grid">
        ${COPY_FIELDS.map(f => `
          <label class="cfg-label">${escapeHtml(f.label)}
            ${f.multiline
              ? `<textarea data-copy-field="${attr(f.key)}" rows="3" placeholder="${attr(f.def)}">${escapeHtml(copy[f.key] || '')}</textarea>`
              : `<input type="text" data-copy-field="${attr(f.key)}" value="${attr(copy[f.key] || '')}" placeholder="${attr(f.def)}">`}
          </label>`).join('')}
      </div>`
  },
}

function detailHtml(sec) {
  return `
    <div class="detail" data-cfg-detail="${sec.id}">
      <ul class="form-issues" data-issues hidden></ul>
      ${BODY[sec.id]()}
      <div class="form-foot">
        <button class="primary" data-action="cfg-${sec.act}-save">Save</button>
        <button data-action="cfg-close">Close</button>
        <span class="form-foot-gap"></span>
        <button class="danger" data-action="cfg-${sec.act}-reset">Reset to defaults</button>
      </div>
      <p class="detail-note muted cfg-key">Stored as <code>${sec.key}</code> on ${escapeHtml(env())}. Reset removes it, and the built-in default applies again.</p>
    </div>`
}

function itemHtml(sec) {
  const open = openId === sec.id
  return `
    <div class="list-item${open ? ' -open' : ''}" id="cfg-${sec.id}">
      <button type="button" class="list-row -plain" data-action="cfg-open" data-cfg="${sec.id}" aria-expanded="${open}">
        <span class="list-row-main"><strong>${sec.title}</strong><span>${escapeHtml(SUMMARY[sec.id]())}</span></span>
        <span class="list-row-pills">${pillsHtml(sec)}</span>
      </button>
      ${open ? detailHtml(sec) : ''}
    </div>`
}

// --- Render ---

export async function renderConfig(c) {
  ctx = c
  // A reload (refresh button, env switch) starts clean: half-typed settings
  // must not follow the operator from staging to production.
  openId = null
  snapshot = ''
  podcastSeed = undefined
  await load()
  seedWorking()

  content().innerHTML = `
    <h2>Config <span class="muted">— editing <strong>${escapeHtml(env())}</strong></span></h2>
    <p class="section-hint">Settings the public site and the join Worker read. Each one has a built-in default;
      saving here replaces it, and <b>Reset to defaults</b> brings it back. Pick one to edit; one is open at a time.</p>
    <section class="list-group" id="cfg-list">${SECTIONS.map(itemHtml).join('')}</section>
  `
}

const openDetail = () => document.querySelector('#content [data-cfg-detail]')

// Everything typed or ticked in the open section, in document order. Adding,
// removing or moving a row changes it too, which is what makes those dirty.
function formState(detail) {
  return JSON.stringify([...detail.querySelectorAll('input, textarea')]
    .map(el => (el.type === 'radio' || el.type === 'checkbox' ? el.checked : el.value)))
}

// Re-render one row in place: the others, and the page scroll, are untouched.
function renderItem(id) {
  const el = $(`#cfg-${id}`)
  if (el) el.outerHTML = itemHtml(sectionById(id))
  if (id === openId) snapshot = formState(openDetail())
}

// True when it is safe to throw the open section's edits away. The baseline
// is the section as rendered, so defaults shown as a starting point (the
// theater list, the built-in newsletter HTML) do not count as changes.
function confirmDiscard() {
  const detail = openDetail()
  if (!detail || formState(detail) === snapshot) return true
  return confirm(`Discard the unsaved changes to ${sectionById(openId).title}?`)
}

function setOpen(id) {
  const prev = openId
  openId = id
  seedWorking()
  if (prev && prev !== id) renderItem(prev)
  if (id) {
    renderItem(id)
    $(`#cfg-${id}`).scrollIntoView({ block: 'nearest' })
  }
}

function showIssues(issues) {
  const box = openDetail().querySelector('[data-issues]')
  box.innerHTML = issues.map(i => `<li>${escapeHtml(i)}</li>`).join('')
  box.hidden = !issues.length
  if (issues.length) {
    box.scrollIntoView({ block: 'nearest' })
    toast(issues.length === 1 ? issues[0] : `${issues.length} things need fixing before this can be saved`, true)
  }
  return issues.length
}

// After a save or reset: reload what KV now holds and redraw this one row,
// still open, with its pill and summary telling the truth.
async function settled(id, message) {
  await load()
  seedWorking()
  renderItem(id)
  toast(message)
}

async function resetSection(id, question) {
  const sec = sectionById(id)
  if (!confirm(`Reset ${sec.title} to its default on ${env()}?\n\n${question}`)) return
  await delKv(sec.key).catch(() => {})
  await settled(id, `${sec.title} reset — the default is back in effect`)
}

// --- List editors ---

function theaterRowsHtml() {
  if (!theaters.length) return '<p class="empty">No theaters — add one below.</p>'
  return theaters.map((v, i) => `
    <div class="cfg-row">
      <input type="text" data-theater value="${attr(v)}" placeholder="Theater name" aria-label="Theater name">
      <button data-action="cfg-theater-up" data-idx="${i}" title="move up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button data-action="cfg-theater-down" data-idx="${i}" title="move down" aria-label="Move down" ${i === theaters.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="danger" data-action="cfg-theater-rm" data-idx="${i}">remove</button>
    </div>`).join('')
}

function venueToRow(v) {
  const ok = typeof v?.lat === 'number' && typeof v?.lng === 'number'
  return {
    name: v?.name || '',
    address: v?.address || '',
    coords: ok ? `${v.lat}, ${v.lng}` : '',
    aliases: Array.isArray(v?.aliases) ? v.aliases.join('; ') : '',
  }
}

function venueRowsHtml() {
  if (!venues.length) return '<p class="empty">No venues — add one below.</p>'
  return venues.map((r, i) => {
    const c = r.coords.split(',').map(s => s.trim())
    const check = c.length === 2 && c[0] && c[1]
      ? `<a href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(c[0])}&mlon=${encodeURIComponent(c[1])}#map=18/${encodeURIComponent(c[0])}/${encodeURIComponent(c[1])}" target="_blank" rel="noopener">check</a>`
      : '<span class="muted">check</span>'
    return `
    <div class="cfg-row cfg-venue-row" data-idx="${i}">
      <input type="text" data-venue-field="name" value="${attr(r.name)}" placeholder="Venue name" aria-label="Venue name">
      <input type="text" data-venue-field="address" value="${attr(r.address)}" placeholder="Street address" aria-label="Street address">
      <input type="text" data-venue-field="coords" value="${attr(r.coords)}" placeholder="32.33554, -90.17678" aria-label="Coordinates" style="max-width:220px">
      ${check}
      <input type="text" data-venue-field="aliases" value="${attr(r.aliases)}" placeholder="Other spellings; separated by semicolons" aria-label="Other spellings">
      <button data-action="cfg-venue-up" data-idx="${i}" title="move up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button data-action="cfg-venue-down" data-idx="${i}" title="move down" aria-label="Move down" ${i === venues.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="danger" data-action="cfg-venue-rm" data-idx="${i}">remove</button>
    </div>`
  }).join('')
}

function episodeRowsHtml() {
  if (!podcast.episodes.length) return '<p class="empty">No episodes — add one below.</p>'
  const featured = String(podcast.featured_id || '')
  return podcast.episodes.map((ep, i) => `
    <div class="cfg-episode" data-idx="${i}">
      <label class="cfg-feat" title="Feature this episode on the homepage player">
        <input type="radio" name="cfg-featured-pick" data-idx="${i}"
          ${ep.id && featured && ep.id === featured ? 'checked' : ''}> featured
      </label>
      <input type="text" data-ep-field="title" value="${attr(ep.title || '')}" placeholder="Episode title" aria-label="Episode title">
      <input type="date" data-ep-field="date" value="${attr(ep.date || '')}" aria-label="Release date">
      <input type="url" data-ep-field="url" value="${attr(ep.url || '')}" placeholder="https://podcasters.spotify.com/…" aria-label="Episode link">
      <button class="danger" data-action="cfg-ep-rm" data-idx="${i}">delete</button>
    </div>`).join('')
}

// DOM -> working state, called before any mutation or save so in-progress
// typing is never lost by a list re-render.
function readTheaters() {
  theaters = [...document.querySelectorAll('#cfg-theaters-list input[data-theater]')].map(i => i.value)
}

function readVenues() {
  venues = [...document.querySelectorAll('#cfg-venues-list .cfg-venue-row')].map(row => {
    const r = {}
    row.querySelectorAll('[data-venue-field]').forEach(inp => { r[inp.dataset.venueField] = inp.value })
    return r
  })
}

function readPodcast() {
  const feat = $('#cfg-featured')
  if (feat) podcast.featured_id = feat.value
  document.querySelectorAll('#cfg-episodes-list .cfg-episode').forEach(row => {
    const ep = podcast.episodes[Number(row.dataset.idx)]
    if (!ep) return
    row.querySelectorAll('[data-ep-field]').forEach(inp => { ep[inp.dataset.epField] = inp.value })
  })
}

const drawTheaters = () => { $('#cfg-theaters-list').innerHTML = theaterRowsHtml() }
const drawVenues = () => { $('#cfg-venues-list').innerHTML = venueRowsHtml() }
const drawEpisodes = () => { $('#cfg-episodes-list').innerHTML = episodeRowsHtml() }

// --- Actions ---

const ACTIONS = {
  'cfg-open': (btn) => {
    if (!confirmDiscard()) return
    setOpen(openId === btn.dataset.cfg ? null : btn.dataset.cfg)
  },
  'cfg-close': () => {
    if (confirmDiscard()) setOpen(null)
  },

  'cfg-theater-add': () => {
    readTheaters()
    theaters.push('')
    drawTheaters()
    const inputs = document.querySelectorAll('#cfg-theaters-list input[data-theater]')
    inputs[inputs.length - 1]?.focus()
  },
  'cfg-theater-rm': (btn) => {
    readTheaters()
    theaters.splice(Number(btn.dataset.idx), 1)
    drawTheaters()
  },
  'cfg-theater-up': (btn) => {
    readTheaters()
    theaters = moveItem(theaters, Number(btn.dataset.idx), -1)
    drawTheaters()
  },
  'cfg-theater-down': (btn) => {
    readTheaters()
    theaters = moveItem(theaters, Number(btn.dataset.idx), 1)
    drawTheaters()
  },
  'cfg-theaters-save': async () => {
    readTheaters()
    const list = normalizeStringList(theaters)
    if (showIssues(list.length ? [] : ['Add at least one theater, or use Reset to defaults to go back to the built-in list'])) return
    await putKv('config:theaters', JSON.stringify(list))
    await settled('theaters', `Saved ${plural(list.length, 'theater')} on ${env()}`)
  },
  'cfg-theaters-reset': () =>
    resetSection('theaters', 'Members hosting a meetup will be offered the built-in theater list.'),

  'cfg-venue-add': () => {
    readVenues()
    venues.push({ name: '', address: '', coords: '', aliases: '' })
    drawVenues()
    const rows = document.querySelectorAll('#cfg-venues-list input[data-venue-field="name"]')
    rows[rows.length - 1]?.focus()
  },
  'cfg-venue-rm': (btn) => {
    readVenues()
    venues.splice(Number(btn.dataset.idx), 1)
    drawVenues()
  },
  'cfg-venue-up': (btn) => {
    readVenues()
    venues = moveItem(venues, Number(btn.dataset.idx), -1)
    drawVenues()
  },
  'cfg-venue-down': (btn) => {
    readVenues()
    venues = moveItem(venues, Number(btn.dataset.idx), 1)
    drawVenues()
  },
  'cfg-venues-save': async () => {
    readVenues()
    const { venues: list, errors } = buildVenueList(venues)
    if (showIssues(errors)) return
    await putKv('config:venues', JSON.stringify(list))
    await settled('venues', `Saved ${plural(list.length, 'venue')} on ${env()}`)
  },
  'cfg-venues-reset': () =>
    resetSection('venues', 'The map will show the built-in venue list.'),

  'cfg-ep-add': () => {
    readPodcast()
    podcast.episodes.unshift({ title: '', date: '', url: '' })
    drawEpisodes()
    document.querySelector('#cfg-episodes-list input[data-ep-field="title"]')?.focus()
  },
  'cfg-ep-rm': (btn) => {
    readPodcast()
    const idx = Number(btn.dataset.idx)
    const ep = podcast.episodes[idx]
    if (ep && (ep.title || ep.url) && !confirm(`Delete episode "${ep.title || ep.url}" from the list?`)) return
    podcast.episodes.splice(idx, 1)
    drawEpisodes()
  },
  'cfg-podcast-save': async () => {
    readPodcast()
    const out = sanitizePodcastConfig(podcast)
    // A saved empty list WINS over data/episodes.json and blanks the
    // homepage podcast section - never let that happen silently.
    if (!out.episodes.length && !confirm(`Save an EMPTY episode list to ${env()}?\n\nThe homepage podcast section will show no episodes. If you meant to go back to the site's own list, cancel and use Reset to defaults instead.`)) return
    showIssues([])
    await putKv('config:podcast', JSON.stringify(out))
    await settled('podcast', `Saved ${plural(out.episodes.length, 'episode')} on ${env()}`)
  },
  'cfg-podcast-reset': () =>
    resetSection('podcast', 'The homepage will show the episode list published with the site.'),

  'cfg-nl-save': async () => {
    const subject = $('#cfg-nl-subject').value.trim()
    const html = $('#cfg-nl-html').value
    if (!subject && !html.trim()) {
      // Storing nothing means "use the default" - an all-empty save is the
      // reset it looks like.
      await delKv('config:newsletter_template').catch(() => {})
      await settled('nl-template', 'Empty template — nothing stored, compose uses the built-in one')
    } else {
      await putKv('config:newsletter_template', JSON.stringify({ subject, html }))
      await settled('nl-template', `Saved the newsletter template on ${env()}`)
    }
  },
  'cfg-nl-reset': () =>
    resetSection('nl-template', 'The Newsletter tab will start new issues from the built-in template.'),

  'cfg-copy-save': async () => {
    const fields = {}
    document.querySelectorAll('#cfg-copy [data-copy-field]').forEach(inp => {
      fields[inp.dataset.copyField] = inp.value
    })
    const blob = buildCopyOverrides(fields, COPY_FIELDS.map(f => f.key))
    if (blob) {
      await putKv('config:copy', JSON.stringify(blob))
      await settled('copy', `Saved ${plural(Object.keys(blob).length, 'homepage text')} on ${env()}`)
    } else {
      await delKv('config:copy').catch(() => {})
      await settled('copy', 'Every box is empty — nothing stored, the homepage shows its built-in text')
    }
  },
  'cfg-copy-reset': () =>
    resetSection('copy', 'Every piece of homepage text goes back to what is built into the site.'),

  'cfg-vp-save': async () => {
    const out = sanitizeVoicePrompt({
      id: $('#cfg-vp-id').value,
      text: $('#cfg-vp-text').value,
      deadline: $('#cfg-vp-deadline').value,
    })
    if (showIssues(out ? [] : ['Prompt needs an id (a slug not starting with msg_) and text — or use Reset to defaults for the generic prompt'])) return
    await putKv('config:voice_prompt', JSON.stringify(out))
    await settled('voice-prompt', `Saved the voice prompt “${out.id}” on ${env()}`)
  },
  'cfg-vp-reset': () =>
    resetSection('voice-prompt', `Members will be asked the generic prompt (“${ctx.defaults.voicePrompt.text}”).`),
}

document.addEventListener('click', async (e) => {
  if (!ctx) return
  const btn = e.target.closest('button[data-action^="cfg-"]')
  const run = btn && ACTIONS[btn.dataset.action]
  if (!run) return
  try { await run(btn) }
  catch (err) { toast(err.message || String(err), true) }
})

// The "featured" radios sit inside the re-drawn episode list, so the pick is
// handled here rather than on an element that a redraw would replace.
document.addEventListener('change', (e) => {
  if (!ctx || !e.target.matches || !e.target.matches('input[name="cfg-featured-pick"]')) return
  readPodcast()
  const ep = podcast.episodes[Number(e.target.dataset.idx)]
  let id = ep && typeof ep.id === 'string' ? ep.id.trim() : ''
  if (!id) {
    // Episodes from data/episodes.json carry no Spotify ID (their anchor URLs
    // cannot be converted) - capture it once and keep it on the row.
    id = (prompt('Spotify episode ID for this episode (from open.spotify.com/episode/…):') || '').trim()
    if (!id) { drawEpisodes(); return }
    ep.id = id
  }
  podcast.featured_id = id
  $('#cfg-featured').value = id
  drawEpisodes()
})
