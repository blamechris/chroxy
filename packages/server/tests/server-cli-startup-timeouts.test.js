import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveStartupTimeouts } from '../src/server-cli.js'
import {
  DEFAULT_RESULT_TIMEOUT_MS,
  DEFAULT_HARD_TIMEOUT_MS,
  DEFAULT_STREAM_STALL_TIMEOUT_MS,
} from '../src/base-session.js'
import { DEFAULT_TOOL_CALL_TIMEOUT_MS } from '../src/byok-mcp-client.js'

/**
 * #4509: `startCliServer` previously hand-rolled the same
 * `Number.isFinite(x) && x [>|>=] 0` check at two adjacent sites — once when
 * building SessionManager constructor args (which take null = use BaseSession
 * default) and once when building the startup log line (which takes the
 * resolved DEFAULT_* constant). Neither site enforced the shared
 * MAX_SANE_DURATION_MS (24h) ceiling, so an operator typo like
 * `CHROXY_HARD_TIMEOUT_MS=99999999999` would silently pass through to
 * BaseSession and arm a >24h internal inactivity timer.
 *
 * `resolveStartupTimeouts(config, log)` consolidates the predicate, applies
 * the ceiling, and returns both shapes so the two sites can't drift apart.
 * These tests exercise the helper directly — the SessionManager / BaseSession
 * sites have their own coverage in their respective `*.test.js`.
 */
