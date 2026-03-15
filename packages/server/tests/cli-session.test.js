import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { CliSession } from '../src/cli-session.js'

/**
 * Tests for CliSession lifecycle: process management, respawn,
 * model switching, sendMessage, interrupt, and destroy.
 *
 * We do NOT call start() in most tests — instead we manipulate
 * internal state to test behaviors in isolation without spawning
 * real child processes.
 */

function createSession(opts = {}) {
  return new CliSession({ cwd: '/tmp', ...opts })
}

// Simulate a session that's ready (post-start) without actually spawning
function createReadySession(opts = {}) {
  const session = createSession(opts)
  session._processReady = true
  session._child = createMockChild()
  return session
}

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(chunk, enc, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  child.kill = mock.fn(() => true)
  child.killed = false
  return child
}

describe('CliSession constructor', () => {
  it('sets defaults from options', () => {
    const session = createSession({ cwd: '/home/user', model: 'opus' })
    assert.equal(session.cwd, '/home/user')
    assert.equal(session.model, 'opus')
    assert.equal(session.permissionMode, 'approve')
    assert.equal(session._isBusy, false)
    assert.equal(session._processReady, false)
  })

  it('creates hook manager when port is provided', () => {
    const session = createSession({ port: 8765 })
    assert.ok(session._hookManager)
    assert.equal(typeof session._hookManager.register, 'function')
    session._hookManager.destroy()
  })

  it('does not create hook manager without port', () => {
    const session = createSession()
    assert.equal(session._hookManager, null)
  })
})

describe('CliSession.sendMessage', () => {
  it('rejects when busy', () => {
    const session = createReadySession()
    session._isBusy = true
    const errors = []
    session.on('error', (e) => errors.push(e))
    session.sendMessage('hello')
    assert.equal(errors.length, 1)
    assert.ok(errors[0].message.includes('Already processing'))
  })

  it('queues message when process not ready', () => {
    const session = createSession()
    session._processReady = false
    session.sendMessage('queued message')
    assert.equal(session._pendingQueue.length, 1)
    assert.deepStrictEqual(session._pendingQueue[0], { prompt: 'queued message', attachments: undefined, options: {} })
    assert.equal(session._isBusy, false)
  })

  it('writes NDJSON to stdin and sets busy state', () => {
    const session = createReadySession()
    const written = []
    session._child.stdin = new Writable({
      write(chunk, enc, cb) { written.push(chunk.toString()); cb() },
    })

    session.sendMessage('test prompt')

    assert.equal(session._isBusy, true)
    assert.equal(session._currentMessageId, 'msg-1')
    assert.equal(written.length, 1)
    const parsed = JSON.parse(written[0].trim())
    assert.equal(parsed.type, 'user')
    assert.equal(parsed.message.content[0].text, 'test prompt')
    // Clean up timer
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null
  })

  it('sets result timeout on send', () => {
    const session = createReadySession()
    session.sendMessage('test')
    assert.ok(session._resultTimeout)
    // Clean up to prevent test hanging
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null
    session._isBusy = false
  })
})

describe('CliSession._clearMessageState', () => {
  it('resets busy state and clears result timeout', () => {
    const session = createReadySession()
    session._isBusy = true
    session._currentMessageId = 'msg-1'
    session._resultTimeout = setTimeout(() => {}, 10000)
    session._currentCtx = { hasStreamStarted: false, didStreamText: false }

    session._clearMessageState()

    assert.equal(session._isBusy, false)
    assert.equal(session._currentMessageId, null)
    assert.equal(session._currentCtx, null)
    assert.equal(session._resultTimeout, null)
  })

  it('emits agent_completed for all tracked agents', () => {
    const session = createReadySession()
    session._isBusy = true
    session._currentCtx = { hasStreamStarted: false, didStreamText: false }
    session._activeAgents.set('agent-1', { toolUseId: 'agent-1' })
    session._activeAgents.set('agent-2', { toolUseId: 'agent-2' })

    const completed = []
    session.on('agent_completed', (data) => completed.push(data))
    session._clearMessageState()

    assert.equal(completed.length, 2)
    assert.equal(session._activeAgents.size, 0)
  })

  it('resets stale _inPlanMode when ExitPlanMode never arrived', () => {
    const session = createReadySession()
    session._isBusy = true
    session._inPlanMode = true
    session._planAllowedPrompts = null // ExitPlanMode never set this
    session._currentCtx = { hasStreamStarted: false, didStreamText: false }

    session._clearMessageState()
    assert.equal(session._inPlanMode, false)
  })

  it('preserves _inPlanMode when ExitPlanMode has fired', () => {
    const session = createReadySession()
    session._isBusy = true
    session._inPlanMode = true
    session._planAllowedPrompts = [{ tool: 'Bash', prompt: 'run tests' }]
    session._currentCtx = { hasStreamStarted: false, didStreamText: false }

    session._clearMessageState()
    // _inPlanMode stays true because plan_ready emit + reset happens
    // in the result handler, before _clearMessageState is called.
    // If we reach here with _planAllowedPrompts non-null, it means
    // the result handler path hasn't run yet — preserve the flag.
    assert.equal(session._inPlanMode, true)
  })
})

