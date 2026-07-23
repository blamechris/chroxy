import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventNormalizer, EVENT_MAP } from '../src/event-normalizer.js'
import {
  ServerClaudeReadySchema,
  ServerModelChangedSchema,
  ServerPermissionModeChangedSchema,
  ServerStreamStartSchema,
  ServerStreamDeltaSchema,
  ServerStreamEndSchema,
  ServerMessageSchema,
  ServerToolStartSchema,
  ServerToolInputDeltaSchema,
  ServerToolResultSchema,
  ServerAgentBusySchema,
  ServerAgentIdleSchema,
  ServerAgentSpawnedSchema,
  ServerAgentCompletedSchema,
  ServerAgentEventSchema,
  ServerBackgroundWorkChangedSchema,
  ServerActivityDeltaSchema,
  ServerActivitySnapshotSchema,
  ServerMcpServersSchema,
  ServerMessageQueuedSchema,
  ServerMessageDequeuedSchema,
  ServerSkillChangedSchema,
  ServerSkillTrustRequestSchema,
  ServerPlanStartedSchema,
  ServerPlanReadySchema,
  ServerInactivityWarningSchema,
  ServerMultiQuestionInterventionSchema,
  ServerResultSchema,
  ServerCostUpdateSchema,
  ServerSessionUsageSchema,
  ServerSessionCostThresholdCrossedSchema,
  ServerBudgetWarningSchema,
  ServerBudgetExceededSchema,
  ServerUserQuestionSchema,
  ServerPermissionRequestSchema,
  ServerSessionStoppedSchema,
  ServerStdinDroppedTotalsSchema,
} from '@chroxy/protocol'

// ─────────────────────────────────────────────────────────────────────────────
// #6841 — event-normalizer serialization-boundary drift guard.
//
// The behavioural suite (event-normalizer.test.js) asserts emitted fields by
// direct property read (e.g. `resultMsg.msg.queueLength === 2`). That misses the
// class of bug that surfaced in #6819: the `result` normalizer's whitelist pick
// silently DROPPED `queueLength` before the wire, and every reconcile test fed
// hand-built fixtures that already carried the field, so nothing exercised the
// normalizer's serialization boundary.
//
// This harness closes that gap: it drives a representative input through EVERY
// EVENT_MAP emitter and parses each emitted wire message through the matching
// `@chroxy/protocol` `Server*Schema`. A dropped required field, a wrong type, or
// a mis-shaped nested object becomes a TEST failure at the normalizer layer
// instead of a production-only symptom at a Zod-validating client.
//
// This file is TEST-ONLY hardening — it asserts the normalizer's outputs conform
// to the declared wire contract; it does not change normalizer behaviour.
// ─────────────────────────────────────────────────────────────────────────────

// Every wire `type` the normalizer can emit → the schema that governs it.
// Sub-messages a single emitter fans out (ready → claude_ready + model_changed +
// permission_mode_changed; stream_start → stream_start + agent_busy; result →
// result + agent_idle) each get their own entry so every message on the wire is
// checked, not just the first.
const SCHEMA_BY_TYPE = {
  claude_ready: ServerClaudeReadySchema,
  model_changed: ServerModelChangedSchema,
  permission_mode_changed: ServerPermissionModeChangedSchema,
  stream_start: ServerStreamStartSchema,
  stream_delta: ServerStreamDeltaSchema,
  stream_end: ServerStreamEndSchema,
  message: ServerMessageSchema,
  tool_start: ServerToolStartSchema,
  tool_input_delta: ServerToolInputDeltaSchema,
  tool_result: ServerToolResultSchema,
  agent_busy: ServerAgentBusySchema,
  agent_idle: ServerAgentIdleSchema,
  agent_spawned: ServerAgentSpawnedSchema,
  agent_completed: ServerAgentCompletedSchema,
  agent_event: ServerAgentEventSchema,
  background_work_changed: ServerBackgroundWorkChangedSchema,
  activity_delta: ServerActivityDeltaSchema,
  activity_snapshot: ServerActivitySnapshotSchema,
  mcp_servers: ServerMcpServersSchema,
  message_queued: ServerMessageQueuedSchema,
  message_dequeued: ServerMessageDequeuedSchema,
  skill_changed: ServerSkillChangedSchema,
  skill_trust_request: ServerSkillTrustRequestSchema,
  plan_started: ServerPlanStartedSchema,
  plan_ready: ServerPlanReadySchema,
  inactivity_warning: ServerInactivityWarningSchema,
  multi_question_intervention: ServerMultiQuestionInterventionSchema,
  result: ServerResultSchema,
  cost_update: ServerCostUpdateSchema,
  session_usage: ServerSessionUsageSchema,
  session_cost_threshold_crossed: ServerSessionCostThresholdCrossedSchema,
  budget_warning: ServerBudgetWarningSchema,
  budget_exceeded: ServerBudgetExceededSchema,
  user_question: ServerUserQuestionSchema,
  permission_request: ServerPermissionRequestSchema,
  session_stopped: ServerSessionStoppedSchema,
  stdin_dropped_totals: ServerStdinDroppedTotalsSchema,
}

