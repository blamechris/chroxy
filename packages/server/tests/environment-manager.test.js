import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir, homedir } from 'os'
import { fileURLToPath } from 'url'

import { EnvironmentManager, UNREACHABLE_STATUSES } from '../src/environment-manager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Creates a mock execFile that records calls and returns configured results.
 * Keyed by docker subcommand: 'run', 'exec', 'rm', 'inspect'.
 */
function createMockExecFile({ results = {}, errors = {} } = {}) {
  const calls = []

  function mockExecFile(cmd, args, opts, callback) {
    // execFile signature: (cmd, args, opts, cb) or (cmd, args, cb)
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    const subcommand = args[0]
    calls.push({ cmd, args: [...args], opts })

    const err = errors[subcommand]
    if (err) {
      callback(err, '', err.message)
      return
    }

    const result = results[subcommand] ?? ''
    callback(null, result, '')
  }

  mockExecFile.calls = calls
  return mockExecFile
}

describe('EnvironmentManager.create()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates an environment with a Docker container', async () => {
    const mockExec = createMockExecFile({
      results: {
        run: 'abc123container\n',
        exec: '/usr/local\n',
      },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })

    const env = await manager.create({
      name: 'test-env',
      cwd: '/home/user/project',
    })

    assert.ok(env.id.startsWith('env-'))
    assert.equal(env.name, 'test-env')
    assert.equal(env.cwd, '/home/user/project')
    assert.equal(env.containerId, 'abc123container')
    assert.equal(env.status, 'running')
    assert.equal(env.image, 'node:22-slim')
    assert.equal(env.containerUser, 'chroxy')
    assert.ok(env.containerCliPath.includes('cli.js'))
    assert.ok(env.createdAt)
    assert.deepEqual(env.sessions, [])

    // Should have called: docker run, docker exec (setup), docker exec (install), docker exec (prefix)
    const runCalls = mockExec.calls.filter(c => c.args[0] === 'run')
    assert.equal(runCalls.length, 1)
  })

  it('applies custom image, memory, cpu options', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'ctr456\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })

    const env = await manager.create({
      name: 'custom-env',
      cwd: '/tmp',
      image: 'ubuntu:22.04',
      memoryLimit: '4g',
      cpuLimit: '4',
    })

    assert.equal(env.image, 'ubuntu:22.04')
    assert.equal(env.memoryLimit, '4g')
    assert.equal(env.cpuLimit, '4')

    // Verify docker run args
    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    assert.ok(runCall.args.includes('--memory'))
    assert.ok(runCall.args.includes('4g'))
    assert.ok(runCall.args.includes('ubuntu:22.04'))
  })

  it('persists the environment to disk', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'persist-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({ name: 'persist-test', cwd: '/tmp' })

    assert.ok(existsSync(statePath))
    const data = JSON.parse(readFileSync(statePath, 'utf-8'))
    assert.equal(data.version, 1)
    assert.equal(data.environments.length, 1)
    assert.equal(data.environments[0].name, 'persist-test')
  })

  it('emits environment_created event', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'event-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })

    const events = []
    manager.on('environment_created', (e) => events.push(e))

    await manager.create({ name: 'event-test', cwd: '/tmp' })

    assert.equal(events.length, 1)
    assert.equal(events[0].name, 'event-test')
  })

  it('throws when name is missing', async () => {
    const manager = new EnvironmentManager({ statePath, _execFile: createMockExecFile() })
    await assert.rejects(() => manager.create({ cwd: '/tmp' }), /name is required/)
  })

  it('throws when cwd is missing', async () => {
    const manager = new EnvironmentManager({ statePath, _execFile: createMockExecFile() })
    await assert.rejects(() => manager.create({ name: 'test' }), /cwd is required/)
  })

  it('throws for invalid containerUser', async () => {
    const manager = new EnvironmentManager({ statePath, _execFile: createMockExecFile() })
    await assert.rejects(
      () => manager.create({ name: 'test', cwd: '/tmp', containerUser: 'BAD USER' }),
      /Invalid containerUser/
    )
  })

  it('rejects when docker run fails', async () => {
    const mockExec = createMockExecFile({
      errors: { run: new Error('Docker daemon not running') },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await assert.rejects(
      () => manager.create({ name: 'fail', cwd: '/tmp' }),
      /Docker daemon not running/
    )
  })

  it('cleans up container when setup fails after start', async () => {
    // docker run succeeds, but exec (setup) fails
    let callCount = 0
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      callCount++
      if (args[0] === 'run') {
        cb(null, 'orphan-ctr\n', '')
        return
      }
      if (args[0] === 'exec') {
        cb(new Error('useradd: command not found'), '', '')
        return
      }
      if (args[0] === 'rm') {
        cb(null, '', '')
        return
      }
      cb(null, '', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await assert.rejects(
      () => manager.create({ name: 'orphan-test', cwd: '/tmp' }),
      /useradd/
    )
    // Environment should NOT be in the registry
    assert.equal(manager.list().length, 0)
  })

  it('includes security constraints in docker run', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'sec-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({ name: 'sec-test', cwd: '/tmp' })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    assert.ok(runCall.args.includes('--cap-drop'))
    assert.ok(runCall.args.includes('ALL'))
    assert.ok(runCall.args.includes('--security-opt'))
    assert.ok(runCall.args.includes('no-new-privileges'))
    assert.ok(runCall.args.includes('--pids-limit'))
    assert.ok(runCall.args.includes('512'))
  })

  it('sets --name chroxy-env-{envId} on docker run', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'named-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'name-test', cwd: '/tmp' })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const nameIdx = runCall.args.indexOf('--name')
    assert.ok(nameIdx >= 0, 'should include --name flag')
    assert.equal(runCall.args[nameIdx + 1], `chroxy-env-${env.id}`)
  })

  it('does NOT use --rm flag (persistent containers)', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'persist-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({ name: 'persist', cwd: '/tmp' })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    assert.ok(!runCall.args.includes('--rm'), 'persistent containers should NOT use --rm')
  })
})

/**
 * #4548 — EnvironmentManager.create() must forward opts.workspacePVC through to
 * the backend's createEnvironment() so callers of the high-level manager API can
 * reach K8sBackend's PVC workspace strategy (added in #4547 for #3385) without
 * bypassing the manager.
 *
 * The manager itself does not validate the shape of workspacePVC — that lives in
 * K8sBackend.validateWorkspacePVC(). The manager is a pure passthrough: it must
 * not strip, mutate, or default the option. Other backends (e.g. DockerBackend)
 * simply ignore the field.
 */
describe('EnvironmentManager.create() — workspacePVC passthrough (#4548)', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * Build a stub backend that records every opts payload it receives. The
   * minimal Backend surface we touch in create() is createEnvironment — we don't
   * need to implement the rest of the interface for these tests.
   */
  function createRecordingBackend() {
    const calls = []
    return {
      calls,
      async createEnvironment(opts) {
        calls.push(opts)
        return {
          containerId: 'stub-container-id',
          containerCliPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        }
      },
    }
  }

  it('forwards opts.workspacePVC verbatim to the backend', async () => {
    const backend = createRecordingBackend()
    const manager = new EnvironmentManager({ statePath, backend })

    const workspacePVC = { claimName: 'shared-workspace-pvc', mountPath: '/work', readOnly: true }

    // NOTE: cwd: '/tmp' and workspacePVC are passed together here only because
    // the recording stub does no validation — the manager's only requirement is
    // that cwd is a non-empty string. A real K8sBackend would reject this
    // combination via validateWorkspacePVC() (mutual-exclusion). The manager
    // itself has no opinion on coexistence; enforcement lives in the backend.
    await manager.create({
      name: 'pvc-env',
      cwd: '/tmp',
      workspacePVC,
    })

    assert.equal(backend.calls.length, 1, 'backend.createEnvironment must be invoked exactly once')
    assert.deepEqual(
      backend.calls[0].workspacePVC,
      workspacePVC,
      'workspacePVC must be forwarded verbatim — manager is a pure passthrough'
    )
  })

  it('omits workspacePVC from the backend call when the caller does not pass it', async () => {
    const backend = createRecordingBackend()
    const manager = new EnvironmentManager({ statePath, backend })

    await manager.create({ name: 'no-pvc-env', cwd: '/tmp' })

    assert.equal(backend.calls.length, 1)
    assert.equal(
      backend.calls[0].workspacePVC,
      undefined,
      'workspacePVC must be undefined when the caller does not pass it (no synthetic defaults)'
    )
  })
})

