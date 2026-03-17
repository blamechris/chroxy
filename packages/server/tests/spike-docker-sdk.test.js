import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import { PassThrough } from 'stream'
import { EventEmitter } from 'events'

/**
 * Unit tests for the spawnClaudeCodeProcess interface.
 *
 * These tests validate that:
 * 1. A docker-exec-style spawner produces objects matching SpawnedProcess
 * 2. SpawnOptions are correctly translated to docker exec args
 * 3. The SpawnedProcess interface contract is satisfied by ChildProcess
 * 4. Env vars are forwarded selectively, not leaked wholesale
 *
 * No Docker required — uses mocks and interface checks.
 */

// ─── Mock SpawnedProcess ────────────────────────────────────────────────────

/**
 * Creates a mock SpawnedProcess that satisfies the SDK interface.
 * This validates the interface shape without needing Docker.
 */
function createMockSpawnedProcess() {
  const emitter = new EventEmitter()
  let _killed = false
  let _exitCode = null

  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    get killed() { return _killed },
    get exitCode() { return _exitCode },
    kill(signal) {
      _killed = true
      emitter.emit('exit', null, signal)
      return true
    },
    on(event, listener) { emitter.on(event, listener) },
    once(event, listener) { emitter.once(event, listener) },
    off(event, listener) { emitter.off(event, listener) },
    // Test helpers
    _emitExit(code, signal) {
      _exitCode = code
      emitter.emit('exit', code, signal)
    },
    _emitError(err) {
      emitter.emit('error', err)
    },
  }
}

// ─── Docker Exec Args Builder ───────────────────────────────────────────────

/**
 * Pure function that builds docker exec args from SpawnOptions.
 * Extracted from the spike script for testability.
 */
function buildDockerExecArgs(containerId, options, forwardKeys = []) {
  const { command, args, cwd, env } = options
  const dockerArgs = ['exec', '-i']

  if (cwd) {
    dockerArgs.push('--workdir', cwd)
  }

  for (const key of forwardKeys) {
    const val = env[key]
    if (val !== undefined) {
      dockerArgs.push('--env', `${key}=${val}`)
    }
  }

  dockerArgs.push(containerId, command, ...args)
  return dockerArgs
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SpawnedProcess interface', () => {
  it('mock satisfies all required properties', () => {
    const proc = createMockSpawnedProcess()

    // Required streams
    assert.ok(proc.stdin, 'stdin must exist')
    assert.ok(proc.stdout, 'stdout must exist')
    assert.equal(typeof proc.stdin.write, 'function', 'stdin must be writable')
    assert.equal(typeof proc.stdout.on, 'function', 'stdout must be readable')

    // Required state
    assert.equal(proc.killed, false, 'killed should start false')
    assert.equal(proc.exitCode, null, 'exitCode should start null')

    // Required methods
    assert.equal(typeof proc.kill, 'function', 'kill must be a function')
    assert.equal(typeof proc.on, 'function', 'on must be a function')
    assert.equal(typeof proc.once, 'function', 'once must be a function')
    assert.equal(typeof proc.off, 'function', 'off must be a function')
  })

  it('kill() sets killed to true and emits exit', () => {
    const proc = createMockSpawnedProcess()
    let exitFired = false
    let exitSignal = null

    proc.on('exit', (code, signal) => {
      exitFired = true
      exitSignal = signal
    })

    const result = proc.kill('SIGTERM')

    assert.equal(result, true, 'kill should return true')
    assert.equal(proc.killed, true, 'killed should be true after kill')
    assert.equal(exitFired, true, 'exit event should fire')
    assert.equal(exitSignal, 'SIGTERM', 'signal should be SIGTERM')
  })

  it('exit event provides code and signal', () => {
    const proc = createMockSpawnedProcess()
    let receivedCode = undefined
    let receivedSignal = undefined

    proc.on('exit', (code, signal) => {
      receivedCode = code
      receivedSignal = signal
    })

    proc._emitExit(0, null)

    assert.equal(receivedCode, 0, 'exit code should be 0')
    assert.equal(receivedSignal, null, 'signal should be null on clean exit')
  })

  it('error event provides Error object', () => {
    const proc = createMockSpawnedProcess()
    let receivedError = null

    proc.on('error', (err) => {
      receivedError = err
    })

    const testError = new Error('spawn failed')
    proc._emitError(testError)

    assert.equal(receivedError, testError, 'error should be forwarded')
  })

  it('once() fires only once', () => {
    const proc = createMockSpawnedProcess()
    let callCount = 0

    proc.once('exit', () => { callCount++ })

    proc._emitExit(0, null)
    proc._emitExit(1, null)

    assert.equal(callCount, 1, 'once listener should fire only once')
  })

  it('off() removes listener', () => {
    const proc = createMockSpawnedProcess()
    let callCount = 0

    const listener = () => { callCount++ }
    proc.on('exit', listener)
    proc.off('exit', listener)

    proc._emitExit(0, null)

    assert.equal(callCount, 0, 'removed listener should not fire')
  })
})

