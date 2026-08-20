// Pure-ish helpers in scripts/lib/voices.mjs — the output-safety and download
// -idempotency guarantees. Everything exercised here returns BEFORE any
// subprocess would spawn, so no wrangler, ffmpeg or network is involved.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAbsolute, resolve } from 'node:path'
import {
  archivePathFor, ensureWritable, isCompleteCopy, looksMissing, pullClip, r2GetArgs,
} from '../../scripts/lib/voices.mjs'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jxnfc-voices-test-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const write = (path, bytes) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes))
  return path
}

describe('ensureWritable', () => {
  it('passes when nothing is in the way', () => {
    expect(ensureWritable([join(dir, 'nope.mp4')])).toEqual([])
  })

  it('refuses rather than overwriting, and names the conflicts', () => {
    const existing = write(join(dir, 'alice-16x9.mp4'), 10)
    expect(() => ensureWritable([existing, join(dir, 'bo-16x9.mp4')]))
      .toThrow(/refusing to overwrite 1 existing output file/)
    expect(() => ensureWritable([existing])).toThrow(/alice-16x9\.mp4/)
    // …and the file is still there. Refusing is not deleting.
    expect(existsSync(existing)).toBe(true)
  })

  it('caps the list but says how many more there are', () => {
    const many = Array.from({ length: 12 }, (_, i) => write(join(dir, `c${i}.mp4`), 1))
    expect(() => ensureWritable(many)).toThrow(/and 4 more/)
  })

  it('only yields to an explicit force', () => {
    const existing = write(join(dir, 'alice-16x9.mp4'), 10)
    expect(ensureWritable([existing], { force: true })).toEqual([])
  })
})

describe('archivePathFor', () => {
  it('is keyed by member id and keeps the object extension', () => {
    expect(archivePathFor('out', 'general', { memberId: 'alice', r2Key: 'voice/general/alice.webm' }))
      .toBe(join('out', 'archive', 'general', 'alice.webm'))
  })

  it('falls back to .bin when the key has no extension', () => {
    expect(archivePathFor('out', 'g', { memberId: 'a', r2Key: 'voice/g/a' }))
      .toBe(join('out', 'archive', 'g', 'a.bin'))
  })
})

describe('isCompleteCopy', () => {
  it('is true only for an exact byte match', () => {
    const p = write(join(dir, 'a.webm'), 128)
    expect(isCompleteCopy(p, 128)).toBe(true)
    expect(isCompleteCopy(p, 127)).toBe(false)
    expect(isCompleteCopy(join(dir, 'missing.webm'), 128)).toBe(false)
  })

  it('refuses to claim completeness with no expected size', () => {
    // The KV row's `size` is the only integrity signal wrangler leaves us —
    // without it we must re-download rather than trust whatever is on disk.
    const p = write(join(dir, 'a.webm'), 128)
    expect(isCompleteCopy(p, null)).toBe(false)
    expect(isCompleteCopy(p, 0)).toBe(false)
  })
})

describe('pullClip idempotency', () => {
  // Both paths below return before wrangler would be spawned, so reaching a
  // subprocess at all is the failure these assert against.
  const clip = { memberId: 'alice', r2Key: 'voice/general/alice.webm', size: 64 }

  it('makes no request when the destination is already complete', () => {
    const dest = write(join(dir, 'raw-0.webm'), 64)
    expect(pullClip(clip, 'production', dest)).toEqual({ source: 'cache', bytes: 64 })
  })

  it('copies from an archived clip instead of re-downloading', () => {
    const archived = write(join(dir, 'archive', 'general', 'alice.webm'), 64)
    const dest = join(dir, 'raw-0.webm')
    expect(pullClip(clip, 'production', dest, { reuseFrom: archived }))
      .toEqual({ source: 'archive', bytes: 64 })
    expect(isCompleteCopy(dest, 64)).toBe(true)
  })

  it('does not trust a truncated archive', () => {
    // Half a download from an interrupted run must not masquerade as a clip.
    const archived = write(join(dir, 'archive', 'general', 'alice.webm'), 3)
    // No stub for wrangler here, so a real attempt would throw — which is the
    // point: it must NOT take the reuse shortcut.
    expect(() => pullClip(clip, 'production', join(dir, 'raw-0.webm'), { reuseFrom: archived }))
      .toThrow()
  })
})


describe('r2GetArgs', () => {
  // Regression: wrangler runs with cwd = worker/ so the MEMBERS_KV binding
  // resolves, but Node resolves the same relative string against the repo
  // root. A relative --file therefore downloaded to worker/out/... while the
  // rename looked in out/... and failed with ENOENT — which the caller then
  // reported as "likely expired (60-day lifecycle)".
  it('always hands wrangler an ABSOLUTE --file path', () => {
    const args = r2GetArgs('jxnfilm-voice', 'voice/g/a.webm', 'out/archive/g/a.webm.part')
    const file = args[args.indexOf('--file') + 1]
    expect(isAbsolute(file)).toBe(true)
    expect(file).toBe(resolve('out/archive/g/a.webm.part'))
  })

  it('leaves an already-absolute path alone', () => {
    const abs = '/tmp/jxnfc/a.webm.part'
    expect(r2GetArgs('b', 'k', abs)).toContain(abs)
  })

  it('targets the right bucket and stays remote', () => {
    // --remote is not optional: wrangler v4 defaults R2 ops to the local
    // simulator and would "succeed" against nothing.
    const args = r2GetArgs('jxnfilm-voice-staging', 'voice/g/a.webm', '/tmp/x')
    expect(args).toContain('jxnfilm-voice-staging/voice/g/a.webm')
    expect(args).toContain('--remote')
  })
})

describe('looksMissing', () => {
  it('recognises a real R2 miss', () => {
    expect(looksMissing(new Error('The specified key does not exist.'))).toBe(true)
    expect(looksMissing(new Error('NoSuchKey'))).toBe(true)
    expect(looksMissing('404 Not Found')).toBe(true)
  })

  it('does NOT excuse a local failure as an expired clip', () => {
    // The exact shape that got misreported as expiry.
    expect(looksMissing(new Error("ENOENT: no such file or directory, rename 'a.part' -> 'a'")))
      .toBe(false)
    expect(looksMissing(new Error('401 Unauthorized'))).toBe(false)
    expect(looksMissing(null)).toBe(false)
  })
})
