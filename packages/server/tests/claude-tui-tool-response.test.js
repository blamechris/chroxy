import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import { normalizeClaudeTuiToolResponse } from '../src/claude-tui-tool-response.js'
import { emitToolResults } from '../src/tool-result.js'

// #8082 — hand-built fixtures reproducing the exact envelopes quoted in the
// issue (a live dogfood pass on 2026-09-28, daemon 9ee74d5f8). These are NOT
// read from a real ~/.claude transcript (never do that — see the worker
// brief); they're constructed by hand from the shapes the issue quotes and
// from Claude Code's documented PostToolUse hook payload / transcript
// toolUseResult shape: `{ stdout, stderr, interrupted, isImage,
// noOutputExpected }` for Bash, `{ type: 'text', file: { filePath, content,
// numLines, startLine, totalLines } }` for Read.

describe('normalizeClaudeTuiToolResponse — #8082 issue fixtures', () => {
  it('Bash: renders stdout, not the JSON envelope', () => {
    const fixture = {
      stdout: '/Users/blamechris/Projects\nMon Sep 28 20:02:44 PDT 2026\nAeolus\n',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    }
    const result = normalizeClaudeTuiToolResponse('Bash', fixture)

    assert.ok(!result.startsWith('{'), 'must not be a JSON envelope')
    assert.ok(!result.includes('"interrupted"'), 'must not leak envelope fields')
    assert.equal(result, '/Users/blamechris/Projects\nMon Sep 28 20:02:44 PDT 2026\nAeolus\n')
  })

  it('Read: renders the file content, not the JSON envelope', () => {
    const fixture = {
      type: 'text',
      file: {
        filePath: '/Users/blamechris/.claude/projects/-chroxy/memory/MEMORY.md',
        content: '# Chroxy Project Memory\nline2\nline3\nline4\nline5\nline6',
        numLines: 6,
        startLine: 1,
        totalLines: 6,
      },
    }
    const result = normalizeClaudeTuiToolResponse('Read', fixture)

    assert.ok(!result.startsWith('{'), 'must not be a JSON envelope')
    assert.ok(!result.includes('"numLines"'), 'must not leak envelope fields')
    assert.equal(result, '# Chroxy Project Memory\nline2\nline3\nline4\nline5\nline6')
  })
})

describe('normalizeClaudeTuiToolResponse — Bash edge cases', () => {
  it('appends non-empty stderr after stdout', () => {
    const result = normalizeClaudeTuiToolResponse('Bash', {
      stdout: 'partial output',
      stderr: 'command not found: foo',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    })
    assert.equal(result, 'partial output\ncommand not found: foo')
  })

  it('is_error / stderr-only: a failing command with no stdout renders stderr alone', () => {
    const result = normalizeClaudeTuiToolResponse('Bash', {
      stdout: '',
      stderr: 'bash: nonexistent-cmd: command not found',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    })
    assert.equal(result, 'bash: nonexistent-cmd: command not found')
  })

  it('empty stdout, no stderr, not interrupted renders empty string', () => {
    const result = normalizeClaudeTuiToolResponse('Bash', {
      stdout: '',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: true,
    })
    assert.equal(result, '')
  })

  it('interrupted with no output renders a placeholder, not a blank card', () => {
    const result = normalizeClaudeTuiToolResponse('Bash', {
      stdout: '',
      stderr: '',
      interrupted: true,
      isImage: false,
      noOutputExpected: false,
    })
    assert.equal(result, '[Interrupted — no output]')
  })

  it('interrupted WITH partial output still shows the output (interrupted flag does not swallow it)', () => {
    const result = normalizeClaudeTuiToolResponse('Bash', {
      stdout: 'still running when interrupted...',
      stderr: '',
      interrupted: true,
      isImage: false,
      noOutputExpected: false,
    })
    assert.equal(result, 'still running when interrupted...')
  })

  it('isImage:true never dumps raw/base64 stdout into a text card', () => {
    const result = normalizeClaudeTuiToolResponse('Bash', {
      stdout: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB...(base64 noise)',
      stderr: '',
      interrupted: false,
      isImage: true,
      noOutputExpected: false,
    })
    assert.equal(result, '[Image output omitted]')
    assert.ok(!result.includes('base64'), 'must not leak raw image payload as text')
  })

  it('isImage:true with stderr keeps the stderr visible', () => {
    const result = normalizeClaudeTuiToolResponse('Bash', {
      stdout: 'binarydata',
      stderr: 'partial capture failed',
      interrupted: false,
      isImage: true,
      noOutputExpected: false,
    })
    assert.equal(result, '[Image output omitted]\npartial capture failed')
  })
})

