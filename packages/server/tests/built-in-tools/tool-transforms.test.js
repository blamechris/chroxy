import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEdit,
  formatNumberedLines,
  GLOB_PATTERN_SHELL_METACHARS,
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
      `if command -v rg >/dev/null 2>&1; then rg -i -n --no-heading 'TODO' '/work'; else grep -r -i -n 'TODO' '/work'; fi`,
    )
  })

  it('appends `; true` when maskExit (runner rejects on non-zero exit)', () => {
    assert.equal(buildGrepCommand({ ...base, maskExit: true }).endsWith('; fi; true'), true)
  })

  it('threads the glob arg into the rg command', () => {
    assert.match(buildGrepCommand({ ...base, globArg: ` --glob '*.md'` }), /rg -i -n --no-heading --glob '\*\.md'/)
  })
})
