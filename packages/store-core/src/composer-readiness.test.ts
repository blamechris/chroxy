import { describe, expect, it } from 'vitest'
import type { ProviderRuntimeInfo } from '@chroxy/protocol'
import { deriveComposerReadiness, providerInputReadinessFallback } from './composer-readiness'

function runtime(
  inputRequiresReady: boolean,
  inputReady?: true | false | 'unknown',
): ProviderRuntimeInfo {
  return {
    provider: 'fixture',
    binaryVersion: 'unknown',
    inputRequiresReady,
    capabilities: inputReady === undefined ? [] : [{ name: 'inputReady', state: inputReady }],
    customization: {
      nativeDiscovery: { state: false, files: [], delivery: 'none', precedence: 'none' },
      chroxyChannels: [],
      nativeSkills: false,
      runtimeToggles: false,
      toolConstraints: 'none',
      policyDecisions: false,
      memoryProjection: 'none',
      mcp: { discovery: false, toolCalls: false },
      byteBudgets: { nativeDocuments: 0, chroxySkills: 0, projectInstructions: 0 },
      egress: 'local',
    },
    projectInstructions: {
      status: 'unsupported', enforcement: 'instructional', compilerVersion: '1',
      budgetBytes: 0, totalBytes: 0, sources: [], rules: [], includedRequiredRuleIds: [],
    },
  }
}

describe('deriveComposerReadiness', () => {
  it('keeps a session synchronizing until current runtime facts arrive', () => {
    expect(deriveComposerReadiness(null)).toEqual({ canSend: false, status: 'synchronizing' })
  })

  it('allows a known non-gated provider before its informational runtime frame arrives', () => {
    expect(deriveComposerReadiness(null, false)).toEqual({ canSend: true, status: 'ready' })
  })

  it('does not gate SDK or legacy drivers that do not require native readiness', () => {
    expect(deriveComposerReadiness(runtime(false))).toEqual({ canSend: true, status: 'ready' })
  })

  it('gates required drivers until live inputReady is true, including unknown', () => {
    expect(deriveComposerReadiness(runtime(true, false))).toEqual({ canSend: false, status: 'initializing' })
    expect(deriveComposerReadiness(runtime(true, 'unknown'))).toEqual({ canSend: false, status: 'initializing' })
    expect(deriveComposerReadiness(runtime(true))).toEqual({ canSend: false, status: 'initializing' })
    expect(deriveComposerReadiness(runtime(true, true))).toEqual({ canSend: true, status: 'ready' })
  })
})

describe('provider startup compatibility', () => {
  it.each(['claude-cli', 'claude-sdk', 'claude-tui', 'claude-channel', 'claude-byok', 'deepseek', 'ollama', 'gemini', 'user-shell'])('keeps %s input available before the informational frame', provider => {
    expect(deriveComposerReadiness(null, providerInputReadinessFallback(provider)).canSend).toBe(true)
    // A runtime trait overrides the compatibility fallback for every provider.
    expect(deriveComposerReadiness(runtime(true, false), providerInputReadinessFallback(provider)).canSend).toBe(false)
  })
  it.each(['codex', 'codex-appserver', null, undefined])('waits for current runtime facts for %s', provider => {
    const fallback = providerInputReadinessFallback(provider)
    expect(deriveComposerReadiness(null, fallback).canSend).toBe(false)
    expect(deriveComposerReadiness(runtime(false), fallback).canSend).toBe(true)
    expect(deriveComposerReadiness(runtime(true, true), fallback).canSend).toBe(true)
  })
})
