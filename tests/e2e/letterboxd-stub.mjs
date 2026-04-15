import { createServer } from 'node:http'

const port = Number(process.argv[2] || 8788)

// Tiny Letterboxd stand-in for E2E: only the handlers the Worker actually
// hits. Real handles return 200; `ghost` returns 404; RSS/lists are empty so
// signup/verify always reports the "token not present yet" 422 — that's the
// error path we test. Full verify happy-path is covered by vitest workers.
const server = createServer((req, res) => {
  const path = req.url || '/'

  if (path.startsWith('/ghost')) {
    res.writeHead(404); res.end('not found'); return
  }
  if (path.endsWith('/rss/')) {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' })
    res.end('<rss><channel><title>stub</title></channel></rss>')
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
