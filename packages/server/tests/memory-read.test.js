import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { encodeProjectPath } from '../src/jsonl-reader.js'

/**
 * `readMemory` op (#6864, epic #6760) — server read of the effective merged
 * CLAUDE.md memory stack (global/project/local + @imports) plus the project's
 * auto-generated MEMORY.md descriptor. Every location is SERVER-chosen (no
 * client-supplied path), so these tests exercise: the fixed three-file
 * precedence stack, missing-file reporting, @import resolution (including
 * relative-to-importing-file, code-fence exclusion, and cycle handling), the
 * path-confinement guard against a traversal attempt, the symlink-escape
 * defence, the MEMORY.md descriptor, and the requestId echo.
 *
 * HOME is redirected to a temp dir per test (the sandbox guard in _setup.mjs
 * locks onto the REAL home recorded at process startup, so this is safe —
 * same pattern as claude-tui-session.test.js / byok-credentials.test.js).
 */
describe('memory_read (readMemory) handler', () => {
  let fileOps
  let originalHome
  let fakeHome
  const responses = []
  const mockSend = (_ws, msg) => responses.push(msg)
  const mockWs = {}

  before(() => {
    fileOps = createFileOps(mockSend)
    originalHome = process.env.HOME
  })

  after(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
  })

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'chroxy-memhome-'))
    process.env.HOME = fakeHome
    responses.length = 0
  })

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true })
  })

  it('returns an error and no entries when there is no session cwd', async () => {
    await fileOps.readMemory(mockWs, null)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].type, 'memory_stack_result')
    assert.ok(responses[0].error)
    assert.deepEqual(responses[0].entries, [])
    assert.equal(responses[0].memoryFile, null)
  })

  it('reports exists:false for global/project/local and the MEMORY.md descriptor when nothing is present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-empty-'))

    await fileOps.readMemory(mockWs, dir)

    assert.equal(responses.length, 1)
    const { entries, memoryFile, error } = responses[0]
    assert.equal(error, null)
    assert.equal(entries.length, 3)
    assert.deepEqual(entries.map((e) => e.scope), ['global', 'project', 'local'])
    for (const e of entries) {
      assert.equal(e.exists, false)
      assert.equal(e.content, null)
      assert.equal(e.error, null)
      assert.equal(e.skipped, false)
      assert.equal(e.importedFrom, null)
    }
    assert.equal(memoryFile.exists, false)
    assert.equal(memoryFile.content, null)

    await rm(dir, { recursive: true, force: true })
  })

  it('reads global, project, and local CLAUDE.md in precedence order (global -> project -> local)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-stack-'))
    await mkdir(join(fakeHome, '.claude'), { recursive: true })
    await writeFile(join(fakeHome, '.claude', 'CLAUDE.md'), 'global notes', 'utf-8')
    await writeFile(join(dir, 'CLAUDE.md'), 'project notes', 'utf-8')
    await writeFile(join(dir, 'CLAUDE.local.md'), 'local notes', 'utf-8')

    await fileOps.readMemory(mockWs, dir)

    const { entries } = responses[0]
    // First three entries are the fixed root stack, in order.
    assert.deepEqual(entries.slice(0, 3).map((e) => e.scope), ['global', 'project', 'local'])
    assert.deepEqual(entries.slice(0, 3).map((e) => e.content), ['global notes', 'project notes', 'local notes'])
    for (const e of entries.slice(0, 3)) {
      assert.equal(e.exists, true)
      assert.equal(e.truncated, false)
      assert.equal(e.error, null)
    }

    await rm(dir, { recursive: true, force: true })
  })

  it('resolves an @import relative to the IMPORTING file, not the session cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-import-'))
    await mkdir(join(dir, 'docs'), { recursive: true })
    await writeFile(join(dir, 'docs', 'extra.md'), 'imported content', 'utf-8')
    await writeFile(join(dir, 'CLAUDE.md'), 'See @docs/extra.md for more.', 'utf-8')

    await fileOps.readMemory(mockWs, dir)

    const { entries } = responses[0]
    const projectEntry = entries.find((e) => e.scope === 'project')
    assert.equal(projectEntry.content, 'See @docs/extra.md for more.')

    const importEntry = entries.find((e) => e.scope === 'import')
    assert.ok(importEntry, 'expected an import entry')
    assert.equal(importEntry.content, 'imported content')
    assert.equal(importEntry.exists, true)
    assert.equal(importEntry.skipped, false)
    assert.match(importEntry.path, /docs\/extra\.md$/)
    assert.equal(importEntry.importedFrom, projectEntry.path)

    await rm(dir, { recursive: true, force: true })
  })

  it('does not treat an @-reference inside a fenced code block or inline code span as an import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-codefence-'))
    await writeFile(
      join(dir, 'CLAUDE.md'),
      [
        'Use `@literal-not-an-import` inline.',
        '```',
        '@also-not-an-import',
        '```',
      ].join('\n'),
      'utf-8',
    )

    await fileOps.readMemory(mockWs, dir)

    const { entries } = responses[0]
    const importEntries = entries.filter((e) => e.scope === 'import')
    assert.equal(importEntries.length, 0, 'no import should have been extracted from code spans/blocks')

    await rm(dir, { recursive: true, force: true })
  })

  it('handles a circular @import chain without an infinite loop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-cycle-'))
    await writeFile(join(dir, 'CLAUDE.md'), 'See @b.md', 'utf-8')
    await writeFile(join(dir, 'b.md'), 'Back to @CLAUDE.md', 'utf-8')

    await fileOps.readMemory(mockWs, dir)

    const { entries } = responses[0]
    const importEntries = entries.filter((e) => e.scope === 'import')
    // b.md is pulled in once; CLAUDE.md is already visited (it's a root entry)
    // so the cycle back to it must NOT produce a second entry.
    assert.equal(importEntries.length, 1)
    assert.equal(importEntries[0].content, 'Back to @CLAUDE.md')

    await rm(dir, { recursive: true, force: true })
  })

  it('rejects an @import that traverses outside the allowed roots (path-confinement guard)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-traversal-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-mem-outside-'))
    await writeFile(join(outsideDir, 'secret.md'), 'top secret contents', 'utf-8')
    await writeFile(join(dir, 'CLAUDE.md'), `Reference @${outsideDir}/secret.md here.`, 'utf-8')

    await fileOps.readMemory(mockWs, dir)

    const { entries } = responses[0]
    const importEntry = entries.find((e) => e.scope === 'import')
    assert.ok(importEntry, 'expected the escaping import to still be reported (for provenance)')
    assert.equal(importEntry.skipped, true)
    assert.equal(importEntry.content, null, 'escaping import content must never be disclosed')
    assert.equal(importEntry.exists, false, 'existence of an out-of-bounds path must not be disclosed either')
    assert.match(importEntry.error, /outside|denied|restricted/i)

    await rm(dir, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  })

  it('rejects a relative-.. @import that escapes the session cwd', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'chroxy-mem-parent-'))
    const dir = join(parent, 'project')
    await mkdir(dir)
    await writeFile(join(parent, 'sibling-secret.md'), 'sibling secret', 'utf-8')
    await writeFile(join(dir, 'CLAUDE.md'), 'Reference @../sibling-secret.md here.', 'utf-8')

    await fileOps.readMemory(mockWs, dir)

    const { entries } = responses[0]
    const importEntry = entries.find((e) => e.scope === 'import')
    assert.ok(importEntry)
    assert.equal(importEntry.skipped, true)
    assert.equal(importEntry.content, null)

    await rm(parent, { recursive: true, force: true })
  })

  it('blocks reading through a CLAUDE.md symlink that escapes the workspace', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-mem-symout-'))
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-symescape-'))
    const outsideFile = join(outsideDir, 'target.md')
    await writeFile(outsideFile, 'should not be readable', 'utf-8')
    await symlink(outsideFile, join(dir, 'CLAUDE.md'))

    await fileOps.readMemory(mockWs, dir)

    const { entries } = responses[0]
    const projectEntry = entries.find((e) => e.scope === 'project')
    assert.equal(projectEntry.content, null)
    assert.equal(projectEntry.skipped, true)
    assert.ok(projectEntry.error)

    await rm(outsideDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves the auto-generated MEMORY.md descriptor via the same per-cwd path encoding as transcripts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-automemory-'))
    const dirReal = await realpath(dir)
    const encoded = encodeProjectPath(dirReal)
    const memoryDir = join(fakeHome, '.claude', 'projects', encoded, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'MEMORY.md'), '# Project Memory\nsome learned fact', 'utf-8')

    await fileOps.readMemory(mockWs, dir)

    const { memoryFile } = responses[0]
    assert.equal(memoryFile.exists, true)
    assert.equal(memoryFile.content, '# Project Memory\nsome learned fact')
    assert.match(memoryFile.path, /projects.*memory\/MEMORY\.md$/)

    await rm(dir, { recursive: true, force: true })
  })

  it('echoes the requestId when the request supplied one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-reqid-'))

    await fileOps.readMemory(mockWs, dir, 'req-42')

    assert.equal(responses[0].requestId, 'req-42')

    await rm(dir, { recursive: true, force: true })
  })

  it('omits requestId when the request did not supply one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-noreqid-'))

    await fileOps.readMemory(mockWs, dir)

    assert.equal('requestId' in responses[0], false)

    await rm(dir, { recursive: true, force: true })
  })
})
