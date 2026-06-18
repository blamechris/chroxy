import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { handleSessionMessage } from '../src/ws-message-handlers.js'
import { createSpy, nsCtx } from './test-helpers.js'
import {
  runRepoRelayRerun,
  RERUN_TIMEOUT_MS,
  GH_MISSING_NOTE,
} from '../src/control-room/integrations.js'
import { ServerIntegrationActionAckSchema } from '@chroxy/protocol'

/**
 * Tests for the repo-relay Re-run action (#5502, epic #5498):
 *   - runRepoRelayRerun (injected exec, no real subprocess) — gh/remote
 *     derivation, the server-side runId RE-VALIDATION (re-fetch `gh run list`
 *     and require the id to be present AND concluded 'failure' before any
 *     `gh run rerun` exec), and legible failure reasons.
 *   - the `integration_action` WS handler with action `repo_relay_rerun` —
 *     same authority + repo-set gates as reindex (shared code path), the
 *     required-for-rerun runId validation, the SHARED per-repo in-flight /
 *     global-cap bucket, and ack/error correlation echoing the runId.
 */

const SLUG_REMOTE = 'git@github.com:blamechris/chroxy.git\n'
const RUN_LIST = JSON.stringify([
  { databaseId: 9002, conclusion: null, status: 'in_progress' },
  { databaseId: 9001, conclusion: 'failure', status: 'completed' },
  { databaseId: 9000, conclusion: 'success', status: 'completed' },
])

