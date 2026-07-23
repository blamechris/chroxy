/**
 * App — root component wiring all dashboard components to the Zustand store.
 *
 * Auto-connects to the server on mount using the injected config + auth cookie.
 * Layout: header → session bar → view switcher → main content → input bar.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  deriveSessionVisualStatus,
  formatPasteMarker,
  formatTokensCompact,
  expandPasteMarkers,
  parseMemoryAppend,
  resolveContextWindow,
  contextOccupancyTokens,
  contextFillPercent,
  providerSupportsMultiQuestion,
  formatToolName,
  getToolPresentation,
  deriveChatActivity,
  type SessionInfo,
} from '@chroxy/store-core'
import { useConnectionStore } from './store/connection'
import type { BaseSessionState, ContextOccupancy } from '@chroxy/store-core'

import { Sidebar, type RepoNode, type ContextMenuTarget } from './components/Sidebar'
import { resolveActivePrimaryClientId } from './components/ViewersIndicator'
import { type ContextMenuItem } from './components/SessionContextMenu'
import { buildSidebarContextMenuItems } from './sidebarContextMenuItems'
import { useCommands, recordMruCommand, getMruCommands } from './store/commands'
import { ChatView, type ChatViewMessage } from './components/ChatView'
import { MultiTerminalView } from './components/MultiTerminalView'
import { InputBar, type FileAttachment, type ImageAttachment } from './components/InputBar'
import { useVoiceInput } from './hooks/useVoiceInput'
import { toWireAttachments } from './utils/attachment-utils'
import { toMessageAttachments } from './utils/attachment-preview'
import { derivePendingPermissionCounts, totalPendingPermissions, selectNextPendingSession } from './utils/pendingPermissions'
import { processImageFiles, filterImageFiles } from './utils/image-utils'
import { getAuthToken } from './utils/auth'
import { SessionBar, type SessionTabData, type SessionStatus } from './components/SessionBar'
import { formatTranscript } from './lib/transcript'
import { extractRowSearchText } from './lib/transcriptSearch'
import { ActivityIndicator, findInFlightToolUse } from './components/ActivityIndicator'
import { CheckInChip } from './components/CheckInChip'
import { EvaluatorClarifyPrompt } from './components/EvaluatorPrompts'
import { SessionNotFoundChip } from './components/SessionNotFoundChip'
import { PlanApproval } from './components/PlanApproval'
import { ReconnectBanner } from './components/ReconnectBanner'
import { ExposureWarningBanner } from './components/ExposureWarningBanner'
import { BillingWarningBanner } from './components/BillingWarningBanner'
import { ConnectionAnnouncer } from './components/ConnectionAnnouncer'
import { StdinDisabledBanner } from './components/StdinDisabledBanner'
import { WelcomeScreen } from './components/WelcomeScreen'
import { NotificationBanners } from './components/NotificationBanners'
import { PendingPairRequests } from './components/PendingPairRequests'
import { type ToastItem } from './components/Toast'
import { FileBrowserPanel } from './components/FileBrowserPanel'
import { CheckpointTimeline } from './components/CheckpointTimeline'
import { FooterBar } from './components/FooterBar'
import { type ShortcutEntry } from './components/ShortcutHelp'
import { formatShortcutKeys, isMacPlatform } from './utils/platform'
import { useShortcutRegistry } from './shortcuts/useShortcutRegistry'
import { buildShortcutEntries } from './shortcuts/buildShortcutEntries'
import { writeText as clipboardWriteText } from './utils/clipboard'
import { useTauriEvents } from './hooks/useTauriEvents'
import { useTrayBadgeSync } from './hooks/useTrayBadgeSync'
import { useChatKeyboard } from './hooks/useChatKeyboard'
import { useTauriMenuWiring } from './hooks/useTauriMenuWiring'
import { isTauri } from './utils/tauri'
import { startServer, revealInFinder } from './hooks/useTauriIPC'
import { usePermissionNotification, type PermissionPromptInfo } from './hooks/usePermissionNotification'
import { useInterventionPing } from './hooks/useInterventionPing'
import { useShortcutDispatch } from './hooks/useShortcutDispatch'
import { FileOpenPalette } from './components/FileOpenPalette'
import { SymbolSearchPalette } from './components/SymbolSearchPalette'
import { CodeSearchPalette } from './components/CodeSearchPalette'
import { ReferencesPalette } from './components/ReferencesPalette'
import { useChatMessages, toChatViewMessage } from './hooks/useChatMessages'
import { useTunnelReady } from './hooks/useTunnelReady'
import { useQrModal } from './hooks/useQrModal'
import { useSidebarOrdering } from './hooks/useSidebarOrdering'
import { useControlRoomState } from './hooks/useControlRoomState'
import { useMessageRenderer } from './hooks/useMessageRenderer'
import { SplitPane } from './components/SplitPane'
import { ViewSwitcher } from './components/ViewSwitcher'
import { DEFAULT_PROVIDER, USER_SHELL_PROVIDER } from '@chroxy/protocol'
import { persistSidebarWidth, loadPersistedSidebarWidth, persistSplitMode, persistShowConsoleTab, loadPersistedShowConsoleTab, persistInterventionPing, loadPersistedInterventionPing, persistCompactChatFilter, loadPersistedCompactChatFilter, loadPersistedSidebarPanelHeight, loadPersistedSidebarPanelView, loadPersistedSidebarPanelCollapsed } from './store/persistence'
import { applyOrderById } from './utils/reorderById'
import { DiffViewerPanel } from './components/DiffViewerPanel'
import { AgentMonitorPanel } from './components/AgentMonitorPanel'
import { SessionLoadingSkeleton } from './components/SessionLoadingSkeleton'
import { StartupErrorScreen } from './components/StartupErrorScreen'
import { ConsolePage } from './components/ConsolePage'
import { SnapshotsPanel } from './components/SnapshotsPanel'
import { PoolStatsPanel } from './components/PoolStatsPanel'
import { PagesPanel } from './components/PagesPanel'
import { type RepoInvestigateRequest, type RepoOpenSessionRequest } from './components/ControlRoomSection'
import { ControlRoomView } from './components/ControlRoomView'
import { AppModals } from './components/AppModals'
import { AppHeader } from './components/AppHeader'
import { SetupWizard } from './components/SetupWizard'

/** Server-injected config from <meta name="chroxy-config"> tag */
interface ChroxyConfig {
  port: number
  noEncrypt: boolean
}

declare const __APP_VERSION__: string

/** Read server-injected config from meta tag (CSP-safe, no inline scripts) */
export function getChroxyConfig(): ChroxyConfig | undefined {
  const meta = document.querySelector('meta[name="chroxy-config"]')
  if (!meta) return undefined
  try {
    return JSON.parse(meta.getAttribute('content') || '') as ChroxyConfig
  } catch {
    return undefined
  }
}


/**
 * Format the context chip label from the occupancy SNAPSHOT (#6769).
 *
 * The total is `ContextOccupancy.totalTokens` — the end-of-turn window
 * occupancy reported by the provider (SDK getContextUsage() / byok
 * final-round prompt). NEVER derived from the billing `contextUsage`
 * aggregate, which sums across agent-loop rounds and over-reads ≈N× on an
 * N-round turn. Undefined (chip hidden — the honest dash state) when the
 * provider has no occupancy signal.
 *
 * Delegates the number formatting to the canonical `formatTokensCompact`
 * helper in `@chroxy/store-core` (#5094) so the chip label, the header
 * meter, and the status-tooltip summary all share one casing/decimal
 * rule and one (correct) 1M rollover.
 */
function formatContext(occupancy: ContextOccupancy | null): string | undefined {
  const total = contextOccupancyTokens(occupancy)
  if (total == null || total === 0) return undefined
  return `${formatTokensCompact(total)} tokens`
}