describe('CliSession._scheduleRespawn', () => {
  let session

  afterEach(() => {
    if (session) {
      session._destroying = true
      if (session._respawnTimer) {
        clearTimeout(session._respawnTimer)
        session._respawnTimer = null
      }
    }
  })

  it('schedules respawn with increasing delay', () => {
    session = createSession()
    session._respawnCount = 0
    session._scheduleRespawn()
    assert.equal(session._respawnCount, 1)
    assert.ok(session._respawnTimer)
  })

  it('gives up after 5 attempts', () => {
    session = createSession()
    session._respawnCount = 5
    const errors = []
    session.on('error', (e) => errors.push(e))
    session._scheduleRespawn()
    assert.equal(session._respawnCount, 6)
    assert.equal(session._respawnTimer, null)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].message.includes('5 attempts'))
  })

  it('does not schedule when destroying', () => {
    session = createSession()
    session._destroying = true
    session._scheduleRespawn()
    assert.equal(session._respawnTimer, null)
  })
})

describe('CliSession.interrupt', () => {
  it('sends SIGINT to child process', () => {
    const session = createReadySession()
    session._isBusy = true
    session.interrupt()
    assert.equal(session._child.kill.mock.calls.length, 1)
    assert.equal(session._child.kill.mock.calls[0].arguments[0], 'SIGINT')
    // Cleanup safety timer to prevent test hanging
    clearTimeout(session._interruptTimer)
    session._interruptTimer = null
  })

  it('sends SIGINT even when not busy (unconditional)', () => {
    const session = createReadySession()
    session._isBusy = false
    session.interrupt()
    // interrupt() sends SIGINT regardless of busy state (only checks _child)
    assert.equal(session._child.kill.mock.calls.length, 1)
    clearTimeout(session._interruptTimer)
    session._interruptTimer = null
  })

  it('does nothing when no child process', () => {
    const session = createSession()
    session._isBusy = true
    session._child = null
    // Should not throw
    session.interrupt()
  })
})

describe('CliSession.destroy', () => {
  it('sets destroying flag and nulls child', () => {
    const session = createReadySession()
    const child = session._child
    session.destroy()
    assert.equal(session._destroying, true)
    // destroy() sets _child = null after calling stdin.end()
    assert.equal(session._child, null)
  })

  it('clears all timers', () => {
    const session = createReadySession()
    session._respawnTimer = setTimeout(() => {}, 10000)
    session._resultTimeout = setTimeout(() => {}, 10000)
    session._interruptTimer = setTimeout(() => {}, 10000)

    session.destroy()

    assert.equal(session._respawnTimer, null)
    assert.equal(session._resultTimeout, null)
    assert.equal(session._interruptTimer, null)
  })

  it('emits agent_completed for tracked agents', () => {
    const session = createReadySession()
    session._activeAgents.set('a1', { toolUseId: 'a1' })
    const completed = []
    session.on('agent_completed', (d) => completed.push(d))

    session.destroy()
    assert.equal(completed.length, 1)
    assert.equal(completed[0].toolUseId, 'a1')
  })

  it('is safe to call multiple times', () => {
    const session = createReadySession()
    session.destroy()
    session.destroy() // should not throw
  })
})

