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
 * Skipped when RUN_K8S_INTEGRATION is unset. An opted-in run fails if kind is missing.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { loadNamedKindKubeconfig } from './k8s-kind-kubeconfig.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ─── skip guards ─────────────────────────────────────────────────────────────

const SHOULD_RUN = process.env.RUN_K8S_INTEGRATION === '1'

// Only probe for `kind` when actually running — avoids spawning a child process
// during the default `npm test` glob. Bound the probe with a short timeout so a
// hung `kind` binary cannot stall test discovery.
const KIND_AVAILABLE = SHOULD_RUN
  ? (() => {
      try {
        execSync('kind version', { stdio: 'pipe', timeout: 5_000 })
        return true
      } catch {
        return false
      }
    })()
  : false

if (!SHOULD_RUN) {
  console.log('[k8s-integration] Skipped — set RUN_K8S_INTEGRATION=1 to run')
} else if (!KIND_AVAILABLE) {
  throw new Error('K8s integration requested but kind is missing or kind version failed')
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

  describe('K8s sidecar roundtrip (integration)', { timeout: CLUSTER_BOOT_TIMEOUT + 180_000 }, () => {

    /** The backend under test, created once per suite. */
    let backend
    /** Pod name returned by createEnvironment. */
    let podName
    /** envId used to derive pod name and secret name. */
    let envId
    /** Private temporary kubeconfig for the named kind cluster. */
    let kubeconfigDir

    // ── before: bootstrap cluster + image ──────────────────────────────────

    before(async () => {
      console.log(`[k8s-integration] Creating kind cluster "${CLUSTER_NAME}" …`)
      execFileSync('kind', ['create', 'cluster', '--name', CLUSTER_NAME], {
        stdio: 'inherit', timeout: CLUSTER_BOOT_TIMEOUT,
      })
      console.log('[k8s-integration] Cluster ready')

      // Use the kubeconfig exported by this exact cluster. The client library's
      // loadFromDefault() silently falls back to http://localhost:8080 when it
      // cannot find a file; that fallback made the nightly fail before Pod
      // creation. Keep the exported CA and client credentials intact.
      const kubeconfig = loadNamedKindKubeconfig(CLUSTER_NAME)
      kubeconfigDir = mkdtempSync(join(tmpdir(), 'chroxy-kind-'))
      const kubeconfigPath = join(kubeconfigDir, 'config')
      writeFileSync(kubeconfigPath, kubeconfig, { mode: 0o600 })
      console.log(`[k8s-integration] Using verified HTTPS kubeconfig for kind-${CLUSTER_NAME}`)

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
      // Pass the named-cluster config explicitly instead of relying on the
      // runner's default kubeconfig or current context.
      // imagePullPolicy: 'IfNotPresent' prevents kind from trying to pull the
      // locally-loaded image from a remote registry (which would fail for a
      // test-only image that doesn't exist in any public registry).
      const { K8sBackend } = await import('../../src/environments/backends/k8s.js')
      backend = new K8sBackend({
        connectMode: 'portforward',
        kubeconfigPath,
        sidecarImage: SIDECAR_IMAGE,
        imagePullPolicy: 'IfNotPresent',
      })

    })

    // ── after: cleanup unconditionally ─────────────────────────────────────

    after(async () => {
      if (_cleanedUp) return
      _cleanedUp = true

      // Best-effort pod cleanup — the test may have already done it
      if (backend && podName) {
        try { await backend.destroyEnvironment(podName) } catch { /* ignore */ }
      }

      await deleteCluster()
      if (kubeconfigDir) rmSync(kubeconfigDir, { recursive: true, force: true })

      // Best-effort host image cleanup — kind loads the image into its own
      // node container, so the host copy is no longer needed once the cluster
      // is gone. Re-runs rebuild from cache anyway.
      try {
        execFileSync('docker', ['rmi', SIDECAR_IMAGE], {
          stdio: 'pipe', timeout: 10_000,
        })
      } catch {
        // Image may already be gone or in use — ignore
      }
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
      let stderrBuf = ''

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

        // Collect sidecar stderr — includes the per-spawn sentinel line (#3344).
        proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString() })

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

      // The sidecar must emit a per-spawn sentinel as the first stderr frame (#3344).
      // This proves the chroxy-pod-agent handled the spawn (not a shorter path).
      assert.ok(
        stderrBuf.includes('[chroxy-pod-agent] spawn cmd=node'),
        `proc.stderr must contain sidecar sentinel line. Got: ${JSON.stringify(stderrBuf)}`
      )
    })

    // ── test 4: destroyEnvironment removes the Pod ─────────────────────────

    it('destroyEnvironment deletes the Pod', { timeout: 60_000 }, async () => {
      assert.ok(podName, 'Pod must exist from previous test')

      await backend.destroyEnvironment(podName)

      // Pod should no longer exist. Require the API's 404 specifically; the
      // earlier try/catch also caught its own assert.fail and passed vacuously.
      await assert.rejects(
        () => backend.getEnvironmentStatus(podName),
        err => [err?.code, err?.statusCode, err?.response?.statusCode, err?.body?.code].includes(404),
        'getEnvironmentStatus should report a 404 after pod deletion',
      )

      // Clear so `after` does not double-delete
      podName = null
    })

  })

}
