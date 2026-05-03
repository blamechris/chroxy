/**
 * ChatSettingsDropdown — native <select> elements for Model, Permission Mode,
 * and Thinking Level.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ChatSettingsDropdown, type ChatSettingsDropdownProps } from './ChatSettingsDropdown'

afterEach(cleanup)

const MODELS = [
  { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4' },
  { id: 'haiku', label: 'Haiku', fullId: 'claude-haiku' },
  { id: 'opus', label: 'Opus', fullId: 'claude-opus-4' },
]

const PERMISSION_MODES = [
  { id: 'approve', label: 'Approve' },
  { id: 'auto-edit', label: 'Accept Edits' },
  { id: 'auto', label: 'Auto Approve' },
  { id: 'plan', label: 'Plan' },
]

/** Render ChatSettingsDropdown with sensible defaults; override any prop. */
function renderDropdown(overrides: Partial<ChatSettingsDropdownProps> = {}) {
  const props: ChatSettingsDropdownProps = {
    availableModels: MODELS,
    activeModel: 'sonnet',
    defaultModelId: null,
    onModelChange: vi.fn(),
    availablePermissionModes: PERMISSION_MODES,
    permissionMode: 'approve',
    onPermissionModeChange: vi.fn(),
    showThinkingLevel: false,
    thinkingLevel: null,
    onThinkingLevelChange: vi.fn(),
    ...overrides,
  }
  return render(<ChatSettingsDropdown {...props} />)
}

