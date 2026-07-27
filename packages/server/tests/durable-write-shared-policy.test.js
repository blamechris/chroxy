import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { confirmRenameDurable } from '../src/platform.js'

/**
 * #7054 — ONE test for the durability VERDICT, exercised directly against the
 * single implementation that all three writers now delegate to.
 *
 * The recipe was implemented three times (platform.writeFileRestricted,
 * credential-store.writeStoreAtomically, byok-mcp-config.writeClaudeConfigAtomic)
 * and drifted: two of the three THREW on a post-rename directory-fsync failure,
 * reporting a write that had already landed as failed. That drift produced a real
 * bug (#7067) — a session-token revoke reported as failed while the revoked
 * snapshot was on disk, and a trust write that landed but triggered claude's
 * trust dialog anyway.
 *
 * Rename STRATEGY is deliberately NOT unified — the three genuinely differ, and
 * credential-store's snapshot-and-restore retry is strictly more protective than
 * a plain rename. It is the verdict that had to stop drifting.
 */
describe('durable-write shared policy (#7054)', () => {
  const IS_WINDOWS = process.platform === 'win32'

  it('a clean directory fsync reports no caveat', () => {
    const calls = []
    const out = confirmRenameDurable('/tmp/x/file.json', {
      durable: true,
      onWindows: false,
      fsync: (t, o) => { calls.push({ t, ...o }) },
    })
    assert.deepEqual(out, { durabilityUnconfirmed: null })
    assert.deepEqual(calls, [{ t: '/tmp/x', isDir: true }], 'fsyncs the CONTAINING DIRECTORY, not the file')
  })

  it('NEVER throws on a directory-fsync failure — the rename already published the file', () => {
    const boom = Object.assign(new Error('disk exploded'), { code: 'EIO' })
    let out
    assert.doesNotThrow(() => {
      out = confirmRenameDurable('/tmp/x/file.json', {
        durable: true,
        onWindows: false,
        fsync: () => { throw boom },
      })
    }, 'throwing here would report a LANDED write as failed — the #7067 bug, three times over')
    assert.match(out.durabilityUnconfirmed, /EIO|disk exploded/)
  })

  it('does nothing on the non-durable path — opt-in only', () => {
    const calls = []
    const out = confirmRenameDurable('/tmp/x/file.json', {
      durable: false,
      onWindows: false,
      fsync: (t) => calls.push(t),
    })
    assert.deepEqual(out, { durabilityUnconfirmed: null })
    assert.deepEqual(calls, [], 'the default path must add no fsync')
  })

  it('skips the directory fsync on Windows (no such primitive; MOVEFILE_WRITE_THROUGH covers it)', () => {
    const calls = []
    const out = confirmRenameDurable('C:\\x\\file.json', {
      durable: true,
      onWindows: true,
      fsync: (t) => calls.push(t),
    })
    assert.deepEqual(out, { durabilityUnconfirmed: null })
    assert.deepEqual(calls, [])
  })

  it('every writer that renames delegates here — no second copy of the verdict', async () => {
    // A regression guard on the DUPLICATION itself, which is what #7054 is about:
    // a future hand-rolled `fsyncForDurability(dirname(...), { isDir: true })`
    // would reintroduce the drift that produced #7067.
    if (IS_WINDOWS) return
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
    for (const f of ['platform.js', 'credential-store.js', 'byok-mcp-config.js']) {
      const body = readFileSync(join(srcDir, f), 'utf-8')
      const handRolled = body.match(/fsyncForDurability\(\s*dirname\(/g) || []
      assert.deepEqual(
        handRolled, [],
        `${f} must reach the directory fsync through confirmRenameDurable, not a local copy of the verdict`,
      )
    }
  })
})
