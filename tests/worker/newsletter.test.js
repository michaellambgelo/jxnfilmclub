import { SELF, env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
// Direct module import so a test can pass a MODIFIED env (SELF's isolate
// ignores mutations of the imported env object).
import worker from '../../worker/src/index.js'

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
    id: 'id-' + email, email, name: 'M', handle: null, pronouns: null, joined: '2026-01-01', ...overrides,
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  return member
}

async function getTokenFor(email, overrides = {}) {
  const member = await seedMember(email, overrides)
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await req('/otp/verify', { method: 'POST', body: { email, code: '111111' } })
  return { token: (await res.json()).token, member }
}

// Run a send and return the captured Resend batch payload (array of messages).
async function captureSend(body) {
  const calls = []
  mockFetch(async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  })
  const res = await req('/admin/newsletter/send', { method: 'POST', token: 'test-admin-token', body })
  const batchCall = calls.find(c => c.url === 'https://api.resend.com/emails/batch')
  return { res, batch: batchCall ? JSON.parse(batchCall.init.body) : null }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('newsletter opt-in capture', () => {
  it('signup with newsletter:true carries the flag onto pending then member', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    await req('/signup', { method: 'POST', body: { email: 'opt@example.com', name: 'Opt', newsletter: true } })

    const pending = JSON.parse(await env.MEMBERS_KV.get('pending:opt@example.com'))
    expect(pending.newsletter).toBe(true)

    await req('/signup/verify', { method: 'POST', body: { email: 'opt@example.com', code: pending.code } })
    const member = JSON.parse(await env.MEMBERS_KV.get('member:opt@example.com'))
    expect(member.newsletter).toBe(true)
  })

  it('signup without the flag defaults newsletter:false', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    await req('/signup', { method: 'POST', body: { email: 'noopt@example.com', name: 'NoOpt' } })

    const pending = JSON.parse(await env.MEMBERS_KV.get('pending:noopt@example.com'))
    expect(pending.newsletter).toBe(false)

    await req('/signup/verify', { method: 'POST', body: { email: 'noopt@example.com', code: pending.code } })
    const member = JSON.parse(await env.MEMBERS_KV.get('member:noopt@example.com'))
    expect(member.newsletter).toBe(false)
  })
})

describe('newsletter toggle via /member/update', () => {
  it('flips the flag and the session overlay (read by /member/me) agrees', async () => {
    const { token, member } = await getTokenFor('toggle@example.com', { newsletter: true })

    mockFetch(async () => new Response('', { status: 204 }))
    const res = await req('/member/update', { method: 'POST', token, body: { newsletter: false } })
    expect(res.status).toBe(200)

    const saved = JSON.parse(await env.MEMBERS_KV.get('member:toggle@example.com'))
    expect(saved.newsletter).toBe(false)
    const session = JSON.parse(await env.MEMBERS_KV.get(`session:${member.id}`))
    expect(session.newsletter).toBe(false)
  })
})

