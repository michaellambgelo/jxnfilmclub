#!/usr/bin/env node
// Post-build pass: stamp every code URL with a build version so a deploy
// replaces the browser's cached modules all at once. See
// scripts/lib/assetversion.mjs for why.
//
// Runs from `postbuild` after fix_importmap.mjs. Exits non-zero if mount.js
// no longer matches the patterns it rewrites, so a Nue upgrade that changes
// the loader fails the build instead of shipping unversioned component URLs.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { assetVersion, versionHtml, versionMount } from './lib/assetversion.mjs'

const DIST = '.dist'
const MOUNT = join(DIST, '@nue', 'mount.js')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

const all = walk(DIST)
// Code only: data/*.json changes on every Letterboxd refresh and must not
// move the code URLs. vendor/ is versioned by its own file names. mount.js is
// left out because this script rewrites it (and Nue does not regenerate it on
// a rebuild); it only changes with a Nue upgrade, which changes nue.js too.
const code = all.filter(p => /\.(js|css)$/.test(p) && p !== MOUNT && !relative(DIST, p).startsWith('vendor'))
const v = assetVersion(code.map(p => [relative(DIST, p), readFileSync(p)]))

const mount = versionMount(readFileSync(MOUNT, 'utf8'), v)
if (!mount.libs || !mount.nue) {
  console.error('version_assets: @nue/mount.js no longer matches ' +
    [!mount.libs && 'the lib URL template', !mount.nue && 'the nue.js import'].filter(Boolean).join(' or '))
  console.error('Component modules would ship unversioned. See scripts/lib/assetversion.mjs.')
  process.exit(1)
}
writeFileSync(MOUNT, mount.js)

let pages = 0
for (const file of all.filter(p => p.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8')
  const next = versionHtml(html, v)
  if (next !== html) { writeFileSync(file, next); pages++ }
}

console.log(`asset version ${v}: mount.js and ${pages} page(s) stamped`)