describe('Node ChildProcess satisfies SpawnedProcess', () => {
  it('spawn() return value has all required properties', () => {
    // Spawn a no-op process to check interface conformance
    const child = spawn('echo', ['test'], { stdio: ['pipe', 'pipe', 'pipe'] })

    // Required streams
    assert.ok(child.stdin, 'stdin must exist')
    assert.ok(child.stdout, 'stdout must exist')
    assert.equal(typeof child.stdin.write, 'function', 'stdin must be writable')
    assert.equal(typeof child.stdout.on, 'function', 'stdout must be readable')

    // Required state
    assert.equal(typeof child.killed, 'boolean', 'killed must be boolean')
    assert.ok(child.exitCode === null || typeof child.exitCode === 'number', 'exitCode must be null or number')

    // Required methods
    assert.equal(typeof child.kill, 'function', 'kill must be a function')
    assert.equal(typeof child.on, 'function', 'on must be a function')
    assert.equal(typeof child.once, 'function', 'once must be a function')
    assert.equal(typeof child.off, 'function', 'off must be a function')

    child.kill('SIGTERM')
  })
})

describe('buildDockerExecArgs', () => {
  const CONTAINER_ID = 'abc123def456'

  it('builds basic exec command', () => {
    const args = buildDockerExecArgs(CONTAINER_ID, {
      command: 'node',
      args: ['--version'],
      env: {},
    })

    assert.deepEqual(args, [
      'exec', '-i',
      CONTAINER_ID, 'node', '--version',
    ])
  })

  it('includes --workdir when cwd is set', () => {
    const args = buildDockerExecArgs(CONTAINER_ID, {
      command: 'claude',
      args: ['-p'],
      cwd: '/workspace',
      env: {},
    })

    assert.deepEqual(args, [
      'exec', '-i',
      '--workdir', '/workspace',
      CONTAINER_ID, 'claude', '-p',
    ])
  })

  it('forwards only specified env keys', () => {
    const args = buildDockerExecArgs(CONTAINER_ID, {
      command: 'claude',
      args: [],
      env: {
        ANTHROPIC_API_KEY: 'sk-test',
        HOME: '/root',
        SECRET_SAUCE: 'do-not-leak',
        PATH: '/usr/bin',
      },
    }, ['ANTHROPIC_API_KEY', 'HOME'])

    assert.deepEqual(args, [
      'exec', '-i',
      '--env', 'ANTHROPIC_API_KEY=sk-test',
      '--env', 'HOME=/root',
      CONTAINER_ID, 'claude',
    ])

    // Verify SECRET_SAUCE was NOT forwarded
    const envArgs = args.filter((a, i) => args[i - 1] === '--env')
    assert.ok(
      !envArgs.some(a => a.includes('SECRET_SAUCE')),
      'SECRET_SAUCE must not be forwarded'
    )
  })

  it('skips undefined env values', () => {
    const args = buildDockerExecArgs(CONTAINER_ID, {
      command: 'claude',
      args: [],
      env: {
        ANTHROPIC_API_KEY: 'sk-test',
        MISSING_KEY: undefined,
      },
    }, ['ANTHROPIC_API_KEY', 'MISSING_KEY'])

    const envArgs = args.filter((a, i) => args[i - 1] === '--env')
    assert.equal(envArgs.length, 1, 'should only have one --env flag')
    assert.equal(envArgs[0], 'ANTHROPIC_API_KEY=sk-test')
  })

  it('passes through all command args', () => {
    const args = buildDockerExecArgs(CONTAINER_ID, {
      command: 'claude',
      args: ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json'],
      env: {},
    })

    const claudeIdx = args.indexOf('claude')
    const claudeArgs = args.slice(claudeIdx + 1)
    assert.deepEqual(claudeArgs, ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json'])
  })
})

describe('SpawnOptions interface', () => {
  it('has the expected shape', () => {
    // Validate the shape that the SDK will pass to spawnClaudeCodeProcess
    const mockOptions = {
      command: 'node',
      args: ['/path/to/cli.js', '-p'],
      cwd: '/workspace',
      env: { ANTHROPIC_API_KEY: 'sk-test', PATH: '/usr/bin' },
      signal: AbortSignal.timeout(5000),
    }

    assert.equal(typeof mockOptions.command, 'string')
    assert.ok(Array.isArray(mockOptions.args))
    assert.equal(typeof mockOptions.cwd, 'string')
    assert.equal(typeof mockOptions.env, 'object')
    assert.ok(mockOptions.signal instanceof AbortSignal)
  })
})

describe('abort signal integration', () => {
  it('signal abort kills the process', () => {
    const proc = createMockSpawnedProcess()
    const controller = new AbortController()

    // Wire abort -> kill (same pattern as spike script)
    controller.signal.addEventListener('abort', () => {
      if (!proc.killed) {
        proc.kill('SIGTERM')
      }
    }, { once: true })

    assert.equal(proc.killed, false, 'should not be killed initially')

    controller.abort()

    assert.equal(proc.killed, true, 'should be killed after abort')
  })
})
