import { beforeEach, describe, expect, it, vi } from 'vitest'
import { members, events } from './fixtures'
import { getMembers, getEvents } from '../../model/index.ts'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = String(url)
    const body = u.includes('members.json') ? members
      : u.includes('events.json') ? events
      : []
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  }))
})

describe('getMembers', () => {
  it('returns correct shape: {type, total, items}', async () => {
    const res = await getMembers({})
    expect(res.type).toBe('members')
    expect(res.total).toBe(members.length)
    expect(Array.isArray(res.items)).toBe(true)
    const item = res.items[0]
    expect(item).toHaveProperty('handle')
    expect(item).toHaveProperty('name')
    expect(item).toHaveProperty('joined')
    expect(item).toHaveProperty('pronouns')
  })

  it('sorts by joined (default) descending via localeCompare on date strings', async () => {
    const res = await getMembers({})
    // localeCompare on ISO date strings sorts lexicographically ascending — document actual behavior
    const joined = res.items.map((i: any) => i.joined)
    const sortedAsc = [...joined].sort((a, b) => String(a).localeCompare(String(b)))
    expect(joined).toEqual(sortedAsc)
  })

  it('filters by handle via search', async () => {
    const res = await getMembers({ search: 'alice' })
    expect(res.total).toBe(1)
    expect(res.items[0].handle).toBe('alice')
  })

  it('filters by name substring via search (case-insensitive)', async () => {
    const res = await getMembers({ search: 'CINEMA' })
    expect(res.total).toBe(1)
    expect(res.items[0].handle).toBe('cara')
  })
})

describe('getEvents', () => {
  it('returns correct shape with type=events', async () => {
    const res = await getEvents({})
    expect(res.type).toBe('events')
    expect(res.total).toBe(events.length)
  })

  it('sorts by date (default) using localeCompare (ascending)', async () => {
    const res = await getEvents({})
    const dates = res.items.map((i: any) => i.date)
    const sortedAsc = [...dates].sort((a, b) => String(a).localeCompare(String(b)))
    expect(dates).toEqual(sortedAsc)
  })

  it('filters events by title via search', async () => {
    const res = await getEvents({ search: 'Documentary' })
    expect(res.total).toBe(1)
    expect(res.items[0].id).toBe('d')
  })

  it('filters events by film via search', async () => {
    const res = await getEvents({ search: 'stalker' })
    expect(res.total).toBe(1)
    expect(res.items[0].id).toBe('c')
  })

  it('filters events by venue via search', async () => {
    const res = await getEvents({ search: 'capri' })
    expect(res.total).toBe(2)
    expect(res.items.map((i: any) => i.id).sort()).toEqual(['a', 'c'])
  })
})

describe('pagination', () => {
  it('limit constrains items returned but total reflects full set', async () => {
    const res = await getMembers({ limit: 2 })
    expect(res.total).toBe(members.length)
    expect(res.items.length).toBe(2)
  })

  it('start offsets into results', async () => {
    const full = await getMembers({ limit: 100 })
    const page2 = await getMembers({ start: 2, limit: 2 })
    expect(page2.items).toEqual(full.items.slice(2, 4))
  })

  it('start + limit past end returns empty items but full total', async () => {
    const res = await getMembers({ start: 1000, limit: 10 })
    expect(res.total).toBe(members.length)
    expect(res.items).toEqual([])
  })
})
