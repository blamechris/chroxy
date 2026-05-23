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
    const routes = new Map()

    before(async () => {
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
