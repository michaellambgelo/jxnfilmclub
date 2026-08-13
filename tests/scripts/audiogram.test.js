import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildFiltergraph, buildRenderArgs, COLORS, escapeHtml, FORMAT_KEYS, FORMATS,
  instantiateTemplate, parseArgs, resolveFormats, safeName, WAVE_SRC_W,
} from '../../scripts/lib/audiogram.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('brand token guard', () => {
  // The template gets its colors straight from css/tokens.css; these ffmpeg
  // literals are the only hardcoded copies of the palette. If tokens.css
  // changes, this fails instead of the videos silently going off-brand
  // (the convention from tests/model/brand-sync.test.ts).
  const tokens = readFileSync(join(ROOT, 'css', 'tokens.css'), 'utf8')
  const token = (name) => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens)
    if (!m) throw new Error(`token ${name} not found in css/tokens.css`)
    return m[1].toLowerCase()
  }
  const hex = (ffmpegColor) => ffmpegColor.replace(/^0x/, '#').toLowerCase()

  it('COLORS.bg is --bg', () => expect(hex(COLORS.bg)).toBe(token('--bg')))
  it('COLORS.bar is --line-2 (the .speak-wave bar grey)', () => expect(hex(COLORS.bar)).toBe(token('--line-2')))
  it('COLORS.brand is --brand', () => expect(hex(COLORS.brand)).toBe(token('--brand')))
})

describe('FORMATS geometry', () => {
  it('covers exactly 16x9, 1x1, 9x16', () => {
    expect(FORMAT_KEYS.sort()).toEqual(['16x9', '1x1', '9x16'].sort())
  })
  it.each(FORMAT_KEYS)('%s wave window fits inside the frame', (key) => {
    const { width, height, wave } = FORMATS[key]
    expect(wave.x + wave.w).toBeLessThanOrEqual(width)
    expect(wave.y + wave.h).toBeLessThanOrEqual(height)
  })
  it.each(FORMAT_KEYS)('%s wave width is an exact multiple of the showfreqs source width', (key) => {
    // Anything else would blur the neighbor upscale's chunky columns.
    expect(FORMATS[key].wave.w % WAVE_SRC_W).toBe(0)
  })
})

