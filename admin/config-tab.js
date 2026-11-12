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

// Working state for the tab. Rebuilt on every render (loadKv is the source
// of truth); mutated in place by the add/remove/move actions between saves.
let cfgTheaters = []
let cfgTheatersKv = false
// Map venue editor rows, as typed: { name, address, coords, aliases }.
let cfgVenues = []
let cfgVenuesKv = false
let cfgUnmatched = []
let cfgPodcast = { episodes: [] }
let cfgPodcastKv = false
let cfgPodcastSeedFailed = false

const cfgBadge = (fromKv) => fromKv
  ? '<span class="pill on">KV override</span>'
  : '<span class="pill off">defaults — no KV key</span>'

export async function renderConfig(c) {
  ctx = c
  const { keys, values } = await loadKv('config:')
  const has = (k) => keys.some(x => x.name === k)

  cfgTheatersKv = has('config:theaters')
  cfgTheaters = cfgTheatersKv
    ? normalizeStringList(tryParse(values['config:theaters']))
    : [...DEFAULT_THEATERS]

  cfgVenuesKv = has('config:venues')
  const storedVenues = cfgVenuesKv ? tryParse(values['config:venues']) : null
  const venueList = Array.isArray(storedVenues) ? storedVenues : DEFAULT_VENUES
  cfgVenues = venueList.map(venueToRow)
  // events:all is the public projection, so no host address reaches this tab.
  const eventsAgg = await loadKv('events:all', 'ATTENDANCE_KV').catch(() => null)
  cfgUnmatched = unmatchedVenueNames(tryParse(eventsAgg?.values?.['events:all']) || [], venueList)

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

    <section class="cfg-section" id="cfg-voice-prompt">
      <h3>Voice prompt ${cfgBadge(!!vp)}</h3>
      <p class="section-hint"><code>config:voice_prompt</code> — the question members answer when they
        record a podcast voice clip. Submissions are keyed by the prompt id, so changing the id starts
        a fresh collection (the Voice tab groups by it). Reset deletes the key; the site falls back to
        the generic default prompt (<code>${escapeHtml(ctx.defaults.voicePrompt.id)}</code> —
        “${escapeHtml(ctx.defaults.voicePrompt.text)}”).</p>
      <label class="cfg-label">Prompt id <span class="muted">— slug; groups the submissions and names the compiled segment</span>
        <input id="cfg-vp-id" type="text" value="${attr(vp?.id || '')}" placeholder="${attr(ctx.defaults.voicePrompt.id)}" style="max-width:260px">
      </label>
      <label class="cfg-label">Prompt text
        <textarea id="cfg-vp-text" rows="2" placeholder="${attr(ctx.defaults.voicePrompt.text)}">${escapeHtml(vp?.text || '')}</textarea>
      </label>
      <label class="cfg-label">Deadline <span class="muted">— optional YYYY-MM-DD shown to members; submissions stay open regardless</span>
        <input id="cfg-vp-deadline" type="date" value="${attr(vp?.deadline || '')}" style="max-width:200px">
      </label>
      <div class="toolbar">
        <button class="primary" data-action="cfg-vp-save">save prompt</button>
        <button class="danger" data-action="cfg-vp-reset">reset to defaults</button>
      </div>
    </section>
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

    <section class="cfg-section" id="cfg-venues">
      <h3>Map venues ${cfgBadge(cfgVenuesKv)}</h3>
      <p class="section-hint"><code>config:venues</code> — the pins on the public <a href="https://jxnfilm.club/map" target="_blank" rel="noopener">/map</a>.
        Separate from the theater list above: a venue here is shown on the map but is <b>not</b> offered to
        members hosting a meetup. An event appears at a venue when its venue text matches the name or an alias
        (case, punctuation, a leading “The”, &amp;/and and theatre/theater are ignored). House screenings are
        never pinned. Coordinates are “lat, lng”, as copied from a map app; “check” opens them on OpenStreetMap.
        Separate aliases with semicolons. Reset deletes the key so the Worker falls back to its built-in list.</p>
      <div id="cfg-venues-list">${renderVenueRows()}</div>
      <div class="toolbar">
        <button data-action="cfg-venue-add">+ add venue</button>
        <button class="primary" data-action="cfg-venues-save">save venues</button>
        <button class="danger" data-action="cfg-venues-reset">reset to defaults</button>
      </div>
      ${cfgUnmatched.length
        ? `<p class="section-hint"><b>Not on the map</b> — public events whose venue matches no entry here
            (add the venue, or add the name as an alias):
            ${cfgUnmatched.map(u => `<code>${escapeHtml(u.name)}</code> (${u.count})`).join(', ')}</p>`
        : '<p class="section-hint">Every public event matches a map venue.</p>'}
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
        <input id="cfg-nl-subject" type="text" value="${attr(nl?.subject || '')}" placeholder="${attr(ctx.defaults.newsletterSubject)}">
      </label>
      <label class="cfg-label">HTML body
        <textarea id="cfg-nl-html" rows="12">${escapeHtml(nl?.html || ctx.defaults.newsletterHtml)}</textarea>
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

function venueToRow(v) {
  const has = typeof v?.lat === 'number' && typeof v?.lng === 'number'
  return {
    name: v?.name || '',
    address: v?.address || '',
    coords: has ? `${v.lat}, ${v.lng}` : '',
    aliases: Array.isArray(v?.aliases) ? v.aliases.join('; ') : '',
  }
}

function renderVenueRows() {
  if (!cfgVenues.length) return '<p class="empty">No venues — add one below.</p>'
  return cfgVenues.map((r, i) => {
    const c = r.coords.split(',').map(s => s.trim())
    const check = c.length === 2 && c[0] && c[1]
      ? `<a href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(c[0])}&mlon=${encodeURIComponent(c[1])}#map=18/${encodeURIComponent(c[0])}/${encodeURIComponent(c[1])}" target="_blank" rel="noopener">check</a>`
      : '<span class="muted">check</span>'
    return `
    <div class="cfg-row cfg-venue-row" data-idx="${i}">
      <input type="text" data-venue-field="name" value="${attr(r.name)}" placeholder="Venue name">
      <input type="text" data-venue-field="address" value="${attr(r.address)}" placeholder="Street address">
      <input type="text" data-venue-field="coords" value="${attr(r.coords)}" placeholder="32.33554, -90.17678" style="max-width:220px">
      ${check}
      <input type="text" data-venue-field="aliases" value="${attr(r.aliases)}" placeholder="Other spellings; separated by semicolons">
      <button data-action="cfg-venue-up" data-idx="${i}" title="move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button data-action="cfg-venue-down" data-idx="${i}" title="move down" ${i === cfgVenues.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="danger" data-action="cfg-venue-rm" data-idx="${i}">remove</button>
    </div>`
  }).join('')
}

function readVenueInputs() {
  cfgVenues = [...document.querySelectorAll('#cfg-venues-list .cfg-venue-row')].map(row => {
    const r = {}
    row.querySelectorAll('[data-venue-field]').forEach(inp => { r[inp.dataset.venueField] = inp.value })
    return r
  })
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

// --- Actions ---

async function runAction(a, btn) {
  if (a === 'cfg-theater-add') {
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
    await ctx.reload()
  }
  else if (a === 'cfg-theaters-reset') {
    if (!confirm(`Delete config:theaters on ${env()}?\n\nThe Worker and site fall back to the hardcoded theater list.`)) return
    await delKv('config:theaters').catch(() => {})
    toast('config:theaters deleted — defaults are back in effect')
    await ctx.reload()
  }
  else if (a === 'cfg-venue-add') {
    readVenueInputs()
    cfgVenues.push({ name: '', address: '', coords: '', aliases: '' })
    $('#cfg-venues-list').innerHTML = renderVenueRows()
    const rows = document.querySelectorAll('#cfg-venues-list input[data-venue-field="name"]')
    rows[rows.length - 1]?.focus()
  }
  else if (a === 'cfg-venue-rm') {
    readVenueInputs()
    cfgVenues.splice(Number(btn.dataset.idx), 1)
    $('#cfg-venues-list').innerHTML = renderVenueRows()
  }
  else if (a === 'cfg-venue-up' || a === 'cfg-venue-down') {
    readVenueInputs()
    cfgVenues = moveItem(cfgVenues, Number(btn.dataset.idx), a === 'cfg-venue-up' ? -1 : 1)
    $('#cfg-venues-list').innerHTML = renderVenueRows()
  }
  else if (a === 'cfg-venues-save') {
    readVenueInputs()
    const { venues, errors } = buildVenueList(cfgVenues)
    if (errors.length) { toast(errors.join(' · '), true); return }
    await putKv('config:venues', JSON.stringify(venues))
    toast(`Saved ${venues.length} venue(s) to config:venues (${env()})`)
    await ctx.reload()
  }
  else if (a === 'cfg-venues-reset') {
    if (!confirm(`Delete config:venues on ${env()}?\n\nThe map falls back to the built-in venue list.`)) return
    await delKv('config:venues').catch(() => {})
    toast('config:venues deleted — defaults are back in effect')
    await ctx.reload()
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
    await ctx.reload()
  }
  else if (a === 'cfg-podcast-reset') {
    if (!confirm(`Delete config:podcast on ${env()}?\n\nThe site falls back to data/episodes.json.`)) return
    await delKv('config:podcast').catch(() => {})
    toast('config:podcast deleted — data/episodes.json is back in effect')
    await ctx.reload()
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
    await ctx.reload()
  }
  else if (a === 'cfg-nl-reset') {
    if (!confirm(`Delete config:newsletter_template on ${env()}?\n\nThe Newsletter compose tab falls back to the built-in template.`)) return
    await delKv('config:newsletter_template').catch(() => {})
    toast('config:newsletter_template deleted — built-in template is back')
    await ctx.reload()
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
    await ctx.reload()
  }
  else if (a === 'cfg-copy-reset') {
    if (!confirm(`Delete config:copy on ${env()}?\n\nEvery homepage copy field falls back to the hardcoded site text.`)) return
    await delKv('config:copy').catch(() => {})
    toast('config:copy deleted — site defaults are back in effect')
    await ctx.reload()
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
    await ctx.reload()
  }
  else if (a === 'cfg-vp-reset') {
    if (!confirm(`Delete config:voice_prompt on ${env()}?\n\nThe site falls back to the generic default prompt ("${ctx.defaults.voicePrompt.text}", id "${ctx.defaults.voicePrompt.id}").`)) return
    await delKv('config:voice_prompt').catch(() => {})
    toast('config:voice_prompt deleted — generic default prompt is back')
    await ctx.reload()
  }
}

document.addEventListener('click', async (e) => {
  if (!ctx) return
  const btn = e.target.closest('button[data-action^="cfg-"]')
  if (!btn) return
  try { await runAction(btn.dataset.action, btn) }
  catch (err) { toast(err.message || String(err), true) }
})
