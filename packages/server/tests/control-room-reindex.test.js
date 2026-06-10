import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { handleSessionMessage, registeredMessageTypes } from '../src/ws-message-handlers.js'
import { createSpy } from './test-helpers.js'
import {
  parseRepoMemoryIndexCounts,
  runRepoMemoryIndex,
  CLI_MISSING_NOTE,
  INDEX_TIMEOUT_MS,
} from '../src/control-room/integrations.js'
import { ServerIntegrationActionAckSchema } from '@chroxy/protocol'

/**
 * Tests for the repo-memory Reindex action (#5500, epic #5498):
 *   - parseRepoMemoryIndexCounts / runRepoMemoryIndex (injected exec, no real
 *     subprocess)
 *   - the `integration_action` WS handler — host-level authority, repo-set
 *     membership validation by realpath BEFORE any exec, per-repo overlap
 *     rejection, global concurrency cap, ack/error correlation by requestId.
 */

// Verbatim stdout shape of `repo-memory index <root>` (verified empirically
// against the installed CLI — see formatReport in its index-command).
const INDEX_STDOUT = [
  'Indexed /home/user/Projects/chroxy',
  '  scanned:       412',
  '  summarized:    12',
  '  already fresh: 398',
  '  skipped:       2',
  '  elapsed:       3.51s',
  '  cache db:      /home/user/Projects/chroxy/.repo-memory/cache.db',
  '',
].join('\n')

describe('parseRepoMemoryIndexCounts (#5500)', () => {
  it('parses the scanned/summarized/fresh/skipped counts from the index report', () => {
    assert.deepEqual(parseRepoMemoryIndexCounts(INDEX_STDOUT), {
      scanned: 412,
      summarized: 12,
      fresh: 398,
      skipped: 2,
    })
  })

  it('returns null when any count line is missing (partial output is unparseable)', () => {
    const withoutSkipped = INDEX_STDOUT.split('\n').filter(l => !l.includes('skipped')).join('\n')
    assert.equal(parseRepoMemoryIndexCounts(withoutSkipped), null)
    assert.equal(parseRepoMemoryIndexCounts(''), null)
    assert.equal(parseRepoMemoryIndexCounts(null), null)
    assert.equal(parseRepoMemoryIndexCounts(undefined), null)
    assert.equal(parseRepoMemoryIndexCounts('totally unrelated output'), null)
  })

  it('does not confuse "summarized" with a hypothetical "unsummarized" line', () => {
    const tricky = 'Indexed /p\n  unsummarized: 9\n  scanned: 1\n  summarized: 2\n  already fresh: 3\n  skipped: 4\n'
    assert.deepEqual(parseRepoMemoryIndexCounts(tricky), { scanned: 1, summarized: 2, fresh: 3, skipped: 4 })
  })
})

