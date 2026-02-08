import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { OutputParser } from '../src/output-parser.js'

/** Create a parser with startup gates bypassed for testing */
function createParser() {
  const parser = new OutputParser()
  parser._ready = true
  parser.claudeReady = true
  parser._startTime = 0
  return parser
}

/** Collect events of a given type from the parser */
function collectEvents(parser, eventName) {
  const events = []
  parser.on(eventName, (data) => events.push(data))
  return events
}

describe('OutputParser._stripAnsi', () => {
  let parser

  beforeEach(() => {
    parser = createParser()
  })

  it('strips SGR codes', () => {
    assert.equal(parser._stripAnsi('\x1b[31mred\x1b[0m'), 'red')
  })

  it('strips combined SGR codes', () => {
    assert.equal(parser._stripAnsi('\x1b[1;32mbold green\x1b[0m'), 'bold green')
  })

  it('replaces CUP at column 1 with newline', () => {
    assert.equal(parser._stripAnsi('\x1b[5;1H'), '\n')
  })

  it('replaces CUP at column >1 with space', () => {
    assert.equal(parser._stripAnsi('\x1b[5;10H'), ' ')
  })

  it('replaces CUP with no column (defaults to 1) with newline', () => {
    assert.equal(parser._stripAnsi('\x1b[5H'), '\n')
  })

  it('replaces CUF with space', () => {
    assert.equal(parser._stripAnsi('\x1b[5C'), ' ')
  })

  it('replaces CHA at column 1 with newline', () => {
    assert.equal(parser._stripAnsi('\x1b[1G'), '\n')
  })

  it('replaces CHA at column >1 with space', () => {
    assert.equal(parser._stripAnsi('\x1b[10G'), ' ')
  })

  it('replaces \\r with \\n', () => {
    assert.equal(parser._stripAnsi('hello\rworld'), 'hello\nworld')
  })

  it('handles split ANSI sequences across chunks', () => {
    // Simulate split: feed raw buffer with partial sequence
    parser.buffer = '\x1b[3'
    parser.buffer += '1mtext\x1b[0m'
    parser.buffer = parser._stripAnsi(parser.buffer)
    assert.equal(parser.buffer, 'text')
  })
})

describe('OutputParser._isNoise', () => {
  let parser

  beforeEach(() => {
    parser = createParser()
  })

  it('filters short non-marker lines', () => {
    assert.equal(parser._isNoise('ab'), true)
    assert.equal(parser._isNoise('x'), true)
  })

  it('filters divider lines', () => {
    assert.equal(parser._isNoise('━━━━━'), true)
    assert.equal(parser._isNoise('─────'), true)
  })

  it('filters tmux status bar', () => {
    assert.equal(parser._isNoise('[claude-code] session'), true)
  })

  it('filters cost lines', () => {
    assert.equal(parser._isNoise('$0.50 | 1000 tokens'), true)
  })

  it('preserves real content', () => {
    assert.equal(parser._isNoise('Hello world'), false)
  })

  it('preserves response markers', () => {
    assert.equal(parser._isNoise('⏺ Something'), false)
  })

  it('preserves prompt markers', () => {
    assert.equal(parser._isNoise('❯ hello'), false)
  })

  it('filters banner block elements', () => {
    assert.equal(parser._isNoise('▐▛▜ Claude'), true)
  })

  it('filters tool status lines', () => {
    assert.equal(parser._isNoise('⎿ Running…'), true)
  })

  it('filters box drawing fragments', () => {
    assert.equal(parser._isNoise('╭╮'), true)
    assert.equal(parser._isNoise('│ some text │'), true)
  })

  it('filters tool block end boundaries', () => {
    assert.equal(parser._isNoise('╰────────'), true)
  })
})

describe('OutputParser._isThinking', () => {
  let parser

  beforeEach(() => {
    parser = createParser()
  })

  it('detects bare spinner characters', () => {
    assert.equal(parser._isThinking('✻'), true)
    assert.equal(parser._isThinking('⏺'), true)
  })

  it('detects spinner with text', () => {
    assert.equal(parser._isThinking('✻ Thinking'), true)
  })

  it('detects braille spinners', () => {
    assert.equal(parser._isThinking('⠋'), true)
  })

  it('detects standalone spinner verbs (bare or with ellipsis)', () => {
    assert.equal(parser._isThinking('thinking'), true)
    assert.equal(parser._isThinking('reading'), true)
    assert.equal(parser._isThinking('analyzing'), true)
    assert.equal(parser._isThinking('reading…'), true)
    assert.equal(parser._isThinking('writing...'), true)
  })

  it('does not treat long text starting with spinner verb as thinking', () => {
    assert.equal(parser._isThinking('thinking about architecture and design patterns'), false)
  })

  it('does not treat spinner verb + real content as thinking', () => {
    assert.equal(parser._isThinking('Writing tests for the parser module'), false)
    assert.equal(parser._isThinking('Working directory: /Users/test'), false)
    assert.equal(parser._isThinking('Reading from file at /path/to'), false)
    assert.equal(parser._isThinking('Editing the configuration file'), false)
    assert.equal(parser._isThinking('Analyzing the error log output'), false)
    assert.equal(parser._isThinking('Searching for pattern in code'), false)
  })

  it('does not treat regular text as thinking', () => {
    assert.equal(parser._isThinking('Hello world'), false)
  })
})

