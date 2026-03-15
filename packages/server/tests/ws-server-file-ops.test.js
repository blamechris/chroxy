import { describe, it, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once, EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSession, createMockSessionManager, waitFor, GIT } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

// Wrapper that defaults noEncrypt: true for all tests (avoids 5s key exchange timeouts)
// Also clears the log listener that WsServer.start() registers, so log_entry broadcasts
// don't interfere with test message counting and sequence number assertions.
class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}
import WebSocket from 'ws'


/**
 * Helper to wait for an event with timeout.
 * Throws if timeout expires before event fires.
 */
async function withTimeout(promise, timeoutMs, timeoutMessage) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
  )
  return Promise.race([promise, timer])
}

/**
 * Start a WsServer on port 0 (OS-assigned) and return the actual port.
 * Resolves only after the HTTP server emits 'listening', so the port is
 * guaranteed to be open and ready for connections.
 */
async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  const httpServer = server.httpServer
  await new Promise((resolve, reject) => {
    function onListening() {
      httpServer.removeListener('error', onError)
      resolve()
    }
    function onError(err) {
      httpServer.removeListener('listening', onListening)
      reject(err)
    }
    httpServer.once('listening', onListening)
    httpServer.once('error', onError)
  })
  return server.httpServer.address().port
}

/** Helper to connect a WebSocket client and collect messages */
async function createClient(port, expectAuth = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      messages.push(msg)
    } catch (err) {
      console.error('Failed to parse message:', data.toString())
    }
  })

  await withTimeout(
    new Promise((resolve, reject) => {
      function onOpen() {
        ws.removeListener('error', onError)
        resolve()
      }
      function onError(err) {
        ws.removeListener('open', onOpen)
        reject(err)
      }
      ws.once('open', onOpen)
      ws.once('error', onError)
    }),
    2000,
    'Connection timeout'
  )

  if (expectAuth) {
    await waitForMessage(messages, 'auth_ok')
  }

  return { ws, messages }
}

/** Helper to send JSON message */
function send(ws, msg) {
  ws.send(JSON.stringify(msg))
}

/**
 * Helper to wait for a message of a specific type with timeout.
 */
async function waitForMessage(messages, type, timeout = 2000) {
  return waitFor(
    () => messages.find(m => m.type === type),
    { timeoutMs: timeout, label: `message type: ${type}` }
  )
}

/**
 * Helper to wait for a message matching an arbitrary predicate.
 */
async function waitForMessageMatch(messages, predicate, timeout = 2000, label = 'message match') {
  return waitFor(
    () => messages.find(predicate),
    { timeoutMs: timeout, label }
  )
}

// ---------------------------------------------------------------------------
// Directory listing tests
// ---------------------------------------------------------------------------

