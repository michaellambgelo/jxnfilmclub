// Cache-busting for the SPA's code.
//
// GitHub Pages serves every file with `Cache-Control: max-age=600`, and Nue
// emits the same URL for a module on every build (/model/index.js,
// /ui/views.html.js, ...). A normal reload revalidates the page but takes its
// modules straight from the browser cache, so for up to ten minutes after a
// deploy a visitor runs the old code. Worse, each file expires on its own
// clock: a new views.html.js can meet an old model/index.js and the page
// breaks in ways neither build ever did. Seen in production 2026-10-24.
//
// The fix is a build version in every code URL, so a deploy changes them all
// at once. The version is a hash of the built JS and CSS, not of the data
// files: the Letterboxd refresh commits that redeploy several times a day
// leave the code URLs, and so the browser cache, alone.
//
// The URLs live in three places:
//   - the page head: the import map (app, state), the module loader script,
//     and the stylesheets;
//   - @nue/mount.js, which builds each component lib URL from the page's
//     `libs` meta (`/${lib}.js`) and imports /@nue/nue.js directly.
// mount.js is minified, so its two patterns are matched loosely and the build
// fails (see scripts/version_assets.mjs) if either stops matching, rather than
// shipping a half-versioned site.

import { createHash } from 'node:crypto'

// One version for the build: a short hash over the code files, in path order
// so it does not depend on directory listing order. files: [path, content].
export function assetVersion(files) {
  const h = createHash('sha256')
  for (const [path, content] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    h.update(path)
    h.update('\0')
    h.update(content)
    h.update('\0')
  }
  return h.digest('hex').slice(0, 10)
}

// A version this file stamped. Re-stamping replaces it rather than skipping:
// Nue's build leaves an existing .dist/@nue/mount.js in place, so a local
// rebuild would otherwise keep the previous build's version there.
const STAMPED = /\?v=[0-9a-f]+/g

// Append ?v= to a root-relative URL, or replace the version it already has.
// Any other query is left alone, so every rewrite here is idempotent.
function stamp(url, v) {
  if (!url.startsWith('/')) return url
  // A fresh non-global regex: .test on the /g STAMPED would carry lastIndex
  // from one URL to the next.
  if (/\?v=[0-9a-f]+/.test(url)) return url.replace(STAMPED, '?v=' + v)
  return url.includes('?') ? url : url + '?v=' + v
}

const IMPORT_MAP = /(<script[^>]*\btype=(["'])importmap\2[^>]*>)([^<]*)(<\/script>)/i
// Each URL may already carry an earlier build's ?v=, which stamp() replaces.
const SCRIPT_SRC = /(<script[^>]*\bsrc=)(["'])([^"']+\.js(?:\?v=[0-9a-f]+)?)\2/gi
const STYLESHEET = /(<link[^>]*\brel=(["'])stylesheet\2[^>]*\bhref=)(["'])([^"']+\.css(?:\?v=[0-9a-f]+)?)\3/gi

// Version the code URLs in one built page. Returns the html unchanged when it
// has none of them.
export function versionHtml(html, v) {
  let out = html.replace(IMPORT_MAP, (all, open, q, json, close) => {
    let map
    try { map = JSON.parse(json) } catch { return all }
    const imports = map && map.imports
    if (!imports || typeof imports !== 'object') return all
    for (const k of Object.keys(imports)) imports[k] = stamp(imports[k], v)
    return open + JSON.stringify(map) + close
  })
  out = out.replace(SCRIPT_SRC, (all, pre, q, url) => pre + q + stamp(url, v) + q)
  out = out.replace(STYLESHEET, (all, pre, q1, q2, url) => pre + q2 + stamp(url, v) + q2)
  return out
}

// `/${lib}.js${suffix}` where suffix is the dev-server reload counter (empty in
// a built site). Any identifier names, since the file is minified.
const LIB_URL = /`\/\$\{([\w$]+)\}\.js\$\{([\w$]+)\}`/
const NUE_IMPORT = /import\((["'])\/@nue\/nue\.js\1\)/

// Version the URLs mount.js builds. Returns { js, libs, nue } with whether
// each pattern was found (already-versioned counts as found).
export function versionMount(js, v) {
  // Already stamped by an earlier run: move it to this version.
  let out = js.replace(STAMPED, '?v=' + v)
  let libs = false
  let nue = false
  if (out.includes('.js?v=')) libs = true
  out = out.replace(LIB_URL, (all, lib, suffix) => {
    libs = true
    return '`/${' + lib + '}.js?v=' + v + '${' + suffix + '?"&"+' + suffix + '.slice(1):""}`'
  })
  if (out.includes('/@nue/nue.js?v=')) nue = true
  out = out.replace(NUE_IMPORT, (all, q) => {
    nue = true
    return 'import(' + q + '/@nue/nue.js?v=' + v + q + ')'
  })
  return { js: out, libs, nue }
}
