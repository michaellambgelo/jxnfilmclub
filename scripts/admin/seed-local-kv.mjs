#!/usr/bin/env node
// Sync production Worker KV member records to local KV.
//
// Usage:
//   node scripts/admin/seed-local-kv.mjs
//
// Reads all member:* keys from production MEMBERS_KV, fetches each record,
// and writes it to local KV (--local flag). Also syncs handle/email
// bidirectional lookups. This gives the local Worker real emails so the
// full OTP sign-in flow works during development.
//
// Safe to re-run — overwrites local KV entries with the latest prod data.
// Wired up as a post-merge git hook so local KV stays fresh on pull.

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKER_DIR = resolve(ROOT, 'worker')
const BINDING = 'MEMBERS_KV'

function wrangler(args) {
  const res = spawnSync('npx', ['wrangler', ...args], {
    cwd: WORKER_DIR, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (res.status !== 0) {
    const msg = (res.stderr || '').trim()
    throw new Error(`wrangler ${args.slice(0, 4).join(' ')} failed: ${msg}`)
  }
  return res.stdout
}

function kvListProd(prefix) {
  const out = wrangler(['kv', 'key', 'list', '--binding', BINDING, '--prefix', prefix])
  return JSON.parse(out).map(k => k.name)
}

function kvGetProd(key) {
  return wrangler(['kv', 'key', 'get', '--binding', BINDING, key]).trim()
}

function kvPutLocal(key, value) {
  wrangler(['kv', 'key', 'put', '--binding', BINDING, '--local', key, value])
}

const memberKeys = kvListProd('member:')
console.log(`Production KV: ${memberKeys.length} member record(s)`)

let seeded = 0
for (const key of memberKeys) {
  let raw
  try {
    raw = kvGetProd(key)
  } catch (e) {
    console.error(`  ! could not read ${key}: ${e.message}`)
    continue
  }

  kvPutLocal(key, raw)

  let member
  try { member = JSON.parse(raw) } catch { member = {} }

  if (member.handle) {
    kvPutLocal(`email:${member.handle}`, member.email)
    kvPutLocal(`handle:${member.email}`, member.handle)
  }

  seeded++
  const handleNote = member.handle ? ` (@${member.handle})` : ''
  console.log(`  ${member.name || key}${handleNote}`)
}

console.log(`\nSynced ${seeded} member(s) to local KV.`)
