import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

function fetchWith(path, method, body, token) {
  return SELF.fetch(`https://join.jxnfilm.club${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function decodeClaims(token) {
  const [payload] = token.split('.')
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
}

async function getTokenFor(email, overrides = {}) {
  const member = {
    id: 'id-' + email, email, name: 'M', handle: null, joined: '2026-01-01', ...overrides,
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  if (member.handle) {
    await env.MEMBERS_KV.put(`email:${member.handle}`, email)
    await env.MEMBERS_KV.put(`handle:${email}`, member.handle)
  }
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await fetchWith('/otp/verify', 'POST', { email, code: '111111' })
  return { token: (await res.json()).token, member }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /member/delete', () => {
  it('401 without a token', async () => {
    const res = await fetchWith('/member/delete', 'POST', {})
    expect(res.status).toBe(401)
  })

  it('cascades all KV state for a member with no Letterboxd link', async () => {
    const { token, member } = await getTokenFor('plain@example.com')
    // Stash some auxiliary state that should also be wiped.
    await env.MEMBERS_KV.put(`lb_token:${member.email}`, JSON.stringify({
      token: 'jxnfc-verify-LEFTOVER', handle: null, exp: Date.now() + 1000,
    }))

    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response('', { status: 204 })
    })

    const res = await fetchWith('/member/delete', 'POST', {}, token)
    expect(res.status).toBe(200)

    expect(await env.MEMBERS_KV.get(`member:${member.email}`)).toBeNull()
    expect(await env.MEMBERS_KV.get(`session:${member.id}`)).toBeNull()
    expect(await env.MEMBERS_KV.get(`lb_token:${member.email}`)).toBeNull()

    const gh = calls.find(c => c.url.includes('api.github.com'))
    expect(gh).toBeTruthy()
    const dispatch = JSON.parse(gh.init.body)
    expect(dispatch.event_type).toBe('remove-member')
    expect(dispatch.client_payload).toEqual({ id: member.id })
  })

  it('also clears handle reverse indices when the member had Letterboxd linked', async () => {
    const { token, member } = await getTokenFor('lblinked@example.com', { handle: 'lbhandle' })
    expect(await env.MEMBERS_KV.get('email:lbhandle')).toBe('lblinked@example.com')

    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/delete', 'POST', {}, token)
    expect(res.status).toBe(200)

    expect(await env.MEMBERS_KV.get(`member:${member.email}`)).toBeNull()
    expect(await env.MEMBERS_KV.get(`email:${member.handle}`)).toBeNull()
    expect(await env.MEMBERS_KV.get(`handle:${member.email}`)).toBeNull()
    // Handle becomes claimable again immediately after delete.
  })

  it('revokes the current jti so a copied token is dead even within the 1h JWT exp', async () => {
    const { token } = await getTokenFor('revoke-on-delete@example.com')
    const { jti } = decodeClaims(token)
    mockFetch(async () => new Response('', { status: 204 }))

    await fetchWith('/member/delete', 'POST', {}, token)
    expect(await env.MEMBERS_KV.get(`revoked:${jti}`)).toBe('1')

    // Sanity: the (now-revoked) token can no longer hit an authed endpoint.
    const replay = await fetchWith('/member/me', 'GET', undefined, token)
    expect(replay.status).toBe(401)
  })

  it('404 when the member row is already gone (idempotency edge — second delete from a stale tab)', async () => {
    const { token, member } = await getTokenFor('gone@example.com')
    await env.MEMBERS_KV.delete(`member:${member.email}`)
    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/delete', 'POST', {}, token)
    expect(res.status).toBe(404)
  })

  it('does NOT dispatch when no token (auth gate trips first)', async () => {
    const calls = []
    mockFetch(async (url) => { calls.push(String(url)); return new Response('', { status: 204 }) })
    await fetchWith('/member/delete', 'POST', {})
    expect(calls.some(u => u.includes('api.github.com'))).toBe(false)
  })

  it('rejects tampered tokens with 401 (signature mismatch path)', async () => {
    const { token } = await getTokenFor('tamper-delete@example.com')
    const [, sig] = token.split('.')
    const evil = btoa(JSON.stringify({
      email: 'someone-else@example.com', id: 'x', exp: Date.now() + 3600_000, jti: 'forged',
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/delete', 'POST', {}, `${evil}.${sig}`)
    expect(res.status).toBe(401)
  })

  describe('with { anonymize: true }', () => {
    // Attendance entries are { id, name }. Seeds take [name] or [id, name]
    // pairs so a test can say which rows are id-keyed and which are the
    // pre-migration bare-name kind.
    async function seedAttendance(eventId, rows) {
      const entries = rows.map(r => (Array.isArray(r) ? { id: r[0], name: r[1] } : { id: null, name: r }))
      await env.ATTENDANCE_KV.put(`attend:${eventId}`, JSON.stringify(entries))
    }
    const names = (list) => list.map(a => a.name)
    const read = async (key) => JSON.parse(await env.ATTENDANCE_KV.get(key))

    it('replaces the member with "former member" across every attend:* key', async () => {
      const { token, member } = await getTokenFor('scrub@example.com', { name: 'Alice Scrub' })
      await seedAttendance('evt-1', [[member.id, 'Alice Scrub'], 'Bob', 'Carol'])
      await seedAttendance('evt-2', ['Dan', [member.id, 'Alice Scrub']])
      await seedAttendance('evt-3', ['Bob', 'Carol']) // does NOT include the member
      mockFetch(async () => new Response('', { status: 204 }))

      const res = await fetchWith('/member/delete', 'POST', { anonymize: true }, token)
      expect(res.status).toBe(200)

      // Each event that previously listed Alice now has "former member" in
      // her slot; event without her is untouched. The label carries no id —
      // it is deliberately unresolvable.
      expect(await read('attend:evt-1'))
        .toEqual([{ id: null, name: 'Bob' }, { id: null, name: 'Carol' }, { id: null, name: 'former member' }])
      expect(names(await read('attend:evt-2'))).toEqual(['Dan', 'former member'])
      expect(names(await read('attend:evt-3'))).toEqual(['Bob', 'Carol'])

      // attendance:all aggregate stays in sync with the per-event keys.
      const all = JSON.parse(await env.ATTENDANCE_KV.get('attendance:all'))
      expect(names(all['evt-1'])).toContain('former member')
      expect(all['evt-1'].some(a => a.id === member.id)).toBe(false)
      expect(names(all['evt-2'])).toContain('former member')

      // Member row still removed.
      expect(await env.MEMBERS_KV.get('member:scrub@example.com')).toBeNull()
    })

    it('scrubs a row that predates the id backfill by matching its bare name', async () => {
      const { token } = await getTokenFor('legacy-scrub@example.com', { name: 'Legacy Leaver' })
      await seedAttendance('evt-1', ['Legacy Leaver', 'Bob'])
      mockFetch(async () => new Response('', { status: 204 }))

      await fetchWith('/member/delete', 'POST', { anonymize: true }, token)
      expect(names(await read('attend:evt-1'))).toEqual(['Bob', 'former member'])
    })

    it('scrubs only the leaver when another member shares their display name', async () => {
      const { token, member } = await getTokenFor('twin-1@example.com', { name: 'Shared Name' })
      await seedAttendance('evt-1', [[member.id, 'Shared Name'], ['other-id', 'Shared Name']])
      mockFetch(async () => new Response('', { status: 204 }))

      await fetchWith('/member/delete', 'POST', { anonymize: true }, token)
      expect(await read('attend:evt-1')).toEqual([
        { id: 'other-id', name: 'Shared Name' },
        { id: null, name: 'former member' },
      ])
    })

    it('is idempotent when "former member" already exists from a previous anonymizer', async () => {
      const { token } = await getTokenFor('second@example.com', { name: 'Second Leaver' })
      // evt-1 already shows a former-member entry from someone earlier.
      await seedAttendance('evt-1', ['Second Leaver', 'former member', 'Charlie'])
      mockFetch(async () => new Response('', { status: 204 }))

      await fetchWith('/member/delete', 'POST', { anonymize: true }, token)
      // Single "former member" entry — no duplicate added.
      const attendees = names(await read('attend:evt-1'))
      expect(attendees.filter(n => n === 'former member')).toHaveLength(1)
      expect(attendees).not.toContain('Second Leaver')
    })

    it('default { anonymize: false } leaves attendance untouched (prior behavior preserved)', async () => {
      const { token } = await getTokenFor('keepname@example.com', { name: 'Loud Member' })
      await seedAttendance('evt-1', ['Loud Member', 'Bob'])
      mockFetch(async () => new Response('', { status: 204 }))

      const res = await fetchWith('/member/delete', 'POST', { anonymize: false }, token)
      expect(res.status).toBe(200)
      expect(names(await read('attend:evt-1'))).toEqual(['Loud Member', 'Bob'])
    })

    it('best-effort dispatch: a 401 from GitHub still returns 200 to the client and records dispatch_failed:* audit', async () => {
      // E2E_MODE short-circuits dispatch in tests, so we temporarily disable
      // it to exercise the real dispatch path. Restore at the end.
      const { env } = await import('cloudflare:test')
      const prev = env.E2E_MODE
      env.E2E_MODE = 'false'
      try {
        const { token, member } = await getTokenFor('paterror@example.com', { name: 'Locked Out' })
        const calls = []
        mockFetch(async (url, init) => {
          calls.push({ url: String(url), init })
          if (String(url).includes('api.github.com')) {
            return new Response('{"message":"Bad credentials"}', { status: 401 })
          }
          return new Response('', { status: 200 })
        })
        // Without best-effort, this would 500. With it, the KV cascade
        // completes and the client gets a clean 200.
        const res = await fetchWith('/member/delete', 'POST', {}, token)
        expect(res.status).toBe(200)

        // Member row was still removed (cascade ran).
        expect(await env.MEMBERS_KV.get(`member:${member.email}`)).toBeNull()

        // GitHub was actually called (we didn't silently skip the dispatch).
        expect(calls.some(c => c.url.includes('api.github.com'))).toBe(true)

        // The audit key is present and parseable so an operator can find drift.
        const auditKeys = await env.MEMBERS_KV.list({ prefix: 'dispatch_failed:remove-member:' })
        expect(auditKeys.keys.length).toBeGreaterThanOrEqual(1)
        const auditRaw = await env.MEMBERS_KV.get(auditKeys.keys[0].name)
        const audit = JSON.parse(auditRaw)
        expect(audit.event_type).toBe('remove-member')
        expect(audit.client_payload.id).toBe(member.id)
        expect(audit.reason).toMatch(/401/)
      } finally {
        env.E2E_MODE = prev
      }
    })

    it('an empty body (no anonymize key) is treated as opt-out', async () => {
      const { token } = await getTokenFor('emptybody@example.com', { name: 'Quiet Member' })
      await seedAttendance('evt-1', ['Quiet Member'])
      mockFetch(async () => new Response('', { status: 204 }))

      const res = await SELF.fetch('https://join.jxnfilm.club/member/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '',
      })
      expect(res.status).toBe(200)
      expect(names(await read('attend:evt-1'))).toEqual(['Quiet Member'])
    })
  })

  describe('RSVP purge', () => {
    const future = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)
    const past = new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10)

    function entry(member) {
      return { memberId: member.id, name: member.name, email: member.email, at: 1 }
    }

    async function seedHostedEvent(id, date, extra = {}) {
      const event = {
        id, title: 'Purge Test', film: 'F', date, kind: 'house',
        address: '1 Secret St', capacity: 2, hostId: 'host-1', hostName: 'Host', ...extra,
      }
      await env.ATTENDANCE_KV.put(`event:${id}`, JSON.stringify(event))
      return event
    }

    it('cancels upcoming-event RSVPs and promotes the waitlist head with an email', async () => {
      const { token, member } = await getTokenFor('purge-future@example.com', { name: 'Purge Future' })
      const waitlisted = { memberId: 'w-1', name: 'Waiting', email: 'waiting@example.com', at: 2 }
      await seedHostedEvent('evt-up', future)
      await env.ATTENDANCE_KV.put('rsvp:evt-up', JSON.stringify({
        confirmed: [entry(member)], waitlist: [waitlisted],
      }))

      const calls = []
      mockFetch(async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response('', { status: 200 })
      })

      const res = await fetchWith('/member/delete', 'POST', {}, token)
      expect(res.status).toBe(200)

      const rsvp = JSON.parse(await env.ATTENDANCE_KV.get('rsvp:evt-up'))
      expect(rsvp.confirmed.map(r => r.memberId)).toEqual(['w-1'])
      expect(rsvp.waitlist).toEqual([])

      // Promotion email went out through the normal cancel path.
      const resend = calls.filter(c => c.url.includes('api.resend.com'))
      expect(resend).toHaveLength(1)
      const sent = JSON.parse(resend[0].init.body)
      expect(sent.to).toEqual(['waiting@example.com'])
      expect(sent.subject).toMatch(/You're in for/)

      // attend mirror reflects the new confirmed list, behind the host (who
      // attends their own screening without holding an RSVP slot). Each entry
      // carries the id it was mirrored from.
      expect(JSON.parse(await env.ATTENDANCE_KV.get('attend:evt-up'))).toEqual([
        { id: 'host-1', name: 'Host' }, { id: 'w-1', name: 'Waiting' },
      ])
    })

    it('scrubs past-event records directly: no emails, attend history untouched', async () => {
      const { token, member } = await getTokenFor('purge-past@example.com', { name: 'Purge Past' })
      const other = { memberId: 'o-1', name: 'Other', email: 'other@example.com', at: 2 }
      await seedHostedEvent('evt-past', past)
      await env.ATTENDANCE_KV.put('rsvp:evt-past', JSON.stringify({
        confirmed: [entry(member), other], waitlist: [],
      }))
      await env.ATTENDANCE_KV.put('attend:evt-past', JSON.stringify([
        { id: member.id, name: 'Purge Past' }, { id: 'o-1', name: 'Other' },
      ]))

      const calls = []
      mockFetch(async (url, init) => {
        calls.push(String(url))
        return new Response('', { status: 204 })
      })

      const res = await fetchWith('/member/delete', 'POST', {}, token)
      expect(res.status).toBe(200)

      const rsvp = JSON.parse(await env.ATTENDANCE_KV.get('rsvp:evt-past'))
      expect(rsvp.confirmed.map(r => r.memberId)).toEqual(['o-1'])
      expect(calls.some(u => u.includes('api.resend.com'))).toBe(false)
      // Attendance history is a separate concern (the anonymize opt-in).
      expect(JSON.parse(await env.ATTENDANCE_KV.get('attend:evt-past'))).toEqual([
        { id: member.id, name: 'Purge Past' }, { id: 'o-1', name: 'Other' },
      ])
    })

    it('removes waitlist-only entries without promoting anyone', async () => {
      const { token, member } = await getTokenFor('purge-wait@example.com', { name: 'Purge Wait' })
      const confirmed = { memberId: 'c-1', name: 'Solid', email: 'solid@example.com', at: 1 }
      await seedHostedEvent('evt-wl', future, { capacity: 1 })
      await env.ATTENDANCE_KV.put('rsvp:evt-wl', JSON.stringify({
        confirmed: [confirmed], waitlist: [entry(member)],
      }))

      const calls = []
      mockFetch(async (url) => { calls.push(String(url)); return new Response('', { status: 204 }) })

      const res = await fetchWith('/member/delete', 'POST', {}, token)
      expect(res.status).toBe(200)

      const rsvp = JSON.parse(await env.ATTENDANCE_KV.get('rsvp:evt-wl'))
      expect(rsvp.confirmed.map(r => r.memberId)).toEqual(['c-1'])
      expect(rsvp.waitlist).toEqual([])
      expect(calls.some(u => u.includes('api.resend.com'))).toBe(false)
    })

    it('scrubs orphaned rsvp records whose event row is gone', async () => {
      const { token, member } = await getTokenFor('purge-orphan@example.com', { name: 'Purge Orphan' })
      await env.ATTENDANCE_KV.put('rsvp:evt-ghost', JSON.stringify({
        confirmed: [entry(member)], waitlist: [],
      }))
      mockFetch(async () => new Response('', { status: 204 }))

      const res = await fetchWith('/member/delete', 'POST', {}, token)
      expect(res.status).toBe(200)
      const rsvp = JSON.parse(await env.ATTENDANCE_KV.get('rsvp:evt-ghost'))
      expect(rsvp.confirmed).toEqual([])
    })

    it('leaves other members’ rsvp records alone', async () => {
      const { token } = await getTokenFor('purge-noop@example.com', { name: 'Purge Noop' })
      const record = { confirmed: [{ memberId: 'x-1', name: 'X', email: 'x@example.com', at: 1 }], waitlist: [] }
      await seedHostedEvent('evt-other', future)
      await env.ATTENDANCE_KV.put('rsvp:evt-other', JSON.stringify(record))
      mockFetch(async () => new Response('', { status: 204 }))

      const res = await fetchWith('/member/delete', 'POST', {}, token)
      expect(res.status).toBe(200)
      expect(JSON.parse(await env.ATTENDANCE_KV.get('rsvp:evt-other'))).toEqual(record)
    })
  })

})
