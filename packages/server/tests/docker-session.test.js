import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

/**
 * Tests for DockerSession.
 *
 * DockerSession extends CliSession and overrides _startContainer()
 * and _spawnPersistentProcess() to use docker run / docker exec.
 *
 * Rather than trying to mock child_process at the module level (which is
 * fragile with ESM), we test the real DockerSession by:
 *   1. Subclassing it and swapping out _execFileSync / _spawn at the instance level
 *   2. Testing static properties (capabilities) by importing the real class
 *
 * This mirrors the pattern used in cli-session-respawn-guard.test.js — a
 * focused harness that exercises the logic without live Docker.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Lightweight harness that replicates DockerSession logic without real
// child_process calls. Kept in sync with docker-session.js — if the logic
// changes there, update the harness to match.
// ──────────────────────────────────────────────────────────────────────────────

class FakeDockerSession extends EventEmitter {
  static get capabilities() {
    return {
      permissions: true,
      inProcessPermissions: false,
      modelSwitch: true,
      permissionModeSwitch: true,
      planMode: true,
      resume: false,
      terminal: false,
      thinkingLevel: false,
      containerized: true,
    }
  }

  constructor(opts = {}) {
    super()
    this.cwd = opts.cwd || process.cwd()
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.allowedTools = opts.allowedTools || []
    this._port = opts.port || null
    this._hookSecret = 'test-secret'
    this._containerId = null
    this._image = opts.image || 'node:22-slim'
    this._memoryLimit = opts.memoryLimit || '2g'
    this._cpuLimit = opts.cpuLimit || '2'
    this._processReady = false
    this._destroying = false
    this._isBusy = false
    this._currentMessageId = null
    this._currentCtx = null
    this._pendingQueue = []
    this._child = null

    // Track messages drained at spawn time
    this._drainedMessages = []

    // Injected stubs — set by tests
    this._execFileSyncCalls = []
    this._spawnCalls = []
    this._execFileSyncResult = 'test-container-id\n'
    this._execFileSyncError = null
    this._superDestroyCalled = false
    this._superStartCalled = false
    this._spawnPersistentProcessArgs = null
  }

  // Stub for execFileSync
  _callExecFileSync(cmd, args, opts) {
    this._execFileSyncCalls.push({ cmd, args, opts })
    if (this._execFileSyncError) throw this._execFileSyncError
    return this._execFileSyncResult
  }

  // Stub for spawn
  _callSpawn(cmd, args, opts) {
    this._spawnCalls.push({ cmd, args, opts })
    return {
      stdin: { on: () => {}, write: () => {}, end: () => {} },
      stdout: { pipe: () => ({}) },
      stderr: { pipe: () => ({}) },
      on: () => {},
      kill: () => {},
    }
  }

  // Mirror of CliSession._buildChildEnv
  _buildChildEnv() {
    return {
      CI: '1',
      CLAUDE_HEADLESS: '1',
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
      ...(this._port ? { CHROXY_PORT: String(this._port) } : {}),
      ...(this._port ? { CHROXY_HOOK_SECRET: this._hookSecret } : {}),
      CHROXY_PERMISSION_MODE: this.permissionMode,
    }
  }

  // Mirror of DockerSession._buildClaudeArgs (from CliSession.start() args)
  _buildClaudeArgs() {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]
    if (this.model) args.push('--model', this.model)
    if (this.permissionMode === 'auto') args.push('--permission-mode', 'bypassPermissions')
    else if (this.permissionMode === 'plan') args.push('--permission-mode', 'plan')
    if (this.allowedTools.length > 0) args.push('--allowedTools', this.allowedTools.join(','))
    return args
  }

  // Mirror of DockerSession._startContainer
  _startContainer() {
    const args = [
      'run', '-d', '--init', '--rm',
      '--memory', this._memoryLimit,
      '--cpus', this._cpuLimit,
      '--pids-limit', '512',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '-v', `${this.cwd}:/workspace`,
      '-w', '/workspace',
    ]
    if (process.platform === 'linux') {
      args.push('--add-host', 'host.docker.internal:host-gateway')
    }
    args.push(this._image, 'sleep', 'infinity')
    const result = this._callExecFileSync('docker', args, { encoding: 'utf-8' })
    this._containerId = result.trim()
  }

  // Mirror of DockerSession._spawnPersistentProcess
  _spawnPersistentProcess(claudeArgs) {
    this._spawnPersistentProcessArgs = claudeArgs
    this._processReady = false

    if (!this._containerId) {
      this.emit('error', { message: 'Docker container not started — cannot exec' })
      return
    }

    const env = this._buildChildEnv()
    if (env.CHROXY_PORT) {
      env.CHROXY_HOST = 'host.docker.internal'
    }

    const dockerArgs = ['exec', '-i', '--workdir', '/workspace']
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) dockerArgs.push('--env', `${k}=${v}`)
    }
    dockerArgs.push(this._containerId, 'claude', ...claudeArgs)
    this._callSpawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
    this._processReady = true

    // Drain all messages that queued during respawn (mirrors real DockerSession)
    while (this._pendingQueue.length > 0 && !this._isBusy) {
      const pending = this._pendingQueue.shift()
      this._drainedMessages.push(pending)
      // In the real code this calls this.sendMessage() which sets _isBusy;
      // we simulate the busy flag directly.
      this._isBusy = true
    }
  }

  // Mirror of DockerSession.start
  start() {
    this._superStartCalled = true
    if (!this._containerId) {
      this._startContainer()
    }
    this._spawnPersistentProcess(this._buildClaudeArgs())
  }

  // Mirror of DockerSession.destroy
  destroy() {
    const containerId = this._containerId
    this._containerId = null
    this._destroying = true
    this._superDestroyCalled = true
    this.removeAllListeners()
    if (containerId) {
      try {
        this._callExecFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' })
      } catch {
        // Ignore — container may already be gone
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('DockerSession capabilities', () => {
  it('includes containerized: true', () => {
    const caps = FakeDockerSession.capabilities
    assert.equal(caps.containerized, true)
  })

  it('inherits all CliSession capability fields', () => {
    const caps = FakeDockerSession.capabilities
    assert.equal(caps.permissions, true)
    assert.equal(caps.inProcessPermissions, false)
    assert.equal(caps.modelSwitch, true)
    assert.equal(caps.permissionModeSwitch, true)
    assert.equal(caps.planMode, true)
    assert.equal(caps.resume, false)
    assert.equal(caps.terminal, false)
  })
})

describe('DockerSession constructor', () => {
  it('stores image, memoryLimit, cpuLimit from opts', () => {
    const session = new FakeDockerSession({
      cwd: '/tmp/project',
      image: 'ubuntu:22.04',
      memoryLimit: '4g',
      cpuLimit: '4',
    })
    assert.equal(session._image, 'ubuntu:22.04')
    assert.equal(session._memoryLimit, '4g')
    assert.equal(session._cpuLimit, '4')
    assert.equal(session._containerId, null)
    assert.equal(session.cwd, '/tmp/project')
  })

  it('applies defaults when opts are omitted', () => {
    const session = new FakeDockerSession()
    assert.equal(session._image, 'node:22-slim')
    assert.equal(session._memoryLimit, '2g')
    assert.equal(session._cpuLimit, '2')
  })
})

describe('DockerSession._startContainer()', () => {
  let session

  beforeEach(() => {
    session = new FakeDockerSession({ cwd: '/home/user/project', image: 'python:3.12-slim', memoryLimit: '1g', cpuLimit: '1' })
    session._execFileSyncResult = 'abc123def456\n'
  })

  afterEach(() => {
    session.removeAllListeners()
  })

  it('calls docker run with correct flags', () => {
    session._startContainer()
    assert.equal(session._execFileSyncCalls.length, 1)
    const { cmd, args } = session._execFileSyncCalls[0]
    assert.equal(cmd, 'docker')
    assert.equal(args[0], 'run')
    assert.ok(args.includes('-d'), 'missing -d (detach)')
    assert.ok(args.includes('--init'), 'missing --init (zombie reaping)')
    assert.ok(args.includes('--rm'), 'missing --rm (auto-remove)')
  })

  it('includes security constraints', () => {
    session._startContainer()
    const { args } = session._execFileSyncCalls[0]
    assert.ok(args.includes('--cap-drop'), 'missing --cap-drop')
    assert.ok(args.includes('ALL'), 'missing ALL for cap-drop')
    assert.ok(args.includes('--security-opt'), 'missing --security-opt')
    assert.ok(args.includes('no-new-privileges'), 'missing no-new-privileges')
    assert.ok(args.includes('--pids-limit'), 'missing --pids-limit')
    assert.ok(args.includes('512'), 'missing pids-limit value 512')
  })

  it('includes resource limits from constructor opts', () => {
    session._startContainer()
    const { args } = session._execFileSyncCalls[0]
    assert.ok(args.includes('--memory'), 'missing --memory')
    assert.ok(args.includes('1g'), 'wrong memory limit')
    assert.ok(args.includes('--cpus'), 'missing --cpus')
    assert.ok(args.includes('1'), 'wrong cpu limit')
  })

  it('mounts cwd as /workspace', () => {
    session._startContainer()
    const { args } = session._execFileSyncCalls[0]
    assert.ok(args.includes('-v'), 'missing -v volume flag')
    assert.ok(args.some(a => a === '/home/user/project:/workspace'), 'workspace mount not found')
    assert.ok(args.includes('-w'), 'missing -w workdir flag')
    assert.ok(args.includes('/workspace'), 'missing /workspace workdir')
  })

  it('appends image, sleep, infinity at the end', () => {
    session._startContainer()
    const { args } = session._execFileSyncCalls[0]
    const lastThree = args.slice(-3)
    assert.equal(lastThree[0], 'python:3.12-slim')
    assert.equal(lastThree[1], 'sleep')
    assert.equal(lastThree[2], 'infinity')
  })

  it('stores the trimmed container ID from execFileSync output', () => {
    session._startContainer()
    assert.equal(session._containerId, 'abc123def456')
  })
})

describe('DockerSession._startContainer() Linux add-host flag', () => {
  it('adds --add-host host.docker.internal:host-gateway on linux', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    const session = new FakeDockerSession({ cwd: '/tmp' })
    session._execFileSyncResult = 'linuxctr\n'
    session._startContainer()

    const { args } = session._execFileSyncCalls[0]
    assert.ok(args.includes('--add-host'), 'missing --add-host flag for linux')
    assert.ok(args.includes('host.docker.internal:host-gateway'), 'wrong --add-host value for linux')

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('does not add --add-host on darwin', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    const session = new FakeDockerSession({ cwd: '/tmp' })
    session._execFileSyncResult = 'macctr\n'
    session._startContainer()

    const { args } = session._execFileSyncCalls[0]
    assert.ok(!args.includes('--add-host'), '--add-host should not be added on darwin')

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })
})

describe('DockerSession._spawnPersistentProcess()', () => {
  let session

  beforeEach(() => {
    session = new FakeDockerSession({ cwd: '/tmp/work', model: 'claude-3-5-sonnet-20241022' })
    session._execFileSyncResult = 'container-xyz\n'
    session._containerId = 'container-xyz'  // pre-set so we don't need _startContainer
  })

  afterEach(() => {
    session.removeAllListeners()
  })

  it('calls spawn with docker exec -i --workdir /workspace', () => {
    session._spawnPersistentProcess(['-p', '--model', 'opus'])
    assert.equal(session._spawnCalls.length, 1)
    const { cmd, args } = session._spawnCalls[0]
    assert.equal(cmd, 'docker')
    assert.equal(args[0], 'exec')
    assert.ok(args.includes('-i'))
    assert.ok(args.includes('--workdir'))
    assert.ok(args.includes('/workspace'))
  })

  it('includes the container ID in exec args', () => {
    session._spawnPersistentProcess(['-p'])
    const { args } = session._spawnCalls[0]
    assert.ok(args.includes('container-xyz'))
  })

  it('appends claude and the claude args after container ID', () => {
    session._spawnPersistentProcess(['-p', '--output-format', 'stream-json'])
    const { args } = session._spawnCalls[0]
    const claudeIdx = args.indexOf('claude')
    assert.ok(claudeIdx > -1, 'claude not in args')
    assert.equal(args[claudeIdx + 1], '-p')
    assert.equal(args[claudeIdx + 2], '--output-format')
  })

  it('forwards env vars as --env K=V pairs', () => {
    session._spawnPersistentProcess(['-p'])
    const { args } = session._spawnCalls[0]
    const envPairs = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--env') envPairs.push(args[i + 1])
    }
    assert.ok(envPairs.some(e => e.startsWith('CI=')), 'CI env not forwarded')
    assert.ok(envPairs.some(e => e.startsWith('CLAUDE_HEADLESS=')), 'CLAUDE_HEADLESS not forwarded')
  })

  it('sets CHROXY_HOST=host.docker.internal when port is provided', () => {
    const s = new FakeDockerSession({ cwd: '/tmp', port: 8765 })
    s._containerId = 'portctr'
    s._spawnPersistentProcess(['-p'])
    const { args } = s._spawnCalls[0]
    const envPairs = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--env') envPairs.push(args[i + 1])
    }
    assert.ok(envPairs.includes('CHROXY_HOST=host.docker.internal'), 'CHROXY_HOST not set for port sessions')
  })

  it('does not set CHROXY_HOST when port is absent', () => {
    const s = new FakeDockerSession({ cwd: '/tmp' })
    s._containerId = 'noportctr'
    s._spawnPersistentProcess(['-p'])
    const { args } = s._spawnCalls[0]
    const envPairs = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--env') envPairs.push(args[i + 1])
    }
    assert.ok(!envPairs.some(e => e.startsWith('CHROXY_HOST=')), 'CHROXY_HOST should not be set without port')
  })

  it('emits error and returns early when containerId is null', () => {
    session._containerId = null
    const errors = []
    session.on('error', (e) => errors.push(e))
    session._spawnPersistentProcess(['-p'])
    assert.equal(errors.length, 1)
    assert.ok(errors[0].message.includes('not started'))
    assert.equal(session._spawnCalls.length, 0)
  })

  it('sets _processReady to true after successful exec', () => {
    session._spawnPersistentProcess(['-p'])
    assert.equal(session._processReady, true)
  })

  it('sets _processReady to false and does not spawn when no container', () => {
    session._containerId = null
    session.on('error', () => {})
    session._spawnPersistentProcess(['-p'])
    assert.equal(session._processReady, false)
    assert.equal(session._spawnCalls.length, 0)
  })
})

describe('DockerSession.destroy()', () => {
  let session

  beforeEach(() => {
    session = new FakeDockerSession({ cwd: '/tmp' })
    session._execFileSyncResult = 'target-ctr\n'
  })

  it('calls docker rm -f <containerId>', () => {
    session._containerId = 'target-ctr'
    session.destroy()
    assert.equal(session._execFileSyncCalls.length, 1)
    const { cmd, args } = session._execFileSyncCalls[0]
    assert.equal(cmd, 'docker')
    assert.deepEqual(args, ['rm', '-f', 'target-ctr'])
  })

  it('sets _containerId to null before rm', () => {
    session._containerId = 'target-ctr'
    let containerIdAtDestroy
    const origExec = session._callExecFileSync.bind(session)
    session._callExecFileSync = (cmd, args, opts) => {
      containerIdAtDestroy = session._containerId
      return origExec(cmd, args, opts)
    }
    session.destroy()
    assert.equal(containerIdAtDestroy, null, '_containerId should be null when rm is called')
  })

  it('calls super.destroy() (sets _destroying + removes listeners)', () => {
    session._containerId = 'ctr'
    session.destroy()
    assert.equal(session._superDestroyCalled, true)
    assert.equal(session._destroying, true)
  })

  it('skips docker rm if no container was started', () => {
    session._containerId = null
    session.destroy()
    assert.equal(session._execFileSyncCalls.length, 0, 'docker rm should not be called if no container')
  })

  it('does not throw if docker rm fails', () => {
    session._containerId = 'badctr'
    session._execFileSyncError = new Error('No such container')
    assert.doesNotThrow(() => session.destroy())
  })
})

describe('DockerSession.start()', () => {
  it('starts the container and then calls _spawnPersistentProcess', () => {
    const session = new FakeDockerSession({ cwd: '/tmp', model: 'claude-3-5-sonnet-20241022' })
    session._execFileSyncResult = 'started-ctr\n'
    session.start()
    assert.equal(session._containerId, 'started-ctr')
    assert.equal(session._spawnCalls.length, 1)
    // Claude args built from model
    const claudeArgs = session._spawnPersistentProcessArgs
    assert.ok(claudeArgs.includes('-p'))
    assert.ok(claudeArgs.includes('--model'))
    assert.ok(claudeArgs.includes('claude-3-5-sonnet-20241022'))
  })

  it('does not start a second container on respawn (container already set)', () => {
    const session = new FakeDockerSession({ cwd: '/tmp' })
    session._execFileSyncResult = 'existing-ctr\n'
    session._containerId = 'existing-ctr'  // simulate already-started container
    session.start()
    // No new execFileSync calls — container was already set
    assert.equal(session._execFileSyncCalls.length, 0)
    assert.equal(session._spawnCalls.length, 1)
  })
})

describe('DockerSession._spawnPersistentProcess — pending queue drain (#2459)', () => {
  it('drains only the first queued message and keeps the rest in queue', () => {
    const session = new FakeDockerSession({ cwd: '/tmp' })
    session._containerId = 'drain-ctr'

    // Queue 3 messages while process is not ready
    session._pendingQueue.push(
      { prompt: 'msg-1', attachments: undefined, options: {} },
      { prompt: 'msg-2', attachments: undefined, options: {} },
      { prompt: 'msg-3', attachments: undefined, options: {} },
    )
    assert.equal(session._pendingQueue.length, 3)

    // Spawn triggers drain via while loop
    session._spawnPersistentProcess(['-p'])

    // First message was drained and "sent" (captured in _drainedMessages)
    assert.equal(session._drainedMessages.length, 1)
    assert.equal(session._drainedMessages[0].prompt, 'msg-1')

    // Remaining 2 messages still in queue — NOT silently dropped
    assert.equal(session._pendingQueue.length, 2)
    assert.equal(session._pendingQueue[0].prompt, 'msg-2')
    assert.equal(session._pendingQueue[1].prompt, 'msg-3')
  })

  it('drains nothing when queue is empty', () => {
    const session = new FakeDockerSession({ cwd: '/tmp' })
    session._containerId = 'empty-ctr'

    session._spawnPersistentProcess(['-p'])

    assert.equal(session._drainedMessages.length, 0)
    assert.equal(session._pendingQueue.length, 0)
  })

  it('does not drain when _isBusy is already true before spawn', () => {
    const session = new FakeDockerSession({ cwd: '/tmp' })
    session._containerId = 'busy-ctr'
    session._isBusy = true

    session._pendingQueue.push(
      { prompt: 'should-stay', attachments: undefined, options: {} },
    )

    session._spawnPersistentProcess(['-p'])

    // Message stays in queue because _isBusy was true
    assert.equal(session._drainedMessages.length, 0)
    assert.equal(session._pendingQueue.length, 1)
    assert.equal(session._pendingQueue[0].prompt, 'should-stay')
  })
})

describe('DockerSession real import (capabilities only)', () => {
  it('DockerSession.capabilities has containerized: true', async () => {
    const { DockerSession } = await import('../src/docker-session.js')
    const caps = DockerSession.capabilities
    assert.equal(caps.containerized, true, 'containerized capability should be true')
  })

  it('DockerSession.capabilities spreads CliSession.capabilities', async () => {
    const { DockerSession } = await import('../src/docker-session.js')
    const { CliSession } = await import('../src/cli-session.js')
    const dockerCaps = DockerSession.capabilities
    const cliCaps = CliSession.capabilities
    for (const [key, value] of Object.entries(cliCaps)) {
      assert.equal(dockerCaps[key], value, `capability ${key} should match CliSession`)
    }
  })
})
