/**
 * ChatSettingsDropdown — consolidates Model, Permission Mode, and Thinking Level
 * into a single header dropdown (#2298).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ChatSettingsDropdown } from './ChatSettingsDropdown'

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

describe('ChatSettingsDropdown', () => {
  it('renders a trigger button', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    expect(screen.getByTestId('chat-settings-trigger')).toBeInTheDocument()
  })

  it('shows current model and permission mode in trigger label', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    const trigger = screen.getByTestId('chat-settings-trigger')
    expect(trigger.textContent).toContain('Sonnet')
    expect(trigger.textContent).toContain('Approve')
  })

  it('dropdown panel is hidden by default', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    expect(screen.queryByTestId('chat-settings-panel')).not.toBeInTheDocument()
  })

  it('opens panel on trigger click', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    expect(screen.getByTestId('chat-settings-panel')).toBeInTheDocument()
  })

  it('panel contains model select with all options', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    const modelSelect = screen.getByLabelText('Model')
    expect(modelSelect).toBeInTheDocument()
    expect(modelSelect.querySelectorAll('option').length).toBeGreaterThanOrEqual(3)
  })

  it('panel contains permission mode select', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    expect(screen.getByLabelText('Permission Mode')).toBeInTheDocument()
  })

  it('hides thinking level when showThinkingLevel is false', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    expect(screen.queryByLabelText('Thinking Level')).not.toBeInTheDocument()
  })

  it('shows thinking level when showThinkingLevel is true', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={true}
        thinkingLevel="default"
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    expect(screen.getByLabelText('Thinking Level')).toBeInTheDocument()
  })

  it('calls onModelChange when model is selected', () => {
    const onModelChange = vi.fn()
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={onModelChange}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'haiku' } })
    expect(onModelChange).toHaveBeenCalledWith('haiku')
  })

  it('calls onPermissionModeChange when mode is selected', () => {
    const onPermissionModeChange = vi.fn()
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={onPermissionModeChange}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    fireEvent.change(screen.getByLabelText('Permission Mode'), { target: { value: 'auto' } })
    expect(onPermissionModeChange).toHaveBeenCalledWith('auto')
  })

  it('closes panel on second trigger click', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    const trigger = screen.getByTestId('chat-settings-trigger')
    fireEvent.click(trigger)
    expect(screen.getByTestId('chat-settings-panel')).toBeInTheDocument()
    fireEvent.click(trigger)
    expect(screen.queryByTestId('chat-settings-panel')).not.toBeInTheDocument()
  })

  it('focuses first select when panel opens', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    expect(document.activeElement).toBe(screen.getByLabelText('Model'))
  })

  it('traps Tab within the panel', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    const panel = screen.getByTestId('chat-settings-panel')
    const permSelect = screen.getByLabelText('Permission Mode')

    // Focus the last focusable element, then Tab — should wrap to first
    permSelect.focus()
    fireEvent.keyDown(panel, { key: 'Tab', bubbles: true })
    expect(document.activeElement).toBe(screen.getByLabelText('Model'))
  })

  it('traps Shift+Tab within the panel', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    const panel = screen.getByTestId('chat-settings-panel')
    const modelSelect = screen.getByLabelText('Model')

    // Focus first element, then Shift+Tab — should wrap to last
    modelSelect.focus()
    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true, bubbles: true })
    expect(document.activeElement).toBe(screen.getByLabelText('Permission Mode'))
  })

  it('returns focus to trigger on Escape', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId={null}
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    expect(screen.getByTestId('chat-settings-panel')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('chat-settings-panel')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByTestId('chat-settings-trigger'))
  })

  it('shows Default option for model when defaultModelId is set', () => {
    render(
      <ChatSettingsDropdown
        availableModels={MODELS}
        activeModel="sonnet"
        defaultModelId="sonnet"
        onModelChange={vi.fn()}
        availablePermissionModes={PERMISSION_MODES}
        permissionMode="approve"
        onPermissionModeChange={vi.fn()}
        showThinkingLevel={false}
        thinkingLevel={null}
        onThinkingLevelChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('chat-settings-trigger'))
    const modelSelect = screen.getByLabelText('Model')
    const options = modelSelect.querySelectorAll('option')
    const defaultOption = Array.from(options).find(o => o.value === '')
    expect(defaultOption).toBeDefined()
    expect(defaultOption!.textContent).toContain('Default')
  })
})
