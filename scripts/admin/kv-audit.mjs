#!/usr/bin/env node
// Read-only drift check between data/members.json and production KV.
//
// Prints:
//   - JSON ids that have no member:{email} row in KV (lookup by scanning
//     member:* keys and matching by id field).
//   - KV member:{email} rows whose id is not in data/members.json.
//
// Exits 0 always (informational). Run anytime you want to know if things
// are in sync.

import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MEMBERS_JSON = resolve(ROOT, 'data/members.json')
const WORKER_DIR = resolve(ROOT, 'worker')
const BINDING = 'MEMBERS_KV'

function wrangler(args) {
  const res = spawnSync('npx', ['wrangler', ...args], {
    cwd: WORKER_DIR, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (res.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed (exit ${res.status})`)
  return res.stdout
}

function kvList(prefix) {
  const out = wrangler(['kv', 'key', 'list', '--binding', BINDING, '--prefix', prefix])
  return JSON.parse(out).map(k => k.name)
}

function kvGet(key) {
  return wrangler(['kv', 'key', 'get', '--binding', BINDING, key]).trim()
}

const members = JSON.parse(await readFile(MEMBERS_JSON, 'utf8'))
const jsonById = new Map(members.map(m => [m.id, m]))

console.log(`data/members.json: ${members.length} rows`)

const kvMemberKeys = kvList('member:')
console.log(`KV member:* keys:  ${kvMemberKeys.length}`)

const kvById = new Map()
for (const key of kvMemberKeys) {
  try {
    const row = JSON.parse(kvGet(key))
    kvById.set(row.id, { key, row })
  } catch (e) {
    console.log(`  ! could not parse ${key}: ${e.message}`)
  }
}

const missingInKv = members.filter(m => !kvById.has(m.id))
const orphanInKv = [...kvById.values()].filter(({ row }) => !jsonById.has(row.id))

console.log()
if (missingInKv.length) {
  console.log(`Missing member:{email} in KV (${missingInKv.length}):`)
  for (const m of missingInKv) console.log(`  - id=${m.id} name="${m.name}"`)
} else {
  console.log(`All data/members.json rows have a KV counterpart.`)
}

console.log()
if (orphanInKv.length) {
  console.log(`KV rows with no matching data/members.json id (${orphanInKv.length}):`)
  for (const { key, row } of orphanInKv) console.log(`  - ${key} id=${row.id} name="${row.name}"`)
} else {
  console.log(`No orphan KV rows.`)
}
