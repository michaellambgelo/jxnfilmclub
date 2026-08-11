import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Member voice clips (podcast submissions from /speak).
//
// Contract under test: POST /voice stores raw audio bytes in the VOICE R2
// bucket at voice/{promptId}/{memberId}.{ext} and a metadata row at
// voice:{promptId}:{memberId} in MEMBERS_KV with a 60-day TTL mirroring the
// bucket-wide R2 lifecycle rule. Consent (X-Voice-Consent: yes) is mandatory,
// the content-type allowlist is PREFIX-matched (browsers send
// 'audio/webm;codecs=opus'), one clip per member per prompt (resubmit
// replaces), and admin status rewrites carry the row's absolute expiry so
// moderation never resets the retention clock.

// --- Test plumbing ---

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

function req(path, { method = 'GET', body, token, headers = {} } = {}) {
  return SELF.fetch(`https://join.jxnfilm.club${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function seedMember(email, overrides = {}) {
  const member = {
    id: 'id-' + email, email, name: 'M-' + email.split('@')[0], handle: null,
    pronouns: null, newsletter: false, joined: '2026-01-01', ...overrides,
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  return member
}

// Issue a real bearer through the OTP verify path so handlers downstream see a
// valid `claims` (including the member's id, which the voice keys use).
async function getTokenFor(email, overrides = {}) {
  const member = await seedMember(email, overrides)
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await req('/otp/verify', { method: 'POST', body: { email, code: '111111' } })
  return { token: (await res.json()).token, member }
}

const WEBM_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])

// Pass `consent: null` to omit the header entirely (undefined would just
// re-trigger the destructuring default).
function postVoice(token, { bytes = WEBM_BYTES, type = 'audio/webm', consent = 'yes', duration } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (type != null) headers['Content-Type'] = type
  if (consent != null) headers['X-Voice-Consent'] = consent
  if (duration !== undefined) headers['X-Voice-Duration'] = String(duration)
  return SELF.fetch('https://join.jxnfilm.club/voice', { method: 'POST', headers, body: bytes })
}

// The single-cell submit throttle is per email; clear it so multi-post tests
// exercise the replace flow instead of the 429.
function clearThrottle(email) {
  return env.MEMBERS_KV.delete(`rate:voice_submit:${email}`)
}

async function listVoiceRows() {
  const list = await env.MEMBERS_KV.list({ prefix: 'voice:' })
  const rows = []
  for (const k of list.keys) {
    rows.push({ key: k, value: JSON.parse(await env.MEMBERS_KV.get(k.name)) })
  }
  return rows
}

const SIXTY_DAYS = 60 * 24 * 3600
const ADMIN = 'test-admin-token'

afterEach(() => { vi.restoreAllMocks() })

// --- Tests ---

describe('POST /voice', () => {
  it('happy path: bytes land in R2, KV row has the full shape + 60-day expiry', async () => {
    const { token, member } = await getTokenFor('speaker@example.com', { handle: 'speakerlb' })
    const res = await postVoice(token, { duration: 42 })
    expect(res.status).toBe(200)
    // Response is the safe projection of the row — no wrapper, no storage
    // internals (r2Key / memberId).
    const data = await res.json()
    expect(data.r2Key).toBeUndefined()
    expect(data.memberId).toBeUndefined()
    expect(data.status).toBe('pending')
    expect(data.size).toBe(WEBM_BYTES.byteLength)
    expect(data.promptId).toBe('general')
    expect(data.expiresAt).toEqual(expect.any(Number))

    // R2 object at the contracted key, byte-for-byte, with its content type.
    const r2Key = `voice/general/${member.id}.webm`
    const obj = await env.VOICE.get(r2Key)
    expect(obj).not.toBeNull()
    expect(new Uint8Array(await obj.arrayBuffer())).toEqual(WEBM_BYTES)
    expect(obj.httpMetadata?.contentType).toBe('audio/webm')

    // KV row: contracted shape, TTL on the key, absolute expiry in the value.
    const [rec] = await listVoiceRows()
    expect(rec.key.name).toBe(`voice:general:${member.id}`)
    const now = Math.floor(Date.now() / 1000)
    expect(rec.value).toEqual({
      memberId: member.id,
      name: member.name,
      handle: 'speakerlb',
      promptId: 'general',
      promptText: "Tell us what you're watching",
      r2Key,
      contentType: 'audio/webm',
      size: WEBM_BYTES.byteLength,
      duration: 42,
      consent: true,
      at: expect.any(String),
      expiresAt: expect.any(Number),
      status: 'pending',
    })
    expect(rec.value.expiresAt).toBeGreaterThan(now + SIXTY_DAYS - 120)
    expect(rec.value.expiresAt).toBeLessThanOrEqual(now + SIXTY_DAYS + 120)
    expect(rec.key.expiration).toBeGreaterThan(now + SIXTY_DAYS - 120)
    expect(rec.key.expiration).toBeLessThanOrEqual(now + SIXTY_DAYS + 120)
  })

  it('requires a session', async () => {
    const res = await postVoice(null)
    expect(res.status).toBe(401)
  })

  it('400 without consent — consent is not optional, voice is identity', async () => {
    const { token } = await getTokenFor('noconsent@example.com')
    expect((await postVoice(token, { consent: null })).status).toBe(400)
    expect((await postVoice(token, { consent: 'no' })).status).toBe(400)
    expect(await listVoiceRows()).toHaveLength(0)
    const list = await env.VOICE.list({ prefix: 'voice/' })
    expect(list.objects).toHaveLength(0)
  })

  it('413 over 8MB', async () => {
    const { token } = await getTokenFor('loud@example.com')
    const res = await postVoice(token, { bytes: new Uint8Array(8 * 1024 * 1024 + 1) })
    expect(res.status).toBe(413)
    expect(await listVoiceRows()).toHaveLength(0)
  })

  it('415 for a non-audio content type', async () => {
    const { token } = await getTokenFor('texter@example.com')
    const res = await postVoice(token, { type: 'text/plain' })
    expect(res.status).toBe(415)
    expect(await listVoiceRows()).toHaveLength(0)
  })

  it("accepts 'audio/webm;codecs=opus' — the allowlist is prefix-matched", async () => {
    const { token, member } = await getTokenFor('opus@example.com')
    const res = await postVoice(token, { type: 'audio/webm;codecs=opus' })
    expect(res.status).toBe(200)
    const obj = await env.VOICE.head(`voice/general/${member.id}.webm`)
    expect(obj).not.toBeNull()
    // The full declared type is preserved on the stored object and the row.
    expect(obj.httpMetadata?.contentType).toBe('audio/webm;codecs=opus')
    const [rec] = await listVoiceRows()
    expect(rec.value.contentType).toBe('audio/webm;codecs=opus')
  })

  it('replaces an existing clip — old R2 object deleted when the ext changes', async () => {
    const { token, member } = await getTokenFor('redo@example.com')
    expect((await postVoice(token, { type: 'audio/webm' })).status).toBe(200)
    const oldKey = `voice/general/${member.id}.webm`
    expect(await env.VOICE.head(oldKey)).not.toBeNull()

    await clearThrottle('redo@example.com')
    const mp3 = new Uint8Array([0xff, 0xfb, 9, 9])
    expect((await postVoice(token, { type: 'audio/mpeg', bytes: mp3 })).status).toBe(200)

    // One clip per member per prompt: the webm orphan is gone, the mp3 is live.
    expect(await env.VOICE.head(oldKey)).toBeNull()
    const obj = await env.VOICE.get(`voice/general/${member.id}.mp3`)
    expect(new Uint8Array(await obj.arrayBuffer())).toEqual(mp3)

    const rows = await listVoiceRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].value.r2Key).toBe(`voice/general/${member.id}.mp3`)
    expect(rows[0].value.contentType).toBe('audio/mpeg')
  })

  it('throttles first submissions but never a replace of an existing clip', async () => {
    const { token } = await getTokenFor('eager@example.com')
    expect((await postVoice(token)).status).toBe(200)
    // Immediate second post is a REPLACE (row exists) — the Replace button
    // legitimately arrives seconds after the first submit, so no 429.
    expect((await postVoice(token)).status).toBe(200)
    expect(await listVoiceRows()).toHaveLength(1)
    // After deleting the clip the next post is a first submission again, and
    // the still-warm throttle cell applies.
    expect((await req('/voice', { method: 'DELETE', token })).status).toBe(200)
    expect((await postVoice(token)).status).toBe(429)
    expect(await listVoiceRows()).toHaveLength(0)
  })
})

describe('GET /voice/mine', () => {
  it('default prompt + null clip when nothing is configured or submitted', async () => {
    const { token } = await getTokenFor('fresh@example.com')
    const res = await req('/voice/mine', { token })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      prompt: { id: 'general', text: "Tell us what you're watching" },
      clip: null,
    })
  })

  it('requires a session', async () => {
    expect((await req('/voice/mine')).status).toBe(401)
  })

  it('round-trips a clip under a configured prompt (config:voice_prompt)', async () => {
    const prompt = { id: 'aug-2026', text: 'Best theater snack?', deadline: '2026-08-31' }
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify(prompt))
    const { token, member } = await getTokenFor('prompted@example.com')
    expect((await postVoice(token)).status).toBe(200)

    const data = await (await req('/voice/mine', { token })).json()
    expect(data.prompt).toEqual(prompt)
    // The clip is the caller's full row (nothing in it is secret to its owner).
    expect(data.clip.memberId).toBe(member.id)
    expect(data.clip.promptId).toBe('aug-2026')
    expect(data.clip.promptText).toBe('Best theater snack?')
    expect(data.clip.r2Key).toBe(`voice/aug-2026/${member.id}.webm`)
    expect(data.clip.status).toBe('pending')
    // And the storage keys are prompt-scoped as contracted.
    expect(await env.VOICE.head(`voice/aug-2026/${member.id}.webm`)).not.toBeNull()
    expect(await env.MEMBERS_KV.get(`voice:aug-2026:${member.id}`)).not.toBeNull()
  })

  it('malformed config:voice_prompt falls back to the default prompt', async () => {
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify({ id: '', text: '' }))
    const { token } = await getTokenFor('fallback@example.com')
    const data = await (await req('/voice/mine', { token })).json()
    expect(data.prompt).toEqual({ id: 'general', text: "Tell us what you're watching" })
  })
})

describe('DELETE /voice', () => {
  it('removes both the R2 object and the KV row', async () => {
    const { token, member } = await getTokenFor('regret@example.com')
    expect((await postVoice(token)).status).toBe(200)

    const res = await req('/voice', { method: 'DELETE', token })
    expect(res.status).toBe(200)
    expect(await env.VOICE.head(`voice/general/${member.id}.webm`)).toBeNull()
    expect(await env.MEMBERS_KV.get(`voice:general:${member.id}`)).toBeNull()

    // Idempotent: deleting again (nothing left) is still 200.
    expect((await req('/voice', { method: 'DELETE', token })).status).toBe(200)
  })

  it('requires a session', async () => {
    expect((await req('/voice', { method: 'DELETE' })).status).toBe(401)
  })
})

describe('admin moderation', () => {
  it('GET /admin/voice lists every row with its KV key; wrong token 401', async () => {
    const a = await getTokenFor('a@example.com')
    expect((await postVoice(a.token)).status).toBe(200)
    const b = await getTokenFor('b@example.com')
    expect((await postVoice(b.token)).status).toBe(200)

    expect((await req('/admin/voice')).status).toBe(401)
    expect((await req('/admin/voice', { token: 'wrong' })).status).toBe(401)

    const res = await req('/admin/voice', { token: ADMIN })
    expect(res.status).toBe(200)
    const { clips } = await res.json()
    expect(clips).toHaveLength(2)
    const keys = clips.map(c => c.key).sort()
    expect(keys).toEqual([
      `voice:general:${a.member.id}`,
      `voice:general:${b.member.id}`,
    ].sort())
    for (const c of clips) {
      expect(c.r2Key).toMatch(/^voice\/general\/.+\.webm$/)
      expect(c.status).toBe('pending')
      expect(c.expiresAt).toEqual(expect.any(Number))
    }
  })

  it('POST /admin/voice/status rewrites the row WITHOUT resetting its expiry', async () => {
    const { token, member } = await getTokenFor('moderated@example.com')
    expect((await postVoice(token)).status).toBe(200)
    const [before] = await listVoiceRows()

    const res = await req('/admin/voice/status', {
      method: 'POST', token: ADMIN,
      body: { key: `voice:general:${member.id}`, status: 'approved' },
    })
    expect(res.status).toBe(200)

    const [after] = await listVoiceRows()
    expect(after.value.status).toBe('approved')
    // The rewrite carried the original absolute expiry — a bare put() would
    // reset the TTL and break the 60-day retention mirror.
    expect(after.value.expiresAt).toBe(before.value.expiresAt)
    expect(after.key.expiration).toBe(before.value.expiresAt)
    // Everything else on the row is untouched.
    expect({ ...after.value, status: 'pending' }).toEqual(before.value)
  })

  it('status endpoint validates input and auth', async () => {
    const { member } = await getTokenFor('victim@example.com')
    const key = `voice:general:${member.id}`
    expect((await req('/admin/voice/status', { method: 'POST', body: { key, status: 'approved' } })).status).toBe(401)
    expect((await req('/admin/voice/status', { method: 'POST', token: ADMIN, body: { key, status: 'famous' } })).status).toBe(400)
    expect((await req('/admin/voice/status', { method: 'POST', token: ADMIN, body: { key: 'member:x', status: 'approved' } })).status).toBe(400)
    expect((await req('/admin/voice/status', { method: 'POST', token: ADMIN, body: { key, status: 'approved' } })).status).toBe(404)
  })

  it('DELETE /admin/voice removes the row and its R2 object; idempotent', async () => {
    const { token, member } = await getTokenFor('removed@example.com')
    expect((await postVoice(token)).status).toBe(200)
    const key = `voice:general:${member.id}`

    expect((await req('/admin/voice', { method: 'DELETE', body: { key } })).status).toBe(401)
    const res = await req('/admin/voice', { method: 'DELETE', token: ADMIN, body: { key } })
    expect(res.status).toBe(200)
    expect(await env.MEMBERS_KV.get(key)).toBeNull()
    expect(await env.VOICE.head(`voice/general/${member.id}.webm`)).toBeNull()

    // Already gone → still 200.
    expect((await req('/admin/voice', { method: 'DELETE', token: ADMIN, body: { key } })).status).toBe(200)
  })
})

describe('member delete purges voice clips', () => {
  it('deletes the member’s rows + R2 objects across prompts, leaves others', async () => {
    // Two prompts' worth of clips for the doomed member.
    const doomed = await getTokenFor('doomed@example.com')
    expect((await postVoice(doomed.token)).status).toBe(200)
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify({ id: 'p2', text: 'Second prompt' }))
    await clearThrottle('doomed@example.com')
    expect((await postVoice(doomed.token)).status).toBe(200)
    await env.MEMBERS_KV.delete('config:voice_prompt')

    const bystander = await getTokenFor('bystander@example.com')
    expect((await postVoice(bystander.token)).status).toBe(200)

    mockFetch(async () => new Response('', { status: 204 }))
    const res = await req('/member/delete', { method: 'POST', token: doomed.token, body: {} })
    expect(res.status).toBe(200)

    // Voice is identity: the doomed member's clips are gone on both sides.
    expect(await env.MEMBERS_KV.get(`voice:general:${doomed.member.id}`)).toBeNull()
    expect(await env.MEMBERS_KV.get(`voice:p2:${doomed.member.id}`)).toBeNull()
    expect(await env.VOICE.head(`voice/general/${doomed.member.id}.webm`)).toBeNull()
    expect(await env.VOICE.head(`voice/p2/${doomed.member.id}.webm`)).toBeNull()

    // The bystander's clip is untouched.
    expect(await env.MEMBERS_KV.get(`voice:general:${bystander.member.id}`)).not.toBeNull()
    expect(await env.VOICE.head(`voice/general/${bystander.member.id}.webm`)).not.toBeNull()
  })
})
