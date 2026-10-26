import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buttonsHtml, changesHtml, codeBlockHtml, emailShellHtml, eventCardHtml,
  fmtEmailDate, fmtEmailTime, mapUrl, notesHtml, transactionalEmailHtml,
} from '../../admin/email.js'

const ADMIN_JS = readFileSync(new URL('../../admin/admin.js', import.meta.url), 'utf8')
const NEWSLETTER_FIXTURE = readFileSync(new URL('./fixtures/newsletter-template.html', import.meta.url), 'utf8').replace(/\n$/, '')

const event = {
  id: 'e1', title: 'Test Screening', film: 'Crash', year: 1996, date: '2099-01-15', time: '19:30',
  venue: 'The Capri Theatre', poster: 'https://image.tmdb.org/t/p/w342/x.jpg',
  letterboxd_uri: 'https://letterboxd.com/film/crash/', hostId: 'm1', hostName: 'Wes',
  address: '123 Main St, Jackson, MS 39201',
}

describe('emailShellHtml', () => {
  // The fixture is the newsletter compose default as it was hand-written
  // before the shell existed. Fed that template's own body row, the shell
  // must reproduce it exactly — so the frame and header band every newsletter
  // already sent with are what the transactional mail now wears. The body row
  // comes from the fixture, not admin.js, so editing the placeholder copy
  // there is not a shell regression.
  it('reproduces the hand-written newsletter frame byte-for-byte', () => {
    const lines = NEWSLETTER_FIXTURE.split('\n')
    const bodyRow = lines.slice(9, -3).join('\n')  // 3 frame + 6 header lines in, 3 closing out
    expect(bodyRow.startsWith('      <tr>')).toBe(true)
    expect(emailShellHtml(bodyRow)).toBe(NEWSLETTER_FIXTURE)
  })

  it('is what the admin newsletter default is built from', () => {
    expect(ADMIN_JS).toMatch(/const NEWSLETTER_TEMPLATE_HTML = emailShellHtml\(`/)
  })

  it('places `after` below the card, inside the page background', () => {
    const out = emailShellHtml('<tr><td>x</td></tr>', { after: '<p>footer</p>' })
    expect(out.indexOf('<p>footer</p>')).toBeGreaterThan(out.lastIndexOf('    </table>'))
    expect(out.endsWith('</table>')).toBe(true)
  })
})

describe('formatting', () => {
  it('formats a calendar day without timezone drift', () => {
    expect(fmtEmailDate('2099-01-15')).toBe('Thursday, January 15, 2099')
    expect(fmtEmailDate('soon')).toBe('soon')
  })

  it('matches the Worker showtime format', () => {
    expect(fmtEmailTime('19:30')).toBe('7:30 pm')
    expect(fmtEmailTime('00:05')).toBe('12:05 am')
    expect(fmtEmailTime('')).toBe('')
  })

  it('builds a Google Maps search link', () => {
    expect(mapUrl('123 Main St, Jackson')).toBe('https://www.google.com/maps/search/?api=1&query=123%20Main%20St%2C%20Jackson')
  })
})

describe('eventCardHtml', () => {
  it('never reads event.address — only the explicit argument', () => {
    const out = eventCardHtml(event)
    expect(out).not.toContain('123 Main St')
    expect(out).toContain('The Capri Theatre')
    expect(out).toContain('Venue')
  })

  it('shows and map-links the address when the caller passes it', () => {
    const out = eventCardHtml(event, { address: event.address })
    expect(out).toContain('Address')
    expect(out).toContain(`href="${mapUrl(event.address).replaceAll('&', '&amp;')}"`)
    expect(out).not.toContain('The Capri Theatre')
  })

  it('carries film, date, showtime, and host', () => {
    const out = eventCardHtml(event)
    expect(out).toContain('Crash')
    expect(out).toContain('(1996)')
    expect(out).toContain('https://letterboxd.com/film/crash/')
    expect(out).toContain('Thursday, January 15, 2099 at 7:30 pm')
    expect(out).toContain('Wes')
  })

  it('asks TMDB for a mail-sized poster, not the original', () => {
    const out = eventCardHtml({ ...event, poster: 'https://image.tmdb.org/t/p/original/abc.jpg' })
    expect(out).toContain('https://image.tmdb.org/t/p/w342/abc.jpg')
    expect(out).not.toContain('/original/')
    expect(eventCardHtml({ ...event, poster: 'https://news.jxnfilm.club/nl/img/a.png' })).toContain('https://news.jxnfilm.club/nl/img/a.png')
  })

  it('drops the poster column when there is no poster', () => {
    expect(eventCardHtml(event)).toContain('<img')
    expect(eventCardHtml({ ...event, poster: '' })).not.toContain('<img')
  })

  it('dims the poster and labels a cancelled event', () => {
    const out = eventCardHtml(event, { cancelled: true })
    expect(out).toContain('Cancelled')
    expect(out).toContain('opacity:0.35')
    expect(eventCardHtml(event)).not.toContain('opacity')
  })

  it('escapes every caller string and refuses non-http URLs', () => {
    const out = eventCardHtml({
      title: '<script>alert(1)</script>', film: 'A & B', venue: '"Quoted"',
      poster: 'javascript:alert(1)', letterboxd_uri: 'data:text/html,x',
    })
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('A &amp; B')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('data:')
    expect(out).not.toContain('<img')
  })

  it('says TBD with no date', () => {
    expect(eventCardHtml({ title: 'X' })).toContain('TBD')
  })
})

describe('blocks', () => {
  it('drops buttons with no usable URL and outlines secondary ones', () => {
    const out = buttonsHtml([
      { href: '', label: 'Buy tickets' },
      { href: 'https://x.test/cancel?token=a&b', label: 'Cancel', secondary: true },
    ])
    expect(out).not.toContain('Buy tickets')
    expect(out).toContain('href="https://x.test/cancel?token=a&amp;b"')
    expect(out).toContain('background:#ffffff')
    expect(buttonsHtml([{ href: 'javascript:x', label: 'No' }])).toBe('')
  })

  it('strikes the old value and bolds the new one', () => {
    const out = changesHtml([{ field: 'Date', from: '2099-01-15', to: '2099-02-01' }, { field: 'Venue', from: '', to: 'Duling <Hall>' }])
    expect(out).toContain('<s style="color:#6b675f">2099-01-15</s>')
    expect(out).toContain('<strong style="color:#100f0e">2099-02-01</strong>')
    expect(out).toContain('(blank)')
    expect(out).toContain('>Date</td>')
    expect(out).toContain('Duling &lt;Hall&gt;')
    expect(changesHtml([])).toBe('')
  })

  it('keeps line breaks in notes, after escaping', () => {
    expect(notesHtml('Notes from the host', 'Buzzer 5\n<park> on street')).toContain('Buzzer 5<br>&lt;park&gt; on street')
  })

  it('renders the code large and monospaced with its expiry', () => {
    const out = codeBlockHtml('123456', 'Expires in 10 minutes')
    expect(out).toContain('>123456<')
    expect(out).toContain('monospace')
    expect(out).toContain('Expires in 10 minutes')
  })
})

describe('transactionalEmailHtml', () => {
  const out = transactionalEmailHtml({
    subject: 'You\'re in for <X>', preheader: 'Soon', eyebrow: 'Confirmed', heading: 'You\'re in for <X>',
    blocks: ['<p>block</p>', '', null], why: 'Because you RSVP\'d.', siteOrigin: 'https://jxnfilm.club',
  })

  it('is a full document with the shared header band', () => {
    expect(out.startsWith('<!doctype html>')).toBe(true)
    expect(out).toContain('https://jxnfilm.club/img/logo.png')
    expect(out).toContain('<title>You&#39;re in for &lt;X&gt;</title>')
  })

  it('has the footer: why, events, privacy — and no unsubscribe', () => {
    expect(out).toContain('Because you RSVP&#39;d.')
    expect(out).toContain('https://jxnfilm.club/events')
    expect(out).toContain('https://join.jxnfilm.club/privacy')
    expect(out.toLowerCase()).not.toContain('unsubscribe')
  })

  it('skips empty blocks', () => {
    expect(out).toContain('<p>block</p>')
    expect(out).not.toContain('null')
  })
})