describe('EnvironmentManager.destroy()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes the container and deletes the environment', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'destroy-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'to-destroy', cwd: '/tmp' })

    await manager.destroy(env.id)

    assert.equal(manager.get(env.id), null)
    const rmCalls = mockExec.calls.filter(c => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1)
    assert.ok(rmCalls[0].args.includes('destroy-ctr'))
  })

  it('emits environment_destroyed event', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'ev-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'event-destroy', cwd: '/tmp' })

    const events = []
    manager.on('environment_destroyed', (e) => events.push(e))

    await manager.destroy(env.id)

    assert.equal(events.length, 1)
    assert.equal(events[0].id, env.id)
  })

  it('throws for unknown environment ID', async () => {
    const manager = new EnvironmentManager({ statePath, _execFile: createMockExecFile() })
    await assert.rejects(() => manager.destroy('env-nonexistent'), /not found/)
  })

  it('persists deletion to disk', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'del-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'del-persist', cwd: '/tmp' })

    await manager.destroy(env.id)

    const data = JSON.parse(readFileSync(statePath, 'utf-8'))
    assert.equal(data.environments.length, 0)
  })
})

describe('EnvironmentManager.list() and .get()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lists all environments', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'list-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({ name: 'env-a', cwd: '/tmp' })
    await manager.create({ name: 'env-b', cwd: '/tmp' })

    const list = manager.list()
    assert.equal(list.length, 2)
    assert.ok(list.some(e => e.name === 'env-a'))
    assert.ok(list.some(e => e.name === 'env-b'))
  })

  it('get returns null for unknown ID', () => {
    const manager = new EnvironmentManager({ statePath, _execFile: createMockExecFile() })
    assert.equal(manager.get('env-nonexistent'), null)
  })
})

describe('EnvironmentManager.getContainerInfo()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns container details for running environment', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'info-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'info-test', cwd: '/tmp' })

    const info = manager.getContainerInfo(env.id)
    assert.equal(info.containerId, 'info-ctr')
    assert.equal(info.containerUser, 'chroxy')
    assert.ok(info.containerCliPath.includes('cli.js'))
  })

  it('throws for non-running environment', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'stopped-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'stopped', cwd: '/tmp' })

    // Manually set to stopped
    env.status = 'stopped'

    assert.throws(() => manager.getContainerInfo(env.id), /not running/)
  })

  it('throws for unknown environment', () => {
    const manager = new EnvironmentManager({ statePath, _execFile: createMockExecFile() })
    assert.throws(() => manager.getContainerInfo('env-nope'), /not found/)
  })
})

describe('EnvironmentManager session tracking', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('tracks sessions connecting and disconnecting', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'session-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'sessions', cwd: '/tmp' })

    manager.addSession(env.id, 'session-1')
    manager.addSession(env.id, 'session-2')
    assert.deepEqual(manager.get(env.id).sessions, ['session-1', 'session-2'])

    manager.removeSession(env.id, 'session-1')
    assert.deepEqual(manager.get(env.id).sessions, ['session-2'])
  })

  it('does not duplicate session IDs', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'dup-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'dup', cwd: '/tmp' })

    manager.addSession(env.id, 'session-1')
    manager.addSession(env.id, 'session-1')
    assert.deepEqual(manager.get(env.id).sessions, ['session-1'])
  })

  it('ignores add/remove for unknown environment', () => {
    const manager = new EnvironmentManager({ statePath, _execFile: createMockExecFile() })
    // Should not throw
    manager.addSession('env-nope', 'session-1')
    manager.removeSession('env-nope', 'session-1')
  })
})

describe('EnvironmentManager.reconnect()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('restores environments from disk and inspects containers', async () => {
    // Seed a state file
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-reconnect',
        name: 'reconnect-test',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: 'reconnect-ctr',
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        status: 'running',
        sessions: ['stale-session'],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
      }],
    }
    const { writeFileSync } = await import('fs')
    writeFileSync(statePath, JSON.stringify(seedData))

    const mockExec = createMockExecFile({
      results: { inspect: 'true\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.reconnect()

    const env = manager.get('env-reconnect')
    assert.ok(env)
    assert.equal(env.status, 'running')
    assert.deepEqual(env.sessions, [], 'stale sessions should be cleared')
  })

  it('marks stopped containers', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-stopped',
        name: 'stopped-env',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: 'stopped-ctr',
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
      }],
    }
    const { writeFileSync } = await import('fs')
    writeFileSync(statePath, JSON.stringify(seedData))

    const mockExec = createMockExecFile({
      results: { inspect: 'false\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.reconnect()

    assert.equal(manager.get('env-stopped').status, 'stopped')
  })

  it('marks error for containers that no longer exist', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-gone',
        name: 'gone-env',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: 'gone-ctr',
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
      }],
    }
    const { writeFileSync } = await import('fs')
    writeFileSync(statePath, JSON.stringify(seedData))

    const mockExec = createMockExecFile({
      errors: { inspect: new Error('No such container') },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.reconnect()

    assert.equal(manager.get('env-gone').status, 'error')
  })

  it('emits environments_reconnected event', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-event',
        name: 'event-env',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: 'event-ctr',
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
      }],
    }
    const { writeFileSync } = await import('fs')
    writeFileSync(statePath, JSON.stringify(seedData))

    const mockExec = createMockExecFile({
      results: { inspect: 'true\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })

    const events = []
    manager.on('environments_reconnected', (e) => events.push(e))

    await manager.reconnect()

    assert.equal(events.length, 1)
    assert.equal(events[0].length, 1)
  })

  it('handles empty/missing state file gracefully', async () => {
    const manager = new EnvironmentManager({ statePath, _execFile: createMockExecFile() })
    await manager.reconnect() // Should not throw
    assert.equal(manager.list().length, 0)
  })

  it('handles corrupt state file gracefully', async () => {
    const { writeFileSync } = await import('fs')
    writeFileSync(statePath, 'not valid json')

    const manager = new EnvironmentManager({ statePath, _execFile: createMockExecFile() })
    await manager.reconnect() // Should not throw
    assert.equal(manager.list().length, 0)
  })

  it('marks environment unreachable when reconnectAgentToken returns false', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-cred-gone',
        name: 'cred-gone-env',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: 'pod-cred-gone',
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
      }],
    }
    writeFileSync(statePath, JSON.stringify(seedData))

    // Mock backend: getEnvironmentStatus says "running" but reconnectAgentToken
    // returns false (credential source GC'd).
    const tokenCalls = []
    const backend = {
      async getEnvironmentStatus() { return true },
      async reconnectAgentToken(handle) {
        tokenCalls.push(handle)
        return false
      },
    }

    // Capture warn output so we can assert the operator-visible signal fires.
    const capturedWarn = []
    const originalWarn = console.warn
    console.warn = (...args) => capturedWarn.push(args.join(' '))

    let manager, result
    try {
      manager = new EnvironmentManager({ statePath, backend })
      result = await manager.reconnect()
    } finally {
      console.warn = originalWarn
    }

    assert.equal(result, false, 'reconnect() should return false when a credential is gone')
    assert.equal(manager.get('env-cred-gone').status, 'error', 'env should be marked error/unreachable')
    assert.deepEqual(tokenCalls, ['pod-cred-gone'], 'reconnectAgentToken should have been called with the handle')
    const warnHit = capturedWarn.find(line =>
      line.includes('cred-gone-env') &&
      line.includes('env-cred-gone') &&
      line.includes('credential source is gone'))
    assert.ok(warnHit,
      `expected a warn log mentioning env name, env id, and "credential source is gone"; got: ${JSON.stringify(capturedWarn)}`)
  })

  it('returns true and leaves status running when reconnectAgentToken returns true', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-cred-ok',
        name: 'cred-ok-env',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: 'pod-cred-ok',
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
      }],
    }
    writeFileSync(statePath, JSON.stringify(seedData))

    const backend = {
      async getEnvironmentStatus() { return true },
      async reconnectAgentToken() { return true },
    }

    const manager = new EnvironmentManager({ statePath, backend })
    const result = await manager.reconnect()

    assert.equal(result, true, 'reconnect() should return true when all credentials refresh')
    assert.equal(manager.get('env-cred-ok').status, 'running')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // allHealthy semantics for transient failures (#3478)
  //
  // Per the reconnect() contract, ANY environment that did not reconnect
  // successfully must flip the return value to false. This includes transient
  // errors (throws) — not just the documented "credential source gone" signal.
  // ──────────────────────────────────────────────────────────────────────────

  it('returns false when reconnectAgentToken throws (#3478)', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-token-throw',
        name: 'token-throw-env',
        cwd: '/tmp',
        image: 'chroxy-pod-agent:latest',
        containerId: 'pod-token-throw',
        containerUser: 'root',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: null,
        cpuLimit: null,
      }],
    }
    writeFileSync(statePath, JSON.stringify(seedData))

    const backend = {
      async getEnvironmentStatus() { return true },
      async reconnectAgentToken() { throw new Error('k8s api error') },
    }

    const manager = new EnvironmentManager({ statePath, backend })
    const result = await manager.reconnect()

    assert.equal(result, false,
      'reconnect() must return false when reconnectAgentToken throws — same signal as returning false')
    assert.equal(manager.get('env-token-throw').status, 'error',
      'env should be marked error when token refresh throws')
  })

  it('returns false when getEnvironmentStatus reports stopped (#3478)', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-stopped-result',
        name: 'stopped-result-env',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: 'stopped-ctr-result',
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
      }],
    }
    writeFileSync(statePath, JSON.stringify(seedData))

    const backend = {
      async getEnvironmentStatus() { return false }, // container stopped
    }

    const manager = new EnvironmentManager({ statePath, backend })
    const result = await manager.reconnect()

    assert.equal(result, false,
      'reconnect() must return false when an environment container is stopped')
    assert.equal(manager.get('env-stopped-result').status, 'stopped')
  })

  it('returns false when getEnvironmentStatus throws (#3478)', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-status-throw',
        name: 'status-throw-env',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: 'gone-ctr-result',
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
      }],
    }
    writeFileSync(statePath, JSON.stringify(seedData))

    const backend = {
      async getEnvironmentStatus() { throw new Error('No such container') },
    }

    const manager = new EnvironmentManager({ statePath, backend })
    const result = await manager.reconnect()

    assert.equal(result, false,
      'reconnect() must return false when getEnvironmentStatus throws')
    assert.equal(manager.get('env-status-throw').status, 'error')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Defensive hardening for non-true backend returns (#3495)
  //
  // The Backend protocol JSDoc only documents `true` / `false` returns from
  // reconnectAgentToken. A misbehaving or future backend that returns
  // `undefined` / `null` / any other non-true value should be treated as
  // failure — a missing credential is just as unusable as `false`.
  // ──────────────────────────────────────────────────────────────────────────

  it('marks environment unreachable when reconnectAgentToken returns undefined (#3495)', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-cred-undef',
        name: 'cred-undef-env',
        cwd: '/tmp',
        image: 'chroxy-pod-agent:latest',
        containerId: 'pod-cred-undef',
        containerUser: 'root',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-05-06T00:00:00Z',
        memoryLimit: null,
        cpuLimit: null,
      }],
    }
    writeFileSync(statePath, JSON.stringify(seedData))

    const backend = {
      async getEnvironmentStatus() { return true },
      async reconnectAgentToken() { /* returns undefined */ },
    }

    const manager = new EnvironmentManager({ statePath, backend })
    const result = await manager.reconnect()

    assert.equal(result, false,
      'reconnect() must return false when reconnectAgentToken returns undefined — non-true is unreachable')
    assert.equal(manager.get('env-cred-undef').status, 'error',
      'env should be marked error when token refresh returns undefined')
  })

  it('marks environment unreachable when reconnectAgentToken returns null (#3495)', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-cred-null',
        name: 'cred-null-env',
        cwd: '/tmp',
        image: 'chroxy-pod-agent:latest',
        containerId: 'pod-cred-null',
        containerUser: 'root',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-05-06T00:00:00Z',
        memoryLimit: null,
        cpuLimit: null,
      }],
    }
    writeFileSync(statePath, JSON.stringify(seedData))

    const backend = {
      async getEnvironmentStatus() { return true },
      async reconnectAgentToken() { return null },
    }

    const manager = new EnvironmentManager({ statePath, backend })
    const result = await manager.reconnect()

    assert.equal(result, false,
      'reconnect() must return false when reconnectAgentToken returns null — non-true is unreachable')
    assert.equal(manager.get('env-cred-null').status, 'error',
      'env should be marked error when token refresh returns null')
  })

  // Regression for #3494: previously the no-containerId branch `continue`d past
  // the `env.sessions = []` cleanup, leaving stale session refs on an env that
  // is even less reachable than one whose container is merely stopped.
  it('clears stale sessions on environments with no containerId (#3494)', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-no-container',
        name: 'no-container-env',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: null,
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: ['stale-1', 'stale-2'],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
      }],
    }
    writeFileSync(statePath, JSON.stringify(seedData))

    // Backend should never be consulted for a no-containerId env — assert by
    // throwing if it is touched. Reconnect must still mark the env unreachable
    // and return false.
    const backend = {
      async getEnvironmentStatus() { throw new Error('backend should not be called for no-containerId env') },
      async reconnectAgentToken() { throw new Error('backend should not be called for no-containerId env') },
    }

    const manager = new EnvironmentManager({ statePath, backend })
    const result = await manager.reconnect()

    const env = manager.get('env-no-container')
    assert.ok(env)
    assert.equal(result, false, 'reconnect() must return false when an env has no containerId')
    assert.equal(env.status, 'error', 'env with no containerId must be marked error')
    assert.deepEqual(env.sessions, [],
      'stale sessions on a no-containerId env must be cleared — they cannot survive a server restart')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Docker Compose stack support