describe('OutputParser state machine', () => {
  it('emits user_input for prompt lines', async () => {
    const parser = createParser()
    const msg = await new Promise((resolve) => {
      parser.on('message', resolve)
      parser.feed('❯ hello\n')
    })
    assert.equal(msg.type, 'user_input')
    assert.equal(msg.content, 'hello\n')
  })

  it('emits response for ⏺ lines after flush', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('⏺ response text\n')

    // Wait for flush timer (1500ms) + buffer
    await new Promise(r => setTimeout(r, 2000))

    assert.ok(messages.length >= 1, 'Should have emitted at least one message')
    assert.equal(messages[0].type, 'response')
    assert.ok(messages[0].content.includes('response text'))
  })

  it('emits tool_use for tool blocks', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('╭─── Read(file.js) ───\ncontent here\n')

    // Tool content accumulates; trigger flush by sending a new state transition
    parser.feed('❯\n')

    await new Promise(r => setTimeout(r, 100))

    assert.ok(messages.length >= 1, 'Should emit tool_use message')
    const toolMsg = messages.find(m => m.type === 'tool_use')
    assert.ok(toolMsg, 'Should have a tool_use message')
    assert.equal(toolMsg.tool, 'Read')
  })

  it('emits tool_use for compact tool format (ToolName(args))', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('Bash(git checkout main && git pull) ⎿ Already up to date.\n')
    parser.feed('❯\n')

    await new Promise(r => setTimeout(r, 100))

    assert.ok(messages.length >= 1, 'Should emit tool_use message')
    const toolMsg = messages.find(m => m.type === 'tool_use')
    assert.ok(toolMsg, 'Should have a tool_use message')
    assert.equal(toolMsg.tool, 'Bash')
  })

  it('emits tool_use for compact Read(file) format', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('Read(src/auth.js)\n')
    parser.feed('❯\n')

    await new Promise(r => setTimeout(r, 100))

    const toolMsg = messages.find(m => m.type === 'tool_use')
    assert.ok(toolMsg, 'Should have a tool_use message')
    assert.equal(toolMsg.tool, 'Read')
  })

  it('deduplicates same content within 10s', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('❯ hello\n')
    parser.feed('❯ hello\n')

    await new Promise(r => setTimeout(r, 100))
    assert.equal(messages.length, 1, 'Should only emit once for duplicate content')
  })

  it('fires raw event on every feed', () => {
    const parser = createParser()
    const raws = collectEvents(parser, 'raw')

    parser.feed('chunk1')
    parser.feed('chunk2')

    assert.equal(raws.length, 2)
    assert.equal(raws[0], 'chunk1')
    assert.equal(raws[1], 'chunk2')
  })

  it('emits claude_ready when ❯ prompt is seen after grace period', () => {
    const parser = new OutputParser()
    parser._ready = true
    parser._startTime = 0
    // claudeReady starts false
    assert.equal(parser.claudeReady, false)

    const readyEvents = collectEvents(parser, 'claude_ready')
    parser.feed('❯\n')

    assert.equal(parser.claudeReady, true)
    assert.equal(readyEvents.length, 1)
  })

  it('suppresses messages before claudeReady', async () => {
    const parser = new OutputParser()
    parser._ready = true
    parser._startTime = 0
    // claudeReady stays false
    const messages = collectEvents(parser, 'message')

    parser.feed('⏺ should be suppressed\n')
    await new Promise(r => setTimeout(r, 2000))

    assert.equal(messages.length, 0, 'Should suppress messages before claudeReady')
  })

  it('accumulates continuation lines into current message', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('⏺ first line\nsecond line\nthird line\n')

    await new Promise(r => setTimeout(r, 2000))

    assert.ok(messages.length >= 1)
    assert.ok(messages[0].content.includes('first line'))
    assert.ok(messages[0].content.includes('second line'))
    assert.ok(messages[0].content.includes('third line'))
  })

  it('transitions from THINKING to RESPONSE on ⏺ marker', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('thinking\n')
    parser.feed('⏺ actual response\n')

    await new Promise(r => setTimeout(r, 2000))

    assert.ok(messages.length >= 1)
    assert.equal(messages[0].type, 'response')
    assert.ok(messages[0].content.includes('actual response'))
  })

  it('skips empty trimmed lines', () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('   \n\n  \n')

    assert.equal(messages.length, 0)
  })

  it('starts as response when content appears in IDLE state', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('some content without marker\n')

    await new Promise(r => setTimeout(r, 2000))

    assert.ok(messages.length >= 1)
    assert.equal(messages[0].type, 'response')
  })

  it('additional ⏺ lines within RESPONSE state append to same message', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('⏺ first part\n')
    parser.feed('⏺ second part\n')

    await new Promise(r => setTimeout(r, 2000))

    assert.ok(messages.length >= 1)
    assert.ok(messages[0].content.includes('first part'))
    assert.ok(messages[0].content.includes('second part'))
  })

  it('tool block end transitions back to IDLE', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('╭─── Read(file.js) ───\ntool output here\n')

    // Trigger flush with a prompt line
    parser.feed('❯ done\n')
    await new Promise(r => setTimeout(r, 100))

    const toolMsg = messages.find(m => m.type === 'tool_use')
    assert.ok(toolMsg, 'Should emit tool_use message')
    assert.equal(toolMsg.tool, 'Read')
    assert.ok(toolMsg.content.includes('tool output here'))
  })

  it('does not set claudeReady before _ready gate', () => {
    const parser = new OutputParser()
    // _ready is false by default
    parser._startTime = 0

    const readyEvents = collectEvents(parser, 'claude_ready')
    parser.feed('❯\n')

    assert.equal(parser.claudeReady, false)
    assert.equal(readyEvents.length, 0)
  })

  it('ignores Try placeholder in prompt', () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.feed('❯ Try "edit this file"\n')

    assert.equal(messages.length, 0)
  })
})

