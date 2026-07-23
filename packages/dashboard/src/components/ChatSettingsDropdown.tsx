/**
 * ChatSettingsDropdown — Model, Permission Mode, and Thinking Level controls.
 *
 * #6220: the Model control is a BUTTON that opens `ModelPickerModal` (the inline
 * <select> couldn't hold the full per-provider model set). Permission Mode and
 * Thinking Level remain native <select> elements, which render their menus via
 * the OS compositor — avoiding CSS overflow/z-index clipping in Tauri WKWebView.
 * The modal renders above everything via the shared `Modal` overlay, so it's
 * likewise clipping-immune.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ModelInfo } from '../store/types'
import type { PermissionMode } from '@chroxy/store-core'
// #6901: single-source the sandbox label/description from protocol's
// CODEX_SANDBOX_MODE_META so the read-only badge below never re-declares the
// copy (same list the create-time selector uses).
import { CODEX_SANDBOX_MODE_META, type CodexSandboxMode } from '@chroxy/protocol'
import { ModelPickerModal } from './ModelPickerModal'

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
  // #6220: active provider label, shown as the group header in the modal picker.
  providerLabel?: string | null
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
  // #6901: the active/resolved Codex sandbox mode for a running codex session
  // (from session_list — only codex sessions carry it). When set, a READ-ONLY
  // badge renders showing the current sandbox. Codex applies the sandbox once at
  // thread start, so this is display-only — changing it needs a new session.
  // `null`/`undefined` (every non-codex session) renders nothing.
  codexSandbox?: CodexSandboxMode | null
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
  codexSandbox = null,
  showThinkingLevel,
  thinkingLevel,
  onThinkingLevelChange,
  readOnlyModel = null,
  providerLabel = null,
}: ChatSettingsDropdownProps) {
  // #6220: the model picker is now a button that opens a modal (was a native
  // <select>). The select couldn't comfortably hold the full per-provider model
  // set; the modal gives room for grouping, the default marker, and search.
  const [pickerOpen, setPickerOpen] = useState(false)
  // #6237 review: close the picker if the model list empties (a known transient
  // during a provider switch — see readOnlyModel prop docs). The button/modal
  // subtree is gated on `availableModels.length > 0`, so without this the modal
  // unmounts while `pickerOpen` stays true and would silently reopen when models
  // repopulate.
  useEffect(() => {
    if (availableModels.length === 0) setPickerOpen(false)
  }, [availableModels.length])

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
  // Label shown in the trigger button (and for the "Default (…)" form): the
  // default model's label, falling back to the first model, then 'recommended'.
  const defaultLabel =
    (defaultModelId
      ? availableModels.find((m) => m.id === defaultModelId)?.label
      : availableModels[0]?.label) ?? 'recommended'

  return (
    <>
      {/* Model — #6220: a button that opens the modal picker. Reads
          "Default (<label>)" when the active model is the server default, else
          the active model's label. */}
      {availableModels.length > 0 && (
        <>
          <button
            type="button"
            data-testid="chat-settings-trigger"
            data-kind="model"
            className="chat-settings-model-btn"
            onClick={() => setPickerOpen(true)}
            title={modelTitle}
            aria-label={modelTitle}
            aria-haspopup="dialog"
          >
            {activeIsDefault ? `Default (${defaultLabel})` : (activeEntry?.label ?? activeModel ?? `Default (${defaultLabel})`)}
          </button>
          <ModelPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            availableModels={availableModels}
            activeModel={activeModel}
            defaultModelId={defaultModelId}
            providerLabel={providerLabel}
            onSelect={onModelChange}
          />
        </>
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
          aria-label="Permission mode"
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

      {/* #6901: read-only Codex sandbox badge. Codex applies the sandbox once at
          thread start, so it can't be switched mid-session — a change needs a new
          session (docs/design/codex-permission-model.md §5). Present only for
          codex sessions (session_list carries `codexSandbox` for no other
          provider). Label/description single-sourced from CODEX_SANDBOX_MODE_META. */}
      {codexSandbox && (() => {
        const meta = CODEX_SANDBOX_MODE_META.find(m => m.id === codexSandbox)
        const title = `Codex sandbox: ${meta?.label ?? codexSandbox}. ${meta?.description ?? ''} Changing the sandbox requires a new session — Codex applies it at thread start.`
        return (
          <span
            data-testid="codex-sandbox-badge"
            data-kind="codex-sandbox"
            className="chat-settings-readonly-badge"
            title={title.trim()}
            aria-label={title.trim()}
            role="status"
          >
            {`Sandbox: ${meta?.label ?? codexSandbox}`}
          </span>
        )
      })()}

      {/* Thinking Level */}
      {showThinkingLevel && (
        <select
          data-kind="thinking"
          aria-label="Thinking level"
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
