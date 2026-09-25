import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEdit,
  formatNumberedLines,
  GLOB_PATTERN_SHELL_METACHARS,
  globPatternEscapeReason,
  globPatternEscapeMessage,
  globMatchEscapesRoot,
  buildGrepArgs,
  buildGrepCommand,
  buildConfinedContainerCommand,
  buildConfinedGlobBody,
  confinedContainerFailureMessage,
  CONTAINER_CONFINE_OK,
  CONTAINER_CONFINE_ESCAPE,
  CONTAINER_CONFINE_ERROR,
  CONTAINER_CONFINE_WITHHELD,
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

describe('buildConfinedGlobBody (#7354)', () => {
  // Collapsed to booleans: the subject is a multi-line script, and a failing
  // `assert.match` carries the whole of it into the TAP stream (#7340).
  const body = buildConfinedGlobBody('**/*.ts')

  it('expands the pattern UNQUOTED — the expansion is the tool', () => {
    assert.ok(body.includes('for f in **/*.ts; do'))
  })

  it('sets nullglob in its own statement so an old bash keeps it', () => {
    // `shopt -s nullglob globstar` fails as a unit where globstar does not
    // exist, and losing nullglob means an unmatched pattern is emitted VERBATIM.
    assert.ok(/^shopt -s nullglob$/m.test(body))
    assert.ok(/^shopt -s globstar 2>\/dev\/null$/m.test(body))
  })

  it('silences globstar so an old bash cannot turn containment into a tool error', () => {
    // Without the redirect, bash 3.2 writes `shopt: globstar: invalid shell
    // option name` to stderr, and _containerGlob's "no stdout AND stderr"
    // branch then reports `Glob failed` for every empty result — including one
    // whose matches were all WITHHELD. CI runs bash 5, where the option is
    // accepted silently, so nothing but this assertion can see the regression.
    assert.ok(body.includes('shopt -s globstar 2>/dev/null'))
  })

  it('resolves every match and compares it against the resolved root', () => {
    assert.ok(body.includes('__cx_resolve "$__cx_d"'), 'must resolve the match directory')
    // #7897 — the symlinked-entry resolution passes the lenient flag so a
    // dangling target whose own parent is also missing still resolves
    // lexically instead of failing outright; the directory-prefetch call
    // above stays strict (no flag) since it resolves a real, existing
    // directory entry, never a followed symlink target.
    assert.ok(body.includes('__cx_resolve "$f" 1'), 'must resolve a symlinked entry leniently')
    assert.ok(body.includes('"$__cx_target"|"$__cx_target"/*'), 'must compare against the root')
  })

  it('withholds an unresolvable match rather than emitting it (fail closed)', () => {
    assert.ok(body.includes('if ! __cx_r=$(__cx_resolve "$f" 1); then'))
    assert.ok(body.includes('__cx_lastv=n'))
  })

  it('#7896 — withholds a non-symlink match that does not exist on disk', () => {
    // A purely literal `pattern` (no wildcard) reaches the `for` loop
    // verbatim even when nothing matches it — nullglob only suppresses a
    // pattern bash actually attempted to expand. The existence check must sit
    // in an `elif` after the `-L` branch: a symlink is not `-e`-testable when
    // dangling and is already existence-checked (via resolution) above.
    assert.ok(body.includes('elif [ ! -e "$f" ]; then'), 'no literal-match existence check')
    const elifLine = body.split('\n').findIndex((l) => l.includes('elif [ ! -e "$f" ]'))
    const lLine = body.split('\n').findIndex((l) => l.includes('if [ -L "$f" ]; then'))
    assert.ok(elifLine > lLine, 'the existence check must be an elif of the -L branch, not a separate if')
  })

  it('emits no marker for a withheld match (no existence oracle, #7341)', () => {
    // The only per-match thing the loop prints is a KEPT match. The trailer is
    // printed once, after the loop, and the host strips it before the model
    // ever sees the body — see splitWithheldTrailer.
    const printed = body.split('\n').filter((l) => l.includes('printf')).map((l) => l.trim())
    assert.deepEqual(printed, [
      // #7357 — NUL-delimited, not '\n': a filename may legally contain a
      // newline, and a '\n'-joined stream can't tell "one match with an
      // embedded newline" apart from "two matches". The trailer line stays
      // '\n'-terminated — it is fixed host-authored text, never a filename.
      `printf '%s\\0' "$f"`,
      `printf '%s %s\\n' '${CONTAINER_CONFINE_WITHHELD}' "$__cx_withheld"`,
    ])
  })

  it('counts every withheld match, on all four withhold branches', () => {
    // A count that is right for some but not all branches understates the
    // trace by exactly the cases an operator most wants to see. #7896 added a
    // 4th branch (a non-existent literal match) to the pre-existing 3
    // (directory containment, symlink-resolution failure, symlink-target
    // containment).
    const increments = body.split('\n').filter((l) => l.includes('__cx_withheld=$((__cx_withheld+1))'))
    assert.equal(increments.length, 4)
    assert.ok(body.includes('__cx_withheld=0'), 'the counter must start at a known value')
  })

  it('exports no unconfined variant alongside it', async () => {
    // The old `buildGlobCommand` built the same listing WITHOUT the resolution
    // pass. Leaving it exported is how a guard ends up wired to only some of
    // its callers (docs/false-safety-guards.md).
    const mod = await import('../../src/built-in-tools/tool-transforms.js')
    assert.equal('buildGlobCommand' in mod, false)
  })
})

