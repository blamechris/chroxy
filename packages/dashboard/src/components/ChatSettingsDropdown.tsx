/**
 * ChatSettingsDropdown — Model, Permission Mode, and Thinking Level selectors.
 *
 * Uses native <select> elements which render their dropdown menus via the OS
 * compositor, avoiding CSS overflow/z-index clipping issues in Tauri WKWebView.
 */
import { useCallback, useMemo } from 'react'
import type { ModelInfo } from '../store/types'

/**
 * Compose the hover tooltip for the active-model select (#3888).
 *
 * Mirrors the prose used by `lib/status-tooltips.modelTooltip()` (#3887) so
 * the header pill and footer chip stay in sync. Inlined here rather than
 * imported because the helper module is not yet on `main` — once #3887
 * lands, this can be refactored to call the shared helper.
 *
 * Picks the model entry by `fullId` first, then `id`, so users see the
 * canonical "claude-opus-4-7"-style identifier when available rather than
 * the dropdown's short `id` form.
 */
function buildActiveModelTooltip(
  availableModels: ModelInfo[],
  activeModel: string | null,
): string {
  const info = availableModels.find(
    m => m.id === activeModel || m.fullId === activeModel,
  )
  const display = info?.fullId || info?.id || activeModel
  if (!display) {
    return 'Active model. Click the model picker in the header to switch.'
  }
  const win = typeof info?.contextWindow === 'number' && info.contextWindow > 0
    ? ` Context window: ${info.contextWindow.toLocaleString()} tokens.`
    : ''
  return `Active model: ${display}.${win}`
}

export interface ChatSettingsDropdownProps {
  availableModels: ModelInfo[]
  activeModel: string | null
  defaultModelId: string | null
  onModelChange: (id: string) => void
  availablePermissionModes: { id: string; label: string }[]
  permissionMode: string | null
  onPermissionModeChange: (mode: string) => void
  // Hide the permission-mode picker when the active provider doesn't expose
  // a permission-mode switch (e.g. Codex). Default true keeps Claude behavior
  // unchanged. #3835.
  showPermissionMode?: boolean
  showThinkingLevel: boolean
  thinkingLevel: string | null
  onThinkingLevelChange: (level: string) => void
  // promptEvaluator was originally rendered here as a per-session
  // checkbox alongside the model + permission selects. Moved to the
  // SettingsPanel ("Active session" section) — the inline toggle was
  // crowding the header and the "Auto-evaluate" label kept wrapping.
  // Settings panel gives it room with a hint line.
}

export function ChatSettingsDropdown({
  availableModels,
  activeModel,
  defaultModelId,
  onModelChange,
  availablePermissionModes,
  permissionMode,
  onPermissionModeChange,
  showPermissionMode = true,
  showThinkingLevel,
  thinkingLevel,
  onThinkingLevelChange,
}: ChatSettingsDropdownProps) {
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

  // #3888: hover tooltip on the active-model pill so users can see the full
  // model id and its context window without expanding the dropdown.
  const modelTitle = useMemo(
    () => buildActiveModelTooltip(availableModels, activeModel),
    [availableModels, activeModel],
  )

  return (
    <>
      {/* Model */}
      {availableModels.length > 0 && (
        <select
          data-testid="chat-settings-trigger"
          data-kind="model"
          value={activeModel === defaultModelId ? '' : (activeModel || '')}
          onChange={handleModelChange}
          title={modelTitle}
          aria-label={modelTitle}
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
      )}

      {/* Permission Mode */}
      {showPermissionMode && availablePermissionModes.length > 0 && (
        <select
          data-kind="permission"
          value={permissionMode || ''}
          onChange={e => onPermissionModeChange(e.target.value)}
        >
          {availablePermissionModes.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      )}

      {/* Thinking Level */}
      {showThinkingLevel && (
        <select
          data-kind="thinking"
          value={thinkingLevel || 'default'}
          onChange={e => onThinkingLevelChange(e.target.value)}
        >
          <option value="default">Auto</option>
          <option value="high">High</option>
          <option value="max">Max</option>
        </select>
      )}
    </>
  )
}
