#!/usr/bin/env node
// Post-build pass: move each page's import map ahead of its module loader.
// See scripts/lib/importmap.mjs for why this is necessary and why it is safe
// to keep running after Nue fixes the order upstream.
//
// Runs from `postbuild`, so `npm run build` covers it — and both CI workflows
// build that way. Exits non-zero if any page still has the wrong order after
// the rewrite, so a Nue change that alters the head markup fails the build
// rather than silently shipping a site Firefox cannot render.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { needsImportMapFix, reorderImportMap } from './lib/importmap.mjs'

const DIST = '.dist'

function htmlFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...htmlFiles(path))
    else if (entry.endsWith('.html')) out.push(path)
  }
  return out
}

let fixed = 0
const stillWrong = []

for (const file of htmlFiles(DIST)) {
  const html = readFileSync(file, 'utf8')
  if (!needsImportMapFix(html)) continue
  const next = reorderImportMap(html)
  writeFileSync(file, next)
  fixed++
  if (needsImportMapFix(next)) stillWrong.push(file)
}

if (stillWrong.length) {
  console.error('import map still follows the module loader in:\n  ' + stillWrong.join('\n  '))
  console.error('Firefox will render these pages blank. See scripts/lib/importmap.mjs.')
  process.exit(1)
}

console.log(`import map: ${fixed} page(s) reordered ahead of the module loader`)
