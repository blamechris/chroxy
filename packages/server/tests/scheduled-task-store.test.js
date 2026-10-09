import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ScheduledTaskCadenceCronSchema, ScheduledTaskSchema } from '@chroxy/protocol'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { parseCron } from '../src/schedule-parser.js'
import { join } from 'path'
import {
  ScheduledTaskStore,
  ScheduledTaskValidationError,
  defaultScheduledTasksPath,
} from '../src/scheduled-task-store.js'

/**
 * #6862 — persisted scheduled-task registry. Covers CRUD round-trips, restart
 * survival (a fresh store reads the file), atomic write + 0600 perms, the
 * version gate + corrupt-json fail-open, per-entry drop of malformed tasks, and
 * next-run computation on add/update/load. No firing — the engine is #6865.
 *
 * Every store writes to a temp dir (never the real ~/.chroxy), so the #4633
 * sandbox guard is satisfied.
 */

const silentLog = { info() {}, warn() {}, error() {} }
const HOUR = 60 * 60 * 1000

describe('#6862 ScheduledTaskStore', () => {
  let dir
  let filePath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sched-store-'))
    filePath = join(dir, 'scheduled-tasks.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const newStore = (now) => new ScheduledTaskStore({ filePath, logger: silentLog, now })

  it('requires a filePath', () => {
    assert.throws(() => new ScheduledTaskStore({}), /requires a filePath/)
  })

  describe('#7074 task id wire cap', () => {
    // Companion to #7051. `ScheduledTaskSchema.id` is max(256) but neither add()
    // nor _normalizeStoredTask bounded it, so an over-cap id loaded clean and then
    // failed the dashboard's safeParse — which yields `snapshot === null`, losing
    // the task list AND the armed state.
    //
    // NOT reachable from a client message: ScheduledTaskInputSchema has no `id`
    // field and z.object strips unknown keys, so ws-server dispatches a payload
    // with no id at all. The reachable path is a hand-edited registry.
    const overCapId = 'a'.repeat(257)

    it('add() rejects an id longer than the wire cap', () => {
      const store = newStore(() => 1000)
      assert.throws(
        () => store.add({ id: overCapId, prompt: 'x', cadence: { kind: 'cron', expression: '*/5 * * * *' } }),
        (err) => err instanceof ScheduledTaskValidationError && err.field === 'id',
      )
    })

    it('accepts an id of exactly the cap length (the bound is inclusive)', () => {
      const store = newStore(() => 1000)
      const atCap = 'b'.repeat(256)
      const t = store.add({ id: atCap, prompt: 'x', cadence: { kind: 'cron', expression: '*/5 * * * *' } })
      assert.equal(t.id, atCap)
    })

    it('a generated id is far below the cap, so this can never fire for normal use', () => {
      const store = newStore(() => 1000)
      const t = store.add({ prompt: 'x', cadence: { kind: 'cron', expression: '*/5 * * * *' } })
      assert.ok(t.id.length < 64, `a generated id should be a uuid, got ${t.id.length} chars`)
    })

    const writeRegistryWithId = (id) => {
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        tasks: [{ id, prompt: 'operator task', cadence: { kind: 'cron', expression: '*/5 * * * *' }, createdAt: 1, updatedAt: 1 }],
      }))
      return newStore(() => 1000).load()
    }

    it('CONTROL: the registry fixture loads with a normal id (so the refusal below means something)', () => {
      assert.equal(writeRegistryWithId('normal-id').list().length, 1)
    })

    it('a hand-edited registry with an over-cap id is refused on load, not served', () => {
      const store = writeRegistryWithId(overCapId)
      assert.deepEqual(store.list(), [], 'an unrepresentable task must not reach the wire')
    })

    it('and #7050 preserves it on disk rather than erasing it', () => {
      const store = writeRegistryWithId(overCapId)
      assert.equal(store.unreadableCount(), 1, 'refusing must not mean erasing')
      store.add({ prompt: 'unrelated', cadence: { kind: 'cron', expression: '0 9 * * *' } })
      const onDisk = JSON.parse(readFileSync(filePath, 'utf-8')).tasks.map((t) => t.id)
      assert.ok(onDisk.includes(overCapId), 'the over-cap entry survives an unrelated write')
    })

    it('the store cap and the wire schema agree at the boundary (drift guard)', () => {
      for (const len of [256, 257]) {
        const id = 'c'.repeat(len)
        const wireOk = ScheduledTaskSchema.safeParse({
          id, name: null, enabled: true, prompt: 'x', target: {},
          cadence: { kind: 'cron', expression: '*/5 * * * *' },
          nextRun: null, lastRun: null, createdAt: 1, updatedAt: 1,
          providerRefusal: null, effectiveProvider: null, effectivePermissionMode: 'default',
          permissionModeClamped: false, quarantined: false,
        }).success
        let storeOk = true
        try {
          newStore(() => 1000).add({ id, prompt: 'x', cadence: { kind: 'cron', expression: '*/5 * * * *' } })
        } catch (err) {
          // Assert WHICH error: a bare catch would let an unrelated throw count as
          // "the cap rejected it", so half this comparison would prove nothing.
          assert.ok(
            err instanceof ScheduledTaskValidationError && err.field === 'id',
            `expected an id-cap rejection at ${len} chars, got ${err?.message}`,
          )
          storeOk = false
        }
        assert.equal(storeOk, wireOk, `at ${len} chars the store and ScheduledTaskSchema disagree — the id cap has drifted`)
      }
    })
  })

  describe('#7050 a load-refused task is preserved, not erased', () => {
    // load() drops any entry _normalizeStoredTask refuses. _persist() then wrote
    // only the SURVIVORS, so the next unrelated mutation erased the operator's
    // named task from disk permanently, with only a daemon-log warn as a trace.
    const TYPO_EPOCH = 1795000000000000000 // ns-vs-ms typo: past MAX_EPOCH_MS

    const writeMixedRegistry = () => {
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        tasks: [
          { id: 'good', prompt: 'keep me', cadence: { kind: 'cron', expression: '*/5 * * * *' }, createdAt: 1, updatedAt: 1 },
          { id: 'typo', prompt: 'operator named task', cadence: { kind: 'once', at: TYPO_EPOCH }, createdAt: 1, updatedAt: 1 },
        ],
      }))
      return newStore(() => 1000).load()
    }

    const onDiskIds = () => JSON.parse(readFileSync(filePath, 'utf-8')).tasks.map((t) => t.id).sort()

    it('CONTROL: the refused entry really is refused (it is not silently loading)', () => {
      const store = writeMixedRegistry()
      assert.deepEqual(store.list().map((t) => t.id), ['good'], 'only the good task loads')
      assert.deepEqual(onDiskIds(), ['good', 'typo'], 'both are still on disk before any mutation')
    })

    it('an unrelated mutation does NOT erase the refused entry from disk', () => {
      const store = writeMixedRegistry()
      store.add({ prompt: 'unrelated', cadence: { kind: 'cron', expression: '0 9 * * *' } })
      assert.ok(onDiskIds().includes('typo'), 'the operator\'s unreadable task must survive an unrelated write')
    })

    it('remove() of a live task also does not erase it', () => {
      const store = writeMixedRegistry()
      assert.equal(store.remove('good'), true)
      assert.deepEqual(onDiskIds(), ['typo'], 'the refused entry is all that is left, and it is still there')
    })

    it('reports how many stored entries could not be read', () => {
      const store = writeMixedRegistry()
      assert.equal(store.unreadableCount(), 1)
      const [only] = store.listUnreadable()
      assert.equal(only.id, 'typo', 'the id is surfaced so the panel can name what is missing')
      assert.match(only.reason, /epoch|representable/i, 'and why')
    })

    it('the refused entry is NOT served as a live task', () => {
      const store = writeMixedRegistry()
      assert.equal(store.get('typo'), null)
      assert.ok(!store.list().some((t) => t.id === 'typo'))
    })

    it('round-trips stably: reloading does not duplicate or resurrect it', () => {
      writeMixedRegistry().add({ prompt: 'x', cadence: { kind: 'cron', expression: '0 9 * * *' } })
      const reloaded = newStore(() => 1000).load()
      assert.equal(reloaded.unreadableCount(), 1, 'still exactly one unreadable entry after a round trip')
      assert.equal(onDiskIds().filter((id) => id === 'typo').length, 1, 'and exactly one copy on disk')
    })

    it('entries past the store cap are preserved too, not silently dropped and erased', () => {
      // The over-cap remainder is never even examined by the loader, so before
      // #7050 it was erased on the next write — valid tasks deleted for losing a
      // race with a cap.
      const many = Array.from({ length: 505 }, (_, i) => ({
        id: `t${i}`, prompt: 'p', cadence: { kind: 'cron', expression: '*/5 * * * *' }, createdAt: 1, updatedAt: 1,
      }))
      writeFileSync(filePath, JSON.stringify({ version: 1, tasks: many }))
      const store = newStore(() => 1000).load()

      assert.equal(store.list().length, 500, 'the cap still bounds what is LOADED')
      assert.equal(store.unreadableCount(), 5, 'the remainder is preserved rather than dropped')

      store.remove('t0') // any unrelated mutation triggers a persist
      const onDisk = JSON.parse(readFileSync(filePath, 'utf-8')).tasks.map((t) => t.id)
      assert.ok(onDisk.includes('t504'), 'an over-cap entry must survive the write')
      assert.equal(onDisk.length, 504, '505 minus the one actually removed')
    })

    it('a RELOAD that hits an early return clears preserved entries too (they must not leak forward)', () => {
      // load() clears _tasks FIRST precisely so every early return below leaves
      // the store empty. The preserved set must follow the same rule: otherwise a
      // second load() that hits ENOENT / bad JSON / the version gate keeps the
      // PREVIOUS load's raw entries, and the next add() writes them back into a
      // file that no longer contains them — resurrecting deleted records.
      const store = writeMixedRegistry()
      assert.equal(store.unreadableCount(), 1, 'precondition: one entry preserved')

      rmSync(filePath) // registry goes away (operator wiped it / fresh machine)
      store.load()     // early return: ENOENT

      assert.equal(store.unreadableCount(), 0, 'an emptied store must not retain the old preserved entries')
      store.add({ prompt: 'fresh', cadence: { kind: 'cron', expression: '0 9 * * *' } })
      const onDisk = JSON.parse(readFileSync(filePath, 'utf-8')).tasks.map((t) => t.id)
      assert.ok(!onDisk.includes('typo'), `a wiped registry must not resurrect 'typo', got ${JSON.stringify(onDisk)}`)
    })

    it('remove() with a non-string id does not mass-delete the id-less preserved entries', () => {
      // Entries with no usable id are preserved as `{ id: null }`, and
      // listUnreadable() emits those rows publicly — so a caller forwarding one
      // back as remove(null) must not wipe every one of them and report success.
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        tasks: [
          { prompt: 'no id at all', cadence: { kind: 'cron', expression: '*/5 * * * *' } },
          { id: 42, prompt: 'numeric id', cadence: { kind: 'cron', expression: '*/5 * * * *' } },
        ],
      }))
      const store = newStore(() => 1000).load()
      assert.equal(store.unreadableCount(), 2, 'both are unreadable and id-less')
      assert.equal(store.remove(null), false, 'a null id must not match the null-id rows')
      assert.equal(store.remove(''), false)
      assert.equal(store.unreadableCount(), 2, 'nothing was deleted')
    })

    it('add() refuses an id that a preserved entry already occupies', () => {
      // The preserved entry is ON DISK, so minting a live task with the same id
      // would put two entries with that id in the file.
      const store = writeMixedRegistry()
      assert.throws(
        () => store.add({ id: 'typo', prompt: 'collide', cadence: { kind: 'cron', expression: '0 9 * * *' } }),
        (err) => err instanceof ScheduledTaskValidationError && err.field === 'id',
        'a preserved id is taken, not free',
      )
    })

    it('an operator can delete an unreadable entry (it must not be undeletable)', () => {
      const store = writeMixedRegistry()
      assert.equal(store.remove('typo'), true, 'remove() must reach preserved entries too')
      assert.equal(store.unreadableCount(), 0)
      assert.deepEqual(onDiskIds(), ['good'])
    })
  })

  // #7077 — the preserved raw entries are captured at load() time, but the
  // operator can hand-edit the file while the daemon runs. Before this, the next
  // unrelated persist wrote the STALE capture back over their fix: the file
  // looked edited and then un-edited itself. _persist() now re-reads the file
  // and reconciles ONLY the preserved set; the daemon's readable tasks stay
  // authoritative, exactly as before.
  describe('#7077 an operator hand-fix to an unreadable entry survives the next persist', () => {
    const TYPO_EPOCH = 1795000000000000000 // ns-vs-ms typo: past MAX_EPOCH_MS
    const GOOD_AT = 1900000000000
    const cron = (expression = '*/5 * * * *') => ({ kind: 'cron', expression })

    const live = (id = 'good') => ({ id, prompt: 'keep me', cadence: cron(), createdAt: 1, updatedAt: 1 })
    const typo = (over = {}) => ({
      id: 'typo', prompt: 'operator named task', cadence: { kind: 'once', at: TYPO_EPOCH }, createdAt: 1, updatedAt: 1, ...over,
    })

    const writeFile = (tasks) => writeFileSync(filePath, JSON.stringify({ version: 1, tasks }))
    const readTasks = () => JSON.parse(readFileSync(filePath, 'utf-8')).tasks
    const onDisk = (id) => readTasks().find((t) => t.id === id)
    /** Operator edits the file by hand while the daemon runs. */
    const hand = (fn) => writeFile(fn(readTasks()))
    const unrelatedMutation = (store) =>
      store.add({ prompt: 'unrelated', cadence: cron('0 9 * * *') })

    it('ACCEPTANCE: the operator\'s correction is not reverted by an unrelated mutation', () => {
      writeFile([live(), typo()])
      const store = newStore(() => 1000).load()
      assert.equal(store.unreadableCount(), 1, 'precondition: the typo entry is preserved')

      // The operator fixes the epoch typo in the file, mid-session.
      hand((tasks) => tasks.map((t) => (t.id === 'typo' ? { ...t, cadence: { kind: 'once', at: GOOD_AT } } : t)))
      unrelatedMutation(store)

      assert.deepEqual(onDisk('typo').cadence, { kind: 'once', at: GOOD_AT }, 'the fix must still be on disk')
      assert.notEqual(onDisk('typo').cadence.at, TYPO_EPOCH, 'the stale capture must NOT be written back')
    })

    it('an entry the operator fixed is ADOPTED as a live task (and is no longer unreadable)', () => {
      writeFile([live(), typo()])
      const store = newStore(() => 1000).load()
      hand((tasks) => tasks.map((t) => (t.id === 'typo' ? { ...t, cadence: { kind: 'once', at: GOOD_AT } } : t)))
      unrelatedMutation(store)

      assert.equal(store.unreadableCount(), 0)
      const adopted = store.get('typo')
      assert.ok(adopted, 'a fixed entry becomes a task')
      assert.equal(adopted.nextRun, GOOD_AT, 'with nextRun recomputed from the corrected cadence')
      assert.equal(readTasks().filter((t) => t.id === 'typo').length, 1, 'exactly one copy on disk')
    })

    it('CONTROL: without an edit, the preserved entry is written back verbatim', () => {
      writeFile([live(), typo()])
      const store = newStore(() => 1000).load()
      unrelatedMutation(store)
      assert.deepEqual(onDisk('typo'), typo(), 'byte-identical round trip')
      assert.equal(store.unreadableCount(), 1)
    })

    it('an entry the operator edited but is STILL unreadable keeps THEIR newer edit, not the stale capture', () => {
      writeFile([live(), typo()])
      const store = newStore(() => 1000).load()
      const [before] = store.listUnreadable()

      const STILL_BAD = 1795000000000000001
      hand((tasks) => tasks.map((t) => (t.id === 'typo'
        ? { ...t, prompt: 'operator tried again', cadence: { kind: 'once', at: STILL_BAD } }
        : t)))
      unrelatedMutation(store)

      assert.equal(onDisk('typo').prompt, 'operator tried again', 'the newer edit survives')
      assert.equal(onDisk('typo').cadence.at, STILL_BAD)
      assert.equal(store.unreadableCount(), 1, 'still unreadable')
      const [after] = store.listUnreadable()
      assert.match(after.reason, /epoch|representable/i, 'the reason is re-derived from the edited entry')
      assert.notEqual(after.handle, before.handle, 'the entry changed, so its handle changed')
    })

    it('an entry the operator DELETED from the file is dropped, not resurrected', () => {
      writeFile([live(), typo()])
      const store = newStore(() => 1000).load()
      hand((tasks) => tasks.filter((t) => t.id !== 'typo'))
      unrelatedMutation(store)

      assert.equal(onDisk('typo'), undefined, 'the operator removed it; the daemon must not put it back')
      assert.equal(store.unreadableCount(), 0)
      assert.ok(onDisk('good'), 'the readable task is untouched')
    })

    it('the daemon\'s readable tasks stay authoritative over a hand-edit of THEM', () => {
      writeFile([live(), typo()])
      const store = newStore(() => 1000).load()
      hand((tasks) => tasks.map((t) => (t.id === 'good' ? { ...t, prompt: 'edited behind the daemon' } : t)))
      unrelatedMutation(store)
      assert.equal(onDisk('good').prompt, 'keep me', 'only the PREFERRED set is reconciled; live tasks win, as before')
    })

    it('a file that is MISSING at persist time falls back to the captured raw entries', () => {
      writeFile([live(), typo()])
      const store = newStore(() => 1000).load()
      rmSync(filePath)
      unrelatedMutation(store)
      assert.deepEqual(onDisk('typo'), typo(), 'never drop preserved data because the file could not be read')
    })

    it('an UNPARSABLE file at persist time falls back to the captured raw entries', () => {
      writeFile([live(), typo()])
      const store = newStore(() => 1000).load()
      writeFileSync(filePath, '{ this is half-saved by an editor')
      unrelatedMutation(store)
      assert.deepEqual(onDisk('typo'), typo())
    })

    it('a file with a wrong version or a non-array `tasks` falls back too', () => {
      for (const body of [
        JSON.stringify({ version: 99, tasks: [] }),
        JSON.stringify({ version: 1, tasks: 'nope' }),
        JSON.stringify(null),
        JSON.stringify([]),
      ]) {
        writeFile([live(), typo()])
        const store = newStore(() => 1000).load()
        writeFileSync(filePath, body)
        unrelatedMutation(store)
        assert.deepEqual(onDisk('typo'), typo(), `fallback for ${body}`)
        assert.equal(store.unreadableCount(), 1)
      }
    })

    it('a file that is an UNREADABLE path (a directory) falls back and does not throw', () => {
      writeFile([live(), typo()])
      const store = newStore(() => 1000).load()
      rmSync(filePath)
      mkdirSync(filePath) // readFileSync -> EISDIR; the atomic write then fails too, which is logged, not thrown
      assert.doesNotThrow(() => unrelatedMutation(store))
      assert.equal(store.unreadableCount(), 1, 'the in-memory capture is intact')
    })

    it('leaves no temp file behind (the write stays atomic)', () => {
      writeFile([live(), typo()])
      const store = newStore(() => 1000).load()
      hand((tasks) => tasks.map((t) => (t.id === 'typo' ? { ...t, cadence: { kind: 'once', at: GOOD_AT } } : t)))
      unrelatedMutation(store)
      assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp')), [])
      assert.equal(statSync(filePath).mode & 0o777, 0o600)
    })

    describe('identity of an entry across edits', () => {
      it('an operator-edited entry whose id CHANGED is followed, not duplicated or lost', () => {
        writeFile([live(), typo()])
        const store = newStore(() => 1000).load()
        hand((tasks) => tasks.map((t) => (t.id === 'typo'
          ? { ...t, id: 'renamed', cadence: { kind: 'once', at: GOOD_AT } }
          : t)))
        unrelatedMutation(store)

        assert.ok(store.get('renamed'), 'the renamed, fixed entry is adopted')
        assert.equal(onDisk('typo'), undefined, 'and the old id is gone')
        assert.equal(store.unreadableCount(), 0)
      })

      it('ID-LESS entries: matched by exact content; an untouched one survives while a sibling is edited', () => {
        const idless = (prompt) => ({ prompt, cadence: { kind: 'once', at: TYPO_EPOCH } })
        writeFile([live(), idless('first'), idless('second')])
        const store = newStore(() => 1000).load()
        assert.equal(store.unreadableCount(), 2)

        // Operator edits only the SECOND one (still id-less, still unreadable).
        hand((tasks) => tasks.map((t) => (t.prompt === 'second' ? { ...t, prompt: 'second, edited' } : t)))
        unrelatedMutation(store)

        const prompts = readTasks().filter((t) => t.id === undefined).map((t) => t.prompt).sort()
        assert.deepEqual(prompts, ['first', 'second, edited'], 'the first is verbatim, the second carries the edit')
        assert.equal(store.unreadableCount(), 2)
      })

      it('ID-LESS entries: an edit that GIVES the entry a valid id adopts it', () => {
        const idless = (prompt) => ({ prompt, cadence: cron(), createdAt: 1, updatedAt: 1 })
        writeFile([live(), idless('needs an id')])
        const store = newStore(() => 1000).load()
        assert.equal(store.unreadableCount(), 1, 'refused: task id must be a non-empty string')

        hand((tasks) => tasks.map((t) => (t.prompt === 'needs an id' ? { ...t, id: 'now-has-id' } : t)))
        unrelatedMutation(store)

        assert.ok(store.get('now-has-id'), 'the operator\'s fix (adding the id) is adopted')
        assert.equal(store.unreadableCount(), 0)
        assert.equal(readTasks().filter((t) => t.id === undefined).length, 0, 'no stale id-less copy left behind')
      })

      it('ID-LESS entries: a deleted one is dropped and the others are untouched', () => {
        const idless = (prompt) => ({ prompt, cadence: { kind: 'once', at: TYPO_EPOCH } })
        writeFile([live(), idless('first'), idless('second')])
        const store = newStore(() => 1000).load()
        hand((tasks) => tasks.filter((t) => t.prompt !== 'first'))
        unrelatedMutation(store)

        assert.deepEqual(readTasks().filter((t) => t.id === undefined).map((t) => t.prompt), ['second'])
        assert.equal(store.unreadableCount(), 1)
      })

      it('an entry the operator fixed to share a LIVE task\'s id is not adopted over it, and is not dropped', () => {
        // Two entries now claim 'good'. The daemon\'s live task is authoritative
        // and untouched; the operator\'s edited entry is kept (preserved, with the
        // collision named) rather than adopted into a duplicate or silently lost.
        writeFile([live(), typo()])
        const store = newStore(() => 1000).load()
        hand((tasks) => tasks.map((t) => (t.id === 'typo'
          ? { ...t, id: 'good', prompt: 'operator renamed me onto a live id', cadence: { kind: 'once', at: GOOD_AT } }
          : t)))
        unrelatedMutation(store)

        assert.equal(store.get('good').prompt, 'keep me', 'the live task is untouched')
        assert.equal(store.unreadableCount(), 1, 'the preserved entry is kept, not adopted into a collision')
        assert.match(store.listUnreadable()[0].reason, /duplicate/i)
        assert.ok(
          readTasks().some((t) => t.prompt === 'operator renamed me onto a live id'),
          'and the operator\'s edit is still on disk',
        )
      })

      it('a fixed entry is NOT adopted past the store cap — it stays preserved with the operator\'s new content', () => {
        const many = Array.from({ length: 500 }, (_, i) => live(`t${i}`))
        writeFile([...many, typo({ id: 'over' })])
        const store = newStore(() => 1000).load()
        assert.equal(store.list().length, 500)
        assert.equal(store.unreadableCount(), 1, 'cap remainder preserved')

        hand((tasks) => tasks.map((t) => (t.id === 'over' ? { ...t, cadence: { kind: 'once', at: GOOD_AT } } : t)))
        store.update('t0', { prompt: 'touch' }) // persists WITHOUT freeing a slot

        assert.equal(store.list().length, 500, 'the cap is never exceeded')
        assert.equal(store.get('over'), null, 'not adopted: there is no room')
        assert.equal(store.unreadableCount(), 1, 'but not lost either')
        assert.deepEqual(onDisk('over').cadence, { kind: 'once', at: GOOD_AT }, 'and carries the operator\'s edit')
        assert.match(store.listUnreadable()[0].reason, /cap/i)
      })
    })
  })

  // #7077 round 2 — NO identity inference. Reconciliation used to guess which
  // on-disk entry "was" a preserved one (by id, then by file order), and each guess
  // had a hole: it could resurrect a deleted task, arm a duplicate a restart
  // would reject, overwrite a live task's copy, or restore a discarded entry over
  // another's repair. It now compares against a multiset of exactly what the
  // daemon last wrote: an entry it wrote is its own; anything else on disk is the
  // operator's, adopted or preserved, never guessed about.
  describe('#7077 reconciliation is driven by what the daemon last wrote', () => {
    const TYPO_EPOCH = 1795000000000000000
    const cron = (expression = '*/5 * * * *') => ({ kind: 'cron', expression })
    const live = (id, over = {}) => ({ id, prompt: `live ${id}`, cadence: cron(), createdAt: 1, updatedAt: 1, ...over })
    const bad = (id, over = {}) => ({ id, prompt: `bad ${id}`, cadence: { kind: 'once', at: TYPO_EPOCH }, createdAt: 1, updatedAt: 1, ...over })
    const writeFile = (tasks) => writeFileSync(filePath, JSON.stringify({ version: 1, tasks }))
    const readTasks = () => JSON.parse(readFileSync(filePath, 'utf-8')).tasks
    const unrelated = (store) => store.add({ prompt: 'unrelated', cadence: cron('0 9 * * *') })
    /** Make the next atomic write fail (the tmp path is a directory) while the file stays readable. */
    const breakWrites = () => mkdirSync(`${filePath}.tmp-${process.pid}`)
    const fixWrites = () => rmSync(`${filePath}.tmp-${process.pid}`, { recursive: true, force: true })

    it('Codex 1: deleting a live task does not resurrect it when the operator removed an unreadable one', () => {
      writeFile([live('A'), bad('B')])
      const store = newStore(() => 1000).load()
      writeFile(readTasks().filter((t) => t.id !== 'B')) // operator deletes B by hand

      assert.equal(store.remove('A'), true)

      assert.equal(store.get('A'), null, 'A stays deleted in memory')
      assert.deepEqual(readTasks().map((t) => t.id), [], 'and on disk: neither A nor B comes back')
      assert.equal(store.unreadableCount(), 0)
    })

    it('Codex 2: two repaired entries sharing an id adopt the FIRST in file order, exactly as load() would', () => {
      writeFile([bad('old-id'), bad('same')])
      const store = newStore(() => 1000).load()
      // Operator repairs both; 'old-id' is renamed to 'same'. The disabled one is first on disk.
      writeFile([
        live('same', { prompt: 'disabled copy', enabled: false }),
        live('same', { prompt: 'enabled copy', enabled: true }),
      ])
      unrelated(store)

      assert.equal(store.get('same').prompt, 'disabled copy', 'the first wins')
      assert.equal(store.unreadableCount(), 1, 'the second is kept, not armed')
      assert.match(store.listUnreadable()[0].reason, /duplicate/i)
      const reloaded = newStore(() => 1000).load()
      assert.equal(reloaded.get('same').prompt, 'disabled copy', 'a restart agrees with the running daemon')
      assert.equal(reloaded.get('same').enabled, false)
    })

    it('Codex 3: an engine save does not overwrite a repaired entry that shares a live task\'s id', () => {
      writeFile([bad('same', { prompt: 'unreadable copy' }), live('same', { prompt: 'live copy' })])
      const store = newStore(() => 1000).load()
      assert.equal(store.unreadableCount(), 1)
      // Operator repairs the unreadable copy on disk...
      writeFile(readTasks().map((t) => (t.prompt === 'unreadable copy' ? live('same', { prompt: 'repaired copy' }) : t)))
      // ...and the engine saves a run result for the live task.
      store.update('same', { lastRun: { at: 5, status: 'success' } })

      const onDisk = readTasks()
      assert.equal(onDisk.filter((t) => t.prompt === 'live copy').length, 1, 'the live task is written exactly once')
      assert.equal(onDisk.filter((t) => t.prompt === 'repaired copy').length, 1, 'the operator\'s repair is not lost')
      assert.equal(store.get('same').prompt, 'live copy', 'and it is not armed over the live task')
      assert.equal(store.get('same').lastRun.status, 'success')
    })

    it('Codex 4: a FAILED discard leaves the entry in memory, so it cannot erase another entry\'s repair', () => {
      const idless = (prompt) => ({ prompt, cadence: { kind: 'once', at: TYPO_EPOCH } })
      writeFile([idless('first'), idless('second')])
      const store = newStore(() => 1000).load()
      const [first] = store.listUnreadable()

      breakWrites()
      assert.throws(() => store.discardUnreadable(first.handle), /could not|failed|write/i, 'the failure is reported, not swallowed')
      assert.equal(store.unreadableCount(), 2, 'the entry is back in memory')
      fixWrites()

      writeFile(readTasks().map((t) => (t.prompt === 'second' ? { ...t, prompt: 'second, edited' } : t)))
      unrelated(store)

      const prompts = readTasks().map((t) => t.prompt).filter((p) => p !== 'unrelated').sort()
      assert.deepEqual(prompts, ['first', 'second, edited'], 'the repair of the other entry survives')
    })

    it('a failed remove() of a live task is reported and the task is restored', () => {
      writeFile([live('A')])
      const store = newStore(() => 1000).load()
      breakWrites()
      assert.throws(() => store.remove('A'))
      assert.ok(store.get('A'), 'still scheduled in memory')
      fixWrites()
      assert.equal(store.remove('A'), true)
    })

    it('a failed remove() of a preserved entry is reported and the entry is restored', () => {
      writeFile([bad('B')])
      const store = newStore(() => 1000).load()
      breakWrites()
      assert.throws(() => store.remove('B'))
      assert.equal(store.unreadableCount(), 1)
    })

    it('#8523: a READABLE task hand-added while the daemon runs survives the next save', () => {
      writeFile([live('A')])
      const store = newStore(() => 1000).load()
      writeFile([...readTasks(), live('hand-added', { prompt: 'added by hand' })])
      unrelated(store)

      assert.equal(store.get('hand-added').prompt, 'added by hand', 'adopted')
      assert.ok(readTasks().some((t) => t.id === 'hand-added'))
    })

    it('#8523: an UNREADABLE entry hand-added while the daemon runs is preserved, and visible', () => {
      writeFile([live('A')])
      const store = newStore(() => 1000).load()
      writeFile([...readTasks(), bad('hand-bad')])
      unrelated(store)

      assert.equal(store.get('hand-bad'), null)
      assert.equal(store.unreadableCount(), 1)
      assert.ok(readTasks().some((t) => t.id === 'hand-bad'), 'still on disk')
    })

    it('an operator edit of a LIVE task is kept as an unreadable duplicate; the live task is never overwritten', () => {
      writeFile([live('A')])
      const store = newStore(() => 1000).load()
      writeFile(readTasks().map((t) => ({ ...t, prompt: 'edited behind the daemon' })))
      unrelated(store)

      assert.equal(store.get('A').prompt, 'live A')
      assert.equal(store.unreadableCount(), 1)
      assert.match(store.listUnreadable()[0].reason, /duplicate/i)
      assert.ok(readTasks().some((t) => t.prompt === 'edited behind the daemon'), 'their content is not lost')
    })

    it('a write that FAILS leaves reconciliation consistent: a hand-added entry is not forgotten as "known"', () => {
      writeFile([live('A')])
      const store = newStore(() => 1000).load()
      writeFile([...readTasks(), live('hand-added')])

      breakWrites()
      unrelated(store) // reconciles, then the write fails (add() logs it)
      fixWrites()
      unrelated(store) // a retry must still see 'hand-added' as the operator\'s

      assert.ok(readTasks().some((t) => t.id === 'hand-added'), 'not erased by the retry')
      assert.ok(store.get('hand-added'), 'and adopted exactly once')
      assert.equal(readTasks().filter((t) => t.id === 'hand-added').length, 1)
    })

    it('an operator deleting a LIVE task\'s entry by hand does not delete the task (the daemon owns it)', () => {
      writeFile([live('A'), live('B')])
      const store = newStore(() => 1000).load()
      writeFile(readTasks().filter((t) => t.id !== 'B'))
      unrelated(store)
      assert.ok(store.get('B'), 'a live task is the daemon\'s: its file entry is rewritten from memory')
    })
  })

  // #7079 — a preserved entry must be visible and discardable without hand-editing.
  // The wire cap on a task id is correct and is NOT widened, so the operator
  // addresses an unreadable entry by a server-derived opaque HANDLE instead.
  describe('#7079 unreadable entries are addressable by an opaque handle', () => {
    const TYPO_EPOCH = 1795000000000000000
    const cron = (expression = '*/5 * * * *') => ({ kind: 'cron', expression })
    const live = (id = 'good') => ({ id, prompt: 'keep me', cadence: cron(), createdAt: 1, updatedAt: 1 })
    const bad = (over = {}) => ({
      id: 'typo', prompt: 'SECRET PROMPT TEXT', cadence: { kind: 'once', at: TYPO_EPOCH }, createdAt: 1, updatedAt: 1, ...over,
    })
    const writeFile = (tasks) => writeFileSync(filePath, JSON.stringify({ version: 1, tasks }))
    const readTasks = () => JSON.parse(readFileSync(filePath, 'utf-8')).tasks

    it('every unreadable entry has a handle: 16 lowercase hex, deterministic across reloads', () => {
      writeFile([live(), bad()])
      const a = newStore(() => 1000).load().listUnreadable()
      const b = newStore(() => 5000).load().listUnreadable()
      assert.equal(a.length, 1)
      assert.match(a[0].handle, /^[0-9a-f]{16}$/)
      assert.equal(a[0].handle, b[0].handle, 'derived from the entry\'s content, so stable across restarts')
    })

    it('the handle is derived from canonical JSON: key order does not change it, content does', () => {
      writeFile([bad()])
      const h1 = newStore().load().listUnreadable()[0].handle
      writeFile([{ updatedAt: 1, createdAt: 1, cadence: { at: TYPO_EPOCH, kind: 'once' }, prompt: 'SECRET PROMPT TEXT', id: 'typo' }])
      const h2 = newStore().load().listUnreadable()[0].handle
      writeFile([bad({ prompt: 'different' })])
      const h3 = newStore().load().listUnreadable()[0].handle
      assert.equal(h1, h2)
      assert.notEqual(h1, h3)
    })

    it('listUnreadable never carries raw contents (the prompt text is not in any row)', () => {
      writeFile([live(), bad()])
      const rows = newStore().load().listUnreadable()
      assert.ok(!JSON.stringify(rows).includes('SECRET PROMPT TEXT'))
    })

    it('two byte-identical unreadable entries still get distinct handles', () => {
      writeFile([bad(), bad()])
      const rows = newStore().load().listUnreadable()
      assert.equal(rows.length, 2)
      assert.notEqual(rows[0].handle, rows[1].handle, 'a duplicate must remain individually addressable')
    })

    it('discardUnreadable(handle) removes the entry from memory AND from disk, and leaves live tasks alone', () => {
      writeFile([live(), bad()])
      const store = newStore(() => 1000).load()
      const [{ handle }] = store.listUnreadable()
      assert.equal(store.discardUnreadable(handle), true)
      assert.equal(store.unreadableCount(), 0)
      assert.deepEqual(readTasks().map((t) => t.id), ['good'])
      assert.ok(store.get('good'))
    })

    it('discarding one of two byte-identical entries removes exactly one', () => {
      writeFile([bad(), bad()])
      const store = newStore(() => 1000).load()
      const [first] = store.listUnreadable()
      assert.equal(store.discardUnreadable(first.handle), true)
      assert.equal(store.unreadableCount(), 1)
      assert.equal(readTasks().length, 1)
    })

    it('an unknown, stale or malformed handle discards nothing and reports false', () => {
      writeFile([live(), bad()])
      const store = newStore(() => 1000).load()
      for (const h of ['0000000000000000', 'typo', '', null, undefined, 42, {}, ['x']]) {
        assert.equal(store.discardUnreadable(h), false, `handle ${JSON.stringify(h)}`)
      }
      assert.equal(store.unreadableCount(), 1)
      assert.ok(readTasks().some((t) => t.id === 'typo'))
    })

    it('the id is NOT a handle: a live task\'s id can never be discarded through this path', () => {
      writeFile([live(), bad()])
      const store = newStore(() => 1000).load()
      assert.equal(store.discardUnreadable('good'), false)
      assert.ok(store.get('good'))
    })

    it('discarding after the operator edited the file refuses a stale handle (the operator\'s edit is never discarded blind)', () => {
      writeFile([live(), bad()])
      const store = newStore(() => 1000).load()
      const [{ handle: stale }] = store.listUnreadable()
      writeFileSync(filePath, JSON.stringify({ version: 1, tasks: [live(), bad({ prompt: 'operator rewrote this' })] }))

      assert.equal(store.discardUnreadable(stale), false, 'the entry the operator saw is not the entry now on disk')
      assert.ok(readTasks().some((t) => t.prompt === 'operator rewrote this'), 'their edit is still there')
      const [fresh] = store.listUnreadable()
      assert.notEqual(fresh.handle, stale, 'and the refreshed list carries the new handle')
      assert.equal(store.discardUnreadable(fresh.handle), true)
    })

    it('discarding one id-less entry does not make its sibling inherit the discarded content', () => {
      const idless = (prompt) => ({ prompt, cadence: { kind: 'once', at: TYPO_EPOCH } })
      writeFile([idless('first'), idless('second')])
      const store = newStore(() => 1000).load()
      const [first] = store.listUnreadable() // load order: 'first' is row 0

      // The operator edits the SECOND entry on disk, then discards the FIRST.
      writeFile(readTasks().map((t) => (t.prompt === 'second' ? { ...t, prompt: 'second, edited' } : t)))
      assert.equal(store.discardUnreadable(first.handle), true)

      assert.deepEqual(readTasks().map((t) => t.prompt), ['second, edited'], 'the sibling keeps ITS edit, not the discarded content')
      assert.equal(store.unreadableCount(), 1)
    })

    it('remove(id) of a preserved entry acts on the file as it is NOW (an edited sibling is not paired with the removed copy)', () => {
      const idless = (prompt) => ({ prompt, cadence: { kind: 'once', at: TYPO_EPOCH } })
      writeFile([bad({ id: 'a' }), idless('sibling')])
      const store = newStore(() => 1000).load()
      // The operator edits the id-less sibling on disk; then 'a' is removed by id.
      writeFile(readTasks().map((t) => (t.prompt === 'sibling' ? { ...t, prompt: 'sibling, edited' } : t)))

      assert.equal(store.remove('a'), true)
      assert.deepEqual(readTasks().map((t) => t.prompt), ['sibling, edited'], 'the sibling keeps its edit; the removed entry is gone')
      assert.equal(store.unreadableCount(), 1)
    })

    it('FULL LOOP: unreadable present -> reported -> discarded -> gone from disk and from the next load', () => {
      writeFile([live(), bad()])
      const store = newStore(() => 1000).load()
      assert.equal(store.unreadableCount(), 1, 'the operator can see it')
      const [{ handle }] = store.listUnreadable()
      store.discardUnreadable(handle)
      assert.deepEqual(readTasks().map((t) => t.id), ['good'])
      const reloaded = newStore(() => 1000).load()
      assert.equal(reloaded.unreadableCount(), 0)
      assert.deepEqual(reloaded.listUnreadable(), [])
    })
  })

  // #7051 — a cron expression the WIRE cannot carry must never enter the
  // registry. ScheduledTaskCadenceCronSchema caps `expression` at 256; the store
  // had no cap at all, so a longer-but-valid cron was store-legal and
  // wire-ILLEGAL. Blast radius is the whole panel, not one row: the dashboard
  // safeParses the entire `scheduled_tasks` snapshot, so ONE such task makes it
  // render zero tasks (plus "may be out of date") while N are armed and firing.
  //
  // REJECT rather than clamp, unlike the string fields projectTask truncates:
  // truncating a cron silently CHANGES THE SCHEDULE, which is worse than
  // refusing it.
  describe('#7051 cron expression wire cap', () => {
    // Fully enumerated minute/hour/day-of-month lists — 319 chars, and every
    // field is legal, so LENGTH is the only thing that can reject it. The
    // self-check below pins that: a fixture that quietly fell under the cap
    // would make the rejection tests fail for an unrelated reason.
    const LONG_VALID_CRON = [
      Array.from({ length: 60 }, (_, i) => i).join(','),
      Array.from({ length: 24 }, (_, i) => i).join(','),
      Array.from({ length: 31 }, (_, i) => i + 1).join(','),
      '*',
      '*',
    ].join(' ')

    const cronOfExactLength = (target) => {
      // '<minute-list> * * * *' — the tail is 8 chars, so the list carries the
      // rest. Mixing 1- and 2-digit entries hits any length exactly.
      const want = target - 8
      for (let k = 1; k < 400; k++) {
        for (let j = 0; j <= k; j++) {
          if (3 * k - j - 1 === want) {
            return [...Array(k)].map((_, i) => (i < j ? '1' : '59')).join(',') + ' * * * *'
          }
        }
      }
      throw new Error(`cannot build a cron of length ${target}`)
    }

    it('the fixture is a VALID cron that is merely too long (length is the only defect)', () => {
      assert.ok(LONG_VALID_CRON.length > 256, `fixture must exceed the cap, got ${LONG_VALID_CRON.length}`)
      assert.doesNotThrow(() => parseCron(LONG_VALID_CRON), 'fixture must parse — otherwise the test proves nothing about the cap')
    })

    it('add() rejects a cron expression longer than the wire cap', () => {
      const store = newStore(() => 1000)
      assert.throws(
        () => store.add({ prompt: 'x', cadence: { kind: 'cron', expression: LONG_VALID_CRON } }),
        (err) => err instanceof ScheduledTaskValidationError && err.field === 'cadence.expression',
        'a store-legal / wire-illegal cron must be refused at the boundary',
      )
    })

    it('accepts a cron expression of exactly the cap length (the bound is inclusive)', () => {
      const store = newStore(() => 1000)
      const atCap = cronOfExactLength(256)
      // Assert the EXACT length: a fixture that drifted shorter would still pass
      // the add() below while no longer testing the boundary at all.
      assert.equal(atCap.length, 256)
      assert.doesNotThrow(() => store.add({ prompt: 'x', cadence: { kind: 'cron', expression: atCap } }))
    })

    // The reachable path today: ~/.chroxy/scheduled-tasks.json edited by hand,
    // or a non-WS writer. _normalizeStoredTask must refuse it too, or the
    // snapshot breaks for every client despite add() being guarded.
    //
    // These two cases share one fixture writer and differ ONLY in the cron, so
    // the control below is what gives the drop case its meaning. The first
    // version of this test wrote `{ v: 1 }` instead of `{ version: 1 }`; the
    // store's version gate then ignored the whole file, `list()` was empty for
    // a reason that had nothing to do with the cap, and the test passed with
    // the cap guard deleted. The control fails loudly on that mistake.
    const writeRegistryWithCron = (expression) => {
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        tasks: [{ id: 'a', prompt: 'x', cadence: { kind: 'cron', expression }, createdAt: 1, updatedAt: 1 }],
      }))
      // .load() is explicit — the constructor does NOT read the file.
      return newStore(() => 1000).load()
    }

    // Drift guard. The store's cap is a HAND-COPIED constant; the wire schema is
    // the real authority. This asserts the two boundaries coincide by comparing
    // behaviour at exactly 256 and exactly 257 chars, so raising/lowering
    // ScheduledTaskCadenceCronSchema without touching MAX_CRON_EXPRESSION_LENGTH
    // (or vice versa) fails here rather than silently reopening the bug.
    it('the store cap and the wire schema agree at the boundary (drift guard)', () => {
      const store = newStore(() => 1000)
      for (const len of [256, 257]) {
        const expression = cronOfExactLength(len)
        assert.equal(expression.length, len, 'builder must hit the length exactly')
        assert.doesNotThrow(() => parseCron(expression), `len ${len} must be a valid cron`)

        const wireOk = ScheduledTaskCadenceCronSchema.safeParse({ kind: 'cron', expression }).success
        let storeOk = true
        try {
          store.add({ prompt: 'x', cadence: { kind: 'cron', expression } })
        } catch (err) {
          assert.ok(
            err instanceof ScheduledTaskValidationError && err.field === 'cadence.expression',
            `expected a cron-cap rejection at ${len} chars, got ${err?.message}`,
          )
          storeOk = false
        }
        assert.equal(
          storeOk,
          wireOk,
          `at ${len} chars the store (${storeOk ? 'accepts' : 'rejects'}) and the wire schema ` +
          `(${wireOk ? 'accepts' : 'rejects'}) disagree — MAX_CRON_EXPRESSION_LENGTH has drifted ` +
          'from ScheduledTaskCadenceCronSchema',
        )
      }
    })

    it('CONTROL: the registry fixture loads when the cron is short (so the drop below means something)', () => {
      assert.equal(writeRegistryWithCron('*/5 * * * *').list().length, 1)
    })

    it('padding is not counted against the cap, and cannot sneak past it', () => {
      const store = newStore(() => 1000)
      // Whitespace is stripped before storing, so an at-cap expression stays
      // legal however it is padded...
      const atCap = cronOfExactLength(256)
      const t = store.add({ prompt: 'x', cadence: { kind: 'cron', expression: `   ${atCap}   ` } })
      assert.equal(t.cadence.expression, atCap, 'the stored expression must be the trimmed one')
      // ...and padding an over-cap expression does not make it legal either.
      assert.throws(
        () => store.add({ prompt: 'x', cadence: { kind: 'cron', expression: `  ${cronOfExactLength(257)}  ` } }),
        (err) => err instanceof ScheduledTaskValidationError && err.field === 'cadence.expression',
      )
    })

    it('a hand-edited registry file with an over-cap cron is rejected on load, not served', () => {
      const store = writeRegistryWithCron(LONG_VALID_CRON)
      assert.deepEqual(store.list(), [], 'an unrepresentable task must be dropped on load rather than served to clients')
    })
  })

  // #6871 review (C3) — an epoch outside the representable Date range is finite,
  // so a finiteness-only check let it be stored and served. It then crashed the
  // dashboard panel during render (`new Date(1e16).toISOString()` throws
  // RangeError), taking the whole dashboard down via the root error boundary.
  // Rejecting it here keeps an unrenderable instant out of the registry.
  describe('#6871 review — out-of-Date-range epochs are rejected', () => {
    const OUT_OF_RANGE = 1e16 // finite, but > 8.64e15 → an Invalid Date

    it('add() rejects a `once` cadence whose `at` cannot be represented', () => {
      const store = newStore(() => 1000)
      assert.throws(
        () => store.add({ prompt: 'x', cadence: { kind: 'once', at: OUT_OF_RANGE } }),
        (err) => err instanceof ScheduledTaskValidationError && err.field === 'cadence.at',
      )
      assert.throws(
        () => store.add({ prompt: 'x', cadence: { kind: 'once', at: -OUT_OF_RANGE } }),
        ScheduledTaskValidationError,
      )
    })

    it('add() rejects an interval anchor that cannot be represented', () => {
      const store = newStore(() => 1000)
      assert.throws(
        () => store.add({ prompt: 'x', cadence: { kind: 'interval', everyMs: HOUR, anchor: OUT_OF_RANGE } }),
        (err) => err instanceof ScheduledTaskValidationError && err.field === 'cadence.anchor',
      )
    })

    it('the bound admits every LEGITIMATE instant, including the exact limit', () => {
      // Nothing real is refused: 8.64e15 ms is the year 275760.
      const store = newStore(() => 1000)
      assert.ok(store.add({ prompt: 'a', cadence: { kind: 'once', at: Date.now() + HOUR } }))
      assert.ok(store.add({ prompt: 'b', cadence: { kind: 'once', at: 8.64e15 } }))
      assert.ok(store.add({ prompt: 'c', cadence: { kind: 'once', at: -8.64e15 } }))
      assert.ok(store.add({ prompt: 'd', cadence: { kind: 'interval', everyMs: HOUR, anchor: 0 } }))
    })

    it('load() DROPS a hand-edited out-of-range task without nuking its siblings', () => {
      // The registry is a user-writable file, so a pre-existing bad record must
      // degrade to one dropped task, not an empty scheduler.
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        tasks: [
          { id: 'good', prompt: 'ok', cadence: { kind: 'cron', expression: '0 9 * * *' }, createdAt: 1, updatedAt: 1 },
          { id: 'bad', prompt: 'boom', cadence: { kind: 'once', at: OUT_OF_RANGE }, createdAt: 1, updatedAt: 1 },
        ],
      }))
      const tasks = newStore(() => 1000).load().list()
      assert.deepEqual(tasks.map((t) => t.id), ['good'])
    })
  })

  it('defaultScheduledTasksPath sits next to the state file', () => {
    assert.equal(defaultScheduledTasksPath('/home/x/.chroxy/session-state.json'), '/home/x/.chroxy/scheduled-tasks.json')
  })

  it('add() assigns id/timestamps, computes nextRun, and persists', () => {
    const store = newStore(() => 1000)
    const task = store.add({
      prompt: 'run the nightly report',
      cadence: { kind: 'interval', everyMs: HOUR },
      target: { provider: 'claude', model: 'sonnet', cwd: '/proj', permissionMode: 'plan' },
    })
    assert.ok(task.id, 'id assigned')
    assert.equal(task.enabled, true)
    assert.equal(task.createdAt, 1000)
    assert.equal(task.updatedAt, 1000)
    assert.equal(task.nextRun, 1000 + HOUR, 'interval nextRun anchored on createdAt')
    assert.deepEqual(task.target, { provider: 'claude', model: 'sonnet', cwd: '/proj', permissionMode: 'plan' })
    assert.equal(task.lastRun, null)
    assert.ok(existsSync(filePath), 'file written')
  })

  it('add() rejects invalid input with ScheduledTaskValidationError', () => {
    const store = newStore()
    assert.throws(() => store.add({ cadence: { kind: 'interval', everyMs: HOUR } }), ScheduledTaskValidationError) // no prompt
    assert.throws(() => store.add({ prompt: 'x' }), ScheduledTaskValidationError) // no cadence
    assert.throws(() => store.add({ prompt: 'x', cadence: { kind: 'interval', everyMs: 10 } }), ScheduledTaskValidationError) // everyMs below the MIN_INTERVAL_MS floor (1000ms)
    assert.throws(() => store.add({ prompt: 'x', cadence: { kind: 'cron', expression: 'bad cron' } }), ScheduledTaskValidationError) // bad cron
    assert.throws(() => store.add({ prompt: 'x', cadence: { kind: 'once' } }), ScheduledTaskValidationError) // once without `at`
    assert.throws(() => store.add({ prompt: 'x', cadence: { kind: 'weekly' } }), ScheduledTaskValidationError) // unknown kind
  })

  it('normalizeTarget rejects a non-plain-object target (array, etc.)', () => {
    const store = newStore()
    // `typeof [] === 'object'` must NOT slip an array through as a valid target.
    assert.throws(
      () => store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 }, target: ['claude'] }),
      ScheduledTaskValidationError,
    )
    // update() path is equally strict.
    const t = store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 } })
    assert.throws(() => store.update(t.id, { target: [] }), ScheduledTaskValidationError)
  })

  it('normalizeTarget rejects an unknown permissionMode', () => {
    const store = newStore()
    assert.throws(
      () => store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 }, target: { permissionMode: 'yolo' } }),
      ScheduledTaskValidationError,
    )
    const t = store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 } })
    assert.throws(
      () => store.update(t.id, { target: { permissionMode: 'not-a-mode' } }),
      ScheduledTaskValidationError,
    )
  })

  it('normalizeTarget accepts every supported permissionMode', () => {
    const store = newStore()
    for (const mode of ['approve', 'acceptEdits', 'auto', 'plan']) {
      const t = store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 }, target: { permissionMode: mode } })
      assert.equal(t.target.permissionMode, mode, `permissionMode ${mode} accepted`)
    }
  })

  it('load() drops a task with an invalid target permissionMode but keeps valid siblings', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      tasks: [
        { id: 'ok', prompt: 'p', cadence: { kind: 'once', at: 1 }, target: { permissionMode: 'plan' }, createdAt: 0, updatedAt: 0 },
        { id: 'bad-mode', prompt: 'p', cadence: { kind: 'once', at: 1 }, target: { permissionMode: 'bogus' }, createdAt: 0, updatedAt: 0 },
        { id: 'bad-target', prompt: 'p', cadence: { kind: 'once', at: 1 }, target: ['nope'], createdAt: 0, updatedAt: 0 },
      ],
    }))
    const store = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store.list().map((t) => t.id), ['ok'], 'only the valid task survives')
  })

  it('get()/list() return copies that cannot mutate stored state', () => {
    const store = newStore()
    const added = store.add({ prompt: 'p', cadence: { kind: 'once', at: 5000 } })
    const fetched = store.get(added.id)
    fetched.prompt = 'MUTATED'
    fetched.target.provider = 'evil'
    assert.equal(store.get(added.id).prompt, 'p', 'stored prompt untouched')
    assert.equal(store.get(added.id).target.provider, undefined)
    assert.equal(store.get('nope'), null)
    assert.equal(store.list().length, 1)
  })

  it('update() patches fields, recomputes nextRun, bumps updatedAt, keeps id/createdAt', () => {
    let clock = 1000
    const store = newStore(() => clock)
    const t = store.add({ prompt: 'p', cadence: { kind: 'interval', everyMs: HOUR } })
    clock = 2000
    const updated = store.update(t.id, { cadence: { kind: 'interval', everyMs: 2 * HOUR }, enabled: false, name: 'nightly' })
    assert.equal(updated.id, t.id)
    assert.equal(updated.createdAt, 1000, 'createdAt immutable')
    assert.equal(updated.updatedAt, 2000, 'updatedAt bumped')
    assert.equal(updated.name, 'nightly')
    assert.equal(updated.enabled, false)
    assert.equal(updated.nextRun, null, 'disabled -> nextRun null')
    assert.equal(store.update('missing', { name: 'x' }), null)
  })

  it('update() can set a lastRun stub (engine #6865 territory) and advances nextRun', () => {
    let clock = 0
    const store = newStore(() => clock)
    const t = store.add({ prompt: 'p', cadence: { kind: 'interval', everyMs: HOUR } })
    clock = HOUR + 5
    const updated = store.update(t.id, { lastRun: { at: HOUR, status: 'success', sessionId: 'sess-9' } })
    assert.deepEqual(updated.lastRun, { at: HOUR, status: 'success', sessionId: 'sess-9' })
    assert.equal(updated.nextRun, 2 * HOUR, 'nextRun advanced to the next boundary after now')
    assert.throws(() => store.update(t.id, { lastRun: { at: 1, status: 'bogus' } }), ScheduledTaskValidationError)
  })

  it('accepts every status the engine can emit, including `interrupted` (#7038)', () => {
    // The store is the LAST gate before a run outcome is persisted, and it
    // throws on an unknown status — which `_recordRun` turns into a QUARANTINE
    // (scheduler.js: "its run outcome could not be recorded"). So an engine
    // status the store has not been taught does not merely fail to persist: it
    // permanently stops the task from firing for the rest of the process.
    const store = newStore(() => 0)
    for (const status of ['success', 'error', 'skipped', 'timeout', 'refused', 'interrupted']) {
      const t = store.add({ prompt: 'p', cadence: { kind: 'interval', everyMs: HOUR } })
      const updated = store.update(t.id, { lastRun: { at: 1, status } })
      assert.equal(updated.lastRun.status, status, `${status} must round-trip through the store`)
    }
  })

  it('remove() deletes and persists; returns false for an unknown id', () => {
    const store = newStore()
    const t = store.add({ prompt: 'p', cadence: { kind: 'once', at: 9999 } })
    assert.equal(store.remove(t.id), true)
    assert.equal(store.get(t.id), null)
    assert.equal(store.remove(t.id), false)
  })

  it('survives a simulated restart: a NEW store reads persisted tasks', () => {
    const store1 = newStore(() => 1000)
    const a = store1.add({ prompt: 'a', cadence: { kind: 'cron', expression: '0 9 * * *' } })
    const b = store1.add({ prompt: 'b', cadence: { kind: 'interval', everyMs: HOUR } })

    const store2 = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    const ids = store2.list().map((t) => t.id).sort()
    assert.deepEqual(ids, [a.id, b.id].sort())
    assert.equal(store2.get(a.id).prompt, 'a')
    assert.equal(store2.get(a.id).cadence.expression, '0 9 * * *')
    assert.ok(Number.isFinite(store2.get(a.id).nextRun), 'cron nextRun recomputed on load')
  })

  it('load() recomputes nextRun rather than trusting a stale stored value', () => {
    // Hand-write a file whose stored nextRun is deliberately wrong.
    const bogus = {
      version: 1,
      tasks: [{
        id: 'fixed', name: null, enabled: true, prompt: 'p',
        target: {}, cadence: { kind: 'interval', everyMs: HOUR, anchor: 0 },
        nextRun: 999999999, lastRun: null, createdAt: 0, updatedAt: 0,
      }],
    }
    writeFileSync(filePath, JSON.stringify(bogus))
    const store = new ScheduledTaskStore({ filePath, logger: silentLog, now: () => 10 }).load()
    assert.equal(store.get('fixed').nextRun, HOUR, 'nextRun recomputed from cadence, not the stored 999999999')
  })

  it('writes atomically (temp+rename) with 0600 perms and no leftover temp', () => {
    const store = newStore()
    store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 } })
    const mode = statSync(filePath).mode & 0o777
    // Windows does not honour POSIX mode bits; assert only on POSIX.
    if (process.platform !== 'win32') assert.equal(mode, 0o600, 'file is owner-only')
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
    assert.deepEqual(leftovers, [], 'no orphaned temp file')
  })

  it('missing file loads as an empty store', () => {
    const store = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store.list(), [])
  })

  it('corrupt JSON fails open to empty (does not throw)', () => {
    writeFileSync(filePath, '{ this is not json')
    const store = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store.list(), [])
  })

  it('an unknown version is skipped whole (fail-open)', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 999,
      tasks: [{ id: 'x', prompt: 'p', cadence: { kind: 'once', at: 1 }, createdAt: 0, updatedAt: 0 }],
    }))
    const store = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store.list(), [])
  })

  it('drops individual malformed entries but keeps valid siblings', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      tasks: [
        { id: 'good', prompt: 'p', cadence: { kind: 'once', at: 1 }, createdAt: 0, updatedAt: 0 },
        { id: 'no-prompt', cadence: { kind: 'once', at: 1 }, createdAt: 0, updatedAt: 0 },
        { id: 'bad-cadence', prompt: 'p', cadence: { kind: 'cron', expression: 'garbage' }, createdAt: 0, updatedAt: 0 },
        { prompt: 'p', cadence: { kind: 'once', at: 1 } }, // no id
        { id: 'good', prompt: 'dup', cadence: { kind: 'once', at: 2 }, createdAt: 0, updatedAt: 0 }, // duplicate id
      ],
    }))
    const store = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    const ids = store.list().map((t) => t.id)
    assert.deepEqual(ids, ['good'], 'only the first valid task survives')
    assert.equal(store.get('good').prompt, 'p', 'the duplicate did not overwrite')
  })

  it('load() replaces in-memory state (no stale re-persist)', () => {
    const store = newStore()
    store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 } })
    assert.equal(store.list().length, 1)
    // Blow the file away, reload — the in-memory task must not survive.
    rmSync(filePath)
    store.load()
    assert.deepEqual(store.list(), [])
  })

  it('a caller-supplied id is honoured and collisions are rejected', () => {
    const store = newStore()
    const t = store.add({ id: 'my-id', prompt: 'p', cadence: { kind: 'once', at: 1 } })
    assert.equal(t.id, 'my-id')
    assert.throws(() => store.add({ id: 'my-id', prompt: 'q', cadence: { kind: 'once', at: 2 } }), ScheduledTaskValidationError)
  })
})
