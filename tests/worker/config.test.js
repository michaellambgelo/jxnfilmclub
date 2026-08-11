import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

// GET /config — public projection of the operator-editable config:* keys in
// MEMBERS_KV (written by the admin portal's generic KV editor). Contract:
// each of { theaters, podcast, copy, voice_prompt } is the parsed KV value or
// null when the key is missing or unparseable; config:newsletter_template is
// admin-only and never appears; bad KV content must never 500 the endpoint.

function getConfig() {
  return SELF.fetch('https://join.jxnfilm.club/config')
}

const PODCAST = {
  featured_id: '2lTN7uSNEil7AoTEDzbEZs',
  episodes: [
    { title: 'Test Episode', date: '2026-07-31', url: 'https://example.com/ep1' },
  ],
}

describe('GET /config', () => {
  it('empty KV → 200 with all nulls, CORS like the other public GETs', async () => {
    const res = await getConfig()
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://jxnfilm.club')
    expect(await res.json()).toEqual({ theaters: null, podcast: null, copy: null, voice_prompt: null })
  })

  it('seeded keys round-trip verbatim', async () => {
    const theaters = ['Duling Hall', 'The Capri Theater']
    const copy = { hero_title: 'Welcome to the club', events_blurb: 'See you there' }
    const voicePrompt = { id: 'aug-2026', text: 'Best theater snack?', deadline: '2026-08-31' }
    await env.MEMBERS_KV.put('config:theaters', JSON.stringify(theaters))
    await env.MEMBERS_KV.put('config:podcast', JSON.stringify(PODCAST))
    await env.MEMBERS_KV.put('config:copy', JSON.stringify(copy))
    await env.MEMBERS_KV.put('config:voice_prompt', JSON.stringify(voicePrompt))

    const data = await (await getConfig()).json()
    expect(data.theaters).toEqual(theaters)
    expect(data.podcast).toEqual(PODCAST)
    expect(data.copy).toEqual(copy)
    // Raw, not defaulted — the SPA applies the standing default itself.
    expect(data.voice_prompt).toEqual(voicePrompt)
  })

  it('invalid JSON in one key → null for that key, others unaffected, no 500', async () => {
    await env.MEMBERS_KV.put('config:theaters', 'not json {')
    await env.MEMBERS_KV.put('config:copy', JSON.stringify({ hero_title: 'Fine' }))

    const res = await getConfig()
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.theaters).toBeNull()
    expect(data.copy).toEqual({ hero_title: 'Fine' })
    expect(data.podcast).toBeNull()
  })

  it('shape-invalid theaters are projected as null, never rendered raw', async () => {
    // Parseable JSON but not a valid allowlist: the SPA must not render
    // entries the worker validation would reject (QA defect 2026-08-10).
    for (const bad of [['', 'Ghost Cinema'], [], [1, 2], { list: [] }]) {
      await env.MEMBERS_KV.put('config:theaters', JSON.stringify(bad))
      const data = await (await getConfig()).json()
      expect(data.theaters).toBeNull()
    }
    // Entries come back trimmed, matching what validation enforces.
    await env.MEMBERS_KV.put('config:theaters', JSON.stringify(['  Duling Hall  ']))
    const data = await (await getConfig()).json()
    expect(data.theaters).toEqual(['Duling Hall'])
  })

  it('config:newsletter_template is never exposed', async () => {
    await env.MEMBERS_KV.put('config:newsletter_template', JSON.stringify({
      subject: 'Monthly digest', html: '<h1>Secret draft</h1>',
    }))
    const data = await (await getConfig()).json()
    expect(Object.keys(data).sort()).toEqual(['copy', 'podcast', 'theaters', 'voice_prompt'])
    expect(JSON.stringify(data)).not.toContain('Secret draft')
  })
})
