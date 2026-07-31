import { chromium } from 'playwright'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const URL = process.argv[2] || 'https://jxnfilm.club/'
const userDir = mkdtempSync(join(tmpdir(), 'pw-'))
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: true,
  args: ['--disable-cache', '--disk-cache-size=0'],
})
const page = await ctx.newPage()

page.on('console', async (m) => {
  const args = await Promise.all(m.args().map(a => a.jsonValue().catch(() => '<unserializable>')))
  console.log(`[${m.type()}]`, ...args)
})
page.on('pageerror', e => console.log('[pageerror]', e.message, e.stack?.split('\n').slice(0, 4).join(' | ')))

console.log('GET', URL)
await page.goto(URL, { waitUntil: 'networkidle', timeout: 20000 })
await page.waitForTimeout(2000)

console.log('---NAV LINKS---')
console.log(await page.evaluate(() => [...document.querySelectorAll('nav a')].map(a => `${a.textContent.trim()} -> ${a.href}`)))
console.log('---BODY (first 500 chars)---')
console.log(await page.evaluate(() => document.body.innerText.slice(0, 500)))

await ctx.close()
rmSync(userDir, { recursive: true, force: true })
