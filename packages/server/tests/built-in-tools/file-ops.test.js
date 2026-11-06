import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync, chmodSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgainstFifoWithReader } from '../helpers/fifo-with-reader.js'
import { readFileTool, writeFileTool, editFileTool } from '../../src/built-in-tools/file-ops.js'

describe('file-ops', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-byok-fileops-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('readFileTool', () => {
    it('returns line-numbered content for a small file', async () => {
      const f = join(dir, 'small.txt')
      writeFileSync(f, 'alpha\nbeta\ngamma')
      const r = await readFileTool({ filePath: f })
      assert.equal(r.ok, true)
      assert.match(r.content, /^\s+1→alpha/m)
      assert.match(r.content, /^\s+2→beta/m)
      assert.match(r.content, /^\s+3→gamma/m)
      assert.equal(r.totalLines, 3)
    })

    it('honors offset + limit', async () => {
      const f = join(dir, 'slice.txt')
      writeFileSync(f, ['a', 'b', 'c', 'd', 'e'].join('\n'))
      const r = await readFileTool({ filePath: f, offset: 2, limit: 2 })
      assert.equal(r.ok, true)
      assert.match(r.content, /^\s+2→b/m)
      assert.match(r.content, /^\s+3→c/m)
      assert.equal(r.linesReturned, 2)
      assert.equal(r.truncatedByLimit, true)
    })

    it('returns ENOENT for missing file', async () => {
      const r = await readFileTool({ filePath: join(dir, 'nope.txt') })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ENOENT')
    })

    it('refuses binary content', async () => {
      const f = join(dir, 'binary.bin')
      writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
      const r = await readFileTool({ filePath: f })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'BINARY')
    })

    it('rejects files larger than maxBytes when no limit given', async () => {
      const f = join(dir, 'big.txt')
      writeFileSync(f, 'x'.repeat(200))
      const r = await readFileTool({ filePath: f, maxBytes: 100 })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'TOO_LARGE')
    })
  })

  describe('writeFileTool', () => {
    it('writes new file and reports created=true', async () => {
      const f = join(dir, 'new.txt')
      const r = await writeFileTool({ filePath: f, content: 'hello' })
      assert.equal(r.ok, true)
      assert.equal(r.created, true)
      assert.equal(r.bytesWritten, 5)
    })

    it('truncates existing file and reports created=false', async () => {
      const f = join(dir, 'exists.txt')
      writeFileSync(f, 'old content here')
      const r = await writeFileTool({ filePath: f, content: 'hi' })
      assert.equal(r.ok, true)
      assert.equal(r.created, false)
      assert.equal(r.bytesWritten, 2)
    })

    it('rejects non-string content', async () => {
      const r = await writeFileTool({ filePath: join(dir, 'x'), content: 42 })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'EINVAL')
    })

    it('creates a new file with the requested mode', { skip: process.platform === 'win32' ? 'POSIX modes' : false }, async () => {
      const f = join(dir, 'mode.txt')
      await writeFileTool({ filePath: f, content: 'x', mode: 0o600 })
      assert.equal(statSync(f).mode & 0o777, 0o600)
    })

    it('keeps an existing file\'s mode on overwrite', { skip: process.platform === 'win32' ? 'POSIX modes' : false }, async () => {
      const f = join(dir, 'keep-mode.txt')
      writeFileSync(f, 'old')
      chmodSync(f, 0o640)
      await writeFileTool({ filePath: f, content: 'new', mode: 0o600 })
      assert.equal(statSync(f).mode & 0o777, 0o640)
      assert.equal(readFileSync(f, 'utf8'), 'new')
    })

    it('refuses a directory target as a non-regular file', async () => {
      const d = join(dir, 'adir')
      mkdirSync(d)
      const r = await writeFileTool({ filePath: d, content: 'x' })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ENOTFILE')
    })

    it('replaces content fully when the new content is shorter', async () => {
      const f = join(dir, 'shorter.txt')
      writeFileSync(f, 'a much longer old content')
      const r = await writeFileTool({ filePath: f, content: 'hi' })
      assert.equal(r.ok, true)
      assert.equal(readFileSync(f, 'utf8'), 'hi')
    })

    it('creates missing parent directories', async () => {
      const f = join(dir, 'a', 'b', 'c.txt')
      const r = await writeFileTool({ filePath: f, content: 'deep' })
      assert.equal(r.ok, true)
      assert.equal(readFileSync(f, 'utf8'), 'deep')
    })

    it('refuses a FIFO target with no reader, promptly', { skip: process.platform === 'win32' ? 'no mkfifo on win32' : false }, async () => {
      const fifo = join(dir, 'pipe')
      execFileSync('mkfifo', [fifo])
      const r = await Promise.race([
        writeFileTool({ filePath: fifo, content: 'payload' }),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 3000).unref()),
      ])
      assert.notEqual(r, 'hung', 'writeFileTool hung on a FIFO')
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ENOTFILE')
    })

    it('refuses a FIFO target with a reader attached and writes nothing to it', { skip: process.platform === 'win32' ? 'no mkfifo on win32' : false }, async () => {
      const fifo = join(dir, 'pipe-reader')
      execFileSync('mkfifo', [fifo])
      let r
      const received = await runAgainstFifoWithReader(fifo, async () => {
        r = await writeFileTool({ filePath: fifo, content: 'payload' })
      })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ENOTFILE')
      assert.equal(received, '')
    })

    it('refuses a final-component symlink (ELOOP) and leaves its target alone', async () => {
      const real = join(dir, 'real.txt')
      writeFileSync(real, 'original')
      const link = join(dir, 'link.txt')
      symlinkSync(real, link)
      const r = await writeFileTool({ filePath: link, content: 'changed' })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ELOOP')
      assert.equal(readFileSync(real, 'utf8'), 'original')
    })
  })

  describe('editFileTool', () => {
    it('replaces a unique substring', async () => {
      const f = join(dir, 'edit.txt')
      writeFileSync(f, 'foo bar baz')
      const r = await editFileTool({ filePath: f, oldString: 'bar', newString: 'QUX' })
      assert.equal(r.ok, true)
      assert.equal(r.replacements, 1)
    })

    it('refuses when oldString matches multiple sites without replaceAll', async () => {
      const f = join(dir, 'multi.txt')
      writeFileSync(f, 'aa aa aa')
      const r = await editFileTool({ filePath: f, oldString: 'aa', newString: 'b' })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'NOT_UNIQUE')
      assert.match(r.message, /3 sites/)
    })

    it('replaces all when replaceAll=true', async () => {
      const f = join(dir, 'replall.txt')
      writeFileSync(f, 'aa aa aa')
      const r = await editFileTool({ filePath: f, oldString: 'aa', newString: 'b', replaceAll: true })
      assert.equal(r.ok, true)
      assert.equal(r.replacements, 3)
    })

    it('refuses when oldString not found', async () => {
      const f = join(dir, 'nothing.txt')
      writeFileSync(f, 'hello')
      const r = await editFileTool({ filePath: f, oldString: 'xyz', newString: 'abc' })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'NOT_FOUND')
    })

    it('refuses no-op replacement', async () => {
      const f = join(dir, 'noop.txt')
      writeFileSync(f, 'hi')
      const r = await editFileTool({ filePath: f, oldString: 'x', newString: 'x' })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'NO_CHANGE')
    })

    it('returns ENOENT for missing file', async () => {
      const r = await editFileTool({ filePath: join(dir, 'nope.txt'), oldString: 'a', newString: 'b' })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ENOENT')
    })

    it('refuses a directory target as a non-regular file', async () => {
      const d = join(dir, 'adir')
      mkdirSync(d)
      const r = await editFileTool({ filePath: d, oldString: 'a', newString: 'b' })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ENOTFILE')
    })

    it('writes the replaced content to disk', async () => {
      const f = join(dir, 'disk.txt')
      writeFileSync(f, 'foo bar baz long tail')
      const r = await editFileTool({ filePath: f, oldString: 'foo bar baz long tail', newString: 'x' })
      assert.equal(r.ok, true)
      assert.equal(readFileSync(f, 'utf8'), 'x')
    })

    it('leaves the file untouched when oldString is not found', async () => {
      const f = join(dir, 'untouched.txt')
      writeFileSync(f, 'hello')
      await editFileTool({ filePath: f, oldString: 'zzz', newString: 'abc' })
      assert.equal(readFileSync(f, 'utf8'), 'hello')
    })

    it('refuses a FIFO target with no reader, promptly', { skip: process.platform === 'win32' ? 'no mkfifo on win32' : false }, async () => {
      const fifo = join(dir, 'pipe')
      execFileSync('mkfifo', [fifo])
      const r = await Promise.race([
        editFileTool({ filePath: fifo, oldString: 'a', newString: 'b' }),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 3000).unref()),
      ])
      assert.notEqual(r, 'hung', 'editFileTool hung on a FIFO')
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ENOTFILE')
    })

    it('refuses a FIFO target with a reader attached and writes nothing to it', { skip: process.platform === 'win32' ? 'no mkfifo on win32' : false }, async () => {
      const fifo = join(dir, 'pipe-reader')
      execFileSync('mkfifo', [fifo])
      let r
      const received = await runAgainstFifoWithReader(fifo, async () => {
        r = await editFileTool({ filePath: fifo, oldString: 'a', newString: 'b' })
      })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ENOTFILE')
      assert.equal(received, '')
    })

    it('refuses a final-component symlink (ELOOP) and leaves its target alone', async () => {
      const real = join(dir, 'real.txt')
      writeFileSync(real, 'original')
      const link = join(dir, 'link.txt')
      symlinkSync(real, link)
      const r = await editFileTool({ filePath: link, oldString: 'original', newString: 'changed' })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ELOOP')
      assert.equal(readFileSync(real, 'utf8'), 'original')
    })
  })
})
