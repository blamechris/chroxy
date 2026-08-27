import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractToolInputSemantics,
  buildToolStartData,
} from '../src/claude-stream-parser.js'

/**
 * Boundary tests for the ClaudeStreamParser module.
 *
 * The parser is a pure-function module shared by CliSession and SdkSession
 * to dedupe Anthropic streaming-protocol parsing. These tests pin its
 * public contract:
 *
 *   - extractToolInputSemantics(toolName, parsedInput) -> { kind, payload }
 *   - buildToolStartData(messageId, contentBlock) -> { messageId, toolUseId, tool, input, serverName? }
 *
 * Behavior preservation across CliSession/SdkSession depends on these
 * staying byte-for-byte identical to the pre-extraction inline logic.
 */

describe('extractToolInputSemantics', () => {
  describe('AskUserQuestion', () => {
    it('returns ask_user_question kind with the questions array', () => {
      const result = extractToolInputSemantics('AskUserQuestion', {
        questions: [{ question: 'A?', options: [] }],
      })
      assert.equal(result.kind, 'ask_user_question')
      assert.deepEqual(result.payload, {
        questions: [{ question: 'A?', options: [] }],
      })
    })

    it('passes through undefined questions field as-is', () => {
      const result = extractToolInputSemantics('AskUserQuestion', {})
      assert.equal(result.kind, 'ask_user_question')
      assert.equal(result.payload.questions, undefined)
    })
  })

  describe('Task', () => {
    it('returns task kind with description and 200-char slice', () => {
      const result = extractToolInputSemantics('Task', { description: 'Run a thing' })
      assert.equal(result.kind, 'task')
      assert.equal(result.payload.description, 'Run a thing')
    })

    it('clamps description to 200 chars', () => {
      const long = 'x'.repeat(500)
      const result = extractToolInputSemantics('Task', { description: long })
      assert.equal(result.kind, 'task')
      assert.equal(result.payload.description.length, 200)
    })

    it('falls back to "Background task" when description is missing', () => {
      const result = extractToolInputSemantics('Task', {})
      assert.equal(result.kind, 'task')
      assert.equal(result.payload.description, 'Background task')
    })

    it('falls back to "Background task" when description is non-string', () => {
      const result = extractToolInputSemantics('Task', { description: 123 })
      assert.equal(result.kind, 'task')
      assert.equal(result.payload.description, 'Background task')
    })

    it('handles null/undefined input', () => {
      const result = extractToolInputSemantics('Task', null)
      assert.equal(result.kind, 'task')
      assert.equal(result.payload.description, 'Background task')
    })

    // #7340: Claude Code renamed the subagent tool `Task` -> `Agent`. Both the
    // standalone CLI (2.1.243) and the Agent SDK's bundled binary (2.1.114)
    // emit `"name":"Agent"` on the tool_use block -- captured from live
    // `-p --output-format stream-json` runs of each. A parser that only knows
    // `Task` tracks no subagents at all on either path, which is why the
    // session shows idle with reviewers still running. Both names must work:
    // chroxy supports whatever `claude` the user has installed.
    it('returns task kind for the `Agent` tool name (Claude Code >= 2.1.114)', () => {
      const result = extractToolInputSemantics('Agent', { description: 'Run a thing' })
      assert.ok(result, 'Agent must be recognised as the subagent tool')
      assert.equal(result.kind, 'task')
      assert.equal(result.payload.description, 'Run a thing')
    })

    // The verbatim input block from the backgrounded probe run.
    it('marks an Agent spawn backgrounded when run_in_background is true', () => {
      const result = extractToolInputSemantics('Agent', {
        description: 'Probe sleep test',
        prompt: 'Run `sleep 45` with the Bash tool, then reply with exactly: PROBE DONE',
        subagent_type: 'general-purpose',
        run_in_background: true,
      })
      assert.equal(result.kind, 'task')
      assert.equal(result.payload.background, true)
    })

    // The verbatim input block from the foreground probe run -- the field is
    // ABSENT, not `false`, so `background` must be derived by strict compare
    // and never default to true.
    it('does not mark a foreground Agent spawn backgrounded when the field is absent', () => {
      const result = extractToolInputSemantics('Agent', {
        description: 'Reply with BLUE',
        subagent_type: 'general-purpose',
        prompt: 'Reply with exactly the word BLUE and nothing else.',
      })
      assert.equal(result.kind, 'task')
      assert.equal(result.payload.background, false)
    })

    it('does not mark a Task spawn backgrounded on a non-boolean run_in_background', () => {
      for (const value of ['true', 1, {}, null]) {
        const result = extractToolInputSemantics('Task', { description: 'd', run_in_background: value })
        assert.equal(result.payload.background, false, `run_in_background: ${JSON.stringify(value)}`)
      }
    })
  })

  describe('EnterPlanMode', () => {
    it('returns enter_plan kind with empty payload', () => {
      const result = extractToolInputSemantics('EnterPlanMode', {})
      assert.equal(result.kind, 'enter_plan')
      assert.deepEqual(result.payload, {})
    })

    it('returns enter_plan kind even with no parsed input', () => {
      const result = extractToolInputSemantics('EnterPlanMode', null)
      assert.equal(result.kind, 'enter_plan')
    })
  })

  describe('ExitPlanMode', () => {
    it('returns exit_plan kind with parsed allowedPrompts array', () => {
      const result = extractToolInputSemantics('ExitPlanMode', {
        allowedPrompts: ['npm test', 'git status'],
      })
      assert.equal(result.kind, 'exit_plan')
      assert.deepEqual(result.payload.allowedPrompts, ['npm test', 'git status'])
    })

    it('returns empty allowedPrompts when field is missing', () => {
      const result = extractToolInputSemantics('ExitPlanMode', {})
      assert.equal(result.kind, 'exit_plan')
      assert.deepEqual(result.payload.allowedPrompts, [])
    })

    it('returns empty allowedPrompts when field is not an array', () => {
      const result = extractToolInputSemantics('ExitPlanMode', {
        allowedPrompts: 'oops',
      })
      assert.equal(result.kind, 'exit_plan')
      assert.deepEqual(result.payload.allowedPrompts, [])
    })

    it('returns empty allowedPrompts on null input', () => {
      const result = extractToolInputSemantics('ExitPlanMode', null)
      assert.equal(result.kind, 'exit_plan')
      assert.deepEqual(result.payload.allowedPrompts, [])
    })
  })

  describe('unknown tools', () => {
    it('returns null kind for unknown tool names', () => {
      const result = extractToolInputSemantics('Bash', { command: 'ls' })
      assert.equal(result, null)
    })

    it('returns null for empty/missing tool name', () => {
      assert.equal(extractToolInputSemantics('', {}), null)
      assert.equal(extractToolInputSemantics(undefined, {}), null)
    })
  })
})