describe('runRepoMemoryIndex (#5500)', () => {
  it('resolves the binary, runs `index <repoPath>` (NOT --quiet), and returns parsed counts', async () => {
    const execSpy = createSpy(async (file, args) => {
      if (file === 'which') return { stdout: '/usr/local/bin/repo-memory\n', stderr: '' }
      return { stdout: INDEX_STDOUT, stderr: '' }
    })
    const result = await runRepoMemoryIndex('/home/user/Projects/chroxy', { _execFile: execSpy })
    assert.deepEqual(result.counts, { scanned: 412, summarized: 12, fresh: 398, skipped: 2 })
    const indexCall = execSpy.calls.find(c => c[0] === '/usr/local/bin/repo-memory')
    assert.deepEqual(indexCall[1], ['index', '/home/user/Projects/chroxy'], 'must not pass --quiet — the counts come from the report')
    assert.equal(indexCall[2].timeout, INDEX_TIMEOUT_MS, 'index gets the generous 120s timeout, not the 20s survey one')
  })

  it('uses the bin override without probing the PATH', async () => {
    const execSpy = createSpy(async () => ({ stdout: INDEX_STDOUT, stderr: '' }))
    await runRepoMemoryIndex('/p/repo', { bin: '/opt/bin/repo-memory', _execFile: execSpy })
    assert.equal(execSpy.calls.some(c => c[0] === 'which'), false)
    assert.equal(execSpy.calls[0][0], '/opt/bin/repo-memory')
  })

  it('returns counts: null when the output is unparseable (instead of failing)', async () => {
    const execSpy = createSpy(async (file) => {
      if (file === 'which') return { stdout: '/usr/local/bin/repo-memory\n', stderr: '' }
      return { stdout: 'a future CLI changed its report format', stderr: '' }
    })
    const result = await runRepoMemoryIndex('/p/repo', { _execFile: execSpy })
    assert.equal(result.counts, null)
  })

  it('throws the CLI-missing note when the binary cannot be resolved', async () => {
    const execSpy = createSpy(async () => { throw new Error('which: not found') })
    await assert.rejects(
      () => runRepoMemoryIndex('/p/repo', { _execFile: execSpy }),
      err => err.message === CLI_MISSING_NOTE,
    )
  })

  it('throws a legible reason (first stderr line) when the index run fails', async () => {
    const execSpy = createSpy(async (file) => {
      if (file === 'which') return { stdout: '/usr/local/bin/repo-memory\n', stderr: '' }
      const err = new Error('Command failed')
      err.stderr = 'Error: project root does not exist or is not a directory: /p/repo\nstack...'
      throw err
    })
    await assert.rejects(
      () => runRepoMemoryIndex('/p/repo', { _execFile: execSpy }),
      err => /repo-memory index failed: Error: project root does not exist/.test(err.message),
    )
  })

  it('treats a timeout as failure with a reason', async () => {
    const execSpy = createSpy(async (file) => {
      if (file === 'which') return { stdout: '/usr/local/bin/repo-memory\n', stderr: '' }
      const err = new Error('spawn ETIMEDOUT')
      err.killed = true
      throw err
    })
    await assert.rejects(
      () => runRepoMemoryIndex('/p/repo', { _execFile: execSpy }),
      err => /repo-memory index failed: .*ETIMEDOUT/.test(err.message),
    )
  })
})

// ───────────────────────────────────────────────────────────────────────────
// integration_action handler
// ───────────────────────────────────────────────────────────────────────────

const REPO_SET = [
  { name: 'chroxy', path: '/home/user/Projects/chroxy' },
  { name: 'other', path: '/home/user/Projects/other' },
  { name: 'third', path: '/home/user/Projects/third' },
]

const COUNTS = { scanned: 412, summarized: 12, fresh: 398, skipped: 2 }

function makeActionCtx(overrides = {}) {
  const sendSpy = createSpy()
  return {
    send: sendSpy,
    config: { repos: [], controlRoomRoot: '/home/user/Projects' },
    resolveRepoSet: createSpy(() => REPO_SET.map(r => ({ ...r }))),
    runRepoMemoryIndex: createSpy(async () => ({ counts: { ...COUNTS } })),
    // Identity realpath by default — tests that exercise symlink/traversal
    // resolution inject their own mapping.
    realpath: createSpy(p => p),
    ...overrides,
    _send: sendSpy,
  }
}

function reindexMsg(over = {}) {
  return {
    type: 'integration_action',
    action: 'repo_memory_reindex',
    repoPath: '/home/user/Projects/chroxy',
    requestId: 'rx-1',
    ...over,
  }
}

