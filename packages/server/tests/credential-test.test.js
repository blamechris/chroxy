import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testCredential } from '../src/credential-test.js'
import { setStoredCredential } from '../src/credential-store.js'

/**
 * #3855: lightweight credential ping. Uses an injected fetch so no real
 * network call is made. Verifies status-code mapping and that the raw value
 * never appears in the result.
 */

const CRED_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY']

function fakeFetch(status, { capture } = {}) {
  return async (url, init) => {
    if (capture) capture(url, init)
    return { ok: status >= 200 && status < 300, status }
  }
}

describe('credential-test (#3855)', () => {
  let tmpHome
  let originalHome
  const savedEnv = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-test-test-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
    for (const k of CRED_ENV_VARS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    for (const k of CRED_ENV_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
  })

  it('returns ok:false with a clear message when no credential is configured', async () => {
    const r = await testCredential('OPENAI_API_KEY', { fetchImpl: fakeFetch(200) })
    assert.equal(r.ok, false)
    assert.match(r.error, /No credential configured/)
  })

  it('returns ok:true on a 200 for OpenAI', async () => {
    setStoredCredential('OPENAI_API_KEY', 'sk-openai-test')
    const r = await testCredential('OPENAI_API_KEY', { fetchImpl: fakeFetch(200) })
    assert.equal(r.ok, true)
    assert.equal(typeof r.latencyMs, 'number')
  })

  it('returns ok:false on a 401 (auth failed)', async () => {
    setStoredCredential('OPENAI_API_KEY', 'sk-openai-test')
    const r = await testCredential('OPENAI_API_KEY', { fetchImpl: fakeFetch(401) })
    assert.equal(r.ok, false)
    assert.match(r.error, /Authentication failed/)
  })

  it('treats a non-auth Anthropic 4xx as a passing auth test', async () => {
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-test')
    // 400 = the key authenticated but the 1-token ping was rejected on content.
    const r = await testCredential('ANTHROPIC_API_KEY', { fetchImpl: fakeFetch(400) })
    assert.equal(r.ok, true)
  })

  it('sends the OpenAI key via the Authorization header, never the URL', async () => {
    setStoredCredential('OPENAI_API_KEY', 'sk-openai-secret')
    let capturedUrl = ''
    let capturedInit = null
    await testCredential('OPENAI_API_KEY', {
      fetchImpl: fakeFetch(200, { capture: (url, init) => { capturedUrl = url; capturedInit = init } }),
    })
    assert.equal(capturedUrl.includes('sk-openai-secret'), false)
    assert.equal(capturedInit.headers.authorization, 'Bearer sk-openai-secret')
  })

  it('sends the Gemini key via the x-goog-api-key header, never the URL', async () => {
    setStoredCredential('GEMINI_API_KEY', 'gemini-secret')
    let capturedUrl = ''
    await testCredential('GEMINI_API_KEY', {
      fetchImpl: fakeFetch(200, { capture: (url) => { capturedUrl = url } }),
    })
    assert.equal(capturedUrl.includes('gemini-secret'), false)
  })

  it('does not interpolate the raw value into a network-error result', async () => {
    setStoredCredential('OPENAI_API_KEY', 'sk-openai-supersecret')
    // A realistic network error (which does NOT contain the key) must not have
    // the key injected by our own formatting.
    const cleanFetch = async () => { throw new Error('ECONNREFUSED 1.2.3.4:443') }
    const r = await testCredential('OPENAI_API_KEY', { fetchImpl: cleanFetch })
    assert.equal(r.ok, false)
    assert.equal(r.error.includes('sk-openai-supersecret'), false)
  })

  it('truncates an overly long provider error so it cannot smuggle data back', async () => {
    setStoredCredential('OPENAI_API_KEY', 'sk-openai-test')
    const longFetch = async () => { throw new Error('x'.repeat(500)) }
    const r = await testCredential('OPENAI_API_KEY', { fetchImpl: longFetch })
    assert.equal(r.ok, false)
    assert.ok(r.error.length <= 210)
  })

  it('rejects an unknown key', async () => {
    const r = await testCredential('NOT_A_KEY', { fetchImpl: fakeFetch(200) })
    assert.equal(r.ok, false)
  })
})
