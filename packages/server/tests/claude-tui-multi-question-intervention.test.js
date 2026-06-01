import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

/**
 * #4653 — Surface multi-question AskUserQuestion denials to the user.
 *
 * The permission-hook (`packages/server/hooks/permission-hook.sh`, shipped in
 * #4648) denies any AskUserQuestion whose `questions[]` has length > 1 so the
 * model re-emits as N sequential single-question calls. That deny is currently
 * invisible to the user: the model just "happens" to ask one at a time.
 *
 * This test pins the server-side observability the dashboard renders: when
 * ClaudeTuiSession's PreToolUse handler sees a multi-question AskUserQuestion
 * (the EXACT condition the bash hook denies on), it emits a
 * `multi_question_intervention` event so SessionManager can broadcast it as a
 * `session_event`. That broadcast drives the dashboard's intervention counter
 * + inline notice.
 *
 * Why mirror the deny condition in JS rather than parse hook stdout: the bash
 * hook runs in claude's child process and writes to claude's stdin, not to
 * chroxy. The server already sees the same PreToolUse payload that the hook
 * sees (via the `cat > pre-*.json` sibling hook in writeHookSettings), so
 * applying the same length check at the same call site keeps the two layers
 * trivially in sync without adding a hook→server side-channel.
 */
describe('ClaudeTuiSession — multi-question intervention event (#4653)', () => {
  let emptySkillsDir
  let session

  beforeEach(() => {
    emptySkillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-skills-'))
    session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
    // _emitToolHookEvent reads _activeTurn for the synth-id fallback path.
    // Tests drive it directly without going through start() / sendMessage().
    session._activeTurn = { messageId: 'msg-test', startedAt: Date.now(), aborted: false, synthSeq: 0 }
  })

  afterEach(async () => {
    if (session) {
      try { await session.destroy() } catch { /* ignore */ }
      session = null
    }
    if (emptySkillsDir) rmSync(emptySkillsDir, { recursive: true, force: true })
    emptySkillsDir = null
  })

  it('declares multi_question_intervention as a customEvent', () => {
    // The static `customEvents` getter is what SessionManager._wireSessionEvents
    // reads to decide which provider-specific events to proxy as transient
    // session_events. Without this declaration the event would fire on the
    // session but never reach the WS wire — silent loss, hard to debug.
    const customEvents = ClaudeTuiSession.customEvents || []
    assert.ok(
      customEvents.includes('multi_question_intervention'),
      `customEvents must declare multi_question_intervention so SessionManager forwards it; got ${JSON.stringify(customEvents)}`,
    )
  })

  it('emits multi_question_intervention for a 2-question AskUserQuestion PreToolUse', () => {
    const events = []
    session.on('multi_question_intervention', (data) => events.push(data))

    session._emitToolHookEvent('PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_multi_1',
      tool_input: {
        questions: [
          { question: 'Which provider?', header: 'Provider', options: [{ label: 'A', value: 'a' }] },
          { question: 'Which transport?', header: 'Transport', options: [{ label: 'B', value: 'b' }] },
        ],
      },
    }, 'msg-test')

    assert.equal(events.length, 1, 'one intervention event per multi-q AskUserQuestion')
    const ev = events[0]
    assert.equal(ev.toolUseId, 'toolu_multi_1', 'toolUseId from payload propagates so the dashboard can dedup repeats')
    assert.equal(ev.questionCount, 2, 'questionCount matches questions[] length')
    assert.equal(ev.reason, 'multi_question', 'reason tag — extensible for future intervention types')
    assert.equal(typeof ev.timestamp, 'number', 'timestamp populated so the UI can render "Ns ago"')
    assert.ok(ev.timestamp <= Date.now(), 'timestamp is wall-clock, not future-dated')
  })

  it('does NOT emit multi_question_intervention for a single-question AskUserQuestion', () => {
    const events = []
    session.on('multi_question_intervention', (data) => events.push(data))

    session._emitToolHookEvent('PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_single_1',
      tool_input: {
        questions: [
          { question: 'Only one?', header: 'Only', options: [{ label: 'A', value: 'a' }] },
        ],
      },
    }, 'msg-test')

    assert.equal(events.length, 0,
      'single-question AskUserQuestion is the happy path — no intervention')
  })

  it('does NOT emit multi_question_intervention for non-AskUserQuestion tools', () => {
    const events = []
    session.on('multi_question_intervention', (data) => events.push(data))

    session._emitToolHookEvent('PreToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'toolu_bash_1',
      tool_input: { command: 'ls' },
    }, 'msg-test')

    assert.equal(events.length, 0, 'Bash and friends never intervene here')
  })

  it('does NOT emit on PostToolUse — only PreToolUse matches the hook deny window', () => {
    const events = []
    session.on('multi_question_intervention', (data) => events.push(data))

    session._emitToolHookEvent('PostToolUse', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_post_1',
      tool_input: {
        questions: [
          { question: 'q1?', header: 'q1', options: [{ label: 'A', value: 'a' }] },
          { question: 'q2?', header: 'q2', options: [{ label: 'B', value: 'b' }] },
        ],
      },
      tool_response: 'ok',
    }, 'msg-test')

    assert.equal(events.length, 0,
      'PostToolUse runs AFTER the deny would have fired; emitting again would double-count')
  })

  it('emits with synthesized toolUseId when payload omits tool_use_id', () => {
    // Older claude builds / certain MCP tools omit tool_use_id. The existing
    // _emitToolHookEvent synth path covers tool_start; the intervention path
    // must use the same id so the dashboard dedup-by-id key matches across
    // tool_start + intervention.
    const events = []
    session.on('multi_question_intervention', (data) => events.push(data))

    session._emitToolHookEvent('PreToolUse', {
      tool_name: 'AskUserQuestion',
      // tool_use_id intentionally absent
      tool_input: {
        questions: [
          { question: 'q1?', header: 'q1', options: [{ label: 'A', value: 'a' }] },
          { question: 'q2?', header: 'q2', options: [{ label: 'B', value: 'b' }] },
          { question: 'q3?', header: 'q3', options: [{ label: 'C', value: 'c' }] },
        ],
      },
    }, 'msg-test')

    assert.equal(events.length, 1, 'still emits even without payload tool_use_id')
    assert.ok(
      typeof events[0].toolUseId === 'string' && events[0].toolUseId.length > 0,
      'synthesized toolUseId is a non-empty string',
    )
    assert.equal(events[0].questionCount, 3)
  })
})