describe('integration_action handler (#5500)', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeActionCtx()
    client = { id: 'client-R' }
    ws = {}
  })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('integration_action'))
    assert.equal(typeof controlRoomHandlers.integration_action, 'function')
  })

  it('replies with a schema-conformant integration_action_ack carrying the counts', async () => {
    await controlRoomHandlers.integration_action(ws, client, reindexMsg(), ctx)
    assert.equal(ctx._send.callCount, 1)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'integration_action_ack')
    assert.equal(payload.action, 'repo_memory_reindex')
    assert.equal(payload.repoPath, '/home/user/Projects/chroxy')
    assert.equal(payload.requestId, 'rx-1')
    assert.deepEqual(payload.counts, COUNTS)
    const parsed = ServerIntegrationActionAckSchema.safeParse(payload)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  })

  it('acks with counts: null when the index output was unparseable', async () => {
    ctx = makeActionCtx({ runRepoMemoryIndex: createSpy(async () => ({ counts: null })) })
    await controlRoomHandlers.integration_action(ws, client, reindexMsg(), ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'integration_action_ack')
    assert.equal(payload.counts, null)
    assert.ok(ServerIntegrationActionAckSchema.safeParse(payload).success)
  })

  it('rejects a session-bound client with INTEGRATION_ACTION_FAILED before any exec', async () => {
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.integration_action(ws, client, reindexMsg(), ctx)
    assert.equal(ctx.runRepoMemoryIndex.callCount, 0, 'must not exec for a bound client')
    assert.equal(ctx.resolveRepoSet.callCount, 0, 'must not even resolve the repo set')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.equal(payload.code, 'INTEGRATION_ACTION_FAILED')
    assert.equal(payload.requestId, 'rx-1')
    assert.equal(payload.repoPath, '/home/user/Projects/chroxy')
    assert.equal(payload.action, 'repo_memory_reindex')
    assert.match(payload.message, /host-level authority/)
  })

  it('rejects an unsupported action without exec (defence in depth behind the schema enum)', async () => {
    await controlRoomHandlers.integration_action(ws, client, reindexMsg({ action: 'rm_rf_slash' }), ctx)
    assert.equal(ctx.runRepoMemoryIndex.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'INTEGRATION_ACTION_FAILED')
    assert.match(payload.message, /[Uu]nsupported/)
  })

  it('rejects a repoPath outside the surveyed repo set before any exec', async () => {
    await controlRoomHandlers.integration_action(ws, client, reindexMsg({ repoPath: '/etc' }), ctx)
    assert.equal(ctx.runRepoMemoryIndex.callCount, 0, 'never exec a non-member path')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'INTEGRATION_ACTION_FAILED')
    assert.equal(payload.repoPath, '/etc')
    assert.match(payload.message, /not .*surveyed/i)
  })

  it('rejects a traversal path whose realpath escapes the repo set', async () => {
    // The dot-dot string is NOT a member; realpath collapses it to /etc.
    ctx = makeActionCtx({
      realpath: createSpy(p => (p.includes('..') ? '/etc' : p)),
    })
    await controlRoomHandlers.integration_action(
      ws, client, reindexMsg({ repoPath: '/home/user/Projects/chroxy/../../../../etc' }), ctx,
    )
    assert.equal(ctx.runRepoMemoryIndex.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'INTEGRATION_ACTION_FAILED')
  })

  it('accepts a symlink that realpaths to a surveyed repo, and runs against the canonical path', async () => {
    ctx = makeActionCtx({
      realpath: createSpy(p => (p === '/home/user/link-to-chroxy' ? '/home/user/Projects/chroxy' : p)),
    })
    await controlRoomHandlers.integration_action(ws, client, reindexMsg({ repoPath: '/home/user/link-to-chroxy' }), ctx)
    assert.equal(ctx.runRepoMemoryIndex.callCount, 1)
    const [ranPath] = ctx.runRepoMemoryIndex.lastCall
    assert.equal(ranPath, '/home/user/Projects/chroxy', 'exec targets the canonical realpath, not the client string')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'integration_action_ack')
    assert.equal(payload.repoPath, '/home/user/link-to-chroxy', 'ack echoes the client-supplied path for correlation')
  })

  it('rejects a repoPath whose realpath lookup fails (nonexistent path)', async () => {
    ctx = makeActionCtx({
      realpath: createSpy(p => {
        if (p === '/does/not/exist') throw new Error('ENOENT')
        return p
      }),
    })
    await controlRoomHandlers.integration_action(ws, client, reindexMsg({ repoPath: '/does/not/exist' }), ctx)
    assert.equal(ctx.runRepoMemoryIndex.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'INTEGRATION_ACTION_FAILED')
  })

  it('passes the configured repo-memory bin override to the runner', async () => {
    ctx = makeActionCtx({
      config: { repos: [], controlRoomRoot: '/home/user/Projects', controlRoomRepoMemoryBin: '/opt/bin/repo-memory' },
    })
    await controlRoomHandlers.integration_action(ws, client, reindexMsg(), ctx)
    const [, opts] = ctx.runRepoMemoryIndex.lastCall
    assert.equal(opts.bin, '/opt/bin/repo-memory')
  })

  it('replies INTEGRATION_ACTION_FAILED with the reason when the index run throws', async () => {
    ctx = makeActionCtx({
      runRepoMemoryIndex: createSpy(async () => { throw new Error('repo-memory index failed: boom') }),
    })
    await controlRoomHandlers.integration_action(ws, client, reindexMsg(), ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.equal(payload.code, 'INTEGRATION_ACTION_FAILED')
    assert.equal(payload.requestId, 'rx-1')
    assert.match(payload.message, /boom/)
  })

  it('rejects an overlapping reindex on the SAME repo and recovers after the first settles', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeActionCtx({
      runRepoMemoryIndex: createSpy(async () => { await gate; return { counts: { ...COUNTS } } }),
    })
    const first = controlRoomHandlers.integration_action(ws, client, reindexMsg({ requestId: 'a' }), ctx)
    await controlRoomHandlers.integration_action(ws, client, reindexMsg({ requestId: 'b' }), ctx)
    assert.equal(ctx.runRepoMemoryIndex.callCount, 1, 'second reindex on the same repo must not exec')
    const rejected = ctx._send.calls.find(c => c[1].requestId === 'b')
    assert.equal(rejected[1].code, 'INTEGRATION_ACTION_FAILED')
    assert.match(rejected[1].message, /already in progress/i)
    release()
    await first
    const ackA = ctx._send.calls.find(c => c[1].requestId === 'a')
    assert.equal(ackA[1].type, 'integration_action_ack')
    // After the first settles, the same repo can be reindexed again.
    await controlRoomHandlers.integration_action(ws, client, reindexMsg({ requestId: 'c' }), ctx)
    assert.equal(ctx.runRepoMemoryIndex.callCount, 2)
  })

  it('an overlapping reindex on the same repo does NOT block a different repo', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeActionCtx({
      runRepoMemoryIndex: createSpy(async (path) => {
        if (path === '/home/user/Projects/chroxy') await gate
        return { counts: { ...COUNTS } }
      }),
    })
    const first = controlRoomHandlers.integration_action(ws, client, reindexMsg({ requestId: 'a' }), ctx)
    await controlRoomHandlers.integration_action(
      ws, client, reindexMsg({ repoPath: '/home/user/Projects/other', requestId: 'b' }), ctx,
    )
    const ackB = ctx._send.calls.find(c => c[1].requestId === 'b')
    assert.equal(ackB[1].type, 'integration_action_ack', 'other repo proceeds while chroxy is indexing')
    release()
    await first
  })

  it('caps global concurrency at 2 — a third concurrent reindex is rejected busy', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeActionCtx({
      runRepoMemoryIndex: createSpy(async () => { await gate; return { counts: { ...COUNTS } } }),
    })
    const p1 = controlRoomHandlers.integration_action(ws, client, reindexMsg({ requestId: 'a' }), ctx)
    const p2 = controlRoomHandlers.integration_action(
      ws, client, reindexMsg({ repoPath: '/home/user/Projects/other', requestId: 'b' }), ctx,
    )
    await controlRoomHandlers.integration_action(
      ws, client, reindexMsg({ repoPath: '/home/user/Projects/third', requestId: 'c' }), ctx,
    )
    assert.equal(ctx.runRepoMemoryIndex.callCount, 2, 'third index must not exec above the cap')
    const rejected = ctx._send.calls.find(c => c[1].requestId === 'c')
    assert.equal(rejected[1].code, 'INTEGRATION_ACTION_FAILED')
    assert.match(rejected[1].message, /busy/i)
    release()
    await Promise.all([p1, p2])
    // Cap frees up once the in-flight runs settle.
    await controlRoomHandlers.integration_action(
      ws, client, reindexMsg({ repoPath: '/home/user/Projects/third', requestId: 'd' }), ctx,
    )
    assert.equal(ctx.runRepoMemoryIndex.callCount, 3)
  })

  it('frees the in-flight slot even when the run throws', async () => {
    ctx = makeActionCtx({
      runRepoMemoryIndex: createSpy(async () => { throw new Error('exploded') }),
    })
    await controlRoomHandlers.integration_action(ws, client, reindexMsg({ requestId: 'a' }), ctx)
    await controlRoomHandlers.integration_action(ws, client, reindexMsg({ requestId: 'b' }), ctx)
    assert.equal(ctx.runRepoMemoryIndex.callCount, 2, 'a failed run must not wedge the per-repo slot')
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, reindexMsg({ requestId: 'reg' }), ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'integration_action_ack')
    assert.equal(payload.requestId, 'reg')
  })
})
