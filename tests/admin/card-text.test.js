import { describe, expect, it } from 'vitest'
import {
  cardTextKey, cardTextSlots, cardTextValues, fillCardText, resolveCardText,
  setCardText, clearCardText, normalizeCardText, cleanCardText, cardTextForCopy,
  buildSocialCopy, CARD_TEXT_MAX,
} from '../../admin/lib.js'

const EVENT = {
  id: '2030-06-12-passion', title: 'Summer Screening', film: 'The Passion of Joan of Arc',
  year: 1928, date: '2030-06-12', time: '19:00', venue: 'The Vault',
  address: '1 Hidden Way', notes: 'gate code',
}
const DATA = { event: EVENT, count: 0, today: '2030-06-09' }
const slotOf = (kind, data, id) => cardTextSlots(kind, data).find(s => s.id === id)

describe('card wording: defaults reproduce what the cards always said', () => {
  it('announcement', () => {
    expect(resolveCardText('announce', DATA).text).toEqual({
      eyebrow: 'Jackson Film Club · Next screening',
      title: 'The Passion of Joan of Arc',
      year: '1928',
      when: 'Wednesday, June 12 · 7:00 pm',
      venue: 'The Vault',
      extra: '',
      footer: 'jxnfilm.club/events',
    })
  })

  it('countdown eyebrow counts down from today', () => {
    expect(resolveCardText('countdown', DATA).text.eyebrow).toBe('Jackson Film Club · 3 days away')
    expect(resolveCardText('countdown', { ...DATA, today: '2030-06-12' }).text.eyebrow).toBe('Jackson Film Club · Tonight')
  })

  it('an event with no time or venue leaves no stray separator', () => {
    const t = resolveCardText('announce', { event: { id: 'x', title: 'Mixer', date: '2030-06-12' } }).text
    expect(t.when).toBe('Wednesday, June 12')
    expect(t.venue).toBe('')
    expect(t.year).toBe('')
  })

  it('a hosted event with no venue says so, and never shows the address', () => {
    const t = resolveCardText('announce', { event: { ...EVENT, venue: '', hostId: 'id-1' } }).text
    expect(t.venue).toBe('Member-hosted screening')
    expect(JSON.stringify(t)).not.toContain('Hidden Way')
  })

  it('recap offers the count lines only when there is a count', () => {
    expect(cardTextSlots('recap', { ...DATA, count: 12 }).map(s => s.id))
      .toEqual(['eyebrow', 'unit1', 'unit2', 'title', 'year', 'extra', 'footer'])
    expect(cardTextSlots('recap', DATA).map(s => s.id))
      .toEqual(['eyebrow', 'lead', 'title', 'year', 'extra', 'footer'])
  })

  it('the list and promo cards', () => {
    expect(resolveCardText('roundup', { films: [], total: 1 }).text.sub).toBe('1 film logged by members in the last week')
    expect(resolveCardText('roundup', { films: [], total: 9 }).text.sub).toBe('9 films logged by members in the last week')
    expect(resolveCardText('monthwrap', { month: '2030-05', monthLabel: 'May 2030', screenings: 2, attendees: 31 }).text)
      .toMatchObject({ heading: 'That was May 2030', sub: '2 screenings · 31 attendees' })
    expect(resolveCardText('monthwrap', { month: '2030-05', monthLabel: 'May 2030', screenings: 1, attendees: 0 }).text.sub)
      .toBe('1 screening')
    expect(resolveCardText('diary', { from: '2030-03-12', to: '2030-04-03', page: 2, pageCount: 5 }).text.meta)
      .toBe('Mar 12 – Apr 3, 2030 · Page 2 of 5')
    expect(resolveCardText('diary', { page: 1, pageCount: 1 }).text.meta).toBe('Page 1 of 1')
    expect(resolveCardText('voice', { prompt: { id: 'p', text: 'Q?', deadline: '2030-07-01' } }).text.sub)
      .toBe('Record or upload up to three minutes by Mon, Jul 1.')
    expect(resolveCardText('voice', { prompt: { id: 'p', text: 'Q?' } }).text.sub)
      .toBe('Record or upload up to three minutes.')
    expect(resolveCardText('milestone', { stat: 'attendance', value: 500 }).text)
      .toMatchObject({ unit1: 'SEATS', unit2: 'FILLED', thanks: 'Thank you, Jackson.' })
    expect(resolveCardText('episode', { episode: { title: 'Ep 9', date: '2030-06-12' } }).text)
      .toMatchObject({ title: 'Ep 9', date: 'Wednesday, June 12', cta: 'LISTEN WHEREVER YOU GET PODCASTS' })
    expect(resolveCardText('lineup', { events: [] }).text.heading).toBe('Coming up at the club')
  })

  it('the no-film event poster has no editable wording', () => {
    expect(cardTextSlots('titlecard', DATA)).toEqual([])
    expect(cardTextKey('titlecard', DATA)).toBeNull()
  })
})

