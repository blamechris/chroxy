/**
 * ChatSettingsDropdown — native <select> elements for Model, Permission Mode,
 * and Thinking Level.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ChatSettingsDropdown, type ChatSettingsDropdownProps } from './ChatSettingsDropdown'

afterEach(cleanup)

const MODELS = [
  { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4', contextWindow: 200000 },
  { id: 'haiku', label: 'Haiku', fullId: 'claude-haiku' },
  { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-7', contextWindow: 200000 },
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

  it('hides permission mode select when showPermissionMode is false (#3835)', () => {
    // Codex and other providers without permission-mode switching must not
    // surface the "Approve / Auto / Plan" selector — the concept doesn't
    // apply to them and the dropdown values would be misleading.
    renderDropdown({ showPermissionMode: false })
    const selects = screen.getAllByRole('combobox')
    // Only the model select remains.
    expect(selects).toHaveLength(1)
  })

  it('defaults to showing permission mode when showPermissionMode is omitted', () => {
    // Backwards-compat: existing Claude callers that never set the prop
    // continue to see the permission picker.
    renderDropdown()
    const selects = screen.getAllByRole('combobox')
    expect(selects).toHaveLength(2)
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

  // The promptEvaluator toggle was originally rendered inside
  // ChatSettingsDropdown alongside the model + permission selects. It moved
  // to SettingsPanel ("Active session" section) — see SettingsPanel.test.tsx
  // for the per-session toggle coverage. The dropdown should NOT render any
  // checkbox here even when the parent passes evaluator-related state via
  // unknown extra props.
  it('does not render any prompt-evaluator checkbox in the header', () => {
    renderDropdown()
    expect(screen.queryByTestId('prompt-evaluator-toggle')).toBeNull()
    expect(screen.queryByTestId('prompt-evaluator-checkbox')).toBeNull()
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

  // #3888 — header model-picker tooltip surfaces model + context-window
  describe('active-model tooltip (#3888)', () => {
    it('exposes model id and context-window via title attribute', () => {
      renderDropdown({ activeModel: 'opus' })
      const select = screen.getByTestId('chat-settings-trigger')
      const title = select.getAttribute('title') || ''
      expect(title).toContain('claude-opus-4-7')
      expect(title).toContain('200,000 tokens')
    })

    it('exposes the same prose via aria-label for screen readers', () => {
      renderDropdown({ activeModel: 'opus' })
      const select = screen.getByTestId('chat-settings-trigger')
      expect(select.getAttribute('aria-label')).toBe(select.getAttribute('title'))
    })

    it('omits the context-window sentence when contextWindow is missing', () => {
      // Haiku in the fixture has no contextWindow set, so the tooltip must
      // not invent one — degrade gracefully to "Active model: <id>." only.
      renderDropdown({ activeModel: 'haiku' })
      const select = screen.getByTestId('chat-settings-trigger')
      const title = select.getAttribute('title') || ''
      expect(title).toContain('claude-haiku')
      expect(title).not.toMatch(/context window/i)
    })

    it('falls back to a generic line when no model is active', () => {
      renderDropdown({ availableModels: [{ id: 'x', label: 'X', fullId: 'x' }], activeModel: null })
      const select = screen.getByTestId('chat-settings-trigger')
      const title = select.getAttribute('title') || ''
      expect(title.toLowerCase()).toContain('active model')
    })

    it('matches activeModel against fullId as well as id', () => {
      // Server can broadcast either the short id or the full id; both must
      // resolve to the same tooltip metadata so the pill is consistent.
      renderDropdown({ activeModel: 'claude-opus-4-7' })
      const select = screen.getByTestId('chat-settings-trigger')
      const title = select.getAttribute('title') || ''
      expect(title).toContain('claude-opus-4-7')
      expect(title).toContain('200,000 tokens')
    })
  })

  // #4019 / #4211 Copilot review: the description from
  // availablePermissionModes flows onto the permission <select>'s title
  // attribute so the user gets the mid-session trade-off hint on hover.
  // Server's PERMISSION_MODES carries description for every mode; we surface
  // the one for the currently-selected option.
  describe('#4019 permission-mode description tooltip', () => {
    const MODES_WITH_DESC = [
      { id: 'approve', label: 'Approve', description: 'Default. Each tool call gates on your approval.' },
      { id: 'auto', label: 'Auto (skip all prompts)', description: 'Auto-approve every tool call. Equivalent to claude --dangerously-skip-permissions.' },
      { id: 'plan', label: 'Plan', description: 'Plan mode — Claude plans before acting; each tool call still gates on approval.' },
    ]

    it('select title reflects the description of the currently-selected mode', () => {
      const { container } = renderDropdown({
        availablePermissionModes: MODES_WITH_DESC,
        permissionMode: 'auto',
      })
      const permSelect = container.querySelector('select[data-kind="permission"]')
      expect(permSelect).toBeTruthy()
      const title = permSelect!.getAttribute('title') || ''
      expect(title).toContain('Auto-approve every tool call')
      expect(title).toContain('claude --dangerously-skip-permissions')
    })

    it('select title updates when permissionMode prop changes', () => {
      const { container, rerender } = renderDropdown({
        availablePermissionModes: MODES_WITH_DESC,
        permissionMode: 'approve',
      })
      const sel = () => container.querySelector('select[data-kind="permission"]')
      expect(sel()!.getAttribute('title')).toContain('Default')
      rerender(<ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={MODES_WITH_DESC}
        permissionMode="plan"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />)
      expect(sel()!.getAttribute('title')).toMatch(/Plan mode/i)
    })

    it('falls back gracefully when the selected mode has no description (old server)', () => {
      const { container } = renderDropdown({
        // Mix of with-/without-description; pre-#4018 servers ship none.
        availablePermissionModes: [
          { id: 'approve', label: 'Approve' },
          { id: 'auto', label: 'Auto' },
        ],
        permissionMode: 'auto',
      })
      const permSelect = container.querySelector('select[data-kind="permission"]')
      // No description → title is undefined / empty, not the literal string "undefined".
      const title = permSelect!.getAttribute('title')
      expect(title === null || title === '' || title === undefined).toBe(true)
    })

    // #4212 ask 3 — per-<option> title parity. Most browsers don't surface
    // option tooltips reliably, but the attribute should still match its
    // mode's description verbatim so AT machinery (and future refactors of
    // the picker into a non-native control) see consistent metadata. A
    // future change that drops `title={m.description}` from the option map
    // would silently regress this — pin it.
    it('each <option> carries its mode description as title (and omits it when missing)', () => {
      const MIXED = [
        { id: 'approve', label: 'Approve', description: 'Default. Each tool call gates on your approval.' },
        { id: 'auto', label: 'Auto', description: 'Auto-approve every tool call.' },
        { id: 'legacy', label: 'Legacy' }, // pre-#4018 server: no description
      ]
      const { container } = renderDropdown({
        availablePermissionModes: MIXED,
        permissionMode: 'approve',
      })
      const permSelect = container.querySelector('select[data-kind="permission"]')
      expect(permSelect).toBeTruthy()
      const options = Array.from(permSelect!.querySelectorAll('option')) as HTMLOptionElement[]
      expect(options).toHaveLength(MIXED.length)

      const byValue = (v: string) => {
        const opt = options.find(o => o.value === v)
        expect(opt, `option[value="${v}"] missing`).toBeTruthy()
        return opt!
      }
      expect(byValue('approve').getAttribute('title')).toBe(
        'Default. Each tool call gates on your approval.',
      )
      expect(byValue('auto').getAttribute('title')).toBe('Auto-approve every tool call.')
      // No description → attribute is absent or empty, never the string "undefined".
      const legacyTitle = byValue('legacy').getAttribute('title')
      expect(legacyTitle === null || legacyTitle === '').toBe(true)
    })
  })
})
