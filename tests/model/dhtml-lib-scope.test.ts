import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A name declared in a lib file's head <script> becomes a FILE-WIDE reserved
// word for every component template in that file: the compiler feeds lib-script
// declaration names in as reserved words, so `{ a.name }` inside
// `:each="a in attendees"` resolves to the module binding instead of the loop
// variable. The view then renders empty with no error anywhere.
//
// This is not hypothetical. Hoisting the shared worker-origin block out of
// three components carried a `const a = e.target.closest(...)` along with it
// and silently blanked every attendee name in events-view. Nothing caught it
// but an e2e assertion, and only because that list happened to be asserted.
//
// So: every lib-scope declaration must be a name no template binds.

const FILES = ['ui/views.html', 'ui/auth.html', 'ui/widgets.html', 'ui/feedback.html']

function libScript(file: string): string {
  const src = readFileSync(file, 'utf8')
  // The head script is the one before the first component element.
  const open = src.indexOf('<script>')
  const close = src.indexOf('</script>')
  if (open === -1 || close === -1) return ''
  return src.slice(open + '<script>'.length, close)
}

// Declaration names at any nesting depth — a name inside a callback is just as
// reserved as one at the top level, which is exactly how the attendee bug got in.
function declaredNames(script: string): string[] {
  const names = new Set<string>()
  const decl = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g
  for (const m of script.matchAll(decl)) names.add(m[1])
  return [...names]
}

// Names bound by a template: :each="x in xs" loop vars, and anything read as a
// bare identifier inside a { } interpolation.
function templateBindings(file: string): Set<string> {
  const src = readFileSync(file, 'utf8')
  const bound = new Set<string>()
  for (const m of src.matchAll(/:each="\s*([A-Za-z_$][\w$]*)\s+in\s/g)) bound.add(m[1])
  for (const m of src.matchAll(/:(?:if|hidden)="([^"]*)"/g)) {
    for (const id of m[1].matchAll(/\b([a-z_$][\w$]*)\b/g)) bound.add(id[1])
  }
  return bound
}

describe('dhtml lib-scope names cannot shadow template fields', () => {
  for (const file of FILES) {
    it(`${file}: no lib-script declaration collides with a template binding`, () => {
      const script = libScript(file)
      if (!script.trim()) return
      const bound = templateBindings(file)
      const clashes = declaredNames(script).filter(n => bound.has(n))
      expect(
        clashes,
        `rename these in ${file}'s head <script> — a lib-scope name is a file-wide ` +
        `reserved word, so a template reading it gets the module binding instead ` +
        `of the component field (see docs/CLAUDE.md, dhtml gotchas): ${clashes.join(', ')}`,
      ).toEqual([])
    })
  }

  it('the check is real: it would have caught the attendee-name regression', () => {
    // Proof the matcher works, so a future refactor cannot make this test pass
    // by silently matching nothing.
    const script = "document.addEventListener('click', function(e) { const a = e.target })"
    expect(declaredNames(script)).toContain('a')
    expect(templateBindings('ui/views.html').has('a')).toBe(true)
  })
})
