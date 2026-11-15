import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registeredMessageTypes, handleSessionMessage } from '../src/ws-message-handlers.js'
import { DevPreviewManager } from '../src/dev-preview.js'
import {
  PRINCIPAL_NEVER_CAPABILITIES,
  PRINCIPAL_DENIED_MESSAGE_TYPES,
  PRINCIPAL_ALLOWED_MESSAGE_TYPES,
  frameForPrincipal,
} from '../src/principal-policy.js'
import { REAL_HANDLERS, SENTINEL, principalClient, hostClient, recordingCtx } from './principal-test-helpers.js'

// Independent oracles (contract §4.3), spelled out here and not read from the
// constant under test.
const EXPECTED_NEVER_TYPES = [
  'add_mcp_server', 'append_memory', 'create_environment', 'daemon_update_action', 'delete_archived_session',
  'destroy_environment', 'git_commit', 'git_create_pr', 'git_stage', 'git_unstage', 'notification_prefs_set',
  'open_dev_preview', 'orchestration_run_start', 'pair_approve', 'pair_deny', 'remove_mcp_server',
  'restore_checkpoint', 'revoke_token', 'scheduled_task_action', 'session_preset_set', 'set_model',
  'set_permission_mode', 'set_permission_rules', 'set_scheduler_enabled', 'set_session_archive_policy',
  'skill_trust_accept', 'skill_trust_grant', 'terminal_input', 'terminal_subscribe', 'write_file',
].sort()
const EXPECTED_S2_ADDS = ['notification_prefs_set', 'set_permission_rules', 'skill_trust_accept', 'skill_trust_grant', 'terminal_input']

const SID = 'sess-1'
const rows = PRINCIPAL_NEVER_CAPABILITIES
const typeRows = rows.flatMap((row) => row.types.map((type) => ({ row, type })))

// One message per type: enough that a host client gets PAST the handler's gate and
// into its host path (the positive control proves the probe can pass).
const MSGS = {
  set_permission_mode: { type: 'set_permission_mode', mode: 'acceptEdits', sessionId: SID },
  set_permission_rules: { type: 'set_permission_rules', requestId: 'r1', rules: [{ tool: 'Write', decision: 'allow' }] },
  revoke_token: { type: 'revoke_token', requestId: 'r1' },
  pair_approve: { type: 'pair_approve', requestId: 'r1' },
  pair_deny: { type: 'pair_deny', requestId: 'r1' },
  add_mcp_server: { type: 'add_mcp_server', requestId: 'r1', name: 'x', config: { command: 'x' } },
  remove_mcp_server: { type: 'remove_mcp_server', requestId: 'r1', name: 'x' },
  skill_trust_accept: { type: 'skill_trust_accept', requestId: 'r1', skillName: 'x', sessionId: SID },
  skill_trust_grant: { type: 'skill_trust_grant', requestId: 'r1', skillName: 'x', author: 'a', sessionId: SID },
  write_file: { type: 'write_file', requestId: 'r1', path: 'a.txt', content: 'x', sessionId: SID },
  append_memory: { type: 'append_memory', requestId: 'r1', content: 'x', sessionId: SID },
  git_stage: { type: 'git_stage', requestId: 'r1', paths: ['a'], sessionId: SID },
  git_unstage: { type: 'git_unstage', requestId: 'r1', paths: ['a'], sessionId: SID },
  git_commit: { type: 'git_commit', requestId: 'r1', message: 'm', sessionId: SID },
  git_create_pr: { type: 'git_create_pr', requestId: 'r1', title: 't', sessionId: SID },
  create_environment: { type: 'create_environment', requestId: 'r1', name: 'x', cwd: '/tmp/x' },
  destroy_environment: { type: 'destroy_environment', requestId: 'r1', environmentId: 'e1' },
  session_preset_set: { type: 'session_preset_set', requestId: 'r1', cwd: '/tmp/x', preset: {} },
  notification_prefs_set: { type: 'notification_prefs_set', requestId: 'r1', prefs: { enabled: false } },
  terminal_input: { type: 'terminal_input', sessionId: SID, data: 'ls\r' },
  terminal_subscribe: { type: 'terminal_subscribe', sessionId: SID },
  open_dev_preview: { type: 'open_dev_preview', requestId: 'r1', sessionId: SID, port: 3000 },
  delete_archived_session: { type: 'delete_archived_session', archiveId: 'a1' },
  // An INVALID policy, so a client that gets past the gate is answered with a validation
  // error instead of the handler writing the real config file.
  set_session_archive_policy: { type: 'set_session_archive_policy', requestId: 'r1', enabled: 'nope' },
  daemon_update_action: { type: 'daemon_update_action', requestId: 'r1', action: 'restart-now' },
  scheduled_task_action: { type: 'scheduled_task_action', requestId: 'r1', action: 'delete', taskId: 't1' },
  set_scheduler_enabled: { type: 'set_scheduler_enabled', requestId: 'r1', enabled: true },
  orchestration_run_start: { type: 'orchestration_run_start', requestId: 'r1', cwd: '/tmp/x' },
  restore_checkpoint: { type: 'restore_checkpoint', checkpointId: 'cp1', mode: 'files' },
  set_model: { type: 'set_model', model: 'sonnet', sessionId: SID },
}