// ──────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.create() with compose', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a compose environment with docker compose up', async () => {
    // Mock: compose -> up succeeds, ps returns JSON, exec succeeds (setup + install + prefix)
    let callCount = 0
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      callCount++
      if (args[0] === 'compose' && args.includes('up')) {
        cb(null, '', '')
        return
      }
      if (args[0] === 'compose' && args.includes('ps')) {
        cb(null, '{"ID":"compose-ctr-123","Service":"app","State":"running"}\n', '')
        return
      }
      if (args[0] === 'exec') {
        cb(null, '/usr/local\n', '')
        return
      }
      cb(null, '', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })

    const env = await manager.create({
      name: 'compose-env',
      cwd: '/home/user/project',
      compose: '/home/user/project/docker-compose.yml',
      primaryService: 'app',
    })

    assert.equal(env.image, 'compose')
    assert.equal(env.containerId, 'compose-ctr-123')
    assert.equal(env.compose, '/home/user/project/docker-compose.yml')
    assert.ok(env.composeProject.startsWith('chroxy-env-'))
    assert.equal(env.status, 'running')
    assert.ok(Array.isArray(env.services))
  })

  it('tears down compose on primary container identification failure', async () => {
    let downCalled = false
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'compose' && args.includes('up')) {
        cb(null, '', '')
        return
      }
      if (args[0] === 'compose' && args.includes('ps')) {
        // Return empty — no containers found
        cb(null, '', '')
        return
      }
      if (args[0] === 'compose' && args.includes('down')) {
        downCalled = true
        cb(null, '', '')
        return
      }
      cb(null, '', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })

    await assert.rejects(
      () => manager.create({
        name: 'fail-compose',
        cwd: '/tmp',
        compose: '/tmp/docker-compose.yml',
      }),
      /No running containers/
    )
    assert.ok(downCalled, 'should tear down compose on failure')
    assert.equal(manager.list().length, 0)
  })

  it('tears down compose on setup failure', async () => {
    let downCalled = false
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'compose' && args.includes('up')) {
        cb(null, '', '')
        return
      }
      if (args[0] === 'compose' && args.includes('ps')) {
        cb(null, '{"ID":"setup-fail-ctr","Service":"app","State":"running"}\n', '')
        return
      }
      if (args[0] === 'compose' && args.includes('down')) {
        downCalled = true
        cb(null, '', '')
        return
      }
      if (args[0] === 'exec') {
        cb(new Error('useradd failed'), '', '')
        return
      }
      cb(null, '', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })

    await assert.rejects(
      () => manager.create({
        name: 'setup-fail',
        cwd: '/tmp',
        compose: '/tmp/compose.yml',
      }),
      /useradd failed/
    )
    assert.ok(downCalled, 'should tear down compose on setup failure')
  })
})

