import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileOps } from '../src/ws-file-ops/index.js'

/**
 * `appendMemory` op (#6861, epic #6760) — the `#`-prefix composer quick-append.
 * The TARGET is always the session cwd's project CLAUDE.md (never a client path),
 * so these tests exercise create/append semantics, the null-cwd guard, note-length
 * cap, and the symlink-escape defence carried over from writeFile.
 */
describe('appendMemory handler', () => {
  let tmpDir
  let fileOps
  const responses = []
  const mockSend = (_ws, msg) => responses.push(msg)
  const mockWs = {}

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-memory-'))
    fileOps = createFileOps(mockSend)
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates CLAUDE.md with the note when it does not exist yet', async () => {
    responses.length = 0
    await fileOps.appendMemory(mockWs, 'first note', tmpDir)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].type, 'append_memory_result')
    assert.equal(responses[0].error, null)
    assert.equal(responses[0].created, true)
    assert.match(responses[0].path, /CLAUDE\.md$/)

    const content = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8')
    assert.equal(content, 'first note\n')
  })

  it('appends a second note on its own line to the existing file', async () => {
    responses.length = 0
    await fileOps.appendMemory(mockWs, 'second note', tmpDir)

    assert.equal(responses[0].error, null)
    assert.equal(responses[0].created, false)
    const content = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8')
    assert.equal(content, 'first note\nsecond note\n')
  })

  it('inserts a separating newline when the existing file does not end with one', async () => {
    responses.length = 0
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-memory-nonl-'))
    await writeFile(join(dir, 'CLAUDE.md'), 'no trailing newline', 'utf-8')

    await fileOps.appendMemory(mockWs, 'appended', dir)

    assert.equal(responses[0].error, null)
    const content = await readFile(join(dir, 'CLAUDE.md'), 'utf-8')
    assert.equal(content, 'no trailing newline\nappended\n')
    await rm(dir, { recursive: true, force: true })
  })

  it('collapses a multi-line note into a single line', async () => {
    responses.length = 0
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-memory-ml-'))
    await fileOps.appendMemory(mockWs, 'line one\nline two', dir)

    assert.equal(responses[0].error, null)
    const content = await readFile(join(dir, 'CLAUDE.md'), 'utf-8')
    assert.equal(content, 'line one line two\n')
    await rm(dir, { recursive: true, force: true })
  })

  it('does not lose a line under concurrent appends (O_APPEND atomicity)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-memory-concurrent-'))
    // Seed the file so every append takes the existing-file (append) path.
    await writeFile(join(dir, 'CLAUDE.md'), 'seed\n', 'utf-8')

    const N = 12
    await Promise.all(
      Array.from({ length: N }, (_, i) => fileOps.appendMemory(mockWs, `note-${i}`, dir)),
    )

    const content = await readFile(join(dir, 'CLAUDE.md'), 'utf-8')
    const lines = content.split('\n').filter(Boolean)
    // Every note line must be present exactly once (none clobbered by a race).
    for (let i = 0; i < N; i++) {
      const count = lines.filter((l) => l === `note-${i}`).length
      assert.equal(count, 1, `note-${i} must appear exactly once (got ${count})`)
    }
    assert.equal(lines.length, N + 1, 'seed + all notes present, no lost lines')
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an error when there is no session cwd', async () => {
    responses.length = 0
    await fileOps.appendMemory(mockWs, 'note', null)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].type, 'append_memory_result')
    assert.ok(responses[0].error)
    assert.equal(responses[0].created, false)
  })

  it('rejects an empty / whitespace-only note', async () => {
    responses.length = 0
    await fileOps.appendMemory(mockWs, '   ', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /note/i)
  })

  it('rejects a note over the length cap', async () => {
    responses.length = 0
    await fileOps.appendMemory(mockWs, 'x'.repeat(10_001), tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /long|max|characters/i)
  })

  it('blocks appending through a CLAUDE.md symlink that escapes the workspace', async () => {
    responses.length = 0
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-memory-outside-'))
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-memory-escape-'))
    const outsideFile = join(outsideDir, 'target.md')
    await writeFile(outsideFile, 'original', 'utf-8')
    await symlink(outsideFile, join(dir, 'CLAUDE.md'))

    await fileOps.appendMemory(mockWs, 'pwned', dir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /denied|restricted/i)

    // The escape target must be untouched.
    const targetContent = await readFile(outsideFile, 'utf-8')
    assert.equal(targetContent, 'original')

    await rm(outsideDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  })
})
