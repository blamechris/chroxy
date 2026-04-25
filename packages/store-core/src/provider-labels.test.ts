import { describe, it, expect } from 'vitest'
import {
  PROVIDER_LABELS,
  getProviderLabel,
  getProviderInfo,
} from './provider-labels'

describe('PROVIDER_LABELS', () => {
  it('contains entries for all known providers', () => {
    const expectedKeys = [
      'claude-sdk', 'claude-cli', 'docker-cli', 'docker-sdk', 'docker', 'gemini', 'codex',
    ]
    for (const key of expectedKeys) {
      expect(PROVIDER_LABELS).toHaveProperty(key)
      expect(typeof PROVIDER_LABELS[key]).toBe('string')
      expect(PROVIDER_LABELS[key].length).toBeGreaterThan(0)
    }
  })

  it('uses CLI-style labels for gemini and codex', () => {
    expect(PROVIDER_LABELS['gemini']).toBe('Gemini (CLI)')
    expect(PROVIDER_LABELS['codex']).toBe('Codex (CLI)')
  })

  it('PROVIDER_LABELS is derived from KNOWN_PROVIDERS (single source of truth)', () => {
    // Verify each label matches what getProviderInfo returns
    for (const [key, label] of Object.entries(PROVIDER_LABELS)) {
      expect(getProviderInfo(key).label).toBe(label)
    }
  })
})

describe('getProviderLabel', () => {
  it('returns human-readable label for known providers', () => {
    expect(getProviderLabel('claude-sdk')).toBe('Claude Code (SDK)')
    expect(getProviderLabel('claude-cli')).toBe('Claude Code (CLI)')
    expect(getProviderLabel('docker-cli')).toBe('Claude Code (Docker CLI)')
    expect(getProviderLabel('docker-sdk')).toBe('Claude Code (Docker SDK)')
    expect(getProviderLabel('docker')).toBe('Claude Code (Docker CLI)')
    expect(getProviderLabel('gemini')).toBe('Gemini (CLI)')
    expect(getProviderLabel('codex')).toBe('Codex (CLI)')
  })

  it('returns the raw name for unknown providers', () => {
    expect(getProviderLabel('unknown-provider')).toBe('unknown-provider')
    expect(getProviderLabel('my-custom-llm')).toBe('my-custom-llm')
    expect(getProviderLabel('')).toBe('')
  })
})

describe('getProviderInfo', () => {
  it('returns correct info for known providers', () => {
    const sdkInfo = getProviderInfo('claude-sdk')
    expect(sdkInfo.short).toBe('SDK')
    expect(sdkInfo.type).toBe('sdk')
    expect(sdkInfo.tooltip).toContain('ANTHROPIC_API_KEY')

    const cliInfo = getProviderInfo('claude-cli')
    expect(cliInfo.short).toBe('CLI')
    expect(cliInfo.type).toBe('cli')
    expect(cliInfo.tooltip).toContain('claude.ai')

    const geminiInfo = getProviderInfo('gemini')
    expect(geminiInfo.short).toBe('Gemini')
    expect(geminiInfo.type).toBe('other')
    expect(geminiInfo.tooltip).toContain('Google')

    const codexInfo = getProviderInfo('codex')
    expect(codexInfo.short).toBe('Codex')
    expect(codexInfo.type).toBe('other')
    expect(codexInfo.tooltip).toContain('OpenAI')
  })

  it('heuristic fallback for unknown sdk-containing providers', () => {
    const info = getProviderInfo('my-custom-sdk')
    expect(info.type).toBe('sdk')
    expect(info.short).toBe('SDK')
    expect(info.tooltip).toContain('billed per token')
  })

  it('fallback for completely unknown providers uppercases the short name', () => {
    const info = getProviderInfo('my-provider')
    expect(info.type).toBe('other')
    expect(info.short).toBe('MY-PROVIDER')
    expect(info.tooltip).toContain('billing dashboard')
  })

  it('strips claude- prefix from unknown claude-* providers', () => {
    const info = getProviderInfo('claude-experimental')
    expect(info.short).toBe('EXPERIMENTAL')
    expect(info.type).toBe('other')
  })

  it('every known provider has a label field matching PROVIDER_LABELS', () => {
    const knownKeys = Object.keys(PROVIDER_LABELS)
    for (const key of knownKeys) {
      const info = getProviderInfo(key)
      expect(info.label).toBe(PROVIDER_LABELS[key])
    }
  })
})