describe('EnvironmentManager.destroy() with compose', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('uses docker compose down for compose environments', async () => {
    let downCalled = false
    let downArgs = []
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'compose' && args.includes('up')) {
        cb(null, '', '')
        return
      }
      if (args[0] === 'compose' && args.includes('ps')) {
        cb(null, '{"ID":"down-ctr","Service":"app","State":"running"}\n', '')
        return
      }
      if (args[0] === 'compose' && args.includes('down')) {
        downCalled = true
        downArgs = [...args]
        cb(null, '', '')
        return
      }
      if (args[0] === 'exec') {
        cb(null, '/usr/local\n', '')
        return
      }
      cb(null, '', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({
      name: 'destroy-compose',
      cwd: '/tmp',
      compose: '/tmp/compose.yml',
    })

    await manager.destroy(env.id)

    assert.ok(downCalled, 'should call docker compose down')
    assert.ok(downArgs.includes('--remove-orphans'), 'should include --remove-orphans')
    assert.equal(manager.list().length, 0)
  })

  it('does NOT use docker compose down for non-compose environments', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'rm-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'plain-env', cwd: '/tmp' })

    await manager.destroy(env.id)

    const composeCalls = mockExec.calls.filter(c => c.args[0] === 'compose')
    assert.equal(composeCalls.length, 0, 'should NOT call docker compose for plain environments')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Snapshot and restore
// ──────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.snapshot()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a docker image from a running container', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'snap-ctr\n', exec: '/usr/local\n', commit: 'sha256:abc123\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'snap-test', cwd: '/tmp' })

    const snap = await manager.snapshot(env.id, { name: 'after-deps' })

    assert.ok(snap.id.startsWith('snap-'))
    assert.equal(snap.name, 'after-deps')
    assert.ok(snap.image.includes('chroxy-env:'))
    assert.ok(snap.createdAt)

    const commitCalls = mockExec.calls.filter(c => c.args[0] === 'commit')
    assert.equal(commitCalls.length, 1)
    assert.ok(commitCalls[0].args.includes('snap-ctr'))
  })

  it('persists snapshot metadata to environment', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'persist-snap-ctr\n', exec: '/usr/local\n', commit: 'sha256:def456\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'persist-snap', cwd: '/tmp' })

    await manager.snapshot(env.id, { name: 'snap-1' })
    await manager.snapshot(env.id, { name: 'snap-2' })

    const updated = manager.get(env.id)
    assert.equal(updated.snapshots.length, 2)
    assert.equal(updated.snapshots[0].name, 'snap-1')
    assert.equal(updated.snapshots[1].name, 'snap-2')

    // Verify persisted to disk
    const data = JSON.parse(readFileSync(statePath, 'utf-8'))
    assert.equal(data.environments[0].snapshots.length, 2)
  })

  it('throws for non-running environment', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'stopped-snap-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'stopped-snap', cwd: '/tmp' })
    env.status = 'stopped'

    await assert.rejects(
      () => manager.snapshot(env.id, { name: 'fail' }),
      /not running/
    )
  })

  it('throws for unknown environment', async () => {
    const manager = new EnvironmentManager({ statePath, _execFile: createMockExecFile() })
    await assert.rejects(
      () => manager.snapshot('env-nonexistent'),
      /not found/
    )
  })

  it('uses snapshot ID as name when name is not provided', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'noname-ctr\n', exec: '/usr/local\n', commit: 'sha256:jkl012\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'noname-snap', cwd: '/tmp' })

    const snap = await manager.snapshot(env.id)
    assert.equal(snap.name, snap.id)
  })
})

describe('EnvironmentManager.restore()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('starts new container from snapshot image', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'restore-ctr\n', exec: '/usr/local\n', commit: 'sha256:aaa\n', inspect: 'true\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'restore-test', cwd: '/tmp' })

    const snap = await manager.snapshot(env.id, { name: 'pre-restore' })
    mockExec.calls.length = 0

    const restored = await manager.restore(env.id, snap.id)

    assert.equal(restored.status, 'running')

    const rmCalls = mockExec.calls.filter(c => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1)

    const runCalls = mockExec.calls.filter(c => c.args[0] === 'run')
    assert.equal(runCalls.length, 1)
    assert.ok(runCalls[0].args.includes(snap.image))
  })

  it('updates containerId after restore', async () => {
    let runCount = 0
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'run') {
        runCount++
        cb(null, runCount === 1 ? 'original-ctr\n' : 'restored-ctr\n', '')
        return
      }
      if (args[0] === 'commit') {
        cb(null, 'sha256:bbb\n', '')
        return
      }
      if (args[0] === 'inspect') {
        cb(null, 'true\n', '')
        return
      }
      cb(null, '/usr/local\n', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'ctr-update', cwd: '/tmp' })

    assert.equal(env.containerId, 'original-ctr')

    const snap = await manager.snapshot(env.id, { name: 'snap-for-restore' })
    const restored = await manager.restore(env.id, snap.id)

    assert.equal(restored.containerId, 'restored-ctr')

    const data = JSON.parse(readFileSync(statePath, 'utf-8'))
    assert.equal(data.environments[0].containerId, 'restored-ctr')
  })

  it('throws for unknown snapshot', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'unknown-snap-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'unknown-snap', cwd: '/tmp' })

    await assert.rejects(
      () => manager.restore(env.id, 'snap-nonexistent'),
      /Snapshot not found/
    )
  })

  it('throws for unknown environment', async () => {
    const manager = new EnvironmentManager({ statePath, _execFile: createMockExecFile() })
    await assert.rejects(
      () => manager.restore('env-nonexistent', 'snap-whatever'),
      /Environment not found/
    )
  })
})

