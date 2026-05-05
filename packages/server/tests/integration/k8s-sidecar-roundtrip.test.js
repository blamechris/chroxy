/**
 * K8s sidecar integration test — end-to-end roundtrip through K8sBackend.
 *
 * Prerequisites: kind, Docker daemon
 * Run with:
 *   RUN_K8S_INTEGRATION=1 npm run test:integration:k8s
 *   or
 *   RUN_K8S_INTEGRATION=1 node --test packages/server/tests/integration/k8s-sidecar-roundtrip.test.js
 *
 * Expected runtime: ~2-3 minutes including cluster bootstrap.
 * Skipped silently when RUN_K8S_INTEGRATION is unset or kind is not on PATH.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync, execFileSync, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ─── skip guards ─────────────────────────────────────────────────────────────

const SHOULD_RUN = process.env.RUN_K8S_INTEGRATION === '1'

const KIND_AVAILABLE = (() => {
  try { execSync('kind version', { stdio: 'pipe' }); return true } catch { return false }
})()

if (!SHOULD_RUN || !KIND_AVAILABLE) {
  console.log('[k8s-integration] Skipped — set RUN_K8S_INTEGRATION=1 and install kind to run')
  // No tests registered → file passes vacuously
} else {

  // ─── constants ─────────────────────────────────────────────────────────────

  const CLUSTER_NAME = `chroxy-test-${process.pid}`
  const SIDECAR_IMAGE = 'chroxy-pod-agent:test'
  const SIDECAR_DIR = pathResolve(__dirname, '../../sidecar')

  // Timeout constants (ms)
  const CLUSTER_BOOT_TIMEOUT = 180_000   // 3 min — kind pull + start can be slow first time
  const POD_READY_TIMEOUT = 90_000       // 1.5 min — image load + schedule + probes
  const EXEC_TIMEOUT = 30_000
  const STREAM_TIMEOUT = 30_000
  const POD_READY_POLL_MS = 2_000

  // ─── helpers ───────────────────────────────────────────────────────────────

  function execFileAsync(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { encoding: 'utf-8', timeout: 30_000, ...opts }, (err, stdout, stderr) => {
        if (err) { err.stderr = stderr; reject(err) } else resolve({ stdout, stderr })
      })
    })
  }

  /**
   * Poll K8sBackend.getEnvironmentStatus until the Pod is Running or the
   * deadline is exceeded.
   */
  async function waitForPodReady(backend, podName, timeoutMs = POD_READY_TIMEOUT) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const running = await backend.getEnvironmentStatus(podName)
        if (running) return
      } catch {
        // Pod not yet visible to API — keep polling
      }
      await new Promise(r => setTimeout(r, POD_READY_POLL_MS))
    }
    throw new Error(`Pod ${podName} did not become Running within ${timeoutMs}ms`)
  }

  // ─── cluster lifecycle ─────────────────────────────────────────────────────

  /**
   * Unconditionally delete the kind cluster.  Called from `after` and the
   * SIGINT handler so cleanup always runs even on test failure.
   */
  async function deleteCluster() {
    try {
      execFileSync('kind', ['delete', 'cluster', '--name', CLUSTER_NAME], {
        stdio: 'pipe', timeout: 60_000,
      })
      console.log(`[k8s-integration] Deleted cluster ${CLUSTER_NAME}`)
    } catch (err) {
      // Log but never throw — cleanup must be best-effort
      console.warn(`[k8s-integration] Warning: cluster delete failed (may already be gone): ${err.message}`)
    }
  }

  // Register SIGINT handler so Ctrl-C during a long test still cleans up.
  // Guard with a flag so we don't double-delete when after() also runs.
  let _cleanedUp = false
  process.on('SIGINT', async () => {
    if (_cleanedUp) return
    _cleanedUp = true
    console.log('\n[k8s-integration] SIGINT — cleaning up cluster before exit')
    await deleteCluster()
    process.exit(130)
  })

  // ─── test suite ────────────────────────────────────────────────────────────

  describe('K8s sidecar roundtrip (integration)', () => {

    /** The backend under test, created once per suite. */
    let backend
    /** Pod name returned by createEnvironment. */
    let podName
    /** envId used to derive pod name and secret name. */
    let envId

    // ── before: bootstrap cluster + image ──────────────────────────────────

    before(async () => {
      console.log(`[k8s-integration] Creating kind cluster "${CLUSTER_NAME}" …`)
      execFileSync('kind', ['create', 'cluster', '--name', CLUSTER_NAME], {
        stdio: 'inherit', timeout: CLUSTER_BOOT_TIMEOUT,
      })
      console.log('[k8s-integration] Cluster ready')

      console.log('[k8s-integration] Building sidecar image …')
      execFileSync('docker', ['build', '-t', SIDECAR_IMAGE, SIDECAR_DIR], {
        stdio: 'inherit', timeout: 120_000,
      })
      console.log('[k8s-integration] Image built')

      console.log('[k8s-integration] Loading image into kind …')
      execFileSync('kind', [
        'load', 'docker-image', SIDECAR_IMAGE, '--name', CLUSTER_NAME,
      ], { stdio: 'inherit', timeout: 60_000 })
      console.log('[k8s-integration] Image loaded')

      // Instantiate K8sBackend with portforward mode (we are outside the cluster).
      // kind writes a context to ~/.kube/config so loadFromDefault() picks it up.
      const { K8sBackend } = await import('../../src/environments/backends/k8s.js')
      backend = new K8sBackend({
        connectMode: 'portforward',
        sidecarImage: SIDECAR_IMAGE,
      })

      // createEnvironment uses imagePullPolicy defaulting to Always in the spec,
      // but our image is local — we need IfNotPresent so it isn't pulled from a
      // registry that doesn't have it. Patch via a small monkey-patch of the
      // internal api so we can set imagePullPolicy without modifying the backend.
      // We wrap the real createNamespacedPod to inject imagePullPolicy.
      const realCreate = backend._api.createNamespacedPod.bind(backend._api)
      backend._api.createNamespacedPod = ({ namespace, body }) => {
        if (body && body.spec && body.spec.containers) {
          for (const c of body.spec.containers) {
            c.imagePullPolicy = 'IfNotPresent'
          }
        }
        return realCreate({ namespace, body })
      }

    }, CLUSTER_BOOT_TIMEOUT + 180_000)

    // ── after: cleanup unconditionally ─────────────────────────────────────

    after(async () => {
      if (_cleanedUp) return
      _cleanedUp = true

      // Best-effort pod cleanup — the test may have already done it
      if (backend && podName) {
        try { await backend.destroyEnvironment(podName) } catch { /* ignore */ }
      }

      await deleteCluster()
    })

    // ── test 1: createEnvironment creates a Running Pod ────────────────────

    it('createEnvironment creates a Running Pod', { timeout: POD_READY_TIMEOUT + 30_000 }, async () => {
      envId = `it-${process.pid}-${Date.now()}`
      const result = await backend.createEnvironment({
        envId,
        image: SIDECAR_IMAGE,
      })

      assert.ok(result.containerId, 'containerId should be set')
      assert.ok(result.agentToken, 'agentToken should be set')
      assert.ok(result.secretName, 'secretName should be set')

      podName = result.containerId

      // Wait for Pod to be Running before proceeding
      await waitForPodReady(backend, podName)

      const running = await backend.getEnvironmentStatus(podName)
      assert.equal(running, true, 'Pod should be in Running phase')
    })

    // ── test 2: execInEnvironment — plain command roundtrip ────────────────

    it('execInEnvironment runs echo and returns stdout via WS bridge', {
      timeout: EXEC_TIMEOUT + 10_000,
    }, async () => {
      assert.ok(podName, 'Pod must exist from previous test')

      const { stdout } = await backend.execInEnvironment(podName, {
        cmd: 'echo',
        args: ['hello'],
        timeout: EXEC_TIMEOUT,
      })

      assert.ok(
        stdout.includes('hello'),
        `stdout should contain "hello" — got: ${JSON.stringify(stdout)}`
      )
    })

    // ── test 3: streamCliInEnvironment — WS bridge event delivery ──────────

    it('streamCliInEnvironment delivers events over the WS bridge', {
      timeout: STREAM_TIMEOUT + 10_000,
    }, async () => {
      assert.ok(podName, 'Pod must exist from previous test')

      const proc = backend.streamCliInEnvironment(podName, {
        cmd: 'node',
        args: ['-e', 'console.log(JSON.stringify({type:"mock-event",value:42}))'],
        timeout: STREAM_TIMEOUT,
      })

      const frames = []
      let stdoutBuf = ''

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('streamCliInEnvironment timed out')), STREAM_TIMEOUT)

        proc.stdout.on('data', (chunk) => {
          stdoutBuf += chunk.toString()
          // Parse complete NDJSON lines
          const lines = stdoutBuf.split('\n')
          stdoutBuf = lines.pop() // keep incomplete last line
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
              frames.push(JSON.parse(trimmed))
            } catch {
              frames.push(trimmed)
            }
          }
        })

        proc.on('exit', () => {
          clearTimeout(timer)
          resolve()
        })

        proc.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })

      // The sidecar's `event` frame re-serializes each NDJSON stdout line as the
      // payload — K8sBackend pushes `JSON.stringify(payload) + '\n'` onto proc.stdout.
      // So we expect at least one frame whose parsed content contains type:"mock-event".
      assert.ok(frames.length > 0, 'should have received at least one parsed frame')

      const mockEvent = frames.find(f => f && f.type === 'mock-event' && f.value === 42)
      assert.ok(
        mockEvent,
        `should have received mock-event frame through WS bridge. Frames: ${JSON.stringify(frames)}`
      )
    })

    // ── test 4: destroyEnvironment removes the Pod ─────────────────────────

    it('destroyEnvironment deletes the Pod', { timeout: 60_000 }, async () => {
      assert.ok(podName, 'Pod must exist from previous test')

      await backend.destroyEnvironment(podName)

      // Pod should no longer exist (getEnvironmentStatus throws on 404)
      try {
        await backend.getEnvironmentStatus(podName)
        assert.fail('getEnvironmentStatus should have thrown after pod deletion')
      } catch (err) {
        // Any error (404 or "not found") is expected here
        assert.ok(err, 'expected an error after pod deletion')
      }

      // Clear so `after` does not double-delete
      podName = null
    })

  })

}