describe('escapeHtml', () => {
  it('escapes markup and quotes', () => {
    expect(escapeHtml(`<b>"O'Brien & Co"</b>`)).toBe('&lt;b&gt;&quot;O&#39;Brien &amp; Co&quot;&lt;/b&gt;')
  })
  it('stringifies null/undefined to empty', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
})

describe('instantiateTemplate', () => {
  const tpl = readFileSync(join(ROOT, 'scripts', 'assets', 'audiogram.html'), 'utf8')
  it('fills every slot and escapes user text', () => {
    const html = instantiateTemplate(tpl, { format: '16x9', title: 'A & B', name: '<X>' })
    expect(html).not.toMatch(/{{[A-Z]+}}/)
    expect(html).toContain('class="f-16x9"')
    expect(html).toContain('A &amp; B')
    expect(html).toContain('&lt;X&gt;')
  })
  it('injects the wave rect from FORMATS', () => {
    const { wave } = FORMATS['9x16']
    const html = instantiateTemplate(tpl, { format: '9x16', title: 't', name: 'n' })
    expect(html).toContain(`--wx: ${wave.x}px`)
    expect(html).toContain(`--wh: ${wave.h}px`)
  })
  it('rejects unknown formats', () => {
    expect(() => instantiateTemplate(tpl, { format: '4x3', title: '', name: '' })).toThrow(/unknown format/)
  })
})

describe('buildFiltergraph', () => {
  it.each(FORMAT_KEYS)('%s wires the wave window geometry and brand colors', (key) => {
    const { wave } = FORMATS[key]
    const g = buildFiltergraph(key)
    expect(g).toContain(`s=${WAVE_SRC_W}x${wave.h}`)
    expect(g).toContain(`scale=${wave.w}:${wave.h}:flags=neighbor`)
    expect(g).toContain(`overlay=${wave.x}:${wave.y}:shortest=1`)
    expect(g).toContain(`colors=${COLORS.bar}`)
    expect(g).toContain(`colors=${COLORS.brand}`)
    // Both composites blend in RGB — yuv blending rounds the base and the
    // PNG differently and re-introduces the grill-stripe artifact.
    expect(g.match(/format=rgb/g)).toHaveLength(2)
  })
  it('keys out the showfreqs background', () => {
    expect(buildFiltergraph('16x9')).toContain('colorkey=0x000000')
  })
})

describe('buildRenderArgs', () => {
  it('encodes H.264/AAC with faststart at the frame size', () => {
    const args = buildRenderArgs({ format: '1x1', audioPath: 'a.wav', framePath: 'f.png', outPath: 'o.mp4' })
    const s = args.join(' ')
    expect(s).toContain('-c:v libx264')
    expect(s).toContain('-pix_fmt yuv420p')
    expect(s).toContain('-movflags +faststart')
    expect(s).toContain('s=1080x1080')
    // The ink base must be generated in RGB, not negotiated through yuv.
    expect(s).toContain(`color=c=${COLORS.bg}:s=1080x1080:r=30,format=rgb24`)
    expect(args.at(-1)).toBe('o.mp4')
  })
})

describe('safeName', () => {
  it('sanitizes for the filesystem', () => {
    expect(safeName('member:éx/..y')).toBe('member-x-..y')
    expect(safeName('mem_1.2-x')).toBe('mem_1.2-x')
    expect(safeName('///')).toBe('clip')
    expect(safeName('')).toBe('clip')
  })
})

describe('resolveFormats', () => {
  it('expands all', () => expect(resolveFormats('all')).toEqual(FORMAT_KEYS))
  it('accepts a single format', () => expect(resolveFormats('9x16')).toEqual(['9x16']))
  it('rejects junk', () => expect(() => resolveFormats('4k')).toThrow(/--format must be one of/))
})

describe('parseArgs', () => {
  it('file mode with defaults', () => {
    const o = parseArgs(['clips/my-clip.m4a'])
    expect(o.audioPath).toBe('clips/my-clip.m4a')
    expect(o.formats).toEqual(['16x9'])
    expect(o.title).toBe('') // logo + name only unless --title opts in
    expect(o.promptId).toBeNull()
  })
  it('prompt mode', () => {
    const o = parseArgs(['--prompt', 'general', '--env', 'staging', '--format', 'all', '--clips-only'])
    expect(o.promptId).toBe('general')
    expect(o.envName).toBe('staging')
    expect(o.formats).toEqual(FORMAT_KEYS)
    expect(o.clipsOnly).toBe(true)
    expect(o.withPrompt).toBe(false) // prompt text is opt-in
  })
  it('prompt mode with --with-prompt', () => {
    expect(parseArgs(['--prompt', 'p', '--with-prompt']).withPrompt).toBe(true)
  })
  it('rejects --with-prompt in file mode', () => {
    expect(() => parseArgs(['x.wav', '--with-prompt'])).toThrow(/only apply to --prompt mode/)
  })
  it('rejects mixing file and prompt mode', () => {
    expect(() => parseArgs(['x.wav', '--prompt', 'p'])).toThrow(/not both/)
  })
  it('rejects prompt-only flags in file mode', () => {
    expect(() => parseArgs(['x.wav', '--segment-only'])).toThrow(/only apply to --prompt mode/)
  })
  it('keeps an explicit --title', () => {
    expect(parseArgs(['x.wav', '--title', 'Big Night']).title).toBe('Big Night')
  })
  it('rejects --segment-only with --clips-only', () => {
    expect(() => parseArgs(['--prompt', 'p', '--segment-only', '--clips-only'])).toThrow(/mutually exclusive/)
  })
  it('rejects flags missing values and unknown flags', () => {
    expect(() => parseArgs(['x.wav', '--title'])).toThrow(/needs a value/)
    expect(() => parseArgs(['x.wav', '--title', '--name', 'n'])).toThrow(/needs a value/)
    expect(() => parseArgs(['x.wav', '--wat'])).toThrow(/unknown flag/)
  })
  it('rejects empty argv with usage', () => {
    expect(() => parseArgs([])).toThrow(/usage:/)
  })
})