describe('CliSession.respondToQuestion', () => {
  it('writes answer to stdin when waiting', () => {
    const session = createReadySession()
    const written = []
    session._child.stdin = new Writable({
      write(chunk, enc, cb) { written.push(chunk.toString()); cb() },
    })
    session._waitingForAnswer = true

    session.respondToQuestion('My answer')
    assert.equal(session._waitingForAnswer, false)
    assert.equal(written.length, 1)
    const parsed = JSON.parse(written[0].trim())
    assert.equal(parsed.type, 'user')
    assert.equal(parsed.message.content[0].text, 'My answer')
  })

  it('ignores when not waiting', () => {
    const session = createReadySession()
    const written = []
    session._child.stdin = new Writable({
      write(chunk, enc, cb) { written.push(chunk.toString()); cb() },
    })
    session._waitingForAnswer = false
    session.respondToQuestion('Ignored')
    assert.equal(written.length, 0)
  })
})

describe('CliSession properties', () => {
  it('isRunning reflects busy state', () => {
    const session = createSession()
    assert.equal(session.isRunning, false)
    session._isBusy = true
    assert.equal(session.isRunning, true)
  })

  it('isReady requires both processReady and not busy', () => {
    const session = createSession()
    assert.equal(session.isReady, false)
    session._processReady = true
    assert.equal(session.isReady, true)
    session._isBusy = true
    assert.equal(session.isReady, false)
  })

  it('sessionId returns internal ID', () => {
    const session = createSession()
    assert.equal(session.sessionId, null)
    session._sessionId = 'test-123'
    assert.equal(session.sessionId, 'test-123')
  })
})

describe('CliSession agent tracking', () => {
  it('tracks Task tool as agent_spawned', () => {
    const session = createReadySession()
    session._isBusy = true
    session._messageCounter = 1
    session._currentMessageId = 'msg-1'
    session._currentCtx = {
      hasStreamStarted: false, didStreamText: false,
      currentContentBlockType: null, currentToolName: null,
      currentToolUseId: null, toolInputChunks: '', toolInputBytes: 0, toolInputOverflow: false,
    }

    const spawned = []
    session.on('agent_spawned', (d) => spawned.push(d))

    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Task', id: 'toolu_task1' },
      },
    })

    // Provide description via input_json_delta
    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"description":"Run tests"}' },
      },
    })
    session._handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].toolUseId, 'toolu_task1')
    assert.ok(spawned[0].description.includes('Run tests'))
    assert.ok(session._activeAgents.has('toolu_task1'))
  })

  it('truncates agent description to 200 chars', () => {
    const session = createReadySession()
    session._isBusy = true
    session._messageCounter = 1
    session._currentMessageId = 'msg-1'
    session._currentCtx = {
      hasStreamStarted: false, didStreamText: false,
      currentContentBlockType: null, currentToolName: null,
      currentToolUseId: null, toolInputChunks: '', toolInputBytes: 0, toolInputOverflow: false,
    }

    const spawned = []
    session.on('agent_spawned', (d) => spawned.push(d))

    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Task', id: 'toolu_task2' },
      },
    })

    const longDesc = 'x'.repeat(300)
    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: longDesc }) },
      },
    })
    session._handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    assert.equal(spawned.length, 1)
    assert.ok(spawned[0].description.length <= 200) // truncated to 200 chars
  })
})

describe('CliSession plan mode', () => {
  function setupWithCtx() {
    const session = createReadySession()
    session._isBusy = true
    session._messageCounter = 1
    session._currentMessageId = 'msg-1'
    session._currentCtx = {
      hasStreamStarted: false, didStreamText: false,
      currentContentBlockType: null, currentToolName: null,
      currentToolUseId: null, toolInputChunks: '', toolInputBytes: 0, toolInputOverflow: false,
    }
    return session
  }

  it('detects EnterPlanMode tool', () => {
    const session = setupWithCtx()
    const events = []
    session.on('plan_started', (d) => events.push(d))

    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'EnterPlanMode', id: 'toolu_plan1' },
      },
    })
    session._handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    assert.equal(session._inPlanMode, true)
    assert.equal(events.length, 1)
  })

  it('detects ExitPlanMode tool and emits plan_ready on result', () => {
    const session = setupWithCtx()
    session._inPlanMode = true
    const events = []
    session.on('plan_ready', (d) => events.push(d))

    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'ExitPlanMode', id: 'toolu_exit1' },
      },
    })

    const input = JSON.stringify({ allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] })
    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: input },
      },
    })
    session._handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    // plan_ready fires when the result event arrives (end of turn)
    assert.equal(events.length, 0)
    assert.ok(session._planAllowedPrompts)

    // Simulate result event
    session._handleEvent({
      type: 'result',
      session_id: 'test-session',
      total_cost_usd: 0.01,
      duration_ms: 1000,
      usage: {},
    })

    assert.equal(events.length, 1)
    assert.ok(events[0].allowedPrompts)
    assert.equal(events[0].allowedPrompts.length, 1)
    assert.equal(session._inPlanMode, false)
  })

  it('resets stale plan mode on interrupt (EnterPlanMode without ExitPlanMode)', () => {
    const session = setupWithCtx()
    const events = []
    session.on('plan_started', (d) => events.push(d))

    // EnterPlanMode fires
    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'EnterPlanMode', id: 'toolu_plan2' },
      },
    })
    session._handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    assert.equal(session._inPlanMode, true)
    assert.equal(events.length, 1)

    // Simulate interrupt — _clearMessageState called without ExitPlanMode
    session._clearMessageState()

    // Plan mode should be reset (stale — ExitPlanMode never arrived)
    assert.equal(session._inPlanMode, false)
  })
})

