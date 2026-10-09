import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ServerScheduledTasksSchema,
  ScheduledTaskSchema,
  ScheduledTaskUnreadableSchema,
  SCHEDULED_TASK_ACTION_VALUES,
  SCHEDULED_TASK_UNREADABLE_HANDLE_MAX,
  SCHEDULED_TASK_UNREADABLE_REASON_MAX,
  SCHEDULED_TASK_UNREADABLE_MAX_ENTRIES,
  SCHEDULED_TASKS_MAX,
} from '../src/schemas/server/scheduler.ts'
import { ScheduledTaskActionSchema } from '../src/schemas/client.ts'

// #7079 — the unreadable-entry surface on the `scheduled_tasks` snapshot and the
// discard action. Every new field is capped, and the caps must REJECT over-cap
// input: a cap that accepts everything is not a cap.

const task = (i = 0) => ({
  id: `t${i}`, name: null, enabled: true, prompt: 'p', target: {},
  cadence: { kind: 'cron', expression: '*/5 * * * *' },
  nextRun: null, lastRun: null, createdAt: 1, updatedAt: 1,
  providerRefusal: null, effectiveProvider: null, effectivePermissionMode: 'default',
  permissionModeClamped: false, quarantined: false,
})

const snapshot = (over = {}) => ({
  type: 'scheduled_tasks',
  generatedAt: new Date(0).toISOString(),
  scheduler: { enabled: false, engineArmed: false, restartRequired: false, source: 'default' },
  schedulableProviders: [],
  defaultProvider: 'claude-sdk',
  defaultProviderRefusal: null,
  tasks: [],
  ...over,
})

describe('#7079 scheduled_tasks snapshot: unreadable entries', () => {
  it('CONTROL: the base snapshot parses (an older daemon that omits the new fields still parses)', () => {
    const r = ServerScheduledTasksSchema.safeParse(snapshot())
    assert.equal(r.success, true, r.error?.message)
    assert.equal(r.data.unreadableCount, undefined)
  })

  it('accepts a count and per-entry { handle, reason }', () => {
    const r = ServerScheduledTasksSchema.safeParse(snapshot({
      unreadableCount: 2,
      unreadable: [
        { handle: '0123456789abcdef', reason: 'once cadence `at` must be a representable epoch-ms instant' },
        { handle: '0123456789abcdef-2', reason: 'task id must be a non-empty string' },
      ],
    }))
    assert.equal(r.success, true, r.error?.message)
  })

  it('rejects an over-cap handle, an empty handle and an over-cap reason', () => {
    const ok = { handle: 'a'.repeat(SCHEDULED_TASK_UNREADABLE_HANDLE_MAX), reason: 'r'.repeat(SCHEDULED_TASK_UNREADABLE_REASON_MAX) }
    assert.equal(ScheduledTaskUnreadableSchema.safeParse(ok).success, true, 'the caps are inclusive')
    assert.equal(ScheduledTaskUnreadableSchema.safeParse({ ...ok, handle: 'a'.repeat(SCHEDULED_TASK_UNREADABLE_HANDLE_MAX + 1) }).success, false)
    assert.equal(ScheduledTaskUnreadableSchema.safeParse({ ...ok, handle: '' }).success, false)
    assert.equal(ScheduledTaskUnreadableSchema.safeParse({ ...ok, reason: 'r'.repeat(SCHEDULED_TASK_UNREADABLE_REASON_MAX + 1) }).success, false)
  })

  it('rejects more entries than the cap, and a negative / fractional count', () => {
    const row = { handle: 'h', reason: 'r' }
    const at = (n) => ServerScheduledTasksSchema.safeParse(snapshot({ unreadable: Array.from({ length: n }, () => row) })).success
    assert.equal(at(SCHEDULED_TASK_UNREADABLE_MAX_ENTRIES), true)
    assert.equal(at(SCHEDULED_TASK_UNREADABLE_MAX_ENTRIES + 1), false)
    for (const bad of [-1, 1.5, '3', null]) {
      assert.equal(ServerScheduledTasksSchema.safeParse(snapshot({ unreadableCount: bad })).success, false, String(bad))
    }
  })

  // Adjacent fields audited with #7079: each was an unbounded array/string that
  // the server could be made to fill, in a snapshot the dashboard safeParses WHOLE.
  it('caps the adjacent snapshot fields: tasks[], schedulableProviders[], generatedAt, error', () => {
    const at = (over) => ServerScheduledTasksSchema.safeParse(snapshot(over)).success
    assert.equal(at({ tasks: Array.from({ length: SCHEDULED_TASKS_MAX }, (_, i) => task(i)) }), true)
    assert.equal(at({ tasks: Array.from({ length: SCHEDULED_TASKS_MAX + 1 }, (_, i) => task(i)) }), false)
    assert.equal(at({ schedulableProviders: Array.from({ length: 256 }, () => 'p') }), true)
    assert.equal(at({ schedulableProviders: Array.from({ length: 257 }, () => 'p') }), false)
    assert.equal(at({ error: { code: 'c'.repeat(128), message: 'm'.repeat(2048) } }), true)
    assert.equal(at({ error: { code: 'c'.repeat(129), message: 'm' } }), false)
    assert.equal(at({ error: { code: 'c', message: 'm'.repeat(2049) } }), false)
  })

  it('the task schema is unchanged for a normal task', () => {
    assert.equal(ScheduledTaskSchema.safeParse(task()).success, true)
  })
})

describe('#7079 scheduled_task_action: discard_unreadable', () => {
  it('the action roster carries it, and the wire enum agrees with the roster', () => {
    assert.ok(SCHEDULED_TASK_ACTION_VALUES.includes('discard_unreadable'))
    const wire = ScheduledTaskActionSchema.shape.action.options
    assert.deepEqual([...wire].sort(), [...SCHEDULED_TASK_ACTION_VALUES].sort(), 'the two rosters have drifted')
  })

  it('accepts a handle and rejects an over-cap or empty one; taskId stays capped at 256', () => {
    const base = { type: 'scheduled_task_action', action: 'discard_unreadable' }
    const ok = (extra) => ScheduledTaskActionSchema.safeParse({ ...base, ...extra }).success
    assert.equal(ok({ handle: 'a'.repeat(SCHEDULED_TASK_UNREADABLE_HANDLE_MAX) }), true)
    assert.equal(ok({ handle: 'a'.repeat(SCHEDULED_TASK_UNREADABLE_HANDLE_MAX + 1) }), false)
    assert.equal(ok({ handle: '' }), false)
    assert.equal(ok({ handle: 5 }), false)
    // The cap on taskId is correct and is NOT widened to carry a malformed record.
    assert.equal(ScheduledTaskActionSchema.safeParse({ ...base, action: 'delete', taskId: 'x'.repeat(256) }).success, true)
    assert.equal(ScheduledTaskActionSchema.safeParse({ ...base, action: 'delete', taskId: 'x'.repeat(257) }).success, false)
  })
})
