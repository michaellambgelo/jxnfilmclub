#!/usr/bin/env node
// Send a Jackson Film Club newsletter to all opted-in members.
//
// Composes nothing itself — it POSTs your subject + body to the Worker's
// /admin/newsletter/send endpoint, which owns the recipient list (members with
// newsletter:true), the per-recipient one-click unsubscribe links, the
// List-Unsubscribe headers, and the CAN-SPAM postal footer.
//
// Usage:
//   ADMIN_TOKEN=... node scripts/admin/send-newsletter.mjs \
//     --subject="May screening: ..." --html=draft.html [--text=draft.txt] [--yes]
//   ADMIN_TOKEN=... node scripts/admin/send-newsletter.mjs ... \
//     --origin=https://join-staging.jxnfilm.club
//
// Without --yes it prints a dry preview (subject + body sources + target
// origin) and does NOT send. Pass --yes to actually fire.

import { readFile } from 'node:fs/promises'

const flags = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)

const origin = flags.origin || 'https://join.jxnfilm.club'
const subject = flags.subject
const token = process.env.ADMIN_TOKEN

if (!subject || (!flags.html && !flags.text)) {
  console.error('usage: ADMIN_TOKEN=... send-newsletter.mjs --subject="..." --html=draft.html [--text=draft.txt] [--origin=...] [--yes]')
  process.exit(1)
}
if (!token) {
  console.error('error: ADMIN_TOKEN env var is required')
  process.exit(1)
}

const html = flags.html ? await readFile(flags.html, 'utf8') : undefined
const text = flags.text ? await readFile(flags.text, 'utf8') : undefined

console.log(`Newsletter → ${origin}/admin/newsletter/send`)
console.log(`  subject: ${subject}`)
console.log(`  html:    ${flags.html || '(none)'}  ${html ? `(${html.length} chars)` : ''}`)
console.log(`  text:    ${flags.text || '(none)'}  ${text ? `(${text.length} chars)` : ''}`)

if (!flags.yes) {
  console.log('\nDRY RUN — re-run with --yes to actually send.')
  process.exit(0)
}

const res = await fetch(`${origin}/admin/newsletter/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ subject, html, text }),
})
const data = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`\nFailed: HTTP ${res.status} ${data.error || ''}`)
  process.exit(1)
}
console.log(`\n✓ Sent to ${data.sent} member(s).`)
