/**
 * Tests for shared context-window resolution (#5424).
 *
 * Pins the rule that the 200k DEFAULT_CONTEXT_WINDOW is a *Claude* default:
 * providers that legitimately report no window (ollama deliberately sends
 * `contextWindow: null`) must resolve to `null` so clients render an
 * "unknown window" state instead of a misleading "% of 200k" meter.
 */
import { describe, it, expect } from 'vitest'
import { isClaudeBackedProvider, resolveContextWindow, CLAUDE_BACKED_DOCKER_IDS } from './context-window'
import { DEFAULT_CONTEXT_WINDOW } from './types'

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