export function App() {
  // #3852: customizable keyboard-shortcut registry. The same instance
  // drives both the keydown matcher below and the cheat-sheet display
  // — when a user rebinds Cmd+K in Settings, both surfaces update.
  const shortcutRegistry = useShortcutRegistry()
  // Store selectors — subscribe to specific slices to avoid re-renders
  const connectionPhase = useConnectionStore(s => s.connectionPhase)
  const serverVersion = useConnectionStore(s => s.serverVersion)
  const sessionCwd = useConnectionStore(s => s.sessionCwd)
  // #4029: FooterBar cwd was static — set once at auth_ok and never updated
  // on tab switch. Subscribe to the active session's cwd from the sessions
  // list so the footer tracks the selected tab. Falls back to sessionCwd
  // (the initial auth_ok value) when no sessions list has landed yet,
  // then to undefined.
  const activeSessionCwd = useConnectionStore(s =>
    s.sessions.find(sess => sess.sessionId === s.activeSessionId)?.cwd ?? null,
  )
  // #4603: active session's provider name (e.g. `'claude-sdk'`,
  // `'claude-cli'`) so the StreamStallChip can prefix its headline
  // with the provider short label for one-glance triage. Subscribed
  // here so a tab switch updates the chip's variant on the next render
  // without a full message-map rebuild.
  const activeSessionProvider = useConnectionStore(s =>
    s.sessions.find(sess => sess.sessionId === s.activeSessionId)?.provider ?? null,
  )
  // #5986 (epic #5982): the embedded user-shell terminal. The server advertises
  // `userShell` in auth_ok.capabilities only when config.userShell.enabled is on
  // AND the connecting client holds the primary token class, so gating the "New
  // shell" affordance on it means paired devices / disabled hosts never see a
  // dead button.
  const userShellSupported = useConnectionStore(s => s.serverCapabilities?.userShell === true)
  // #6473 — gate the Cmd+P quick-open palette on the opt-in `ide` capability.
  const ideEnabled = useConnectionStore(s => s.serverCapabilities?.ide === true)
  // #6006 — the operator panic button (Revoke token) is available only when the
  // server has a rotating TokenManager (auth on) AND this client holds the
  // primary token, both reflected in the `tokenRevoke` capability. Gating on it
  // keeps paired / --no-auth clients from seeing a button they can't use.
  const tokenRevokeSupported = useConnectionStore(s => s.serverCapabilities?.tokenRevoke === true)
  // Providers backed by a real PTY get the live Output terminal. claude-tui
  // mirrors its TUI PTY alongside the parsed Chat view; user-shell is
  // terminal-ONLY — a raw $SHELL with no Claude chat/tools/permissions
  // semantics, so its session renders the terminal and hides the Chat tab.
  const isTui = activeSessionProvider === DEFAULT_PROVIDER
  const isUserShell = activeSessionProvider === USER_SHELL_PROVIDER
  const isPtyProvider = isTui || isUserShell
  const defaultCwd = useConnectionStore(s => s.defaultCwd)
  const sessions = useConnectionStore(s => s.sessions)
  // #5665 — machine-wide monthly programmatic-credit meter (sidebar token view).
  const monthlyBudget = useConnectionStore(s => s.monthlyBudget)
  const sessionStates = useConnectionStore(s => s.sessionStates)
  const activeSessionId = useConnectionStore(s => s.activeSessionId)
  const viewMode = useConnectionStore(s => s.viewMode)
  // #5835 (PR2): live claude-tui PTY mirror — the Output tab is the authenticity
  // surface only for claude-tui (the only provider with a real PTY).
  const subscribeTerminalMirror = useConnectionStore(s => s.subscribeTerminalMirror)
  const unsubscribeTerminalMirror = useConnectionStore(s => s.unsubscribeTerminalMirror)
  const availableModels = useConnectionStore(s => s.availableModels)
  const availableModelsProvider = useConnectionStore(s => s.availableModelsProvider)
  // #5184: header cost-badge display mode (Settings-driven, persisted).
  const costBadgeMode = useConnectionStore(s => s.costBadgeMode)
  const defaultModelId = useConnectionStore(s => s.defaultModelId)
  const availablePermissionModes = useConnectionStore(s => s.availablePermissionModes)
  const availableProviders = useConnectionStore(s => s.availableProviders)
  const serverErrors = useConnectionStore(s => s.serverErrors)
  const infoNotifications = useConnectionStore(s => s.infoNotifications ?? [])
  const connectionError = useConnectionStore(s => s.connectionError)
  const serverPhase = useConnectionStore(s => s.serverPhase)
  const tunnelProgress = useConnectionStore(s => s.tunnelProgress)
  // #5356: exposure snapshot from auth_ok + per-connection dismissal flag.
  const serverExposure = useConnectionStore(s => s.serverExposure)
  const exposureBannerDismissed = useConnectionStore(s => s.exposureBannerDismissed)
  const dismissExposureBanner = useConnectionStore(s => s.dismissExposureBanner)
  // #5821: billing-canary banner state.
  const billingCanary = useConnectionStore(s => s.billingCanary)
  const billingBannerDismissed = useConnectionStore(s => s.billingBannerDismissed)
  const dismissBillingBanner = useConnectionStore(s => s.dismissBillingBanner)
  const serverStartupLogs = useConnectionStore(s => s.serverStartupLogs)
  const connectionRetryCount = useConnectionStore(s => s.connectionRetryCount)
  // #5556 — restart-countdown parity with mobile: feed the ETA/anchor/reason
  // through to ReconnectBanner so it can render a live ~M:SS countdown.
  const shutdownReason = useConnectionStore(s => s.shutdownReason)
  const restartEtaMs = useConnectionStore(s => s.restartEtaMs)
  const restartingSince = useConnectionStore(s => s.restartingSince)
  const filePickerFiles = useConnectionStore(s => s.filePickerFiles)
  const mcpResources = useConnectionStore(s => s.mcpResources)
  const sessionNotifications = useConnectionStore(s => s.sessionNotifications)
  // #5510 (epic #5509): pairing-approval primitive — host-surface pending queue.
  const pendingPairRequests = useConnectionStore(s => s.pendingPairRequests)
  const approvePairRequest = useConnectionStore(s => s.approvePairRequest)
  const denyPairRequest = useConnectionStore(s => s.denyPairRequest)
  const inputSettings = useConnectionStore(s => s.inputSettings)
  const connectedClients = useConnectionStore(s => s.connectedClients)
  // #5281 ①.3 — global primary (last-driver) fallback for the pre-session /
  // 'default' case; per-session primary is read from sessionStates below.
  const globalPrimaryClientId = useConnectionStore(s => s.primaryClientId)
  // #5589 / #5281 — this client's explicit role for the active session, derived
  // from the server's `session_role` broadcast. Drives the ViewersIndicator's
  // observer state + take-over affordance.
  const activeSessionRole = useConnectionStore(s => {
    const id = s.activeSessionId
    return id && s.sessionStates[id] ? s.sessionStates[id].sessionRole : null
  })
  const claimPrimary = useConnectionStore(s => s.claimPrimary)
  const pairingRefreshedCount = useConnectionStore(s => s.pairingRefreshedCount)
  // #4497: server-advertised stream-stall window — threaded into the
  // StreamStallChip render path so the headline humanises to e.g.
  // "No response for 5 minutes — retry?" instead of a static phrase.
  // Null for older servers (server PR #4483 / #4477); chip falls back
  // to the static copy in that case.
  const streamStallTimeoutMs = useConnectionStore(s => s.streamStallTimeoutMs)

  // Listen for Tauri desktop events (no-op in browser context)
  useTauriEvents()

  // Voice input mode is persisted on inputSettings (#4785). Default is
  // 'continuous' — click to start, click to stop, mic stays lit across
  // silence gaps. Pre-#4785 behaviour ('auto-pause' on silence) available
  // via the Voice input section of SettingsPanel.
  const voiceInputMode = useConnectionStore(s => s.inputSettings.voiceInputMode)
  const voiceInput = useVoiceInput({ mode: voiceInputMode })

  // Session-level state via useShallow — includes messages from sessionStates.
  // stream_end/result handlers force a new messages[] reference so useShallow
  // detects the change even when delta flush was already completed by the timer.
  const {
    messages: storeMessages,
    streamingMessageId,
    // #5939 (epic #5935 ④): per-session send-while-busy queue, surfaced as a
    // "Queued" badge on the matching optimistic bubble.
    queuedMessages,
    activeModel,
    permissionMode,
    contextUsage,
    // #6769: occupancy snapshot — the context meter's only input.
    contextOccupancy,
    sessionCost,
    isIdle,
    activeAgents,
    isPlanPending,
    thinkingLevel,
    skills: activeSkills,
    mismatchedSkillNames: activeMismatched,
    pendingCommunitySkills: activePendingCommunitySkills,
    pendingTrustGrants: activePendingTrustGrants,
    pendingEvaluatorClarify,
    // #4653: surface chroxy-side interventions (currently only the
    // multi-question AskUserQuestion deny shipped in #4648) in the
    // FooterBar counter chip so users can tell when chroxy intervened.
    interventions,
    // #6790: active dev-server preview tunnels for the header DevPreviewChip.
    devPreviews,
  } = useConnectionStore(useShallow(s => s.getActiveSessionState()))

  // #3205: stable Set for SkillsPanel mismatch indicator. useMemo
  // keyed by the array reference so the Set only re-derives when the
  // store actually mutated the list (skill_changed event fired).
  const mismatchedSet = useMemo(
    () => new Set(activeMismatched || []),
    [activeMismatched],
  )

  // #5939 (epic #5935 ④): the ids of currently-queued send-while-busy
  // follow-ups, as a stable Set so ChatView can render a "Queued" badge on the
  // matching optimistic bubble. Only entries carrying a clientMessageId can be
  // matched to a bubble (and cancelled); a server-confirmed entry with no local
  // id is rare (another device) and simply renders without a badge here.
  // (`onCancelQueued` is derived below, once the store action is bound.)
  const queuedIds = useMemo(
    () => new Set((queuedMessages || []).map(m => m.clientMessageId).filter((id): id is string => !!id)),
    [queuedMessages],
  )

  // #5953 (epic #5951): label for the in-chat "Claude is working" indicator.
  // Surfaces the current in-flight tool ("Running Bash…") using the same
  // detection the ActivityIndicator uses; falls back to undefined so the
  // indicator shows its generic default ("Claude is working…"). The walk is
  // O(1) in practice (the unresolved tool is at the tail) and the label string
  // is stable across response tokens (it only changes when the tool changes).
  const workingLabel = useMemo(() => {
    const inFlight = findInFlightToolUse(storeMessages)
    return inFlight ? `Running ${formatToolName(inFlight.tool, inFlight.serverName)}…` : undefined
  }, [storeMessages])

  // #6392 — color the presence rail by the in-flight tool's kind (Read=cyan,
  // Bash=purple, Edit=orange…) via the shared tool-presentation registry, rather
  // than the generic 'busy' purple. A `var(--token)` string when a tool is
  // mid-flight, undefined otherwise → the rail falls back to its activity-state
  // colour. Same findInFlightToolUse walk as workingLabel, so it's stable across
  // response tokens (only changes when the tool changes).
  const inFlightToolColor = useMemo(() => {
    const inFlight = findInFlightToolUse(storeMessages)
    if (!inFlight) return undefined
    return `var(--${getToolPresentation(inFlight.tool, inFlight.serverName).colorToken})`
  }, [storeMessages])

  // #4735 / #4731: the multi-question AskUserQuestion form is gated per
  // session type. TUI / CLI sessions (`claude-tui` / `claude-cli`) keep
  // the #4666 deferred notice because the permission-hook (#4648) denies
  // multi-question tool_uses there and answers would misroute through
  // `_pendingUserAnswer`. SDK / BYOK / Codex / Gemini sessions support
  // per-question delivery natively (#4731) via the in-process
  // `canUseTool` flow (`packages/server/src/sdk-session.js:30`), so the
  // dashboard renders the interactive `MultiQuestionForm` for them and
  // submits per-question answers (including multi-select arrays) on the
  // widened wire. Reuses the `activeSessionProvider` selector declared
  // above (#4603) so we don't re-derive the same value.
  // #5795 — provider capability lives in @chroxy/store-core (single source of
  // truth, keyed off the registered provider `type`), not a hand-rolled
  // name check duplicated across the app + dashboard.
  const allowMultiQuestionForm = useMemo(
    () => providerSupportsMultiQuestion(activeSessionProvider),
    [activeSessionProvider],
  )

  // #4685 — track resolved permissions from the store so the QuestionPrompt
  // gate can flip off the moment the user clicks Allow on a pending
  // AskUserQuestion permission_request. The store keeps a per-requestId
  // map keyed by decision (`allow` | `deny` | `allowSession`); combined
  // with the per-message `answered` flag this gives us the full
  // "is there an unresolved-or-denied AskUserQuestion permission?" view.
  //
  // #4685 Copilot review: ONLY `allow` / `allowSession` un-gate the
  // content. `deny` keeps the gate ON — issue #4685's expected behavior
  // says "and shows the redacted/denied state if user clicks Deny". A
  // permission denial means the user explicitly refused to see the
  // question; revealing the model-supplied text and options post-deny
  // defeats the whole point of the gate.
  const resolvedPermissions = useConnectionStore(s => s.resolvedPermissions)

  // #4685 — boolean: is there an unresolved-or-denied AskUserQuestion
  // permission prompt in the active session's chat? When true, the
  // QuestionPrompt for any `user_question`-derived `prompt` message MUST
  // gate its content behind a placeholder so the model-supplied question
  // text and options stay hidden. A permission prompt counts as
  // "unresolved-or-denied" when EITHER (a) it has not been answered on
  // this client (no `m.answered === 'allow' | 'allowSession'`) AND (b)
  // no other client has allowed it (`resolvedPermissions[requestId]`
  // not in {`allow`, `allowSession`}). `deny` on either signal keeps the
  // gate ON — Copilot review (#4685) caught the pre-fix bug where deny
  // un-gated the content, contradicting issue #4685's expected behavior.
  // Multiple pending AskUserQuestion permissions in the same session are
  // rare but any single un-allowed one is enough to gate every question
  // render in that session — the bug is content leak before consent, not
  // which specific question got which specific permission decision.
  const hasPendingAskUserQuestionPermission = useMemo(() => {
    for (const m of storeMessages) {
      if (m.type !== 'prompt') continue
      if (!m.requestId) continue
      if (m.tool !== 'AskUserQuestion') continue
      // Per-message `answered` is set by `handlePermissionResolved` on
      // BOTH allow and deny — gate only flips off for allow variants
      // (#6771: allowAlways is an allow variant too).
      if (m.answered === 'allow' || m.answered === 'allowSession' || m.answered === 'allowAlways') continue
      // Cross-client decision via `resolvedPermissions[requestId]` —
      // same allow-only rule.
      const decision = resolvedPermissions?.[m.requestId]
      if (decision === 'allow' || decision === 'allowSession' || decision === 'allowAlways') continue
      return true
    }
    return false
  }, [storeMessages, resolvedPermissions])

  // #3839: dropdown-gating flags derived from the active session's provider
  // capabilities. Hoisted out of the JSX so the lookups don't re-run on every
  // render of <App>, which fires on most WS messages.
  const dropdownFlags = useMemo(() => {
    const activeProvider = activeSessionProvider
    const providerInfo = availableProviders.find(p => p.name === activeProvider)
    const caps = providerInfo?.capabilities
    // The store carries one `availableModels` slot tagged with the provider
    // that pushed it. If the active session is a different provider (server
    // hasn't pushed the matching list yet), suppress the picker instead of
    // showing the wrong models.
    const modelsMatchProvider =
      availableModelsProvider == null ||
      activeProvider == null ||
      availableModelsProvider === activeProvider
    return {
      showModelPicker: caps?.modelSwitch !== false && modelsMatchProvider,
      // #4464: render a non-interactive badge in the picker's slot when the
      // active provider permanently lacks mid-session model switching (TUI).
      // null on transient "models not matching provider" (provider just
      // switched) so we don't flash a stale-label badge during reconnect.
      readOnlyModel: caps?.modelSwitch === false ? activeModel : null,
      showPermissionMode: caps?.permissionModeSwitch !== false,
      showThinkingLevel: !!caps?.thinkingLevel,
    }
  }, [activeSessionProvider, availableProviders, availableModelsProvider, activeModel])

  // Fire native notifications for permission requests when window is not focused
  const permissionPrompts = useMemo<PermissionPromptInfo[]>(() =>
    storeMessages
      .filter(m => m.requestId && m.expiresAt && m.type === 'prompt' && !m.answered)
      .map(m => ({
        id: m.id,
        requestId: m.requestId!,
        tool: m.tool || 'Unknown',
        description: m.content,
        expiresAt: m.expiresAt!,
        answered: m.answered,
      })),
    [storeMessages],
  )
  usePermissionNotification(permissionPrompts)
  // #4891 — audible intervention ping enable/mute. Defaults on; persisted
  // per-device in localStorage. Toggled via Settings → Dashboard.
  const [interventionPingEnabled, setInterventionPingEnabled] = useState(() => {
    return loadPersistedInterventionPing()
  })
  // #4891 — audible ping on incoming intervention (permission request /
  // question / blocked-on-input). Reuses the same derived prompt list as the
  // OS-notification hook so both surfaces fire on identical events. The hook
  // dedupes by requestId and throttles bursts; `enabled` honors the operator
  // mute toggle (Settings → Dashboard, persisted per-device).
  useInterventionPing(permissionPrompts, { enabled: interventionPingEnabled })

  // #3698 — derive the user-message history for the InputBar's terminal-
  // style Up/Down navigation. Oldest-first (matches the natural arrival
  // order of `messages`), and trims out empty bodies so a stray no-op
  // user_input never recalls a blank string.
  //
  // `storeMessages` re-references on every streaming delta flush (the
  // delta-batch path rebuilds the array even when no user_input was added),
  // so a naive `[storeMessages]` dep would rebuild `userMessageHistory` on
  // every assistant token and trip InputBar's array-identity reset, wiping
  // the user's in-flight Up/Down cycle. We memoise on a stable fingerprint
  // (count + last user_input id) so a fresh array is only produced when the
  // actual user-message slice changes (new send, session switch, history
  // replay on reconnect). Equal-content updates reuse the previous array
  // reference, keeping InputBar's cycling state stable.
  const userMessageHistoryFingerprint = useMemo(() => {
    let count = 0
    let lastId = ''
    for (const m of storeMessages) {
      if (m.type === 'user_input' && typeof m.content === 'string' && m.content.length > 0) {
        count++
        lastId = m.id
      }
    }
    return `${count}\x1f${lastId}`
  }, [storeMessages])
  const userMessageHistory = useMemo(
    () => storeMessages
      .filter(m => m.type === 'user_input' && typeof m.content === 'string' && m.content.length > 0)
      .map(m => m.content),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userMessageHistoryFingerprint],
  )

  const slashCommands = useConnectionStore(s => s.slashCommands)

  // Chat redesign #6391 (slice 8): order slash commands by source so the picker
  // renders clean Built-in / Project / User groups (and the "builtins pinned
  // above" intent in the SlashCommand docstring is actually enforced). Stable
  // within each group; the parent's keyboard nav (InputBar `filteredCommands`)
  // reads this same ordering, so selection stays coherent across the grouped
  // display.
  const orderedSlashCommands = useMemo(() => {
    // #6823: MCP-server prompts (source 'mcp') sort last, after user skills —
    // matches the server's computeSlashCommands ordering.
    const rank = (s: string) => (s === 'builtin' ? 0 : s === 'project' ? 1 : s === 'user' ? 2 : 3)
    return [...slashCommands].sort((a, b) => rank(a.source) - rank(b.source))
  }, [slashCommands])

  // Store actions (stable refs)
  const connect = useConnectionStore(s => s.connect)
  const retryConnection = useConnectionStore(s => s.retryConnection)
  const sendInput = useConnectionStore(s => s.sendInput)
  const appendMemory = useConnectionStore(s => s.appendMemory)
  const addInfoNotification = useConnectionStore(s => s.addInfoNotification)
  const sendInterrupt = useConnectionStore(s => s.sendInterrupt)
  const sendCancelQueued = useConnectionStore(s => s.sendCancelQueued)
  // #5939: stable cancel callback so the memoized message rows skip re-render.
  const onCancelQueued = useCallback(
    (id: string) => { sendCancelQueued(id) },
    [sendCancelQueued],
  )
  // #5780 — nonce bumped on the explicit "jump to latest" user action. Those
  // actions are: send (handleSend), approving a permission/plan, and answering
  // an AskUserQuestion (#5786). Passed to every ChatView so it snaps to the
  // bottom even when the user had scrolled up to read history — see ChatView's
  // scrollToBottomSignal effect.
  const [scrollToBottomSignal, setScrollToBottomSignal] = useState(0)
  // #6788 — nonce bumped by the Cmd/Ctrl+F shortcut to summon the ChatView's
  // in-session find bar. A nonce (not a boolean) re-opens it reliably and keeps
  // ChatView's memo wrapper intact. Only passed to the primary chat panes.
  const [openSearchSignal, setOpenSearchSignal] = useState(0)
  const evaluateDraft = useConnectionStore(s => s.evaluateDraft)
  const sendPermissionResponse = useConnectionStore(s => s.sendPermissionResponse)
  const switchSession = useConnectionStore(s => s.switchSession)
  // #4982 — banner rendered when the server rejects a stale sessionId.
  // The message-handler clears activeSessionId on SESSION_NOT_FOUND so
  // the next user send doesn't loop the same toast; this banner gives
  // the operator a calm explanation while pointing at the sidebar.
  const sessionNotFoundError = useConnectionStore(s => s.sessionNotFoundError)
  const dismissSessionNotFoundError = useConnectionStore(s => s.dismissSessionNotFoundError)
  const destroySession = useConnectionStore(s => s.destroySession)
  const renameSession = useConnectionStore(s => s.renameSession)
  const createSession = useConnectionStore(s => s.createSession)
  const revokeToken = useConnectionStore(s => s.revokeToken)
  const confirmSessionClose = useConnectionStore(s => s.confirmSessionClose)
  const setViewMode = useConnectionStore(s => s.setViewMode)
  // #5835 (PR2) / #5986: drive the live PTY mirror's opt-in. While the Output
  // tab is shown for a PTY-backed session (claude-tui OR user-shell — see
  // isPtyProvider), opt into terminal_output; opt out on leave / session switch
  // / provider change. If the Output tab is somehow active on a session with no
  // PTY mirror (e.g. after switching to a chat provider), fall back to chat —
  // the tab is hidden there, so the user shouldn't be stranded on it.
  useEffect(() => {
    // #5986/#5997 — user-shell has no Chat view (the tab is hidden). Redirect
    // the operator to the Output terminal ONLY from the now-hidden Chat tab
    // (e.g. a persisted 'chat' viewMode carried over from a prior session). We
    // deliberately do NOT force away from other tabs (Files / System / Diff /
    // Envs are useful for a shell's cwd) — snapping back from every non-terminal
    // view trapped the operator on the terminal (#5997).
    if (isUserShell && viewMode === 'chat') {
      setViewMode('terminal')
      return
    }
    // Only force away from the Output tab once we KNOW the active session has no
    // PTY mirror. During the initial-load / reconnect window the provider is
    // still null/unknown — force-switching then would kick the operator out of a
    // persisted Output view for a claude-tui session (Copilot #5838).
    if (viewMode === 'terminal' && activeSessionProvider != null && !isPtyProvider) {
      setViewMode('chat')
      return
    }
    // Gate the opt-in on a live socket and depend on connectionPhase, so a
    // reconnect (which clears the server-side terminalSessionIds set) re-runs
    // this effect and re-subscribes — otherwise the mirror silently stops
    // updating until the user toggles tabs (Copilot #5838). Both claude-tui and
    // user-shell expose a live PTY mirror, so subscribe for either (#5986).
    if (viewMode === 'terminal' && isPtyProvider && activeSessionId && connectionPhase === 'connected') {
      subscribeTerminalMirror(activeSessionId)
      return () => unsubscribeTerminalMirror(activeSessionId)
    }
  }, [viewMode, activeSessionId, activeSessionProvider, isUserShell, isPtyProvider, connectionPhase, subscribeTerminalMirror, unsubscribeTerminalMirror, setViewMode])
  const setModel = useConnectionStore(s => s.setModel)
  const setPermissionMode = useConnectionStore(s => s.setPermissionMode)
  const setThinkingLevel = useConnectionStore(s => s.setThinkingLevel)
  // setPromptEvaluator now consumed directly by SettingsPanel — moved out
  // of the header in fix/auto-evaluate-to-settings (avoids the wrapping
  // "Auto-" / "evaluate" header label and gives the toggle a hint line).
  // #3209: skills runtime API
  const requestListSkills = useConnectionStore(s => s.requestListSkills)
  const activateSkill = useConnectionStore(s => s.activateSkill)
  const deactivateSkill = useConnectionStore(s => s.deactivateSkill)
  // #3270: 'Accept new content' affordance — pairs with skill_trust_accept
  // server handler (#3235/#3269).
  const acceptSkillTrust = useConnectionStore(s => s.acceptSkillTrust)
  // #3272: gate the Accept button on (a) the server's advertised
  // capability AND (b) an actually-connected socket. Without the
  // connection check, capability state surviving from a previous
  // connection could leave the button rendered while disconnected /
  // reconnecting — clicks would then silently no-op. Treat missing
  // flag as false — fail-closed.
  const skillTrustAcceptSupported = useConnectionStore(s =>
    s.connectionPhase === 'connected' && !!s.serverCapabilities?.skillTrustAccept,
  )
  // #3298: community-skill first-activation trust grant. Gate on (a)
  // server capability AND (b) connected socket — same pattern as
  // skillTrustAcceptSupported above.
  const grantCommunitySkillTrust = useConnectionStore(s => s.grantCommunitySkillTrust)
  const skillTrustGrantSupported = useConnectionStore(s =>
    s.connectionPhase === 'connected' && !!s.serverCapabilities?.skillTrustGrant,
  )
  const [skillsPanelOpen, setSkillsPanelOpen] = useState(false)
  const dismissServerError = useConnectionStore(s => s.dismissServerError)
  const dismissInfoNotification = useConnectionStore(s => s.dismissInfoNotification)
  const dismissSessionNotification = useConnectionStore(s => s.dismissSessionNotification)
  // #4890 — Slack-style notifications widget read/unread actions. Pulled
  // as discrete selectors so a notifications-only state change doesn't
  // re-render unrelated chrome.
  const markSessionNotificationRead = useConnectionStore(s => s.markSessionNotificationRead)
  const markAllSessionNotificationsRead = useConnectionStore(s => s.markAllSessionNotificationsRead)
  // #6790 — dismiss an active dev-server preview tunnel from the header chip.
  const closeDevPreview = useConnectionStore(s => s.closeDevPreview)
  const conversationHistory = useConnectionStore(s => s.conversationHistory)
  const fetchConversationHistory = useConnectionStore(s => s.fetchConversationHistory)
  const resumeConversation = useConnectionStore(s => s.resumeConversation)
  const sendUserQuestionResponse = useConnectionStore(s => s.sendUserQuestionResponse)
  const markPromptAnswered = useConnectionStore(s => s.markPromptAnswered)
  const fetchFileList = useConnectionStore(s => s.fetchFileList)
  const fetchSlashCommands = useConnectionStore(s => s.fetchSlashCommands)
  const searchResults = useConnectionStore(s => s.searchResults)
  const searchLoading = useConnectionStore(s => s.searchLoading)
  const searchQuery = useConnectionStore(s => s.searchQuery)
  const searchConversations = useConnectionStore(s => s.searchConversations)
  const clearSearchResults = useConnectionStore(s => s.clearSearchResults)

  // Command palette
  const commands = useCommands(isPtyProvider)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [fileOpenPaletteOpen, setFileOpenPaletteOpen] = useState(false)
  const [symbolSearchOpen, setSymbolSearchOpen] = useState(false)
  const [codeSearchOpen, setCodeSearchOpen] = useState(false)
  // #6477 — the references palette is opened by alt+click (store-driven), not a shortcut.
  const referencesOpen = useConnectionStore(s => s.referencesOpen)

  // Local state
  const [showCreateSession, setShowCreateSession] = useState(false)
  const [pendingCwd, setPendingCwd] = useState<string | null>(null)
  // #5553 — the open per-repo settings drawer target (path + name), or null.
  const [repoPresetDrawer, setRepoPresetDrawer] = useState<{ path: string; name: string } | null>(null)
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  const [sessionCreateError, setSessionCreateError] = useState<string | null>(null)
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([])
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(() => loadPersistedSidebarWidth() ?? 240)
  const [sidebarFilter, setSidebarFilter] = useState('')
  // #4045: sidebar right-click context menu state. `null` when closed.
  const [sidebarContextMenu, setSidebarContextMenu] = useState<{
    target: ContextMenuTarget
    x: number
    y: number
  } | null>(null)
  const [checkpointsOpen, setCheckpointsOpen] = useState(false)
  // #5560 — Control Room tab (#5204), converged Settings redirect (#5544), the
  // legacy settings modal + shortcut-help flags, and split-view mode all live
  // in `useControlRoomState` (split-view is co-located because openControlRoom
  // clears it).
  const {
    controlRoomOpen,
    controlRoomActive,
    setControlRoomActive,
    settingsRedirectNonce,
    controlRoomInitialTab,
    settingsOpen,
    setSettingsOpen,
    shortcutHelpOpen,
    setShortcutHelpOpen,
    splitMode,
    setSplitMode,
    openControlRoom,
    openSettings,
    closeControlRoom,
  } = useControlRoomState()
  // #5997 — split view is a chat|terminal pane pair; it makes no sense for a
  // terminal-only user-shell session (the chat half renders empty). The Split
  // button is hidden for user-shell in ViewSwitcher, but a split carried over
  // from a prior chat session would persist — clear it when a user-shell
  // session becomes active so the operator is never left with an empty pane.
  useEffect(() => {
    if (isUserShell && splitMode) {
      setSplitMode(null)
      persistSplitMode(null)
    }
  }, [isUserShell, splitMode, setSplitMode])
  // #5206 — the session id awaiting close-confirmation, or null when no
  // confirm is pending. Drives the ConfirmDialog rendered near the modals.
  const [closeConfirmSessionId, setCloseConfirmSessionId] = useState<string | null>(null)
  // #5202 — when an Investigate verdict launches a session, the reason note is
  // stashed here at click time and seeded into the new session's composer once
  // the server confirms the session (the create-confirm effect). A ref (not
  // state) so it survives without re-renders and is read at the transition.
  const pendingSeedPromptRef = useRef<string | null>(null)

  // #5217 — single owner of the create-session picker open path. Every opener
  // routes through this so none can diverge on the three things that must stay
  // in lockstep: the pre-filled cwd, the Investigate seed ref (#5202 — only the
  // Investigate opener passes a non-null seed; everyone else clears it so a
  // stale reason can't leak into an unrelated session, #5214), and showing the
  // modal. Stable identity ([] deps) so effects/handlers can depend on it freely.
  const openCreateSession = useCallback(({ cwd = null, seed = null }: { cwd?: string | null; seed?: string | null } = {}) => {
    pendingSeedPromptRef.current = seed || null
    setPendingCwd(cwd)
    setShowCreateSession(true)
  }, [])

  // #3073: copy chat transcript to clipboard with brief "Copied" feedback.
  const [transcriptCopied, setTranscriptCopied] = useState(false)
  const transcriptResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleCopyTranscript = useCallback(() => {
    const text = formatTranscript(storeMessages)
    if (!text) return
    // #4673: route through the clipboard helper so Tauri builds use the
    // native plugin (navigator.clipboard.writeText silently no-ops in
    // WKWebView). Only flash the "Copied!" check mark if the helper actually
    // wrote — otherwise the indicator lies about an empty OS clipboard.
    void clipboardWriteText(text).then((ok) => {
      if (!ok) {
        // #4629: when the helper reports failure (Tauri plugin rejected,
        // navigator.clipboard missing in a non-secure context, etc.) the
        // OS clipboard was NOT written. The original bug was that the
        // dashboard swallowed this silently and the "Copied!" tooltip
        // still flashed, so the user pasted the wrong content into the
        // next app. PR #4676 stopped the misleading flash; this surfaces
        // a visible toast so the user knows to retry instead of being
        // left guessing why Cmd+V pasted stale data.
        // #4870: tag as 'warning' (yellow) rather than the default
        // 'error' (red). Per the #4148 convention, red is reserved
        // for destructive failures like STREAM_ERROR / ABORT; a
        // failed clipboard write is non-destructive — the user just
        // needs to retry — so warning is the visually honest level.
        useConnectionStore.getState().addServerError(
          'Failed to copy transcript to clipboard. Please try again.',
          undefined,
          'warning',
        )
        return
      }
      setTranscriptCopied(true)
      if (transcriptResetTimerRef.current) clearTimeout(transcriptResetTimerRef.current)
      transcriptResetTimerRef.current = setTimeout(() => setTranscriptCopied(false), 1500)
    })
  }, [storeMessages])
  useEffect(() => () => {
    if (transcriptResetTimerRef.current) clearTimeout(transcriptResetTimerRef.current)
  }, [])

  // #5547: copy a SPECIFIC session's transcript (the sidebar right-click
  // action). Unlike handleCopyTranscript (which copies the ACTIVE session via
  // `storeMessages`), this reads the target session's messages straight from
  // the store so it works without switching sessions first. Routes through the
  // same clipboard helper + warning-toast-on-failure path.
  const handleCopySessionTranscript = useCallback((sessionId: string) => {
    const ss = useConnectionStore.getState().sessionStates[sessionId]
    const text = ss ? formatTranscript(ss.messages) : ''
    if (!text) {
      useConnectionStore.getState().addInfoNotification('No transcript to copy for this session yet.')
      return
    }
    void clipboardWriteText(text).then((ok) => {
      if (!ok) {
        useConnectionStore.getState().addServerError(
          'Failed to copy transcript to clipboard. Please try again.',
          undefined,
          'warning',
        )
        return
      }
      useConnectionStore.getState().addInfoNotification('Transcript copied to clipboard.')
    })
  }, [])

  // #5547: cross-session /compact. Ask the server to summarize the session's
  // persisted history, then open the create-session modal with the session's
  // cwd prefilled and the brief seeded EDITABLE in the composer (never
  // auto-sent — reuses the Investigate seed path). Progress + failures surface
  // as info / error toasts; a per-session in-flight latch disables re-entry so
  // a double right-click can't fire two model calls.
  const summarizingSessionsRef = useRef<Set<string>>(new Set())
  const handleSummarizeAndCreateSession = useCallback((sessionId: string) => {
    if (summarizingSessionsRef.current.has(sessionId)) return
    const store = useConnectionStore.getState()
    const session = store.sessions.find(s => s.sessionId === sessionId)
    const cwd = session?.cwd || null
    summarizingSessionsRef.current.add(sessionId)
    store.addInfoNotification('Summarizing session…')
    void store.summarizeSession(sessionId)
      .then(({ summary }) => {
        // Open the create-session modal pre-filled, with the brief staged as
        // the first (editable) composer message. Mirrors handleInvestigate.
        openCreateSession({ cwd, seed: summary })
      })
      .catch((err: unknown) => {
        useConnectionStore.getState().addServerError(
          err instanceof Error ? err.message : 'Could not summarize this session.',
          undefined,
          'warning',
        )
      })
      .finally(() => {
        summarizingSessionsRef.current.delete(sessionId)
      })
  }, [openCreateSession])

  const [showConsoleTab, setShowConsoleTab] = useState(() => {
    return loadPersistedShowConsoleTab()
  })
  // #6799 — global compact chat filter (hide tool calls + thinking, mobile
  // parity). Seeded from the persisted preference so the choice survives a
  // reload; the filter is applied in the shared `buildChatViewMessages` pass
  // via useChatMessages below.
  const [compactChatFilter, setCompactChatFilter] = useState(() => loadPersistedCompactChatFilter())
  const toggleCompactChatFilter = useCallback((enabled: boolean) => {
    setCompactChatFilter(enabled)
    persistCompactChatFilter(enabled)
  }, [])
  const [isSwitchingSession, setIsSwitchingSession] = useState(false)

  // Clear the switching flag once the active session actually changes
  useEffect(() => {
    setIsSwitchingSession(false)
  }, [activeSessionId])

  const handleSwitchSession = useCallback((sessionId: string) => {
    // #5204 — clicking any session tab returns from the Control Room view.
    // This must run even when the clicked session is already the active one
    // (CR is overlaid on top of it), so it sits before the no-op early return.
    setControlRoomActive(false)
    if (sessionId === activeSessionId) return
    setIsSwitchingSession(true)
    switchSession(sessionId)
  }, [switchSession, activeSessionId])

  // The actual session teardown, shared by the confirm path and the
  // no-confirm path (#5206).
  const performCloseSession = useCallback((sessionId: string, force?: boolean) => {
    // #3800: evict the per-session composer state (draft + collapsed-paste
    // blocks + next-id counter) so the refs further down don't leak the
    // pasted-text content for the lifetime of <App />. `handleSend` already
    // evicts on send; this closes the parallel path on session teardown.
    // The sessions-list reconciliation effect (#3977) is the belt-and-braces
    // backstop for server-driven removals, but evicting synchronously here
    // keeps the cleanup tied to the click.
    evictSessionComposerState(sessionId)
    // Only thread `force` when set, so the normal close path stays a single-arg
    // call (no spurious `undefined` second argument).
    if (force) destroySession(sessionId, true)
    else destroySession(sessionId)
  }, [destroySession])

  const handleCloseSession = useCallback((sessionId: string) => {
    // #5710 — a busy/running session is rejected by the server's #5695 guard
    // ("interrupt it first"). For a WEDGED session that never reports turn-end
    // that's a dead end, so offer an explicit force-delete confirm here that
    // sends `force: true`. `isBusy` is the client-visible proxy for the server's
    // `isRunning`. window.confirm is synchronous and matches the auto-mode
    // confirm pattern used elsewhere in the dashboard.
    const session = sessions.find(s => s.sessionId === sessionId)
    if (session?.isBusy) {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm('This session is still running. Delete it anyway? The in-flight turn will be interrupted and any uncommitted work in its worktree may be lost.')
        : true
      if (!ok) return
      performCloseSession(sessionId, true)
      return
    }
    // #5206 — gate the teardown behind a styled confirm dialog when the
    // setting is enabled (the default). When disabled, close immediately.
    // The Control Room tab closes via its own non-session path and never
    // reaches here, so it stays exempt from the confirmation.
    if (confirmSessionClose) {
      setCloseConfirmSessionId(sessionId)
      return
    }
    performCloseSession(sessionId)
  }, [sessions, confirmSessionClose, performCloseSession])

  // #3567 / #3602: dedicated restart handler for the StdinDisabledBanner.
  // Creates a replacement session FIRST and then destroys the broken one so
  // the swap never leaves the user with zero sessions. The server's
  // `destroy_session` handler rejects "Cannot destroy the last session" (see
  // `packages/server/src/handlers/session-handlers.js`), so a destroy-first
  // ordering would fail in the common case where the wedged session is the
  // only one open. Creating first also avoids an intermediate
  // `session_switched` away from the restarted session when the active
  // session is destroyed. The replacement keeps the same cwd / name /
  // provider / model / permissionMode so the user lands back where they
  // started without going through the create-session modal. No confirm
  // dialog — destruction is implicit in "restart" and any in-flight Claude
  // work was already wedged behind the broken stdin pipe.
  const handleRestartSession = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.sessionId === sessionId)
    if (!session) return
    createSession({
      name: session.name,
      cwd: session.cwd || undefined,
      provider: session.provider,
      model: session.model || undefined,
      permissionMode: session.permissionMode || undefined,
      worktree: session.worktree,
    })
    // #3800: same per-session composer eviction as handleCloseSession. The
    // restart path also tears down the old session via destroySession, so
    // its draft / collapsed-paste entries would otherwise linger keyed by
    // the now-defunct sessionId. The #3977 reconciliation effect would
    // also catch this once `sessions[]` rebroadcasts without the old id,
    // but evicting here keeps the cleanup tied to the click.
    evictSessionComposerState(sessionId)
    destroySession(sessionId)
  }, [sessions, destroySession, createSession])

  // #4045: sidebar right-click context menu open + dismiss handlers. The
  // open path stashes the click target + viewport coordinates so the
  // SessionContextMenu can render at the cursor. Dismiss clears state.
  // #4372: move focus to the row before opening the menu. A right-click
  // does not move focus by default, so without this the SessionContextMenu's
  // `previouslyFocused` capture (PR #4369) lands on whatever the user last
  // clicked (often the composer textarea) and Esc returns focus there
  // instead of to the row.
  const handleSidebarContextMenu = useCallback((target: ContextMenuTarget, event: React.MouseEvent) => {
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.focus()
    }
    setSidebarContextMenu({ target, x: event.clientX, y: event.clientY })
  }, [])
  const dismissSidebarContextMenu = useCallback(() => {
    setSidebarContextMenu(null)
  }, [])

  // #4045/#4249: build the menu item list for the currently-targeted sidebar
  // row. Branching by target.type and capability-gating ("Open in Finder"
  // only under Tauri; resumable "Open in Finder" only when the conversation
  // record carries a cwd) lives in buildSidebarContextMenuItems so the
  // per-branch logic is unit-testable without rendering App.
  const sidebarContextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!sidebarContextMenu) return []
    return buildSidebarContextMenuItems({
      target: sidebarContextMenu.target,
      sessions,
      conversationHistory,
      isTauri: isTauri(),
      createSession,
      resumeConversation,
      revealInFinder,
      onRevealError: (message) => {
        useConnectionStore.getState().addServerError(message)
      },
      copyToClipboard: (text) => {
        // #4673: route through the clipboard helper so Tauri builds use the
        // native plugin instead of navigator.clipboard (which silently
        // no-ops in WKWebView).
        // #4871: surface a visible warning toast on failure so the user
        // knows the OS clipboard was NOT written (Tauri plugin rejected,
        // navigator.clipboard missing in a non-secure context, etc.).
        // Mirrors the #4857 / #4629 pattern applied to handleCopyTranscript
        // above. Severity is 'warning' (not the default 'error') per #4870 —
        // a failed clipboard write is non-destructive, the user just retries.
        void clipboardWriteText(text).then((ok) => {
          if (!ok) {
            useConnectionStore.getState().addServerError(
              'Failed to copy to clipboard. Please try again.',
              undefined,
              'warning',
            )
          }
        })
      },
      openCreateSessionAt: (cwd) => {
        // #5214/#5217 — context-menu opener; not an Investigate launch (seed
        // cleared by the shared helper).
        openCreateSession({ cwd })
      },
      copySessionTranscript: handleCopySessionTranscript,
      summarizeAndCreateSession: handleSummarizeAndCreateSession,
      confirmCloseSession: handleCloseSession,
    })
  }, [
    sidebarContextMenu,
    sessions,
    conversationHistory,
    createSession,
    resumeConversation,
    handleCloseSession,
    openCreateSession,
    handleCopySessionTranscript,
    handleSummarizeAndCreateSession,
  ])

  /**
   * Append processed image attachments to the composer's pending-image
   * tray. Hoisted above the keydown listener so the Ctrl+V Tauri path
   * (which produces a single base64-decoded attachment) and the File-based
   * paste/drop paths in `handleImagePaste` / `handleImageDrop` (which
   * produce arrays from `processImageFiles`) all share one append point
   * (#3796 review).
   */
  const appendImageAttachments = useCallback((attachments: ImageAttachment[]) => {
    if (attachments.length === 0) return
    setImageAttachments(prev => [...prev, ...attachments])
  }, [])

  // Latest-handler ref for the Cmd+Shift+L device-pairing shortcut. `handleShowQr`
  // (from useQrModal) and `isConnected` are declared BELOW this dispatch call, so
  // the shortcut reads them through a ref rather than forcing a hook reorder. The
  // ref is assigned once both are in scope (search: showQrRef.current =).
  const showQrRef = useRef<(() => void) | null>(null)

  // #4770: keydown dispatch (Backspace prevention + Tauri Ctrl+V image
  // paste + registry-routed shortcuts) lives in useShortcutDispatch so
  // App stays under the SRP threshold and the dispatch ladder is
  // independently testable.
  useShortcutDispatch({
    shortcutRegistry,
    sessions,
    activeSessionId,
    viewMode,
    setViewMode,
    setSplitMode,
    // #5997 — gate the chat/terminal toggle + split shortcuts off for a
    // terminal-only user-shell session (no chat surface to toggle/split).
    terminalOnly: isUserShell,
    setPaletteOpen,
    setSidebarOpen,
    setSettingsOpen,
    // #5544 — Cmd+, redirects to the Control Room Settings tab.
    openSettings,
    setShowCreateSession,
    setShortcutHelpOpen,
    handleSwitchSession,
    handleCloseSession,
    handleCopyTranscript,
    sendInterrupt,
    setPermissionMode,
    appendImageAttachments,
    openFilePalette: () => { if (ideEnabled) setFileOpenPaletteOpen(true) },
    openSymbolSearch: () => { if (ideEnabled) setSymbolSearchOpen(true) },
    openCodeSearch: () => { if (ideEnabled) setCodeSearchOpen(true) },
    // Cmd+Shift+L → device-pairing QR. Stable closure over a ref, since
    // handleShowQr/isConnected are declared below; the ref no-ops when null
    // (disconnected), so the shortcut only opens the modal when there's a server.
    showQr: () => showQrRef.current?.(),
    // #6788 — Cmd/Ctrl+F summons the in-session find bar. Only intercept the
    // browser's native find when a chat transcript is on screen (chat view, or a
    // split whose first pane is chat); elsewhere the event falls through.
    chatTranscriptVisible: viewMode === 'chat' || splitMode !== null,
    openTranscriptSearch: () => setOpenSearchSignal(n => n + 1),
  })

  const trackedCommands = useMemo(
    () => commands.map(cmd => ({
      ...cmd,
      action: () => {
        recordMruCommand(cmd.id)
        // Override commands that need App-level state
        if (cmd.id === 'new-session') {
          // #5217 — plain new session via the shared opener (resets cwd +
          // clears any stashed Investigate seed).
          openCreateSession()
        } else if (cmd.id === 'toggle-sidebar') {
          setSidebarOpen(prev => !prev)
        } else {
          cmd.action()
        }
      },
    })),
    [commands],
  )

  // Auto-connect on mount — use page token (served by local server),
  // or fall back to the last active server from the registry.
  // Reads registry via getState() to avoid reactive deps (mount-only effect).
  //
  // NOTE: precedence here (local-first) is intentionally the inverse of
  // retryConnection's (active-server-first). A fresh page load returns to the
  // local "home" daemon; a manual Retry resumes whatever you were connected to.
  // The two don't collide in practice — connectLocal nulls activeServerId.
  useEffect(() => {
    const token = getAuthToken()
    if (token) {
      // Served by a local daemon — connect to "this machine" (scope null).
      useConnectionStore.getState().connectLocal()
      return
    }
    const { activeServerId: savedId, serverRegistry: registry, connectToServer: connectSrv } = useConnectionStore.getState()
    if (savedId && registry.some(s => s.id === savedId)) {
      connectSrv(savedId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect])

  // Close Create Session modal when server confirms (activeSessionId changes)
  useEffect(() => {
    if (isCreatingSession && activeSessionId) {
      setShowCreateSession(false)
      setIsCreatingSession(false)
      setSessionCreateError(null)
      // #5202 — if this create was launched from an Investigate verdict, seed
      // the freshly-created session's composer with the reason note and drop
      // out of the Control Room so the operator lands in the new session. We
      // write the per-session draft ref too so the draft-restore effect (which
      // runs after this one on the same activeSessionId change) reads the seed
      // rather than clobbering it with an empty draft.
      // #5553: a server-provided repo-preset SEED (delivered on session_switched
      // and stashed in the store keyed by sessionId) takes precedence — it's the
      // repo's intentional first-message template. Falls back to the client-side
      // Investigate/summarize seed (#5202/#5547). Either way the seed is staged
      // EDITABLE (never auto-sent) via the same draft-ref path.
      const takeSeed = useConnectionStore.getState().takePendingServerSeed
      const serverSeed = typeof takeSeed === 'function' ? takeSeed(activeSessionId) : null
      const seed = serverSeed || pendingSeedPromptRef.current
      if (seed) {
        inputDraftsRef.current.set(activeSessionId, seed)
        setInputDraftValue(seed)
        setControlRoomActive(false)
        pendingSeedPromptRef.current = null
      }
    }
  }, [activeSessionId, isCreatingSession])

  // Show session_error in modal when creating
  useEffect(() => {
    if (isCreatingSession && serverErrors.length > 0) {
      const latest = serverErrors[serverErrors.length - 1]
      if (latest) {
        setSessionCreateError(latest.message)
        setIsCreatingSession(false)
      }
    }
  }, [serverErrors, isCreatingSession])

  // #6285 — clear a stranded "Creating…" spinner if the socket drops mid-create.
  // The socket onclose only resets ~12 transient flags, NOT isCreatingSession, and
  // a closed-socket createSession is a silent no-op — so a drop between Create-click
  // and the server's session_created/session_error reply would wedge the spinner
  // forever. Reset it and surface a retryable error the moment connectionPhase
  // leaves 'connected' while a create is in flight.
  useEffect(() => {
    if (isCreatingSession && connectionPhase !== 'connected') {
      setIsCreatingSession(false)
      setSessionCreateError('Connection lost — try again')
    }
  }, [connectionPhase, isCreatingSession])

  // #4770: chat-message pipeline (filter system events + group activity
  // runs + apply streaming overlay + flatten to ChatViewMessage[]) is
  // extracted to `useChatMessages` so the derivations are independently
  // testable. The hook also exposes `storeMsgMap` (O(1) renderMessage
  // lookup) and `stalledPromptIds` (#4615 — prompts invalidated by a
  // subsequent ASK_USER_QUESTION_STALL) because both are pure
  // storeMessages derivations that only the renderer consumes.
  const {
    chatMessages,
    chatToolGroupPayloads,
    chatTailMessageId,
    storeMsgMap,
    stalledPromptIds,
  } = useChatMessages({
    storeMessages,
    streamingMessageId,
    // #6799 — global compact chat filter: drop tool_use + thinking rows
    // session-wide when the header toggle is on (mobile parity).
    hideToolAndThinking: compactChatFilter,
  })

  // #6788 — searchable-text extractor for the ChatView in-session find bar.
  // Delegates to the pure `extractRowSearchText` helper (unit-tested in
  // lib/transcriptSearch.test.ts): collapsed `tool_group` rows join their inner
  // tool summaries + results from the group payload, and a SINGLETON `tool_use`
  // row appends the store message's `toolResult` (#6811 review — a lone tool's
  // stdout lives on the store message, not in the row's `content`, and must be
  // just as findable as the same output inside a 2+ group; mobile searches
  // content || toolResult on every row). Memoized on the two lookup maps so
  // ChatView's memoized searchable-row list stays stable.
  const chatSearchText = useCallback(
    (msg: ChatViewMessage): string =>
      extractRowSearchText(msg, chatToolGroupPayloads, storeMsgMap),
    [chatToolGroupPayloads, storeMsgMap],
  )

  // System events for the System tab — uses the same toChatViewMessage
  // mapping the chat pipeline does so both surfaces present rows in the
  // same shape.
  const systemMessages = useMemo(
    () => storeMessages.filter(m => m.type === 'system').map(toChatViewMessage),
    [storeMessages],
  )

  // Track unread system events per session so switching sessions or message
  // trimming does not leave a stale global count.
  const lastSeenSystemCountRef = useRef<Map<string | null | undefined, number>>(new Map())
  const lastSeenForSession = lastSeenSystemCountRef.current.get(activeSessionId) ?? 0
  const rawUnreadSystemCount = viewMode === 'system'
    ? 0
    : systemMessages.length - lastSeenForSession
  const unreadSystemCount = rawUnreadSystemCount > 0 ? rawUnreadSystemCount : 0

  // Update last-seen count when entering System tab; clamp when messages are trimmed
  useEffect(() => {
    const map = lastSeenSystemCountRef.current
    const previous = map.get(activeSessionId) ?? 0

    // Clamp if messages were trimmed below previously-seen count
    if (previous > systemMessages.length) {
      map.set(activeSessionId, systemMessages.length)
    }

    if (viewMode === 'system') {
      map.set(activeSessionId, systemMessages.length)
    }
  }, [viewMode, systemMessages.length, activeSessionId])

  // #3619: `sessionActivityNow` is compared against `lastActivityAt` /
  // `createdAt` from `session_list`, which are server-issued wall-clock
  // timestamps. Wall-clock-against-wall-clock is the only coherent path
  // here; `performance.now()` would subtract a process-local monotonic
  // clock from a remote wall clock. The minute-tick granularity tolerates
  // any small wall-clock drift between the two machines.
  const [sessionActivityNow, setSessionActivityNow] = useState(() => Date.now())

  useEffect(() => {
    const intervalId = window.setInterval(() => setSessionActivityNow(Date.now()), 60_000)
    return () => window.clearInterval(intervalId)
  }, [])

  const getSessionVisualStatus = useCallback((session: SessionInfo): SessionStatus => {
    const state = sessionStates[session.sessionId]
    return deriveSessionVisualStatus({
      isBusy: session.isBusy,
      isIdle: state?.isIdle,
      streamingMessageId: state?.streamingMessageId,
      activeAgentCount: state?.activeAgents.length ?? 0,
      lastActivityAt: session.lastActivityAt ?? session.createdAt,
      now: sessionActivityNow,
    })
  }, [sessionStates, sessionActivityNow])

  // #5560 — the three user-defined ordering overlays (SessionBar tab order
  // #4831; sidebar repo + per-repo session orders #4832) plus their
  // server-switch refresh effects (#4831 / #4940) live in `useSidebarOrdering`.
  const {
    tabOrder,
    sidebarRepoOrder,
    sidebarSessionOrder,
    handleReorderTabs,
    handleReorderRepos,
    handleReorderSidebarSessions,
  } = useSidebarOrdering()

  // Map sessions to SessionTabData[] with unified status indicators.
  //
  // #4831: apply the persisted `tabOrder` overlay. Sessions present in
  // `tabOrder` render in that order; sessions added by the server since
  // the last reorder (new tabs, restored conversations) fall through to
  // the server's natural order at the end. Stale ids in `tabOrder` (server
  // removed the session) are harmlessly ignored because we filter against
  // the live `sessions` list.
  // #5667 — which sessions have an unanswered, still-live permission prompt,
  // across ALL sessions (not just the active one). Now that the server routes a
  // prompt to its owning session, a background session's prompt no longer lands
  // in the focused tab — without a per-tab indicator it would be invisible until
  // the operator switched to that session. Shallow-equal Record so this only
  // re-renders a tab when its pending state actually flips, not on every stream
  // delta. The `expiresAt > now` check (inside the helper) clears the indicator
  // on expiry/timeout, which set `options: undefined` but not `answered`.
  const pendingPermissionCounts = useConnectionStore(
    useShallow((s) => derivePendingPermissionCounts(s.sessionStates, Date.now())),
  )

  const sessionTabs: SessionTabData[] = useMemo(
    () => {
      const byId = new Map(sessions.map(s => [s.sessionId, s]))
      const ordered: SessionInfo[] = []
      const seen = new Set<string>()
      for (const id of tabOrder) {
        const s = byId.get(id)
        if (s && !seen.has(id)) {
          ordered.push(s)
          seen.add(id)
        }
      }
      for (const s of sessions) {
        if (!seen.has(s.sessionId)) ordered.push(s)
      }
      return ordered.map(s => ({
        sessionId: s.sessionId,
        name: s.name,
        isBusy: s.isBusy,
        isActive: s.sessionId === activeSessionId,
        cwd: s.cwd,
        model: s.model ?? undefined,
        provider: s.provider,
        status: getSessionVisualStatus(s),
        // #3567: surface latched stdin-disabled flag from session_list.
        stdinForwardingDisabled: s.stdinForwardingDisabled,
        // #5667: flag tabs with an unanswered permission prompt so a
        // background session's request is visible without switching to it.
        // #5693: also carry the count so the tab can show `!2`.
        pendingPermission: (pendingPermissionCounts[s.sessionId] ?? 0) > 0,
        pendingPermissionCount: pendingPermissionCounts[s.sessionId] ?? 0,
      }))
    },
    [sessions, activeSessionId, getSessionVisualStatus, tabOrder, pendingPermissionCounts],
  )

  // #5693 (PR-3) — aggregate "N pending" badge + jump-to-next-waiting-session.
  // Containment keeps each prompt in its own tab; this gives one place to see
  // the total and one click to reach the next waiting session (cyclically, in
  // visual tab order).
  const pendingPermissionTotal = totalPendingPermissions(pendingPermissionCounts)
  // #6184/#6225: mirror the cross-session "needs me" count on the desktop dock
  // badge (no-op in a plain browser tab). Reuses the pending total derived above
  // for the header indicator so we don't scan every session's messages twice;
  // the badge adds crashed-session count on top (failed slice, inside the hook).
  useTrayBadgeSync(pendingPermissionTotal)

  // Chat redesign #6391 (slice 3): the dashboard's canonical per-session chat
  // activity (idle/thinking/busy/waiting/error), replacing the ad-hoc binary
  // isBusy. Feeds the store's raw signals into store-core's deriveChatActivity
  // — the SAME machine the mobile app uses (#6396) — so the composer's live
  // hairline + state-lozenge (slices 4-5) read one source instead of N
  // independent isBusy/isStreaming derivations. Exposed to the composer as a
  // data attribute; startedAt continuity is wired when slice 6 (footer-stat
  // thinking) consumes it.
  const chatActivity = deriveChatActivity({
    isIdle: isIdle ?? true,
    streamingMessageId: streamingMessageId ?? null,
    isPlanPending: isPlanPending ?? false,
    pendingPermission: (pendingPermissionCounts[activeSessionId ?? ''] ?? 0) > 0,
  })

  const handleJumpToPending = useCallback(() => {
    const orderedIds = sessionTabs.map(t => t.sessionId)
    const next = selectNextPendingSession(orderedIds, pendingPermissionCounts, activeSessionId)
    if (next) handleSwitchSession(next)
  }, [sessionTabs, pendingPermissionCounts, activeSessionId, handleSwitchSession])

  // Derive sidebar repo tree from sessions
  // #4120: dedicated selector for the cumulativeUsage slice the sidebar
  // reads, with shallow equality so this only updates when a value the
  // sidebar consumes actually changes — NOT on every stream chunk.
  // Without this slice the sidebarRepos useMemo below depended on the
  // entire `sessionStates` object, which gets replaced on every WS
  // event (every stream_delta, every tool_result), forcing the memo
  // to recompute + allocate a fresh RepoNode[] hundreds of times per
  // turn (#4119 review followup #4120).
  const sidebarCumulativeUsage = useConnectionStore(
    useShallow((s) => {
      // for-in + index lookup avoids the per-call Object.entries()
      // intermediate array allocation. This selector still runs on every
      // store update (zustand fires the selector to compute the new
      // value and compare against the previous); only the SHALLOW-EQUAL
      // RESULT comparison short-circuits the React subscribers.
      // Skipping the array allocation keeps the hot path tight (#4130
      // review).
      const out: Record<string, BaseSessionState['cumulativeUsage']> = {}
      for (const id in s.sessionStates) {
        out[id] = s.sessionStates[id]!.cumulativeUsage
      }
      return out
    }),
  )

  const sidebarRepos: RepoNode[] = useMemo(() => {
    const repoMap = new Map<string, RepoNode>()

    // Group active sessions by cwd (skip sessions without a cwd)
    for (const s of sessions) {
      if (!s.cwd) continue
      let repo = repoMap.get(s.cwd)
      if (!repo) {
        const name = s.cwd.split('/').pop() || s.cwd
        repo = { path: s.cwd, name, source: 'auto', exists: true, activeSessions: [], resumableSessions: [] }
        repoMap.set(s.cwd, repo)
      }
      repo.activeSessions.push({
        sessionId: s.sessionId,
        name: s.name,
        isBusy: s.isBusy,
        provider: s.provider,
        worktree: s.worktree,
        status: getSessionVisualStatus(s),
        // #3567: surface latched stdin-disabled flag from session_list.
        stdinForwardingDisabled: s.stdinForwardingDisabled,
        // #4073: surface per-session running cost. Prefer the live
        // session-state copy (updated by `session_usage` events) and
        // fall back to the session_list snapshot for sessions that
        // haven't received a session_usage tick yet.
        // #4120: read from the shallow-equal selector above instead of
        // `sessionStates` directly so this memo only recomputes when
        // a cumulativeUsage value actually changes — not on every
        // stream chunk.
        cumulativeUsage: sidebarCumulativeUsage[s.sessionId] ?? s.cumulativeUsage ?? null,
      })
    }

    // If no repos from sessions, create a default
    if (repoMap.size === 0) {
      return []
    }

    // #4832 — apply user-defined ordering. Repo groups are reordered
    // by saved cwd order (unknown ids dropped, new repos appended at
    // tail). Sessions within each repo are reordered by the per-repo
    // saved order. `applyOrderById` keeps unsaved sessions / repos at
    // the end so newly-created entries don't shuffle the existing list.
    const ordered = applyOrderById([...repoMap.values()], sidebarRepoOrder, r => r.path)
    return ordered.map(repo => {
      const savedSessionOrder = sidebarSessionOrder[repo.path]
      if (!savedSessionOrder || savedSessionOrder.length === 0) return repo
      return {
        ...repo,
        activeSessions: applyOrderById(repo.activeSessions, savedSessionOrder, s => s.sessionId),
      }
    })
  }, [sessions, getSessionVisualStatus, sidebarCumulativeUsage, sidebarRepoOrder, sidebarSessionOrder])

  // Known CWDs for CreateSessionModal suggestions
  const knownCwds = useMemo(
    () => [...sidebarRepos.map(r => r.path), ...(defaultCwd ? [defaultCwd] : []), ...(sessionCwd ? [sessionCwd] : [])],
    [sidebarRepos, defaultCwd, sessionCwd],
  )

  // Derive plan content from the last assistant message (plan text is streamed
  // before plan_ready fires — the WS protocol doesn't include plan content separately)
  const planHtml = useMemo(() => {
    if (!isPlanPending) return ''
    for (let i = storeMessages.length - 1; i >= 0; i--) {
      const m = storeMessages[i]!
      if (m.type === 'response' || m.type === 'thinking') {
        const escaped = m.content
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br/>')
        return `<p>${escaped}</p>`
      }
    }
    return '<p>Claude has prepared a plan for your review.</p>'
  }, [isPlanPending, storeMessages])

  // Toast items from server errors + info notifications
  // #3587: pass through optional `action` so INVALID_AUTHOR errors with
  // a corrected `actualAuthor` render an inline "Try as <author>" button
  // that re-issues skill_trust_grant. Info notifications never carry
  // actions today, so the spread covers only the error path.
  // #3603: when the WS socket isn't open (reconnecting, restarting,
  // or fully disconnected), action callbacks like `grantCommunitySkillTrust`
  // silently no-op — the operator clicks the button, sees the toast
  // dismiss, and gets no feedback that nothing happened. Flag the
  // action as disabled and swap the label to "Reconnecting…" so the
  // state is visible. The Toast also pauses its 5s auto-dismiss timer
  // while `actionDisabled` is true (and restarts a fresh 5s window on
  // reconnect), so the toast survives the entire disconnect and stays
  // clickable once the socket recovers.
  const isSocketConnected = connectionPhase === 'connected'
  // #4075: surface the active session's cost-threshold warning as a Toast
  // when set and not yet dismissed. The server fires the event ONCE per
  // session; renderer-side dismissal is per-session via `dismissedAt`.
  const activeCostWarning = activeSessionId
    ? sessionStates[activeSessionId]?.costThresholdWarning ?? null
    : null
  const toastItems: ToastItem[] = useMemo(
    () => [
      ...serverErrors
        .filter(e => !e.sessionId || e.sessionId === activeSessionId)
        .map(e => ({
          id: e.id,
          message: e.message,
          // #4148: thread severity through. Default to 'error' for any
          // ServerError that doesn't set the field — preserves the
          // existing red-toast behavior for STREAM_ERROR / ABORT and
          // every pre-#4148 call site of addServerError.
          level: (e.severity === 'warning' ? 'warning' : 'error') as 'warning' | 'error',
          ...(e.action
            ? {
                action: e.action,
                actionDisabled: !isSocketConnected,
                actionDisabledLabel: 'Reconnecting…',
              }
            : {}),
          // #5039: optional partial-cost sub-line surfaced under the
          // main toast message when PR #5037 folded any parent + Task
          // subagent rounds onto the error envelope before the error
          // fired. Undefined for every error path that didn't carry
          // partials, so the existing message-only toast is unchanged.
          ...(e.partialCostLine ? { subMessage: e.partialCostLine } : {}),
        })),
      ...infoNotifications
        .map(e => ({ id: e.id, message: e.message, level: 'info' as const })),
      ...(activeCostWarning && activeCostWarning.dismissedAt == null
        ? [{
            id: `cost-threshold-${activeSessionId}`,
            message: `Session has used $${activeCostWarning.costUsd.toFixed(2)}. (Threshold: $${activeCostWarning.thresholdUsd.toFixed(2)}).`,
            level: 'info' as const,
          }]
        : []),
    ],
    [serverErrors, infoNotifications, activeSessionId, isSocketConnected, activeCostWarning],
  )

  // Per-session input draft persistence.
  //
  // Reconciliation invariant (#3977): every key in `inputDraftsRef`,
  // `pastedTextBlocksRef`, and `pastedTextNextIdRef` MUST correspond to a
  // sessionId present in `sessions[]`. Any per-session ref added below must
  // be added to `evictSessionComposerState()` so the `sessions[]`
  // reconciliation effect can clean it up on server-driven removal.
  const inputDraftsRef = useRef<Map<string, string>>(new Map())
  const [inputDraftValue, setInputDraftValue] = useState('')
  const handleDraftChange = useCallback((text: string) => {
    setInputDraftValue(text)
    if (activeSessionId) inputDraftsRef.current.set(activeSessionId, text)
  }, [activeSessionId])

  // Per-session collapsed-paste storage (#3797). Each composer paste that
  // crosses the size threshold is stashed by id; the textarea sees only
  // the marker. Mirrors the draft-text per-session storage so switching
  // sessions preserves both the marker text and its associated content —
  // expanding back to the original payload on send.
  type PastedTextBlock = { id: number; content: string }
  const pastedTextBlocksRef = useRef<Map<string, PastedTextBlock[]>>(new Map())
  const pastedTextNextIdRef = useRef<Map<string, number>>(new Map())
  const [pastedTextBlocks, setPastedTextBlocks] = useState<PastedTextBlock[]>([])
  const [inspectedPastedTextId, setInspectedPastedTextId] = useState<number | null>(null)

  // #3800 / #3977: single eviction point for the three per-session composer
  // refs above. Called from `handleCloseSession` / `handleRestartSession` /
  // `handleSend` (synchronous user actions) AND from the sessions-list
  // reconciliation effect below (server-driven removals such as another
  // client closing the session, supervisor culling, cold restart, or
  // multi-server switching). Defined as a non-memoised closure because the
  // refs themselves are stable and the helper has no other deps — adding
  // useCallback here would only buy a stable identity that no consumer
  // currently requires.
  const evictSessionComposerState = (sessionId: string) => {
    inputDraftsRef.current.delete(sessionId)
    pastedTextBlocksRef.current.delete(sessionId)
    pastedTextNextIdRef.current.delete(sessionId)
  }

  // #3977: reconcile per-session composer refs against the live `sessions[]`
  // list. PR #3973 closed the two user-initiated removal paths
  // (`handleCloseSession`, `handleRestartSession`); this effect closes the
  // larger surface where the server (or another client) removes a session
  // from `session_list` without <App /> having any local hook to react —
  // see store/message-handler.ts `case 'session_list'`. Any ref entry whose
  // sessionId is no longer present in `sessions` was destroyed by that
  // path; evict it so the maps don't grow unbounded over a long-lived
  // dashboard process. The user-initiated handlers still call
  // `evictSessionComposerState` directly so the cleanup is synchronous with
  // the click — this effect is the belt-and-braces backstop, not the
  // primary path.
  //
  // Deps: only `sessions` — `evictSessionComposerState` reads stable refs
  // and is intentionally not memoised. Building the Set inside the effect
  // (not in a useMemo) keeps the diff cheap; the loop runs once per
  // sessions-array change, which is O(refs) and dominated by O(sessions)
  // on a single Set build.
  useEffect(() => {
    const liveIds = new Set(sessions.map(s => s.sessionId))
    for (const id of inputDraftsRef.current.keys()) {
      if (!liveIds.has(id)) evictSessionComposerState(id)
    }
    // pastedTextBlocksRef / pastedTextNextIdRef may hold ids without a
    // matching draft entry (paste-without-typing), so they need their own
    // pass. The helper is idempotent so re-evicting an id that was already
    // removed above is a no-op.
    for (const id of pastedTextBlocksRef.current.keys()) {
      if (!liveIds.has(id)) evictSessionComposerState(id)
    }
    for (const id of pastedTextNextIdRef.current.keys()) {
      if (!liveIds.has(id)) evictSessionComposerState(id)
    }
  }, [sessions])

  // Restore draft + paste blocks when switching sessions
  useEffect(() => {
    if (activeSessionId) {
      setInputDraftValue(inputDraftsRef.current.get(activeSessionId) ?? '')
      setPastedTextBlocks(pastedTextBlocksRef.current.get(activeSessionId) ?? [])
      setInspectedPastedTextId(null)
    }
  }, [activeSessionId])

  const handleLargePaste = useCallback((text: string): string => {
    const sid = activeSessionId
    if (!sid) return text
    const nextId = (pastedTextNextIdRef.current.get(sid) ?? 0) + 1
    pastedTextNextIdRef.current.set(sid, nextId)
    const block: PastedTextBlock = { id: nextId, content: text }
    const updated = [...(pastedTextBlocksRef.current.get(sid) ?? []), block]
    pastedTextBlocksRef.current.set(sid, updated)
    setPastedTextBlocks(updated)
    return formatPasteMarker(nextId, text)
  }, [activeSessionId])

  const handleRemovePastedText = useCallback((id: number) => {
    const sid = activeSessionId
    if (!sid) return
    const updated = (pastedTextBlocksRef.current.get(sid) ?? []).filter(b => b.id !== id)
    pastedTextBlocksRef.current.set(sid, updated)
    setPastedTextBlocks(updated)
    // Strip the marker for this id from the draft. Build a per-id regex so
    // we only target the matching marker (not other ids' markers).
    const markerRe = new RegExp(`\\[Pasted text #${id} \\+\\d+ (?:lines|chars)\\]`, 'g')
    const currentDraft = inputDraftsRef.current.get(sid) ?? ''
    const cleaned = currentDraft.replace(markerRe, '')
    inputDraftsRef.current.set(sid, cleaned)
    setInputDraftValue(cleaned)
    if (inspectedPastedTextId === id) setInspectedPastedTextId(null)
  }, [activeSessionId, inspectedPastedTextId])

  const handleInspectPastedText = useCallback((id: number) => {
    setInspectedPastedTextId(id)
  }, [])

  // Handlers
  const handleSend = useCallback((text: string, files?: FileAttachment[]) => {
    const allFiles = files || fileAttachments
    // #6861 — `#`-prefix quick-append. A leading `# ` (hash + space) routes the
    // note to the project CLAUDE.md instead of sending a chat turn. Skipped when
    // attachments are pending (they can't go to memory) and for PTY-backed
    // sessions (claude-tui / user-shell) where the composer writes to the
    // terminal and a leading `#` is a shell comment, not a memory command —
    // mirrors the mobile SessionScreen `!hasTerminal` guard. The confirmation
    // lands via the `append_memory_result` ack.
    if (!isPtyProvider && allFiles.length === 0 && imageAttachments.length === 0) {
      const memory = parseMemoryAppend(text)
      if (memory.isMemory) {
        const sent = appendMemory(memory.note)
        if (sent === false) {
          // #6308/#6309 — disconnected: appendMemory is NOT offline-queued, so
          // KEEP the draft (don't clear) and surface a notice rather than
          // silently losing the note.
          addInfoNotification('Not connected — memory note not saved. Try again once reconnected.')
          return
        }
        const memSid = activeSessionId
        if (memSid) evictSessionComposerState(memSid)
        setInputDraftValue('')
        setPastedTextBlocks([])
        setInspectedPastedTextId(null)
        return
      }
    }
    const wire = toWireAttachments(
      allFiles.length > 0 ? allFiles : undefined,
      imageAttachments.length > 0 ? imageAttachments : undefined,
    )
    // #3797: expand `[Pasted text #N +M lines]` markers to their original
    // content before the message hits the wire. Build the lookup from
    // the active session's stashed blocks; markers without a match (e.g.
    // user manually typed something marker-shaped) pass through unchanged.
    const sid = activeSessionId
    const blocks = sid ? pastedTextBlocksRef.current.get(sid) ?? [] : []
    const blockMap = new Map(blocks.map(b => [b.id, b.content]))
    const expanded = blockMap.size > 0 ? expandPasteMarkers(text, blockMap) : text
    // #6632: build transcript previews (composer images → data: URIs, files →
    // chips) so the sent bubble shows what was attached.
    const previews = toMessageAttachments(
      imageAttachments.length > 0 ? imageAttachments : undefined,
      allFiles.length > 0 ? allFiles : undefined,
    )
    const sendResult = sendInput(
      expanded,
      wire.length > 0 ? wire : undefined,
      previews.length > 0 ? { previewAttachments: previews } : undefined,
    )
    // #6295 — parity with the mobile app (SessionScreen handleSend): when the
    // socket is closed the send falls through to the offline queue and returns
    // 'queued'. Surface a transient info notice so the operator knows the
    // message will go out on reconnect, rather than seeing a plain "sent"-
    // looking bubble during the disconnected window.
    if (sendResult === 'queued') {
      addInfoNotification('Message queued — will send on reconnect.')
    }
    // #5780 — sending is an explicit "show me the latest" action: snap the
    // chat to the bottom even if the user had scrolled up before typing.
    setScrollToBottomSignal(n => n + 1)
    setFileAttachments([])
    setImageAttachments([])
    // Clear draft + pasted-text blocks for the session that sent the message.
    // Unlike the close / restart paths, the session itself is still alive —
    // we're just resetting the composer after a successful send. The next
    // paste or draft change for this sid will repopulate the maps.
    if (sid) {
      evictSessionComposerState(sid)
    }
    setInputDraftValue('')
    setPastedTextBlocks([])
    setInspectedPastedTextId(null)
  }, [sendInput, appendMemory, addInfoNotification, fileAttachments, imageAttachments, activeSessionId, isPtyProvider])

  const handleInterrupt = useCallback(() => {
    sendInterrupt()
  }, [sendInterrupt])

  const handleNewSession = useCallback(() => {
    // #5217 — plain new session via the shared opener (no investigation seed).
    openCreateSession()
  }, [openCreateSession])

  // #5986 (epic #5982) — create an embedded user-shell directly. Unlike a chat
  // session this skips the provider-picker modal: user-shell is HIDDEN from the
  // chat provider list and server-gated on the primary token + the userShell
  // capability, so there are no per-session options to pick. The session lands
  // terminal-only (see the isUserShell branch — forces the Output view, hides
  // Chat). cwd falls back to the host default when no repo is selected.
  const handleNewShell = useCallback(() => {
    createSession({ name: 'Shell', cwd: defaultCwd ?? undefined, provider: USER_SHELL_PROVIDER })
  }, [createSession, defaultCwd])

  // #6006 — operator panic button. Revoke is destructive (it invalidates the
  // current token with no grace, severs every live user-shell, and forces ALL
  // connections — including this dashboard — to re-authenticate with the new
  // token, obtained out-of-band). Confirm before firing.
  const handleRevokeToken = useCallback(() => {
    const ok = window.confirm(
      'Revoke the API token now?\n\n' +
      'This immediately invalidates the current token (no grace period), closes every embedded shell, ' +
      'and signs out all connected devices — including this dashboard. You will need to re-pair with the ' +
      'new token to reconnect.\n\nUse this only if the token may be compromised.',
    )
    if (ok) revokeToken()
  }, [revokeToken])

  // #5202 — open the create-session picker pre-filled for an Investigate
  // action: cwd = the repo path, and the reason note seeded into the new
  // session's composer once it's created. The user still picks
  // model/provider/options in the modal before creating.
  const handleInvestigate = useCallback((req: RepoInvestigateRequest) => {
    openCreateSession({ cwd: req.cwd, seed: req.reason })
  }, [openCreateSession])

  // #5507 — open the create-session picker pre-filled for an "Open session"
  // row action: cwd = the repo path. Same plumbing as Investigate minus the
  // composer seeding (no reason note) — the modal suggests + dedupes the
  // session name from the repo's basename, and the user picks
  // model/provider/permission/worktree before creating.
  const handleOpenSession = useCallback((req: RepoOpenSessionRequest) => {
    openCreateSession({ cwd: req.cwd })
  }, [openCreateSession])

  // #5553 — the per-repo settings drawer (gear on a Control Room repo row). One
  // drawer open at a time; the target repo path+name is stashed in state.
  const handleConfigureRepo = useCallback((req: { path: string; name: string }) => {
    setRepoPresetDrawer(req)
  }, [])

  // #4695 / #4942 — bridge the macOS menu bar items to App-state
  // handlers. See the `useTauriMenuEvents` call below `handleShowQr`
  // (further down in this file) for the actual wiring — we can't
  // invoke it inline here because the View > Show QR item reuses
  // `handleShowQr`, which depends on `fetchQrInto`, which is declared
  // further down. The hook is a no-op outside Tauri (web dashboard).

  const handleCreateSession = useCallback((data: { name: string; cwd: string; provider?: string; permissionMode?: string; model?: string; worktree?: boolean; skipPermissions?: boolean }) => {
    setSessionCreateError(null)
    // #6285 — only latch the "Creating…" spinner when the request actually went
    // on the wire. createSession is a silent no-op when the socket is closed; if
    // we latched unconditionally the spinner would wedge forever (no
    // session_created / session_error reply ever arrives to clear it). On a
    // closed socket, surface a retryable error instead.
    const sent = createSession({ name: data.name, cwd: data.cwd || undefined, provider: data.provider, model: data.model, permissionMode: data.permissionMode, worktree: data.worktree, skipPermissions: data.skipPermissions })
    if (sent) {
      setIsCreatingSession(true)
    } else {
      setSessionCreateError('Connection lost — try again')
    }
  }, [createSession])

  const handlePlanApprove = useCallback(() => {
    sendInput('approve')
    // #5786 — approving a plan is an explicit "show me the latest" action: snap
    // to the bottom so the follow-up response scrolls into view.
    setScrollToBottomSignal(n => n + 1)
  }, [sendInput])

  const handlePlanFeedback = useCallback(() => {
    // Focus the input bar so the user can type feedback
    const textarea = document.querySelector<HTMLTextAreaElement>('.input-bar textarea')
    textarea?.focus()
  }, [])

  const handleFileSelect = useCallback((path: string) => {
    setFileAttachments(prev => {
      if (prev.some(f => f.path === path)) return prev
      const name = path.split('/').pop() || path
      return [...prev, { path, name }]
    })
  }, [])

  const handleRemoveAttachment = useCallback((path: string) => {
    setFileAttachments(prev => prev.filter(f => f.path !== path))
  }, [])

  const handleImagePaste = useCallback(async (files: File[]) => {
    const images = filterImageFiles(files)
    if (images.length === 0) return
    const { accepted } = await processImageFiles(images)
    appendImageAttachments(accepted)
  }, [appendImageAttachments])

  const handleImageDrop = useCallback(async (files: File[]) => {
    const images = filterImageFiles(files)
    if (images.length === 0) return
    const { accepted } = await processImageFiles(images)
    appendImageAttachments(accepted)
  }, [appendImageAttachments])

  const handleRemoveImage = useCallback((index: number) => {
    setImageAttachments(prev => prev.filter((_, i) => i !== index))
  }, [])

  // #5560 — the QR-modal surface (linking-mode QR, per-session "Share" QR,
  // typeable pairing code, Discord pairing-link delivery) lives in `useQrModal`.
  // `handleShowQr` is consumed by the Tauri menu wiring directly below, so the
  // hook is called here (not lower with the rest of the modal handlers).
  const {
    qrModalOpen,
    setQrModalOpen,
    qrSvg,
    qrLoading,
    qrError,
    qrPairingCode,
    qrShareMode,
    handleShowQr,
    handleShareSession,
    handlePostPairLinkToDiscord,
  } = useQrModal(activeSessionId, pairingRefreshedCount)

  // #5560 — the macOS menu-bar wiring (#4695 / #4942) lives in
  // `useTauriMenuWiring`. No-op outside Tauri.
  useTauriMenuWiring({
    onNewSession: handleNewSession,
    onShowQr: handleShowQr,
    openSettings,
    setSidebarOpen,
    setPermissionMode,
  })

  // #5786 — approving a permission/plan or answering an AskUserQuestion is, like
  // sending, an explicit "show me the latest" action: snap the chat to the
  // bottom so the follow-up response scrolls into view even if the user had
  // scrolled up to read history. These wrappers forward to the underlying store
  // actions unchanged (same args, same return) and bump the same nonce
  // handleSend does — but AFTER the action runs and only when it was accepted
  // (sendPermissionResponse / sendUserQuestionResponse return false when the
  // socket isn't OPEN; review #5786). Bumping after the call lets the action's
  // store updates land first, so ChatView's RAF scroll runs once the follow-up
  // has rendered. A non-false result (incl. 'queued') still bumps — the message
  // will send and produce a response.
  const respondToPermission = useCallback<typeof sendPermissionResponse>((...args) => {
    const result = sendPermissionResponse(...args)
    if (result !== false) setScrollToBottomSignal(n => n + 1)
    return result
  }, [sendPermissionResponse])

  // #6287 — a SINGLE document-level keyboard listener for the permission
  // shortcuts, scoped to the FIRST unanswered prompt in the active session.
  // Replaces the per-instance keydown effect that PermissionPrompt used to
  // register: with multiple live prompts, Cmd+Y / Cmd+Shift+Y / Escape fired on
  // EVERY mounted prompt at once, answering all pending requests from one
  // keystroke (a security hazard). Answering the primary advances to the next.
  useChatKeyboard({
    storeMessages,
    resolvedPermissions,
    sendPermissionResponse: respondToPermission,
    activeSessionProvider,
    availableProviders,
    connected: connectionPhase === 'connected',
  })

  const respondToUserQuestion = useCallback<typeof sendUserQuestionResponse>((...args) => {
    const result = sendUserQuestionResponse(...args)
    if (result !== false) setScrollToBottomSignal(n => n + 1)
    return result
  }, [sendUserQuestionResponse])

  // #6222/#6224: respondToPermission (sendPermissionResponse) now marks the
  // prompt answered with the canonical decision token itself — only when the
  // answer actually went over the wire (after the disconnected-socket guard).
  // The previous explicit markPromptAnsweredByRequestId(requestId, 'Allowed')
  // here was both wrong-format (a display label, not the 'allow'/'deny' token
  // consumers expect) and unconditional (it ran even when the send was refused
  // while disconnected, falsely clearing the prompt). Dropped in favour of the
  // single choke point.
  const handleBannerApprove = useCallback((requestId: string, notificationId: string) => {
    respondToPermission(requestId, 'allow')
    dismissSessionNotification(notificationId)
  }, [respondToPermission, dismissSessionNotification])

  const handleBannerDeny = useCallback((requestId: string, notificationId: string) => {
    respondToPermission(requestId, 'deny')
    dismissSessionNotification(notificationId)
  }, [respondToPermission, dismissSessionNotification])

  // Retry reconnects to the *active* server (remote registry entry or local),
  // not unconditionally to local — see retryConnection / #5284.
  const handleRetry = useCallback(() => {
    retryConnection()
  }, [retryConnection])

  const handleStartServer = useCallback(() => {
    startServer()
  }, [])

  // #5791 — the active provider's advertised capabilities, so the renderer can
  // gate the claude-tui single-multiSelect form on the server's
  // `multiSelectReinject` bit (the CHROXY_TUI_MULTISELECT_REINJECT flag) rather
  // than the provider name alone — the client must not offer a form the server
  // would refuse.
  const activeSessionCaps = useMemo(
    () => availableProviders.find(p => p.name === activeSessionProvider)?.capabilities ?? null,
    [availableProviders, activeSessionProvider],
  )

  // #5560 — the custom chat-message renderer (permission prompts, question
  // prompts, tool bubbles/groups, evaluator banner, stall / resume chips) is
  // built by `useMessageRenderer`. Same deps array, same per-branch JSX.
  const renderMessage = useMessageRenderer({
    storeMsgMap,
    chatToolGroupPayloads,
    chatTailMessageId,
    // #5786 — wrapped so approve/answer also snaps the chat to the bottom.
    sendPermissionResponse: respondToPermission,
    sendUserQuestionResponse: respondToUserQuestion,
    markPromptAnswered,
    storeMessages,
    sendInput,
    streamStallTimeoutMs,
    allowMultiQuestionForm,
    activeSessionProvider,
    activeSessionCaps,
    setViewMode,
    stalledPromptIds,
    hasPendingAskUserQuestionPermission,
    sessions,
  })

  // #4412: registry-driven cheat sheet. Recomputed on every render —
  // not memoised, by design. The shortcut registry hook re-renders
  // whenever a binding changes, so reading registry.list() inside
  // the body picks up the new combos automatically. Memoising on
  // [shortcutRegistry] would silently skip rebinds because the
  // registry reference is stable. The work is cheap (constant-size
  // arrays, simple map) so re-running it per render is fine.
  // #5560 — the registry-driven cheat-sheet rows are built by the pure
  // `buildShortcutEntries` helper. Still called on every render (not memoised)
  // by design — see the helper's docblock (#4412).
  const SHORTCUTS: ShortcutEntry[] = buildShortcutEntries(shortcutRegistry, isMacPlatform(), isMacPlatform())

  // #5424: resolve the active model's context window once for the header
  // meter, the footer meter, and the percent computation. `null` when the
  // window is genuinely unknown (e.g. ollama deliberately reports none) —
  // the 200k fallback only applies to claude-backed providers, where it's
  // a real default rather than a fabricated number.
  const activeContextWindow = useMemo(() => {
    const modelInfo = availableModels.find(m => m.id === activeModel || m.fullId === activeModel)
    return resolveContextWindow(modelInfo, activeSessionProvider)
  }, [availableModels, activeModel, activeSessionProvider])

  // #6769: the context meter reads the OCCUPANCY SNAPSHOT, never the billing
  // `contextUsage` aggregate (which sums cache_read across agent-loop rounds
  // and over-reads window fill ≈N× on an N-round turn — the #6816 review
  // finding). The snapshot persists across turns and steps DOWN after a
  // compaction; providers with no snapshot (claude-cli / claude-tui / codex /
  // gemini — plus any byok-loop subclass, e.g. ollama, whose endpoint
  // reports no usage) yield null → the chips render their honest dash state.
  // (Compaction *markers* are #6768, a separate issue.)
  const contextTokens = useMemo(
    () => contextOccupancyTokens(contextOccupancy),
    [contextOccupancy],
  )

  // #6769: percent of the meter ceiling the conversation fills. The ceiling
  // is the SDK's real autoCompactThreshold when the snapshot carries one
  // (desktop /context parity); byok snapshots fall back to the documented
  // reserve below the registry-resolved window. Null when either the
  // snapshot or every window source is unknown — the chips then fall back
  // to the raw token-count text (#5424) or hide entirely.
  const contextPercent = useMemo(
    () => contextFillPercent(contextOccupancy, activeContextWindow),
    [contextOccupancy, activeContextWindow],
  )

  // Window total for the header meter label: prefer the snapshot's own
  // maxTokens (authoritative, SDK) over the registry-resolved window.
  const contextWindowForMeter = useMemo(
    () => contextOccupancy?.maxTokens ?? activeContextWindow,
    [contextOccupancy, activeContextWindow],
  )

  // #5184: human-readable model label for the `provider-model` cost-badge
  // mode. Prefer the server-supplied `label`; fall back to the raw model id
  // so a model missing from `availableModels` still shows something.
  const activeModelLabel = useMemo(() => {
    if (!activeModel) return undefined
    const modelInfo = availableModels.find(m => m.id === activeModel || m.fullId === activeModel)
    return modelInfo?.label ?? activeModel
  }, [activeModel, availableModels])

  const isConnected = connectionPhase === 'connected'
  // Point the Cmd+Shift+L shortcut at the live QR handler, gated on connection
  // (mirrors the footer/overflow `onShowQr={isConnected ? handleShowQr : undefined}`
  // surfaces). Assigning a ref during render is the standard latest-callback idiom
  // — no state update, no re-render.
  showQrRef.current = isConnected ? handleShowQr : null
  const isReconnecting = connectionPhase === 'reconnecting' || connectionPhase === 'server_restarting'
  // #5698 — the reconnect ladder gave up; terminal state, manual reconnect only.
  const isServerDown = connectionPhase === 'server_down'
  const isStartupError = connectionPhase === 'disconnected' && !!connectionError && sessions.length === 0
  const showWelcome = isConnected && sessions.length === 0

  // Track whether a configured tunnel is fully ready (connection info
  // available). Extracted to `useTunnelReady` (#5560).
  const tunnelReady = useTunnelReady(isConnected)

  // Fetch conversation history when welcome screen is shown
  useEffect(() => {
    if (showWelcome) fetchConversationHistory()
  }, [showWelcome, fetchConversationHistory])

  // Convert ConversationSummary[] to RecentSession[] for WelcomeScreen
  const recentSessions = useMemo(
    () => conversationHistory
      .filter(c => c.preview && c.cwd)
      .map(c => ({
        conversationId: c.conversationId,
        preview: c.preview!,
        cwd: c.cwd!,
        updatedAt: c.modifiedAtMs,
      })),
    [conversationHistory],
  )

  // #2836: show a soft banner during the Cloudflare DNS-propagation
  // window so the user knows why the QR isn't up yet.
  const isTunnelWarming =
    serverPhase === 'tunnel_warming' || serverPhase === 'tunnel_verifying'

  return (
    <div id="app" className={sidebarRepos.length > 0 ? 'with-sidebar' : ''}>
      {/* #6787 — desktop first-run setup wizard. Self-contained: resolves
          get_setup_state itself and renders null outside Tauri or once
          setup is complete, so it can sit unconditionally at the root. */}
      <SetupWizard />
      {/* #4873 — single page-level live region that announces only the
          SETTLED connection phase after a debounce. Replaces the
          per-status-dot role=status announcements that flooded SR
          users during reconnect storms. */}
      <ConnectionAnnouncer phase={connectionPhase} />
      {/* Reconnect banner */}
      <ReconnectBanner
        visible={isReconnecting || isServerDown}
        attempt={connectionRetryCount}
        maxAttempts={5}
        message={
          isServerDown
            ? 'Server appears to be down'
            : connectionPhase === 'server_restarting' ? 'Server restarting...' : undefined
        }
        terminal={isServerDown}
        restartEtaMs={connectionPhase === 'server_restarting' ? restartEtaMs : null}
        restartingSince={connectionPhase === 'server_restarting' ? restartingSince : null}
        shutdownReason={connectionPhase === 'server_restarting' ? shutdownReason : null}
        onRetry={handleRetry}
        onStartServer={isTauri() ? handleStartServer : undefined}
      />

      {/* Tunnel warming banner — shown during Cloudflare DNS propagation (#2836).
          Always rendered as a fixed-height slot to avoid layout shift when toggled (#2915). */}
      <div
        className={`tunnel-warming-banner${isTunnelWarming ? '' : ' tunnel-warming-banner--hidden'}`}
        data-testid="tunnel-warming-banner"
        role="status"
        aria-live="polite"
        aria-hidden={isTunnelWarming ? undefined : true}
      >
        {isTunnelWarming ? (
          <>
            Tunnel warming up
            {tunnelProgress
              ? `… attempt ${tunnelProgress.attempt}/${tunnelProgress.maxAttempts}`
              : '…'}{' '}
            (QR will appear shortly)
          </>
        ) : null}
      </div>

      {/* Exposure warning banner (#5356) — server reported a non-loopback
          bind and/or a public quick tunnel in auth_ok. Dismissible per
          connection; no defaults are changed by this banner. */}
      {serverExposure && !exposureBannerDismissed && (
        <ExposureWarningBanner
          lanBind={serverExposure.lanBind}
          quickTunnel={serverExposure.quickTunnel}
          onDismiss={dismissExposureBanner}
        />
      )}

      {/* #5821 — billing-canary warnings (silent metered default; claude-tui
          reclassification tripwire) during the 2026-06-15 credit window. */}
      {billingCanary && billingCanary.warnings.length > 0 && (
        <BillingWarningBanner
          warnings={billingCanary.warnings}
          dismissed={billingBannerDismissed}
          onDismiss={dismissBillingBanner}
        />
      )}

      {/* #5560 — the two-row header (#5200) is grouped into the presentational
          <AppHeader>. App owns the state + the shared `formatContext`. */}
      <AppHeader
        serverVersion={serverVersion}
        connectionPhase={connectionPhase}
        chatActivityState={chatActivity.state}
        serverPhase={serverPhase}
        isConnected={isConnected}
        tunnelReady={tunnelReady}
        showModelPicker={dropdownFlags.showModelPicker}
        availableModels={availableModels}
        activeModel={activeModel}
        defaultModelId={defaultModelId}
        onModelChange={setModel}
        readOnlyModel={dropdownFlags.readOnlyModel}
        availablePermissionModes={availablePermissionModes}
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        showPermissionMode={dropdownFlags.showPermissionMode}
        showThinkingLevel={dropdownFlags.showThinkingLevel}
        thinkingLevel={thinkingLevel}
        onThinkingLevelChange={(level) => setThinkingLevel(level as 'default' | 'high' | 'max')}
        sessionNotifications={sessionNotifications}
        onSwitchSession={handleSwitchSession}
        onMarkNotificationRead={markSessionNotificationRead}
        onMarkAllNotificationsRead={markAllSessionNotificationsRead}
        onDismissNotification={dismissSessionNotification}
        onNewSession={handleNewSession}
        onNewShell={userShellSupported ? handleNewShell : undefined}
        onRevokeToken={tokenRevokeSupported ? handleRevokeToken : undefined}
        onToggleSkillsPanel={() => {
          setSkillsPanelOpen(prev => {
            const next = !prev
            if (next) requestListSkills()
            return next
          })
        }}
        onShowQr={isConnected ? handleShowQr : undefined}
        showCopyTranscript={viewMode === 'chat' && storeMessages.length > 0}
        transcriptCopied={transcriptCopied}
        onCopyTranscript={handleCopyTranscript}
        onOpenSettings={openSettings}
        cost={sessionCost ?? undefined}
        context={formatContext(contextOccupancy)}
        contextPercent={contextPercent}
        contextTokens={contextTokens ?? undefined}
        contextEstimated={contextOccupancy?.source === 'final-round-prompt'}
        inputTokens={contextUsage?.inputTokens}
        outputTokens={contextUsage?.outputTokens}
        contextWindow={activeModel ? contextWindowForMeter ?? undefined : undefined}
        isBusy={!isIdle}
        agentCount={activeAgents.length}
        provider={sessions.find(s => s.sessionId === activeSessionId)?.provider}
        modelLabel={activeModelLabel}
        costBadgeMode={costBadgeMode}
        devPreviews={devPreviews}
        onCloseDevPreview={closeDevPreview}
      />

      {/* Sidebar */}
      {sidebarRepos.length > 0 && (
        <Sidebar
          repos={sidebarRepos}
          activeSessionId={activeSessionId}
          isOpen={sidebarOpen}
          width={sidebarWidth}
          filter={sidebarFilter}
          serverStatus={isConnected ? 'connected' : isReconnecting ? 'reconnecting' : 'disconnected'}
          chatActivityState={chatActivity.state}
          tunnelUrl={null}
          connectedClients={connectedClients}
          activePrimaryClientId={resolveActivePrimaryClientId(activeSessionId, sessionStates, globalPrimaryClientId)}
          activeSessionRole={activeSessionRole}
          onTakeOverPrimary={() => { if (activeSessionId) claimPrimary(activeSessionId, { force: true }) }}
          onFilterChange={setSidebarFilter}
          onSessionClick={handleSwitchSession}
          onResumeSession={resumeConversation}
          onOpenControlRoom={openControlRoom}
          onNewSession={(cwd) => openCreateSession({ cwd: cwd || null })}
          onToggle={() => setSidebarOpen(prev => !prev)}
          onWidthChange={(w: number) => { setSidebarWidth(w); persistSidebarWidth(w) }}
          onContextMenu={handleSidebarContextMenu}
          searchResults={searchResults}
          searchLoading={searchLoading}
          searchQuery={searchQuery}
          searchConversations={searchConversations}
          clearSearchResults={clearSearchResults}
          sessions={sessions}
          monthlyBudget={monthlyBudget}
          initialPanelHeight={loadPersistedSidebarPanelHeight() ?? 200}
          initialPanelView={loadPersistedSidebarPanelView()}
          initialPanelCollapsed={loadPersistedSidebarPanelCollapsed()}
          onReorderRepos={handleReorderRepos}
          onReorderSessions={handleReorderSidebarSessions}
        />
      )}

      {/* Main content wrapper (when sidebar present) */}
      <div className={sidebarRepos.length > 0 ? 'main-wrapper' : undefined}>
        {/* Session bar. #5204 — also rendered when the Control Room tab is
            open even if there are no sessions, so the pinned CR tab (and its
            close) is always reachable. */}
        {(sessionTabs.length > 0 || controlRoomOpen) && (
          <SessionBar
            sessions={sessionTabs}
            onSwitch={handleSwitchSession}
            onClose={handleCloseSession}
            onRename={renameSession}
            onNewSession={handleNewSession}
            onReorder={handleReorderTabs}
            controlRoom={{
              open: controlRoomOpen,
              active: controlRoomActive,
              onActivate: openControlRoom,
              onClose: closeControlRoom,
            }}
            pendingPermissionTotal={pendingPermissionTotal}
            onJumpToPending={handleJumpToPending}
          />
        )}

        {/* Stdin forwarding lost banner (#3567) — render the latched
            `stdinForwardingDisabled` flag from session_list metadata for the
            currently-active session. The flag persists across server restarts
            (#3540 / #3564), so this banner appears immediately after a
            cold-restart reconnect without needing a fresh `error` event. */}
        <StdinDisabledBanner
          visible={!!sessions.find(s => s.sessionId === activeSessionId)?.stdinForwardingDisabled}
          sessionId={activeSessionId}
          onRestart={handleRestartSession}
        />

        {/* Startup error screen — shown when server failed to start (Tauri).
            #5211 — suppressed while the Control Room tab is active so the two
            don't double-render; the CR shows its own not-connected affordance
            (disabled Refresh + hint) and the operator can close it to reach
            this screen. */}
        {isStartupError && !controlRoomActive && (
          <StartupErrorScreen
            error={connectionError}
            logs={serverStartupLogs}
            onRetry={handleRetry}
            onStartServer={isTauri() ? handleStartServer : undefined}
          />
        )}

        {/* Disconnected screen — shown when not connected with no error (e.g.
            server stopped). #5211 — suppressed while the Control Room tab is
            active (mutually exclusive with the CR view, which renders its own
            not-connected state). */}
        {connectionPhase === 'disconnected' && !connectionError && !isConnected && sessions.length === 0 && !controlRoomActive && (
          <div className="startup-error-screen" data-testid="disconnected-screen">
            <div className="startup-error-content">
              <h2 className="startup-error-title">Disconnected</h2>
              <p className="startup-error-message">Not connected to a Chroxy server.</p>
              <div className="startup-error-actions">
                {isTauri() && (
                  <button
                    className="startup-error-retry-btn startup-error-start-btn"
                    onClick={handleStartServer}
                    type="button"
                    data-testid="disconnected-start-server-button"
                  >
                    Start Server
                  </button>
                )}
                <button
                  className="startup-error-retry-btn"
                  onClick={handleRetry}
                  type="button"
                >
                  Reconnect
                </button>
              </div>
            </div>
          </div>
        )}

        {/* #5204 — Control Room top-level view. Session-independent: it
            renders in place of the session UI / welcome screen while active,
            and switching back to a session restores it untouched. Takes
            precedence over the welcome screen so the operator can open the CR
            even with zero sessions. */}
        {/* #5211 — the CR owns the main area whenever active (any connection
            phase). It renders its own empty/loading + not-connected states, so
            it stays put across reconnects instead of blanking or
            double-rendering with the disconnected/startup screens. */}
        {controlRoomActive && (
          <div className="main-content" data-testid="control-room-main">
            <ControlRoomView
              onInvestigate={handleInvestigate}
              onOpenSession={handleOpenSession}
              onConfigureRepo={handleConfigureRepo}
              // #5544 — the Settings tab embeds the converged preference body.
              // Closed→open via a Settings entry point mounts straight onto the
              // Settings tab (`initialTab`); an entry-point click while the CR
              // is already open bumps `settingsRedirectNonce` so the view jumps
              // to Settings even from another tab.
              initialTab={controlRoomInitialTab}
              forceTab="settings"
              forceTabNonce={settingsRedirectNonce}
              showConsoleTab={showConsoleTab}
              onToggleConsoleTab={(show) => {
                setShowConsoleTab(show)
                persistShowConsoleTab(show)
              }}
              interventionPingEnabled={interventionPingEnabled}
              onToggleInterventionPing={(enabled) => {
                setInterventionPingEnabled(enabled)
                persistInterventionPing(enabled)
              }}
            />
          </div>
        )}

        {/* Welcome screen — shown when connected but no sessions */}
        {showWelcome && !controlRoomActive && (
          <WelcomeScreen
            onNewSession={handleNewSession}
            recentSessions={recentSessions}
            onResumeSession={resumeConversation}
            className="main-content"
          />
        )}

        {/* #5510 (epic #5509): pairing-approval primitive — host-level
            approve/deny banner for camera-less device pair requests. */}
        <PendingPairRequests
          requests={pendingPairRequests}
          onApprove={approvePairRequest}
          onDeny={denyPairRequest}
        />

        {/* Cross-session notification banners */}
        {sessionNotifications.length > 0 && (
          <NotificationBanners
            notifications={sessionNotifications}
            onApprove={handleBannerApprove}
            onDeny={handleBannerDeny}
            onDismiss={dismissSessionNotification}
            onSwitchSession={handleSwitchSession}
          />
        )}

        {/* Normal session UI. #5204 — suppressed while the Control Room tab
            is active (the CR view above takes the main content area). */}
        {!showWelcome && !controlRoomActive && (
          <>
            {/* View switcher */}
            <ViewSwitcher
              viewMode={viewMode}
              setViewMode={setViewMode}
              splitMode={splitMode}
              setSplitMode={setSplitMode}
              persistSplitMode={persistSplitMode}
              showChatTab={!isUserShell}
              showTerminalTab={isPtyProvider}
              showConsoleTab={showConsoleTab}
              unreadSystemCount={unreadSystemCount}
              checkpointsOpen={checkpointsOpen}
              setCheckpointsOpen={setCheckpointsOpen}
              compactChatFilter={compactChatFilter}
              onToggleCompactChatFilter={toggleCompactChatFilter}
            />

            {/* Main content */}
            <div className={`main-content${checkpointsOpen ? ' with-checkpoint-panel' : ''}`}>
              <div className="main-content-primary">
                {/* #4982 — banner for session_error{code:'SESSION_NOT_FOUND'}.
                    Sits above whatever pane is showing (loading skeleton,
                    chat view, empty state) so the operator sees it on the
                    first frame after the lost-id rejection. Cleared by
                    Dismiss OR by switchSession (the operator picked a new
                    live id). */}
                {sessionNotFoundError && (
                  <SessionNotFoundChip
                    message={sessionNotFoundError.message}
                    attemptedSessionId={sessionNotFoundError.attemptedSessionId}
                    onDismiss={dismissSessionNotFoundError}
                  />
                )}
                {connectionPhase === 'connecting' ? (
                  <SessionLoadingSkeleton label="Connecting..." />
                ) : isSwitchingSession ? (
                  <SessionLoadingSkeleton label="Switching session..." />
                ) : splitMode ? (
                  <SplitPane
                    direction={splitMode}
                    first={
                      <ChatView
                        messages={chatMessages}
                        isStreaming={streamingMessageId !== null}
                        isBusy={!isIdle}
                        chatActivityState={chatActivity.state}
                        renderMessage={renderMessage}
                        scrollToBottomSignal={scrollToBottomSignal}
                        queuedIds={queuedIds}
                        onCancelQueued={onCancelQueued}
                        workingLabel={workingLabel}
                        inFlightToolColor={inFlightToolColor}
                        openSearchSignal={openSearchSignal}
                        getSearchText={chatSearchText}
                      />
                    }
                    second={
                      <MultiTerminalView
                        sessions={sessions}
                        activeSessionId={activeSessionId}
                        className="terminal-container"
                      />
                    }
                    onReset={() => {
                      /* double-click resets to 50/50 — handled by react-resizable-panels */
                    }}
                  />
                ) : (
                  <>
                    {/*
                      #4305 — Chat and Output stay mounted; the inactive
                      pane is hidden with display:none rather than
                      unmounted. Previously each tab switch unmounted
                      ChatView, which reset every ToolGroup/ToolBubble's
                      local `expanded` state (and dropped scroll position)
                      causing the visible "re-fold jump" the issue
                      describes. Keeping both mounted preserves
                      user-toggled expand state, the isTail-driven
                      tail-expanded state, and the chat scroll position
                      across tab switches. Mirrors the same pattern
                      MultiTerminalView already uses to preserve per-
                      session terminal state.
                    */}
                    <div
                      data-testid="chat-pane"
                      style={{
                        display: viewMode === 'chat' ? 'contents' : 'none',
                      }}
                    >
                      <ChatView
                        messages={chatMessages}
                        isStreaming={streamingMessageId !== null}
                        isBusy={!isIdle}
                        chatActivityState={chatActivity.state}
                        renderMessage={renderMessage}
                        hidden={viewMode !== 'chat'}
                        scrollToBottomSignal={scrollToBottomSignal}
                        queuedIds={queuedIds}
                        onCancelQueued={onCancelQueued}
                        workingLabel={workingLabel}
                        inFlightToolColor={inFlightToolColor}
                        openSearchSignal={openSearchSignal}
                        getSearchText={chatSearchText}
                      />
                    </div>
                    <div
                      data-testid="terminal-pane"
                      style={{
                        display: viewMode === 'terminal' ? 'contents' : 'none',
                      }}
                    >
                      <MultiTerminalView
                        sessions={sessions}
                        activeSessionId={activeSessionId}
                        className="terminal-container"
                      />
                    </div>
                  </>
                )}
                {viewMode === 'files' && connectionPhase !== 'connecting' && !isSwitchingSession && (
                  <FileBrowserPanel />
                )}
                {/*
                  #4397 — system tab uses the same display:none kept-alive
                  pattern as the chat/output toggle above (#4305). Pre-fix,
                  switching chat → system → chat unmounted the system
                  ChatView and dropped its scroll position + any expand
                  state on system-side tool groups. The wrapper is mounted
                  whenever the connection is ready, so React preserves the
                  ChatView instance (and its hooks-local scroll state)
                  across tab switches in either direction.
                */}
                {connectionPhase !== 'connecting' && !isSwitchingSession && (
                  <div
                    data-testid="system-pane"
                    style={{
                      display: viewMode === 'system' ? 'contents' : 'none',
                    }}
                  >
                    <ChatView
                      messages={systemMessages}
                      isStreaming={false}
                      isBusy={false}
                      renderMessage={renderMessage}
                      hidden={viewMode !== 'system'}
                    />
                  </div>
                )}
                {viewMode === 'console' && connectionPhase !== 'connecting' && !isSwitchingSession && (
                  <ConsolePage />
                )}
                {viewMode === 'snapshots' && connectionPhase !== 'connecting' && !isSwitchingSession && (
                  <SnapshotsPanel />
                )}
                {viewMode === 'pool' && connectionPhase !== 'connecting' && !isSwitchingSession && (
                  <PoolStatsPanel />
                )}
                {viewMode === 'pages' && connectionPhase !== 'connecting' && !isSwitchingSession && (
                  <PagesPanel />
                )}
                {/* #5204 — the Control Room moved out of the per-session view
                    area into a dedicated top-level tab (rendered above). */}
              </div>
              {checkpointsOpen && (
                <div className="checkpoint-panel">
                  <CheckpointTimeline />
                </div>
              )}
              {viewMode === 'diff' && connectionPhase !== 'connecting' && !isSwitchingSession && <DiffViewerPanel />}
            </div>

            {/* Agent monitor — shows when agents are active */}
            {activeAgents.length > 0 && <AgentMonitorPanel />}

            {/* Plan approval */}
            {isPlanPending && (
              <PlanApproval
                planHtml={planHtml}
                onApprove={handlePlanApprove}
                onFeedback={handlePlanFeedback}
              />
            )}

            {/* #3188 auto-evaluator clarify prompt. Inline block above
              the input bar; submitting fires sendInput (a fresh
              user_input round-trip) — the addUserMessage path clears
              pendingEvaluatorClarify so the block disappears, and the
              server re-evaluates the new draft. */}
            {pendingEvaluatorClarify && (
              <EvaluatorClarifyPrompt
                evaluatorIteration={pendingEvaluatorClarify.evaluatorIteration}
                originalDraft={pendingEvaluatorClarify.originalDraft}
                clarification={pendingEvaluatorClarify.clarification}
                reasoning={pendingEvaluatorClarify.reasoning}
                onSubmit={(answer) => sendInput(answer)}
              />
            )}

            {/* Activity indicator (#3758) — "Working… last activity Ns ago"
                so users can distinguish a still-active long turn from a
                stalled one. Self-gates on busy/idle; renders nothing when
                idle. Sits immediately above the input bar. */}
            <ActivityIndicator />

            {/* Check-in chip (#3899) — soft inactivity prompt with a one-
                click "Status update?" follow-up. Self-gates on the active
                session's inactivityWarning slot; renders nothing when none
                is outstanding. Stacks below the activity indicator so the
                user sees "still working, but quiet" with a single
                actionable affordance. */}
            <CheckInChip />

            {/* Input bar */}
            <InputBar
              onSend={handleSend}
              onInterrupt={handleInterrupt}
              disabled={!isConnected}
              isBusy={!isIdle}
              isStreaming={streamingMessageId !== null}
              chatActivityState={chatActivity.state}
              placeholder={isConnected ? `Type a message... (${inputSettings.chatEnterToSend ? 'Enter' : formatShortcutKeys('Cmd+Enter')} to send)` : 'Connecting...'}
              controlledValue={inputDraftValue}
              onValueChange={handleDraftChange}
              filePickerFiles={filePickerFiles}
              mcpResources={mcpResources}
              onFileTrigger={fetchFileList}
              attachments={fileAttachments}
              onRemoveAttachment={handleRemoveAttachment}
              slashCommands={orderedSlashCommands}
              onSlashTrigger={fetchSlashCommands}
              onImagePaste={handleImagePaste}
              onImageDrop={handleImageDrop}
              imageAttachments={imageAttachments}
              onRemoveImage={handleRemoveImage}
              onFileAttach={handleFileSelect}
              sendOnEnter={inputSettings.chatEnterToSend}
              voiceInput={voiceInput.isAvailable ? voiceInput : undefined}
              onEvaluate={isConnected ? evaluateDraft : undefined}
              onLargePaste={handleLargePaste}
              pastedTextBlocks={pastedTextBlocks}
              onInspectPastedText={handleInspectPastedText}
              onRemovePastedText={handleRemovePastedText}
              userMessageHistory={userMessageHistory}
              // #4306 — only highlight when the active provider actually
              // honours the magic thinking keyword. Reuses `showThinkingLevel`
              // (capabilities.thinkingLevel) as the truth-source: if the
              // dropdown is hidden because the provider can't take a thinking
              // budget, the keyword wouldn't escalate either — so we must
              // not visually imply otherwise.
              highlightThinkingKeywords={dropdownFlags.showThinkingLevel}
            />
          </>
        )}
      </div>

      {/* Footer bar */}
      <FooterBar
        connectionPhase={connectionPhase}
        chatActivityState={chatActivity.state}
        tunnelReady={tunnelReady}
        serverPhase={serverPhase}
        tunnelProgress={tunnelProgress}
        serverVersion={serverVersion}
        cwd={activeSessionCwd ?? sessionCwd ?? undefined}
        model={activeModel || undefined}
        cost={sessionCost ?? undefined}
        context={formatContext(contextOccupancy)}
        contextPercent={contextPercent}
        contextEstimated={contextOccupancy?.source === 'final-round-prompt'}
        inputTokens={contextUsage?.inputTokens}
        outputTokens={contextUsage?.outputTokens}
        isBusy={!isIdle}
        agentCount={activeAgents.length}
        onShowQr={isConnected ? handleShowQr : undefined}
        onShareSession={isConnected && activeSessionId ? handleShareSession : undefined}
        provider={sessions.find(s => s.sessionId === activeSessionId)?.provider}
        // #5424: null when the window is genuinely unknown (e.g. ollama) —
        // the model tooltip then omits the context-window sentence instead
        // of claiming a fabricated 200k. #6769: prefers the snapshot's own
        // maxTokens (authoritative) when a snapshot carries one.
        contextWindow={contextWindowForMeter ?? undefined}
        // #3857: surface a clickable "/compact" suggestion past 80% so the
        // user gets a remedy hint rather than just a red bar. Only enabled
        // when there's an active session to route the input through — without
        // that, the chip would have nowhere to send /compact to.
        onCompact={isConnected && activeSessionId ? () => sendInput('/compact') : undefined}
        // #4653: the active session's chroxy-side intervention ring. Empty
        // by default — the chip hides itself when nothing has fired.
        interventions={interventions}
        // #4653: threaded so the panel collapses on session switch (the
        // FooterBar instance is shared across sessions, so without this
        // the open panel would persist with stale entries).
        activeSessionId={activeSessionId}
      />

      {/* #5560 — the top-level overlay / modal stack is grouped into the
          presentational <AppModals>. App still owns all the state; these are
          leaf overlays separate from the main-content / terminal subtree. */}
      <AppModals
        settingsOpen={settingsOpen}
        onSettingsClose={() => setSettingsOpen(false)}
        showConsoleTab={showConsoleTab}
        onToggleConsoleTab={(show) => { setShowConsoleTab(show); persistShowConsoleTab(show) }}
        interventionPingEnabled={interventionPingEnabled}
        onToggleInterventionPing={(enabled) => { setInterventionPingEnabled(enabled); persistInterventionPing(enabled) }}
        shortcutHelpOpen={shortcutHelpOpen}
        onShortcutHelpClose={() => setShortcutHelpOpen(false)}
        shortcuts={SHORTCUTS}
        inspectedPastedTextId={inspectedPastedTextId}
        pastedTextBlocks={pastedTextBlocks}
        onPastedTextClose={() => setInspectedPastedTextId(null)}
        onRemovePastedText={handleRemovePastedText}
        qrModalOpen={qrModalOpen}
        onQrClose={() => setQrModalOpen(false)}
        qrSvg={qrSvg}
        qrLoading={qrLoading}
        qrError={qrError}
        qrShareMode={qrShareMode}
        qrPairingCode={qrPairingCode}
        onPostPairLinkToDiscord={handlePostPairLinkToDiscord}
        skillsPanelOpen={skillsPanelOpen}
        skills={activeSkills}
        skillsCanToggle={!!sessions.find(s => s.sessionId === activeSessionId)?.capabilities?.skillToggle}
        mismatchedSkillNames={mismatchedSet}
        onActivateSkill={activateSkill}
        onDeactivateSkill={deactivateSkill}
        onAcceptSkillTrust={skillTrustAcceptSupported ? acceptSkillTrust : undefined}
        pendingCommunitySkills={activePendingCommunitySkills}
        onGrantSkillTrust={skillTrustGrantSupported ? grantCommunitySkillTrust : undefined}
        skillsPanelCapabilities={{ skillTrustGrant: skillTrustGrantSupported }}
        pendingTrustGrants={activePendingTrustGrants}
        onSkillsPanelClose={() => setSkillsPanelOpen(false)}
        sidebarContextMenu={sidebarContextMenu}
        sidebarContextMenuItems={sidebarContextMenuItems}
        onDismissSidebarContextMenu={dismissSidebarContextMenu}
        showCreateSession={showCreateSession}
        onCreateSessionClose={() => { setShowCreateSession(false); setIsCreatingSession(false); setSessionCreateError(null); pendingSeedPromptRef.current = null }}
        onCreateSession={handleCreateSession}
        createSessionInitialCwd={pendingCwd}
        knownCwds={knownCwds}
        existingSessionNames={sessions.map(s => s.name)}
        sessionCreateError={sessionCreateError ?? undefined}
        isCreatingSession={isCreatingSession}
        repoPresetDrawer={repoPresetDrawer}
        onRepoPresetDrawerClose={() => setRepoPresetDrawer(null)}
        closeConfirmOpen={closeConfirmSessionId !== null}
        closeConfirmMessage={(() => {
          const name = sessions.find(s => s.sessionId === closeConfirmSessionId)?.name
          return name
            ? `Close "${name}"? The Claude process will be terminated.`
            : 'Close this session? The Claude process will be terminated.'
        })()}
        onCloseConfirm={() => {
          if (closeConfirmSessionId) performCloseSession(closeConfirmSessionId)
          setCloseConfirmSessionId(null)
        }}
        onCloseConfirmCancel={() => setCloseConfirmSessionId(null)}
        toastItems={toastItems}
        onToastDismiss={(id) => {
          // #4075: cost-threshold toast IDs are routed via the per-session
          // dismissedAt latch; everything else falls through to the
          // existing server-error / info-notification dismissal paths.
          if (id.startsWith('cost-threshold-')) {
            const sid = id.slice('cost-threshold-'.length)
            const states = useConnectionStore.getState().sessionStates
            const ss = states[sid]
            if (ss?.costThresholdWarning) {
              useConnectionStore.setState({
                sessionStates: {
                  ...states,
                  [sid]: {
                    ...ss,
                    costThresholdWarning: { ...ss.costThresholdWarning, dismissedAt: Date.now() },
                  },
                },
              })
            }
            return
          }
          const item = toastItems.find(t => t.id === id)
          if (!item) return
          if (item.level === 'error') {
            dismissServerError(id)
          } else {
            dismissInfoNotification(id)
          }
        }}
        commands={trackedCommands}
        paletteOpen={paletteOpen}
        onPaletteClose={() => setPaletteOpen(false)}
        mruList={paletteOpen ? getMruCommands() : undefined}
      />
      <FileOpenPalette
        isOpen={fileOpenPaletteOpen}
        onClose={() => setFileOpenPaletteOpen(false)}
      />
      <SymbolSearchPalette
        isOpen={symbolSearchOpen}
        onClose={() => setSymbolSearchOpen(false)}
      />
      <CodeSearchPalette
        isOpen={codeSearchOpen}
        onClose={() => setCodeSearchOpen(false)}
      />
      <ReferencesPalette
        isOpen={ideEnabled && referencesOpen}
        onClose={() => useConnectionStore.setState({ referencesOpen: false })}
      />
    </div>
  )
}