describe('EnvironmentManager.destroy() snapshot cleanup', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes snapshot images when destroying environment', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'cleanup-ctr\n', exec: '/usr/local\n', commit: 'sha256:ddd\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'cleanup-test', cwd: '/tmp' })

    const snap1 = await manager.snapshot(env.id, { name: 'snap-a' })
    const snap2 = await manager.snapshot(env.id, { name: 'snap-b' })

    mockExec.calls.length = 0

    await manager.destroy(env.id)

    const rmiCalls = mockExec.calls.filter(c => c.args[0] === 'rmi')
    assert.equal(rmiCalls.length, 2)
    assert.ok(rmiCalls.some(c => c.args.includes(snap1.image)))
    assert.ok(rmiCalls.some(c => c.args.includes(snap2.image)))
  })

  it('destroys cleanly when environment has no snapshots', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'no-snap-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'no-snap', cwd: '/tmp' })

    await manager.destroy(env.id)

    assert.equal(manager.get(env.id), null)
    const rmiCalls = mockExec.calls.filter(c => c.args[0] === 'rmi')
    assert.equal(rmiCalls.length, 0)
  })
})
// ──────────────────────────────────────────────────────────────────────────────
// DevContainer spec support
// ──────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.create() with devcontainer', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('applies image from devcontainer.json', async () => {
    // Create a .devcontainer/devcontainer.json in a temp project dir
    const projectDir = mkdtempSync(join(tmpdir(), 'chroxy-dc-'))
    const { mkdirSync: mkdir, writeFileSync: writeFile } = await import('fs')
    mkdir(join(projectDir, '.devcontainer'), { recursive: true })
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      image: 'python:3.12-slim',
      remoteUser: 'devuser',
    }))

    const mockExec = createMockExecFile({
      results: { run: 'dc-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({
      name: 'dc-image',
      cwd: projectDir,
      devcontainer: true,
    })

    assert.equal(env.image, 'python:3.12-slim')
    assert.equal(env.containerUser, 'devuser')

    // Verify docker run used the devcontainer image
    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    assert.ok(runCall.args.includes('python:3.12-slim'))

    rmSync(projectDir, { recursive: true, force: true })
  })

  it('explicit options override devcontainer values', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'chroxy-dc-'))
    const { mkdirSync: mkdir, writeFileSync: writeFile } = await import('fs')
    mkdir(join(projectDir, '.devcontainer'), { recursive: true })
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      image: 'python:3.12-slim',
    }))

    const mockExec = createMockExecFile({
      results: { run: 'override-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({
      name: 'dc-override',
      cwd: projectDir,
      image: 'node:22-slim',
      devcontainer: true,
    })

    assert.equal(env.image, 'node:22-slim', 'explicit image should override devcontainer')

    rmSync(projectDir, { recursive: true, force: true })
  })

  it('falls back gracefully when no devcontainer file found', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'chroxy-dc-'))

    const mockExec = createMockExecFile({
      results: { run: 'nodc-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({
      name: 'dc-missing',
      cwd: projectDir,
      devcontainer: true,
    })

    assert.equal(env.image, 'node:22-slim', 'should use default image when no devcontainer found')

    rmSync(projectDir, { recursive: true, force: true })
  })

  it('runs postCreateCommand after setup', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'chroxy-dc-'))
    const { mkdirSync: mkdir, writeFileSync: writeFile } = await import('fs')
    mkdir(join(projectDir, '.devcontainer'), { recursive: true })
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      postCreateCommand: 'npm install',
    }))

    let postCreateCalled = false
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'run') { cb(null, 'post-ctr\n', ''); return }
      if (args[0] === 'exec' && args.includes('bash') && args.includes('npm install')) {
        postCreateCalled = true
        cb(null, '', '')
        return
      }
      cb(null, '/usr/local\n', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({
      name: 'dc-postcreate',
      cwd: projectDir,
      devcontainer: true,
    })

    assert.ok(postCreateCalled, 'should run postCreateCommand')

    rmSync(projectDir, { recursive: true, force: true })
  })

  it('passes containerEnv and forwardPorts to docker run', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'chroxy-dc-'))
    const { mkdirSync: mkdir, writeFileSync: writeFile } = await import('fs')
    mkdir(join(projectDir, '.devcontainer'), { recursive: true })
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      containerEnv: { NODE_ENV: 'development', DEBUG: 'true' },
      forwardPorts: [3000, 5432],
    }))

    const mockExec = createMockExecFile({
      results: { run: 'ports-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({
      name: 'dc-env-ports',
      cwd: projectDir,
      devcontainer: true,
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const envPairs = []
    const portPairs = []
    for (let i = 0; i < runCall.args.length - 1; i++) {
      if (runCall.args[i] === '--env') envPairs.push(runCall.args[i + 1])
      if (runCall.args[i] === '-p') portPairs.push(runCall.args[i + 1])
    }

    assert.ok(envPairs.includes('NODE_ENV=development'))
    assert.ok(envPairs.includes('DEBUG=true'))
    assert.ok(portPairs.includes('3000:3000'))
    assert.ok(portPairs.includes('5432:5432'))

    rmSync(projectDir, { recursive: true, force: true })
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// DevContainer mount and env validation (#2512)
// ──────────────────────────────────────────────────────────────────────────────

describe('DevContainer mount validation', () => {
  let tmpDir, statePath, projectDir

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
    projectDir = mkdtempSync(join(tmpdir(), 'chroxy-dc-'))
    const { mkdirSync: mkdir } = await import('fs')
    mkdir(join(projectDir, '.devcontainer'), { recursive: true })
    mkdir(join(projectDir, 'subdir'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('allows mounts with source inside the project directory', async () => {
    const { writeFileSync: writeFile } = await import('fs')
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      mounts: [`${projectDir}/subdir:/container/path`],
    }))

    const mockExec = createMockExecFile({
      results: { run: 'mount-ok-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({
      name: 'mount-allowed',
      cwd: projectDir,
      devcontainer: true,
    })

    // Mount should be passed to docker run
    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const volumeArgs = []
    for (let i = 0; i < runCall.args.length - 1; i++) {
      if (runCall.args[i] === '-v') volumeArgs.push(runCall.args[i + 1])
    }
    assert.ok(volumeArgs.some(v => v.includes(projectDir + '/subdir')), 'should include mount inside project dir')
  })

  it('rejects mounts with source outside the project directory', async () => {
    const { writeFileSync: writeFile } = await import('fs')
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      mounts: ['/etc/passwd:/container/etc/passwd', `${projectDir}/subdir:/container/path`],
    }))

    const mockExec = createMockExecFile({
      results: { run: 'mount-reject-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({
      name: 'mount-rejected',
      cwd: projectDir,
      devcontainer: true,
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const volumeArgs = []
    for (let i = 0; i < runCall.args.length - 1; i++) {
      if (runCall.args[i] === '-v') volumeArgs.push(runCall.args[i + 1])
    }
    assert.ok(!volumeArgs.some(v => v.includes('/etc/passwd')), 'should NOT include mount outside project dir')
    assert.ok(volumeArgs.some(v => v.includes(projectDir + '/subdir')), 'should still include valid mount')
  })

  it('rejects mounts targeting home directory sensitive paths', async () => {
    const home = homedir()
    const { writeFileSync: writeFile } = await import('fs')
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      mounts: [
        `${home}/.ssh:/container/.ssh`,
        `${home}/.aws:/container/.aws`,
        `${home}/.gnupg:/container/.gnupg`,
        `${home}:/container/home`,
      ],
    }))

    const mockExec = createMockExecFile({
      results: { run: 'sensitive-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({
      name: 'mount-sensitive',
      cwd: projectDir,
      devcontainer: true,
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const volumeArgs = []
    for (let i = 0; i < runCall.args.length - 1; i++) {
      if (runCall.args[i] === '-v') volumeArgs.push(runCall.args[i + 1])
    }
    // None of the sensitive mounts should be passed through
    assert.ok(!volumeArgs.some(v => v.includes('.ssh')), 'should reject .ssh mount')
    assert.ok(!volumeArgs.some(v => v.includes('.aws')), 'should reject .aws mount')
    assert.ok(!volumeArgs.some(v => v.includes('.gnupg')), 'should reject .gnupg mount')
    assert.ok(!volumeArgs.some(v => v.includes(home + ':/container/home')), 'should reject home dir mount')
  })

  it('rejects mounts with source using ~ tilde notation for sensitive paths', async () => {
    const { writeFileSync: writeFile } = await import('fs')
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      mounts: ['~/.ssh:/container/.ssh', '~/.config:/container/.config'],
    }))

    const mockExec = createMockExecFile({
      results: { run: 'tilde-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({
      name: 'mount-tilde',
      cwd: projectDir,
      devcontainer: true,
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const volumeArgs = []
    for (let i = 0; i < runCall.args.length - 1; i++) {
      if (runCall.args[i] === '-v') volumeArgs.push(runCall.args[i + 1])
    }
    assert.ok(!volumeArgs.some(v => v.includes('.ssh')), 'should reject tilde .ssh mount')
    assert.ok(!volumeArgs.some(v => v.includes('.config')), 'should reject tilde .config mount')
  })

  it('rejects mounts with source path /etc', async () => {
    const { writeFileSync: writeFile } = await import('fs')
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      mounts: ['/etc:/container/etc'],
    }))

    const mockExec = createMockExecFile({
      results: { run: 'etc-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({
      name: 'mount-etc',
      cwd: projectDir,
      devcontainer: true,
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const volumeArgs = []
    for (let i = 0; i < runCall.args.length - 1; i++) {
      if (runCall.args[i] === '-v') volumeArgs.push(runCall.args[i + 1])
    }
    assert.ok(!volumeArgs.some(v => v.startsWith('/etc')), 'should reject /etc mount')
  })

  it('logs rejected mounts with the attempted path', async () => {
    const { writeFileSync: writeFile } = await import('fs')
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      mounts: ['/etc/shadow:/container/shadow'],
    }))

    const mockExec = createMockExecFile({
      results: { run: 'log-ctr\n', exec: '/usr/local\n' },
    })

    // Capture log output by replacing the logger temporarily
    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })

    // We test indirectly: the mount is rejected (not passed to docker run)
    // and the method returns successfully (logs instead of throwing)
    await manager.create({
      name: 'mount-logged',
      cwd: projectDir,
      devcontainer: true,
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const volumeArgs = []
    for (let i = 0; i < runCall.args.length - 1; i++) {
      if (runCall.args[i] === '-v') volumeArgs.push(runCall.args[i + 1])
    }
    assert.ok(!volumeArgs.some(v => v.includes('/etc/shadow')), 'rejected mount should not appear in docker args')
  })

  it('rejects mounts using .. path traversal to escape project directory', async () => {
    const { writeFileSync: writeFile } = await import('fs')
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      mounts: [
        `${projectDir}/subdir/../../../../etc/passwd:/container/passwd`,
        `source=${projectDir}/sub/../../../etc/shadow,target=/container/shadow,type=bind`,
        `${projectDir}/subdir:/container/valid`,
      ],
    }))

    const mockExec = createMockExecFile({
      results: { run: 'mount-traversal-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({
      name: 'mount-traversal',
      cwd: projectDir,
      devcontainer: true,
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const volumeArgs = []
    for (let i = 0; i < runCall.args.length - 1; i++) {
      if (runCall.args[i] === '-v') volumeArgs.push(runCall.args[i + 1])
    }
    assert.ok(!volumeArgs.some(v => v.includes('/etc/passwd')), 'should reject .. traversal to /etc/passwd')
    assert.ok(!volumeArgs.some(v => v.includes('/etc/shadow')), 'should reject .. traversal in --mount format')
    assert.ok(volumeArgs.some(v => v.includes(projectDir + '/subdir')), 'should still include valid mount')
  })

  it('handles docker-style --mount source=,target= format', async () => {
    const { writeFileSync: writeFile } = await import('fs')
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      mounts: [
        `source=${projectDir}/subdir,target=/container/path,type=bind`,
        'source=/etc/passwd,target=/container/passwd,type=bind',
      ],
    }))

    const mockExec = createMockExecFile({
      results: { run: 'mount-fmt-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({
      name: 'mount-format',
      cwd: projectDir,
      devcontainer: true,
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const allArgs = runCall.args.join(' ')
    assert.ok(allArgs.includes(projectDir + '/subdir'), 'should include valid mount in --mount format')
    assert.ok(!allArgs.includes('/etc/passwd'), 'should reject invalid mount in --mount format')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Concurrency guards
// ──────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager concurrency guards', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('serializes concurrent operations on the same environment', async () => {
    // Track the order operations actually execute in
    const executionOrder = []
    let runCount = 0

    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'run') {
        runCount++
        cb(null, `ctr-${runCount}\n`, '')
        return
      }
      if (args[0] === 'commit') {
        // Simulate a slow snapshot — use setTimeout to ensure
        // without mutex the second snapshot would start before this finishes
        executionOrder.push('commit-start')
        setTimeout(() => {
          executionOrder.push('commit-end')
          cb(null, 'sha256:abc\n', '')
        }, 50)
        return
      }
      if (args[0] === 'rm') {
        executionOrder.push('rm')
        cb(null, '', '')
        return
      }
      if (args[0] === 'rmi') {
        cb(null, '', '')
        return
      }
      cb(null, '/usr/local\n', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'mutex-test', cwd: '/tmp' })

    // Fire snapshot + destroy concurrently on the same environment
    const [/* snapResult */] = await Promise.allSettled([
      manager.snapshot(env.id, { name: 'snap-1' }),
      manager.destroy(env.id),
    ])

    // The snapshot must complete before destroy starts
    const commitEndIdx = executionOrder.indexOf('commit-end')
    const rmIdx = executionOrder.indexOf('rm')
    assert.ok(commitEndIdx >= 0, 'commit should have completed')
    assert.ok(rmIdx >= 0, 'rm should have been called')
    assert.ok(commitEndIdx < rmIdx, 'snapshot commit must finish before destroy rm starts')
  })

  it('allows concurrent operations on different environments', async () => {
    const activeOps = { count: 0, max: 0 }

    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'run') {
        cb(null, 'ctr-diff\n', '')
        return
      }
      if (args[0] === 'commit') {
        activeOps.count++
        activeOps.max = Math.max(activeOps.max, activeOps.count)
        setTimeout(() => {
          activeOps.count--
          cb(null, 'sha256:abc\n', '')
        }, 30)
        return
      }
      cb(null, '/usr/local\n', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const envA = await manager.create({ name: 'env-a', cwd: '/tmp' })
    const envB = await manager.create({ name: 'env-b', cwd: '/tmp' })

    // Two snapshots on different environments should run in parallel
    await Promise.all([
      manager.snapshot(envA.id, { name: 'snap-a' }),
      manager.snapshot(envB.id, { name: 'snap-b' }),
    ])

    assert.equal(activeOps.max, 2, 'operations on different environments should overlap')
  })

  it('releases mutex when operation throws', async () => {
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'run') {
        cb(null, 'err-ctr\n', '')
        return
      }
      if (args[0] === 'commit') {
        cb(new Error('commit failed'), '', 'commit failed')
        return
      }
      cb(null, '/usr/local\n', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'err-mutex', cwd: '/tmp' })

    // First snapshot fails
    await assert.rejects(() => manager.snapshot(env.id, { name: 'fail' }), /commit failed/)

    // Second operation should not deadlock — destroy should proceed
    // Change mock to allow destroy
    const manager2 = new EnvironmentManager({ statePath, _execFile: createMockExecFile({
      results: { run: 'err-ctr\n', exec: '/usr/local\n' },
    }) })
    // Re-populate the internal map
    manager2._environments = manager._environments

    await manager2.destroy(env.id)
    assert.equal(manager2.get(env.id), null, 'should be able to operate after a failed op')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Atomic restore
