#!/usr/bin/env node
// One-shot backfill: read a Letterboxd CSV archive and seed every diary entry
// tagged `jxnfilmclub` as an event in data/events.json + data/attendance.json.
//
// Usage:
//   node scripts/admin/seed-events-from-archive.mjs --archive=<path-to-diary.csv> [--handle=michaellamb] [--dry-run]
//
// What it does:
//   1. Parses the diary.csv (Letterboxd export format).
//   2. For each row tagged `jxnfilmclub`, builds an event row keyed by
//      YYYY-MM-DD-film-slug and appends to data/events.json (skip if id exists).
//   3. Auto-attends the archive owner's handle (default: michaellamb) on every
//      backfilled event in data/attendance.json.
//
// What it doesn't do:
//   - Touch KV. Attendance KV (`attend:{event_id}`) is hydrated separately by
//     `kv-audit.mjs` or by the worker on first read.
//   - Commit the diff. Review and commit yourself.

import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EVENTS_JSON = resolve(ROOT, 'data/events.json')
const ATTENDANCE_JSON = resolve(ROOT, 'data/attendance.json')
const TAG = 'jxnfilmclub'

function parseFlags(argv) {
  const out = { dryRun: false }
  for (const arg of argv) {
    if (arg === '--dry-run') { out.dryRun = true; continue }
    const m = arg.match(/^--([^=]+)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`)
  console.error('usage: seed-events-from-archive.mjs --archive=<path-to-diary.csv> [--handle=michaellamb] [--dry-run]')
  process.exit(msg ? 1 : 0)
}

// Minimal RFC-4180-ish CSV parser. Handles quoted fields with embedded commas
// and escaped double-quotes. Letterboxd exports use \n line endings and quote
// only fields that need it, so this is sufficient.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else {
      field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

function rowsToObjects(rows) {
  const [header, ...data] = rows
  return data
    .filter(r => r.length === header.length && r.some(v => v.length))
    .map(r => Object.fromEntries(header.map((k, i) => [k, r[i]])))
}

function slugify(s) {
  return s.toLowerCase()
    .replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function buildEvent(entry) {
  const date = entry['Watched Date']
  const film = entry['Name']
  const year = entry['Year'] ? Number(entry['Year']) : null
  const id = `${date}-${slugify(film)}`
  return {
    id,
    title: film,
    film,
    year,
    date,
    venue: 'TBD',
    poster: '',
    letterboxd_uri: entry['Letterboxd URI'] || '',
  }
}

function hasTag(entry) {
  return (entry['Tags'] || '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .includes(TAG)
}

const flags = parseFlags(process.argv.slice(2))
if (!flags.archive) usage('--archive=<path-to-diary.csv> required')
const handle = flags.handle || 'michaellamb'

const csv = await readFile(flags.archive, 'utf8')
const entries = rowsToObjects(parseCsv(csv)).filter(hasTag)
console.log(`Found ${entries.length} ${TAG}-tagged diary entries.`)

const events = JSON.parse(await readFile(EVENTS_JSON, 'utf8'))
const attendance = JSON.parse(await readFile(ATTENDANCE_JSON, 'utf8'))
const existingIds = new Set(events.map(e => e.id))

let added = 0
for (const entry of entries) {
  const ev = buildEvent(entry)
  if (existingIds.has(ev.id)) {
    if (!attendance[ev.id]) attendance[ev.id] = []
    if (!attendance[ev.id].includes(handle)) attendance[ev.id].push(handle)
    console.log(`· skip event ${ev.id} (exists); ensured @${handle} attended`)
    continue
  }
  events.push(ev)
  existingIds.add(ev.id)
  attendance[ev.id] = [handle]
  added++
  console.log(`+ ${ev.id} — ${ev.film} (${ev.year || '—'})`)
}

events.sort((a, b) => String(a.date).localeCompare(String(b.date)))

if (flags.dryRun) {
  console.log(`\n[dry-run] would add ${added} events; data files unchanged.`)
  process.exit(0)
}

await writeFile(EVENTS_JSON, JSON.stringify(events, null, 2) + '\n')
await writeFile(ATTENDANCE_JSON, JSON.stringify(attendance, null, 2) + '\n')

console.log(`\nWrote ${added} new event${added === 1 ? '' : 's'} to data/events.json.`)
console.log(`Updated data/attendance.json with @${handle} on ${entries.length} event${entries.length === 1 ? '' : 's'}.`)
console.log(`\nReview + commit:\n  git add data/events.json data/attendance.json && git commit -m "Backfill jxnfilmclub events from archive"`)
