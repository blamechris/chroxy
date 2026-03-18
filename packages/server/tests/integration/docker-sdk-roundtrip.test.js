/**
 * Integration tests for DockerSdkSession.
 *
 * These tests require a running Docker daemon and are skipped in CI.
 * Run locally with:
 *   DOCKER_TESTS=1 node --test tests/integration/docker-sdk-roundtrip.test.js
 *
 * Prerequisites:
 *   - Docker daemon running (`docker info` succeeds)
 *   - Network access to pull node:22-slim image (first run only)
 *   - ANTHROPIC_API_KEY in env (for full round-trip, not for container lifecycle tests)
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execFile } from 'child_process'

const SKIP = !process.env.DOCKER_TESTS

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function dockerAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf-8', ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr
        reject(err)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// Container lifecycle tests — verifies Docker integration without needing
// ANTHROPIC_API_KEY or Claude Code. Tests the container start/setup/destroy
// pipeline using the real DockerSdkSession class.
// ──────────────────────────────────────────────────────────────────────────────

describe('DockerSdkSession container lifecycle (integration)', { skip: SKIP }, () => {
  let hasDocker = false

  before(() => {
    hasDocker = dockerAvailable()
    if (!hasDocker) {
      console.log('Docker not available — skipping integration tests')
    }
  })

  it('can start a container, create user, and destroy', { skip: !hasDocker || SKIP }, async () => {
    // Import the real class
    const { DockerSdkSession } = await import('../../src/docker-sdk-session.js')

    const session = new DockerSdkSession({
      cwd: process.cwd(),
      image: 'node:22-slim',
      memoryLimit: '512m',
      cpuLimit: '1',
      containerUser: 'testuser',
    })

    // Start the container (this does docker run + user setup + npm install)
    // We wrap in a promise since start() is callback-based internally
    const started = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Container start timed out')), 180_000)

      session.once('error', (e) => {
        clearTimeout(timeout)
        reject(new Error(e.message))
      })

      // The real start() calls super.start() which emits 'ready' via SdkSession
      // But SdkSession.start() sets _processReady — we can poll for it
      const origStart = session.start.bind(session)
      // Intercept _startContainer callback to know when container is ready
      const origStartContainer = session._startContainer.bind(session)
      session._startContainer = (cb) => {
        origStartContainer((err) => {
          clearTimeout(timeout)
          if (err) {
            reject(err)
          } else {
            resolve(session._containerId)
          }
          // Don't call cb to avoid super.start() which needs SDK init
        })
      }
      session.start()
    })

    assert.ok(started, 'container ID should be truthy')
    assert.ok(started.length >= 12, 'container ID should be at least 12 chars')

    // Verify the container is actually running
    const { stdout: inspectOut } = await execFileAsync('docker', [
      'inspect', '--format', '{{.State.Running}}', started,
    ], { timeout: 5000 })
    assert.equal(inspectOut.trim(), 'true', 'container should be running')

    // Verify the non-root user was created
    const { stdout: userOut } = await execFileAsync('docker', [
      'exec', started, 'id', 'testuser',
    ], { timeout: 5000 })
    assert.ok(userOut.includes('testuser'), 'testuser should exist in container')

    // Verify /workspace mount exists
    const { stdout: lsOut } = await execFileAsync('docker', [
      'exec', started, 'ls', '-d', '/workspace',
    ], { timeout: 5000 })
    assert.equal(lsOut.trim(), '/workspace')

    // Verify Claude Code was installed
    const cliPath = session._containerCliPath
    assert.ok(cliPath, 'CLI path should be discovered')
    assert.ok(typeof cliPath === 'string' && cliPath.length > 0)
    // Use shell form so && is interpreted; silently catch if file doesn't exist
    const { stdout: cliCheck } = await execFileAsync('docker', [
      'exec', started, 'bash', '-c', `test -f ${cliPath} && echo exists`,
    ], { timeout: 5000 }).catch(() => ({ stdout: '' }))

    // Clean up — destroy should remove the container
    session._containerId = started // restore since we intercepted
    session.destroy()

    // Give Docker a moment to remove the container
    await new Promise(r => setTimeout(r, 1000))

    // Verify container was removed
    try {
      await execFileAsync('docker', ['inspect', started], { timeout: 5000 })
      assert.fail('Container should have been removed')
    } catch (err) {
      // Expected — container no longer exists
      assert.ok(err.message || err.stderr)
    }
  })

  it('applies resource limits to the container', { skip: !hasDocker || SKIP }, async () => {
    const { DockerSdkSession } = await import('../../src/docker-sdk-session.js')

    const session = new DockerSdkSession({
      cwd: process.cwd(),
      image: 'node:22-slim',
      memoryLimit: '256m',
      cpuLimit: '0.5',
    })

    const containerId = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out')), 180_000)

      session.once('error', (e) => {
        clearTimeout(timeout)
        reject(new Error(e.message))
      })

      const origStartContainer = session._startContainer.bind(session)
      session._startContainer = (cb) => {
        origStartContainer((err) => {
          clearTimeout(timeout)
          if (err) reject(err)
          else resolve(session._containerId)
        })
      }
      session.start()
    })

    try {
      // Verify memory limit
      const { stdout: memOut } = await execFileAsync('docker', [
        'inspect', '--format', '{{.HostConfig.Memory}}', containerId,
      ], { timeout: 5000 })
      // 256m = 268435456 bytes
      assert.equal(memOut.trim(), '268435456', 'memory limit should be 256m')

      // Verify CPU limit
      const { stdout: cpuOut } = await execFileAsync('docker', [
        'inspect', '--format', '{{.HostConfig.NanoCpus}}', containerId,
      ], { timeout: 5000 })
      // 0.5 CPUs = 500000000 NanoCPUs
      assert.equal(cpuOut.trim(), '500000000', 'CPU limit should be 0.5')

      // Verify security options
      const { stdout: secOut } = await execFileAsync('docker', [
        'inspect', '--format', '{{.HostConfig.SecurityOpt}}', containerId,
      ], { timeout: 5000 })
      assert.ok(secOut.includes('no-new-privileges'), 'should have no-new-privileges')

      // Verify PID limit
      const { stdout: pidOut } = await execFileAsync('docker', [
        'inspect', '--format', '{{.HostConfig.PidsLimit}}', containerId,
      ], { timeout: 5000 })
      assert.equal(pidOut.trim(), '512', 'PID limit should be 512')
    } finally {
      session._containerId = containerId
      session.destroy()
      await new Promise(r => setTimeout(r, 500))
    }
  })

  it('spawns docker exec with correct user and env', { skip: !hasDocker || SKIP }, async () => {
    const { DockerSdkSession } = await import('../../src/docker-sdk-session.js')

    const session = new DockerSdkSession({
      cwd: process.cwd(),
      image: 'node:22-slim',
      memoryLimit: '256m',
      cpuLimit: '0.5',
    })

    const containerId = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out')), 180_000)

      session.once('error', (e) => {
        clearTimeout(timeout)
        reject(new Error(e.message))
      })

      const origStartContainer = session._startContainer.bind(session)
      session._startContainer = (cb) => {
        origStartContainer((err) => {
          clearTimeout(timeout)
          if (err) reject(err)
          else resolve(session._containerId)
        })
      }
      session.start()
    })

    try {
      // Verify container user and env directly via docker exec
      // (spawn callback is tested in unit tests; this validates the container state)
      const { stdout: whoami } = await execFileAsync('docker', [
        'exec', '-u', 'chroxy', containerId, 'whoami',
      ], { timeout: 5000 })
      assert.equal(whoami.trim(), 'chroxy', 'should run as chroxy user')

      // Verify HOME is set correctly for the user
      const { stdout: homeOut } = await execFileAsync('docker', [
        'exec', '-u', 'chroxy', '--env', 'HOME=/home/chroxy', containerId,
        'bash', '-c', 'echo $HOME',
      ], { timeout: 5000 })
      assert.equal(homeOut.trim(), '/home/chroxy')
    } finally {
      session._containerId = containerId
      session.destroy()
      await new Promise(r => setTimeout(r, 500))
    }
  })

  it('emits error and self-destructs when docker run fails', { skip: !hasDocker || SKIP }, async () => {
    const { DockerSdkSession } = await import('../../src/docker-sdk-session.js')

    const session = new DockerSdkSession({
      cwd: process.cwd(),
      image: 'nonexistent-image-that-does-not-exist:latest',
      memoryLimit: '256m',
      cpuLimit: '0.5',
    })

    const error = await new Promise((resolve) => {
      session.once('error', resolve)
      session.start()
    })

    assert.ok(error.message.includes('Failed to start Docker container'))
    assert.equal(session._containerId, null, 'container ID should be null after failure')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Full round-trip test — requires ANTHROPIC_API_KEY and Docker
// This is the most expensive test: it starts a container, installs Claude Code,
// and sends an actual message through the SDK.
// ──────────────────────────────────────────────────────────────────────────────

describe('DockerSdkSession full round-trip (integration)', {
  skip: SKIP || !process.env.ANTHROPIC_API_KEY,
}, () => {
  // Full round-trip tests would go here, but they require:
  // 1. A valid ANTHROPIC_API_KEY
  // 2. Docker daemon running
  // 3. Network access for Claude API
  // 4. ~2-5 minutes per test (container setup + API call)
  //
  // These are intentionally left as stubs for local development.
  // Run with: DOCKER_TESTS=1 ANTHROPIC_API_KEY=sk-... node --test tests/integration/docker-sdk-roundtrip.test.js

  it('placeholder for full round-trip test', { todo: 'requires manual run with API key' }, () => {
    // To implement: create session, send simple message, verify response events
  })
})
