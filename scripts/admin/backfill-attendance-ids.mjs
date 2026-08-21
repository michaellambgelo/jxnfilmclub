#!/usr/bin/env node
// Backfill: rewrite every attend:{id} row from bare display names to id-keyed
// `{ id, name }` entries.
//
// Attendance used to be stored as `["Michael Lamb", ...]`. A member who
// renamed lost every past row — the count stayed filed under the old string.
// The Worker now stores `[{ id, name }]` and resolves the name off the member
// id on read, so a rename lands everywhere at once. Reads normalize the old
// shape on the fly, so nothing is broken before this runs; what this does is
// attach the ids, which is what makes the *old* rows follow a rename too.
//
// Names are matched against members:all case-insensitively and with
// surrounding whitespace trimmed (at least one member row carries a trailing
// space). Ambiguous names — two members sharing one — are left unlinked and
// reported rather than guessed at.
//
// A member who renamed BEFORE this ran has rows under a name that matches
// nobody. Those cannot be inferred; pass them explicitly:
//
//   --alias "Old Name=memberId" --alias "Another Old Name=otherId"
//
// Usage:
//   node scripts/admin/backfill-attendance-ids.mjs                 # dry run, production
//   node scripts/admin/backfill-attendance-ids.mjs --apply         # write, production
//   node scripts/admin/backfill-attendance-ids.mjs --env staging   # dry run, staging
//
// Safe to re-run: rows that already carry ids are left alone, and the pass is
// a no-op once it has converged.
//
// Run it at a quiet moment. The final write to `attendance:all` is a
// read-modify-write, so a member clicking "I was there" mid-run could be
// clobbered — and unlike `members:all` there is no reconcile cron to heal the
// attendance aggregate afterwards.

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKER_DIR = resolve(ROOT, 'worker')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const ENV = (() => {
  const i = argv.indexOf('--env')
  return i === -1 ? null : argv[i + 1]
})()

// "Old Name=memberId", repeatable.
const ALIASES = new Map()
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--alias') continue
  const [name, id] = String(argv[i + 1] || '').split('=')
  if (!name || !id) throw new Error(`--alias needs "Old Name=memberId", got ${argv[i + 1]}`)
  ALIASES.set(key(name), id)
}

