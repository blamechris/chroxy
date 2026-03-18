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
