import { test, expect } from '@playwright/test'

// The site rendered BLANK in Firefox — every page, in production — for as long
// as nobody checked. Nue emits the module loader before the import map; the
// spec requires the map first. Chromium and WebKit tolerate the wrong order,
// Firefox refuses the map outright, the first bare specifier throws, and the
// SPA never mounts: <article> stays empty and document.body carries ~142
// characters of shell.
//
// The whole e2e suite ran chromium-only, so it was structurally incapable of
// seeing this. That is what this file is for — not /speak, not any feature,
// just "does the application boot in a second engine". Keep it cheap and keep
// it to that: the fake-microphone flag the rest of the suite needs is
// Chromium-only, and re-running feature logic in a second browser would buy
// almost nothing for double the wall clock.
//
// Runs against the BUILT site (see the firefox-dist project in
// playwright.config.ts), because the repair lives in postbuild.
test.describe('the site boots in a second engine', () => {
  // No sign-in, no worker: a page that fails this way fails before any of that.
  for (const path of ['/', '/speak', '/members', '/events']) {
    test(`${path} mounts and renders its view`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))

      await page.goto(path)

      // The masthead is server-rendered, so asserting on it alone would pass
      // even with a dead SPA. The nav links come from the mounted app.
      await expect(page.locator('.mastnav-links a')).toHaveCount(5)
      // The mount point is <article nue="...">; a mounted view is an element
      // inside it. Counted rather than checked for visibility — the first child
      // is not always a visible node — and 'article' alone is ambiguous once a
      // view has rendered an <article> of its own.
      await expect(page.locator('article[nue] > *')).not.toHaveCount(0)
      // The heading is rendered BY the view, so it is the cheap proof that the
      // mount produced content rather than an empty shell.
      await expect(page.locator('h1').first()).toBeVisible()

      // The specifier failure surfaces here and nowhere else — no request
      // 404s, no console error the naked eye would catch in a screenshot.
      expect(errors, `page errors on ${path}`).toEqual([])
    })
  }

  test('the import map precedes the module loader in the served HTML', async ({ page }) => {
    const res = await page.request.get('/')
    const html = await res.text()
    const map = html.indexOf('type="importmap"')
    const mod = html.indexOf('type="module"')
    expect(map, 'no import map in the built page').toBeGreaterThan(-1)
    expect(mod, 'no module script in the built page').toBeGreaterThan(-1)
    // The assertion the browser checks above, stated directly — so a failure
    // says WHY the pages went blank instead of only that they did.
    expect(map).toBeLessThan(mod)
  })
})
