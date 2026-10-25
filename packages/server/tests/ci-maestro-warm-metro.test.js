import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const script = resolve(import.meta.dirname, '../../../scripts/maestro-warm-metro.mjs')

async function withMetro(options, verify) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url, accept: req.headers.accept, platform: req.headers['expo-platform'] })
    if (req.url === '/' && options.manifestRedirect) {
      res.writeHead(302, { location: '/redirected-manifest' })
      if (options.manifestRedirectHang) res.write('redirect pending')
      else res.end()
    } else if (req.url === '/' || req.url === '/redirected-manifest') {
      res.writeHead(options.manifestStatus || 200, {
        'content-type': options.manifestType || 'application/expo+json'
      })
      if (options.manifestHang) {
        res.write('{')
        return
      }
      res.end(JSON.stringify(options.manifest?.(server.address().port) ?? {
        launchAsset: {
          contentType: 'application/javascript',
          url: `http://127.0.0.1:${server.address().port}/custom-entry.bundle?platform=ios&dev=true`
        }
      }))
    } else if (req.url?.startsWith('/custom-entry.bundle?') && options.bundleRedirect) {
      res.writeHead(302, { location: '/redirected-bundle' })
      if (options.bundleRedirectHang) res.write('redirect pending')
      else res.end()
    } else if (req.url?.startsWith('/custom-entry.bundle?') || req.url === '/redirected-bundle') {
      res.writeHead(options.bundleStatus || 200, {
        'content-type': options.bundleType || 'application/javascript',
        ...(options.truncate ? { 'content-length': '1000' } : {})
      })
      if (options.truncate) {
        res.write('var incomplete = true;')
        setTimeout(() => res.destroy(), 20)
      } else if (options.hang) {
        res.write('var started = true;')
      } else if (options.delay) {
        res.write('var started = true;')
        setTimeout(() => res.end('var finished = true;'), options.delay)
      } else {
        res.end(options.empty ? '' : 'var bundle = true;')
      }
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    await verify({ origin: `http://127.0.0.1:${server.address().port}`, requests })
  } finally {
    server.closeAllConnections()
    await new Promise(resolveClose => server.close(resolveClose))
  }
}

function run(origin, timeoutMs = 1000, watchdogMs = 8000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, origin], {
      env: { ...process.env, MAESTRO_METRO_TIMEOUT_MS: String(timeoutMs) }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const watchdog = setTimeout(() => child.kill('SIGKILL'), watchdogMs)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(watchdog)
      resolveRun({ code, signal, stdout, stderr })
    })
  })
}

describe('Maestro iOS Metro warmup', () => {
  it('derives the real iOS launch asset and waits for the entire JavaScript body', async () => {
    await withMetro({
      delay: 60, manifestType: 'application/expo+json; charset=utf-8',
      bundleType: 'text/javascript; charset=utf-8'
    }, async ({ origin, requests }) => {
      const started = Date.now()
      const result = await run(origin)
      assert.equal(result.code, 0, result.stderr)
      assert.ok(Date.now() - started >= 60, 'must consume the delayed final bundle chunk')
      assert.ok(result.stdout.includes('iOS Metro bundle ready: 39 bytes'))
      assert.deepEqual(requests.map(request => request.url), [
        '/', '/custom-entry.bundle?platform=ios&dev=true'
      ])
      assert.equal(requests[0].accept, 'application/expo+json')
      assert.equal(requests[0].platform, 'ios')
    })
  })

  it('fails closed on a bad manifest response or absent launch asset', async () => {
    await withMetro({ manifestStatus: 503 }, async ({ origin, requests }) => {
      const result = await run(origin)
      assert.equal(result.code, 1)
      assert.ok(result.stderr.includes('manifest returned HTTP 503'))
      assert.equal(requests.length, 1)
    })
    await withMetro({ manifest: () => ({ launchAsset: null }) }, async ({ origin, requests }) => {
      const result = await run(origin)
      assert.equal(result.code, 1)
      assert.ok(result.stderr.includes('no JavaScript launch asset'))
      assert.equal(requests.length, 1)
    })
    await withMetro({ manifestType: 'application/notexpo+json' }, async ({ origin, requests }) => {
      const result = await run(origin)
      assert.equal(result.code, 1)
      assert.ok(result.stderr.includes('unexpected content type'))
      assert.equal(requests.length, 1)
    })
  })

  it('rejects off-origin or non-iOS launch assets without fetching them', async () => {
    for (const assetUrl of [
      () => 'https://example.invalid/index.bundle?platform=ios',
      () => 'http://127.0.0.1:1/index.bundle?platform=ios',
      origin => `${origin}/index.bundle?platform=android`
    ]) {
      await withMetro({ manifest: port => ({ launchAsset: {
        contentType: 'application/javascript', url: assetUrl(`http://127.0.0.1:${port}`)
      } }) }, async ({ origin, requests }) => {
        const result = await run(origin)
        assert.equal(result.code, 1)
        assert.ok(result.stderr.includes('not a same-origin iOS bundle'))
        assert.equal(requests.length, 1)
      })
    }
  })

  it('rejects non-JavaScript, empty, and failed bundle responses', async () => {
    for (const options of [
      { bundleType: 'text/html' }, { bundleType: 'application/notjavascript' },
      { empty: true }, { bundleStatus: 500 }, { truncate: true }
    ]) {
      await withMetro(options, async ({ origin }) => {
        const result = await run(origin)
        assert.equal(result.code, 1)
        assert.ok(result.stderr.includes('Metro warmup failed'))
      })
    }
  })

  it('does not follow manifest or bundle redirects', async () => {
    await withMetro({ manifestRedirect: true }, async ({ origin, requests }) => {
      const result = await run(origin)
      assert.equal(result.code, 1)
      assert.deepEqual(requests.map(request => request.url), ['/'])
    })
    await withMetro({ bundleRedirect: true }, async ({ origin, requests }) => {
      const result = await run(origin)
      assert.equal(result.code, 1)
      assert.deepEqual(requests.map(request => request.url), [
        '/', '/custom-entry.bundle?platform=ios&dev=true'
      ])
    })
  })

  it('exits promptly when rejected response bodies never finish', async () => {
    for (const [options, expected] of [
      [{ manifestType: 'text/plain', manifestHang: true }, 'manifest returned HTTP 200'],
      [{ bundleType: 'text/plain', hang: true }, 'bundle returned HTTP 200'],
      [{ manifestRedirect: true, manifestRedirectHang: true }, 'manifest returned HTTP 302'],
      [{ bundleRedirect: true, bundleRedirectHang: true }, 'bundle returned HTTP 302']
    ]) {
      await withMetro(options, async ({ origin }) => {
        const result = await run(origin, 200)
        assert.equal(result.code, 1, `rejected response must exit without watchdog kill: ${expected}`)
        assert.equal(result.signal, null)
        assert.ok(result.stderr.includes(expected), result.stderr)
      })
    }
  })

  it('times out stalled manifest and bundle streams', async () => {
    await withMetro({ manifestHang: true }, async ({ origin, requests }) => {
      const result = await run(origin, 300)
      assert.equal(result.code, 1)
      assert.ok(result.stderr.includes('iOS Metro bundle exceeded 300ms'))
      assert.equal(requests.length, 1)
    })
    await withMetro({ hang: true }, async ({ origin }) => {
      const result = await run(origin, 300)
      assert.equal(result.code, 1)
      assert.ok(result.stderr.includes('iOS Metro bundle exceeded 300ms'))
    })
  })
})