// Wire types the normalizer emits that have NO `Server*Schema` in
// `@chroxy/protocol` today. Documented here so the round-trip harness can tell
// "deliberately un-schemaed" apart from "a new emitter shipped a type nobody
// gave a schema". If a schema is later added for one of these, WIRE IT INTO
// `SCHEMA_BY_TYPE` above and drop it from this set (the meta-test below fails
// until both sides agree). See the PR for #6841 — these are tracked as a
// follow-up schema-gap, not a licence to leave new types unchecked.
const KNOWN_UNSCHEMAED = new Set([
  'conversation_id', // conversation_id emitter — no ServerConversationIdSchema
  'permission_expired', // permission_expired emitter — no schema
  'permission_resolved', // permission_resolved emitter — no schema
])

// Standard multi-session context (mirrors event-normalizer.test.js).
function makeCtx(overrides = {}) {
  return {
    sessionId: 'sess-1',
    mode: 'multi',
    getSessionEntry: () => ({
      session: { model: 'claude-sonnet-4-6', permissionMode: 'approve' },
      name: 'Test Session',
      cwd: '/tmp/test',
    }),
    ...overrides,
  }
}

// A realistic background-task snapshot entry (BackgroundTaskSchema).
const backgroundTask = { toolUseId: 'toolu_ci', kind: 'bash', description: 'Wait for CI', startedAt: 1781068000000 }
// A realistic activity-tree entry (ActivityEntrySchema); `running` → no endedAt.
const activityEntry = { id: 'a1', kind: 'tool', label: 'Read', status: 'running', startedAt: 1781068000000 }

