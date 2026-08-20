import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Nue's dhtml compiler serializes each component's <script> through a path
// with a ~10,000-character cap, and a script past it is truncated SILENTLY —
// the build succeeds, the bundle parses, and the component simply loses its
// tail at runtime. That failure mode is invisible in review and in CI unless
// something asserts on it, which is what this does.
//
// The /speak components are the ones that have actually been split for this
// reason (see the comments in ui/views.html), so they are checked by name;
// every other component is checked too, so a new one can't quietly grow past
// the cliff.

const CAP = 10_000
const ROOT = join(__dirname, '..', '..')
const FILES = ['ui/views.html', 'ui/auth.html', 'ui/widgets.html', 'ui/feedback.html']

function components(file: string) {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const out: { name: string; chars: number }[] = []
  const re = /:is="([a-z0-9-]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = src.indexOf('<script>', m.index)
    if (open === -1) continue
    // Only count a <script> that belongs to this component: another :is=
    // starting before it means this component has no script of its own.
    const nextIs = re.lastIndex === 0 ? -1 : src.indexOf(':is="', m.index + 1)
    if (nextIs !== -1 && nextIs < open) continue
    const close = src.indexOf('</script>', open)
    out.push({ name: m[1], chars: close - open - '<script>'.length })
  }
  return out
}

describe('dhtml component script cap', () => {
  for (const file of FILES) {
    it(`${file}: every component script stays under the ${CAP.toLocaleString()}-char cliff`, () => {
      const over = components(file).filter(c => c.chars >= CAP)
      expect(over, `split these into child components: ${over.map(c => `${c.name} (${c.chars})`).join(', ')}`)
        .toEqual([])
    })
  }

  it('reports the /speak components, which sit closest to the cap', () => {
    const found = components('ui/views.html').filter(c => c.name.startsWith('speak'))
    expect(found.map(c => c.name)).toEqual(['speak-view', 'speak-recorder', 'speak-history'])
    // Not an assertion on the exact numbers — just proof the parser found
    // real scripts rather than silently matching nothing and passing.
    for (const c of found) expect(c.chars).toBeGreaterThan(1000)
  })
})
