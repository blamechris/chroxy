/**
 * Tests for shared context-window resolution (#5424).
 *
 * Pins the rule that the 200k DEFAULT_CONTEXT_WINDOW is a *Claude* default:
 * providers that legitimately report no window (ollama deliberately sends
 * `contextWindow: null`) must resolve to `null` so clients render an
 * "unknown window" state instead of a misleading "% of 200k" meter.
 */
import { describe, it, expect } from 'vitest'
import {
  isClaudeBackedProvider,
  resolveContextWindow,
  CLAUDE_BACKED_DOCKER_IDS,
  contextOccupancyTokens,
  contextMeterCeiling,
  effectiveContextWindow,
  contextFillPercent,
  CONTEXT_AUTO_COMPACT_RESERVE,
} from './context-window'
import { handleResultUsage } from './handlers/stream'
import type { ContextOccupancy } from './types'
import { DEFAULT_CONTEXT_WINDOW } from './types'

/** Shorthand for a ContextOccupancy snapshot in these tests. */
function snapshot(overrides: Partial<ContextOccupancy> = {}): ContextOccupancy {
  return {
    totalTokens: 0,
    maxTokens: null,
    autoCompactThreshold: null,
    isAutoCompactEnabled: null,
    source: null,
    ...overrides,
  }
}

describe('isClaudeBackedProvider (#5424)', () => {
  it('treats the claude-* family as claude-backed', () => {
    for (const p of ['claude-cli', 'claude-sdk', 'claude-tui', 'claude-channel', 'claude-byok']) {
      expect(isClaudeBackedProvider(p)).toBe(true)
    }
  })

  it('treats the docker-* wrappers (claude in a container) as claude-backed', () => {
    for (const p of ['docker', 'docker-cli', 'docker-sdk', 'docker-byok']) {
      expect(isClaudeBackedProvider(p)).toBe(true)
    }
  })

  it('treats null/undefined as claude-backed (legacy servers predate provider reporting)', () => {
    expect(isClaudeBackedProvider(null)).toBe(true)
    expect(isClaudeBackedProvider(undefined)).toBe(true)
  })

  it('treats non-claude providers as NOT claude-backed', () => {
    for (const p of ['ollama', 'deepseek', 'gemini', 'codex', 'some-future-provider']) {
      expect(isClaudeBackedProvider(p)).toBe(false)
    }
  })

  it('does not prefix-match without the dash separator', () => {
    // 'claudette' / 'dockerish' must not ride the claude/docker defaults.
    expect(isClaudeBackedProvider('claudette')).toBe(false)
    expect(isClaudeBackedProvider('dockerish')).toBe(false)
  })

  it('FAILS CLOSED for an unknown docker-* provider (#5448)', () => {
    // The docker family is an explicit allowlist, not a `docker-*` prefix — a
    // future non-Claude containerized provider must NOT inherit the Claude 200k
    // default (the #5424 failure mode) just because its id starts with `docker-`.
    for (const p of ['docker-ollama', 'docker-vllm', 'docker-llamacpp', 'docker-future']) {
      expect(isClaudeBackedProvider(p)).toBe(false)
    }
    // resolveContextWindow consequently returns null (real "unknown window"),
    // not a fabricated 200k meter.
    expect(resolveContextWindow(null, 'docker-ollama')).toBe(null)
    expect(resolveContextWindow({}, 'docker-ollama')).toBe(null)
  })

  it('the docker allowlist exactly matches the known Claude docker wrappers (#5448)', () => {
    expect([...CLAUDE_BACKED_DOCKER_IDS].sort()).toEqual(['docker', 'docker-byok', 'docker-cli', 'docker-sdk'])
  })
})

