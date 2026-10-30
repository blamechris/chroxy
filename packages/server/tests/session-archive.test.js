import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'

import { SessionArchive } from '../src/session-archive.js'
import { ServerArchivedSessionHistorySchema, ServerArchivedSessionMetaSchema } from '@chroxy/protocol'

/**
 * Provider-neutral session archive: the claims worth pinning.
 *   - a saved session round-trips through archive -> list -> paged read;
 *   - the off switch writes NOTHING, yet retention still deletes old data;
 *   - the same snapshot is never archived twice (dedupe);
 *   - retention (age, count, bytes) actually UNLINKS the record files;
 *   - the index is a cache: lost/corrupt -> rebuilt, orphan files adopted;
 *   - a client-supplied id is never turned into a path before it is vetted;
 *   - archive() can never throw (it runs inside session teardown).
 */

const DAY = 24 * 60 * 60 * 1000
const posix = process.platform !== 'win32'

function saved(id, { lastActivityAt = 1_000, n = 3, name = `Session ${id}`, content } = {}) {
  return {
    id,
    name,
    provider: 'codex',
    cwd: '/work/project',
    model: 'gpt-x',
    lastActivityAt,
    createdAt: 500,
    // A field that must NOT leak into a roster row.
    permissionMode: 'approve',
    history: Array.from({ length: n }, (_, i) => ({
      type: 'message',
      messageType: 'user_input',
      content: content ?? `${id}-entry-${i}`,
      _seq: i + 1,
    })),
  }
}

