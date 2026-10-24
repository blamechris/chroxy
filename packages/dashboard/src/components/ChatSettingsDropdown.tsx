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
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { findModelEntry, modelDisplayTarget, formatActiveModelLabel } from '@chroxy/store-core'
import type { ModelInfo } from '../store/types'
import type { PermissionMode } from '@chroxy/store-core'
// #6901: single-source the sandbox label/description from protocol's
// CODEX_SANDBOX_MODE_META so the read-only badge below never re-declares the
// copy (same list the create-time selector uses).
import {
  CODEX_SANDBOX_MODE_META,
  type CodexSandboxMode,
  thinkingLevelOptions,
  formatThinkingLevelLabel,
  LEGACY_DEFAULT_THINKING_LEVEL,
  isThinkingLevelMismatch,
  type ThinkingLevelOption,
} from '@chroxy/protocol'
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
  const info = findModelEntry(availableModels, activeModel)
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
  modelTooltipTarget?: string | null
  defaultModelId: string | null
  onModelChange: (id: string) => void
  // #4464: render a non-interactive pill instead of the model <select>
  // when the active provider doesn't expose a mid-session model switch
  // (today: claude TUI — see claude-tui-session.js capability.modelSwitch=false).
  // Passing a string here causes the badge to render in the picker's slot
  // showing the caller's formatted label (or "Provider default" when empty).
  // The actual target remains in activeModel for its tooltip. Null hides model UI —
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
  // #8619: the server's `allowAutoPermissionMode` opt-in, from
  // auth_ok.capabilities.autoPermissionMode. `false` disables the Auto option
  // and says why in its label (a switch would be refused with
  // AUTO_MODE_DISABLED_BY_CONFIG); `undefined` (older daemon) leaves the
  // option exactly as the roster describes it.
  autoPermissionModeAllowed?: boolean
  // #6901: the active/resolved Codex sandbox mode for a running codex session
  // (from session_list — only codex sessions carry it). When set, a READ-ONLY
  // badge renders showing the current sandbox. Codex applies the sandbox once at
  // thread start, so this is display-only — changing it needs a new session.
  // `null`/`undefined` (every non-codex session) renders nothing.
  codexSandbox?: CodexSandboxMode | null
  showThinkingLevel: boolean
  thinkingLevel: string | null
  // #7730: the levels THIS session's model offers, in the provider's own order
  // — from the active model's catalog row (`reasoningLevels` /
  // `defaultReasoningLevel`), which for codex is the binary's own
  // `supportedReasoningEfforts`. The three literal <option>s that used to live
  // below were a copy of the Claude vocabulary, so a codex session could only
  // be offered levels codex does not have. Omitted → the Claude triple, which
  // is what `thinkingLevelOptions(null)` resolves to, so a row with no
  // reasoning levels (every Claude provider today) renders exactly as before.
  //
  // #7784: that empty-list fallback is the CLAUDE roster, so an EMPTY array
  // here would put the Claude triple on a provider whose gate refuses all
  // three. `App` therefore never renders this control with an empty list —
  // `showThinkingLevel` requires `activeModelThinkingLevels.length > 0` — and a
  // new call site must do the same rather than relying on the fallback below.
  thinkingLevels?: ThinkingLevelOption[]
  onThinkingLevelChange: (level: string) => void
  // #8700: the active provider's `thinkingLevelEffective` capability — it
  // REPORTS the level it actually applied (claude-sdk family). Only then does
  // the picker get a read-only "Effective: <level>" readout beside it: the
  // picker says what was asked for, the readout says what Claude Code did with
  // it, because an adaptive model can run at an effort the picker never named.
  // Anything but `true` (older daemon, a provider with no such report) renders
  // no readout — "unknown" is only honest where the provider could have known.
  thinkingLevelEffective?: boolean
  // #8700: the level the provider last reported applying, from the session's
  // `effectiveThinkingLevel`. `null` / `undefined` read as "unknown": not
  // reported yet (before the first turn starts, right after a model change, or
  // the CLI could not answer).
  effectiveThinkingLevel?: string | null
  // promptEvaluator was originally rendered here as a per-session
  // checkbox alongside the model + permission selects. Moved to the
  // SettingsPanel ("Active session" section) — the inline toggle was
  // crowding the header and the "Auto-evaluate" label kept wrapping.
  // Settings panel gives it room with a hint line.
}

