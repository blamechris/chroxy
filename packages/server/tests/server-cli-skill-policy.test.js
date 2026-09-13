import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadAndMergeConfig } from '../src/cli/shared.js'
import { isFatalConfigWarning, validateConfig } from '../src/config.js'
import {
  createDaemonSessionManager,
  formatStartupSkillPolicyDiagnostic,
  resolveStartupSkillPolicy,
} from '../src/server-cli.js'
import { GeminiSession } from '../src/gemini-session.js'
import { registerProvider } from '../src/providers.js'
import { waitFor } from './test-helpers.js'

const PROVIDER = 'test-gemini-skill-policy-7834'
const outboundPrompts = []

class CapturingGeminiSession extends GeminiSession {
  static get resolvedBinary() {
    return process.execPath
  }

  _buildArgs(text) {
    outboundPrompts.push(text)
    return [this.constructor.shimPath, text]
  }
}

registerProvider(PROVIDER, CapturingGeminiSession)

describe('daemon startup skill policy (#7834)', () => {
  let root
  let configDir
  let skillsDir
  let repoDir
  let stateFilePath
  let previousEnv
  const managers = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-skill-policy-'))
    configDir = join(root, '.chroxy')
    skillsDir = join(configDir, 'skills')
    repoDir = join(root, 'repo')
    stateFilePath = join(root, 'state', 'session-state.json')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(join(root, 'gemini-home'), { recursive: true })
    CapturingGeminiSession.shimPath = join(root, 'gemini-shim.mjs')
    writeFileSync(
      CapturingGeminiSession.shimPath,
      "process.stdout.write(JSON.stringify({ type: 'result', usage: {} }) + '\\n')\n",
    )

    previousEnv = {
      HOME: process.env.HOME,
      CHROXY_CONFIG_DIR: process.env.CHROXY_CONFIG_DIR,
      CHROXY_GEMINI_HOME: process.env.CHROXY_GEMINI_HOME,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      PROVIDERSKILLALLOWLIST: process.env.PROVIDERSKILLALLOWLIST,
      TRUSTMISMATCHMODE: process.env.TRUSTMISMATCHMODE,
    }
    process.env.HOME = root
    process.env.CHROXY_CONFIG_DIR = configDir
    process.env.CHROXY_GEMINI_HOME = join(root, 'gemini-home')
    process.env.GEMINI_API_KEY = 'fixture-key'
    delete process.env.PROVIDERSKILLALLOWLIST
    delete process.env.TRUSTMISMATCHMODE
    outboundPrompts.length = 0
  })

  afterEach(() => {
    while (managers.length > 0) {
      try { managers.pop().destroyAll() } catch { /* already destroyed */ }
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  function loadFixtureConfig(value) {
    const path = join(configDir, 'config.json')
    writeFileSync(path, JSON.stringify(value))
    return loadAndMergeConfig({ config: path, verbose: false })
  }

  function createManager(config) {
    const { sessionManager: manager, startupSkillPolicy: policy } = createDaemonSessionManager(config, {
      maxSessions: 5,
      defaultCwd: repoDir,
      providerType: PROVIDER,
      skipPreflight: true,
      stateFilePath,
      persistDebounceMs: 0,
    })
    managers.push(manager)
    return { manager, policy }
  }

  async function sendFirstTurn(manager, name) {
    const sessionId = manager.createSession({ name, cwd: repoDir, provider: PROVIDER })
    const session = manager.getSession(sessionId).session
    await session.sendMessage('fixture question')
    await waitFor(() => outboundPrompts.length > 0, { label: 'captured Gemini outbound prompt' })
    return outboundPrompts.shift()
  }

  it('applies allowlist and block trust policy through config → daemon options → Gemini outbound prompt', async () => {
    writeFileSync(join(skillsDir, 'allowed.md'), 'trusted skill body')
    writeFileSync(join(skillsDir, 'denied.md'), 'deny-listed skill body')
    const config = loadFixtureConfig({
      providerSkillAllowlist: { [PROVIDER]: ['allowed'] },
      trustMismatchMode: 'block',
    })
    const { manager, policy } = createManager(config)

    assert.equal(
      formatStartupSkillPolicyDiagnostic(policy.diagnostics),
      'Runtime skills: allowlist=configured (source: config, providers: 1); trust=block (source: config)',
    )

    const firstPrompt = await sendFirstTurn(manager, 'first activation')
    assert.ok(firstPrompt.includes('trusted skill body'), 'allowlisted skill reaches Gemini argv prompt')
    assert.ok(!firstPrompt.includes('deny-listed skill body'), 'unlisted skill is absent from Gemini argv prompt')

    const trustPath = join(configDir, 'skills-trust.json')
    assert.ok(existsSync(trustPath), 'first activation persists the configured trust ledger')
    const firstLedger = JSON.parse(readFileSync(trustPath, 'utf8'))
    assert.ok(
      Object.keys(firstLedger.skills).some((path) => path.endsWith('/allowed.md')),
      'first activation records the allowlisted skill hash',
    )

    writeFileSync(join(skillsDir, 'allowed.md'), 'changed skill body')
    const secondPrompt = await sendFirstTurn(manager, 'after content change')
    assert.ok(!secondPrompt.includes('changed skill body'), 'block mode removes changed content from Gemini argv prompt')
    assert.ok(!secondPrompt.includes('trusted skill body'), 'stale trusted content is never reused')
  })

  it('reports omitted and rejected trust modes without enabling a ledger', () => {
    const omitted = resolveStartupSkillPolicy(loadFixtureConfig({}))
    assert.deepEqual(omitted.sessionManagerOptions, {
      maxSkillBytes: null,
      maxTotalSkillBytes: null,
      providerSkillAllowlist: null,
      trustMismatchMode: null,
    })
    assert.equal(
      formatStartupSkillPolicyDiagnostic(omitted.diagnostics),
      'Runtime skills: allowlist=disabled (source: default); trust=disabled (source: default)',
    )

    const rejected = resolveStartupSkillPolicy(loadFixtureConfig({ trustMismatchMode: 'strict' }))
    assert.equal(rejected.sessionManagerOptions.trustMismatchMode, null)
    assert.equal(
      formatStartupSkillPolicyDiagnostic(rejected.diagnostics),
      'Runtime skills: allowlist=disabled (source: default); trust=disabled (source: rejected config)',
    )

    const invalidAllowlist = validateConfig({ providerSkillAllowlist: [] }).warnings
    assert.ok(
      invalidAllowlist.some((warning) => isFatalConfigWarning(warning)),
      'a non-object allowlist remains a fatal config type error',
    )
  })
})