describe('SessionArchive', () => {
  let root
  let clock

  function make(opts = {}) {
    root = root || mkdtempSync(join(tmpdir(), 'chroxy-archive-'))
    clock = clock || { t: 1_000_000 }
    const dir = opts.dir ?? join(root, 'archive')
    return new SessionArchive({ dir, now: () => clock.t, ...opts })
  }
  const files = (dir) => (existsSync(dir) ? readdirSync(dir) : [])
  const recordFiles = (dir) => files(dir).filter((f) => f.endsWith('.json.gz'))

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
    clock = null
  })

  it('round-trips archive -> list -> paged read, oldest first', () => {
    const archive = make()
    const meta = archive.archive(saved('s1', { n: 120 }), 'closed')

    assert.ok(meta, 'archived')
    assert.match(meta.archiveId, /^[0-9a-f]{32}$/)
    assert.equal(meta.sessionId, 's1')
    assert.equal(meta.reason, 'closed')
    assert.equal(meta.historyLength, 120)
    assert.equal(meta.archivedAt, 1_000_000)
    assert.ok(meta.bytes > 0)
    assert.doesNotThrow(() => ServerArchivedSessionMetaSchema.parse(meta))

    const rows = archive.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].archiveId, meta.archiveId)
    assert.equal('permissionMode' in rows[0], false, 'only typed roster fields are copied from the saved entry')
    assert.equal('history' in rows[0], false)

    const first = archive.getHistoryPage(meta.archiveId)
    assert.equal(first.ok, true)
    assert.equal(first.total, 120)
    assert.equal(first.offset, 0)
    assert.equal(first.entries.length, 50, 'default page is 50')
    assert.equal(first.entries[0].content, 's1-entry-0')
    assert.equal('_seq' in first.entries[0], false, '_seq never leaves the server')
    assert.doesNotThrow(() => ServerArchivedSessionHistorySchema.parse({ type: 'archived_session_history', archiveId: meta.archiveId, ...first }))

    const last = archive.getHistoryPage(meta.archiveId, { offset: 100, limit: 50 })
    assert.equal(last.entries.length, 20)
    assert.equal(last.entries[19].content, 's1-entry-119')
    const past = archive.getHistoryPage(meta.archiveId, { offset: 999 })
    assert.deepEqual(past.entries, [])
    assert.equal(past.ok, true)
  })

  it('lists newest first and survives a reload from disk', () => {
    const archive = make()
    const a = archive.archive(saved('a'), 'closed')
    clock.t += 1000
    const b = archive.archive(saved('b'), 'idle_timeout')
    assert.deepEqual(archive.list().map((r) => r.archiveId), [b.archiveId, a.archiveId])

    const reloaded = make()
    assert.deepEqual(reloaded.list().map((r) => r.archiveId), [b.archiveId, a.archiveId])
    assert.equal(reloaded.list()[0].reason, 'idle_timeout')
    assert.equal(reloaded.getHistoryPage(a.archiveId).entries[0].content, 'a-entry-0')
  })

  it('writes the record 0600 and the directory 0700', { skip: !posix }, () => {
    const archive = make()
    const meta = archive.archive(saved('s1'))
    const dir = join(root, 'archive')
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, `${meta.archiveId}.json.gz`)).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, 'index.json')).mode & 0o777, 0o600)
    assert.deepEqual(files(dir).filter((f) => f.includes('.tmp')), [], 'no temp file left behind')
  })

  it('writes NOTHING when disabled, and creates no directory', () => {
    const archive = make({ enabled: false })
    assert.equal(archive.archive(saved('s1')), null)
    assert.equal(existsSync(join(root, 'archive')), false, 'a disabled archive does not even create its directory')
    assert.deepEqual(archive.list(), [])
    assert.equal(archive.retentionPolicy().enabled, false)
  })

  it('does not archive a session with no history', () => {
    const archive = make()
    assert.equal(archive.archive({ ...saved('s1'), history: [] }), null)
    assert.equal(archive.archive({ ...saved('s1'), history: undefined }), null)
    assert.equal(archive.archive(null), null)
    assert.equal(archive.archive({ ...saved('s1'), id: undefined }), null, 'no session id, nothing to dedupe on')
    assert.deepEqual(files(join(root, 'archive')), [])
  })

  it('dedupes the same sessionId + lastActivityAt + historyLength, but not a changed snapshot', () => {
    const archive = make()
    assert.ok(archive.archive(saved('s1', { lastActivityAt: 10, n: 3 })))
    assert.equal(archive.archive(saved('s1', { lastActivityAt: 10, n: 3 })), null, 'an identical snapshot is a duplicate')
    assert.equal(archive.list().length, 1)
    assert.equal(recordFiles(join(root, 'archive')).length, 1, 'the duplicate wrote no second file')

    assert.ok(archive.archive(saved('s1', { lastActivityAt: 11, n: 3 })), 'later activity is a different snapshot')
    assert.ok(archive.archive(saved('s1', { lastActivityAt: 10, n: 4 })), 'a longer history is a different snapshot')
    assert.ok(archive.archive(saved('s2', { lastActivityAt: 10, n: 3 })), 'another session is different')
    assert.equal(archive.list().length, 4)

    // The dedupe survives a reload (the stale-entry-seen-on-two-boots case).
    assert.equal(make().archive(saved('s1', { lastActivityAt: 10, n: 3 })), null)
  })

  it('bounds the strings it copies into a roster row', () => {
    const archive = make()
    const meta = archive.archive({ ...saved('s1'), name: 'n'.repeat(5000), cwd: 'c'.repeat(9000), model: 7, provider: { x: 1 } })
    assert.equal(meta.name.length, 256)
    assert.equal(meta.cwd.length, 4096)
    assert.equal(meta.model, null, 'a non-string is null, not coerced')
    assert.equal(meta.provider, null)
  })

  describe('retention', () => {
    it('drops records older than maxAgeDays and UNLINKS their files', () => {
      const archive = make({ maxAgeDays: 10 })
      const old = archive.archive(saved('old'))
      const dir = join(root, 'archive')
      clock.t += 5 * DAY
      const mid = archive.archive(saved('mid'))
      assert.equal(recordFiles(dir).length, 2)

      clock.t += 6 * DAY // old is now 11 days old, mid is 6
      const fresh = archive.archive(saved('fresh'))

      assert.deepEqual(archive.list().map((r) => r.sessionId).sort(), ['fresh', 'mid'])
      assert.equal(existsSync(join(dir, `${old.archiveId}.json.gz`)), false, 'the expired file is unlinked, not just hidden')
      assert.deepEqual(recordFiles(dir).sort(), [`${fresh.archiveId}.json.gz`, `${mid.archiveId}.json.gz`].sort())
      assert.equal(archive.getHistoryPage(old.archiveId).ok, false)
    })

    it('drops the OLDEST beyond maxEntries and unlinks them', () => {
      const archive = make({ maxEntries: 2 })
      const dir = join(root, 'archive')
      const a = archive.archive(saved('a'))
      clock.t += 10
      archive.archive(saved('b'))
      clock.t += 10
      archive.archive(saved('c'))

      assert.deepEqual(archive.list().map((r) => r.sessionId), ['c', 'b'])
      assert.equal(existsSync(join(dir, `${a.archiveId}.json.gz`)), false)
      assert.equal(recordFiles(dir).length, 2)
    })

    it('drops the oldest until the total fits maxMegabytes, unlinking them', () => {
      // Incompressible content so each record is ~90 KiB on disk.
      const noise = () => randomBytes(90_000).toString('base64')
      // 0.2 MiB (~209 KB): room for two ~90 KB records, not three.
      const archive = make({ maxMegabytes: 0.2 })
      const dir = join(root, 'archive')
      const a = archive.archive(saved('a', { n: 1, content: noise() }))
      assert.ok(a.bytes > 60_000, `record is large enough for the test to mean something (${a.bytes})`)
      clock.t += 10
      archive.archive(saved('b', { n: 1, content: noise() }))
      clock.t += 10
      archive.archive(saved('c', { n: 1, content: noise() }))

      assert.deepEqual(archive.list().map((r) => r.sessionId), ['c', 'b'])
      assert.equal(existsSync(join(dir, `${a.archiveId}.json.gz`)), false)
      const total = recordFiles(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0)
      assert.ok(total <= 0.2 * 1024 * 1024, `on-disk total ${total} fits the cap`)
    })

    it('still ages old data out when archiving is DISABLED (at load and on archive())', () => {
      const dir = join(root = mkdtempSync(join(tmpdir(), 'chroxy-archive-')), 'archive')
      clock = { t: 1_000_000 }
      const writer = make({ maxAgeDays: 10 })
      const old = writer.archive(saved('old'))
      assert.equal(recordFiles(dir).length, 1)

      clock.t += 11 * DAY
      // A restarted daemon with the archive switched off: loading it must still age the record out.
      const off = make({ enabled: false, maxAgeDays: 10 })
      assert.equal(off.archive(saved('new')), null, 'the off switch stops new writes')
      assert.deepEqual(off.list(), [])
      assert.equal(existsSync(join(dir, `${old.archiveId}.json.gz`)), false, 'the expired record was unlinked despite the off switch')
    })

    it('prune() applies retention without waiting for a new archive()', () => {
      const archive = make({ maxAgeDays: 1 })
      const meta = archive.archive(saved('a'))
      clock.t += 2 * DAY
      archive.prune()
      assert.equal(existsSync(join(root, 'archive', `${meta.archiveId}.json.gz`)), false)
      assert.deepEqual(archive.list(), [])
    })

    it('an entry evicted by the byte cap straight away is not reported as archived', () => {
      const archive = make({ maxMegabytes: 0.000001 })
      assert.equal(archive.archive(saved('a')), null)
      assert.deepEqual(recordFiles(join(root, 'archive')), [])
    })
  })

  describe('the index is a cache of the record files', () => {
    it('rebuilds from the files when index.json is missing', () => {
      const archive = make()
      const a = archive.archive(saved('a'))
      clock.t += 10
      const b = archive.archive(saved('b'))
      rmSync(join(root, 'archive', 'index.json'))

      const reloaded = make()
      const rows = reloaded.list()
      assert.deepEqual(rows.map((r) => r.archiveId), [b.archiveId, a.archiveId])
      assert.equal(rows[0].sessionId, 'b')
      assert.equal(rows[0].historyLength, 3)
      assert.equal(rows[0].archivedAt, b.archivedAt)
      assert.ok(rows[0].bytes > 0)
      assert.ok(existsSync(join(root, 'archive', 'index.json')), 'the rebuilt index is written back')
    })

    it('rebuilds from the files when index.json is corrupt', () => {
      const archive = make()
      const a = archive.archive(saved('a'))
      writeFileSync(join(root, 'archive', 'index.json'), '{not json')

      const reloaded = make()
      assert.deepEqual(reloaded.list().map((r) => r.archiveId), [a.archiveId])
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, 'archive', 'index.json'), 'utf8')))
    })

    it('drops index rows whose file is gone, and adopts a record the index never saw', () => {
      const archive = make()
      const a = archive.archive(saved('a'))
      clock.t += 10
      const b = archive.archive(saved('b'))
      const dir = join(root, 'archive')
      const indexBefore = readFileSync(join(dir, 'index.json'), 'utf8')

      // Lose a's file; and "lose" b's index row (an index write lost to a crash).
      rmSync(join(dir, `${a.archiveId}.json.gz`))
      const lostIndex = JSON.parse(indexBefore)
      lostIndex.entries = lostIndex.entries.filter((e) => e.archiveId !== b.archiveId)
      writeFileSync(join(dir, 'index.json'), JSON.stringify(lostIndex))

      const reloaded = make()
      const rows = reloaded.list()
      assert.deepEqual(rows.map((r) => r.archiveId), [b.archiveId], 'a gone, b adopted')
      assert.equal(reloaded.getHistoryPage(b.archiveId).entries[0].content, 'b-entry-0')
    })

    it('ignores files that are not archive records, and skips an unreadable record', () => {
      const archive = make()
      const a = archive.archive(saved('a'))
      const dir = join(root, 'archive')
      writeFileSync(join(dir, 'notes.txt'), 'hello')
      writeFileSync(join(dir, `${'f'.repeat(32)}.json.gz`), 'not gzip at all')
      writeFileSync(join(dir, `${'e'.repeat(32)}.json.gz`), gzipSync('"a string, not a record"'))
      rmSync(join(dir, 'index.json'))

      const reloaded = make()
      assert.deepEqual(reloaded.list().map((r) => r.archiveId), [a.archiveId])
      assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'hello', 'a foreign file is left alone')
    })
  })

  describe('client-supplied ids', () => {
    it('answers NOT_FOUND for an unknown or malformed id without touching a path built from it', () => {
      const archive = make()
      archive.archive(saved('a'))
      // A sentinel OUTSIDE the archive dir that a traversal id would reach.
      writeFileSync(join(root, 'x.json.gz'), gzipSync(JSON.stringify({ saved: { history: [{ type: 'message', content: 'SECRET' }] } })))

      for (const bad of ['../x', '../x.json.gz', `..${'/'}archive${'/'}${'a'.repeat(32)}`, '', 'g'.repeat(32), 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), undefined, null, 42, {}, ['a'.repeat(32)]]) {
        const r = archive.getHistoryPage(bad)
        assert.equal(r.ok, false, `${JSON.stringify(bad)} is not served`)
        assert.equal(r.code, 'ARCHIVED_SESSION_NOT_FOUND')
        assert.equal(archive.delete(bad), false)
      }
      // A well-formed id that the index does not know is also refused, and a
      // record file dropped in WITHOUT going through load is not served.
      const stranger = 'c'.repeat(32)
      writeFileSync(join(root, 'archive', `${stranger}.json.gz`), gzipSync(JSON.stringify({ saved: { history: [{ type: 'message', content: 'planted' }] } })))
      assert.equal(archive.getHistoryPage(stranger).ok, false, 'not in the (already loaded) index -> not served')
      assert.equal(archive.delete(stranger), false)
      assert.ok(existsSync(join(root, 'archive', `${stranger}.json.gz`)), 'delete of an unknown id unlinked nothing')
      assert.ok(existsSync(join(root, 'x.json.gz')))
    })

    it('answers NOT_FOUND when the record file is missing or unreadable', () => {
      const archive = make()
      const a = archive.archive(saved('a'))
      const b = archive.archive(saved('b'))
      const dir = join(root, 'archive')
      rmSync(join(dir, `${a.archiveId}.json.gz`))
      writeFileSync(join(dir, `${b.archiveId}.json.gz`), 'corrupt')

      assert.equal(archive.getHistoryPage(a.archiveId).code, 'ARCHIVED_SESSION_NOT_FOUND')
      assert.equal(archive.getHistoryPage(b.archiveId).code, 'ARCHIVED_SESSION_NOT_FOUND')
    })
  })

  it('delete() removes the file and the row; deleteAll() removes everything and returns the count', () => {
    const archive = make()
    const dir = join(root, 'archive')
    const a = archive.archive(saved('a'))
    clock.t += 10
    const b = archive.archive(saved('b'))
    clock.t += 10
    archive.archive(saved('c'))
    // Warm the one-entry cache, then delete the cached record: it must not be served from memory.
    assert.equal(archive.getHistoryPage(a.archiveId).ok, true)

    assert.equal(archive.delete(a.archiveId), true)
    assert.equal(existsSync(join(dir, `${a.archiveId}.json.gz`)), false)
    assert.equal(archive.getHistoryPage(a.archiveId).ok, false, 'a deleted record is not served from the cache')
    assert.equal(archive.delete(a.archiveId), false, 'second delete: nothing there')
    assert.equal(archive.list().length, 2)
    assert.deepEqual(make().list().map((r) => r.sessionId), ['c', 'b'], 'the index on disk reflects the delete')

    assert.equal(archive.deleteAll(), 2)
    assert.deepEqual(archive.list(), [])
    assert.deepEqual(recordFiles(dir), [])
    assert.equal(archive.getHistoryPage(b.archiveId).ok, false)
    assert.equal(archive.deleteAll(), 0)
  })

  it('archive() NEVER throws, even when the directory cannot be created', () => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-archive-'))
    const blocker = join(root, 'archive')
    writeFileSync(blocker, 'i am a file, not a directory')
    const archive = new SessionArchive({ dir: blocker })

    let result
    assert.doesNotThrow(() => { result = archive.archive(saved('a')) })
    assert.equal(result, null)
    assert.deepEqual(archive.list(), [])
    assert.equal(archive.getHistoryPage('a'.repeat(32)).ok, false)
    assert.equal(archive.delete('a'.repeat(32)), false)
    assert.equal(archive.deleteAll(), 0)
    assert.doesNotThrow(() => archive.prune())
    assert.equal(readFileSync(blocker, 'utf8'), 'i am a file, not a directory')
  })

  it('archive() does not throw on an unserialisable saved entry', () => {
    const archive = make()
    const cyc = saved('a')
    cyc.history[0].self = cyc.history[0]
    assert.doesNotThrow(() => archive.archive(cyc))
    assert.equal(archive.archive(cyc), null)
    assert.deepEqual(recordFiles(join(root, 'archive')), [])
  })

  it('falls back to the defaults for invalid numbers, and reports the policy', () => {
    const archive = make({ maxEntries: 0, maxAgeDays: Number.NaN, maxMegabytes: -5 })
    assert.deepEqual(archive.retentionPolicy(), { enabled: true, maxEntries: 100, maxAgeDays: 30, maxMegabytes: 256 })
    assert.equal(make({ maxEntries: 2.5 }).retentionPolicy().maxEntries, 100, 'maxEntries must be an integer')
    assert.equal(make({ enabled: 'false' }).retentionPolicy().enabled, true, 'a non-boolean falls back to the default')
    assert.deepEqual(make({ maxEntries: 7, maxAgeDays: 1.5, maxMegabytes: 2 }).retentionPolicy(), { enabled: true, maxEntries: 7, maxAgeDays: 1.5, maxMegabytes: 2 })
  })
})
