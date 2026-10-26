import { describe, expect, it } from 'vitest'
import { assetVersion, versionHtml, versionMount } from '../../scripts/lib/assetversion.mjs'

// GitHub Pages caches every file for ten minutes under a URL that never
// changes between builds, so a deploy reached browsers piecemeal: a new
// views.html.js against an old model/index.js. scripts/version_assets.mjs
// stamps every code URL with one build version after each build.
const HEAD = [
  '<head>',
  '\t<link rel="stylesheet" href="/css/watched.css">',
  '\t<link rel="icon" href="/img/favicon.ico">',
  '\t<script type="importmap">{"imports":{"app":"/model/index.js","state":"/@nue/state.js"}}</script>',
  '\t<script src="/@nue/mount.js" type="module"></script>',
  '</head>',
].join('\n')

// The two URL sites in Nue 2.0.0-beta.2's minified loader, verbatim.
const MOUNT = 'let{mount:i}=await import("/@nue/nue.js");' +
  'async function d(t){let e=[];for(let o of l()){let i=o==t?`?${p++}`:"",{lib:n}=await import(`/${o}.js${i}`);if(n)e.push(...n)}return e}'

describe('assetVersion', () => {
  it('is stable for the same files in any order, and moves when any changes', () => {
    const a = assetVersion([['a.js', 'x'], ['b.css', 'y']])
    expect(a).toMatch(/^[0-9a-f]{10}$/)
    expect(assetVersion([['b.css', 'y'], ['a.js', 'x']])).toBe(a)
    expect(assetVersion([['a.js', 'x'], ['b.css', 'z']])).not.toBe(a)
    // A path is part of the identity, not just the bytes.
    expect(assetVersion([['c.js', 'x'], ['b.css', 'y']])).not.toBe(a)
  })
})

describe('versionHtml', () => {
  const out = versionHtml(HEAD, 'abc123')

  it('stamps the import map, the loader and the stylesheets', () => {
    expect(out).toContain('{"imports":{"app":"/model/index.js?v=abc123","state":"/@nue/state.js?v=abc123"}}')
    expect(out).toContain('<script src="/@nue/mount.js?v=abc123" type="module">')
    expect(out).toContain('<link rel="stylesheet" href="/css/watched.css?v=abc123">')
  })

  it('leaves everything else alone', () => {
    expect(out).toContain('<link rel="icon" href="/img/favicon.ico">')
    expect(out.split('\n')).toHaveLength(HEAD.split('\n').length)
  })

  it('is idempotent and skips external URLs', () => {
    expect(versionHtml(out, 'abc123')).toBe(out)
    const ext = '<script src="https://cdn.example/x.js"></script>'
    expect(versionHtml(ext, 'v1')).toBe(ext)
  })
})

describe('versionMount', () => {
  it('versions both URLs mount.js builds, keeping the dev reload counter', () => {
    const m = versionMount(MOUNT, 'abc123')
    expect(m.libs).toBe(true)
    expect(m.nue).toBe(true)
    expect(m.js).toContain('import("/@nue/nue.js?v=abc123")')
    expect(m.js).toContain('import(`/${o}.js?v=abc123${i?"&"+i.slice(1):""}`)')
  })

  it('evaluates to the right URLs', () => {
    const tpl = versionMount('f=(o,i)=>`/${o}.js${i}`', 'v1').js
    const f = new Function('return ' + tpl.slice(2))()
    expect(f('ui/views.html', '')).toBe('/ui/views.html.js?v=v1')
    expect(f('ui/views.html', '?3')).toBe('/ui/views.html.js?v=v1&3')
  })

  it('reports a loader it no longer recognises', () => {
    const m = versionMount('import(lib)', 'v1')
    expect(m.libs).toBe(false)
    expect(m.nue).toBe(false)
  })

  it('is idempotent', () => {
    const once = versionMount(MOUNT, 'v1')
    const twice = versionMount(once.js, 'v1')
    expect(twice.js).toBe(once.js)
    expect(twice.libs && twice.nue).toBe(true)
  })

  it('moves an earlier build version to the new one', () => {
    // Nue leaves .dist/@nue/mount.js in place across builds, so the second
    // build sees the first build's stamp.
    const m = versionMount(versionMount(MOUNT, 'aaaa111').js, 'bbbb222')
    expect(m.js).not.toContain('aaaa111')
    expect(m.js).toContain('import("/@nue/nue.js?v=bbbb222")')
    expect(m.js).toContain('.js?v=bbbb222${')
    expect(versionHtml(versionHtml(HEAD, 'aaaa111'), 'bbbb222')).toBe(versionHtml(HEAD, 'bbbb222'))
  })
})
