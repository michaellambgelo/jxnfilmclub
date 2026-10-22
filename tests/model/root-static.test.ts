import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The root component (index.html) must never update() once a view is mounted.
//
// Views are mounted into the root template's <article>. A root update()
// re-renders the template and domdiffs it against the live DOM: the view's
// <article> survives (same tag) but loses its attributes and every child, and
// nothing remounts it. Opening the hamburger emptied /events on production
// (2026-10-22) exactly this way. See tests/e2e/root-update.spec.ts.
//
// Two ways in, both checked here:
//   - an explicit this.update() in the root's component script
//   - ANY :on handler in the root template, because nuedom wraps every
//     handler as exec(handler) then update() (nuedom/src/dom/node.js)
// Template expressions are checked too: with no update() they would render
// once and go stale, which is the hint that state belongs in a child
// component (see ui/masthead.html).

const src = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8')
const body = src.slice(src.indexOf('<body>'))
// Comments stripped: the script explains why it has no update() call.
const componentScript = body.slice(body.indexOf('<script>'), body.indexOf('</script>')).replace(/\/\/.*$/gm, '')
const markup = body.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '')

describe('index.html root stays static', () => {
  it('never calls update() on the root', () => {
    expect(componentScript).not.toMatch(/\bupdate\s*\(/)
  })

  it('binds no :on handlers in the root template', () => {
    expect(markup).not.toMatch(/\s:on[a-z]+=/)
  })

  it('reads no state in the root template', () => {
    expect(markup).not.toMatch(/\s:(?:if|hidden|each|bind|class|disabled)=/)
    expect(markup).not.toMatch(/\{[^}]*\}/)
  })
})
