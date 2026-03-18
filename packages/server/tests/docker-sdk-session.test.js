import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

/**
 * Tests for DockerSdkSession.
 *
 * DockerSdkSession extends SdkSession and overrides:
 *   - start() to launch a Docker container, create a non-root user, install Claude Code
 *   - _augmentQueryOptions() to inject spawnClaudeCodeProcess
 *   - destroy() to clean up the container
 *
 * Tests use a FakeDockerSdkSession harness that mirrors the real class logic
 * with stubbed child_process calls — no Docker required.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Constants (mirrored from docker-sdk-session.js)
// ──────────────────────────────────────────────────────────────────────────────

const FORWARDED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'NODE_ENV',
]

const DEFAULT_CONTAINER_CLI_PATH = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'

// ──────────────────────────────────────────────────────────────────────────────
// Lightweight harness that replicates DockerSdkSession logic without real
// child_process calls.
// ──────────────────────────────────────────────────────────────────────────────

class FakeDockerSdkSession extends EventEmitter {
  static get capabilities() {
    return {
      permissions: true,
      inProcessPermissions: true,
      modelSwitch: true,
      permissionModeSwitch: true,
      planMode: false,
      resume: true,
      terminal: false,
      thinkingLevel: true,
      containerized: true,
    }
  }

  constructor(opts = {}) {
    super()
    this.cwd = opts.cwd || process.cwd()
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this._containerId = null
    this._image = opts.image || 'node:22-slim'
    this._memoryLimit = opts.memoryLimit || '2g'
    this._cpuLimit = opts.cpuLimit || '2'
    this._containerUser = opts.containerUser || 'chroxy'
    this._containerCliPath = null
    this._processReady = false
    this._destroying = false
    this._isBusy = false

    // Track calls for assertions
    this._execFileCalls = []
    this._spawnCalls = []
    this._superStartCalled = false
    this._superDestroyCalled = false
    this._augmentedOptions = null

    // Configurable stubs
    this._execFileResults = {} // keyed by first docker subcommand
    this._execFileErrors = {} // keyed by first docker subcommand
  }

  /**
   * Stub for execFile — records calls, returns configured results.
   * Identifies calls by the first docker subcommand (run, exec, rm).
   */
  _callExecFile(cmd, args, opts, callback) {
    const subcommand = args[0]
    this._execFileCalls.push({ cmd, args: [...args], opts })

    const err = this._execFileErrors[subcommand]
    if (err) {
      callback(err, '', err.message)
      return
    }

    const result = this._execFileResults[subcommand] || ''
    callback(null, result, '')
  }

  /**
   * Stub for spawn — records calls, returns a fake ChildProcess.
   */
  _callSpawn(cmd, args, opts) {
    this._spawnCalls.push({ cmd, args: [...args], opts })
    const fakeChild = new EventEmitter()
    fakeChild.stdin = { on: () => {}, write: () => {}, end: () => {} }
    fakeChild.stdout = new EventEmitter()
    fakeChild.stderr = new EventEmitter()
    fakeChild.killed = false
    fakeChild.exitCode = null
    fakeChild.kill = () => { fakeChild.killed = true }
    // Attach the data listener that the real code uses for stderr
    fakeChild.stderr.on('data', () => {})
    return fakeChild
  }

  // Mirror of DockerSdkSession._startContainer
  _startContainer(callback) {
    const runArgs = [
      'run', '-d', '--init', '--rm',
      '--memory', this._memoryLimit,
      '--cpus', this._cpuLimit,
      '--pids-limit', '512',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '-v', `${this.cwd || process.cwd()}:/workspace`,
      '-w', '/workspace',
    ]

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (apiKey) {
      runArgs.push('--env', `ANTHROPIC_API_KEY=${apiKey}`)
    }

    if (process.platform === 'linux') {
      runArgs.push('--add-host', 'host.docker.internal:host-gateway')
    }

    runArgs.push(this._image, 'sleep', 'infinity')

    this._callExecFile('docker', runArgs, { encoding: 'utf-8', timeout: 120_000 }, (err, stdout) => {
      if (err) {
        callback(new Error(err.message))
        return
      }
      this._containerId = stdout.trim()
      this._setupContainer(callback)
    })
  }

  // Mirror of DockerSdkSession._setupContainer
  _setupContainer(callback) {
    const user = this._containerUser
    const setupCmd = [
      `useradd -m -s /bin/bash ${user}`,
      `chown ${user}:${user} /workspace`,
    ].join(' && ')

    this._callExecFile('docker', [
      'exec', this._containerId,
      'bash', '-c', setupCmd,
    ], { encoding: 'utf-8', timeout: 10_000 }, (err) => {
      if (err) {
        callback(new Error(`Failed to create container user: ${err.message}`))
        return
      }
      this._installClaudeCode(callback)
    })
  }

  // Mirror of DockerSdkSession._installClaudeCode
  _installClaudeCode(callback) {
    // First call: npm install
    this._callExecFile('docker', [
      'exec', this._containerId,
      'npm', 'install', '-g', '@anthropic-ai/claude-code',
    ], { encoding: 'utf-8', timeout: 120_000 }, (installErr) => {
      if (installErr) {
        callback(new Error(`Failed to install Claude Code in container: ${installErr.message}`))
        return
      }

      // Second call: npm prefix -g
      this._callExecFile('docker', [
        'exec', this._containerId,
        'npm', 'prefix', '-g',
      ], { encoding: 'utf-8', timeout: 10_000 }, (prefixErr, prefixOut) => {
        if (!prefixErr && prefixOut) {
          this._containerCliPath = `${prefixOut.trim()}/lib/node_modules/@anthropic-ai/claude-code/cli.js`
        } else {
          this._containerCliPath = DEFAULT_CONTAINER_CLI_PATH
        }
        callback(null)
      })
    })
  }

  // Mirror of DockerSdkSession.start
  start() {
    if (this._containerId) {
      this._superStartCalled = true
      this._processReady = true
      return
    }

    this._startContainer((err) => {
      if (err) {
        this.emit('error', { message: `Failed to start Docker container: ${err.message}` })
        this.destroy()
        return
      }
      this._superStartCalled = true
      this._processReady = true
    })
  }

  // Mirror of DockerSdkSession._augmentQueryOptions
  _augmentQueryOptions(options) {
    if (!this._containerId) return
    options.spawnClaudeCodeProcess = this._createSpawnCallback()
    this._augmentedOptions = options
  }

  // Mirror of DockerSdkSession._createSpawnCallback
  _createSpawnCallback() {
    const containerId = this._containerId
    const containerCliPath = this._containerCliPath || DEFAULT_CONTAINER_CLI_PATH
    const containerUser = this._containerUser

    return (options) => {
      const { command, args, cwd, env, signal } = options

      const dockerArgs = ['exec', '-i', '-u', containerUser]

      if (cwd) {
        dockerArgs.push('--workdir', cwd)
      }

      for (const key of FORWARDED_ENV_KEYS) {
        const val = env?.[key]
        if (val !== undefined) {
          dockerArgs.push('--env', `${key}=${val}`)
        }
      }

      dockerArgs.push('--env', `HOME=/home/${containerUser}`)
      dockerArgs.push('--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')

      const containerCommand = command
      const containerArgs = [...args]

      if (containerArgs.length > 0 && containerArgs[0].includes('@anthropic-ai/claude-code/cli.js')) {
        containerArgs[0] = containerCliPath
      }

      dockerArgs.push(containerId, containerCommand, ...containerArgs)

      const child = this._callSpawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Wire up abort signal (mirrors real implementation)
      if (signal) {
        signal.addEventListener('abort', () => {
          if (!child.killed) {
            child.kill()
          }
        }, { once: true })
      }

      return child
    }
  }

  // Mirror of DockerSdkSession.destroy
  destroy() {
    const containerId = this._containerId
    this._containerId = null
    this._destroying = true
    this._superDestroyCalled = true
    this._processReady = false
    this.removeAllListeners()

    if (containerId) {
      this._callExecFile('docker', ['rm', '-f', containerId], { stdio: 'ignore' }, () => {})
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('DockerSdkSession capabilities', () => {
  it('includes containerized: true', () => {
    const caps = FakeDockerSdkSession.capabilities
    assert.equal(caps.containerized, true)
  })

  it('inherits all SdkSession capability fields', () => {
    const caps = FakeDockerSdkSession.capabilities
    assert.equal(caps.permissions, true)
    assert.equal(caps.inProcessPermissions, true)
    assert.equal(caps.modelSwitch, true)
    assert.equal(caps.permissionModeSwitch, true)
    assert.equal(caps.planMode, false)
    assert.equal(caps.resume, true)
    assert.equal(caps.terminal, false)
    assert.equal(caps.thinkingLevel, true)
  })
})

describe('DockerSdkSession constructor', () => {
  it('stores image, memoryLimit, cpuLimit, containerUser from opts', () => {
    const session = new FakeDockerSdkSession({
      cwd: '/tmp/project',
      image: 'ubuntu:22.04',
      memoryLimit: '4g',
      cpuLimit: '4',
      containerUser: 'testuser',
    })
    assert.equal(session._image, 'ubuntu:22.04')
    assert.equal(session._memoryLimit, '4g')
    assert.equal(session._cpuLimit, '4')
    assert.equal(session._containerUser, 'testuser')
    assert.equal(session._containerId, null)
    assert.equal(session._containerCliPath, null)
    assert.equal(session.cwd, '/tmp/project')
  })

  it('applies defaults when opts are omitted', () => {
    const session = new FakeDockerSdkSession()
    assert.equal(session._image, 'node:22-slim')
    assert.equal(session._memoryLimit, '2g')
    assert.equal(session._cpuLimit, '2')
    assert.equal(session._containerUser, 'chroxy')
  })
})

describe('DockerSdkSession._startContainer()', () => {
  let session

  beforeEach(() => {
    session = new FakeDockerSdkSession({
      cwd: '/home/user/project',
      image: 'python:3.12-slim',
      memoryLimit: '1g',
      cpuLimit: '1',
    })
    // Configure stubs: run returns container ID, exec calls succeed,
    // npm prefix returns a path
    session._execFileResults = {
      run: 'abc123def456\n',
      exec: '/usr/local\n',
    }
  })

  afterEach(() => {
    session.removeAllListeners()
  })

  it('calls docker run with correct flags', (_, done) => {
    session._startContainer((err) => {
      assert.ifError(err)
      // First call should be docker run
      const runCall = session._execFileCalls[0]
      assert.equal(runCall.cmd, 'docker')
      assert.equal(runCall.args[0], 'run')
      assert.ok(runCall.args.includes('-d'), 'missing -d (detach)')
      assert.ok(runCall.args.includes('--init'), 'missing --init (zombie reaping)')
      assert.ok(runCall.args.includes('--rm'), 'missing --rm (auto-remove)')
      done()
    })
  })

  it('includes security constraints', (_, done) => {
    session._startContainer((err) => {
      assert.ifError(err)
      const { args } = session._execFileCalls[0]
      assert.ok(args.includes('--cap-drop'), 'missing --cap-drop')
      assert.ok(args.includes('ALL'), 'missing ALL for cap-drop')
      assert.ok(args.includes('--security-opt'), 'missing --security-opt')
      assert.ok(args.includes('no-new-privileges'), 'missing no-new-privileges')
      assert.ok(args.includes('--pids-limit'), 'missing --pids-limit')
      assert.ok(args.includes('512'), 'missing pids-limit value 512')
      done()
    })
  })

  it('includes resource limits from constructor opts', (_, done) => {
    session._startContainer((err) => {
      assert.ifError(err)
      const { args } = session._execFileCalls[0]
      assert.ok(args.includes('--memory'), 'missing --memory')
      assert.ok(args.includes('1g'), 'wrong memory limit')
      assert.ok(args.includes('--cpus'), 'missing --cpus')
      assert.ok(args.includes('1'), 'wrong cpu limit')
      done()
    })
  })

  it('mounts cwd as /workspace', (_, done) => {
    session._startContainer((err) => {
      assert.ifError(err)
      const { args } = session._execFileCalls[0]
      assert.ok(args.includes('-v'), 'missing -v volume flag')
      assert.ok(args.some(a => a === '/home/user/project:/workspace'), 'workspace mount not found')
      assert.ok(args.includes('-w'), 'missing -w workdir flag')
      assert.ok(args.includes('/workspace'), 'missing /workspace workdir')
      done()
    })
  })

  it('appends image, sleep, infinity at the end', (_, done) => {
    session._startContainer((err) => {
      assert.ifError(err)
      const { args } = session._execFileCalls[0]
      const lastThree = args.slice(-3)
      assert.equal(lastThree[0], 'python:3.12-slim')
      assert.equal(lastThree[1], 'sleep')
      assert.equal(lastThree[2], 'infinity')
      done()
    })
  })

  it('stores the trimmed container ID', (_, done) => {
    session._startContainer((err) => {
      assert.ifError(err)
      assert.equal(session._containerId, 'abc123def456')
      done()
    })
  })

  it('creates a non-root user in the container', (_, done) => {
    session._startContainer((err) => {
      assert.ifError(err)
      // Second call should be docker exec for user setup
      const setupCall = session._execFileCalls[1]
      assert.equal(setupCall.cmd, 'docker')
      assert.equal(setupCall.args[0], 'exec')
      const bashCmd = setupCall.args[setupCall.args.length - 1]
      assert.ok(bashCmd.includes('useradd'), 'missing useradd command')
      assert.ok(bashCmd.includes('chroxy'), 'missing chroxy user name')
      assert.ok(bashCmd.includes('chown'), 'missing chown command')
      done()
    })
  })

  it('installs Claude Code CLI in the container', (_, done) => {
    session._startContainer((err) => {
      assert.ifError(err)
      // Third call should be npm install
      const installCall = session._execFileCalls[2]
      assert.equal(installCall.cmd, 'docker')
      assert.ok(installCall.args.includes('npm'))
      assert.ok(installCall.args.includes('install'))
      assert.ok(installCall.args.includes('@anthropic-ai/claude-code'))
      done()
    })
  })

  it('discovers the container CLI path via npm prefix', (_, done) => {
    session._startContainer((err) => {
      assert.ifError(err)
      assert.equal(
        session._containerCliPath,
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
      )
      done()
    })
  })

  it('falls back to DEFAULT_CONTAINER_CLI_PATH on npm prefix error', (_, done) => {
    // Make the npm prefix call fail by making all exec calls fail after the first two
    let callCount = 0
    const origExecFile = session._callExecFile.bind(session)
    session._callExecFile = (cmd, args, opts, cb) => {
      callCount++
      // Call 4 is the npm prefix call — make it fail
      if (callCount === 4) {
        cb(new Error('prefix failed'), '', '')
        return
      }
      origExecFile(cmd, args, opts, cb)
    }

    session._startContainer((err) => {
      assert.ifError(err)
      assert.equal(session._containerCliPath, DEFAULT_CONTAINER_CLI_PATH)
      done()
    })
  })
})

describe('DockerSdkSession._startContainer() Linux add-host flag', () => {
  it('adds --add-host host.docker.internal:host-gateway on linux', (_, done) => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    const session = new FakeDockerSdkSession({ cwd: '/tmp' })
    session._execFileResults = { run: 'linuxctr\n', exec: '/usr/local\n' }

    session._startContainer((err) => {
      try {
        assert.ifError(err)
        const { args } = session._execFileCalls[0]
        assert.ok(args.includes('--add-host'), 'missing --add-host flag for linux')
        assert.ok(args.includes('host.docker.internal:host-gateway'), 'wrong --add-host value')
        done()
      } catch (e) {
        done(e)
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      }
    })
  })

  it('does not add --add-host on darwin', (_, done) => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    const session = new FakeDockerSdkSession({ cwd: '/tmp' })
    session._execFileResults = { run: 'darwinctr\n', exec: '/usr/local\n' }

    session._startContainer((err) => {
      try {
        assert.ifError(err)
        const { args } = session._execFileCalls[0]
        assert.ok(!args.includes('--add-host'), '--add-host should not be added on darwin')
        done()
      } catch (e) {
        done(e)
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      }
    })
  })
})