// ──────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.restore() atomic behavior', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('keeps old container until new one passes health check', async () => {
    const removedContainers = []
    let runCount = 0

    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'run') {
        runCount++
        cb(null, runCount === 1 ? 'old-ctr\n' : 'new-ctr\n', '')
        return
      }
      if (args[0] === 'commit') {
        cb(null, 'sha256:snap\n', '')
        return
      }
      if (args[0] === 'inspect') {
        // Health check: new container is running
        cb(null, 'true\n', '')
        return
      }
      if (args[0] === 'rm') {
        removedContainers.push(args[args.length - 1])
        cb(null, '', '')
        return
      }
      cb(null, '/usr/local\n', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'atomic-restore', cwd: '/tmp' })
    const snap = await manager.snapshot(env.id, { name: 'checkpoint' })

    // Clear tracking
    removedContainers.length = 0

    const restored = await manager.restore(env.id, snap.id)

    // Old container should have been removed
    assert.ok(removedContainers.includes('old-ctr'), 'old container should be removed after new one is healthy')
    assert.equal(restored.containerId, 'new-ctr')
    assert.equal(restored.status, 'running')
  })

  it('keeps old container when new container fails health check', async () => {
    const removedContainers = []
    let runCount = 0

    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'run') {
        runCount++
        cb(null, runCount === 1 ? 'old-ctr\n' : 'bad-new-ctr\n', '')
        return
      }
      if (args[0] === 'commit') {
        cb(null, 'sha256:snap\n', '')
        return
      }
      if (args[0] === 'inspect') {
        // New container is NOT running (health check fails)
        if (args.includes('bad-new-ctr')) {
          cb(new Error('Container not running'), '', '')
          return
        }
        cb(null, 'true\n', '')
        return
      }
      if (args[0] === 'rm') {
        removedContainers.push(args[args.length - 1])
        cb(null, '', '')
        return
      }
      cb(null, '/usr/local\n', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'fail-restore', cwd: '/tmp' })
    const snap = await manager.snapshot(env.id, { name: 'checkpoint' })

    removedContainers.length = 0

    await assert.rejects(
      () => manager.restore(env.id, snap.id),
      /health check failed/i,
    )

    // Old container should NOT have been removed
    assert.ok(!removedContainers.includes('old-ctr'), 'old container should be preserved when new one fails')
    // Bad new container should be cleaned up
    assert.ok(removedContainers.includes('bad-new-ctr'), 'failed new container should be removed')
    // Environment should still reference the old container
    assert.equal(manager.get(env.id).containerId, 'old-ctr')
    assert.equal(manager.get(env.id).status, 'running')
  })

  it('rolls back when new container inspect throws', async () => {
    let runCount = 0
    const removedContainers = []
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'run') {
        runCount++
        cb(null, runCount === 1 ? 'orig-ctr\n' : 'fail-inspect-ctr\n', '')
        return
      }
      if (args[0] === 'commit') {
        cb(null, 'sha256:ccc\n', '')
        return
      }
      if (args[0] === 'inspect') {
        // Inspect throws error (container crashed immediately)
        cb(new Error('No such container'), '', '')
        return
      }
      if (args[0] === 'rm') {
        removedContainers.push(args[args.length - 1])
        cb(null, '', '')
        return
      }
      cb(null, '/usr/local\n', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const env = await manager.create({ name: 'inspect-fail-test', cwd: '/tmp' })

    const snap = await manager.snapshot(env.id, { name: 'pre-inspect-fail' })

    await assert.rejects(
      () => manager.restore(env.id, snap.id),
      /health check failed/
    )

    // Old container preserved, failed new container cleaned up
    assert.ok(!removedContainers.includes('orig-ctr'))
    assert.ok(removedContainers.includes('fail-inspect-ctr'))
    assert.equal(manager.get(env.id).containerId, 'orig-ctr')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Compose services graceful degradation
// ──────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager._composeServices() graceful degradation', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when docker compose ps fails', async () => {
    const mockExec = createMockExecFile({
      errors: { compose: new Error('docker compose not found') },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const services = await manager._composeServices('test-project')
    assert.deepEqual(services, [], 'should return empty array on failure')
  })

  it('returns empty array when compose ps returns invalid JSON', async () => {
    function mockExec(_cmd, _args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      cb(null, 'not-valid-json\n', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    const services = await manager._composeServices('test-project')
    assert.deepEqual(services, [], 'should return empty array on JSON parse failure')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Startup reconciliation
// ──────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.reconcile()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stops orphaned chroxy-env-* containers not in registry', async () => {
    const removedContainers = []

    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }

      // docker ps --filter to list chroxy containers
      if (args[0] === 'ps') {
        cb(null, 'orphan-ctr-1\norphan-ctr-2\nknown-ctr\n', '')
        return
      }
      if (args[0] === 'rm') {
        removedContainers.push(args[args.length - 1])
        cb(null, '', '')
        return
      }
      if (args[0] === 'inspect') {
        cb(null, 'true\n', '')
        return
      }
      cb(null, '', '')
    }
    mockExec.calls = []

    // Seed state with one known environment
    const { writeFileSync } = await import('fs')
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      environments: [{
        id: 'env-known',
        name: 'known-env',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: 'known-ctr',
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
      }],
    }))

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.reconnect()
    await manager.reconcile()

    // Should remove orphan-ctr-1 and orphan-ctr-2 but NOT known-ctr
    assert.ok(removedContainers.includes('orphan-ctr-1'), 'should remove orphan 1')
    assert.ok(removedContainers.includes('orphan-ctr-2'), 'should remove orphan 2')
    assert.ok(!removedContainers.includes('known-ctr'), 'should NOT remove known container')
  })

  it('handles empty docker ps output gracefully', async () => {
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'ps') {
        cb(null, '\n', '')
        return
      }
      cb(null, '', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    // Should not throw
    await manager.reconcile()
  })

  it('handles docker ps failure gracefully', async () => {
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'ps') {
        cb(new Error('Docker not available'), '', 'Docker not available')
        return
      }
      cb(null, '', '')
    }
    mockExec.calls = []

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    // Should not throw — reconcile is best-effort
    await manager.reconcile()
  })

  // Regression guard for #3314: createEnvironment persists the full 64-char
  // ID returned by docker run; without --no-trunc, docker ps -q returns the
  // 12-char prefix, so reconcile()'s exact-string comparison would mark every
  // known container as orphan and destroy it.
  //
  // The mock simulates real `docker ps`: it ONLY returns full-length IDs when
  // --no-trunc is present in the args; otherwise it returns the truncated
  // 12-char prefix that real Docker produces. This way the test fails before
  // the fix and passes after.
  it('does NOT destroy a known container when docker ps returns IDs (#3314)', async () => {
    const fullId = 'a'.repeat(64)
    const truncatedId = fullId.slice(0, 12)
    const removedContainers = []

    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }

      if (args[0] === 'ps') {
        // Simulate real docker ps behavior: truncates to 12 chars unless --no-trunc.
        const id = args.includes('--no-trunc') ? fullId : truncatedId
        cb(null, `${id}\n`, '')
        return
      }
      if (args[0] === 'rm') {
        removedContainers.push(args[args.length - 1])
        cb(null, '', '')
        return
      }
      if (args[0] === 'inspect') {
        cb(null, 'true\n', '')
        return
      }
      cb(null, '', '')
    }
    mockExec.calls = []

    // Seed state with an environment whose containerId is the full 64-char form
    // (as returned by `docker run` and persisted by createEnvironment).
    const { writeFileSync } = await import('fs')
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      environments: [{
        id: 'env-known',
        name: 'known-env',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: fullId,
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-03-17T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
      }],
    }))

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.reconnect()
    await manager.reconcile()

    assert.equal(removedContainers.length, 0,
      'known container must NOT be destroyed by reconcile() — ' +
      'docker ps must return full IDs that match the persisted containerId')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// DevContainer containerEnv key sanitization (#2512)
