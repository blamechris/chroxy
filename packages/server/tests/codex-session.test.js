import { describe, it, beforeEach, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { CodexSession, buildCodexArgs, resolveCodexSandbox, CODEX_SANDBOX_MODES, CODEX_DEFAULT_SANDBOX, CODEX_CONTEXT_WINDOW_HEADROOM, CODEX_CONTEXT_WINDOW_RATCHET_CAP, _maybeRatchetContextWindow } from '../src/codex-session.js'
import { SkillsTrustStore } from '../src/skills-trust.js'
import { getRegistryForProvider } from '../src/models.js'
import { waitFor } from './test-helpers.js'
// Importing providers.js triggers built-in provider registration so
// getRegistryForProvider('codex') can wire to CodexSession's static hooks
// when this suite runs in isolation. Without this the registry falls back
// to the default Claude registry and the learn-loop ratchet tests below
// would silently no-op.
import '../src/providers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect emitted events from a session into a plain array.
 */
function makeCollector(session) {
  const events = []
  const collect = (...names) => {
    for (const name of names) {
      session.on(name, (data) => events.push({ type: name, ...data }))
    }
  }
  return { events, collect }
}

// Shim binary path — a temporary node script that prints scripted JSONL lines.
const shimPath = join(tmpdir(), `codex-shim-${process.pid}.mjs`)

function writeShim(lines) {
  const payload = lines.map((l) => JSON.stringify(l)).join('\n')
  writeFileSync(shimPath, [
    '#!/usr/bin/env node',
    `process.stdout.write(${JSON.stringify(payload + '\n')})`,
    'process.exit(0)',
  ].join('\n'))
}

function writeExitShim(code) {
  writeFileSync(shimPath, [
    '#!/usr/bin/env node',
    `process.exit(${code})`,
  ].join('\n'))
}

function cleanupShim() {
  if (existsSync(shimPath)) unlinkSync(shimPath)
}

/**
 * Subclass of CodexSession that uses a shim binary instead of the real
 * `codex` CLI.  It mirrors the sendMessage() logic exactly so that the full
 * readline → event pipeline is exercised without needing the real binary.
 */
class ShimmedCodexSession extends CodexSession {
  constructor(opts, shimBin) {
    super(opts)
    this._shimBin = shimBin
  }

  async sendMessage(text) {
    if (!this._processReady) {
      this.emit('error', { message: 'Session is not running' })
      return
    }
    if (this._isBusy) {
      this.emit('error', { message: 'Session is busy' })
      return
    }

    this._isBusy = true
    this._currentMessageId = `codex-msg-${++this._messageCounter}`

    const proc = spawn(process.execPath, [this._shimBin], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this._process = proc
    let didStreamStart = false
    let didEmitResult = false

    const rl = createInterface({ input: proc.stdout })

    rl.on('line', (line) => {
      if (this._destroying) return
      const event = this._parseJsonLine(line)
      if (!event || !event.type) return

      switch (event.type) {
        case 'item.completed': {
          const item = event.item
          if (!item) break
          if (item.type === 'agent_message' && item.text) {
            if (!didStreamStart) {
              this.emit('stream_start', { messageId: this._currentMessageId })
              didStreamStart = true
            }
            this.emit('stream_delta', { messageId: this._currentMessageId, delta: item.text })
          } else if (item.type === 'tool_call') {
            const toolMessageId = `codex-tool-${++this._messageCounter}`
            this.emit('tool_start', {
              messageId: toolMessageId,
              toolUseId: item.id || toolMessageId,
              tool: item.name || 'unknown',
              input: item.arguments || item.input || {},
            })
          } else if (item.type === 'tool_output') {
            this.emit('tool_result', {
              toolUseId: item.call_id || item.id || `codex-tool-${this._messageCounter}`,
              result: item.output || item.text || '',
            })
          }
          break
        }
        case 'turn.completed': {
          didEmitResult = true
          if (didStreamStart) {
            this.emit('stream_end', { messageId: this._currentMessageId })
            didStreamStart = false
          }
          const usage = event.usage || {}
          this.emit('result', {
            cost: null,
            duration: null,
            usage: {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
            },
            sessionId: null,
          })
          break
        }
        default:
          break
      }
    })

    proc.stderr.on('data', () => {})

    proc.on('close', (code) => {
      this._process = null
      this._isBusy = false
      if (this._destroying) return
      if (didStreamStart) {
        this.emit('stream_end', { messageId: this._currentMessageId })
      }
      if (code !== 0 && code !== null) {
        this.emit('error', { message: `Codex process exited with code ${code}` })
      }
      if (!didEmitResult) {
        this.emit('result', { cost: null, duration: null, usage: null, sessionId: null })
      }
    })

    proc.on('error', (err) => {
      this._process = null
      this._isBusy = false
      if (this._destroying) return
      this.emit('error', { message: err.message || 'Failed to spawn codex' })
    })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexSession', () => {
  let savedApiKey
  before(() => {
    savedApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'test-key'
  })
  after(() => {
    if (savedApiKey !== undefined) process.env.OPENAI_API_KEY = savedApiKey
    else delete process.env.OPENAI_API_KEY
  })

  describe('capabilities', () => {
    it('exposes correct static capabilities', () => {
      const caps = CodexSession.capabilities
      assert.equal(caps.permissions, false)
      assert.equal(caps.inProcessPermissions, false)
      assert.equal(caps.modelSwitch, true)
      assert.equal(caps.permissionModeSwitch, false)
      assert.equal(caps.planMode, false)
      assert.equal(caps.resume, false)
      assert.equal(caps.terminal, false)
      assert.equal(caps.thinkingLevel, false)
    })
  })

  describe('constructor', () => {
    it('defers to Codex CLI default when no model is supplied (no hallucinated ID)', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      // We deliberately do NOT ship a hard-coded default like 'gpt-5.4' —
      // that was a hallucinated ID and pins the server to a specific Codex
      // release. A null model signals `sendMessage` to omit the `-m`/`-c
      // model=` flag, so Codex CLI picks its own configured default.
      assert.equal(session.model, null)
      assert.notEqual(session.model, 'gpt-5.4')
    })

    it('accepts a model override', () => {
      const session = new CodexSession({ cwd: '/tmp', model: 'o3' })
      assert.equal(session.model, 'o3')
    })

    it('sets cwd', () => {
      const session = new CodexSession({ cwd: '/some/dir' })
      assert.equal(session.cwd, '/some/dir')
    })

    it('initialises resumeSessionId to null', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      assert.equal(session.resumeSessionId, null)
    })

    // #3865: SessionManager persists resumeSessionId via serializeState() and
    // re-passes it through createSession() on restoreState(). Before this fix
    // the value was silently dropped by the JsonlSubprocessSession middle
    // layer, so a Codex thread captured before a server restart was lost
    // even though every other persistence layer carried it.
    it('accepts resumeSessionId from constructor so restoreState() can rehydrate the thread', () => {
      const session = new CodexSession({ cwd: '/tmp', resumeSessionId: 't-restored' })
      assert.equal(session.resumeSessionId, 't-restored')
    })

    it('treats resumeSessionId=null as no captured thread (back-compat)', () => {
      const session = new CodexSession({ cwd: '/tmp', resumeSessionId: null })
      assert.equal(session.resumeSessionId, null)
    })

    it('initialises _process to null', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      assert.equal(session._process, null)
    })

    it('is not busy or ready after construction', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      assert.equal(session.isRunning, false)
      assert.equal(session.isReady, false)
    })

    // #3755: Leaf constructor must forward resultTimeoutMs through every
    // layer (CodexSession → JsonlSubprocessSession → BaseSession). Otherwise
    // SessionManager's providerOpts.resultTimeoutMs is silently dropped.
    it('forwards resultTimeoutMs to BaseSession (#3755)', () => {
      const session = new CodexSession({ cwd: '/tmp', resultTimeoutMs: 600_000 })
      assert.equal(session._resultTimeoutMs, 600_000)
    })

    it('defaults _resultTimeoutMs to 30 min when omitted (#3755 / #3884)', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      assert.equal(session._resultTimeoutMs, 30 * 60 * 1000)
    })

    // #4790: Leaf constructor must forward streamStallTimeoutMs through every
    // layer (CodexSession → JsonlSubprocessSession → BaseSession). PR #4745
    // wired per-provider overrides through SessionManager — Codex was the
    // motivating case — but each middle layer dropped the key from its
    // destructure list. The existing CapturingProvider-based test in
    // session-manager.test.js missed this because CapturingProvider has no
    // middle layer.
    it('forwards streamStallTimeoutMs to BaseSession (#4790)', () => {
      const session = new CodexSession({ cwd: '/tmp', streamStallTimeoutMs: 900_000 })
      assert.equal(session._streamStallTimeoutMs, 900_000)
    })

    it('defaults _streamStallTimeoutMs to 5 min when omitted (#4790)', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      assert.equal(session._streamStallTimeoutMs, 5 * 60 * 1000)
    })

    it('forwards streamStallTimeoutMs: 0 (explicit disable) to BaseSession (#4790)', () => {
      const session = new CodexSession({ cwd: '/tmp', streamStallTimeoutMs: 0 })
      assert.equal(session._streamStallTimeoutMs, 0)
    })

    // -------------------------------------------------------------------
    // #3225: JsonlSubprocessSession's constructor previously dropped
    // `provider` and `activeManualSkills` (and the budget overrides). The
    // codex/gemini subclasses passed them to super(), but the middle layer
    // didn't accept them — so providers gating, manual activation, and
    // size budgets silently no-op'd for these providers. These tests pin
    // the pass-through.
    // -------------------------------------------------------------------

    it('passes `provider` through to BaseSession (#3225)', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      // Default provider id when caller doesn't override.
      assert.equal(session._provider, 'codex')
    })

    it('passes a custom `provider` through to BaseSession (#3225)', () => {
      const session = new CodexSession({ cwd: '/tmp', provider: 'codex-experimental' })
      assert.equal(session._provider, 'codex-experimental')
    })

    it('passes `activeManualSkills` through to BaseSession (#3225)', () => {
      const session = new CodexSession({
        cwd: '/tmp',
        activeManualSkills: new Set(['my-skill']),
      })
      assert.ok(session._activeManualSkills instanceof Set)
      assert.equal(session._activeManualSkills.has('my-skill'), true)
    })

    it('accepts `activeManualSkills` as an array (#3225)', () => {
      const session = new CodexSession({
        cwd: '/tmp',
        activeManualSkills: ['a', 'b'],
      })
      assert.equal(session._activeManualSkills.has('a'), true)
      assert.equal(session._activeManualSkills.has('b'), true)
    })

    // -------------------------------------------------------------------
    // PR #3231 review (agent-review): JsonlSubprocessSession was the
    // middle layer between CodexSession and BaseSession and silently
    // dropped the second batch of round-2 opts —
    // `providerSkillAllowlist`, `trustStore`, `trustMismatchMode` — even
    // though Codex/Gemini both passed them to super(). The result was
    // that allowlist filtering and trust hashing silently no-op'd for
    // the subprocess providers (the exact regression #3225 was filed
    // to prevent).
    //
    // These tests construct CodexSession directly and verify each opt
    // reaches BaseSession's plumbing.
    // -------------------------------------------------------------------

    describe('round-2 skills opts plumb through JsonlSubprocessSession (#3231)', () => {
      let skillsDir
      beforeEach(() => { skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-codex-r2-')) })
      afterEach(() => { rmSync(skillsDir, { recursive: true, force: true }) })

      it('passes `providerSkillAllowlist` through — denied skills are filtered', () => {
        writeFileSync(join(skillsDir, 'allowed.md'), 'allowed body')
        writeFileSync(join(skillsDir, 'denied.md'), 'denied body')
        const session = new CodexSession({
          cwd: '/tmp',
          provider: 'codex',
          skillsDir,
          repoSkillsDir: null,
          providerSkillAllowlist: { codex: ['allowed'] },
        })
        const names = session._getSkills().map((sk) => sk.name)
        assert.deepEqual(names, ['allowed'])
      })

      it('passes `providerSkillAllowlist` through — fail-secure when entry is missing', () => {
        writeFileSync(join(skillsDir, 'a.md'), 'a body')
        const session = new CodexSession({
          cwd: '/tmp',
          provider: 'codex',
          skillsDir,
          repoSkillsDir: null,
          // Allowlist configured for a different provider — codex should drop everything.
          providerSkillAllowlist: { gemini: ['a'] },
        })
        assert.deepEqual(session._getSkills(), [])
      })

      it('passes `trustStore` through so the loader records hashes', () => {
        writeFileSync(join(skillsDir, 'a.md'), 'body a')
        const trustDir = mkdtempSync(join(tmpdir(), 'chroxy-codex-r2-trust-'))
        const trustPath = join(trustDir, 'trust.json')
        try {
          const trustStore = new SkillsTrustStore({ filePath: trustPath })
          const session = new CodexSession({
            cwd: '/tmp',
            skillsDir,
            repoSkillsDir: null,
            trustStore,
          })
          assert.equal(session._trustStore, trustStore,
            'CodexSession must forward the caller-supplied trust store to BaseSession')
          assert.equal(session._getSkills().length, 1)
          // Records should be populated — the loader hit `inspect()` for `a.md`.
          assert.ok(Object.keys(trustStore._records).length >= 1,
            'trust store should have recorded at least one hash via the loader')
        } finally {
          rmSync(trustDir, { recursive: true, force: true })
        }
      })

      it('passes `trustMismatchMode` through so the default store is wired', () => {
        writeFileSync(join(skillsDir, 'a.md'), 'body a')
        const session = new CodexSession({
          cwd: '/tmp',
          skillsDir,
          repoSkillsDir: null,
          trustMismatchMode: 'warn',
        })
        // No explicit `trustStore` but `trustMismatchMode` should still
        // result in a wired store (BaseSession constructs the default).
        assert.ok(session._trustStore,
          'CodexSession must forward trustMismatchMode so BaseSession wires the default trust store')
        assert.equal(session._trustStore.mode, 'warn')
      })

      // #3185: same middle-layer trap, fresh opt. Without forwarding,
      // a CodexSession started with `promptEvaluator: true` would
      // silently land at BaseSession's `false` default and the
      // toggle would be a no-op for Codex / Gemini specifically.
      it('passes `promptEvaluator` through to BaseSession (#3185)', () => {
        const session = new CodexSession({
          cwd: '/tmp',
          skillsDir,
          repoSkillsDir: null,
          promptEvaluator: true,
        })
        assert.equal(session.promptEvaluator, true,
          'CodexSession must forward promptEvaluator so BaseSession state matches')
      })

      it('without round-2 opts, no trust store is wired (back-compat)', () => {
        writeFileSync(join(skillsDir, 'a.md'), 'body a')
        const session = new CodexSession({
          cwd: '/tmp',
          skillsDir,
          repoSkillsDir: null,
        })
        assert.equal(session._trustStore, null,
          'trust must remain opt-in: no opts → no store')
      })
    })
  })

  describe('start()', () => {
    it('emits ready on the next tick', async () => {
      const session = new CodexSession({ cwd: '/tmp', model: 'o3' })
      const events = []
      session.on('ready', (d) => events.push(d))

      session.start()
      assert.equal(events.length, 0, 'ready must not fire synchronously')

      await waitFor(() => events.length >= 1, { label: 'ready event' })
      assert.equal(events.length, 1)
      assert.equal(events[0].model, 'o3', 'ready payload should include model')
    })

    it('emits ready with null model when no model was supplied (Codex CLI picks default)', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const events = []
      session.on('ready', (d) => events.push(d))

      session.start()
      await waitFor(() => events.length >= 1, { label: 'ready event' })
      assert.equal(events[0].model, null)
    })

    it('sets _processReady so isReady becomes true', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      await waitFor(() => session.isReady, { label: 'isReady' })
      assert.equal(session.isReady, true)
    })

    it('isRunning remains false after start (not yet sending)', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      await waitFor(() => session.isReady, { label: 'isReady' })
      assert.equal(session.isRunning, false)
    })
  })

  describe('destroy()', () => {
    it('resets isReady and isRunning', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      await waitFor(() => session.isReady, { label: 'isReady' })

      session.destroy()
      assert.equal(session.isReady, false)
      assert.equal(session.isRunning, false)
    })

    it('kills _process if one exists', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      await waitFor(() => session.isReady, { label: 'isReady' })

      const mockProc = new EventEmitter()
      let killed = false
      mockProc.kill = () => { killed = true }
      session._process = mockProc

      session.destroy()
      assert.equal(killed, true)
      assert.equal(session._process, null)
    })

    it('removes all listeners', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      await waitFor(() => session.isReady, { label: 'isReady' })
      session.on('result', () => {})

      session.destroy()
      assert.equal(session.listenerCount('result'), 0)
    })
  })

  describe('setModel()', () => {
    it('updates the model property when not busy', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.setModel('o3')
      assert.equal(session.model, 'o3')
    })

    it('does not update the model when busy', () => {
      const session = new CodexSession({ cwd: '/tmp', model: 'o3' })
      session._isBusy = true
      session.setModel('gpt-5-codex')
      // Model should remain unchanged because base class guards on _isBusy
      assert.equal(session.model, 'o3')
    })

    it('model remains the same when setting the same value', () => {
      const session = new CodexSession({ cwd: '/tmp', model: 'o3' })
      session.setModel('o3')
      assert.equal(session.model, 'o3')
    })
  })

  describe('setPermissionMode()', () => {
    it('is callable without throwing', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      assert.doesNotThrow(() => session.setPermissionMode('auto'))
    })
  })

  describe('_parseJsonLine()', () => {
    let session

    beforeEach(() => {
      session = new CodexSession({ cwd: '/tmp' })
    })

    it('parses a valid JSON line', () => {
      const result = session._parseJsonLine('{"type":"thread.started","thread_id":"t1"}')
      assert.deepEqual(result, { type: 'thread.started', thread_id: 't1' })
    })

    it('returns null for invalid JSON', () => {
      assert.equal(session._parseJsonLine('not json'), null)
    })

    it('returns null for an empty string', () => {
      assert.equal(session._parseJsonLine(''), null)
    })

    it('returns null for whitespace-only string', () => {
      assert.equal(session._parseJsonLine('   '), null)
    })

    it('round-trips item.completed correctly', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Hello from Codex' },
      })
      const parsed = session._parseJsonLine(line)
      assert.equal(parsed.type, 'item.completed')
      assert.equal(parsed.item.text, 'Hello from Codex')
    })

    it('round-trips turn.completed correctly', () => {
      const line = JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      const parsed = session._parseJsonLine(line)
      assert.equal(parsed.type, 'turn.completed')
      assert.equal(parsed.usage.input_tokens, 10)
    })

    it('round-trips tool_call item', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: { type: 'tool_call', id: 'tc1', name: 'read_file', arguments: { path: 'a.txt' } },
      })
      const parsed = session._parseJsonLine(line)
      assert.equal(parsed.item.type, 'tool_call')
      assert.equal(parsed.item.name, 'read_file')
    })

    it('round-trips tool_output item', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: { type: 'tool_output', call_id: 'tc1', output: 'file contents' },
      })
      const parsed = session._parseJsonLine(line)
      assert.equal(parsed.item.type, 'tool_output')
      assert.equal(parsed.item.output, 'file contents')
    })
  })

  describe('sendMessage() guards', () => {
    it('emits error when session is not running (_processReady false)', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const errors = []
      session.on('error', (e) => errors.push(e))

      await session.sendMessage('hello')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /not running/)
    })

    it('emits error when session is busy', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session._processReady = true
      session._isBusy = true
      const errors = []
      session.on('error', (e) => errors.push(e))

      await session.sendMessage('hello')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /busy/)
    })

    it('emits error when attachments are supplied', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session._processReady = true
      session._isBusy = false
      const errors = []
      session.on('error', (e) => errors.push(e))

      await session.sendMessage('hello', [{ data: 'x' }])
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /attachments/)
    })
  })

  describe('sendMessage() full pipeline (node shim)', () => {
    it('agent_message item emits stream_start → stream_delta → stream_end → result', async () => {
      writeShim([
        { type: 'item.completed', item: { type: 'agent_message', text: 'Hello!' } },
        { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const { events, collect } = makeCollector(session)
      collect('stream_start', 'stream_delta', 'stream_end', 'result', 'error')

      await session.sendMessage('hi')
      await waitFor(() => events.find(e => e.type === 'result'), { label: 'result event' })

      const types = events.map((e) => e.type)
      assert.ok(types.includes('stream_start'), 'expected stream_start')
      assert.ok(types.includes('stream_delta'), 'expected stream_delta')
      assert.ok(types.includes('stream_end'), 'expected stream_end')
      assert.ok(types.includes('result'), 'expected result')

      const delta = events.find((e) => e.type === 'stream_delta')
      assert.equal(delta.delta, 'Hello!')

      cleanupShim()
    })

    it('turn.completed emits result with usage', async () => {
      writeShim([
        { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 42 } },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const results = []
      session.on('result', (d) => results.push(d))

      await session.sendMessage('hi')
      await waitFor(() => results.length >= 1, { label: 'result event' })

      assert.equal(results.length, 1)
      assert.equal(results[0].usage.input_tokens, 100)
      assert.equal(results[0].usage.output_tokens, 42)
      assert.equal(results[0].cost, null)
      assert.equal(results[0].sessionId, null)

      cleanupShim()
    })

    it('tool_call item emits tool_start', async () => {
      writeShim([
        {
          type: 'item.completed',
          item: { type: 'tool_call', id: 'tc-1', name: 'read_file', arguments: { path: 'a.txt' } },
        },
        { type: 'turn.completed', usage: {} },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const toolStarts = []
      session.on('tool_start', (d) => toolStarts.push(d))

      await session.sendMessage('hi')
      await waitFor(() => toolStarts.length >= 1, { label: 'tool_start event' })

      assert.equal(toolStarts.length, 1)
      assert.equal(toolStarts[0].tool, 'read_file')
      assert.equal(toolStarts[0].toolUseId, 'tc-1')
      assert.deepEqual(toolStarts[0].input, { path: 'a.txt' })

      cleanupShim()
    })

    it('tool_output item emits tool_result', async () => {
      writeShim([
        {
          type: 'item.completed',
          item: { type: 'tool_output', call_id: 'tc-1', output: 'file data' },
        },
        { type: 'turn.completed', usage: {} },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const toolResults = []
      session.on('tool_result', (d) => toolResults.push(d))

      await session.sendMessage('hi')
      await waitFor(() => toolResults.length >= 1, { label: 'tool_result event' })

      assert.equal(toolResults.length, 1)
      assert.equal(toolResults[0].toolUseId, 'tc-1')
      assert.equal(toolResults[0].result, 'file data')

      cleanupShim()
    })

    it('emits result with null usage when no turn.completed received', async () => {
      writeShim([])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const results = []
      session.on('result', (d) => results.push(d))

      await session.sendMessage('hi')
      await waitFor(() => results.length >= 1, { label: 'result event' })

      assert.equal(results.length, 1)
      assert.equal(results[0].usage, null)

      cleanupShim()
    })

    it('non-zero exit code emits error', async () => {
      writeExitShim(1)

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const errors = []
      session.on('error', (e) => errors.push(e))
      session.on('result', () => {})

      await session.sendMessage('hi')
      await waitFor(() => errors.length >= 1, { label: 'error event' })

      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /code 1/)

      cleanupShim()
    })

    it('_isBusy is cleared after process closes', async () => {
      writeShim([
        { type: 'turn.completed', usage: {} },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true

      await session.sendMessage('hi')
      assert.equal(session.isRunning, true)

      await waitFor(() => !session.isRunning, { label: 'isRunning cleared' })
      assert.equal(session.isRunning, false)

      cleanupShim()
    })

    it('stream_start, stream_delta and stream_end share the same messageId', async () => {
      writeShim([
        { type: 'item.completed', item: { type: 'agent_message', text: 'A' } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'B' } },
        { type: 'turn.completed', usage: {} },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const { events, collect } = makeCollector(session)
      collect('stream_start', 'stream_delta', 'stream_end')

      await session.sendMessage('hi')
      await waitFor(() => events.find(e => e.type === 'stream_end'), { label: 'stream_end event' })

      const start = events.find((e) => e.type === 'stream_start')
      const deltas = events.filter((e) => e.type === 'stream_delta')
      const end = events.find((e) => e.type === 'stream_end')

      assert.ok(start, 'stream_start missing')
      assert.equal(deltas.length, 2)
      assert.ok(end, 'stream_end missing')

      for (const d of deltas) {
        assert.equal(d.messageId, start.messageId)
      }
      assert.equal(end.messageId, start.messageId)

      cleanupShim()
    })

    it('unknown JSONL types (turn.started) are silently ignored', async () => {
      writeShim([
        { type: 'turn.started' },
        { type: 'turn.completed', usage: {} },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const { events, collect } = makeCollector(session)
      const results = []
      session.on('result', (d) => results.push(d))
      collect('stream_start', 'stream_delta', 'error')

      await session.sendMessage('hi')
      // Wait for process to finish (result event confirms turn.completed was processed)
      await waitFor(() => results.length >= 1, { label: 'result event' })

      const streamEvents = events.filter((e) => e.type === 'stream_start' || e.type === 'stream_delta')
      const errors = events.filter((e) => e.type === 'error')
      assert.equal(streamEvents.length, 0, 'no stream events for unknown types')
      assert.equal(errors.length, 0, 'no errors for unknown types')

      cleanupShim()
    })

    it('model is included in ready event from start()', async () => {
      const session = new CodexSession({ cwd: '/tmp', model: 'o3' })
      const readyEvents = []
      session.on('ready', (d) => readyEvents.push(d))
      session.start()
      await waitFor(() => readyEvents.length >= 1, { label: 'ready event' })

      assert.equal(readyEvents.length, 1)
      assert.equal(readyEvents[0].model, 'o3')
    })
  })

  describe('start() API key validation', () => {
    let savedCodexHome, noOauthDir
    beforeEach(() => {
      // #6563: isolate the OAuth probe from the test machine's ~/.codex so the
      // "no creds → throws" expectation is deterministic regardless of whether the
      // dev has run `codex login`. Point CHROXY_CODEX_HOME at an empty dir.
      savedCodexHome = process.env.CHROXY_CODEX_HOME
      noOauthDir = mkdtempSync(join(tmpdir(), 'chroxy-codex-noauth-'))
      process.env.CHROXY_CODEX_HOME = noOauthDir
    })
    afterEach(() => {
      process.env.OPENAI_API_KEY = 'test-key'
      if (savedCodexHome === undefined) delete process.env.CHROXY_CODEX_HOME
      else process.env.CHROXY_CODEX_HOME = savedCodexHome
      try { rmSync(noOauthDir, { recursive: true, force: true }) } catch { /* best effort */ }
    })

    it('throws when OPENAI_API_KEY is not set and no OAuth creds', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      delete process.env.OPENAI_API_KEY
      assert.throws(() => session.start(), {
        message: /OPENAI_API_KEY.*not set/,
      })
    })

    it('succeeds when OPENAI_API_KEY is set', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      assert.equal(session._processReady, true)
      session.destroy()
    })

    // #6563: a `codex login`-only user (OAuth tokens in ~/.codex/auth.json, no
    // OPENAI_API_KEY) must be runtime-ready — start() must NOT throw (matching
    // resolveAuth()'s ready:true), and preflight marks the env var optional so
    // `chroxy doctor` downgrades the missing key from fail→warn (not a hard
    // failure). All three layers share the hasCodexOAuthCreds probe.
    it('#6563: OAuth-only (auth.json present, no env var) — start() does not throw + preflight optional', () => {
      const oauthDir = mkdtempSync(join(tmpdir(), 'chroxy-codex-oauth-'))
      writeFileSync(join(oauthDir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'tok-abc' } }))
      const savedHome = process.env.CHROXY_CODEX_HOME
      process.env.CHROXY_CODEX_HOME = oauthDir
      delete process.env.OPENAI_API_KEY
      try {
        assert.equal(CodexSession.hasAlternativeCredentials(), true)
        assert.equal(CodexSession.preflight.credentials.optional, true, 'preflight marks the key optional so doctor downgrades a missing key fail→warn, not a hard failure')
        const session = new CodexSession({ cwd: '/tmp' })
        assert.doesNotThrow(() => session.start(), 'OAuth-only user is not rejected at runtime')
        assert.equal(session._processReady, true)
        session.destroy()
      } finally {
        if (savedHome === undefined) delete process.env.CHROXY_CODEX_HOME
        else process.env.CHROXY_CODEX_HOME = savedHome
        try { rmSync(oauthDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Argv construction — verifies we never spawn `codex` with a hallucinated
  // `-m` / `-c model=...` flag when no model was supplied.
  // ---------------------------------------------------------------------------
  describe('buildCodexArgs()', () => {
    it('always emits `exec <text> --json` as the first three args', () => {
      const args = buildCodexArgs('hello', null)
      assert.deepEqual(args.slice(0, 3), ['exec', 'hello', '--json'])
    })

    it('omits the -c model=... override when model is null', () => {
      const args = buildCodexArgs('hi', null)
      assert.ok(!args.includes('-c'), `unexpected -c in args: ${JSON.stringify(args)}`)
      const hasModelOverride = args.some((a) => typeof a === 'string' && a.startsWith('model='))
      assert.ok(!hasModelOverride, `unexpected model override: ${JSON.stringify(args)}`)
    })

    it('omits the -c model=... override when model is an empty string', () => {
      const args = buildCodexArgs('hi', '')
      assert.ok(!args.includes('-c'))
    })

    it('never references the hallucinated `gpt-5.4` when given no model', () => {
      const args = buildCodexArgs('hi', null)
      assert.ok(!args.some((a) => typeof a === 'string' && a.includes('gpt-5.4')),
        `args must not reference hallucinated model: ${JSON.stringify(args)}`)
    })

    it('appends -c model="X" when an explicit model is provided', () => {
      const args = buildCodexArgs('hi', 'o3')
      const idx = args.indexOf('-c')
      assert.ok(idx >= 0, '-c flag should be present when model is set')
      assert.equal(args[idx + 1], 'model="o3"')
    })

    it('always passes --skip-git-repo-check (#3834)', () => {
      // Codex exec refuses non-trusted (non-git) dirs without this flag and
      // exits 1 with no diagnostic the user can see. Chroxy owns its own
      // session-trust gate so the codex git-repo heuristic is redundant.
      assert.ok(buildCodexArgs('hi', null).includes('--skip-git-repo-check'))
      assert.ok(buildCodexArgs('hi', 'o3').includes('--skip-git-repo-check'))
    })

    it('always passes --sandbox workspace-write (#3837)', () => {
      // Without this, codex exec defaults to read-only in any directory
      // not explicitly trusted in ~/.codex/config.toml, so Codex can't
      // edit files in fresh chroxy sessions. The user picking the directory
      // in chroxy is the trust signal.
      const args = buildCodexArgs('hi', null)
      const idx = args.indexOf('--sandbox')
      assert.ok(idx >= 0, '--sandbox flag should be present')
      assert.equal(args[idx + 1], 'workspace-write')
      // Also present when a model is configured.
      const withModel = buildCodexArgs('hi', 'o3')
      const idxModel = withModel.indexOf('--sandbox')
      assert.ok(idxModel >= 0, '--sandbox flag should be present with model')
      assert.ok(idxModel + 1 < withModel.length, '--sandbox should have a value')
      assert.equal(withModel[idxModel + 1], 'workspace-write')
    })

    // #3865: multi-turn context loss. Without a threadId, every sendMessage
    // spawns `codex exec "<prompt>"` as a fresh thread and Codex has no
    // memory of prior turns. When a threadId is supplied, argv switches to
    // `codex exec resume <thread_id> <text>` so the CLI replays state.
    describe('threadId resume (#3865)', () => {
      it('emits the resume form when threadId is supplied', () => {
        const args = buildCodexArgs('continue', null, 'thread-abc-123')
        assert.equal(args[0], 'exec')
        // SESSION_ID and PROMPT follow the `resume` subcommand
        const resumeIdx = args.indexOf('resume')
        assert.ok(resumeIdx > 0, 'resume subcommand must be present')
        assert.equal(args[resumeIdx + 1], 'thread-abc-123')
        assert.equal(args[resumeIdx + 2], 'continue')
        assert.ok(args.includes('--json'))
        assert.ok(args.includes('--skip-git-repo-check'))
        const sandboxIdx = args.indexOf('--sandbox')
        assert.equal(args[sandboxIdx + 1], 'workspace-write')
      })

      // codex-cli 0.128.0 — `codex exec resume --sandbox ...` errors with
      // `unexpected argument '--sandbox' found`. The flag is only declared on
      // the parent `exec` command, so argv must place --sandbox BEFORE the
      // `resume` subcommand. This pins that contract so the bug can't slip
      // back in via a future refactor.
      it('places --sandbox BEFORE the resume subcommand (codex-cli requires this)', () => {
        const args = buildCodexArgs('continue', null, 'thread-abc')
        const sandboxIdx = args.indexOf('--sandbox')
        const resumeIdx = args.indexOf('resume')
        assert.ok(sandboxIdx >= 0, '--sandbox must be present')
        assert.ok(resumeIdx >= 0, 'resume subcommand must be present')
        assert.ok(
          sandboxIdx < resumeIdx,
          `--sandbox (idx ${sandboxIdx}) must come before resume (idx ${resumeIdx}); ` +
          'codex exec resume rejects --sandbox as a subcommand flag',
        )
      })

      it('emits the resume form with model override', () => {
        const args = buildCodexArgs('continue', 'o3', 'thread-abc')
        const resumeIdx = args.indexOf('resume')
        assert.ok(resumeIdx > 0)
        assert.equal(args[resumeIdx + 1], 'thread-abc')
        const cIdx = args.indexOf('-c')
        assert.equal(args[cIdx + 1], 'model="o3"')
      })

      it('falls back to first-turn form when threadId is null', () => {
        const args = buildCodexArgs('hi', null, null)
        assert.equal(args[0], 'exec')
        assert.equal(args[1], 'hi')
        assert.ok(!args.includes('resume'))
      })

      it('falls back to first-turn form when threadId is omitted', () => {
        const args = buildCodexArgs('hi', null)
        assert.equal(args[0], 'exec')
        assert.equal(args[1], 'hi')
        assert.ok(!args.includes('resume'))
      })
    })

    // #3847: CHROXY_CODEX_SANDBOX env var lets operators override the default
    // sandbox mode without source edits. The per-session selector under #3837
    // remains the proper fix; this is a stopgap for multi-tenant / shared-dev
    // hosts where the operator wants Codex to start more restrictive.
    describe('CHROXY_CODEX_SANDBOX env override (#3847)', () => {
      let savedEnv
      beforeEach(() => { savedEnv = process.env.CHROXY_CODEX_SANDBOX })
      afterEach(() => {
        if (savedEnv === undefined) delete process.env.CHROXY_CODEX_SANDBOX
        else process.env.CHROXY_CODEX_SANDBOX = savedEnv
      })

      it('exports the canonical sandbox mode list', () => {
        // Source of truth for what we accept — keeps tests honest if a mode is
        // added or removed without re-validating the env contract.
        assert.ok(Array.isArray(CODEX_SANDBOX_MODES))
        assert.ok(CODEX_SANDBOX_MODES.includes('read-only'))
        assert.ok(CODEX_SANDBOX_MODES.includes('workspace-write'))
        assert.ok(CODEX_SANDBOX_MODES.includes('danger-full-access'))
      })

      it('exports the documented default (workspace-write)', () => {
        assert.equal(CODEX_DEFAULT_SANDBOX, 'workspace-write')
      })

      it('resolveCodexSandbox() falls back to workspace-write when env is unset', () => {
        delete process.env.CHROXY_CODEX_SANDBOX
        assert.equal(resolveCodexSandbox(), 'workspace-write')
      })

      it('resolveCodexSandbox() falls back to workspace-write when env is empty', () => {
        process.env.CHROXY_CODEX_SANDBOX = ''
        assert.equal(resolveCodexSandbox(), 'workspace-write')
      })

      it('resolveCodexSandbox() honours read-only', () => {
        process.env.CHROXY_CODEX_SANDBOX = 'read-only'
        assert.equal(resolveCodexSandbox(), 'read-only')
      })

      it('resolveCodexSandbox() honours workspace-write', () => {
        process.env.CHROXY_CODEX_SANDBOX = 'workspace-write'
        assert.equal(resolveCodexSandbox(), 'workspace-write')
      })

      it('resolveCodexSandbox() honours danger-full-access', () => {
        process.env.CHROXY_CODEX_SANDBOX = 'danger-full-access'
        assert.equal(resolveCodexSandbox(), 'danger-full-access')
      })

      it('resolveCodexSandbox() trims surrounding whitespace', () => {
        // Common foot-gun when copy-pasting from shell exports / docker-compose.
        process.env.CHROXY_CODEX_SANDBOX = '  read-only  '
        assert.equal(resolveCodexSandbox(), 'read-only')
      })

      it('resolveCodexSandbox() rejects unknown values and falls back to default', () => {
        // Per the proposal in #3847 — log a warning and fall back, do not throw.
        // Throwing would refuse to start the whole server, which is the wrong
        // failure mode for a stopgap env knob.
        process.env.CHROXY_CODEX_SANDBOX = 'gimme-root'
        const warnings = []
        const origWarn = console.warn
        console.warn = (msg) => warnings.push(String(msg))
        try {
          assert.equal(resolveCodexSandbox(), 'workspace-write')
        } finally {
          console.warn = origWarn
        }
        assert.ok(
          warnings.some((m) => m.includes('CHROXY_CODEX_SANDBOX')),
          `expected a warning mentioning CHROXY_CODEX_SANDBOX, got: ${JSON.stringify(warnings)}`,
        )
      })

      it('resolveCodexSandbox() is case-sensitive (refuses Read-Only)', () => {
        // Codex CLI itself is case-sensitive on these flag values; do not
        // silently coerce or we mask a typo that would have failed loudly.
        process.env.CHROXY_CODEX_SANDBOX = 'Read-Only'
        const origWarn = console.warn
        console.warn = () => {}
        try {
          assert.equal(resolveCodexSandbox(), 'workspace-write')
        } finally {
          console.warn = origWarn
        }
      })

      it('resolveCodexSandbox(override) — a valid per-session override wins over env/default (#6638)', () => {
        process.env.CHROXY_CODEX_SANDBOX = 'read-only'
        assert.equal(resolveCodexSandbox('danger-full-access'), 'danger-full-access', 'override beats env')
        delete process.env.CHROXY_CODEX_SANDBOX
        assert.equal(resolveCodexSandbox('read-only'), 'read-only', 'override beats the default')
        assert.equal(resolveCodexSandbox('  workspace-write  '), 'workspace-write', 'override is trimmed')
      })

      it('resolveCodexSandbox(override) — an invalid/absent override falls through to env/default (#6638)', () => {
        process.env.CHROXY_CODEX_SANDBOX = 'read-only'
        assert.equal(resolveCodexSandbox('gimme-root'), 'read-only', 'invalid override → env resolution')
        delete process.env.CHROXY_CODEX_SANDBOX
        assert.equal(resolveCodexSandbox('bogus'), 'workspace-write', 'invalid override + no env → default')
        assert.equal(resolveCodexSandbox(undefined), 'workspace-write', 'no override → default')
      })

      // #3981: resolveCodexSandbox() runs on every sendMessage(). Without
      // a per-value warn cache, a single typo in an operator's environment
      // would spam console.warn for every turn for the lifetime of the
      // server. Pin the once-per-distinct-value behavior so log volume is
      // bounded but typo discoverability is preserved.
      describe('warn-once on invalid values (#3981)', () => {
        it('warns exactly once when the same invalid value is resolved repeatedly', () => {
          process.env.CHROXY_CODEX_SANDBOX = 'bogus-once'
          const warnings = []
          const origWarn = console.warn
          console.warn = (msg) => warnings.push(String(msg))
          try {
            assert.equal(resolveCodexSandbox(), 'workspace-write')
            assert.equal(resolveCodexSandbox(), 'workspace-write')
            assert.equal(resolveCodexSandbox(), 'workspace-write')
          } finally {
            console.warn = origWarn
          }
          const matched = warnings.filter((m) => m.includes('bogus-once'))
          assert.equal(
            matched.length,
            1,
            `expected exactly one warning for 'bogus-once', got ${matched.length}: ${JSON.stringify(warnings)}`,
          )
        })

        it('warns again when a different invalid value is supplied (typo correction)', () => {
          const warnings = []
          const origWarn = console.warn
          console.warn = (msg) => warnings.push(String(msg))
          try {
            process.env.CHROXY_CODEX_SANDBOX = 'bogus-typo-a'
            assert.equal(resolveCodexSandbox(), 'workspace-write')
            assert.equal(resolveCodexSandbox(), 'workspace-write')
            process.env.CHROXY_CODEX_SANDBOX = 'bogus-typo-b'
            assert.equal(resolveCodexSandbox(), 'workspace-write')
            assert.equal(resolveCodexSandbox(), 'workspace-write')
          } finally {
            console.warn = origWarn
          }
          const a = warnings.filter((m) => m.includes('bogus-typo-a'))
          const b = warnings.filter((m) => m.includes('bogus-typo-b'))
          assert.equal(a.length, 1, `expected one warn for typo-a, got: ${JSON.stringify(warnings)}`)
          assert.equal(b.length, 1, `expected one warn for typo-b, got: ${JSON.stringify(warnings)}`)
        })
      })

      it('buildCodexArgs() emits --sandbox read-only when env is set (first-turn form)', () => {
        process.env.CHROXY_CODEX_SANDBOX = 'read-only'
        const args = buildCodexArgs('hi', null)
        const idx = args.indexOf('--sandbox')
        assert.ok(idx >= 0, '--sandbox flag must be present')
        assert.equal(args[idx + 1], 'read-only')
      })

      it('buildCodexArgs() emits --sandbox read-only when env is set (resume form)', () => {
        process.env.CHROXY_CODEX_SANDBOX = 'read-only'
        const args = buildCodexArgs('continue', null, 'thread-abc')
        const idx = args.indexOf('--sandbox')
        assert.ok(idx >= 0, '--sandbox flag must be present on resume too')
        assert.equal(args[idx + 1], 'read-only')
        // Invariant from #3865/#3837: --sandbox must still come BEFORE resume.
        const resumeIdx = args.indexOf('resume')
        assert.ok(idx < resumeIdx, '--sandbox must precede resume subcommand')
      })

      it('buildCodexArgs() emits --sandbox danger-full-access when env requests it', () => {
        process.env.CHROXY_CODEX_SANDBOX = 'danger-full-access'
        const args = buildCodexArgs('hi', null)
        const idx = args.indexOf('--sandbox')
        assert.equal(args[idx + 1], 'danger-full-access')
      })

      it('buildCodexArgs() still defaults to workspace-write when env is unset', () => {
        // Back-compat: the #3846 stopgap must keep working for operators who
        // do not set the env var.
        delete process.env.CHROXY_CODEX_SANDBOX
        const args = buildCodexArgs('hi', null)
        const idx = args.indexOf('--sandbox')
        assert.equal(args[idx + 1], 'workspace-write')
      })

      it('buildCodexArgs() falls back to workspace-write on an invalid env value', () => {
        process.env.CHROXY_CODEX_SANDBOX = 'no-such-mode'
        const origWarn = console.warn
        console.warn = () => {}
        try {
          const args = buildCodexArgs('hi', null)
          const idx = args.indexOf('--sandbox')
          assert.equal(args[idx + 1], 'workspace-write')
        } finally {
          console.warn = origWarn
        }
      })

      it('buildCodexArgs() reads the env var at call time, not module-load time', () => {
        // Critical for tests, hot-reload, and the rare operator who changes the
        // env in-process. If we cached at module init, this test would fail
        // because the env wasn't set when the module first loaded.
        delete process.env.CHROXY_CODEX_SANDBOX
        const before = buildCodexArgs('hi', null)
        const beforeIdx = before.indexOf('--sandbox')
        assert.equal(before[beforeIdx + 1], 'workspace-write')

        process.env.CHROXY_CODEX_SANDBOX = 'read-only'
        const after = buildCodexArgs('hi', null)
        const afterIdx = after.indexOf('--sandbox')
        assert.equal(after[afterIdx + 1], 'read-only')
      })
    })
  })

  // -------------------------------------------------------------------
  // #3865 — thread.started capture and resume-form argv selection.
  // Without this, every sendMessage on a Codex session spawns a fresh
  // subprocess with no prior conversation context.
  // -------------------------------------------------------------------
  describe('thread.started capture (#3865)', () => {
    it('captures thread_id from thread.started and stores it on resumeSessionId', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      assert.equal(session.resumeSessionId, null)
      session._processJsonlLine(
        { type: 'thread.started', thread_id: 't-deadbeef' },
        { didStreamStart: false, didEmitResult: false },
      )
      assert.equal(session.resumeSessionId, 't-deadbeef')
    })

    it('ignores thread.started with missing thread_id', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session._processJsonlLine(
        { type: 'thread.started' },
        { didStreamStart: false, didEmitResult: false },
      )
      assert.equal(session.resumeSessionId, null)
    })

    it('_buildArgs switches to resume form after thread_id is captured', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const first = session._buildArgs('hi')
      assert.equal(first[0], 'exec')
      assert.equal(first[1], 'hi')
      assert.ok(!first.includes('resume'))

      session._processJsonlLine(
        { type: 'thread.started', thread_id: 't-1234' },
        { didStreamStart: false, didEmitResult: false },
      )

      const second = session._buildArgs('continue')
      assert.equal(second[0], 'exec')
      const resumeIdx = second.indexOf('resume')
      assert.ok(resumeIdx > 0, 'resume subcommand present on subsequent turns')
      assert.equal(second[resumeIdx + 1], 't-1234')
      assert.equal(second[resumeIdx + 2], 'continue')
    })

    it('result event includes the captured sessionId (was null pre-#3865)', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const results = []
      session.on('result', (d) => results.push(d))

      session._processJsonlLine(
        { type: 'thread.started', thread_id: 't-99' },
        { didStreamStart: false, didEmitResult: false },
      )
      session._processJsonlLine(
        { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } },
        { didStreamStart: false, didEmitResult: false },
      )

      assert.equal(results.length, 1)
      assert.equal(results[0].sessionId, 't-99')
    })
  })

  describe('binary candidate list', () => {
    // Regression: the Tauri GUI launch path bug that bit claude (#2891) also
    // affects codex when installed via curl|sh to ~/.local/bin or via
    // `npm install -g` to ~/.npm-global. Candidate list must cover both.
    it('includes ~/.local/bin/codex, Homebrew, /usr/local, and ~/.npm-global/bin', async () => {
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const { CodexSession } = await import('../src/codex-session.js')
      const candidates = CodexSession.binaryCandidates

      assert.ok(
        candidates.includes(join(homedir(), '.local/bin/codex')),
        'candidate list must include ~/.local/bin/codex')
      assert.ok(
        candidates.includes('/opt/homebrew/bin/codex'),
        'candidate list must include /opt/homebrew/bin/codex')
      assert.ok(
        candidates.includes('/usr/local/bin/codex'),
        'candidate list must include /usr/local/bin/codex')
      assert.ok(
        candidates.includes(join(homedir(), '.npm-global/bin/codex')),
        'candidate list must include ~/.npm-global/bin/codex')
    })

    it('uses homedir() for user-local candidate paths', async () => {
      const { readFileSync } = await import('node:fs')
      const { dirname, join } = await import('node:path')
      const { fileURLToPath } = await import('node:url')
      const dir = dirname(fileURLToPath(import.meta.url))
      const source = readFileSync(join(dir, '../src/codex-session.js'), 'utf-8')

      // User-relative paths must be joined with homedir() — not hard-coded
      assert.ok(/import\s*\{[^}]*homedir[^}]*\}\s*from\s*'os'/.test(source),
        'codex-session.js must import homedir from os')
      assert.ok(/import\s*\{[^}]*join[^}]*\}\s*from\s*'path'/.test(source),
        'codex-session.js must import join from path')
    })
  })

  // ---------------------------------------------------------------------------
  // sendMessage() through the FULL spawn pipeline of the JsonlSubprocessSession
  // base class — closes #2991.
  //
  // The existing `ShimmedCodexSession` block above re-implements sendMessage()
  // on top of the subclass, so a misconfigured `resolvedBinary` or broken
  // `_buildArgs()` would never surface. Below we override only the static
  // `resolvedBinary` (point it at node) and `_buildArgs()` (point node at our
  // shim script) so the real `JsonlSubprocessSession.sendMessage()` runs
  // through the real `CodexSession._processJsonlLine()`.
  // ---------------------------------------------------------------------------
  describe('sendMessage() via JsonlSubprocessSession base (#2991)', () => {
    const baseShimPath = join(tmpdir(), `codex-base-shim-${process.pid}-${Date.now()}.mjs`)

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
     * CodexSession but with the binary swapped for `node` and argv overridden
     * to invoke the shim script. _buildChildEnv, _processJsonlLine,
     * _shouldSkipStderr, _emitFallbackResult all flow from the real subclass.
     */
    class BaseShimmedCodex extends CodexSession {
      static get resolvedBinary() {
        return process.execPath
      }

      _buildArgs(text) {
        // Node executes the shim; pass `text` through so the shim could echo it.
        return [baseShimPath, text]
      }
    }

    // Track every session created in this block so afterEach can guarantee
    // the spawned shim subprocess is killed even if a `waitFor` throws —
    // otherwise a `setInterval(...)` shim could outlive the test run and
    // hang the whole suite.
    const createdSessions = []
    function makeSession(opts) {
      const s = new BaseShimmedCodex(opts || { cwd: '/tmp' })
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

    it('successful round-trip: agent_message + turn.completed → stream + result', async () => {
      writeBaseShimJsonl([
        { type: 'item.completed', item: { type: 'agent_message', text: 'Hi from base' } },
        { type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 4 } },
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
      assert.deepEqual(types, ['stream_start', 'stream_delta', 'stream_end', 'result'])

      const delta = seen.find((e) => e.type === 'stream_delta')
      assert.equal(delta.delta, 'Hi from base')

      const start = seen.find((e) => e.type === 'stream_start')
      const end = seen.find((e) => e.type === 'stream_end')
      assert.equal(end.messageId, start.messageId, 'stream_end shares stream_start id')
      assert.match(start.messageId, /^codex-msg-/, 'codex prefix preserved by base class')

      const result = seen.find((e) => e.type === 'result')
      assert.equal(result.usage.input_tokens, 11)
      assert.equal(result.usage.output_tokens, 4)
    })

    it('abort mid-stream: interrupt() kills the subprocess and clears busy', async () => {
      // Long-lived shim — emits one chunk then sleeps so we have time to interrupt.
      writeBaseShim([
        '#!/usr/bin/env node',
        `process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'starting...' } }) + '\\n')`,
        // Hang waiting for SIGINT — our interrupt() should kill us.
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
      // Wait for the first delta to confirm the subprocess is live.
      await waitFor(() => deltas.length >= 1, { label: 'first delta before interrupt' })
      assert.equal(session.isRunning, true, 'session must be busy mid-stream')

      session.interrupt()

      // After SIGINT the subprocess exits; close handler clears busy and
      // emits a fallback result (turn.completed never arrived).
      await waitFor(() => !session.isRunning, { label: 'isRunning cleared after interrupt' })
      assert.equal(session._process, null, '_process cleared after close')
      assert.ok(results.length >= 1, 'fallback result fired after abort')
    })

    it('subprocess crash: non-zero exit emits error with displayLabel + code', async () => {
      // Crash before any JSONL — ensures we still hit the close path.
      writeBaseShimJsonl([], { exitCode: 13, stderr: 'ERROR: codex blew up\n' })

      const session = makeSession()
      session._processReady = true
      const errors = []
      const results = []
      session.on('error', (e) => errors.push(e))
      session.on('result', (r) => results.push(r))

      await session.sendMessage('hi')
      await waitFor(() => errors.length >= 1, { label: 'error event' })

      assert.equal(errors.length, 1)
      // Codex uses displayLabel 'OpenAI Codex' (verified by the static).
      assert.match(errors[0].message, /OpenAI Codex.*code 13/)
      // Stderr is surfaced in the exit error so users see *why* codex died.
      assert.match(errors[0].message, /codex blew up/)
    })

    it('subprocess crash mid-stream: stream_end + error + fallback result', async () => {
      // Emit a partial stream then exit non-zero before turn.completed.
      writeBaseShimJsonl([
        { type: 'item.completed', item: { type: 'agent_message', text: 'partial...' } },
      ], { exitCode: 1, stderr: 'ERROR: pipe broken' })

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
      // stream_end must fire before error+result so clients can close their bubble
      const endIdx = types.indexOf('stream_end')
      const errIdx = types.indexOf('error')
      assert.notEqual(endIdx, -1, 'stream_end emitted on close when stream was open')
      assert.notEqual(errIdx, -1, 'error emitted for non-zero exit')
      assert.ok(endIdx < errIdx, 'stream_end before error')
      // No turn.completed arrived, but the stream did produce output before
      // the subprocess crashed — Codex inherits the base _emitFallbackResult
      // default, which fires exactly one result event so clients can transition
      // back to idle.
    })

    it('does not keep stdin open when prompt is passed as argv', async () => {
      // `codex exec` appends piped stdin to the prompt and waits for EOF. The
      // base runner must therefore give subprocess providers an ignored stdin
      // handle instead of an open pipe.
      writeBaseShim([
        '#!/usr/bin/env node',
        'process.stdin.resume()',
        'process.stdin.on("end", () => {',
        `  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stdin closed' } }) + '\\n')`,
        `  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n')`,
        '})',
      ].join('\n'))

      const session = makeSession()
      session._processReady = true
      const deltas = []
      const results = []
      session.on('stream_delta', (d) => deltas.push(d))
      session.on('result', (r) => results.push(r))

      await session.sendMessage('hello')
      await waitFor(() => results.length >= 1, { label: 'result after stdin EOF' })
      await waitFor(() => !session.isRunning, { label: 'isRunning cleared after stdin EOF' })

      assert.equal(deltas[0]?.delta, 'stdin closed')
      assert.equal(session.isRunning, false, 'session should not remain busy waiting for stdin')
    })

    it('multi-message sequencing: rejects second sendMessage while first is busy', async () => {
      // Long-running first message — stays busy until we let it finish.
      writeBaseShim([
        '#!/usr/bin/env node',
        `process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }) + '\\n')`,
        // Wait 100ms to give the second sendMessage a chance to fire while busy.
        `setTimeout(() => {`,
        `  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')`,
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
      // Wait for the subprocess to start streaming — confirms _isBusy=true.
      await waitFor(() => deltas.length >= 1, { label: 'first delta' })
      assert.equal(session.isRunning, true, 'first message keeps session busy')

      // Second sendMessage MUST be rejected with a busy error.
      await session.sendMessage('second')
      assert.equal(errors.length, 1, 'second send emitted exactly one error')
      assert.match(errors[0].message, /busy/)

      // First completes normally.
      await waitFor(() => results.length >= 1, { label: 'first result' })
      await waitFor(() => !session.isRunning, { label: 'busy cleared' })

      // Now a third send should succeed (process is idle again). Reuse a
      // simple shim so we know it parses through the real subclass mapper.
      writeBaseShimJsonl([
        { type: 'item.completed', item: { type: 'agent_message', text: 'third' } },
        { type: 'turn.completed', usage: {} },
      ])
      const seenAfter = []
      session.on('stream_delta', (d) => seenAfter.push(d))
      await session.sendMessage('third')
      await waitFor(() => results.length >= 2, { label: 'third result' })
      assert.ok(seenAfter.some(d => d.delta === 'third'), 'third message went through mapper')
    })

    it('drives the real CodexSession._processJsonlLine via the base sendMessage', async () => {
      // Tool-flavoured events — ensures the subclass mapper (not the
      // base default) is wired in. Validates `tool_call` → tool_start
      // and `tool_output` → tool_result through the full pipeline.
      writeBaseShimJsonl([
        { type: 'item.completed', item: { type: 'tool_call', id: 'tc-99', name: 'shell', arguments: { cmd: 'ls' } } },
        { type: 'item.completed', item: { type: 'tool_output', call_id: 'tc-99', output: 'file.txt' } },
        { type: 'turn.completed', usage: {} },
      ])

      const session = makeSession()
      session._processReady = true
      const toolStarts = []
      const toolResults = []
      session.on('tool_start', (d) => toolStarts.push(d))
      session.on('tool_result', (d) => toolResults.push(d))

      await session.sendMessage('run a tool')
      await waitFor(() => toolResults.length >= 1, { label: 'tool_result' })

      assert.equal(toolStarts.length, 1)
      assert.equal(toolStarts[0].tool, 'shell')
      assert.equal(toolStarts[0].toolUseId, 'tc-99')
      assert.deepEqual(toolStarts[0].input, { cmd: 'ls' })
      assert.equal(toolResults.length, 1)
      assert.equal(toolResults[0].toolUseId, 'tc-99')
      assert.equal(toolResults[0].result, 'file.txt')
    })
  })

  // -------------------------------------------------------------------
  // #3857 — Codex context-window registry + learn-loop
  // -------------------------------------------------------------------
  //
  // The static MODEL_INFO table was last bumped pre-launch and shipped 272k
  // for both gpt-5 and gpt-5-codex even though OpenAI publishes 400k for
  // Codex on every paid plan. The first fix is the static bump; the second
  // is a runtime learn-loop that catches future drift the same way
  // sdk-session.js corrects Claude windows from `SDKResultSuccess.modelUsage`.
  describe('#3857 context-window source-of-truth', () => {
    it('gpt-5-codex ships the current OpenAI-documented 400k window', () => {
      const meta = CodexSession.getModelMetadata('gpt-5-codex')
      assert.ok(meta)
      assert.equal(meta.contextWindow, 400_000,
        'gpt-5-codex should ship the 400k Codex window OpenAI publishes for all paid plans')
    })

    it('gpt-5 ships the current OpenAI-documented 400k window', () => {
      const meta = CodexSession.getModelMetadata('gpt-5')
      assert.ok(meta)
      assert.equal(meta.contextWindow, 400_000,
        'gpt-5 should ship the 400k window — was 272k pre-launch (#3857)')
    })

    it('every shipped fallback model carries a positive contextWindow', () => {
      for (const m of CodexSession.getFallbackModels()) {
        assert.ok(typeof m.contextWindow === 'number' && m.contextWindow > 0,
          `${m.fullId} should have a numeric contextWindow > 0`)
      }
    })
  })

  describe('#3857 learn-loop — _maybeRatchetContextWindow()', () => {
    // #4413: the ratchet now persists to disk via the codex-scoped cache
    // file (`~/.chroxy/models-cache.codex.json`). Without an isolated
    // CHROXY_CONFIG_DIR these tests would write to the operator's real
    // chroxy state directory and contaminate it with the test cap value
    // (see memory: feedback_test_state_contamination.md). Each test gets
    // its own temp dir, and the registry cache is purged so the next
    // `getRegistryForProvider('codex')` rebuilds against that dir.
    let _ratchetTmpDir
    let _ratchetOrigConfigDir
    beforeEach(() => {
      _ratchetTmpDir = mkdtempSync(join(tmpdir(), 'chroxy-codex-ratchet-block-'))
      _ratchetOrigConfigDir = process.env.CHROXY_CONFIG_DIR
      process.env.CHROXY_CONFIG_DIR = _ratchetTmpDir
      const r = getRegistryForProvider('codex')
      r.resetModels()
    })
    afterEach(() => {
      if (_ratchetOrigConfigDir === undefined) {
        delete process.env.CHROXY_CONFIG_DIR
      } else {
        process.env.CHROXY_CONFIG_DIR = _ratchetOrigConfigDir
      }
      try { rmSync(_ratchetTmpDir, { recursive: true, force: true }) } catch {}
    })

    it('no-op when input_tokens is at or below the registered window', () => {
      const emitted = []
      const fakeSession = { model: 'gpt-5-codex', emit: (e, d) => emitted.push({ e, d }) }
      // 400k window — a 100k turn should not trigger.
      const changed = _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 100_000)
      assert.equal(changed, false)
      assert.equal(emitted.length, 0)
    })

    it('ratchets up when input_tokens exceeds the registered window', () => {
      const emitted = []
      const fakeSession = { model: 'gpt-5-codex', emit: (e, d) => emitted.push({ e, d }) }
      // 500k input on a 400k registered window → bump to >= 500k * 1.1 = 550k.
      const changed = _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 500_000)
      assert.equal(changed, true)

      const r = getRegistryForProvider('codex')
      const m = r.getModels().find(x => x.fullId === 'gpt-5-codex')
      assert.ok(m)
      assert.ok(m.contextWindow >= 500_000 * CODEX_CONTEXT_WINDOW_HEADROOM,
        `expected ratcheted window >= ${500_000 * CODEX_CONTEXT_WINDOW_HEADROOM}, got ${m.contextWindow}`)
      // Round-to-1k cleanliness check — meter should not display "550127".
      assert.equal(m.contextWindow % 1000, 0,
        `expected ratcheted window rounded up to nearest 1k, got ${m.contextWindow}`)
    })

    it('emits models_updated with the updated registry when ratcheted', () => {
      const emitted = []
      const fakeSession = { model: 'gpt-5-codex', emit: (e, d) => emitted.push({ e, d }) }
      _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 500_000)
      const evt = emitted.find(x => x.e === 'models_updated')
      assert.ok(evt, 'should emit models_updated so dashboards refresh')
      assert.ok(Array.isArray(evt.d.models))
      const m = evt.d.models.find(x => x.fullId === 'gpt-5-codex')
      assert.ok(m && m.contextWindow >= 500_000 * CODEX_CONTEXT_WINDOW_HEADROOM)
    })

    it('only ratchets up — never shrinks the registered window', () => {
      const r = getRegistryForProvider('codex')
      // Ratchet up first.
      const fakeSession = { model: 'gpt-5-codex', emit: () => {} }
      _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 800_000)
      const after = r.getModels().find(x => x.fullId === 'gpt-5-codex').contextWindow
      assert.ok(after > 400_000, 'sanity: ratchet should have raised the window')

      // Now a small turn comes in. Must NOT ratchet down.
      const changed = _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 50_000)
      assert.equal(changed, false)
      const stable = r.getModels().find(x => x.fullId === 'gpt-5-codex').contextWindow
      assert.equal(stable, after,
        'a small follow-up turn must not shrink the ratcheted window')
    })

    it('no-op for an unknown model id', () => {
      const emitted = []
      const fakeSession = { model: 'gpt-99-future', emit: (e, d) => emitted.push({ e, d }) }
      const changed = _maybeRatchetContextWindow(fakeSession, 'gpt-99-future', 999_999_999)
      assert.equal(changed, false, 'unknown models should be a silent no-op, not a throw')
      assert.equal(emitted.length, 0)
    })

    // The cap exists to make a single corrupt turn unable to balloon the
    // registry to an absurd number — a JSONL parse glitch or future Codex
    // CLI bug must not blow up the meter math downstream. 2M is well above
    // today's largest published windows, so anything above suggests bad data.
    it('caps the ratchet target at CODEX_CONTEXT_WINDOW_RATCHET_CAP', () => {
      const fakeSession = { model: 'gpt-5-codex', emit: () => {} }
      // A wildly high observed value — e.g. CLI bug or overflow
      _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 10_000_000)
      const r = getRegistryForProvider('codex')
      const m = r.getModels().find(x => x.fullId === 'gpt-5-codex')
      assert.ok(m)
      assert.ok(m.contextWindow <= CODEX_CONTEXT_WINDOW_RATCHET_CAP,
        `expected ratchet capped at ${CODEX_CONTEXT_WINDOW_RATCHET_CAP}, got ${m.contextWindow}`)
    })

    // Defensive guards: a corrupt usage payload (NaN, Infinity, negative)
    // must not feed the ratchet math. NaN * 1.1 = NaN; Infinity * 1.1 =
    // Infinity → unbounded growth (or NaN propagation through the
    // registry → meter showing NaN%). Silent no-op is the right failure.
    for (const bad of [NaN, Infinity, -Infinity, -1, 0]) {
      it(`no-op when input_tokens is invalid (${bad})`, () => {
        const emitted = []
        const fakeSession = { model: 'gpt-5-codex', emit: (e, d) => emitted.push({ e, d }) }
        const changed = _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', bad)
        assert.equal(changed, false)
        assert.equal(emitted.length, 0)
      })
    }
  })
})