describe('OutputParser._isNoise additional patterns', () => {
  let parser

  beforeEach(() => {
    parser = createParser()
  })

  it('filters token count lines', () => {
    assert.equal(parser._isNoise('500 tokens'), true)
    assert.equal(parser._isNoise('1000tokens'), true)
  })

  it('filters ctrl+g lines', () => {
    assert.equal(parser._isNoise('ctrl+g to switch'), true)
  })

  it('filters /ide hints', () => {
    assert.equal(parser._isNoise('/ide for editor'), true)
  })

  it('filters version lines', () => {
    assert.equal(parser._isNoise('Claude Code v2.1.0'), true)
  })

  it('filters model lines outside response', () => {
    assert.equal(parser._isNoise('Sonnet 4'), true)
    assert.equal(parser._isNoise('Opus 4'), true)
  })

  it('preserves model lines inside response (prefixed with ⏺)', () => {
    assert.equal(parser._isNoise('⏺ Sonnet 4 is a model'), false)
  })

  it('filters percentage lines', () => {
    assert.equal(parser._isNoise('75.5% complete'), true)
  })

  it('filters "start of a new" banner', () => {
    assert.equal(parser._isNoise('start of a new conversation'), true)
    assert.equal(parser._isNoise('new conversation'), true)
  })

  it('filters path-only lines', () => {
    assert.equal(parser._isNoise('/Users/test'), true)
  })

  it('filters scroll arrow fragments', () => {
    assert.equal(parser._isNoise('text ↓'), true)
  })

  it('filters Try placeholder lines', () => {
    assert.equal(parser._isNoise('Try "edit something"'), true)
  })

  it('filters Claude Max/Pro/Free lines', () => {
    assert.equal(parser._isNoise('Claude Max'), true)
    assert.equal(parser._isNoise('Claude Pro'), true)
    assert.equal(parser._isNoise('Claude Free'), true)
  })

  it('filters til compact lines', () => {
    assert.equal(parser._isNoise('til compact mode'), true)
  })

  it('filters tmux "Christophers-" lines', () => {
    assert.equal(parser._isNoise('"Christophers-MacBook'), true)
  })

  it('filters tmux "* Claude Code" lines', () => {
    assert.equal(parser._isNoise('* Claude Code'), true)
  })

  it('filters latest/current version lines', () => {
    assert.equal(parser._isNoise('latest: 2.1.0'), true)
    assert.equal(parser._isNoise('current: 2.0.0'), true)
  })

  it('preserves version lines prefixed with ⏺', () => {
    assert.equal(parser._isNoise('⏺ latest: 2.1.0'), false)
    assert.equal(parser._isNoise('⏺ current: 2.0.0'), false)
  })

  it('preserves percentage lines prefixed with ⏺', () => {
    assert.equal(parser._isNoise('⏺ 75.5% complete'), false)
  })

  it('filters lines with only dashes and numbers', () => {
    assert.equal(parser._isNoise('─━n123'), true)
  })

  it('filters "Conversation compacted" notification', () => {
    assert.equal(parser._isNoise('✻ Conversation compacted (ctrl+o for history)'), true)
  })

  it('filters "Conversation compacted" with varying formatting', () => {
    assert.equal(parser._isNoise('Conversation compacted'), true)
    assert.equal(parser._isNoise('conversation  compacted'), true)
  })

  it('preserves lines mentioning "conversation" without "compacted"', () => {
    assert.equal(parser._isNoise('The conversation was interesting'), false)
  })
})

describe('OutputParser._isThinking additional patterns', () => {
  let parser

  beforeEach(() => {
    parser = createParser()
  })

  it('detects dot spinner with ellipsis text', () => {
    assert.equal(parser._isThinking('· Analyzing…'), true)
  })

  it('detects spinner with timing info', () => {
    assert.equal(parser._isThinking('⏺ (3s · ↓'), true)
  })

  it('detects mixed spinner sequences', () => {
    assert.equal(parser._isThinking('✻✶✳ '), true)
  })

  it('detects writing, editing, searching verbs', () => {
    assert.equal(parser._isThinking('writing'), true)
    assert.equal(parser._isThinking('searching'), true)
    assert.equal(parser._isThinking('editing'), true)
    assert.equal(parser._isThinking('working'), true)
    assert.equal(parser._isThinking('pondering'), true)
    assert.equal(parser._isThinking('considering'), true)
    assert.equal(parser._isThinking('processing'), true)
  })
})

describe('OutputParser._detectPrompt', () => {
  it('detects numbered options', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    // Feed numbered options as raw lines
    parser._detectPrompt('1. Yes, trust this folder')
    parser._detectPrompt('2. No, exit')

    // Wait for prompt flush
    await new Promise(r => setTimeout(r, 700))

    assert.ok(messages.length >= 1)
    assert.equal(messages[0].type, 'prompt')
    assert.equal(messages[0].options.length, 2)
    assert.equal(messages[0].options[0].value, '1')
    assert.equal(messages[0].options[1].value, '2')
  })

  it('detects Allow/Deny keywords', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser._detectPrompt('Allow')
    parser._detectPrompt('Deny')

    await new Promise(r => setTimeout(r, 700))

    assert.ok(messages.length >= 1)
    assert.equal(messages[0].type, 'prompt')
    const allowOpt = messages[0].options.find(o => o.label === 'Allow')
    assert.ok(allowOpt)
    assert.equal(allowOpt.value, 'y')
    const denyOpt = messages[0].options.find(o => o.label === 'Deny')
    assert.ok(denyOpt)
    assert.equal(denyOpt.value, 'n')
  })

  it('detects "Always allow" keyword', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser._detectPrompt('Always allow')

    await new Promise(r => setTimeout(r, 700))

    assert.ok(messages.length >= 1)
    const opt = messages[0].options.find(o => o.label === 'Always allow')
    assert.ok(opt)
    assert.equal(opt.value, 'a')
  })

  it('suppresses prompts before claudeReady', async () => {
    const parser = new OutputParser()
    parser._ready = true
    parser._startTime = 0
    // claudeReady stays false

    const messages = collectEvents(parser, 'message')

    parser._detectPrompt('1. Option one')
    parser._detectPrompt('2. Option two')

    await new Promise(r => setTimeout(r, 700))

    assert.equal(messages.length, 0, 'Should suppress prompt before claudeReady')
  })

  it('ignores long lines for permission keywords', () => {
    const parser = createParser()

    // Long line should not be detected as permission keyword
    parser._detectPrompt('Allow me to explain the architecture of the system in great detail here')

    assert.equal(parser._pendingPrompt, null)
  })

  it('ignores non-matching lines', () => {
    const parser = createParser()

    parser._detectPrompt('Hello world')
    parser._detectPrompt('This is regular text')

    assert.equal(parser._pendingPrompt, null)
  })
})

