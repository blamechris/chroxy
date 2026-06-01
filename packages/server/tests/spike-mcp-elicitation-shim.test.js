import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHROXY_ASK_USER_TOOL,
  STEERING_PROMPT_ADDENDUM,
  handleChroxyAskUser,
} from '../scripts/spike-mcp-elicitation-shim.mjs'

// These tests guard the *shape* of the spike, not its production
// behavior — the spike is a research artifact for #4734. The point is
// to catch regressions in the schema the decision doc relies on:
//   - The tool's input shape mirrors the AskUserQuestion shape observed
//     at packages/server/src/claude-tui-session.js:1384 (questions[],
//     options[].label, multiSelect). If the schemas drift, the
//     "near-mirror" claim in the decision doc becomes inaccurate.
//   - The steering addendum names the *MCP-prefixed* tool name
//     (mcp__chroxy__chroxy_ask_user) so a prompt-steering bake-off can
//     run against a real claude session without an additional hand-edit.
//   - The handler accepts the canonical multi-question payload and
//     produces an MCP-shaped result envelope, proving the JSON-RPC
//     `tools/call` round-trip path is exercisable from a self-test.

test('chroxy_ask_user tool schema mirrors AskUserQuestion input shape', () => {
  assert.equal(CHROXY_ASK_USER_TOOL.name, 'chroxy_ask_user')
  assert.equal(CHROXY_ASK_USER_TOOL.inputSchema.type, 'object')

  const questionsSchema = CHROXY_ASK_USER_TOOL.inputSchema.properties.questions
  assert.equal(questionsSchema.type, 'array')
  assert.equal(questionsSchema.minItems, 1)
  // AskUserQuestion's runtime caps multi-question forms below the
  // per-form-shape limit; the spike mirrors a conservative 4.
  assert.equal(questionsSchema.maxItems, 4)

  const item = questionsSchema.items
  assert.deepEqual(item.required.sort(), ['options', 'question'].sort())
  assert.equal(item.properties.question.type, 'string')
  assert.equal(item.properties.options.type, 'array')
  assert.equal(item.properties.multiSelect.type, 'boolean')

  // options[].label is the single load-bearing field — the keystroke
  // driver maps labels to digits; the MCP shim returns labels back.
  // The schema MUST require it so a malformed model call rejects
  // structurally rather than producing an answer to "option-undefined".
  const optionItem = item.properties.options.items
  assert.deepEqual(optionItem.required, ['label'])
  assert.equal(optionItem.properties.label.type, 'string')
})

test('steering prompt addendum names the MCP-prefixed tool', () => {
  // claude exposes MCP tools under the mcp__<server>__<tool> namespace
  // (per packages/server/src/mcp-tools.js). The steering prompt must
  // use the prefixed name so a bake-off can run without hand-editing.
  assert.match(STEERING_PROMPT_ADDENDUM, /mcp__chroxy__chroxy_ask_user/)
  // The addendum must also mention AskUserQuestion explicitly so the
  // model is told what NOT to prefer. Without this contrast the
  // steering signal is much weaker (empirically — see decision doc).
  assert.match(STEERING_PROMPT_ADDENDUM, /AskUserQuestion/)
})

test('handleChroxyAskUser returns an MCP-shaped envelope for multi-question input', async () => {
  const result = await handleChroxyAskUser({
    questions: [
      {
        question: 'Pick one',
        options: [{ label: 'A' }, { label: 'B' }],
      },
      {
        question: 'Pick any',
        multiSelect: true,
        options: [{ label: 'X' }, { label: 'Y' }],
      },
    ],
  })

  assert.ok(Array.isArray(result.content), 'result.content must be an array')
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'text')

  const parsed = JSON.parse(result.content[0].text)
  assert.equal(parsed.answers.length, 2)
  // First question is single-select → scalar answer
  assert.equal(typeof parsed.answers[0].answer, 'string')
  assert.equal(parsed.answers[0].answer, 'A')
  // Second is multiSelect → array answer (matches AskUserQuestion's
  // own multi-select shape in respondToQuestion at sdk-session.js)
  assert.ok(Array.isArray(parsed.answers[1].answer))
  assert.deepEqual(parsed.answers[1].answer, ['X'])
})

test('handleChroxyAskUser rejects empty questions array', async () => {
  await assert.rejects(
    () => handleChroxyAskUser({ questions: [] }),
    /questions array is required/,
  )
})