export function ChatSettingsDropdown({
  availableModels,
  activeModel,
  modelTooltipTarget,
  defaultModelId,
  onModelChange,
  availablePermissionModes,
  permissionMode,
  onPermissionModeChange,
  showPermissionMode = true,
  autoPermissionModeAllowed,
  codexSandbox = null,
  showThinkingLevel,
  thinkingLevel,
  thinkingLevels,
  onThinkingLevelChange,
  thinkingLevelEffective = false,
  effectiveThinkingLevel,
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

  // #7730: the thinking-level <option> list, and which one is selected.
  //
  // Two things this has to get right, both learned from the model <select> two
  // blocks down (#5628): a native <select> whose `value` matches no <option>
  // silently renders the FIRST one, so a session running codex's `xhigh` would
  // have shown "Low" — a control lying about the state it is in. If the current
  // level is not in the offered list (a stale value mid-model-switch, or a
  // Claude `default` on a codex row), it is APPENDED rather than dropped, so
  // the control keeps naming what the session is actually at.
  //
  // The appended option is labelled through `formatThinkingLevelLabel`, the same
  // formatter `thinkingLevelOptions` uses, rather than by echoing the raw id.
  // This is the COMMON codex path, not an edge: a fresh codex session has
  // `get thinkingLevel === null`, so ws-history replays `level: thinkingLevel ||
  // 'default'` and the append branch runs with `default` — which would otherwise
  // render lowercase and raw here while the identical id renders as 'Auto' on
  // every Claude session.
  const thinkingLevelChoices = useMemo(() => {
    const options = thinkingLevels && thinkingLevels.length > 0 ? thinkingLevels : thinkingLevelOptions(null)
    const current = thinkingLevel && thinkingLevel.length > 0 ? thinkingLevel : options[0]!.id
    return options.some(o => o.id === current)
      ? { options, selected: current }
      : { options: [...options, { id: current, label: formatThinkingLevelLabel(current) }], selected: current }
  }, [thinkingLevels, thinkingLevel])

  // #3888: hover tooltip on the active-model pill so users can see the full
  // model id and its context window without expanding the dropdown.
  const modelTitle = useMemo(
    () => buildActiveModelTooltip(availableModels, modelTooltipTarget ?? modelDisplayTarget(availableModels, activeModel, defaultModelId, providerLabel)),
    [availableModels, modelTooltipTarget, activeModel, defaultModelId, providerLabel],
  )

  const activeLabel = formatActiveModelLabel(availableModels, activeModel, defaultModelId, providerLabel)

  // #8619 + #8618: the permission <option>s as rendered — label, title and
  // disabled state — computed once, so the roster sizers (SelectFit) measure
  // exactly the labels the control can DISPLAY: every selectable option, plus
  // the selected one even when it is disabled (App.tsx keeps `plan` while it is
  // unavailable). A disabled label the value can never show — "Auto (disabled
  // on this server)", "Plan (unavailable)" — must not widen the control; the
  // sizers govern the cell precisely so the select's own intrinsic width,
  // which counts disabled options, cannot. The config gate is a separate reason
  // from adapter support: only an otherwise-supported Auto gets the "disabled
  // on this server" suffix, so the two never read the same.
  const permissionOptions = useMemo(() => availablePermissionModes.map(m => {
    const gated = m.id === 'auto' && m.supported !== false && autoPermissionModeAllowed === false
    return {
      id: m.id,
      label: gated ? `${m.label} (disabled on this server)` : m.label,
      title: gated
        ? 'Auto is disabled on this server: set allowAutoPermissionMode: true in the server config file on the dev machine, then restart the daemon.'
        : m.description,
      disabled: m.supported === false || gated,
    }
  }), [availablePermissionModes, autoPermissionModeAllowed])

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
            {activeLabel}
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
          {readOnlyModel || 'Provider default'}
        </span>
      )}

      {/* Permission Mode */}
      {showPermissionMode && availablePermissionModes.length > 0 && (
        <SelectFit kind="permission" labels={permissionOptions.filter(o => !o.disabled || o.id === permissionMode).map(o => o.label)}>
          <select
            data-kind="permission"
            aria-label="Permission mode"
            value={permissionMode || ''}
            onChange={e => onPermissionModeChange(e.target.value)}
            // #4019: server-side PERMISSION_MODES carries a `description` for
            // every mode (including the Auto protected-path exception).
            // Surface the description for the currently-selected option as a
            // title so the user gets the same trade-off explanation mid-session
            // they get at creation time. Each <option> also carries its own
            // title — most browsers don't show option tooltips reliably, but
            // it's harmless and feeds AT-friendly machinery for those that do.
            title={availablePermissionModes.find(m => m.id === permissionMode)?.description}
          >
            {permissionOptions.map(o => (
              <option key={o.id} value={o.id} title={o.title} disabled={o.disabled}>{o.label}</option>
            ))}
          </select>
        </SelectFit>
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
        <SelectFit kind="thinking" labels={thinkingLevelChoices.options.map(o => o.label)}>
          <select
            data-kind="thinking"
            aria-label="Thinking level"
            value={thinkingLevelChoices.selected}
            onChange={e => onThinkingLevelChange(e.target.value)}
          >
            {thinkingLevelChoices.options.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </SelectFit>
      )}

      {/* #8700: what the provider REPORTS it applied, beside what was asked for.
          Gated on the capability as well as the picker, so a provider that
          makes no such report never shows an "unknown" it could not resolve. */}
      {showThinkingLevel && thinkingLevelEffective === true && (
        <EffectiveThinkingLevel requested={thinkingLevel} effective={effectiveThinkingLevel} />
      )}
    </>
  )
}

