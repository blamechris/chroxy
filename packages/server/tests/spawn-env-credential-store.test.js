import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSpawnEnv } from '../src/utils/spawn-env.js'
import { setStoredCredential } from '../src/credential-store.js'

/**
 * #3855: verify that buildSpawnEnv injects stored credentials when the
 * operator's shell has NOT exported the env var — the Tauri/launchd GUI-launch
 * gap (cwd=/, minimal PATH, no rc file sourced). Process env always wins.
 */

const CRED_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY']

describe('buildSpawnEnv — credential-store fallback (#3855)', () => {
  let tmpHome
  let originalHome
  const savedEnv = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-spawn-cred-test-'))
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

  it('injects a stored OPENAI_API_KEY into the codex child when env is unset', () => {
    setStoredCredential('OPENAI_API_KEY', 'sk-stored-openai')
    const env = buildSpawnEnv('codex')
    assert.equal(env.OPENAI_API_KEY, 'sk-stored-openai')
  })

  it('injects a stored GEMINI_API_KEY into the gemini child when env is unset', () => {
    setStoredCredential('GEMINI_API_KEY', 'gemini-stored')
    const env = buildSpawnEnv('gemini')
    assert.equal(env.GEMINI_API_KEY, 'gemini-stored')
  })

  it('lets the shell export win over the store', () => {
    setStoredCredential('OPENAI_API_KEY', 'sk-stored-openai')
    process.env.OPENAI_API_KEY = 'sk-shell-openai'
    const env = buildSpawnEnv('codex')
    assert.equal(env.OPENAI_API_KEY, 'sk-shell-openai')
  })

  it('keeps ANTHROPIC_API_KEY denylisted for claude even when stored', () => {
    // The Claude CLI must use OAuth/subscription auth, not the stored API key.
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-stored')
    const env = buildSpawnEnv('claude')
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
  })

  it('injects a stored CLAUDE_CODE_OAUTH_TOKEN into the claude child (not denylisted)', () => {
    setStoredCredential('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-stored-token')
    const env = buildSpawnEnv('claude')
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-stored-token')
  })

  it('does not inject OPENAI_API_KEY into the gemini child (cross-provider isolation)', () => {
    setStoredCredential('OPENAI_API_KEY', 'sk-stored-openai')
    const env = buildSpawnEnv('gemini')
    // gemini allowlist does not include OPENAI_API_KEY, so the store fallback
    // never runs for it.
    assert.equal(env.OPENAI_API_KEY, undefined)
  })
})
