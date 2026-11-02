import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL, MODELS, RAW_SRT, wavArgs, whisperArgs } from '../../scripts/lib/whisper.mjs'

// Whisper argv builders shared by the laptop CLI and node0's drafter — the
// two must produce the same draft from the same clip, so the argv is the
// contract. No ffmpeg or uvx is spawned here.

describe('wavArgs', () => {
  it('decodes to 16 kHz mono 16-bit PCM', () => {
    expect(wavArgs('in.webm', 'out.wav')).toEqual(
      ['-i', 'in.webm', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', 'out.wav'])
  })

  it('leaves the -hide_banner/-nostdin/-y prefix to the caller', () => {
    const args = wavArgs('a', 'b')
    expect(args[0]).toBe('-i')
    expect(args).not.toContain('-y')
    expect(args).not.toContain('-hide_banner')
    expect(args).not.toContain('-nostdin')
  })

  it('passes paths through verbatim (argv, not a shell string)', () => {
    const src = '/tmp/clips/a clip; rm -rf.webm'
    const dest = "/tmp/out/it's.wav"
    const args = wavArgs(src, dest)
    expect(args[1]).toBe(src)
    expect(args.at(-1)).toBe(dest)
  })
})

describe('whisperArgs', () => {
  it('runs mlx-whisper via uvx with the default model, writing raw.srt', () => {
    expect(whisperArgs('clip.wav', '/out')).toEqual([
      '--from', 'mlx-whisper', 'mlx_whisper', 'clip.wav',
      '--model', `mlx-community/whisper-${DEFAULT_MODEL}-mlx`,
      '--output-dir', '/out', '--output-name', 'raw', '--output-format', 'srt',
    ])
  })

  it('defaults to the small model', () => {
    expect(DEFAULT_MODEL).toBe('small')
    expect(MODELS).toContain(DEFAULT_MODEL)
  })

  it('maps every known model to its mlx-community repo', () => {
    for (const m of MODELS) {
      const args = whisperArgs('c.wav', 'o', m)
      expect(args[args.indexOf('--model') + 1]).toBe(`mlx-community/whisper-${m}-mlx`)
    }
  })

  it('rejects an unknown model rather than building a bad repo id', () => {
    expect(() => whisperArgs('c.wav', 'o', 'huge')).toThrow(/unknown whisper model: huge/)
    expect(() => whisperArgs('c.wav', 'o', '')).toThrow(/unknown whisper model/)
  })

  it('output name + format agree with RAW_SRT', () => {
    const args = whisperArgs('c.wav', 'o')
    const name = args[args.indexOf('--output-name') + 1]
    const fmt = args[args.indexOf('--output-format') + 1]
    expect(`${name}.${fmt}`).toBe(RAW_SRT)
  })
})
