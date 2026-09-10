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

// Everything outside a <script> — i.e. the templates. Component scripts are
// full of object literals and blocks, so scanning the whole file for `{ }`
// would drown the interpolation pass in JS noise.
function templateMarkup(src: string): string {
  return src.replace(/<script>[\s\S]*?<\/script>/g, '')
}

// Bare identifiers in an expression, ignoring property accesses (`a.name`
// binds `a`, not `name`) and string literals ('This round' binds nothing).
function identsIn(expr: string, into: Set<string>): void {
  const bare = expr.replace(/'[^']*'|"[^"]*"/g, ' ')
  for (const m of bare.matchAll(/(\.)?\b([a-z_$][\w$]*)\b/g)) if (!m[1]) into.add(m[2])
}

// Names bound by a template: :each="x in xs" loop vars, the directives that
// take an expression, and anything read as a bare identifier inside a { }
// interpolation. The interpolation pass is the one that matters most — a
// lib-scope `const prompt` shadows `{ prompt.text }` in a template that binds
// `prompt` in no directive at all, so a directives-only scan would miss it.
function templateBindings(file: string): Set<string> {
  const markup = templateMarkup(readFileSync(file, 'utf8'))
  const bound = new Set<string>()
  for (const m of markup.matchAll(/:each="\s*([A-Za-z_$][\w$]*)\s+in\s/g)) bound.add(m[1])
  for (const m of markup.matchAll(/:(?:if|hidden)="([^"]*)"/g)) identsIn(m[1], bound)
  for (const m of markup.matchAll(/\{([^{}]*)\}/g)) identsIn(m[1], bound)
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

  it('the interpolation pass sees names no directive binds', () => {
    // A directives-only scan misses a field that is only ever interpolated —
    // which is most of them. Asserted against synthetic markup rather than a
    // real identifier in views.html, so that refactoring a binding away cannot
    // quietly turn this proof into a tautology.
    const bound = new Set<string>()
    identsIn('subject ? subject.text : fallback', bound)
    expect([...bound].sort()).toEqual(['fallback', 'subject'])

    // ...and it must NOT bind property names or string contents, or it
    // over-matches into uselessness and starts failing on unrelated names.
    const narrow = new Set<string>()
    identsIn("session ? 'Record a clip' : mine.name", narrow)
    expect([...narrow].sort()).toEqual(['mine', 'session'])
  })
})
