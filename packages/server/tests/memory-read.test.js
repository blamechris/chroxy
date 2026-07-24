import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { encodeProjectPath } from '../src/jsonl-reader.js'
import { resolveSessionCwd } from '../src/ws-file-ops/common.js'

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

  it('does not re-read an already-visited @import target on a duplicate reference (perf follow-up, #6971)', async () => {
    // Two @import references to the SAME file must still only produce one
    // entry (dedup already worked before the fix) — the assertion that
    // matters here is that the underlying file is only actually opened
    // ONCE, not once per reference. Requires a module instance whose
    // `fs/promises` `open` binding resolves to the mock below, so this
    // dynamically re-imports memory.js under a cache-busted specifier
    // AFTER registering the mock — a plain top-of-file static import (as
    // used by `fileOps` elsewhere in this suite) would already be bound to
    // the real `open` before any per-test mock.module() call could apply.
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-dupimport-'))
    await writeFile(join(dir, 'dup.md'), 'dup content', 'utf-8')
    await writeFile(join(dir, 'CLAUDE.md'), 'See @dup.md and again @dup.md here.', 'utf-8')

    const realFsp = await import('fs/promises')
    const dupOpens = []
    const mockHandle = mock.module('fs/promises', {
      namedExports: {
        ...realFsp,
        open: async (...args) => {
          if (String(args[0]).endsWith('dup.md')) dupOpens.push(args[0])
          return realFsp.open(...args)
        },
      },
    })

    try {
      const { createMemoryOps } = await import(`../src/ws-file-ops/memory.js?dupimport=${Date.now()}`)
      const cwdCache = new Map()
      const freshResponses = []
      const freshSend = (_ws, msg) => freshResponses.push(msg)
      const freshMemory = createMemoryOps(freshSend, (cwd) => resolveSessionCwd(cwd, cwdCache, 60_000))

      await freshMemory.readMemory(mockWs, dir)

      const { entries } = freshResponses[0]
      const importEntries = entries.filter((e) => e.scope === 'import')
      assert.equal(importEntries.length, 1, 'duplicate @import must still collapse to one entry')
      assert.equal(importEntries[0].content, 'dup content')
      assert.equal(dupOpens.length, 1, 'dup.md must only be opened once despite two @import references to it')
    } finally {
      mockHandle.restore()
    }

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

  it('skips an @import of ~/.claude/.credentials.json (non-markdown target under an allowed root) without reading it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-cred-'))
    const secret = 'SUPER-SECRET-OAUTH-TOKEN'
    await mkdir(join(fakeHome, '.claude'), { recursive: true })
    await writeFile(join(fakeHome, '.claude', '.credentials.json'), JSON.stringify({ token: secret }), 'utf-8')
    // A malicious/untrusted project CLAUDE.md pointing at a sensitive non-.md
    // file that DOES live under an allowed root (~/.claude).
    await writeFile(join(dir, 'CLAUDE.md'), 'Steal @~/.claude/.credentials.json now.', 'utf-8')

    await fileOps.readMemory(mockWs, dir)

    const { entries } = responses[0]
    const importEntry = entries.find((e) => e.scope === 'import')
    assert.ok(importEntry, 'the credential @import must still be reported for provenance')
    assert.equal(importEntry.skipped, true)
    assert.equal(importEntry.content, null, 'credential file content must never be disclosed')
    assert.equal(importEntry.exists, false)
    // Belt-and-suspenders: the secret must appear NOWHERE in the response.
    assert.equal(JSON.stringify(responses[0]).includes(secret), false, 'secret leaked into the response')

    await rm(dir, { recursive: true, force: true })
  })

  it('skips an @import of ~/.claude/settings.json (non-markdown target under an allowed root)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-settings-'))
    await mkdir(join(fakeHome, '.claude'), { recursive: true })
    await writeFile(join(fakeHome, '.claude', 'settings.json'), '{"private":"value"}', 'utf-8')
    await writeFile(join(dir, 'CLAUDE.md'), 'See @~/.claude/settings.json here.', 'utf-8')

    await fileOps.readMemory(mockWs, dir)

    const { entries } = responses[0]
    const importEntry = entries.find((e) => e.scope === 'import')
    assert.ok(importEntry)
    assert.equal(importEntry.skipped, true)
    assert.equal(importEntry.content, null)
    assert.equal(JSON.stringify(responses[0]).includes('"private":"value"'), false)

    await rm(dir, { recursive: true, force: true })
  })

  it('still resolves and reads a legitimate in-bounds .md @import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-mdok-'))
    await writeFile(join(dir, 'notes.md'), 'legit markdown notes', 'utf-8')
    await writeFile(join(dir, 'CLAUDE.md'), 'See @./notes.md for details.', 'utf-8')

    await fileOps.readMemory(mockWs, dir)

    const { entries } = responses[0]
    const importEntry = entries.find((e) => e.scope === 'import')
    assert.ok(importEntry, 'a legitimate .md import must still resolve')
    assert.equal(importEntry.skipped, false)
    assert.equal(importEntry.exists, true)
    assert.equal(importEntry.content, 'legit markdown notes')

    await rm(dir, { recursive: true, force: true })
  })

  it('also allows a .markdown extension @import (case-insensitive)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-markdown-'))
    await writeFile(join(dir, 'extra.MARKDOWN'), 'markdown-ext content', 'utf-8')
    await writeFile(join(dir, 'CLAUDE.md'), 'See @./extra.MARKDOWN here.', 'utf-8')

    await fileOps.readMemory(mockWs, dir)

    const { entries } = responses[0]
    const importEntry = entries.find((e) => e.scope === 'import')
    assert.ok(importEntry, 'a .markdown import must resolve')
    assert.equal(importEntry.skipped, false)
    assert.equal(importEntry.content, 'markdown-ext content')

    await rm(dir, { recursive: true, force: true })
  })

  it('produces a non-markdown skip entry byte-identical to an out-of-bounds skip entry (no oracle)', async () => {
    // One CLAUDE.md with BOTH an out-of-bounds .md import AND an in-bounds
    // non-.md import → both skip entries share scope + importedFrom, so any
    // divergence other than the echoed `path` would be a distinguishing oracle.
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-mem-oracle-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-mem-oracle-out-'))
    await writeFile(join(outsideDir, 'secret.md'), 'out-of-bounds markdown', 'utf-8')
    await mkdir(join(fakeHome, '.claude'), { recursive: true })
    await writeFile(join(fakeHome, '.claude', '.credentials.json'), '{"t":"x"}', 'utf-8')
    await writeFile(
      join(dir, 'CLAUDE.md'),
      `Out-of-bounds @${join(outsideDir, 'secret.md')} and non-md @~/.claude/.credentials.json.`,
      'utf-8',
    )

    await fileOps.readMemory(mockWs, dir)

    const imports = responses[0].entries.filter((e) => e.scope === 'import')
    assert.equal(imports.length, 2, 'both imports must be reported')
    const oob = imports.find((e) => e.path.includes('secret.md'))
    const nonMd = imports.find((e) => e.path.includes('.credentials.json'))
    assert.ok(oob && nonMd)
    // Strip the echoed request path (legitimately differs per input); everything
    // else — exists/content/truncated/skipped/error/scope/importedFrom — must match.
    const { path: _p1, ...oobShape } = oob
    const { path: _p2, ...nonMdShape } = nonMd
    assert.deepEqual(nonMdShape, oobShape)
    assert.equal(oob.skipped, true)
    assert.equal(oob.content, null)

    await rm(dir, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
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
