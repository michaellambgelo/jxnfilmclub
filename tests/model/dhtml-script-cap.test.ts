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
  const out: { name: string; chars: number; body: string }[] = []
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
    const body = src.slice(open + '<script>'.length, close)
    out.push({ name: m[1], chars: body.length, body })
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

  // The cap test measures LENGTH only, and length is not the only way to
  // corrupt the bundle. A component script is serialized through util.inspect,
  // which picks a quote character in the order single -> double -> backtick,
  // choosing the first the string does not contain. Every one of these scripts
  // contains an apostrophe, so a script carrying BOTH a double quote and a
  // backtick leaves util.inspect no free delimiter; it falls back to escaping
  // and emits a literal that breaks apart mid-string. The build still reports
  // success, and vitest still passes because it imports source rather than the
  // bundle — the shipped file simply does not parse, and the SyntaxError points
  // at an unrelated line hundreds of characters away.
  //
  // Verified by bisection, not assumed: either character alone is fine, both
  // together break, and the apostrophe makes no difference on its own.
  for (const file of FILES) {
    it(`${file}: no component script mixes backticks with double quotes`, () => {
      const bad = components(file).filter(c => c.body.includes('`') && c.body.includes('"'))
      expect(
        bad.map(c => c.name),
        'these scripts contain a backtick AND a double quote, which corrupts the ' +
        'emitted bundle while the build reports success — drop one of the two, ' +
        'in comments as much as in code: ' + bad.map(c => c.name).join(', '),
      ).toEqual([])
    })
  }

  it('reports the /speak components, which sit closest to the cap', () => {
    const found = components('ui/views.html').filter(c => c.name.startsWith('speak'))
    expect(found.map(c => c.name)).toEqual(['speak-view', 'speak-recorder', 'speak-compose', 'speak-history'])
    // Not an assertion on the exact numbers — just proof the parser found
    // real scripts rather than silently matching nothing and passing.
    for (const c of found) expect(c.chars).toBeGreaterThan(1000)
  })
})