// ──────────────────────────────────────────────────────────────────────────────

describe('DevContainer containerEnv key sanitization', () => {
  let tmpDir, statePath, projectDir

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
    projectDir = mkdtempSync(join(tmpdir(), 'chroxy-dc-'))
    const { mkdirSync: mkdir } = await import('fs')
    mkdir(join(projectDir, '.devcontainer'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('allows valid env var keys (alphanumeric + underscore)', async () => {
    const { writeFileSync: writeFile } = await import('fs')
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      containerEnv: { NODE_ENV: 'development', MY_VAR_2: 'value' },
    }))

    const mockExec = createMockExecFile({
      results: { run: 'env-ok-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({
      name: 'env-valid',
      cwd: projectDir,
      devcontainer: true,
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const envPairs = []
    for (let i = 0; i < runCall.args.length - 1; i++) {
      if (runCall.args[i] === '--env') envPairs.push(runCall.args[i + 1])
    }
    assert.ok(envPairs.includes('NODE_ENV=development'))
    assert.ok(envPairs.includes('MY_VAR_2=value'))
  })

  it('rejects env var keys with special characters', async () => {
    const { writeFileSync: writeFile } = await import('fs')
    writeFile(join(projectDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      containerEnv: {
        'VALID_KEY': 'ok',
        'BAD-KEY': 'nope',
        'BAD KEY': 'nope',
        'BAD;KEY': 'nope',
        'BAD$(cmd)': 'nope',
      },
    }))

    const mockExec = createMockExecFile({
      results: { run: 'env-reject-ctr\n', exec: '/usr/local\n' },
    })

    const manager = new EnvironmentManager({ statePath, _execFile: mockExec })
    await manager.create({
      name: 'env-sanitized',
      cwd: projectDir,
      devcontainer: true,
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const envPairs = []
    for (let i = 0; i < runCall.args.length - 1; i++) {
      if (runCall.args[i] === '--env') envPairs.push(runCall.args[i + 1])
    }
    assert.ok(envPairs.some(e => e.startsWith('VALID_KEY=')), 'should include valid env key')
    assert.ok(!envPairs.some(e => e.startsWith('BAD-KEY=')), 'should reject key with hyphen')
    assert.ok(!envPairs.some(e => e.startsWith('BAD KEY=')), 'should reject key with space')
    assert.ok(!envPairs.some(e => e.startsWith('BAD;KEY=')), 'should reject key with semicolon')
    assert.ok(!envPairs.some(e => e.includes('BAD$(cmd)')), 'should reject key with shell injection')
  })
})

describe('EnvironmentManager._persist() rename-failure cleanup (regression: #2940)', () => {
  let tempDir
  let statePath

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-env-rename-fail-test-'))
    statePath = join(tempDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // Force the final renameSync to fail by pre-creating <statePath> as a
  // non-empty directory. POSIX rename() into a non-empty directory throws
  // ENOTEMPTY / EISDIR — the closest portable analogue of a transient FS error.
  function blockRename() {
    mkdirSync(statePath)
    writeFileSync(join(statePath, 'sentinel'), 'block rename')
  }

  it('removes the orphaned .tmp file when the final rename fails', () => {
    blockRename()

    const mgr = new EnvironmentManager({ statePath, _execFile: () => {} })
    // Call _persist() directly — it swallows errors by design
    mgr._persist()

    assert.equal(existsSync(statePath + '.tmp'), false, 'orphaned .tmp file must be cleaned up')
  })

  it('swallows the rename error (existing _persist error-logging contract is preserved)', () => {
    blockRename()

    const mgr = new EnvironmentManager({ statePath, _execFile: () => {} })
    // _persist must not throw — it logs and returns
    assert.doesNotThrow(() => mgr._persist())
  })

  it('does not leak .tmp across repeated rename failures', () => {
    blockRename()

    const mgr = new EnvironmentManager({ statePath, _execFile: () => {} })
    mgr._persist()
    mgr._persist()

    assert.equal(existsSync(statePath + '.tmp'), false, '.tmp must never accumulate across repeated failures')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// EnvironmentManager.reconnect() — backend reconnectAgentToken integration (#3339)
// ─────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.reconnect() — reconnectAgentToken delegation (#3339)', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls reconnectAgentToken on the backend for each environment', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-k8s-1',
        name: 'k8s-env',
        cwd: '/tmp',
        image: 'chroxy-pod-agent:latest',
        containerId: 'chroxy-env-k8s-1',
        containerUser: 'root',
        containerCliPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-01-01T00:00:00Z',
        memoryLimit: null,
        cpuLimit: null,
        compose: null,
        composeProject: null,
      }],
    }
    writeFileSync(statePath, JSON.stringify(seedData))

    const reconnectedIds = []
    const mockBackend = {
      getEnvironmentStatus: async () => true,
      reconnectAgentToken: async (podName) => { reconnectedIds.push(podName); return true },
    }

    const manager = new EnvironmentManager({ statePath, backend: mockBackend })
    await manager.reconnect()

    assert.deepEqual(reconnectedIds, ['chroxy-env-k8s-1'],
      'reconnect() must call reconnectAgentToken for each environment with a containerId')
  })

  it('logs a warning, marks env error, and returns false when reconnectAgentToken rejects (#3478)', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-k8s-err',
        name: 'k8s-err',
        cwd: '/tmp',
        image: 'chroxy-pod-agent:latest',
        containerId: 'chroxy-env-k8s-err',
        containerUser: 'root',
        containerCliPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-01-01T00:00:00Z',
        memoryLimit: null,
        cpuLimit: null,
        compose: null,
        composeProject: null,
      }],
    }
    writeFileSync(statePath, JSON.stringify(seedData))

    const mockBackend = {
      getEnvironmentStatus: async () => true,
      reconnectAgentToken: async () => { throw new Error('k8s api error') },
    }

    const manager = new EnvironmentManager({ statePath, backend: mockBackend })
    // Must not throw even when reconnectAgentToken rejects — errors are absorbed.
    let result
    await assert.doesNotReject(async () => { result = await manager.reconnect() },
      'reconnect() must absorb token refresh errors')

    // Per #3478: a thrown reconnectAgentToken is the same unreachable signal
    // as returning false — flip allHealthy and mark the env error.
    assert.equal(result, false,
      'reconnect() must return false when reconnectAgentToken throws')
    assert.equal(manager.get('env-k8s-err').status, 'error',
      'env should be marked error when token refresh throws')
  })

  it('skips reconnectAgentToken when backend does not support it (Docker)', async () => {
    const seedData = {
      version: 1,
      environments: [{
        id: 'env-docker-1',
        name: 'docker-env',
        cwd: '/tmp',
        image: 'node:22-slim',
        containerId: 'abc123',
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/cli.js',
        status: 'running',
        sessions: [],
        createdAt: '2026-01-01T00:00:00Z',
        memoryLimit: '2g',
        cpuLimit: '2',
        compose: null,
        composeProject: null,
      }],
    }
    writeFileSync(statePath, JSON.stringify(seedData))

    // Backend without reconnectAgentToken (simulates DockerBackend)
    const mockBackend = {
      getEnvironmentStatus: async () => true,
      // No reconnectAgentToken property
    }

    const manager = new EnvironmentManager({ statePath, backend: mockBackend })
    // Should not throw even without reconnectAgentToken on the backend
    await assert.doesNotReject(() => manager.reconnect())
    assert.equal(manager.get('env-docker-1').status, 'running')
  })
})

