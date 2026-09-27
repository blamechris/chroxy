import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createReaderOps } from '../src/ws-file-ops/reader.js'
import { resolveSessionCwd, validatePathWithinCwd } from '../src/ws-file-ops/common.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

/**
 * #8000 — `read_file` on a MISSING target must answer from the same canonical
 * containment check as an existing one.
 *
 * The ENOENT branch used to compare `resolve(sessionCwd, requested)` — built
 * from the cwd AS GIVEN — against `resolveSessionCwd(sessionCwd)`, which is the
 * native realpath. Whenever those two spellings differ, a missing file INSIDE
 * the project was answered "Access denied" instead of "File not found":
 *
 *   - POSIX: a session cwd that runs through a symlink (macOS `/tmp` ->
 *     `/private/tmp`, a symlinked project directory) — reproduced below;
 *   - Windows: an 8.3 short-name cwd (the CI runner's account gets
 *     `C:\WINDOWS\SERVIC~1\NETWOR~1\...` as its tmpdir), which native realpath
 *     expands. That is how this was found (#7285).
 *
 * It failed in the safe direction (still denied, wrong message), but the
 * existence-oracle rule the branch exists for must hold in BOTH directions:
 * a missing path outside the root says "Access denied", a missing path inside
 * it says "File not found".
 */
describe('read_file on a missing target under a non-canonical session cwd (#8000)', { skip: SKIP_NO_SYMLINK }, () => {
  let root
  let realProject
  let linkedCwd
  let outside

  function reader() {
    const sent = []
    const send = (_ws, msg) => sent.push(msg)
    const boundResolve = (cwd) => resolveSessionCwd(cwd, new Map(), 60_000)
    const boundValidate = (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000)
    return { ops: createReaderOps(send, boundResolve, boundValidate), sent }
  }

  async function read(cwd, requested) {
    const { ops, sent } = reader()
    await ops.readFile(null, requested, cwd)
    assert.equal(sent.length, 1, 'exactly one file_content reply')
    return sent[0]
  }

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-8000-')))
    realProject = join(root, 'real-project')
    outside = join(root, 'outside')
    mkdirSync(realProject)
    mkdirSync(outside)
    writeFileSync(join(realProject, 'present.txt'), 'hello\n')
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    // The session is started in `linked-cwd`, a symlink to the real project:
    // the cwd AS GIVEN is not its canonical spelling.
    linkedCwd = join(root, 'linked-cwd')
    symlinkSync(realProject, linkedCwd)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('a missing file INSIDE the project says "File not found", not "Access denied"', async () => {
    const reply = await read(linkedCwd, 'missing.txt')
    assert.equal(reply.error, 'File not found')
    assert.equal(reply.content, null)
  })

  it('a missing file in a missing SUBDIRECTORY inside the project says "File not found"', async () => {
    const reply = await read(linkedCwd, 'no/such/dir/missing.txt')
    assert.equal(reply.error, 'File not found')
  })

  it('CONTRAST: the same missing file under the CANONICAL cwd says "File not found" (the spelling is the only variable)', async () => {
    const reply = await read(realProject, 'missing.txt')
    assert.equal(reply.error, 'File not found')
  })

  it('a missing file OUTSIDE the project still says "Access denied" (no existence oracle)', async () => {
    const reply = await read(linkedCwd, '../outside/missing.txt')
    assert.match(reply.error, /^Access denied/)
  })

  it('a missing file reached through an in-project symlink to OUTSIDE says "Access denied"', async () => {
    symlinkSync(outside, join(realProject, 'escape'))
    const reply = await read(linkedCwd, 'escape/missing.txt')
    assert.match(reply.error, /^Access denied/)
  })

  it('a missing file through an in-project symlink to OUTSIDE says "Access denied" under the CANONICAL cwd too (no oracle through a link)', async () => {
    // With the canonical cwd the old lexical check saw `<cwd>/escape/missing.txt`
    // as INSIDE and answered "File not found", which told the caller whether
    // `outside/missing.txt` exists. The deepest existing ancestor here is the
    // `escape` link itself, whose real path is outside the project.
    symlinkSync(outside, join(realProject, 'escape'))
    const reply = await read(realProject, 'escape/missing.txt')
    assert.match(reply.error, /^Access denied/)
  })

  it('an EXISTING file under the non-canonical cwd is still served', async () => {
    const reply = await read(linkedCwd, 'present.txt')
    assert.equal(reply.error, null)
    assert.equal(reply.content, 'hello\n')
  })
})

describe('read_file ENOENT containment fails closed (#8000)', () => {
  it('a containment check that THROWS answers "Access denied", never "File not found"', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-8000-fc-')))
    try {
      const sent = []
      const send = (_ws, msg) => sent.push(msg)
      const boundResolve = (cwd) => resolveSessionCwd(cwd, new Map(), 60_000)
      // Stands in for an ancestor walk that cannot finish (ELOOP, EACCES,
      // ENAMETOOLONG at the depth ceiling).
      const throwingValidate = async () => {
        throw Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' })
      }
      const ops = createReaderOps(send, boundResolve, throwingValidate)
      await ops.readFile(null, 'missing.txt', root)
      assert.equal(sent.length, 1)
      assert.match(sent[0].error, /^Access denied/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
