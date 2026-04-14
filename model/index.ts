
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
  const { start = 0, limit = 30, sort, search } = opts || {}

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

  return { type, total: items.length, items: items.slice(start, start + limit) }
}

function sortBy(key: string, arr: any[]) {
  arr.sort((a, b) => {
    const av = a[key], bv = b[key]
    if (typeof av == 'number' && typeof bv == 'number') return bv - av
    return String(av ?? '').localeCompare(String(bv ?? ''))
  })
}