describe('ChatSettingsDropdown', () => {
  it('renders the model select', () => {
    renderDropdown()
    expect(screen.getByTestId('chat-settings-trigger')).toBeInTheDocument()
  })

  it('model select shows current model value', () => {
    renderDropdown()
    const modelSelect = screen.getByTestId('chat-settings-trigger') as HTMLSelectElement
    expect(modelSelect.value).toBe('sonnet')
  })

  it('model select contains all model options', () => {
    renderDropdown()
    const modelSelect = screen.getByTestId('chat-settings-trigger')
    expect(modelSelect.querySelectorAll('option').length).toBeGreaterThanOrEqual(3)
  })

  it('renders permission mode select', () => {
    renderDropdown()
    const selects = screen.getAllByRole('combobox')
    // Model + Permission Mode = at least 2 selects
    expect(selects.length).toBeGreaterThanOrEqual(2)
  })

  it('hides thinking level when showThinkingLevel is false', () => {
    renderDropdown({ showThinkingLevel: false })
    const selects = screen.getAllByRole('combobox')
    // Model + Permission = 2, no thinking
    expect(selects).toHaveLength(2)
  })

  it('shows thinking level when showThinkingLevel is true', () => {
    renderDropdown({ showThinkingLevel: true, thinkingLevel: 'default' })
    const selects = screen.getAllByRole('combobox')
    // Model + Permission + Thinking = 3
    expect(selects).toHaveLength(3)
  })

  it('calls onModelChange when model is selected', () => {
    const onModelChange = vi.fn()
    renderDropdown({ onModelChange })
    fireEvent.change(screen.getByTestId('chat-settings-trigger'), { target: { value: 'haiku' } })
    expect(onModelChange).toHaveBeenCalledWith('haiku')
  })

  it('calls onPermissionModeChange when mode is selected', () => {
    const onPermissionModeChange = vi.fn()
    renderDropdown({ onPermissionModeChange })
    const selects = screen.getAllByRole('combobox')
    // Second select is permission mode
    fireEvent.change(selects[1]!, { target: { value: 'auto' } })
    expect(onPermissionModeChange).toHaveBeenCalledWith('auto')
  })

  it('calls onThinkingLevelChange when level is selected', () => {
    const onThinkingLevelChange = vi.fn()
    renderDropdown({ showThinkingLevel: true, thinkingLevel: 'default', onThinkingLevelChange })
    const selects = screen.getAllByRole('combobox')
    // Third select is thinking level
    fireEvent.change(selects[2]!, { target: { value: 'high' } })
    expect(onThinkingLevelChange).toHaveBeenCalledWith('high')
  })

  // #3185: per-session promptEvaluator toggle. The toggle is opt-in —
  // parent must wire `onPromptEvaluatorChange` for it to render. When
  // present, the checkbox reflects the current value and emits the new
  // value on click.
  describe('promptEvaluator toggle (#3185)', () => {
    it('does not render the toggle when onPromptEvaluatorChange is omitted', () => {
      renderDropdown()
      expect(screen.queryByTestId('prompt-evaluator-toggle')).toBeNull()
    })

    // Capability gate: even with the change handler wired, the toggle
    // stays hidden until the active session reports a boolean
    // `promptEvaluator` field. Older servers (pre-#3185) omit the field
    // entirely — surfacing a non-functional control would be misleading.
    it('does not render when promptEvaluator is undefined (older server)', () => {
      renderDropdown({ promptEvaluator: undefined, onPromptEvaluatorChange: vi.fn() })
      expect(screen.queryByTestId('prompt-evaluator-toggle')).toBeNull()
    })

    it('renders the toggle when handler + boolean value are both present', () => {
      renderDropdown({ promptEvaluator: false, onPromptEvaluatorChange: vi.fn() })
      expect(screen.getByTestId('prompt-evaluator-toggle')).toBeInTheDocument()
    })

    it('reflects promptEvaluator=true as a checked checkbox', () => {
      renderDropdown({ promptEvaluator: true, onPromptEvaluatorChange: vi.fn() })
      const cb = screen.getByTestId('prompt-evaluator-checkbox') as HTMLInputElement
      expect(cb.checked).toBe(true)
    })

    it('reflects promptEvaluator=false as an unchecked checkbox', () => {
      renderDropdown({ promptEvaluator: false, onPromptEvaluatorChange: vi.fn() })
      const cb = screen.getByTestId('prompt-evaluator-checkbox') as HTMLInputElement
      expect(cb.checked).toBe(false)
    })

    it('emits the new boolean value on click', () => {
      const onChange = vi.fn()
      renderDropdown({ promptEvaluator: false, onPromptEvaluatorChange: onChange })
      fireEvent.click(screen.getByTestId('prompt-evaluator-checkbox'))
      expect(onChange).toHaveBeenCalledWith(true)
    })

    it('emits false when toggling off', () => {
      const onChange = vi.fn()
      renderDropdown({ promptEvaluator: true, onPromptEvaluatorChange: onChange })
      fireEvent.click(screen.getByTestId('prompt-evaluator-checkbox'))
      expect(onChange).toHaveBeenCalledWith(false)
    })
  })

  it('shows Default option for model when defaultModelId is set', () => {
    renderDropdown({ defaultModelId: 'sonnet' })
    const modelSelect = screen.getByTestId('chat-settings-trigger')
    const options = modelSelect.querySelectorAll('option')
    const defaultOption = Array.from(options).find(o => o.value === '')
    expect(defaultOption).toBeDefined()
    expect(defaultOption!.textContent).toContain('Default')
  })

  it('selects empty value when activeModel matches defaultModelId', () => {
    renderDropdown({ defaultModelId: 'sonnet', activeModel: 'sonnet' })
    const modelSelect = screen.getByTestId('chat-settings-trigger') as HTMLSelectElement
    expect(modelSelect.value).toBe('')
  })

  it('filters default model from non-default options', () => {
    renderDropdown({ defaultModelId: 'sonnet' })
    const modelSelect = screen.getByTestId('chat-settings-trigger')
    const options = Array.from(modelSelect.querySelectorAll('option'))
    const nonDefaultOptions = options.filter(o => o.value !== '')
    expect(nonDefaultOptions.every(o => o.value !== 'sonnet')).toBe(true)
  })

  it('calls onModelChange with defaultModelId when Default option is selected', () => {
    const onModelChange = vi.fn()
    renderDropdown({ defaultModelId: 'sonnet', activeModel: 'haiku', onModelChange })
    fireEvent.change(screen.getByTestId('chat-settings-trigger'), { target: { value: '' } })
    expect(onModelChange).toHaveBeenCalledWith('sonnet')
  })
})