// --remote: wrangler v4 defaults KV ops to LOCAL simulated storage. Every call
// here must be explicit or the script silently "fixes" a local sandbox.
//
// Retried: the Cloudflare API answers a rapid burst of per-key reads with a
// spurious 401, so a one-shot spawn per key is not reliable. Everything below
// reads aggregates rather than fanning out per key, keeping a whole run to a
// handful of calls.
function wrangler(args, { attempts = 3 } = {}) {
  let last
  for (let i = 1; i <= attempts; i++) {
    const res = spawnSync('npx', ['wrangler', ...args, '--remote', ...(ENV ? ['--env', ENV] : [])], {
      cwd: WORKER_DIR, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (res.status === 0) return res.stdout
    last = (res.stderr || '').trim()
    // A missing key is an answer, not a failure.
    if (/not found|404/i.test(last)) return ''
    if (i < attempts) {
      console.log(`  ! retry ${i}/${attempts - 1}: wrangler ${args.slice(0, 3).join(' ')}`)
      spawnSync('sleep', [String(i)])
    }
  }
  throw new Error(`wrangler ${args.join(' ')} failed after ${attempts} attempts:\n${last}`)
}

const kvGet = (binding, k) => wrangler(['kv', 'key', 'get', '--binding', binding, k])
const kvPut = (binding, k, v) => wrangler(['kv', 'key', 'put', '--binding', binding, k, v])
const parse = (raw) => { try { return JSON.parse(raw) } catch { return null } }

function key(name) {
  return String(name || '').trim().toLowerCase()
}

console.log(`env=${ENV || 'production'} mode=${APPLY ? 'APPLY' : 'dry-run'}`)

// --- name -> id index -------------------------------------------------------
const members = parse(kvGet('MEMBERS_KV', 'members:all')) || []
const byName = new Map()
const ambiguous = new Set()
for (const m of members) {
  if (!m || !m.id || !m.name) continue
  const k = key(m.name)
  if (byName.has(k) && byName.get(k) !== m.id) ambiguous.add(k)
  byName.set(k, m.id)
}
for (const k of ambiguous) byName.delete(k)
for (const [k, id] of ALIASES) byName.set(k, id)
console.log(`members: ${members.length}, resolvable names: ${byName.size}` +
  (ambiguous.size ? `, ambiguous (left unlinked): ${[...ambiguous].join(', ')}` : '') +
  (ALIASES.size ? `, aliases: ${ALIASES.size}` : ''))

// Hosts resolve by hostId regardless of what the mirror wrote as a name.
const events = parse(kvGet('ATTENDANCE_KV', 'events:all')) || []
const hostIdByEvent = new Map()
const hostNameById = new Map()
for (const ev of events) {
  if (!ev || !ev.id || !ev.hostId) continue
  hostIdByEvent.set(ev.id, ev.hostId)
  if (ev.hostName) hostNameById.set(ev.hostId, ev.hostName)
}

// --- rewrite ----------------------------------------------------------------
// The aggregate is written on every mutation, so it normally holds every
// event. Orphans (a per-event key whose aggregate entry was pruned by hand)
// are pulled in individually so the pass can't skip one silently.
const all = parse(kvGet('ATTENDANCE_KV', 'attendance:all')) || {}
const listed = parse(wrangler(['kv', 'key', 'list', '--binding', 'ATTENDANCE_KV', '--prefix', 'attend:'])) || []
for (const k of listed) {
  const eventId = String(k.name || '').slice('attend:'.length)
  if (!eventId || eventId in all) continue
  console.log(`  ~ ${eventId}: no aggregate entry, reading attend:${eventId} directly`)
  all[eventId] = parse(kvGet('ATTENDANCE_KV', k.name)) || []
}
const unmatched = new Map()   // name -> count, reported at the end
let changed = 0

for (const eventId of Object.keys(all)) {
  const current = Array.isArray(all[eventId]) ? all[eventId] : []
  const hostId = hostIdByEvent.get(eventId) || null
  let touched = false

  const next = current.map((entry) => {
    if (entry && typeof entry === 'object') return entry     // already migrated
    const name = String(entry || '')
    if (!name) return { id: null, name }
    // The host mirror wrote a bare name; hostId is the authoritative match for
    // it even when the host has since renamed.
    const id = (hostId && hostNameById.get(hostId) === name)
      ? hostId
      : (byName.get(key(name)) || null)
    if (!id) unmatched.set(name, (unmatched.get(name) || 0) + 1)
    touched = true
    return { id, name }
  })

  if (!touched) continue
  changed++
  const linked = next.filter(a => a.id).length
  console.log(`  + ${eventId}: ${next.length} entries, ${linked} linked, ${next.length - linked} unlinked`)
  all[eventId] = next
  if (APPLY) kvPut('ATTENDANCE_KV', `attend:${eventId}`, JSON.stringify(next))
}

if (unmatched.size) {
  console.log('\nNames that matched no member (left as { id: null }):')
  for (const [name, n] of [...unmatched].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}x  ${JSON.stringify(name)}`)
  }
  console.log('Guests and departed members belong here. If one is a member who')
  console.log('renamed, re-run with --alias "That Name=theirMemberId".')
}

if (!changed) {
  console.log('\nNothing to do — every attendance row already carries member ids.')
} else if (APPLY) {
  // Aggregate last, so a mid-run failure leaves per-event keys ahead of the
  // aggregate (the direction the Worker already tolerates) rather than behind.
  kvPut('ATTENDANCE_KV', 'attendance:all', JSON.stringify(all))
  console.log(`\nUpdated ${changed} event(s) + attendance:all.`)
  console.log('Next: gh workflow run snapshot-attendance.yml (production only) to refresh the ledger.')
} else {
  console.log(`\n${changed} event(s) would change. Re-run with --apply to write.`)
}
