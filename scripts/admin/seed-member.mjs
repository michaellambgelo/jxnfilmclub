#!/usr/bin/env node
// Seed a member into data/members.json + KV.
//
// Usage:
//   node scripts/admin/seed-member.mjs --email=... --name=... [--handle=...] [--pronouns=...] [--id=...] [--joined=YYYY-MM-DD]
//   node scripts/admin/seed-member.mjs <path-to-json>     # single object or array of objects
//   node scripts/admin/seed-member.mjs                    # reads .admin/pending-members.json
//
// What it does:
//   1. For each member, generates a random `id` if none is provided.
//   2. Appends to data/members.json unless an entry with that `id` already exists.
//   3. Writes `member:{email}` to production KV (name, id, handle, pronouns, joined).
//   4. If handle is set, also writes email:{handle} and handle:{email}.
//
// What it doesn't do:
//   - Commit the data/members.json diff — that's on you, so the admin can
//     review and commit in a batch.
//   - Send email, talk to Resend, dispatch GH Actions.
//
// The KV schema matches worker/src/index.js:handleSignupVerify — keep in
// sync if that ever changes.

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MEMBERS_JSON = resolve(ROOT, 'data/members.json')
const DEFAULT_INPUT = resolve(ROOT, '.admin/pending-members.json')
const WORKER_DIR = resolve(ROOT, 'worker')
const BINDING = 'MEMBERS_KV'

const HANDLE_RE = /^[a-zA-Z0-9_-]+$/

function randomId() {
  return randomBytes(8).toString('base64url').slice(0, 10)
}

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
  console.error(
`usage:
  seed-member.mjs --email=X --name=Y [--handle=Z] [--pronouns=...] [--id=...] [--joined=YYYY-MM-DD]
  seed-member.mjs <path-to-json>
  seed-member.mjs                         (reads .admin/pending-members.json)`)
  process.exit(msg ? 1 : 0)
}

function validate(m) {
  if (!m.email || typeof m.email !== 'string') throw new Error(`missing email on ${JSON.stringify(m)}`)
  if (!m.name || typeof m.name !== 'string')   throw new Error(`missing name on ${JSON.stringify(m)}`)
  if (m.handle && !HANDLE_RE.test(m.handle))   throw new Error(`invalid handle format: ${m.handle}`)
}

function wrangler(args, { input } = {}) {
  const res = spawnSync('npx', ['wrangler', ...args], {
    cwd: WORKER_DIR,
    input,
    encoding: 'utf8',
    stdio: input !== undefined ? ['pipe', 'pipe', 'inherit'] : 'inherit',
  })
  if (res.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed (exit ${res.status})`)
  return res.stdout
}

function kvPut(key, value) {
  // Value can be arbitrary; pass via stdin isn't supported, so use a positional.
  // Using double-quotes in the arg is safe because spawnSync doesn't shell-evaluate.
  // No --remote flag: remote is wrangler's default; --local would override.
  wrangler(['kv', 'key', 'put', '--binding', BINDING, key, value])
}

async function loadInput(args) {
  const flags = parseFlags(args)
  if (flags.email || flags.name) {
    // Single entry via flags
    if (!flags.email) usage('--email required')
    if (!flags.name) usage('--name required')
    return [{
      email: flags.email,
      name: flags.name,
      handle: flags.handle || null,
      pronouns: flags.pronouns || null,
      id: flags.id || undefined,
      joined: flags.joined || undefined,
    }]
  }
  const path = args.find(a => !a.startsWith('--')) || DEFAULT_INPUT
  if (!existsSync(path)) usage(`no input: ${path}`)
  const raw = JSON.parse(await readFile(path, 'utf8'))
  return Array.isArray(raw) ? raw : [raw]
}

async function upsertJson(member) {
  const all = JSON.parse(await readFile(MEMBERS_JSON, 'utf8'))
  const existing = all.find(m => m.id === member.id)
  if (existing) return { added: false, existing }

  const row = {
    id: member.id,
    name: member.name,
    joined: member.joined,
    pronouns: member.pronouns || '',
  }
  if (member.handle) row.handle = member.handle
  all.push(row)
  await writeFile(MEMBERS_JSON, JSON.stringify(all, null, 2) + '\n')
  return { added: true, row }
}

async function seedOne(input) {
  validate(input)
  const today = new Date().toISOString().slice(0, 10)
  const member = {
    id: input.id || randomId(),
    email: input.email,
    name: input.name,
    handle: input.handle || null,
    pronouns: input.pronouns || null,
    joined: input.joined || today,
  }

  const jsonResult = await upsertJson(member)

  // KV writes — always. Even if the JSON row already existed, we may be
  // backfilling KV.
  const memberRow = {
    id: member.id,
    email: member.email,
    name: member.name,
    handle: member.handle,
    pronouns: member.pronouns,
    joined: member.joined,
  }
  kvPut(`member:${member.email}`, JSON.stringify(memberRow))
  if (member.handle) {
    kvPut(`email:${member.handle}`, member.email)
    kvPut(`handle:${member.email}`, member.handle)
  }

  return { member, jsonResult }
}

const results = []
for (const input of await loadInput(process.argv.slice(2))) {
  const r = await seedOne(input)
  results.push(r)
  const jsonNote = r.jsonResult.added ? 'added to data/members.json' : `already in data/members.json (id=${r.member.id})`
  const lbNote = r.member.handle ? `, linked handle @${r.member.handle}` : ''
  console.log(`✓ ${r.member.email}: ${jsonNote}, wrote member:${r.member.email}${lbNote}`)
}

const added = results.filter(r => r.jsonResult.added).length
if (added > 0) {
  console.log(`\nCommit the data/members.json diff:\n  git add data/members.json && git commit -m "Seed member${added > 1 ? 's' : ''}: ${results.filter(r => r.jsonResult.added).map(r => r.member.name).join(', ')}"`)
} else {
  console.log(`\ndata/members.json unchanged (KV-only backfill).`)
}
