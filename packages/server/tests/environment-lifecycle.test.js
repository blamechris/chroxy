/**
 * #6134 (epic #5530) — EnvironmentManager stop/restart + DockerBackend
 * lifecycle methods.
 *
 * Pins the behaviour the containers_action handler builds on:
 *   - stop(): backend.stopEnvironment(containerId) + status→'stopped' + persist;
 *     no-op (returns current status, no second backend call) when already stopped.
 *   - restart(): backend.restartEnvironment(containerId) + status→'running'.
 *   - unknown env / compose env / a backend lacking the method → throws.
 *   - DockerBackend.{stop,start,restart}Environment exec `docker <verb> <id>` and
 *     REJECT on failure (unlike the swallowing destroy path).
 *
 * Never touches real docker — a stub backend / injected `_execFile` cans every
 * call.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EnvironmentManager } from '../src/environment-manager.js'
import { DockerBackend } from '../src/environments/backends/docker.js'

function lifecycleBackend() {
  const calls = []
  return {
    calls,
    async createEnvironment(opts) {
      calls.push({ method: 'create', opts })
      return { containerId: 'stub-container-id', containerCliPath: '/cli.js' }
    },
    async stopEnvironment(containerId) { calls.push({ method: 'stop', containerId }) },
    async restartEnvironment(containerId) { calls.push({ method: 'restart', containerId }) },
    async destroyEnvironment(containerId) { calls.push({ method: 'destroy', containerId }) },
  }
}

describe('#6134 EnvironmentManager.stop / restart', () => {
  let tmpDir, statePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-lifecycle-'))
    statePath = join(tmpDir, 'environments.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function createRunning(backend) {
    const manager = new EnvironmentManager({ statePath, backend })
    const env = await manager.create({ name: 'web', cwd: '/tmp' })
    return { manager, id: env.id }
  }

  it('stop() calls the backend, flips status to stopped, and returns it', async () => {
    const backend = lifecycleBackend()
    const { manager, id } = await createRunning(backend)
    const status = await manager.stop(id)
    assert.equal(status, 'stopped')
    assert.equal(manager.get(id).status, 'stopped')
    assert.deepEqual(backend.calls.filter((c) => c.method === 'stop'), [{ method: 'stop', containerId: 'stub-container-id' }])
  })

  it('stop() is a no-op when already stopped (no second backend call)', async () => {
    const backend = lifecycleBackend()
    const { manager, id } = await createRunning(backend)
    await manager.stop(id)
    const status = await manager.stop(id)
    assert.equal(status, 'stopped')
    assert.equal(backend.calls.filter((c) => c.method === 'stop').length, 1, 'backend.stop must run only once')
  })

  it('restart() calls the backend and ends running', async () => {
    const backend = lifecycleBackend()
    const { manager, id } = await createRunning(backend)
    await manager.stop(id)
    const status = await manager.restart(id)
    assert.equal(status, 'running')
    assert.equal(manager.get(id).status, 'running')
    assert.ok(backend.calls.some((c) => c.method === 'restart' && c.containerId === 'stub-container-id'))
  })

  it('destroy() removes the container even when the env was stopped (#6134 no orphan)', async () => {
    const backend = lifecycleBackend()
    const { manager, id } = await createRunning(backend)
    await manager.stop(id)
    await manager.destroy(id)
    // The stopped container must still be `docker rm -f`'d — not orphaned.
    assert.ok(
      backend.calls.some((c) => c.method === 'destroy' && c.containerId === 'stub-container-id'),
      'destroy must remove a stopped container, not just drop the manager entry',
    )
    assert.equal(manager.get(id), null)
  })

  it('stop() throws for an unknown environment', async () => {
    const backend = lifecycleBackend()
    const manager = new EnvironmentManager({ statePath, backend })
    await assert.rejects(() => manager.stop('nope'), /Environment not found/)
  })

  it('stop() throws when the backend does not implement the lifecycle', async () => {
    // A backend with only createEnvironment (e.g. k8s/rancher today).
    const backend = {
      async createEnvironment() { return { containerId: 'c', containerCliPath: '/cli.js' } },
    }
    const manager = new EnvironmentManager({ statePath, backend })
    const env = await manager.create({ name: 'web', cwd: '/tmp' })
    await assert.rejects(() => manager.stop(env.id), /not supported on this environment backend/)
  })

  it('stop()/restart() reject compose environments', async () => {
    const backend = lifecycleBackend()
    const manager = new EnvironmentManager({ statePath, backend })
    // Seed a compose env directly (create() compose path needs a real compose file).
    manager._environments.set('cmp', {
      id: 'cmp', name: 'stack', cwd: '/tmp', compose: 'docker-compose.yml',
      composeProject: 'chroxy-cmp', status: 'running', containerId: null, sessions: [],
    })
    await assert.rejects(() => manager.stop('cmp'), /not supported for compose/)
    await assert.rejects(() => manager.restart('cmp'), /not supported for compose/)
  })
})

describe('#6134 DockerBackend lifecycle execs', () => {
  it('stop/start/restart exec `docker <verb> <id>` and resolve on success', async () => {
    const execCalls = []
    const backend = new DockerBackend({
      _execFile: (file, args, opts, cb) => { execCalls.push({ file, args }); cb(null) },
    })
    await backend.stopEnvironment('abc123')
    await backend.startEnvironment('abc123')
    await backend.restartEnvironment('abc123')
    assert.deepEqual(execCalls.map((c) => c.args), [
      ['stop', 'abc123'],
      ['start', 'abc123'],
      ['restart', 'abc123'],
    ])
    assert.ok(execCalls.every((c) => c.file === 'docker'))
  })

  it('REJECTS on a docker failure (unlike the swallowing destroy path)', async () => {
    const backend = new DockerBackend({
      _execFile: (file, args, opts, cb) => cb(new Error('No such container')),
    })
    await assert.rejects(() => backend.stopEnvironment('gone'), /docker stop failed: No such container/)
  })
})
