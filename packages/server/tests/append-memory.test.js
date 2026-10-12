import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, realpath } from 'fs/promises'
import { openSync, closeSync, constants as fsConstants } from 'fs'
import { execFileSync, spawnSync } from 'child_process'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { createReaderOps } from '../src/ws-file-ops/reader.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

/**
 * `appendMemory` op (#6861, epic #6760) — the `#`-prefix composer quick-append.
 * The TARGET is server-chosen project memory (never a client path),
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

  it('appends through a thin adapter to authored rules, preserving both imports and the project guard', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-memory-authored-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const repo = fileURLToPath(new URL('../../../', import.meta.url))
    await writeFile(join(dir, 'AGENTS.md'), await readFile(join(repo, 'AGENTS.md')))
    await writeFile(join(dir, 'CLAUDE.md'), '@AGENTS.md\n')
    await writeFile(join(dir, 'GEMINI.md'), '@./AGENTS.md\n')
    execFileSync('git', ['init', '--quiet', dir])

    responses.length = 0
    await fileOps.appendMemory(mockWs, 'Shared memory reaches every host.', dir)
    assert.equal(responses[0].error, null)
    assert.equal(responses[0].path, await realpath(join(dir, 'AGENTS.md')))
    assert.equal(responses[0].created, false)
    for (const [name, expected] of [['CLAUDE.md', '@AGENTS.md\n'], ['GEMINI.md', '@./AGENTS.md\n']]) {
      const adapter = await readFile(join(dir, name), 'utf8')
      assert.equal(adapter, expected)
      const imported = await readFile(resolve(dirname(join(dir, name)), adapter.trim().slice(1)), 'utf8')
      assert.ok(imported.endsWith('Shared memory reaches every host.\n'), `${name} must expose the same note`)
    }
    const guard = spawnSync(process.execPath, [join(repo, 'scripts/check-project-rules.mjs'), '--root', dir], {
      encoding: 'utf8', timeout: 10000,
    })
    assert.equal(guard.error, undefined)
    assert.equal(guard.status, 0, guard.stderr)
    assert.ok(guard.stdout.includes('PROJECT_RULES_OK'))

    // Exercise the real memory-stack import reader with an isolated home.
    const fakeHome = join(dir, 'fake-home')
    await mkdir(fakeHome)
    const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CHROXY_CONFIG_DIR: process.env.CHROXY_CONFIG_DIR }
    try {
      process.env.HOME = fakeHome
      process.env.USERPROFILE = fakeHome
      process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
      responses.length = 0
      await fileOps.readMemory(mockWs, dir)
      const imported = responses[0].entries.find(entry => entry.scope === 'import' && entry.path.endsWith('/AGENTS.md'))
      assert.ok(imported?.content.endsWith('Shared memory reaches every host.\n'))
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('recognizes the relative thin adapter but keeps other imports on the legacy file', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-memory-import-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'AGENTS.md'), '# Authored rules\n')
    await writeFile(join(dir, 'CLAUDE.md'), '@./AGENTS.md\n')
    responses.length = 0
    await fileOps.appendMemory(mockWs, 'relative note', dir)
    assert.equal(responses[0].error, null)
    assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), '# Authored rules\nrelative note\n')
    await writeFile(join(dir, 'other.md'), 'keep other import intact\n')
    await writeFile(join(dir, 'CLAUDE.md'), '@other.md\n')
    responses.length = 0
    await fileOps.appendMemory(mockWs, 'legacy note', dir)
    assert.equal(responses[0].error, null)
    assert.equal(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), '@other.md\nlegacy note\n')
    assert.equal(await readFile(join(dir, 'other.md'), 'utf8'), 'keep other import intact\n')
    await writeFile(join(dir, 'CLAUDE.md'), '```\n@AGENTS.md\n```\n')
    responses.length = 0
    await fileOps.appendMemory(mockWs, 'fenced example note', dir)
    assert.equal(responses[0].path, await realpath(join(dir, 'CLAUDE.md')))
  })

  it('refuses a missing authored target without changing the thin adapter', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-memory-missing-authored-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'CLAUDE.md'), '@AGENTS.md\n')
    responses.length = 0
    await fileOps.appendMemory(mockWs, 'note', dir)
    assert.equal(responses[0].error, 'Authored project memory AGENTS.md is missing')
    assert.equal(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
    await assert.rejects(readFile(join(dir, 'AGENTS.md')), { code: 'ENOENT' })
  })

  it('retains a legacy in-bounds CLAUDE.md symlink destination', { skip: SKIP_NO_SYMLINK }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-memory-local-link-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'legacy.md'), '# Legacy rules\n')
    await symlink(join(dir, 'legacy.md'), join(dir, 'CLAUDE.md'))
    responses.length = 0
    await fileOps.appendMemory(mockWs, 'legacy linked note', dir)
    assert.equal(responses[0].error, null)
    assert.equal(await readFile(join(dir, 'legacy.md'), 'utf8'), '# Legacy rules\nlegacy linked note\n')
  })

  it('refuses authored-target symlink escapes and a symlink introduced after validation', { skip: SKIP_NO_SYMLINK }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-memory-authored-link-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-memory-authored-outside-'))
    t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(outsideDir, { recursive: true, force: true })]))
    const outside = join(outsideDir, 'outside.md')
    const authored = join(dir, 'AGENTS.md')
    await writeFile(outside, 'keep outside intact\n')
    await writeFile(join(dir, 'CLAUDE.md'), '@AGENTS.md\n')
    await symlink(outside, authored)
    responses.length = 0
    await fileOps.appendMemory(mockWs, 'note', dir)
    assert.ok(responses[0].error.includes('restricted'))
    await rm(authored)
    await writeFile(authored, '# Local rules\n')
    const racedOps = createReaderOps(mockSend, async () => dir, async () => {
      await rm(authored)
      await symlink(outside, authored)
      return { valid: true }
    })
    responses.length = 0
    await racedOps.appendMemory(mockWs, 'raced note', dir)
    assert.ok(responses[0].error.includes('restricted'))
    assert.equal(await readFile(outside, 'utf8'), 'keep outside intact\n')
    assert.equal(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
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

  it('blocks appending through a CLAUDE.md symlink that escapes the workspace', { skip: SKIP_NO_SYMLINK }, async () => {
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

  // #7938 — CLAUDE.md planted as a FIFO: the O_APPEND open goes through
  // openNoFollow, which now ORs O_NONBLOCK in, so with no reader it fails
  // ENXIO instead of blocking forever waiting for one.
  it('returns an error promptly when CLAUDE.md is a FIFO instead of hanging (#7938)', { skip: process.platform === 'win32' ? 'no mkfifo on win32' : false }, async () => {
    responses.length = 0
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-memory-fifo-'))
    const fifo = join(dir, 'CLAUDE.md')
    execFileSync('mkfifo', [fifo])
    try {
      const outcome = await Promise.race([
        fileOps.appendMemory(mockWs, 'note', dir).then(() => 'returned'),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 3000)),
      ])
      assert.equal(outcome, 'returned', 'appendMemory blocked opening a FIFO with no reader — openNoFollow needs O_NONBLOCK (#7938)')
      assert.equal(responses.length, 1)
      assert.ok(responses[0].error, 'a FIFO CLAUDE.md must produce an error, not a successful append')
      assert.equal(responses[0].created, false)
    } finally {
      // Releases a write-open stranded by a regression (see write-file.test.js).
      try { closeSync(openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)) } catch { /* nothing to release */ }
      await rm(dir, { recursive: true, force: true })
    }
  })
})
