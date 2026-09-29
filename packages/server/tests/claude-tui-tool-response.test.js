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

  // #8082 PR review, Suggestion #4: a bare non-object, non-string
  // tool_response (no real tool produces this) now renders '' — matching
  // the ORIGINAL pre-#8082 behavior (only the string and object branches
  // ever set `result`; everything else fell through to the '' default) —
  // rather than String(resp), which the initial PR introduced.
  it('a bare non-object, non-string tool_response (e.g. a number) renders empty string, matching pre-#8082 behavior', () => {
    assert.equal(normalizeClaudeTuiToolResponse('Bash', 42), '')
    assert.equal(normalizeClaudeTuiToolResponse('Bash', true), '')
  })
})

// #8082 PR review, Critical #1 — Write's structured result:
// { type: 'create'|'update', filePath, content, structuredPatch,
// originalFile, userModified }, where `content` is the ENTIRE written
// file. Before this fix, rule 1's unscoped string-`content` check matched
// it and rendered the whole file body into the tool card.
describe('normalizeClaudeTuiToolResponse — Write (#8082 PR review, Critical #1)', () => {
  // A realistic ~10KB body so a regression (rendering the body instead of
  // a confirmation) is unambiguous — mirrors the reviewer's own repro.
  const BIG_FILE_MARKER = 'UNIQUE_FILE_BODY_MARKER_8082'
  const bigFileBody = `${BIG_FILE_MARKER}\n${'x'.repeat(10 * 1024)}`

  it('create: renders a short confirmation with the path, never the file body', () => {
    const result = normalizeClaudeTuiToolResponse('Write', {
      type: 'create',
      filePath: '/Users/blamechris/Projects/chroxy/scratch.txt',
      content: bigFileBody,
      structuredPatch: [],
      originalFile: '',
      userModified: false,
    })

    assert.equal(
      result,
      `Wrote ${Buffer.byteLength(bigFileBody, 'utf8')} bytes to /Users/blamechris/Projects/chroxy/scratch.txt (created).`,
    )
    assert.ok(!result.includes(BIG_FILE_MARKER), 'must not include the file body')
    assert.ok(result.length < 200, 'must be a short confirmation, not the ~10KB file')
  })

  it('update: renders a short confirmation with the path, no "(created)" suffix, never the file body', () => {
    const result = normalizeClaudeTuiToolResponse('Write', {
      type: 'update',
      filePath: '/Users/blamechris/Projects/chroxy/CHANGELOG.md',
      content: bigFileBody,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['+added'] }],
      originalFile: 'old content',
      userModified: false,
    })

    assert.equal(
      result,
      `Wrote ${Buffer.byteLength(bigFileBody, 'utf8')} bytes to /Users/blamechris/Projects/chroxy/CHANGELOG.md.`,
    )
    assert.ok(!result.includes('(created)'), 'update must not claim "(created)"')
    assert.ok(!result.includes(BIG_FILE_MARKER), 'must not include the file body')
  })

  it('matches the wording byok-tool-executor.js already produces for the same tool (formatWriteConfirmation)', async () => {
    const { formatWriteConfirmation } = await import('../src/built-in-tools/tool-transforms.js')
    const expected = formatWriteConfirmation({ bytesWritten: 11, filePath: '/tmp/x.txt', created: true })

    const result = normalizeClaudeTuiToolResponse('Write', {
      type: 'create',
      filePath: '/tmp/x.txt',
      content: 'hello world', // 11 bytes
      structuredPatch: [],
    })

    assert.equal(result, expected)
  })

  it('a Write-shaped response is recognised regardless of tool name (shape-based, not name-based)', () => {
    // The predicate is a shape check (filePath/structuredPatch/type), not a
    // toolName === 'Write' check — see isFileWriteResponseShape's doc for
    // why (a wrapped/renamed Write-like tool should get the same
    // protection). toolName is deliberately something else here.
    const result = normalizeClaudeTuiToolResponse('mcp__fs__write_file', {
      type: 'create',
      filePath: '/tmp/y.txt',
      content: BIG_FILE_MARKER,
      structuredPatch: [],
    })
    assert.ok(!result.includes(BIG_FILE_MARKER))
    assert.ok(result.startsWith('Wrote '))
  })
})

