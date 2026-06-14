import { describe, it, expect } from 'vitest'
import {
  PROVIDER_LABELS,
  getProviderLabel,
  getProviderInfo,
  providerSupportsMultiQuestion,
  providerSupportsSingleMultiSelect,
} from './provider-labels'

describe('PROVIDER_LABELS', () => {
  it('contains entries for all known providers', () => {
    const expectedKeys = [
      'claude-sdk', 'claude-cli', 'claude-tui', 'claude-byok', 'docker-cli', 'docker-sdk', 'docker-byok', 'docker', 'gemini', 'codex',
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
    expect(getProviderLabel('claude-tui')).toBe('Claude Code (TUI)')
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

    // #3932: claude-tui must not regress to the generic external-provider
    // fallback (short='CLAUDE-TUI', type='other'). Pin the canonical metadata.
    const tuiInfo = getProviderInfo('claude-tui')
    expect(tuiInfo.short).toBe('TUI')
    expect(tuiInfo.label).toBe('Claude Code (TUI)')
    expect(tuiInfo.type).toBe('cli')
    expect(tuiInfo.tooltip).toContain('PTY')
    expect(tuiInfo.tooltip).toContain('claude.ai')
    expect(tuiInfo.tooltip).toContain('subscription')

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

  // #5026: docker-byok must not regress to the generic fallback. The
  // selector reads `getProviderLabel('docker-byok')` for the option label;
  // without this entry it would show the bare provider id.
  it('docker-byok returns canonical metadata', () => {
    const info = getProviderInfo('docker-byok')
    expect(info.short).toBe('Docker BYOK')
    expect(info.label).toBe('Claude (BYOK — Docker container)')
    expect(info.type).toBe('sdk')
    expect(info.tooltip).toContain('container')
    expect(info.tooltip).toContain('ANTHROPIC_API_KEY')
  })

  it('every known provider has a label field matching PROVIDER_LABELS', () => {
    const knownKeys = Object.keys(PROVIDER_LABELS)
    for (const key of knownKeys) {
      const info = getProviderInfo(key)
      expect(info.label).toBe(PROVIDER_LABELS[key])
    }
  })
})

// #5795 — single source of truth for AskUserQuestion render capability,
// hoisted out of four hand-rolled client derivations.
describe('providerSupportsMultiQuestion', () => {
  it('is true for structured-channel (sdk / other) providers', () => {
    expect(providerSupportsMultiQuestion('claude-sdk')).toBe(true)
    expect(providerSupportsMultiQuestion('claude-byok')).toBe(true)
    expect(providerSupportsMultiQuestion('docker-byok')).toBe(true)
    expect(providerSupportsMultiQuestion('docker-sdk')).toBe(true)
    expect(providerSupportsMultiQuestion('gemini')).toBe(true)
    expect(providerSupportsMultiQuestion('codex')).toBe(true)
  })

  it('is false for cli-type providers (single text answer, no answersMap)', () => {
    expect(providerSupportsMultiQuestion('claude-cli')).toBe(false)
    expect(providerSupportsMultiQuestion('claude-tui')).toBe(false)
  })

  it('is false for docker-cli and its docker alias (the #5795 latent bug)', () => {
    // docker-cli is DockerSession extends CliSession — single-text
    // respondToQuestion like claude-cli. The old `!= claude-cli && != claude-tui`
    // checks let it fall through to true; keying off `type: cli` fixes it.
    expect(providerSupportsMultiQuestion('docker-cli')).toBe(false)
    expect(providerSupportsMultiQuestion('docker')).toBe(false)
  })

  it('is false for null/undefined/empty', () => {
    expect(providerSupportsMultiQuestion(null)).toBe(false)
    expect(providerSupportsMultiQuestion(undefined)).toBe(false)
    expect(providerSupportsMultiQuestion('')).toBe(false)
  })

  it('treats unknown providers as structured-capable (matches the prior fallback)', () => {
    expect(providerSupportsMultiQuestion('my-custom-sdk')).toBe(true)
    expect(providerSupportsMultiQuestion('my-provider')).toBe(true)
  })
})

describe('providerSupportsSingleMultiSelect', () => {
  it('is true for structured-channel providers regardless of caps', () => {
    expect(providerSupportsSingleMultiSelect('claude-sdk')).toBe(true)
    expect(providerSupportsSingleMultiSelect('claude-byok')).toBe(true)
    expect(providerSupportsSingleMultiSelect('docker-sdk')).toBe(true)
    expect(providerSupportsSingleMultiSelect('gemini')).toBe(true)
    expect(providerSupportsSingleMultiSelect('codex')).toBe(true)
  })

  it('claude-tui is gated on the multiSelectReinject capability (#5791)', () => {
    // Without the cap (server flag off / unknown) the client must NOT offer the
    // form — the server refuses it (was the #5791 split-brain).
    expect(providerSupportsSingleMultiSelect('claude-tui')).toBe(false)
    expect(providerSupportsSingleMultiSelect('claude-tui', null)).toBe(false)
    expect(providerSupportsSingleMultiSelect('claude-tui', {})).toBe(false)
    expect(providerSupportsSingleMultiSelect('claude-tui', { multiSelectReinject: false })).toBe(false)
    // With the cap the form is offered (server will reinject the answer).
    expect(providerSupportsSingleMultiSelect('claude-tui', { multiSelectReinject: true })).toBe(true)
  })

  it('ignores the cap for non-claude-tui providers', () => {
    // The cap only gates claude-tui; SDK providers are always structured-capable
    // and CLI providers are never (the cap can't enable them).
    expect(providerSupportsSingleMultiSelect('claude-sdk', { multiSelectReinject: false })).toBe(true)
    expect(providerSupportsSingleMultiSelect('claude-cli', { multiSelectReinject: true })).toBe(false)
    expect(providerSupportsSingleMultiSelect('docker-cli', { multiSelectReinject: true })).toBe(false)
  })

  it('is false for the plain CLI providers', () => {
    expect(providerSupportsSingleMultiSelect('claude-cli')).toBe(false)
    expect(providerSupportsSingleMultiSelect('docker-cli')).toBe(false)
    expect(providerSupportsSingleMultiSelect('docker')).toBe(false)
  })

  it('is false for null/undefined/empty', () => {
    expect(providerSupportsSingleMultiSelect(null)).toBe(false)
    expect(providerSupportsSingleMultiSelect(undefined)).toBe(false)
    expect(providerSupportsSingleMultiSelect('')).toBe(false)
  })
})
