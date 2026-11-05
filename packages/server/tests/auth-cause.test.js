import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyAuthCause, AUTH_REQUIRED_CAUSES } from '../src/utils/auth-cause.js'
import { SdkSession } from '../src/sdk-session.js'
import { buildErrorWire } from '../src/message-wire.js'

// #8970: one case per authentication mechanism. `settings` is passed explicitly so
// no case reads the developer's real ~/.claude; the file-reading path has its own
// cases below under a temp CLAUDE_CONFIG_DIR.
const NO_SETTINGS = { settings: {} }

describe('classifyAuthCause (#8970)', () => {
  it('login: no credential anywhere falls back to a host login', () => {
    assert.equal(classifyAuthCause({}, NO_SETTINGS), 'login')
  })
  it('api_key: ANTHROPIC_API_KEY', () => {
    assert.equal(classifyAuthCause({ ANTHROPIC_API_KEY: 'k' }, NO_SETTINGS), 'api_key')
  })
  it('bedrock: CLAUDE_CODE_USE_BEDROCK, even with a stray API key (the cloud provider wins)', () => {
    assert.equal(classifyAuthCause({ CLAUDE_CODE_USE_BEDROCK: '1' }, NO_SETTINGS), 'bedrock')
    assert.equal(classifyAuthCause({ CLAUDE_CODE_USE_BEDROCK: 'true', ANTHROPIC_API_KEY: 'k' }, NO_SETTINGS), 'bedrock')
  })
  it('vertex: CLAUDE_CODE_USE_VERTEX', () => {
    assert.equal(classifyAuthCause({ CLAUDE_CODE_USE_VERTEX: '1' }, NO_SETTINGS), 'vertex')
  })
  it('a flag set to 0 / false / empty does not select the provider', () => {
    for (const v of ['0', 'false', '']) {
      assert.equal(classifyAuthCause({ CLAUDE_CODE_USE_BEDROCK: v, CLAUDE_CODE_USE_VERTEX: v }, NO_SETTINGS), 'login')
    }
  })
  it('auth_token: ANTHROPIC_AUTH_TOKEN, ahead of an API key', () => {
    assert.equal(classifyAuthCause({ ANTHROPIC_AUTH_TOKEN: 't' }, NO_SETTINGS), 'auth_token')
    assert.equal(classifyAuthCause({ ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }, NO_SETTINGS), 'auth_token')
  })
  it('api_key_helper: apiKeyHelper in settings, behind an env API key', () => {
    assert.equal(classifyAuthCause({}, { settings: { apiKeyHelper: '/bin/key.sh' } }), 'api_key_helper')
    assert.equal(classifyAuthCause({ ANTHROPIC_API_KEY: 'k' }, { settings: { apiKeyHelper: '/bin/key.sh' } }), 'api_key')
  })
  it('undefined: only CLAUDE_CODE_OAUTH_TOKEN (ambiguous source)', () => {
    assert.equal(classifyAuthCause({ CLAUDE_CODE_OAUTH_TOKEN: 't' }, NO_SETTINGS), undefined)
  })
  it('container wins over everything', () => {
    assert.equal(classifyAuthCause({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k' }, { containerized: true, settings: {} }), 'container')
  })
  it('honours the settings.json env block, with the process env winning', () => {
    assert.equal(classifyAuthCause({}, { settings: { env: { CLAUDE_CODE_USE_VERTEX: '1' } } }), 'vertex')
    assert.equal(classifyAuthCause({ CLAUDE_CODE_USE_BEDROCK: '1' }, { settings: { env: { CLAUDE_CODE_USE_VERTEX: '1' } } }), 'bedrock')
  })

  it('a key or OAuth token set only in settings.json env is still seen', () => {
    assert.equal(classifyAuthCause({}, { settings: { env: { ANTHROPIC_API_KEY: 'k' } } }), 'api_key')
    assert.equal(classifyAuthCause({}, { settings: { env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } } }), undefined)
  })

  describe('reading the active settings file', () => {
    it('honours the env block read from the file itself', () => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'k' } }))
      assert.equal(classifyAuthCause({ CLAUDE_CONFIG_DIR: dir }), 'api_key')
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }))
      assert.equal(classifyAuthCause({ CLAUDE_CONFIG_DIR: dir }), 'bedrock')
    })

    let dir
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chroxy-authcause-')) })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('finds apiKeyHelper in <CLAUDE_CONFIG_DIR>/settings.json', () => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/key.sh' }))
      assert.equal(classifyAuthCause({ CLAUDE_CONFIG_DIR: dir }), 'api_key_helper')
    })
    it('a missing or malformed file is login, not a crash', () => {
      assert.equal(classifyAuthCause({ CLAUDE_CONFIG_DIR: dir }), 'login')
      writeFileSync(join(dir, 'settings.json'), '{ not json')
      assert.equal(classifyAuthCause({ CLAUDE_CONFIG_DIR: dir }), 'login')
    })
  })
})

describe('AUTH_REQUIRED cause roster, server side (#8970)', () => {
  // Hand-written: deriving it from the subject could not go red (#7424).
  const EXPECTED = ['api_key', 'api_key_helper', 'auth_token', 'bedrock', 'container', 'login', 'vertex']

  it('is exactly the expected causes', () => {
    assert.deepEqual([...AUTH_REQUIRED_CAUSES].sort(), EXPECTED)
  })

  it('every cause has a distinct message, and none sends a non-login user to log in', () => {
    const s = new SdkSession({ cwd: '/tmp' })
    const seen = new Map()
    for (const cause of AUTH_REQUIRED_CAUSES) {
      const msg = s._authRequiredMessage(cause)
      assert.ok(!seen.has(msg), `${cause} shares a message with ${seen.get(msg)}`)
      seen.set(msg, cause)
      if (cause !== 'login') assert.ok(!/auth login/.test(msg), `${cause}: ${msg}`)
    }
    s.destroy()
  })

  it('bedrock and vertex messages name their own remedy', () => {
    const s = new SdkSession({ cwd: '/tmp' })
    assert.match(s._authRequiredMessage('bedrock'), /AWS/)
    assert.match(s._authRequiredMessage('vertex'), /Google Cloud/)
    s.destroy()
  })

  it('the wire passes every cause through and drops an unknown one', () => {
    for (const cause of AUTH_REQUIRED_CAUSES) {
      const wire = buildErrorWire({ code: 'AUTH_REQUIRED', message: 'm', authCause: cause })
      assert.equal(wire.authCause, cause, cause)
    }
    const dropped = buildErrorWire({ code: 'AUTH_REQUIRED', message: 'm', authCause: 'made_up' })
    assert.ok(!('authCause' in dropped))
  })
})