// One representative { event, data, ctx } per EVENT_MAP emitter. Inputs are
// shaped like what the session layer actually emits so the normalizer's real
// serialization path runs. A coverage meta-test asserts this table stays in
// lockstep with EVENT_MAP, so a future emitter forces a fixture here.
const FIXTURES = [
  ['ready', {}, makeCtx()],
  ['background_tasks_changed', { backgroundTasks: [backgroundTask], scheduledWakeup: { at: 1781068600000, reason: 'watching CI' } }, makeCtx()],
  ['conversation_id', { conversationId: 'conv-1' }, makeCtx()],
  ['stream_start', { messageId: 'm1' }, makeCtx()],
  ['stream_delta', { messageId: 'm1', delta: 'hello' }, makeCtx()],
  ['stream_end', { messageId: 'm1' }, makeCtx()],
  ['message', { type: 'response', content: 'Hi there', tool: null, options: null, timestamp: 1700000000000 }, makeCtx()],
  ['tool_start', { messageId: 'm1', toolUseId: 'tu1', tool: 'Read', input: { path: '/tmp/x' } }, makeCtx()],
  ['tool_input_delta', { messageId: 'm1', toolUseId: 'tu1', partialJson: '{"path":' }, makeCtx()],
  ['tool_result', { toolUseId: 'tu1', result: 'file contents', truncated: false, isError: false }, makeCtx()],
  ['agent_spawned', { toolUseId: 'tu_task', description: 'Explore code', startedAt: 1700000000000 }, makeCtx()],
  ['agent_completed', { toolUseId: 'tu_task' }, makeCtx()],
  ['agent_event', { parentToolUseId: 'tu_task', type: 'tool_start', payload: { toolUseId: 'tu_child', tool: 'Read' } }, makeCtx()],
  ['background_work_changed', { pending: [{ shellId: 'brk57kt6pm', command: 'npm test', startedAt: 1781068000000 }] }, makeCtx()],
  ['activity_delta', { schemaVersion: 1, op: 'started', entry: activityEntry }, makeCtx()],
  ['activity_snapshot', { schemaVersion: 1, entries: [activityEntry] }, makeCtx()],
  ['mcp_servers', { servers: [{ name: 'filesystem', status: 'connected', enabled: true, canToggle: true }] }, makeCtx()],
  ['message_queued', { clientMessageId: 'c-1', text: 'follow-up while busy', queueLength: 1 }, makeCtx()],
  ['message_dequeued', { clientMessageId: 'c-1', queueLength: 0, reason: 'flush' }, makeCtx()],
  ['skill_changed', { name: 'coding-style', oldHash: 'a'.repeat(64), newHash: 'b'.repeat(64), blocked: false, mode: 'warn' }, makeCtx()],
  ['skill_trust_request', { name: 'community-skill', author: 'alice', source: 'global', description: 'A community skill', path: '/skills/x' }, makeCtx()],
  ['plan_started', {}, makeCtx()],
  ['plan_ready', { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] }, makeCtx()],
  ['inactivity_warning', { messageId: 'm-7', idleMs: 1_800_000, prefab: 'Status update?' }, makeCtx()],
  ['multi_question_intervention', { toolUseId: 'toolu_mq', questionCount: 4, reason: 'multi_question', timestamp: 1700000000000 }, makeCtx()],
  [
    'result',
    {
      cost: 0.05,
      duration: 3000,
      usage: { input_tokens: 10, output_tokens: 20 },
      sessionId: 'sdk-1',
      queueLength: 2,
      contextOccupancy: { totalTokens: 110_000, maxTokens: 200_000, autoCompactThreshold: 167_000, isAutoCompactEnabled: true, source: 'context-usage-api' },
    },
    makeCtx(),
  ],
  ['cost_update', { sessionCost: 0.1, totalCost: 0.5, budget: 10 }, makeCtx()],
  ['session_usage', { cumulativeUsage: { inputTokens: 17, outputTokens: 23, cacheReadTokens: 5, cacheCreationTokens: 2, costUsd: 0.00198, turnsBilled: 2 } }, makeCtx()],
  ['session_cost_threshold_crossed', { costUsd: 5.01, thresholdUsd: 5 }, makeCtx()],
  ['budget_warning', { sessionCost: 8, budget: 10, percent: 80, message: '80% of budget used' }, makeCtx()],
  ['budget_exceeded', { sessionCost: 11, budget: 10, percent: 110, message: 'Budget exceeded' }, makeCtx()],
  ['user_question', { toolUseId: 'toolu_q', questions: [{ question: 'Pick one', options: [] }] }, makeCtx()],
  ['permission_request', { requestId: 'req-1', tool: 'Bash', description: 'run ls', input: 'ls', remainingMs: 60_000 }, makeCtx()],
  ['permission_expired', { requestId: 'req-1', message: 'Permission prompt expired' }, makeCtx()],
  ['permission_resolved', { requestId: 'req-1', decision: 'allow', reason: 'user' }, makeCtx()],
  ['error', { message: 'Something went wrong', code: 'docker_not_running' }, makeCtx()],
  ['stopped', { code: 0 }, makeCtx()],
  ['stdin_dropped_totals', { bytes: 1024, count: 3, reason: 'pre_dial_cap', escalated: true }, makeCtx()],
]

