import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildFiltergraph, buildRenderArgs, COLORS, escapeHtml, FORMAT_KEYS, FORMATS,
  instantiateTemplate, mergeManifest, parseArgs, plannedRenderPaths, resolveFormats,
  safeName, selectClips, WAVE_SRC_W,
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
  it('COLORS.wavePeak is --brand-tint-fg', () => expect(hex(COLORS.wavePeak)).toBe(token('--brand-tint-fg')))

  it('the ramp runs dark to bright in every channel', () => {
    // The direction is the whole idea: a bar at rest must be darker than a bar
    // at full travel, or height stops reading as loudness.
    const ch = (c) => [1, 3, 5].map((i) => parseInt(c.replace(/^0x/, '').slice(i - 1, i + 1), 16))
    const base = ch(COLORS.waveBase)
    const peak = ch(COLORS.wavePeak)
    base.forEach((v, i) => expect(v).toBeLessThan(peak[i]))
  })

  it('the ramp base stays inside the brand red, not a neutral', () => {
    // Red dominant and clearly warm — a grey base is what this replaced.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(COLORS.waveBase.slice(i + 1, i + 3), 16))
    expect(r).toBeGreaterThan(g * 2)
    expect(r).toBeGreaterThan(b * 2)
  })
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
  it.each(FORMAT_KEYS)('%s wave width is an exact multiple of the wave source width', (key) => {
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
  it.each(FORMAT_KEYS)('%s wires the wave window geometry', (key) => {
    const { wave } = FORMATS[key]
    const g = buildFiltergraph(key)
    // Rendered double-height, lower half kept and flipped: bars grow from the
    // baseline, keeping the .speak-wave silhouette.
    expect(g).toContain(`s=${WAVE_SRC_W}x${wave.h * 2}`)
    expect(g).toContain(`crop=${WAVE_SRC_W}:${wave.h}:0:${wave.h},vflip`)
    expect(g).toContain(`scale=${wave.w}:${wave.h}:flags=neighbor`)
    expect(g).toContain(`overlay=${wave.x}:${wave.y}:shortest=1`)
    // Both composites blend in RGB — yuv blending rounds the base and the PNG
    // differently and re-introduces the grill-stripe artifact.
    expect(g.match(/overlay=[^;]*format=rgb(?![0-9])/g)).toHaveLength(2)
  })

  it('colors the wave by height rather than by column', () => {
    const g = buildFiltergraph('16x9')
    // An alpha mask over a ramp, not per-bar colors: showwaves takes one color
    // per channel and cannot vary with height.
    expect(g).toContain('alphamerge')
    expect(g).toContain('format=gray')
    // The ramp must reach alphamerge as rgba. On an alpha-less format the
    // filter yields NO frames and ffmpeg dies later with an internal error
    // that names neither the filter nor the format.
    expect(g).toMatch(/format=rgba\[ramp\];\[ramp\]\[mask\]alphamerge/)
    // The old fixed red band is gone — that is what looked parked while the
    // shape around it moved.
    expect(g).not.toContain('crop=2:')
    expect(g).not.toContain('colorkey')
  })

  it('escapes the commas inside the ramp expression', () => {
    // Unescaped, the filtergraph parser reads them as filter separators and
    // the render dies at ffmpeg with an opaque message.
    const g = buildFiltergraph('16x9')
    expect(g).toContain('min(1\\,max(0\\,')
    expect(g).not.toMatch(/min\(1,max/)
  })

  it.each(FORMAT_KEYS)('%s saturates the ramp partway up, not at the ceiling', (key) => {
    const { wave } = FORMATS[key]
    // Speech peaks rarely pass ~60% of the window, so a ramp reaching full
    // brightness only at the very top would never show it.
    expect(buildFiltergraph(key)).toContain(`/${Math.round(wave.h * 0.5)}))`)
  })

  it('gain and knee are tunable together', () => {
    // They interact: more gain means taller bars, which want a looser ramp.
    const g = buildFiltergraph('16x9', { gainDb: 14, rampKnee: 0.75 })
    expect(g).toContain('volume=14dB')
    expect(g).toContain(`/${Math.round(FORMATS['16x9'].wave.h * 0.75)}))`)
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


describe('--member (single clip vs whole round)', () => {
  const argv = (...a) => parseArgs(['--prompt', 'general', ...a])

  it('defaults to the whole round with no --member', () => {
    const o = argv()
    expect(o.members).toEqual([])
    expect(o.clipsOnly).toBe(false)
    expect(o.segmentOnly).toBe(false)
  })

  it('accepts repeats and comma lists', () => {
    expect(argv('--member', 'alice', '--member', 'bo,cass').members)
      .toEqual(['alice', 'bo', 'cass'])
  })

  it('implies --clips-only, because a one-clip segment IS the clip', () => {
    expect(argv('--member', 'alice').clipsOnly).toBe(true)
  })

  it('lets an explicit scope flag win, so a subset segment stays possible', () => {
    const o = argv('--member', 'alice', '--member', 'cass', '--segment-only')
    expect(o.segmentOnly).toBe(true)
    expect(o.clipsOnly).toBe(false)
  })

  it('is refused in file mode', () => {
    expect(() => parseArgs(['clip.wav', '--member', 'alice'])).toThrow(/only apply to --prompt mode/)
  })

  it('needs a value', () => {
    expect(() => argv('--member', '--format')).toThrow(/needs a value/)
  })
})

describe('selectClips', () => {
  const clips = [
    { key: 'voice:general:alice', memberId: 'alice' },
    { key: 'voice:general:bo', memberId: 'bo' },
    { key: 'voice:general:cass', memberId: 'cass' },
  ]

  it('matches a memberId or a full KV key', () => {
    const { selected, missing } = selectClips(clips, ['bo', 'voice:general:alice'])
    expect(selected.map(c => c.memberId)).toEqual(['alice', 'bo'])
    expect(missing).toEqual([])
  })

  it('keeps submission order, not the order the flags were typed', () => {
    // A subset segment must still play in the order the round did.
    expect(selectClips(clips, ['cass', 'alice']).selected.map(c => c.memberId))
      .toEqual(['alice', 'cass'])
  })

  it('reports names that matched nothing instead of silently rendering fewer', () => {
    const { selected, missing } = selectClips(clips, ['alice', 'nobody'])
    expect(selected.map(c => c.memberId)).toEqual(['alice'])
    expect(missing).toEqual(['nobody'])
  })

  it('ignores blank entries', () => {
    expect(selectClips(clips, ['  bo  ', '']).selected.map(c => c.memberId)).toEqual(['bo'])
  })
})


describe('plannedRenderPaths', () => {
  it('enumerates every file a render would write', () => {
    expect(plannedRenderPaths('out/x', ['alice', 'segment'], ['16x9', '1x1'])).toEqual([
      'out/x/alice-16x9.mp4', 'out/x/alice-1x1.mp4',
      'out/x/segment-16x9.mp4', 'out/x/segment-1x1.mp4',
    ])
  })

  it('applies safeName, so the guard checks the paths actually written', () => {
    expect(plannedRenderPaths('out', ['mem alice!'], ['16x9']))
      .toEqual(['out/mem-alice-16x9.mp4'])
  })

  it('rejects an unknown format instead of planning a bogus path', () => {
    expect(() => plannedRenderPaths('out', ['a'], ['4x3'])).toThrow(/unknown format/)
  })
})

describe('--force', () => {
  it('is off by default in both modes', () => {
    expect(parseArgs(['clip.wav']).force).toBe(false)
    expect(parseArgs(['--prompt', 'general']).force).toBe(false)
  })

  it('is accepted in both modes', () => {
    expect(parseArgs(['clip.wav', '--force']).force).toBe(true)
    expect(parseArgs(['--prompt', 'general', '--force']).force).toBe(true)
  })
})


describe('mergeManifest', () => {
  const clip = (over = {}) => ({
    order: 1, key: 'voice:g:alice', memberId: 'alice', name: 'Alice',
    at: '2026-08-01T00:00:00.000Z', seconds: 60, files: { '16x9': 'a-16x9.mp4' },
    ...over,
  })
  const run = (over = {}) => ({
    promptId: 'g', env: 'production', generatedAt: '2026-08-02T00:00:00.000Z',
    formats: ['16x9'], clips: [clip()], segment: null, ...over,
  })

  it('records the run even when there is nothing to merge with', () => {
    expect(mergeManifest(null, run()).runs).toEqual([
      { generatedAt: '2026-08-02T00:00:00.000Z', formats: ['16x9'] },
    ])
  })

  it('unions formats and per-clip files across runs', () => {
    const first = mergeManifest(null, run())
    const second = mergeManifest(first, run({
      generatedAt: '2026-08-03T00:00:00.000Z',
      formats: ['1x1'],
      clips: [clip({ files: { '1x1': 'a-1x1.mp4' } })],
    }))
    expect(second.formats).toEqual(['16x9', '1x1'])
    expect(second.clips[0].files).toEqual({ '16x9': 'a-16x9.mp4', '1x1': 'a-1x1.mp4' })
    expect(second.runs).toHaveLength(2)
  })

  it('adds clips from a later narrowed run without dropping earlier ones', () => {
    const first = mergeManifest(null, run())
    const second = mergeManifest(first, run({
      members: ['bo'],
      clips: [clip({ key: 'voice:g:bo', memberId: 'bo', name: 'Bo',
                     at: '2026-08-01T01:00:00.000Z', files: { '16x9': 'b-16x9.mp4' } })],
    }))
    expect(second.clips.map(c => c.memberId)).toEqual(['alice', 'bo'])
    // Renumbered by submission order, not by the order the runs happened.
    expect(second.clips.map(c => c.order)).toEqual([1, 2])
    expect(second.runs[1].members).toEqual(['bo'])
  })

  it('never lets a null segment erase a real one', () => {
    const withSeg = mergeManifest(null, run({ segment: { files: { '16x9': 's.mp4' } } }))
    expect(mergeManifest(withSeg, run({ segment: null })).segment)
      .toEqual({ files: { '16x9': 's.mp4' } })
  })

  it('keeps the renders of a clip that has since aged out', () => {
    // The audio is gone from R2, but the MP4 made last week is still on disk.
    const first = mergeManifest(null, run())
    const second = mergeManifest(first, run({
      clips: [{ order: 1, key: 'voice:g:alice', memberId: 'alice', name: 'Alice',
                at: '2026-08-01T00:00:00.000Z', seconds: null, skipped: 'expired' }],
    }))
    expect(second.clips[0].files).toEqual({ '16x9': 'a-16x9.mp4' })
    expect(second.clips[0].skipped).toBe('expired')
    expect(second.clips[0].seconds).toBe(60)
  })

  it('tolerates a manifest that is not an object', () => {
    expect(mergeManifest([], run()).clips).toHaveLength(1)
  })
})

describe('--no-keep-audio', () => {
  it('keeps pulled source audio by default', () => {
    expect(parseArgs(['--prompt', 'g']).keepAudio).toBe(true)
  })
  it('opts out', () => {
    expect(parseArgs(['--prompt', 'g', '--no-keep-audio']).keepAudio).toBe(false)
  })
})
