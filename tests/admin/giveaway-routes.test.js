import { describe, it, expect } from 'vitest'
import { giveawayRoute } from '../../admin/giveaway-routes.mjs'

// giveawayRoute() is the one admin-portal -> join-Worker route table shared by
// admin/server.mjs and admin/worker/src/index.js. These pin its branches.

const status = fn => {
  try { fn() } catch (e) { return [e.status, e.message] }
  return null
}

describe('giveawayRoute', () => {
  it('returns null for non-giveaway paths and unknown giveaway actions', () => {
    expect(giveawayRoute('GET', '/api/events', {})).toBeNull()
    expect(giveawayRoute('GET', '/api/giveaways/nope', { id: 'g1' })).toBeNull()
    expect(giveawayRoute('POST', '/api/giveaways', { id: 'g1' })).toBeNull()
    // method matters: draw is POST-only
    expect(giveawayRoute('GET', '/api/giveaways/draw', { id: 'g1' })).toBeNull()
  })

  it('lists, with an optional encoded event filter', () => {
    expect(giveawayRoute('GET', '/api/giveaways', {}))
      .toEqual({ path: '/admin/giveaways', method: 'GET', csv: false })
    expect(giveawayRoute('GET', '/api/giveaways', { event: 'a b&c' }).path)
      .toBe('/admin/giveaways?event=a%20b%26c')
  })

  it('PUT and DELETE need an id, which is encoded', () => {
    expect(status(() => giveawayRoute('PUT', '/api/giveaways', {}))).toEqual([400, 'id required'])
    expect(status(() => giveawayRoute('DELETE', '/api/giveaways', {}))).toEqual([400, 'id required'])
    expect(giveawayRoute('PUT', '/api/giveaways', { id: 'a/b' }))
      .toEqual({ path: '/admin/giveaways/a%2Fb', method: 'PUT', csv: false })
  })

  it('DELETE passes force only when force=1', () => {
    expect(giveawayRoute('DELETE', '/api/giveaways', { id: 'g1' }).path).toBe('/admin/giveaways/g1')
    expect(giveawayRoute('DELETE', '/api/giveaways', { id: 'g1', force: '1' }).path)
      .toBe('/admin/giveaways/g1?force=1')
    expect(giveawayRoute('DELETE', '/api/giveaways', { id: 'g1', force: 'true' }).path)
      .toBe('/admin/giveaways/g1')
  })

  it('entry toggle needs an id and a numeric entry', () => {
    expect(status(() => giveawayRoute('POST', '/api/giveaways/entry', { entry: '3' })))
      .toEqual([400, 'id required'])
    expect(status(() => giveawayRoute('POST', '/api/giveaways/entry', { id: 'g1' })))
      .toEqual([400, 'entry required'])
    expect(status(() => giveawayRoute('POST', '/api/giveaways/entry', { id: 'g1', entry: '3/../x' })))
      .toEqual([400, 'entry required'])
    expect(giveawayRoute('POST', '/api/giveaways/entry', { id: 'g1', entry: '42' }))
      .toEqual({ path: '/admin/giveaways/g1/entries/42', method: 'POST', csv: false })
  })

  it.each([
    ['GET', 'entries'],
    ['GET', 'entrants'],
    ['POST', 'entrants'],
    ['POST', 'draw'],
    ['POST', 'redraw'],
    ['POST', 'record-winners'],
    ['GET', 'winners'],
  ])('%s %s maps to the per-giveaway action and requires an id', (method, action) => {
    expect(giveawayRoute(method, `/api/giveaways/${action}`, { id: 'g1' }))
      .toEqual({ path: `/admin/giveaways/g1/${action}`, method, csv: false })
    expect(status(() => giveawayRoute(method, `/api/giveaways/${action}`, {})))
      .toEqual([400, 'id required'])
  })

  it('winners.csv is flagged csv and forwards only format=boxoffice', () => {
    expect(giveawayRoute('GET', '/api/giveaways/winners.csv', { id: 'g1' }))
      .toEqual({ path: '/admin/giveaways/g1/winners.csv', method: 'GET', csv: true })
    expect(giveawayRoute('GET', '/api/giveaways/winners.csv', { id: 'g1', format: 'boxoffice' }).path)
      .toBe('/admin/giveaways/g1/winners.csv?format=boxoffice')
    expect(giveawayRoute('GET', '/api/giveaways/winners.csv', { id: 'g1', format: 'evil' }).path)
      .toBe('/admin/giveaways/g1/winners.csv')
  })
})
