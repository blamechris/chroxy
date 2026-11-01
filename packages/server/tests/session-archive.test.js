import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync, mkdirSync, symlinkSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync, gunzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'

import { SessionArchive } from '../src/session-archive.js'
import { writeFileRestricted } from '../src/platform.js'
import { addLogListener, removeLogListener } from '../src/logger.js'
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

  it('round-trips archive -> list -> paged read, oldest first', async () => {
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

    const first = (await archive.getHistoryPage(meta.archiveId))
    assert.equal(first.ok, true)
    assert.equal(first.total, 120)
    assert.equal(first.offset, 0)
    assert.equal(first.entries.length, 50, 'default page is 50')
    assert.equal(first.entries[0].content, 's1-entry-0')
    assert.equal('_seq' in first.entries[0], false, '_seq never leaves the server')
    assert.doesNotThrow(() => ServerArchivedSessionHistorySchema.parse({ type: 'archived_session_history', archiveId: meta.archiveId, ...first }))

    const last = (await archive.getHistoryPage(meta.archiveId, { offset: 100, limit: 50 }))
    assert.equal(last.entries.length, 20)
    assert.equal(last.entries[19].content, 's1-entry-119')
    const past = (await archive.getHistoryPage(meta.archiveId, { offset: 999 }))
    assert.deepEqual(past.entries, [])
    assert.equal(past.ok, true)
  })

  it('lists newest first and survives a reload from disk', async () => {
    const archive = make()
    const a = archive.archive(saved('a'), 'closed')
    clock.t += 1000
    const b = archive.archive(saved('b'), 'idle_timeout')
    assert.deepEqual(archive.list().map((r) => r.archiveId), [b.archiveId, a.archiveId])

    const reloaded = make()
    assert.deepEqual(reloaded.list().map((r) => r.archiveId), [b.archiveId, a.archiveId])
    assert.equal(reloaded.list()[0].reason, 'idle_timeout')
    assert.equal((await reloaded.getHistoryPage(a.archiveId)).entries[0].content, 'a-entry-0')
  })

  it('writes the record 0600 and the directory 0700', { skip: !posix }, async () => {
    const archive = make()
    const meta = archive.archive(saved('s1'))
    const dir = join(root, 'archive')
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, `${meta.archiveId}.json.gz`)).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, 'index.json')).mode & 0o777, 0o600)
    assert.deepEqual(files(dir).filter((f) => f.includes('.tmp')), [], 'no temp file left behind')
  })

  it('writes NOTHING when disabled, and creates no directory', async () => {
    const archive = make({ enabled: false })
    assert.equal(archive.archive(saved('s1')), null)
    assert.equal(existsSync(join(root, 'archive')), false, 'a disabled archive does not even create its directory')
    assert.deepEqual(archive.list(), [])
    assert.equal(archive.retentionPolicy().enabled, false)
  })

  it('does not archive a session with no history', async () => {
    const archive = make()
    assert.equal(archive.archive({ ...saved('s1'), history: [] }), null)
    assert.equal(archive.archive({ ...saved('s1'), history: undefined }), null)
    assert.equal(archive.archive(null), null)
    assert.equal(archive.archive({ ...saved('s1'), id: undefined }), null, 'no session id, nothing to dedupe on')
    assert.deepEqual(files(join(root, 'archive')), [])
  })

  it('dedupes the same sessionId + lastActivityAt + historyLength, but not a changed snapshot', async () => {
    const archive = make()
    assert.ok(archive.archive(saved('s1', { lastActivityAt: 10, n: 3 })))
    assert.equal(archive.archive(saved('s1', { lastActivityAt: 10, n: 3 })), null, 'an identical snapshot is a duplicate')
    assert.equal(archive.list().length, 1)
    assert.equal(recordFiles(join(root, 'archive')).length, 1, 'the duplicate wrote no second file')

    assert.ok(archive.archive(saved('s1', { lastActivityAt: 11, n: 3 })), 'later activity is a different snapshot')
    assert.ok(archive.archive(saved('s3', { lastActivityAt: 10, n: 3 })))
    assert.ok(archive.archive(saved('s3', { lastActivityAt: 10, n: 4 })), 'the SAME activity time with MORE history is a different snapshot')
    assert.equal(archive.archive(saved('s3', { lastActivityAt: 10, n: 2 })), null, '...but with LESS is superseded')
    assert.ok(archive.archive(saved('s2', { lastActivityAt: 10, n: 3 })), 'another session is different')
    assert.equal(archive.list().length, 5)

    // The dedupe survives a reload (the stale-entry-seen-on-two-boots case).
    assert.equal(make().archive(saved('s1', { lastActivityAt: 10, n: 3 })), null)
  })

  it('bounds the strings it copies into a roster row', async () => {
    const archive = make()
    const meta = archive.archive({ ...saved('s1'), name: 'n'.repeat(5000), cwd: 'c'.repeat(9000), model: 7, provider: { x: 1 } })
    assert.equal(meta.name.length, 256)
    assert.equal(meta.cwd.length, 4096)
    assert.equal(meta.model, null, 'a non-string is null, not coerced')
    assert.equal(meta.provider, null)
  })

  describe('retention', () => {
    it('drops records older than maxAgeDays and UNLINKS their files', async () => {
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
      assert.equal((await archive.getHistoryPage(old.archiveId)).ok, false)
    })

    it('drops the OLDEST beyond maxEntries and unlinks them', async () => {
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

    it('drops the oldest until the total fits maxMegabytes, unlinking them', async () => {
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

    it('still ages old data out when archiving is DISABLED (at load and on archive())', async () => {
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

    it('prune() applies retention without waiting for a new archive()', async () => {
      const archive = make({ maxAgeDays: 1 })
      const meta = archive.archive(saved('a'))
      clock.t += 2 * DAY
      archive.prune()
      assert.equal(existsSync(join(root, 'archive', `${meta.archiveId}.json.gz`)), false)
      assert.deepEqual(archive.list(), [])
    })

    it('an entry evicted by the byte cap straight away is not reported as archived', async () => {
      const archive = make({ maxMegabytes: 0.000001 })
      assert.equal(archive.archive(saved('a')), null)
      assert.deepEqual(recordFiles(join(root, 'archive')), [])
    })
  })

  describe('the index is a cache of the record files', () => {
    it('rebuilds from the files when index.json is missing', async () => {
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

    it('rebuilds from the files when index.json is corrupt', async () => {
      const archive = make()
      const a = archive.archive(saved('a'))
      writeFileSync(join(root, 'archive', 'index.json'), '{not json')

      const reloaded = make()
      assert.deepEqual(reloaded.list().map((r) => r.archiveId), [a.archiveId])
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, 'archive', 'index.json'), 'utf8')))
    })

    it('drops index rows whose file is gone, and adopts a record the index never saw', async () => {
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
      assert.equal((await reloaded.getHistoryPage(b.archiveId)).entries[0].content, 'b-entry-0')
    })

    it('ignores files that are not archive records, and skips an unreadable record', async () => {
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
    it('answers NOT_FOUND for an unknown or malformed id without touching a path built from it', async () => {
      const archive = make()
      archive.archive(saved('a'))
      // A sentinel OUTSIDE the archive dir that a traversal id would reach.
      writeFileSync(join(root, 'x.json.gz'), gzipSync(JSON.stringify({ saved: { history: [{ type: 'message', content: 'SECRET' }] } })))

      for (const bad of ['../x', '../x.json.gz', `..${'/'}archive${'/'}${'a'.repeat(32)}`, '', 'g'.repeat(32), 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), undefined, null, 42, {}, ['a'.repeat(32)]]) {
        const r = (await archive.getHistoryPage(bad))
        assert.equal(r.ok, false, `${JSON.stringify(bad)} is not served`)
        assert.equal(r.code, 'ARCHIVED_SESSION_NOT_FOUND')
        assert.equal(archive.delete(bad), 'not_found')
      }
      // A well-formed id that the index does not know is also refused, and a
      // record file dropped in WITHOUT going through load is not served.
      const stranger = 'c'.repeat(32)
      writeFileSync(join(root, 'archive', `${stranger}.json.gz`), gzipSync(JSON.stringify({ saved: { history: [{ type: 'message', content: 'planted' }] } })))
      assert.equal((await archive.getHistoryPage(stranger)).ok, false, 'not in the (already loaded) index -> not served')
      assert.equal(archive.delete(stranger), 'not_found')
      assert.ok(existsSync(join(root, 'archive', `${stranger}.json.gz`)), 'delete of an unknown id unlinked nothing')
      assert.ok(existsSync(join(root, 'x.json.gz')))
    })

    it('answers NOT_FOUND when the record file is missing or unreadable', async () => {
      const archive = make()
      const a = archive.archive(saved('a'))
      const b = archive.archive(saved('b'))
      const dir = join(root, 'archive')
      rmSync(join(dir, `${a.archiveId}.json.gz`))
      writeFileSync(join(dir, `${b.archiveId}.json.gz`), 'corrupt')

      assert.equal((await archive.getHistoryPage(a.archiveId)).code, 'ARCHIVED_SESSION_NOT_FOUND')
      assert.equal((await archive.getHistoryPage(b.archiveId)).code, 'ARCHIVED_SESSION_NOT_FOUND')
    })
  })

  it('delete() removes the file and the row; deleteAll() removes everything and returns the count', async () => {
    const archive = make()
    const dir = join(root, 'archive')
    const a = archive.archive(saved('a'))
    clock.t += 10
    const b = archive.archive(saved('b'))
    clock.t += 10
    archive.archive(saved('c'))
    // Warm the one-entry cache, then delete the cached record: it must not be served from memory.
    assert.equal((await archive.getHistoryPage(a.archiveId)).ok, true)

    assert.equal(archive.delete(a.archiveId), 'deleted')
    assert.equal(existsSync(join(dir, `${a.archiveId}.json.gz`)), false)
    assert.equal((await archive.getHistoryPage(a.archiveId)).ok, false, 'a deleted record is not served from the cache')
    assert.equal(archive.delete(a.archiveId), 'not_found', 'second delete: nothing there')
    assert.equal(archive.list().length, 2)
    assert.deepEqual(make().list().map((r) => r.sessionId), ['c', 'b'], 'the index on disk reflects the delete')

    assert.deepEqual(archive.deleteAll(), { deleted: 2, failed: 0 })
    assert.deepEqual(archive.list(), [])
    assert.deepEqual(recordFiles(dir), [])
    assert.equal((await archive.getHistoryPage(b.archiveId)).ok, false)
    assert.deepEqual(archive.deleteAll(), { deleted: 0, failed: 0 })
  })

  it('archive() NEVER throws, even when the directory cannot be created', async () => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-archive-'))
    const blocker = join(root, 'archive')
    writeFileSync(blocker, 'i am a file, not a directory')
    const archive = new SessionArchive({ dir: blocker })

    let result
    assert.doesNotThrow(() => { result = archive.archive(saved('a')) })
    assert.equal(result, null)
    assert.deepEqual(archive.list(), [])
    assert.equal((await archive.getHistoryPage('a'.repeat(32))).ok, false)
    assert.equal(archive.delete('a'.repeat(32)), 'not_found')
    assert.deepEqual(archive.deleteAll(), { deleted: 0, failed: 0 })
    assert.doesNotThrow(() => archive.prune())
    assert.equal(readFileSync(blocker, 'utf8'), 'i am a file, not a directory')
  })

  it('archive() does not throw on an unserialisable saved entry', async () => {
    const archive = make()
    const cyc = saved('a')
    cyc.history[0].self = cyc.history[0]
    assert.doesNotThrow(() => archive.archive(cyc))
    assert.equal(archive.archive(cyc), null)
    assert.deepEqual(recordFiles(join(root, 'archive')), [])
  })

  it('falls back to the defaults for invalid numbers, and reports the policy', async () => {
    const archive = make({ maxEntries: 0, maxAgeDays: Number.NaN, maxMegabytes: -5 })
    assert.deepEqual(archive.retentionPolicy(), { enabled: true, maxEntries: 100, maxAgeDays: 30, maxMegabytes: 256 })
    assert.equal(make({ maxEntries: 2.5 }).retentionPolicy().maxEntries, 100, 'maxEntries must be an integer')
    assert.equal(make({ enabled: 'false' }).retentionPolicy().enabled, true, 'a non-boolean falls back to the default')
    assert.deepEqual(make({ maxEntries: 7, maxAgeDays: 1.5, maxMegabytes: 2 }).retentionPolicy(), { enabled: true, maxEntries: 7, maxAgeDays: 1.5, maxMegabytes: 2 })
  })

  describe('setRetentionPolicy (#8869)', () => {
    it('lowering maxEntries prunes the excess records NOW and reports the applied policy', () => {
      const archive = make()
      for (const id of ['a', 'b', 'c']) { clock.t += 1000; archive.archive(saved(id, { lastActivityAt: clock.t }), 'closed') }
      assert.equal(archive.list().length, 3)
      const applied = archive.setRetentionPolicy({ enabled: true, maxEntries: 1, maxAgeDays: 30, maxMegabytes: 256 })
      assert.deepEqual(applied, { enabled: true, maxEntries: 1, maxAgeDays: 30, maxMegabytes: 256 })
      assert.equal(recordFiles(join(root, 'archive')).length, 1, 'the excess record files are unlinked immediately')
      assert.deepEqual(archive.list().map((r) => r.sessionId), ['c'], 'the newest survives')
    })

    it('enabled:false stops new writes, and existing records stay', () => {
      const archive = make()
      archive.archive(saved('a'), 'closed')
      archive.setRetentionPolicy({ enabled: false, maxEntries: 100, maxAgeDays: 30, maxMegabytes: 256 })
      assert.equal(archive.archive(saved('b')), null)
      assert.deepEqual(archive.list().map((r) => r.sessionId), ['a'])
      assert.equal(archive.retentionPolicy().enabled, false)
    })

    it('the Settings "off + delete" sequence leaves nothing, even with a write still queued', async () => {
      const archive = make()
      archive.archive(saved('old', { lastActivityAt: 1 }), 'closed')
      assert.equal(archive.enqueue(saved('queued', { lastActivityAt: 2 })).status, 'queued')
      // The handler's order: apply the off switch, then purge.
      archive.setRetentionPolicy({ enabled: false, maxEntries: 100, maxAgeDays: 30, maxMegabytes: 256 })
      assert.deepEqual(archive.deleteAll(), { deleted: 2, failed: 0 })
      await archive.whenIdle()
      assert.deepEqual(archive.list(), [])
      assert.deepEqual(recordFiles(join(root, 'archive')), [])
      assert.equal(archive.enqueue(saved('later', { lastActivityAt: 3 })).status, 'skipped', 'off: nothing new is queued')
      await archive.whenIdle()
      assert.deepEqual(archive.list(), [])
    })

    it('turning it back on resumes archiving, but never past an invalid directory', () => {
      const archive = make({ enabled: false })
      archive.setRetentionPolicy({ enabled: true, maxEntries: 5, maxAgeDays: 30, maxMegabytes: 256 })
      assert.ok(archive.archive(saved('a')))
      const noDir = new SessionArchive({})
      assert.equal(noDir.setRetentionPolicy({ enabled: true, maxEntries: 5, maxAgeDays: 30, maxMegabytes: 256 }).enabled, false)
    })
  })

  describe('outcomes (a caller about to drop the only copy needs to know)', () => {
    it('reports archived / duplicate / skipped / failed', () => {
      const archive = make()
      const first = archive.archiveOutcome(saved('a'), 'closed')
      assert.equal(first.status, 'archived')
      assert.equal(first.meta.sessionId, 'a')
      assert.equal(archive.archiveOutcome(saved('a'), 'closed').status, 'duplicate')
      assert.equal(archive.archiveOutcome({ ...saved('b'), history: [] }).status, 'skipped', 'empty history: nothing to keep')
      assert.equal(archive.archiveOutcome(null).status, 'skipped')
      assert.equal(make({ enabled: false }).archiveOutcome(saved('c')).status, 'skipped', 'the off switch is skipped, not failed')
    })

    it('reports skipped when the user\'s own retention evicts the record on write', () => {
      const archive = make({ maxMegabytes: 0.000001 })
      assert.equal(archive.archiveOutcome(saved('a')).status, 'skipped')
    })

    it('reports FAILED when the archive path is a file (an unwritable archive), and writes nothing', () => {
      root = mkdtempSync(join(tmpdir(), 'chroxy-archive-'))
      const blocker = join(root, 'archive')
      writeFileSync(blocker, 'a file where the directory should be')
      const archive = new SessionArchive({ dir: blocker })
      assert.equal(archive.archiveOutcome(saved('a')).status, 'failed')
      assert.equal(archive.archive(saved('a')), null, 'archive() keeps its meta-or-null contract')
      assert.equal(archive.enqueue(saved('a')).status, 'queued', 'queueing succeeds; the write failure is logged by the queue')
    })

    it('reports FAILED (not skipped) for a snapshot that cannot be serialised', () => {
      const archive = make()
      const cyc = saved('a')
      cyc.history[0].self = cyc.history[0]
      assert.equal(archive.archiveOutcome(cyc).status, 'failed')
      assert.equal(archive.enqueue(cyc).status, 'failed')
    })

    it('reports FAILED when the file write itself fails (injected), and leaves no temp behind', () => {
      let calls = 0
      const archive = make({
        writeFile: (path, data, opts) => {
          calls++
          writeFileSync(`${path}${opts.tmpSuffix}`, 'partial')
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        },
      })
      assert.equal(archive.archiveOutcome(saved('a')).status, 'failed')
      assert.equal(calls, 1)
      assert.deepEqual(files(join(root, 'archive')), [], 'the failed write\'s temp file was removed')
    })
  })

  describe('tombstones: a deleted or aged-out record is not resurrected by a source that outlives it', () => {
    it('delete() leaves a tombstone, so the same snapshot is a duplicate afterwards', () => {
      const archive = make()
      const a = archive.archive(saved('a', { lastActivityAt: 10, n: 3 }))
      assert.equal(archive.delete(a.archiveId), 'deleted')

      assert.equal(archive.archiveOutcome(saved('a', { lastActivityAt: 10, n: 3 })).status, 'duplicate')
      assert.deepEqual(archive.list(), [])
      assert.equal(archive.archiveOutcome(saved('a', { lastActivityAt: 11, n: 3 })).status, 'archived', 'a DIFFERENT snapshot is still archived')
    })

    it('deleteAll() leaves a tombstone per record', () => {
      const archive = make()
      archive.archive(saved('a', { lastActivityAt: 1 }))
      archive.archive(saved('b', { lastActivityAt: 2 }))
      assert.deepEqual(archive.deleteAll(), { deleted: 2, failed: 0 })
      assert.equal(archive.archiveOutcome(saved('a', { lastActivityAt: 1 })).status, 'duplicate')
      assert.equal(archive.archiveOutcome(saved('b', { lastActivityAt: 2 })).status, 'duplicate')
    })

    it('retention eviction (age and count) leaves tombstones', () => {
      const archive = make({ maxEntries: 1, maxAgeDays: 10 })
      archive.archive(saved('a', { lastActivityAt: 1 }))
      clock.t += 10
      archive.archive(saved('b', { lastActivityAt: 2 })) // evicts a by count
      assert.equal(archive.archiveOutcome(saved('a', { lastActivityAt: 1 })).status, 'duplicate', 'count-evicted')
      clock.t += 11 * DAY // b ages out
      assert.deepEqual(archive.list(), [])
      assert.equal(archive.archiveOutcome(saved('b', { lastActivityAt: 2 })).status, 'duplicate', 'age-evicted')
    })

    it('tombstones survive a reload, and a rebuilt-from-files index starts with none', () => {
      const archive = make()
      const a = archive.archive(saved('a', { lastActivityAt: 1 }))
      archive.delete(a.archiveId)
      assert.equal(make().archiveOutcome(saved('a', { lastActivityAt: 1 })).status, 'duplicate')
    })

    it('are FIFO-capped at 1000 and re-validated on load', () => {
      const archive = make()
      const keep = archive.archive(saved('keep'))
      const dir = join(root, 'archive')
      const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
      index.tombstones = [
        ...Array.from({ length: 1200 }, (_, i) => ({ sessionId: `old-${i}`, lastActivityAt: i, historyLength: 1, at: i })),
        { sessionId: '', lastActivityAt: 1, historyLength: 1, at: 1 },
        { sessionId: 'bad-length', lastActivityAt: 1, historyLength: -4, at: 1 },
        'not an object',
      ]
      writeFileSync(join(dir, 'index.json'), JSON.stringify(index))

      const reloaded = make()
      assert.equal(reloaded.list().length, 1)
      assert.equal(reloaded.archiveOutcome(saved('old-1199', { lastActivityAt: 1199, n: 1 })).status, 'duplicate', 'newest tombstones kept')
      assert.equal(reloaded.archiveOutcome(saved('old-0', { lastActivityAt: 0, n: 1 })).status, 'archived', 'oldest tombstones fell off the FIFO')
      reloaded.delete(keep.archiveId) // forces an index write
      const written = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).tombstones
      assert.ok(written.length <= 1000, `persisted tombstones are capped (${written.length})`)
      assert.ok(written.every((t) => typeof t.sessionId === 'string' && t.sessionId !== '' && t.historyLength >= 0), 'invalid tombstones were dropped')
    })
  })

  describe('record size bound (the writer never writes what the reader refuses)', () => {
    const big = (id, n, size) => ({ ...saved(id, { n: 0 }), history: Array.from({ length: n }, (_, i) => ({ type: 'message', content: `${i}:`.padEnd(size, 'x') })) })

    it('omits the OLDEST entries to fit, records how many, and the record stays readable', async () => {
      const cap = 5000
      const archive = make({ maxRecordBytes: cap })
      const outcome = archive.archiveOutcome(big('s', 10, 1000), 'closed')

      assert.equal(outcome.status, 'archived')
      const { meta } = outcome
      assert.ok(meta.omittedOldest > 0 && meta.omittedOldest < 10, `omitted ${meta.omittedOldest}`)
      assert.equal(meta.historyLength, 10 - meta.omittedOldest, 'historyLength is the kept count')
      const raw = gunzipSync(readFileSync(join(root, 'archive', `${meta.archiveId}.json.gz`)))
      assert.ok(raw.length <= cap, `the record's JSON (${raw.length}) fits the bound (${cap})`)
      assert.equal(JSON.parse(raw.toString()).omittedOldest, meta.omittedOldest, 'stored in the record too')

      const page = await archive.getHistoryPage(meta.archiveId)
      assert.equal(page.ok, true, 'a written record is always readable')
      assert.equal(page.total, meta.historyLength)
      assert.ok(page.entries[0].content.startsWith(`${meta.omittedOldest}:`), 'the kept entries are the NEWEST ones')
      assert.ok(page.entries.at(-1).content.startsWith('9:'))
    })

    it('counts the record\'s own framing: a cap one byte under the full record omits exactly the oldest entry', () => {
      const full = make({ maxRecordBytes: 10_000_000 })
      const { meta: fm } = full.archiveOutcome(big('s', 5, 1000))
      const fullLen = gunzipSync(readFileSync(join(root, 'archive', `${fm.archiveId}.json.gz`))).length
      rmSync(root, { recursive: true, force: true })
      root = null
      const archive = make({ maxRecordBytes: fullLen - 1 })
      const { meta } = archive.archiveOutcome(big('s', 5, 1000))
      assert.equal(meta.omittedOldest, 1)
      const len = gunzipSync(readFileSync(join(root, 'archive', `${meta.archiveId}.json.gz`))).length
      assert.ok(len <= fullLen - 1, `${len} <= ${fullLen - 1}`)
    })

    it('keeps everything and reports omittedOldest 0 when it fits', () => {
      const archive = make({ maxRecordBytes: 100_000 })
      const { meta } = archive.archiveOutcome(big('s', 5, 100))
      assert.equal(meta.omittedOldest, 0)
      assert.equal(meta.historyLength, 5)
    })

    it('still dedupes on the SOURCE length after trimming, and adopts omittedOldest when the index is rebuilt', () => {
      const archive = make({ maxRecordBytes: 5000 })
      const first = archive.archiveOutcome(big('s', 10, 1000))
      assert.equal(first.status, 'archived')
      assert.equal(archive.archiveOutcome(big('s', 10, 1000)).status, 'duplicate')
      rmSync(join(root, 'archive', 'index.json'))
      const rebuilt = make({ maxRecordBytes: 5000 }).list()
      assert.equal(rebuilt[0].omittedOldest, first.meta.omittedOldest)
      assert.equal(rebuilt[0].historyLength, first.meta.historyLength)
    })

    it('fails (and writes nothing) when not even the newest entry fits', () => {
      const archive = make({ maxRecordBytes: 500 })
      assert.equal(archive.archiveOutcome(big('s', 3, 2000)).status, 'failed')
      assert.deepEqual(recordFiles(join(root, 'archive')), [])
    })

    it('the reader enforces the same bound: a record inflating past it is not served', async () => {
      const writer = make({ maxRecordBytes: 100_000 })
      const { meta } = writer.archiveOutcome(big('s', 5, 5000))
      const strictReader = make({ maxRecordBytes: 2000 })
      assert.equal((await strictReader.getHistoryPage(meta.archiveId)).ok, false)
    })
  })

  describe('retention while the daemon sits idle (no prune(), no archive())', () => {
    it('list() never serves an expired record and unlinks its file', () => {
      const archive = make({ maxAgeDays: 1 })
      const a = archive.archive(saved('a'))
      clock.t += 2 * DAY
      assert.deepEqual(archive.list(), [])
      assert.equal(existsSync(join(root, 'archive', `${a.archiveId}.json.gz`)), false)
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'archive', 'index.json'), 'utf8')).entries, [], 'and the index was persisted')
    })

    it('getHistoryPage() never serves an expired record (even one already in the cache)', async () => {
      const archive = make({ maxAgeDays: 1 })
      const a = archive.archive(saved('a'))
      assert.equal((await archive.getHistoryPage(a.archiveId)).ok, true, 'fresh: served (and cached)')
      clock.t += 2 * DAY
      assert.equal((await archive.getHistoryPage(a.archiveId)).ok, false)
      assert.equal(existsSync(join(root, 'archive', `${a.archiveId}.json.gz`)), false)
    })

    it('delete() of an expired record finds nothing to delete', () => {
      const archive = make({ maxAgeDays: 1 })
      const a = archive.archive(saved('a'))
      clock.t += 2 * DAY
      assert.equal(archive.delete(a.archiveId), 'not_found')
      assert.deepEqual(archive.deleteAll(), { deleted: 0, failed: 0 })
    })
  })

  describe('delete failures are reported, not swallowed (POSIX, not root)', { skip: !posix || process.getuid?.() === 0 }, () => {
    it('delete() returns failed, keeps the row and the file, and leaves no tombstone', async () => {
      const archive = make()
      const a = archive.archive(saved('a', { lastActivityAt: 5 }))
      const dir = join(root, 'archive')
      chmodSync(dir, 0o500) // no unlink
      try {
        assert.equal(archive.delete(a.archiveId), 'failed')
        assert.equal(archive.list().length, 1, 'the row is still listed')
        assert.ok(existsSync(join(dir, `${a.archiveId}.json.gz`)), 'the file is still there')
        assert.equal((await archive.getHistoryPage(a.archiveId)).ok, true, 'and still readable')
      } finally {
        chmodSync(dir, 0o700)
      }
      assert.equal(archive.archiveOutcome(saved('a', { lastActivityAt: 5 })).status, 'duplicate', 'still indexed, so still a duplicate')
      assert.equal(archive.delete(a.archiveId), 'deleted', 'and deletable once the directory is writable again')
    })

    it('deleteAll() counts the records it could not remove', () => {
      const archive = make()
      archive.archive(saved('a', { lastActivityAt: 1 }))
      archive.archive(saved('b', { lastActivityAt: 2 }))
      const dir = join(root, 'archive')
      chmodSync(dir, 0o500)
      try {
        assert.deepEqual(archive.deleteAll(), { deleted: 0, failed: 2 })
        assert.equal(archive.list().length, 2)
      } finally {
        chmodSync(dir, 0o700)
      }
      assert.deepEqual(archive.deleteAll(), { deleted: 2, failed: 0 })
    })
  })

  describe('off-event-loop queue', () => {
    it('enqueue() writes nothing synchronously, then whenIdle() has the record in the index (gzip level 1)', async () => {
      const archive = make()
      assert.deepEqual(archive.enqueue(saved('a', { n: 50 })), { status: 'queued' })
      assert.equal(existsSync(join(root, 'archive')), false, 'nothing is compressed or written on the calling tick')
      assert.deepEqual(archive.list(), [])

      await archive.whenIdle()
      const rows = archive.list()
      assert.equal(rows.length, 1)
      const file = readFileSync(join(root, 'archive', `${rows[0].archiveId}.json.gz`))
      assert.equal(file[8], 4, 'gzip header says fastest compression (level 1)')
      assert.equal((await archive.getHistoryPage(rows[0].archiveId)).total, 50)
      assert.deepEqual(files(join(root, 'archive')).sort(), [`${rows[0].archiveId}.json.gz`, 'index.json'].sort())
    })

    it('the synchronous path also uses level 1', () => {
      const archive = make()
      const { meta } = archive.archiveOutcome(saved('a'))
      assert.equal(readFileSync(join(root, 'archive', `${meta.archiveId}.json.gz`))[8], 4)
    })

    it('dedupes against queued snapshots, in both directions', async () => {
      const archive = make()
      assert.equal(archive.enqueue(saved('a')).status, 'queued')
      assert.equal(archive.enqueue(saved('a')).status, 'duplicate')
      assert.equal(archive.archiveOutcome(saved('a')).status, 'duplicate', 'the sync path sees the queued one')
      await archive.whenIdle()
      assert.equal(archive.list().length, 1)
    })

    it('serialises writes: many queued snapshots all land, the index lists each once', async () => {
      const archive = make()
      for (let i = 0; i < 8; i++) archive.enqueue(saved(`s${i}`, { lastActivityAt: i }))
      await archive.whenIdle()
      assert.equal(archive.list().length, 8)
      assert.equal(recordFiles(join(root, 'archive')).length, 8)
      assert.equal(JSON.parse(readFileSync(join(root, 'archive', 'index.json'), 'utf8')).entries.length, 8)
    })

    it('drainSync() finishes the queue synchronously and the queue does not write it twice', async () => {
      const archive = make()
      archive.enqueue(saved('a'))
      archive.enqueue(saved('b', { lastActivityAt: 2 }))
      archive.drainSync()
      assert.equal(recordFiles(join(root, 'archive')).length, 2, 'both records exist the moment drainSync() returns')
      assert.deepEqual(archive.list().map((r) => r.sessionId).sort(), ['a', 'b'])
      await archive.whenIdle()
      assert.equal(archive.list().length, 2, 'the in-flight compression found its job already done')
      assert.equal(recordFiles(join(root, 'archive')).length, 2)
    })

    it('a failed queued write is logged, never thrown, and later jobs still run', async () => {
      root = mkdtempSync(join(tmpdir(), 'chroxy-archive-'))
      const blocker = join(root, 'archive')
      writeFileSync(blocker, 'file')
      const archive = new SessionArchive({ dir: blocker })
      archive.enqueue(saved('a'))
      await assert.doesNotReject(() => archive.whenIdle())
      assert.deepEqual(archive.list(), [])
      assert.doesNotThrow(() => archive.drainSync())
    })
  })

  // -- round 3 -----------------------------------------------------------------

  const rootOnly = process.getuid?.() === 0

  describe('B: a SUPERSEDED snapshot is a duplicate (a backup at an older point of the same session)', () => {
    it('archive S@10/3 -> delete -> offer S@9/2 is a duplicate; S@11 is archived', () => {
      const archive = make()
      const a = archive.archive(saved('S', { lastActivityAt: 10, n: 3 }))
      assert.equal(archive.delete(a.archiveId), 'deleted')
      assert.equal(archive.archiveOutcome(saved('S', { lastActivityAt: 9, n: 2 })).status, 'duplicate', 'older and shorter')
      assert.equal(archive.archiveOutcome(saved('S', { lastActivityAt: 9, n: 7 })).status, 'duplicate', 'an OLDER timestamp is superseded even with more history')
      assert.equal(archive.archiveOutcome(saved('S', { lastActivityAt: 11, n: 3 })).status, 'archived', 'control: a newer snapshot is new')
    })

    it('also against a live row and a queued job', async () => {
      const archive = make()
      archive.archive(saved('S', { lastActivityAt: 10, n: 3 }))
      assert.equal(archive.archiveOutcome(saved('S', { lastActivityAt: 5, n: 1 })).status, 'duplicate', 'row')
      archive.enqueue(saved('Q', { lastActivityAt: 20, n: 3 }))
      assert.equal(archive.archiveOutcome(saved('Q', { lastActivityAt: 19, n: 2 })).status, 'duplicate', 'queued')
      await archive.whenIdle()
    })

    it('when a timestamp is unknown only an exact (timestamp, length) match counts', () => {
      const archive = make()
      assert.equal(archive.archiveOutcome({ ...saved('N', { n: 3 }), lastActivityAt: undefined }).status, 'archived')
      assert.equal(archive.archiveOutcome({ ...saved('N', { n: 3 }), lastActivityAt: undefined }).status, 'duplicate', 'exact')
      assert.equal(archive.archiveOutcome({ ...saved('N', { n: 2 }), lastActivityAt: undefined }).status, 'archived', 'a different length is not covered')
      assert.equal(archive.archiveOutcome(saved('N', { lastActivityAt: 1, n: 3 })).status, 'archived', 'null vs a number is not covered either way')
    })
  })

  describe('C: removals are durable (tombstone written FIRST, record unlinked after)', () => {
    /** A writeFile seam that can be told to fail index writes, and records what existed when each index write ran. */
    function seam() {
      const state = { failIndex: false, indexWrites: [] }
      state.writeFile = (path, data, opts) => {
        if (path.endsWith('index.json')) {
          const dir = join(path, '..')
          state.indexWrites.push({ files: readdirSync(dir).filter((f) => f.endsWith('.json.gz')).length, tombstones: JSON.parse(data).tombstones.length })
          if (state.failIndex) throw new Error('EIO: injected index write failure')
        }
        return writeFileRestricted(path, data, opts)
      }
      return state
    }

    it('delete() writes the index WITH the tombstone while the record file still exists', () => {
      const st = seam()
      const archive = make({ writeFile: st.writeFile })
      const a = archive.archive(saved('a', { lastActivityAt: 1 }))
      st.indexWrites.length = 0
      assert.equal(archive.delete(a.archiveId), 'deleted')
      assert.deepEqual(st.indexWrites[0], { files: 1, tombstones: 1 }, 'tombstoned index written while the file was still on disk')
      assert.equal(recordFiles(join(root, 'archive')).length, 0, 'unlinked afterwards')
    })

    it('an index-write failure makes delete() FAIL, keeps the record, and the snapshot is still a duplicate on a new instance', () => {
      const st = seam()
      const archive = make({ writeFile: st.writeFile })
      const a = archive.archive(saved('a', { lastActivityAt: 1 }))
      st.failIndex = true
      assert.equal(archive.delete(a.archiveId), 'failed')
      assert.equal(archive.list().length, 1, 'still listed')
      assert.equal(recordFiles(join(root, 'archive')).length, 1, 'file kept')
      assert.deepEqual(archive.deleteAll(), { deleted: 0, failed: 1 })
      assert.equal(make().archiveOutcome(saved('a', { lastActivityAt: 1 })).status, 'duplicate', 'a fresh instance still knows it')
    })

    it('crash between the tombstoned index and the unlink: the orphan record is unlinked on load, not adopted', () => {
      const archive = make()
      const a = archive.archive(saved('a', { lastActivityAt: 1 }))
      const dir = join(root, 'archive')
      const copy = join(root, 'copy.json.gz')
      copyFileSync(join(dir, `${a.archiveId}.json.gz`), copy)
      assert.equal(archive.delete(a.archiveId), 'deleted')
      copyFileSync(copy, join(dir, `${a.archiveId}.json.gz`)) // the unlink "never ran"

      const reloaded = make()
      assert.deepEqual(reloaded.list(), [])
      assert.equal(existsSync(join(dir, `${a.archiveId}.json.gz`)), false, 'unlinked by the load')
    })

    it('retention keeps the row (for the next pass) when its index write fails', () => {
      const st = seam()
      const archive = make({ writeFile: st.writeFile, maxEntries: 1 })
      archive.archive(saved('a', { lastActivityAt: 1 }))
      clock.t += 10
      st.failIndex = true
      archive.archive(saved('b', { lastActivityAt: 2 })) // would evict a
      assert.equal(archive.list().length, 2, 'a was NOT evicted: its tombstone could not be persisted')
      st.failIndex = false
      archive.prune()
      assert.deepEqual(archive.list().map((r) => r.sessionId), ['b'], 'the next pass evicts it')
      assert.equal(archive.archiveOutcome(saved('a', { lastActivityAt: 1 })).status, 'duplicate')
    })
  })

  describe('D: deleteAll covers queued snapshots', () => {
    it('enqueue -> deleteAll -> whenIdle leaves nothing, counts the queued one, and tombstones it', async () => {
      const archive = make()
      archive.archive(saved('old', { lastActivityAt: 1 }))
      archive.enqueue(saved('new', { lastActivityAt: 2 }))
      assert.deepEqual(archive.deleteAll(), { deleted: 2, failed: 0 })
      await archive.whenIdle()
      assert.deepEqual(archive.list(), [])
      assert.deepEqual(recordFiles(join(root, 'archive')), [])
      assert.equal(archive.archiveOutcome(saved('new', { lastActivityAt: 2 })).status, 'duplicate')
    })

    it('with no rows at all, the cancellation still reaches disk', async () => {
      const archive = make()
      archive.enqueue(saved('only', { lastActivityAt: 2 }))
      assert.deepEqual(archive.deleteAll(), { deleted: 1, failed: 0 })
      await archive.whenIdle()
      assert.deepEqual(archive.list(), [])
      assert.equal(make().archiveOutcome(saved('only', { lastActivityAt: 2 })).status, 'duplicate', 'tombstone persisted')
    })

    it('drainSync() does not resurrect a cancelled job', () => {
      const archive = make()
      archive.enqueue(saved('x', { lastActivityAt: 2 }))
      archive.deleteAll()
      archive.drainSync()
      assert.deepEqual(archive.list(), [])
    })
  })

  describe('E: a record larger than the user\'s byte cap is skipped and evicts NOTHING', () => {
    const noise = () => randomBytes(40_000).toString('base64')

    it('skipped, no file, existing records untouched', () => {
      const archive = make({ maxMegabytes: 0.02 }) // ~21 KB
      archive.archive(saved('a', { lastActivityAt: 1 }))
      archive.archive(saved('b', { lastActivityAt: 2 }))
      const before = recordFiles(join(root, 'archive')).sort()
      const out = archive.archiveOutcome(saved('big', { n: 1, content: noise(), lastActivityAt: 3 }))
      assert.equal(out.status, 'skipped')
      assert.deepEqual(recordFiles(join(root, 'archive')).sort(), before, 'nothing evicted, nothing written')
      assert.equal(archive.list().length, 2)
    })

    it('retention never evicts the record being committed, even if it sorts oldest', () => {
      const archive = make({ maxEntries: 1 })
      archive.archive(saved('x', { lastActivityAt: 1 }))
      clock.t -= 1000 // the new record gets an OLDER archivedAt
      const out = archive.archiveOutcome(saved('y', { lastActivityAt: 2 }))
      assert.equal(out.status, 'archived')
      assert.deepEqual(archive.list().map((r) => r.sessionId), ['y'], 'x went, y (being committed) stayed')
    })
  })

  describe('F: temp files', () => {
    it('a failed write removes its own temp (record and index)', () => {
      const failing = (match) => (path, data, opts) => {
        if (path.endsWith(match)) {
          writeFileSync(`${path}${opts.tmpSuffix}`, 'partial transcript bytes')
          throw new Error('ENOSPC')
        }
        return writeFileRestricted(path, data, opts)
      }
      const archive = make({ writeFile: failing('index.json') })
      archive.archive(saved('a', { lastActivityAt: 1 })) // record fine, index write fails (swallowed)
      assert.deepEqual(files(join(root, 'archive')).filter((f) => f.includes('.tmp')), [], 'no index temp left')
    })

    it('load removes record/index temps left by a dead process, and only those', () => {
      const archive = make()
      const a = archive.archive(saved('a'))
      const dir = join(root, 'archive')
      writeFileSync(join(dir, `${a.archiveId}.json.gz.tmp-99999`), 'partial transcript')
      writeFileSync(join(dir, `${'b'.repeat(32)}.json.gz.tmp-1`), 'partial transcript')
      writeFileSync(join(dir, 'index.json.tmp-7'), '{}')
      writeFileSync(join(dir, 'notes.tmp-1'), 'not ours')
      assert.equal(make().list().length, 1)
      assert.deepEqual(files(dir).filter((f) => f.includes('.tmp')).sort(), ['notes.tmp-1'])
    })
  })

  describe('G: only a missing archive means empty', () => {
    it('an unreadable directory is NOT cached as empty: the op fails, a later call retries', { skip: !posix || rootOnly }, () => {
      const seed = make()
      seed.archive(saved('a', { lastActivityAt: 1 }))
      seed.archive(saved('b', { lastActivityAt: 2 }))
      const dir = join(root, 'archive')
      const archive = make()
      chmodSync(dir, 0o300) // writable + searchable, not listable
      try {
        assert.deepEqual(archive.list(), [], 'list reports nothing while it cannot look')
        assert.equal(archive.archiveOutcome(saved('c', { lastActivityAt: 3 })).status, 'failed', 'and an archive attempt FAILS rather than writing over an unseen index')
      } finally {
        chmodSync(dir, 0o700)
      }
      assert.deepEqual(archive.list().map((r) => r.sessionId).sort(), ['a', 'b'], 'the same instance retried and found the real records')
      assert.equal(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).entries.length, 2, 'the real index was never replaced by an empty one')
    })

    it('an unreadable INDEX file is not treated as corrupt/empty either', { skip: !posix || rootOnly }, () => {
      const seed = make()
      seed.archive(saved('a'))
      const index = join(root, 'archive', 'index.json')
      chmodSync(index, 0o000)
      const archive = make()
      try {
        assert.equal(archive.archiveOutcome(saved('z', { lastActivityAt: 9 })).status, 'failed')
      } finally {
        chmodSync(index, 0o600)
      }
      assert.equal(archive.list().length, 1)
    })

    it('a missing directory is simply empty (and not an error)', () => {
      const archive = make()
      assert.deepEqual(archive.list(), [])
      assert.deepEqual(archive.deleteAll(), { deleted: 0, failed: 0 })
    })
  })

  describe('H: the synchronous (boot-path) writes are durable; the queued path is not', () => {
    it('archiveOutcome fsyncs the record and the index; enqueue does not', async () => {
      const calls = []
      const spy = (path, data, opts) => { calls.push([path.endsWith('index.json') ? 'index' : 'record', opts.durable === true]); return writeFileRestricted(path, data, opts) }
      const archive = make({ writeFile: spy })
      archive.archiveOutcome(saved('a', { lastActivityAt: 1 }))
      assert.deepEqual(calls, [['record', true], ['index', true]])
      calls.length = 0
      archive.enqueue(saved('b', { lastActivityAt: 2 }))
      await archive.whenIdle()
      assert.deepEqual(calls, [['record', false], ['index', false]])
    })
  })

  describe('J: bounds and hardening', () => {
    it('clamps maxEntries to 1000', () => {
      assert.equal(make({ maxEntries: 5000 }).retentionPolicy().maxEntries, 1000)
      assert.equal(make({ maxEntries: 1000 }).retentionPolicy().maxEntries, 1000)
      assert.equal(make({ maxEntries: 999 }).retentionPolicy().maxEntries, 999)
    })

    it('makes a pre-existing loose directory 0700', { skip: !posix }, () => {
      root = mkdtempSync(join(tmpdir(), 'chroxy-archive-'))
      const dir = join(root, 'archive')
      mkdirSync(dir, { mode: 0o755 })
      chmodSync(dir, 0o755)
      new SessionArchive({ dir }).archive(saved('a'))
      assert.equal(statSync(dir).mode & 0o777, 0o700)
    })

    it('does not follow a symlinked index.json (rebuilds from the records, leaves the target alone)', { skip: !posix }, () => {
      const seed = make()
      const a = seed.archive(saved('a'))
      const dir = join(root, 'archive')
      const decoy = join(root, 'decoy-index.json')
      writeFileSync(decoy, JSON.stringify({ version: 1, entries: [{ archiveId: 'c'.repeat(32), sessionId: 'PLANTED', historyLength: 1, bytes: 1, reason: 'closed', archivedAt: 1 }], tombstones: [] }))
      rmSync(join(dir, 'index.json'))
      symlinkSync(decoy, join(dir, 'index.json'))
      const reloaded = make()
      assert.deepEqual(reloaded.list().map((r) => r.sessionId), ['a'], 'the planted roster was not read')
      assert.equal(JSON.parse(readFileSync(decoy, 'utf8')).entries[0].sessionId, 'PLANTED', 'and the symlink target was not overwritten')
      assert.equal(a.archiveId, reloaded.list()[0].archiveId)
    })

    it('does not follow a symlinked record', { skip: !posix }, async () => {
      const archive = make()
      const a = archive.archive(saved('a'))
      const b = archive.archive(saved('b', { lastActivityAt: 2 }))
      const dir = join(root, 'archive')
      rmSync(join(dir, `${a.archiveId}.json.gz`))
      symlinkSync(join(dir, `${b.archiveId}.json.gz`), join(dir, `${a.archiveId}.json.gz`))
      assert.equal((await make().getHistoryPage(a.archiveId)).ok, false)
      assert.equal((await make().getHistoryPage(b.archiveId)).ok, true)
    })

    it('a FIFO planted where the index is does not hang the load (it is rebuilt around)', { skip: !posix, timeout: 10_000 }, async () => {
      const { spawnSync } = await import('node:child_process')
      const seed = make()
      seed.archive(saved('a'))
      const index = join(root, 'archive', 'index.json')
      rmSync(index)
      assert.equal(spawnSync('mkfifo', [index]).status, 0)
      const reloaded = make()
      assert.deepEqual(reloaded.list().map((r) => r.sessionId), ['a'])
    })

    it('a parse error is logged by class, never with the file\'s content', () => {
      const seed = make()
      seed.archive(saved('a'))
      writeFileSync(join(root, 'archive', 'index.json'), 'TOPSECRET-TRANSCRIPT-BYTES is not json at all')
      const lines = []
      const listener = (entry) => lines.push(entry.message)
      addLogListener(listener)
      try {
        make().list()
      } finally {
        removeLogListener(listener)
      }
      assert.ok(lines.some((l) => l.includes('index unreadable')), 'control: the unreadable-index line was logged')
      assert.equal(lines.some((l) => l.includes('TOPSECRET')), false)
    })
  })

  describe('K: cached read race and the exact-fit boundary', () => {
    it('a cache-hit read that overlaps a delete is NOT served', async () => {
      const archive = make()
      const a = archive.archive(saved('a'))
      assert.equal((await archive.getHistoryPage(a.archiveId)).ok, true) // warm the cache
      const pending = archive.getHistoryPage(a.archiveId)
      assert.equal(archive.delete(a.archiveId), 'deleted')
      assert.equal((await pending).ok, false)
    })

    it('a cap exactly the size of the full record keeps every entry', () => {
      const full = make({ maxRecordBytes: 10_000_000 })
      const { meta: fm } = full.archiveOutcome({ ...saved('s', { n: 0 }), history: Array.from({ length: 10 }, (_, i) => ({ type: 'message', content: `${i}`.padEnd(40, 'x') })) })
      const fullLen = gunzipSync(readFileSync(join(root, 'archive', `${fm.archiveId}.json.gz`))).length
      rmSync(root, { recursive: true, force: true })
      root = null
      const archive = make({ maxRecordBytes: fullLen })
      const { meta } = archive.archiveOutcome({ ...saved('s', { n: 0 }), history: Array.from({ length: 10 }, (_, i) => ({ type: 'message', content: `${i}`.padEnd(40, 'x') })) })
      assert.equal(meta.omittedOldest, 0, 'nothing is discarded on an over-estimate')
    })
  })
})
