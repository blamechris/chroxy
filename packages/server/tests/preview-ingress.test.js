import { it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, chmod, lstat, rename, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createPreviewIngress } from '../src/preview-ingress.js'

// A separate process keeps a blocking open from hanging the test runner.
// The watchdog is an assertion outcome, independent of the suite's timeout.
async function attempt(saved) {
  const source = `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { EventEmitter } from 'node:events'
    import { PreviewTunnelAdapter } from ${JSON.stringify(new URL('../src/tunnel/preview.js', import.meta.url).href)}
    import { CloudflareTunnelAdapter } from ${JSON.stringify(new URL('../src/tunnel/cloudflare.js', import.meta.url).href)}
    let reads = 0, spawned = 0, error = null
    const read = fs.readFileSync
    fs.readFileSync = (...args) => { if (typeof args[0] === 'number') reads++; return read(...args) }
    syncBuiltinESMExports()
    CloudflareTunnelAdapter.prototype._spawnCloudflared = () => { spawned++; return new EventEmitter() }
    const adapter = new PreviewTunnelAdapter({ config: { previewIngress: JSON.parse(process.env.CHROXY_TEST_PREVIEW_INGRESS) } })
    try { adapter._spawnCloudflared(adapter._quickTunnelArguments(), {}) } catch (caught) { error = caught.message }
    console.log(JSON.stringify({ reads, spawned, error }))
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', new URL('./_setup.mjs', import.meta.url).href, '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CHROXY_TEST_PREVIEW_INGRESS: JSON.stringify(saved) } })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => { timedOut = true
    child.kill('SIGKILL') }, 2000)
    child.once('error', error => { clearTimeout(timer)
    reject(error) })
    child.once('close', code => { clearTimeout(timer)
    resolve({ timedOut, code, stdout, stderr }) })
  })
}

async function result(saved) {
  const outcome = await attempt(saved)
  assert.equal(outcome.timedOut, false, 'ingress admission must finish without waiting for a FIFO writer')
  assert.equal(outcome.code, 0, outcome.stderr)
  return JSON.parse(outcome.stdout)
}

it('adapter refuses nonregular or changed config before reading, and admits the real owned config', { skip: !['darwin', 'linux'].includes(process.platform), timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'preview-ingress-test-'))
  await chmod(directory, 0o700)
  const socketPath = join(directory, 'origin.sock')
  const server = createServer()
  try {
    await new Promise((resolve, reject) => { server.once('error', reject)
    server.listen(socketPath, resolve) })
    const saved = await createPreviewIngress(socketPath, await lstat(directory))
    assert.deepEqual(await result(saved), { reads: 1, spawned: 1, error: null })
    for (const key of ['ino', 'uid']) {
      const changed = { ...saved, file: { ...saved.file, [key]: -1 } }
      assert.deepEqual(await result(changed), { reads: 0, spawned: 0, error: 'Preview ingress configuration changed' }, 'changed descriptor identity must be refused before reading')
    }
    await chmod(saved.path, 0o644)
    assert.deepEqual(await result(saved), { reads: 0, spawned: 0, error: 'Preview ingress configuration changed' }, 'nonprivate mode must be refused before reading')
    await chmod(saved.path, 0o600)
    await rename(saved.path, saved.path + '.held')
    try {
      await promisify(execFile)('mkfifo', ['-m', '600', saved.path])
      const fifo = await lstat(saved.path)
      assert.ok(fifo.isFIFO(), 'fixture must be a real FIFO')
      const changed = { ...saved, file: { dev: fifo.dev, ino: fifo.ino, uid: fifo.uid } }
      assert.deepEqual(await result(changed), { reads: 0, spawned: 0, error: 'Preview ingress configuration changed' }, 'nonregular descriptor must be refused before reading')
      await unlink(saved.path)
    } finally { await rename(saved.path + '.held', saved.path) }
    assert.deepEqual(await result(saved), { reads: 1, spawned: 1, error: null }, 'restored owned config must still reach spawn')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
