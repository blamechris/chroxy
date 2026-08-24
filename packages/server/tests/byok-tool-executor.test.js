import { describe, it, beforeEach, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { glob as fsGlob } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { executeBuiltinTool } from '../src/byok-tool-executor.js'

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
      symlinkSync('/etc', join(dir, 'esc'))
      mkdirSync(join(dir, 'keep'), { recursive: true })
      writeFileSync(join(dir, 'keep/passenger.txt'), 'ok')

      const raw = []
      for await (const f of fsGlob('{esc,keep}/pass*', { cwd: dir })) raw.push(f)
      assert.deepEqual(
        raw.sort(), ['esc/passwd', 'keep/passenger.txt'],
        'precondition: the matcher must really produce BOTH, or this proves nothing',
      )

      const r = await executeBuiltinTool({
        toolName: 'Glob',
        input: { pattern: '{esc,keep}/pass*' },
        ...ctx(),
      })
      assert.equal(r.isError, false)
      assert.match(r.content, /keep\/passenger\.txt/)
      assert.equal(r.content.includes('passwd'), false, 'the escaping match must be withheld')
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
