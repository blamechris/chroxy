import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  })
})
