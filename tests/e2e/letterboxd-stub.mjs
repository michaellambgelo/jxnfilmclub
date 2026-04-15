import { createServer } from 'node:http'

const port = Number(process.argv[2] || 8788)

// Tiny Letterboxd stand-in for E2E.
//
// - GET /<handle>/        → 200 stub profile (404 for "ghost")
// - GET /<handle>/rss/    → 200 RSS body. If a token has been primed via
//                           POST /__prime, embed it in a <category>; else
//                           empty feed.
// - GET /<handle>/lists/  → 200 empty HTML (kept for older paths)
// - POST /__prime         → { token?: string } — set or clear the token
//                           that should appear on the next RSS fetch
// - DELETE /__prime       → clear

let primedToken = null

function body(req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', c => buf += c)
    req.on('end', () => resolve(buf))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const path = req.url || '/'

  if (path === '/__prime') {
    if (req.method === 'POST') {
      const raw = await body(req)
      try {
        primedToken = JSON.parse(raw || '{}').token || null
      } catch { primedToken = null }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, primedToken }))
      return
    }
    if (req.method === 'DELETE') {
      primedToken = null
      res.writeHead(200); res.end(); return
    }
    res.writeHead(405); res.end(); return
  }

  if (path.startsWith('/ghost')) {
    res.writeHead(404); res.end('not found'); return
  }
  if (path.endsWith('/rss/')) {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' })
    if (primedToken) {
      res.end(`<rss><channel><item><category>${primedToken}</category></item></channel></rss>`)
    } else {
      res.end('<rss><channel><title>stub</title></channel></rss>')
    }
    return
  }
  if (path.endsWith('/lists/')) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html><body>no lists</body></html>')
    return
  }
  // Default: any /<handle>/ returns a 200 stub profile
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<html><body>stub profile</body></html>')
})

server.listen(port, () => {
  console.log(`[letterboxd-stub] listening on :${port}`)
})