describe('card wording: where it is saved', () => {
  it('one key per item', () => {
    expect(cardTextKey('announce', DATA)).toBe('cardtext:event:2030-06-12-passion')
    expect(cardTextKey('countdown', DATA)).toBe('cardtext:event:2030-06-12-passion')
    expect(cardTextKey('recap', DATA)).toBe('cardtext:event:2030-06-12-passion')
    expect(cardTextKey('announce', {})).toBeNull()
    expect(cardTextKey('monthwrap', { month: '2030-05' })).toBe('cardtext:monthwrap:2030-05')
    expect(cardTextKey('milestone', { stat: 'screenings' })).toBe('cardtext:milestone:screenings')
    expect(cardTextKey('milestone', { stat: 'bogus' })).toBe('cardtext:milestone:members')
    expect(cardTextKey('voice', { prompt: { id: 'Best Of 2030' } })).toBe('cardtext:voice:best-of-2030')
    expect(cardTextKey('episode', { episode: { title: 'Ep 9', url: 'https://pod.example/ep/9' } }))
      .toBe('cardtext:episode:https-pod-example-ep-9')
    // Real episode URLs share a prefix longer than the key: the tail must survive.
    const base = 'https://podcasters.spotify.com/pod/show/jxnfilmclub/episodes/'
    const a = cardTextKey('episode', { episode: { url: `${base}the-muppets-appreciation-hour-e2abc` } })
    const b = cardTextKey('episode', { episode: { url: `${base}a-love-letter-for-animation-e2xyz` } })
    expect(a).not.toBe(b)
    expect(a.endsWith('the-muppets-appreciation-hour-e2abc')).toBe(true)
    expect(cardTextKey('episode', { episode: {} })).toBeNull()
    for (const k of ['lineup', 'roundup', 'diary']) expect(cardTextKey(k, {})).toBe(`cardtext:${k}`)
  })

  it('the three event posts share title, date, venue and footer but not the eyebrow', () => {
    const store = (kind, id) => slotOf(kind, { ...DATA, count: 3 }, id).store
    expect(store('announce', 'title')).toBe(store('recap', 'title'))
    expect(store('announce', 'footer')).toBe(store('recap', 'footer'))
    expect(store('announce', 'extra')).toBe(store('countdown', 'extra'))
    expect(new Set([store('announce', 'eyebrow'), store('countdown', 'eyebrow'), store('recap', 'eyebrow')]).size).toBe(3)
    // "Sold out" on the announcement must not follow the event onto its recap.
    expect(store('recap', 'extra')).not.toBe(store('announce', 'extra'))
  })
})

describe('card wording: rewording a line', () => {
  it('stores only what differs from the default, and drops it again when typed back', () => {
    const when = slotOf('announce', DATA, 'when')
    let saved = setCardText({}, when, '{date} · Doors at 7')
    expect(saved).toEqual({ when: '{date} · Doors at 7' })
    expect(resolveCardText('announce', DATA, saved).text.when).toBe('Wednesday, June 12 · Doors at 7')
    saved = setCardText(saved, when, '{date} · {time}')
    expect(saved).toEqual({})
  })

  it('a reworded line keeps following the data through its tokens', () => {
    const saved = { 'countdown.eyebrow': 'JXN Film Club · {countdown}' }
    expect(resolveCardText('countdown', DATA, saved).text.eyebrow).toBe('JXN Film Club · 3 days away')
    expect(resolveCardText('countdown', { ...DATA, today: '2030-06-11' }, saved).text.eyebrow).toBe('JXN Film Club · Tomorrow')
    const moved = { ...DATA, event: { ...EVENT, date: '2030-06-13' } }
    expect(resolveCardText('announce', moved, { when: '{date} · Doors at 7' }).text.when).toBe('Thursday, June 13 · Doors at 7')
  })

  it('an empty line is a real value: it removes the line', () => {
    const venue = slotOf('announce', DATA, 'venue')
    const saved = setCardText({}, venue, '')
    expect(saved).toEqual({ venue: '' })
    const r = resolveCardText('announce', DATA, saved)
    expect(r.text.venue).toBe('')
    expect(r.slots.find(s => s.id === 'venue').edited).toBe(true)
  })

  it('the extra line is empty by default and clearing it stores nothing', () => {
    const extra = slotOf('announce', DATA, 'extra')
    const saved = setCardText({}, extra, 'Free with RSVP')
    expect(resolveCardText('announce', DATA, saved).text.extra).toBe('Free with RSVP')
    expect(setCardText(saved, extra, '')).toEqual({})
  })

  it('reset clears this card and leaves the other posts own lines alone', () => {
    const saved = { title: 'Joan', 'announce.eyebrow': 'A', 'recap.eyebrow': 'R', 'recap.extra': 'Thanks' }
    expect(clearCardText(saved, cardTextSlots('announce', DATA))).toEqual({ 'recap.eyebrow': 'R', 'recap.extra': 'Thanks' })
  })

  it('marks which slots are reworded', () => {
    const r = resolveCardText('announce', DATA, { title: 'Joan', when: '{date} · {time}' })
    expect(r.slots.filter(s => s.edited).map(s => s.id)).toEqual(['title'])
    expect(r.tokens).toContain('countdown')
  })
})