describe('buildConfinedContainerCommand (#7354)', () => {
  const cmd = buildConfinedContainerCommand({ target: '/workspace/src', body: 'echo hi' })

  it('resolves the workspace and the target before running the body', () => {
    assert.ok(cmd.includes(`__cx_resolve '/workspace'`))
    assert.ok(cmd.includes(`__cx_resolve '/workspace/src'`))
    assert.ok(cmd.indexOf(CONTAINER_CONFINE_OK) < cmd.indexOf('echo hi'))
  })

  it('bails to a sentinel and exit 0 — never a non-zero the runner would throw on', () => {
    for (const sentinel of [CONTAINER_CONFINE_ESCAPE, CONTAINER_CONFINE_ERROR]) {
      assert.ok(cmd.includes(`printf '%s\\n' '${sentinel}'; exit 0;`), `missing bail for ${sentinel}`)
    }
  })

  it('unsets CDPATH around every cd, so `cd` cannot echo into the capture', () => {
    const cds = cmd.split('\n').filter((l) => l.includes('cd -P --'))
    assert.ok(cds.length > 0)
    assert.ok(cds.every((l) => l.includes('unset CDPATH')), 'a cd without `unset CDPATH`')
  })

  it('shell-quotes the target, so a path with a quote cannot break out', () => {
    const evil = buildConfinedContainerCommand({ target: `/workspace/a'; id; '`, body: 'true' })
    assert.ok(evil.includes(`__cx_resolve '/workspace/a'\\''; id; '\\'''`))
  })

  it('runs an optional setup after the check and before the OK sentinel', () => {
    const withSetup = buildConfinedContainerCommand({
      target: '/workspace', body: 'echo hi', setup: 'cd x',
    })
    const setupAt = withSetup.indexOf('cd x')
    assert.ok(setupAt > withSetup.indexOf('case $__cx_target'))
    assert.ok(setupAt < withSetup.indexOf(CONTAINER_CONFINE_OK))
    assert.ok(withSetup.includes(`cd x || { printf '%s\\n' '${CONTAINER_CONFINE_ERROR}'`))
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

  it('rootExpr substitutes a shell expression for the quoted root (#7354)', () => {
    // The container searches the path its confinement preamble RESOLVED, the
    // same thing the host does (it passes safeResolveRoot's realpath).
    const cmd = buildGrepCommand({ ...base, root: undefined, rootExpr: '"$__cx_target"' })
    assert.ok(cmd.includes(`-e 'TODO' -- "$__cx_target";`), 'rg must search the resolved root')
    assert.ok(cmd.includes(`grep -r -i -n -e 'TODO' -- "$__cx_target"`), 'so must the fallback')
    assert.equal(cmd.includes(`'undefined'`), false, 'the unused literal root must not leak in')
  })

  it('keeps the `--` terminator under rootExpr (the #7295 property)', () => {
    // shellQuote closes SHELL injection only; `--` is what stops rg's own
    // option parser seeing a root that begins with `-`. Swapping the root for
    // an expression must not take it with it.
    const cmd = buildGrepCommand({ ...base, rootExpr: '"$__cx_target"' })
    assert.equal(cmd.split('-- "$__cx_target"').length - 1, 2, 'both arms need the terminator')
  })

  it('falls back to the quoted literal root when rootExpr is absent or empty', () => {
    for (const rootExpr of [undefined, '', null]) {
      assert.ok(buildGrepCommand({ ...base, rootExpr }).includes(`-- '/work'`), `rootExpr=${rootExpr}`)
    }
  })
})

describe('confinedContainerFailureMessage (#7354)', () => {
  it('names the escape without echoing anything from outside the workspace', () => {
    const msg = confinedContainerFailureMessage('Glob', 'escape', 'esc')
    assert.ok(msg.includes('Glob refused'))
    assert.ok(msg.includes('resolves outside the workspace'))
    assert.ok(msg.includes('esc'))
  })

  it('distinguishes an unresolvable path from an escape', () => {
    for (const reason of ['error', 'unparseable']) {
      const msg = confinedContainerFailureMessage('Read', reason, 'a.ts')
      assert.equal(msg.includes('resolves outside the workspace'), false, reason)
      assert.ok(msg.includes('a.ts'), reason)
    }
  })

  it('distinguishes an unparseable REPLY from an unresolvable PATH', () => {
    // The error sentinel means the container answered, about the path. An
    // unparseable reply means the verdict never arrived — the guard may not
    // have run. Collapsing them sends an operator to the wrong place, and the
    // second case is the one that needs looking at.
    const err = confinedContainerFailureMessage('Read', 'error', 'a.ts')
    const unp = confinedContainerFailureMessage('Read', 'unparseable', 'a.ts')
    assert.ok(err.includes('could not resolve'))
    assert.equal(err.includes('no valid confinement verdict'), false)
    assert.ok(unp.includes('no valid confinement verdict'))
    assert.equal(unp.includes('could not resolve'), false)
  })

  it('omits the path clause when there is no path to name', () => {
    assert.equal(
      confinedContainerFailureMessage('Grep', 'escape', undefined).includes('undefined'),
      false,
    )
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
      // NOTE: patterns that only REACH `..` by expansion — `.{.,x}/etc/*`,
    // `..*/etc/*`, `.[.]/etc/*`, `{.,x}{.,y}/etc/*` — are deliberately NOT
    // rejected here any more. Detecting them meant modelling brace expansion
    // and glob-vs-`..` matching, which was both wrong (46/515 bracket segments)
    // and a DoS. They are caught where they materialise: see the container's
    // "escaping paths the container actually returned" test and the host's
    // parent-escape test.
    // Windows drive-absolute and UNC. These run on Windows CI (this file is not
    // in WINDOWS_EXEMPT, unlike byok-tool-executor.test.js), which is the whole
    // reason they belong here: the host Glob is portable now, but every test of
    // it lives in a file no Windows job executes.
    ['C:/Users/x/.ssh/*', /absolute path/],
    ['C:\\Users\\x\\*', /absolute path/],
    ['c:/Users/*', /absolute path/],
    ['C:*', /absolute path/],
    ['//server/share/*', /absolute path/],
    ['{a,C:/etc}/x', /absolute path/],
    ['..\\..\\etc\\pass*', /parent-directory/],
    ['src\\..\\..\\etc', /parent-directory/],
    // The pattern is interpolated UNQUOTED, so whitespace makes it SEVERAL
    // patterns and only the first one has to look innocent.
    ['* /etc/pass*', /whitespace/],
    ['* ~/.ssh/*', /whitespace/],
    ['My Docs/*.pdf', /whitespace/],   // refused on BOTH paths, for parity
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
    '[.]*',
    // `.*` and `.?` are allowed again. They CAN expand to `..` in a shell, and
    // the previous cut rejected them for that reason — but computing "can this
    // glob reach `..`" is what produced both a 12.9-second event-loop stall and
    // 46 wrong answers out of 515 enumerated bracket segments. Containment moved
    // to the output, where a `..` that actually materialises is caught for real,
    // so the common "list the dotfiles" pattern works again.
    '.*',
    '.?',
    '.[[:punct:]]',
    '.[z-a]',                // an invalid class is a matcher's problem, not ours
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

describe('globPatternEscapeReason — cost (#7341)', () => {
  // The layer this replaced was a denial of service. `{a,b}` × 8 fanned out to
  // 256 words and each word's dot-leading segment was compiled to a regex with
  // k adjacent unbounded quantifiers, then match-tested against `..`; V8
  // backtracks that quadratically. MEASURED on the pre-fix tree: 4 KB of
  // pattern = 12.9 SECONDS of blocked event loop, returning `null` — accepted.
  // Glob is auto-approved in acceptEdits and callable in a loop, so that was a
  // whole-daemon freeze from one tool call.
  //
  // The check is now a linear scan. This test fails if anything super-linear
  // is ever reintroduced.
  it('stays linear on a pathological pattern (no catastrophic backtracking)', () => {
    for (const k of [4_000, 50_000, 200_000]) {
      const pattern = '{a,b}'.repeat(8) + '/.' + '*'.repeat(k) + 'z'
      const started = Date.now()
      globPatternEscapeReason(pattern)
      const elapsed = Date.now() - started
      assert.ok(elapsed < 500, `${pattern.length} bytes took ${elapsed}ms — backtracking is back`)
    }
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
    // Both separators and the Windows absolute forms. Splitting on `/` alone
    // is #6928 one layer down — a guard that knew one separator and let the
    // other through.
    '..\\etc\\passwd',
    'src\\..\\..\\etc',
    '\\etc\\passwd',
    'C:\\Windows\\x',
    'C:/Windows/x',
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