describe('DockerSdkSession._startContainer() error handling', () => {
  it('calls back with error when docker run fails', (_, done) => {
    const session = new FakeDockerSdkSession({ cwd: '/tmp' })
    session._execFileErrors = { run: new Error('Docker daemon not running') }

    session._startContainer((err) => {
      assert.ok(err)
      assert.ok(err.message.includes('Docker daemon not running'))
      assert.equal(session._containerId, null)
      done()
    })
  })

  it('calls back with error when user setup fails', (_, done) => {
    const session = new FakeDockerSdkSession({ cwd: '/tmp' })
    session._execFileResults = { run: 'failctr\n' }
    session._execFileErrors = { exec: new Error('useradd: command not found') }

    session._startContainer((err) => {
      assert.ok(err)
      assert.ok(err.message.includes('Failed to create container user'))
      done()
    })
  })
})

describe('DockerSdkSession._augmentQueryOptions()', () => {
  let session

  beforeEach(() => {
    session = new FakeDockerSdkSession({ cwd: '/tmp/work' })
    session._containerId = 'test-container-id'
    session._containerCliPath = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
  })

  afterEach(() => {
    session.removeAllListeners()
  })

  it('injects spawnClaudeCodeProcess into options when container exists', () => {
    const options = { cwd: '/tmp', permissionMode: 'default' }
    session._augmentQueryOptions(options)
    assert.equal(typeof options.spawnClaudeCodeProcess, 'function')
  })

  it('does not inject spawnClaudeCodeProcess when no container', () => {
    session._containerId = null
    const options = { cwd: '/tmp', permissionMode: 'default' }
    session._augmentQueryOptions(options)
    assert.equal(options.spawnClaudeCodeProcess, undefined)
  })
})

