// Nue emits the module loader BEFORE the import map.
//
// `nuekit/src/render/head.js` pushes the page's scripts and only then the map:
//
//     head.push(...scripts)
//     head.push(importMap(conf.import_map))
//
// An import map must precede any module load. Chromium and WebKit tolerate the
// wrong order; Firefox enforces it, refuses the map outright, and the first
// bare specifier then throws:
//
//     Import maps are not allowed after a module load or preload has started.
//     The specifier "state" was a bare specifier, but was not remapped to anything.
//
// The SPA never mounts, so <article> stays empty and the whole site renders as
// a blank page — confirmed against production, not just a local build. Nothing
// in site.yaml controls the order, so a post-build reorder is the only fix
// available from this repo. Upstream is the real home for it; until then this
// runs from `postbuild`, which covers every path that ships a build (both CI
// workflows go through `npm run build`).
//
// Deliberately idempotent and absence-tolerant: when Nue is fixed upstream the
// map is already first, this becomes a no-op, and nothing here needs removing
// in a hurry.

// The map is a single tag holding JSON. JSON contains no '<', so [^<]* cannot
// run past the closing tag — no lazy-quantifier backtracking, and no risk of
// swallowing a following script.
const IMPORT_MAP = /[ \t]*<script[^>]*\btype=(["'])importmap\1[^>]*>[^<]*<\/script>\n?/i

// The first module script — the one whose load locks the map out.
const MODULE_SCRIPT = /[ \t]*<script[^>]*\btype=(["'])module\1[^>]*>/i

export function needsImportMapFix(html) {
  const map = IMPORT_MAP.exec(html)
  if (!map) return false
  const mod = MODULE_SCRIPT.exec(html)
  if (!mod) return false
  return mod.index < map.index
}

// Move the import map ahead of the first module script. Returns the html
// unchanged when there is no map, no module script, or the order is already
// correct.
export function reorderImportMap(html) {
  if (!needsImportMapFix(html)) return html
  const map = IMPORT_MAP.exec(html)
  const tag = map[0]
  // Cut first, then locate the insertion point in the REMAINDER. Finding it in
  // the original and splicing into the cut string would be off by the tag's
  // length whenever the map precedes the anchor, which is exactly the case
  // this function exists to handle.
  const without = html.slice(0, map.index) + html.slice(map.index + tag.length)
  const mod = MODULE_SCRIPT.exec(without)
  // Carry the module script's own indentation so the emitted head stays tidy.
  // Taken from the match itself: MODULE_SCRIPT swallows the leading whitespace,
  // so mod.index already points at it and the text before it ends in a newline.
  const indent = (/^[ \t]*/.exec(mod[0]) || [''])[0]
  return without.slice(0, mod.index) + indent + tag.trim() + '\n' + without.slice(mod.index)
}
