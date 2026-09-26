import { describe, it, beforeEach, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { glob as fsGlob, rm as rmAsync, symlink as symlinkAsync, rename as renameAsync } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { executeBuiltinTool, compileCaseCheck, caseCheckPasses, segmentMatches, walkGlob, expandBraces, parseRangeGroup, hasRangeBrace, hostBraceDepthExceeded } from '../src/byok-tool-executor.js'
import { globPatternComplexityReason } from '../src/built-in-tools/tool-transforms.js'

/**
 * Tests for byok-tool-executor.js — the dispatcher that routes tool_use
 * blocks to the local executors. Each test exercises one tool path
 * with a real temp filesystem so the path-safety check
 * (validatePathWithinCwd) is actually exercised, not stubbed away.
 */

describe('executeBuiltinTool', () => {
  let dir
  let cwdRealCache
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-byok-exec-'))
    cwdRealCache = new Map()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function ctx() {
    return { cwd: dir, cwdRealCache, cwdCacheTtl: 30_000 }
  }

  describe('unknown tool name', () => {
    it('returns isError with a clear message', async () => {
      const r = await executeBuiltinTool({ toolName: 'NotARealTool', input: {}, ...ctx() })
      assert.equal(r.isError, true)
      assert.match(r.content, /Unknown tool: NotARealTool/)
    })

    it('error message lists every BUILTIN_TOOL name (drift guard — review #4136)', async () => {
      // Pre-fix the list was hardcoded and could drift from BUILTIN_TOOLS.
      // Now it's derived from BUILTIN_TOOL_NAMES — adding a tool here is
      // automatically reflected in the error message.
      const { BUILTIN_TOOL_NAMES } = await import('../src/byok-tools.js')
      const r = await executeBuiltinTool({ toolName: 'X', input: {}, ...ctx() })
      for (const name of BUILTIN_TOOL_NAMES) {
        assert.ok(r.content.includes(name), `error must list ${name}`)
      }
    })
  })

  describe('Read', () => {
    it('reads a file inside the workspace cwd', async () => {
      const f = join(dir, 'hello.txt')
      writeFileSync(f, 'hi\nthere')
      const r = await executeBuiltinTool({ toolName: 'Read', input: { file_path: f }, ...ctx() })
      assert.equal(r.isError, false)
      assert.match(r.content, /1→hi/)
      assert.match(r.content, /2→there/)
    })

    it('refuses paths outside the cwd (symlink escape defense)', async () => {
      const outsideAbs = '/etc/passwd'
      const r = await executeBuiltinTool({ toolName: 'Read', input: { file_path: outsideAbs }, ...ctx() })
      assert.equal(r.isError, true)
      assert.match(r.content, /outside workspace/)
    })

    it('accepts a workspace-relative path', async () => {
      writeFileSync(join(dir, 'rel.txt'), 'relative ok')
      const r = await executeBuiltinTool({ toolName: 'Read', input: { file_path: 'rel.txt' }, ...ctx() })
      assert.equal(r.isError, false)
      assert.match(r.content, /relative ok/)
    })
  })

  describe('Write', () => {
    it('writes a new file under cwd', async () => {
      const r = await executeBuiltinTool({
        toolName: 'Write',
        input: { file_path: join(dir, 'out.txt'), content: 'fresh' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /Wrote 5 bytes/)
      assert.match(r.content, /\(created\)/)
    })
  })

  describe('Edit', () => {
    it('replaces a unique substring', async () => {
      const f = join(dir, 'edit.txt')
      writeFileSync(f, 'aaa bbb ccc')
      const r = await executeBuiltinTool({
        toolName: 'Edit',
        input: { file_path: f, old_string: 'bbb', new_string: 'XXX' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /Replaced 1 occurrence/)
    })

    it('surfaces NOT_UNIQUE as a tool error so the model can self-correct', async () => {
      const f = join(dir, 'multi.txt')
      writeFileSync(f, 'foo foo foo')
      const r = await executeBuiltinTool({
        toolName: 'Edit',
        input: { file_path: f, old_string: 'foo', new_string: 'bar' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /NOT_UNIQUE/)
    })
  })

  describe('Bash', () => {
    it('captures stdout + exit code from a simple command', async () => {
      const r = await executeBuiltinTool({
        toolName: 'Bash',
        input: { command: 'echo agent-loop-test' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /agent-loop-test/)
      assert.match(r.content, /exit=0/)
    })

    it('marks non-zero exit as error', async () => {
      const r = await executeBuiltinTool({
        toolName: 'Bash',
        input: { command: 'exit 17' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /exit=17/)
    })

    it('rejects empty command with a clear error', async () => {
      const r = await executeBuiltinTool({ toolName: 'Bash', input: { command: '' }, ...ctx() })
      assert.equal(r.isError, true)
      assert.match(r.content, /command is required/)
    })

    it('respects a small timeout', async () => {
      const r = await executeBuiltinTool({
        toolName: 'Bash',
        input: { command: 'sleep 5', timeout: 200 },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /timed out/)
    })
  })

  describe('Glob', () => {
    it('matches files inside the workspace via shell glob', async () => {
      writeFileSync(join(dir, 'a.ts'), '1')
      writeFileSync(join(dir, 'b.ts'), '2')
      writeFileSync(join(dir, 'c.js'), '3')
      const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.ts' }, ...ctx() })
      assert.equal(r.isError, false)
      assert.match(r.content, /a\.ts/)
      assert.match(r.content, /b\.ts/)
      assert.equal(r.content.includes('c.js'), false)
    })

    it('returns "No matches" when nothing matches', async () => {
      const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.zzz' }, ...ctx() })
      assert.equal(r.isError, false)
      assert.match(r.content, /No matches/)
    })

    it('refuses pattern with shell command-substitution metacharacters (security #4070)', async () => {
      // Pre-fix PoC: pattern `*.ts $(touch /tmp/CHROXY_PWN)` would
      // execute the touch on `for f in $pattern` interpolation.
      const pwn = join(dir, 'CHROXY_PWN')
      const r = await executeBuiltinTool({
        toolName: 'Glob',
        input: { pattern: `*.ts $(touch ${pwn})` },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /shell-dangerous characters/)
      // Most important: the side effect must NOT have happened.
      assert.equal(
        existsSync(pwn),
        false,
        'command substitution must be refused, not executed',
      )
    })

    it('refuses absolute path outside the workspace (security #4071)', async () => {
      const r = await executeBuiltinTool({
        toolName: 'Glob',
        input: { pattern: '*.conf', path: '/etc' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /outside workspace/)
    })

    it('refuses backtick command substitution', async () => {
      const r = await executeBuiltinTool({
        toolName: 'Glob',
        input: { pattern: '`whoami`' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /shell-dangerous characters/)
    })

    it('refuses pipe / redirect / semicolon', async () => {
      for (const pat of ['*.ts | cat', '*.ts; ls', '*.ts > /tmp/x', '*.ts && rm -rf']) {
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: pat }, ...ctx() })
        assert.equal(r.isError, true, `expected error for: ${pat}`)
      }
    })

    // ---- #7341: the PATTERN escapes the workspace root -------------------
    //
    // Pre-fix these ALL returned isError:false with real file contents —
    // measured end-to-end through this same dispatcher. `pattern` was checked
    // only against GLOB_PATTERN_SHELL_METACHARS, a shell-INJECTION denylist
    // that permits `~`, `/` and `..`; the sibling `path` field was fully
    // realpath-confined. Glob is auto-approved in acceptEdits mode and gets
    // only the reduced secrets floor, so this was a read-anything primitive
    // behind a tool classified read-only.
    //
    // These assertions must FAIL on the pre-fix tree — verified by restoring
    // the pre-fix src/ and re-running (docs/false-safety-guards.md).

    it('refuses a home-directory (~) pattern (security #7341)', async () => {
      for (const pattern of ['~/.ssh/*', '{~,.}/.ssh/*']) {
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern }, ...ctx() })
        assert.equal(r.isError, true, `expected error for: ${pattern}`)
        assert.match(r.content, /escapes the workspace root/)
        assert.equal(
          r.content.includes(homedir()),
          false,
          `${pattern} must not leak paths under the real home directory`,
        )
      }
    })

    it('refuses an absolute pattern (security #7341)', async () => {
      for (const pattern of ['/etc/pass*', '{a,/etc}/pass*']) {
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern }, ...ctx() })
        assert.equal(r.isError, true, `expected error for: ${pattern}`)
        assert.match(r.content, /escapes the workspace root/)
        assert.equal(r.content.includes('passwd'), false, `${pattern} must not list /etc`)
      }
    })

    it('refuses a `..` traversal pattern (security #7341)', async () => {
      // Enough `..` to clear even a deep macOS /private/var/folders tmpdir —
      // a shallower one silently "passes" as No-matches and proves nothing.
      for (const pattern of [
        '../'.repeat(12) + 'etc/pass*',
        'src/../' + '../'.repeat(11) + 'etc/pass*',
        '{.,..}/' + '../'.repeat(11) + 'etc/pass*',
      ]) {
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern }, ...ctx() })
        assert.equal(r.isError, true, `expected error for: ${pattern}`)
        assert.match(r.content, /escapes the workspace root/)
        assert.equal(r.content.includes('passwd'), false, `${pattern} must not list /etc`)
      }
    })

    it('refuses a whitespace-split multi-pattern (security #7341)', async () => {
      // The pattern is interpolated UNQUOTED into `for f in <pattern>`, so a
      // space makes it SEVERAL patterns and only the first has to look
      // innocent. Pre-fix `* /etc/pass*` listed /etc through the container
      // Glob, which has no result-confinement layer to fall back on.
      for (const pattern of ['* /etc/pass*', '* ~/.ssh/*']) {
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern }, ...ctx() })
        assert.equal(r.isError, true, `expected error for: ${pattern}`)
        assert.match(r.content, /whitespace/)
        assert.equal(r.content.includes('passwd'), false)
        assert.equal(r.content.includes(homedir()), false)
      }
    })

    it('contains a glob that reaches `..` by EXPANSION, without inspecting it', async () => {
      // `.*` matches the `..` entry in a shell, so `.{.,x}/x` and `.*/x` reach
      // the parent with no `..` token in the source text. The previous cut tried
      // to detect that by modelling brace expansion and glob-vs-`..` matching.
      // That model was wrong on 46 of 515 enumerated bracket segments AND cost
      // 12.9 seconds of blocked event loop on a 4 KB pattern, so it is gone:
      // these patterns are now ACCEPTED by the pattern check and contained by
      // the output layer instead. What must hold is not the rejection — it is
      // that nothing outside the workspace comes back.
      const outer = mkdtempSync(join(tmpdir(), 'chroxy-glob-outer-'))
      try {
        writeFileSync(join(outer, 'TOPSECRET.txt'), 'pw')
        const ws = join(outer, 'ws')
        mkdirSync(ws)
        writeFileSync(join(ws, 'a.ts'), '1')
        for (const pattern of ['.{.,x}/TOP*', '.*/TOP*', '..*/TOP*', '.[.]/TOP*', '.[[:punct:]]/TOP*']) {
          const r = await executeBuiltinTool({
            toolName: 'Glob', input: { pattern },
            cwd: ws, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
          })
          assert.equal(
            r.content.includes('TOPSECRET'), false,
            `${pattern} must not reach outside the workspace`,
          )
        }
        // POSITIVE CONTROL on the same workspace — the tool still works.
        const ok = await executeBuiltinTool({
          toolName: 'Glob', input: { pattern: '*.ts' },
          cwd: ws, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
        })
        assert.match(ok.content, /a\.ts/)
      } finally {
        rmSync(outer, { recursive: true, force: true })
      }
    })

    it('still globs dotfiles that cannot reach `..` (positive control)', async () => {
      // The `..`-matching rule must not cost ordinary dotfile globbing. A
      // leading `.` has to be matched LITERALLY by the shell, so `.env*` and
      // `.[a-z]*` can never reach `..` and must keep working.
      writeFileSync(join(dir, '.envrc'), 'x')
      for (const pattern of ['.env*', '.[a-z]*']) {
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern }, ...ctx() })
        assert.equal(r.isError, false, `${pattern} must still work`)
        assert.match(r.content, /\.envrc/)
      }
    })

    it('names an explicitly-addressed out-of-workspace directory (#7341)', async () => {
      // When the caller NAMES the directory, silence is the wrong answer and
      // not required: `input.path: 'esc'` already returns exactly this error,
      // so saying it for a literal pattern prefix leaks nothing new. This is
      // what makes `Glob node_modules/**` over a pnpm store explain itself
      // instead of returning a baffling "No matches".
      symlinkSync('/etc', join(dir, 'esc'))
      const r = await executeBuiltinTool({
        toolName: 'Glob',
        input: { pattern: 'esc/pass*' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /outside workspace/)
      assert.equal(r.content.includes('passwd'), false, 'must not list /etc through a symlink')
    })

    it('stays silent about a symlink it DISCOVERED rather than was given (oracle)', async () => {
      // The oracle case, and the reason the rule is split. Here the caller did
      // not name `esc` — a wildcard found it. Anything distinguishing "matched,
      // but outside" from "matched nothing" turns one bit per call into
      // filesystem enumeration for a workspace containing `esc -> /`, through a
      // tool auto-approved in acceptEdits. The two responses must be identical.
      symlinkSync('/etc', join(dir, 'esc'))
      const hit = await executeBuiltinTool({
        toolName: 'Glob', input: { pattern: '{esc,nope}/passwd' }, ...ctx(),
      })
      const miss = await executeBuiltinTool({
        toolName: 'Glob', input: { pattern: '{esc,nope}/definitely-no-such-file' }, ...ctx(),
      })
      assert.equal(hit.isError, false)
      assert.equal(hit.isError, miss.isError)
      assert.equal(
        hit.content.replace('{esc,nope}/passwd', 'X'),
        miss.content.replace('{esc,nope}/definitely-no-such-file', 'X'),
      )
      assert.equal(/\d/.test(hit.content), false, 'no count may leak')

      // PRECONDITION: the matcher really does produce the escaping match, so
      // "identical output" is evidence of withholding and not of a pattern
      // that never matched.
      const raw = []
      for await (const f of fsGlob('{esc,nope}/passwd', { cwd: dir })) raw.push(f)
      assert.deepEqual(raw, ['esc/passwd'], 'precondition: the escape must be real')
    })

    it('withholds a parent-directory escape the matcher really does produce', async () => {
      // THE test for layer 2, and the only one written against a vector that
      // provably reaches a real secret. `{a}b,../TOP*}` walks past the
      // syntactic guard — bash and node both skip a brace body with no
      // top-level comma and keep scanning, which the guard does not model —
      // so this is layer 2 alone, unaided.
      //
      // The `fsGlob` assertion is a POSITIVE CONTROL and is not decoration.
      // Without it, "the tool returned no match" is satisfied just as well by
      // a pattern that never matched anything, and the test would keep passing
      // with the confinement deleted (docs/false-safety-guards.md).
      const outer = mkdtempSync(join(tmpdir(), 'chroxy-glob-outer-'))
      try {
        writeFileSync(join(outer, 'TOPSECRET.txt'), 'pw')
        const ws = join(outer, 'ws')
        mkdirSync(ws)
        writeFileSync(join(ws, 'a.ts'), '1')

        for (const pattern of ['{a}b,../TOP*}', '../TOP*']) {
          const raw = []
          for await (const f of fsGlob(pattern, { cwd: ws })) raw.push(f)
          assert.deepEqual(
            raw, ['../TOPSECRET.txt'],
            `precondition: ${pattern} must really escape, or this test proves nothing`,
          )

          const r = await executeBuiltinTool({
            toolName: 'Glob',
            input: { pattern },
            cwd: ws,
            cwdRealCache: new Map(),
            cwdCacheTtl: 30_000,
          })
          assert.equal(
            r.content.includes('TOPSECRET'), false,
            `${pattern} must not reach outside the workspace`,
          )
        }

        // Positive control on the SAME workspace: an in-bounds pattern still works.
        const ok = await executeBuiltinTool({
          toolName: 'Glob', input: { pattern: '*.ts' },
          cwd: ws, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
        })
        assert.match(ok.content, /a\.ts/)
      } finally {
        rmSync(outer, { recursive: true, force: true })
      }
    })

    it('treats shell-only expansion syntax as literal characters (#7341)', async () => {
      // The host no longer shells out, so quote removal, word splitting and
      // POSIX bracket sub-expressions — three of the six bypasses review found
      // against the old `for f in <pattern>` implementation — are not
      // expansions any more, they are just characters that match no filename.
      const outer = mkdtempSync(join(tmpdir(), 'chroxy-glob-outer-'))
      try {
        writeFileSync(join(outer, 'TOPSECRET.txt'), 'pw')
        const ws = join(outer, 'ws')
        mkdirSync(ws)
        for (const pattern of [`'..'/TOP*`, `"..".${'/'}TOP*`, '.[[:punct:]]/TOP*']) {
          const r = await executeBuiltinTool({
            toolName: 'Glob', input: { pattern },
            cwd: ws, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
          })
          assert.equal(r.content.includes('TOPSECRET'), false, `${pattern} must not escape`)
        }
      } finally {
        rmSync(outer, { recursive: true, force: true })
      }
    })

    it('does not emit the workspace root itself for `**` (#7341 regression)', async () => {
      // `fs.glob` yields the search ROOT as a match for `**`; `relative()`
      // renders it '', which survived confinement and came out as a leading
      // blank line — and as a bare '' on an empty workspace, where the shell
      // implementation said "No matches". Both are regressions from the
      // rewrite, not from the original bug.
      const empty = mkdtempSync(join(tmpdir(), 'chroxy-glob-empty-'))
      try {
        const r0 = await executeBuiltinTool({
          toolName: 'Glob', input: { pattern: '**' },
          cwd: empty, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
        })
        assert.equal(r0.isError, false)
        assert.match(r0.content, /^No matches for/)
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }

      // Non-empty: real matches, and no blank line among them.
      writeFileSync(join(dir, 'a.ts'), '1')
      mkdirSync(join(dir, 'sub'), { recursive: true })
      writeFileSync(join(dir, 'sub/b.ts'), '1')
      const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**' }, ...ctx() })
      assert.equal(r.isError, false)
      const lines = r.content.split('\n')
      assert.equal(lines.includes(''), false, 'the workspace root must not appear as an empty match')
      assert.ok(lines.includes('a.ts') && lines.includes('sub/b.ts'), 'real matches must survive')
    })

    it('bounds a walk with a wall-clock timeout, and the bound FIRES', async () => {
      // Dropping `executeBash` dropped its 30s kill, and `fs.glob` honours no
      // AbortSignal (measured on Node 22: an already-aborted signal is simply
      // ignored), so an unbounded walk was reachable. Asserting only the happy
      // path here would be a guard whose success and whose absence look the
      // same, so the budget is shrunk to 0 and the timeout branch is taken.
      // The deadline can only be observed where the walk yields to the event
      // loop, so the tree has to be big enough to span several ticks.
      // MEASURED: 200 files in one directory times out 2/5 runs, 1000 across
      // five directories times out 5/5. 1200 is used for margin — a smaller
      // tree here would be a flaky test, not a faster one.
      for (let d = 0; d < 8; d++) {
        mkdirSync(join(dir, `d${d}`), { recursive: true })
        for (let i = 0; i < 150; i++) writeFileSync(join(dir, `d${d}/f${i}.ts`), '1')
      }

      // POSITIVE CONTROL: the same call, same tree, with the normal budget.
      const ok = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*' }, ...ctx() })
      assert.equal(ok.isError, false)
      assert.match(ok.content, /d0\/f0\.ts/)

      const prev = process.env.CHROXY_GLOB_TIMEOUT_MS
      process.env.CHROXY_GLOB_TIMEOUT_MS = '1'
      try {
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*' }, ...ctx() })
        assert.equal(r.isError, true, 'a 1ms budget must time out, not succeed')
        assert.match(r.content, /timed out after 1ms/)
      } finally {
        if (prev === undefined) delete process.env.CHROXY_GLOB_TIMEOUT_MS
        else process.env.CHROXY_GLOB_TIMEOUT_MS = prev
      }
    })

    it('treats an empty or unparseable CHROXY_GLOB_TIMEOUT_MS as unset', async () => {
      // `Number('') === 0`, and the first cut accepted any finite `>= 0`. An
      // exported-but-EMPTY var — what a bare `.env` line and `docker run -e VAR`
      // both produce — therefore gave every Glob call a 0ms budget and disabled
      // the tool outright, with nothing pointing at the cause. The knob exists
      // to make the timeout testable; switching Glob off by accident is not a
      // thing it may do.
      // The tree must be big enough that a ZERO budget would actually be
      // observed. Globbing a near-empty directory cannot tell "0 means unset"
      // apart from "0 means a 0ms budget" — the walk finishes before the timer
      // fires either way — so the assertion would pass under both readings and
      // the mutant `n >= 0` survived it. Same size as the timeout test, and
      // measured the same way.
      for (let d = 0; d < 8; d++) {
        mkdirSync(join(dir, `d${d}`), { recursive: true })
        for (let i = 0; i < 150; i++) writeFileSync(join(dir, `d${d}/f${i}.ts`), '1')
      }
      const prev = process.env.CHROXY_GLOB_TIMEOUT_MS
      try {
        // CONTROL: with the budget genuinely set to 1ms this same call DOES
        // time out, so a pass below is evidence the value was rejected as
        // unset — not evidence that the budget is unobservable.
        process.env.CHROXY_GLOB_TIMEOUT_MS = '1'
        const control = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*' }, ...ctx() })
        assert.equal(control.isError, true, 'control: a real 1ms budget must fire on this tree')

        for (const value of ['', '   ', '0', 'abc', '-1', '1e999', '0x10']) {
          process.env.CHROXY_GLOB_TIMEOUT_MS = value
          const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*' }, ...ctx() })
          assert.equal(r.isError, false, `${JSON.stringify(value)} must fall back to the default, not disable Glob`)
          assert.match(r.content, /d0\/f0\.ts/)
        }
      } finally {
        if (prev === undefined) delete process.env.CHROXY_GLOB_TIMEOUT_MS
        else process.env.CHROXY_GLOB_TIMEOUT_MS = prev
      }
    })

    it('aborts on a pattern that matches nothing', async () => {
      // `signal.aborted` was only read INSIDE the loop, so a pattern with no
      // matches never reached the check: an aborted call ran the whole tree and
      // then reported a cheerful `No matches`, isError:false. Stop is the user's
      // only lever on a runaway turn. The existing pre-abort test used a
      // MATCHING pattern, so it was satisfied by the in-loop check and never
      // covered this.
      // Enough of a tree that the walk is still running when the abort lands —
      // measured the same way the timeout test's fixture was sized.
      for (let d = 0; d < 8; d++) {
        mkdirSync(join(dir, `d${d}`), { recursive: true })
        for (let i = 0; i < 150; i++) writeFileSync(join(dir, `d${d}/f${i}.ts`), '1')
      }
      const controller = new AbortController()
      controller.abort()
      const r = await executeBuiltinTool({
        toolName: 'Glob', input: { pattern: '**/*.NOSUCHEXT' }, signal: controller.signal, ...ctx(),
      })
      assert.equal(r.isError, true, 'an aborted walk must not report success')
      assert.match(r.content, /interrupted/i)
    })

    it('honors a pre-aborted signal', async () => {
      writeFileSync(join(dir, 'a.ts'), '1')
      const controller = new AbortController()
      controller.abort()
      const r = await executeBuiltinTool({
        toolName: 'Glob', input: { pattern: '**/*' }, signal: controller.signal, ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /interrupted/i)
    })

    it('withholds a match it cannot resolve, rather than trusting it (fail-closed)', async () => {
      // The fail-closed `catch` had NO test: a mutation flipping it to
      // `return true` passed all 341 tests in this PR. That is the shape the
      // whole issue is about — success and not-checking looking identical —
      // so the escape hatch gets its own proof.
      //
      // A symlink cycle makes the component-wise resolver throw ELOOP, which
      // is the only way to reach that branch without stubbing.
      // Absolute targets: the test sandbox resolves a RELATIVE symlink target
      // against process.cwd() and blocks it as a real-user-state write.
      symlinkSync(join(dir, 'loop2'), join(dir, 'loop'))
      symlinkSync(join(dir, 'loop'), join(dir, 'loop2'))
      writeFileSync(join(dir, 'resolvable.ts'), '1')

      const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*' }, ...ctx() })
      assert.equal(r.isError, false)
      assert.equal(r.content.includes('loop'), false, 'an unresolvable match must be withheld')
      // POSITIVE CONTROL, same call: an ordinary file is still returned, so
      // this cannot pass by the tool having failed outright.
      assert.match(r.content, /resolvable\.ts/)
    })

    it('sorts, and announces truncation as a SORTED PREFIX (#7341)', async () => {
      // Both halves were regressions from the rewrite. `fs.glob` yields in
      // traversal order where every shell glob sorts, and the first cut capped
      // that unsorted stream at 10 000 with no marker — so over a 20 000-file
      // tree it returned 10 000 paths, isError:false, and `d00`-`d09` (half the
      // tree, the alphabetically-first half) were simply absent. A model would
      // conclude those directories hold no TypeScript.
      //
      // The oracle argument that justifies silence for WITHHELD matches does
      // not apply to truncation: a count of in-workspace matches reveals
      // nothing about anything outside it.
      for (let d = 0; d < 12; d++) {
        mkdirSync(join(dir, `d${String(d).padStart(2, '0')}`), { recursive: true })
        for (let i = 0; i < 1000; i++) {
          writeFileSync(join(dir, `d${String(d).padStart(2, '0')}/f${String(i).padStart(4, '0')}.ts`), '')
        }
      }
      const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*.ts' }, ...ctx() })
      assert.equal(r.isError, false)
      const lines = r.content.split('\n')
      const marker = lines[lines.length - 1]
      const data = lines.slice(0, -1)

      assert.match(marker, /truncated: showing 10000 of 12000 matches/)
      assert.equal(data.length, 10_000)
      assert.deepEqual(data, [...data].sort(), 'output must be sorted')
      // A PREFIX, not an arbitrary subset: the cut is at d09/d10, and every
      // earlier directory is complete.
      assert.equal(data[0], 'd00/f0000.ts')
      assert.equal(data[data.length - 1], 'd09/f0999.ts')
      assert.equal(data.some((l) => l.startsWith('d10/')), false)
    })

    it('sorts a result that is NOT truncated (positive control)', async () => {
      // Without this, the sort assertion above could be satisfied by the
      // truncation path alone.
      for (const name of ['zebra.ts', 'alpha.ts', 'mango.ts']) writeFileSync(join(dir, name), '')
      const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.ts' }, ...ctx() })
      assert.equal(r.isError, false)
      assert.deepEqual(r.content.split('\n'), ['alpha.ts', 'mango.ts', 'zebra.ts'])
      assert.equal(r.content.includes('truncated'), false)
    })

    it('accepts a valid `path` and confines relative to it (#7341)', async () => {
      // The rewrite changed what `path` means underneath — `fsGlob(pattern,
      // {cwd: realRoot})` and confinement measured against `realRoot`, not
      // `cwd` — and no test passed a VALID `path` at all. The only existing one
      // asserted the `/etc` rejection.
      mkdirSync(join(dir, 'sub/deep'), { recursive: true })
      writeFileSync(join(dir, 'sub/a.ts'), '1')
      writeFileSync(join(dir, 'sub/deep/b.ts'), '1')
      writeFileSync(join(dir, 'outside-sub.ts'), '1')
      symlinkSync('/etc', join(dir, 'sub/esc'))

      const abs = await executeBuiltinTool({
        toolName: 'Glob', input: { pattern: '**/*.ts', path: join(dir, 'sub') }, ...ctx(),
      })
      assert.equal(abs.isError, false)
      assert.deepEqual(abs.content.split('\n'), ['a.ts', 'deep/b.ts'])
      assert.equal(abs.content.includes('outside-sub'), false, 'results are relative to `path`')

      const rel = await executeBuiltinTool({
        toolName: 'Glob', input: { pattern: '*.ts', path: 'sub' }, ...ctx(),
      })
      assert.equal(rel.isError, false)
      assert.match(rel.content, /a\.ts/)

      // Confinement still applies BELOW a valid subdirectory root.
      const esc = await executeBuiltinTool({
        toolName: 'Glob', input: { pattern: '{esc,deep}/*', path: join(dir, 'sub') }, ...ctx(),
      })
      assert.equal(esc.content.includes('passwd'), false, 'confinement must hold under a `path` root')
      assert.match(esc.content, /deep\/b\.ts/)
    })

    it('never returns a path outside the workspace, over a corpus (property)', async () => {
      // The rejection lists in this file are a hand-written enumeration of the
      // classes someone thought of, and two review rounds found six more. This
      // asserts the PROPERTY instead: whatever the pattern, every path the tool
      // returns resolves inside the workspace. It is the test that does not
      // need updating when round seven turns up.
      const outer = mkdtempSync(join(tmpdir(), 'chroxy-glob-outer-'))
      try {
        writeFileSync(join(outer, 'TOPSECRET.txt'), 'pw')
        const ws = join(outer, 'ws')
        mkdirSync(join(ws, 'sub'), { recursive: true })
        writeFileSync(join(ws, 'a.ts'), '1')
        writeFileSync(join(ws, 'sub/b.ts'), '1')
        symlinkSync(outer, join(ws, 'up'))
        symlinkSync('/etc', join(ws, 'esc'))

        const bits = ['*', '**', '..', '.', '/', '{', '}', ',', '~', "'", '"', '[', ']', '?', 'TOP', 'up', 'esc']
        const corpus = ['../TOP*', '{a}b,../TOP*}', 'up/TOP*', 'esc/pass*', '{.,..}/TOP*', '.*/TOP*']
        // Deterministic pseudo-random assembly — no Math.random, so a failure
        // is reproducible from the seed.
        let seed = 1337
        const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648)
        for (let i = 0; i < 300; i++) {
          let pat = ''
          const len = 2 + (next() % 5)
          for (let j = 0; j < len; j++) pat += bits[next() % bits.length]
          corpus.push(pat)
        }

        const realWs = realpathSync(ws)
        for (const pattern of corpus) {
          const r = await executeBuiltinTool({
            toolName: 'Glob', input: { pattern },
            cwd: ws, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
          })
          if (r.isError) continue                       // refused outright — fine
          if (r.content.startsWith('No matches')) continue
          for (const line of r.content.split('\n')) {
            const resolved = realpathSync(resolve(realWs, line))
            assert.ok(
              resolved === realWs || resolved.startsWith(realWs + '/'),
              `pattern ${JSON.stringify(pattern)} returned ${line} -> ${resolved}, outside ${realWs}`,
            )
          }
        }
      } finally {
        rmSync(outer, { recursive: true, force: true })
      }
    })

    // #7918 review (containment) — the whole-pattern brace expansion runs
    // AFTER `globPatternEscapeReason`, which sees only the unexpanded text, so
    // concatenation can build what it would have refused: `{.,x}{.,y/z}`
    // expands to `..`, and `{,x}/abs/...` to an absolute path. Each pattern
    // here is one raw `fs.glob` really does answer with an ESCAPING match (the
    // precondition below proves it — without it, "the tool returned nothing
    // outside" would pass for a corpus that never reached outside at all), and
    // the tool must return none. It also routes the escape through the other
    // two changes in this PR: a determinate directory-only symlink (#7917,
    // `{up/,x/y}`) and a `**`-free chain through a self-loop, which now skips
    // the ancestor-cycle refusal (#7916, `sub/selfloop/out`).
    it('never returns a path outside the workspace for a brace-expanded pattern (#7918/#7917/#7916)', {
      // symlinkSync needs a privilege the Windows CI runner lacks by default (#7288).
      skip: process.platform === 'win32',
    }, async () => {
      const outer = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-glob-expand-outer-')))
      try {
        writeFileSync(join(outer, 'TOPSECRET.txt'), 'pw')
        const ws = join(outer, 'ws')
        mkdirSync(join(ws, 'sub'), { recursive: true })
        writeFileSync(join(ws, 'sub', 'b.ts'), '1')
        symlinkSync(outer, join(ws, 'up'))
        symlinkSync('.', join(ws, 'sub', 'selfloop'))
        symlinkSync(outer, join(ws, 'sub', 'out'))

        const escapes = (rel) => {
          let real
          try { real = realpathSync(resolve(ws, rel)) } catch { return false }
          return !(real === ws || real.startsWith(ws + '/'))
        }
        // [pattern, the in-workspace match it must STILL return] — the second
        // column proves the expansion and the walk really ran, so an empty
        // answer cannot pass for a withheld one.
        const corpus = [
          ['{{.,x}{.,y/z}/TOP*,sub/b.ts}', 'sub/b.ts'],
          ['{up,x/y,sub}/{TOP*,b.ts}', 'sub/b.ts'],
          ['{up/,sub/}', 'sub'],
          ['{sub/selfloop/out,x/y,sub/selfloop}/{TOP*,b.ts}', 'sub/selfloop/b.ts'],
          ['{sub/selfloop/selfloop/out/,sub/selfloop/selfloop/}', 'sub/selfloop/selfloop'],
          [`{{,x}${outer}/TOPSECRET.txt,sub/b.ts}`, 'sub/b.ts'],
        ]
        for (const [pattern, mustReturn] of corpus) {
          const raw = []
          for await (const e of fsGlob(pattern, { cwd: ws })) raw.push(e)
          assert.ok(raw.some(escapes), `precondition: raw fs.glob must reach outside for ${JSON.stringify(pattern)} (got ${JSON.stringify(raw)})`)

          const r = await executeBuiltinTool({
            toolName: 'Glob', input: { pattern },
            cwd: ws, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
          })
          assert.equal(r.isError, false, `${JSON.stringify(pattern)}: ${r.content}`)
          const lines = r.content.split('\n')
          assert.ok(lines.includes(mustReturn), `${JSON.stringify(pattern)} must still return ${mustReturn}, got ${JSON.stringify(r.content)}`)
          for (const line of lines) {
            assert.ok(!line.includes('TOPSECRET'), `${JSON.stringify(pattern)} leaked ${line}`)
            assert.ok(!escapes(line), `${JSON.stringify(pattern)} returned ${line}, which resolves outside ${ws}`)
          }
        }
      } finally {
        rmSync(outer, { recursive: true, force: true })
      }
    })

    it('returns the in-workspace match and withholds the escaping one, in ONE call', async () => {
      // This test was written as a positive control against the #7273 shape and
      // WAS ITSELF that shape. It globbed `*/pass*` and asserted `esc/passwd`
      // was absent — but `fs.glob` does not descend a wildcard-matched
      // symlinked directory, so `*/pass*` never yields `esc/passwd` under any
      // implementation. It asserted the absence of something that was never
      // there, and passed with the entire fix deleted.
      //
      // `{esc,keep}/pass*` names the symlinked directory explicitly, so the
      // escaping match really is produced and really must be withheld. The
      // fsGlob precondition below is what proves that, and is the difference
      // between a control and a decoration.
      //
      // It is also the ONLY test where one call produces matches from two
      // different directories, one in-workspace and one out — which is what
      // pins `confineGlobMatches`' per-directory verdict cache. A mutant that
      // computed a real verdict for the first directory and assumed `true` for
      // every later one returned /etc/passwd with all 346 tests green.
      // The escape target is a directory THIS TEST owns, not `/etc`. An earlier
      // cut pointed at `/etc` and pinned the exact match set — which passed on
      // macOS and failed on the Linux CI runner, where `/etc` also holds
      // `passwd-`. A precondition that encodes the host's filesystem contents
      // is a precondition about the wrong thing.
      const outside = mkdtempSync(join(tmpdir(), 'chroxy-glob-outside-'))
      try {
        writeFileSync(join(outside, 'secret.txt'), 'pw')
        symlinkSync(outside, join(dir, 'esc'))
        mkdirSync(join(dir, 'keep'), { recursive: true })
        writeFileSync(join(dir, 'keep/secret.txt'), 'ok')

        const raw = []
        for await (const f of fsGlob('{esc,keep}/secret*', { cwd: dir })) raw.push(f)
        assert.deepEqual(
          raw.sort(), ['esc/secret.txt', 'keep/secret.txt'],
          'precondition: the matcher must really produce BOTH, or this proves nothing',
        )

        const r = await executeBuiltinTool({
          toolName: 'Glob',
          input: { pattern: '{esc,keep}/secret*' },
          ...ctx(),
        })
        assert.equal(r.isError, false)
        assert.equal(r.content, 'keep/secret.txt', 'exactly the in-workspace match, nothing else')
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('lists an in-workspace symlink that stays in the workspace (positive control)', async () => {
      // A symlink is confined by where it POINTS, not by being a symlink.
      mkdirSync(join(dir, 'real'), { recursive: true })
      writeFileSync(join(dir, 'real/inside.txt'), 'ok')
      symlinkSync(join(dir, 'real'), join(dir, 'alias'))
      const r = await executeBuiltinTool({
        toolName: 'Glob',
        input: { pattern: 'alias/*.txt' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /alias\/inside\.txt/)
      assert.equal(r.content.includes('withheld'), false)
    })

    it('allows ordinary patterns that merely LOOK like traversal (positive control)', async () => {
      // `*~` and `a..b` are legitimate filenames. A containment rule that
      // rejected them would be a functional regression, not extra safety.
      writeFileSync(join(dir, 'draft.md~'), 'x')
      writeFileSync(join(dir, 'v1..v2.diff'), 'y')
      for (const pattern of ['*~', 'v1..v2.diff']) {
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern }, ...ctx() })
        assert.equal(r.isError, false, `${pattern} must still work`)
        assert.equal(r.content.includes('No matches'), false, `${pattern} must still match`)
      }
    })

    // #7355 — host Glob must be case-SENSITIVE, matching the container (bash's
    // own globbing has no case-folding override) and Claude Code's own Glob.
    // `fs.glob` hard-codes `nocase: isWindows || isMacOS` (measured on Node
    // 22.22.3: an explicit `nocase: false` is silently ignored), so these
    // reproduce on a case-insensitive filesystem (this machine) and are inert
    // — not red, not proof of anything — on a case-sensitive one (Linux CI),
    // where the underlying `fs.glob` call was never case-folding in the first
    // place. That asymmetry is inherent to the bug, not a gap in the test.
    describe('case sensitivity (#7355)', () => {
      it('a wildcard pattern does not match a wrong-case extension', async () => {
        writeFileSync(join(dir, 'Upper.TS'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.ts' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.match(r.content, /No matches/)
      })

      it('a wildcard pattern still matches the SAME case (positive control)', async () => {
        writeFileSync(join(dir, 'Upper.TS'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.TS' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, 'Upper.TS')
      })

      it('a literal (magic-free) pattern with the wrong case is "No matches", never the pattern\'s own spelling', async () => {
        // Pre-fix, `fs.glob` verifies existence case-INSENSITIVELY for a fully
        // literal pattern and then echoes the PATTERN's own text back as the
        // "match" — `upper.ts` against a real `Upper.TS` returned `upper.ts`,
        // a path that does not exist as spelled.
        writeFileSync(join(dir, 'Upper.TS'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'upper.ts' }, ...ctx() })
        assert.equal(r.isError, false)
        // Exact equality: the standard "No matches for <pattern>" message
        // legitimately contains the pattern's own text, so only an exact
        // match rules out a fabricated `upper.ts` being returned as if it
        // were a real result line alongside that message.
        assert.equal(r.content, 'No matches for upper.ts')
      })

      it('a literal pattern with the correct case still matches (positive control)', async () => {
        writeFileSync(join(dir, 'Upper.TS'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'Upper.TS' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, 'Upper.TS')
      })

      it('a literal DIRECTORY segment with the wrong case is rejected', async () => {
        mkdirSync(join(dir, 'dir'), { recursive: true })
        writeFileSync(join(dir, 'dir/dir.ts'), '1')
        const wrong = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'DIR/*.ts' }, ...ctx() })
        assert.equal(wrong.isError, false)
        assert.match(wrong.content, /No matches/)
        // Positive control, same fixture: the correctly-cased directory still works.
        const right = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'dir/*.ts' }, ...ctx() })
        assert.equal(right.content, 'dir/dir.ts')
      })

      it('bracket and brace expressions still work, case-sensitively on their literal parts', async () => {
        writeFileSync(join(dir, 'Upper.TS'), '1')
        const bracketRight = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '[Uu]pper.TS' }, ...ctx() })
        assert.equal(bracketRight.content, 'Upper.TS', '[Uu] must still match the U')
        const bracketWrong = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '[Uu]pper.ts' }, ...ctx() })
        assert.match(bracketWrong.content, /No matches/, 'the literal .ts suffix must still reject .TS')
        const braceRight = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{Upper,Other}.TS' }, ...ctx() })
        assert.equal(braceRight.content, 'Upper.TS')
        const braceWrong = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{upper,other}.TS' }, ...ctx() })
        assert.match(braceWrong.content, /No matches/)
      })

      // A brace pattern with alternatives that case-fold to the SAME real
      // file (`abc`/`ABC` both fold to a real `ABC.ts` on this case-
      // insensitive filesystem) makes `fs.glob` hand back ONE raw candidate
      // PER matching alternative — `abc.ts` and `ABC.ts` — each echoing its
      // own branch's text. Both independently pass the case check (the
      // pattern legitimately accepts either spelling), so pushing the
      // candidate's own text instead of the verified real name returned BOTH:
      // the real `ABC.ts` and a phantom `abc.ts` line that does not exist on
      // disk. This is the exact "pattern's own spelling, not the file's"
      // defect #7355 was filed to close, reached through a brace pattern
      // rather than the fully-literal repro the issue used.
      it('a brace pattern whose alternatives fold to the same real file returns it ONCE, correctly spelled', async () => {
        writeFileSync(join(dir, 'ABC.ts'), '1') // the only real file on disk
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{abc,ABC}.ts' }, ...ctx() })
        assert.equal(r.isError, false)
        // Exact equality: rules out a phantom `abc.ts` line appearing
        // alongside the real, correctly-spelled `ABC.ts`.
        assert.equal(r.content, 'ABC.ts')
      })

      // Flagged by Copilot review on this PR: `fs.glob` normalizes away a `.`
      // path segment in every match it returns (`./src/*.ts` yields a Dirent
      // whose parentPath/name never mention the leading `.`), so compiling the
      // case check from the PATTERN's own unfiltered segments (`.`, `src`,
      // `*.ts` — 3 segments) could never align with the real match's segments
      // (`src`, `x.ts` — 2 segments), failing every `./`-prefixed pattern
      // closed. `./` prefixes are explicitly legal Glob input
      // (`globPatternEscapeReason` has no rule against a bare `.` segment).
      it('a "./"-prefixed pattern still matches (fs.glob drops the "." segment from real matches)', async () => {
        mkdirSync(join(dir, 'src'), { recursive: true })
        writeFileSync(join(dir, 'src/x.ts'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: './src/*.ts' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, 'src/x.ts')
      })

      it('a "." segment in the MIDDLE of a pattern still matches', async () => {
        mkdirSync(join(dir, 'src'), { recursive: true })
        writeFileSync(join(dir, 'src/x.ts'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'src/./x.ts' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, 'src/x.ts')
      })

      it('a recursive ** pattern still finds nested matches after the case filter', async () => {
        mkdirSync(join(dir, 'sub'), { recursive: true })
        writeFileSync(join(dir, 'sub/keep.ts'), '1')
        writeFileSync(join(dir, 'Upper.TS'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*.ts' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.match(r.content, /sub\/keep\.ts/)
        assert.equal(r.content.includes('Upper.TS'), false)
      })

      // A pattern with TWO (or more) `**` segments used to be marked
      // `ambiguous` and unconditionally fail-closed the case check, dropping
      // EVERY match — including ones whose real on-disk segments already
      // matched the pattern's case exactly. That is silent false-negative
      // data loss on an ordinary, common pattern shape (a monorepo query like
      // `packages/**/src/**/*.test.js`), not merely a narrowing: measured
      // against origin/main pre-#7355, the identical fixture below returned
      // both correctly-cased matches; post-#7355 it returned "No matches".
      it('a pattern with two "**" segments still matches correctly-cased real files', async () => {
        mkdirSync(join(dir, 'packages/server/src/sub'), { recursive: true })
        writeFileSync(join(dir, 'packages/server/src/sub/foo.test.js'), '1')
        writeFileSync(join(dir, 'packages/server/src/foo.test.js'), '1')
        const r = await executeBuiltinTool({
          toolName: 'Glob',
          input: { pattern: 'packages/**/src/**/*.test.js' },
          ...ctx(),
        })
        assert.equal(r.isError, false)
        assert.equal(r.content, 'packages/server/src/foo.test.js\npackages/server/src/sub/foo.test.js')
      })

      // Same two-"**" shape, but the fixed literal segment between the two
      // globstars ("src") is wrong-cased on disk ("Src") — the case check
      // must still reject it, not just fall back to "**" leniency for having
      // more than one globstar.
      it('a pattern with two "**" segments still rejects a wrong-case fixed segment between them', async () => {
        mkdirSync(join(dir, 'packages/server/Src/sub'), { recursive: true })
        writeFileSync(join(dir, 'packages/server/Src/sub/foo.test.js'), '1')
        const r = await executeBuiltinTool({
          toolName: 'Glob',
          input: { pattern: 'packages/**/src/**/*.test.js' },
          ...ctx(),
        })
        assert.equal(r.isError, false)
        assert.match(r.content, /No matches/)
      })

      // The former case-check compiled each LITERAL pattern segment straight
      // to a backtracking RegExp (`*` -> `[\s\S]*`, chained per occurrence).
      // A segment shaped like this one, tested against a REAL on-disk name
      // that almost-but-doesn't match, is the textbook catastrophic-
      // backtracking shape: measured pre-fix at 0.03ms for a 20-char name,
      // 811ms at 30 chars, 5.9s at 32 — and this check runs SYNCHRONOUSLY in
      // confineGlobMatches, AFTER runGlob's own 30s walk-timeout race has
      // already resolved, so nothing bounded it.
      //
      // This calls compileCaseCheck/caseCheckPasses DIRECTLY rather than
      // through executeBuiltinTool's Glob path, and that is deliberate, not
      // a shortcut: runGlob's WALK calls Node's OWN `fsGlob(pattern, ...)`
      // first, which has to evaluate this SAME pattern text against the SAME
      // real name to decide candidacy, before confineGlobMatches (and this
      // check) ever runs — and Node's fs.glob has an independent, unrelated
      // backtracking vulnerability of its own (measured: 87 SECONDS for this
      // exact pattern against a 40-char name, via `node:fs/promises`'s
      // `glob()` alone, no chroxy code involved). An integration-level test
      // long enough to distinguish the old regex from the new DP would hang
      // on THAT walk before ever reaching the code this fix changed — that
      // is a separate, pre-existing, out-of-scope defect in Node's runtime,
      // not something `compileCaseCheck` can fix, so it is flagged as a
      // follow-up rather than worked around here with a shorter, weaker name
      // that would not actually prove this check is polynomial.
      it('caseCheckPasses does not catastrophically backtrack on a pathological pattern segment (direct — see comment)', () => {
        const evilPattern = '*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b.ts'
        // Does not match the evil pattern (no trailing "b") — the exact shape
        // that made the old RegExp explore exponentially many partial
        // matches before concluding failure.
        const longName = `${'a'.repeat(5000)}.ts`
        const check = compileCaseCheck(evilPattern)
        const t0 = Date.now()
        const result = caseCheckPasses(check, [longName])
        const elapsedMs = Date.now() - t0
        assert.equal(result, false)
        assert.ok(elapsedMs < 500, `case check must stay fast, took ${elapsedMs}ms for a 5000-char name`)
      })

      // #7898 round 3 — the DP that replaced the backtracking RegExp above
      // (parseSegmentTokens/segmentMatches, ccd677c4b) reintroduced an
      // analogous blowup in its OWN `alt` ({a,b}) branch: advanceToken used
      // to recompute each brace alternative from scratch for every
      // individually-reachable string offset (`for (const j of reachable) {
      // for (const option ...) { advanceTokens(option, str, new Set([j])) }
      // }`), instead of feeding an option the whole reachable set in one
      // call the way `star` already does one level up. A pattern segment
      // built from L sequential `{*a,*b}`-shaped groups — an entirely
      // ordinary glob shape, `{*.ts,*.js}` is no different — paid an extra
      // O(name.length) at EVERY group, because each group's own `*`
      // re-expands the reachable set back toward the full name length right
      // before the next group starts. Measured pre-fix: 20 groups (140
      // chars) against a 5000-char non-matching real segment took 12.96
      // SECONDS; even bounded to a filesystem-realistic 255-byte name, 100
      // groups (a 700-char pattern — nothing upstream caps pattern length)
      // already exceeded 100ms. Same failure shape as the test above (a
      // synchronous, per-match, unbounded cost inside confineGlobMatches),
      // different branch of the same new code.
      it('caseCheckPasses does not blow up on a chained brace-with-wildcard pattern segment (direct)', () => {
        const evilPattern = '{*a,*b}'.repeat(30) // 210 chars, an ordinary-looking shape
        // A homogeneous name of one repeated character legitimately MATCHES
        // this pattern (it can always be split into 30 nonempty pieces each
        // ending in 'a'), so this is a pure timing assertion — the fix does
        // not change the result, only how long it takes to compute it (the
        // pre-fix code took 12.96s for this exact input at n=5000).
        const longName = 'a'.repeat(5000)
        const check = compileCaseCheck(evilPattern)
        const t0 = Date.now()
        const result = caseCheckPasses(check, [longName])
        const elapsedMs = Date.now() - t0
        assert.equal(result, true)
        assert.ok(elapsedMs < 500, `case check must stay fast, took ${elapsedMs}ms for a 5000-char name`)
      })

      // #7898 round 3 — parseBracketExpr accepts any `-`-range TEXT
      // (`[z-a]`, or `[b-!a!x]` from adjacent special characters colliding)
      // without checking the range is in order. JS's RegExp constructor
      // rejects an out-of-order range and THROWS synchronously from inside
      // compileCaseCheck, which runs unconditionally for every Glob call
      // whose pattern has a bracket segment — even with zero candidate
      // files, confineGlobMatches compiles the case check up front. Nothing
      // between there and executeBuiltinTool's outer catch stops it, so an
      // ordinary "No matches" (fs.glob itself tolerates `[z-a]bc.ts` and
      // just matches nothing — verified directly against node:fs/promises's
      // glob()) turned into a surfaced "Tool Glob failed: Invalid regular
      // expression..." error instead.
      it('compileCaseCheck does not throw on an out-of-order bracket range (fails closed instead)', () => {
        for (const pattern of ['[z-a]x', '[9-0]bc', '[b-!a!x]', '[a[^-[]']) {
          const check = compileCaseCheck(pattern)
          assert.equal(caseCheckPasses(check, ['probe']), false, `pattern ${pattern} must fail closed, not throw`)
        }
      })

      it('Glob with an out-of-order bracket range pattern returns "No matches", not a tool error', async () => {
        writeFileSync(join(dir, 'xbc.ts'), '1')
        const r = await executeBuiltinTool({
          toolName: 'Glob',
          input: { pattern: '[z-a]bc.ts' },
          ...ctx(),
        })
        assert.equal(r.isError, false)
        assert.match(r.content, /No matches/)
      })
    })

    // #7899 — Node's `fs.glob` hard-codes case-INSENSITIVE candidate
    // generation on macOS/Windows, and for a NEGATED bracket class
    // (`[^X]`/`[!x]`) that folding excludes BOTH cases of the named character
    // from the candidate set it generates — not just the named one — so
    // `[^X]*.ts` against a real `xyz.ts` produced no candidates from `fs.glob`
    // itself, and #7898's case-check post-filter could never recover a match
    // `fs.glob` never produced in the first place. #7901 removes `fs.glob`
    // from the host path entirely: `walkGlob` tests every real directory
    // entry directly against `segmentMatches` (case-sensitive by
    // construction, no folding of any kind), so there is no separate
    // candidate-generation step left to disagree with the case check. These
    // pin the issue's own acceptance criteria — a real file is created on
    // ONE side of the case distinction at a time because this dev machine's
    // filesystem (like the CI macOS runner) is case-INSENSITIVE and
    // case-PRESERVING: `xyz.ts` and `Xyz.ts` cannot coexist as two files, only
    // as two possible spellings of the same inode.
    describe('negated bracket class case (#7899)', () => {
      it('[^X]*.ts matches a real lowercase xyz.ts; [!x]*.ts excludes it', async () => {
        writeFileSync(join(dir, 'xyz.ts'), '1')
        const included = await executeBuiltinTool({
          toolName: 'Glob', input: { pattern: '[^X]*.ts' }, ...ctx(),
        })
        assert.equal(included.isError, false)
        assert.equal(included.content, 'xyz.ts', '[^X] must not fold away the real lowercase file')

        const excluded = await executeBuiltinTool({
          toolName: 'Glob', input: { pattern: '[!x]*.ts' }, ...ctx(),
        })
        assert.equal(excluded.isError, false)
        assert.match(excluded.content, /No matches/, '[!x] must exclude the real lowercase-x file')
      })

      it('[!x]*.ts matches a real uppercase Xyz.ts; [^X]*.ts excludes it', async () => {
        writeFileSync(join(dir, 'Xyz.ts'), '1')
        const included = await executeBuiltinTool({
          toolName: 'Glob', input: { pattern: '[!x]*.ts' }, ...ctx(),
        })
        assert.equal(included.isError, false)
        assert.equal(included.content, 'Xyz.ts', '[!x] must not fold away the real uppercase file')

        const excluded = await executeBuiltinTool({
          toolName: 'Glob', input: { pattern: '[^X]*.ts' }, ...ctx(),
        })
        assert.equal(excluded.isError, false)
        assert.match(excluded.content, /No matches/, '[^X] must exclude the real uppercase-X file')
      })
    })

    // #7951 — a matched `{...}` with NO top-level comma is literal, never
    // alternation, in the PER-SEGMENT compiler (`parseSegmentTokens`) — the
    // same rule `expandBraces` already enforced on the slash-spanning path.
    // Before this fix, `parseSegmentTokens` treated EVERY matched brace pair
    // as an `alt` token regardless of comma count, so `{dup}` wrongly
    // matched a real file/dir named `dup`, and a real file literally named
    // `{braces}.txt` was never reachable by the pattern that names it.
    describe('comma-less brace is literal, not alternation (#7951)', () => {
      it('{dup} does not match a real file/dir named "dup"', async () => {
        writeFileSync(join(dir, 'dup'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{dup}' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.match(r.content, /No matches/)
      })

      it('a pattern with literal braces matches a real file spelled with literal braces', async () => {
        writeFileSync(join(dir, '{braces}.txt'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{braces}.txt' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, '{braces}.txt')
      })

      it('a wildcard INSIDE a comma-less brace still functions', async () => {
        // `{a*}` has no top-level comma, so the braces are literal — but the
        // `*` between them is still an ordinary wildcard token, matching a
        // real file whose name is spelled with literal braces around
        // whatever the `*` absorbed.
        writeFileSync(join(dir, '{axyz}'), '1')
        writeFileSync(join(dir, 'axyz'), '1') // negative control: braces are NOT stripped
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{a*}' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, '{axyz}', 'only the literally-braced file matches, never the unbraced one')
      })

      it('a NESTED group with its own top-level comma still expands inside a comma-less outer group', async () => {
        // `{{dup,nested}}` — outer group has no comma (one option: the
        // inner `{dup,nested}`), so its braces stay literal; the INNER
        // group does have a comma and still expands, matching `fs.glob`'s
        // own rule (`expandBraces`'s doc: "anything expandable nested
        // inside it still expands").
        writeFileSync(join(dir, '{dup}'), '1')
        writeFileSync(join(dir, '{nested}'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{{dup,nested}}' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, '{dup}\n{nested}')
      })

      // #7951 — braceCloseTable's PAIRING bracket-awareness, exercised
      // through the PER-SEGMENT path directly (no '/' inside the braces, so
      // this never takes expandBraces's whole-pattern route — the parity
      // harness's equivalent row for this shape (`bracecomma/{a[}]b,s}`)
      // goes through the SAME per-segment compiler for the same reason, but
      // this pins it here too, independent of that harness's oracle).
      // `{a[}]b,s}` — the embedded `}` inside `[}]` is a class member, not
      // a group closer, so the REAL outer group spans the whole text (one
      // top-level comma, splitting into `a[}]b` and `s`); `a[}]b` recompiles
      // with `[}]` as a real class matching literal `}`, requiring a 3-char
      // name `a}b` that does not exist, so only `s` matches.
      it('an embedded "}" inside a bracket class does not end a comma-less-looking group early', async () => {
        writeFileSync(join(dir, 's'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{a[}]b,s}' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, 's')
      })
    })

    // #7951 — `{X..Y}` / `{X..Y..S}` range expansion, matching `fs.glob`'s
    // own observed behavior (see `parseRangeGroup`'s doc for every case
    // measured directly against it: ascending/descending, zero-padded,
    // negative, stepped, mixed-case letter ranges). The permanent parity
    // harness (byok-glob-fs-glob-parity.test.js) proves this end-to-end
    // against the real oracle; these direct-call tests pin the ARITHMETIC
    // (padding width, direction, the zero-step refusal) at full scale,
    // the same reason `expandBraces` itself is called directly above.
    describe('range expansion (#7951)', () => {
      it('parseRangeGroup: ascending, descending, and single-member numeric ranges', () => {
        assert.equal(parseRangeGroup('1..3').count, 3)
        assert.deepEqual([0, 1, 2].map((k) => parseRangeGroup('1..3').nth(k)), ['1', '2', '3'])
        assert.equal(parseRangeGroup('3..1').count, 3)
        assert.deepEqual([0, 1, 2].map((k) => parseRangeGroup('3..1').nth(k)), ['3', '2', '1'])
        assert.equal(parseRangeGroup('5..5').count, 1)
        assert.deepEqual([parseRangeGroup('5..5').nth(0)], ['5'])
      })

      it('parseRangeGroup: zero-padding takes the WIDER endpoint\'s own printed length, sign included', () => {
        // Verified directly against fs.glob: {001..10} and {1..010} both
        // produce 001..010 (width 3); {-01..1} produces -01, 000, 001
        // (width 3 — the '-' counts toward the width).
        const a = parseRangeGroup('001..10')
        assert.deepEqual([0, 1, 9].map((k) => a.nth(k)), ['001', '002', '010'])
        const b = parseRangeGroup('1..010')
        assert.deepEqual([0, 1, 9].map((k) => b.nth(k)), ['001', '002', '010'])
        const c = parseRangeGroup('-01..1')
        assert.deepEqual([0, 1, 2].map((k) => c.nth(k)), ['-01', '000', '001'])
        // A lone "0" has no second digit to pad — not padded.
        assert.deepEqual([parseRangeGroup('0..2').nth(0), parseRangeGroup('0..2').nth(2)], ['0', '2'])
      })

      it('parseRangeGroup: stepped ranges, both directions', () => {
        const asc = parseRangeGroup('1..10..2')
        assert.equal(asc.count, 5)
        assert.deepEqual([0, 1, 2, 3, 4].map((k) => asc.nth(k)), ['1', '3', '5', '7', '9'])
        const desc = parseRangeGroup('10..1..3')
        assert.deepEqual([0, 1, 2, 3].map((k) => desc.nth(k)), ['10', '7', '4', '1'])
      })

      it('parseRangeGroup: single-letter ranges, ascending/descending/mixed-case', () => {
        const az = parseRangeGroup('a..c')
        assert.equal(az.count, 3)
        assert.deepEqual([0, 1, 2].map((k) => az.nth(k)), ['a', 'b', 'c'])
        const desc = parseRangeGroup('c..a')
        assert.deepEqual([0, 1, 2].map((k) => desc.nth(k)), ['c', 'b', 'a'])
        // Mixed case: a raw UTF-16 code-unit walk, matching fs.glob's own
        // observed behavior (verified directly: {a..C} steps THROUGH the
        // punctuation code points between 'C' and 'a' in ASCII).
        const mixed = parseRangeGroup('a..C')
        assert.equal(mixed.count, 'a'.charCodeAt(0) - 'C'.charCodeAt(0) + 1)
        assert.equal(mixed.nth(0), 'a')
        assert.equal(mixed.nth(mixed.count - 1), 'C')
      })

      it('parseRangeGroup: refuses a zero (or unparsable) step — never divides by zero, never returns a range', () => {
        assert.equal(parseRangeGroup('1..10..0'), null)
        assert.equal(parseRangeGroup('a..z..0'), null)
      })

      it('parseRangeGroup: rejects non-range shapes (mixed type, multi-char letters, non-integer, a comma)', () => {
        for (const body of ['ab..cd', 'a..3', '1..a', '1..3.5', '1..3,x', 'dup']) {
          assert.equal(parseRangeGroup(body), null, `${JSON.stringify(body)} must not be treated as a range`)
        }
      })

      it('hasRangeBrace: true for a range shape, false for an ordinary pattern or comma-less brace', () => {
        assert.equal(hasRangeBrace('file{1..3}.txt'), true)
        assert.equal(hasRangeBrace('{a..z}'), true)
        assert.equal(hasRangeBrace('*.ts'), false)
        assert.equal(hasRangeBrace('{dup}'), false)
        assert.equal(hasRangeBrace('{ts,js}'), false)
        // Bracket-expression aware, matching the pairing awareness above:
        // a `..` inside `[...]` is a class member (a two-member class:
        // '.' and '.'), not range syntax.
        assert.equal(hasRangeBrace('{[..]}'), false)
      })

      it('expandBraces expands a numeric range end to end, including a non-slash-spanning pattern', () => {
        assert.deepEqual(expandBraces('file{1..3}.txt').sort(), ['file1.txt', 'file2.txt', 'file3.txt'])
        assert.deepEqual(expandBraces('{01..03}.txt').sort(), ['01.txt', '02.txt', '03.txt'])
      })

      it('Glob expands a non-slash-spanning numeric range against real files', async () => {
        writeFileSync(join(dir, 'file1.txt'), '1')
        writeFileSync(join(dir, 'file2.txt'), '1')
        writeFileSync(join(dir, 'file3.txt'), '1')
        writeFileSync(join(dir, 'file4.txt'), '1') // negative control — must NOT appear
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'file{1..3}.txt' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, 'file1.txt\nfile2.txt\nfile3.txt')
      })

      it('Glob expands a letter range against real files', async () => {
        writeFileSync(join(dir, 'a.txt'), '1')
        writeFileSync(join(dir, 'b.txt'), '1')
        writeFileSync(join(dir, 'c.txt'), '1')
        writeFileSync(join(dir, 'd.txt'), '1') // negative control
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{a..c}.txt' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, 'a.txt\nb.txt\nc.txt')
      })

      it('Glob with a zero-step range fails closed: no throw, treated as literal, clean "No matches"', async () => {
        // fs.glob itself THROWS `RangeError: Invalid array length` for this
        // exact shape (measured directly — see parseRangeGroup's doc and
        // the parity harness's comment on why this pattern is excluded from
        // its oracle-based table). This tool must never reproduce that
        // crash: a zero step is refused as a range and the group falls back
        // to literal `{...}` text, which matches no real file here.
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'x{1..10..0}.txt' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.match(r.content, /No matches/)
      })

      // #7951 acceptance — the SAME count-before-materialize cap #7945 built
      // for comma groups, applied to ranges: `{1..100000}` (100,001 members)
      // and `{a..z}{a..z}{a..z}` (17,576 combinations) both exceed
      // GLOB_BRACE_EXPANSION_CAP (1,000) and must FAIL CLOSED with a clean
      // EINVAL, never a silent truncation and never by generating the range
      // to find out how big it is.
      it('Glob rejects an over-cap numeric range fast, without materializing it', { timeout: 5000 }, async () => {
        const t0 = Date.now()
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{1..100000}' }, ...ctx() })
        const elapsedMs = Date.now() - t0
        assert.equal(r.isError, true)
        assert.match(r.content, /EINVAL: glob pattern is too complex/)
        assert.match(r.content, /brace alternatives/)
        assert.ok(elapsedMs < 2000, `rejection must be near-instant, took ${elapsedMs}ms`)
      })

      it('Glob rejects an over-cap combinatorial letter-range pattern fast, without materializing it', { timeout: 5000 }, async () => {
        const t0 = Date.now()
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{a..z}{a..z}{a..z}' }, ...ctx() })
        const elapsedMs = Date.now() - t0
        assert.equal(r.isError, true)
        assert.match(r.content, /EINVAL: glob pattern is too complex/)
        assert.match(r.content, /brace alternatives/)
        assert.ok(elapsedMs < 2000, `rejection must be near-instant, took ${elapsedMs}ms`)
      })

      // #7951 acceptance — a dedicated, tight timing budget (the task's own
      // number: the first #7945 draft blocked the event loop 292 SECONDS on
      // an analogous comma-group shape). Called directly, the same reason
      // `expandBraces`'s own linear-time test above calls it directly rather
      // than through the whole tool dispatch (root resolution, the deadline
      // race, confinement overhead would fold into the measurement and
      // loosen what the number actually proves).
      it('expandBraces/hasRangeBrace stay well under 50ms on adversarial range patterns (event-loop-block budget)', { timeout: 5000 }, () => {
        for (const pattern of ['{1..100000}', '{1..999999999999}', '{a..z}{a..z}{a..z}', 'x{1..10..0}.txt']) {
          const t0 = Date.now()
          hasRangeBrace(pattern)
          expandBraces(pattern)
          const elapsedMs = Date.now() - t0
          assert.ok(elapsedMs < 50, `${JSON.stringify(pattern)} must stay under 50ms, took ${elapsedMs}ms`)
        }
      })

      // #7951 acceptance — workspace containment: a range's own generated
      // members never contain a `.` or a `/`. A MIXED-CASE letter range
      // does produce one EMPTY member (the backslash code point, as
      // `fs.glob` does — see parseRangeGroup's doc), so `.{Z..a}.` can spell
      // a `..` segment; the containment test below the next two covers that.
      // What these two prove is that the pre-existing
      // `globPatternEscapeReason` check (unchanged by this fix) still
      // rejects a literal `..` segment WRITTEN NEXT TO a range group,
      // before the new `hasRangeBrace` gate ever runs.
      it('a literal ".." segment next to a range group is still rejected up front, never expanded', async () => {
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '{0..1}/../{2..3}' }, ...ctx() })
        assert.equal(r.isError, true)
        assert.match(r.content, /parent-directory/)
      })

      it('a numeric or single-case letter range never generates an empty member, "." or ".." (direct proof over every generated member)', () => {
        for (const body of ['1..1000', '-500..500', 'a..z', 'z..a', '001..500']) {
          const info = parseRangeGroup(body)
          for (let k = 0; k < Math.min(info.count, 2000); k++) {
            const member = info.nth(k)
            assert.ok(member.length > 0, `${body}#${k} must never be empty`)
            assert.notEqual(member, '.', `${body}#${k} must never be a bare "."`)
            assert.notEqual(member, '..', `${body}#${k} must never be ".."`)
            assert.ok(!member.includes('/'), `${body}#${k} must never contain "/"`)
          }
        }
      })
    })

    // #7951 review — defects found in the range/brace changes after they
    // were written, each measured against real `fs.glob` (Node 22) and, for
    // the arithmetic, against the `brace-expansion` source Node bundles.
    describe('range/brace review fixes (#7951 review)', () => {
      it('a ONE-member range still expands: a total of 1 is not "nothing expands"', async () => {
        // expandBraces returned `[pattern]` whenever the whole count was 1,
        // which was only ever true of "no group expands" before ranges
        // existed; `{5..5}` and `{1..3..5}` have exactly one member each.
        assert.deepEqual(expandBraces('file{5..5}.txt'), ['file5.txt'])
        assert.deepEqual(expandBraces('{1..3..5}'), ['1'])
        assert.deepEqual(expandBraces('{00..0}'), ['00'])
        assert.deepEqual(expandBraces('{x}'), ['{x}'], 'a group that does not expand still hands the pattern back verbatim')
        writeFileSync(join(dir, 'file2.txt'), '1')
        writeFileSync(join(dir, 'file{2..2}.txt'), '1') // negative control: the braces are syntax, not text
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'file{2..2}.txt' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, 'file2.txt')
      })

      it('a zero-padded STEP turns padding on, with the width still taken from the endpoints', () => {
        // brace-expansion: `pad = n.some(isPadded)` over start, end AND step;
        // `width = Math.max(n[0].length, n[1].length)`.
        const r = parseRangeGroup('1..10..01')
        assert.equal(r.count, 10)
        assert.deepEqual([0, 1, 8, 9].map((k) => r.nth(k)), ['01', '02', '09', '10'])
        const narrow = parseRangeGroup('1..3..01')
        assert.deepEqual([0, 1, 2].map((k) => narrow.nth(k)), ['1', '2', '3'], 'width 1: padding on, nothing to pad')
      })

      it('a mixed-case letter range emits the backslash code point as an EMPTY member, never "\\\\"', async () => {
        const r = parseRangeGroup('Z..a')
        const members = Array.from({ length: r.count }, (_, k) => r.nth(k))
        assert.deepEqual(members, ['Z', '[', '', ']', '^', '_', '`', 'a'])
        writeFileSync(join(dir, 'qq'), '1')
        const g = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'q{Z..a}q' }, ...ctx() })
        assert.equal(g.isError, false)
        assert.equal(g.content, 'qq')
      })

      it('numeric ranges are exact past 2^53 and at any length — never NaN, never rounded, never 1e+21', () => {
        const big = parseRangeGroup('9007199254740993..9007199254740995')
        assert.equal(big.count, 3)
        assert.deepEqual([0, 1, 2].map((k) => big.nth(k)), ['9007199254740993', '9007199254740994', '9007199254740995'])
        // Two equal 400-digit endpoints: as floats both are Infinity, so the
        // count was NaN, every `>= cap` test was false, and the group
        // silently expanded to NOTHING.
        const nines = '9'.repeat(400)
        const same = parseRangeGroup(`${nines}..${nines}`)
        assert.equal(same.count, 1)
        assert.equal(same.nth(0), nines)
        assert.deepEqual(expandBraces(`x{${nines}..${nines}}`), [`x${nines}`])
        assert.ok(parseRangeGroup(`1..${nines}`).count > 1000)
        assert.equal(expandBraces(`{1..${nines}}`), null, 'over the cap fails closed, even when the count is astronomically large')
        const e21 = parseRangeGroup('1000000000000000000000..1000000000000000000001')
        assert.deepEqual([e21.nth(0), e21.nth(1)], ['1000000000000000000000', '1000000000000000000001'])
      })

      it('a letter range with an enormous step yields its start letter, not a NUL', () => {
        // `Math.abs(Number(step))` is Infinity for 400 digits and
        // `Infinity * 0` is NaN, which `String.fromCharCode` turns into U+0000.
        const r = parseRangeGroup(`a..z..${'9'.repeat(400)}`)
        assert.equal(r.count, 1)
        assert.equal(r.nth(0), 'a')
        const numeric = parseRangeGroup(`1..10..${'9'.repeat(400)}`)
        assert.equal(numeric.count, 1)
        assert.equal(numeric.nth(0), '1')
      })

      it('an empty range member that spells ".." cannot walk out of the search root', async () => {
        // `.{Z..a}.` expands to `.Z.`, `.[.`, `..`, `.].`, ... — the empty
        // member makes a real `..` segment. Positive control: `fs.glob`
        // itself expands the same pattern to a match OUTSIDE the root, so
        // the pattern really does reach `..` — the tool must not follow it.
        mkdirSync(join(dir, 'sub'))
        writeFileSync(join(dir, 'outside.txt'), '1')
        writeFileSync(join(dir, 'sub', 'inside.txt'), '1')
        const raw = await Array.fromAsync(fsGlob('.{Z..a}./*', { cwd: join(dir, 'sub') }))
        assert.ok(raw.some((p) => p.includes('outside.txt')), `control: fs.glob must reach the parent through the empty member, got ${JSON.stringify(raw)}`)
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '.{Z..a}./*', path: 'sub' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.ok(!r.content.includes('outside'), `must not escape the root: ${r.content}`)
        assert.match(r.content, /No matches/)
      })

      it('hasRangeBrace skips a bracket expression exactly as expandBraces does (the gate is exact, not a superset)', () => {
        // The implementer's mutation 10 ("not independently observable"):
        // a range INSIDE a bracket expression is a class to both functions.
        // Through Glob the skip is invisible (expandBraces would hand the
        // pattern back unchanged), so it is pinned here, directly.
        assert.equal(hasRangeBrace('x[{1..3}]'), false)
        assert.deepEqual(expandBraces('x[{1..3}]'), ['x[{1..3}]'])
        assert.equal(hasRangeBrace('x[{1..3}]{1..2}'), true, 'control: a range outside the class is still seen')
      })

      it('brace nesting the host parser sees is capped even when the bracket-oblivious counter reads it as shallow', async () => {
        // `{,` x30, then a class `[}}}…]` whose 30 `}` walk the shared
        // counter back down, repeated: the host parser pairs bracket-aware,
        // so every `{,` really nests. 480 levels in 1,953 characters.
        const dense = (levels) => {
          let s = ''
          for (let open = 0; open < levels;) {
            const n = Math.min(30, levels - open)
            s += '{,'.repeat(n) + '[' + '}'.repeat(n) + ']'
            open += n
          }
          return s + 'y' + '}'.repeat(levels)
        }
        const deep = dense(480)
        assert.equal(globPatternComplexityReason(deep), null, 'control: the shared, bracket-oblivious counter passes this pattern')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: deep }, ...ctx() })
        assert.equal(r.isError, true)
        assert.match(r.content, /nesting deeper than 32 levels/)
        // Boundary: exactly 32 real levels is allowed, 33 is not.
        const at = (levels) => '{,'.repeat(30) + '[' + '}'.repeat(30) + ']' + '{,'.repeat(levels - 30) + 'y' + '}'.repeat(levels)
        assert.equal(globPatternComplexityReason(at(33)), null)
        const ok = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: at(32) }, ...ctx() })
        assert.equal(ok.isError, false, ok.content)
        const over = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: at(33) }, ...ctx() })
        assert.equal(over.isError, true)
        assert.match(over.content, /nesting deeper than 32 levels/)
      })

      it('the host depth cap is applied to every EXPANSION: an expansion can nest far deeper than the raw pattern reads', async () => {
        // `{[,` + `{`x30 + `]}` is a comma group whose bracket span `[,{{…]`
        // hides 30 `{` from any bracket-aware reading of the RAW pattern; its
        // second alternative, `{`x30 + `]`, puts them in plain text. Two such
        // groups, each followed by `[` + `}`x31 + `]` to walk the
        // bracket-oblivious counter back down, then `,}` x60: the raw pattern
        // reads one level both ways, while one of its 4 expansions really
        // nests 60 `alt` levels (with 9 groups, 270 levels in 1,158 chars).
        // `{1..1}` routes the pattern through expansion. This is why runGlob
        // measures `patterns`, not `pattern`.
        const hide = '{[,' + '{'.repeat(30) + ']}' + '[' + '}'.repeat(31) + ']'
        const pattern = '{1..1}' + hide.repeat(2) + ',}'.repeat(60)
        assert.equal(globPatternComplexityReason(pattern), null, 'control: the shared counter passes the pattern')
        assert.equal(hostBraceDepthExceeded(pattern), false, 'control: the raw pattern reads shallow to the host scan as well')
        const expanded = expandBraces(pattern)
        assert.equal(expanded.length, 4)
        const deep = expanded.filter(hostBraceDepthExceeded)
        assert.equal(deep.length, 1)
        const altDepth = (tokens) => tokens.reduce((d, t) => (t.t === 'alt' ? Math.max(d, 1 + Math.max(...t.options.map(altDepth))) : d), 0)
        assert.equal(altDepth(compileCaseCheck(deep[0]).matchers[0]), 60, 'the parser really nests that deep, not just the scan')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern }, ...ctx() })
        assert.equal(r.isError, true, r.content)
        assert.match(r.content, /nesting deeper than 32 levels/)
      })

      // Both timing tests below compare against a CONTROL measured in the same
      // process, interleaved, best of N — not against a wall-clock budget. The
      // absolute budget they replace (40ms for the depth scan) read ~4ms on
      // the dev Mac uninstrumented, ~31ms under `npm test`'s c8 (V8 block
      // coverage costs a per-character JS loop ~9x), and 153ms on the Linux
      // CI runner: a red build on code that had not regressed. CPU speed,
      // runner contention and coverage counters slow a subject and a control
      // of the same shape alike, so the RATIO holds where a budget cannot,
      // and a super-linear regression moves it by an order of magnitude.
      //
      // Up to `runs` interleaved pairs, stopping early once three pairs read
      // under half the limit: a busy runner can inflate every one of a few
      // sub-millisecond samples (seen at 2x CPU oversubscription on the dev
      // Mac: one family read 6x for a run), so a pass may take more samples,
      // while a regression never reads under half the limit and always runs
      // them all.
      function bestRatio(subject, control, runs, limit) {
        let bestS = Infinity
        let bestC = Infinity
        for (let r = 0; r < runs; r++) {
          let t0 = performance.now()
          control()
          bestC = Math.min(bestC, performance.now() - t0)
          t0 = performance.now()
          subject()
          bestS = Math.min(bestS, performance.now() - t0)
          if (r >= 2 && bestS / bestC < limit / 2) break
        }
        return { ratio: bestS / bestC, bestS, bestC }
      }

      it('the host depth scan is linear: every bracket/brace family costs a small multiple of a bracket-oblivious pass', { timeout: 120_000 }, () => {
        // runGlob runs hostBraceDepthExceeded synchronously over every
        // expanded pattern — up to 1,000 of up to 2,000 chars — before the
        // walk, so it must stay ONE pass per pattern. Called directly on long
        // strings (the scan has no length cap of its own), where one pass and
        // a rescan differ by orders of magnitude. The control is the same
        // depth count without the bracket skip, over the same string.
        //
        // Measured subject/control, worst family per run: 1.3-2.3 under c8 on
        // the dev Mac (20 runs), 2.3-2.6 under V8 coverage in
        // node:22-bookworm (20 runs), at most 2.6 under c8 with the CPU 2x
        // oversubscribed (10 runs). A rescan: dropping the `lastClose` skip
        // reads 173x under c8 on the unclosed family; a per-`{` prefix
        // rescan reads 1,360-3,340x. Skipping brackets through the
        // allocating parseBracketExpr again is a constant factor, not a
        // rescan — red uninstrumented, not under c8, and not this test's job.
        const MAX_RATIO = 8
        const obliviousPass = (s) => {
          let depth = 0
          let max = 0
          for (let j = 0; j < s.length; j++) {
            const c = s.charCodeAt(j)
            if (c === 0x7b) { if (++depth > max) max = depth } else if (c === 0x7d && depth > 0) depth--
          }
          return max
        }
        const families = {
          // An unclosed `[` must not re-scan to the end (the `lastClose` skip).
          'unclosed [': '['.repeat(150_000),
          'closed [x]': '[x]'.repeat(50_000),
          '{} pairs': '{}'.repeat(8_000),
          '[{} mixed': '[{}'.repeat(5_000),
          '[}]{} bracket-hidden': '[}]{}'.repeat(3_000),
        }
        let sink = 0
        for (const [name, s] of Object.entries(families)) {
          assert.equal(hostBraceDepthExceeded(s), false, `${name}: control — the family must pass, so the whole string is scanned`)
          const { ratio, bestS, bestC } = bestRatio(() => { sink += hostBraceDepthExceeded(s) ? 1 : 0 }, () => { sink += obliviousPass(s) }, 15, MAX_RATIO)
          assert.ok(ratio < MAX_RATIO, `${name}: depth scan took ${ratio.toFixed(1)}x the oblivious pass (${bestS.toFixed(3)}ms vs ${bestC.toFixed(3)}ms) — a rescan, not one pass`)
        }
        assert.ok(sink > 0, 'both sides ran and produced a result')
      })

      it('the host depth scan over a range\'s 999 expansions stays under a measured ceiling', { timeout: 60_000 }, () => {
        // The runGlob-scale cost of the scan above: 999 expansions of ~2,000
        // chars in each family, all passing, so every one is scanned in full.
        // Measured, best of 3, worst family per run: 3-6ms on the dev Mac
        // uninstrumented, 31-35ms under c8 (20 runs), 93-95ms under V8
        // coverage in node:22-bookworm (20 runs), up to 81ms under c8 with the
        // CPU 2x oversubscribed; the one CI reading (Linux runner, c8, whole
        // suite in parallel) was 153ms for the unclosed family. The ratio
        // test above is what catches a super-linear regression; this is the
        // absolute ceiling on the synchronous block runGlob pays, with ~6x
        // headroom over that CI reading (the #7910 perf guard went 250ms ->
        // 2000ms on the same kind of evidence).
        const AGG_CEILING_MS = 1000
        for (const unit of ['[', '[x]', '{}', '[{}', '[}]{}']) {
          const expanded = expandBraces('{1..999}' + unit.repeat(Math.floor(1990 / unit.length)))
          assert.equal(expanded.length, 999)
          assert.equal(expanded.some(hostBraceDepthExceeded), false, `${unit}: control — every expansion passes, so all 999 are scanned`)
          let best = Infinity
          for (let run = 0; run < 3; run++) {
            const t0 = performance.now()
            for (const p of expanded) hostBraceDepthExceeded(p)
            best = Math.min(best, performance.now() - t0)
          }
          assert.ok(best < AGG_CEILING_MS, `${unit}: depth scan over 999 expansions took ${best.toFixed(1)}ms (ceiling ${AGG_CEILING_MS}ms)`)
        }
      })

      it('per-segment brace pairing is one pass: a run of unmatched `{` costs no more than the brackets around it', { timeout: 120_000 }, () => {
        // Each `{[}]` is a `{` bracket-aware pairing leaves unmatched. The
        // shipped per-`{` scan re-parsed every unclosed `[` after it with a
        // full `indexOf`, and `{1..999}` makes runGlob compile 999 such
        // patterns: 2,146ms per Glob call on the dev Mac, against ~90ms with
        // one pairing pass. The control is the same pattern with the `{`
        // removed (same length, same brackets, same unclosed run), so
        // whatever the brackets cost on this machine cancels out.
        //
        // Measured subject/control: 1.8-1.9 on the dev Mac uninstrumented and
        // under c8, and in node:22-bookworm (20 runs each), at most 2.0 with
        // the CPU 2x oversubscribed — the one pairing pass is a second walk
        // over the same brackets. Restoring the per-`{` scan, or rebuilding
        // the table at every `{`: 28x both ways. On CI the old absolute 1s
        // budget read 825ms — 83% of it, on code that had not regressed.
        const MAX_RATIO = 6
        const subject = expandBraces('{1..999}' + '{[}]'.repeat(30) + '['.repeat(1870))
        const control = expandBraces('{1..999}' + '[}]'.repeat(30) + '['.repeat(1900))
        assert.equal(subject.length, 999)
        assert.equal(control.length, 999)
        assert.equal(subject[0].length, control[0].length)
        const { ratio, bestS, bestC } = bestRatio(
          () => { for (const p of subject) compileCaseCheck(p) },
          () => { for (const p of control) compileCaseCheck(p) },
          5,
          MAX_RATIO,
        )
        assert.ok(ratio < MAX_RATIO, `30 unmatched "{" made compiling ${ratio.toFixed(1)}x slower (${bestS.toFixed(0)}ms vs ${bestC.toFixed(0)}ms) — pairing is rescanning per "{"`)
      })
    })

    // #7898 round 4 — every prior round (1-3) found a NEW super-linear
    // blow-up in this matcher (silent false negatives, a backtracking-regex
    // ReDoS, an O(n^2) brace-alternative branch). This suite is the
    // structural answer: a fail-closed complexity cap (globPatternComplexityReason,
    // tool-transforms.js) bounding pattern length and brace-nesting depth
    // BEFORE any of this code runs, plus a performance-guard table proving
    // every construct the matcher accepts stays fast UNDER that cap. See the
    // worst-case bound written above compileCaseCheck (byok-tool-executor.js)
    // for the derivation.
    //
    // Every timing test below passes `{ timeout }` (node:test's own option,
    // well above the assertion budget). Documented honestly, because this
    // round's own mutation proof (revert the `alt`-branch batching from
    // 65831e075, see the PR comment) measured its actual limit: `caseCheckPasses`
    // is a purely SYNCHRONOUS, CPU-bound call that never yields to the event
    // loop, so `{ timeout }` cannot PREEMPT it mid-call the way it can an
    // async wait — a regression that is merely SLOW (not infinite) still runs
    // to completion and fails via the `elapsedMs` assertion below, just later
    // than the nominal timeout (the un-batched mutation made the two
    // largest-N table rows take 76s and 19s respectively before failing that
    // way, not via the timeout firing). `{ timeout }` remains real protection
    // against a regression that stops TERMINATING altogether (an actual
    // infinite loop, or an async call that never resolves) — exactly the
    // shape docs/false-safety-guards.md catalogues as a guard that hangs
    // instead of failing (entry #7340) — it is just not a hard real-time
    // bound on synchronous JS, which nothing short of a Worker thread with
    // `terminate()` can provide.
    //
    // #7910 review round 2 — the original 250ms budget FLAKED on a loaded CI
    // runner: PR #7909's Server Tests run measured 306ms for the "100 chained
    // groups" row (a shared runner, contended with other jobs) against
    // batched code that is not regressed — a false failure, not a caught
    // regression. The regressions this suite exists to catch cost SECONDS
    // (12.96s / 19.4s / 76.6s — see the rows below and 65831e075's own commit
    // message), three orders of magnitude above any plausible loaded-runner
    // reading, so the budget is raised to 2000ms: still tight enough to fail
    // fast and clearly on an actual regression, wide enough that no realistic
    // CI contention should ever cross it for genuinely-fast code. `{ timeout
    // }` is raised in step (to 5000ms) so it stays a backstop behind the
    // `elapsedMs` assertion, not a race with it.
    describe('performance guard (#7898 round 4)', () => {
      // Build a pattern segment with exactly `n` levels of CHAIN-nested
      // braces: {a,{a,{a,...{a,z}...}}}. Each iteration adds exactly one
      // '{' (and one matching '}'), so the real nesting depth is exactly n —
      // unlike a "balanced binary tree" of alternatives, this shape needs
      // only ~4 characters per extra level of depth, not ~2^depth, which is
      // what makes it cheap for an attacker to type and is exactly the shape
      // round 3's "self-limiting" dismissal of deep nesting did not cover.
      function nestedBraceChain(n) {
        let s = 'z'
        for (let i = 0; i < n; i++) s = `{a,${s}}`
        return s
      }

      const PERF_BUDGET_MS = 2000

      it('globPatternComplexityReason accepts an ordinary pattern', () => {
        assert.equal(globPatternComplexityReason('packages/**/src/**/*.test.js'), null)
        assert.equal(globPatternComplexityReason('{a,{b,{c,d}}}'), null, "the task's own nested-brace example")
      })

      // The cap is inclusive at exactly 32 levels — proves the guard does
      // not accidentally reject the depth it claims to allow.
      it('globPatternComplexityReason allows brace nesting up to and including the 32-level cap', () => {
        assert.equal(globPatternComplexityReason(nestedBraceChain(32)), null)
      })

      it('globPatternComplexityReason rejects brace nesting one level past the cap', () => {
        const reason = globPatternComplexityReason(nestedBraceChain(33))
        assert.match(reason, /nesting deeper than 32/)
      })

      it('globPatternComplexityReason rejects a pattern longer than 2000 characters', () => {
        assert.equal(globPatternComplexityReason('a'.repeat(2000)), null, 'exactly at the cap must pass')
        const reason = globPatternComplexityReason('a'.repeat(2001))
        assert.match(reason, /longer than 2000 characters/)
      })

      // Integration-level: the cap is checked in runGlob BEFORE the fs.glob
      // walk or compileCaseCheck ever run, so an over-cap pattern is refused
      // near-instantly with a clean tool error — not a hang, not a crash,
      // and not the generic "Tool Glob failed: <exception message>" a
      // RangeError would otherwise surface as (see the worst-case-bound
      // comment's "what the time bound does not cover" section).
      it('Glob with an over-depth pattern returns a clean EINVAL fast, not a tool crash', { timeout: 5000 }, async () => {
        const t0 = Date.now()
        const r = await executeBuiltinTool({
          toolName: 'Glob',
          input: { pattern: nestedBraceChain(40) },
          ...ctx(),
        })
        const elapsedMs = Date.now() - t0
        assert.equal(r.isError, true)
        assert.match(r.content, /EINVAL: glob pattern is too complex/)
        assert.match(r.content, /nesting deeper than 32/)
        assert.ok(elapsedMs < PERF_BUDGET_MS, `rejection must be near-instant, took ${elapsedMs}ms`)
      })

      it('Glob with an over-length pattern returns a clean EINVAL fast', { timeout: 5000 }, async () => {
        const t0 = Date.now()
        const r = await executeBuiltinTool({
          toolName: 'Glob',
          input: { pattern: '{*a,*b}'.repeat(300) }, // 2100 chars, well-formed but over the length cap
          ...ctx(),
        })
        const elapsedMs = Date.now() - t0
        assert.equal(r.isError, true)
        assert.match(r.content, /EINVAL: glob pattern is too complex/)
        assert.match(r.content, /longer than 2000 characters/)
        assert.ok(elapsedMs < PERF_BUDGET_MS, `rejection must be near-instant, took ${elapsedMs}ms`)
      })

      // #7918 — `hasSlashSpanningBrace`/`expandBraces`'s OWN bound
      // (`GLOB_BRACE_EXPANSION_CAP`, 1,000), independent of the pre-existing
      // length/depth caps above: 11 SIBLING (not nested) two-way brace
      // groups multiply to 2^11 = 2,048 alternatives while the pattern
      // itself stays ~60 characters and 1 level deep — well under both of
      // `globPatternComplexityReason`'s bounds, so this pattern would sail
      // through unrejected without its own cap. The first group spans a
      // `/` (`{a/x,b}`) so the pattern actually takes the whole-pattern
      // expansion path at all; the other ten are ordinary `{c,d}`-shaped
      // multipliers.
      it('Glob rejects a slash-spanning brace pattern whose alternatives exceed the expansion cap, fast', { timeout: 5000 }, async () => {
        const groups = ['{a/x,b}', ...Array.from({ length: 10 }, (_, i) => `{${String.fromCharCode(99 + i * 2)},${String.fromCharCode(100 + i * 2)}}`)]
        const pattern = groups.join('')
        assert.ok(pattern.length < 200, 'sanity: this pattern must stay far under the 2000-char length cap')
        const t0 = Date.now()
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern }, ...ctx() })
        const elapsedMs = Date.now() - t0
        assert.equal(r.isError, true)
        assert.match(r.content, /EINVAL: glob pattern is too complex/)
        assert.match(r.content, /brace alternatives/)
        assert.ok(elapsedMs < PERF_BUDGET_MS, `rejection must be near-instant (the count is computed before any alternative is built), took ${elapsedMs}ms`)
      })

      // Positive control for the cap above: the SAME shape (a slash-spanning
      // brace mixed with ordinary sibling groups) but with few enough total
      // alternatives to stay under the cap must still expand and match
      // normally — proves the cap rejects on COUNT, not merely on the
      // presence of multiple sibling groups.
      it('Glob still expands a slash-spanning brace pattern with several (under-cap) sibling groups', async () => {
        mkdirSync(join(dir, 'nested'))
        writeFileSync(join(dir, 'nested', 'dup'), 'file named dup')
        mkdirSync(join(dir, 'dup'))
        writeFileSync(join(dir, 'dup', 'inner.txt'), '1')

        const r = await executeBuiltinTool({
          toolName: 'Glob', input: { pattern: '{dup,nested/dup}{,x}' }, ...ctx(),
        })
        assert.equal(r.isError, false)
        const lines = r.content.split('\n')
        assert.ok(lines.includes('dup'), 'the first alternative, expanded with the empty second-group option, must match')
        assert.ok(lines.includes('nested/dup'), 'the slash-spanning alternative, expanded with the empty second-group option, must match')
      })

      // #7918 review (DoS, critical) — the expansion runs SYNCHRONOUSLY on the
      // daemon's event loop, where the walk's deadline race cannot interrupt
      // it, so its cost must be bounded by pattern LENGTH. The first
      // implementation re-scanned every candidate string from its start once
      // per brace group, running `parseBracketExpr`'s scan-to-the-next-`]` at
      // every `[` it passed — O(groups × strings × n²). This pattern (1,107
      // chars, far inside every cap: one slash-spanning group and eight
      // two-way groups → 512 strings, preceded by 1,000 unclosed `[` and
      // followed by 20 one-option `{q}` groups) took 12.3 SECONDS inside that
      // expander on this machine; a 1,998-char variant took 292 seconds of
      // frozen daemon. The linear rewrite does it in about a millisecond.
      // Timed directly so the budget measures the expander, not the walk.
      it('expandBraces stays linear-time on a pattern built to make a rescanning expander quadratic', { timeout: 5000 }, () => {
        const pattern = '['.repeat(1000) + '{x/y,z}' + '{a,b}'.repeat(8) + '{q}'.repeat(20)
        assert.equal(globPatternComplexityReason(pattern), null, 'sanity: must be inside the pre-existing length/depth caps')
        const t0 = Date.now()
        const out = expandBraces(pattern)
        const elapsedMs = Date.now() - t0
        assert.ok(elapsedMs < PERF_BUDGET_MS, `expansion must be linear in pattern length, took ${elapsedMs}ms`)
        // Not vacuous: the expansion really happened, in full.
        assert.ok(Array.isArray(out), 'an under-cap pattern must expand, not be refused')
        assert.equal(out.length, 512)
        assert.equal(new Set(out).size, 512, 'every combination is distinct')
        assert.ok(out.every((p) => p.startsWith('['.repeat(1000)) && p.endsWith('{q}'.repeat(20))), 'one-option groups stay literal, prefix untouched')
      })

      // #7918 review (parity) — a brace group with no top-level comma is not
      // an alternation to `fs.glob` (`{nested/dup}` names a literal
      // `{nested`/`dup}` path there), and before #7918 this code never
      // expanded it either: the per-segment compiler saw the same text. The
      // first #7918 expander stripped the braces, which walked `nested/dup`
      // instead. A group nested inside a comma-less one still expands; the
      // enclosing braces stay (`fs.glob` gives `{dup}` and `{nested/dup}` for
      // `{{dup,nested/dup}}`). The byok-glob-fs-glob-parity table proves the
      // end-to-end answer against `fs.glob` itself (`{curly/dup}`).
      it('expandBraces leaves a comma-less group literal and still expands a group nested inside it', () => {
        assert.deepEqual(expandBraces('{nested/dup}'), ['{nested/dup}'])
        assert.deepEqual(expandBraces('{a}/{b,c/d}').sort(), ['{a}/b', '{a}/c/d'])
        assert.deepEqual(expandBraces('{{dup,nested/dup}}').sort(), ['{dup}', '{nested/dup}'])
        // An unmatched '{' is a literal, and scanning continues past it.
        assert.deepEqual(expandBraces('{x/{a,b}').sort(), ['{x/a', '{x/b'])
        // Brace syntax (`{`/`}`) inside a bracket expression is a class
        // member for PAIRING purposes: a `}` there does not close the group
        // early (verified directly against `fs.glob`: `{a[}]b,fc}` only
        // matches a real file named `fc`, never one shaped like the
        // truncated group a bracket-oblivious pairing scan would find).
        assert.deepEqual(expandBraces('[{,]{a,b/c}').sort(), ['[{,]a', '[{,]b/c'])
        assert.deepEqual(expandBraces('{a,[}]b/c}').sort(), ['[}]b/c', 'a'])
        // #7951 — but a COMMA inside a bracket expression is deliberately
        // NOT a class member for SPLITTING purposes: it still splits, the
        // OPPOSITE awareness from pairing just above, matching `fs.glob`'s
        // own measured behavior exactly (`{a[,]b,c/d}` against real files
        // named `a[`, `]b`, `c/d` splits 3 ways, not the 2 a bracket-aware
        // split gave before this fix — see the parity harness's `#7951`
        // rows, which prove this end-to-end against `fs.glob` itself).
        assert.deepEqual(expandBraces('{a[,]b,c/d}').sort(), [']b', 'a[', 'c/d'])
      })

      it('expandBraces refuses an over-cap pattern without materializing it', { timeout: 5000 }, () => {
        const t0 = Date.now()
        // 2^16 alternatives: counting must saturate, never multiply out.
        // (Small enough that an expander which DID materialize it would
        // still return — and fail the null assertion legibly — rather than
        // exhaust the heap and take the whole file down with it.)
        assert.equal(expandBraces('{x/y,z}' + '{a,b}'.repeat(15)), null)
        assert.ok(Date.now() - t0 < PERF_BUDGET_MS)
        // Exactly at the cap is allowed; one past it is not.
        const ten = '{a,b,c,d,e,f,g,h,i,j}'
        assert.equal(expandBraces(`${ten}${ten}${ten}/x`).length, 1000)
        assert.equal(expandBraces(`${ten}${ten}${ten}{/x,/y}`), null)
      })

      // Nested braces AT the cap (32 levels, 129 chars) — the case this cap
      // must NOT break: legitimate-if-unusual input stays usable, both when
      // it matches and when it doesn't. Measured on this machine: compiling
      // is ~0.1ms and each caseCheckPasses call ~0.02-0.14ms — the O(depth^2)
      // parse cost this cap exists to bound is negligible at depth 32; it
      // only becomes a problem once nothing stops depth from growing toward
      // pattern-length/2 (measured 301.88ms at depth 4000 with no cap, in the
      // COMPLEXITY BOUND comment above compileCaseCheck).
      it('caseCheckPasses stays fast for brace nesting AT the 32-level cap (direct)', { timeout: 5000 }, () => {
        const check = compileCaseCheck(nestedBraceChain(32))
        const t0 = Date.now()
        const noMatch = caseCheckPasses(check, ['nope'])
        const match = caseCheckPasses(check, ['z'])
        const elapsedMs = Date.now() - t0
        assert.equal(noMatch, false)
        assert.equal(match, true, 'the innermost literal "z" alternative must still match')
        assert.ok(elapsedMs < PERF_BUDGET_MS, `depth-32 nested braces must stay fast, took ${elapsedMs}ms`)
      })

      // Round 2's backtracking-regex shape (regression guard, table form) and
      // three LARGER/different adversarial shapes than any prior round
      // measured, all within the new length/depth caps: 200 consecutive `*`
      // tokens, 100 chained (not nested) `{*a,*b}` groups — up from round
      // 3's 30 — and 30 chained groups that mix a brace with a bracket class
      // (`{*[a-z],?[0-9]}`), which round 3 did not exercise in combination.
      // Each row is checked against a 5000-char real segment name, the same
      // adversarial scale every prior round used. Measured on this machine
      // (fixed, batched code — see each row's `measuredMs`), all comfortably
      // under the 2000ms budget; this round's mutation proof (revert
      // 65831e075's batching, see the PR comment) reproduces round 3's
      // original blowup on the two brace rows — 76.6s and 19.4s respectively
      // — confirming the table is actually exercising the code the batching
      // fix changed, not just re-measuring round 3's own existing test.
      const longName = `${'a'.repeat(5000)}.ts`
      const homogeneous = 'a'.repeat(5000)
      const perfTable = [
        {
          label: 'round-2 backtracking-regex shape (regression)',
          pattern: '*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b.ts',
          name: longName,
          expect: false,
          measuredMs: '~0.03 (this branch never used the backtracking RegExp)',
        },
        {
          label: '200 consecutive "*" tokens',
          pattern: '*'.repeat(200),
          name: longName,
          expect: true,
          measuredMs: '~21',
        },
        {
          label: '100 chained "{*a,*b}" groups (round 3 was 30)',
          pattern: '{*a,*b}'.repeat(100),
          name: homogeneous,
          expect: true,
          measuredMs: '~41 (pre-batching mutation: ~76,600)',
        },
        {
          label: '30 chained groups mixing a brace with a bracket class',
          pattern: '{*[a-z],?[0-9]}'.repeat(30),
          name: homogeneous,
          expect: true,
          measuredMs: '~22 (pre-batching mutation: ~19,400)',
        },
      ]
      for (const { label, pattern, name, expect } of perfTable) {
        it(`caseCheckPasses stays fast: ${label} (direct)`, { timeout: 5000 }, () => {
          assert.equal(globPatternComplexityReason(pattern), null, 'table entries must stay under the complexity cap')
          const check = compileCaseCheck(pattern)
          const t0 = Date.now()
          const result = caseCheckPasses(check, [name])
          const elapsedMs = Date.now() - t0
          assert.equal(result, expect)
          assert.ok(elapsedMs < PERF_BUDGET_MS, `"${label}" must stay under ${PERF_BUDGET_MS}ms, took ${elapsedMs}ms`)
        })
      }

      // #7910 review round 2 — `caseCheckPasses` is DEAD CODE in production:
      // `runGlob` stopped calling it entirely when `walkGlob` (#7901) replaced
      // `fs.glob` on the host path — it survives only as a directly-tested
      // export (see this file's import and the export comment in
      // byok-tool-executor.js). Every row above therefore proves the SHARED
      // per-segment matcher (`segmentMatches`/`advanceToken`) stays fast when
      // called through `caseCheckPasses`'s path-level wrapper, but nothing
      // above exercises the function `walkGlob` — the code that actually
      // ships — calls itself, once per REAL directory entry `opendir` reads.
      // This table closes that gap DIRECTLY: `segmentMatches` at the SAME
      // full adversarial scale (5000 chars) the direct-call table above
      // already uses.
      //
      // An earlier version of this test went through `executeBuiltinTool`
      // against a real on-disk file instead, at a filesystem-safe 250-char
      // name (a real filename cannot be 5000+ bytes — most filesystems' NAME_MAX
      // is 255; 65831e075's own commit message independently settled on 255
      // bytes as "a filesystem-realistic name" for the same reason). That
      // version did NOT catch the mutation below: reverting the batching made
      // the 5000-char direct call take 69.5s, but the SAME mutation made the
      // 250-char on-disk version take only ~120ms — comfortably inside even a
      // strict budget, and nowhere near the ~2000ms this suite settled on
      // after the CI-flakiness fix. A guard that cannot fail against the
      // defect it names is exactly docs/false-safety-guards.md's catalogue —
      // caught here before landing by running the mutation proof against it,
      // not after. `segmentMatches` sidesteps the whole problem: it takes a
      // plain string, not a file, so it is tested at the SAME scale that
      // actually demonstrates the regression.
      for (const { label, pattern, name, expect } of perfTable) {
        it(`the live matcher (segmentMatches) stays fast: ${label} (direct)`, { timeout: 5000 }, () => {
          assert.equal(globPatternComplexityReason(pattern), null, 'table entries must stay under the complexity cap')
          const [matcher] = compileCaseCheck(pattern).matchers
          const t0 = Date.now()
          const result = segmentMatches(matcher, name)
          const elapsedMs = Date.now() - t0
          assert.equal(result, expect)
          assert.ok(elapsedMs < PERF_BUDGET_MS, `"${label}" must stay under ${PERF_BUDGET_MS}ms through segmentMatches (the function walkGlob actually calls), took ${elapsedMs}ms`)
        })
      }

      // Correctness/sanity companion to the table above, through the REAL
      // dispatch (`executeBuiltinTool` → `walkGlob` → `opendir`) rather than a
      // direct call — proves the wiring (root resolution, confinement, the
      // deadline race) does not somehow break these patterns end to end, and
      // completes without hanging. NOT a complexity-regression proof (see the
      // comment above the table): at a filesystem-safe 250-char name the
      // absolute-time gap between correct and quadratically-regressed code is
      // too small to assert reliably, so this uses the same generous budget
      // purely as a non-hang sanity check, not the primary guard.
      for (const { label, pattern, name, expect } of perfTable) {
        if (label.startsWith('round-2 ')) continue // already has a dedicated integration test below
        it(`the real Glob dispatch matches correctly and does not hang: ${label} (integration, correctness only)`, { timeout: 5000 }, async () => {
          // Scale the SAME adversarial name down to 250 chars (see above),
          // preserving whether it carries the `.ts` extension: the
          // brace-chain rows only match a string that itself ENDS in 'a'/'b'
          // (`name: homogeneous`, no extension); the star-repeat row matches
          // anything (`name: longName`, `.ts` extension) since a bare `*`
          // chain is extension-agnostic. Getting this wrong silently flips
          // `expect` for the affected rows rather than erroring — verified
          // directly against the pattern's own semantics before relying on it.
          const realName = name.endsWith('.ts') ? `${'a'.repeat(247)}.ts` : 'a'.repeat(250)
          writeFileSync(join(dir, realName), '1')
          const t0 = Date.now()
          const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern }, ...ctx() })
          const elapsedMs = Date.now() - t0
          assert.equal(r.isError, false)
          assert.equal(r.content.includes(realName), expect, `"${label}" must ${expect ? '' : 'not '}match the real file through the live walk`)
          assert.ok(elapsedMs < PERF_BUDGET_MS, `"${label}" must not hang through the real Glob dispatch, took ${elapsedMs}ms`)
        })
      }

      // A 50-level path (D=50), alternating "**" with a brace-containing
      // literal segment — stresses the PATH-level DP (`caseCheckPasses`'s own
      // `dp[]` array, aligning `**` against a real match) together with the
      // per-segment brace matcher, rather than either alone. Synthetic
      // realSegments, not a real 50-directory fixture — building and walking
      // one adds real filesystem I/O this unit-level test does not need to
      // pin the DP's own complexity bound. Measured on this machine: ~0.2ms.
      //
      // #7910 review round 2 — like the rest of this describe block,
      // `caseCheckPasses`'s path-level `dp[]` array is dead code in
      // production (see the export comment in byok-tool-executor.js);
      // `walkGlob`'s OWN incremental version of the same `**`-alignment
      // (`active`/`next`/`closeGlobstars`) runs once per REAL directory
      // level as it descends, not once per synthetic call — a live-path
      // equivalent of THIS specific test would need an actual 25-level-deep
      // directory tree, which the per-segment `segmentMatches` guard above
      // did not (a plain string is not filesystem-bound the way a directory
      // depth is). Not built here — out of scope for this round's fix, which
      // is the per-segment complexity CI flaked on — but the same gap in
      // principle, noted rather than silently left implicit.
      it('caseCheckPasses stays fast for a 50-level path alternating ** and brace segments (direct)', { timeout: 5000 }, () => {
        const patSegs = []
        for (let i = 0; i < 25; i++) {
          patSegs.push('**')
          patSegs.push(`{seg${i}a,seg${i}b}`)
        }
        const pattern = patSegs.join('/')
        assert.equal(globPatternComplexityReason(pattern), null)
        const realSegs = []
        for (let i = 0; i < 25; i++) {
          realSegs.push(`filler${i}`) // absorbed by the preceding "**"
          realSegs.push(`seg${i}a`) // must match the brace segment, case-sensitively
        }
        const check = compileCaseCheck(pattern)
        const t0 = Date.now()
        const result = caseCheckPasses(check, realSegs)
        const elapsedMs = Date.now() - t0
        assert.equal(result, true)
        assert.ok(elapsedMs < PERF_BUDGET_MS, `50-level path must stay fast, took ${elapsedMs}ms`)
      })
    })

    // #7901 / #7356 — the self-implemented `walkGlob` (byok-tool-executor.js)
    // that replaced `fs.glob` on the host path entirely. Build helpers shared
    // by the tests below.
    describe('self-implemented walk (#7901 / #7356)', () => {
      function buildBigTree(base, dirs, filesPerDir) {
        for (let d = 0; d < dirs; d++) {
          const sub = join(base, `d${String(d).padStart(3, '0')}`)
          mkdirSync(sub, { recursive: true })
          for (let i = 0; i < filesPerDir; i++) {
            writeFileSync(join(sub, `f${String(i).padStart(4, '0')}.ts`), '')
          }
        }
      }

      // #7901's own repro, run through the FULL executeBuiltinTool dispatch —
      // not possible before this fix (see the comment on the `export` at the
      // bottom of byok-tool-executor.js): `runGlob`'s walk used to call
      // Node's OWN `fs.glob`, whose internal matcher backtracks
      // catastrophically on this pattern shape independently of
      // `compileCaseCheck`'s DP (#7898 already made THAT side safe) —
      // measured directly against `node:fs/promises`'s `glob()` alone, no
      // chroxy code involved: ~8.7s for this exact (pattern, 40-char
      // near-miss name) pair on this machine, and the issue's own repro
      // measured 87s. `walkGlob` never calls `fs.glob` at all, so this
      // pathological pattern now costs exactly what `compileCaseCheck`'s own
      // direct-call perf-guard tests already proved it costs: milliseconds.
      it('the fs.glob-backtracking pattern returns fast through the real Glob dispatch', { timeout: 15_000 }, async () => {
        const evilPattern = '*a*a*a*a*a*a*a*a*a*a*b.ts'
        const nearMiss = 'a'.repeat(37) + '.ts' // 40 chars, no trailing "b" -- the issue's own repro shape
        writeFileSync(join(dir, nearMiss), '1')

        const t0 = Date.now()
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: evilPattern }, ...ctx() })
        const elapsedMs = Date.now() - t0

        assert.equal(r.isError, false)
        assert.match(r.content, /No matches/)
        assert.ok(elapsedMs < 3000, `must return fast, took ${elapsedMs}ms (pre-#7901 this took ~8.7s on this machine)`)
      })

      // #7901's second acceptance bullet: the event loop must keep turning
      // WHILE a large walk is in flight — a concurrent timer probe firing on
      // schedule is the direct, daemon-relevant observable (`fs.glob`'s
      // synchronous internal matching is what froze every session, every WS
      // client and the tunnel health checks for the duration). A moderately
      // adversarial-but-ordinary pattern shape gives it several probe ticks
      // to observe without needing an unrealistically huge fixture.
      it('the event loop keeps turning during a large walk (concurrent timer probe)', { timeout: 15_000 }, async () => {
        buildBigTree(dir, 15, 1000) // 15,000 files

        const gaps = []
        let last = Date.now()
        const probe = setInterval(() => {
          const now = Date.now()
          gaps.push(now - last)
          last = now
        }, 5)

        let r
        try {
          r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*.ts' }, ...ctx() })
        } finally {
          clearInterval(probe)
        }

        assert.equal(r.isError, false)
        assert.ok(
          gaps.length >= 4,
          `probe must have fired several times during the walk (fired ${gaps.length}) — the walk finished too fast to prove anything; enlarge the fixture`,
        )
        const maxGap = Math.max(...gaps)
        assert.ok(
          maxGap < 200,
          `event loop must keep turning throughout the walk, max observed gap between probe ticks was ${maxGap}ms (probe fired ${gaps.length} times, nominal interval 5ms)`,
        )
      })

      // #7356 — the TOOL CALL returns promptly on abort, proven on a large
      // tree, by comparing the ABORTED call's duration against an UNABORTED
      // control over the identical tree. NOTE what this test does and does
      // NOT prove: `runGlob`'s deadline/abort race
      // (`Promise.race([collect, deadlineReached])`) resolves via
      // `deadlineReached` — a timer/abort callback independent of whether the
      // WALK itself ever notices `state.stop` — so this proves the CALLER
      // gets its answer back quickly, but not that the walk stops generating
      // filesystem work afterward. That second property — the actual #7356
      // defect (a 200,000-file/9,111-dir tree left orphans running up to 15s
      // after the tool returned pre-fix, wasting up to 2.3GB RSS and 63x
      // request-latency inflation) — is proven by the next test, which calls
      // `walkGlob` directly and times its OWN promise.
      it('an aborted walk stops promptly on a large tree, far short of a full walk', { timeout: 15_000 }, async () => {
        buildBigTree(dir, 15, 1000) // 15,000 files

        // POSITIVE CONTROL first: how long does an uninterrupted walk of this
        // exact tree take? Without this, "the aborted call was fast" could
        // just mean the whole tree walks fast anyway, proving nothing about
        // cancellation.
        const t0 = Date.now()
        const full = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*.ts' }, ...ctx() })
        const fullMs = Date.now() - t0
        assert.equal(full.isError, false)

        const controller = new AbortController()
        setTimeout(() => controller.abort(), 2)
        const t1 = Date.now()
        const aborted = await executeBuiltinTool({
          toolName: 'Glob', input: { pattern: '**/*.ts' }, signal: controller.signal, ...ctx(),
        })
        const abortedMs = Date.now() - t1

        assert.equal(aborted.isError, true, 'an aborted walk must not report success')
        assert.match(aborted.content, /interrupted/i)
        assert.ok(
          abortedMs < Math.max(500, fullMs / 2),
          `aborted call took ${abortedMs}ms, a full walk of the same tree took ${fullMs}ms — cancellation must resolve well short of a full walk`,
        )
      })

      // #7356 — THE test for the actual defect: does `walkGlob`'s own promise
      // stop generating filesystem work once `state.stop` is set, or does it
      // keep walking in the background regardless of what the caller's race
      // already decided? Calls `walkGlob` directly (exported for exactly this
      // purpose — see its export comment) rather than through
      // `executeBuiltinTool`, and times from the MOMENT `state.stop` is set
      // (not from call start), so the measurement is of the walk's own
      // response latency, not of an unrelated setTimeout's scheduling slop.
      it('walkGlob itself stops within a bounded time of state.stop being set (direct)', { timeout: 15_000 }, async () => {
        buildBigTree(dir, 15, 1000) // 15,000 files
        const { matchers } = compileCaseCheck('**/*.ts')
        const state = { stop: null, visited: 0 }
        const results = []
        const walkPromise = walkGlob({
          realRoot: dir, matchers, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
          state, results, maxEntries: 2_000_000,
        })

        let stopSetAt = null
        setTimeout(() => { state.stop = 'interrupted'; stopSetAt = Date.now() }, 2)

        await walkPromise
        assert.ok(stopSetAt !== null, 'the walk must not have already finished before state.stop was even set')
        const respondedInMs = Date.now() - stopSetAt
        assert.ok(
          respondedInMs < 500,
          `walkGlob must stop within a bounded time of state.stop being set, took ${respondedInMs}ms (tree: 15,000 files)`,
        )
        // The walk really was interrupted mid-flight, not merely finished on
        // its own at roughly the same moment: far fewer than 15,000 matches
        // were collected.
        assert.ok(
          results.length < 15_000,
          `an interrupted walk over 15,000 files collected ${results.length} — it should have stopped short, not completed`,
        )
      })

      // #7910 review (security, TOCTOU) — `dirent.isDirectory()`/
      // `isSymbolicLink()` reflect the type Node captured when this entry's
      // underlying readdir(2) BATCH was read, which can be stale by the time
      // the walk actually opens it: this walk is strictly sequential within
      // a directory, so a sibling late in a large listing is reached only
      // after every earlier one has been processed. Chroxy dispatches every
      // tool block a model approves in ONE turn CONCURRENTLY
      // (byok-session.js's Promise.all fan-out, #7356), so a Bash call
      // approved in the SAME turn as this Glob call can delete a plain
      // directory and recreate it as a symlink to outside the workspace
      // WHILE the walk is still busy elsewhere in the tree. Proven directly
      // against the unpatched walk: an unpatched `walkGlob` followed exactly
      // this swap straight into the attacker's target and returned matches
      // from OUTSIDE the workspace, reported under a workspace-looking path.
      it('re-verifies a plain-directory entry immediately before opening it, closing a symlink-swap race (security #7910 review)', { timeout: 15_000 }, async () => {
        const outer = mkdtempSync(join(tmpdir(), 'chroxy-toctou-outer-'))
        try {
          writeFileSync(join(outer, 'SECRETMARKER.txt'), 'top secret')
          mkdirSync(join(dir, 'subtree'))
          // Enough siblings that the walk needs real time to reach the swap
          // target, giving the concurrent racer room to land before the walk
          // gets there — independent of Node's exact opendir() batch size.
          for (let i = 0; i < 60; i++) mkdirSync(join(dir, 'subtree', `sib_${i}`))
          const targetAbs = join(dir, 'subtree', 'zzz_target')
          mkdirSync(targetAbs)

          const { matchers } = compileCaseCheck('subtree/**')
          const state = { stop: null, visited: 0 }
          const results = []
          const walkPromise = walkGlob({
            realRoot: dir, matchers, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
            state, results, maxEntries: 10_000_000,
          })
          const racer = (async () => {
            while (state.visited === 0) await new Promise((r) => setImmediate(r))
            await rmAsync(targetAbs, { recursive: true, force: true })
            await symlinkAsync(outer, targetAbs)
          })()
          await Promise.all([walkPromise, racer])

          assert.equal(
            results.some((r) => r.includes('SECRETMARKER')),
            false,
            'a directory swapped for an out-of-workspace symlink mid-walk must never be traversed',
          )
        } finally {
          rmSync(outer, { recursive: true, force: true })
        }
      })

      // #7910 review round 2 — the test above is a REAL concurrent race: the
      // 60 siblings buy the racer time, but nothing PROVES the swap landed in
      // the specific window this fix targets (between the pre-open check and
      // the `opendir` call) rather than earlier, where even the round-1 fix
      // already caught it. A race that happens to pass is not evidence the
      // narrow window is closed — it is evidence SOME window is. `walkGlob`'s
      // `__testDescendSeam` hook is awaited at that EXACT point (see
      // `openVerifiedDirForDescend`'s doc), so this test performs the swap
      // deterministically inside the window itself rather than hoping to win
      // a real race — the honest way to test a fix whose whole point is a
      // window measured in microseconds.
      it('closes the swap even when it lands in the EXACT window between the pre-open check and opendir (security #7910 review round 2, deterministic)', async () => {
        const outer = mkdtempSync(join(tmpdir(), 'chroxy-toctou-seam-outer-'))
        try {
          writeFileSync(join(outer, 'SECRETMARKER.txt'), 'top secret')
          mkdirSync(join(dir, 'subtree'))
          const targetAbs = join(dir, 'subtree', 'target')
          mkdirSync(targetAbs)
          writeFileSync(join(targetAbs, 'innocent.ts'), '1') // would be a match if not swapped

          const { matchers } = compileCaseCheck('subtree/**')
          const state = { stop: null, visited: 0 }
          const results = []
          let seamFired = false
          await walkGlob({
            realRoot: dir, matchers, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
            state, results, maxEntries: 10_000_000,
            __testDescendSeam: async (target) => {
              if (target !== targetAbs) return // only the one directory under test
              seamFired = true
              await rmAsync(targetAbs, { recursive: true, force: true })
              await symlinkAsync(outer, targetAbs)
            },
          })

          assert.ok(seamFired, 'the seam must have fired for the swap to have been attempted at all')
          assert.equal(
            results.some((r) => r.includes('SECRETMARKER')),
            false,
            'a swap landing in the exact check-to-open window must still never be traversed',
          )
          assert.equal(
            results.some((r) => r.includes('innocent.ts')),
            false,
            'the directory was withheld entirely (swapped-away before opendir even ran) — its original contents are gone from disk, not merely filtered',
          )
          // Positive control: the walk did not just silently stop dead —
          // "subtree" itself (which the swap never touched) is still a match.
          assert.ok(results.includes('subtree'), 'the walk must still find unrelated matches, not fail closed on everything')
        } finally {
          rmSync(outer, { recursive: true, force: true })
        }
      })

      // #7910 review round 3 — round 2's own fix (the test above) verified
      // the PATH twice (a pre-open lstat, then a post-open lstat) but never
      // the object `opendir` actually opened. That is an ABA, not a
      // check-then-use: swap `target` to a symlink pointing OUTSIDE the
      // workspace before the open (so `opendir` follows it), then swap the
      // real directory BACK before the post-open lstat runs — both lstats
      // see the legitimate directory, so round 2's dev/ino comparison
      // reports a match despite the `Dir` it is vouching for being bound to
      // the outside target the whole time. `openVerifiedDirForDescend` now
      // opens via `openNoFollow` (O_NOFOLLOW enforced atomically by the
      // kernel on POSIX) and verifies identity via `fstat` on the OPENED
      // HANDLE itself, never a fresh path lookup — this drives exactly the
      // swap-then-restore timing above via the seam's two phases.
      it('closes the ABA where a swap-then-restore straddles the open, not just check-then-use (security #7910 review round 3)', async () => {
        const outer = mkdtempSync(join(tmpdir(), 'chroxy-toctou-aba-outer-'))
        try {
          writeFileSync(join(outer, 'SECRETMARKER.txt'), 'top secret')
          mkdirSync(join(dir, 'subtree'))
          const targetAbs = join(dir, 'subtree', 'target')
          mkdirSync(targetAbs)
          writeFileSync(join(targetAbs, 'innocent.ts'), '1')

          // The real directory is moved ASIDE (never deleted) so it can be
          // moved BACK with its inode intact — an identity check comparing
          // dev/ino (as both the mutant below and the fix's own pre-open
          // `lstat` do) must see the literal SAME object restored, not a
          // freshly created directory that merely looks the same but holds
          // a different inode.
          const realAside = join(dir, 'subtree', 'target-real-aside')

          const { matchers } = compileCaseCheck('subtree/**')
          const state = { stop: null, visited: 0 }
          const results = []
          let beforeOpenFired = false
          let afterOpenFired = false
          await walkGlob({
            realRoot: dir, matchers, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
            state, results, maxEntries: 10_000_000,
            __testDescendSeam: async (target, phase) => {
              if (target !== targetAbs) return
              if (phase === 'before-open') {
                beforeOpenFired = true
                // Half 1 of the ABA: move the real directory aside (its
                // inode is untouched) and plant a symlink to the outside
                // directory at the original path, right before the open.
                await renameAsync(targetAbs, realAside)
                await symlinkAsync(outer, targetAbs)
              } else if (phase === 'after-open') {
                afterOpenFired = true
                // Half 2 of the ABA: remove the symlink (this unlinks the
                // symlink itself, never `outer`'s contents — `fs.rm` never
                // follows a symlink to recurse into its target) and move
                // the SAME real directory back into place before whatever
                // the fix's post-open verification re-checks by PATH would
                // run — this reproduces the exact identity round 2's
                // dev/ino comparison would see as "unchanged".
                await rmAsync(targetAbs, { force: true })
                await renameAsync(realAside, targetAbs)
              }
            },
          })

          assert.ok(beforeOpenFired, 'the before-open seam must have fired for the swap to have been attempted at all')
          assert.equal(
            results.some((r) => r.includes('SECRETMARKER')),
            false,
            'a swap-then-restore straddling the open must never disclose the outside directory\'s entries',
          )
          // `openNoFollow`'s O_NOFOLLOW makes the open itself fail while the
          // symlink is in place — there is no point afterward at which
          // "restoring" the real directory can retroactively legitimize an
          // open that never happened, so `after-open` is never reached for
          // THIS entry. That is the expected, correct outcome (see the
          // mutation proof in the PR description/report — reverting to the
          // round-2 `opendir()`-based open makes this same assertion fail
          // while `afterOpenFired` flips true), not a weaker test: the
          // leading assertion above is on the WALK'S OUTPUT.
          assert.equal(
            afterOpenFired,
            false,
            'openNoFollow must refuse the open outright while the symlink is in place — the swap-back must never be reached',
          )
        } finally {
          rmSync(outer, { recursive: true, force: true })
        }
      })

      // #7910 review round 2 — the mirror image of the test above: the seam
      // fires but does NOT swap anything, proving the new pre-open/post-open
      // identity check does not reject a legitimate, un-tampered directory
      // (a check that withholds everything would also make the test above
      // pass, for the wrong reason — docs/false-safety-guards.md).
      it('still descends normally when the seam fires but nothing is swapped (positive control, #7910 review round 2)', async () => {
        mkdirSync(join(dir, 'subtree'))
        const targetAbs = join(dir, 'subtree', 'target')
        mkdirSync(targetAbs)
        writeFileSync(join(targetAbs, 'innocent.ts'), '1')

        const { matchers } = compileCaseCheck('subtree/**')
        const state = { stop: null, visited: 0 }
        const results = []
        let seamFired = false
        await walkGlob({
          realRoot: dir, matchers, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
          state, results, maxEntries: 10_000_000,
          __testDescendSeam: async (target) => { if (target === targetAbs) seamFired = true },
        })

        assert.ok(seamFired, 'the seam must have been reached for this to be a meaningful control')
        assert.ok(
          results.some((r) => r.includes('innocent.ts')),
          'an untampered directory must still be descended into and its contents matched',
        )
      })

      // #7910 review round 2 (parity re-review) — the round-2 fix's
      // `detHandoff`/`canDescendSymlink` gate answers "was this entry named
      // by a determinate segment THIS step" — which a SELF-REFERENTIAL
      // symlink's repeating name satisfies at every depth it recurs to,
      // forever. `**/selfloop/**` against `selfloop -> .` measured 200+
      // matches (unbounded growth with sibling count) on the round-2 code,
      // bounded only by the componentwise resolver's own symlink-depth
      // ceiling — a real DoS shape, not merely a parity gap. `visitedDirs`
      // (real directories on the current descent path, by dev:ino) closes
      // it: entering a real directory that is already an ancestor on THIS
      // path is refused before any of its entries are read.
      it('does not grow unbounded on a self-referential symlink loop reached via a determinate segment inside \'**\' (DoS #7910 review round 2)', { timeout: 10_000 }, async () => {
        mkdirSync(join(dir, 'sub'))
        symlinkSync('.', join(dir, 'sub', 'selfloop'))
        for (let i = 0; i < 40; i++) writeFileSync(join(dir, 'sub', `f${i}.txt`), '1')

        const { matchers } = compileCaseCheck('**/selfloop/**')
        const state = { stop: null, visited: 0 }
        const results = []
        const t0 = Date.now()
        await walkGlob({
          realRoot: dir, matchers, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
          state, results, maxEntries: 50_000_000,
        })
        const ms = Date.now() - t0

        assert.ok(ms < 2000, `a self-loop through a determinate segment must not blow up the walk time, took ${ms}ms`)
        // Bounded LINEARLY in the number of siblings (visiting each real
        // entry a small constant number of times), never exponentially —
        // the unpatched shape grew past 1,600 matches on an equivalent
        // 40-sibling fixture.
        assert.ok(
          results.length < 100,
          `a self-loop must not produce unbounded matches, got ${results.length} (unpatched: 1,640+ on this fixture shape)`,
        )
        assert.ok(
          state.visited < 200,
          `a self-loop must not visit an unbounded number of filesystem entries, visited ${state.visited}`,
        )
      })

      // #7910 review round 2 — the mirror image: two SEPARATE, non-
      // overlapping symlinks that happen to point at the SAME real directory
      // (a diamond, not a cycle) must still each be followed independently —
      // `visitedDirs` is path-scoped (pushed on descent, popped on
      // backtracking in `walk`'s `finally`), not a global "seen once, never
      // again" set, precisely so this does not regress.
      it('still follows two independent symlinks to the SAME real directory (not a cycle) — positive control (#7910 review round 2)', async () => {
        mkdirSync(join(dir, 'real'))
        writeFileSync(join(dir, 'real', 'shared.ts'), '1')
        mkdirSync(join(dir, 'branchA'))
        mkdirSync(join(dir, 'branchB'))
        symlinkSync(join(dir, 'real'), join(dir, 'branchA', 'lnk'))
        symlinkSync(join(dir, 'real'), join(dir, 'branchB', 'lnk'))

        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*/lnk/*.ts' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.match(r.content, /branchA\/lnk\/shared\.ts/, 'the first independent symlink to the shared real directory must still be followed')
        assert.match(r.content, /branchB\/lnk\/shared\.ts/, 'the second independent symlink to the SAME real directory must ALSO still be followed — it is not an ancestor of the first')
      })

      // #7910 review round 2 (parity re-review) — round 2's zero-width `**`
      // closure gate used `isDirLike = dirent.isDirectory() ||
      // dirent.isSymbolicLink()`, which is true for EVERY symlink regardless
      // of how it was discovered — exempting every symlink from the
      // determinate-segment requirement `canDescendSymlink` (just below)
      // already enforces for descending. Verified directly against Node 22's
      // `glob()`: a NON-determinate segment naming a symlinked directory
      // (`*/**`) produces ZERO matches for that symlink, only a determinate
      // one (`[s]rc-link/**`) does.
      it('a trailing ** does not close with zero width onto a symlinked directory named by a non-determinate segment (parity #7910 review round 2)', async () => {
        mkdirSync(join(dir, 'src'))
        writeFileSync(join(dir, 'src', 'index.ts'), '1')
        symlinkSync(join(dir, 'src'), join(dir, 'src-link'))

        const wild = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*/**' }, ...ctx() })
        assert.equal(wild.isError, false)
        assert.equal(wild.content.includes('src-link'), false, '"*/**" (non-determinate) must not close zero-width onto the symlinked directory itself')

        const bracket = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '[s]rc-link/**' }, ...ctx() })
        assert.equal(bracket.isError, false)
        assert.match(bracket.content, /^src-link$/m, '"[s]rc-link/**" (determinate) still closes zero-width onto the symlink itself (matches fs.glob)')
      })

      // Same gate, for a symlink to a FILE rather than a directory — verified
      // directly against Node 22's `glob()`: `*.txt/**` (non-determinate)
      // produces no match for a symlinked `.txt` file; a determinate literal
      // does, exactly like an ordinary (non-symlink) file (`plainfile.txt/**`,
      // tested elsewhere in this file).
      it('a trailing ** does not close with zero width onto a symlinked FILE named by a non-determinate segment (parity #7910 review round 2)', async () => {
        writeFileSync(join(dir, 'real-file.txt'), '1')
        symlinkSync(join(dir, 'real-file.txt'), join(dir, 'file-link.txt'))

        const wild = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.txt/**' }, ...ctx() })
        assert.equal(wild.isError, false)
        assert.equal(wild.content.includes('file-link.txt'), false, '"*.txt/**" (non-determinate) must not close zero-width onto the symlinked file')

        const lit = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'file-link.txt/**' }, ...ctx() })
        assert.equal(lit.isError, false)
        assert.match(lit.content, /^file-link\.txt$/m, 'a determinate literal still closes zero-width onto a symlinked file (matches a plain file, and matches fs.glob)')
      })

      // #7910 review round 2 (parity re-review) — a pattern ending in `/`
      // means directories only, matching `fs.glob` exactly (verified
      // directly): `sub/*/` excludes a plain file AND a symlink pointing at
      // a directory, keeping only a real (non-symlink) directory entry.
      // `compileCaseCheck` already drops the trailing empty segment a
      // trailing slash produces, so without this the flag was silently lost
      // and `sub/*/` behaved identically to `sub/*`.
      it('a pattern ending in / matches directories only, excluding files and symlinks-to-directories (parity #7910 review round 2)', async () => {
        mkdirSync(join(dir, 'sub'))
        mkdirSync(join(dir, 'sub', 'realdir'))
        writeFileSync(join(dir, 'sub', 'plainfile.txt'), '1')
        symlinkSync(join(dir, 'sub', 'realdir'), join(dir, 'sub', 'dirlink'))

        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'sub/*/' }, ...ctx() })
        assert.equal(r.isError, false)
        const lines = r.content.split('\n')
        assert.ok(lines.includes('sub/realdir'), 'a real directory must still match a trailing-slash pattern')
        assert.equal(lines.includes('sub/plainfile.txt'), false, 'a plain file must be excluded by a trailing-slash (directory-only) pattern')
        assert.equal(lines.includes('sub/dirlink'), false, 'a symlink pointing at a directory must ALSO be excluded — fs.glob requires a REAL directory, not merely "dir-like"')

        // Positive control: without the trailing slash, the same pattern
        // finds all three (proving the exclusion is the `/`, not something
        // else about this fixture).
        const noSlash = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'sub/*' }, ...ctx() })
        const noSlashLines = noSlash.content.split('\n')
        assert.ok(noSlashLines.includes('sub/plainfile.txt') && noSlashLines.includes('sub/dirlink'), 'without the trailing slash, the file and the symlink must both be listed (positive control)')
      })

      // #7910 review (security/DoS) — a symlinked directory is only descended
      // into when a DETERMINATE segment (literal, bracket class, or brace
      // alternation — no bare `*`/`?`) explicitly named it, matching Node
      // 22's `glob()` exactly (verified directly): `link/*`, `[l]ink/*`
      // follow; `*/*`, `?ink/*` do not (they still LIST the symlink's own
      // name, just never open it). Without this, `walkGlob` followed every
      // symlinked directory it found regardless of how it was discovered —
      // duplicating real subtrees under every alias `**` swept up, and, for
      // a self-referential symlink, being re-discovered (and re-descended
      // into) at every recursion depth.
      it('descends a symlinked directory only via a determinate segment, never via a bare wildcard or ** absorption (security/DoS #7910 review)', async () => {
        mkdirSync(join(dir, 'real'))
        writeFileSync(join(dir, 'real/index.ts'), '1')
        symlinkSync(join(dir, 'real'), join(dir, 'real-link'))

        const lit = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'real-link/*.ts' }, ...ctx() })
        assert.match(lit.content, /real-link\/index\.ts/, 'a literal segment still follows (matches fs.glob)')

        const bracket = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '[r]eal-link/*.ts' }, ...ctx() })
        assert.match(bracket.content, /real-link\/index\.ts/, 'a bracket-class segment still follows (matches fs.glob)')

        const wild = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*/*.ts' }, ...ctx() })
        assert.equal(wild.content.includes('real-link'), false, '"*/*" must not descend through a wildcard-discovered symlink')
        assert.match(wild.content, /real\/index\.ts/, 'the real directory is still found through the same pattern (positive control)')

        const globstar = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**' }, ...ctx() })
        const lines = globstar.content.split('\n')
        assert.ok(lines.includes('real-link'), '"**" must still list the symlink itself')
        assert.equal(lines.some((l) => l.startsWith('real-link/')), false, '"**" must never descend through a symlink it merely absorbed')
      })

      it('terminates a symlink self-loop discovered only via ** absorption, cheaply (DoS #7910 review)', async () => {
        mkdirSync(join(dir, 'loopdir'))
        symlinkSync('.', join(dir, 'loopdir/selfloop'))
        const t0 = Date.now()
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**' }, ...ctx() })
        const ms = Date.now() - t0
        assert.equal(r.isError, false)
        assert.ok(ms < 2000, `a bare-**-discovered symlink self-loop must terminate quickly, took ${ms}ms`)
        const lines = r.content.split('\n')
        assert.ok(lines.includes('loopdir/selfloop'), 'the self-loop symlink itself is still listed')
        assert.equal(lines.includes('loopdir/selfloop/selfloop'), false, '"**" must not re-discover the loop through its own absorption')
      })

      // #7916 (partial fix) — `visitedDirs`'s ancestor-cycle refusal used to
      // apply unconditionally, refusing even a fully `**`-free, all-literal
      // pattern's own explicit re-entry through a self-loop
      // (`sub/selfloop/file.txt`, verified directly against Node 22's
      // `glob()` to actually match there). `openVerifiedDirForDescend`'s new
      // `enforceCycleGuard` parameter (derived from `walkGlob`'s
      // `hasGlobstar`) skips the refusal specifically when the WHOLE pattern
      // contains no `**` at all — see that parameter's doc for why this is
      // safe: a `**`-free pattern's recursion depth is hard-bounded by its
      // own segment count, independent of the filesystem's symlink
      // structure, so there is nothing here for the DoS guard to protect
      // against.
      it('a fully **-free literal chain re-entering an ancestor through a self-loop now matches (parity #7916 partial fix)', {
        // symlinkSync needs a privilege the Windows CI runner lacks by default (#7288).
        skip: process.platform === 'win32',
      }, async () => {
        mkdirSync(join(dir, 'sub'))
        writeFileSync(join(dir, 'sub', 'file.txt'), '1')
        symlinkSync('.', join(dir, 'sub', 'selfloop'))

        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'sub/selfloop/file.txt' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, 'sub/selfloop/file.txt', 'a single, fully-literal re-entry through the self-loop must be found, matching fs.glob')
      })

      // #7916 (partial fix, termination proof) — the relaxation above is only
      // safe because a `**`-free pattern's OWN LENGTH bounds how many times
      // it can re-enter the self-loop, never the filesystem's cycle. This
      // test is the adversarial case that claim has to survive: a pattern
      // that spells the self-loop segment out MANY times in a row (proving
      // the bound really is the pattern's length, not some smaller constant
      // that happened to work for one hop) still terminates quickly and
      // still matches — verified directly against Node 22's `glob()` on the
      // identical fixture and pattern (`took 6ms` for 20 hops on this
      // machine), so this is a real parity claim, not merely "does not
      // hang".
      it('terminates quickly on a **-free pattern with many repeated self-loop hops, matching fs.glob (DoS/termination #7916 partial fix)', {
        timeout: 10_000,
        // symlinkSync needs a privilege the Windows CI runner lacks by default (#7288).
        skip: process.platform === 'win32',
      }, async () => {
        mkdirSync(join(dir, 'sub'))
        writeFileSync(join(dir, 'sub', 'file.txt'), '1')
        symlinkSync('.', join(dir, 'sub', 'selfloop'))

        const hops = 20
        const pattern = `sub/${'selfloop/'.repeat(hops)}file.txt`
        const t0 = Date.now()
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern }, ...ctx() })
        const ms = Date.now() - t0

        assert.equal(r.isError, false)
        assert.ok(ms < 2000, `a ${hops}-hop **-free self-loop chain must terminate quickly, took ${ms}ms`)
        assert.equal(r.content, `sub/${'selfloop/'.repeat(hops)}file.txt`, 'must match fs.glob exactly for this exact chain length')
      })

      // #7916 (partial fix, control) — the relaxation is scoped to `**`-free
      // patterns ONLY. A pattern that combines an explicit self-loop chain
      // WITH `**` must still be governed by the full, unchanged `visitedDirs`
      // guard — proving the `hasGlobstar` gate actually reads the WHOLE
      // compiled pattern, not just its first segment or whichever segment is
      // being matched right now.
      //
      // #7918 review — the pattern must be one the guard's ABSENCE would
      // blow up. The first version of this test used
      // `sub/selfloop/selfloop/**`, which stays at 42 lines with the guard
      // deleted outright (a trailing `**` never descends a symlink it merely
      // absorbed), so it could not fail. `sub/selfloop/**/selfloop/**` is
      // the round-2 DoS shape behind two literal hops: measured 1,599 lines
      // with the guard forced off, 0 with it on — and unlike the round-2
      // test's `**/selfloop/**`, its FIRST segment is not `**`, so a gate
      // that only looked at `matchers[0]` would also go red here.
      it('still enforces the full ancestor-cycle guard when the pattern contains ** anywhere, even after literal selfloop hops (DoS control #7916 partial fix)', {
        timeout: 5_000,
        // symlinkSync needs a privilege the Windows CI runner lacks by default (#7288).
        skip: process.platform === 'win32',
      }, async () => {
        mkdirSync(join(dir, 'sub'))
        for (let i = 0; i < 40; i++) writeFileSync(join(dir, 'sub', `f${i}.txt`), '1')
        symlinkSync('.', join(dir, 'sub', 'selfloop'))

        const t0 = Date.now()
        const r = await executeBuiltinTool({
          toolName: 'Glob', input: { pattern: 'sub/selfloop/**/selfloop/**' }, ...ctx(),
        })
        const ms = Date.now() - t0
        assert.equal(r.isError, false)
        assert.ok(ms < 2000, `a **-containing pattern through a self-loop must still be bounded, took ${ms}ms`)
        const lines = r.content.startsWith('No matches') ? [] : r.content.split('\n')
        assert.ok(lines.length < 200, `a **-containing pattern through a self-loop must still be bounded in match count, got ${lines.length}`)
      })

      // #7910 review (parity) — a trailing `**` closing with ZERO width onto a
      // non-directory entry requires the segment that named the entry to be
      // DETERMINATE (verified directly against Node 22's `glob()`:
      // `plainfile.txt/**` matches the plain FILE `plainfile.txt`;
      // `*.txt/**` does not). `walkGlob`'s `closeGlobstars` propagation had no
      // such gate, so a non-determinate segment handing straight into a
      // trailing `**` finalized on files it should never have matched.
      it('a trailing ** does not close with zero width onto a non-directory entry named by a non-determinate segment (#7910 review)', async () => {
        writeFileSync(join(dir, 'plainfile.txt'), '1')
        const lit = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: 'plainfile.txt/**' }, ...ctx() })
        assert.equal(lit.isError, false)
        assert.match(lit.content, /^plainfile\.txt$/m, 'a literal segment still closes ** onto a file (matches fs.glob)')

        const wild = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.txt/**' }, ...ctx() })
        assert.match(wild.content, /No matches/, 'a bare-wildcard segment must not close ** onto a file')
      })

      // #7901 — `walkGlob` implements dotfile exclusion itself now (previously
      // free, handled internally by `fs.glob` before any of chroxy's own code
      // ran). Without `advanceToken`'s dot guard, a bare `*`/`?`/ordinary
      // class would match a real segment's leading dot the same as any other
      // character — nothing in the pre-#7901 test suite pins this, because it
      // was always `fs.glob`'s behavior to prove, never this file's own.
      it('a bare wildcard/any/class never matches a real leading dot', async () => {
        writeFileSync(join(dir, '.env'), 'secret')
        writeFileSync(join(dir, 'keep.ts'), '1')
        const star = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*' }, ...ctx() })
        assert.equal(star.isError, false)
        assert.equal(star.content.includes('.env'), false, '"*" must not match a dotfile')
        assert.match(star.content, /keep\.ts/)

        const any = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '????' }, ...ctx() })
        assert.equal(any.isError, false)
        assert.equal(any.content.includes('.env'), false, '"?" must not match a dotfile\'s leading dot')

        const klass = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '[.e]nv' }, ...ctx() })
        assert.equal(klass.isError, false)
        assert.match(klass.content, /No matches/, 'a multi-member class containing "." is not the [.] exception')
      })

      // #7910 review — a `*` immediately followed by a literal `.` in the SAME
      // segment (`*.env`) must not match a real leading dot either: the star's
      // own dot guard used to keep offset 0 reachable with ZERO width so a
      // LATER dot-entitled literal token could consume it, letting the star
      // "pass through" the dot untouched. Verified directly against Node 22's
      // `glob()`: `*.env` returns no matches for a real `.env`. The existing
      // "bare wildcard" test above only covers a `*` with nothing after it in
      // the segment, which cannot exercise this path.
      it('a leading * cannot cross a real leading dot even with a literal dot immediately after it (#7910 review)', async () => {
        writeFileSync(join(dir, '.env'), 'secret')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.env' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.match(r.content, /No matches/, '"*.env" must not match ".env"')

        const positive = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '.env*' }, ...ctx() })
        assert.equal(positive.isError, false)
        assert.match(positive.content, /\.env/, 'a literal-dot-first pattern is unaffected (positive control)')
      })

      // #7901 — `**` (globstar) never absorbs a dot-named real segment either,
      // at any depth, matching `fs.glob`'s own default exactly (verified
      // directly against Node 22: `.hidden/**` lists `.hidden` itself and its
      // non-dot descendants, never a nested dotfile). Without this check in
      // `walkGlob`'s own GLOBSTAR branch, `**` would both list AND descend
      // into every dotfile/dotdir it finds.
      it('"**" never lists or descends into a dotfile/dotdir', async () => {
        mkdirSync(join(dir, '.hidden'), { recursive: true })
        writeFileSync(join(dir, '.hidden/inside.ts'), '1')
        writeFileSync(join(dir, '.envtop'), '1')
        mkdirSync(join(dir, 'visible'), { recursive: true })
        writeFileSync(join(dir, 'visible/keep.ts'), '1')

        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**' }, ...ctx() })
        assert.equal(r.isError, false)
        const lines = r.content.split('\n')
        assert.equal(lines.includes('.hidden'), false, '"**" must not list the hidden directory itself')
        assert.equal(lines.some((l) => l.includes('.hidden')), false, '"**" must not descend into the hidden directory')
        assert.equal(lines.includes('.envtop'), false, '"**" must not list a top-level dotfile')
        assert.ok(lines.includes('visible') && lines.includes('visible/keep.ts'), 'ordinary entries must still be found')
      })

      // #7901 — `GLOB_MAX_ENTRIES_VISITED`'s guard, proven the same way the
      // existing wall-clock-timeout test proves `CHROXY_GLOB_TIMEOUT_MS`: a
      // hardcoded 2,000,000 default cannot be waited out in a test, so it is
      // read per call via `CHROXY_GLOB_MAX_ENTRIES`, and this test lowers it
      // to a size the fixture tree comfortably exceeds. Without this guard (or
      // with the env override wired to nothing), the walk would simply finish
      // normally against a tree this small — the test only proves anything
      // because the CONTROL run (unset override) is asserted to succeed on
      // the identical tree first.
      it('bounds the walk by total entries visited, and the bound FIRES', async () => {
        buildBigTree(dir, 5, 200) // 1,000 files

        const control = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*.ts' }, ...ctx() })
        assert.equal(control.isError, false, 'control: the same tree must succeed with the real default')

        const prev = process.env.CHROXY_GLOB_MAX_ENTRIES
        process.env.CHROXY_GLOB_MAX_ENTRIES = '10'
        try {
          const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*.ts' }, ...ctx() })
          assert.equal(r.isError, true, 'a 10-entry budget must fire on a 1,000-file tree, not succeed')
          assert.match(r.content, /visited more than 10 filesystem entries/)
        } finally {
          if (prev === undefined) delete process.env.CHROXY_GLOB_MAX_ENTRIES
          else process.env.CHROXY_GLOB_MAX_ENTRIES = prev
        }
      })

      it('treats an empty or unparseable CHROXY_GLOB_MAX_ENTRIES as unset', async () => {
        buildBigTree(dir, 5, 200) // 1,000 files
        const prev = process.env.CHROXY_GLOB_MAX_ENTRIES
        try {
          // CONTROL: a real small budget DOES fire on this tree.
          process.env.CHROXY_GLOB_MAX_ENTRIES = '10'
          const control = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*.ts' }, ...ctx() })
          assert.equal(control.isError, true, 'control: a real 10-entry budget must fire on this tree')

          for (const value of ['', '   ', '0', 'abc', '-1']) {
            process.env.CHROXY_GLOB_MAX_ENTRIES = value
            const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*.ts' }, ...ctx() })
            assert.equal(r.isError, false, `${JSON.stringify(value)} must fall back to the default, not disable Glob`)
          }
        } finally {
          if (prev === undefined) delete process.env.CHROXY_GLOB_MAX_ENTRIES
          else process.env.CHROXY_GLOB_MAX_ENTRIES = prev
        }
      })
    })

    // #7357 — two output-integrity defects the review panel on PR #7349 found.
    describe('dangling symlinks and embedded newlines (#7357)', () => {
      // Re-verification (not a new fix): #6923's component-wise resolver
      // (ws-file-ops/common.js -> utils/componentwise-resolver.js), which
      // `isWithin` already delegates to, resolves ENOENT on a dangling
      // symlink's target by applying the remaining tail LEXICALLY rather than
      // throwing — so the containment decision already lands on where the
      // target STRING points, in or out of the workspace, never on a plain
      // `realpath()` throw. These three tests PIN that already-correct
      // behavior (measured green against origin/main; #6923 landed before
      // #7357 was filed) rather than fix anything host-side.
      it('lists a dangling symlink whose target is inside the workspace', { skip: process.platform === 'win32' }, async () => {
        // symlinkSync needs a privilege the Windows CI runner lacks (#7288).
        symlinkSync('./nonexistent-7357', join(dir, 'broken.ts'))
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.ts' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.equal(r.content, 'broken.ts')
      })

      it('withholds a dangling symlink whose absolute target string points outside the workspace', { skip: process.platform === 'win32' }, async () => {
        symlinkSync('/definitely-nonexistent-outside-7357', join(dir, 'broken.ts'))
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.ts' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.match(r.content, /No matches/)
      })

      it('withholds a dangling symlink whose relative target escapes the workspace via ..', { skip: process.platform === 'win32' }, async () => {
        symlinkSync('../../../etc/nonexistent-7357', join(dir, 'broken.ts'))
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.ts' }, ...ctx() })
        assert.equal(r.isError, false)
        assert.match(r.content, /No matches/)
      })

      it('a match whose name contains a newline is dropped, never split into two entries', {
        // Windows rejects control characters (including \n, 0x0A) in
        // filenames via the Win32 API — there is nothing to reproduce there.
        skip: process.platform === 'win32',
      }, async () => {
        writeFileSync(join(dir, 'keep.ts'), '1')
        writeFileSync(join(dir, 'nl\nSECRET.ts'), '1')
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*.ts' }, ...ctx() })
        assert.equal(r.isError, false)
        // Exact equality, not a substring match: proves the newline-bearing
        // name is ABSENT, not merely that "SECRET.ts" as a fabricated
        // second line is absent (which a half-fixed split could still pass).
        assert.equal(r.content, 'keep.ts')
      })
    })
  })

  describe('Grep', () => {
    it('finds matching lines via ripgrep or grep fallback', async () => {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src/x.js'), 'foo\nbar TARGET baz\nqux')
      writeFileSync(join(dir, 'src/y.js'), 'no match here')
      const r = await executeBuiltinTool({
        toolName: 'Grep',
        input: { pattern: 'TARGET', path: join(dir, 'src') },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /x\.js.*TARGET/)
    })

    it('returns "No matches" when the pattern is absent', async () => {
      writeFileSync(join(dir, 'a.txt'), 'hello world')
      const r = await executeBuiltinTool({
        toolName: 'Grep',
        input: { pattern: 'absolutely-not-present' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /No matches/)
    })

    it('refuses absolute path outside the workspace (security #4071)', async () => {
      // Pre-fix PoC: Grep with path=/etc returned /etc/passwd contents.
      const r = await executeBuiltinTool({
        toolName: 'Grep',
        input: { pattern: 'root', path: '/etc' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /outside workspace/)
    })
  })

  describe('TodoWrite (#4051)', () => {
    function todoCtx() {
      return { cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: new Map() }
    }

    it('adds new items to an empty store', async () => {
      const store = new Map()
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [
          { id: 'a', content: 'task one', status: 'pending' },
          { id: 'b', content: 'task two', status: 'in_progress', activeForm: 'Working on two' },
        ] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(r.isError, false)
      assert.equal(store.size, 2)
      assert.match(r.content, /2 items/)
      assert.match(r.content, /1 in progress/)
      assert.match(r.content, /1 pending/)
      assert.match(r.content, /task one/)
      assert.match(r.content, /task two/)
    })

    it('merges partial updates without dropping unrelated items', async () => {
      const store = new Map()
      // Seed with 3 items.
      await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [
          { id: 'a', content: 'task one', status: 'pending' },
          { id: 'b', content: 'task two', status: 'pending' },
          { id: 'c', content: 'task three', status: 'pending' },
        ] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(store.size, 3)

      // Update ONLY item 'b' — items 'a' and 'c' must remain in the store.
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [{ id: 'b', content: 'task two', status: 'in_progress' }] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(r.isError, false)
      assert.equal(store.size, 3, 'partial update must not drop unrelated items')
      assert.equal(store.get('a').status, 'pending')
      assert.equal(store.get('b').status, 'in_progress')
      assert.equal(store.get('c').status, 'pending')
    })

    it('replaces fields per item id on subsequent calls', async () => {
      const store = new Map()
      await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [{ id: 'x', content: 'old name', status: 'pending' }] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [{ id: 'x', content: 'new name', status: 'completed' }] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(store.size, 1)
      assert.equal(store.get('x').content, 'new name')
      assert.equal(store.get('x').status, 'completed')
    })

    it('rejects items without an id', async () => {
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [{ content: 'no id', status: 'pending' }] },
        ...todoCtx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /id is required/)
    })

    it('rejects items without content', async () => {
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [{ id: 'a', status: 'pending' }] },
        ...todoCtx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /content is required/)
    })

    it('rejects invalid status values', async () => {
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [{ id: 'a', content: 'x', status: 'banana' }] },
        ...todoCtx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /status must be one of/)
    })

    it('rejects duplicate ids within a single call (#4138)', async () => {
      // Per #4138: a duplicate id in one call is almost certainly a
      // model bug. Surface it as EINVAL so the model self-corrects
      // rather than letting the last write silently win.
      const store = new Map()
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [
          { id: 'a', content: 'first', status: 'pending' },
          { id: 'a', content: 'second', status: 'completed' },
        ] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /duplicate/i)
      // Id is JSON-quoted for parseability (so embedded quotes / newlines /
      // control chars don't mangle the message). Pin both the JSON-quoted
      // id and the array index so the template can't drift unnoticed.
      assert.match(r.content, /"a"/)
      assert.match(r.content, /todos\[1\]/)
      assert.equal(store.size, 0, 'duplicate-id call must not mutate the store (atomic)')
    })

    it('JSON-quotes the id in the dup-rejection error (Copilot review on #4155)', async () => {
      // An id containing a quote or newline must not mangle the error
      // string. JSON.stringify yields a parseable representation.
      const store = new Map()
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [
          { id: 'a"b', content: 'first', status: 'pending' },
          { id: 'a"b', content: 'second', status: 'completed' },
        ] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(r.isError, true)
      // JSON.stringify('a"b') === '"a\\"b"' — the escaped quote survives.
      assert.match(r.content, /"a\\"b"/)
    })

    it('treats ids as case-sensitive (dup check matches storage semantics)', async () => {
      // The Map storage uses raw string keys, so 'a' and 'A' are distinct.
      // Pin that contract — a future "normalize for user friendliness"
      // refactor would silently merge what the model intended as separate
      // todos.
      const store = new Map()
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [
          { id: 'a', content: 'lower', status: 'pending' },
          { id: 'A', content: 'upper', status: 'pending' },
        ] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(r.isError, false)
      assert.equal(store.size, 2)
    })

    it('duplicate-id rejection preserves prior store entries (#4138 atomic)', async () => {
      const store = new Map()
      // Seed a prior entry under id 'a'.
      await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [{ id: 'a', content: 'prior', status: 'in_progress' }] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      // A call with a dup must not mutate 'a' (even though both dups carry id 'a').
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [
          { id: 'a', content: 'one', status: 'pending' },
          { id: 'a', content: 'two', status: 'completed' },
          { id: 'b', content: 'new', status: 'pending' },
        ] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(r.isError, true)
      assert.equal(store.size, 1, 'prior store untouched on dup rejection')
      assert.equal(store.get('a').content, 'prior')
      assert.equal(store.get('a').status, 'in_progress')
      assert.equal(store.has('b'), false, 'valid item from same call also not applied')
    })

    it('does not half-apply when a later item is invalid (atomic merge)', async () => {
      const store = new Map()
      // Seed.
      await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [{ id: 'a', content: 'first', status: 'pending' }] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      // Try a 2-item call where the second is invalid — neither item
      // should be applied; the store should still contain only 'a' with
      // its original state.
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [
          { id: 'a', content: 'mutated', status: 'completed' },
          { id: 'b', content: 'bad', status: 'banana' },
        ] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(r.isError, true)
      assert.equal(store.size, 1, 'invalid item must not apply earlier items in the same call')
      assert.equal(store.get('a').content, 'first')
      assert.equal(store.get('a').status, 'pending')
    })

    it('rejects when todos is not an array', async () => {
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: 'not-an-array' },
        ...todoCtx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /must be an array/)
    })

    it('accepts an empty todos array (no-op confirmation)', async () => {
      const store = new Map([['a', { id: 'a', content: 'x', status: 'pending' }]])
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(r.isError, false)
      assert.equal(store.size, 1, 'empty input must not clear the store')
      assert.match(r.content, /1 items/)
    })

    it('caps rendered output at 100 items with a "showing first X of Y" marker (review #4136)', async () => {
      const store = new Map()
      const lots = []
      for (let i = 0; i < 150; i++) {
        lots.push({ id: `t${i}`, content: `task ${i}`, status: 'pending' })
      }
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: lots },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(r.isError, false)
      assert.equal(store.size, 150, 'full list retained server-side')
      assert.match(r.content, /150 items/)
      assert.match(r.content, /showing first 100 of 150/)
      // Item 0 should appear, item 149 should NOT (cap is 100).
      assert.match(r.content, /task 0 \(t0\)/)
      assert.equal(r.content.includes('task 149 (t149)'), false)
    })

    it('truncates long content strings with an ellipsis marker (review #4136)', async () => {
      const store = new Map()
      const longText = 'x'.repeat(500)
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [{ id: 'a', content: longText, status: 'pending' }] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000, todoStore: store,
      })
      assert.equal(r.isError, false)
      assert.ok(r.content.length < longText.length + 200, 'output must be capped')
      assert.match(r.content, /…/)
    })

    it('returns EINTERNAL when the executor is called without a todoStore', async () => {
      // This guards against forgetting to wire the session's Map through
      // — the executor should fail loudly rather than silently dropping.
      const r = await executeBuiltinTool({
        toolName: 'TodoWrite',
        input: { todos: [{ id: 'a', content: 'x', status: 'pending' }] },
        cwd: dir, cwdRealCache, cwdCacheTtl: 30_000,
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /EINTERNAL/)
    })
  })

  describe('Bash env hardening (#4069)', () => {
    it('strips ANTHROPIC_API_KEY before spawning bash', async () => {
      const original = process.env.ANTHROPIC_API_KEY
      process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak'
      try {
        const r = await executeBuiltinTool({
          toolName: 'Bash',
          input: { command: 'echo "KEY=$ANTHROPIC_API_KEY"' },
          ...ctx(),
        })
        assert.equal(r.isError, false)
        assert.match(r.content, /KEY=\s*$/m)
        assert.equal(r.content.includes('sk-ant-must-not-leak'), false,
          'BYOK API key must not be reachable from the model-controlled subprocess')
      } finally {
        if (original) process.env.ANTHROPIC_API_KEY = original
        else delete process.env.ANTHROPIC_API_KEY
      }
    })

    it('strips CLAUDE_CODE_OAUTH_TOKEN before spawning bash', async () => {
      const original = process.env.CLAUDE_CODE_OAUTH_TOKEN
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-secret-leak-this-and-die'
      try {
        const r = await executeBuiltinTool({
          toolName: 'Bash',
          input: { command: 'env | grep -c OAUTH || echo zero' },
          ...ctx(),
        })
        assert.equal(r.content.includes('oauth-secret-leak-this-and-die'), false)
      } finally {
        if (original) process.env.CLAUDE_CODE_OAUTH_TOKEN = original
        else delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      }
    })

    it('preserves non-secret env vars like PATH and HOME', async () => {
      const r = await executeBuiltinTool({
        toolName: 'Bash',
        input: { command: 'echo "PATH_LEN=${#PATH} HOME_PRESENT=$([ -n "$HOME" ] && echo yes || echo no)"' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /HOME_PRESENT=yes/)
      assert.match(r.content, /PATH_LEN=\d/)
    })
  })

  describe('WebFetch (#4050)', () => {
    let server
    let baseUrl
    let priorAllowPrivate
    const routes = new Map()

    before(async () => {
      // #4132: WebFetch now blocks private/loopback/link-local hosts by
      // default. The test server runs on 127.0.0.1, so set the opt-in
      // env flag for the WebFetch suite. Individual SSRF-defense tests
      // unset it locally and restore it after.
      priorAllowPrivate = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = '1'

      server = createServer((req, res) => {
        const handler = routes.get(req.url)
        if (!handler) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('not found')
          return
        }
        handler(req, res)
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      baseUrl = `http://127.0.0.1:${port}`
    })

    after(async () => {
      if (priorAllowPrivate === undefined) delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      else process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = priorAllowPrivate
      await new Promise((resolve) => server.close(resolve))
    })

    beforeEach(() => {
      routes.clear()
    })

    it('extracts readable text from an HTML page, dropping <script> and <style>', async () => {
      routes.set('/article', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`
          <html><head>
            <style>.x { color: red }</style>
            <script>alert('xss')</script>
          </head><body>
            <h1>Hello World</h1>
            <p>Some readable text.</p>
            <script>tracking()</script>
          </body></html>
        `)
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/article`, prompt: 'summarize' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /Hello World/)
      assert.match(r.content, /Some readable text/)
      assert.equal(r.content.includes('alert'), false, '<script> bodies must be stripped')
      assert.equal(r.content.includes('color: red'), false, '<style> bodies must be stripped')
    })

    it('returns JSON bodies as plain text without HTML processing', async () => {
      routes.set('/api', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }))
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/api`, prompt: 'parse' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /"ok":true/)
      assert.match(r.content, /"items":\[1,2,3\]/)
    })

    it('returns plaintext bodies as-is', async () => {
      routes.set('/text', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('hello\nworld')
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/text`, prompt: 'read' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /hello\nworld/)
    })

    it('refuses non-http(s) URLs (file://, ftp://, javascript:)', async () => {
      for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)']) {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          input: { url, prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true, `expected error for ${url}`)
        assert.match(r.content, /only http\(s\)/i)
      }
    })

    it('rejects empty / missing url with a clear error', async () => {
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: '', prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /url is required/i)
    })

    it('marks 404 responses as error and surfaces status', async () => {
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/missing`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /404/)
    })

    it('refuses binary content-types (image, octet-stream)', async () => {
      routes.set('/binary', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.end(Buffer.from([0x00, 0x01, 0x02]))
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/binary`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /binary|unsupported content-type/i)
    })

    it('truncates oversize responses with a clear marker', async () => {
      const huge = 'A'.repeat(500_000)
      routes.set('/huge', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(huge)
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/huge`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /\[truncated/)
      assert.ok(r.content.length < huge.length, 'content should be capped below source size')
    })

    it('respects a short timeout', async () => {
      routes.set('/slow', (_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('eventually')
        }, 3000)
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/slow`, prompt: 'x', timeout: 200 },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /timed out|abort/i)
    })

    it('rejects empty / missing prompt with a clear error (review #4131)', async () => {
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/text`, prompt: '' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /prompt is required/i)
    })

    it('short-circuits when external signal is already aborted (review #4131)', async () => {
      let hit = false
      routes.set('/never', (_req, res) => {
        hit = true
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('should not reach')
      })
      const externalAc = new AbortController()
      externalAc.abort(new Error('session destroyed'))
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/never`, prompt: 'x' },
        ...ctx(),
        signal: externalAc.signal,
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /aborted|timed out/i)
      assert.equal(hit, false, 'pre-aborted signal must skip the outbound fetch')
    })

    it('uses distinct markers for raw-cap vs output-cap truncation (review #4131)', async () => {
      // Output cap (100 KB) reached after HTML strip: the raw cap (1 MB) is
      // not hit but the output cap is. We test by passing a payload that's
      // slightly over the output cap and well under the raw cap.
      const overOutput = 'B'.repeat(120_000)
      routes.set('/over-out', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(overOutput)
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/over-out`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /\[truncated at output cap: \d+ chars\]/)
    })

    it('survives malicious HTML numeric entities without throwing (review #4131)', async () => {
      // String.fromCodePoint(9999999999) throws RangeError; safeFromCodePoint
      // must guard so the entire fetch doesn't error out.
      routes.set('/evil-entity', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<p>before&#9999999999;middle&#x110000;after&#xD800;</p>')
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/evil-entity`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false, 'out-of-range numeric entities must not throw')
      assert.match(r.content, /beforemiddleafter/)
    })

    it('strips user:pass@ credentials from URL echoed in result header (#4133)', async () => {
      // Pre-fix the URL was echoed verbatim from parsed.toString(), leaking
      // any embedded credentials into the model's view and (via history)
      // back to the Anthropic API. Strip userinfo before display.
      routes.set('/creds-ok', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('body content')
      })
      const { port } = server.address()
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: {
          url: `http://alice:hunter2@127.0.0.1:${port}/creds-ok`,
          prompt: 'x',
        },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.equal(r.content.includes('alice'), false, 'username must not leak')
      assert.equal(r.content.includes('hunter2'), false, 'password must not leak')
      assert.equal(r.content.includes('alice:hunter2@'), false, 'userinfo must not leak')
      // The sanitized URL is still useful — host + path are preserved.
      assert.match(r.content, new RegExp(`URL: http://127\\.0\\.0\\.1:${port}/creds-ok`))
    })

    it('malformed-url EINVAL does not echo raw input (no creds leak) (#4159)', async () => {
      // A URL like `http://alice:hunter2@` fails new URL() AND contains
      // userinfo — the EINVAL must NOT echo the raw input back to the
      // model (which lands in conversation history). Pre-fix it did.
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: 'http://alice:hunter2@', prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /malformed/i)
      assert.equal(r.content.includes('alice'), false, 'username must not leak')
      assert.equal(r.content.includes('hunter2'), false, 'password must not leak')
    })

    it('also strips credentials from the 4xx/5xx error path (#4133)', async () => {
      const { port } = server.address()
      // /missing is not registered → 404
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: {
          url: `http://alice:hunter2@127.0.0.1:${port}/missing`,
          prompt: 'x',
        },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /404/)
      assert.equal(r.content.includes('alice'), false)
      assert.equal(r.content.includes('hunter2'), false)
    })

    it('marks the URL line when userinfo was stripped on success (#4160)', async () => {
      // Without a marker, the silent strip looks like a vanilla unauthed
      // request — a downstream 401 is mysterious. The marker lets the
      // model explain the situation and suggest fixes.
      routes.set('/creds-marker-ok', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
      })
      const { port } = server.address()
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: {
          url: `http://alice:hunter2@127.0.0.1:${port}/creds-marker-ok`,
          prompt: 'x',
        },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      // #4183: the marker must name `input URL` as the source, not just
      // a bare `[userinfo stripped]` — otherwise a reader could plausibly
      // read it as referring to the URL it sits next to (which after a
      // redirect could be a destination URL that carried no userinfo).
      assert.match(r.content, /\[userinfo stripped from input URL\]/)
      // Credentials still must not leak alongside the marker.
      assert.equal(r.content.includes('alice'), false)
      assert.equal(r.content.includes('hunter2'), false)
    })

    it('marks the URL line when userinfo was stripped on error path (#4160)', async () => {
      const { port } = server.address()
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: {
          url: `http://alice:hunter2@127.0.0.1:${port}/missing`,
          prompt: 'x',
        },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /404/)
      // #4183: explicit source naming — input URL was where the creds came
      // from (no redirect on this 404 path).
      assert.match(r.content, /\[userinfo stripped from input URL\]/)
    })

    it('does NOT mark the URL line when input had no userinfo (#4160)', async () => {
      // Regress-guard: the marker must only appear when userinfo was
      // actually stripped, otherwise it would tag every URL.
      routes.set('/no-creds', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('plain')
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/no-creds`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.equal(r.content.includes('[userinfo stripped'), false,
        'marker must not appear when input had no userinfo')
    })

    it('strips userinfo introduced by a redirect Location header (#4182 Copilot review)', async () => {
      // A Location header can carry `user:pass@` userinfo even when the
      // initial URL had none. Without per-hop stripping, that URL would
      // be passed to fetch(), which refuses credentialed URLs with an
      // error message that echoes the credentialed URL — leaking the
      // creds via the catch-all `WebFetch failed: ${err.message}` path.
      const { port } = server.address()
      routes.set('/r-creds', (_req, res) => {
        res.writeHead(302, { Location: `http://bob:s3cr3t@127.0.0.1:${port}/r-creds-final` })
        res.end()
      })
      routes.set('/r-creds-final', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('landed')
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `http://127.0.0.1:${port}/r-creds`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false, 'redirect with userinfo must not leak via WebFetch failed:')
      assert.match(r.content, /landed/, 'must follow the redirect to the final page')
      // #4183: the marker must NAME the redirect Location as the source —
      // a bare `[userinfo stripped]` would be misleading because the
      // initial URL had no userinfo and the displayed `currentUrl` is the
      // final destination, not the credentialed Location header.
      assert.match(r.content, /\[userinfo stripped from redirect Location\]/,
        'marker must attribute the strip to the redirect Location, not the displayed URL')
      // Per #4183 acceptance criteria: the input-URL phrasing must NOT
      // appear here — only the redirect carried userinfo so claiming the
      // input did would be wrong.
      assert.equal(r.content.includes('[userinfo stripped from input URL'), false,
        'marker must not claim input URL had userinfo when only the redirect did')
      assert.equal(r.content.includes('bob'), false, 'username must not leak')
      assert.equal(r.content.includes('s3cr3t'), false, 'password must not leak')
      assert.equal(r.content.includes('bob:s3cr3t@'), false, 'userinfo must not leak verbatim')
    })

    it('names both sources when input AND redirect each carry userinfo (#4183)', async () => {
      // The cross-product case: input URL carries `alice:hunter2@` AND the
      // 302 Location header carries `bob:s3cr3t@`. Both get stripped; the
      // single combined marker tells the reader where each came from.
      // Without source-naming, the bare marker is doubly ambiguous here.
      const { port } = server.address()
      routes.set('/both-creds', (_req, res) => {
        res.writeHead(302, { Location: `http://bob:s3cr3t@127.0.0.1:${port}/both-creds-final` })
        res.end()
      })
      routes.set('/both-creds-final', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('landed-both')
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: {
          url: `http://alice:hunter2@127.0.0.1:${port}/both-creds`,
          prompt: 'x',
        },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /landed-both/)
      assert.match(r.content,
        /\[userinfo stripped from input URL and redirect Location\]/,
        'combined marker must name both sources')
      // Belt-and-braces: no credential leak from either hop.
      assert.equal(r.content.includes('alice'), false, 'input username must not leak')
      assert.equal(r.content.includes('hunter2'), false, 'input password must not leak')
      assert.equal(r.content.includes('bob'), false, 'redirect username must not leak')
      assert.equal(r.content.includes('s3cr3t'), false, 'redirect password must not leak')
    })

    it('decodes per declared Content-Type charset, not assumed utf-8 (#4134)', async () => {
      // ISO-8859-1: 0xE9 is 'é', 0xF6 is 'ö'. Decoded as utf-8 those
      // bytes are invalid continuations and become replacement
      // characters (mojibake). Pre-fix readBodyCapped used utf-8 always.
      routes.set('/latin1', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=ISO-8859-1' })
        res.end(Buffer.from([0x63, 0x61, 0x66, 0xE9, 0x20, 0x66, 0xF6, 0x6F])) // "café föo"
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/latin1`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /café föo/)
    })

    it('falls back to utf-8 when charset is unrecognised (#4134)', async () => {
      // Use a sequence that is valid utf-8 but would decode differently
      // under Latin-1 — proves the fallback is utf-8, not "whatever the
      // bogus label happens to alias to". The bytes "café" in utf-8
      // are 0x63 0x61 0x66 0xC3 0xA9. As Latin-1 those last two would
      // be "Ã©". Asserting "café" appears means we used utf-8.
      routes.set('/weirdcharset', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=not-a-real-charset' })
        res.end(Buffer.from([0x63, 0x61, 0x66, 0xC3, 0xA9]))
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/weirdcharset`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /café/)
      assert.equal(r.content.includes('Ã©'), false, 'must NOT be Latin-1 decoded')
    })

    it('falls back to utf-8 when Content-Type omits charset (#4134)', async () => {
      // Same payload as the unknown-charset test — bytes that decode
      // distinctly under utf-8 vs Latin-1 — but with no charset
      // declared. The model gets utf-8 (the default), not raw bytes.
      routes.set('/nocharset', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(Buffer.from([0x63, 0x61, 0x66, 0xC3, 0xA9]))
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/nocharset`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /café/)
      assert.equal(r.content.includes('Ã©'), false)
    })

    it('charset parameter boundary anchoring — xcharset=fakeout is not matched (#4162)', async () => {
      // Pre-fix the regex matched `xcharset=` substring → label "fakeout"
      // → TextDecoder rejects it → fallback to utf-8. That's the right
      // outcome by accident; the parameter-boundary anchor makes the
      // regex correct on principle. Pin it with a header that contains
      // a real `charset` parameter AFTER a fake one, so a non-anchored
      // regex would grab the wrong value.
      routes.set('/boundary', (_req, res) => {
        // "xcharset=ISO-8859-1; charset=utf-8" — the real charset is utf-8.
        // utf-8 bytes for "café" must decode as utf-8, not Latin-1.
        res.writeHead(200, { 'Content-Type': 'text/plain; xcharset=ISO-8859-1; charset=utf-8' })
        res.end(Buffer.from([0x63, 0x61, 0x66, 0xC3, 0xA9]))
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/boundary`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /café/)
    })

    it('follows redirects (302 → 200) when scheme + host are allowed (#4132)', async () => {
      routes.set('/r1', (_req, res) => {
        res.writeHead(302, { Location: `${baseUrl}/r2` })
        res.end()
      })
      routes.set('/r2', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('redirected ok')
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/r1`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /redirected ok/)
    })

    it('refuses redirect to file:// scheme without leaking the Location path (#4132 + Copilot review)', async () => {
      routes.set('/r-evil', (_req, res) => {
        res.writeHead(302, { Location: 'file:///etc/passwd' })
        res.end()
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/r-evil`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /redirect.*scheme|only http\(s\)/i)
      // The scheme IS the diagnostic — but Location is attacker-controlled,
      // so the message must NOT echo the path/query verbatim (prompt
      // injection + sensitive-path leak surface).
      assert.match(r.content, /file:/)
      assert.equal(r.content.includes('/etc/passwd'), false,
        'attacker-controlled Location path must not be reflected in error')
    })

    it('refuses redirect to javascript: scheme (#4132)', async () => {
      routes.set('/r-js', (_req, res) => {
        res.writeHead(302, { Location: 'javascript:alert(1)' })
        res.end()
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/r-js`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /redirect.*scheme|only http\(s\)/i)
    })

    it('refuses initial private/loopback host when env opt-out is unset (#4132 SSRF)', async () => {
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          // 169.254.169.254 is the cloud-instance metadata service —
          // the canonical SSRF target. Doesn't need a real server; the
          // pre-fetch check should refuse it.
          input: { url: 'http://169.254.169.254/latest/meta-data/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
        assert.match(r.content, /CHROXY_WEBFETCH_ALLOW_PRIVATE/, 'error must point at the opt-out flag')
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('refuses initial IPv6 loopback [::1] when env opt-out unset (#4166 bracket handling)', async () => {
      // URL.hostname returns IPv6 literals with brackets ('[::1]') and
      // net.isIP() doesn't accept brackets. Pre-fix the probe fell
      // through to dnsLookup which failed, so the refusal still fired
      // (fail-closed) — but the path was broken for public IPv6 too.
      // After the fix, the bracket is stripped and the loopback is
      // recognised as such and refused via the IP branch.
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          input: { url: 'http://[::1]:1/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('refuses IPv4-mapped IPv6 hex form (::ffff:7f00:1) (Copilot review on #4165)', async () => {
      // ::ffff:7f00:1 expands to ::ffff:127.0.0.1 — the SAME loopback
      // address in IPv4-mapped IPv6 hex form. Pre-fix this bypassed
      // the SSRF check because only the dotted-quad tail form was
      // recognised. The mappedV6ToV4 helper now expands the v6 groups
      // and recognises the IPv4-mapped prefix.
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          input: { url: 'http://[::ffff:7f00:1]:1/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('refuses IPv4-mapped IPv6 dotted form (::ffff:127.0.0.1) (#4132)', async () => {
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          input: { url: 'http://[::ffff:127.0.0.1]:1/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('refuses initial loopback (127.0.0.1) when env opt-out unset (#4132 SSRF)', async () => {
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        // Use a port unlikely to bind to anything so even a stale local
        // service can't accidentally answer; the SSRF refusal happens
        // BEFORE any network attempt.
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          input: { url: 'http://127.0.0.1:1/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('refuses initial RFC1918 10.0.0.0/8 host when env opt-out unset (#4167 coverage)', async () => {
      // Pre-#4167 the SSRF tests covered 169.254 + 127.0.0.1 but skipped
      // the two most common LAN ranges. Adding 10.0.0.x and 192.168.x
      // explicitly so a regression in the RFC1918 branches is caught.
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          input: { url: 'http://10.0.0.1/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('refuses initial RFC1918 192.168.0.0/16 host when env opt-out unset (#4167 coverage)', async () => {
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          input: { url: 'http://192.168.1.1/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('refuses CGNAT 100.64.0.0/10 host (RFC 6598, #4167)', async () => {
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          // 100.64.0.1 is at the bottom of the CGNAT range.
          input: { url: 'http://100.64.0.1/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('refuses TEST-NET-1 192.0.2.0/24 host (RFC 5737, #4167)', async () => {
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          input: { url: 'http://192.0.2.1/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('refuses TEST-NET-2 198.51.100.0/24 host (RFC 5737, #4167)', async () => {
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          input: { url: 'http://198.51.100.1/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('refuses TEST-NET-3 203.0.113.0/24 host (RFC 5737, #4167)', async () => {
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          input: { url: 'http://203.0.113.1/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('refuses benchmark range 198.18.0.0/15 host (RFC 2544, #4167)', async () => {
      const prior = process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      delete process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE
      try {
        const r = await executeBuiltinTool({
          toolName: 'WebFetch',
          // 198.19.x is the top half of the /15.
          input: { url: 'http://198.19.0.1/', prompt: 'x' },
          ...ctx(),
        })
        assert.equal(r.isError, true)
        assert.match(r.content, /private|loopback|link-local|SSRF/i)
      } finally {
        if (prior !== undefined) process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE = prior
      }
    })

    it('follows relative Location header (#4167 coverage)', async () => {
      // `new URL(loc, currentUrl)` should resolve `/login` against the
      // base. Pre-fix this was uncovered by tests even though it works.
      routes.set('/r-rel', (_req, res) => {
        res.writeHead(302, { Location: '/login' })
        res.end()
      })
      routes.set('/login', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('relative-redirect-target')
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/r-rel`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /relative-redirect-target/)
    })

    it('refuses 3xx with empty Location header (#4167 coverage)', async () => {
      // A 302 with no Location is malformed; pre-fix code handled it but
      // there was no test pinning the behaviour.
      routes.set('/r-empty', (_req, res) => {
        res.writeHead(302, { Location: '' })
        res.end()
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/r-empty`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /no Location header/)
    })

    it('refuses redirect to a non-http(s) scheme even when host check is bypassed (#4132)', async () => {
      // Confirms the scheme check fires independent of the host check —
      // a file:// redirect target has no host, so the host check is
      // moot but scheme refusal must fire.
      routes.set('/r-ftp', (_req, res) => {
        res.writeHead(302, { Location: 'ftp://example.com/secret' })
        res.end()
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/r-ftp`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /redirect.*scheme|only http\(s\)/i)
    })

    it('refuses excessive redirect chain (#4132)', async () => {
      // Chain redirect 1→2→3→... and assert refusal at the cap.
      for (let i = 1; i <= 20; i++) {
        routes.set(`/chain-${i}`, (_req, res) => {
          res.writeHead(302, { Location: `${baseUrl}/chain-${i + 1}` })
          res.end()
        })
      }
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/chain-1`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, true)
      assert.match(r.content, /redirect.*cap|too many redirects/i)
    })

    it('decodes HTML entities (&amp;, &lt;, &gt;, &quot;, &#39;)', async () => {
      routes.set('/entities', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<p>Tom &amp; Jerry &lt;3 &quot;hi&quot; &#39;ok&#39;</p>')
      })
      const r = await executeBuiltinTool({
        toolName: 'WebFetch',
        input: { url: `${baseUrl}/entities`, prompt: 'x' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /Tom & Jerry <3 "hi" 'ok'/)
    })
  })
})
