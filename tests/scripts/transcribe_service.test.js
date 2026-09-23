// node0's caption drafter (scripts/transcribe_service.mjs): the parts that
// decide WHO it listens to and WHERE it sends its token. Everything here
// returns before ffmpeg or whisper would spawn.

import { afterEach, describe, expect, it } from 'vitest'
import {
  authorized, createHookServer, createQueue, createWorker, logfmt, ORIGINS, parseHook,
} from '../../scripts/transcribe_service.mjs'
import { MODELS, wavArgs, whisperArgs } from '../../scripts/lib/whisper.mjs'

describe('authorized', () => {
  it('accepts only the exact bearer', () => {
    expect(authorized('Bearer s3cret', 's3cret')).toBe(true)
    expect(authorized('Bearer s3cre', 's3cret')).toBe(false)
    expect(authorized('s3cret', 's3cret')).toBe(false)
    expect(authorized(undefined, 's3cret')).toBe(false)
  })

  it('fails closed with no token configured', () => {
    expect(authorized('Bearer ', '')).toBe(false)
    expect(authorized('Bearer undefined', undefined)).toBe(false)
  })
})

describe('parseHook', () => {
  it('takes a voice key and a known environment', () => {
    expect(parseHook('{"key":"voice:general:id-a","env":"production"}'))
      .toEqual({ key: 'voice:general:id-a', env: 'production' })
    expect(parseHook('{"key":"voice:msg_x:id-a","env":"staging"}'))
      .toEqual({ key: 'voice:msg_x:id-a', env: 'staging' })
  })

  it('never lets the caller choose where the token goes', () => {
    // An origin in the body is ignored; the env maps through ORIGINS only.
    const job = parseHook('{"key":"voice:general:a","env":"production","origin":"https://evil.example"}')
    expect(job).toEqual({ key: 'voice:general:a', env: 'production' })
    expect(parseHook('{"key":"voice:general:a","env":"https://evil.example"}')).toBeNull()
    expect(parseHook('{"key":"voice:general:a","env":"__proto__"}')).toBeNull()
    expect(ORIGINS.production).toBe('https://join.jxnfilm.club')
  })

  it('rejects anything that is not a voice row key', () => {
    expect(parseHook('{"key":"member:a@b.c","env":"production"}')).toBeNull()
    expect(parseHook('{"key":"voice:has space","env":"production"}')).toBeNull()
    expect(parseHook('not json')).toBeNull()
    expect(parseHook('null')).toBeNull()
  })
})

describe('createQueue', () => {
  it('drafts a clip nudged twice (submit + cron) only once', async () => {
    const seen = []
    let release
    const gate = new Promise(r => { release = r })
    const q = createQueue(async job => { seen.push(job.key); await gate; return { result: 'drafted' } })
    expect(q.push({ key: 'voice:a', env: 'production' })).toBe(true)
    expect(q.push({ key: 'voice:a', env: 'production' })).toBe(false)
    expect(q.push({ key: 'voice:a', env: 'staging' })).toBe(true)
    release()
    await q.idle()
    expect(seen).toEqual(['voice:a', 'voice:a'])
    // Done jobs can be queued again (a later replace of the same clip).
    expect(q.push({ key: 'voice:a', env: 'production' })).toBe(true)
    await q.idle()
  })

  it('an error in one job does not stop the queue', async () => {
    const q = createQueue(async job => { if (job.key === 'voice:bad') throw new Error('boom'); return { result: 'drafted' } })
    q.push({ key: 'voice:bad', env: 'production' })
    q.push({ key: 'voice:good', env: 'production' })
    await q.idle()
    expect(q.status().last).toMatchObject({ key: 'voice:good', result: 'drafted' })
  })
})

describe('createHookServer', () => {
  let server
  afterEach(() => server && new Promise(r => server.close(r)))

  async function start() {
    const pushed = []
    const queue = { push: job => { pushed.push(job); return true }, status: () => ({ queued: 0 }) }
    server = createHookServer({ token: 'tok', queue })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}`
    const hook = (body, auth = 'Bearer tok') => fetch(`${base}/hook`, {
      method: 'POST', headers: auth ? { Authorization: auth } : {}, body,
    })
    return { base, hook, pushed }
  }

  it('queues an authorized hook and answers 202 without waiting for whisper', async () => {
    const { hook, pushed } = await start()
    const res = await hook(JSON.stringify({ key: 'voice:general:a', env: 'production' }))
    expect(res.status).toBe(202)
    expect(pushed).toEqual([{ key: 'voice:general:a', env: 'production' }])
  })

  it('refuses a missing or wrong token before reading the body', async () => {
    const { hook, pushed } = await start()
    expect((await hook('{}', null)).status).toBe(401)
    expect((await hook('{}', 'Bearer nope')).status).toBe(401)
    expect(pushed).toEqual([])
  })

  it('rejects malformed and oversized bodies', async () => {
    const { hook } = await start()
    expect((await hook(JSON.stringify({ key: 'member:x', env: 'production' }))).status).toBe(400)
    const big = await hook('x'.repeat(10_000)).catch(() => null)
    // Either a 413, or the connection is dropped mid-upload — never a 202.
    if (big) expect(big.status).toBe(413)
  })

  it('health is open and reveals no clip content', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, queued: 0 })
  })
})

describe('createWorker', () => {
  const logs = []
  const log = f => logs.push(f)

  it('fetches only from the environment\'s own origin, with the token', async () => {
    const calls = []
    const fetchImpl = async (url, init) => { calls.push({ url, auth: init.headers.Authorization }); return new Response('', { status: 404 }) }
    const run = createWorker({ token: 'tok', log, fetchImpl })
    expect(await run({ key: 'voice:general:a', env: 'staging' })).toEqual({ result: 'gone' })
    expect(calls).toEqual([{
      url: 'https://join-staging.jxnfilm.club/transcriber/audio?key=voice%3Ageneral%3Aa',
      auth: 'Bearer tok',
    }])
  })

  it('skips (for the cron to retry) when the stream guard says wait', async () => {
    let fetched = false
    const run = createWorker({
      token: 'tok', log, deferScript: '/nonexistent/defer-if-streaming.sh',
      fetchImpl: async () => { fetched = true; return new Response('', { status: 404 }) },
    })
    expect(await run({ key: 'voice:general:a', env: 'production' })).toEqual({ result: 'deferred' })
    expect(fetched).toBe(false)
  })
})

describe('whisper args (shared with scripts/transcribe.mjs)', () => {
  it('decodes to 16 kHz mono PCM', () => {
    expect(wavArgs('in.webm', 'out.wav')).toEqual(['-i', 'in.webm', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', 'out.wav'])
  })

  it('writes raw.srt with the mlx-community model', () => {
    expect(whisperArgs('a.wav', '/tmp/x', 'small')).toEqual(['--from', 'mlx-whisper', 'mlx_whisper', 'a.wav',
      '--model', 'mlx-community/whisper-small-mlx', '--output-dir', '/tmp/x', '--output-name', 'raw', '--output-format', 'srt'])
    expect(MODELS).toContain('large-v3')
    expect(() => whisperArgs('a.wav', '/tmp/x', 'huge')).toThrow(/unknown whisper model/)
  })
})

describe('logfmt', () => {
  it('quotes values with spaces and drops empties', () => {
    expect(logfmt({ event: 'error', detail: 'a "b" c', none: null })).toBe('event=error detail="a \\"b\\" c"')
  })
})