describe('#988 — _killAndRespawn extraction', () => {
  it('has _killAndRespawn as a prototype method', () => {
    assert.equal(typeof CliSession.prototype._killAndRespawn, 'function',
      '_killAndRespawn should be extracted as a shared method')
  })

  it('setModel uses _killAndRespawn instead of inline kill logic', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, '../src/cli-session.js'), 'utf-8')
    const setModelBlock = source.match(/setModel\(model\)\s*\{[\s\S]*?^  \}/m)
    assert.ok(setModelBlock, 'setModel method should exist')
    assert.ok(setModelBlock[0].includes('_killAndRespawn'),
      'setModel should delegate to _killAndRespawn')
    assert.ok(!setModelBlock[0].includes('forceKillTimer'),
      'setModel should not contain inline kill logic (forceKillTimer)')
  })

  it('setPermissionMode uses _killAndRespawn instead of inline kill logic', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, '../src/cli-session.js'), 'utf-8')
    const setPermBlock = source.match(/setPermissionMode\(mode\)\s*\{[\s\S]*?^  \}/m)
    assert.ok(setPermBlock, 'setPermissionMode method should exist')
    assert.ok(setPermBlock[0].includes('_killAndRespawn'),
      'setPermissionMode should delegate to _killAndRespawn')
    assert.ok(!setPermBlock[0].includes('forceKillTimer'),
      'setPermissionMode should not contain inline kill logic (forceKillTimer)')
  })
})

describe('_killAndRespawn behavioral tests (#1009)', () => {
  it('setModel kills old child and respawns after close', async () => {
    const session = createReadySession({ model: 'sonnet' })
    const oldChild = session._child

    // Stub start() to prevent actual process spawning
    let startCalled = false
    session.start = () => { startCalled = true }

    // Trigger model change → _killAndRespawn
    session.setModel('opus')

    // _respawning should be set before kill (not _destroying — that's only for permanent teardown)
    assert.equal(session._respawning, true)
    assert.equal(session._destroying, false)
    assert.equal(session._processReady, false)
    assert.equal(session._child, null, 'Old child should be detached')
    assert.equal(oldChild.kill.mock.calls.length, 1, 'kill() should be called on old child')
    assert.equal(oldChild.kill.mock.calls[0].arguments[0], 'SIGTERM')

    // start() not called yet (waiting for close)
    assert.equal(startCalled, false)

    // Simulate old child closing
    oldChild.emit('close', 0)

    // Now start() should have been called
    assert.equal(startCalled, true)
    assert.equal(session._respawning, false)
    assert.equal(session._destroying, false)
    assert.equal(session._respawnCount, 0)
  })

  it('setPermissionMode kills old child and respawns after close', async () => {
    const session = createReadySession({ permissionMode: 'approve' })
    const oldChild = session._child

    let startCalled = false
    session.start = () => { startCalled = true }

    session.setPermissionMode('auto')

    assert.equal(session._respawning, true)
    assert.equal(session._destroying, false)
    assert.equal(session.permissionMode, 'auto')
    assert.equal(oldChild.kill.mock.calls.length, 1)

    oldChild.emit('close', 0)

    assert.equal(startCalled, true)
    assert.equal(session._respawning, false)
    assert.equal(session._destroying, false)
  })

  it('_killAndRespawn clears timers before killing', () => {
    const session = createReadySession({ model: 'sonnet' })
    const oldChild = session._child

    // Set up timers that should be cleared
    session._interruptTimer = setTimeout(() => {}, 100000)
    session._respawnTimer = setTimeout(() => {}, 100000)

    session.start = () => {}
    session.setModel('opus')

    assert.equal(session._interruptTimer, null)
    assert.equal(session._respawnTimer, null)

    // Emit close to clean up the forceKillTimer created by _killAndRespawn
    oldChild.emit('close', 0)
  })

  it('_killAndRespawn starts immediately when no child exists', () => {
    const session = createSession({ model: 'sonnet' })
    session._processReady = true
    session._child = null // no child process

    let startCalled = false
    session.start = () => { startCalled = true }

    session.setModel('opus')

    // Should call start() immediately (no child to kill)
    assert.equal(startCalled, true)
    assert.equal(session._respawning, false)
    assert.equal(session._destroying, false)
  })

  it('setModel ignores change when busy', () => {
    const session = createReadySession({ model: 'sonnet' })
    session._isBusy = true

    let startCalled = false
    session.start = () => { startCalled = true }

    session.setModel('opus')

    // Should be a no-op — model unchanged, no kill
    assert.equal(session.model, 'sonnet')
    assert.equal(session._child.kill.mock.calls.length, 0)
    assert.equal(startCalled, false)
  })

  it('setModel ignores change when model is the same', () => {
    const session = createReadySession({ model: 'claude-sonnet-4-20250514' })

    let startCalled = false
    session.start = () => { startCalled = true }

    session.setModel('sonnet') // resolves to same full ID

    assert.equal(session._child.kill.mock.calls.length, 0)
    assert.equal(startCalled, false)
  })
})

