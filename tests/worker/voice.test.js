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
function postVoice(token, { bytes = WEBM_BYTES, type = 'audio/webm', consent = 'yes', duration, kind, subject, note, promptId } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (type != null) headers['Content-Type'] = type
  if (consent != null) headers['X-Voice-Consent'] = consent
  if (duration !== undefined) headers['X-Voice-Duration'] = String(duration)
  // Free-form-message metadata rides in query params, never headers: fetch()
  // throws on a non-Latin1 header value, so a subject with a curly apostrophe
  // would fail in the browser before the request left.
  const qs = new URLSearchParams()
  if (kind !== undefined) qs.set('kind', kind)
  if (subject !== undefined) qs.set('subject', subject)
  if (note !== undefined) qs.set('note', note)
  if (promptId !== undefined) qs.set('promptId', promptId)
  const url = 'https://join.jxnfilm.club/voice' + (qs.toString() ? `?${qs}` : '')
  return SELF.fetch(url, { method: 'POST', headers, body: bytes })
}

// A message: same call, with the mode and a subject.
function postMessage(token, opts = {}) {
  return postVoice(token, { kind: 'message', subject: 'The ending of Nope', ...opts })
}

function clearMsgThrottle(email) {
  return env.MEMBERS_KV.delete(`rate:voice_msg:${email}`)
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
    expect(data.clip.promptId).toBe('aug-2026')
    expect(data.clip.promptText).toBe('Best theater snack?')
    expect(data.clip.status).toBe('pending')
    // Storage internals are asserted against storage, not against what the
    // member-facing endpoint hands back — that response is a whitelist.
    expect(data.clip.r2Key).toBeUndefined()
    const stored = await env.MEMBERS_KV.get(`voice:aug-2026:${member.id}`, { type: 'json' })
    expect(stored.r2Key).toBe(`voice/aug-2026/${member.id}.webm`)
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

  it('?promptId= deletes that prompt\'s clip and leaves the current one', async () => {
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify({ id: 'old-round', text: 'Old?' }))
    const { token, member } = await getTokenFor('curator@example.com')
    expect((await postVoice(token)).status).toBe(200)
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify({ id: 'new-round', text: 'New?' }))
    await clearThrottle('curator@example.com')
    expect((await postVoice(token)).status).toBe(200)

    const res = await req('/voice?promptId=old-round', { method: 'DELETE', token })
    expect(res.status).toBe(200)
    expect(await env.MEMBERS_KV.get(`voice:old-round:${member.id}`)).toBeNull()
    expect(await env.VOICE.head(`voice/old-round/${member.id}.webm`)).toBeNull()
    expect(await env.MEMBERS_KV.get(`voice:new-round:${member.id}`)).not.toBeNull()
    expect(await env.VOICE.head(`voice/new-round/${member.id}.webm`)).not.toBeNull()
  })

  it('rejects a promptId outside the slug shape — it feeds the KV key', async () => {
    const { token } = await getTokenFor('crafty@example.com')
    const res = await req('/voice?promptId=general%3Aother-id', { method: 'DELETE', token })
    expect(res.status).toBe(400)
  })
})

describe('GET /voice/history', () => {
  it("lists only the caller's clips, current prompt pinned first", async () => {
    // Rival submits under the current prompt — must never surface for the caller.
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify({ id: 'round-1', text: 'One?' }))
    const rival = await getTokenFor('rival@example.com')
    expect((await postVoice(rival.token)).status).toBe(200)

    // Caller submits under round-1, then round-2, then round-1 becomes
    // current again — the round-1 row must be pinned first despite being older.
    const { token, member } = await getTokenFor('historian@example.com')
    expect((await postVoice(token)).status).toBe(200)
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify({ id: 'round-2', text: 'Two?' }))
    await clearThrottle('historian@example.com')
    expect((await postVoice(token)).status).toBe(200)
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify({ id: 'round-1', text: 'One?' }))

    const data = await (await req('/voice/history', { token })).json()
    expect(data.currentPromptId).toBe('round-1')
    expect(data.clips.map(c => c.promptId)).toEqual(['round-1', 'round-2'])
    // Projection only — no storage internals, and nothing of the rival's.
    for (const c of data.clips) {
      expect(c.r2Key).toBeUndefined()
      expect(c.memberId).toBeUndefined()
    }
    expect(member.id).not.toBe(rival.member.id)
  })

  it('empty history is an empty list, and a session is required', async () => {
    const { token } = await getTokenFor('lurker@example.com')
    const data = await (await req('/voice/history', { token })).json()
    expect(data).toEqual({ currentPromptId: 'general', clips: [] })
    expect((await req('/voice/history')).status).toBe(401)
  })
})