describe('resolveContextWindow (#5424)', () => {
  it('returns the reported window when positive, regardless of provider', () => {
    expect(resolveContextWindow({ contextWindow: 32_000 }, 'ollama')).toBe(32_000)
    expect(resolveContextWindow({ contextWindow: 1_000_000 }, 'claude-sdk')).toBe(1_000_000)
    expect(resolveContextWindow({ contextWindow: 128_000 }, undefined)).toBe(128_000)
  })

  it('falls back to the 200k default for claude-backed providers when missing', () => {
    expect(resolveContextWindow({}, 'claude-cli')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(resolveContextWindow(undefined, 'claude-tui')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(resolveContextWindow(null, 'docker-sdk')).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('falls back to 200k when the provider is unknown (legacy servers only ran claude)', () => {
    expect(resolveContextWindow({}, null)).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(resolveContextWindow(undefined, undefined)).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('returns null for non-claude providers when the window is missing (the ollama path)', () => {
    expect(resolveContextWindow({}, 'ollama')).toBe(null)
    expect(resolveContextWindow(undefined, 'ollama')).toBe(null)
    expect(resolveContextWindow(null, 'gemini')).toBe(null)
    expect(resolveContextWindow({}, 'codex')).toBe(null)
  })

  it('ignores non-positive / non-finite windows', () => {
    expect(resolveContextWindow({ contextWindow: 0 }, 'ollama')).toBe(null)
    expect(resolveContextWindow({ contextWindow: -1 }, 'ollama')).toBe(null)
    expect(resolveContextWindow({ contextWindow: NaN }, 'ollama')).toBe(null)
    expect(resolveContextWindow({ contextWindow: Infinity }, 'ollama')).toBe(null)
    // ...but a claude-backed provider still gets the default in that case.
    expect(resolveContextWindow({ contextWindow: 0 }, 'claude-sdk')).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})

// ---------------------------------------------------------------------------
// #6769 — context-window fill from an OCCUPANCY SNAPSHOT, never from billing.
//
// A result's `usage` is the per-turn billing aggregate summed across every
// agent-loop round (byok-session.js #4056 accumulates cache_read per round;
// the SDK/CLI forward the driver's whole-turn aggregate). The meter reads the
// `contextUsage` snapshot instead. See the module docblock for the model.
// ---------------------------------------------------------------------------

describe('multi-round turn: billing aggregate over-reads, snapshot does not (#6769)', () => {
  // A realistic 8-round coding turn on a ~100k conversation. Each round
  // re-reads the history from cache, so the BILLING aggregate's cache_read is
  // ≈8× the real occupancy. This fixture pins the failure mode that sank the
  // first cut of #6769 (which read the aggregate as occupancy).
  const ROUNDS = 8
  const HISTORY = 100_000
  const WINDOW = 200_000
  // What the wire `result.usage` actually carries after byok/sdk accumulation:
  const billingAggregate = {
    input_tokens: ROUNDS * 400,            // fresh tokens per round
    output_tokens: ROUNDS * 900,           // reply + tool_use blocks per round
    cache_read_input_tokens: ROUNDS * HISTORY, // history re-read EVERY round
    cache_creation_input_tokens: 6_000,
  }
  // What the SDK's getContextUsage() reports after the same turn:
  const occupancySnapshot = snapshot({
    totalTokens: 110_000,
    maxTokens: WINDOW,
    autoCompactThreshold: 167_000,
    isAutoCompactEnabled: true,
    source: 'context-usage-api',
  })

  it('the OLD model (sum the aggregate fields) reads several times the window — pinned as the bug', () => {
    const aggregateTotal =
      billingAggregate.input_tokens +
      billingAggregate.output_tokens +
      billingAggregate.cache_read_input_tokens +
      billingAggregate.cache_creation_input_tokens
    // ≈816k "occupancy" on a 200k window — the meter would clamp 100% red on
    // essentially every real multi-tool turn.
    expect(aggregateTotal).toBeGreaterThan(WINDOW * 4)
    // The aggregate over-reads the true occupancy by ≈ the round count.
    expect(aggregateTotal / occupancySnapshot.totalTokens).toBeGreaterThan(ROUNDS * 0.8)
  })

  it('the NEW model (snapshot) reads the true occupancy and a sane percent', () => {
    expect(contextOccupancyTokens(occupancySnapshot)).toBe(110_000)
    const pct = contextFillPercent(occupancySnapshot)
    // 110k / 167k threshold ≈ 66% — nowhere near the pinned-red 100%.
    expect(pct).toBeCloseTo((110_000 / 167_000) * 100, 5)
    expect(pct!).toBeLessThan(100)
  })

  it('handleResultUsage NEVER derives occupancy from the billing usage field', () => {
    // A result carrying ONLY the billing aggregate (no contextUsage wire
    // field) must yield contextOccupancy: null — the no-signal dash state,
    // not a fabricated ≈816k meter.
    const payload = handleResultUsage(
      { type: 'result', usage: billingAggregate, sessionId: 's1' },
      's1',
    )
    expect(payload.contextUsage).not.toBeNull() // billing still parsed for cost
    expect(payload.contextOccupancy).toBeNull() // but occupancy is unknown
  })
})

describe('handleResultUsage occupancy parsing (#6769)', () => {
  it('parses a full SDK snapshot from the contextUsage wire field', () => {
    const payload = handleResultUsage(
      {
        type: 'result',
        usage: { input_tokens: 1, output_tokens: 1 },
        contextUsage: {
          totalTokens: 110_000,
          maxTokens: 200_000,
          autoCompactThreshold: 167_000,
          isAutoCompactEnabled: true,
          source: 'context-usage-api',
        },
        sessionId: 's1',
      },
      's1',
    )
    expect(payload.contextOccupancy).toEqual({
      totalTokens: 110_000,
      maxTokens: 200_000,
      autoCompactThreshold: 167_000,
      isAutoCompactEnabled: true,
      source: 'context-usage-api',
    })
  })

  it('parses a minimal byok final-round snapshot (total + source only)', () => {
    const payload = handleResultUsage(
      {
        type: 'result',
        contextUsage: { totalTokens: 42_000, source: 'final-round-prompt' },
        sessionId: 's1',
      },
      's1',
    )
    expect(payload.contextOccupancy).toEqual({
      totalTokens: 42_000,
      maxTokens: null,
      autoCompactThreshold: null,
      isAutoCompactEnabled: null,
      source: 'final-round-prompt',
    })
  })

  it('rejects a snapshot without a finite non-negative totalTokens', () => {
    for (const totalTokens of [NaN, Infinity, -1, '110000', undefined, null]) {
      const payload = handleResultUsage(
        { type: 'result', contextUsage: { totalTokens }, sessionId: 's1' },
        's1',
      )
      expect(payload.contextOccupancy, `totalTokens=${String(totalTokens)}`).toBeNull()
    }
  })

  it('coerces malformed optional metadata to null without rejecting the snapshot', () => {
    const payload = handleResultUsage(
      {
        type: 'result',
        contextUsage: {
          totalTokens: 50_000,
          maxTokens: -5,
          autoCompactThreshold: 'soon',
          isAutoCompactEnabled: 'yes',
          source: 'made-up-source',
        },
        sessionId: 's1',
      },
      's1',
    )
    expect(payload.contextOccupancy).toEqual({
      totalTokens: 50_000,
      maxTokens: null,
      autoCompactThreshold: null,
      isAutoCompactEnabled: null,
      source: null,
    })
  })

  it('returns null occupancy when the wire field is absent or not an object', () => {
    for (const contextUsage of [undefined, null, 'big', 42, ['x']]) {
      const payload = handleResultUsage(
        { type: 'result', usage: {}, contextUsage, sessionId: 's1' },
        's1',
      )
      expect(payload.contextOccupancy).toBeNull()
    }
  })
})

describe('contextOccupancyTokens (#6769)', () => {
  it('returns the snapshot total; null for no snapshot (dash state)', () => {
    expect(contextOccupancyTokens(snapshot({ totalTokens: 95_500 }))).toBe(95_500)
    expect(contextOccupancyTokens(null)).toBe(null)
    expect(contextOccupancyTokens(undefined)).toBe(null)
  })

  it('returns 0 for an empty-window snapshot and null for a malformed one', () => {
    expect(contextOccupancyTokens(snapshot({ totalTokens: 0 }))).toBe(0)
    expect(contextOccupancyTokens(snapshot({ totalTokens: NaN }))).toBe(null)
    expect(contextOccupancyTokens(snapshot({ totalTokens: -1 }))).toBe(null)
  })

  it('a later smaller snapshot simply reads smaller — compaction follows down', () => {
    // The snapshot model needs no special compaction handling: the
    // post-compaction snapshot IS smaller. (#6768 markers are separate.)
    const before = contextOccupancyTokens(snapshot({ totalTokens: 151_000 }))
    const after = contextOccupancyTokens(snapshot({ totalTokens: 21_500 }))
    expect(after!).toBeLessThan(before!)
  })
})

describe('contextMeterCeiling (#6769)', () => {
  it('prefers the real autoCompactThreshold when present and enabled', () => {
    const occ = snapshot({
      totalTokens: 1, maxTokens: 200_000,
      autoCompactThreshold: 167_000, isAutoCompactEnabled: true,
    })
    expect(contextMeterCeiling(occ)).toBe(167_000)
    // The reserve fallback is NOT applied on top of the real threshold.
    expect(contextMeterCeiling(occ)).not.toBe(effectiveContextWindow(167_000))
  })

  it('uses the RAW window when auto-compact is known-disabled', () => {
    const occ = snapshot({
      totalTokens: 1, maxTokens: 200_000,
      autoCompactThreshold: 167_000, isAutoCompactEnabled: false,
    })
    // Threshold is ignored (no compaction will fire); hard window is honest.
    expect(contextMeterCeiling(occ)).toBe(200_000)
  })

  it('falls back to the documented reserve when no threshold exists (byok)', () => {
    const occ = snapshot({ totalTokens: 1, source: 'final-round-prompt' })
    expect(contextMeterCeiling(occ, 200_000)).toBe(effectiveContextWindow(200_000))
  })

  it('prefers the snapshot maxTokens over the caller-resolved window', () => {
    const occ = snapshot({ totalTokens: 1, maxTokens: 1_000_000 })
    expect(contextMeterCeiling(occ, 200_000)).toBe(effectiveContextWindow(1_000_000))
  })

  it('returns null when no window is known at all', () => {
    expect(contextMeterCeiling(snapshot({ totalTokens: 1 }))).toBe(null)
    expect(contextMeterCeiling(snapshot({ totalTokens: 1 }), null)).toBe(null)
    expect(contextMeterCeiling(null, 200_000)).toBe(null)
  })
})

describe('effectiveContextWindow (#6769 fallback)', () => {
  it('reserves the documented headroom below the raw window', () => {
    expect(effectiveContextWindow(200_000)).toBe(
      Math.round(200_000 * (1 - CONTEXT_AUTO_COMPACT_RESERVE)),
    )
    expect(effectiveContextWindow(200_000)).toBeLessThan(200_000)
  })

  it('returns null for an unknown / non-positive / non-finite window', () => {
    expect(effectiveContextWindow(null)).toBe(null)
    expect(effectiveContextWindow(undefined)).toBe(null)
    expect(effectiveContextWindow(0)).toBe(null)
    expect(effectiveContextWindow(-1)).toBe(null)
    expect(effectiveContextWindow(NaN)).toBe(null)
    expect(effectiveContextWindow(Infinity)).toBe(null)
  })

  it('exposes a reserve fraction strictly between 0 and 1', () => {
    expect(CONTEXT_AUTO_COMPACT_RESERVE).toBeGreaterThan(0)
    expect(CONTEXT_AUTO_COMPACT_RESERVE).toBeLessThan(1)
  })
})

describe('contextFillPercent (#6769)', () => {
  it('meters an SDK snapshot against its real threshold', () => {
    const occ = snapshot({
      totalTokens: 110_000, maxTokens: 200_000,
      autoCompactThreshold: 167_000, isAutoCompactEnabled: true,
      source: 'context-usage-api',
    })
    expect(contextFillPercent(occ)).toBeCloseTo((110_000 / 167_000) * 100, 5)
  })

  it('meters a byok snapshot against the reserve-adjusted registry window', () => {
    const occ = snapshot({ totalTokens: 92_000, source: 'final-round-prompt' })
    const ceiling = effectiveContextWindow(200_000)!
    expect(contextFillPercent(occ, 200_000)).toBeCloseTo((92_000 / ceiling) * 100, 5)
  })

  it('can exceed 100% once occupancy passes the ceiling', () => {
    const occ = snapshot({
      totalTokens: 180_000, maxTokens: 200_000,
      autoCompactThreshold: 167_000, isAutoCompactEnabled: true,
    })
    expect(contextFillPercent(occ)!).toBeGreaterThan(100)
  })

  it('returns null when no window/ceiling is known (no fabricated fraction)', () => {
    expect(contextFillPercent(snapshot({ totalTokens: 50_000 }))).toBe(null)
    expect(contextFillPercent(snapshot({ totalTokens: 50_000 }), null)).toBe(null)
  })

  it('returns null for no snapshot (dash state) or an empty snapshot', () => {
    expect(contextFillPercent(null, 200_000)).toBe(null)
    expect(contextFillPercent(undefined, 200_000)).toBe(null)
    expect(contextFillPercent(snapshot({ totalTokens: 0 }), 200_000)).toBe(null)
  })
})