describe('CliSession._buildChildEnv', () => {
  it('strips ANTHROPIC_API_KEY from child env', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-test-key-12345'
    try {
      const session = createSession()
      const env = session._buildChildEnv()
      assert.equal(env.ANTHROPIC_API_KEY, undefined,
        'ANTHROPIC_API_KEY must be absent from child env')
    } finally {
      if (savedKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = savedKey
      }
    }
  })

  it('always includes CI and CLAUDE_HEADLESS vars', () => {
    const session = createSession()
    const env = session._buildChildEnv()
    assert.equal(env.CI, '1')
    assert.equal(env.CLAUDE_HEADLESS, '1')
    assert.equal(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, '1')
  })

  it('includes CHROXY_PORT when port is set', () => {
    const session = createSession({ port: 8765 })
    session._hookManager?.destroy()
    const env = session._buildChildEnv()
    assert.equal(env.CHROXY_PORT, '8765')
  })

  it('omits CHROXY_PORT when port is not set', () => {
    const session = createSession()
    const env = session._buildChildEnv()
    assert.equal(env.CHROXY_PORT, undefined)
  })

  it('sets CHROXY_PERMISSION_MODE from session', () => {
    const session = createSession({ permissionMode: 'auto' })
    const env = session._buildChildEnv()
    assert.equal(env.CHROXY_PERMISSION_MODE, 'auto')
  })

  it('includes CHROXY_TOKEN when apiToken is provided', () => {
    const session = createSession({ apiToken: 'tok-abc123' })
    const env = session._buildChildEnv()
    assert.equal(env.CHROXY_TOKEN, 'tok-abc123')
  })

  it('omits CHROXY_TOKEN when apiToken is not set', () => {
    const session = createSession()
    const env = session._buildChildEnv()
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'CHROXY_TOKEN'), 'CHROXY_TOKEN should not be present in child env when apiToken is not set')
  })

  it('forwards arbitrary process.env keys to child env', () => {
    const savedVal = process.env.CHROXY_TEST_PASSTHROUGH
    process.env.CHROXY_TEST_PASSTHROUGH = 'passthrough-value'
    try {
      const session = createSession()
      const env = session._buildChildEnv()
      assert.equal(env.CHROXY_TEST_PASSTHROUGH, 'passthrough-value',
        'arbitrary env vars should pass through to child')
    } finally {
      if (savedVal === undefined) {
        delete process.env.CHROXY_TEST_PASSTHROUGH
      } else {
        process.env.CHROXY_TEST_PASSTHROUGH = savedVal
      }
    }
  })
})
