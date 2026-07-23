/**
 * ChatSettingsDropdown — model trigger button (opens the modal picker, #6220) +
 * native <select> elements for Permission Mode and Thinking Level.
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
  // #6220 — the model picker is now a button that opens a modal (was a native
  // <select>). Only permission + thinking remain native <select> comboboxes.
  describe('model trigger button (#6220)', () => {
    it('renders the model trigger as a button (not a native select)', () => {
      renderDropdown()
      const trigger = screen.getByTestId('chat-settings-trigger')
      expect(trigger).toBeInTheDocument()
      expect(trigger.tagName.toLowerCase()).toBe('button')
    })

    it('shows the active model label', () => {
      renderDropdown({ activeModel: 'sonnet' })
      expect(screen.getByTestId('chat-settings-trigger').textContent).toContain('Sonnet')
    })

    it('shows "Default (<label>)" when the active model is the server default', () => {
      renderDropdown({ defaultModelId: 'sonnet', activeModel: 'sonnet' })
      expect(screen.getByTestId('chat-settings-trigger').textContent).toMatch(/Default \(Sonnet\)/)
    })

    it('resolves a full-id activeModel to its label, not "Default" (#5628)', () => {
      renderDropdown({ defaultModelId: 'sonnet', activeModel: 'claude-opus-4-7' })
      const t = screen.getByTestId('chat-settings-trigger').textContent || ''
      expect(t).toContain('Opus')
      expect(t).not.toMatch(/^Default/)
    })

    it('carries the data-kind="model" sizing hook + the model tooltip (#5181/#3888)', () => {
      renderDropdown({ activeModel: 'opus' })
      const trigger = screen.getByTestId('chat-settings-trigger')
      expect(trigger.getAttribute('data-kind')).toBe('model')
      expect(trigger.getAttribute('title')).toContain('claude-opus-4-7')
      expect(trigger.getAttribute('aria-label')).toBe(trigger.getAttribute('title'))
    })

    it('opens the modal picker on click and lists every model', () => {
      renderDropdown()
      expect(screen.queryByTestId('model-picker')).toBeNull()
      fireEvent.click(screen.getByTestId('chat-settings-trigger'))
      expect(screen.getByTestId('model-picker')).toBeInTheDocument()
      expect(screen.getByTestId('model-picker-item-sonnet')).toBeInTheDocument()
      expect(screen.getByTestId('model-picker-item-haiku')).toBeInTheDocument()
      expect(screen.getByTestId('model-picker-item-opus')).toBeInTheDocument()
    })

    it('calls onModelChange when a model is picked from the modal', () => {
      const onModelChange = vi.fn()
      renderDropdown({ onModelChange })
      fireEvent.click(screen.getByTestId('chat-settings-trigger'))
      fireEvent.click(screen.getByTestId('model-picker-item-haiku'))
      expect(onModelChange).toHaveBeenCalledWith('haiku')
    })
  })

  it('renders a permission-mode select alongside the model button', () => {
    renderDropdown()
    // Model is a button now; permission is the only combobox by default.
    expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(1)
  })

  it('hides thinking level when showThinkingLevel is false (permission only)', () => {
    renderDropdown({ showThinkingLevel: false })
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
  })

  it('shows thinking level when showThinkingLevel is true', () => {
    renderDropdown({ showThinkingLevel: true, thinkingLevel: 'default' })
    // Permission + Thinking = 2 comboboxes (model is a button).
    expect(screen.getAllByRole('combobox')).toHaveLength(2)
  })

  it('hides permission mode select when showPermissionMode is false (#3835)', () => {
    renderDropdown({ showPermissionMode: false })
    // Model is a button (not a combobox); with permission + thinking hidden none remain.
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.getByTestId('chat-settings-trigger')).toBeInTheDocument()
  })

  it('defaults to showing permission mode when showPermissionMode is omitted', () => {
    renderDropdown()
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
  })

  it('calls onPermissionModeChange when mode is selected', () => {
    const onPermissionModeChange = vi.fn()
    renderDropdown({ onPermissionModeChange })
    // Permission is the first (only) combobox now that the model is a button.
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'auto' } })
    expect(onPermissionModeChange).toHaveBeenCalledWith('auto')
  })

  it('calls onThinkingLevelChange when level is selected', () => {
    const onThinkingLevelChange = vi.fn()
    renderDropdown({ showThinkingLevel: true, thinkingLevel: 'default', onThinkingLevelChange })
    // Order: permission (0), thinking (1).
    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'high' } })
    expect(onThinkingLevelChange).toHaveBeenCalledWith('high')
  })

  it('does not render any prompt-evaluator checkbox in the header', () => {
    renderDropdown()
    expect(screen.queryByTestId('prompt-evaluator-toggle')).toBeNull()
    expect(screen.queryByTestId('prompt-evaluator-checkbox')).toBeNull()
  })

  // #3888 — the trigger button surfaces model + context-window via title/aria so
  // a visually-truncated label is never lost to AT users. (The picker's option
  // list + default/active marking are covered in ModelPickerModal.test.tsx.)
  describe('active-model tooltip (#3888)', () => {
    it('exposes model id and context-window via title attribute', () => {
      renderDropdown({ activeModel: 'opus' })
      const trigger = screen.getByTestId('chat-settings-trigger')
      const title = trigger.getAttribute('title') || ''
      expect(title).toContain('claude-opus-4-7')
      expect(title).toContain('200,000 tokens')
    })

    it('exposes the same prose via aria-label for screen readers', () => {
      renderDropdown({ activeModel: 'opus' })
      const trigger = screen.getByTestId('chat-settings-trigger')
      expect(trigger.getAttribute('aria-label')).toBe(trigger.getAttribute('title'))
    })

    it('omits the context-window sentence when contextWindow is missing', () => {
      renderDropdown({ activeModel: 'haiku' })
      const trigger = screen.getByTestId('chat-settings-trigger')
      const title = trigger.getAttribute('title') || ''
      expect(title).toContain('claude-haiku')
      expect(title).not.toMatch(/context window/i)
    })

    it('falls back to a generic line when no model is active', () => {
      renderDropdown({ availableModels: [{ id: 'x', label: 'X', fullId: 'x' }], activeModel: null })
      const trigger = screen.getByTestId('chat-settings-trigger')
      const title = trigger.getAttribute('title') || ''
      expect(title.toLowerCase()).toContain('active model')
    })

    it('matches activeModel against fullId as well as id', () => {
      renderDropdown({ activeModel: 'claude-opus-4-7' })
      const trigger = screen.getByTestId('chat-settings-trigger')
      const title = trigger.getAttribute('title') || ''
      expect(title).toContain('claude-opus-4-7')
      expect(title).toContain('200,000 tokens')
    })
  })

  // #4464 — TUI provider declares `modelSwitch: false`; the dashboard hides the
  // picker (availableModels=[]) and shows a non-interactive read-only badge.
  describe('read-only model badge (#4464)', () => {
    it('renders a non-interactive badge when availableModels is empty and readOnlyModel is set', () => {
      renderDropdown({ availableModels: [], readOnlyModel: 'opus' })
      expect(screen.queryByTestId('chat-settings-trigger')).toBeNull()
      const badge = screen.getByTestId('active-model-badge')
      expect(badge).toBeInTheDocument()
      expect(badge.tagName.toLowerCase()).not.toBe('select')
    })

    it('badge text surfaces the active model id', () => {
      renderDropdown({ availableModels: [], readOnlyModel: 'opus' })
      expect(screen.getByTestId('active-model-badge').textContent).toContain('opus')
    })

    it('badge falls back to "Default" when readOnlyModel is an empty string', () => {
      renderDropdown({ availableModels: [], readOnlyModel: '' })
      expect(screen.getByTestId('active-model-badge').textContent).toMatch(/default/i)
    })

    it('does NOT render the badge when the picker is shown (availableModels non-empty)', () => {
      renderDropdown({ availableModels: MODELS, activeModel: 'opus', readOnlyModel: 'opus' })
      expect(screen.queryByTestId('active-model-badge')).toBeNull()
      expect(screen.getByTestId('chat-settings-trigger')).toBeInTheDocument()
    })

    it('does NOT render the badge when readOnlyModel is null', () => {
      renderDropdown({ availableModels: [], readOnlyModel: null })
      expect(screen.queryByTestId('active-model-badge')).toBeNull()
    })

    it('badge surfaces buildActiveModelTooltip output via title and aria-label', () => {
      renderDropdown({ availableModels: [], activeModel: 'opus', readOnlyModel: 'opus' })
      const badge = screen.getByTestId('active-model-badge')
      expect(badge.getAttribute('title')).toMatch(/active model/i)
      expect(badge.getAttribute('title')).toContain('opus')
      expect(badge.getAttribute('aria-label')).toBe(badge.getAttribute('title'))
    })
  })

  // #4019 / #4211 — permission-mode description flows onto the permission
  // <select>'s title (and each <option>'s title).
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
        availablePermissionModes: [
          { id: 'approve', label: 'Approve' },
          { id: 'auto', label: 'Auto' },
        ],
        permissionMode: 'auto',
      })
      const permSelect = container.querySelector('select[data-kind="permission"]')
      const title = permSelect!.getAttribute('title')
      expect(title === null || title === '' || title === undefined).toBe(true)
    })

    it('each <option> carries its mode description as title (and omits it when missing)', () => {
      const MIXED = [
        { id: 'approve', label: 'Approve', description: 'Default. Each tool call gates on your approval.' },
        { id: 'auto', label: 'Auto', description: 'Auto-approve every tool call.' },
        { id: 'legacy', label: 'Legacy' },
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
      const legacyTitle = byValue('legacy').getAttribute('title')
      expect(legacyTitle === null || legacyTitle === '').toBe(true)
    })
  })

  // #6901 — read-only Codex sandbox badge. session_list carries `codexSandbox`
  // only for codex sessions; the badge is display-only (a change needs a new
  // session — Codex applies the sandbox at thread start).
  describe('#6901 codex sandbox read-only badge', () => {
    it('renders a read-only badge with the mode label when codexSandbox is set', () => {
      renderDropdown({ codexSandbox: 'read-only' })
      const badge = screen.getByTestId('codex-sandbox-badge')
      expect(badge).toBeInTheDocument()
      expect(badge.tagName.toLowerCase()).not.toBe('select')
      // Label single-sourced from CODEX_SANDBOX_MODE_META ('Read-only').
      expect(badge.textContent).toContain('Read-only')
    })

    it('surfaces the mid-session constraint in the badge tooltip', () => {
      renderDropdown({ codexSandbox: 'workspace-write' })
      const badge = screen.getByTestId('codex-sandbox-badge')
      const title = badge.getAttribute('title') || ''
      expect(title).toContain('Workspace write')
      expect(title).toMatch(/new session/i)
      expect(badge.getAttribute('aria-label')).toBe(title)
    })

    it('does NOT render the badge for a non-codex session (codexSandbox null)', () => {
      renderDropdown({ codexSandbox: null })
      expect(screen.queryByTestId('codex-sandbox-badge')).toBeNull()
    })

    it('does NOT render the badge when codexSandbox is omitted entirely', () => {
      renderDropdown()
      expect(screen.queryByTestId('codex-sandbox-badge')).toBeNull()
    })
  })
})
