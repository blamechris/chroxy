import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { resendPendingQuestions, sendHistoryEntry } from '../src/ws-history.js'

/**
 * #8373 -- the two payloads claude-tui forwards out of a PreToolUse hook that
 * did not take the shared redaction floor: the AskUserQuestion `questions`
 * (live `user_question`, history, pending-question replay) and the backgrounded
 * Bash command (the "waiting on" chip). Every case drives the real producer,
 * `_emitToolHookEvent`, and reads what each consumer is handed.
 *
 * Tokens are synthetic: the right SHAPE for the redaction patterns, no real key.
 */
const SECRET = 'sk-ant-api03-' + 'A'.repeat(48)
const SECRET_2 = 'sk-ant-api03-' + 'B'.repeat(48)
const SECRET_3 = 'sk-ant-api03-' + 'C'.repeat(48)
const SECRET_4 = 'sk-ant-api03-' + 'D'.repeat(48)

describe('ClaudeTuiSession hook payloads take the shared redaction floor (#8373)', () => {
  let emptySkillsDir
  let session

  beforeEach(() => {
    emptySkillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-skills-'))
    session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
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

  const askQuestion = (toolUseId, toolInput) => session._emitToolHookEvent('PreToolUse', {
    tool_use_id: toolUseId,
    tool_name: 'AskUserQuestion',
    tool_input: toolInput,
  }, 'msg-test')

  describe('AskUserQuestion questions', () => {
    const secretBearing = () => ({
      questions: [{
        question: `Deploy with token=${SECRET} now?`,
        header: `Key ${SECRET_2}`,
        multiSelect: false,
        options: [
          { label: 'Yes, deploy', description: `uses ${SECRET_3}` },
          { label: 'No, hold', description: 'Do nothing' },
        ],
      }],
    })

    it('masks a secret in the question text, header, and option description on the live user_question', () => {
      const events = []
      session.on('user_question', (e) => events.push(e))
      askQuestion('toolu_q1', secretBearing())

      assert.equal(events.length, 1)
      const wire = JSON.stringify(events[0])
      for (const s of [SECRET, SECRET_2, SECRET_3]) {
        assert.ok(!wire.includes(s), 'a synthetic token must not reach the user_question payload')
      }
      assert.ok(wire.includes('[REDACTED]'), 'the redaction marker is what the user sees instead')
    })

    it('keeps the shape clients and the form driver rely on', () => {
      const events = []
      session.on('user_question', (e) => events.push(e))
      askQuestion('toolu_q2', secretBearing())

      const [q] = events[0].questions
      assert.ok(Array.isArray(events[0].questions) && events[0].questions.length === 1)
      assert.equal(q.multiSelect, false)
      assert.equal(q.options.length, 2, 'option count is untouched (the TUI is driven by position)')
      assert.equal(q.options[0].label, 'Yes, deploy', 'a label with no secret is verbatim, so the answer still matches it')
      assert.equal(q.options[1].description, 'Do nothing')
      assert.equal(events[0].toolUseId, 'toolu_q2')
    })

    it('leaves a question with nothing secret byte-for-byte as the hook wrote it', () => {
      const events = []
      session.on('user_question', (e) => events.push(e))
      const input = {
        questions: [{
          question: 'Which provider?',
          header: 'Provider',
          multiSelect: false,
          options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
        }],
      }
      askQuestion('toolu_q3', input)
      assert.deepEqual(events[0].questions, input.questions)
    })

    it('caps an oversized question and still delivers an array with its options', () => {
      const events = []
      session.on('user_question', (e) => events.push(e))
      askQuestion('toolu_q4', {
        questions: [{
          question: 'x'.repeat(200 * 1024),
          header: 'Big',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      })

      assert.ok(Array.isArray(events[0].questions))
      assert.ok(JSON.stringify(events[0]).length < 40 * 1024, 'the oversized text is capped, not shipped whole')
      assert.equal(events[0].questions[0].options.length, 2)
    })

    it('keeps the question usable when one piece is over the cap on its own', () => {
      const events = []
      session.on('user_question', (e) => events.push(e))
      askQuestion('toolu_q5', {
        questions: [{
          question: 'q',
          header: 'h'.repeat(8 * 1024),
          description: 'd'.repeat(8 * 1024),
          options: [{ label: 'A', description: 'y'.repeat(8 * 1024) + 'z'.repeat(8 * 1024) }],
        }],
      })
      const [q] = events[0].questions
      assert.equal(typeof q.question, 'string', 'the question text field is still there to render')
      assert.equal(q.options.length, 1)
      assert.equal(typeof q.options[0].label === 'string' && q.options[0].label.length > 0, true, 'the option keeps a label to answer with')
      assert.ok(JSON.stringify(events[0]).length < 60 * 1024)
    })

    it('does not keep a raw copy for answer routing or the pending-question replay', () => {
      askQuestion('toolu_q6', secretBearing())

      const pending = session.getPendingQuestions()
      assert.equal(pending.length, 1)
      assert.ok(!JSON.stringify(pending).includes(SECRET), 'the pending list is what a replay re-sends')
      assert.ok(!JSON.stringify(session._pendingUserAnswers.get('toolu_q6')).includes(SECRET_3), 'the answer-routing entry holds no raw token')
    })

    it('masks the token in the history entry and in the frame a replay re-sends', () => {
      const history = new SessionMessageHistory({ maxHistory: 10 })
      const events = []
      session.on('user_question', (e) => events.push(e))
      askQuestion('toolu_q7', secretBearing())

      history.recordHistory('s1', 'user_question', events[0])
      const [entry] = history.getHistory('s1')
      assert.ok(!JSON.stringify(entry).includes(SECRET), 'the persisted entry is clean')

      const sent = []
      sendHistoryEntry((_ws, payload) => sent.push(payload), null, 's1', entry)
      assert.ok(!JSON.stringify(sent).includes(SECRET))

      const resent = []
      resendPendingQuestions({
        sessionManager: { getSession: () => ({ session }) },
        send: (_ws, payload) => resent.push(payload),
      }, {}, 's1')
      assert.equal(resent.length, 1)
      assert.equal(resent[0].type, 'user_question')
      for (const s of [SECRET, SECRET_2, SECRET_3]) {
        assert.ok(!JSON.stringify(resent).includes(s), 'the pending replay frame is clean')
      }
    })

    it('masks the token in the wire frame the normalizer builds', () => {
      const normalizer = new EventNormalizer({ flushIntervalMs: 10 })
      const events = []
      session.on('user_question', (e) => events.push(e))
      try {
        askQuestion('toolu_q8', secretBearing())
        const frame = normalizer.normalize('user_question', events[0], { sessionId: 's1', mode: 'multi', getSessionEntry: () => ({ session: {}, name: 'n', cwd: '/tmp' }) })
        assert.ok(!JSON.stringify(frame).includes(SECRET))
      } finally {
        normalizer.destroy()
      }
    })

    it('still answers by the label a client was shown when that label held a secret', () => {
      askQuestion('toolu_q9', {
        questions: [{
          question: 'Pick one',
          options: [{ label: `Use ${SECRET_4}` }, { label: 'Other' }],
        }],
      })
      const shown = session.getPendingQuestions()[0].questions[0].options.map((o) => o.label)
      const entry = session._pendingUserAnswers.get('toolu_q9')
      assert.ok(entry.options.some((o) => o.label === shown[0]), 'the label a client sends back is found in the routing entry')
      assert.ok(!shown[0].includes(SECRET_4))
    })
  })

  describe('background command chip', () => {
    const background = (toolUseId, shellId, command) => {
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: toolUseId,
        tool_name: 'Bash',
        tool_input: { command, run_in_background: true },
      }, 'msg-test')
      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: toolUseId,
        tool_name: 'Bash',
        tool_response: `Command running in background with ID: ${shellId}. Output…`,
      }, 'msg-test')
    }

    it('masks a secret in the command on the chip event and the pending snapshot', () => {
      const events = []
      session.on('background_work_changed', (e) => events.push(e))
      background('toolu_bg1', 'tui-shell-1', `curl -H "x: y" https://example.test --token ${SECRET} && TOKEN=${SECRET_2} ./run.sh`)

      assert.equal(events.length, 1)
      const wire = JSON.stringify(events[0])
      assert.ok(!wire.includes(SECRET) && !wire.includes(SECRET_2), 'the chip event is clean')
      const snapshot = JSON.stringify(session.getPendingBackgroundShells())
      assert.ok(!snapshot.includes(SECRET) && !snapshot.includes(SECRET_2), 'the snapshot a late client reads is clean')
      assert.ok(snapshot.includes('./run.sh'), 'the rest of the command survives')
    })

    it('leaves a command with nothing secret verbatim', () => {
      background('toolu_bg2', 'tui-shell-2', 'sleep 600')
      assert.equal(session._pendingBackgroundShells.get('tui-shell-2').command, 'sleep 600')
    })

    it('caps an oversized command and never keeps the front of a secret the cap cut through', () => {
      // A secret that straddles the scan bound: a clip first would leave
      // `sk-ant-api03-AAAA...` as a prefix the patterns no longer match.
      const filler = 'a'.repeat(8150)
      background('toolu_bg3', 'tui-shell-3', `${filler} ${SECRET} tail`)

      const { command } = session._pendingBackgroundShells.get('tui-shell-3')
      assert.ok(command.length <= 8192, 'the command is capped')
      assert.ok(!command.includes('sk-ant-api03-') && !command.includes('AAAA'), 'no piece of the straddling token survives')
    })
  })
})