describe('card wording: untrusted input', () => {
  it('fillCardText leaves unknown tokens and literal braces alone', () => {
    expect(fillCardText('{nope} and {date}', { date: 'Fri' })).toBe('{nope} and Fri')
    expect(fillCardText('{ not a token }', {})).toBe('{ not a token }')
  })

  it('tidies separators stranded by an empty token, but not ones the operator typed', () => {
    expect(fillCardText('{date} · {time}', { date: 'Fri', time: '' })).toBe('Fri')
    expect(fillCardText('{a} · {b} · {c}', { a: 'A', b: '', c: 'C' })).toBe('A · C')
    expect(fillCardText('{title} ({year})', { title: 'M', year: '' })).toBe('M')
    expect(fillCardText('Doors — 7', {})).toBe('Doors — 7')
  })

  it('a saved row is reduced to a flat map of capped, single-line strings', () => {
    expect(normalizeCardText({ title: 'ok', bad: 4, nested: { a: 1 }, 'Weird Key!': 'x', when: 'a\nb' }))
      .toEqual({ title: 'ok', when: 'a b' })
    expect(normalizeCardText('nope')).toEqual({})
    expect(normalizeCardText(['a'])).toEqual({})
    expect(cleanCardText('x'.repeat(500))).toHaveLength(CARD_TEXT_MAX)
  })

  it('token values never include private event fields', () => {
    expect(JSON.stringify(cardTextValues('announce', DATA))).not.toMatch(/Hidden Way|gate code/)
  })
})

describe('captions follow reworded image text', () => {
  it('an untouched event leaves the captions exactly as they were', () => {
    expect(cardTextForCopy('announce', DATA, {})).toBeNull()
    expect(cardTextForCopy('announce', DATA, { 'announce.eyebrow': 'X', footer: 'y', extra: 'z' })).toBeNull()
    for (const p of ['instagram', 'facebook', 'discord', 'bluesky', 'x']) {
      expect(buildSocialCopy('announce', p, { ...DATA, text: null })).toBe(buildSocialCopy('announce', p, DATA))
    }
  })

  it('title, year, date line and venue carry into every platform', () => {
    const saved = { title: 'Joan of Arc', year: '', when: '{date} · Doors at 7', venue: 'The Vault, upstairs' }
    const text = cardTextForCopy('announce', DATA, saved)
    expect(text).toEqual({
      name: 'Joan of Arc', year: '', when: 'Wednesday, June 12 · Doors at 7',
      whenShort: 'Wed, Jun 12 · Doors at 7', venue: 'The Vault, upstairs',
    })
    const ig = buildSocialCopy('announce', 'instagram', { ...DATA, text })
    expect(ig).toContain('\nJoan of Arc\n📅 Wednesday, June 12 · Doors at 7\n📍 The Vault, upstairs')
    expect(ig).not.toContain('1928')
    const x = buildSocialCopy('announce', 'x', { ...DATA, text })
    expect(x).toContain('Joan of Arc\n📅 Wed, Jun 12 · Doors at 7 · The Vault, upstairs')
  })

  it('a removed date or venue line is removed from the caption, not left as a bare emoji', () => {
    const text = cardTextForCopy('announce', DATA, { when: '', venue: '' })
    const fb = buildSocialCopy('announce', 'facebook', { ...DATA, text })
    expect(fb).not.toMatch(/📅|📍/)
    expect(buildSocialCopy('announce', 'bluesky', { ...DATA, text })).not.toMatch(/📅|📍/)
  })

  it('the recap, which has no date line of its own, still uses the reworded title', () => {
    const text = cardTextForCopy('recap', { ...DATA, count: 12 }, { title: 'Joan', venue: 'the Vault' })
    expect(text).toEqual({ name: 'Joan', venue: 'the Vault' })
    expect(buildSocialCopy('recap', 'facebook', { ...DATA, count: 12, text }))
      .toContain("That's a wrap on Joan (1928). 12 of us came out to the Vault.")
  })

  it('other cards do not feed captions', () => {
    expect(cardTextForCopy('roundup', { films: [], total: 2 }, { heading: 'X' })).toBeNull()
  })
})
