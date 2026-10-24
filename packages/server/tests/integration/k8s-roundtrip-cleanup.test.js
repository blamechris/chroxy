import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./fixtures/k8s-cleanup-child.mjs', import.meta.url))

function runFixture(root, { signal, failKind = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture], {
      env: {
        ...process.env,
        K8S_CLEANUP_FIXTURE_ROOT: root,
        K8S_CLEANUP_FAIL_KIND: failKind ? '1' : '0',
        K8S_CLEANUP_MANUAL: signal ? '0' : '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let sent = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`cleanup fixture timed out: ${output.slice(-300)}`))
    }, 5_000)
    child.stdout.on('data', chunk => {
      output += chunk
      if (signal && output.includes('READY') && !sent) {
        sent = true
        child.kill(signal)
      }
    })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', (code, endedBy) => {
      clearTimeout(timer)
      resolve({ code, endedBy, output })
    })
  })
}

function assertCleanup(root) {
  assert.equal(existsSync(join(root, 'kubeconfig')), false, 'temporary kubeconfig must be removed')
  assert.deepEqual(readFileSync(join(root, 'commands'), 'utf8').trim().split('\n'), [
    'kind delete cluster --name fixture-cluster timeout=60000',
    'docker rmi fixture-image timeout=10000',
  ])
}

describe('K8s roundtrip cleanup', () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    it(`removes the kubeconfig and cluster on ${signal}`, {
      skip: process.platform === 'win32' ? 'POSIX signal delivery' : false,
    }, async () => {
      const root = mkdtempSync(join(tmpdir(), 'chroxy-k8s-cleanup-'))
      try {
        const result = await runFixture(root, { signal, failKind: signal === 'SIGTERM' })
        assert.equal(result.endedBy, null, `handler should exit after cleanup: ${result.output}`)
        assert.equal(result.code, signal === 'SIGINT' ? 130 : 143)
        assertCleanup(root)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('runs the same cleanup once on normal completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chroxy-k8s-cleanup-'))
    try {
      const result = await runFixture(root)
      assert.equal(result.code, 0, result.output)
      assertCleanup(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