describe('normalizeClaudeTuiToolResponse — MCP-shaped content passthrough', () => {
  it('a { content: string } shape (matches a tool_result block) is used verbatim', () => {
    const result = normalizeClaudeTuiToolResponse('mcp__foo__bar', { content: 'mcp tool output', isError: false })
    assert.equal(result, 'mcp tool output')
  })

  it('a { content: [{type:"text",text}] } shape is flattened the same way tool-result.js does', () => {
    const result = normalizeClaudeTuiToolResponse('mcp__foo__bar', {
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
      isError: false,
    })
    assert.equal(result, 'line one\nline two')
  })

  it('an is_error MCP result still renders its content text (error affordance is a separate wire field, not content mangling)', () => {
    const result = normalizeClaudeTuiToolResponse('mcp__foo__bar', {
      content: [{ type: 'text', text: 'tool threw: boom' }],
      isError: true,
    })
    assert.equal(result, 'tool threw: boom')
  })
})

describe('normalizeClaudeTuiToolResponse — unchanged behavior', () => {
  it('plain string tool_response passes through unchanged', () => {
    assert.equal(normalizeClaudeTuiToolResponse('Edit', 'File edited successfully'), 'File edited successfully')
  })

  it('unknown tool + structured result with no known shape is unchanged from today (JSON.stringify)', () => {
    const fixture = { selectedLabel: 'Patch' }
    const result = normalizeClaudeTuiToolResponse('AskUserQuestion', fixture)
    assert.equal(result, JSON.stringify(fixture))
  })

  it('a Bash-named response missing both stdout and stderr falls through to JSON.stringify (not Bash-shaped)', () => {
    const fixture = { exitCode: 0, note: 'no stdout/stderr fields at all' }
    const result = normalizeClaudeTuiToolResponse('Bash', fixture)
    assert.equal(result, JSON.stringify(fixture))
  })

  it('a Read-named response with no file.content falls through to JSON.stringify (not Read-shaped)', () => {
    const fixture = { type: 'text', file: { filePath: '/x', numLines: 0 } }
    const result = normalizeClaudeTuiToolResponse('Read', fixture)
    assert.equal(result, JSON.stringify(fixture))
  })

  it('null/undefined tool_response renders empty string', () => {
    assert.equal(normalizeClaudeTuiToolResponse('Bash', null), '')
    assert.equal(normalizeClaudeTuiToolResponse('Bash', undefined), '')
  })
})

// Parity: the claude-tui path (normalizeClaudeTuiToolResponse) and the
// SDK/CLI path (tool-result.js's emitToolResults, which flattens a real
// tool_result content block) must produce the SAME wire `result` string for
// the same logical content shape. This is a STRUCTURAL parity test — it
// proves both paths reduce a tool_result-content-shaped payload (string, or
// an array of {type:'text',text} blocks) to identical flattened text. It
// does NOT prove SDK/CLI's real Bash/Read tool_result content is byte-
// identical to claude-tui's Bash/Read structured unwrap for every live tool
// call — nobody may spawn a real `claude` binary in this suite (sandbox
// tripwire) or read a real ~/.claude transcript, so that would need a live
// check (see the PR's "Needs live check" note).
describe('parity — claude-tui vs SDK/CLI (tool-result.js) wire shape', () => {
  it('same tool_result-content-shaped payload -> identical flattened text on both paths', () => {
    const contentBlocks = [
      { type: 'text', text: 'shared output line 1' },
      { type: 'text', text: 'shared output line 2' },
    ]

    // SDK/CLI path: a real tool_result content block through emitToolResults.
    const emitter = new EventEmitter()
    const sdkEvents = []
    emitter.on('tool_result', (e) => sdkEvents.push(e))
    emitToolResults([
      { type: 'tool_result', tool_use_id: 'tu_parity', content: contentBlocks },
    ], emitter)

    // claude-tui path: the same content shape arriving as tool_response.
    const tuiResult = normalizeClaudeTuiToolResponse('mcp__foo__bar', { content: contentBlocks })

    assert.equal(sdkEvents.length, 1)
    assert.equal(tuiResult, sdkEvents[0].result)
    assert.equal(tuiResult, 'shared output line 1\nshared output line 2')
  })

  it('documents a KNOWN divergence: Bash/Read on claude-tui unwrap a structured envelope SDK/CLI never see raw (they only ever get already-flattened content), so there is no equivalent emitToolResults input to compare against for those two tools', () => {
    // SdkSession/CliSession never receive {stdout,stderr,...} or
    // {type:'text',file:{...}} as a tool_result block's `content` — Claude's
    // own agent harness has already reduced Bash/Read output to plain text
    // by the time it reaches the model's conversation. claude-tui is the
    // ONLY provider that ever sees the raw structured shape (via the
    // PostToolUse hook), which is exactly why this normalizer exists.
    const bashResult = normalizeClaudeTuiToolResponse('Bash', { stdout: 'ok\n', stderr: '' })
    assert.equal(bashResult, 'ok\n')
  })
})
