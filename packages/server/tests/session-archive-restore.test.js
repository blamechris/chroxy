import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SessionArchive } from '../src/session-archive.js'

/**
 * #8866 — the two archive primitives a restore needs:
 *   - getSaved(): the record's saved entry, as a copy the caller may mutate;
 *   - release(): remove a record WITHOUT a tombstone, because the session is
 *     live again and a later close must be able to archive it afresh.
 */

function saved(id, extra = {}) {
  return {
    id,
    name: `Session ${id}`,
    provider: 'claude-sdk',
    cwd: '/work/project',
    lastActivityAt: 1_000,
    createdAt: 500,
    sdkSessionId: 'conv-1',
    history: [
      { type: 'message', messageType: 'user_input', content: 'hello' },
      { type: 'message', messageType: 'response', content: 'hi there' },
    ],
    ...extra,
  }
}

describe('SessionArchive restore primitives (#8866)', () => {
  let root
  const make = () => {
    root = root || mkdtempSync(join(tmpdir(), 'chroxy-archive-restore-'))
    return new SessionArchive({ dir: join(root, 'archive'), now: () => 1_000_000 })
  }
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = null })
  const recordFiles = () => (existsSync(join(root, 'archive')) ? readdirSync(join(root, 'archive')).filter((f) => f.endsWith('.json.gz')) : [])

  it('getSaved returns the saved entry and the roster row, and a mutation does not reach a later read', async () => {
    const archive = make()
    const meta = archive.archive(saved('a'.repeat(32)))
    const first = await archive.getSaved(meta.archiveId)
    assert.equal(first.ok, true)
    assert.equal(first.saved.sdkSessionId, 'conv-1')
    assert.equal(first.meta.archiveId, meta.archiveId)
    first.saved.history[0]._seq = 99
    first.saved.history.length = 0
    const second = await archive.getSaved(meta.archiveId)
    assert.equal(second.saved.history.length, 2, 'the cached copy was not handed out')
    assert.equal(second.saved.history[0]._seq, undefined)
  })

  it('getSaved refuses an unknown or malformed id', async () => {
    const archive = make()
    archive.archive(saved('a'.repeat(32)))
    for (const id of ['../../etc/passwd', 'f'.repeat(32), '', 42, null]) {
      const r = await archive.getSaved(id)
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ARCHIVED_SESSION_NOT_FOUND')
    }
  })

  it('release removes the record and its file, and leaves NO tombstone: the same session can be archived again', () => {
    const archive = make()
    const snapshot = saved('a'.repeat(32))
    const meta = archive.archive(snapshot)
    assert.equal(recordFiles().length, 1)

    assert.equal(archive.release(meta.archiveId), 'released')
    assert.equal(recordFiles().length, 0)
    assert.deepEqual(archive.list(), [])

    // delete() would have tombstoned this snapshot and made this a 'duplicate'.
    const again = archive.archiveOutcome(snapshot)
    assert.equal(again.status, 'archived')
    assert.equal(archive.list().length, 1)
  })

  it('delete, by contrast, tombstones: the same snapshot dedupes (the contrast release is pinned against)', () => {
    const archive = make()
    const snapshot = saved('a'.repeat(32))
    const meta = archive.archive(snapshot)
    assert.equal(archive.delete(meta.archiveId), 'deleted')
    assert.equal(archive.archiveOutcome(snapshot).status, 'duplicate')
  })

  it('release survives a reload (the index no longer lists it, the file is gone)', () => {
    const archive = make()
    const meta = archive.archive(saved('a'.repeat(32)))
    archive.release(meta.archiveId)
    const reloaded = new SessionArchive({ dir: join(root, 'archive'), now: () => 1_000_000 })
    assert.deepEqual(reloaded.list(), [])
  })

  it('release of an unknown id is not_found and removes nothing', () => {
    const archive = make()
    archive.archive(saved('a'.repeat(32)))
    assert.equal(archive.release('f'.repeat(32)), 'not_found')
    assert.equal(archive.release('../x'), 'not_found')
    assert.equal(recordFiles().length, 1)
  })

  it('the roster row carries an internal locator hint: true for a recorded conversation, false for none or an unwritten one', () => {
    const archive = make()
    archive.archive(saved('a'.repeat(32)))
    archive.archive(saved('b'.repeat(32), { sdkSessionId: null }))
    archive.archive(saved('c'.repeat(32), { conversationPersisted: false }))
    archive.archive(saved('d'.repeat(32), { sdkSessionId: null, nativeResume: { thread: 't' } }))
    const byId = Object.fromEntries(archive.list().map((r) => [r.sessionId, r.locator]))
    assert.deepEqual(byId, { ['a'.repeat(32)]: true, ['b'.repeat(32)]: false, ['c'.repeat(32)]: false, ['d'.repeat(32)]: true })
  })

  it('a row from before the hint existed reads as unknown (null), not as no locator', () => {
    const archive = make()
    const meta = archive.archive(saved('a'.repeat(32)))
    // Simulate an older index row: drop the key, reload.
    const idxPath = join(root, 'archive', 'index.json')
    const index = JSON.parse(readFileSync(idxPath, 'utf8'))
    for (const row of index.entries) delete row.locator
    writeFileSync(idxPath, JSON.stringify(index))
    const reloaded = new SessionArchive({ dir: join(root, 'archive'), now: () => 1_000_000 })
    assert.equal(reloaded.list().find((r) => r.archiveId === meta.archiveId).locator, null)
  })
})