describe('DockerSdkSession spawnClaudeCodeProcess callback', () => {
  let session
  let spawnCallback

  beforeEach(() => {
    session = new FakeDockerSdkSession({ cwd: '/tmp/work' })
    session._containerId = 'test-ctr-123'
    session._containerCliPath = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
    spawnCallback = session._createSpawnCallback()
  })

  afterEach(() => {
    session.removeAllListeners()
  })

  it('calls spawn with docker exec -i -u <user>', () => {
    spawnCallback({
      command: 'node',
      args: ['/host/path/to/node_modules/@anthropic-ai/claude-code/cli.js', '--output-format', 'stream-json'],
      cwd: '/workspace',
      env: { ANTHROPIC_API_KEY: 'sk-test' },
    })

    assert.equal(session._spawnCalls.length, 1)
    const { cmd, args } = session._spawnCalls[0]
    assert.equal(cmd, 'docker')
    assert.equal(args[0], 'exec')
    assert.ok(args.includes('-i'))
    assert.ok(args.includes('-u'))
    assert.ok(args.includes('chroxy'))
  })

  it('sets --workdir when cwd is provided', () => {
    spawnCallback({
      command: 'node',
      args: ['/host/path/cli.js'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    const wdIdx = args.indexOf('--workdir')
    assert.ok(wdIdx > -1)
    assert.equal(args[wdIdx + 1], '/workspace')
  })

  it('forwards only allowlisted env vars', () => {
    spawnCallback({
      command: 'node',
      args: ['/host/path/cli.js'],
      cwd: '/workspace',
      env: {
        ANTHROPIC_API_KEY: 'sk-test-key',
        NODE_ENV: 'production',
        SECRET_TOKEN: 'should-not-forward',
        HOME: '/Users/host-user',
        PATH: '/usr/local/bin',
      },
    })

    const { args } = session._spawnCalls[0]
    const envPairs = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--env') envPairs.push(args[i + 1])
    }

    assert.ok(envPairs.some(e => e === 'ANTHROPIC_API_KEY=sk-test-key'), 'ANTHROPIC_API_KEY should be forwarded')
    assert.ok(envPairs.some(e => e === 'NODE_ENV=production'), 'NODE_ENV should be forwarded')
    assert.ok(!envPairs.some(e => e.startsWith('SECRET_TOKEN=')), 'SECRET_TOKEN should NOT be forwarded')
    // HOST HOME and PATH are overridden, not forwarded
    assert.ok(!envPairs.some(e => e === 'HOME=/Users/host-user'), 'host HOME should NOT be forwarded')
    assert.ok(!envPairs.some(e => e === 'PATH=/usr/local/bin'), 'host PATH should NOT be forwarded')
  })

  it('overrides HOME for the container user', () => {
    spawnCallback({
      command: 'node',
      args: ['/host/path/cli.js'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    const envPairs = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--env') envPairs.push(args[i + 1])
    }

    assert.ok(envPairs.includes('HOME=/home/chroxy'), 'HOME should be /home/chroxy')
  })

  it('overrides PATH for the container', () => {
    spawnCallback({
      command: 'node',
      args: ['/host/path/cli.js'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    const envPairs = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--env') envPairs.push(args[i + 1])
    }

    assert.ok(
      envPairs.includes('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),
      'PATH should be overridden for container'
    )
  })

  it('remaps host CLI path to container CLI path', () => {
    spawnCallback({
      command: 'node',
      args: ['/Users/host/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/cli.js', '--output-format', 'stream-json'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    // Find the container ID in args, then the command and remapped arg
    const ctrIdx = args.indexOf('test-ctr-123')
    assert.ok(ctrIdx > -1, 'container ID should be in args')
    // After container ID: command, then args
    assert.equal(args[ctrIdx + 1], 'node')
    assert.equal(args[ctrIdx + 2], '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')
    assert.equal(args[ctrIdx + 3], '--output-format')
    assert.equal(args[ctrIdx + 4], 'stream-json')
  })

  it('does NOT remap args that do not match the SDK cli.js path', () => {
    spawnCallback({
      command: 'node',
      args: ['/some/other/script.js', '--flag'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    const ctrIdx = args.indexOf('test-ctr-123')
    assert.equal(args[ctrIdx + 2], '/some/other/script.js', 'non-SDK args should not be remapped')
  })

  it('does NOT false-positive remap a project path containing "claude"', () => {
    spawnCallback({
      command: 'node',
      args: ['/workspace/claude-utils/index.js', '--flag'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    const ctrIdx = args.indexOf('test-ctr-123')
    assert.equal(args[ctrIdx + 2], '/workspace/claude-utils/index.js', 'project path with "claude" should not be remapped')
  })

  it('includes container ID in docker exec args', () => {
    spawnCallback({
      command: 'node',
      args: ['/host/@anthropic-ai/claude-code/cli.js'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    assert.ok(args.includes('test-ctr-123'))
  })

  it('uses custom containerUser', () => {
    const customSession = new FakeDockerSdkSession({
      cwd: '/tmp',
      containerUser: 'custom-user',
    })
    customSession._containerId = 'custom-ctr'
    customSession._containerCliPath = DEFAULT_CONTAINER_CLI_PATH

    const cb = customSession._createSpawnCallback()
    cb({
      command: 'node',
      args: ['/host/cli.js'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = customSession._spawnCalls[0]
    const uIdx = args.indexOf('-u')
    assert.equal(args[uIdx + 1], 'custom-user')

    const envPairs = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--env') envPairs.push(args[i + 1])
    }
    assert.ok(envPairs.includes('HOME=/home/custom-user'))
  })

  it('wires up abort signal to kill the child process', () => {
    const ac = new AbortController()
    const child = spawnCallback({
      command: 'node',
      args: ['/host/cli.js'],
      cwd: '/workspace',
      env: {},
      signal: ac.signal,
    })

    assert.equal(child.killed, false)
    ac.abort()
    assert.equal(child.killed, true)
  })

  it('returns a ChildProcess-compatible object', () => {
    const child = spawnCallback({
      command: 'node',
      args: ['/host/cli.js'],
      cwd: '/workspace',
      env: {},
    })

    // SpawnedProcess interface requirements
    assert.ok(child.stdin, 'should have stdin')
    assert.ok(child.stdout, 'should have stdout')
    assert.ok(typeof child.kill === 'function', 'should have kill()')
    assert.equal(typeof child.killed, 'boolean', 'should have killed property')
  })
})

describe('DockerSdkSession.start()', () => {
  it('starts container, sets up user, installs CLI, then calls super.start()', () => {
    const session = new FakeDockerSdkSession({ cwd: '/tmp/myproject' })
    session._execFileResults = { run: 'started-ctr\n', exec: '/usr/local\n' }

    session.start()

    assert.equal(session._containerId, 'started-ctr')
    assert.ok(session._superStartCalled)
    assert.ok(session._processReady)
    // Should have called: docker run, docker exec (setup), docker exec (npm install), docker exec (npm prefix)
    assert.ok(session._execFileCalls.length >= 3)
  })

  it('does not start a second container if already set', () => {
    const session = new FakeDockerSdkSession({ cwd: '/tmp' })
    session._containerId = 'existing-ctr'

    session.start()

    assert.equal(session._execFileCalls.length, 0, 'should not call docker run when container exists')
    assert.ok(session._superStartCalled)
  })

  it('emits error and destroys if container start fails', () => {
    const session = new FakeDockerSdkSession({ cwd: '/tmp' })
    session._execFileErrors = { run: new Error('no space left on device') }

    const errors = []
    session.on('error', (e) => errors.push(e))
    session.start()

    assert.equal(errors.length, 1)
    assert.ok(errors[0].message.includes('Failed to start Docker container'))
    assert.ok(session._superDestroyCalled, 'should self-destruct on failure')
  })
})

describe('DockerSdkSession.destroy()', () => {
  let session

  beforeEach(() => {
    session = new FakeDockerSdkSession({ cwd: '/tmp' })
  })

  it('calls docker rm -f <containerId>', () => {
    session._containerId = 'target-ctr'
    session.destroy()

    const rmCall = session._execFileCalls.find(
      c => c.args[0] === 'rm' && c.args[1] === '-f'
    )
    assert.ok(rmCall, 'should call docker rm -f')
    assert.equal(rmCall.args[2], 'target-ctr')
  })

  it('sets _containerId to null before rm', () => {
    session._containerId = 'target-ctr'
    let containerIdAtRm
    const origExecFile = session._callExecFile.bind(session)
    session._callExecFile = (cmd, args, opts, cb) => {
      if (args[0] === 'rm') {
        containerIdAtRm = session._containerId
      }
      origExecFile(cmd, args, opts, cb)
    }
    session.destroy()
    assert.equal(containerIdAtRm, null, '_containerId should be null when rm is called')
  })

  it('calls super.destroy()', () => {
    session._containerId = 'ctr'
    session.destroy()
    assert.ok(session._superDestroyCalled)
    assert.ok(session._destroying)
  })

  it('skips docker rm if no container was started', () => {
    session._containerId = null
    session.destroy()
    assert.equal(session._execFileCalls.length, 0, 'should not call docker rm without container')
  })
})

describe('DockerSdkSession env var allowlist', () => {
  it('FORWARDED_ENV_KEYS contains only safe vars', () => {
    assert.ok(FORWARDED_ENV_KEYS.includes('ANTHROPIC_API_KEY'))
    assert.ok(FORWARDED_ENV_KEYS.includes('NODE_ENV'))
    // Should NOT include dangerous vars
    assert.ok(!FORWARDED_ENV_KEYS.includes('HOME'))
    assert.ok(!FORWARDED_ENV_KEYS.includes('PATH'))
    assert.ok(!FORWARDED_ENV_KEYS.includes('SSH_AUTH_SOCK'))
    assert.ok(!FORWARDED_ENV_KEYS.includes('AWS_SECRET_ACCESS_KEY'))
  })

  it('forwards exactly the allowlisted vars and no others', () => {
    const session = new FakeDockerSdkSession({ cwd: '/tmp' })
    session._containerId = 'env-ctr'
    session._containerCliPath = DEFAULT_CONTAINER_CLI_PATH

    const cb = session._createSpawnCallback()
    cb({
      command: 'node',
      args: ['/host/cli.js'],
      cwd: '/workspace',
      env: {
        ANTHROPIC_API_KEY: 'key1',
        NODE_ENV: 'test',
        GITHUB_TOKEN: 'should-not-forward',
        AWS_ACCESS_KEY_ID: 'should-not-forward',
      },
    })

    const { args } = session._spawnCalls[0]
    const envPairs = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--env') envPairs.push(args[i + 1])
    }

    // Exactly: ANTHROPIC_API_KEY, NODE_ENV, HOME (override), PATH (override)
    const forwardedKeys = envPairs.map(e => e.split('=')[0])
    assert.ok(!forwardedKeys.includes('GITHUB_TOKEN'))
    assert.ok(!forwardedKeys.includes('AWS_ACCESS_KEY_ID'))
    assert.ok(forwardedKeys.includes('ANTHROPIC_API_KEY'))
    assert.ok(forwardedKeys.includes('NODE_ENV'))
    assert.ok(forwardedKeys.includes('HOME'))
    assert.ok(forwardedKeys.includes('PATH'))
  })
})

describe('DockerSdkSession path remapping', () => {
  let session, spawnCallback

  beforeEach(() => {
    session = new FakeDockerSdkSession({ cwd: '/tmp' })
    session._containerId = 'remap-ctr'
    session._containerCliPath = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
    spawnCallback = session._createSpawnCallback()
  })

  it('remaps args[0] when it contains @anthropic-ai/claude-code/cli.js', () => {
    spawnCallback({
      command: 'node',
      args: ['/host/nvm/node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-code/cli.js', '--flag'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    const ctrIdx = args.indexOf('remap-ctr')
    assert.equal(args[ctrIdx + 2], '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')
  })

  it('preserves remaining args after remapping', () => {
    spawnCallback({
      command: 'node',
      args: ['/host/node_modules/@anthropic-ai/claude-code/cli.js', '--output-format', 'stream-json', '--verbose'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    const ctrIdx = args.indexOf('remap-ctr')
    assert.equal(args[ctrIdx + 3], '--output-format')
    assert.equal(args[ctrIdx + 4], 'stream-json')
    assert.equal(args[ctrIdx + 5], '--verbose')
  })

  it('uses DEFAULT_CONTAINER_CLI_PATH when _containerCliPath is null', () => {
    session._containerCliPath = null
    const cb = session._createSpawnCallback()

    cb({
      command: 'node',
      args: ['/host/node_modules/@anthropic-ai/claude-code/cli.js'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    const ctrIdx = args.indexOf('remap-ctr')
    assert.equal(args[ctrIdx + 2], DEFAULT_CONTAINER_CLI_PATH)
  })

  it('does NOT remap a project path containing "claude" (false-positive guard)', () => {
    spawnCallback({
      command: 'node',
      args: ['/workspace/claude-utils/index.js', '--run'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    const ctrIdx = args.indexOf('remap-ctr')
    assert.equal(args[ctrIdx + 2], '/workspace/claude-utils/index.js')
  })

  it('does NOT remap /home/user/claude-docs/script.js', () => {
    spawnCallback({
      command: 'node',
      args: ['/home/user/claude-docs/script.js', '--flag'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    const ctrIdx = args.indexOf('remap-ctr')
    assert.equal(args[ctrIdx + 2], '/home/user/claude-docs/script.js')
  })

  it('remaps direct @anthropic-ai/claude-code/cli.js install path', () => {
    spawnCallback({
      command: 'node',
      args: ['/home/user/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/cli.js', '--output-format', 'stream-json'],
      cwd: '/workspace',
      env: {},
    })

    const { args } = session._spawnCalls[0]
    const ctrIdx = args.indexOf('remap-ctr')
    assert.equal(args[ctrIdx + 2], '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', 'host nvm path should be remapped to container CLI path')
  })
})

describe('DockerSdkSession real import (capabilities only)', () => {
  it('DockerSdkSession.capabilities has containerized: true', async () => {
    const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
    const caps = DockerSdkSession.capabilities
    assert.equal(caps.containerized, true, 'containerized capability should be true')
  })

  it('DockerSdkSession.capabilities spreads SdkSession capabilities', async () => {
    const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
    const { SdkSession } = await import('../src/sdk-session.js')
    const dockerCaps = DockerSdkSession.capabilities
    const sdkCaps = SdkSession.capabilities
    for (const [key, value] of Object.entries(sdkCaps)) {
      assert.equal(dockerCaps[key], value, `capability ${key} should match SdkSession`)
    }
    assert.equal(dockerCaps.containerized, true, 'should also have containerized')
  })

  it('exports FORWARDED_ENV_KEYS and DEFAULT_CONTAINER_CLI_PATH', async () => {
    const mod = await import('../src/docker-sdk-session.js')
    assert.ok(Array.isArray(mod.FORWARDED_ENV_KEYS))
    assert.equal(typeof mod.DEFAULT_CONTAINER_CLI_PATH, 'string')
  })
})

describe('DockerSdkSession._augmentQueryOptions hook in SdkSession', () => {
  it('SdkSession has the _augmentQueryOptions hook method', async () => {
    const { SdkSession } = await import('../src/sdk-session.js')
    const session = Object.create(SdkSession.prototype)
    assert.equal(typeof session._augmentQueryOptions, 'function')
    // Should be a no-op (doesn't throw, doesn't modify)
    const opts = { cwd: '/tmp' }
    session._augmentQueryOptions(opts)
    assert.deepEqual(opts, { cwd: '/tmp' })
  })
})