// Parse one emitted wire message against its declared schema. Returns the wire
// `type` when it was schema-validated, or a `{ schemaless }` marker for the
// documented un-schemaed emitters (which the meta-test cross-checks).
function validateMessage(event, msg) {
  assert.equal(typeof msg?.type, 'string', `${event} emitted a message with no string 'type'`)
  const schema = SCHEMA_BY_TYPE[msg.type]
  if (!schema) {
    assert.ok(
      KNOWN_UNSCHEMAED.has(msg.type),
      `${event} emitted wire type '${msg.type}' which has no Server*Schema and is not in the ` +
        `KNOWN_UNSCHEMAED allowlist — add a schema (and wire it into SCHEMA_BY_TYPE) or, if it is ` +
        `deliberately un-schemaed, add it to KNOWN_UNSCHEMAED with a reason.`,
    )
    return { schemaless: msg.type }
  }
  const parsed = schema.safeParse(msg)
  assert.ok(
    parsed.success,
    `${event} → '${msg.type}' output must validate against its Server*Schema (dropped/mis-shaped ` +
      `wire field): ${JSON.stringify(parsed.error?.issues)}\n   msg=${JSON.stringify(msg)}`,
  )
  return { validated: msg.type }
}

describe('EventNormalizer output → Server*Schema round-trip (#6841)', () => {
  // Coverage guard: every declarative EVENT_MAP emitter must have a fixture, so
  // a NEW emitter can't ship without a schema-validated fixture landing here.
  it('has a representative fixture for every EVENT_MAP emitter', () => {
    const eventKeys = Object.keys(EVENT_MAP).sort()
    const fixtureKeys = [...new Set(FIXTURES.map((f) => f[0]))].sort()
    assert.deepEqual(
      fixtureKeys,
      eventKeys,
      'FIXTURES must cover exactly the EVENT_MAP emitters — add a fixture for any new event',
    )
  })

  // Per-emitter round-trip: drive the input through the normalizer and parse
  // every emitted wire message against its schema. One `it()` per event so a
  // failure names the offending emitter.
  for (const [event, data, ctx] of FIXTURES) {
    it(`${event}: every emitted wire message validates against its Server*Schema`, () => {
      const normalizer = new EventNormalizer({ flushIntervalMs: 10 })
      try {
        const result = normalizer.normalize(event, data, ctx)
        assert.ok(result, `normalize('${event}') returned null for a known event`)
        const messages = Array.isArray(result.messages) ? result.messages : []
        for (const entry of messages) {
          validateMessage(event, entry.msg)
        }
      } finally {
        normalizer.destroy()
      }
    })
  }

  // Every schema in the map must be exercised by at least one fixture, so the
  // map can't drift into listing a schema nothing actually produces.
  it('exercises every schema listed in SCHEMA_BY_TYPE', () => {
    const normalizer = new EventNormalizer({ flushIntervalMs: 10 })
    const hit = new Set()
    try {
      for (const [event, data, ctx] of FIXTURES) {
        const result = normalizer.normalize(event, data, ctx)
        for (const entry of (result?.messages ?? [])) {
          if (SCHEMA_BY_TYPE[entry.msg.type]) hit.add(entry.msg.type)
        }
      }
    } finally {
      normalizer.destroy()
    }
    const never = Object.keys(SCHEMA_BY_TYPE).filter((t) => !hit.has(t)).sort()
    assert.deepEqual(never, [], 'every SCHEMA_BY_TYPE entry must be produced by a fixture')
  })

  // The only emitters allowed to ship a message with no Server*Schema are the
  // documented set. This turns "a new emitter quietly shipped an un-schemaed
  // wire type" into a failure, and also fails if a schema is added for one of
  // these three without updating both SCHEMA_BY_TYPE and KNOWN_UNSCHEMAED.
  it('emits un-schemaed wire types only for the documented KNOWN_UNSCHEMAED set', () => {
    const normalizer = new EventNormalizer({ flushIntervalMs: 10 })
    const schemaless = new Set()
    try {
      for (const [event, data, ctx] of FIXTURES) {
        const result = normalizer.normalize(event, data, ctx)
        for (const entry of (result?.messages ?? [])) {
          if (!SCHEMA_BY_TYPE[entry.msg.type]) schemaless.add(entry.msg.type)
        }
      }
    } finally {
      normalizer.destroy()
    }
    assert.deepEqual(
      [...schemaless].sort(),
      [...KNOWN_UNSCHEMAED].sort(),
      'the set of emitted un-schemaed wire types must equal KNOWN_UNSCHEMAED exactly',
    )
  })
})