describe('POST /admin/newsletter/send', () => {
  it('rejects a missing or wrong admin token', async () => {
    expect((await req('/admin/newsletter/send', { method: 'POST', body: { subject: 's', text: 't' } })).status).toBe(401)
    expect((await req('/admin/newsletter/send', { method: 'POST', token: 'nope', body: { subject: 's', text: 't' } })).status).toBe(401)
  })

  it('sends only to opted-in members, with unsubscribe link, headers, and postal footer', async () => {
    await seedMember('in@example.com', { newsletter: true })
    await seedMember('out@example.com', { newsletter: false })
    await seedMember('legacy@example.com') // no flag at all -> excluded

    const { res, batch } = await captureSend({ subject: 'May picks', html: '<p>Hi</p>', text: 'Hi' })
    expect(res.status).toBe(200)
    expect((await res.json()).sent).toBe(1)

    expect(batch).toHaveLength(1)
    const msg = batch[0]
    expect(msg.to).toEqual(['in@example.com'])
    expect(msg.subject).toBe('May picks')

    // One-click List-Unsubscribe (Gmail/Yahoo bulk rules + RFC 8058).
    expect(msg.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    const unsubUrl = msg.headers['List-Unsubscribe'].match(/<([^>]+\/unsubscribe[^>]+)>/)[1]
    expect(unsubUrl).toContain('/unsubscribe?token=')

    // Unsubscribe link + (when configured) postal address in the body.
    // The HTML footer must carry the link as a real anchor, not a bare URL.
    expect(msg.html).toMatch(/<a href="[^"]*\/unsubscribe\?token=[^"]*">Unsubscribe<\/a>/)
    expect(msg.html).toContain('Jackson Film Club, PO Box 1')
    expect(msg.text).toContain('Unsubscribe:')
    expect(msg.text).toContain('Jackson Film Club, PO Box 1')
  })

  it('sends without a postal address configured — the footer just omits the line', async () => {
    // The var is optional since 2026-08-11 (a home address was removed from
    // the committed config): sending must NOT 500, and no address line or
    // dangling separator may appear in either footer.
    await seedMember('nopostal@example.com', { newsletter: true })
    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(new Request('https://join.jxnfilm.club/admin/newsletter/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify({ subject: 'June picks', html: '<p>Hi</p>', text: 'Hi' }),
    }), { ...env, NEWSLETTER_POSTAL_ADDRESS: '' }, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
    const batchCall = calls.find(c => c.url === 'https://api.resend.com/emails/batch')
    const msg = JSON.parse(batchCall.init.body)[0]
    expect(msg.html).not.toContain('PO Box')
    expect(msg.html).toMatch(/Unsubscribe<\/a><\/p>/)
    expect(msg.text).not.toContain('PO Box')
    expect(msg.text.trimEnd().endsWith(msg.text.match(/Unsubscribe: \S+/)[0])).toBe(true)
  })

  it('400s when subject or body is missing', async () => {
    const res = await req('/admin/newsletter/send', { method: 'POST', token: 'test-admin-token', body: { subject: 'only subject' } })
    expect(res.status).toBe(400)
  })

  it('testTo sends exactly one faithful preview, ignores the opt-in list, writes no audit row', async () => {
    await seedMember('notin@example.com', { newsletter: false })
    const { res, batch } = await captureSend({ subject: 'Preview', text: 'Hi', testTo: 'me@example.com' })

    const data = await res.json()
    expect(data.test).toBe(true)
    expect(data.sent).toBe(1)
    expect(batch).toHaveLength(1)
    expect(batch[0].to).toEqual(['me@example.com'])
    // Faithful: a test still carries the unsubscribe header + footer.
    expect(batch[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(batch[0].text).toContain('Unsubscribe:')

    const sent = await env.MEMBERS_KV.list({ prefix: 'newsletter:sent:' })
    expect(sent.keys).toHaveLength(0)
  })

  it('rejects an invalid testTo', async () => {
    const res = await req('/admin/newsletter/send', {
      method: 'POST', token: 'test-admin-token', body: { subject: 's', text: 't', testTo: 'not-an-email' },
    })
    expect(res.status).toBe(400)
  })

  it('a real send writes one newsletter:sent audit row with the recipient count', async () => {
    await seedMember('one@example.com', { newsletter: true })
    await seedMember('two@example.com', { newsletter: true })
    const { res } = await captureSend({ subject: 'Broadcast', text: 'Hi' })
    expect((await res.json()).sent).toBe(2)

    const sent = await env.MEMBERS_KV.list({ prefix: 'newsletter:sent:' })
    expect(sent.keys).toHaveLength(1)
    const audit = JSON.parse(await env.MEMBERS_KV.get(sent.keys[0].name))
    expect(audit.subject).toBe('Broadcast')
    expect(audit.count).toBe(2)
  })

  it('a zero-recipient send writes no audit row', async () => {
    const { res } = await captureSend({ subject: 'Nobody', text: 'Hi' })
    expect((await res.json()).sent).toBe(0)
    const sent = await env.MEMBERS_KV.list({ prefix: 'newsletter:sent:' })
    expect(sent.keys).toHaveLength(0)
  })
})

describe('/unsubscribe', () => {
  it('GET with a valid token flips newsletter:false; one-click POST is not Origin-gated', async () => {
    await seedMember('bye@example.com', { newsletter: true })

    // Mint a real token by sending and pulling it out of the batch payload.
    const { batch } = await captureSend({ subject: 's', text: 't' })
    const unsubUrl = batch[0].headers['List-Unsubscribe'].match(/<([^>]+\/unsubscribe[^>]+)>/)[1]
    const token = new URL(unsubUrl).searchParams.get('token')

    const getRes = await req(`/unsubscribe?token=${encodeURIComponent(token)}`)
    expect(getRes.status).toBe(200)
    expect((await getRes.text()).toLowerCase()).toContain('unsubscribed')
    expect(JSON.parse(await env.MEMBERS_KV.get('member:bye@example.com')).newsletter).toBe(false)

    // Re-opt-in, then prove the one-click POST works even with a cross-origin
    // Origin header (mailbox providers POST server-to-server).
    await seedMember('bye@example.com', { newsletter: true })
    const postRes = await req(`/unsubscribe?token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { Origin: 'https://mail.google.com' },
    })
    expect(postRes.status).toBe(200)
    expect(JSON.parse(await env.MEMBERS_KV.get('member:bye@example.com')).newsletter).toBe(false)
  })

  it('rejects a tampered token without changing state', async () => {
    await seedMember('safe@example.com', { newsletter: true })
    const res = await req('/unsubscribe?token=not.a.realtoken')
    expect(res.status).toBe(200) // human page, not an error
    expect((await res.text()).toLowerCase()).toContain('invalid')
    expect(JSON.parse(await env.MEMBERS_KV.get('member:safe@example.com')).newsletter).toBe(true)

    const postRes = await req('/unsubscribe?token=not.a.realtoken', { method: 'POST' })
    expect(postRes.status).toBe(400)
  })
})

// --- Send guards ------------------------------------------------------------
//
// Three failure modes converge on this handler, two of them silent: Gmail
// strips data: images at render time, Gmail clips the html part near 102KB,
// and sendBatch's JSON.stringify flattens each body in place so a large one
// approaches the isolate memory ceiling while fanning out per recipient.
describe('POST /admin/newsletter/send — body guards', () => {
  const OK = { subject: 'S', html: '<p>hi</p>', text: 'hi' }

  it('413s an oversized html body without reaching Resend', async () => {
    const { res, batch } = await captureSend({ ...OK, html: 'x'.repeat(200 * 1024) })
    expect(res.status).toBe(413)
    expect((await res.json()).error).toMatch(/over the .*KB limit/)
    expect(batch).toBeNull()          // never got as far as sending
  })

  it('413s an oversized plain-text body', async () => {
    const { res } = await captureSend({ ...OK, text: 'x'.repeat(80 * 1024) })
    expect(res.status).toBe(413)
  })

  it('accepts a body just under the ceiling', async () => {
    await seedMember('under@example.com', { newsletter: true })
    const { res } = await captureSend({ ...OK, html: '<p>' + 'x'.repeat(100 * 1024) + '</p>' })
    expect(res.status).toBe(200)
  })

  it('400s an embedded data: image', async () => {
    const { res, batch } = await captureSend({ ...OK, html: '<img src="data:image/png;base64,iVBORw0KGgo=">' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/gmail strips those/i)
    expect(batch).toBeNull()
  })

  it('400s an image hosted on another environment', async () => {
    const { res } = await captureSend({ ...OK, html: '<img src="https://join-staging.jxnfilm.club/nl/img/a.jpg">' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/another environment/)
  })

  it('allows an image on this environment', async () => {
    await seedMember('same@example.com', { newsletter: true })
    const { res } = await captureSend({ ...OK, html: '<img src="https://join.jxnfilm.club/nl/img/a.jpg">' })
    expect(res.status).toBe(200)
  })

  // The guards sit BEFORE the testTo branch on purpose. A test send is the one
  // path that makes a broken body look correct — a data: URI renders perfectly
  // in a test to an Apple Mail address and is stripped by Gmail for the real
  // list — so leaving it unguarded manufactures false confidence.
  it('guards a TEST send on identical terms', async () => {
    const dataUri = await captureSend({ ...OK, html: '<img src="data:image/png;base64,AA">', testTo: 'me@example.com' })
    expect(dataUri.res.status).toBe(400)
    expect(dataUri.batch).toBeNull()

    const tooBig = await captureSend({ ...OK, html: 'x'.repeat(200 * 1024), testTo: 'me@example.com' })
    expect(tooBig.res.status).toBe(413)
    expect(tooBig.batch).toBeNull()
  })
})

describe('POST /admin/newsletter/send — upstream failures are legible', () => {
  it('502s with the Resend message instead of "internal server error"', async () => {
    await seedMember('a@example.com', { newsletter: true })
    mockFetch(async (url) => String(url).includes('resend')
      ? new Response('{"message":"validation failed"}', { status: 422 })
      : new Response('', { status: 200 }))
    const res = await req('/admin/newsletter/send', {
      method: 'POST', token: 'test-admin-token', body: { subject: 'S', html: '<p>hi</p>' },
    })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/Resend batch 422/)
    expect(body.error).toMatch(/validation failed/)
    expect(body.error).not.toMatch(/internal server error/i)
  })

  it('reports a partial broadcast as partial, so a retry is not a double-send', async () => {
    // 150 recipients = two chunks. Fail the second: 100 people already have it.
    for (let i = 0; i < 150; i++) await seedMember(`p${i}@example.com`, { newsletter: true })
    let n = 0
    mockFetch(async (url) => {
      if (!String(url).includes('resend')) return new Response('', { status: 200 })
      n++
      return n === 1
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response('{"message":"rate limited"}', { status: 429 })
    })
    const res = await req('/admin/newsletter/send', {
      method: 'POST', token: 'test-admin-token', body: { subject: 'S', html: '<p>hi</p>' },
    })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.sent).toBe(100)
    expect(body.partial).toBe(true)
  })
})

// --- Shareable permalink -----------------------------------------------------
describe('newsletter web archive', () => {
  const OK = { subject: 'This month at the club', html: '<p>Sherlock Jr. on Friday</p>', text: 'Sherlock Jr. on Friday' }

  it('archives the PRE-FOOTER body, never a rendered message', async () => {
    // buildNewsletterMessage signs a per-recipient unsubscribe token into each
    // copy's footer. Archiving a rendered message would publish one member's
    // signed token at a public URL, letting anyone unsubscribe them.
    await seedMember('arch@example.com', { newsletter: true })
    const { res, batch } = await captureSend(OK)
    expect(res.status).toBe(200)
    const { permalink } = await res.json()
    expect(permalink).toMatch(/^https:\/\/join\.jxnfilm\.club\/n\/\d{4}-\d{2}-this-month-at-the-club-[a-f0-9]{10}$/)

    // The delivered copy DOES carry a token; the archive must not.
    expect(batch[0].html).toMatch(/unsubscribe\?token=/)
    const page = await (await SELF.fetch(permalink)).text()
    expect(page).not.toMatch(/unsubscribe\?token=/)
    expect(page).toContain('Sherlock Jr. on Friday')
  })

  it('puts a share link in both the html and text footers', async () => {
    await seedMember('foot@example.com', { newsletter: true })
    const { res, batch } = await captureSend(OK)
    const { permalink } = await res.json()
    expect(batch[0].html).toContain(permalink)
    expect(batch[0].html).toMatch(/View it in your browser/)
    expect(batch[0].text).toContain(`Share this: ${permalink}`)
  })

  it('renders the archive with a script-blocking CSP', async () => {
    // The body is operator-authored HTML on our own origin — a step up from a
    // mail client's sandbox — so nothing but styles and images may run.
    await seedMember('csp@example.com', { newsletter: true })
    const { res } = await captureSend(OK)
    const { permalink } = await res.json()
    const page = await SELF.fetch(permalink)
    expect(page.status).toBe(200)
    const csp = page.headers.get('Content-Security-Policy')
    expect(csp).toMatch(/default-src 'none'/)
    expect(csp).not.toMatch(/script-src/)      // nothing re-enables scripts
    expect(page.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('404s an unknown or malformed id without throwing', async () => {
    for (const id of ['nope', '../admin', 'A'.repeat(200), '']) {
      const res = await SELF.fetch(`https://join.jxnfilm.club/n/${id}`)
      expect(res.status).toBe(404)
    }
  })

  it('gives a test send a working permalink too', async () => {
    // A "view in browser" link that 404s would make the test send a liar.
    const { res } = await captureSend({ ...OK, testTo: 'me@example.com' })
    const { permalink, test } = await res.json()
    expect(test).toBe(true)
    expect((await SELF.fetch(permalink)).status).toBe(200)
  })

  it('records the archive id on the broadcast audit row', async () => {
    await seedMember('audit@example.com', { newsletter: true })
    const { res } = await captureSend(OK)
    const { permalink } = await res.json()
    const list = await env.MEMBERS_KV.list({ prefix: 'newsletter:sent:' })
    const row = JSON.parse(await env.MEMBERS_KV.get(list.keys.at(-1).name))
    expect(permalink).toContain(row.archiveId)
  })
})
