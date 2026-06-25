/**
 * Tests for the provider limitation note on the Create Session modal (#6312).
 *
 * A reduced-capability provider (notably claude-tui, the zero-config default —
 * no plan mode / streaming / model switch) previously communicated those gaps
 * only by the ABSENCE of a UI control. This note explains them at session
 * creation. Pins:
 *   1. the note renders for a provider with `false` capabilities
 *   2. the note is absent for a fully-capable provider
 *   3. switching to a reduced-capability provider surfaces the note
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'

const mockStoreState: Record<string, unknown> = {}

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockStoreState),
}))

import { CreateSessionModal, type CreateSessionModalProps } from './CreateSessionModal'

const READY_AUTH = {
  ready: true,
  source: 'env',
  envVar: 'ANTHROPIC_API_KEY',
  envVars: ['ANTHROPIC_API_KEY'],
  detail: 'API key',
  hint: '',
}
const TUI_DEGRADED = {
  name: 'claude-tui',
  capabilities: { permissions: true, modelSwitch: false, planMode: false, streaming: false },
  auth: READY_AUTH,
}
const SDK_CAPABLE = {
  name: 'claude-sdk',
  capabilities: { permissions: true, modelSwitch: true, planMode: true, streaming: true },
  auth: READY_AUTH,
}

beforeEach(() => {
  for (const k of Object.keys(mockStoreState)) delete mockStoreState[k]
  Object.assign(mockStoreState, {
    defaultProvider: 'claude-sdk',
    defaultModel: null,
    availableModels: [],
    availableModelsProvider: null,
    availableProviders: [SDK_CAPABLE, TUI_DEGRADED],
    availablePermissionModes: [],
    environments: [],
    requestDirectoryListing: () => {},
    setDirectoryListingCallback: () => {},
    defaultCwd: null,
  })
})

afterEach(cleanup)

function renderModal(props: Partial<CreateSessionModalProps> = {}) {
  const onCreate = vi.fn()
  const onClose = vi.fn()
  const defaultProps: CreateSessionModalProps = {
    open: true,
    onClose,
    onCreate,
    initialCwd: '/Users/me/projects',
    knownCwds: [],
    existingNames: [],
    ...props,
  }
  return { ...render(<CreateSessionModal {...defaultProps} />), onCreate }
}

describe('CreateSessionModal provider limitation note (#6312)', () => {
  it('renders the limitation note for a reduced-capability provider (claude-tui)', () => {
    mockStoreState.defaultProvider = 'claude-tui'
    renderModal()
    const note = screen.getByTestId('provider-limitation-note')
    expect(note).toBeInTheDocument()
    expect(note.textContent).toMatch(/plan mode/)
    expect(note.textContent).toMatch(/streaming/)
    expect(note.textContent).toMatch(/model switching/)
  })

  it('does NOT render the note for a fully-capable provider', () => {
    mockStoreState.defaultProvider = 'claude-sdk'
    renderModal()
    expect(screen.queryByTestId('provider-limitation-note')).not.toBeInTheDocument()
  })

  it('surfaces the note when the user switches to a reduced-capability provider', () => {
    mockStoreState.defaultProvider = 'claude-sdk'
    renderModal()
    expect(screen.queryByTestId('provider-limitation-note')).not.toBeInTheDocument()
    const select = screen.getByLabelText('Select provider') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'claude-tui' } })
    const note = screen.getByTestId('provider-limitation-note')
    expect(note.textContent).toMatch(/doesn't support/)
  })
})
