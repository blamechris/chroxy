/**
 * ChatSettingsDropdown — single dropdown consolidating Model, Permission Mode,
 * and Thinking Level selectors (#2298).
 *
 * Replaces 3 separate <select> elements in header-center with a compact
 * trigger button + dropdown panel.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import type { ModelInfo } from '../store/types'

export interface ChatSettingsDropdownProps {
  availableModels: ModelInfo[]
  activeModel: string | null
  defaultModelId: string | null
  onModelChange: (id: string) => void
  availablePermissionModes: { id: string; label: string }[]
  permissionMode: string | null
  onPermissionModeChange: (mode: string) => void
  showThinkingLevel: boolean
  thinkingLevel: string | null
  onThinkingLevelChange: (level: string) => void
}

export function ChatSettingsDropdown({
  availableModels,
  activeModel,
  defaultModelId,
  onModelChange,
  availablePermissionModes,
  permissionMode,
  onPermissionModeChange,
  showThinkingLevel,
  thinkingLevel,
  onThinkingLevelChange,
}: ChatSettingsDropdownProps) {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const modelLabel = activeModel
    ? (availableModels.find(m => m.id === activeModel)?.label ?? activeModel)
    : 'Default'
  const modeLabel = permissionMode
    ? (availablePermissionModes.find(m => m.id === permissionMode)?.label ?? permissionMode)
    : availablePermissionModes[0]?.label ?? ''

  const handleModelChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value
    if (v) {
      onModelChange(v)
    } else if (defaultModelId) {
      const dm = availableModels.find(m => m.id === defaultModelId)
      if (dm) onModelChange(dm.id)
    } else if (availableModels[0]) {
      onModelChange(availableModels[0].id)
    }
  }, [onModelChange, defaultModelId, availableModels])

  return (
    <div className="chat-settings-dropdown">
      <button
        ref={triggerRef}
        className="chat-settings-trigger"
        data-testid="chat-settings-trigger"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
        type="button"
      >
        <span className="chat-settings-label">
          {modelLabel} · {modeLabel}
        </span>
        <span className="chat-settings-chevron">{open ? '\u25B2' : '\u25BC'}</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          className="chat-settings-panel"
          data-testid="chat-settings-panel"
          role="dialog"
          aria-label="Chat Settings"
        >
          {/* Model */}
          {availableModels.length > 0 && (
            <div className="chat-settings-row">
              <label htmlFor="cs-model">Model</label>
              <select
                id="cs-model"
                value={activeModel === defaultModelId ? '' : (activeModel || '')}
                onChange={handleModelChange}
              >
                <option value="">
                  Default ({(defaultModelId
                    ? availableModels.find(m => m.id === defaultModelId)?.label
                    : availableModels[0]?.label) ?? 'recommended'})
                </option>
                {availableModels
                  .filter(m => m.id !== defaultModelId)
                  .map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
              </select>
            </div>
          )}

          {/* Permission Mode */}
          {availablePermissionModes.length > 0 && (
            <div className="chat-settings-row">
              <label htmlFor="cs-permission">Permission Mode</label>
              <select
                id="cs-permission"
                value={permissionMode || ''}
                onChange={e => onPermissionModeChange(e.target.value)}
              >
                {availablePermissionModes.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Thinking Level */}
          {showThinkingLevel && (
            <div className="chat-settings-row">
              <label htmlFor="cs-thinking">Thinking Level</label>
              <select
                id="cs-thinking"
                value={thinkingLevel || 'default'}
                onChange={e => onThinkingLevelChange(e.target.value)}
              >
                <option value="default">Auto</option>
                <option value="high">High</option>
                <option value="max">Max</option>
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
