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
})
