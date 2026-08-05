import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

// members:all is reconciled against canonical member:{email} rows on every
// aggregate write (reconcileMembersAll) — regression coverage for the
// 2026-08-05 race where two near-simultaneous /signup/verify calls clobbered
// each other's read-modify-write append and silently dropped a member from
// the public directory.

const ADMIN_TOKEN = 'test-admin-token'

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

async function seedMember(email, overrides = {}) {
  const member = {
    id: 'id-' + email, email, name: 'M ' + email, handle: null, joined: '2026-01-01', ...overrides,
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  return member
}

async function getTokenFor(email, overrides = {}) {
  const member = await seedMember(email, overrides)
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await fetchWith('/otp/verify', 'POST', { email, code: '111111' })
  return { token: (await res.json()).token, member }
}

async function seedAggregate(projections) {
  await env.MEMBERS_KV.put('members:bootstrapped', '1')
  await env.MEMBERS_KV.put('members:all', JSON.stringify(projections))
}

async function publicIds() {
  const res = await SELF.fetch('https://join.jxnfilm.club/members')
  return (await res.json()).map(m => m.id).sort()
}

afterEach(() => { vi.restoreAllMocks() })

describe('members:all reconciliation', () => {
  it('any member mutation restores a member race-dropped from the aggregate', async () => {
    const { token: tokenB, member: b } = await getTokenFor('b@example.com')
    const a = await seedMember('a@example.com')
    // Simulate the clobber: aggregate lost member A but kept member B.
    await seedAggregate([{ id: b.id, name: b.name, joined: b.joined }])

    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/update', 'POST', { name: 'B Renamed' }, tokenB)
    expect(res.status).toBe(200)

    expect(await publicIds()).toEqual([a.id, b.id].sort())
  })

  it('aggregate rows without a canonical KV row are preserved (baseline members)', async () => {
    const { token, member } = await getTokenFor('real@example.com')
    // Baseline-only member: present in the aggregate, no member:{email} row.
    await seedAggregate([
      { id: 'baseline-only', name: 'From data/members.json', joined: '2021-01-01' },
      { id: member.id, name: member.name, joined: member.joined },
    ])

    mockFetch(async () => new Response('', { status: 204 }))
    await fetchWith('/member/update', 'POST', { name: 'Renamed' }, token)

    expect(await publicIds()).toEqual(['baseline-only', member.id].sort())
  })

  it('a deleted member leaves the aggregate and stays gone through later reconciles', async () => {
    const { token: tokenA, member: a } = await getTokenFor('gone@example.com')
    const { token: tokenB, member: b } = await getTokenFor('stays@example.com')
    await seedAggregate([
      { id: a.id, name: a.name, joined: a.joined },
      { id: b.id, name: b.name, joined: b.joined },
    ])

    mockFetch(async () => new Response('', { status: 204 }))
    const del = await fetchWith('/member/delete', 'POST', { confirm: 'gone@example.com' }, tokenA)
    expect(del.status).toBe(200)
    expect(await publicIds()).toEqual([b.id])

    // A later mutation must not resurrect the deleted member (canonical row
    // is gone, so the reconcile has nothing to restore).
    await fetchWith('/member/update', 'POST', { name: 'Still Here' }, tokenB)
    expect(await publicIds()).toEqual([b.id])
  })

  it('POST /admin/scrub reconciles drift with no member activity (cron parity)', async () => {
    const a = await seedMember('idle-a@example.com', { handle: 'idlea' })
    const b = await seedMember('idle-b@example.com')
    // Aggregate lost A entirely and shows a stale name for B.
    await seedAggregate([{ id: b.id, name: 'Stale Name', joined: b.joined }])

    const res = await SELF.fetch('https://join.jxnfilm.club/admin/scrub', {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).reconciledMembers).toBe(2)

    const all = await (await SELF.fetch('https://join.jxnfilm.club/members')).json()
    expect(all.map(m => m.id).sort()).toEqual([a.id, b.id].sort())
    expect(all.find(m => m.id === a.id).handle).toBe('idlea')
    expect(all.find(m => m.id === b.id).name).toBe('M idle-b@example.com')
  })
})