// Handlers that read one property BEFORE their gate (a feature flag, the session
// manager's presence) need it stubbed, or they return early for a reason that is
// not the gate. The stubbed read itself is not counted; whatever the handler reads
// beyond it is.
const PROBE_CTX = {
  orchestration_run_start: {
    stubs: { 'services.config': { features: { orchestration: true } } },
    tolerate: ['services.config', 'services.config.features'],
  },
  restore_checkpoint: {
    stubs: { 'sessions.sessionManager': { getSession: () => null } },
    tolerate: ['sessions.sessionManager', 'sessions.sessionManager.getSession'],
  },
}
const probeCtx = (type) => recordingCtx(PROBE_CTX[type])

// How a probe tells that a client got PAST the gate. The default is "the handler read
// into its host path"; a handler whose first step past the gate is a validation reply
// is told apart by that reply's code instead.
const PASSED_GATE = {
  set_session_archive_policy: ({ sent }) => sent.some((f) => f.code === 'SESSION_ARCHIVE_POLICY_INVALID'),
}
const passedGate = (type, result) => (PASSED_GATE[type] ?? ((r) => r.touched.length > 0))(result)

/**
 * Run the real handler with the dispatch allowlist bypassed. `proceeded` is true
 * when the handler reached into its host path (read the session manager, the
 * services, the permission manager or the runtime). A handler that refuses leaves
 * every one of those untouched.
 */
async function callHandler(type, client) {
  const { ctx, sent, touched } = probeCtx(type)
  try {
    await REAL_HANDLERS[type]({}, client, MSGS[type], ctx)
  } catch {
    // A host-path handler fed an empty context throws: reaching it is the point.
  }
  return { sent, touched, proceeded: passedGate(type, { sent, touched }) }
}

// The dev-preview gate lives in DevPreviewManager, so the probe builds the real
// manager and reads its outcome from the frames it sends.
async function callOpenDevPreview(client) {
  const frames = []
  const devPreview = new DevPreviewManager({
    daemonPort: 1,
    authRequired: true,
    getSession: (id) => (id === SID ? { session: { cwd: '/tmp' } } : null),
    pinTarget: async () => { throw new Error('reached the pin step') },
  })
  const ctx = {
    transport: { send: (_ws, m) => frames.push(m) },
    services: { devPreview },
    sessions: {}, permissions: {}, runtime: {},
  }
  await REAL_HANDLERS.open_dev_preview({}, client, MSGS.open_dev_preview, ctx)
  const refusedByAuthority = frames.some((f) => typeof f.reason === 'string' && f.reason.includes('requires the primary-token client'))
  const gotPast = frames.some((f) => typeof f.reason === 'string' && f.reason.includes('reached the pin step'))
  return { frames, proceeded: gotPast, refused: refusedByAuthority }
}

// A principal as the real server would hold it, plus the fields that let a refusal
// be the GATE'S doing rather than a missing active session.
const principal = (over) => principalClient({ activeSessionId: SID, subscribedSessionIds: new Set([SID]), ...over })
const noSentinel = () => principal({ boundSessionId: undefined })
const host = () => hostClient({ activeSessionId: SID, subscribedSessionIds: new Set([SID]) })

describe('principal never table: roster', () => {
  it('is non-empty and its types are exactly the contract §4.3 types', () => {
    assert.ok(rows.length > 0)
    assert.ok(typeRows.length > 0)
    assert.deepEqual([...new Set(typeRows.map((r) => r.type))].sort(), EXPECTED_NEVER_TYPES)
  })

  it('every row names its column-(b) handler predicate, and each id is unique', () => {
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length)
    for (const row of rows) {
      assert.ok(typeof row.handlerPredicate === 'string' && row.handlerPredicate.length > 10, row.id)
      assert.equal(typeof row.sentinelDependent, 'boolean', row.id)
      assert.equal(typeof row.s2AddsRefusal, 'boolean', row.id)
    }
  })

  it('every never type is registered, denied to a principal and absent from its allowlist (column a)', () => {
    const registered = new Set(registeredMessageTypes)
    for (const { type } of typeRows) {
      assert.ok(registered.has(type), `${type} is not a real type`)
      assert.ok(Object.hasOwn(PRINCIPAL_DENIED_MESSAGE_TYPES, type), `${type} must be denied`)
      assert.equal(Object.hasOwn(PRINCIPAL_ALLOWED_MESSAGE_TYPES, type), false, `${type} must not be allowed`)
    }
  })

  it('every row type has a fixture, and every fixture is a row type (both directions)', () => {
    assert.deepEqual(Object.keys(MSGS).sort(), EXPECTED_NEVER_TYPES)
  })

  it('the rows S2 adds an explicit principal refusal for are exactly the five expected types', () => {
    const types = rows.filter((r) => r.s2AddsRefusal).flatMap((r) => r.types).sort()
    assert.deepEqual(types, EXPECTED_S2_ADDS)
  })

  it('identity rotation has no WebSocket type at all (CLI only)', () => {
    const row = rows.find((r) => r.id === 'identity-rotation')
    assert.ok(row)
    assert.deepEqual([...row.types], [])
    assert.deepEqual(registeredMessageTypes.filter((t) => /identity|rotate/.test(t)), [])
  })
})

