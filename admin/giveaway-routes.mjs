// Admin-portal -> join-Worker mapping for the Giveaways tab, shared by the
// hosted admin Worker (admin/worker/src/index.js) and the local dashboard
// (admin/server.mjs) so the two cannot drift. Every giveaway write goes
// through the join Worker's /admin/giveaways routes — never a raw D1 or KV
// write — so validation, the draw's transaction and the audit log all hold.
//
//   GET  /api/giveaways?env=[&event=]            list (drafts included)
//   PUT  /api/giveaways?env=&id=                 create / update
//   GET  /api/giveaways/entries?env=&id=         entries + counts by source
//   POST /api/giveaways/entry?env=&id=&entry=    { excluded }
//   POST /api/giveaways/draw?env=&id=            { excludeFlagged }
//   POST /api/giveaways/redraw?env=&id=          { memberId, excludeFlagged }
//   POST /api/giveaways/record-winners?env=&id=  Instagram: { winners, note } / { replaces, winners }
//   GET  /api/giveaways/winners?env=&id=         winners + draw log
//   GET  /api/giveaways/winners.csv?env=&id=[&format=boxoffice]

const ACTIONS = {
  'GET /api/giveaways/entries': 'entries',
  'POST /api/giveaways/draw': 'draw',
  'POST /api/giveaways/redraw': 'redraw',
  'POST /api/giveaways/record-winners': 'record-winners',
  'GET /api/giveaways/winners': 'winners',
  'GET /api/giveaways/winners.csv': 'winners.csv',
}

// -> { path, method, csv } or null when the request is not a giveaway route.
// Throws { status, message } for a malformed one.
export function giveawayRoute(method, pathname, q) {
  if (!pathname.startsWith('/api/giveaways')) return null
  const bad = message => { const e = new Error(message); e.status = 400; throw e }
  const id = q.id ? encodeURIComponent(q.id) : null

  if (pathname === '/api/giveaways' && method === 'GET') {
    return { path: `/admin/giveaways${q.event ? `?event=${encodeURIComponent(q.event)}` : ''}`, method, csv: false }
  }
  if (pathname === '/api/giveaways' && method === 'PUT') {
    if (!id) bad('id required')
    return { path: `/admin/giveaways/${id}`, method, csv: false }
  }
  if (pathname === '/api/giveaways/entry' && method === 'POST') {
    if (!id) bad('id required')
    if (!/^[0-9]+$/.test(q.entry || '')) bad('entry required')
    return { path: `/admin/giveaways/${id}/entries/${q.entry}`, method, csv: false }
  }
  const action = ACTIONS[`${method} ${pathname}`]
  if (!action) return null
  if (!id) bad('id required')
  const format = action === 'winners.csv' && q.format === 'boxoffice' ? '?format=boxoffice' : ''
  return { path: `/admin/giveaways/${id}/${action}${format}`, method, csv: action === 'winners.csv' }
}