describe('GET /voice/audio', () => {
  it("streams the caller's own bytes with the stored content type", async () => {
    const { token } = await getTokenFor('listener@example.com')
    expect((await postVoice(token)).status).toBe(200)
    const res = await req('/voice/audio?promptId=general', { token })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('audio/webm')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEBM_BYTES)
  })

  it('404 when no clip exists for the prompt', async () => {
    const { token } = await getTokenFor('empty@example.com')
    expect((await req('/voice/audio?promptId=general', { token })).status).toBe(404)
  })

  it('404 (not 500) when the KV row outlives the lifecycle-deleted R2 object', async () => {
    const { token, member } = await getTokenFor('expired@example.com')
    expect((await postVoice(token)).status).toBe(200)
    await env.VOICE.delete(`voice/general/${member.id}.webm`)
    expect((await req('/voice/audio?promptId=general', { token })).status).toBe(404)
  })

  it('validates promptId and auth', async () => {
    const { token } = await getTokenFor('strict@example.com')
    expect((await req('/voice/audio', { token })).status).toBe(400)
    expect((await req('/voice/audio?promptId=a%3Ab', { token })).status).toBe(400)
    expect((await req('/voice/audio?promptId=general')).status).toBe(401)
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

// Approval and publication are different facts. A clip can sit approved for
// weeks before its episode airs, so the member UI has to be able to say
// "we're using this" without claiming "this is out in the world".
describe('published rounds', () => {
  const publish = (promptId, published, token = ADMIN) =>
    req('/admin/voice/publish', { method: 'POST', token, body: { promptId, published } })

  it('nothing is published until an admin says so', async () => {
    const { token } = await getTokenFor('unpub@example.com')
    expect((await postVoice(token)).status).toBe(200)

    const mine = await (await req('/voice/mine', { token })).json()
    expect(mine.clip.published).toBe(false)
    const hist = await (await req('/voice/history', { token })).json()
    expect(hist.clips[0].published).toBe(false)
  })

  it('publishing a round flips it for every member in that round', async () => {
    const a = await getTokenFor('a-pub@example.com')
    const b = await getTokenFor('b-pub@example.com')
    expect((await postVoice(a.token)).status).toBe(200)
    expect((await postVoice(b.token)).status).toBe(200)

    const res = await publish('general', true)
    expect(res.status).toBe(200)
    expect((await res.json()).promptIds).toEqual(['general'])

    for (const who of [a, b]) {
      const mine = await (await req('/voice/mine', { token: who.token })).json()
      expect(mine.clip.published).toBe(true)
    }
  })

  it('unpublishing is possible — an episode can be pulled', async () => {
    const { token } = await getTokenFor('unpub2@example.com')
    expect((await postVoice(token)).status).toBe(200)
    await publish('general', true)
    expect((await publish('general', false)).status).toBe(200)

    const mine = await (await req('/voice/mine', { token })).json()
    expect(mine.clip.published).toBe(false)
    expect(await env.MEMBERS_KV.get('config:voice_published', { type: 'json' }))
      .toEqual({ promptIds: [] })
  })

  it('only marks the round it was told to', async () => {
    const { token } = await getTokenFor('other-round@example.com')
    expect((await postVoice(token)).status).toBe(200)
    await publish('noir-november', true)

    const hist = await (await req('/voice/history', { token })).json()
    expect(hist.clips.every(c => c.published === false)).toBe(true)
  })

  it('survives the round it describes — config carries no expiry', async () => {
    // Clip rows die at 60 days; a member asking six months later still
    // deserves a truthful answer about whether that episode aired.
    await publish('general', true)
    const listed = await env.MEMBERS_KV.list({ prefix: 'config:voice_published' })
    expect(listed.keys[0].expiration).toBeUndefined()
  })

  it('validates input and auth', async () => {
    expect((await publish('general', true, null)).status).toBe(401)
    expect((await publish('general', true, 'wrong-token')).status).toBe(401)
    // promptId feeds a KV key elsewhere — same slug boundary as everywhere.
    expect((await publish('voice:general:someone', true)).status).toBe(400)
    expect((await publish('general', 'yes')).status).toBe(400)
  })

  it('a malformed config:voice_published reads as nothing published', async () => {
    const { token } = await getTokenFor('malformed@example.com')
    expect((await postVoice(token)).status).toBe(200)
    await env.MEMBERS_KV.put('config:voice_published', JSON.stringify({ promptIds: 'general' }))

    const mine = await (await req('/voice/mine', { token })).json()
    expect(mine.clip.published).toBe(false)
  })

  it('GET /admin/voice reports the published set for the round toggles', async () => {
    await publish('general', true)
    const data = await (await req('/admin/voice', { token: ADMIN })).json()
    expect(data.publishedPromptIds).toEqual(['general'])
  })
})

// Transcripts. The admin panel only EDITS: drafts are produced locally by
// scripts/transcribe.mjs and uploaded, so no model runs on Cloudflare. Because
// a draft must reach R2 before it can be edited there, "an .srt exists" cannot
// mean "a human read it" — the reviewed marker lives on the KV row instead.
describe('transcripts', () => {
  const SRT = '1\n00:00:00,000 --> 00:00:02,400\nHey, this is Michael Lamb.\n'
  const save = (key, srt, token = ADMIN) =>
    req('/admin/voice/transcript', { method: 'POST', token, body: { key, srt } })

  it('writes the SRT beside the audio and stamps the row reviewed', async () => {
    const { token, member } = await getTokenFor('srt@example.com')
    expect((await postVoice(token)).status).toBe(200)
    const key = `voice:general:${member.id}`

    const res = await save(key, SRT)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Same stem as the audio, so the bucket's all-prefixes 60-day lifecycle
    // expires the transcript with the recording it describes.
    expect(body.transcriptKey).toBe(`voice/general/${member.id}.srt`)
    expect(await (await env.VOICE.get(body.transcriptKey)).text()).toBe(SRT)

    const row = await env.MEMBERS_KV.get(key, { type: 'json' })
    expect(row.transcript.reviewedAt).toEqual(expect.any(String))
    expect(row.transcript.bytes).toBe(SRT.length)
  })

  it('reviewing never resets the retention clock', async () => {
    const { token, member } = await getTokenFor('srt-ttl@example.com')
    expect((await postVoice(token)).status).toBe(200)
    const [before] = await listVoiceRows()

    expect((await save(`voice:general:${member.id}`, SRT)).status).toBe(200)

    const [after] = await listVoiceRows()
    expect(after.value.expiresAt).toBe(before.value.expiresAt)
    expect(after.key.expiration).toBe(before.value.expiresAt)
    // Nothing else on the row moved.
    const { transcript, ...rest } = after.value
    expect(rest).toEqual(before.value)
  })

  it('refuses text with no timing lines', async () => {
    // An SRT with no cues renders no captions, and finding that out at render
    // time costs ten minutes of ffmpeg.
    const { token, member } = await getTokenFor('srt-bad@example.com')
    expect((await postVoice(token)).status).toBe(200)
    const key = `voice:general:${member.id}`
    expect((await save(key, 'just some notes I typed')).status).toBe(400)
    expect((await save(key, '   ')).status).toBe(400)
    expect((await save(key, 'x'.repeat(256 * 1024 + 1))).status).toBe(413)
  })

  it('validates key and auth like every other admin voice route', async () => {
    const { member } = await getTokenFor('srt-auth@example.com')
    const key = `voice:general:${member.id}`
    expect((await save(key, SRT, null)).status).toBe(401)
    expect((await save(key, SRT, 'wrong-token')).status).toBe(401)
    expect((await save('member:someone', SRT)).status).toBe(400)
    // A clip that never existed, or already aged out.
    expect((await save('voice:general:nobody', SRT)).status).toBe(404)
  })

  it('rides along on the admin listing so the panel can show reviewed state', async () => {
    const { token, member } = await getTokenFor('srt-list@example.com')
    expect((await postVoice(token)).status).toBe(200)
    await save(`voice:general:${member.id}`, SRT)

    const data = await (await req('/admin/voice', { token: ADMIN })).json()
    const row = data.clips.find(c => c.key === `voice:general:${member.id}`)
    expect(row.transcript.reviewedAt).toEqual(expect.any(String))
  })

  it('is not exposed to the member', async () => {
    // Members see their own clip, but the review state is operator bookkeeping.
    const { token, member } = await getTokenFor('srt-priv@example.com')
    expect((await postVoice(token)).status).toBe(200)
    await save(`voice:general:${member.id}`, SRT)

    const mine = await (await req('/voice/mine', { token })).json()
    expect(mine.clip.transcript).toBeUndefined()
  })
})

// "Mark reviewed" — vouching for a transcript that needed no fixes. Same
// endpoint with the body omitted, because it is the same fact being recorded.
describe('mark reviewed without rewriting', () => {
  const SRT = '1\n00:00:00,000 --> 00:00:02,400\nHey, this is Michael Lamb.\n'
  const mark = (key, token = ADMIN) =>
    req('/admin/voice/transcript', { method: 'POST', token, body: { key } })

  it('stamps the row and leaves the stored transcript byte-identical', async () => {
    const { token, member } = await getTokenFor('mark@example.com')
    expect((await postVoice(token)).status).toBe(200)
    const key = `voice:general:${member.id}`
    const r2Key = `voice/general/${member.id}.srt`
    await env.VOICE.put(r2Key, SRT)

    const res = await mark(key)
    expect(res.status).toBe(200)
    expect(await (await env.VOICE.get(r2Key)).text()).toBe(SRT)

    const row = await env.MEMBERS_KV.get(key, { type: 'json' })
    expect(row.transcript.reviewedAt).toEqual(expect.any(String))
    expect(row.transcript.bytes).toBe(SRT.length)
  })

  it('refuses to vouch for a transcript that is not there', async () => {
    // Stamping a clip whose transcript never arrived would open the caption
    // gate on nothing.
    const { token, member } = await getTokenFor('mark-empty@example.com')
    expect((await postVoice(token)).status).toBe(200)
    const res = await mark(`voice:general:${member.id}`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/upload one first/)
  })

  it('still validates the body when one IS sent', async () => {
    const { token, member } = await getTokenFor('mark-bad@example.com')
    expect((await postVoice(token)).status).toBe(200)
    const key = `voice:general:${member.id}`
    // An empty string is a save attempt, not a mark-reviewed.
    expect((await req('/admin/voice/transcript', { method: 'POST', token: ADMIN, body: { key, srt: '' } })).status).toBe(400)
  })

  it('needs the admin token like everything else here', async () => {
    const { member } = await getTokenFor('mark-auth@example.com')
    expect((await mark(`voice:general:${member.id}`, null)).status).toBe(401)
  })
})


// --- Free-form messages ------------------------------------------------------
//
// A message is a round of one: the member writes the subject, the server mints
// a promptId in the reserved msg_ namespace, and the row is an ordinary voice
// row. These tests pin the two things that make that safe — the reserved
// namespace really is unreachable, and a stray subject can never be mistaken
// for an answer to the current round.

describe('free-form messages', () => {
  it('mints a reserved msg_ id, stores the subject as promptText, and marks the kind', async () => {
    const { token, member } = await getTokenFor('msg1@example.com')
    const res = await postMessage(token, { subject: 'The ending of Nope, explained', note: 'about 2 min', duration: 90 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.kind).toBe('message')
    expect(body.note).toBe('about 2 min')
    expect(body.promptText).toBe('The ending of Nope, explained')
    expect(body.status).toBe('pending')
    // Storage internals stay out of the member projection.
    expect(body.r2Key).toBeUndefined()
    expect(body.memberId).toBeUndefined()

    const rows = await listVoiceRows()
    expect(rows).toHaveLength(1)
    const { key, value } = rows[0]
    expect(key.name).toMatch(/^voice:msg_[a-z0-9]{8,24}:id-msg1@example[.]com$/)
    // memberId stays the LAST key segment, which is what /voice/history's
    // endsWith filter and the TUI's key parser both depend on.
    expect(key.name.endsWith(':' + member.id)).toBe(true)
    expect(value.kind).toBe('message')
    expect(value.note).toBe('about 2 min')
    expect(value.promptText).toBe('The ending of Nope, explained')
    expect(value.r2Key).toBe('voice/' + value.promptId + '/' + member.id + '.webm')
    // Retention is identical to a round clip — the privacy promise makes no
    // distinction, so neither may the code.
    const now = Math.floor(Date.now() / 1000)
    expect(Math.abs(value.expiresAt - (now + SIXTY_DAYS))).toBeLessThan(120)
    expect(Math.abs(key.expiration - (now + SIXTY_DAYS))).toBeLessThan(120)

    expect(await env.VOICE.head(value.r2Key)).not.toBeNull()
  })

  it('a subject without kind=message is refused, and the round clip is untouched', async () => {
    // The dangerous default: without this guard the request falls into the
    // round branch and the replace path overwrites the member's answer to the
    // current round, deleting its audio.
    const { token, member } = await getTokenFor('msg2@example.com')
    await postVoice(token, { duration: 30 })
    const before = JSON.parse(await env.MEMBERS_KV.get('voice:general:' + member.id))
    await clearThrottle('msg2@example.com')

    const res = await postVoice(token, { subject: 'oops' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/kind=message/)

    const after = JSON.parse(await env.MEMBERS_KV.get('voice:general:' + member.id))
    expect(after).toEqual(before)
    expect(await env.VOICE.head(before.r2Key)).not.toBeNull()
    expect(await listVoiceRows()).toHaveLength(1)
  })

  it('one member holds many messages, and each is independently addressable', async () => {
    const { token, member } = await getTokenFor('msg3@example.com')
    const ids = []
    for (let i = 0; i < 3; i++) {
      await clearMsgThrottle('msg3@example.com')
      const res = await postMessage(token, { subject: 'Message number ' + i })
      expect(res.status).toBe(200)
      ids.push((await res.json()).promptId)
    }
    expect(new Set(ids).size).toBe(3)
    expect(await listVoiceRows()).toHaveLength(3)

    // /voice/audio and DELETE /voice both take ?promptId= and both accept a
    // minted id — the ownership check stays structural (key built from claims).
    const audio = await SELF.fetch('https://join.jxnfilm.club/voice/audio?promptId=' + ids[1], {
      headers: { Authorization: 'Bearer ' + token },
    })
    expect(audio.status).toBe(200)
    expect(audio.headers.get('Content-Type')).toBe('audio/webm')
    // Drain the body: an unread R2 stream outlives the test and the pool's
    // isolated-storage teardown then cannot pop the R2 frame.
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(WEBM_BYTES)

    const del = await SELF.fetch('https://join.jxnfilm.club/voice?promptId=' + ids[1], {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
    })
    expect(del.status).toBe(200)
    expect(await env.MEMBERS_KV.get('voice:' + ids[1] + ':' + member.id)).toBeNull()
    // Deleting one leaves the others alone.
    expect(await listVoiceRows()).toHaveLength(2)
  })

  it('caps live messages and says how to make room', async () => {
    const { token } = await getTokenFor('msg4@example.com')
    for (let i = 0; i < 5; i++) {
      await clearMsgThrottle('msg4@example.com')
      expect((await postMessage(token, { subject: 'Filling slot ' + i })).status).toBe(200)
    }
    await clearMsgThrottle('msg4@example.com')
    const res = await postMessage(token, { subject: 'One too many' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/up to 5 messages/)
    expect(await listVoiceRows()).toHaveLength(5)

    // Deleting one frees a slot — the cap counts live rows, not lifetime sends.
    const rows = await listVoiceRows()
    await env.MEMBERS_KV.delete(rows[0].key.name)
    await clearMsgThrottle('msg4@example.com')
    expect((await postMessage(token, { subject: 'Room again now' })).status).toBe(200)
  })

  it('replacing a message reuses its id and does not consume a new slot', async () => {
    const { token, member } = await getTokenFor('msg5@example.com')
    const first = await (await postMessage(token, { subject: 'First take' })).json()
    await clearMsgThrottle('msg5@example.com')
    const again = await postMessage(token, { subject: 'Second take', promptId: first.promptId })
    expect(again.status).toBe(200)
    expect((await again.json()).promptId).toBe(first.promptId)
    expect(await listVoiceRows()).toHaveLength(1)
    const row = JSON.parse(await env.MEMBERS_KV.get('voice:' + first.promptId + ':' + member.id))
    expect(row.promptText).toBe('Second take')
  })

  // These all pass the control-character check (every one is >= 32) and would
  // otherwise reach the admin list, the TUI and the audiogram frame verbatim.
  it('strips invisible formatting characters from a subject and note', async () => {
    const { token, member } = await getTokenFor('bidi@example.com')
    const res = await postMessage(token, {
      subject: 'Report\u202Egnp.exe',
      note: 'zero\u200bwidth\ufeff joined',
    })
    expect(res.status).toBe(200)
    const promptId = (await res.json()).promptId
    const row = JSON.parse(await env.MEMBERS_KV.get('voice:' + promptId + ':' + member.id))
    expect(row.promptText).toBe('Reportgnp.exe')
    expect(row.note).toBe('zerowidth joined')
  })

  // The bound has to apply to what is actually rendered, or padding a subject
  // with zero-width characters buys extra visible length in the audiogram.
  it('the length bound is measured after stripping', async () => {
    const { token } = await getTokenFor('pad@example.com')
    const res = await postMessage(token, { subject: 'A'.repeat(80) + '\u200b'.repeat(20) })
    expect(res.status).toBe(200)
  })

  // The audio is overwritten in place when the extension does not change, so
  // the ext-changed branch never fires — but the .srt is a DERIVED key and is
  // not overwritten. It would outlive the audio it describes, and "mark
  // reviewed" HEADs that object and would vouch for a transcript of a clip
  // nobody can hear any more.
  it('a same-extension replace does not leave the old transcript behind', async () => {
    const { token, member } = await getTokenFor('srt@example.com')
    const first = await (await postMessage(token, { subject: 'First take' })).json()
    const srtKey = 'voice/' + first.promptId + '/' + member.id + '.srt'
    await env.VOICE.put(srtKey, '1\n00:00:00,000 --> 00:00:01,000\nold words\n')
    expect(await env.VOICE.head(srtKey)).not.toBeNull()

    await clearMsgThrottle('srt@example.com')
    const again = await postMessage(token, { subject: 'Second take', promptId: first.promptId })
    expect(again.status).toBe(200)

    // Same extension, so the audio object is still there under the same key...
    expect(await env.VOICE.head('voice/' + first.promptId + '/' + member.id + '.webm')).not.toBeNull()
    // ...but the transcript of the take that no longer exists is gone.
    expect(await env.VOICE.head(srtKey)).toBeNull()
  })

  // isMessageId only proves the id is well-FORMED. The cap check is skipped
  // whenever a promptId is present, so a caller passing a fresh random msg_ id
  // each time would mint rows under ids of their own choosing, without limit —
  // the mailbox cap and the policy's "up to five" both silently untrue.
  it('refuses a replace of a message that does not exist', async () => {
    const { token } = await getTokenFor('ghost@example.com')
    const res = await postMessage(token, { subject: 'Slipping the cap', promptId: 'msg_doesnotexist1' })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/not found/)

    // Nothing was written on either side.
    expect(await listVoiceRows()).toHaveLength(0)
    expect((await env.VOICE.list({ prefix: 'voice/msg_' })).objects).toHaveLength(0)
  })

  it('the cap cannot be walked past with invented promptIds', async () => {
    const { token } = await getTokenFor('capper@example.com')
    for (let i = 0; i < 5; i++) {
      await clearMsgThrottle('capper@example.com')
      expect((await postMessage(token, { subject: 'Slot ' + i })).status).toBe(200)
    }
    await clearMsgThrottle('capper@example.com')
    const invented = await postMessage(token, { subject: 'One more', promptId: 'msg_invented01' })
    expect(invented.status).toBe(404)
    await clearMsgThrottle('capper@example.com')
    expect((await postMessage(token, { subject: 'One more' })).status).toBe(409)
    expect(await listVoiceRows()).toHaveLength(5)
  })

  it('rejects a promptId outside the message namespace on a replace', async () => {
    const { token } = await getTokenFor('msg6@example.com')
    const res = await postMessage(token, { promptId: 'general' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid promptId/)
  })

  it('validates the subject: required, bounded, and no control characters', async () => {
    const { token } = await getTokenFor('msg7@example.com')
    const cases = [
      [{ subject: '' }, /required/],
      [{ subject: 'no' }, /at least 3/],
      [{ subject: 'x'.repeat(81) }, /80 characters or fewer/],
      [{ subject: 'a line' + String.fromCharCode(10) + 'break' }, /control characters/],
      [{ subject: 'a bell' + String.fromCharCode(7) + 'here' }, /control characters/],
    ]
    for (const [opts, expected] of cases) {
      await clearMsgThrottle('msg7@example.com')
      const res = await postMessage(token, opts)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(expected)
    }
    expect(await listVoiceRows()).toHaveLength(0)
  })

  it('keeps unicode intact — the reason metadata is not in a header', async () => {
    const { token } = await getTokenFor('msg8@example.com')
    const subject = 'Almodóvar — “Volver”, revisited'
    const res = await postMessage(token, { subject })
    expect(res.status).toBe(200)
    expect((await res.json()).promptText).toBe(subject)
  })

  it('bounds the note and keeps its line breaks', async () => {
    const { token } = await getTokenFor('msg9@example.com')
    const note = 'line one' + String.fromCharCode(10) + 'line two'
    const res = await postMessage(token, { note })
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe(note)

    await clearMsgThrottle('msg9@example.com')
    const tooLong = await postMessage(token, { note: 'x'.repeat(501) })
    expect(tooLong.status).toBe(400)
    expect((await tooLong.json()).error).toMatch(/500 characters or fewer/)
  })

  it('throttles messages on their own cell, so sending one never blocks the round', async () => {
    const { token } = await getTokenFor('msg10@example.com')
    expect((await postMessage(token)).status).toBe(200)
    // Second message, same window: throttled.
    expect((await postMessage(token, { subject: 'Right behind it' })).status).toBe(429)
    // …but answering the round still works — a different cell entirely.
    expect((await postVoice(token, { duration: 12 })).status).toBe(200)
  })

  it('history mixes rounds and messages, with the current round still pinned first', async () => {
    const { token } = await getTokenFor('msg11@example.com')
    await postMessage(token, { subject: 'A message first' })
    await clearThrottle('msg11@example.com')
    await postVoice(token, { duration: 20 })

    const res = await SELF.fetch('https://join.jxnfilm.club/voice/history', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const { currentPromptId, clips } = await res.json()
    expect(currentPromptId).toBe('general')
    expect(clips).toHaveLength(2)
    expect(clips[0].promptId).toBe('general')
    expect(clips[0].kind).toBeUndefined()
    expect(clips[1].kind).toBe('message')
  })

  it('messages never leak into /voice/mine — that endpoint is the round', async () => {
    const { token } = await getTokenFor('msg12@example.com')
    await postMessage(token)
    const res = await SELF.fetch('https://join.jxnfilm.club/voice/mine', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await res.json()
    expect(body.prompt.id).toBe('general')
    expect(body.clip).toBeNull()
  })

  it('account deletion purges messages, their audio, and their transcripts', async () => {
    const { token, member } = await getTokenFor('msg13@example.com')
    const msg = await (await postMessage(token)).json()
    await clearThrottle('msg13@example.com')
    await postVoice(token, { duration: 15 })

    // Give the message a reviewed transcript, the way an operator would.
    const key = 'voice:' + msg.promptId + ':' + member.id
    const srtBody = '1' + String.fromCharCode(10) + '00:00:00,000 --> 00:00:02,000' + String.fromCharCode(10) + 'hello' + String.fromCharCode(10)
    const srt = await SELF.fetch('https://join.jxnfilm.club/admin/voice/transcript', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, srt: srtBody }),
    })
    expect(srt.status).toBe(200)
    const srtKey = 'voice/' + msg.promptId + '/' + member.id + '.srt'
    expect(await env.VOICE.head(srtKey)).not.toBeNull()

    mockFetch(async () => new Response('', { status: 200 }))
    const del = await req('/member/delete', { method: 'POST', token })
    expect(del.status).toBe(200)

    expect(await listVoiceRows()).toHaveLength(0)
    expect(await env.VOICE.head('voice/' + msg.promptId + '/' + member.id + '.webm')).toBeNull()
    // The transcript is the member's words verbatim. The policy says deletion
    // is immediate and complete, and the .srt key is derived rather than
    // stored — so every delete path has to re-derive it.
    expect(await env.VOICE.head(srtKey)).toBeNull()
  })
})

describe('the msg_ namespace is reserved', () => {
  it('a msg_ id in config:voice_prompt falls back to the default round', async () => {
    // The admin form cannot produce one, but admin/server.mjs's raw PUT and the
    // E2E KV shim both write arbitrary keys. A round aimed at the message
    // keyspace would collide with members' own rows.
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify({ id: 'msg_deadbeef01', text: 'Sneaky' }))
    const { token, member } = await getTokenFor('reserved@example.com')
    const res = await postVoice(token)
    expect(res.status).toBe(200)
    expect((await res.json()).promptId).toBe('general')
    expect(await env.MEMBERS_KV.get('voice:general:' + member.id)).not.toBeNull()

    const mine = await SELF.fetch('https://join.jxnfilm.club/voice/mine', {
      headers: { Authorization: 'Bearer ' + token },
    })
    expect((await mine.json()).prompt.id).toBe('general')
  })

  it('GET /config never hands the SPA a reserved id either', async () => {
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify({ id: 'msg_deadbeef01', text: 'Sneaky' }))
    const res = await SELF.fetch('https://join.jxnfilm.club/config')
    expect((await res.json()).voice_prompt).toBeNull()
  })

  it('a normal configured round is still served untouched', async () => {
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify({ id: 'spring-rewatch', text: 'What did you rewatch?' }))
    const res = await SELF.fetch('https://join.jxnfilm.club/config')
    expect((await res.json()).voice_prompt).toEqual({ id: 'spring-rewatch', text: 'What did you rewatch?' })
  })
})
