import { describe, it, beforeEach, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
