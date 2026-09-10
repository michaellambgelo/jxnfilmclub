import { describe, expect, it } from 'vitest'
import { needsImportMapFix, reorderImportMap } from '../../scripts/lib/importmap.mjs'

// Nue emits the module loader before the import map, which Firefox refuses —
// the map is ignored, the first bare specifier throws, the SPA never mounts and
// the whole site renders blank. Confirmed against production, not just a local
// build. scripts/fix_importmap.mjs repairs it after every build.
const MAP = '<script type="importmap">{"imports":{"state":"/@nue/state.js"}}</script>'
const MOD = '<script src="/@nue/mount.js" type="module"></script>'

const broken = `<head>\n\t<link rel="stylesheet" href="/a.css">\n\t${MOD}\n\t${MAP}\n</head>`

describe('import map ordering', () => {
  it('detects the order Nue actually emits', () => {
    expect(needsImportMapFix(broken)).toBe(true)
  })

  it('moves the map ahead of the module loader', () => {
    const out = reorderImportMap(broken)
    expect(out.indexOf(MAP)).toBeLessThan(out.indexOf(MOD))
    expect(needsImportMapFix(out)).toBe(false)
  })

  it('keeps the rest of the document byte-identical', () => {
    const out = reorderImportMap(broken)
    // Same tags, same stylesheet, nothing dropped or duplicated.
    expect(out).toContain('<link rel="stylesheet" href="/a.css">')
    expect(out.match(/<script/g)).toHaveLength(2)
    expect(out.split(MAP)).toHaveLength(2)
    expect(out.split(MOD)).toHaveLength(2)
  })

  it('carries the module loader indentation onto the moved tag', () => {
    expect(reorderImportMap(broken)).toContain(`\t${MAP}\n\t${MOD}`)
  })

  // The point of running unconditionally from postbuild: when Nue fixes the
  // order upstream this becomes a no-op that nobody has to remember to remove.
  it('is idempotent, and a no-op once the order is right', () => {
    const once = reorderImportMap(broken)
    expect(reorderImportMap(once)).toBe(once)
    expect(needsImportMapFix(once)).toBe(false)
  })

  it('leaves a page with no map or no module script alone', () => {
    const plain = '<head>\n\t<link rel="stylesheet" href="/a.css">\n</head>'
    expect(reorderImportMap(plain)).toBe(plain)
    const mapOnly = `<head>\n\t${MAP}\n</head>`
    expect(reorderImportMap(mapOnly)).toBe(mapOnly)
    const modOnly = `<head>\n\t${MOD}\n</head>`
    expect(reorderImportMap(modOnly)).toBe(modOnly)
  })

  // JSON cannot contain '<', which is what makes the [^<]* body match safe.
  it('does not swallow a script that follows the map', () => {
    const after = `<head>\n\t${MOD}\n\t${MAP}\n\t<script src="/x.js"></script>\n</head>`
    const out = reorderImportMap(after)
    expect(out).toContain('<script src="/x.js"></script>')
    expect(out.indexOf(MAP)).toBeLessThan(out.indexOf(MOD))
  })

  it('handles single-quoted type attributes', () => {
    const sq = broken.replace('type="importmap"', "type='importmap'").replace('type="module"', "type='module'")
    expect(needsImportMapFix(sq)).toBe(true)
    const out = reorderImportMap(sq)
    expect(out.indexOf('importmap')).toBeLessThan(out.indexOf("type='module'"))
  })
})
