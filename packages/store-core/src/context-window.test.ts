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
  contextWindowTokens,
  effectiveContextWindow,
  contextFillPercent,
  CONTEXT_AUTO_COMPACT_RESERVE,
} from './context-window'
import { DEFAULT_CONTEXT_WINDOW } from './types'

/** Shorthand for a ContextUsage-shaped object in these tests. */
function usage(
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  cacheCreation = 0,
) {
  return { inputTokens, outputTokens, cacheRead, cacheCreation }
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
// #6769 — cumulative context-window fill (occupancy).
//
// The meter must read the current conversation size, which — under prompt
// caching — is input + output + cache_read + cache_creation of the MOST RECENT
// result, not input + output (which is just the new message + reply and reads
// near-empty mid-conversation). See the module docblock for the full semantic
// model and its evidence.
// ---------------------------------------------------------------------------

describe('contextWindowTokens (#6769)', () => {
  it('sums input + output + cache_read + cache_creation (cumulative fill)', () => {
    // A mid-conversation Claude turn: tiny new input, big cache_read history.
    expect(contextWindowTokens(usage(500, 2_000, 90_000, 3_000))).toBe(95_500)
  })

  it('degrades to input + output when cache fields are absent (0)', () => {
    // Providers that omit cache tokens (handleResultUsage defaults them to 0)
    // must fall back to input + output automatically — no special-casing.
    expect(contextWindowTokens(usage(40_000, 8_000, 0, 0))).toBe(48_000)
  })

  it('returns null when usage is null/undefined (pre-first-turn)', () => {
    expect(contextWindowTokens(null)).toBe(null)
    expect(contextWindowTokens(undefined)).toBe(null)
  })

  it('returns 0 for an all-zero usage object (empty turn)', () => {
    expect(contextWindowTokens(usage(0, 0, 0, 0))).toBe(0)
  })

  it('tolerates a partial object missing the cache fields (degrades to input+output)', () => {
    // A provider / persisted-cache shape that predates the cache fields must
    // NOT poison the total to NaN — it degrades to input + output.
    expect(contextWindowTokens({ inputTokens: 12_000, outputTokens: 500 })).toBe(12_500)
  })

  it('coerces a non-finite field to 0 rather than poisoning the whole total', () => {
    expect(contextWindowTokens(usage(NaN, 500, 0, 0))).toBe(500)
    expect(contextWindowTokens(usage(1_000, 500, Infinity, 0))).toBe(1_500)
  })

  it('follows a compaction DOWN — a smaller latest turn yields a smaller total', () => {
    // Pre-compaction: 150k of history in cache_read.
    const before = contextWindowTokens(usage(500, 1_000, 150_000, 0))
    // After Claude compacts, the next turn re-reports a much smaller history.
    const after = contextWindowTokens(usage(500, 1_000, 20_000, 0))
    expect(before).toBe(151_500)
    expect(after).toBe(21_500)
    // The meter reads the LATEST turn, so it drops rather than clamping to a
    // per-session max (#6768 compaction markers are a separate concern).
    expect(after!).toBeLessThan(before!)
  })
})

describe('effectiveContextWindow (#6769)', () => {
  it('reserves the auto-compact headroom below the raw window', () => {
    // Claude Code compacts BEFORE the hard window, so the meter reads 100% at
    // the compaction boundary, not the raw ceiling.
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
  it('meters cumulative occupancy against the effective (auto-compact) ceiling', () => {
    // 92k of history + new tokens against a 200k window whose effective
    // ceiling is 184k → ~50%.
    const pct = contextFillPercent(usage(2_000, 1_000, 89_000, 0), 200_000)
    const ceiling = effectiveContextWindow(200_000)!
    expect(pct).toBeCloseTo((92_000 / ceiling) * 100, 5)
  })

  it('includes cache tokens — a cached conversation is NOT near-empty', () => {
    // The exact bug from #6769: input+output alone reads ~1% while the window
    // is actually ~half full because the history lives in cache_read.
    const naive = contextFillPercent(usage(1_000, 1_000, 0, 0), 200_000)
    const real = contextFillPercent(usage(1_000, 1_000, 90_000, 0), 200_000)
    expect(naive).toBeLessThan(2)
    expect(real).toBeGreaterThan(40)
  })

  it('can exceed 100% once occupancy passes the auto-compact ceiling', () => {
    const pct = contextFillPercent(usage(0, 0, 195_000, 0), 200_000)
    expect(pct).toBeGreaterThan(100)
  })

  it('returns null when the window is unknown (no fabricated fraction)', () => {
    expect(contextFillPercent(usage(50_000, 5_000, 0, 0), null)).toBe(null)
  })

  it('returns null for no usage or a zero-token conversation', () => {
    expect(contextFillPercent(null, 200_000)).toBe(null)
    expect(contextFillPercent(usage(0, 0, 0, 0), 200_000)).toBe(null)
  })
})
