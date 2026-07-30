import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Drift guards for the Worker's copies of main-site brand assets.
// worker/src/brand.css mirrors a subset of css/tokens.css by hand, and
// worker/src/favicon.ico is a copy of img/favicon.ico (wrangler module
// imports can't reach outside worker/src). These tests turn "keep in sync"
// comments into failures.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

function rootTokens(css: string): Map<string, string> {
  const start = css.search(/:root\s*\{/)
  const open = css.indexOf('{', start)
  let depth = 1
  let i = open + 1
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++
    if (css[i] === '}') depth--
    i++
  }
  const block = css.slice(open + 1, i - 1)
  const tokens = new Map<string, string>()
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(m[1], m[2].replace(/\s+/g, ' ').trim())
  }
  return tokens
}

describe('worker brand.css mirrors css/tokens.css', () => {
  const source = rootTokens(read('css/tokens.css'))
  const mirror = rootTokens(read('worker/src/brand.css'))

  it('defines a non-empty token subset', () => {
    expect(mirror.size).toBeGreaterThan(0)
  })

  for (const [name, value] of mirror) {
    // Worker-only tokens (not mirrored from the main site) are exempt.
    if (!source.has(name)) continue
    it(`${name} matches the main site`, () => {
      expect(value).toBe(source.get(name))
    })
  }

  it('every mirrored token exists in css/tokens.css (no invented names)', () => {
    const invented = [...mirror.keys()].filter(n => !source.has(n) && n !== '--page-width')
    expect(invented).toEqual([])
  })
})

describe('worker favicon is a byte-identical copy of the main site favicon', () => {
  it('worker/src/favicon.ico === img/favicon.ico', () => {
    const a = fs.readFileSync(path.join(root, 'img/favicon.ico'))
    const b = fs.readFileSync(path.join(root, 'worker/src/favicon.ico'))
    expect(b.equals(a)).toBe(true)
  })
})
