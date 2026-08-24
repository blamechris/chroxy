import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEdit,
  formatNumberedLines,
  GLOB_PATTERN_SHELL_METACHARS,
  globPatternEscapeReason,
  globPatternEscapeMessage,
  globMatchEscapesRoot,
  buildGlobCommand,
  buildGrepArgs,
  buildGrepCommand,
} from '../../src/built-in-tools/tool-transforms.js'

/**
 * Pure-transform contract (audit P2-9 / #5882). These back BOTH the host
 * built-in tools and the docker-byok container re-encodings, so the semantics
 * are pinned here once.
 */

describe('applyEdit', () => {
  it('replaces a unique occurrence (literal slice)', () => {
    const r = applyEdit('foo bar baz', { oldString: 'bar', newString: 'QUX' })
    assert.deepEqual(r, { ok: true, next: 'foo QUX baz', replacements: 1 })
  })

  it('refuses >1 match without replaceAll, reporting the count', () => {
    const r = applyEdit('aa aa aa', { oldString: 'aa', newString: 'b' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'NOT_UNIQUE')
    assert.equal(r.matchCount, 3)
  })

  it('replaces every occurrence with replaceAll', () => {
    const r = applyEdit('aa aa aa', { oldString: 'aa', newString: 'b', replaceAll: true })
    assert.deepEqual(r, { ok: true, next: 'b b b', replacements: 3 })
  })

  it('NOT_FOUND when the oldString is absent', () => {
    assert.equal(applyEdit('hello', { oldString: 'xyz', newString: 'abc' }).code, 'NOT_FOUND')
  })

  it('NO_CHANGE when old and new are identical (the container-side drift this closes)', () => {
    assert.equal(applyEdit('hi', { oldString: 'x', newString: 'x' }).code, 'NO_CHANGE')
  })

  it('EINVAL for a missing/empty oldString or non-string newString', () => {
    assert.equal(applyEdit('x', { oldString: '', newString: 'a' }).code, 'EINVAL')
    assert.equal(applyEdit('x', { oldString: undefined, newString: 'a' }).code, 'EINVAL')
    assert.equal(applyEdit('x', { oldString: 'x', newString: 42 }).code, 'EINVAL')
  })

  it('counts overlapping patterns NON-overlapping, consistent with split/join (#5888 Copilot)', () => {
    // 'aa' in 'aaaa' is 2 non-overlapping occurrences (positions 0 and 2), not
    // the overlapping 3. replaceAll must replace exactly 2 and report 2.
    const all = applyEdit('aaaa', { oldString: 'aa', newString: 'b', replaceAll: true })
    assert.deepEqual(all, { ok: true, next: 'bb', replacements: 2 })
    // Without replaceAll the same input is non-unique (2 > 1).
    assert.equal(applyEdit('aaaa', { oldString: 'aa', newString: 'b' }).matchCount, 2)
    // 'aa' in 'aaa' is a single non-overlapping occurrence → a unique edit.
    assert.deepEqual(applyEdit('aaa', { oldString: 'aa', newString: 'X' }), { ok: true, next: 'Xa', replacements: 1 })
  })

  it('inserts a newString containing $-patterns LITERALLY (not String.replace interpretation)', () => {
    // Single-match path used to be `content.replace(old, new)`, which would
    // expand `$&` to the match. Literal replacement inserts it verbatim.
    const r = applyEdit('a TOKEN b', { oldString: 'TOKEN', newString: '$& and $1 and $`' })
    assert.equal(r.ok, true)
    assert.equal(r.next, 'a $& and $1 and $` b')
  })
})

describe('formatNumberedLines', () => {
  it('numbers lines 1-indexed with a 5-wide pad and arrow', () => {
    const r = formatNumberedLines('alpha\nbeta\ngamma')
    assert.equal(r.content, '    1→alpha\n    2→beta\n    3→gamma')
    assert.equal(r.totalLines, 3)
    assert.equal(r.linesReturned, 3)
    assert.equal(r.truncatedByLimit, false)
  })

  it('slices by 1-indexed offset/limit and reports truncation', () => {
    const text = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n')
    const r = formatNumberedLines(text, { offset: 3, limit: 2 })
    assert.equal(r.content, '    3→L3\n    4→L4')
    assert.equal(r.linesReturned, 2)
    assert.equal(r.truncatedByLimit, true)
  })

  it('caps at maxLines', () => {
    const text = Array.from({ length: 5 }, (_, i) => `L${i + 1}`).join('\n')
    const r = formatNumberedLines(text, { maxLines: 2 })
    assert.equal(r.linesReturned, 2)
    assert.equal(r.truncatedByLimit, true)
  })
})

describe('GLOB_PATTERN_SHELL_METACHARS', () => {
  it('flags shell-dangerous characters and passes legitimate glob chars', () => {
    for (const bad of ['$', '`', ';', '|', '&', '>', '<', '(', ')', '\\', '\n', '\r']) {
      assert.equal(GLOB_PATTERN_SHELL_METACHARS.test(`a${bad}b`), true, `should flag ${JSON.stringify(bad)}`)
    }
    assert.equal(GLOB_PATTERN_SHELL_METACHARS.test('src/**/*.{js,ts}'), false)
  })
})

describe('buildGlobCommand', () => {
  it('builds the globstar listing command, quoting the root but not the pattern', () => {
    assert.equal(
      buildGlobCommand('**/*.ts', '/work/repo'),
      `shopt -s globstar nullglob; cd '/work/repo' && for f in **/*.ts; do printf '%s\\n' "$f"; done`,
    )
  })
})

describe('buildGrepArgs', () => {
  it('defaults line numbers on, case-insensitive off, no glob', () => {
    assert.deepEqual(buildGrepArgs({}), { ci: '', ln: '-n', globArg: '' })
  })
  it('honors -i, -n=false, and a glob filter', () => {
    assert.deepEqual(
      buildGrepArgs({ '-i': true, '-n': false, glob: '*.go' }),
      { ci: '-i', ln: '', globArg: ` --glob '*.go'` },
    )
  })
})

describe('buildGrepCommand', () => {
  const base = { pattern: 'TODO', root: '/work', ci: '-i', ln: '-n', globArg: '' }

  it('prefers rg with an if/then/else grep fallback', () => {
    assert.equal(
      buildGrepCommand(base),
      `if command -v rg >/dev/null 2>&1; then rg --no-config -i -n --no-heading -e 'TODO' -- '/work'; else grep -r -i -n -e 'TODO' -- '/work'; fi`,
    )
  })

  it('appends `; true` when maskExit (runner rejects on non-zero exit)', () => {
    assert.equal(buildGrepCommand({ ...base, maskExit: true }).endsWith('; fi; true'), true)
  })

  it('threads the glob arg into the rg command', () => {
    assert.match(buildGrepCommand({ ...base, globArg: ` --glob '*.md'` }), /rg --no-config -i -n --no-heading --glob '\*\.md' -e 'TODO'/)
  })
})

describe('globPatternEscapeReason (#7341)', () => {
  // The shell behaviours these rules encode were MEASURED against bash before
  // the rules were written — brace expansion runs before tilde expansion and
  // yields each alternative as its own word, so `{~,.}/x` really does reach
  // the home directory and a leading-anchor-only check really is bypassable.
  const ESCAPES = [
    ['~/.ssh/*', /home-directory/],
    ['~', /home-directory/],
    ['~-/secrets/*', /home-directory/],
    ['{~,.}/.ssh/*', /home-directory/],
    ['{.,~}/.ssh/*', /home-directory/],
    ['/etc/pass*', /absolute path/],
    ['{a,/etc}/passwd', /absolute path/],
    ['../*', /parent-directory/],
    ['..', /parent-directory/],
    ['../../../../etc/pass*', /parent-directory/],
    ['src/../../etc/pass*', /parent-directory/],
    ['{.,..}/x', /parent-directory/],
    ['{..,src}/x', /parent-directory/],
    ['src/{a,..}/x', /parent-directory/],
    // Brace expansion runs BEFORE globbing, so this becomes the word
    // `../etc/*` — a traversal whose SOURCE TEXT contains no `..` at all.
    // The first cut of this guard was a set of anchored regexes and this
    // walked straight through it.
    ['.{.,x}/etc/pass*', /parent-directory/],
    ['{.,x}{.,y}/etc/pass*', /parent-directory/],
    // A glob MATCHES the `..` directory entry: `.*` expands to `. ..`
    // (measured, bash 3.2 and 5.x), so these reach the parent with no `..`
    // token present either.
    ['.*/.*/etc/pass*', /parent-directory/],
    ['.*/x', /parent-directory/],
    ['..*/etc/pass*', /parent-directory/],
    ['.?/etc/pass*', /parent-directory/],
    ['.[.]/etc/pass*', /parent-directory/],
    // The pattern is interpolated UNQUOTED, so whitespace makes it SEVERAL
    // patterns and only the first one has to look innocent.
    ['* /etc/pass*', /whitespace/],
    ['* ~/.ssh/*', /whitespace/],
    ['*.ts\t../../etc/pass*', /whitespace/],
  ]
  for (const [pattern, reason] of ESCAPES) {
    it(`rejects ${JSON.stringify(pattern)}`, () => {
      const got = globPatternEscapeReason(pattern)
      assert.notEqual(got, null, `expected ${pattern} to be rejected`)
      assert.match(got, reason)
    })
  }

  // POSITIVE CONTROLS. Without these the whole suite above would pass just as
  // well against a validator that rejected every pattern unconditionally —
  // the #7273 shape, where a check that denies everything satisfies its own
  // negative tests. These pin that ordinary globs still work.
  const ALLOWED = [
    '*',
    '*.ts',
    '**/*.ts',
    'src/**/*.{js,ts}',
    '*~',                    // emacs backup files — a trailing ~ never expands
    'src/*~',
    'report..final.md',      // `..` inside a filename is not a segment
    'v1..v2/*.diff',
    'src/[a-z]*.js',
    '.github/workflows/*.yml',
    './src/*.ts',
    'a,b/*.txt',
    '.github/**/*.yml',      // a dot-leading segment with no metachar
    '.env*',                 // dot-leading WITH a metachar, but cannot match `..`
    '.[a-z]*',               // ditto — `[a-z]` cannot match the second `.`
    '.config/**',
    '{src,tests}/**/*.js',   // ordinary brace expansion still works
    '[.]*',                  // measured: a leading dot must be matched LITERALLY,
                             // so this expands to nothing and cannot reach `..`
  ]
  for (const pattern of ALLOWED) {
    it(`allows ${JSON.stringify(pattern)}`, () => {
      assert.equal(globPatternEscapeReason(pattern), null)
    })
  }

  it('message names the reason and points at the `path` argument', () => {
    const msg = globPatternEscapeMessage(globPatternEscapeReason('~/.ssh/*'))
    assert.match(msg, /^EINVAL: glob pattern escapes the workspace root/)
    assert.match(msg, /home-directory/)
    assert.match(msg, /"path" argument/)
  })
})

describe('globPatternEscapeReason — brace-expansion ceilings (#7341)', () => {
  it('REJECTS a brace bomb rather than skipping the check', () => {
    // "Too complex to verify" must not read as "verified fine" — that is the
    // cannot-check-so-nothing-to-check class in docs/false-safety-guards.md.
    const bomb = '{a,b}'.repeat(12) + '/x'
    assert.match(globPatternEscapeReason(bomb), /too large to verify/)
  })

  it('rejects an over-deep nest rather than skipping the check', () => {
    let nest = 'x'
    for (let i = 0; i < 12; i++) nest = `{${nest},y}`
    assert.notEqual(globPatternEscapeReason(nest + '/z'), null)
  })

  it('still accepts a brace expansion just under the ceiling (positive control)', () => {
    // Without this the two tests above would pass against a validator that
    // rejected every brace pattern outright.
    assert.equal(globPatternEscapeReason('{a,b}{c,d}/*.ts'), null)
  })

  it('leaves a comma-less brace body literal, as bash does', () => {
    assert.equal(globPatternEscapeReason('{a}/*.ts'), null)
  })

  it('fails closed on a non-string pattern', () => {
    for (const bad of [undefined, null, 42, {}]) {
      assert.notEqual(globPatternEscapeReason(bad), null)
    }
  })
})

describe('globMatchEscapesRoot (#7341)', () => {
  // This is the container Glob's containment boundary. It inspects what the
  // expansion PRODUCED rather than predicting what it will produce — which is
  // why it catches all six of the bypasses that were found against the
  // pattern-prediction guard, none of which are visible in the pattern text.
  const ESCAPES = [
    '/etc/passwd',                 // absolute — `''/etc/pass*`, `* /etc/pass*`
    '../etc/passwd',               // `'..'/x`, `.[[:punct:]]/x`, `{a}b,../x}`
    '../../etc/passwd',            // `.*` matching the `..` entry, twice
    'src/../../etc/passwd',
    '..',
    'a/..',
    '/',
  ]
  for (const m of ESCAPES) {
    it(`withholds ${JSON.stringify(m)}`, () => {
      assert.equal(globMatchEscapesRoot(m), true)
    })
  }

  const CONTAINED = [
    'a.ts',
    'src/a.ts',
    './a.ts',
    'src/.env',
    'report..final.md',            // `..` inside a NAME is not a segment
    'v1..v2/x.diff',
    '.github/workflows/ci.yml',
    'a b.txt',                     // a space in a filename is not an escape
    "it's.txt",
  ]
  for (const m of CONTAINED) {
    it(`keeps ${JSON.stringify(m)}`, () => {
      assert.equal(globMatchEscapesRoot(m), false)
    })
  }

  it('fails closed on a non-string match', () => {
    for (const bad of [undefined, null, 42]) assert.equal(globMatchEscapesRoot(bad), true)
  })
})
