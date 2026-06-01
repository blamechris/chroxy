import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionManager } from '../src/permission-manager.js'

/**
 * #4731 — SDK mode end-to-end multi-question AskUserQuestion support.
 *
 * SdkSession.respondToQuestion delegates straight through to
 * PermissionManager.respondToQuestion (`sdk-session.js:1136`), so the
 * round-trip from the dashboard's wire `answersMap` to the SDK's
 * `updatedInput.answers` is entirely owned by PermissionManager. These
 * tests pin the four wedge shapes the TUI driver failed on so the SDK
 * mode can be enabled with confidence:
 *
 *   1. mixed-type        — single-select + multi-select in one form
 *   2. all-single-select — every question is single-select
 *   3. all-multi-select  — every question is multi-select
 *   4. with-Other        — freeform answer for a question whose options
 *                          list includes the SDK's automatic "Other"
 *                          sentinel
 *
 * The SDK output spec (`@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:2696`)
 * is explicit: "The answers provided by the user (question text -> answer
 * string; multi-select answers are comma-separated)". That dictates the
 * wire-to-SDK normalization rules pinned below — multi-select arrays from
 * the dashboard (either native arrays after #4731 schema bump or legacy
 * JSON-stringified arrays from #4604 Chunk B dashboards) must collapse to
 * a single comma-separated string per question.
 */

const silentLog = { info() {}, warn() {} }

function createManager() {
  return new PermissionManager({ log: silentLog })
}