describe('buildToolStartData', () => {
  it('uses content_block.id as both messageId and toolUseId', () => {
    const result = buildToolStartData('turn-msg-1', {
      type: 'tool_use',
      id: 'toolu_abc',
      name: 'Bash',
    })
    assert.deepEqual(result, {
      messageId: 'toolu_abc',
      toolUseId: 'toolu_abc',
      tool: 'Bash',
      input: null,
    })
  })

  it('falls back to `${messageId}-tool` when content_block.id is missing', () => {
    const result = buildToolStartData('turn-msg-1', {
      type: 'tool_use',
      name: 'Bash',
    })
    // Both fields must reuse the synthesized fallback so the wire schema
    // (ServerToolStartSchema.toolUseId: z.string()) still holds.
    assert.equal(result.messageId, 'turn-msg-1-tool')
    assert.equal(result.toolUseId, 'turn-msg-1-tool')
  })

  it('attaches serverName for MCP tools', () => {
    const result = buildToolStartData('turn-1', {
      type: 'tool_use',
      id: 'toolu_xyz',
      name: 'mcp__github__create_issue',
    })
    assert.equal(result.tool, 'mcp__github__create_issue')
    assert.equal(result.serverName, 'github')
  })

  it('does not attach serverName for built-in tools', () => {
    const result = buildToolStartData('turn-1', {
      type: 'tool_use',
      id: 'toolu_xyz',
      name: 'Read',
    })
    assert.equal('serverName' in result, false)
  })
})