describe('directory listing', () => {
  let server
  const TOKEN = 'test-token'

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('lists directories at a valid path', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // List home directory — should always exist and contain directories
    send(ws, { type: 'list_directory', path: '~' })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.equal(listing.error, null)
    assert.ok(Array.isArray(listing.entries))

    ws.close()
  })

  it('returns error for non-existent path', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // Use a path inside the home directory that doesn't exist
    const os = await import('os')
    const nonexistent = `${os.homedir()}/nonexistent_path_that_does_not_exist_12345`
    send(ws, { type: 'list_directory', path: nonexistent })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.equal(listing.error, 'Directory not found')
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('returns error for a file path', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // Use this test file itself as a file path
    const filePath = new URL(import.meta.url).pathname
    send(ws, { type: 'list_directory', path: filePath })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.equal(listing.error, 'Not a directory')
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('filters hidden directories', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // List home directory — should have entries but none starting with '.'
    send(ws, { type: 'list_directory', path: '~' })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.equal(listing.error, null)
    const hidden = listing.entries.filter(e => e.name.startsWith('.'))
    assert.equal(hidden.length, 0, 'Should not include hidden directories')

    ws.close()
  })

  it('requires authentication', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)

    // Send list_directory before authenticating
    send(ws, { type: 'list_directory', path: '~' })
    await new Promise(r => setTimeout(r, 200))

    // Should NOT get any directory_listing back (message is ignored pre-auth)
    const listing = messages.find(m => m.type === 'directory_listing')
    assert.equal(listing, undefined, 'Should not respond to unauthenticated requests')

    ws.close()
  })

  it('defaults to home directory when path is empty', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    send(ws, { type: 'list_directory' })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.equal(listing.error, null)
    assert.ok(listing.path, 'Should have a resolved path')
    assert.ok(listing.entries.length > 0, 'Home directory should have entries')

    ws.close()
  })

  it('works in multi-session mode', async () => {
    const manager = new EventEmitter()
    const mockSession = createMockSession()
    mockSession.cwd = '/tmp/test'

    const sessionsMap = new Map()
    sessionsMap.set('sess-1', { session: mockSession, name: 'Test', cwd: '/tmp/test', type: 'cli', isBusy: false })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => [{ id: 'sess-1', name: 'Test', cwd: '/tmp/test', type: 'cli', isBusy: false }]
    manager.getHistory = () => []
    manager.recordUserInput = () => {}
    manager.getFullHistoryAsync = async () => []
    manager.isBudgetPaused = () => false
    Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1' })

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    send(ws, { type: 'list_directory', path: '~' })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing in multi-session mode')
    assert.equal(listing.error, null)

    ws.close()
  })

  it('restricts listing to home directory', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // Try listing /tmp — should be denied (outside home directory)
    send(ws, { type: 'list_directory', path: '/tmp' })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.ok(listing.error.includes('restricted'), 'Should get access denied error')
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('rejects symlink inside home that points outside home (#662)', async () => {
    // Create a temp directory inside home with a symlink escaping to /tmp
    const home = homedir()
    const testDir = mkdtempSync(join(home, '.chroxy-test-symlink-'))
    const outsideTarget = mkdtempSync(join(tmpdir(), 'chroxy-test-outside-'))
    writeFileSync(join(outsideTarget, 'leaked.txt'), 'should not see this')
    mkdirSync(join(outsideTarget, 'leaked-dir'))

    try {
      symlinkSync(outsideTarget, join(testDir, 'escape-link'))

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: createMockSession(),
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      // Try listing through the symlink — should be denied
      send(ws, { type: 'list_directory', path: join(testDir, 'escape-link') })

      const listing = await waitForMessage(messages, 'directory_listing', 2000)
      assert.ok(listing, 'Should receive directory_listing')
      assert.ok(listing.error, 'Should return an error for symlink outside home')
      assert.match(listing.error, /restricted/i)
      assert.deepEqual(listing.entries, [])

      ws.close()
    } finally {
      rmSync(testDir, { recursive: true, force: true })
      rmSync(outsideTarget, { recursive: true, force: true })
    }
  })

  it('allows symlink inside home that points within home (#662)', async () => {
    // Create a temp directory inside home with a symlink pointing to another dir in home
    const home = homedir()
    const testDir = mkdtempSync(join(home, '.chroxy-test-symlink-'))
    const internalTarget = join(testDir, 'real-dir')
    mkdirSync(internalTarget)
    mkdirSync(join(internalTarget, 'child'))

    try {
      symlinkSync(internalTarget, join(testDir, 'internal-link'))

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: createMockSession(),
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      // List through the symlink — should work since target is inside home
      send(ws, { type: 'list_directory', path: join(testDir, 'internal-link') })

      const listing = await waitForMessage(messages, 'directory_listing', 2000)
      assert.ok(listing, 'Should receive directory_listing')
      assert.equal(listing.error, null, 'Should not return error for symlink within home')
      assert.ok(listing.entries.some(e => e.name === 'child'), 'Should list child directory')

      ws.close()
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Slash commands tests
// ---------------------------------------------------------------------------

describe('slash commands', () => {
  let server
  const TOKEN = 'test-token'

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('returns commands from project .claude/commands/ directory', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    // Create temp project with .claude/commands/
    const tmpDir = join(tmpdir(), `chroxy-test-slash-${Date.now()}`)
    const cmdDir = join(tmpDir, '.claude', 'commands')
    mkdirSync(cmdDir, { recursive: true })
    writeFileSync(join(cmdDir, 'deploy.md'), '# /deploy\n\nDeploy to production.\n\n## Steps\n...')
    writeFileSync(join(cmdDir, 'test.md'), '# /test\n\nRun the test suite.\n')

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_slash_commands' })
      const result = await waitForMessage(messages, 'slash_commands', 2000)

      assert.ok(result, 'Should receive slash_commands')
      assert.ok(Array.isArray(result.commands))
      assert.ok(result.commands.length >= 2, 'Should find at least 2 commands')

      const deploy = result.commands.find(c => c.name === 'deploy')
      assert.ok(deploy, 'Should include deploy command')
      assert.equal(deploy.source, 'project')
      assert.ok(deploy.description.length > 0, 'Should extract description')

      const test = result.commands.find(c => c.name === 'test')
      assert.ok(test, 'Should include test command')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns empty array when no commands exist', async () => {
    const { mkdirSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-slash-empty-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_slash_commands' })
      const result = await waitForMessage(messages, 'slash_commands', 2000)

      assert.ok(result, 'Should receive slash_commands')
      assert.ok(Array.isArray(result.commands))

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('works in multi-session mode', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-slash-ms-${Date.now()}`)
    const cmdDir = join(tmpDir, '.claude', 'commands')
    mkdirSync(cmdDir, { recursive: true })
    writeFileSync(join(cmdDir, 'build.md'), '# /build\n\nBuild the project.')

    try {
      const manager = new EventEmitter()
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      const sessionsMap = new Map()
      sessionsMap.set('sess-1', { session: mockSession, name: 'Test', cwd: tmpDir, type: 'cli', isBusy: false })
      manager.getSession = (id) => sessionsMap.get(id)
      manager.listSessions = () => [{ id: 'sess-1', name: 'Test', cwd: tmpDir, type: 'cli', isBusy: false }]
      manager.getHistory = () => []
      manager.recordUserInput = () => {}
      manager.getFullHistoryAsync = async () => []
      manager.isBudgetPaused = () => false
      Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1' })

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        sessionManager: manager,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_slash_commands' })
      const result = await waitForMessage(messages, 'slash_commands', 2000)

      assert.ok(result, 'Should receive slash_commands in multi-session mode')
      assert.equal(result.sessionId, 'sess-1', 'slash_commands should include sessionId in multi-session mode')
      const build = result.commands.find(c => c.name === 'build')
      assert.ok(build, 'Should include build command')
      assert.equal(build.source, 'project')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('omits sessionId in single-session CLI mode', async () => {
    const { mkdirSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-slash-cli-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_slash_commands' })
      const result = await waitForMessage(messages, 'slash_commands', 2000)

      assert.ok(result, 'Should receive slash_commands')
      assert.equal(result.sessionId, undefined, 'slash_commands should NOT include sessionId in single-session mode')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Agent listing tests
// ---------------------------------------------------------------------------

describe('agent listing', () => {
  let server
  const TOKEN = 'test-token'

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('returns agents from project .claude/agents/ directory', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-agents-${Date.now()}`)
    const agentDir = join(tmpDir, '.claude', 'agents')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'reviewer.md'), '# Reviewer\n\nReviews code changes for quality.\n')
    writeFileSync(join(agentDir, 'deployer.md'), '# Deployer\n\nDeploys to staging environment.\n')

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_agents' })
      const result = await waitForMessage(messages, 'agent_list', 2000)

      assert.ok(result, 'Should receive agent_list')
      assert.ok(Array.isArray(result.agents))
      assert.ok(result.agents.length >= 2, 'Should find at least 2 agents')

      const deployer = result.agents.find(a => a.name === 'deployer')
      assert.ok(deployer, 'Should include deployer agent')
      assert.equal(deployer.source, 'project')
      assert.ok(deployer.description.length > 0)

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns empty array when no agents exist', async () => {
    const { mkdirSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-agents-empty-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_agents' })
      const result = await waitForMessage(messages, 'agent_list', 2000)

      assert.ok(result, 'Should receive agent_list')
      assert.ok(Array.isArray(result.agents))
      // No project agents should exist (temp dir has no .claude/agents/)
      // User agents from ~/.claude/agents/ may be present on the dev machine
      const projectAgents = result.agents.filter(a => a.source === 'project')
      assert.equal(projectAgents.length, 0, 'Should have no project agents from empty temp dir')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('includes sessionId in multi-session mode', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-agents-ms-${Date.now()}`)
    const agentDir = join(tmpDir, '.claude', 'agents')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'helper.md'), '# Helper\n\nHelps with tasks.\n')

    try {
      const manager = new EventEmitter()
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      const sessionsMap = new Map()
      sessionsMap.set('sess-1', { session: mockSession, name: 'Test', cwd: tmpDir, type: 'cli', isBusy: false })
      manager.getSession = (id) => sessionsMap.get(id)
      manager.listSessions = () => [{ id: 'sess-1', name: 'Test', cwd: tmpDir, type: 'cli', isBusy: false }]
      manager.getHistory = () => []
      manager.recordUserInput = () => {}
      manager.getFullHistoryAsync = async () => []
      manager.isBudgetPaused = () => false
      Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1' })

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        sessionManager: manager,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_agents' })
      const result = await waitForMessage(messages, 'agent_list', 2000)

      assert.ok(result, 'Should receive agent_list in multi-session mode')
      assert.equal(result.sessionId, 'sess-1', 'agent_list should include sessionId in multi-session mode')
      const helper = result.agents.find(a => a.name === 'helper')
      assert.ok(helper, 'Should include helper agent')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('omits sessionId in single-session CLI mode', async () => {
    const { mkdirSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-agents-cli-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_agents' })
      const result = await waitForMessage(messages, 'agent_list', 2000)

      assert.ok(result, 'Should receive agent_list')
      assert.equal(result.sessionId, undefined, 'agent_list should NOT include sessionId in single-session mode')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// File browser symlink security tests (#690)
// ---------------------------------------------------------------------------

describe('file browser symlink security', () => {
  let server
  let tempDir    // main CWD
  let outsideDir // directory outside CWD that symlinks target

  beforeEach(() => {
    // Create temp directories
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-test-cwd-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'chroxy-test-outside-'))

    // Create structure inside CWD:
    //   tempDir/
    //     subdir/
    //       file.txt
    //     internal-link -> subdir/     (symlink within CWD — should work)
    //     escape-link -> outsideDir/   (symlink outside CWD — should be blocked)
    //     escape-file -> outsideDir/secret.txt (file symlink outside CWD — should be blocked)
    mkdirSync(join(tempDir, 'subdir'))
    writeFileSync(join(tempDir, 'subdir', 'file.txt'), 'inside content')
    writeFileSync(join(outsideDir, 'secret.txt'), 'outside secret')
    mkdirSync(join(outsideDir, 'hidden-dir'))
    writeFileSync(join(outsideDir, 'hidden-dir', 'data.txt'), 'hidden data')

    symlinkSync(join(tempDir, 'subdir'), join(tempDir, 'internal-link'))
    symlinkSync(outsideDir, join(tempDir, 'escape-link'))
    symlinkSync(join(outsideDir, 'secret.txt'), join(tempDir, 'escape-file'))
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    rmSync(tempDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  /** Spin up a WsServer with cwd set to tempDir and return a connected client. */
  async function createFileBrowserTestServer() {
    const mockSession = createMockSession()
    mockSession.cwd = tempDir

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    return { ws, messages }
  }

  it('browse_files: rejects symlink directory pointing outside CWD', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'browse_files', path: 'escape-link' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error for symlink outside CWD')
    assert.match(listing.error, /access denied/i)
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('browse_files: allows symlink directory pointing within CWD', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'browse_files', path: 'internal-link' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.equal(listing.error, null, 'Should not return an error for symlink within CWD')
    assert.ok(listing.entries.length > 0, 'Should return entries')
    assert.ok(listing.entries.some(e => e.name === 'file.txt'), 'Should list file.txt inside symlinked dir')

    ws.close()
  })

  it('browse_files: rejects ../../../ path traversal', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'browse_files', path: '../../../etc' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error for path traversal')
    assert.match(listing.error, /access denied/i)
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('read_file: rejects symlink file pointing outside CWD', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'read_file', path: 'escape-file' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for symlink file outside CWD')
    assert.match(content.error, /access denied/i)
    assert.equal(content.content, null)

    ws.close()
  })

  it('read_file: allows reading file through symlink within CWD', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'read_file', path: 'internal-link/file.txt' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.equal(content.error, null, 'Should not return error for symlink within CWD')
    assert.equal(content.content, 'inside content')

    ws.close()
  })

  it('read_file: rejects ../../../etc/passwd traversal', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'read_file', path: '../../../etc/passwd' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for path traversal')
    assert.match(content.error, /access denied/i)
    assert.equal(content.content, null)

    ws.close()
  })

  it('read_file: rejects null bytes in path', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'read_file', path: 'subdir/file.txt\x00.jpg' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    // Should error — either access denied or file not found, but NOT return content
    assert.ok(content.error, 'Should return an error for null bytes in path')

    ws.close()
  })

  it('browse_files: rejects symlink chain escaping CWD', async () => {
    // Create a chain: tempDir/chain-link -> outsideDir/hidden-dir
    symlinkSync(join(outsideDir, 'hidden-dir'), join(tempDir, 'chain-link'))

    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'browse_files', path: 'chain-link' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error for symlink chain outside CWD')
    assert.match(listing.error, /access denied/i)

    ws.close()
  })
})

// ---------------------------------------------------------------------------
// get_diff handler tests
// ---------------------------------------------------------------------------

describe('get_diff handler', () => {
  let server
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-diff-test-'))
    // Initialize a git repo in the temp directory
    execFileSync(GIT, ['init'], { cwd: tempDir, stdio: 'pipe' })
    execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tempDir, stdio: 'pipe' })
    execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tempDir, stdio: 'pipe' })
    // Create an initial commit
    writeFileSync(join(tempDir, 'file.txt'), 'initial content\n')
    execFileSync(GIT, ['add', '.'], { cwd: tempDir, stdio: 'pipe' })
    execFileSync(GIT, ['commit', '-m', 'initial'], { cwd: tempDir, stdio: 'pipe' })
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function createDiffTestServer() {
    const mockSession = createMockSession()
    mockSession.cwd = tempDir

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    return { ws, messages }
  }

  it('returns empty files array when no changes', async () => {
    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    assert.deepEqual(result.files, [])

    ws.close()
  })

  it('returns diff for modified file', async () => {
    // Modify the file
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].path, 'file.txt')
    assert.equal(result.files[0].status, 'modified')
    assert.ok(result.files[0].additions > 0 || result.files[0].deletions > 0,
      'Should have additions or deletions')
    assert.ok(result.files[0].hunks.length > 0, 'Should have hunks')

    ws.close()
  })

  it('returns untracked new file with synthetic diff', async () => {
    writeFileSync(join(tempDir, 'new-file.txt'), 'new content\n')

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].path, 'new-file.txt')
    assert.equal(result.files[0].status, 'untracked')
    assert.equal(result.files[0].additions, 1)
    assert.equal(result.files[0].deletions, 0)
    assert.equal(result.files[0].hunks.length, 1)
    assert.equal(result.files[0].hunks[0].header, 'New untracked file')
    assert.equal(result.files[0].hunks[0].lines[0].type, 'addition')
    assert.equal(result.files[0].hunks[0].lines[0].content, 'new content')

    ws.close()
  })

  it('shows untracked files alongside modified files', async () => {
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')
    writeFileSync(join(tempDir, 'untracked.txt'), 'brand new\n')

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    assert.equal(result.files.length, 2)

    const modified = result.files.find(f => f.path === 'file.txt')
    const untracked = result.files.find(f => f.path === 'untracked.txt')
    assert.ok(modified, 'Modified file should be present')
    assert.ok(untracked, 'Untracked file should be present')
    assert.equal(modified.status, 'modified')
    assert.equal(untracked.status, 'untracked')

    ws.close()
  })

  it('caps untracked files at 10', async () => {
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(tempDir, `untracked-${String(i).padStart(2, '0')}.txt`), `content ${i}\n`)
    }

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    const untrackedFiles = result.files.filter(f => f.status === 'untracked')
    assert.equal(untrackedFiles.length, 10, 'Should cap at 10 untracked files')

    ws.close()
  })

  it('shows placeholder for untracked files exceeding 50KB', async () => {
    // Create a file just over 50KB
    const bigContent = 'x'.repeat(51 * 1024) + '\n'
    writeFileSync(join(tempDir, 'big-untracked.txt'), bigContent)

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    const bigFile = result.files.find(f => f.path === 'big-untracked.txt')
    assert.ok(bigFile, 'Big untracked file should be present')
    assert.equal(bigFile.status, 'untracked')
    assert.equal(bigFile.additions, 0, 'Too-large file should have 0 additions')
    assert.equal(bigFile.hunks.length, 1)
    assert.equal(bigFile.hunks[0].lines.length, 1)
    assert.equal(bigFile.hunks[0].lines[0].type, 'context')
    assert.ok(bigFile.hunks[0].lines[0].content.includes('File too large to preview'), 'Should show size placeholder')

    ws.close()
  })

  it('shows placeholder for binary untracked files', async () => {
    // Create a binary file with realistic JPEG header bytes (invalid UTF-8 + null bytes)
    const binaryContent = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0,                         // JPEG SOI + APP0 marker
      0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,       // JFIF segment with nulls
      0x01, 0x02, 0xFF, 0xDB, 0xFF, 0xC0, 0xFF, 0xDA, // typical JPEG markers
    ])
    writeFileSync(join(tempDir, 'image.png'), binaryContent)

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    const binaryFile = result.files.find(f => f.path === 'image.png')
    assert.ok(binaryFile, 'Binary untracked file should be present')
    assert.equal(binaryFile.status, 'untracked')
    assert.equal(binaryFile.additions, 0, 'Binary file should have 0 additions')
    assert.equal(binaryFile.hunks.length, 1)
    assert.equal(binaryFile.hunks[0].lines.length, 1)
    assert.equal(binaryFile.hunks[0].lines[0].type, 'context')
    assert.ok(binaryFile.hunks[0].lines[0].content.includes('Binary file'), 'Should show binary placeholder')

    ws.close()
  })

  it('returns error when no sessionCwd', async () => {
    // Create a mock session without cwd set (cwd is undefined)
    const mockSession = createMockSession()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.ok(result.error, 'Should return error when no CWD')
    assert.match(result.error, /not available/i)

    ws.close()
  })

  it('returns friendly error for non-git directory', async () => {
    // Create a plain (non-git) temp directory
    const nonGitDir = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-nongit-')))
    let ws
    try {
      const mockSession = createMockSession()
      mockSession.cwd = nonGitDir

      server = new WsServer({
        port: 0,
        apiToken: 'test-token',
        cliSession: mockSession,
        authRequired: false,
      })
      const port = await startServerAndGetPort(server)
      const client = await createClient(port, true)
      ws = client.ws

      send(ws, { type: 'get_diff' })
      const result = await waitForMessage(client.messages, 'diff_result', 5000)

      assert.ok(result.error, 'Should return error for non-git dir')
      assert.match(result.error, /not a git repository/i)
      assert.deepEqual(result.files, [])
    } finally {
      if (ws) ws.close()
      rmSync(nonGitDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// browse_files and read_file handler tests (#663)
// ---------------------------------------------------------------------------
describe('browse_files and read_file handlers', () => {
  let server
  let tempDir

  beforeEach(() => {
    // Resolve symlinks (macOS /tmp -> /private/tmp) so paths match CWD realpath checks
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-fb-test-')))

    // Build a test directory tree:
    //   tempDir/
    //     alpha.js
    //     beta.py
    //     .hidden
    //     node_modules/
    //       dep/
    //     subdir/
    //       nested.txt
    //     zeta/
    mkdirSync(join(tempDir, 'subdir'))
    mkdirSync(join(tempDir, 'zeta'))
    mkdirSync(join(tempDir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(tempDir, 'alpha.js'), 'const a = 1')
    writeFileSync(join(tempDir, 'beta.py'), 'print("hi")')
    writeFileSync(join(tempDir, '.hidden'), 'secret')
    writeFileSync(join(tempDir, 'subdir', 'nested.txt'), 'nested content')
    writeFileSync(join(tempDir, 'node_modules', 'dep', 'index.js'), 'module.exports = {}')
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  /** Spin up a WsServer with cwd set to tempDir and return a connected client. */
  async function createTestServer(opts = {}) {
    const mockSession = createMockSession()
    if (opts.cwd !== undefined) {
      mockSession.cwd = opts.cwd
    } else {
      mockSession.cwd = tempDir
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    return { ws, messages }
  }

  // ------- browse_files -------

  it('browse_files: lists files in session CWD', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'browse_files', path: '' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.equal(listing.error, null, 'Should not return an error')
    assert.ok(listing.entries.length > 0, 'Should return entries')

    // Check entries have expected shape
    for (const entry of listing.entries) {
      assert.equal(typeof entry.name, 'string')
      assert.equal(typeof entry.isDirectory, 'boolean')
      // size is null for directories, number for files
      if (!entry.isDirectory) {
        assert.equal(typeof entry.size, 'number')
      }
    }

    // alpha.js should be present
    assert.ok(listing.entries.some(e => e.name === 'alpha.js'), 'Should include alpha.js')
    // subdir should be present
    assert.ok(listing.entries.some(e => e.name === 'subdir' && e.isDirectory), 'Should include subdir/')

    ws.close()
  })

  it('browse_files: sorts directories first, then alphabetical', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'browse_files', path: '' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.equal(listing.error, null)

    const dirs = listing.entries.filter(e => e.isDirectory)
    const files = listing.entries.filter(e => !e.isDirectory)

    // All directories should come before all files
    const lastDirIdx = listing.entries.lastIndexOf(dirs[dirs.length - 1])
    const firstFileIdx = listing.entries.indexOf(files[0])
    assert.ok(lastDirIdx < firstFileIdx, 'Directories should come before files')

    // Directories should be alphabetical among themselves
    for (let i = 1; i < dirs.length; i++) {
      assert.ok(dirs[i - 1].name.localeCompare(dirs[i].name) <= 0,
        `Dir ${dirs[i - 1].name} should come before ${dirs[i].name}`)
    }

    // Files should be alphabetical among themselves
    for (let i = 1; i < files.length; i++) {
      assert.ok(files[i - 1].name.localeCompare(files[i].name) <= 0,
        `File ${files[i - 1].name} should come before ${files[i].name}`)
    }

    ws.close()
  })

  it('browse_files: filters dotfiles and node_modules', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'browse_files', path: '' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.equal(listing.error, null)

    const names = listing.entries.map(e => e.name)
    assert.ok(!names.includes('.hidden'), 'Should not include dotfiles')
    assert.ok(!names.includes('node_modules'), 'Should not include node_modules')

    ws.close()
  })

  it('browse_files: defaults to CWD when path is empty or null', async () => {
    const { ws, messages } = await createTestServer()

    // Test with empty string
    send(ws, { type: 'browse_files', path: '' })
    const listing1 = await waitForMessage(messages, 'file_listing', 2000)
    assert.equal(listing1.error, null, 'Empty string should not error')
    assert.ok(listing1.entries.length > 0, 'Should return entries for empty path')
    const names1 = listing1.entries.map(e => e.name)

    // Clear messages for next request
    messages.length = 0

    // Test with null
    send(ws, { type: 'browse_files', path: null })
    const listing2 = await waitForMessage(messages, 'file_listing', 2000)
    assert.equal(listing2.error, null, 'Null path should not error')

    // Both should return the same entries (CWD root)
    const names2 = listing2.entries.map(e => e.name)
    assert.deepEqual(names1, names2, 'Empty and null should return same entries')

    ws.close()
  })

  it('browse_files: rejects path traversal outside CWD', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'browse_files', path: '../../etc' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error for path traversal')
    assert.match(listing.error, /access denied/i)
    assert.deepEqual(listing.entries, [])

    // Also test absolute paths outside CWD
    messages.length = 0
    send(ws, { type: 'browse_files', path: '/etc' })
    const listing2 = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing2.error, 'Should return an error for absolute path outside CWD')
    assert.match(listing2.error, /access denied/i)
    assert.deepEqual(listing2.entries, [])

    ws.close()
  })

  it('browse_files: returns error when no session CWD', async () => {
    const { ws, messages } = await createTestServer({ cwd: null })

    send(ws, { type: 'browse_files', path: '' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error when no CWD')
    assert.match(listing.error, /not available/i)
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('browse_files: returns error for non-existent directory', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'browse_files', path: 'does-not-exist' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error for non-existent directory')
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  // ------- read_file -------

  it('read_file: reads a text file', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'alpha.js' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.equal(content.error, null, 'Should not return an error')
    assert.equal(content.content, 'const a = 1')
    assert.equal(typeof content.size, 'number')
    assert.equal(content.truncated, false)

    ws.close()
  })

  it('read_file: detects language from file extension', async () => {
    const { ws, messages } = await createTestServer()

    // .js -> js
    send(ws, { type: 'read_file', path: 'alpha.js' })
    const jsContent = await waitForMessage(messages, 'file_content', 2000)
    assert.equal(jsContent.language, 'js', 'Should detect .js extension')

    // .py -> py
    messages.length = 0
    send(ws, { type: 'read_file', path: 'beta.py' })
    const pyContent = await waitForMessage(messages, 'file_content', 2000)
    assert.equal(pyContent.language, 'py', 'Should detect .py extension')

    // .txt -> txt
    messages.length = 0
    send(ws, { type: 'read_file', path: 'subdir/nested.txt' })
    const txtContent = await waitForMessage(messages, 'file_content', 2000)
    assert.equal(txtContent.language, 'txt', 'Should detect .txt extension')

    ws.close()
  })

  it('read_file: rejects path traversal outside CWD', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: '../../etc/passwd' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for path traversal')
    assert.match(content.error, /access denied/i)
    assert.equal(content.content, null)

    // Also test absolute path outside CWD
    messages.length = 0
    send(ws, { type: 'read_file', path: '/etc/passwd' })
    const content2 = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content2.error, 'Should return an error for absolute path outside CWD')
    assert.match(content2.error, /access denied/i)
    assert.equal(content2.content, null)

    ws.close()
  })

  it('read_file: rejects files over 512KB', async () => {
    // Create a file slightly over 512KB
    const largeContent = 'x'.repeat(512 * 1024 + 1)
    writeFileSync(join(tempDir, 'large.bin'), largeContent)

    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'large.bin' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for large file')
    assert.match(content.error, /too large/i)
    assert.equal(content.content, null)
    assert.equal(typeof content.size, 'number')
    assert.ok(content.size > 512 * 1024, 'Should report actual file size')

    ws.close()
  })

  it('read_file: truncates content over 100KB', async () => {
    // Create a file over 100KB but under 512KB
    const bigContent = 'a'.repeat(150 * 1024)
    writeFileSync(join(tempDir, 'big.txt'), bigContent)

    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'big.txt' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.equal(content.error, null, 'Should not return an error')
    assert.equal(content.truncated, true, 'Should be marked as truncated')
    assert.equal(content.content.length, 100 * 1024, 'Content should be truncated to 100KB')

    ws.close()
  })

  it('read_file: returns base64 data URL for image files', async () => {
    // Create a small PNG-like file with null bytes (binary)
    const binaryContent = Buffer.alloc(100)
    binaryContent[0] = 0x89  // PNG header
    binaryContent[1] = 0x50
    binaryContent[2] = 0x4e
    binaryContent[3] = 0x47
    binaryContent[10] = 0x00 // null byte
    writeFileSync(join(tempDir, 'image.png'), binaryContent)

    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'image.png' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.equal(content.error, null, 'Image files should not return error')
    assert.equal(content.language, 'image')
    assert.ok(content.content.startsWith('data:image/png;base64,'), 'Should return base64 data URL')

    ws.close()
  })

  it('read_file: detects non-image binary files', async () => {
    // Create a generic binary file (not an image extension)
    const binaryContent = Buffer.alloc(100)
    binaryContent[10] = 0x00 // null byte
    writeFileSync(join(tempDir, 'data.bin'), binaryContent)

    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'data.bin' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for non-image binary file')
    assert.match(content.error, /binary/i)
    assert.equal(content.content, null)

    ws.close()
  })

  it('read_file: returns error for directories', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'subdir' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for directory')
    assert.match(content.error, /cannot read a directory/i)
    assert.equal(content.content, null)

    ws.close()
  })

  it('read_file: returns error for non-existent file', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'does-not-exist.txt' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for non-existent file')
    assert.match(content.error, /not found/i)
    assert.equal(content.content, null)

    ws.close()
  })

  it('read_file: returns error when no session CWD', async () => {
    const { ws, messages } = await createTestServer({ cwd: null })

    send(ws, { type: 'read_file', path: 'alpha.js' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error when no CWD')
    assert.match(content.error, /not available/i)
    assert.equal(content.content, null)

    ws.close()
  })
})
