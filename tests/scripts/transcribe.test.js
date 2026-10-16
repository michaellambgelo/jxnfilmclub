import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// scripts/transcribe.mjs is a top-level CLI. Its argument parsing and
// validation run before anything touches ffmpeg, whisper, wrangler or R2, so
// every rejection branch can be exercised by spawning it with bad arguments —
// no external tools needed. The happy path (which shells out) is not run here.

const SCRIPT = fileURLToPath(new URL('../../scripts/transcribe.mjs', import.meta.url))

const cli = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000 })
  return { status: r.status, err: r.stderr }
}

describe('scripts/transcribe.mjs argument validation', () => {
  it('no arguments prints usage and exits 1', () => {
    const r = cli()
    expect(r.status).toBe(1)
    expect(r.err).toMatch(/^error: usage:/)
  })

  it.each([
    [['--prompt'], /--prompt needs a value/],
    [['--prompt', '--force'], /--prompt needs a value/],
    [['--member'], /--member needs a value/],
    [['--bogus'], /unknown flag: --bogus/],
    [['a.wav', 'b.wav'], /unexpected argument: b\.wav/],
    [['a.wav', '--prompt', 'p1'], /either an audio file or --prompt, not both/],
    [['a.wav', '--model', 'huge'], /--model must be one of .* \(got: huge\)/],
    [['--prompt', 'p1', '--env', 'dev'], /--env must be production or staging \(got: dev\)/],
    [['a.wav', '--member', 'm1'], /--member\/--upload\/--pull only apply to --prompt mode/],
    [['a.wav', '--upload'], /only apply to --prompt mode/],
    [['a.wav', '--pull'], /only apply to --prompt mode/],
    [['--prompt', 'p1', '--pull', '--upload'], /--pull and --upload are opposite directions/],
    [['--prompt', 'p1', '--pull', '--upload-only'], /--pull and --upload are opposite directions/],
    [['--prompt', 'p1', '--no-upload', '--upload'], /--no-upload contradicts/],
    [['--prompt', 'p1', '--no-upload', '--pull'], /--no-upload contradicts/],
  ])('rejects %j', (args, message) => {
    const r = cli(...args)
    expect(r.status).toBe(1)
    expect(r.err).toMatch(message)
  })
})
