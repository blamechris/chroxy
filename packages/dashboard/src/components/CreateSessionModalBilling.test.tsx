/**
 * CreateSessionModal billing-copy tests (#5630/#5629).
 *
 * The provider-billing hint prefers the live server `auth.detail` (which is
 * itself era-gated server-side). The STATIC fallback — shown when a provider
 * has no live auth.detail yet — is also era-gated CLIENT-side here, so we
 * assert both eras by mocking the system clock (the fallback reads Date.now()).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { ProviderInfo } from '../store/types'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

const baseCaps = {
  permissions: true,
  inProcessPermissions: false,
  modelSwitch: true,
  permissionModeSwitch: true,
  planMode: true,
  resume: true,
  terminal: false,
}

// A ready provider with NO auth.detail so the static (era-gated) fallback is
// what renders. claude-cli is the canonical era-flipping provider.
const CLAUDE_CLI_NO_DETAIL: ProviderInfo = {
  name: 'claude-cli',
  capabilities: { ...baseCaps },
}

// A provider that DOES carry a live server detail — primacy check.
const CLAUDE_CLI_WITH_DETAIL: ProviderInfo = {
  name: 'claude-cli',
  capabilities: { ...baseCaps },
  auth: {
    ready: true,
    source: 'oauth',
    envVar: null,
    envVars: [],
    hint: '',
    detail: 'SERVER-DRIVEN DETAIL WINS',
    billingClass: 'programmatic-credit',
  },
}

function buildState(defaultProvider: string, providers: ProviderInfo[]) {
  return {
    defaultProvider,
    defaultModel: '',
    availableModels: [],
    availableModelsProvider: null,
    availableProviders: providers,
    availablePermissionModes: [],
    environments: [],
    requestDirectoryListing: () => {},
    setDirectoryListingCallback: () => {},
    defaultCwd: null,
  }
}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector((globalThis as unknown as { __TEST_STATE__: Record<string, unknown> }).__TEST_STATE__),
}))

import { CreateSessionModal } from './CreateSessionModal'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (globalThis as unknown as { __TEST_STATE__?: Record<string, unknown> }).__TEST_STATE__
})

function renderWithState(defaultProvider: string, providers: ProviderInfo[]) {
  ;(globalThis as unknown as { __TEST_STATE__: Record<string, unknown> }).__TEST_STATE__ =
    buildState(defaultProvider, providers)
  return render(
    <CreateSessionModal
      open={true}
      onClose={vi.fn()}
      onCreate={vi.fn()}
      initialCwd=""
      knownCwds={[]}
      existingNames={[]}
    />,
  )
}

describe('CreateSessionModal billing copy — era-gated fallback (#5629)', () => {
  it('shows the subscription fallback BEFORE 2026-06-15', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-14T12:00:00Z'))
    renderWithState('claude-cli', [CLAUDE_CLI_NO_DETAIL])
    const hint = screen.getByTestId('provider-billing-hint')
    expect(hint.textContent ?? '').toMatch(/subscription/i)
    expect(hint.textContent ?? '').not.toMatch(/programmatic credit pool/i)
    // Source attribute reflects the static fallback path.
    expect(hint.getAttribute('data-source')).toBe('static')
  })

  it('shows the programmatic-credit fallback ON/AFTER 2026-06-15', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'))
    renderWithState('claude-cli', [CLAUDE_CLI_NO_DETAIL])
    const hint = screen.getByTestId('provider-billing-hint')
    expect(hint.textContent ?? '').toMatch(/programmatic credit pool/i)
  })

  it('prefers the live server detail over the static fallback', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'))
    renderWithState('claude-cli', [CLAUDE_CLI_WITH_DETAIL])
    const hint = screen.getByTestId('provider-billing-hint')
    expect(hint.textContent).toBe('SERVER-DRIVEN DETAIL WINS')
    expect(hint.getAttribute('data-source')).toBe('oauth')
  })
})
