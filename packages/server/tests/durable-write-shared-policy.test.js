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

  it('the directory-fsync verdict exists in exactly ONE place (drift guard)', async () => {
    // #7054 is about DRIFT, so the guard must survive the ways drift actually
    // arrives. The first version of this test grepped the three writers for
    // `fsyncForDurability(dirname(` — and MISSED a live copy in
    // writeStoreAtomically that called the same thing through a module-local
    // alias (`_durabilityFsync(dirname(target), { isDir: true })`). A guard keyed
    // on one spelling of one function name is theatre.
    //
    // Assert the invariant instead: across ALL server source, `isDir: true` — the
    // thing that makes an fsync a DIRECTORY fsync, whatever function carries it —
    // appears exactly once, inside the shared helper. Any new copy, in any file,
    // through any alias, trips this. Runs on every platform: it reads source text
    // and has no platform-specific behaviour.
    const { readFileSync, readdirSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : (e.name.endsWith('.js') ? [join(d, e.name)] : []))

    const sites = []
    for (const file of walk(srcDir)) {
      const body = readFileSync(file, 'utf-8')
      for (const m of body.matchAll(/isDir:\s*true/g)) {
        sites.push(`${file.slice(srcDir.length + 1)}:${body.slice(0, m.index).split('\n').length}`)
      }
    }
    assert.equal(
      sites.length, 1,
      `the directory-fsync verdict must live in exactly one place; found ${sites.length}: ${sites.join(', ')}`,
    )
    assert.match(sites[0], /^platform\.js:/, 'and that place must be the shared helper in platform.js')
  })
})
