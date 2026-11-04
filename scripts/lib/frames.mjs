// Browser-rendered frames for the video CLIs (make_audiogram, make_reel).
// Homebrew's ffmpeg has no drawtext (the formula dropped freetype), so the
// browser is the text renderer and ffmpeg never draws type.
//
// tokens.css references /fonts/… with absolute URLs, so file:// pages load no
// fonts. startServer serves an allowlist of repo directories plus instantiated
// frame HTML from memory; nothing ever binds beyond 127.0.0.1.

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'

const MIME = {
  '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml',
}

// frames: Map<key, html> served at /frame/<key>. allow: repo-relative dirs.
export function startServer(frames, { repoRoot, allow = ['css', 'fonts'] }) {
  const roots = allow.map(d => join(repoRoot, d))
  return new Promise((resolveStart, rejectStart) => {
    const srv = createServer(async (req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      if (path.startsWith('/frame/')) {
        const html = frames.get(path.slice('/frame/'.length))
        if (html === undefined) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(html)
        return
      }
      const file = resolve(repoRoot, path.slice(1))
      if (!roots.some(r => file.startsWith(r + '/'))) { res.writeHead(404); res.end(); return }
      try {
        const data = await readFile(file)
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
        res.end(data)
      } catch {
        res.writeHead(404)
        res.end()
      }
    })
    srv.on('error', rejectStart)
    srv.listen(0, '127.0.0.1', () => resolveStart(srv))
  })
}

// Throws with an install hint; callers decide how to exit.
export async function launchChromium() {
  try {
    const { chromium } = await import('playwright')
    return await chromium.launch()
  } catch (err) {
    throw new Error(`could not launch headless Chromium (needed to render the branded frame): ${err.message}\n` +
      'If the browser binaries are missing, install them with: npx playwright install chromium')
  }
}

// Load one instantiated frame and screenshot it. transparent → omitBackground,
// so the PNG composites over video/waveform.
export async function screenshotHtml(page, port, frames, html, { width, height, path, transparent = true }) {
  const key = `${frames.size}.html`
  frames.set(key, html)
  await page.setViewportSize({ width, height })
  await page.goto(`http://127.0.0.1:${port}/frame/${key}`, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))))
  await page.screenshot({ path, omitBackground: transparent })
}
