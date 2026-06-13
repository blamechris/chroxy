/**
 * ChatSettingsDropdown — Model, Permission Mode, and Thinking Level selectors.
 *
 * Uses native <select> elements which render their dropdown menus via the OS
 * compositor, avoiding CSS overflow/z-index clipping issues in Tauri WKWebView.
 */
import { useCallback, useMemo } from 'react'
import type { ModelInfo } from '../store/types'
import type { PermissionMode } from '@chroxy/store-core'

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
  // #4464: render a non-interactive pill instead of the model <select>
  // when the active provider doesn't expose a mid-session model switch
  // (today: claude TUI — see claude-tui-session.js capability.modelSwitch=false).
  // Passing a string here causes the badge to render in the picker's slot
  // showing that id (or "Default" when empty). Null hides any model UI —
  // same as today's "availableModels=[]" behaviour for the transient
  // provider-switch case where we don't want a flash of a stale label.
  readOnlyModel?: string | null
  // #4019: PermissionMode carries an optional `description` field server-side
  // (PERMISSION_MODES exports it for every mode). Use the typed import from
  // store-core so the title-attribute hint stays in lockstep with the wire shape.
  availablePermissionModes: PermissionMode[]
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
  readOnlyModel = null,
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

  // #5628: the session's active model arrives as either a short id ('fable')
  // or a full id ('claude-fable-5'), but the <option> values are short ids
  // (m.id). A native <select> whose `value` matches no <option> silently
  // renders the FIRST option — so a full-id activeModel made the header show
  // "Default (Sonnet 4.6)" even while the status bar (which dual-matches on
  // id||fullId) showed the real model. Resolve the active model the same way
  // the status bar does, then drive the <select> off the resolved short id so
  // it matches its option. `activeEntry` is null for a model not in the list
  // (e.g. unknown/unbroadcast) — we then render a synthetic option carrying the
  // raw id so the picker degrades to the real id rather than misrendering as
  // "Default" (#5631 graceful-degradation).
  const activeEntry = useMemo(
    () => availableModels.find(m => m.id === activeModel || m.fullId === activeModel) ?? null,
    [availableModels, activeModel],
  )
  // The <option> value that represents the active model: its short id when
  // known, else the raw activeModel string (matched by the synthetic option).
  const activeOptionValue = activeEntry?.id ?? activeModel ?? ''
  // True only when the active model genuinely IS the server default — compared
  // on the normalized short id so a full-id activeModel still resolves.
  const activeIsDefault = defaultModelId != null && activeOptionValue === defaultModelId
  // Render a synthetic option ONLY when the active model is set, isn't the
  // default, and isn't already one of the listed options.
  const needsSyntheticOption =
    !activeIsDefault && !!activeModel && activeEntry === null

  return (
    <>
      {/* Model */}
      {availableModels.length > 0 && (
        <select
          data-testid="chat-settings-trigger"
          data-kind="model"
          value={activeIsDefault ? '' : activeOptionValue}
          onChange={handleModelChange}
          title={modelTitle}
          aria-label={modelTitle}
        >
          <option value="">
            Default ({(defaultModelId
              ? availableModels.find(m => m.id === defaultModelId)?.label
              : availableModels[0]?.label) ?? 'recommended'})
          </option>
          {needsSyntheticOption && (
            <option value={activeOptionValue}>{activeModel}</option>
          )}
          {availableModels
            .filter(m => m.id !== defaultModelId)
            .map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
        </select>
      )}

      {/* #4464: read-only badge for providers without modelSwitch (claude TUI).
          Renders ONLY when the picker is hidden (availableModels empty) AND a
          read-only label was explicitly passed — never on the transient
          "models not yet broadcast" window where readOnlyModel stays null. */}
      {availableModels.length === 0 && readOnlyModel !== null && (
        <span
          data-testid="active-model-badge"
          data-kind="model-readonly"
          className="chat-settings-readonly-badge"
          title={modelTitle}
          aria-label={modelTitle}
          role="status"
        >
          {readOnlyModel || 'Default'}
        </span>
      )}

      {/* Permission Mode */}
      {showPermissionMode && availablePermissionModes.length > 0 && (
        <select
          data-kind="permission"
          value={permissionMode || ''}
          onChange={e => onPermissionModeChange(e.target.value)}
          // #4019: server-side PERMISSION_MODES carries a `description` for
          // every mode (e.g. "Auto-approve every tool call without prompting").
          // Surface the description for the currently-selected option as a
          // title so the user gets the same trade-off explanation mid-session
          // they get at creation time. Each <option> also carries its own
          // title — most browsers don't show option tooltips reliably, but
          // it's harmless and feeds AT-friendly machinery for those that do.
          title={availablePermissionModes.find(m => m.id === permissionMode)?.description}
        >
          {availablePermissionModes.map(m => (
            <option key={m.id} value={m.id} title={m.description}>{m.label}</option>
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
