import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession } from '../src/sdk-session.js'
import { CliSession } from '../src/cli-session.js'
import { parseCompactBoundaryMeta, formatCompactBoundaryContent } from '../src/claude-stream-parser.js'

/**
 * Tests for #6768 — a `compact_boundary` system event from the Agent
 * SDK/CLI must be parsed into a distinct structured "context compacted"
 * marker (`type: 'system'`, `subtype: 'compact_boundary'`,
 * `compactMetadata: { trigger, preTokens, postTokens, durationMs }`)
 * rather than falling through to the generic "unknown system event"
 * branch, which forwards the literal string `compact_boundary` as
 * `content` with no structured fields.
 *
 * #4700: every session under test routes through a per-test temp
 * `stateFilePath` so a future persistence regression can never
 * contaminate `~/.chroxy/session-state.json` — mirrors sdk-session.test.js
 * / cli-session.test.js.
 */

let _tmpDir
function tmpStateFile() {
  if (!_tmpDir) _tmpDir = mkdtempSync(join(tmpdir(), 'compact-boundary-test-'))
  return join(_tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

after(() => {
  if (_tmpDir) rmSync(_tmpDir, { recursive: true, force: true })
})

// A realistic SDKCompactBoundaryMessage.compact_metadata fixture, matching
// @anthropic-ai/claude-agent-sdk/sdk.d.ts's SDKCompactBoundaryMessage shape
// (snake_case on the wire from the SDK/CLI).
function fixtureCompactMetadata(overrides = {}) {
  return {
    trigger: 'auto',
    pre_tokens: 128_000,
    post_tokens: 12_000,
    duration_ms: 2_500,
    ...overrides,
  }
}

describe('#6768 compact_boundary parsing', () => {
  describe('parseCompactBoundaryMeta / formatCompactBoundaryContent (shared parser)', () => {
    it('camelCases a well-formed compact_metadata payload', () => {
      const meta = parseCompactBoundaryMeta(fixtureCompactMetadata())
      assert.deepEqual(meta, {
        trigger: 'auto',
        preTokens: 128_000,
        postTokens: 12_000,
        durationMs: 2_500,
      })
    })

    it('preserves an explicit manual trigger', () => {
      const meta = parseCompactBoundaryMeta(fixtureCompactMetadata({ trigger: 'manual' }))
      assert.equal(meta.trigger, 'manual')
    })

    it('defaults an unrecognized/missing trigger to auto', () => {
      assert.equal(parseCompactBoundaryMeta({}).trigger, 'auto')
      assert.equal(parseCompactBoundaryMeta(undefined).trigger, 'auto')
      assert.equal(parseCompactBoundaryMeta({ trigger: 'bogus' }).trigger, 'auto')
    })

    it('coerces missing/non-finite optional numeric fields to null, not undefined', () => {
      const meta = parseCompactBoundaryMeta({ trigger: 'auto', pre_tokens: 50_000 })
      assert.deepEqual(meta, {
        trigger: 'auto',
        preTokens: 50_000,
        postTokens: null,
        durationMs: null,
      })

      const malformed = parseCompactBoundaryMeta({
        trigger: 'auto',
        pre_tokens: 'a lot',
        post_tokens: NaN,
      })
      assert.equal(malformed.preTokens, null)
      assert.equal(malformed.postTokens, null)
    })

    it('formats a human-readable fallback with the token delta when both counts are known', () => {
      const text = formatCompactBoundaryContent({ trigger: 'auto', preTokens: 128_000, postTokens: 12_000 })
      assert.match(text, /Context compacted/)
      assert.match(text, /128,000/)
      assert.match(text, /12,000/)
    })

    it('falls back to a trigger-only string when token counts are unknown', () => {
      const text = formatCompactBoundaryContent({ trigger: 'manual', preTokens: null, postTokens: null })
      assert.match(text, /Context compacted \(manual\)/)
    })
  })

  describe('SdkSession', () => {
    function createSdkSession(opts = {}) {
      return new SdkSession({ cwd: '/tmp', stateFilePath: tmpStateFile(), ...opts })
    }

    function fakeQueryWithCompactBoundary(compactMetadata) {
      return (async function* () {
        yield {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: compactMetadata,
          uuid: 'test-uuid-1',
          session_id: 'sdk-compact-1',
        }
        yield {
          type: 'result',
          session_id: 'sdk-compact-1',
          total_cost_usd: 0,
          duration_ms: 0,
          usage: {},
        }
      })()
    }

    it('emits a structured compact_boundary marker (not the generic system fallback)', async () => {
      const s = createSdkSession()
      s._processReady = true
      s._callQuery = () => fakeQueryWithCompactBoundary(fixtureCompactMetadata())

      const messages = []
      s.on('message', (m) => messages.push(m))
      await s.sendMessage('hello')
      s.destroy()

      const marker = messages.find((m) => m.type === 'system')
      assert.ok(marker, 'expected a system message event')
      assert.equal(marker.subtype, 'compact_boundary')
      assert.deepEqual(marker.compactMetadata, {
        trigger: 'auto',
        preTokens: 128_000,
        postTokens: 12_000,
        durationMs: 2_500,
      })
      assert.equal(typeof marker.timestamp, 'number')

      // Must NOT be the generic "unknown system event" fallback, which
      // forwards the literal subtype string as content with no structured
      // fields at all.
      assert.notEqual(marker.content, 'compact_boundary')
      assert.match(marker.content, /Context compacted/)
    })

    it('marks a manual /compact trigger distinctly from auto-compaction', async () => {
      const s = createSdkSession()
      s._processReady = true
      s._callQuery = () => fakeQueryWithCompactBoundary(fixtureCompactMetadata({ trigger: 'manual' }))

      const messages = []
      s.on('message', (m) => messages.push(m))
      await s.sendMessage('hello')
      s.destroy()

      const marker = messages.find((m) => m.subtype === 'compact_boundary')
      assert.equal(marker.compactMetadata.trigger, 'manual')
    })

    it('coerces a missing duration/post_tokens to null instead of dropping the marker', async () => {
      const s = createSdkSession()
      s._processReady = true
      s._callQuery = () => fakeQueryWithCompactBoundary({ trigger: 'auto', pre_tokens: 200_000 })

      const messages = []
      s.on('message', (m) => messages.push(m))
      await s.sendMessage('hello')
      s.destroy()

      const marker = messages.find((m) => m.subtype === 'compact_boundary')
      assert.ok(marker)
      assert.deepEqual(marker.compactMetadata, {
        trigger: 'auto',
        preTokens: 200_000,
        postTokens: null,
        durationMs: null,
      })
    })

    it('still routes an unrelated system subtype through the generic fallback', async () => {
      const s = createSdkSession()
      s._processReady = true
      s._callQuery = () => (async function* () {
        yield { type: 'system', subtype: 'some_other_event', message: 'hi there', session_id: 'sdk-other-1' }
        yield { type: 'result', session_id: 'sdk-other-1', total_cost_usd: 0, duration_ms: 0, usage: {} }
      })()

      const messages = []
      s.on('message', (m) => messages.push(m))
      await s.sendMessage('hello')
      s.destroy()

      const marker = messages.find((m) => m.type === 'system')
      assert.ok(marker)
      assert.equal(marker.content, 'hi there')
      assert.equal(marker.subtype, undefined)
      assert.equal(marker.compactMetadata, undefined)
    })
  })

  describe('CliSession', () => {
    function createCliSession() {
      const session = new CliSession({ cwd: '/tmp', stateFilePath: tmpStateFile() })
      session._isBusy = true
      return session
    }

    it('emits a structured compact_boundary marker (not the generic system fallback)', () => {
      const session = createCliSession()
      const messages = []
      session.on('message', (m) => messages.push(m))

      session._handleEvent({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: fixtureCompactMetadata({ trigger: 'manual', post_tokens: 9_000, duration_ms: 1_800 }),
        session_id: 'cli-compact-1',
      })

      assert.equal(messages.length, 1)
      const [marker] = messages
      assert.equal(marker.type, 'system')
      assert.equal(marker.subtype, 'compact_boundary')
      assert.deepEqual(marker.compactMetadata, {
        trigger: 'manual',
        preTokens: 128_000,
        postTokens: 9_000,
        durationMs: 1_800,
      })
      assert.notEqual(marker.content, 'compact_boundary')
      assert.match(marker.content, /Context compacted/)
    })

    it('still routes an unrelated system subtype through the generic fallback', () => {
      const session = createCliSession()
      const messages = []
      session.on('message', (m) => messages.push(m))

      session._handleEvent({ type: 'system', subtype: 'some_other_event', message: 'usage info', session_id: 'cli-other-1' })

      assert.equal(messages.length, 1)
      assert.equal(messages[0].content, 'usage info')
      assert.equal(messages[0].subtype, undefined)
      assert.equal(messages[0].compactMetadata, undefined)
    })
  })
})
