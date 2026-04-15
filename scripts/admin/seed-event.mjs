#!/usr/bin/env node
// Seed a single new event into data/events.json.
//
// Usage:
//   node scripts/admin/seed-event.mjs --film="Whiplash" --year=2014 --date=2026-05-01 --venue="Duling Hall" --letterboxd-uri="https://boxd.it/2aybi" [--title="..."] [--poster="..."] [--id="..."]
//
// Notes:
//   - --title defaults to the film name (matches the backfill convention).
//   - --id defaults to YYYY-MM-DD-film-slug, same as the backfill script.
//   - Does not touch KV or attendance — attendance starts empty and members
//     self-report via the events page.
//   - Does not commit; review + commit yourself.

import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EVENTS_JSON = resolve(ROOT, 'data/events.json')

function parseFlags(argv) {
  const out = {}
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`)
  console.error('usage: seed-event.mjs --film=... --year=YYYY --date=YYYY-MM-DD --venue=... --letterboxd-uri=... [--title=...] [--poster=...] [--id=...]')
  process.exit(msg ? 1 : 0)
}

function slugify(s) {
  return s.toLowerCase()
    .replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const flags = parseFlags(process.argv.slice(2))
for (const required of ['film', 'date', 'venue']) {
  if (!flags[required]) usage(`--${required} required`)
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.date)) usage('--date must be YYYY-MM-DD')

const event = {
  id: flags.id || `${flags.date}-${slugify(flags.film)}`,
  title: flags.title || flags.film,
  film: flags.film,
  year: flags.year ? Number(flags.year) : null,
  date: flags.date,
  venue: flags.venue,
  poster: flags.poster || '',
  letterboxd_uri: flags['letterboxd-uri'] || '',
}

const events = JSON.parse(await readFile(EVENTS_JSON, 'utf8'))
if (events.some(e => e.id === event.id)) {
  console.error(`error: event id already exists: ${event.id}`)
  process.exit(1)
}

events.push(event)
events.sort((a, b) => String(a.date).localeCompare(String(b.date)))
await writeFile(EVENTS_JSON, JSON.stringify(events, null, 2) + '\n')

console.log(`+ ${event.id} — ${event.film} @ ${event.venue} on ${event.date}`)
console.log(`\nReview + commit:\n  git add data/events.json && git commit -m "Add event: ${event.title}"`)