describe('SDK multi-question wedge shapes (#4731)', () => {
  let pm

  beforeEach(() => {
    pm = createManager()
  })

  afterEach(() => {
    pm.destroy()
  })

  it('mixed-type form: single-select + multi-select answers in one round-trip', async () => {
    const questions = [
      { question: 'Color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] },
      { question: 'Features?', header: 'Features', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Tests' }, { label: 'CI' }] },
    ]
    const promise = pm._handleAskUserQuestion({ questions }, null)

    // Dashboard sends arrays for multi-select questions (post-#4731 wire)
    pm.respondToQuestion('', { 'Color?': 'Red', 'Features?': ['Auth', 'Tests'] })

    const result = await promise
    assert.equal(result.behavior, 'allow')
    // Per SDK type contract, multi-select arrives as a comma-separated string
    assert.deepEqual(result.updatedInput.answers, {
      'Color?': 'Red',
      'Features?': 'Auth, Tests',
    })
  })

  it('all-single-select form: every answer arrives as a plain string', async () => {
    const questions = [
      { question: 'Lib?', header: 'Lib', options: [{ label: 'date-fns' }, { label: 'dayjs' }] },
      { question: 'Style?', header: 'Style', options: [{ label: 'CSS' }, { label: 'Tailwind' }] },
      { question: 'DB?', header: 'DB', options: [{ label: 'pg' }, { label: 'sqlite' }] },
    ]
    const promise = pm._handleAskUserQuestion({ questions }, null)

    pm.respondToQuestion('', { 'Lib?': 'date-fns', 'Style?': 'Tailwind', 'DB?': 'pg' })

    const result = await promise
    assert.deepEqual(result.updatedInput.answers, {
      'Lib?': 'date-fns',
      'Style?': 'Tailwind',
      'DB?': 'pg',
    })
  })

  it('all-multi-select form: every answer is a comma-separated string', async () => {
    const questions = [
      { question: 'Features?', header: 'Features', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Targets?', header: 'Targets', multiSelect: true, options: [{ label: 'iOS' }, { label: 'Android' }, { label: 'Web' }] },
    ]
    const promise = pm._handleAskUserQuestion({ questions }, null)

    pm.respondToQuestion('', {
      'Features?': ['A', 'B'],
      'Targets?': ['iOS', 'Web'],
    })

    const result = await promise
    assert.deepEqual(result.updatedInput.answers, {
      'Features?': 'A, B',
      'Targets?': 'iOS, Web',
    })
  })

  it('with-Other / freeform: arbitrary string passes through unchanged', async () => {
    // The SDK auto-provides an "Other" option whose selection routes a
    // free-text reply. Per the AskUserQuestionOutput contract, that text
    // arrives in `answers[questionText]` as a plain string — no schema
    // transformation, no wrapping. Pin that the freeform text survives
    // round-trip exactly as the user typed it.
    const questions = [
      {
        question: 'Which framework?',
        header: 'Framework',
        options: [{ label: 'React' }, { label: 'Vue' }, { label: 'Other' }],
      },
    ]
    const promise = pm._handleAskUserQuestion({ questions }, null)

    pm.respondToQuestion('', { 'Which framework?': 'Solid.js (via Other)' })

    const result = await promise
    assert.equal(result.updatedInput.answers['Which framework?'], 'Solid.js (via Other)')
  })

  it('legacy dashboard JSON-stringified array values are unwrapped to comma-separated strings', async () => {
    // Pre-#4731 dashboards (and the in-tree #4604 Chunk B MultiQuestionForm)
    // JSON.stringify multi-select arrays so the wire shape stays
    // Record<string,string>. The server must transparently unwrap that
    // legacy shape so the SDK sees the canonical comma-separated string —
    // otherwise the model receives a raw JSON literal like '["A","B"]' as
    // the answer text and gets confused. Mixed with a plain-string single-
    // select to verify each value type is detected independently.
    const questions = [
      { question: 'Color?', header: 'Color', options: [{ label: 'Red' }] },
      { question: 'Features?', header: 'Features', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    ]
    const promise = pm._handleAskUserQuestion({ questions }, null)

    pm.respondToQuestion('', { 'Color?': 'Red', 'Features?': '["A","B"]' })

    const result = await promise
    assert.deepEqual(result.updatedInput.answers, {
      'Color?': 'Red',
      'Features?': 'A, B',
    })
  })

  it('regression: single-question happy path unchanged (string answer, no answersMap)', async () => {
    // The v0.9.4 happy path: dashboard sends a plain string `answer` field
    // for single-question prompts and no `answers` map. That must still
    // produce the legacy { [questionText]: <text> } mapping.
    const questions = [{ question: 'Continue?', header: 'Continue', options: [{ label: 'Yes' }, { label: 'No' }] }]
    const promise = pm._handleAskUserQuestion({ questions }, null)

    pm.respondToQuestion('Yes')

    const result = await promise
    assert.equal(result.behavior, 'allow')
    assert.deepEqual(result.updatedInput.answers, { 'Continue?': 'Yes' })
  })

  it('empty multi-select array yields an empty string (SDK accepts zero selections)', async () => {
    // The SDK accepts zero selections for multi-select questions. Per the
    // comma-separated rule, [] becomes ''. The model is then free to
    // interpret the empty as "skipped / no preference" — the contract is
    // owned by the model, not the wire layer.
    const questions = [
      { question: 'Optional features?', header: 'Optional', multiSelect: true, options: [{ label: 'A' }] },
    ]
    const promise = pm._handleAskUserQuestion({ questions }, null)

    pm.respondToQuestion('', { 'Optional features?': [] })

    const result = await promise
    assert.equal(result.updatedInput.answers['Optional features?'], '')
  })
})

describe('UserQuestionResponseSchema multi-select value (#4731)', () => {
  it('accepts arrays and strings as per-question answer values', async () => {
    const { UserQuestionResponseSchema } = await import('../../protocol/dist/schemas/client.js')

    // Pre-#4731 happy path — plain string values
    const stringOnly = UserQuestionResponseSchema.safeParse({
      type: 'user_question_response',
      answer: 'Red',
      answers: { 'Color?': 'Red' },
    })
    assert.equal(stringOnly.success, true, 'string-valued answers must still parse')

    // Post-#4731 — array values for multi-select
    const withArray = UserQuestionResponseSchema.safeParse({
      type: 'user_question_response',
      answer: '',
      answers: { 'Color?': 'Red', 'Features?': ['Auth', 'Tests'] },
    })
    assert.equal(withArray.success, true, `array-valued multi-select answers must parse (got: ${JSON.stringify(withArray.error?.issues)})`)
  })
})
