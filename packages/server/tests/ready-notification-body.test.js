// #5438 — unit tests for the ready-for-input notification body composer.
// The composer turns a #5436 background-task snapshot into the idle-push
// body shared by the Expo sink and the Discord status embed (which renders
// `notification.body` as its Status field). Contract under test:
//   - absent snapshot (null/undefined) → today's plain body, unchanged
//   - explicit empty snapshot ([], no wakeup) → plain body too
//   - outstanding tasks → 'Ready for input — still watching: <desc>' (+N more)
//   - armed wakeup → 'Ready for input — resumes at HH:MM: <reason>'
//   - tasks win over a wakeup when both exist (dashboard chip priority)
//   - the composed body is clamped to ~140 chars (push payload hygiene)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeReadyNotificationBody,
  DEFAULT_READY_BODY,
  READY_BODY_MAX_LENGTH,
} from '../src/notifications/ready-body.js'

const task = (over = {}) => ({
  toolUseId: 'toolu_01',
  kind: 'bash',
  description: 'npm test in worktree',
  startedAt: 1_000,
  ...over,
})

describe('composeReadyNotificationBody — absent / empty snapshot', () => {
  it('returns the plain body for an absent snapshot (null)', () => {
    assert.equal(composeReadyNotificationBody(null), DEFAULT_READY_BODY)
  })

  it('returns the plain body for undefined', () => {
    assert.equal(composeReadyNotificationBody(undefined), DEFAULT_READY_BODY)
  })

  it('returns the plain body for an explicit empty snapshot ([] + null wakeup)', () => {
    assert.equal(
      composeReadyNotificationBody({ backgroundTasks: [], scheduledWakeup: null }),
      DEFAULT_READY_BODY
    )
  })

  it('returns the plain body for a malformed snapshot (non-object)', () => {
    assert.equal(composeReadyNotificationBody('garbage'), DEFAULT_READY_BODY)
  })
})

describe('composeReadyNotificationBody — outstanding tasks', () => {
  it('single task: still-watching with the task description', () => {
    const body = composeReadyNotificationBody({
      backgroundTasks: [task()],
      scheduledWakeup: null,
    })
    assert.equal(body, 'Ready for input — still watching: npm test in worktree')
  })

  it('several tasks: picks the most recent (max startedAt) and appends +N more', () => {
    const body = composeReadyNotificationBody({
      backgroundTasks: [
        task({ toolUseId: 'a', description: 'old watcher', startedAt: 1_000 }),
        task({ toolUseId: 'b', description: 'newest deploy', startedAt: 3_000 }),
        task({ toolUseId: 'c', description: 'middle build', startedAt: 2_000 }),
      ],
      scheduledWakeup: null,
    })
    assert.equal(body, 'Ready for input — still watching: newest deploy +2 more')
  })

  it('falls back to the toolUseId when the description is empty', () => {
    const body = composeReadyNotificationBody({
      backgroundTasks: [task({ description: '' })],
      scheduledWakeup: null,
    })
    assert.equal(body, 'Ready for input — still watching: toolu_01')
  })

  it('falls back to the toolUseId when the description is whitespace-only', () => {
    const body = composeReadyNotificationBody({
      backgroundTasks: [task({ description: ' \n\t ' })],
      scheduledWakeup: null,
    })
    assert.equal(body, 'Ready for input — still watching: toolu_01')
  })

  it('collapses newlines and tabs in a multi-line description (Agent prompt fallback)', () => {
    // TranscriptTaskScanner falls back to `prompt.slice(0, 80)` for Agent
    // launches with no description — multi-line prompts are routine, and a
    // raw newline would wrap the one-line push body / Discord Status field.
    const body = composeReadyNotificationBody({
      backgroundTasks: [task({ description: 'watch the deploy\n\nand report back\twhen done' })],
      scheduledWakeup: null,
    })
    assert.equal(body, 'Ready for input — still watching: watch the deploy and report back when done')
  })

  it('strips ANSI escapes and control bytes from the description', () => {
    const body = composeReadyNotificationBody({
      backgroundTasks: [task({ description: '\u001b[31mred\u001b[0m alert\u0007 bell' })],
      scheduledWakeup: null,
    })
    assert.equal(body, 'Ready for input — still watching: red alert bell')
  })
})