/**
 * Issue #3492 / #3545 — invariant guard for the reconnect() unreachable-count
 * helper.
 *
 * The boot-path aggregate-warn helper in
 * `server-cli.js#logEnvironmentManagerReconnectResult` derives the unreachable
 * count via `list().filter(e => UNREACHABLE_STATUSES.has(e.status)).length`.
 * This stays accurate only while every code path in `reconnect()` that flips
 * `allHealthy = false` also sets `env.status` to a value in
 * `UNREACHABLE_STATUSES`. A future contributor adding a new
 * `allHealthy = false` branch (quotas, partial-restore, metrics, …) without
 * a co-located status assignment would silently undercount.
 *
 * Original guard (#3492) inspected counts only — it asserted that the number
 * of `allHealthy = false` flips equals (status assignments − 1) and that every
 * literal status was 'running' or in UNREACHABLE_STATUSES. The count check
 * misses a narrower contributor bug (#3545): a new branch that flips
 * `allHealthy = false` AND assigns `env.status = 'running'` (or any other
 * reachable status) — internally inconsistent, yet the count balances.
 *
 * Strengthened guard (#3545) walks the body line-by-line and pairs each
 * `allHealthy = false` with the most-recent preceding `env.status` literal,
 * asserting the literal is in UNREACHABLE_STATUSES. Failure messages quote the
 * exact pairing so the broken branch is obvious.
 */
describe('EnvironmentManager.reconnect() invariant guard (#3492, #3545)', () => {
  it('UNREACHABLE_STATUSES contains expected statuses', () => {
    assert.ok(UNREACHABLE_STATUSES.has('error'), '\'error\' must be unreachable')
    assert.ok(UNREACHABLE_STATUSES.has('stopped'), '\'stopped\' must be unreachable')
    assert.ok(!UNREACHABLE_STATUSES.has('running'), '\'running\' must NOT be unreachable')
  })

  it('every allHealthy=false branch in reconnect() pairs with the nearest preceding env.status assignment to an UNREACHABLE_STATUSES value', () => {
    const srcPath = resolve(__dirname, '../src/environment-manager.js')
    const src = readFileSync(srcPath, 'utf-8')

    // Extract the body of reconnect() — from `async reconnect() {` to the
    // matching closing brace of the method.
    const startIdx = src.indexOf('async reconnect() {')
    assert.notEqual(startIdx, -1, 'reconnect() not found in source')

    let depth = 0
    let endIdx = -1
    let started = false
    for (let i = startIdx; i < src.length; i++) {
      const ch = src[i]
      if (ch === '{') {
        depth += 1
        started = true
      } else if (ch === '}') {
        depth -= 1
        if (started && depth === 0) {
          endIdx = i
          break
        }
      }
    }
    assert.notEqual(endIdx, -1, 'closing brace for reconnect() not found')

    // Strip line comments so the regexes below count actual code, not the
    // inline invariant docstrings (which intentionally mention
    // `allHealthy = false` and the status literals). Preserve original line
    // numbers — needed for failure messages.
    const bodyLines = src
      .slice(startIdx, endIdx + 1)
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
    const bodyOffsetLine = src.slice(0, startIdx).split('\n').length // 1-based first line of body

    const body = bodyLines.join('\n')

    // ──────────────────────────────────────────────────────────────────────
    // Top-level sanity (preserved from #3492)
    // ──────────────────────────────────────────────────────────────────────
    const flipMatches = body.match(/allHealthy\s*=\s*false/g) || []
    const statusMatches = body.match(/env\.status\s*=\s*['"]([^'"]+)['"]/g) || []

    assert.ok(flipMatches.length > 0, 'reconnect() must contain at least one allHealthy=false branch')
    // Count check still useful: catches a branch with no env.status assignment
    // at all (the most-likely contributor mistake).
    assert.equal(
      statusMatches.length,
      flipMatches.length + 1, // +1 for the success-path 'running' assignment
      `expected ${flipMatches.length + 1} env.status assignments (one per allHealthy=false branch + the running success path), found ${statusMatches.length}. ` +
      'A new allHealthy=false branch was added without a co-located env.status assignment — see #3492 invariant.',
    )

    // Every literal status string written must be either 'running' or a
    // value in UNREACHABLE_STATUSES.
    for (const match of statusMatches) {
      const literal = match.match(/['"]([^'"]+)['"]/)[1]
      assert.ok(
        literal === 'running' || UNREACHABLE_STATUSES.has(literal),
        `env.status = '${literal}' is not 'running' and not in UNREACHABLE_STATUSES. ` +
        'Either the new status is reachable (use \'running\') or add it to UNREACHABLE_STATUSES — see #3492 invariant.',
      )
    }

    // ──────────────────────────────────────────────────────────────────────
    // Per-branch pairing (#3545)
    //
    // Walk the body line-by-line. Track the most-recent `env.status =
    // '<literal>'` assignment. On each line that flips `allHealthy = false`,
    // assert the tracked literal exists and is in UNREACHABLE_STATUSES.
    //
    // After consuming an assignment in a flip pairing, clear the tracker so
    // a subsequent flip cannot reuse a stale assignment from a sibling
    // branch.
    //
    // The success-path `env.status = 'running'` assignment is allowed to
    // exist without a paired flip — it overwrites the tracker but, if the
    // next event in the body is the function returning rather than a flip,
    // it's discarded harmlessly.
    // ──────────────────────────────────────────────────────────────────────
    const statusLineRe = /env\.status\s*=\s*['"]([^'"]+)['"]/
    const flipLineRe = /allHealthy\s*=\s*false/

    let lastStatus = null // { literal, lineNo }
    let pairingsChecked = 0

    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i]
      const lineNo = bodyOffsetLine + i

      const statusMatch = line.match(statusLineRe)
      if (statusMatch) {
        lastStatus = { literal: statusMatch[1], lineNo }
      }

      if (flipLineRe.test(line)) {
        assert.ok(
          lastStatus !== null,
          `[#3545] reconnect() line ${lineNo}: 'allHealthy = false' has no preceding 'env.status = ...' assignment in scope. ` +
          'Every allHealthy=false flip must be co-located with an unreachable env.status assignment so the boot-path aggregate-warn count stays accurate.',
        )
        assert.ok(
          UNREACHABLE_STATUSES.has(lastStatus.literal),
          `[#3545] reconnect() line ${lineNo}: 'allHealthy = false' is paired with 'env.status = '${lastStatus.literal}'' ` +
          `(line ${lastStatus.lineNo}), which is NOT in UNREACHABLE_STATUSES. ` +
          'An env reported unhealthy must be assigned an unreachable status (\'error\' or \'stopped\') — ' +
          'otherwise the boot-path aggregate-warn helper undercounts. See #3492/#3545 invariant.',
        )
        pairingsChecked += 1
        lastStatus = null // consume — sibling branches cannot reuse this assignment
      }
    }

    // Belt-and-braces: the per-branch loop must have inspected every flip.
    assert.equal(
      pairingsChecked,
      flipMatches.length,
      `[#3545] expected to pair ${flipMatches.length} 'allHealthy = false' branches, but only inspected ${pairingsChecked}. ` +
      'The line-pairing walk diverged from the top-level count — likely a regex/source-extraction bug in the test itself.',
    )
  })
})
