/**
 * ModelPickerModal (#6220) — modal model picker behaviour: list + group header,
 * default/active marking, select → onSelect+onClose, search filter, arrow-key
 * roving focus, disabled (forward-compat) rows, and Escape (via shared Modal).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ModelPickerModal, type ModelPickerModalProps } from './ModelPickerModal'

afterEach(cleanup)

const MODELS = [
  { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6', contextWindow: 200000 },
  { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-8', contextWindow: 1_000_000 },
  { id: 'haiku', label: 'Haiku', fullId: 'claude-haiku-4-5' },
]

function renderModal(overrides: Partial<ModelPickerModalProps> = {}) {
  const props: ModelPickerModalProps = {
    open: true,
    onClose: vi.fn(),
    availableModels: MODELS,
    activeModel: 'sonnet',
    defaultModelId: 'opus',
    providerLabel: 'claude-cli',
    onSelect: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<ModelPickerModal {...props} />) }
}

describe('ModelPickerModal (#6220)', () => {
  it('renders nothing when closed', () => {
    renderModal({ open: false })
    expect(screen.queryByTestId('model-picker')).toBeNull()
  })

  it('lists every available model under the provider group header', () => {
    renderModal()
    expect(screen.getByTestId('model-picker-group').textContent).toBe('claude-cli')
    expect(screen.getByTestId('model-picker-item-sonnet')).toBeInTheDocument()
    expect(screen.getByTestId('model-picker-item-opus')).toBeInTheDocument()
    expect(screen.getByTestId('model-picker-item-haiku')).toBeInTheDocument()
  })

  it('marks the default model with "(default)"', () => {
    renderModal({ defaultModelId: 'opus' })
    expect(screen.getByTestId('model-picker-item-opus').textContent).toMatch(/Opus \(default\)/)
    expect(screen.getByTestId('model-picker-item-sonnet').textContent).not.toMatch(/default/)
  })

  it('marks the active model as aria-selected', () => {
    renderModal({ activeModel: 'sonnet' })
    expect(screen.getByTestId('model-picker-item-sonnet').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('model-picker-item-opus').getAttribute('aria-selected')).toBe('false')
  })

  it('resolves a full-id activeModel to the right row (#5628)', () => {
    renderModal({ activeModel: 'claude-opus-4-8' })
    expect(screen.getByTestId('model-picker-item-opus').getAttribute('aria-selected')).toBe('true')
  })

  it('calls onSelect with the model id and closes when a row is clicked', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    renderModal({ onSelect, onClose })
    fireEvent.click(screen.getByTestId('model-picker-item-haiku'))
    expect(onSelect).toHaveBeenCalledWith('haiku')
    expect(onClose).toHaveBeenCalled()
  })

  it('filters the list by the search query (label, id, or fullId)', () => {
    renderModal()
    fireEvent.change(screen.getByTestId('model-picker-search'), { target: { value: 'opus' } })
    expect(screen.getByTestId('model-picker-item-opus')).toBeInTheDocument()
    expect(screen.queryByTestId('model-picker-item-sonnet')).toBeNull()
    expect(screen.queryByTestId('model-picker-item-haiku')).toBeNull()
  })

  it('shows an empty state when nothing matches the query', () => {
    renderModal()
    fireEvent.change(screen.getByTestId('model-picker-search'), { target: { value: 'zzz-no-match' } })
    expect(screen.getByTestId('model-picker-empty')).toBeInTheDocument()
  })

  it('renders a disabled (forward-compat) model as a non-selectable row', () => {
    const onSelect = vi.fn()
    const models = [...MODELS, { id: 'fable', label: 'Fable', fullId: 'claude-fable-5', disabled: true }]
    renderModal({ availableModels: models as ModelPickerModalProps['availableModels'], onSelect })
    const row = screen.getByTestId('model-picker-item-fable') as HTMLButtonElement
    expect(row.disabled).toBe(true)
    fireEvent.click(row)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('arrow keys move focus between option rows', () => {
    renderModal()
    const sonnet = screen.getByTestId('model-picker-item-sonnet')
    sonnet.focus()
    expect(document.activeElement).toBe(sonnet)
    fireEvent.keyDown(screen.getByTestId('model-picker-list'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('model-picker-item-opus'))
    fireEvent.keyDown(screen.getByTestId('model-picker-list'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(sonnet)
  })

  // #6238 — search-then-arrow: ArrowDown from the search field jumps into the
  // first (enabled) result without an intermediate Tab.
  it('ArrowDown from the search field focuses the first result row', () => {
    renderModal()
    const search = screen.getByTestId('model-picker-search')
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('model-picker-item-sonnet'))
  })

  it('ArrowDown from search skips a disabled first row to the first enabled one', () => {
    const models = [
      { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6', disabled: true },
      { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-8' },
    ]
    renderModal({ availableModels: models as ModelPickerModalProps['availableModels'] })
    const search = screen.getByTestId('model-picker-search')
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('model-picker-item-opus'))
  })

  it('Enter in the search field selects when the filter narrows to exactly one match', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    renderModal({ onSelect, onClose })
    const search = screen.getByTestId('model-picker-search')
    fireEvent.change(search, { target: { value: 'opus' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('opus')
    expect(onClose).toHaveBeenCalled()
  })

  it('Enter in the search field does NOT select when more than one match remains', () => {
    const onSelect = vi.fn()
    renderModal({ onSelect })
    const search = screen.getByTestId('model-picker-search')
    // Empty query → all three models match; Enter must not pick arbitrarily.
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  // #8064 — the Enter that commits an IME composition must not be read as
  // "select the single matching model", even when the filter has narrowed
  // to exactly one match.
  it('Enter in the search field during IME composition does not select', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    renderModal({ onSelect, onClose })
    const search = screen.getByTestId('model-picker-search')
    fireEvent.change(search, { target: { value: 'opus' } })
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('model target identity (#8260)', () => {
  const aliases = [
    { id: 'haiku', fullId: 'haiku', label: 'Haiku 4.5' },
    { id: 'haiku-4-5', fullId: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    { id: 'haiku-4-5-20251001', fullId: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ]
  it('names every distinct target and sends its original selection ID', () => {
    const onSelect = vi.fn()
    renderModal({ availableModels: aliases, activeModel: aliases[2]!.fullId, defaultModelId: null, onSelect })
    expect(screen.getByTestId('model-picker-item-haiku').textContent).toContain('provider alias')
    expect(screen.getByTestId('model-picker-item-haiku-4-5').textContent).toContain('pinned 4.5')
    expect(screen.getByTestId('model-picker-item-haiku-4-5-20251001').textContent).toContain('pinned 20251001')
    expect(screen.getAllByRole('option').filter(row => row.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    expect(screen.getByTestId('model-picker-item-haiku-4-5-20251001').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByTestId('model-picker-item-haiku-4-5'))
    expect(onSelect).toHaveBeenCalledWith('haiku-4-5')
  })
  it('never highlights a family substitute for an absent dated running ID', () => {
    renderModal({ availableModels: aliases, activeModel: 'claude-haiku-4-5-20251101', defaultModelId: 'haiku' })
    expect(screen.getAllByRole('option').filter(row => row.getAttribute('aria-selected') === 'true')).toHaveLength(0)
  })
})

it('marks one shared-target row as active and default when different accepted aliases name it (#8260)', () => {
  renderModal({ availableModels: [{ id: 'a', fullId: 'same-target', label: 'Shared' }, { id: 'b', fullId: 'same-target', label: 'Shared' }], activeModel: 'b', defaultModelId: 'a' })
  expect(screen.getAllByRole('option')).toHaveLength(1)
  const row = screen.getByTestId('model-picker-item-a')
  expect(row.getAttribute('aria-selected')).toBe('true')
  expect(row.textContent).toContain('Shared (default)')
})

it('selects Chroxy Sonnet 5.5 Default while keeping the upstream Default and Fable choices (#8603)', () => {
  const onSelect = vi.fn()
  renderModal({
    availableModels: [
      { id: 'sonnet-5-5', fullId: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'default', fullId: 'default', label: 'Fable 5.1' },
      { id: 'fable-5-1', fullId: 'claude-fable-5-1', label: 'Fable 5.1' },
    ],
    activeModel: null,
    defaultModelId: 'sonnet-5-5',
    onSelect,
  })
  expect(screen.getByTestId('model-picker-item-sonnet-5-5').textContent).toContain('Sonnet 5.5 (default)')
  fireEvent.click(screen.getByTestId('model-picker-item-sonnet-5-5'))
  expect(onSelect).toHaveBeenCalledWith('sonnet-5-5')
  expect(screen.getByTestId('model-picker-item-default')).toBeInTheDocument()
  expect(screen.getByTestId('model-picker-item-fable-5-1')).toBeInTheDocument()
})