describe('principal never table: each row refuses on its own, and again at dispatch', () => {
  let cases = 0

  for (const { row, type } of typeRows) {
    if (type === 'open_dev_preview') continue // exercised below through the real manager
    describe(`${row.id} / ${type}`, () => {
      it('positive control: a host client gets past the gate into the handler\'s host path', async () => {
        cases++
        const { proceeded } = await callHandler(type, host())
        assert.ok(proceeded, `the probe for ${type} never gets a host client past its gate, so a refusal proves nothing`)
      })

      it('column (b): the real handler refuses a principal with dispatch bypassed', async () => {
        cases++
        const { sent, proceeded } = await callHandler(type, principal())
        assert.equal(proceeded, false, `${type} got past its gate for a principal`)
        // What the principal would RECEIVE: the outgoing choke point filters every frame.
        for (const frame of sent) {
          const delivered = frameForPrincipal(principal(), frame, {})
          assert.equal(JSON.stringify(delivered).includes(SENTINEL), false, 'the sentinel must not be serialized')
        }
      })

      if (row.sentinelDependent) {
        it('sentinel-dependent: with the sentinel removed the handler would proceed', async () => {
          cases++
          const { proceeded } = await callHandler(type, noSentinel())
          assert.ok(proceeded, `${type} is flagged sentinelDependent but refuses without the sentinel`)
        })
      } else {
        it('independent of the sentinel: with the sentinel removed it still refuses', async () => {
          cases++
          const { proceeded } = await callHandler(type, noSentinel())
          assert.equal(proceeded, false, `${type} depends on the sentinel but is not flagged sentinelDependent`)
        })
      }

      it('column (a): with dispatch active the principal is refused scope_denied before the handler', async () => {
        cases++
        const { ctx, sent, touched } = probeCtx(type)
        await handleSessionMessage({}, principal(), MSGS[type], ctx)
        assert.equal(sent.length, 1)
        assert.equal(sent[0].code, 'scope_denied')
        assert.equal(sent[0].requestType, type)
        assert.deepEqual(touched, [])
      })
    })
  }

  describe('dev-preview / open_dev_preview', () => {
    it('positive control: the primary-token client passes the authority gate', async () => {
      cases++
      const r = await callOpenDevPreview(host())
      assert.equal(r.refused, false)
      assert.equal(r.proceeded, true, 'the host client must reach the pin step')
    })

    it('column (b): a principal is refused by the manager with dispatch bypassed', async () => {
      cases++
      const r = await callOpenDevPreview(principal())
      assert.equal(r.refused, true)
      assert.equal(r.proceeded, false)
    })

    it('two independent refusals: isPrimaryToken=false alone refuses (no sentinel), and the binding alone refuses (isPrimaryToken=true)', async () => {
      cases++
      const noBinding = await callOpenDevPreview(noSentinel())
      assert.equal(noBinding.refused, true, 'isPrimaryToken !== true must refuse on its own')
      const bound = await callOpenDevPreview(principal({ isPrimaryToken: true, authToken: 'x' }))
      assert.equal(bound.refused, true, 'a truthy boundSessionId must refuse on its own')
    })

    it('column (a): with dispatch active the principal is refused scope_denied', async () => {
      cases++
      const { ctx, sent, touched } = recordingCtx()
      await handleSessionMessage({}, principal(), MSGS.open_dev_preview, ctx)
      assert.equal(sent[0].code, 'scope_denied')
      assert.deepEqual(touched, [])
    })
  })

  it('ran a non-zero number of cases', () => {
    assert.ok(cases > 0, 'the never-table guard ran zero cases')
    assert.ok(cases >= typeRows.length * 3, `expected at least ${typeRows.length * 3} cases, ran ${cases}`)
  })
})