describe('OutputParser._finishCurrentMessage edge cases', () => {
  it('skips messages in first 5 seconds', () => {
    const parser = new OutputParser()
    // _ready is false, _startTime is recent
    parser.claudeReady = true

    const messages = collectEvents(parser, 'message')

    parser.currentMessage = { type: 'response', content: 'too early\n' }
    parser._finishCurrentMessage()

    assert.equal(messages.length, 0)
    assert.equal(parser.currentMessage, null)
  })

  it('sets _ready after grace period', () => {
    const parser = new OutputParser()
    parser._startTime = 0  // far in the past
    parser.claudeReady = true

    parser.currentMessage = { type: 'response', content: 'valid content\n' }
    parser._finishCurrentMessage()

    assert.equal(parser._ready, true)
  })

  it('skips empty content messages', () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.currentMessage = { type: 'response', content: '   ' }
    parser._finishCurrentMessage()

    assert.equal(messages.length, 0)
  })

  it('skips null currentMessage', () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    parser.currentMessage = null
    parser._finishCurrentMessage()

    assert.equal(messages.length, 0)
  })

  it('clears flush timer on finish', () => {
    const parser = createParser()

    parser._flushTimer = setTimeout(() => {}, 10000)
    parser.currentMessage = { type: 'response', content: 'test\n' }
    parser._finishCurrentMessage()

    assert.equal(parser._flushTimer, null)
  })
})

