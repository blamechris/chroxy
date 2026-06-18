import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudeChannelSession, CLAUDE_CHANNEL_MIN_VERSION } from '../src/claude-channel-session.js'
import { BaseSession } from '../src/base-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

// #3953 — provider scaffold for the `claude --channels` MCP transport.
// The session is intentionally a no-op (start() throws); these tests pin
// the static surface the dashboard + `chroxy doctor` rely on, and confirm
// start() fails fast without spawning anything.
describe('ClaudeChannelSession scaffold (#3953)', () => {
  it('extends BaseSession', () => {
    assert.ok(ClaudeChannelSession.prototype instanceof BaseSession)
  })

  it('start() rejects with the not-implemented error and spawns nothing', async () => {
    const session = new ClaudeChannelSession({ cwd: process.cwd() })
    await assert.rejects(
      () => session.start(),
      /not yet implemented/i,
    )
    // No PTY / MCP child was created — the scaffold has no process handles.
    assert.equal(session._processReady, false)
  })

  it('start() error references the bridge sub-issue (#3954)', async () => {
    const session = new ClaudeChannelSession({ cwd: process.cwd() })
    await assert.rejects(() => session.start(), /#3954/)
  })

  it('sendMessage() rejects with the not-implemented error', async () => {
    const session = new ClaudeChannelSession({ cwd: process.cwd() })
    await assert.rejects(() => session.sendMessage('hello'), /not yet implemented/i)
  })

  it('interrupt() throws the not-implemented error', () => {
    const session = new ClaudeChannelSession({ cwd: process.cwd() })
    assert.throws(() => session.interrupt(), /not yet implemented/i)
  })

  it('destroy() is a safe no-op (does not throw)', () => {
    const session = new ClaudeChannelSession({ cwd: process.cwd() })
    assert.doesNotThrow(() => session.destroy())
    assert.equal(session._destroying, true)
    assert.equal(session._processReady, false)
  })

  it('exposes a research-preview displayLabel', () => {
    assert.equal(typeof ClaudeChannelSession.displayLabel, 'string')
    assert.match(ClaudeChannelSession.displayLabel, /channel/i)
    assert.match(ClaudeChannelSession.displayLabel, /research preview/i)
    assert.match(ClaudeChannelSession.displayLabel, /subscription/i)
  })

  it('dataDir points at ~/.claude (shared with the other Claude providers)', () => {
    assert.equal(ClaudeChannelSession.dataDir, join(homedir(), '.claude'))
  })

  describe('capabilities matrix (from the spike)', () => {
    const caps = ClaudeChannelSession.capabilities

    it('declares permissions true (channel/permission relay — sub 4)', () => {
      assert.equal(caps.permissions, true)
    })

    it('verdicts round-trip over IPC, not in-process', () => {
      assert.equal(caps.inProcessPermissions, false)
    })

    it('streams (the headline win over claude-tui)', () => {
      assert.equal(caps.streaming, true)
    })

    it('renders tool calls', () => {
      assert.equal(caps.tools, true)
    })

    // The deliberately-honest cells: channels do NOT solve these.
    it('does not claim model switch / permission-mode switch / plan / resume / terminal / thinking', () => {
      assert.equal(caps.modelSwitch, false)
      assert.equal(caps.permissionModeSwitch, false)
      assert.equal(caps.planMode, false)
      assert.equal(caps.resume, false)
      assert.equal(caps.terminal, false)
      assert.equal(caps.thinkingLevel, false)
    })
  })

  describe('preflight', () => {
    const pf = ClaudeChannelSession.preflight

    it('checks the `claude` binary', () => {
      assert.equal(pf.binary.name, 'claude')
      assert.deepEqual(pf.binary.args, ['--version'])
      assert.ok(Array.isArray(pf.binary.candidates) && pf.binary.candidates.length > 0)
    })

    it('declares the channel-transport minimum version', () => {
      assert.equal(pf.binary.minVersion, CLAUDE_CHANNEL_MIN_VERSION)
      assert.equal(CLAUDE_CHANNEL_MIN_VERSION, '2.1.80')
    })

    it('install hint mentions the version floor', () => {
      assert.match(pf.binary.installHint, new RegExp(CLAUDE_CHANNEL_MIN_VERSION))
    })

    it('credentials are optional and do NOT accept ANTHROPIC_API_KEY', () => {
      assert.deepEqual(pf.credentials.envVars, [])
      assert.equal(pf.credentials.optional, true)
      assert.match(pf.credentials.hint, /claude login/)
      assert.match(pf.credentials.hint, /ANTHROPIC_API_KEY/)
    })
  })

  describe('resolveAuth (#4769 pattern)', () => {
    it('reports ready via subscription OAuth, mentioning research preview', () => {
      const auth = ClaudeChannelSession.resolveAuth()
      assert.equal(auth.ready, true)
      assert.equal(auth.source, 'oauth')
      assert.equal(auth.envVar, null)
      assert.deepEqual(auth.envVars, [])
      assert.match(auth.detail, /subscription/i)
      assert.match(auth.detail, /research preview/i)
      assert.match(auth.detail, /bypasses programmatic credit metering/i)
    })
  })

  describe('model metadata (reused from claude-tui)', () => {
    it('returns the same non-empty fallback model list as claude-tui', () => {
      const models = ClaudeChannelSession.getFallbackModels()
      assert.ok(Array.isArray(models) && models.length > 0)
      assert.deepEqual(models, ClaudeTuiSession.getFallbackModels())
    })

    it('returns a non-empty allowed-model list', () => {
      const allowed = ClaudeChannelSession.getAllowedModels()
      assert.ok(Array.isArray(allowed) && allowed.length > 0)
    })

    it('derives model metadata for a valid id', () => {
      const meta = ClaudeChannelSession.getModelMetadata('claude-sonnet-4-5-20250929')
      assert.ok(meta)
      assert.equal(typeof meta.id, 'string')
      assert.equal(meta.fullId, 'claude-sonnet-4-5-20250929')
      assert.equal(typeof meta.contextWindow, 'number')
    })

    it('returns null for an empty/invalid model id', () => {
      assert.equal(ClaudeChannelSession.getModelMetadata(''), null)
      assert.equal(ClaudeChannelSession.getModelMetadata(null), null)
    })
  })

  describe('constructor / BaseSession opt forwarding', () => {
    it('defaults provider to claude-channel', () => {
      const session = new ClaudeChannelSession({ cwd: process.cwd() })
      assert.equal(session._provider, 'claude-channel')
    })

    it('forwards BaseSession opts through super() (middle-layer trap guard)', () => {
      const session = new ClaudeChannelSession({
        cwd: '/tmp/some-cwd',
        model: 'claude-opus-4-1-20250805',
        permissionMode: 'acceptEdits',
        chroxyContextHint: true,
        sessionPreamble: 'be terse',
      })
      assert.equal(session.cwd, '/tmp/some-cwd')
      assert.equal(session.model, 'claude-opus-4-1-20250805')
      assert.equal(session.permissionMode, 'acceptEdits')
      assert.equal(session.chroxyContextHint, true)
      assert.equal(session.sessionPreamble, 'be terse')
    })

    it('constructs with no args (every opt optional)', () => {
      const session = new ClaudeChannelSession()
      assert.ok(session instanceof ClaudeChannelSession)
      assert.equal(session._provider, 'claude-channel')
    })
  })
})
