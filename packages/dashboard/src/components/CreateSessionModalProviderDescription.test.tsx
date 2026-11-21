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

  it('shows one description line for the selected provider and follows the selection', () => {
    renderModal()
    const desc = () => screen.getByTestId('provider-description').textContent
    expect(desc() === getProviderInfo('claude-sdk').tooltip, 'initial').toBe(true)
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'codex' } })
    expect(desc() === getProviderInfo('codex').tooltip, 'after change').toBe(true)
  })
})
