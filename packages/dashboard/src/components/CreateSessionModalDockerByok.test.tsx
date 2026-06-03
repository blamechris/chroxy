/**
 * Runtime polish tests for the docker-byok provider selector (#5026).
 *
 * Asserts the rendered behaviour:
 *   - the option label resolves through PROVIDER_LABELS (not the raw
 *     provider id)
 *   - the "Containerized" capability badge renders with the
 *     data-capability="containerized" hook so CSS can style it distinctly
 *   - selecting docker-byok shows the container-settings hint (gated on
 *     `capabilities.containerized`)
 *   - selecting claude-byok does NOT show the container hint or the
 *     Containerized badge (regression guard so the polish stays scoped
 *     to docker-* providers)
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

const DOCKER_BYOK_PROVIDER: ProviderInfo = {
  name: 'docker-byok',
  capabilities: {
    ...baseCaps,
    containerized: true,
    sessionRules: true,
  },
  auth: {
    ready: true,
    source: 'env',
    envVar: 'ANTHROPIC_API_KEY',
    envVars: ['ANTHROPIC_API_KEY'],
    hint: '',
    detail: 'Direct Anthropic API (your ANTHROPIC_API_KEY set)',
  },
}

const CLAUDE_BYOK_PROVIDER: ProviderInfo = {
  name: 'claude-byok',
  capabilities: {
    ...baseCaps,
    sessionRules: true,
  },
  auth: {
    ready: true,
    source: 'env',
    envVar: 'ANTHROPIC_API_KEY',
    envVars: ['ANTHROPIC_API_KEY'],
    hint: '',
    detail: 'Direct Anthropic API (your ANTHROPIC_API_KEY set)',
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

describe('docker-byok provider-selector runtime polish (#5026)', () => {
  it('renders the human-readable label for docker-byok (not the raw id)', () => {
    renderWithState('docker-byok', [DOCKER_BYOK_PROVIDER])
    const select = screen.getByLabelText('Select provider') as HTMLSelectElement
    const option = Array.from(select.options).find(o => o.value === 'docker-byok')
    expect(option).toBeTruthy()
    expect(option!.textContent).toMatch(/Claude \(BYOK — Docker container\)/)
    // The raw id alone is a regression — the label must render the
    // human-readable copy from PROVIDER_LABELS.
    expect(option!.textContent).not.toBe('docker-byok')
  })

  it('renders the "Containerized" capability badge with data-capability="containerized"', () => {
    renderWithState('docker-byok', [DOCKER_BYOK_PROVIDER])
    const badges = screen.getByTestId('provider-capabilities')
    const containerizedBadge = badges.querySelector('[data-capability="containerized"]')
    expect(containerizedBadge).toBeTruthy()
    expect(containerizedBadge!.textContent).toBe('Containerized')
  })

  it('shows the container-settings hint when docker-byok is selected', () => {
    renderWithState('docker-byok', [DOCKER_BYOK_PROVIDER])
    const hint = screen.getByTestId('provider-container-hint')
    expect(hint).toBeTruthy()
    // Default branch (no environments) must explain the built-in defaults
    // so the user knows what they'll get without picking an Environment.
    expect(hint.textContent).toMatch(/node:22-slim/)
    expect(hint.textContent).toMatch(/2g/i)
    expect(hint.textContent).toMatch(/Environment/i)
  })

  it('does NOT show the container hint for claude-byok (regression guard)', () => {
    renderWithState('claude-byok', [CLAUDE_BYOK_PROVIDER])
    expect(screen.queryByTestId('provider-container-hint')).toBeNull()
  })

  it('does NOT render a Containerized badge for claude-byok (regression guard)', () => {
    renderWithState('claude-byok', [CLAUDE_BYOK_PROVIDER])
    const badges = screen.queryByTestId('provider-capabilities')
    // claude-byok may not have any badges at all if none of resume / plan /
    // permissions / terminal apply — either way the containerized hook
    // must not appear.
    if (badges) {
      expect(badges.querySelector('[data-capability="containerized"]')).toBeNull()
    }
  })

  it('switches the hint copy when an environment exists', () => {
    ;(globalThis as unknown as { __TEST_STATE__: Record<string, unknown> }).__TEST_STATE__ = {
      ...buildState('docker-byok', [DOCKER_BYOK_PROVIDER]),
      environments: [
        {
          id: 'env-1',
          name: 'main',
          cwd: '/tmp',
          image: 'node:22-slim',
          containerId: 'abc',
          containerUser: 'chroxy',
          containerCliPath: '/usr/local/bin/claude',
          status: 'running',
          sessions: [],
          createdAt: new Date().toISOString(),
          memoryLimit: '2g',
          cpuLimit: '2',
        },
      ],
    }
    render(
      <CreateSessionModal
        open={true}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        initialCwd=""
        knownCwds={[]}
        existingNames={[]}
      />,
    )
    const hint = screen.getByTestId('provider-container-hint')
    // When environments exist the hint should steer the user to the
    // dropdown rather than telling them to create one.
    expect(hint.textContent).toMatch(/Pick an environment/i)
  })

  it('surfaces the docker-byok vs. claude-byok trade-off in the billing hint', () => {
    renderWithState('docker-byok', [DOCKER_BYOK_PROVIDER])
    // The live auth.detail wins over PROVIDER_BILLING here (auth.ready
    // is true with a populated detail), but the static PROVIDER_BILLING
    // entry MUST still be present so a server without the detail field
    // (or one running older code) gets the trade-off copy. The source
    // file assertion in ProviderPicker.test.tsx checks the static map.
    // This runtime test asserts the live detail surfaces the API-key
    // billing identity.
    const billing = screen.getByTestId('provider-billing-hint')
    expect(billing.textContent).toMatch(/ANTHROPIC_API_KEY/)
  })
})