// #8082 PR review, per-tool table — Grep's content-mode result
// ({ mode: 'content', content: '<rg output>', numLines }) must still be
// rendered via rule 1b: it has a string `content` field but is NOT
// Write-shaped (no filePath/structuredPatch/type: create|update).
describe('normalizeClaudeTuiToolResponse — Grep content-mode (rule 1b, not Write-shaped)', () => {
  it('renders the grep output text, not JSON.stringify', () => {
    const fixture = {
      mode: 'content',
      content: 'src/foo.js:12:  const x = 1\nsrc/bar.js:3:  const x = 2',
      numLines: 2,
    }
    const result = normalizeClaudeTuiToolResponse('Grep', fixture)
    assert.equal(result, fixture.content)
    assert.ok(!result.startsWith('{'), 'must not be a JSON envelope')
  })
})

// #8082 PR review, Suggestion #2 / Mutant B — the surviving mutant: no
// fixture previously supplied an object carrying BOTH a `content` field
// AND a Bash/Read discriminator, so swapping the check order (Bash/Read
// before the content-field rule, or the content-field rule before the
// Write-shape check) went undetected. These fixtures pin the intended
// priority so that regression is caught.
describe('normalizeClaudeTuiToolResponse — Edit is not mistaken for Write', () => {
  it('an Edit result (filePath + structuredPatch, no type/content) keeps its unchanged fallback and never claims a write', () => {
    const fixture = {
      filePath: '/tmp/edited.js',
      oldString: 'const a = 1',
      newString: 'const a = 2',
      originalFile: 'const a = 1\n',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-const a = 1', '+const a = 2'] }],
      userModified: false,
      replaceAll: false,
    }
    const result = normalizeClaudeTuiToolResponse('Edit', fixture)
    assert.ok(!/Wrote \d+ bytes/.test(result), 'an Edit must not be rendered as a write confirmation')
    assert.equal(result, JSON.stringify(fixture))
  })
})

describe('normalizeClaudeTuiToolResponse — rule-order regression (kills the surviving mutant)', () => {
  it('a Write-shaped object ALSO named "Bash" still renders the Write confirmation, not stdout/stderr (Write-shape check must run before the Bash branch)', () => {
    // Pathological but exactly what a naive reorder would get wrong: this
    // object satisfies isFileWriteResponseShape AND normalizeBashResponse's
    // "has stdout or stderr" test.
    const result = normalizeClaudeTuiToolResponse('Bash', {
      type: 'create',
      filePath: '/tmp/pathological.txt',
      content: 'the file body, not stdout',
      structuredPatch: [],
      stdout: 'this must NOT win',
      stderr: '',
    })
    assert.equal(result, 'Wrote 25 bytes to /tmp/pathological.txt (created).')
    assert.ok(!result.includes('this must NOT win'))
  })

  it('a Write-shaped object with a string content field never falls through rule 1b (Write-shape check must run before the content-field rule)', () => {
    // If rule 1b (plain string `content` wins) were checked WITHOUT the
    // Write-shape exclusion — i.e. the exclusion existed but ran too late,
    // or was skipped — this would render the raw file body instead of the
    // confirmation. Pins the ordering requirement independent of toolName.
    const fixture = {
      type: 'update',
      filePath: '/tmp/ordering.txt',
      content: 'RAW_FILE_BODY_MUST_NOT_WIN',
      structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }],
    }
    const result = normalizeClaudeTuiToolResponse('Write', fixture)
    assert.ok(!result.includes('RAW_FILE_BODY_MUST_NOT_WIN'))
    assert.equal(result, 'Wrote 26 bytes to /tmp/ordering.txt.')
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
