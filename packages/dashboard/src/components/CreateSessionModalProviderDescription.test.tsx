/**
 * #8231 — the New Session provider picker says what each provider is: ready
 * `<option>`s carry the provider's tooltip as their title (not just the bare
 * label), and one visible line under the select describes the selected one.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'
import { getProviderInfo } from '../lib/provider-labels'

const mockStoreState: Record<string, unknown> = {}

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockStoreState),
}))

import { CreateSessionModal } from './CreateSessionModal'

const READY = (name: string) => ({
  name,
  capabilities: {},
  auth: { ready: true, source: 'env', envVar: 'K', envVars: ['K'], detail: 'ok', hint: '' },
})

beforeEach(() => {
  for (const k of Object.keys(mockStoreState)) delete mockStoreState[k]
  Object.assign(mockStoreState, {
    defaultProvider: 'claude-sdk',
    defaultModel: null,
    modelsByProvider: {},
    availableProviders: [READY('claude-sdk'), READY('codex')],
    permissionModesByProvider: {},
    environments: [],
    requestDirectoryListing: () => {},
    setDirectoryListingCallback: () => {},
    defaultCwd: null,
  })
})

afterEach(cleanup)

function renderModal() {
  render(
    <CreateSessionModal
      open
      onClose={() => {}}
      onCreate={() => {}}
      initialCwd="/Users/me/projects"
      knownCwds={[]}
      existingNames={[]}
    />,
  )
}

describe('provider picker descriptions (#8231)', () => {
  it('a ready option title is the provider tooltip, not the bare label', () => {
    renderModal()
    const select = screen.getByLabelText('Select provider') as HTMLSelectElement
    const codex = Array.from(select.options).find(o => o.value === 'codex')!
    expect(codex.title === getProviderInfo('codex').tooltip, 'title is the tooltip').toBe(true)
    expect(codex.title !== codex.textContent, 'title adds information').toBe(true)
  })

  it('shows the description only when no billing hint is shown, and follows the selection', () => {
    mockStoreState.availableProviders = [
      READY('claude-sdk'),
      { name: 'smoke-stub', capabilities: {}, auth: { ready: true, source: 'none', envVar: null, envVars: [], detail: '', hint: '' } },
    ]
    renderModal()
    // claude-sdk has live auth detail → the billing hint speaks, no description.
    expect(screen.getByTestId('provider-billing-hint')).toBeInTheDocument()
    expect(screen.queryByTestId('provider-description')).not.toBeInTheDocument()
    // smoke-stub has neither live detail nor a static billing line → description shows.
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'smoke-stub' } })
    expect(screen.queryByTestId('provider-billing-hint')).not.toBeInTheDocument()
    expect(screen.getByTestId('provider-description').textContent === getProviderInfo('smoke-stub').tooltip).toBe(true)
  })
})