/**
 * #8700: read-only readout of the thinking level the provider applied.
 *
 * Three states, none of them silent:
 *   - known and matching (or the operator left it on Auto) → "Effective: Medium"
 *   - not reported (`null` / `undefined`) → "Effective: unknown", with a title
 *     saying when the report arrives
 *   - known but different from an EXPLICIT request → the same text in the
 *     warning colour (`data-mismatch`), with a title naming both sides
 *
 * `default` (Auto) asks for no particular level, so any applied level satisfies
 * it and is not a mismatch. Colour alone is not the signal: the title and
 * aria-label carry the same words, and `data-mismatch` is the test hook.
 */
function EffectiveThinkingLevel({ requested, effective }: { requested: string | null; effective: string | null | undefined }) {
  const known = typeof effective === 'string' && effective.length > 0
  const asked = requested && requested.length > 0 ? requested : LEGACY_DEFAULT_THINKING_LEVEL
  const mismatch = isThinkingLevelMismatch(requested, effective)
  const text = known ? `Effective: ${formatThinkingLevelLabel(effective)}` : 'Effective: unknown'
  const title = !known
    ? 'Effective level unknown: Claude Code reports the applied effort once a turn starts.'
    : mismatch
      ? `Requested ${formatThinkingLevelLabel(asked)}; Claude Code applied ${formatThinkingLevelLabel(effective)}.`
      : `Claude Code applied ${formatThinkingLevelLabel(effective)}.`
  return (
    <span
      data-testid="effective-thinking-level"
      data-kind="thinking-effective"
      data-mismatch={mismatch ? 'true' : 'false'}
      className={`chat-settings-effective${mismatch ? ' chat-settings-effective--mismatch' : ''}`}
      title={title}
      aria-label={`${text}. ${title}`}
      role="status"
    >
      {text}
    </span>
  )
}

/**
 * #8618: size a native header <select> to the widest label it can show.
 *
 * A native <select> with `width: auto` does not grow to its label in WebKit
 * (#5197): it collapses to its `min-width` and cuts the text mid-glyph, which
 * is how `xhigh` rendered as "Xhi" on a codex session once five controls
 * squeezed the center column. Every earlier fix (#3705, #3720, #5181, #5197,
 * #4464) tuned a fixed per-kind floor, and each floor was right only for the
 * roster that existed when it was written — #7730 made the thinking roster the
 * binary's own, and a hardcoded width beside a growing roster is the class
 * docs/false-safety-guards.md records.
 *
 * So the width comes from the roster instead: every label the control can
 * display is rendered once as an invisible sizer in the same grid cell as the
 * <select>, with the select's chrome (padding, border, room for the native
 * arrow), and the select — `width: 0; min-width: 100%`, so its own intrinsic
 * width contributes nothing — is stretched to the cell. The cell is as wide as
 * the widest of those labels actually renders in the select's font — no
 * character count, no per-kind constant — and the wrapper does not shrink,
 * because a select narrower than its label is the bug. The sizers are
 * `aria-hidden`, `visibility: hidden` and zero-height, so they are neither
 * read, clickable, nor a change to the row's height.
 *
 * The sizers govern, rather than the select's intrinsic width, for two
 * reasons. A native select's intrinsic width spans its widest option, disabled
 * ones included, and the default configuration (no `allowAutoPermissionMode`)
 * renders "Auto (disabled on this server)" and "Plan (unavailable)" — labels
 * the value never shows — which would hold the control near 220px and
 * non-shrinking. And it makes the mechanism provable in Chromium, the engine
 * `scripts/header-layout.test.mjs` runs: without the sizers the select
 * collapses and the test reports the clipped label, instead of the sizers
 * mattering only on WebKit (the Tauri shell, where #5197 observed a
 * `width: auto` select collapsing to its floor).
 */
function SelectFit({ kind, labels, children }: { kind: 'permission' | 'thinking'; labels: string[]; children: ReactNode }) {
  return (
    <span className="header-select-fit" data-kind={kind} data-testid={`header-select-fit-${kind}`}>
      {labels.map((label, i) => (
        <span key={`${i}:${label}`} className="header-select-fit-sizer" aria-hidden="true">{label}</span>
      ))}
      {children}
    </span>
  )
}