describe('composeReadyNotificationBody — armed wakeup', () => {
  it('formats the wakeup in server-local HH:MM with the reason', () => {
    const at = new Date(2026, 5, 10, 9, 5).getTime() // 09:05 local
    const body = composeReadyNotificationBody({
      backgroundTasks: [],
      scheduledWakeup: { at, reason: 'poll CI for the release build' },
    })
    assert.equal(body, 'Ready for input — resumes at 09:05: poll CI for the release build')
  })

  it('omits the reason segment when the reason is empty', () => {
    const at = new Date(2026, 5, 10, 23, 59).getTime()
    const body = composeReadyNotificationBody({
      backgroundTasks: [],
      scheduledWakeup: { at, reason: '' },
    })
    assert.equal(body, 'Ready for input — resumes at 23:59')
  })

  it('omits the reason segment when the reason is whitespace-only', () => {
    const at = new Date(2026, 5, 10, 23, 59).getTime()
    const body = composeReadyNotificationBody({
      backgroundTasks: [],
      scheduledWakeup: { at, reason: ' \n ' },
    })
    assert.equal(body, 'Ready for input — resumes at 23:59')
  })

  it('degrades to the plain body when the wakeup time is unparsable', () => {
    const body = composeReadyNotificationBody({
      backgroundTasks: [],
      scheduledWakeup: { at: NaN, reason: 'whatever' },
    })
    assert.equal(body, DEFAULT_READY_BODY)
  })
})

describe('composeReadyNotificationBody — both tasks and a wakeup', () => {
  it('tasks win (same priority order as the dashboard ActivityIndicator chips)', () => {
    const body = composeReadyNotificationBody({
      backgroundTasks: [task({ description: 'tail deploy logs' })],
      scheduledWakeup: { at: Date.now() + 60_000, reason: 'check again later' },
    })
    assert.equal(body, 'Ready for input — still watching: tail deploy logs')
  })
})

describe('composeReadyNotificationBody — length clamp', () => {
  it('truncates an oversized task description so the body stays within the limit', () => {
    const body = composeReadyNotificationBody({
      backgroundTasks: [task({ description: 'x'.repeat(500) })],
      scheduledWakeup: null,
    })
    assert.ok(body.length <= READY_BODY_MAX_LENGTH, `body length ${body.length} exceeds limit`)
    assert.ok(body.startsWith('Ready for input — still watching: x'))
    assert.ok(body.endsWith('…'), 'truncation marked with an ellipsis')
  })

  it('truncation preserves the +N more suffix', () => {
    const body = composeReadyNotificationBody({
      backgroundTasks: [
        task({ toolUseId: 'a', description: 'y'.repeat(500), startedAt: 9_000 }),
        task({ toolUseId: 'b', description: 'older', startedAt: 1_000 }),
      ],
      scheduledWakeup: null,
    })
    assert.ok(body.length <= READY_BODY_MAX_LENGTH)
    assert.ok(body.endsWith('… +1 more'), `suffix survives the clamp (got: ${body.slice(-20)})`)
  })

  it('never splits a surrogate pair at the truncation point', () => {
    // Build a description whose clamp budget lands exactly mid-emoji: if the
    // cut split the pair, the body would carry a lone high surrogate into
    // the push/Discord JSON payload.
    const body = composeReadyNotificationBody({
      backgroundTasks: [task({ description: '🚀'.repeat(200) })],
      scheduledWakeup: null,
    })
    assert.ok(body.length <= READY_BODY_MAX_LENGTH)
    assert.ok(!/[\uD800-\uDBFF]…/.test(body), 'no lone high surrogate before the ellipsis')
    assert.ok(body.isWellFormed(), 'body is a well-formed unicode string')
  })

  it('truncates an oversized wakeup reason too', () => {
    const at = new Date(2026, 5, 10, 12, 0).getTime()
    const body = composeReadyNotificationBody({
      backgroundTasks: [],
      scheduledWakeup: { at, reason: 'z'.repeat(500) },
    })
    assert.ok(body.length <= READY_BODY_MAX_LENGTH)
    assert.ok(body.startsWith('Ready for input — resumes at 12:00: z'))
    assert.ok(body.endsWith('…'))
  })
})
