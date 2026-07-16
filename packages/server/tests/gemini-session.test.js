import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  GeminiSession,
  GEMINI_CONTEXT_WINDOW_HEADROOM,
  GEMINI_CONTEXT_WINDOW_RATCHET_CAP,
  _maybeRatchetContextWindow,
} from '../src/gemini-session.js'
import { getRegistryForProvider } from '../src/models.js'
import { SkillsTrustStore } from '../src/skills-trust.js'
import { waitFor } from './test-helpers.js'
// Importing providers.js triggers built-in provider registration so
// getRegistryForProvider('gemini') can wire to GeminiSession's static hooks
// when this suite runs in isolation. Without this the registry falls back
// to the default Claude registry and the #4414 learn-loop tests below
// would silently no-op.
import '../src/providers.js'

describe('GeminiSession', () => {
  let savedApiKey
  beforeEach(() => {
    savedApiKey = process.env.GEMINI_API_KEY
    process.env.GEMINI_API_KEY = 'test-key'
  })
  afterEach(() => {
    if (savedApiKey !== undefined) process.env.GEMINI_API_KEY = savedApiKey
    else delete process.env.GEMINI_API_KEY
  })

  it('exposes correct capabilities', () => {
    const caps = GeminiSession.capabilities
    assert.equal(caps.permissions, false)
    assert.equal(caps.inProcessPermissions, false)
    assert.equal(caps.modelSwitch, true)
    assert.equal(caps.permissionModeSwitch, false)
    assert.equal(caps.planMode, false)
    assert.equal(caps.resume, false)
    assert.equal(caps.terminal, false)
  })

  it('constructs with default values', () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    assert.equal(session.cwd, '/tmp')
    assert.ok(session.model)
    assert.equal(session.isRunning, false)
    assert.equal(session.resumeSessionId, null)
  })

  it('accepts model override in constructor', () => {
    const session = new GeminiSession({ cwd: '/tmp', model: 'gemini-2.5-pro' })
    assert.equal(session.model, 'gemini-2.5-pro')
  })

  // #6563: parity with the Codex fix — a `gemini login`-only user (OAuth tokens
  // under ~/.gemini, no GEMINI_API_KEY) must be runtime-ready. hasAlternativeCredentials()
  // reuses the same hasGeminiOAuthCreds() probe resolveAuth() + preflight use, so all
  // three layers (display, runtime, preflight) agree — start() must not throw for the
  // missing env key and `chroxy doctor` marks the credential optional.
  describe('start() OAuth-awareness (#6563)', () => {
    let savedGeminiHome, noOauthDir
    beforeEach(() => {
      // Isolate the OAuth probe from the test machine's real ~/.gemini so the
      // "no creds" expectation is deterministic regardless of a real `gemini login`.
      savedGeminiHome = process.env.CHROXY_GEMINI_HOME
      noOauthDir = mkdtempSync(join(tmpdir(), 'chroxy-gemini-noauth-'))
      process.env.CHROXY_GEMINI_HOME = noOauthDir
    })
    afterEach(() => {
      if (savedGeminiHome === undefined) delete process.env.CHROXY_GEMINI_HOME
      else process.env.CHROXY_GEMINI_HOME = savedGeminiHome
      try { rmSync(noOauthDir, { recursive: true, force: true }) } catch { /* best effort */ }
    })

    it('no env var and no OAuth creds → hasAlternativeCredentials() false + preflight credential required', () => {
      delete process.env.GEMINI_API_KEY
      assert.equal(GeminiSession.hasAlternativeCredentials(), false)
      assert.equal(GeminiSession.preflight.credentials.optional, false)
    })

    it('OAuth-only (oauth_creds.json present, no env var) — hasAlternativeCredentials() + preflight optional + start() not rejected for the missing key', () => {
      // Different temp dir than noOauthDir — the OAuth probe is cache-keyed on
      // CHROXY_GEMINI_HOME, so reusing the dir would risk a stale cached false.
      const oauthDir = mkdtempSync(join(tmpdir(), 'chroxy-gemini-oauth-'))
      writeFileSync(join(oauthDir, 'oauth_creds.json'), JSON.stringify({ access_token: 'tok-abc' }))
      const savedHome = process.env.CHROXY_GEMINI_HOME
      process.env.CHROXY_GEMINI_HOME = oauthDir
      delete process.env.GEMINI_API_KEY
      let session = null
      try {
        assert.equal(GeminiSession.hasAlternativeCredentials(), true)
        assert.equal(GeminiSession.preflight.credentials.optional, true, 'preflight marks the key optional so doctor downgrades a missing key fail→warn, not a hard failure')
        session = new GeminiSession({ cwd: '/tmp' })
        // The base JsonlSubprocessSession.start() throws the API-key error ONLY when
        // no env var AND no alt creds; with OAuth present that throw must be skipped.
        // A binary-not-found error (gemini CLI absent in CI) is unrelated — only the
        // GEMINI_API_KEY rejection is asserted against.
        let apiKeyError = null
        try { session.start() } catch (e) { if (/GEMINI_API_KEY/.test(e?.message ?? '')) apiKeyError = e }
        assert.equal(apiKeyError, null, 'OAuth-only user is not rejected at runtime for a missing API key')
      } finally {
        if (session) { try { session.destroy() } catch { /* best effort */ } }
        if (savedHome === undefined) delete process.env.CHROXY_GEMINI_HOME
        else process.env.CHROXY_GEMINI_HOME = savedHome
        try { rmSync(oauthDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    })
  })

  // ---------------------------------------------------------------------
  // #3225: JsonlSubprocessSession previously dropped these constructor
  // opts at the middle layer, so providers gating and manual activation
  // silently no-op'd for Gemini sessions. Pin the pass-through.
  // ---------------------------------------------------------------------

  it('passes `provider` through to BaseSession (#3225)', () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    assert.equal(session._provider, 'gemini')
  })

  it('passes a custom `provider` through to BaseSession (#3225)', () => {
    const session = new GeminiSession({ cwd: '/tmp', provider: 'gemini-vertex' })
    assert.equal(session._provider, 'gemini-vertex')
  })

  it('passes `activeManualSkills` through to BaseSession (#3225)', () => {
    const session = new GeminiSession({
      cwd: '/tmp',
      activeManualSkills: new Set(['gemini-skill']),
    })
    assert.ok(session._activeManualSkills instanceof Set)
    assert.equal(session._activeManualSkills.has('gemini-skill'), true)
  })

  // #3755: GeminiSession → JsonlSubprocessSession → BaseSession forwarding
  // of resultTimeoutMs. SessionManager sets providerOpts.resultTimeoutMs;
  // every layer must forward it to honour operator config.
  it('forwards resultTimeoutMs to BaseSession (#3755)', () => {
    const session = new GeminiSession({ cwd: '/tmp', resultTimeoutMs: 600_000 })
    assert.equal(session._resultTimeoutMs, 600_000)
  })

  it('defaults _resultTimeoutMs to 30 min when omitted (#3755 / #3884)', () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    assert.equal(session._resultTimeoutMs, 30 * 60 * 1000)
  })

  // #4790: GeminiSession → JsonlSubprocessSession → BaseSession forwarding of
  // streamStallTimeoutMs. SessionManager (PR #4745) wired per-provider
  // overrides into providerOpts but each middle layer dropped the key.
  // The CapturingProvider-based test in session-manager.test.js missed this
  // because CapturingProvider has no middle layer.
  it('forwards streamStallTimeoutMs to BaseSession (#4790)', () => {
    const session = new GeminiSession({ cwd: '/tmp', streamStallTimeoutMs: 900_000 })
    assert.equal(session._streamStallTimeoutMs, 900_000)
  })

  it('defaults _streamStallTimeoutMs to 5 min when omitted (#4790)', () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    assert.equal(session._streamStallTimeoutMs, 5 * 60 * 1000)
  })

  it('forwards streamStallTimeoutMs: 0 (explicit disable) to BaseSession (#4790)', () => {
    const session = new GeminiSession({ cwd: '/tmp', streamStallTimeoutMs: 0 })
    assert.equal(session._streamStallTimeoutMs, 0)
  })

  // ---------------------------------------------------------------------
  // PR #3231 review (agent-review): JsonlSubprocessSession was the
  // middle layer between GeminiSession and BaseSession and silently
  // dropped the second batch of round-2 opts —
  // `providerSkillAllowlist`, `trustStore`, `trustMismatchMode` — even
  // though Codex/Gemini both passed them to super(). The result was
  // that allowlist filtering and trust hashing silently no-op'd for
  // the subprocess providers.
  // ---------------------------------------------------------------------

  describe('round-2 skills opts plumb through JsonlSubprocessSession (#3231)', () => {
    let skillsDir
    beforeEach(() => { skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-gemini-r2-')) })
    afterEach(() => { rmSync(skillsDir, { recursive: true, force: true }) })

    it('passes `providerSkillAllowlist` through — denied skills are filtered', () => {
      writeFileSync(join(skillsDir, 'allowed.md'), 'allowed body')
      writeFileSync(join(skillsDir, 'denied.md'), 'denied body')
      const session = new GeminiSession({
        cwd: '/tmp',
        provider: 'gemini',
        skillsDir,
        repoSkillsDir: null,
        providerSkillAllowlist: { gemini: ['allowed'] },
      })
      const names = session._getSkills().map((sk) => sk.name)
      assert.deepEqual(names, ['allowed'])
    })

    it('passes `providerSkillAllowlist` through — fail-secure when entry is missing', () => {
      writeFileSync(join(skillsDir, 'a.md'), 'a body')
      const session = new GeminiSession({
        cwd: '/tmp',
        provider: 'gemini',
        skillsDir,
        repoSkillsDir: null,
        // Allowlist configured for a different provider — gemini should drop everything.
        providerSkillAllowlist: { codex: ['a'] },
      })
      assert.deepEqual(session._getSkills(), [])
    })

    it('passes `trustStore` through so the loader records hashes', () => {
      writeFileSync(join(skillsDir, 'a.md'), 'body a')
      const trustDir = mkdtempSync(join(tmpdir(), 'chroxy-gemini-r2-trust-'))
      const trustPath = join(trustDir, 'trust.json')
      try {
        const trustStore = new SkillsTrustStore({ filePath: trustPath })
        const session = new GeminiSession({
          cwd: '/tmp',
          skillsDir,
          repoSkillsDir: null,
          trustStore,
        })
        assert.equal(session._trustStore, trustStore,
          'GeminiSession must forward the caller-supplied trust store to BaseSession')
        assert.equal(session._getSkills().length, 1)
        assert.ok(Object.keys(trustStore._records).length >= 1,
          'trust store should have recorded at least one hash via the loader')
      } finally {
        rmSync(trustDir, { recursive: true, force: true })
      }
    })

    it('passes `trustMismatchMode` through so the default store is wired', () => {
      writeFileSync(join(skillsDir, 'a.md'), 'body a')
      const session = new GeminiSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustMismatchMode: 'block',
      })
      assert.ok(session._trustStore,
        'GeminiSession must forward trustMismatchMode so BaseSession wires the default trust store')
      assert.equal(session._trustStore.mode, 'block')
    })

    it('without round-2 opts, no trust store is wired (back-compat)', () => {
      writeFileSync(join(skillsDir, 'a.md'), 'body a')
      const session = new GeminiSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
      })
      assert.equal(session._trustStore, null,
        'trust must remain opt-in: no opts → no store')
    })
  })

  it('setModel updates the model property', () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    session.setModel('gemini-2.5-flash')
    assert.equal(session.model, 'gemini-2.5-flash')
  })

  it('setModel is a no-op when busy', () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    session._isBusy = true
    const before = session.model
    session.setModel('gemini-2.5-flash')
    assert.equal(session.model, before)
  })

  it('setModel is a no-op when model is unchanged', () => {
    const session = new GeminiSession({ cwd: '/tmp', model: 'gemini-2.5-pro' })
    session.setModel('gemini-2.5-pro')
    assert.equal(session.model, 'gemini-2.5-pro')
  })

  it('setPermissionMode is a no-op (no throw)', () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    assert.doesNotThrow(() => session.setPermissionMode('auto'))
  })

  it('start sets isRunning and emits ready', async () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    const events = []
    session.on('ready', (data) => events.push(data))

    session.start()
    await new Promise(r => setTimeout(r, 50))

    assert.equal(session.isReady, true)
    assert.equal(session.isRunning, false) // Not busy until sendMessage
    assert.equal(events.length, 1)
    assert.ok(events[0].model)
  })

  it('destroy resets isReady and isRunning', async () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    session.start()
    await new Promise(r => setTimeout(r, 50))

    session.destroy()
    assert.equal(session.isReady, false)
    assert.equal(session.isRunning, false)
  })

  describe('_parseJsonLine', () => {
    it('parses valid JSON', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const result = session._parseJsonLine('{"type":"content_block_start"}')
      assert.deepEqual(result, { type: 'content_block_start' })
    })

    it('returns null for invalid JSON', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const result = session._parseJsonLine('not json')
      assert.equal(result, null)
    })

    it('returns null for empty line', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      assert.equal(session._parseJsonLine(''), null)
      assert.equal(session._parseJsonLine('   '), null)
    })
  })

  describe('event mapping', () => {
    it('_processGeminiEvent skips assistant text (handled in sendMessage)', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const events = []
      session.on('stream_start', (d) => events.push({ type: 'stream_start', ...d }))
      session.on('stream_delta', (d) => events.push({ type: 'stream_delta', ...d }))
      session.on('stream_end', (d) => events.push({ type: 'stream_end', ...d }))

      // Text blocks are now handled inline in sendMessage, not _processGeminiEvent
      session._processGeminiEvent({
        type: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      })

      assert.equal(events.length, 0) // No stream events from _processGeminiEvent
    })

    it('maps result event with usage to result', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const events = []
      session.on('result', (d) => events.push(d))

      session._processGeminiEvent({
        type: 'result',
        usage: { input_tokens: 100, output_tokens: 50 },
      })

      assert.equal(events.length, 1)
      assert.ok(events[0].usage)
    })

    it('maps tool_use to tool_start', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const events = []
      session.on('tool_start', (d) => events.push(d))

      session._processGeminiEvent({
        type: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'read_file',
          input: { path: 'test.txt' },
        }],
      })

      assert.equal(events.length, 1)
      assert.equal(events[0].tool, 'read_file')
    })
  })

  describe('start() API key validation', () => {
    // #6563: isolate the OAuth probe from the test machine's real ~/.gemini so the
    // "no key → throws" expectation is deterministic regardless of a real `gemini
    // login` (hasAlternativeCredentials() now gates the throw). Point CHROXY_GEMINI_HOME
    // at an empty dir so hasGeminiOAuthCreds() is false here.
    let savedGeminiHome, noOauthDir
    beforeEach(() => {
      savedGeminiHome = process.env.CHROXY_GEMINI_HOME
      noOauthDir = mkdtempSync(join(tmpdir(), 'chroxy-gemini-akv-'))
      process.env.CHROXY_GEMINI_HOME = noOauthDir
    })
    afterEach(() => {
      if (savedGeminiHome === undefined) delete process.env.CHROXY_GEMINI_HOME
      else process.env.CHROXY_GEMINI_HOME = savedGeminiHome
      try { rmSync(noOauthDir, { recursive: true, force: true }) } catch { /* best effort */ }
    })

    it('throws when GEMINI_API_KEY is not set', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      delete process.env.GEMINI_API_KEY
      assert.throws(() => session.start(), {
        message: /GEMINI_API_KEY.*not set/,
      })
    })

    it('succeeds when GEMINI_API_KEY is set', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      session.start()
      assert.equal(session._processReady, true)
      session.destroy()
    })
  })

  describe('binary candidate list', () => {
    // Regression: the Tauri GUI launch path bug that bit claude (#2891) also
    // affects gemini when installed via curl|sh to ~/.local/bin or via
    // `npm install -g` to ~/.npm-global. Candidate list must cover both.
    it('includes ~/.local/bin/gemini, Homebrew, /usr/local, and ~/.npm-global/bin', async () => {
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const { GeminiSession } = await import('../src/gemini-session.js')
      const candidates = GeminiSession.binaryCandidates

      assert.ok(
        candidates.includes(join(homedir(), '.local/bin/gemini')),
        'candidate list must include ~/.local/bin/gemini')
      assert.ok(
        candidates.includes('/opt/homebrew/bin/gemini'),
        'candidate list must include /opt/homebrew/bin/gemini')
      assert.ok(
        candidates.includes('/usr/local/bin/gemini'),
        'candidate list must include /usr/local/bin/gemini')
      assert.ok(
        candidates.includes(join(homedir(), '.npm-global/bin/gemini')),
        'candidate list must include ~/.npm-global/bin/gemini')
    })

    it('uses homedir() for user-local candidate paths', async () => {
      const { readFileSync } = await import('node:fs')
      const { dirname, join } = await import('node:path')
      const { fileURLToPath } = await import('node:url')
      const dir = dirname(fileURLToPath(import.meta.url))
      const source = readFileSync(join(dir, '../src/gemini-session.js'), 'utf-8')

      assert.ok(/import\s*\{[^}]*homedir[^}]*\}\s*from\s*'os'/.test(source),
        'gemini-session.js must import homedir from os')
      assert.ok(/import\s*\{[^}]*join[^}]*\}\s*from\s*'path'/.test(source),
        'gemini-session.js must import join from path')
    })
  })

  // ---------------------------------------------------------------------------
  // sendMessage() through the FULL spawn pipeline of the JsonlSubprocessSession
  // base class — closes #2991.
  //
  // The pre-existing tests above only call `_processGeminiEvent` in isolation.
  // Below we override only the static `resolvedBinary` (point it at node) and
  // `_buildArgs()` (point node at our shim script) so the real
  // `JsonlSubprocessSession.sendMessage()` runs through the real
  // `GeminiSession._processJsonlLine()` mapper.
  // ---------------------------------------------------------------------------
  describe('sendMessage() via JsonlSubprocessSession base (#2991)', () => {
    const baseShimPath = join(tmpdir(), `gemini-base-shim-${process.pid}-${Date.now()}.mjs`)

    function writeBaseShim(body) {
      writeFileSync(baseShimPath, body)
    }

    function writeBaseShimJsonl(lines, { exitCode = 0, stderr = '' } = {}) {
      const payload = lines.map((l) => JSON.stringify(l)).join('\n')
      const parts = [
        '#!/usr/bin/env node',
        `process.stdout.write(${JSON.stringify(payload + (payload ? '\n' : ''))})`,
      ]
      if (stderr) parts.push(`process.stderr.write(${JSON.stringify(stderr)})`)
      parts.push(`process.exit(${exitCode})`)
      writeBaseShim(parts.join('\n'))
    }

    function cleanupBaseShim() {
      if (existsSync(baseShimPath)) unlinkSync(baseShimPath)
    }

    /**
     * GeminiSession but with the binary swapped for `node` and argv overridden
     * to invoke the shim script. _buildChildEnv, _processJsonlLine,
     * _shouldSkipStderr all flow from the real subclass.
     */
    class BaseShimmedGemini extends GeminiSession {
      static get resolvedBinary() {
        return process.execPath
      }

      _buildArgs(text) {
        return [baseShimPath, text]
      }
    }

    // Track every session created in this block so afterEach can guarantee
    // the spawned shim subprocess is killed even if a `waitFor` throws —
    // otherwise a `setInterval(...)` shim could outlive the test run and
    // hang the whole suite.
    const createdSessions = []
    function makeSession(opts) {
      const s = new BaseShimmedGemini(opts || { cwd: '/tmp' })
      createdSessions.push(s)
      return s
    }

    afterEach(() => {
      while (createdSessions.length) {
        const s = createdSessions.pop()
        try { s.interrupt() } catch { /* already gone */ }
        try { s.destroy() } catch { /* already gone */ }
      }
      cleanupBaseShim()
    })

    it('successful round-trip: assistant text + result → stream + result', async () => {
      writeBaseShimJsonl([
        { type: 'assistant', content: [{ type: 'text', text: 'Greetings, ' }] },
        { type: 'assistant', content: [{ type: 'text', text: 'Earthling.' }] },
        { type: 'result', usage: { input_tokens: 8, output_tokens: 3 } },
      ])

      const session = makeSession()
      session._processReady = true
      const seen = []
      session.on('stream_start', (d) => seen.push({ type: 'stream_start', ...d }))
      session.on('stream_delta', (d) => seen.push({ type: 'stream_delta', ...d }))
      session.on('stream_end', (d) => seen.push({ type: 'stream_end', ...d }))
      session.on('result', (d) => seen.push({ type: 'result', ...d }))
      session.on('error', (d) => seen.push({ type: 'error', ...d }))

      await session.sendMessage('hello')
      await waitFor(() => seen.find(e => e.type === 'result'), { label: 'result event' })

      const types = seen.map((e) => e.type)
      assert.deepEqual(types, ['stream_start', 'stream_delta', 'stream_delta', 'stream_end', 'result'])

      const deltas = seen.filter(e => e.type === 'stream_delta').map(e => e.delta)
      assert.deepEqual(deltas, ['Greetings, ', 'Earthling.'])

      const start = seen.find(e => e.type === 'stream_start')
      const end = seen.find(e => e.type === 'stream_end')
      assert.equal(end.messageId, start.messageId, 'stream_end shares stream_start id')
      assert.match(start.messageId, /^gemini-msg-/, 'gemini prefix preserved by base class')

      const result = seen.find(e => e.type === 'result')
      assert.equal(result.usage.input_tokens, 8)
      assert.equal(result.usage.output_tokens, 3)
    })

    it('abort mid-stream: interrupt() kills the subprocess and clears busy', async () => {
      writeBaseShim([
        '#!/usr/bin/env node',
        `process.stdout.write(JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'starting...' }] }) + '\\n')`,
        // Hang waiting for SIGINT — interrupt() should kill us.
        `setInterval(() => {}, 1000)`,
      ].join('\n'))

      const session = makeSession()
      session._processReady = true
      const deltas = []
      const errors = []
      const results = []
      session.on('stream_delta', (d) => deltas.push(d))
      session.on('error', (e) => errors.push(e))
      session.on('result', (r) => results.push(r))

      await session.sendMessage('hello')
      await waitFor(() => deltas.length >= 1, { label: 'first delta before interrupt' })
      assert.equal(session.isRunning, true, 'session must be busy mid-stream')

      session.interrupt()

      // After SIGINT the subprocess exits; close handler clears busy and
      // emits a fallback result (turn.completed/result never arrived).
      await waitFor(() => !session.isRunning, { label: 'isRunning cleared after interrupt' })
      assert.equal(session._process, null, '_process cleared after close')
      assert.ok(results.length >= 1, 'fallback result fired after abort')
    })

    it('subprocess crash: non-zero exit emits error with displayLabel + code', async () => {
      writeBaseShimJsonl([], { exitCode: 5, stderr: 'gemini: fatal error\n' })

      const session = makeSession()
      session._processReady = true
      const errors = []
      const results = []
      session.on('error', (e) => errors.push(e))
      session.on('result', (r) => results.push(r))

      await session.sendMessage('hi')
      await waitFor(() => errors.length >= 1, { label: 'error event' })

      assert.equal(errors.length, 1)
      // Gemini uses displayLabel 'Google Gemini'.
      assert.match(errors[0].message, /Google Gemini.*code 5/)
      assert.match(errors[0].message, /fatal error/)
    })

    it('subprocess crash mid-stream: stream_end + error + fallback result', async () => {
      writeBaseShimJsonl([
        { type: 'assistant', content: [{ type: 'text', text: 'partial...' }] },
      ], { exitCode: 1, stderr: 'fatal: pipe closed' })

      const session = makeSession()
      session._processReady = true
      const events = []
      session.on('stream_start', (d) => events.push({ type: 'stream_start', ...d }))
      session.on('stream_delta', (d) => events.push({ type: 'stream_delta', ...d }))
      session.on('stream_end', (d) => events.push({ type: 'stream_end', ...d }))
      session.on('error', (d) => events.push({ type: 'error', ...d }))
      session.on('result', (d) => events.push({ type: 'result', ...d }))

      await session.sendMessage('hi')
      await waitFor(() => events.find(e => e.type === 'result'), { label: 'result event' })

      const types = events.map(e => e.type)
      const endIdx = types.indexOf('stream_end')
      const errIdx = types.indexOf('error')
      const resIdx = types.indexOf('result')
      assert.notEqual(endIdx, -1, 'stream_end emitted on close when stream was open')
      assert.notEqual(errIdx, -1, 'error emitted for non-zero exit')
      assert.notEqual(resIdx, -1, 'fallback result emitted on close')
      assert.ok(endIdx < errIdx, 'stream_end before error')
    })

    it('multi-message sequencing: rejects second sendMessage while first is busy', async () => {
      writeBaseShim([
        '#!/usr/bin/env node',
        `process.stdout.write(JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'first' }] }) + '\\n')`,
        // Stay busy briefly so the second sendMessage hits while busy.
        `setTimeout(() => {`,
        `  process.stdout.write(JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')`,
        `  process.exit(0)`,
        `}, 100)`,
      ].join('\n'))

      const session = makeSession()
      session._processReady = true
      const results = []
      const errors = []
      const deltas = []
      session.on('result', (r) => results.push(r))
      session.on('error', (e) => errors.push(e))
      session.on('stream_delta', (d) => deltas.push(d))

      await session.sendMessage('first')
      await waitFor(() => deltas.length >= 1, { label: 'first delta' })
      assert.equal(session.isRunning, true, 'first message keeps session busy')

      // Second sendMessage MUST be rejected with a busy error.
      await session.sendMessage('second')
      assert.equal(errors.length, 1, 'second send emitted exactly one error')
      assert.match(errors[0].message, /busy/)

      // First completes normally.
      await waitFor(() => results.length >= 1, { label: 'first result' })
      await waitFor(() => !session.isRunning, { label: 'busy cleared' })

      // Third send succeeds — fully exercises the real mapper again.
      writeBaseShimJsonl([
        { type: 'assistant', content: [{ type: 'text', text: 'third' }] },
        { type: 'result', usage: {} },
      ])
      const seenAfter = []
      session.on('stream_delta', (d) => seenAfter.push(d))
      await session.sendMessage('third')
      await waitFor(() => results.length >= 2, { label: 'third result' })
      assert.ok(seenAfter.some(d => d.delta === 'third'), 'third message went through mapper')
    })

    it('drives the real GeminiSession._processJsonlLine via the base sendMessage', async () => {
      // Tool-flavoured events — confirms the real subclass mapper handles
      // tool_use blocks and standalone tool_result events through the full
      // spawn pipeline.
      writeBaseShimJsonl([
        { type: 'assistant', content: [{ type: 'tool_use', id: 'g-tool-7', name: 'search', input: { q: 'hello' } }] },
        { type: 'tool_result', tool_use_id: 'g-tool-7', content: 'matched 1 doc' },
        { type: 'result', usage: {} },
      ])

      const session = makeSession()
      session._processReady = true
      const toolStarts = []
      const toolResults = []
      const results = []
      session.on('tool_start', (d) => toolStarts.push(d))
      session.on('tool_result', (d) => toolResults.push(d))
      session.on('result', (d) => results.push(d))

      await session.sendMessage('use a tool')
      await waitFor(() => results.length >= 1, { label: 'result' })

      assert.equal(toolStarts.length, 1)
      assert.equal(toolStarts[0].tool, 'search')
      assert.equal(toolStarts[0].toolUseId, 'g-tool-7')
      assert.deepEqual(toolStarts[0].input, { q: 'hello' })

      assert.equal(toolResults.length, 1)
      assert.equal(toolResults[0].toolUseId, 'g-tool-7')
      assert.equal(toolResults[0].result, 'matched 1 doc')
    })
  })

  describe('#4414 learn-loop — _maybeRatchetContextWindow()', () => {
    // The gemini provider registry is module-cached; reset before each test
    // so the pollution from a previous ratchet doesn't bleed in. Mirrors the
    // Codex test setup so both providers exercise the helper identically.
    beforeEach(() => {
      const r = getRegistryForProvider('gemini')
      r.resetModels()
    })

    it('no-op when input_tokens is at or below the registered window', () => {
      const emitted = []
      const fakeSession = { model: 'gemini-2.5-pro', emit: (e, d) => emitted.push({ e, d }) }
      // 2M window — a 500k turn should not trigger.
      const changed = _maybeRatchetContextWindow(fakeSession, 'gemini-2.5-pro', 500_000)
      assert.equal(changed, false)
      assert.equal(emitted.length, 0)
    })

    it('ratchets up when input_tokens exceeds the registered window', () => {
      const emitted = []
      const fakeSession = { model: 'gemini-2.5-pro', emit: (e, d) => emitted.push({ e, d }) }
      // 2.5M input on a 2M registered window → bump to >= 2.5M * 1.1 = 2.75M.
      const changed = _maybeRatchetContextWindow(fakeSession, 'gemini-2.5-pro', 2_500_000)
      assert.equal(changed, true)

      const r = getRegistryForProvider('gemini')
      const m = r.getModels().find(x => x.fullId === 'gemini-2.5-pro')
      assert.ok(m)
      assert.ok(m.contextWindow >= 2_500_000 * GEMINI_CONTEXT_WINDOW_HEADROOM,
        `expected ratcheted window >= ${2_500_000 * GEMINI_CONTEXT_WINDOW_HEADROOM}, got ${m.contextWindow}`)
      // Round-to-1k cleanliness check — meter should not display "2750127".
      assert.equal(m.contextWindow % 1000, 0,
        `expected ratcheted window rounded up to nearest 1k, got ${m.contextWindow}`)
    })

    it('emits models_updated with the updated registry when ratcheted', () => {
      const emitted = []
      const fakeSession = { model: 'gemini-2.5-pro', emit: (e, d) => emitted.push({ e, d }) }
      _maybeRatchetContextWindow(fakeSession, 'gemini-2.5-pro', 2_500_000)
      const evt = emitted.find(x => x.e === 'models_updated')
      assert.ok(evt, 'should emit models_updated so dashboards refresh')
      assert.ok(Array.isArray(evt.d.models))
      const m = evt.d.models.find(x => x.fullId === 'gemini-2.5-pro')
      assert.ok(m && m.contextWindow >= 2_500_000 * GEMINI_CONTEXT_WINDOW_HEADROOM)
    })

    it('only ratchets up — never shrinks the registered window', () => {
      const r = getRegistryForProvider('gemini')
      // Ratchet up first (gemini-2.5-flash starts at 1M).
      const fakeSession = { model: 'gemini-2.5-flash', emit: () => {} }
      _maybeRatchetContextWindow(fakeSession, 'gemini-2.5-flash', 1_500_000)
      const after = r.getModels().find(x => x.fullId === 'gemini-2.5-flash').contextWindow
      assert.ok(after > 1_000_000, 'sanity: ratchet should have raised the window')

      // Now a small turn comes in. Must NOT ratchet down.
      const changed = _maybeRatchetContextWindow(fakeSession, 'gemini-2.5-flash', 100_000)
      assert.equal(changed, false)
      const stable = r.getModels().find(x => x.fullId === 'gemini-2.5-flash').contextWindow
      assert.equal(stable, after,
        'a small follow-up turn must not shrink the ratcheted window')
    })

    it('no-op for an unknown model id', () => {
      const emitted = []
      const fakeSession = { model: 'gemini-99-future', emit: (e, d) => emitted.push({ e, d }) }
      const changed = _maybeRatchetContextWindow(fakeSession, 'gemini-99-future', 999_999_999)
      assert.equal(changed, false, 'unknown models should be a silent no-op, not a throw')
      assert.equal(emitted.length, 0)
    })

    // The cap exists to make a single corrupt turn unable to balloon the
    // registry to an absurd number — a JSONL parse glitch or future Gemini
    // CLI bug must not blow up the meter math downstream. 4M is double
    // today's largest published Gemini window (2M for gemini-2.5-pro), so
    // anything above suggests bad data.
    it('caps the ratchet target at GEMINI_CONTEXT_WINDOW_RATCHET_CAP', () => {
      const fakeSession = { model: 'gemini-2.5-pro', emit: () => {} }
      // A wildly high observed value — e.g. CLI bug or overflow
      _maybeRatchetContextWindow(fakeSession, 'gemini-2.5-pro', 20_000_000)
      const r = getRegistryForProvider('gemini')
      const m = r.getModels().find(x => x.fullId === 'gemini-2.5-pro')
      assert.ok(m)
      assert.ok(m.contextWindow <= GEMINI_CONTEXT_WINDOW_RATCHET_CAP,
        `expected ratchet capped at ${GEMINI_CONTEXT_WINDOW_RATCHET_CAP}, got ${m.contextWindow}`)
    })

    // Defensive guards: a corrupt usage payload (NaN, Infinity, negative)
    // must not feed the ratchet math. NaN * 1.1 = NaN; Infinity * 1.1 =
    // Infinity → unbounded growth (or NaN propagation through the
    // registry → meter showing NaN%). Silent no-op is the right failure.
    for (const bad of [NaN, Infinity, -Infinity, -1, 0]) {
      it(`no-op when input_tokens is invalid (${bad})`, () => {
        const emitted = []
        const fakeSession = { model: 'gemini-2.5-pro', emit: (e, d) => emitted.push({ e, d }) }
        const changed = _maybeRatchetContextWindow(fakeSession, 'gemini-2.5-pro', bad)
        assert.equal(changed, false)
        assert.equal(emitted.length, 0)
      })
    }

    it('Gemini cap (4M) is independent of the Codex cap (2M)', () => {
      // Sanity check that the per-provider cap table actually returns
      // different values for the two providers — guards against a future
      // refactor that accidentally collapses them.
      assert.equal(GEMINI_CONTEXT_WINDOW_RATCHET_CAP, 4_000_000,
        'Gemini cap should be 4M per CONTEXT_WINDOW_RATCHET_CAPS')
    })
  })
})

// #6692 — gemini reports input/output only; the result payload gains a
// synthesized single-model split so per-model accounting works uniformly.
describe('per-model usage on result (#6692)', () => {
  it('production _processJsonlLine result carries synthesized modelUsage', () => {
    const session = new GeminiSession({ cwd: '/tmp', model: 'gemini-2.5-pro' })
    const results = []
    session.on('result', (r) => results.push(r))
    const ctx = { messageId: 'g1', didStreamStart: false, didEmitResult: false }
    session._processJsonlLine({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 } }, ctx)
    assert.equal(results.length, 1)
    assert.deepEqual(results[0].modelUsage, {
      'gemini-2.5-pro': {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        web_search_requests: 0,
        cost_usd: null,
      },
    })
  })
})
