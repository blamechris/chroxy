import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { execFileSync, execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSession, waitFor, GIT, disableRepoAutoGc, rmDirRobust } from './test-helpers.js'
import { setLogListener, addLogListener, removeLogListener } from '../src/logger.js'
import { truncateForLog, createReaderOps } from '../src/ws-file-ops/reader.js'
import { resolveSessionCwd, validatePathWithinCwd } from '../src/ws-file-ops/common.js'

const realExecFileAsync = promisify(execFileCb)

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
    } catch (_err) {
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
async function _waitForMessageMatch(messages, predicate, timeout = 2000, label = 'message match') {
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

    // list_directory restricts to $HOME, so the file under test must live there.
    // Using this test file's own path only worked when the repo happened to be
    // under $HOME (a dev machine); in a CI container the repo is at /work and
    // the home-restriction fired first, masking the not-a-directory check
    // (#6075). Create a real file inside $HOME instead.
    const homeTmpDir = mkdtempSync(join(homedir(), '.chx-fileops-test-'))
    const filePath = join(homeTmpDir, 'afile.txt')
    writeFileSync(filePath, 'x')
    try {
      send(ws, { type: 'list_directory', path: filePath })

      const listing = await waitForMessage(messages, 'directory_listing', 2000)
      assert.ok(listing, 'Should receive directory_listing')
      assert.equal(listing.error, 'Not a directory')
      assert.deepEqual(listing.entries, [])
    } finally {
      rmSync(homeTmpDir, { recursive: true, force: true })
      ws.close()
    }
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
    // The empty path must default to $HOME. Assert the resolved path IS the
    // home directory rather than that home is non-empty — a fresh CI container
    // home (/root) can be empty once hidden entries are filtered, which made
    // the old entries>0 check fail there (#6075).
    assert.equal(realpathSync(listing.path), realpathSync(homedir()),
      'empty path should resolve to the home directory')
    assert.ok(Array.isArray(listing.entries), 'entries should be an array')

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

  // -------------------------------------------------------------------------
  // #3856 — built-in commands surface in the picker alongside .md skills
  // -------------------------------------------------------------------------
  it('merges provider built-ins ahead of project skills (#3856)', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { EventEmitter } = await import('events')

    const tmpDir = join(tmpdir(), `chroxy-test-slash-builtins-${Date.now()}`)
    const cmdDir = join(tmpDir, '.claude', 'commands')
    mkdirSync(cmdDir, { recursive: true })
    // A user-authored skill that should ALSO appear, but ranked AFTER built-ins.
    writeFileSync(join(cmdDir, 'deploy.md'), '# /deploy\n\nDeploy to production.\n')
    // A name collision with a built-in (`/clear`). The built-in must win —
    // a user can't shadow a provider command (would mismatch what the CLI
    // actually does downstream).
    writeFileSync(join(cmdDir, 'clear.md'), '# /clear\n\nUser-defined clear that should be SHADOWED.\n')

    try {
      const manager = new EventEmitter()
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      const sessionsMap = new Map()
      sessionsMap.set('sess-1', {
        session: mockSession,
        name: 'Test',
        cwd: tmpDir,
        type: 'cli',
        isBusy: false,
        // The wired-through provider id — listSlashCommands keys built-ins off this.
        provider: 'claude-sdk',
      })
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

      assert.ok(result, 'Should receive slash_commands')
      assert.ok(Array.isArray(result.commands))

      const byName = new Map(result.commands.map(c => [c.name, c]))

      // Built-ins surface.
      assert.ok(byName.has('clear'), 'should include built-in /clear')
      assert.ok(byName.has('compact'), 'should include built-in /compact')
      assert.ok(byName.has('model'), 'should include built-in /model (sdk supports modelSwitch)')
      assert.equal(byName.get('clear').source, 'builtin')

      // Project skill still surfaces.
      assert.ok(byName.has('deploy'), 'should include user-authored /deploy')
      assert.equal(byName.get('deploy').source, 'project')

      // Built-in wins the /clear collision (only one entry, sourced as builtin).
      const clearEntries = result.commands.filter(c => c.name === 'clear')
      assert.equal(clearEntries.length, 1, 'no duplicate /clear entries')
      assert.equal(clearEntries[0].source, 'builtin', 'builtin /clear shadows the user .md')

      // Order: every built-in appears before every project/user entry.
      const builtinIdx = result.commands.findIndex(c => c.source === 'builtin')
      const projectIdx = result.commands.findIndex(c => c.source === 'project')
      assert.ok(builtinIdx >= 0 && projectIdx >= 0)
      assert.ok(builtinIdx < projectIdx, 'built-ins should be ranked above project skills')

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

  // #7938 — a FIFO planted at the requested path, instead of a regular file,
  // must be refused promptly rather than hanging the read forever. Before
  // O_NONBLOCK was added to openNoFollow (the one helper every ws-file-ops
  // read goes through), `open(path, O_RDONLY)` on a FIFO with no writer
  // connected blocks the calling thread indefinitely.
  it('read_file: does not hang when the target is a FIFO instead of a regular file', { skip: process.platform === 'win32' ? 'no mkfifo on win32' : false }, async () => {
    const fifoPath = join(tempDir, 'evil.fifo')
    execFileSync('mkfifo', [fifoPath])
    const { ws, messages } = await createFileBrowserTestServer()

    const HANG_GUARD_MS = 3000
    const start = Date.now()
    send(ws, { type: 'read_file', path: 'evil.fifo' })
    const content = await Promise.race([
      waitForMessage(messages, 'file_content', HANG_GUARD_MS),
      new Promise((resolve) => setTimeout(() => resolve({ outcome: 'hung' }), HANG_GUARD_MS)),
    ])
    const elapsed = Date.now() - start

    assert.notEqual(content?.outcome, 'hung',
      `read_file blocked for >= ${HANG_GUARD_MS}ms on a planted FIFO — the open needs O_NONBLOCK (#7938)`)
    assert.ok(elapsed < 2500, `read_file must return promptly against a planted FIFO (elapsed=${elapsed}ms)`)
    assert.equal(content.content, null, 'a FIFO must never be read as file content')
    assert.match(content.error || '', /not a regular file/i,
      'a FIFO must be refused via the post-open isFile() check, not a different/incidental error (#7938)')

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
    disableRepoAutoGc(tempDir) // #6075: stop background gc racing the teardown rmSync
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
    rmDirRobust(tempDir)
  })

  async function createDiffTestServer(cwd = tempDir) {
    const mockSession = createMockSession()
    mockSession.cwd = cwd

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

  /**
   * Call getDiff directly, bypassing the WS message pipeline and its
   * ClientMessageSchema validation entirely. #7870 bounds `base` to
   * GET_DIFF_BASE_MAX_LENGTH (256) AT THE WIRE now — an over-length base sent
   * via `send(ws, ...)` is rejected before it ever reaches this handler (see
   * the '#7870' wire-level tests below). The server's OWN MAX_DIFF_BASE_LENGTH
   * gate inside reader.js is independent, second-layer defense-in-depth that
   * stays correct even for a future caller reaching getDiff by a path that
   * skips schema validation — pinned here by calling it directly.
   */
  function directReader() {
    const sent = []
    const send = (_ws, msg) => sent.push(msg)
    const boundResolve = (cwd) => resolveSessionCwd(cwd, new Map(), 60_000)
    const boundValidate = (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000)
    const reader = createReaderOps(send, boundResolve, boundValidate)
    return { reader, sent }
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

  // ── #7290: the `base` revision must never reach git as an OPTION ──────────
  //
  // `base` arrives from the wire unvalidated — GetDiffSchema is
  // `z.object({ type: z.literal('get_diff') }).passthrough()`, so the field is
  // not constrained at all — and lands in the REVISION slot of
  // `git diff <base>`. The old allowlist put `-` INSIDE its character class,
  // so every single-token option passed it.
  //
  // These are NEGATIVE CONTROLS, per docs/false-safety-guards.md: each one
  // observes a git behaviour that is only reachable when the option was
  // actually parsed. Delete the leading-dash rejection and they go red.
  //
  // NOTE `['diff', base, '--']` does NOT fix this and these tests prove it:
  // `--` ends option parsing at ITS position, and `base` precedes it.

  it('#7290: -O<path> does not become a git orderfile read (filesystem oracle)', async () => {
    // `git diff -O<file>` reads <file> as a diff order file. git reports
    // whether it could read it, and getDiff forwards raw git stderr to the
    // client (reader.js `error: err.message`) — so an unguarded `-O` is a
    // file existence/readability oracle over the WHOLE filesystem, as the
    // daemon user, escaping the session cwd entirely.
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')
    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff', base: '-O/chroxy-7290-no-such-orderfile' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    // The oracle's tell. Present iff git parsed `-O` as an option.
    assert.ok(
      !/orderfile/i.test(result.error || ''),
      `git must never see -O as an option; got error: ${result.error}`
    )
    // And it must still behave like an unrecognised base: fall back to HEAD.
    assert.equal(result.error, null)
    assert.equal(result.files.length, 1)

    ws.close()
  })

  it('#7290: --exit-code does not become a git option', async () => {
    // `git diff --exit-code` exits 1 when there are changes, which execFile
    // surfaces as a rejection — so an unguarded `--exit-code` turns a healthy
    // diff into a wire error.
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')
    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff', base: '--exit-code' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null, 'a dash-leading base must not reach git')
    assert.equal(result.files.length, 1)

    ws.close()
  })

  it('#7290: --stat does not become a git option', async () => {
    // `git diff --stat` emits a summary, not a unified diff, so parseDiff
    // yields ZERO files. An unguarded `--stat` silently empties the diff view.
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')
    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff', base: '--stat' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    assert.equal(result.files.length, 1, '--stat must not replace the unified diff')
    assert.ok(result.files[0].hunks.length > 0, 'hunks are lost when --stat is parsed')

    ws.close()
  })

  // POSITIVE CONTROL — the guard must not be vacuous. A legitimate revision
  // still reaches git and still selects a real base. Without this, a guard
  // that rejected EVERYTHING would pass all three tests above.
  it('#7290: a legitimate revision is still honoured (positive control)', async () => {
    // Second commit, so HEAD~1 names a base that differs from HEAD and the
    // choice of base is observable in the output.
    writeFileSync(join(tempDir, 'file.txt'), 'second content\n')
    execFileSync(GIT, ['add', 'file.txt'], { cwd: tempDir, stdio: 'pipe' })
    execFileSync(GIT, ['commit', '-m', 'second'], { cwd: tempDir, stdio: 'pipe' })

    const { ws, messages } = await createDiffTestServer()

    // vs HEAD: the tree is clean, so no files.
    send(ws, { type: 'get_diff', base: 'HEAD' })
    const clean = await waitForMessage(messages, 'diff_result', 5000)
    assert.equal(clean.error, null)
    assert.deepEqual(clean.files, [], 'HEAD must compare against the last commit')

    // vs HEAD~1: the second commit shows up. Proves the base was really used.
    // waitForMessage() scans an ACCUMULATING array with .find(), so it would
    // re-read the reply above. Clear it before the second round-trip.
    messages.length = 0
    send(ws, { type: 'get_diff', base: 'HEAD~1' })
    const prev = await waitForMessage(messages, 'diff_result', 5000)
    assert.equal(prev.error, null)
    assert.equal(prev.files.length, 1, 'HEAD~1 must reach git as a real revision')
    assert.equal(prev.files[0].path, 'file.txt')

    ws.close()
  })

  // ── #7298: the dash-free path oracle ──────────────────────────────────────
  //
  // #7290 closed the LEADING-DASH route (`-O<path>`). This is the route that
  // needs no dash: `:` and `/` were both members of the charset allowlist, so
  // `HEAD:<path>` and a bare absolute path both reached git as revisions, and
  // git's stderr was forwarded verbatim. Measured against git 2.55.0, every
  // one of these passed both halves of the old guard:
  //
  //   base='HEAD:/etc/passwd'  -> fatal: path '/etc/passwd' exists on disk,
  //                              but not in 'HEAD'
  //   base='HEAD:absent.txt'   -> fatal: path 'absent.txt' does not exist in 'HEAD'
  //   base='/etc/passwd'       -> fatal: '/etc/passwd' is outside repository
  //                              at '<cwdReal>'          <- also leaks the cwd
  //
  // The fix has two halves and each of the tests below isolates ONE of them,
  // deliberately — a single test cannot, because the halves overlap on the
  // probes above (drop half 2 and the two `HEAD:<path>` replies still differ
  // from the DEFAULT reply; drop half 1 and they no longer differ from each
  // other, but raw stderr is still forwarded on any other git failure):
  //
  //   half 1  resolve the base with `rev-parse --verify --quiet <base>^{commit}`
  //           and drop `:` from the charset -> an unusable base is silently
  //           equivalent to the default base
  //   half 2  never forward raw git stderr -> a fixed 'Failed to run git diff'

  it('#7298: HEAD:<path> bases are indistinguishable from each other and from the default (half 1)', async () => {
    // A non-empty working tree, so "fell back to HEAD" and "errored out" are
    // observably different replies rather than both being an empty file list.
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')

    const { ws, messages } = await createDiffTestServer()

    // Baseline: no base at all. This is what an unusable base must look like.
    send(ws, { type: 'get_diff' })
    const baseline = await waitForMessage(messages, 'diff_result', 5000)
    assert.equal(baseline.error, null)
    assert.equal(baseline.files.length, 1, 'baseline must be a real, non-empty diff')

    // A path that DOES exist on the daemon's filesystem, outside the cwd.
    messages.length = 0
    send(ws, { type: 'get_diff', base: 'HEAD:/etc/passwd' })
    const present = await waitForMessage(messages, 'diff_result', 5000)

    // A path that does NOT exist.
    messages.length = 0
    send(ws, { type: 'get_diff', base: 'HEAD:/chroxy-7298/definitely/not/here' })
    const absent = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(
      present.error, absent.error,
      'a path that exists and one that does not must produce the SAME error'
    )
    assert.deepEqual(
      present.files, absent.files,
      'a path that exists and one that does not must produce the SAME files'
    )
    // …and both must be the default reply, not an error of any kind. Without
    // this clause the pair is equal under half 2 alone (both error out with
    // the same fixed string) and the oracle is closed only by scrubbing the
    // message, never by refusing to ask git the question.
    assert.equal(present.error, baseline.error, 'an unusable base falls back to HEAD')
    assert.deepEqual(present.files, baseline.files, 'an unusable base falls back to HEAD')

    ws.close()
  })

  it('#7298: an absolute-path base does not leak the daemon cwd', async () => {
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff', base: '/etc/passwd' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    const serialized = JSON.stringify(result)
    assert.ok(
      !serialized.includes(tempDir) && !serialized.includes(realpathSync(tempDir)),
      `the workspace path must never reach the client; got: ${serialized.slice(0, 400)}`
    )
    assert.ok(
      !/outside repository|exists on disk|ambiguous argument/i.test(result.error || ''),
      `raw git stderr must not be forwarded; got error: ${result.error}`
    )

    ws.close()
  })

  it('#7298: raw git stderr is never forwarded to the client (half 2)', async () => {
    // Force `git diff` itself to fail in a way half 1 cannot pre-empt: a diff
    // larger than getDiff's 2MB maxBuffer. execFile rejects with
    // 'stdout maxBuffer length exceeded', which the old `error: err.message`
    // branch handed straight to the client.
    // 1.5MB per side: the diff carries both, so it is ~3MB against a 2MB
    // maxBuffer — over the limit with margin, at half the I/O of the 3MB
    // payload this started with (Copilot review of #7862).
    const SIDE = 1536 * 1024
    writeFileSync(join(tempDir, 'big.txt'), 'x'.repeat(SIDE) + '\n')
    execFileSync(GIT, ['add', 'big.txt'], { cwd: tempDir, stdio: 'pipe' })
    execFileSync(GIT, ['commit', '-m', 'big'], { cwd: tempDir, stdio: 'pipe' })
    writeFileSync(join(tempDir, 'big.txt'), 'y'.repeat(SIDE) + '\n')

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 10000)

    assert.equal(
      result.error, 'Failed to run git diff',
      'the git failure detail must stay server-side'
    )
    assert.deepEqual(result.files, [])

    ws.close()
  })

  it('#7298: a branch name still resolves to its own commit (positive control)', async () => {
    // rev-parse is the new gate; prove it does not reject legitimate bases.
    writeFileSync(join(tempDir, 'file.txt'), 'second content\n')
    execFileSync(GIT, ['add', 'file.txt'], { cwd: tempDir, stdio: 'pipe' })
    execFileSync(GIT, ['commit', '-m', 'second'], { cwd: tempDir, stdio: 'pipe' })
    execFileSync(GIT, ['branch', 'chroxy-7298-base', 'HEAD~1'], { cwd: tempDir, stdio: 'pipe' })

    const { ws, messages } = await createDiffTestServer()

    // The branch points at the FIRST commit, so the second commit shows up.
    send(ws, { type: 'get_diff', base: 'chroxy-7298-base' })
    const branch = await waitForMessage(messages, 'diff_result', 5000)
    assert.equal(branch.error, null)
    assert.equal(branch.files.length, 1, 'a branch name must reach git as a real revision')
    assert.equal(branch.files[0].path, 'file.txt')

    // …and it must differ from HEAD, which is clean. Asserting "no error"
    // alone would pass for a guard that silently rewrote every base to HEAD.
    messages.length = 0
    send(ws, { type: 'get_diff', base: 'HEAD' })
    const head = await waitForMessage(messages, 'diff_result', 5000)
    assert.equal(head.error, null)
    assert.deepEqual(head.files, [], 'HEAD is clean, so the two bases must differ')

    ws.close()
  })

  it('#7298: a base naming a repo path is not handed to git as a pathspec (the RESOLUTION, not the charset)', async () => {
    // The mutation that proved "half 1" reverted TWO independent changes at
    // once — `:` back in the charset AND the rev-parse bypassed — so it could
    // not tell which of them the tests were pinning. Reverting only the
    // rev-parse (charset left narrowed) leaves the rest of this suite GREEN,
    // because every probe above is a `HEAD:<path>` or an absolute path, and
    // the charset alone already diverts those to the HEAD fallback.
    //
    // This is the observable that separates them. A base that passes the
    // charset and names no commit but DOES name a file is read by git as a
    // PATHSPEC, and the reply narrows to that one file (measured, git 2.55.0):
    //
    //     git diff --name-only            -> file.txt, second.txt
    //     git diff --name-only file.txt   -> file.txt      (exit 0)
    //
    // so the reply is observably different from the fallback, and a client
    // can walk the workspace one path at a time. Resolution refuses the
    // question; the charset never sees it.
    writeFileSync(join(tempDir, 'second.txt'), 'second initial\n')
    execFileSync(GIT, ['add', 'second.txt'], { cwd: tempDir, stdio: 'pipe' })
    execFileSync(GIT, ['commit', '-m', 'second file'], { cwd: tempDir, stdio: 'pipe' })
    // Two tracked files modified, so a pathspec-filtered reply is narrower
    // than the fallback one rather than accidentally identical to it.
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')
    writeFileSync(join(tempDir, 'second.txt'), 'second modified\n')

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const baseline = await waitForMessage(messages, 'diff_result', 5000)
    assert.equal(baseline.error, null)
    assert.deepEqual(
      baseline.files.map(f => f.path).sort(), ['file.txt', 'second.txt'],
      'baseline must show BOTH modified files, or the assertion below is vacuous'
    )

    messages.length = 0
    send(ws, { type: 'get_diff', base: 'file.txt' })
    const pathBase = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(pathBase.error, baseline.error)
    assert.deepEqual(
      pathBase.files.map(f => f.path).sort(), ['file.txt', 'second.txt'],
      'a base naming no commit must fall back to HEAD — reaching git, which reads it as a pathspec, narrows the reply and answers whether that path exists'
    )

    ws.close()
  })

  it('#7298: the workspace path stays server-side on EVERY error branch, not just the git-diff one', async () => {
    // Half 2 was applied to the `git diff` catch only. Two other branches of
    // getDiff still forwarded a raw `err.message`, and this one names the
    // workspace with no crafted base at all: the outer catch wraps
    // `resolveSessionCwd`, whose realpath() throws
    // `ENOENT: no such file or directory, realpath '<cwdReal>'` once the
    // session cwd is gone — a removed worktree, an unmounted volume, a
    // rename. A bound (share-a-session) client reaches it with a bare
    // `get_diff`.
    // A cwd of its own, so the removal below cannot race the suite's own
    // tempDir teardown (and never has to delete a .git dir on Windows).
    const goneDir = mkdtempSync(join(tmpdir(), 'chroxy-diff-gone-'))
    const goneReal = realpathSync(goneDir)
    const { ws, messages } = await createDiffTestServer(goneDir)

    rmSync(goneDir, { recursive: true, force: true })

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    const serialized = JSON.stringify(result)
    assert.ok(
      !serialized.includes(goneDir) && !serialized.includes(goneReal),
      `the workspace path must never reach the client; got: ${serialized.slice(0, 400)}`
    )
    assert.equal(result.error, 'Failed to run git diff')
    assert.deepEqual(result.files, [])

    ws.close()
  })

  it('#7298: an oversized base is rejected by length, and only its length is logged', async () => {
    // Copilot review of this PR: `base` was unconstrained on the wire at the
    // time (GetDiffSchema was .passthrough()), so every byte of it was spawned
    // twice — once per `rev-parse` — and could be echoed back into an error
    // message. The oracle is closed either way (an oversized base resolves to
    // no commit and falls back to HEAD), so the observable here is the COST
    // gate, not the reply: the rejection is logged, by length, before git is
    // spawned at all.
    //
    // #7870 moved the length gate one layer EARLIER: GetDiffSchema itself now
    // rejects a base over GET_DIFF_BASE_MAX_LENGTH (256) at the wire (see the
    // '#7870' tests below), so a 5000-char base sent via `send(ws, ...)` would
    // never reach this handler at all. This test now calls getDiff DIRECTLY to
    // keep pinning the server's OWN, independent length gate — defense-in-
    // depth that must hold even for a caller that reaches getDiff by a path
    // that skips schema validation.
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')

    const { reader, sent } = directReader()

    const entries = []
    const listener = (entry) => entries.push(entry)
    addLogListener(listener)

    try {
      await reader.getDiff({}, 'a'.repeat(5000), tempDir)

      // The reply is the ordinary fallback — an oversized base is not an error.
      assert.equal(sent.length, 1)
      const result = sent[0]
      assert.equal(result.type, 'diff_result')
      assert.equal(result.error, null)
      assert.equal(result.files.length, 1)

      const rejection = entries.find(e => /base rejected/.test(e.message || ''))
      assert.ok(rejection, `expected a rejection log line; got: ${entries.map(e => e.message).join(' | ').slice(0, 300)}`)
      assert.ok(
        rejection.message.includes('5000'),
        `the rejection must name the length; got: ${rejection.message}`
      )
      assert.ok(
        !rejection.message.includes('aaaaaaaaaa'),
        'the rejected value must never be logged — only its length'
      )
    } finally {
      removeLogListener(listener)
    }
  })

  it('#7298: an oversized base never reaches a rev-parse argv, even when it names a real commit', async () => {
    // The test above asserts the LOG LINE, and the log line is not the gate.
    // Deleting `rawBase.length <= MAX_DIFF_BASE_LENGTH &&` from the candidate
    // conjunction — the term that actually keeps the oversized value out of
    // the two `rev-parse` argvs — leaves the `log.warn` above it untouched, so
    // the whole suite stays green while the bound is gone: a guard whose
    // observable is not the behaviour it claims (docs/false-safety-guards.md).
    //
    // This is the observable that separates them. `<ref>^0` names the commit
    // <ref> itself and CHAINS, so a real branch padded with `^0` is a revision
    // built only from charset-allowed characters, carrying no leading dash,
    // that git resolves to a real non-HEAD commit at any length (measured,
    // git 2.55.0). Over the bound it must be indistinguishable from the HEAD
    // fallback. Called directly for the same reason as the test above — #7870
    // means a 277-char base like this one no longer reaches getDiff over the
    // wire at all.
    writeFileSync(join(tempDir, 'file.txt'), 'second content\n')
    execFileSync(GIT, ['add', 'file.txt'], { cwd: tempDir, stdio: 'pipe' })
    execFileSync(GIT, ['commit', '-m', 'second'], { cwd: tempDir, stdio: 'pipe' })
    execFileSync(GIT, ['branch', 'chroxy-7298-long', 'HEAD~1'], { cwd: tempDir, stdio: 'pipe' })

    const padded = 'chroxy-7298-long' + '^0'.repeat(130)
    assert.ok(padded.length > 256, `the probe must exceed the bound; got ${padded.length} chars`)

    const { reader, sent } = directReader()

    // Control: the SAME ref, unpadded, does resolve and does reach git — so a
    // red below is the length diverting it, not the ref being unresolvable.
    // Without this the assertion would pass for a branch that never existed.
    await reader.getDiff({}, 'chroxy-7298-long', tempDir)
    const short = sent[0]
    assert.equal(short.error, null)
    assert.deepEqual(
      short.files.map(f => f.path), ['file.txt'],
      'control: the unpadded ref must resolve to its own commit and show the second commit'
    )

    sent.length = 0
    await reader.getDiff({}, padded, tempDir)
    const long = sent[0]

    assert.equal(long.error, null)
    assert.deepEqual(
      long.files.map(f => f.path), [],
      'an oversized base must be the HEAD fallback (clean) — resolving it to HEAD~1 means the value reached a rev-parse argv'
    )
  })

  // ── #7870: the wire-level gate itself ──────────────────────────────────────
  it('#7870: an over-length base is rejected AT THE WIRE, before getDiff ever runs', async () => {
    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff', base: 'a'.repeat(257) })
    const result = await waitForMessage(messages, 'error', 5000)

    assert.equal(result.code, 'INVALID_MESSAGE')
    assert.ok(
      !messages.some(m => m.type === 'diff_result'),
      'the message must never reach getDiff — it never even leaves the schema layer'
    )

    ws.close()
  })

  it('#7870: a base exactly at the wire bound (256 chars) still reaches getDiff normally', async () => {
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')
    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff', base: 'a'.repeat(256) })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    // Not a real ref, so it resolves to nothing and falls back to HEAD — the
    // point here is only that it reaches getDiff at all (no INVALID_MESSAGE).
    assert.equal(result.error, null)
    assert.equal(result.files.length, 1)

    ws.close()
  })

  it('#7870: a non-string base is rejected AT THE WIRE', async () => {
    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff', base: 12345 })
    const result = await waitForMessage(messages, 'error', 5000)

    assert.equal(result.code, 'INVALID_MESSAGE')
    assert.ok(!messages.some(m => m.type === 'diff_result'))

    ws.close()
  })

  it('#7298: a git failure detail is bounded before it reaches the log', () => {
    // The wire gets a fixed string and the detail goes to the log; this keeps
    // the log copy bounded too. An execFile rejection's `message` carries the
    // whole command line plus the child's stderr, and nothing in either is
    // bounded by the caller.
    //
    // Asserted on the helper rather than through a forced git failure ON
    // PURPOSE: every git failure this suite can provoke yields a SHORT message
    // (`stdout maxBuffer length exceeded` and friends), so an integration
    // assertion on the length would pass identically with the truncation
    // deleted — a test that cannot fail. The end-to-end amplification path is
    // covered by the length gate in the test above, which stops an oversized
    // input reaching the argv this message quotes.
    const short = 'git diff failed: stdout maxBuffer length exceeded'
    assert.equal(truncateForLog(short), short, 'a short detail passes through unchanged')

    const long = 'z'.repeat(2000)
    const bounded = truncateForLog(long)
    assert.ok(
      bounded.length < 600,
      `a 2000-char detail must be bounded; got ${bounded.length} chars`
    )
    assert.ok(bounded.includes('2000'), 'the bound must record the original length')
    assert.equal(truncateForLog(undefined), '', 'a missing detail is the empty string, never "undefined"')
  })

  it('#7298: a non-repo cwd is classified without logging an error every request', async () => {
    // "Not a git repository" is the ordinary state of a session whose cwd is
    // not a checkout, and it recurs on EVERY get_diff that session sends. The
    // fixed-string sweep above wired a log.error into that path; logging a
    // routine classification at error level buries the failures worth reading
    // (Copilot review of this PR).
    const plainDir = mkdtempSync(join(tmpdir(), 'chroxy-diff-norepo-'))

    try {
      const { ws, messages } = await createDiffTestServer(plainDir)

      // After start(), which clears every listener.
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        send(ws, { type: 'get_diff' })
        const result = await waitForMessage(messages, 'diff_result', 5000)

        // The client still gets the classification — silence is not the fix.
        assert.equal(result.error, 'Not a git repository')

        const errors = entries.filter(e => e.level === 'error')
        assert.deepEqual(
          errors.map(e => e.message), [],
          'an expected non-repo cwd must not log at error level'
        )

        ws.close()
      } finally {
        removeLogListener(listener)
      }
    } finally {
      rmSync(plainDir, { recursive: true, force: true })
    }
  })

  // ── #7871: createReaderOps' execImpl seam ──────────────────────────────
  //
  // createReaderOps previously called execFileAsync on the module-level GIT
  // binding directly, so getDiff's preflight branch could only be reached by
  // a REAL non-repo/permission-denied/timeout condition on the test host —
  // "cannot check this" silently treated as "nothing to check"
  // (docs/false-safety-guards.md). createGitOps already had this seam
  // (ws-file-ops/git.js's 5th arg); createReaderOps now matches it.

  // Build an injectable exec that routes by (file, args) and records every
  // call, mirroring the router pattern in tests/git-create-pr.test.js.
  function makeSeamReader(route) {
    const calls = []
    const sent = []
    const execImpl = async (file, args, opts) => {
      calls.push({ file, args: [...args], opts })
      return route(file, args, opts)
    }
    const send = (_ws, msg) => sent.push(msg)
    const boundResolve = (cwd) => resolveSessionCwd(cwd, new Map(), 60_000)
    const boundValidate = (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000)
    const reader = createReaderOps(send, boundResolve, boundValidate, execImpl)
    return { reader, sent, calls }
  }

  it('#7871: createReaderOps accepts an execImpl seam, matching createGitOps', () => {
    // Signature/contract check: the 4th arg exists and defaults sanely (no
    // throw when omitted — matches production wiring in ws-file-ops/index.js).
    assert.doesNotThrow(() => createReaderOps(() => {}, async () => tempDir, async () => ({ valid: true })))
  })

  it('#7871: every git invocation inside getDiff routes through the injected exec (all 5 call sites)', async () => {
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')
    // Delegates to the REAL execFileAsync so behaviour matches production —
    // only the routing is observed, not faked.
    const { reader, sent, calls } = makeSeamReader((file, args, opts) => realExecFileAsync(file, args, opts))

    await reader.getDiff({}, undefined, tempDir)

    assert.equal(sent[0].type, 'diff_result')
    assert.equal(sent[0].error, null, 'the seam must not change getDiff behaviour when it just delegates')

    const shapes = calls.map(c => c.args.slice(0, 2).join(' '))
    assert.ok(shapes.includes('rev-parse --git-dir'), 'preflight must route through the seam')
    assert.ok(
      calls.filter(c => c.args[0] === 'rev-parse' && c.args[1] === '--verify').length >= 1,
      'resolveCommit (rev-parse --verify) must route through the seam'
    )
    // A real repo with a commit resolves headOid, so this is `git diff <oid>`
    // (never the bare `['diff']` form, which only fires in an empty repo).
    assert.ok(calls.some(c => c.args[0] === 'diff' && c.args.length === 2 && c.args[1] !== '--cached'), '`git diff <oid>` must route through the seam')
    assert.ok(calls.some(c => c.args[0] === 'diff' && c.args[1] === '--cached'), 'staged `git diff --cached` must route through the seam')
    assert.ok(calls.some(c => c.args[0] === 'ls-files'), 'the untracked-files scan must route through the seam')
  })

  it('#7871: the preflight failure branch is reachable via the seam for a non-128 failure (ENOENT)', async () => {
    // Before this seam, this branch could only be swept "by inspection" —
    // there was no way to make execFileAsync fail with anything but a real
    // host condition. #7862's review noted exactly this (issue body).
    const { reader, sent, calls } = makeSeamReader((file, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
        const err = new Error(`spawn ${GIT} ENOENT`)
        err.code = 'ENOENT'
        throw err
      }
      throw new Error(`unexpected exec in this test: ${args.join(' ')}`)
    })

    await reader.getDiff({}, undefined, tempDir)

    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'diff_result')
    assert.equal(sent[0].error, 'Failed to run git diff')
    assert.deepEqual(sent[0].files, [])
    // #7298 must hold on this branch too: no raw message (which would carry
    // the resolved git binary path) reaches the client.
    assert.ok(!JSON.stringify(sent[0]).includes(GIT), 'the git binary path must never reach the client')
    assert.equal(calls.length, 1, 'must fail fast at the preflight — no further git calls')
  })

  // ── #7877: exit-128 classification ──────────────────────────────────────
  //
  // getDiff's preflight treated EVERY exit-128 as "Not a git repository"
  // (`stderr.includes(...) || code === 128`) and logged nothing for the
  // "|| code === 128" half. `fatal: detected dubious ownership in repository`
  // — common on mounted volumes and container/worktree setups — is also
  // exit 128 but is NOT "not a git repository"; an operator had no trace.

  it('#7877: a non-"not a git repository" exit-128 (dubious ownership) is logged server-side; the client still gets a fixed string', async () => {
    const DUBIOUS = "fatal: detected dubious ownership in repository at '/some/mounted/path'"
    const { reader, sent } = makeSeamReader((file, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
        const err = new Error(DUBIOUS)
        err.code = 128
        err.stderr = DUBIOUS + '\n'
        throw err
      }
      throw new Error(`unexpected exec in this test: ${args.join(' ')}`)
    })

    const entries = []
    const listener = (entry) => entries.push(entry)
    addLogListener(listener)
    try {
      await reader.getDiff({}, undefined, tempDir)
    } finally {
      removeLogListener(listener)
    }

    // Client contract unchanged: still a fixed classification, never raw stderr.
    assert.equal(sent[0].error, 'Not a git repository')
    assert.ok(
      !JSON.stringify(sent[0]).includes('dubious ownership'),
      'raw stderr must never reach the client (#7298 must hold)'
    )

    // #7877: the operator now sees it, and NOT at error level (it's a routine-
    // ish classification, not an unexpected daemon failure).
    const hit = entries.find(e => /dubious ownership/i.test(e.message || ''))
    assert.ok(hit, `expected a log entry mentioning the real cause; got: ${entries.map(e => e.message).join(' | ')}`)
    assert.equal(hit.level, 'warn')
  })

  it('#7877: the genuine not-a-git-repo classification stays quiet (no log at any level)', async () => {
    const NOTREPO = 'fatal: not a git repository (or any of the parent directories): .git'
    const { reader, sent } = makeSeamReader((file, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
        const err = new Error(NOTREPO)
        err.code = 128
        err.stderr = NOTREPO + '\n'
        throw err
      }
      throw new Error(`unexpected exec in this test: ${args.join(' ')}`)
    })

    const entries = []
    const listener = (entry) => entries.push(entry)
    addLogListener(listener)
    try {
      await reader.getDiff({}, undefined, tempDir)
    } finally {
      removeLogListener(listener)
    }

    assert.equal(sent[0].error, 'Not a git repository')
    assert.deepEqual(entries, [], 'the genuine non-repo case must log nothing at all, at any level')
  })

  it('#7877: the preflight forces LC_ALL=C/LANG=C so the classification is locale-independent', async () => {
    let capturedEnv = null
    const { reader, sent } = makeSeamReader((file, args, opts) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
        capturedEnv = opts?.env
        const err = new Error('fatal: not a git repository (or any of the parent directories): .git')
        err.code = 128
        err.stderr = 'fatal: not a git repository (or any of the parent directories): .git\n'
        throw err
      }
      throw new Error(`unexpected exec in this test: ${args.join(' ')}`)
    })

    await reader.getDiff({}, undefined, tempDir)

    assert.equal(sent[0].error, 'Not a git repository')
    assert.ok(capturedEnv, 'the preflight call must pass an env option')
    assert.equal(capturedEnv.LC_ALL, 'C')
    assert.equal(capturedEnv.LANG, 'C')
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
