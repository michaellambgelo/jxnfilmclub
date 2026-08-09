import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

// Brand parity for every HTML surface the Worker serves: same favicon as the
// main site, shared "Night Shift" tokens, no unresolved template placeholders,
// and none of the old off-brand styling on the JS-built pages.

function get(path, headers = {}) {
  return SELF.fetch(`https://join.jxnfilm.club${path}`, { headers })
}

describe('GET /favicon.ico', () => {
  it('serves the icon first-party', async () => {
    const res = await get('/favicon.ico')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/x-icon')
    const bytes = new Uint8Array(await res.arrayBuffer())
    // ICO magic: reserved 0x0000, type 0x0001
    expect([...bytes.slice(0, 4)]).toEqual([0, 0, 1, 0])
  })
})

describe('branded static pages', () => {
  for (const path of ['/', '/privacy']) {
    it(`${path} carries the favicon and brand tokens, fully rendered`, async () => {
      const res = await get(path)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('rel="icon"')
      expect(body).toContain('--brand: #d7321f')
      expect(body).toContain('logo-word')
      expect(body).toContain('site-footer')
      expect(body).not.toContain('%BRAND_CSS%')
      expect(body).not.toContain('%SITE_ORIGIN%')
    })
  }
})

describe('GET /privacy/version', () => {
  it('returns the same revision date the served policy page carries', async () => {
    // Self-syncing: extract the date from the rendered /privacy page rather
    // than hardcoding it, so a policy bump can never desync this test (or
    // pass while the endpoint serves a stale constant).
    const page = await (await get('/privacy')).text()
    const fromPage = page.match(/Last updated: (\d{4}-\d{2}-\d{2})/)
    expect(fromPage).toBeTruthy()

    const res = await get('/privacy/version')
    expect(res.status).toBe(200)
    const { updated } = await res.json()
    expect(updated).toBe(fromPage[1])
  })
})

describe('branded JS-built pages', () => {
  for (const path of ['/unsubscribe?token=bad', '/rsvp/cancel?token=bad']) {
    it(`${path} uses the shared shell, not the old off-brand styles`, async () => {
      const res = await get(path)
      const body = await res.text()
      expect(body).toContain('logo-word')
      expect(body).toContain('--brand: #d7321f')
      expect(body).toContain('rel="icon"')
      expect(body).not.toContain('system-ui')
      expect(body).not.toContain('#0a58ca')
    })
  }
})

describe('404 fallthrough', () => {
  it('serves a branded page to browsers', async () => {
    const res = await get('/no-such-page', { Accept: 'text/html,application/xhtml+xml' })
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('logo-word')
    expect(body).toContain('Not found')
  })

  it('stays plain text for API callers', async () => {
    const res = await get('/no-such-page')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).not.toContain('text/html')
    expect(await res.text()).toBe('Not Found')
  })
})