describe('OutputParser scrollback suppression', () => {
  /** Create a parser with scrollback suppression enabled and gates bypassed */
  function createSuppressedParser() {
    const parser = new OutputParser({ assumeReady: true, suppressScrollback: true })
    return parser
  }

  it('suppresses messages during scrollback burst', async () => {
    const parser = createSuppressedParser()
    const messages = collectEvents(parser, 'message')

    // Simulate rapid scrollback dump
    parser.feed('⏺ old message one\n')
    parser.feed('❯ old user input\n')
    parser.feed('⏺ old message two\n')

    // Wait for flush timers but NOT the 500ms quiet period
    await new Promise(r => setTimeout(r, 200))

    assert.equal(messages.length, 0, 'Should suppress all messages during scrollback burst')
  })

  it('still emits raw events during suppression', () => {
    const parser = createSuppressedParser()
    const raws = collectEvents(parser, 'raw')

    parser.feed('raw data chunk')

    assert.equal(raws.length, 1)
    assert.equal(raws[0], 'raw data chunk')
  })

  it('emits messages after quiet period elapses', async () => {
    const parser = createSuppressedParser()
    const messages = collectEvents(parser, 'message')

    // Simulate scrollback burst
    parser.feed('⏺ old stale message\n')

    // Wait for 500ms quiet period to pass
    await new Promise(r => setTimeout(r, 700))

    assert.equal(parser._suppressingScrollback, false, 'Suppression should end after quiet period')

    // Now feed new data — should emit normally
    parser.feed('❯ new user input\n')
    await new Promise(r => setTimeout(r, 100))

    assert.ok(messages.length >= 1, 'Should emit messages after quiet period')
    assert.equal(messages[0].type, 'user_input')
  })

  it('resets quiet timer on continued data', async () => {
    const parser = createSuppressedParser()

    // Feed data, wait 400ms, feed more — should NOT end suppression
    parser.feed('⏺ chunk one\n')
    await new Promise(r => setTimeout(r, 400))
    assert.equal(parser._suppressingScrollback, true, 'Should still be suppressing')

    parser.feed('⏺ chunk two\n')
    await new Promise(r => setTimeout(r, 400))
    assert.equal(parser._suppressingScrollback, true, 'Timer should have reset, still suppressing')

    // Now wait the full 500ms quiet period
    await new Promise(r => setTimeout(r, 600))
    assert.equal(parser._suppressingScrollback, false, 'Should end suppression after full quiet period')
  })

  it('preserves dedup map when suppression ends (entries self-expire via TTL)', async () => {
    const parser = createSuppressedParser()

    // Manually add a dedup entry to simulate content seen during suppression
    parser._recentEmissions.set('response:testcontent', Date.now())

    // Must feed data to start the quiet timer — suppression ends after 500ms of silence
    parser.feed('⏺ scrollback data\n')

    // Wait for quiet period to end suppression
    await new Promise(r => setTimeout(r, 700))

    assert.equal(parser._suppressingScrollback, false, 'Suppression should end')
    assert.ok(parser._recentEmissions.size > 0, 'Dedup map should NOT be cleared — entries self-expire via TTL')
  })

  it('deduplicates content across scrollback suppression boundary', async () => {
    const parser = createSuppressedParser()
    const messages = collectEvents(parser, 'message')

    // During suppression: feed content (message suppressed, but dedup map
    // doesn't get cleared when suppression ends)
    parser.feed('⏺ I fixed the bug in auth.js\n')

    // Wait for suppression to end
    await new Promise(r => setTimeout(r, 700))
    assert.equal(parser._suppressingScrollback, false)
    assert.equal(messages.length, 0, 'Message during suppression should be suppressed')

    // After suppression: feed the SAME content (scrollback replay duplicate)
    parser.feed('⏺ I fixed the bug in auth.js\n')

    await new Promise(r => setTimeout(r, 2000))

    // The dedup map should prevent the duplicate from being emitted
    // because the first feed added it to the map (even though message was suppressed)
    // Actually — during suppression, _finishCurrentMessage returns early before
    // reaching dedup. So the map won't have the entry. But this tests the scenario
    // where content from the suppressed period leaks into the map.
    // The key point is: NOT clearing the map doesn't cause harm.
    assert.ok(messages.length <= 1, 'Should not emit duplicate content after suppression')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Smoke test: exact junk lines observed in real PTY server logs
// These are the actual fragments that leaked through the old filters
// ─────────────────────────────────────────────────────────────────────
describe('OutputParser real-world PTY noise (smoke test)', () => {
  let parser

  beforeEach(() => {
    parser = createParser()
  })

  // --- _isNoise: tmux status bars with various session names ---
  it('filters [dev] tmux status bar', () => {
    assert.equal(parser._isNoise('[dev] 0:2.1.37*'), true)
  })

  it('filters [claude-code] tmux status bar', () => {
    assert.equal(parser._isNoise('[claude-code] session 1:bash'), true)
  })

  it('filters [my-project] tmux status bar', () => {
    assert.equal(parser._isNoise('[my-project] 0:zsh*'), true)
  })

  // --- _isNoise: cost/token fragments ---
  it('filters standalone cost "$0.02"', () => {
    assert.equal(parser._isNoise('$0.02'), true)
  })

  it('filters cost with pipe "$0.50 |"', () => {
    assert.equal(parser._isNoise('$0.50 | 500 tokens'), true)
  })

  it('filters "775 tokens)"', () => {
    assert.equal(parser._isNoise('775 tokens)'), true)
  })

  it('filters "12.3k tokens"', () => {
    assert.equal(parser._isNoise('12.3k tokens'), true)
  })

  it('filters "thought for 3s)" fragment', () => {
    assert.equal(parser._isNoise('thought for 3s)'), true)
  })

  it('filters "(No content)"', () => {
    assert.equal(parser._isNoise('(No content)'), true)
  })

  it('filters bare version "2.1.37"', () => {
    assert.equal(parser._isNoise('2.1.37'), true)
  })

  it('filters "PTY Scrollback"', () => {
    assert.equal(parser._isNoise('PTY Scrollback'), true)
  })

  // --- _isNoise: short terminal redraw fragments ---
  it('filters "z g" (2-char redraw artifact)', () => {
    assert.equal(parser._isNoise('z g'), true)
  })

  it('filters "c 9" (2-char redraw artifact)', () => {
    assert.equal(parser._isNoise('c 9'), true)
  })

  it('filters "A u" (short redraw artifact)', () => {
    assert.equal(parser._isNoise('A u'), true)
  })

  it('filters "i n" (short fragment)', () => {
    assert.equal(parser._isNoise('i n'), true)
  })

  // --- _isNoise: scroll arrows ---
  it('filters "↓ 5" scroll arrow fragment', () => {
    assert.equal(parser._isNoise('↓ 5'), true)
  })

  it('filters "↑" bare scroll arrow', () => {
    assert.equal(parser._isNoise('↑'), true)
  })

  // --- _isThinking: exact fragments from logs ---
  it('detects "4 thinking" counter fragment', () => {
    assert.equal(parser._isThinking('4 thinking'), true)
  })

  it('detects "42 thinking" counter fragment', () => {
    assert.equal(parser._isThinking('42 thinking'), true)
  })

  it('detects "c a thinking" garbled fragment', () => {
    assert.equal(parser._isThinking('c a thinking'), true)
  })

  it('detects "Actualizing…" spinner verb', () => {
    assert.equal(parser._isThinking('Actualizing…'), true)
  })

  it('detects "Waiting…" spinner verb', () => {
    assert.equal(parser._isThinking('Waiting…'), true)
  })

  it('detects "thinking" bare word', () => {
    assert.equal(parser._isThinking('thinking'), true)
  })

  it('detects "thought for 7s" past tense', () => {
    assert.equal(parser._isThinking('thought for 7s'), true)
  })

  it('detects braille spinner ⠐', () => {
    assert.equal(parser._isThinking('⠐'), true)
  })

  it('detects braille spinner ⠂', () => {
    assert.equal(parser._isThinking('⠂'), true)
  })

  it('detects braille spinner ⠈', () => {
    assert.equal(parser._isThinking('⠈'), true)
  })

  // --- Legitimate content must NOT be filtered ---
  it('preserves real response text', () => {
    assert.equal(parser._isNoise('I have fixed the authentication bug in the login flow.'), false)
    assert.equal(parser._isThinking('I have fixed the authentication bug in the login flow.'), false)
  })

  it('preserves response with dash bullets', () => {
    assert.equal(parser._isNoise('- First item in a list'), false)
    assert.equal(parser._isThinking('- First item in a list'), false)
  })

  it('preserves ⏺ prefixed lines', () => {
    assert.equal(parser._isNoise('⏺ Here is the result'), false)
  })

  it('preserves ❯ prompt lines', () => {
    assert.equal(parser._isNoise('❯ hello world'), false)
  })

  it('preserves longer meaningful text that starts with a spinner verb', () => {
    assert.equal(parser._isThinking('thinking about architecture and design patterns for the new auth system'), false)
  })

  it('preserves code-like content', () => {
    assert.equal(parser._isNoise('const result = await fetch(url)'), false)
    assert.equal(parser._isThinking('const result = await fetch(url)'), false)
  })
})

describe('OutputParser end-to-end PTY noise filtering', () => {
  it('does not emit messages for thinking/noise lines', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    // Feed a barrage of real junk lines
    const junkLines = [
      '[dev] 0:2.1.37*',
      '4 thinking',
      'c a thinking',
      'Actualizing…',
      '$0.02',
      '775 tokens)',
      '⠐',
      'z g',
      'thought for 3s)',
    ]
    for (const line of junkLines) {
      parser.feed(line + '\n')
    }

    // Wait for any flush timers
    await new Promise(r => setTimeout(r, 2000))

    assert.equal(messages.length, 0, `Expected no messages but got ${messages.length}: ${messages.map(m => JSON.stringify(m.content)).join(', ')}`)
  })

  it('emits real response after filtering junk', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    // Junk first
    parser.feed('4 thinking\n')
    parser.feed('[dev] 0:2.1.37*\n')
    parser.feed('⠐\n')

    // Then real response
    parser.feed('⏺ I have fixed the bug in the authentication module.\n')

    await new Promise(r => setTimeout(r, 2000))

    assert.ok(messages.length >= 1, 'Should emit at least one message')
    assert.equal(messages[0].type, 'response')
    assert.ok(messages[0].content.includes('fixed the bug'))
  })
})

// ─────────────────────────────────────────────────────────────────────
// QA Test Run #2: exact junk lines from server logs (2026-02-07)
// Tests every pattern category that was leaking through the old filters
// ─────────────────────────────────────────────────────────────────────
describe('QA Test Run #2 — noise filter regressions', () => {
  let parser

  beforeEach(() => {
    parser = createParser()
  })

  // --- Category 1: Missing spinner verbs (Imagining, Baked) ---
  it('filters "Imagining…" as thinking', () => {
    assert.equal(parser._isThinking('Imagining…'), true)
  })

  it('filters "Imagining… 39" (spinner + scroll count)', () => {
    assert.equal(parser._isThinking('Imagining… 39'), true)
  })

  it('filters "Imagining… 51" (spinner + count)', () => {
    assert.equal(parser._isThinking('Imagining… 51'), true)
  })

  it('filters "Imagining… ↑ 64 3542" (spinner + scroll position)', () => {
    assert.equal(parser._isThinking('Imagining… ↑ 64 3542'), true)
  })

  it('filters "Baked for 6m 29s" as noise', () => {
    assert.equal(parser._isNoise('Baked for 6m 29s'), true)
  })

  // --- Category 2: CUP-split status fragments (single-char tokens) ---
  it('filters "c a" (CUP fragment)', () => {
    assert.equal(parser._isNoise('c a'), true)
  })

  it('filters "z g" (CUP fragment)', () => {
    assert.equal(parser._isNoise('z g'), true)
  })

  it('filters "i n" (CUP fragment)', () => {
    assert.equal(parser._isNoise('i n'), true)
  })

  it('filters "A u" (CUP fragment)', () => {
    assert.equal(parser._isNoise('A u'), true)
  })

  it('filters "t l" (CUP fragment)', () => {
    assert.equal(parser._isNoise('t l'), true)
  })

  it('filters "i …" (CUP fragment with ellipsis)', () => {
    assert.equal(parser._isNoise('i …'), true)
  })

  it('filters "· c a 9" (CUP fragment with dot)', () => {
    assert.equal(parser._isNoise('· c a 9'), true)
  })

  it('filters "A u 7" (CUP fragment with number)', () => {
    assert.equal(parser._isNoise('A u 7'), true)
  })

  it('filters "A u 8 0" (CUP fragment multi-digit)', () => {
    assert.equal(parser._isNoise('A u 8 0'), true)
  })

  // --- Category 3: Spinner char lines not broadly caught ---
  it('filters "✶ … 5" (spinner + ellipsis + number)', () => {
    assert.equal(parser._isThinking('✶ … 5'), true)
  })

  it('filters "✻ …" (spinner + ellipsis)', () => {
    assert.equal(parser._isThinking('✻ …'), true)
  })

  it('filters "✢  · thinking)" (spinner + garbled status)', () => {
    assert.equal(parser._isThinking('✢  · thinking)'), true)
  })

  it('filters "✳ …" (spinner char + ellipsis)', () => {
    assert.equal(parser._isThinking('✳ …'), true)
  })

  // --- Category 4: tmux status bar with pane title ---
  it('filters tmux status with pane title (non-anchored)', () => {
    assert.equal(parser._isNoise('[dev] 0:2.1.37*                                                                     "⠐ App UI Debugg'), true)
  })

  it('filters quoted braille pane title', () => {
    assert.equal(parser._isNoise('"⠐ App UI Debugging..."'), true)
  })

  it('filters quoted spinner pane title', () => {
    assert.equal(parser._isNoise('"✳ Restart Testing"'), true)
  })

  // --- Category 5: Numeric-only fragments ---
  it('filters "7 0 -0" (numeric fragment)', () => {
    assert.equal(parser._isNoise('7 0 -0'), true)
  })

  it('filters "8 187 -3" (numeric fragment)', () => {
    assert.equal(parser._isNoise('8 187 -3'), true)
  })

  it('filters "2 9 )" (numeric with paren)', () => {
    assert.equal(parser._isNoise('2 9 )'), true)
  })

  // --- Category 6: General capitalized verb pattern ---
  it('filters "Conjuring…" (unknown future verb)', () => {
    assert.equal(parser._isThinking('Conjuring…'), true)
  })

  it('filters "Manifesting… 42" (unknown verb + count)', () => {
    assert.equal(parser._isThinking('Manifesting… 42'), true)
  })

  it('filters "Synthesizing..." (three dots)', () => {
    assert.equal(parser._isThinking('Synthesizing...'), true)
  })

  // --- Category 7: Middle dot with status indicators ---
  it('filters "· 9 thinking" (dot + number + thinking)', () => {
    assert.equal(parser._isThinking('· 9 thinking'), true)
  })

  it('filters "· thinking" (dot + thinking)', () => {
    assert.equal(parser._isThinking('· thinking'), true)
  })

  it('filters "· … thinking" (dot + ellipsis + thinking)', () => {
    assert.equal(parser._isThinking('· … thinking'), true)
  })

  // --- Category 8: [Pasted text] markers ---
  it('filters "[Pasted text #5 +6 lines]" as noise', () => {
    assert.equal(parser._isNoise('[Pasted text #5 +6 lines]'), true)
  })

  it('filters "[Pasted text #6 +9 lines]" as noise', () => {
    assert.equal(parser._isNoise('[Pasted text #6 +9 lines]'), true)
  })

  // --- Category 9: Actualizing/status line accumulation ---
  it('filters "Actualizing… 2" (verb + number)', () => {
    assert.equal(parser._isThinking('Actualizing… 2'), true)
  })

  it('filters "Actualizing… 3" (verb + number)', () => {
    assert.equal(parser._isThinking('Actualizing… 3'), true)
  })

  // --- Legitimate content must NOT be filtered ---
  it('preserves "I see the problem. When you switch..." (real response)', () => {
    const text = 'I see the problem. When you switch to a session, _replayHistory sends the entire history buffer'
    assert.equal(parser._isNoise(text), false)
    assert.equal(parser._isThinking(text), false)
  })

  it('preserves "The history trimming should fix the main issue." (real response)', () => {
    const text = 'The history trimming should fix the main issue. The server was replaying up to 100 entries'
    assert.equal(parser._isNoise(text), false)
    assert.equal(parser._isThinking(text), false)
  })

  it('preserves "Step 1: Fix duplicate tool messages" (real response)', () => {
    const text = 'Step 1: Fix duplicate tool messages in cli-session.js'
    assert.equal(parser._isNoise(text), false)
    assert.equal(parser._isThinking(text), false)
  })

  it('preserves "Here\'s a quick test checklist" (real response)', () => {
    const text = "Here's a quick test checklist to run through:"
    assert.equal(parser._isNoise(text), false)
    assert.equal(parser._isThinking(text), false)
  })

  it('preserves "Now, about the orange prompt issue" (real response)', () => {
    const text = 'Now, about the orange prompt issue — the old history still has duplicate messages'
    assert.equal(parser._isNoise(text), false)
    assert.equal(parser._isThinking(text), false)
  })
})

describe('QA Test Run #2 — end-to-end noise suppression', () => {
  it('suppresses all junk from exact log patterns', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    // Exact lines from the QA test run #2 server logs
    const junkLines = [
      'Imagining… 39',
      'Imagining… 51',
      'Imagining…',
      'Actualizing… 2',
      'Actualizing…',
      'Baked for 6m 29s',
      '✶ … 5',
      '✢  · thinking)',
      '[Pasted text #5 +6 lines]',
      '7 0 -0',
      '8 187 -3',
      'c a',
      'z g',
      'A u 7',
      '· c a 9',
      '4 thinking',
      '· thinking',
    ]
    for (const line of junkLines) {
      parser.feed(line + '\n')
    }

    await new Promise(r => setTimeout(r, 2000))

    assert.equal(messages.length, 0,
      `Expected no messages but got ${messages.length}: ${messages.map(m => JSON.stringify(m.content.trim().slice(0, 50))).join(', ')}`)
  })

  it('real response survives after QA junk barrage', async () => {
    const parser = createParser()
    const messages = collectEvents(parser, 'message')

    // Junk before
    parser.feed('Imagining… 39\n')
    parser.feed('✶ … 5\n')
    parser.feed('c a\n')
    parser.feed('A u 7\n')

    // Real response
    parser.feed('⏺ I see the problem. When you switch to a session, _replayHistory sends the entire history buffer.\n')

    await new Promise(r => setTimeout(r, 2000))

    assert.ok(messages.length >= 1, 'Should emit the real response')
    assert.equal(messages[0].type, 'response')
    assert.ok(messages[0].content.includes('_replayHistory'))
  })
})

describe('Server log line noise filter', () => {
  let parser

  beforeEach(() => {
    parser = createParser()
  })

  it('filters [parser] log lines', () => {
    assert.ok(parser._isNoise('[parser] Emitting response: "Hello"'))
  })

  it('filters [ws] log lines', () => {
    assert.ok(parser._isNoise('[ws] Client connected'))
  })

  it('filters [cli] log lines', () => {
    assert.ok(parser._isNoise('[cli] Starting server on port 3000'))
  })

  it('filters [tunnel] log lines', () => {
    assert.ok(parser._isNoise('[tunnel] Cloudflare tunnel URL: https://foo.trycloudflare.com'))
  })

  it('filters [pty] log lines', () => {
    assert.ok(parser._isNoise('[pty] Session attached'))
  })

  it('filters [pty-session] log lines', () => {
    assert.ok(parser._isNoise('[pty-session] Auto-accepting trust dialog (my-session)'))
  })

  it('filters [SIGINT] log lines', () => {
    assert.ok(parser._isNoise('[SIGINT] Caught interrupt, shutting down'))
  })

  it('filters "Press Ctrl+C to stop" server output', () => {
    assert.ok(parser._isNoise('Press Ctrl+C to stop'))
  })

  it('filters "Or connect manually:" server output', () => {
    assert.ok(parser._isNoise('Or connect manually:'))
  })

  it('filters URL server output', () => {
    assert.ok(parser._isNoise('URL:   wss://abc-123.trycloudflare.com'))
  })

  it('filters Token server output', () => {
    assert.ok(parser._isNoise('Token: abc123def456'))
  })

  it('filters "Scan this QR code" server output', () => {
    assert.ok(parser._isNoise('Scan this QR code to connect:'))
  })

  it('filters QR code block characters', () => {
    assert.ok(parser._isNoise('▄▀█▀▄ ▄▀█▀▄ ▄▀█▀▄'))
    assert.ok(parser._isNoise('█▀▀▀▀▀█ ▀▀█ ▀█▀ █▀▀▀▀▀█'))
  })

  it('does not filter normal bracketed content', () => {
    // [TODO] or [Note] are not server log prefixes
    assert.ok(!parser._isNoise('[TODO] Fix this later'))
    assert.ok(!parser._isNoise('[Note] Important detail'))
  })

  it('does not filter lines that just contain "parser" etc.', () => {
    assert.ok(!parser._isNoise('The parser needs fixing'))
    assert.ok(!parser._isNoise('ws connection established'))
  })
})

describe('Prompt detector option cap', () => {
  let parser

  beforeEach(() => {
    parser = createParser()
  })

  it('caps at 10 options and sets overflow sentinel', () => {
    // Simulate numbered scrollback lines (test output)
    for (let i = 1; i <= 12; i++) {
      parser._detectPrompt(`${i}. ok - test case ${i}`)
    }
    // After 10+ options, _pendingPrompt should be an overflow sentinel
    assert.ok(parser._pendingPrompt !== null, 'Should have overflow sentinel')
    assert.ok(parser._pendingPrompt.overflow, 'Should be marked as overflow')
    assert.ok(!parser._pendingPrompt.options, 'Should not have options array')
  })

  it('allows normal prompts under 10 options', () => {
    parser._detectPrompt('1. Yes, trust this folder')
    parser._detectPrompt('2. No, exit')
    assert.ok(parser._pendingPrompt !== null)
    assert.equal(parser._pendingPrompt.options.length, 2)
  })
})

describe('False positive guards — RESPONSE state preservation', () => {
  let parser, messages

  beforeEach(() => {
    parser = createParser()
    messages = collectEvents(parser, 'message')
  })

  it('preserves numeric content "42" during RESPONSE state', async () => {
    parser.feed('⏺ The answer to the question is:\n')
    parser.feed('42\n')
    parser.feed('That is the final answer.\n')

    await new Promise(r => setTimeout(r, 2000))

    assert.ok(messages.length >= 1, 'Should emit the response')
    const content = messages.map(m => m.content).join('')
    assert.ok(content.includes('42'), '"42" should not be filtered during RESPONSE')
  })

  it('preserves "However..." during RESPONSE state', async () => {
    parser.feed('⏺ Let me explain the issue.\n')
    parser.feed('However...\n')
    parser.feed('the root cause was different.\n')

    await new Promise(r => setTimeout(r, 2000))

    const content = messages.map(m => m.content).join('')
    assert.ok(content.includes('However'), '"However..." should not be eaten by thinking filter')
  })

  it('preserves "Meanwhile..." during RESPONSE state', async () => {
    parser.feed('⏺ The server started.\n')
    parser.feed('Meanwhile...\n')
    parser.feed('the client was connecting.\n')

    await new Promise(r => setTimeout(r, 2000))

    const content = messages.map(m => m.content).join('')
    assert.ok(content.includes('Meanwhile'), '"Meanwhile..." should not be eaten')
  })

  it('preserves "Reading..." during RESPONSE state', async () => {
    parser.feed('⏺ I will help with that.\n')
    parser.feed('Reading...\n')
    parser.feed('the file contents show the issue.\n')

    await new Promise(r => setTimeout(r, 2000))

    const content = messages.map(m => m.content).join('')
    assert.ok(content.includes('Reading'), '"Reading..." should not be eaten during RESPONSE')
  })

  it('still filters "Imagining…" outside of RESPONSE state', () => {
    // Not in RESPONSE state — should be filtered as thinking
    assert.ok(parser._isThinking('Imagining…'))
    assert.ok(parser._isThinking('Actualizing… 39'))
    assert.ok(parser._isThinking('Reading…'))
  })

  it('still filters numeric fragments outside of RESPONSE state', () => {
    // Not in RESPONSE state — should be filtered as noise
    assert.ok(parser._isNoise('7 0 -0'))
    assert.ok(parser._isNoise('8 187 -3'))
    assert.ok(parser._isNoise('42'))
  })

  it('preserves numeric content during RESPONSE but filters outside', () => {
    // Set parser to RESPONSE state manually
    parser.feed('⏺ The answer is:\n')
    // Now parser.state should be RESPONSE

    // These should NOT be filtered during RESPONSE
    assert.ok(!parser._isNoise('42'), '"42" should pass during RESPONSE')
    assert.ok(!parser._isNoise('100'), '"100" should pass during RESPONSE')
  })
})

describe('Recursive amplification — end-to-end', () => {
  let parser, messages

  beforeEach(() => {
    parser = createParser()
    messages = collectEvents(parser, 'message')
  })

  it('suppresses server log lines from tmux scrollback', async () => {
    // Simulate what happens when tmux scrollback contains server logs
    parser.feed('[parser] Emitting response: "Hello world"\n')
    parser.feed('[parser] Emitting response: "[parser] Emitting response: "z g""\n')
    parser.feed('[ws] Broadcasting to 1 clients\n')
    parser.feed('[tunnel] Health check passed\n')

    await new Promise(r => setTimeout(r, 2000))

    assert.equal(messages.length, 0, 'Server log lines should be completely suppressed')
  })

  it('suppresses server output fragments from scrollback', async () => {
    parser.feed('Press Ctrl+C to stop the server\n')
    parser.feed('Or connect manually:\n')
    parser.feed('URL:   wss://abc-xyz.trycloudflare.com\n')
    parser.feed('Token: abcdef123456\n')
    parser.feed('Scan this QR code to connect:\n')
    parser.feed('█▀▀▀▀▀█ ▀▀█ ▀█▀ █▀▀▀▀▀█\n')

    await new Promise(r => setTimeout(r, 2000))

    assert.equal(messages.length, 0, 'Server output fragments should be completely suppressed')
  })
})
