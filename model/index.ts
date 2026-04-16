
const is_browser = typeof window == 'object'

async function fetchJson(path: string) {
  const url = is_browser ? `./${path}` : `file:${process.cwd()}/${path}`
  const res = await fetch(url)
  return await res.json()
}

export async function getMembers(opts = {}) {
  return getList('members', opts)
}

export async function getEvents(opts = {}) {
  return getList('events', opts)
}

async function getList(type: string, opts: any) {
  const { start = 0, limit = 30, sort, search, venue } = opts || {}

  let items = await fetchJson(`data/${type}.json`)
  const defaultSort = type === 'events' ? 'date' : 'joined'
  sortBy(sort || defaultSort, items)

  if (search) {
    const s = search.toLowerCase()
    const has = (v: any) => typeof v == 'string' && v.toLowerCase().includes(s)
    items = items.filter((el: any) =>
      has(el.name) || has(el.handle) || has(el.title) || has(el.film) || has(el.venue)
    )
  }

  if (venue) {
    items = items.filter((el: any) => el.venue === venue)
  }

  return { type, total: items.length, items: items.slice(start, start + limit) }
}

function sortBy(spec: string, arr: any[]) {
  const m = /^(.+)-(asc|desc)$/.exec(spec)
  if (m) {
    const key = m[1], desc = m[2] === 'desc'
    arr.sort((a, b) => {
      const av = a[key], bv = b[key]
      const cmp = typeof av == 'number' && typeof bv == 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''))
      return desc ? -cmp : cmp
    })
    return
  }
  arr.sort((a, b) => {
    const av = a[spec], bv = b[spec]
    if (typeof av == 'number' && typeof bv == 'number') return bv - av
    return String(av ?? '').localeCompare(String(bv ?? ''))
  })
}