/** Injected exec fake covering the happy path; override per test. */
function makeExec(overrides = {}) {
  return createSpy(async (file, args) => {
    if (file === 'which') return { stdout: '/opt/homebrew/bin/gh\n', stderr: '' }
    if (file === 'git') {
      if (overrides.git) return overrides.git(args)
      return { stdout: SLUG_REMOTE, stderr: '' }
    }
    if (args[0] === 'run' && args[1] === 'list') {
      if (overrides.runList) return overrides.runList(args)
      return { stdout: RUN_LIST, stderr: '' }
    }
    if (args[0] === 'run' && args[1] === 'rerun') {
      if (overrides.rerun) return overrides.rerun(args)
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
  })
}

describe('runRepoRelayRerun (#5502)', () => {
  it('re-validates the runId against a fresh gh run list, then execs gh run rerun', async () => {
    const execSpy = makeExec()
    const result = await runRepoRelayRerun('/p/chroxy', 9001, { _execFile: execSpy })
    assert.deepEqual(result, { runId: 9001 })

    const listCall = execSpy.calls.find(c => c[1][0] === 'run' && c[1][1] === 'list')
    assert.deepEqual(listCall[1], [
      'run', 'list', '--workflow=repo-relay.yml', '-R', 'blamechris/chroxy',
      '--limit', '5', '--json', 'databaseId,conclusion,status',
    ], 'must re-fetch the exact window the survey surfaced')

    const rerunCall = execSpy.calls.find(c => c[1][0] === 'run' && c[1][1] === 'rerun')
    assert.equal(rerunCall[0], '/opt/homebrew/bin/gh')
    assert.deepEqual(rerunCall[1], ['run', 'rerun', '9001', '-R', 'blamechris/chroxy'])
    assert.equal(rerunCall[2].timeout, RERUN_TIMEOUT_MS, 'rerun gets the ~30s timeout')

    // The list re-fetch MUST happen before the rerun exec.
    const listIdx = execSpy.calls.indexOf(listCall)
    const rerunIdx = execSpy.calls.indexOf(rerunCall)
    assert.ok(listIdx < rerunIdx, 're-validation runs before the exec')
  })

  it('derives owner/repo from the git remote server-side (https form too)', async () => {
    const execSpy = makeExec({ git: () => ({ stdout: 'https://github.com/someorg/somerepo.git\n', stderr: '' }) })
    await runRepoRelayRerun('/p/somerepo', 9001, { _execFile: execSpy })
    const rerunCall = execSpy.calls.find(c => c[1][0] === 'run' && c[1][1] === 'rerun')
    assert.deepEqual(rerunCall[1], ['run', 'rerun', '9001', '-R', 'someorg/somerepo'])
    const gitCall = execSpy.calls.find(c => c[0] === 'git')
    assert.equal(gitCall[2].cwd, '/p/somerepo', 'remote read runs in the repo')
  })

  it('throws the gh-missing note when gh cannot be resolved (no exec attempted)', async () => {
    const execSpy = createSpy(async (file) => {
      if (file === 'which') throw new Error('not found')
      throw new Error('must not exec anything else')
    })
    await assert.rejects(
      () => runRepoRelayRerun('/p/chroxy', 9001, { _execFile: execSpy }),
      err => err.message === GH_MISSING_NOTE && err.reason === 'gh-missing',
    )
  })

  it('throws no-github-remote when the origin remote is missing or not GitHub', async () => {
    for (const git of [
      () => { throw new Error('fatal: no such remote') },
      () => ({ stdout: 'https://gitlab.com/x/y.git\n', stderr: '' }),
    ]) {
      const execSpy = makeExec({ git })
      await assert.rejects(
        () => runRepoRelayRerun('/p/chroxy', 9001, { _execFile: execSpy }),
        err => err.reason === 'no-github-remote' && /no GitHub remote/.test(err.message),
      )
      assert.equal(execSpy.calls.some(c => c[1][0] === 'run'), false, 'no gh run calls without a target')
    }
  })

  it('rejects a runId the fresh run list does not contain — never trusts the client id', async () => {
    const execSpy = makeExec()
    await assert.rejects(
      () => runRepoRelayRerun('/p/chroxy', 1234567, { _execFile: execSpy }),
      err => err.reason === 'unknown-run' && /1234567/.test(err.message) && /refresh/i.test(err.message),
    )
    assert.equal(execSpy.calls.some(c => c[1][0] === 'run' && c[1][1] === 'rerun'), false, 'must not exec rerun')
  })

  it('rejects a run that did not conclude failure (success and in-progress)', async () => {
    for (const [runId, statePattern] of [[9000, /success/], [9002, /in_progress/]]) {
      const execSpy = makeExec()
      await assert.rejects(
        () => runRepoRelayRerun('/p/chroxy', runId, { _execFile: execSpy }),
        err => err.reason === 'run-not-failed' && statePattern.test(err.message) && /only failed runs/i.test(err.message),
      )
      assert.equal(execSpy.calls.some(c => c[1][0] === 'run' && c[1][1] === 'rerun'), false)
    }
  })

  it('throws run-list-failed when the re-fetch fails or is unparseable', async () => {
    const failing = makeExec({ runList: () => { const e = new Error('boom'); e.stderr = 'HTTP 502\nmore'; throw e } })
    await assert.rejects(
      () => runRepoRelayRerun('/p/chroxy', 9001, { _execFile: failing }),
      err => err.reason === 'run-list-failed' && /gh run list failed: HTTP 502/.test(err.message),
    )
    const garbage = makeExec({ runList: () => ({ stdout: 'not json', stderr: '' }) })
    await assert.rejects(
      () => runRepoRelayRerun('/p/chroxy', 9001, { _execFile: garbage }),
      err => err.reason === 'run-list-failed' && /unparseable/.test(err.message),
    )
  })

  it('throws rerun-failed with the first stderr line when gh run rerun fails', async () => {
    const execSpy = makeExec({
      rerun: () => { const e = new Error('exit 1'); e.stderr = 'failed to rerun: run 9001 cannot be rerun\nstack'; throw e },
    })
    await assert.rejects(
      () => runRepoRelayRerun('/p/chroxy', 9001, { _execFile: execSpy }),
      err => err.reason === 'rerun-failed' && /gh run rerun failed: failed to rerun/.test(err.message),
    )
  })
})

// ───────────────────────────────────────────────────────────────────────────
// integration_action handler — repo_relay_rerun
// ───────────────────────────────────────────────────────────────────────────

const REPO_SET = [
  { name: 'chroxy', path: '/home/user/Projects/chroxy' },
  { name: 'other', path: '/home/user/Projects/other' },
  { name: 'third', path: '/home/user/Projects/third' },
]

function makeActionCtx(overrides = {}) {
  const sendSpy = createSpy()
  return nsCtx({
    send: sendSpy,
    config: { repos: [], controlRoomRoot: '/home/user/Projects' },
    resolveRepoSet: createSpy(() => REPO_SET.map(r => ({ ...r }))),
    runRepoRelayRerun: createSpy(async (repoPath, runId) => ({ runId })),
    runRepoMemoryIndex: createSpy(async () => ({ counts: null })),
    realpath: createSpy(p => p),
    ...overrides,
    _send: sendSpy,
  })
}

function rerunMsg(over = {}) {
  return {
    type: 'integration_action',
    action: 'repo_relay_rerun',
    repoPath: '/home/user/Projects/chroxy',
    runId: 9001,
    requestId: 'rr-1',
    ...over,
  }
}

describe('integration_action handler — repo_relay_rerun (#5502)', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeActionCtx()
    client = { id: 'client-RR' }
    ws = {}
  })

  it('replies with a schema-conformant ack echoing requestId/action/repoPath/runId (no counts)', async () => {
    await controlRoomHandlers.integration_action(ws, client, rerunMsg(), ctx)
    assert.equal(ctx._send.callCount, 1, 'exactly one reply')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'integration_action_ack')
    assert.equal(payload.action, 'repo_relay_rerun')
    assert.equal(payload.repoPath, '/home/user/Projects/chroxy')
    assert.equal(payload.requestId, 'rr-1')
    assert.equal(payload.runId, 9001)
    assert.equal(payload.counts, null)
    const parsed = ServerIntegrationActionAckSchema.safeParse(payload)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
    // The runner received the canonical path + the client runId as lookup key.
    assert.deepEqual(ctx.runRepoRelayRerun.lastCall.slice(0, 2), ['/home/user/Projects/chroxy', 9001])
  })

  it('rejects a session-bound client before any exec (same gate as reindex)', async () => {
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.integration_action(ws, client, rerunMsg(), ctx)
    assert.equal(ctx.runRepoRelayRerun.callCount, 0)
    assert.equal(ctx.resolveRepoSet.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'INTEGRATION_ACTION_FAILED')
    assert.equal(payload.action, 'repo_relay_rerun')
    assert.match(payload.message, /host-level authority/)
  })

  it('rejects a repoPath outside the surveyed repo set before any exec', async () => {
    await controlRoomHandlers.integration_action(ws, client, rerunMsg({ repoPath: '/etc' }), ctx)
    assert.equal(ctx.runRepoRelayRerun.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'INTEGRATION_ACTION_FAILED')
    assert.equal(payload.repoPath, '/etc')
  })

  it('rejects a missing or non-integer runId before any path resolution', async () => {
    for (const over of [{ runId: undefined }, { runId: null }, { runId: 1.5 }, { runId: -1 }, { runId: '9001' }]) {
      ctx = makeActionCtx()
      await controlRoomHandlers.integration_action(ws, client, rerunMsg(over), ctx)
      assert.equal(ctx.realpath.callCount, 0, `must reject before realpath for runId=${String(over.runId)}`)
      assert.equal(ctx.runRepoRelayRerun.callCount, 0)
      const [, payload] = ctx._send.lastCall
      assert.equal(payload.code, 'INTEGRATION_ACTION_FAILED')
      assert.equal(payload.requestId, 'rr-1')
      assert.match(payload.message, /runId/)
    }
  })

  it('runs against the canonical realpath for a symlinked alias, echoing the client path', async () => {
    ctx = makeActionCtx({
      realpath: createSpy(p => (p === '/home/user/link-to-chroxy' ? '/home/user/Projects/chroxy' : p)),
    })
    await controlRoomHandlers.integration_action(ws, client, rerunMsg({ repoPath: '/home/user/link-to-chroxy' }), ctx)
    assert.equal(ctx.runRepoRelayRerun.lastCall[0], '/home/user/Projects/chroxy')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'integration_action_ack')
    assert.equal(payload.repoPath, '/home/user/link-to-chroxy')
  })

  it('maps a thrown rerun failure to INTEGRATION_ACTION_FAILED echoing requestId + runId', async () => {
    ctx = makeActionCtx({
      runRepoRelayRerun: createSpy(async () => {
        const err = new Error('run 9001 did not fail (success) — only failed runs can be re-run')
        err.reason = 'run-not-failed'
        throw err
      }),
    })
    await controlRoomHandlers.integration_action(ws, client, rerunMsg(), ctx)
    assert.equal(ctx._send.callCount, 1, 'exactly one reply on failure too')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.equal(payload.code, 'INTEGRATION_ACTION_FAILED')
    assert.equal(payload.reason, 'run-not-failed')
    assert.equal(payload.requestId, 'rr-1')
    assert.equal(payload.runId, 9001)
    assert.match(payload.message, /only failed runs/)
  })

  it('shares the per-repo in-flight bucket with reindex (a reindex blocks a rerun on the same repo)', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeActionCtx({
      runRepoMemoryIndex: createSpy(async () => { await gate; return { counts: null } }),
    })
    const reindex = controlRoomHandlers.integration_action(ws, client, {
      type: 'integration_action', action: 'repo_memory_reindex',
      repoPath: '/home/user/Projects/chroxy', requestId: 'ix-1',
    }, ctx)
    await controlRoomHandlers.integration_action(ws, client, rerunMsg({ requestId: 'rr-2' }), ctx)
    assert.equal(ctx.runRepoRelayRerun.callCount, 0, 'rerun must not exec while a reindex holds the repo slot')
    const rejected = ctx._send.calls.find(c => c[1].requestId === 'rr-2')
    assert.equal(rejected[1].code, 'INTEGRATION_ACTION_FAILED')
    assert.match(rejected[1].message, /already in progress/i)
    release()
    await reindex
    // Slot freed — the rerun goes through now.
    await controlRoomHandlers.integration_action(ws, client, rerunMsg({ requestId: 'rr-3' }), ctx)
    assert.equal(ctx.runRepoRelayRerun.callCount, 1)
  })

  it('counts toward the shared global cap of 2 across action kinds', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeActionCtx({
      runRepoMemoryIndex: createSpy(async () => { await gate; return { counts: null } }),
      runRepoRelayRerun: createSpy(async (repoPath, runId) => { await gate; return { runId } }),
    })
    const p1 = controlRoomHandlers.integration_action(ws, client, {
      type: 'integration_action', action: 'repo_memory_reindex',
      repoPath: '/home/user/Projects/chroxy', requestId: 'a',
    }, ctx)
    const p2 = controlRoomHandlers.integration_action(
      ws, client, rerunMsg({ repoPath: '/home/user/Projects/other', requestId: 'b' }), ctx,
    )
    await controlRoomHandlers.integration_action(
      ws, client, rerunMsg({ repoPath: '/home/user/Projects/third', requestId: 'c' }), ctx,
    )
    const rejected = ctx._send.calls.find(c => c[1].requestId === 'c')
    assert.equal(rejected[1].code, 'INTEGRATION_ACTION_FAILED')
    assert.match(rejected[1].message, /busy/i)
    release()
    await Promise.all([p1, p2])
    const ackB = ctx._send.calls.find(c => c[1].requestId === 'b')
    assert.equal(ackB[1].type, 'integration_action_ack')
  })

  it('frees the in-flight slot even when the rerun throws', async () => {
    ctx = makeActionCtx({
      runRepoRelayRerun: createSpy(async () => { throw new Error('exploded') }),
    })
    await controlRoomHandlers.integration_action(ws, client, rerunMsg({ requestId: 'a' }), ctx)
    await controlRoomHandlers.integration_action(ws, client, rerunMsg({ requestId: 'b' }), ctx)
    assert.equal(ctx.runRepoRelayRerun.callCount, 2, 'a failed rerun must not wedge the per-repo slot')
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, rerunMsg({ requestId: 'reg' }), ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'integration_action_ack')
    assert.equal(payload.action, 'repo_relay_rerun')
    assert.equal(payload.requestId, 'reg')
  })
})
