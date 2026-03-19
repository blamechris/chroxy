import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { EnvironmentManager } from '../src/environment-manager.js'

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
    function mockExec(cmd, args, opts, cb) {
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
    function mockExec(cmd, args, opts, cb) {
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
    function mockExec(cmd, args, opts, cb) {
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
    function mockExec(cmd, args, opts, cb) {
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
    function mockExec(cmd, args, opts, cb) {
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
    let rmCalled = false
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
    function mockExec(cmd, args, opts, cb) {
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
    function mockExec(cmd, args, opts, cb) {
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

    function mockExec(cmd, args, opts, cb) {
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
    const [snapResult] = await Promise.allSettled([
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

    function mockExec(cmd, args, opts, cb) {
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
    function mockExec(cmd, args, opts, cb) {
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

    function mockExec(cmd, args, opts, cb) {
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

    function mockExec(cmd, args, opts, cb) {
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
    function mockExec(cmd, args, opts, cb) {
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
    function mockExec(cmd, args, opts, cb) {
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

    function mockExec(cmd, args, opts, cb) {
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
    function mockExec(cmd, args, opts, cb) {
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
    function mockExec(cmd, args, opts, cb) {
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
})
