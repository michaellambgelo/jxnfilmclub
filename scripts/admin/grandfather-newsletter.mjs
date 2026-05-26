#!/usr/bin/env node
// One-shot: grandfather existing members onto the newsletter list.
//
// For every member:{email} row that has no `newsletter` field yet, set
// newsletter:true (opt-in). Idempotent — rows that already carry the field are
// left untouched, so re-running is safe.
//
// Usage:
//   node scripts/admin/grandfather-newsletter.mjs [--env=staging] [--dry-run]
//
// Run against staging first, eyeball with kv-audit.mjs, then prod.
//
// The `newsletter` flag is private (like email): it lives only on the
// member:{email} KV row and is never written to data/members.json.

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKER_DIR = resolve(ROOT, 'worker')
const BINDING = 'MEMBERS_KV'

const flags = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)
const ENV_ARGS = flags.env ? ['--env', String(flags.env)] : []
const DRY = !!flags['dry-run']

function wrangler(args) {
  const res = spawnSync('npx', ['wrangler', ...args], {
    cwd: WORKER_DIR, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (res.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed (exit ${res.status})`)
  return res.stdout
}

function kvList(prefix) {
  const out = wrangler(['kv', 'key', 'list', '--binding', BINDING, ...ENV_ARGS, '--prefix', prefix])
  return JSON.parse(out).map(k => k.name)
}

function kvGet(key) {
  return wrangler(['kv', 'key', 'get', '--binding', BINDING, ...ENV_ARGS, key]).trim()
}

function kvPut(key, value) {
  wrangler(['kv', 'key', 'put', '--binding', BINDING, ...ENV_ARGS, key, value])
}

const target = flags.env ? `(${flags.env})` : '(production)'
console.log(`Grandfathering newsletter opt-in ${target}${DRY ? ' — DRY RUN' : ''}\n`)

const keys = kvList('member:')
let updated = 0
let skipped = 0
for (const key of keys) {
  let row
  try {
    row = JSON.parse(kvGet(key))
  } catch (e) {
    console.log(`  ! could not parse ${key}: ${e.message}`)
    continue
  }
  if (Object.prototype.hasOwnProperty.call(row, 'newsletter')) {
    skipped++
    continue
  }
  row.newsletter = true
  if (DRY) {
    console.log(`  would set newsletter:true on ${key}`)
  } else {
    kvPut(key, JSON.stringify(row))
    console.log(`  ✓ ${key} → newsletter:true`)
  }
  updated++
}

console.log(`\n${DRY ? 'would update' : 'updated'} ${updated}, left ${skipped} already-set row(s) untouched.`)
