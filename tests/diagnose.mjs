import { chromium } from 'playwright'

const URL = process.argv[2] || 'https://jxnfilm.club/'
const browser = await chromium.launch()
const ctx = await browser.newContext()
const page = await ctx.newPage()

page.on('console', async (m) => {
  const args = await Promise.all(m.args().map(a => a.jsonValue().catch(() => '<unserializable>')))
  console.log(`[${m.type()}]`, ...args)
})
page.on('pageerror', e => console.log('[pageerror]', e.message, e.stack?.split('\n').slice(0, 4).join(' | ')))

console.log('GET', URL)
await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 })
await page.waitForTimeout(800)

console.log('---BODY---')
console.log(await page.evaluate(() => document.body.innerHTML.slice(0, 2000)))

await browser.close()