describe('resolveStartupTimeouts (#4509)', () => {
  const MAX_SANE_DURATION_MS = 24 * 60 * 60 * 1000

  // Shape of the return value the helper produces. The constructor arg side
  // (`*TimeoutMs`) takes `null` for invalid/over-ceiling so BaseSession can
  // apply its default; the log-line side (`effective*`) takes the resolved
  // default so the operator sees the actual wall-clock value that will fire.
  // #4517: mcpToolCallTimeoutMs joined the helper family — its "effective"
  // side resolves to DEFAULT_TOOL_CALL_TIMEOUT_MS (byok-mcp-client default).
  function expectShape(out) {
    assert.ok(out && typeof out === 'object', 'helper must return an object')
    for (const k of [
      'resultTimeoutMs', 'hardTimeoutMs', 'streamStallTimeoutMs', 'mcpToolCallTimeoutMs',
      'effectiveResultTimeoutMs', 'effectiveHardTimeoutMs', 'effectiveStreamStallTimeoutMs', 'effectiveMcpToolCallTimeoutMs',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(out, k), `missing key: ${k}`)
    }
  }

  afterEach(() => {
    mock.restoreAll()
  })

  it('passes in-range positive values through verbatim on both sides', () => {
    const out = resolveStartupTimeouts({
      resultTimeoutMs: 90_000,
      hardTimeoutMs: 3_600_000,
      streamStallTimeoutMs: 120_000,
      mcpToolCallTimeoutMs: 45_000,
    }, { warn: () => {} })
    expectShape(out)
    assert.equal(out.resultTimeoutMs, 90_000)
    assert.equal(out.effectiveResultTimeoutMs, 90_000)
    assert.equal(out.hardTimeoutMs, 3_600_000)
    assert.equal(out.effectiveHardTimeoutMs, 3_600_000)
    assert.equal(out.streamStallTimeoutMs, 120_000)
    assert.equal(out.effectiveStreamStallTimeoutMs, 120_000)
    assert.equal(out.mcpToolCallTimeoutMs, 45_000)
    assert.equal(out.effectiveMcpToolCallTimeoutMs, 45_000)
  })

  it('accepts streamStallTimeoutMs=0 as an explicit disable (does NOT fall back)', () => {
    // 0 is the documented opt-out for stream-stall recovery (#4467); the soft
    // warning + hard cap still fire regardless. The other two timeouts treat
    // 0 as invalid (see next test).
    const out = resolveStartupTimeouts({ streamStallTimeoutMs: 0 }, { warn: () => {} })
    assert.equal(out.streamStallTimeoutMs, 0)
    assert.equal(out.effectiveStreamStallTimeoutMs, 0)
  })

  it('falls back to null / DEFAULT_* when config values are non-positive or non-finite', () => {
    for (const bad of [NaN, Infinity, -1, undefined, '60000']) {
      const out = resolveStartupTimeouts({
        resultTimeoutMs: bad,
        hardTimeoutMs: bad,
        // For streamStall, only Infinity / NaN / strings are invalid — 0 and
        // -1 paths are tested separately because 0 is intentional and -1 is
        // just "out of range" without a special-case meaning.
        streamStallTimeoutMs: bad === 0 ? -1 : bad,
        // #4517: mcpToolCallTimeoutMs follows the same `> 0` gate as the soft/
        // hard inactivity timeouts — 0 fires immediately and makes every MCP
        // tool look broken — so it joins the bad-input loop directly.
        mcpToolCallTimeoutMs: bad,
      }, { warn: () => {} })
      assert.equal(out.resultTimeoutMs, null, `resultTimeoutMs null for ${String(bad)}`)
      assert.equal(out.effectiveResultTimeoutMs, DEFAULT_RESULT_TIMEOUT_MS)
      assert.equal(out.hardTimeoutMs, null, `hardTimeoutMs null for ${String(bad)}`)
      assert.equal(out.effectiveHardTimeoutMs, DEFAULT_HARD_TIMEOUT_MS)
      assert.equal(out.streamStallTimeoutMs, null, `streamStallTimeoutMs null for ${String(bad)}`)
      assert.equal(out.effectiveStreamStallTimeoutMs, DEFAULT_STREAM_STALL_TIMEOUT_MS)
      assert.equal(out.mcpToolCallTimeoutMs, null, `mcpToolCallTimeoutMs null for ${String(bad)}`)
      assert.equal(out.effectiveMcpToolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS)
    }
  })

  it('clamps resultTimeoutMs above MAX_SANE_DURATION_MS back to null + DEFAULT and warns', () => {
    const warnings = []
    const out = resolveStartupTimeouts(
      { resultTimeoutMs: MAX_SANE_DURATION_MS + 1 },
      { warn: (msg) => warnings.push(msg) },
    )
    assert.equal(out.resultTimeoutMs, null,
      'SessionManager arg side must fall back to null so BaseSession applies its default')
    assert.equal(out.effectiveResultTimeoutMs, DEFAULT_RESULT_TIMEOUT_MS,
      'log-line side must resolve to DEFAULT_RESULT_TIMEOUT_MS so operators see the actual effective value')
    const hit = warnings.find((w) => w.includes('resultTimeoutMs') && w.includes('MAX_SANE_DURATION_MS'))
    assert.ok(hit, `expected warn log mentioning resultTimeoutMs + MAX_SANE_DURATION_MS, got: ${warnings.join(' | ')}`)
  })

  it('clamps hardTimeoutMs above MAX_SANE_DURATION_MS back to null + DEFAULT and warns', () => {
    const warnings = []
    const out = resolveStartupTimeouts(
      { hardTimeoutMs: MAX_SANE_DURATION_MS + 1 },
      { warn: (msg) => warnings.push(msg) },
    )
    assert.equal(out.hardTimeoutMs, null)
    assert.equal(out.effectiveHardTimeoutMs, DEFAULT_HARD_TIMEOUT_MS)
    const hit = warnings.find((w) => w.includes('hardTimeoutMs') && w.includes('MAX_SANE_DURATION_MS'))
    assert.ok(hit, `expected warn log mentioning hardTimeoutMs + MAX_SANE_DURATION_MS, got: ${warnings.join(' | ')}`)
  })

  it('clamps streamStallTimeoutMs above MAX_SANE_DURATION_MS back to null + DEFAULT and warns', () => {
    const warnings = []
    const out = resolveStartupTimeouts(
      { streamStallTimeoutMs: MAX_SANE_DURATION_MS + 1 },
      { warn: (msg) => warnings.push(msg) },
    )
    assert.equal(out.streamStallTimeoutMs, null)
    assert.equal(out.effectiveStreamStallTimeoutMs, DEFAULT_STREAM_STALL_TIMEOUT_MS)
    const hit = warnings.find((w) => w.includes('streamStallTimeoutMs') && w.includes('MAX_SANE_DURATION_MS'))
    assert.ok(hit, `expected warn log mentioning streamStallTimeoutMs + MAX_SANE_DURATION_MS, got: ${warnings.join(' | ')}`)
  })

  it('clamps mcpToolCallTimeoutMs above MAX_SANE_DURATION_MS back to null + DEFAULT and warns (#4517)', () => {
    // #4517: mcpToolCallTimeoutMs joined the three sibling timeouts in the
    // ceiling-clamp guardrail. config.js has a tighter 1s-10min validator
    // applied to file-loaded values (left in place — see PR notes for the
    // site-4 decision), but defense-in-depth at the resolution layer keeps
    // programmatic instantiation (tests, embedders) honest.
    const warnings = []
    const out = resolveStartupTimeouts(
      { mcpToolCallTimeoutMs: MAX_SANE_DURATION_MS + 1 },
      { warn: (msg) => warnings.push(msg) },
    )
    assert.equal(out.mcpToolCallTimeoutMs, null,
      'SessionManager arg side must fall back to null so byok-mcp-client applies its default')
    assert.equal(out.effectiveMcpToolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS,
      'log-line side must resolve to DEFAULT_TOOL_CALL_TIMEOUT_MS so operators see the actual effective value')
    const hit = warnings.find((w) => w.includes('mcpToolCallTimeoutMs') && w.includes('MAX_SANE_DURATION_MS'))
    assert.ok(hit, `expected warn log mentioning mcpToolCallTimeoutMs + MAX_SANE_DURATION_MS, got: ${warnings.join(' | ')}`)
  })

  it('accepts the exact MAX_SANE_DURATION_MS boundary on all four timeouts', () => {
    const out = resolveStartupTimeouts({
      resultTimeoutMs: MAX_SANE_DURATION_MS,
      hardTimeoutMs: MAX_SANE_DURATION_MS,
      streamStallTimeoutMs: MAX_SANE_DURATION_MS,
      mcpToolCallTimeoutMs: MAX_SANE_DURATION_MS,
    }, { warn: () => {} })
    assert.equal(out.resultTimeoutMs, MAX_SANE_DURATION_MS)
    assert.equal(out.effectiveResultTimeoutMs, MAX_SANE_DURATION_MS)
    assert.equal(out.hardTimeoutMs, MAX_SANE_DURATION_MS)
    assert.equal(out.effectiveHardTimeoutMs, MAX_SANE_DURATION_MS)
    assert.equal(out.streamStallTimeoutMs, MAX_SANE_DURATION_MS)
    assert.equal(out.effectiveStreamStallTimeoutMs, MAX_SANE_DURATION_MS)
    assert.equal(out.mcpToolCallTimeoutMs, MAX_SANE_DURATION_MS)
    assert.equal(out.effectiveMcpToolCallTimeoutMs, MAX_SANE_DURATION_MS)
  })

  it('returns the same shape with no config (all defaults)', () => {
    const out = resolveStartupTimeouts({}, { warn: () => {} })
    expectShape(out)
    assert.equal(out.resultTimeoutMs, null)
    assert.equal(out.effectiveResultTimeoutMs, DEFAULT_RESULT_TIMEOUT_MS)
    assert.equal(out.hardTimeoutMs, null)
    assert.equal(out.effectiveHardTimeoutMs, DEFAULT_HARD_TIMEOUT_MS)
    assert.equal(out.streamStallTimeoutMs, null)
    assert.equal(out.effectiveStreamStallTimeoutMs, DEFAULT_STREAM_STALL_TIMEOUT_MS)
    assert.equal(out.mcpToolCallTimeoutMs, null)
    assert.equal(out.effectiveMcpToolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS)
  })
})
