/**
 * Abstraction boundary tests — verify that EnvironmentManager delegates
 * Docker operations to the injected Backend and never calls Docker directly.
 *
 * These tests inject a mock Backend (plain object with spy methods) into the
 * EnvironmentManager constructor and assert that the correct backend methods
 * are called with the correct arguments for every manager operation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EnvironmentManager } from '../../../src/environment-manager.js'

/**
 * Creates a spy function that records every call.
 * Returns a specified value (or resolves a promise with it) on each invocation.
 */
function spy(returnValue) {
  const calls = []
  const fn = (...args) => {
    calls.push(args)
    return typeof returnValue === 'function' ? returnValue(...args) : Promise.resolve(returnValue)
  }
  fn.calls = calls
  fn.callCount = () => calls.length
  fn.lastCall = () => calls[calls.length - 1]
  return fn
}

/**
 * Build a mock Backend with all required methods as spies.
 * Pass per-method overrides via `overrides` to customise return values.
 */
function createMockBackend(overrides = {}) {
  return {
    createEnvironment: spy({ containerId: 'mock-ctr-123', containerCliPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js' }),
    createComposeEnvironment: spy({ containerId: 'mock-compose-ctr', containerCliPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', services: [{ name: 'app', status: 'running', primary: false }] }),
    destroyEnvironment: spy(undefined),
    destroyComposeEnvironment: spy(undefined),
    removeImage: spy(undefined),
    execInEnvironment: spy({ stdout: '', stderr: '' }),
    getEnvironmentStatus: spy(true),
    listEnvironments: spy([]),
    commitEnvironment: spy('sha256:mock-commit'),
    renameEnvironment: spy(undefined),
    restoreEnvironment: spy('mock-restore-ctr'),
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// create() — delegates to backend.createEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.create() → backend.createEnvironment()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seam-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls backend.createEnvironment with resolved options', async () => {
    const backend = createMockBackend()
    const manager = new EnvironmentManager({ statePath, backend })

    const env = await manager.create({
      name: 'test-env',
      cwd: '/home/user/project',
    })

    assert.equal(backend.createEnvironment.callCount(), 1)

    const [opts] = backend.createEnvironment.lastCall()
    assert.ok(opts.envId.startsWith('env-'))
    assert.equal(opts.cwd, '/home/user/project')
    assert.equal(opts.image, 'node:22-slim')        // resolved default
    assert.equal(opts.memoryLimit, '2g')             // resolved default
    assert.equal(opts.cpuLimit, '2')                 // resolved default
    assert.equal(opts.containerUser, 'chroxy')       // resolved default

    // Manager uses the containerId returned by the backend
    assert.equal(env.containerId, 'mock-ctr-123')
    assert.equal(env.containerCliPath, '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')
    assert.equal(env.status, 'running')
  })

  it('passes explicit image and resource options through to backend', async () => {
    const backend = createMockBackend()
    const manager = new EnvironmentManager({ statePath, backend })

    await manager.create({
      name: 'custom-env',
      cwd: '/tmp',
      image: 'ubuntu:22.04',
      memoryLimit: '4g',
      cpuLimit: '4',
      containerUser: 'myuser',
    })

    const [opts] = backend.createEnvironment.lastCall()
    assert.equal(opts.image, 'ubuntu:22.04')
    assert.equal(opts.memoryLimit, '4g')
    assert.equal(opts.cpuLimit, '4')
    assert.equal(opts.containerUser, 'myuser')
  })

  it('does NOT call any Docker shellout directly (only backend methods)', async () => {
    let execFileCalled = false
    const mockExecFile = () => { execFileCalled = true }
    const backend = createMockBackend()

    // Even when _execFile is injected, with a backend provided,
    // _execFile must not be called for normal create operations.
    const manager = new EnvironmentManager({ statePath, backend, _execFile: mockExecFile })

    await manager.create({ name: 'no-direct-exec', cwd: '/tmp' })

    assert.equal(execFileCalled, false, 'should not call execFile directly — all Docker calls go through the backend')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// create() with compose — delegates to backend.createComposeEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.create() with compose → backend.createComposeEnvironment()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seam-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls backend.createComposeEnvironment with composeFile and composeProject', async () => {
    const backend = createMockBackend()
    const manager = new EnvironmentManager({ statePath, backend })

    const env = await manager.create({
      name: 'compose-env',
      cwd: '/home/user/project',
      compose: '/home/user/project/docker-compose.yml',
      primaryService: 'app',
    })

    assert.equal(backend.createComposeEnvironment.callCount(), 1)
    assert.equal(backend.createEnvironment.callCount(), 0, 'should NOT call createEnvironment for compose envs')

    const [opts] = backend.createComposeEnvironment.lastCall()
    assert.equal(opts.composeFile, '/home/user/project/docker-compose.yml')
    assert.ok(opts.composeProject.startsWith('chroxy-env-'))
    assert.equal(opts.primaryService, 'app')
    assert.equal(opts.containerUser, 'chroxy')

    assert.equal(env.image, 'compose')
    assert.equal(env.containerId, 'mock-compose-ctr')
    assert.equal(env.services.length, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// destroy() — delegates to backend.destroyEnvironment or destroyComposeEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.destroy() → backend.destroyEnvironment()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seam-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls backend.destroyEnvironment with the container ID', async () => {
    const backend = createMockBackend()
    const manager = new EnvironmentManager({ statePath, backend })

    const env = await manager.create({ name: 'to-destroy', cwd: '/tmp' })
    backend.destroyEnvironment.calls.length = 0 // reset — any calls from create are irrelevant

    await manager.destroy(env.id)

    assert.equal(backend.destroyEnvironment.callCount(), 1)
    const [containerId] = backend.destroyEnvironment.lastCall()
    assert.equal(containerId, 'mock-ctr-123')
  })

  it('calls backend.destroyComposeEnvironment for compose environments', async () => {
    const backend = createMockBackend()
    const manager = new EnvironmentManager({ statePath, backend })

    const env = await manager.create({
      name: 'compose-destroy',
      cwd: '/tmp',
      compose: '/tmp/docker-compose.yml',
    })

    backend.destroyComposeEnvironment.calls.length = 0

    await manager.destroy(env.id)

    assert.equal(backend.destroyComposeEnvironment.callCount(), 1)
    assert.equal(backend.destroyEnvironment.callCount(), 0, 'should NOT call destroyEnvironment for compose')

    const [opts] = backend.destroyComposeEnvironment.lastCall()
    assert.equal(opts.composeFile, '/tmp/docker-compose.yml')
    assert.ok(opts.composeProject.startsWith('chroxy-'))
  })

  it('calls backend.removeImage for each snapshot when destroying', async () => {
    const backend = createMockBackend({
      commitEnvironment: spy('sha256:snap'),
    })
    const manager = new EnvironmentManager({ statePath, backend })

    const env = await manager.create({ name: 'snap-env', cwd: '/tmp' })
    const snap1 = await manager.snapshot(env.id, { name: 'snap-a' })
    const snap2 = await manager.snapshot(env.id, { name: 'snap-b' })

    backend.removeImage.calls.length = 0

    await manager.destroy(env.id)

    assert.equal(backend.removeImage.callCount(), 2)
    const removedImages = backend.removeImage.calls.map(c => c[0])
    assert.ok(removedImages.includes(snap1.image))
    assert.ok(removedImages.includes(snap2.image))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// snapshot() — delegates to backend.commitEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.snapshot() → backend.commitEnvironment()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seam-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls backend.commitEnvironment with containerId and generated imageTag', async () => {
    const backend = createMockBackend({
      commitEnvironment: spy('sha256:snap-abc'),
    })
    const manager = new EnvironmentManager({ statePath, backend })

    const env = await manager.create({ name: 'snap-test', cwd: '/tmp' })
    const snap = await manager.snapshot(env.id, { name: 'my-snap' })

    assert.equal(backend.commitEnvironment.callCount(), 1)
    const [containerId, imageTag] = backend.commitEnvironment.lastCall()
    assert.equal(containerId, 'mock-ctr-123')
    assert.ok(imageTag.startsWith('chroxy-env:'))
    assert.ok(imageTag.includes(env.id))

    // Snap metadata stored correctly
    assert.equal(snap.name, 'my-snap')
    assert.equal(snap.image, imageTag)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// restore() — delegates to backend.restoreEnvironment, getEnvironmentStatus, destroyEnvironment, renameEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.restore() → backend methods', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seam-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls renameEnvironment, restoreEnvironment, getEnvironmentStatus, destroyEnvironment in order', async () => {
    const callOrder = []

    const backend = createMockBackend({
      commitEnvironment: spy('sha256:snap'),
      renameEnvironment: spy(() => { callOrder.push('rename'); return Promise.resolve() }),
      restoreEnvironment: spy(() => { callOrder.push('restoreEnvironment'); return Promise.resolve('new-restore-ctr') }),
      getEnvironmentStatus: spy(() => { callOrder.push('getStatus'); return Promise.resolve(true) }),
      destroyEnvironment: spy(() => { callOrder.push('destroy'); return Promise.resolve() }),
    })

    const manager = new EnvironmentManager({ statePath, backend })
    const env = await manager.create({ name: 'restore-test', cwd: '/tmp' })
    const snap = await manager.snapshot(env.id, { name: 'before' })

    // Reset call order tracking
    callOrder.length = 0

    const restored = await manager.restore(env.id, snap.id)

    assert.equal(restored.containerId, 'new-restore-ctr')
    assert.equal(restored.status, 'running')

    // Must rename before starting new container
    assert.equal(callOrder[0], 'rename', 'rename must be first')
    assert.equal(callOrder[1], 'restoreEnvironment', 'restoreEnvironment must be second')
    assert.equal(callOrder[2], 'getStatus', 'getStatus must be third (health check)')
    assert.equal(callOrder[3], 'destroy', 'destroy old container must be last')
  })

  it('calls destroyEnvironment on the NEW container (not old) when health check fails', async () => {
    const destroyedContainers = []

    const backend = createMockBackend({
      commitEnvironment: spy('sha256:snap'),
      renameEnvironment: spy(undefined),
      restoreEnvironment: spy(() => Promise.resolve('bad-new-ctr')),
      getEnvironmentStatus: spy(() => Promise.resolve(false)),  // health check fails
      destroyEnvironment: spy((cid) => {
        destroyedContainers.push(cid)
        return Promise.resolve()
      }),
    })

    const manager = new EnvironmentManager({ statePath, backend })
    const env = await manager.create({ name: 'hc-fail', cwd: '/tmp' })
    const snap = await manager.snapshot(env.id, { name: 'snap' })

    destroyedContainers.length = 0

    await assert.rejects(
      () => manager.restore(env.id, snap.id),
      /health check failed/i
    )

    // The BAD new container should be cleaned up, not the original
    assert.ok(destroyedContainers.includes('bad-new-ctr'), 'failed new container should be cleaned up')
    assert.ok(!destroyedContainers.includes('mock-ctr-123'), 'original container should be preserved')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// reconnect() — delegates to backend.getEnvironmentStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.reconnect() → backend.getEnvironmentStatus()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seam-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls backend.getEnvironmentStatus for each persisted environment', async () => {
    const { writeFileSync } = await import('fs')
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      environments: [
        { id: 'env-a', name: 'a', cwd: '/tmp', image: 'node:22-slim', containerId: 'ctr-a', containerUser: 'chroxy', containerCliPath: '/usr/local/cli.js', status: 'running', sessions: [], createdAt: '2026-03-01T00:00:00Z', memoryLimit: '2g', cpuLimit: '2' },
        { id: 'env-b', name: 'b', cwd: '/tmp', image: 'node:22-slim', containerId: 'ctr-b', containerUser: 'chroxy', containerCliPath: '/usr/local/cli.js', status: 'running', sessions: [], createdAt: '2026-03-01T00:00:00Z', memoryLimit: '2g', cpuLimit: '2' },
      ],
    }))

    const backend = createMockBackend({
      getEnvironmentStatus: spy(true),
    })
    const manager = new EnvironmentManager({ statePath, backend })

    await manager.reconnect()

    assert.equal(backend.getEnvironmentStatus.callCount(), 2)
    const inspectedIds = backend.getEnvironmentStatus.calls.map(c => c[0])
    assert.ok(inspectedIds.includes('ctr-a'))
    assert.ok(inspectedIds.includes('ctr-b'))
  })

  it('marks status running/stopped based on backend.getEnvironmentStatus', async () => {
    const { writeFileSync } = await import('fs')
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      environments: [
        { id: 'env-run', name: 'run', cwd: '/tmp', image: 'node:22-slim', containerId: 'run-ctr', containerUser: 'chroxy', containerCliPath: '/usr/local/cli.js', status: 'unknown', sessions: [], createdAt: '2026-03-01T00:00:00Z', memoryLimit: '2g', cpuLimit: '2' },
        { id: 'env-stop', name: 'stop', cwd: '/tmp', image: 'node:22-slim', containerId: 'stop-ctr', containerUser: 'chroxy', containerCliPath: '/usr/local/cli.js', status: 'unknown', sessions: [], createdAt: '2026-03-01T00:00:00Z', memoryLimit: '2g', cpuLimit: '2' },
      ],
    }))

    const backend = createMockBackend({
      getEnvironmentStatus: spy((cid) => Promise.resolve(cid === 'run-ctr')),
    })
    const manager = new EnvironmentManager({ statePath, backend })

    await manager.reconnect()

    assert.equal(manager.get('env-run').status, 'running')
    assert.equal(manager.get('env-stop').status, 'stopped')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// reconcile() — delegates to backend.listEnvironments + destroyEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('EnvironmentManager.reconcile() → backend.listEnvironments() + destroyEnvironment()', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seam-test-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls backend.listEnvironments to find orphaned containers', async () => {
    const backend = createMockBackend({
      listEnvironments: spy(['orphan-1', 'orphan-2']),
    })
    const manager = new EnvironmentManager({ statePath, backend })

    await manager.reconcile()

    assert.equal(backend.listEnvironments.callCount(), 1)
    assert.equal(backend.destroyEnvironment.callCount(), 2)

    const removedIds = backend.destroyEnvironment.calls.map(c => c[0])
    assert.ok(removedIds.includes('orphan-1'))
    assert.ok(removedIds.includes('orphan-2'))
  })

  it('does NOT call destroyEnvironment for known containers', async () => {
    // Seed a known environment
    const backend = createMockBackend({
      getEnvironmentStatus: spy(true),
      listEnvironments: spy(['known-ctr', 'orphan-ctr']),
    })

    const { writeFileSync } = await import('fs')
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      environments: [{
        id: 'env-known', name: 'known', cwd: '/tmp', image: 'node:22-slim',
        containerId: 'known-ctr', containerUser: 'chroxy', containerCliPath: '/usr/local/cli.js',
        status: 'running', sessions: [], createdAt: '2026-03-01T00:00:00Z', memoryLimit: '2g', cpuLimit: '2',
      }],
    }))

    const manager = new EnvironmentManager({ statePath, backend })
    await manager.reconnect()
    backend.destroyEnvironment.calls.length = 0

    await manager.reconcile()

    // Only the orphan should be destroyed
    assert.equal(backend.destroyEnvironment.callCount(), 1)
    const [removedId] = backend.destroyEnvironment.lastCall()
    assert.equal(removedId, 'orphan-ctr')
  })

  it('handles listEnvironments failure gracefully (best-effort)', async () => {
    const backend = createMockBackend({
      listEnvironments: spy(() => Promise.reject(new Error('Docker not available'))),
    })
    const manager = new EnvironmentManager({ statePath, backend })

    // Must not throw
    await assert.doesNotReject(() => manager.reconcile())
    assert.equal(backend.destroyEnvironment.callCount(), 0)
  })
})
