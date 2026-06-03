/**
 * App — root component wiring all dashboard components to the Zustand store.
 *
 * Auto-connects to the server on mount using the injected config + auth cookie.
 * Layout: header → session bar → view switcher → main content → input bar.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  DEFAULT_CONTEXT_WINDOW,
  deriveSessionVisualStatus,
  formatPasteMarker,
  expandPasteMarkers,
  type SessionInfo,
} from '@chroxy/store-core'
import { useConnectionStore } from './store/connection'
import type { BaseSessionState } from '@chroxy/store-core'
import type { ChatViewMessage } from './components/ChatView'

import { Sidebar, type RepoNode, type ContextMenuTarget } from './components/Sidebar'
import { SessionContextMenu, type ContextMenuItem } from './components/SessionContextMenu'
import { buildSidebarContextMenuItems } from './sidebarContextMenuItems'
import { CommandPalette } from './components/CommandPalette'
import { useCommands, recordMruCommand, getMruCommands } from './store/commands'
import { ChatView } from './components/ChatView'
import { MultiTerminalView } from './components/MultiTerminalView'
import { InputBar, type FileAttachment, type ImageAttachment } from './components/InputBar'
import { useVoiceInput } from './hooks/useVoiceInput'
import { toWireAttachments } from './utils/attachment-utils'
import { processImageFiles, filterImageFiles } from './utils/image-utils'
import { getAuthToken } from './utils/auth'
import { SessionBar, type SessionTabData, type SessionStatus } from './components/SessionBar'
import { StatusBar } from './components/StatusBar'
import { ChatSettingsDropdown } from './components/ChatSettingsDropdown'
import { SkillsPanel } from './components/SkillsPanel'
import { HeaderOverflowMenu, type HeaderOverflowItem } from './components/HeaderOverflowMenu'
import { NotificationsWidget } from './components/NotificationsWidget'
import { PermissionPrompt } from './components/PermissionPrompt'
import { formatTranscript } from './lib/transcript'
import { QuestionPrompt } from './components/QuestionPrompt'
import { ActivityIndicator } from './components/ActivityIndicator'
import { CheckInChip } from './components/CheckInChip'
import { ToolBubble } from './components/ToolBubble'
import { ToolGroup } from './components/ToolGroup'
import { PastedTextModal } from './components/PastedTextModal'
import { EvaluatorRewriteBanner, EvaluatorClarifyPrompt } from './components/EvaluatorPrompts'
import { StreamStallChip } from './components/StreamStallChip'
import { AskUserQuestionStallChip } from './components/AskUserQuestionStallChip'
import { ResumeUnknownChip } from './components/ResumeUnknownChip'
import { SessionNotFoundChip } from './components/SessionNotFoundChip'
import { PlanApproval } from './components/PlanApproval'
import { ReconnectBanner } from './components/ReconnectBanner'
import { ConnectionAnnouncer } from './components/ConnectionAnnouncer'
import { StdinDisabledBanner } from './components/StdinDisabledBanner'
import { WelcomeScreen } from './components/WelcomeScreen'
import { CreateSessionModal } from './components/CreateSessionModal'
import { NotificationBanners } from './components/NotificationBanners'
import { Toast, type ToastItem } from './components/Toast'
import { FileBrowserPanel } from './components/FileBrowserPanel'
import { CheckpointTimeline } from './components/CheckpointTimeline'
import { FooterBar } from './components/FooterBar'
import { QrModal } from './components/QrModal'
import { SettingsPanel } from './components/SettingsPanel'
import { ShortcutHelp, type ShortcutEntry } from './components/ShortcutHelp'
import { formatShortcutKeys, isMacPlatform } from './utils/platform'
import { useShortcutRegistry } from './shortcuts/useShortcutRegistry'
import { formatBindingForDisplay, parseBinding } from './shortcuts/registry'
import { writeText as clipboardWriteText } from './utils/clipboard'
import { formatQuestionAnswerSummary } from './utils/questionAnswerSummary'
import { useTauriEvents } from './hooks/useTauriEvents'
import { useTauriMenuEvents } from './hooks/useTauriMenuEvents'
import { isTauri } from './utils/tauri'
import { startServer, revealInFinder } from './hooks/useTauriIPC'
import { usePermissionNotification, type PermissionPromptInfo } from './hooks/usePermissionNotification'
import { useShortcutDispatch } from './hooks/useShortcutDispatch'
import { useChatMessages, toChatViewMessage } from './hooks/useChatMessages'
import { SplitPane, type SplitDirection } from './components/SplitPane'
import { persistSidebarWidth, loadPersistedSidebarWidth, persistSplitMode, loadPersistedSplitMode, persistShowConsoleTab, loadPersistedShowConsoleTab, loadPersistedSidebarPanelHeight, loadPersistedSidebarPanelView, loadPersistedSidebarPanelCollapsed, loadPersistedSidebarRepoOrder, loadPersistedSidebarSessionOrder, persistSidebarRepoOrder, persistSidebarSessionOrder, persistSessionTabOrder, loadPersistedSessionTabOrder } from './store/persistence'
import { applyOrderById } from './utils/reorderById'
import { DiffViewerPanel } from './components/DiffViewerPanel'
import { AgentMonitorPanel } from './components/AgentMonitorPanel'
import { SessionLoadingSkeleton } from './components/SessionLoadingSkeleton'
import { StartupErrorScreen } from './components/StartupErrorScreen'
import { ConsolePage } from './components/ConsolePage'
import { EnvironmentPanel } from './components/EnvironmentPanel'

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
 * Format context usage as a compact string.
 *
 * Trims trailing `.0` on round kilo totals (90000 → `90k tokens`, not
 * `90.0k tokens`) so the chip text stays in lockstep with the
 * `formatTokens` helper in `lib/status-tooltips.ts` — both the chip
 * label and the breakdown inside its tooltip use the same rule. Without
 * this, the same tooltip would read `... (90.0k tokens) ... Breakdown:
 * ... = 90k tokens.` (#4230 Copilot review).
 */
function formatContext(usage: { inputTokens: number; outputTokens: number } | null): string | undefined {
  if (!usage) return undefined
  const total = usage.inputTokens + usage.outputTokens
  if (total === 0) return undefined
  if (total < 1000) return `${total} tokens`
  const k = total / 1000
  return Number.isInteger(k) ? `${k}k tokens` : `${k.toFixed(1)}k tokens`
}

type ViewMode = 'chat' | 'terminal' | 'files' | 'diff' | 'system' | 'console' | 'environments'

/** Scrollable tab bar with arrow buttons when overflowing */
function ViewSwitcher({
  viewMode, setViewMode, splitMode, setSplitMode, persistSplitMode,
  showConsoleTab, unreadSystemCount, checkpointsOpen, setCheckpointsOpen,
}: {
  viewMode: string
  setViewMode: (m: ViewMode) => void
  splitMode: SplitDirection | null
  setSplitMode: (m: SplitDirection | null) => void
  persistSplitMode: (m: SplitDirection | null) => void
  showConsoleTab: boolean
  unreadSystemCount: number
  checkpointsOpen: boolean
  setCheckpointsOpen: (fn: (prev: boolean) => boolean) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const dragState = useRef<{ isDragging: boolean; startX: number; scrollLeft: number }>({
    isDragging: false, startX: 0, scrollLeft: 0,
  })

  const updateArrows = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 1)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    updateArrows()
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(updateArrows)
      ro.observe(el)
    }
    el.addEventListener('scroll', updateArrows, { passive: true })
    return () => { ro?.disconnect(); el.removeEventListener('scroll', updateArrows) }
  }, [updateArrows, showConsoleTab, unreadSystemCount])

  const scroll = useCallback((dir: number) => {
    const el = scrollRef.current
    if (!el) return
    // Scroll by one tab width (use the first tab's width as reference)
    const tabWidth = el.querySelector('.view-tab')?.getBoundingClientRect().width ?? 100
    el.scrollBy({ left: dir * (tabWidth + 8), behavior: 'smooth' })
  }, [])

  // Drag-to-scroll handlers
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Only drag on the container background, not on buttons or their children
    if ((e.target as HTMLElement).closest('button')) return
    const el = scrollRef.current
    if (!el) return
    dragState.current = { isDragging: true, startX: e.clientX, scrollLeft: el.scrollLeft }
    el.setPointerCapture(e.pointerId)
    el.style.cursor = 'grabbing'
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current.isDragging) return
    const el = scrollRef.current
    if (!el) return
    const dx = e.clientX - dragState.current.startX
    el.scrollLeft = dragState.current.scrollLeft - dx
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current.isDragging) return
    dragState.current.isDragging = false
    const el = scrollRef.current
    if (!el) return
    el.releasePointerCapture(e.pointerId)
    el.style.cursor = ''
  }, [])

  return (
    <div className="view-switch-wrapper">
      {canScrollLeft && (
        <button className="view-switch-arrow view-switch-arrow-left" onClick={() => scroll(-1)} type="button" aria-label="Scroll tabs left">‹</button>
      )}
      <div
        className="view-switch"
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <button className={`view-tab${viewMode === 'chat' && !splitMode ? ' active' : ''}`} onClick={() => { setViewMode('chat'); setSplitMode(null); persistSplitMode(null) }} type="button">Chat</button>
        <button className={`view-tab${viewMode === 'terminal' && !splitMode ? ' active' : ''}`} onClick={() => { setViewMode('terminal'); setSplitMode(null); persistSplitMode(null) }} type="button">Output</button>
        <button
          className={`view-tab${splitMode ? ' active' : ''}`}
          onClick={() => { const next: SplitDirection | null = splitMode ? null : 'horizontal'; setSplitMode(next); persistSplitMode(next) }}
          type="button" title={`Split view (${formatShortcutKeys('Cmd+\\')})`}
        >Split</button>
        <button className={`view-tab${viewMode === 'files' ? ' active' : ''}`} onClick={() => setViewMode('files')} type="button">Files</button>
        <button className={`view-tab${viewMode === 'system' ? ' active' : ''}`} onClick={() => { setViewMode('system'); setSplitMode(null); persistSplitMode(null) }} type="button">
          System{unreadSystemCount > 0 && <span className="system-badge">{unreadSystemCount}</span>}
        </button>
        {showConsoleTab && (
          <button className={`view-tab${viewMode === 'console' ? ' active' : ''}`} onClick={() => { setViewMode('console'); setSplitMode(null); persistSplitMode(null) }} type="button">Console</button>
        )}
        <button className={`view-tab${viewMode === 'environments' ? ' active' : ''}`} onClick={() => { setViewMode('environments'); setSplitMode(null); persistSplitMode(null) }} type="button">Envs</button>
        <div className="view-switch-spacer" />
        <button className={`view-tab view-tab-right${checkpointsOpen ? ' active' : ''}`} onClick={() => setCheckpointsOpen(prev => !prev)} type="button" title="Toggle checkpoint timeline">Checkpoints</button>
        <button className={`view-tab${viewMode === 'diff' ? ' active' : ''}`} onClick={() => setViewMode('diff')} type="button">Diff</button>
      </div>
      {canScrollRight && (
        <button className="view-switch-arrow view-switch-arrow-right" onClick={() => scroll(1)} type="button" aria-label="Scroll tabs right">›</button>
      )}
    </div>
  )
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
  const defaultCwd = useConnectionStore(s => s.defaultCwd)
  const sessions = useConnectionStore(s => s.sessions)
  const sessionStates = useConnectionStore(s => s.sessionStates)
  const activeSessionId = useConnectionStore(s => s.activeSessionId)
  const viewMode = useConnectionStore(s => s.viewMode)
  const availableModels = useConnectionStore(s => s.availableModels)
  const availableModelsProvider = useConnectionStore(s => s.availableModelsProvider)
  const defaultModelId = useConnectionStore(s => s.defaultModelId)
  const availablePermissionModes = useConnectionStore(s => s.availablePermissionModes)
  const availableProviders = useConnectionStore(s => s.availableProviders)
  const serverErrors = useConnectionStore(s => s.serverErrors)
  const infoNotifications = useConnectionStore(s => s.infoNotifications ?? [])
  const connectionError = useConnectionStore(s => s.connectionError)
  const serverPhase = useConnectionStore(s => s.serverPhase)
  const tunnelProgress = useConnectionStore(s => s.tunnelProgress)
  const serverStartupLogs = useConnectionStore(s => s.serverStartupLogs)
  const connectionRetryCount = useConnectionStore(s => s.connectionRetryCount)
  const filePickerFiles = useConnectionStore(s => s.filePickerFiles)
  const sessionNotifications = useConnectionStore(s => s.sessionNotifications)
  const inputSettings = useConnectionStore(s => s.inputSettings)
  const connectedClients = useConnectionStore(s => s.connectedClients)
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
    activeModel,
    permissionMode,
    contextUsage,
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
  } = useConnectionStore(useShallow(s => s.getActiveSessionState()))

  // #3205: stable Set for SkillsPanel mismatch indicator. useMemo
  // keyed by the array reference so the Set only re-derives when the
  // store actually mutated the list (skill_changed event fired).
  const mismatchedSet = useMemo(
    () => new Set(activeMismatched || []),
    [activeMismatched],
  )

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
  const allowMultiQuestionForm = useMemo(
    () => activeSessionProvider != null && activeSessionProvider !== 'claude-tui' && activeSessionProvider !== 'claude-cli',
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
      // BOTH allow and deny — gate only flips off for allow variants.
      if (m.answered === 'allow' || m.answered === 'allowSession') continue
      // Cross-client decision via `resolvedPermissions[requestId]` —
      // same allow-only rule.
      const decision = resolvedPermissions?.[m.requestId]
      if (decision === 'allow' || decision === 'allowSession') continue
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

  // Store actions (stable refs)
  const connect = useConnectionStore(s => s.connect)
  const sendInput = useConnectionStore(s => s.sendInput)
  const sendInterrupt = useConnectionStore(s => s.sendInterrupt)
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
  const setViewMode = useConnectionStore(s => s.setViewMode)
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
  const markPromptAnsweredByRequestId = useConnectionStore(s => s.markPromptAnsweredByRequestId)
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
  const commands = useCommands()
  const [paletteOpen, setPaletteOpen] = useState(false)

  // Local state
  const [showCreateSession, setShowCreateSession] = useState(false)
  const [pendingCwd, setPendingCwd] = useState<string | null>(null)
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  const [sessionCreateError, setSessionCreateError] = useState<string | null>(null)
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([])
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('settings') === '1'
  })
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(() => loadPersistedSidebarWidth() ?? 240)
  const [sidebarFilter, setSidebarFilter] = useState('')
  // #4832 — user-defined order for the sidebar's repo groups and the
  // sessions inside each group. Both are layered on top of the
  // server-supplied session list and persisted in localStorage so they
  // survive reload + Tauri restart. State sits at App-level so the
  // `sidebarRepos` memo below can apply the order to the derived
  // RepoNode[].
  const [sidebarRepoOrder, setSidebarRepoOrder] = useState<string[]>(() => loadPersistedSidebarRepoOrder())
  const [sidebarSessionOrder, setSidebarSessionOrder] = useState<Record<string, string[]>>(() => loadPersistedSidebarSessionOrder())
  // #4045: sidebar right-click context menu state. `null` when closed.
  const [sidebarContextMenu, setSidebarContextMenu] = useState<{
    target: ContextMenuTarget
    x: number
    y: number
  } | null>(null)
  const [splitMode, setSplitMode] = useState<SplitDirection | null>(() => loadPersistedSplitMode())
  const [checkpointsOpen, setCheckpointsOpen] = useState(false)

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
  const [showConsoleTab, setShowConsoleTab] = useState(() => {
    return loadPersistedShowConsoleTab()
  })
  const [isSwitchingSession, setIsSwitchingSession] = useState(false)

  // Clear the switching flag once the active session actually changes
  useEffect(() => {
    setIsSwitchingSession(false)
  }, [activeSessionId])

  const handleSwitchSession = useCallback((sessionId: string) => {
    if (sessionId === activeSessionId) return
    setIsSwitchingSession(true)
    switchSession(sessionId)
  }, [switchSession, activeSessionId])

  const handleCloseSession = useCallback((sessionId: string) => {
    if (!window.confirm('Close this session? The Claude process will be terminated.')) return
    // #3800: evict the per-session composer state (draft + collapsed-paste
    // blocks + next-id counter) so the refs further down don't leak the
    // pasted-text content for the lifetime of <App />. `handleSend` already
    // evicts on send; this closes the parallel path on session teardown.
    // The sessions-list reconciliation effect (#3977) is the belt-and-braces
    // backstop for server-driven removals, but evicting synchronously here
    // keeps the cleanup tied to the click.
    evictSessionComposerState(sessionId)
    destroySession(sessionId)
  }, [destroySession])

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
        setPendingCwd(cwd)
        setShowCreateSession(true)
      },
      confirmCloseSession: handleCloseSession,
    })
  }, [
    sidebarContextMenu,
    sessions,
    conversationHistory,
    createSession,
    resumeConversation,
    handleCloseSession,
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
    setPaletteOpen,
    setSidebarOpen,
    setSettingsOpen,
    setShowCreateSession,
    setShortcutHelpOpen,
    handleSwitchSession,
    handleCloseSession,
    handleCopyTranscript,
    sendInterrupt,
    setPermissionMode,
    appendImageAttachments,
  })

  const trackedCommands = useMemo(
    () => commands.map(cmd => ({
      ...cmd,
      action: () => {
        recordMruCommand(cmd.id)
        // Override commands that need App-level state
        if (cmd.id === 'new-session') {
          setShowCreateSession(true)
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
  useEffect(() => {
    const token = getAuthToken()
    if (token) {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const wsUrl = `${proto}://${window.location.host}/ws`
      connect(wsUrl, token)
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
  })

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

  // #4831 — user-defined SessionBar tab order (overlay on the server's
  // `sessions[]` membership). Loaded lazily from localStorage on mount and
  // re-persisted whenever the user drags / keyboard-reorders a tab. The
  // server is still authoritative for which sessions EXIST; this slice
  // controls only the visual order in the top tab strip (issue #4831).
  const [tabOrder, setTabOrder] = useState<string[]>(() => loadPersistedSessionTabOrder())
  // #4831 — `loadPersistedSessionTabOrder` reads under the *current*
  // server scope (set by `setServerScope` on server-switch). The initial
  // `useState` only fires once on mount, so without this effect a server
  // switch in the same browser tab would leave SessionBar showing the
  // previous server's tabOrder until a full page refresh. Re-load whenever
  // the active server changes so each server gets its own persisted order.
  const activeServerId = useConnectionStore(s => s.activeServerId)
  useEffect(() => {
    setTabOrder(loadPersistedSessionTabOrder())
  }, [activeServerId])
  // #4940 — same server-switch refresh for the sidebar repo / per-repo
  // session orders declared above (see lines around the `sidebarRepoOrder`
  // useState). The persistence layer is already server-scoped via
  // `scopedKey` / `scopedRead`, but the App-level state was initialised
  // once and never re-read. Without this effect, switching servers via
  // the ServerPicker left server A's drag-ordering applied to server B's
  // sidebar until a full page reload, silently bypassing the scoping.
  useEffect(() => {
    setSidebarRepoOrder(loadPersistedSidebarRepoOrder())
    setSidebarSessionOrder(loadPersistedSidebarSessionOrder())
  }, [activeServerId])
  const handleReorderTabs = useCallback((nextOrder: string[]) => {
    setTabOrder(nextOrder)
    persistSessionTabOrder(nextOrder)
  }, [])

  // Map sessions to SessionTabData[] with unified status indicators.
  //
  // #4831: apply the persisted `tabOrder` overlay. Sessions present in
  // `tabOrder` render in that order; sessions added by the server since
  // the last reorder (new tabs, restored conversations) fall through to
  // the server's natural order at the end. Stale ids in `tabOrder` (server
  // removed the session) are harmlessly ignored because we filter against
  // the live `sessions` list.
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
      }))
    },
    [sessions, activeSessionId, getSessionVisualStatus, tabOrder],
  )

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

  // #4832 — reorder callbacks wired into the Sidebar component. Both
  // persist immediately so a reload (or Tauri restart) restores the
  // order. We update local state synchronously so the UI reflects the
  // new order on the next render without waiting for a round-trip.
  const handleReorderRepos = useCallback((orderedPaths: string[]) => {
    setSidebarRepoOrder(orderedPaths)
    persistSidebarRepoOrder(orderedPaths)
  }, [])

  const handleReorderSidebarSessions = useCallback((repoPath: string, orderedIds: string[]) => {
    setSidebarSessionOrder(prev => {
      const next = { ...prev, [repoPath]: orderedIds }
      persistSidebarSessionOrder(next)
      return next
    })
  }, [])

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
    sendInput(expanded, wire.length > 0 ? wire : undefined)
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
  }, [sendInput, fileAttachments, imageAttachments, activeSessionId])

  const handleInterrupt = useCallback(() => {
    sendInterrupt()
  }, [sendInterrupt])

  const handleNewSession = useCallback(() => {
    setPendingCwd(null)
    setShowCreateSession(true)
  }, [])

  // #4695 — bridge the macOS menu bar "File > New Session" item to
  // `handleNewSession` (the same callback the chrome "New Session"
  // button uses). The sidebar's per-project "+" row and the command
  // palette's `new-session` entry currently open the create-session
  // dialog through their own inline handlers, so they are NOT routed
  // through this hook. Hook is a no-op outside Tauri (web dashboard).
  useTauriMenuEvents({ onNewSession: handleNewSession })

  const handleCreateSession = useCallback((data: { name: string; cwd: string; provider?: string; permissionMode?: string; model?: string; worktree?: boolean; skipPermissions?: boolean }) => {
    setSessionCreateError(null)
    setIsCreatingSession(true)
    createSession({ name: data.name, cwd: data.cwd || undefined, provider: data.provider, model: data.model, permissionMode: data.permissionMode, worktree: data.worktree, skipPermissions: data.skipPermissions })
  }, [createSession])

  const handlePlanApprove = useCallback(() => {
    sendInput('approve')
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

  const fetchQrInto = useCallback(async (path: string) => {
    setQrModalOpen(true)
    setQrLoading(true)
    setQrError(null)
    setQrSvg(null)
    const token = getAuthToken()
    if (!token) {
      setQrLoading(false)
      setQrError('No auth token available')
      return
    }
    try {
      const res = await fetch(path, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Request failed' }))
        setQrError(body.error || `HTTP ${res.status}`)
        setQrSvg(null)
      } else {
        const svg = await res.text()
        setQrSvg(svg)
        setQrError(null)
      }
    } catch (err) {
      setQrError(err instanceof Error ? err.message : 'Failed to fetch QR code')
      setQrSvg(null)
    } finally {
      setQrLoading(false)
    }
  }, [])

  const handleShowQr = useCallback(() => fetchQrInto('/qr'), [fetchQrInto])

  // #3070: per-session "Share this session" QR. Issues a token bound to the
  // active session — the scanner can chat into it but cannot list/switch
  // others. Distinct from the linking-mode QR above, which lets the paired
  // device manage every session.
  const [qrShareMode, setQrShareMode] = useState<'link' | 'share'>('link')
  const handleShareSession = useCallback(() => {
    if (!activeSessionId) return
    setQrShareMode('share')
    void fetchQrInto(`/qr/session/${encodeURIComponent(activeSessionId)}`)
  }, [activeSessionId, fetchQrInto])
  // Reset share-mode label whenever the modal reopens via the regular QR
  // button so the title reflects the actual content.
  useEffect(() => {
    if (qrModalOpen && qrShareMode === 'share') return
    if (!qrModalOpen) setQrShareMode('link')
  }, [qrModalOpen, qrShareMode])

  // Auto-refresh QR when the server regenerates the pairing ID (#2916).
  // Only refresh while the modal is open — guarding on qrSvg would reopen
  // the modal after the user closes it if qrSvg was not cleared on close.
  useEffect(() => {
    if (pairingRefreshedCount === 0) return
    if (!qrModalOpen) return
    handleShowQr()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairingRefreshedCount])

  const handleBannerApprove = useCallback((requestId: string, notificationId: string) => {
    sendPermissionResponse(requestId, 'allow')
    markPromptAnsweredByRequestId(requestId, 'Allowed')
    dismissSessionNotification(notificationId)
  }, [sendPermissionResponse, markPromptAnsweredByRequestId, dismissSessionNotification])

  const handleBannerDeny = useCallback((requestId: string, notificationId: string) => {
    sendPermissionResponse(requestId, 'deny')
    markPromptAnsweredByRequestId(requestId, 'Denied')
    dismissSessionNotification(notificationId)
  }, [sendPermissionResponse, markPromptAnsweredByRequestId, dismissSessionNotification])

  const handleRetry = useCallback(() => {
    const token = getAuthToken()
    if (!token) return
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${proto}://${window.location.host}/ws`
    connect(wsUrl, token)
  }, [connect])

  const handleStartServer = useCallback(() => {
    startServer()
  }, [])

  // Custom message renderer for permission prompts and tool bubbles.
  // `chatTailMessageId` is sourced from `useChatMessages` above (#4770).
  const renderMessage = useCallback((msg: ChatViewMessage) => {
    // Tool-group synthetic row (#3747) — id is a group key, not a store id.
    if (msg.type === 'tool_group') {
      const payload = chatToolGroupPayloads.get(msg.id)
      if (!payload) return null
      // #4305 — keep the trailing group expanded so the Chat tab matches
      // Output-tab chronology when a turn ends on a tool run with no
      // follow-up summary.
      return (
        <ToolGroup
          messages={payload.messages}
          isActive={payload.isActive}
          isTail={msg.id === chatTailMessageId}
        />
      )
    }
    const storeMsg = storeMsgMap.get(msg.id)
    if (!storeMsg) return null

    // Permission prompt
    if (storeMsg.requestId && storeMsg.expiresAt && !storeMsg.answered) {
      // #3619 wall-clock site (kept on `Date.now()` intentionally).
      // `storeMsg.expiresAt` is computed at receipt as
      // `Date.now() + msg.remainingMs` in `message-handler.ts`, so this
      // subtraction is wall-clock-vs-wall-clock — both sides use the
      // same clock, no mixing. Switching this site to `performance.now()`
      // would subtract a process-local monotonic clock from a wall-clock
      // anchor and produce garbage. Wall-clock jumps after receipt do
      // change `Date.now()` and therefore affect each re-computation
      // here — that is correct behavior for a wall-clock anchor.
      // Whatever value falls out is what feeds `<PermissionPrompt>`'s
      // local countdown anchor as its initial `remainingMs` prop.
      const remainingMs = Math.max(0, storeMsg.expiresAt - Date.now())
      return (
        <PermissionPrompt
          requestId={storeMsg.requestId}
          tool={storeMsg.tool || 'Unknown'}
          description={storeMsg.content}
          remainingMs={remainingMs}
          onRespond={(reqId, decision) => sendPermissionResponse(reqId, decision)}
        />
      )
    }

    // Question prompt (options or free-text fallback)
    if (storeMsg.type === 'prompt' && storeMsg.options && !storeMsg.requestId) {
      // #4615 — suppress unanswered prompts that have been invalidated by
      // a subsequent ASK_USER_QUESTION_STALL. The chip rendered for the
      // stall error carries the retry affordance; leaving the interactive
      // prompt visible would let the user submit answers into a dead
      // _pendingUserAnswer slot. Already-answered prompts still render
      // (their answer summary is part of chat history).
      if (stalledPromptIds.has(storeMsg.id)) return null
      return (
        <QuestionPrompt
          question={storeMsg.content}
          options={storeMsg.options}
          questions={storeMsg.questions}
          answered={storeMsg.answered}
          // #4735 / #4731 — SDK / BYOK / Codex / Gemini sessions get the
          // interactive MultiQuestionForm; TUI / CLI sessions keep the
          // #4666 deferred notice (their permission-hook still denies
          // multi-question forms per #4648). Derivation lives at
          // `allowMultiQuestionForm` above so the flag flips correctly
          // on session-switch without a full re-render of every prompt.
          allowMultiQuestion={allowMultiQuestionForm}
          // #4685 — gate the question content render on the matching
          // AskUserQuestion permission_request being resolved. Pre-fix
          // the user_question card rendered the moment the wire event
          // arrived (which the server emits in parallel with the
          // permission_request), leaking the model-supplied question
          // text + options before the user had a chance to click Allow.
          // The derivation `hasPendingAskUserQuestionPermission` scans
          // the same session's messages for any AskUserQuestion
          // permission prompt that is still unresolved on both this
          // client and across clients. Already-answered prompts skip the
          // gate so post-answer chat history renders normally.
          pendingPermission={!storeMsg.answered && hasPendingAskUserQuestionPermission}
          onSelect={(answer) => {
            // #4604 Chunk B / #4735 — answer is `string` for
            // single-question / free-text paths and
            // `Record<string, string | string[]>` for multi-question
            // forms (multi-select values are native arrays on the
            // widened wire). sendUserQuestionResponse handles both
            // shapes; markPromptAnswered records a string summary on
            // the bubble so the post-answer collapse UI has something
            // readable to show.
            sendUserQuestionResponse(answer, storeMsg.toolUseId)
            markPromptAnswered(storeMsg.id, formatQuestionAnswerSummary(answer))
          }}
        />
      )
    }

    // Tool bubble
    if (storeMsg.type === 'tool_use' && storeMsg.toolUseId) {
      // #4313 — singleton activity runs (a single trailing tool_use)
      // bypass the ToolGroup path entirely: `chatToolGroupPayloads`
      // only collapses contiguous runs of 2+ messages (see above,
      // ~line 897). Pass the same `isTail` signal that ToolGroup uses
      // (#4309) so the Chat tab's last item matches Output-tab
      // chronology in the 1-tool case too. Without this, a turn
      // shaped `summary text -> 1 trailing tool` skipped the #4309
      // mitigation entirely and the trailing tool rendered collapsed
      // while Output still showed it inline.
      return (
        <ToolBubble
          toolName={storeMsg.tool || 'Tool'}
          toolUseId={storeMsg.toolUseId}
          input={storeMsg.toolInput}
          inputPartial={storeMsg.toolInputPartial}
          result={storeMsg.toolResult}
          serverName={storeMsg.serverName}
          isTail={msg.id === chatTailMessageId}
          resultImages={storeMsg.toolResultImages}
        />
      )
    }

    // #3188: auto-evaluator rewrite banner. The system message is pushed
    // by the dashboard's `evaluator_rewrite` handler and persisted in
    // the per-session localStorage cache (`sessionMessagesKey` in
    // packages/dashboard/src/store/persistence.ts). Reconnect/replay
    // re-renders the banner from that cached metadata — no need to
    // re-fire the transient wire event.
    if (storeMsg.type === 'system' && storeMsg.evaluator?.kind === 'rewrite') {
      return <EvaluatorRewriteBanner meta={storeMsg.evaluator} />
    }

    // #4476: distinct chip for stream-stall errors (server PR #4475 emits
    // `error{code: 'stream_stall'}` after the configured inactivity window).
    // Generic red bubble reads as "broken"; this affordance signals
    // "recoverable, just retry" and offers a one-tap resend of the last
    // user message. Only render the retry button when the stall is the
    // most recent bubble (chatTailMessageId) — replayed historical stalls
    // surface the chip text + tooltip for diagnostics, but resending an
    // ancient user_input from a long-finished turn would be misleading.
    //
    // #4603: thread the active session's provider through so the chip
    // headline can carry a short label ("SDK · ...", "CLI · ...") for
    // one-glance triage, and hand the View-logs affordance a closure
    // that switches the view to the System pane (where session-level
    // context lives). The View-logs button is only shown on the tail
    // entry — replaying historical stalls shouldn't offer to jump the
    // operator out of the chat for an old event.
    if (storeMsg.type === 'error' && storeMsg.code === 'stream_stall') {
      const isTail = msg.id === chatTailMessageId
      const lastUserInput = isTail
        ? [...storeMessages].reverse().find(m => m.type === 'user_input')
        : undefined
      return (
        <StreamStallChip
          errorText={storeMsg.content}
          onRetry={lastUserInput ? () => sendInput(lastUserInput.content) : undefined}
          timeoutMs={streamStallTimeoutMs ?? undefined}
          provider={activeSessionProvider ?? undefined}
          onViewLogs={isTail ? () => setViewMode('system') : undefined}
        />
      )
    }

    // #4615: dedicated chip for ASK_USER_QUESTION_STALL errors. The server
    // emits `error{code: 'ASK_USER_QUESTION_STALL'}` (PR #4614) when the
    // Claude TUI never acknowledges an AskUserQuestion answer — typically
    // a multi-question form wedge. Generic red toast reads as "broken";
    // this affordance signals "recoverable, just retry your original
    // request" and offers a one-tap resend of the last user message.
    // Mirrors the StreamStallChip pattern (#4476): retry only on tail
    // entries so replayed historical stalls show the chip + tooltip for
    // diagnostics but don't offer a misleading resend button.
    if (storeMsg.type === 'error' && storeMsg.code === 'ASK_USER_QUESTION_STALL') {
      const isTail = msg.id === chatTailMessageId
      const lastUserInput = isTail
        ? [...storeMessages].reverse().find(m => m.type === 'user_input')
        : undefined
      return (
        <AskUserQuestionStallChip
          errorText={storeMsg.content}
          onRetry={lastUserInput ? () => sendInput(lastUserInput.content) : undefined}
        />
      )
    }

    // #4947: dedicated chip for `error{code: 'resume_unknown'}` errors
    // (server PR #4944). The server emits this when the claude CLI rejects
    // a `--resume <id>` because the conversation id is unknown locally
    // (operator wiped ~/.claude/projects/ between chroxy boots, restored a
    // state file from a different machine, etc.). CliSession has ALREADY
    // auto-fallen-back to a fresh conversation by the time this lands —
    // the chip explains that and (when present) surfaces
    // `attemptedResumeId` as subtext for operator correlation against
    // `~/.chroxy/session-state.json.resumeConversationId`. Distinct from
    // the stream_stall / ASK_USER_QUESTION_STALL chips because no retry
    // affordance is needed: the fresh conversation is already running.
    // Mirrors the chip pattern for consistency with the recoverable-error
    // visual language.
    if (storeMsg.type === 'error' && storeMsg.code === 'resume_unknown') {
      return (
        <ResumeUnknownChip
          errorText={storeMsg.content}
          attemptedResumeId={storeMsg.attemptedResumeId}
        />
      )
    }

    // Default rendering
    return null
  }, [storeMsgMap, chatToolGroupPayloads, chatTailMessageId, sendPermissionResponse, sendUserQuestionResponse, markPromptAnswered, storeMessages, sendInput, streamStallTimeoutMs, allowMultiQuestionForm, activeSessionProvider, setViewMode, stalledPromptIds, hasPendingAskUserQuestionPermission])

  // #4412: registry-driven cheat sheet. Recomputed on every render —
  // not memoised, by design. The shortcut registry hook re-renders
  // whenever a binding changes, so reading registry.list() inside
  // the body picks up the new combos automatically. Memoising on
  // [shortcutRegistry] would silently skip rebinds because the
  // registry reference is stable. The work is cheap (constant-size
  // arrays, simple map) so re-running it per render is fine.
  const isMacForCheatsheet = isMacPlatform()
  const SHORTCUTS: ShortcutEntry[] = (() => {
    // Section labels mirror the Settings panel groupings so the cheat
    // sheet and customization UI stay coherent.
    const CATEGORY_TO_SECTION: Record<string, string> = {
      navigation: 'Global',
      view: 'Global',
      session: 'Session',
      sidebar: 'Sidebar',
      composer: 'Input',
      other: 'Global',
    }
    // Cmd+1-9 collapse: nine separate rows would bloat the cheat
    // sheet without adding signal. Emit a single "Cmd+1-9" row whose
    // keys reflect the registry's current first-digit binding so a
    // rebind (e.g. moving them to Alt+1-9) is still visible.
    //
    // #4432 — only collapse when all nine bindings share the same
    // modifier set AND each `session.switch.N` has key `N`. If any
    // entry diverges (e.g. user rebinds only session.switch.1 to
    // Cmd+Q) the cheat sheet would otherwise show a misleading
    // "Cmd+Q-9" label, so we fall back to nine individual rows.
    const tabSwitchEntries = Array.from({ length: 9 }, (_, i) =>
      shortcutRegistry.get(`session.switch.${i + 1}`),
    )
    const tabSwitchAligned = (() => {
      const first = tabSwitchEntries[0]
      if (!first) return false
      const firstParsed = parseBinding(first.binding)
      if (firstParsed.key !== '1') return false
      for (let i = 0; i < tabSwitchEntries.length; i += 1) {
        const entry = tabSwitchEntries[i]
        if (!entry) return false
        const parsed = parseBinding(entry.binding)
        if (parsed.key !== String(i + 1)) return false
        if (
          parsed.meta !== firstParsed.meta ||
          parsed.shift !== firstParsed.shift ||
          parsed.alt !== firstParsed.alt
        ) return false
      }
      return true
    })()
    const tabSwitch1 = tabSwitchEntries[0]
    const tabSwitchKeys = tabSwitch1
      ? formatBindingForDisplay(tabSwitch1.binding, isMacForCheatsheet).replace(/1$/, '1-9')
      : 'Cmd+1-9'
    const registryRows: ShortcutEntry[] = []
    for (const entry of shortcutRegistry.list()) {
      // When aligned: skip the 2..9 tab-switch entries — they're
      // collapsed into one row driven by session.switch.1 below.
      // When diverged: render all nine individually so each rebind is
      // visible.
      if (/^session\.switch\.[2-9]$/.test(entry.id)) {
        if (tabSwitchAligned) continue
        registryRows.push({
          keys: formatBindingForDisplay(entry.binding, isMacForCheatsheet),
          description: entry.description,
          section: CATEGORY_TO_SECTION[entry.category] || 'Global',
        })
        continue
      }
      if (entry.id === 'session.switch.1') {
        if (tabSwitchAligned) {
          registryRows.push({
            keys: tabSwitchKeys,
            description: 'Switch to tab by number',
            section: CATEGORY_TO_SECTION[entry.category] || 'Global',
          })
        } else {
          registryRows.push({
            keys: formatBindingForDisplay(entry.binding, isMacForCheatsheet),
            description: entry.description,
            section: CATEGORY_TO_SECTION[entry.category] || 'Global',
          })
        }
        continue
      }
      registryRows.push({
        keys: formatBindingForDisplay(entry.binding, isMacForCheatsheet),
        description: entry.description,
        section: CATEGORY_TO_SECTION[entry.category] || 'Global',
      })
    }
    // Non-registry entries: permission shortcuts (handled inside the
    // permission prompt UI), composer send (handled in InputBar),
    // Escape (handled per-modal), and the Tauri image-paste shortcut.
    // None of these live in the global keydown ladder so they don't
    // belong in the registry.
    const extraEntries: ShortcutEntry[] = [
      { keys: 'Cmd+Y', description: 'Allow current permission prompt', section: 'Session' },
      { keys: 'Cmd+Shift+Y', description: 'Allow current permission prompt for this session (rule-eligible tools)', section: 'Session' },
      { keys: 'Cmd+Enter', description: 'Send message', section: 'Input' },
      { keys: 'Escape', description: 'Close modal / cancel', section: 'Global' },
    ]
    // #3748 — Ctrl+V (image-paste) only works in the Tauri desktop on
    // macOS; on other platforms Ctrl+V is the native text-paste
    // shortcut. Show the entry only where the shortcut is actually
    // wired.
    if (isTauri() && isMacPlatform()) {
      extraEntries.push({
        keys: 'Ctrl+V',
        description: 'Paste image from clipboard (Cmd+V stays as text paste)',
        section: 'Input',
      })
    }
    return [...registryRows, ...extraEntries].map(entry => ({ ...entry, keys: formatShortcutKeys(entry.keys) }))
  })()

  // Compute context window usage percentage from active model metadata
  const contextPercent = useMemo(() => {
    if (!contextUsage) return null
    const total = contextUsage.inputTokens + contextUsage.outputTokens
    if (total === 0) return null
    const modelInfo = availableModels.find(m => m.id === activeModel || m.fullId === activeModel)
    const contextWindow = modelInfo?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    return (total / contextWindow) * 100
  }, [contextUsage, activeModel, availableModels])

  const isConnected = connectionPhase === 'connected'
  const isReconnecting = connectionPhase === 'reconnecting' || connectionPhase === 'server_restarting'
  const isStartupError = connectionPhase === 'disconnected' && !!connectionError && sessions.length === 0
  const showWelcome = isConnected && sessions.length === 0

  // Track whether a configured tunnel is fully ready (connection info available)
  const [tunnelReady, setTunnelReady] = useState(true)
  useEffect(() => {
    if (!isConnected) { setTunnelReady(true); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    async function checkTunnel() {
      try {
        const { getServerInfo } = await import('./hooks/useTauriIPC')
        const info = await getServerInfo()
        // Only track tunnel readiness if tunnel mode is configured
        if (!info || info.tunnelMode === 'none') { setTunnelReady(true); return }
      } catch {
        // Not in Tauri — check /connect directly
      }
      try {
        const { getAuthToken } = await import('./utils/auth')
        const token = getAuthToken()
        if (!token) return
        const res = await fetch('/connect', { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) { if (!cancelled) setTunnelReady(true); return }
      } catch { /* ignore */ }
      if (!cancelled) { setTunnelReady(false); timer = setTimeout(checkTunnel, 3000) }
    }
    checkTunnel()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [isConnected])

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
      {/* #4873 — single page-level live region that announces only the
          SETTLED connection phase after a debounce. Replaces the
          per-status-dot role=status announcements that flooded SR
          users during reconnect storms. */}
      <ConnectionAnnouncer phase={connectionPhase} />
      {/* Reconnect banner */}
      <ReconnectBanner
        visible={isReconnecting}
        attempt={connectionRetryCount}
        maxAttempts={5}
        message={connectionPhase === 'server_restarting' ? 'Server restarting...' : undefined}
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

      {/* Header */}
      <header id="header">
        <div className="header-left">
          <span className="logo">Chroxy</span>
          {/* #4630 — version + status-dot were bare spans with no
              discoverable label, leaving Tauri/WKWebView and SR users with
              nothing on hover. Pair `title` (browser hover tooltip) with
              `aria-label` (screen-reader announcement) so both surfaces
              get a label.
              #4873 — the status dot intentionally does NOT carry
              `role="status"`. role=status implies aria-live=polite,
              which made reconnect-storm churn (connecting →
              reconnecting → connected → reconnecting…) verbally hammer
              SR users with every intermediate transition. aria-label
              alone keeps the dot discoverable on focus/hover, and the
              page-level debounced ConnectionAnnouncer (mounted above)
              announces only the settled phase. */}
          {(() => {
            const versionLabel = `Chroxy server v${serverVersion ?? __APP_VERSION__}`
            return (
              <span
                className="version-badge"
                title={versionLabel}
                aria-label={versionLabel}
              >
                v{serverVersion ?? __APP_VERSION__}
              </span>
            )
          })()}
          {(() => {
            const warming = serverPhase === 'tunnel_warming' || serverPhase === 'tunnel_verifying' || (isConnected && !tunnelReady && serverPhase == null)
            const phase = warming ? 'connecting' : connectionPhase
            const STATUS_LABELS: Record<string, string> = {
              connected: 'Connected to Chroxy server',
              connecting: warming ? 'Tunnel warming up…' : 'Connecting to Chroxy server…',
              reconnecting: 'Reconnecting to Chroxy server…',
              server_restarting: 'Server restarting…',
              disconnected: 'Disconnected from Chroxy server',
            }
            const label = STATUS_LABELS[phase] ?? `Connection status: ${phase}`
            return (
              <span
                className={`status-dot ${phase}`}
                title={label}
                aria-label={label}
              />
            )
          })()}
        </div>
        <div className="header-center">
          <ChatSettingsDropdown
            availableModels={dropdownFlags.showModelPicker ? availableModels : []}
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
            onThinkingLevelChange={level => setThinkingLevel(level as 'default' | 'high' | 'max')}
          />
        </div>
        <div className="header-right">
          {/* #4695 — prominent always-visible New Session entry point.
              Previously the affordance lived only on the per-project
              sidebar row (`sidebar-new-session-<path>`) and inside the
              command palette, neither of which a first-time user finds
              by scanning the chrome. This button and the macOS menu-bar
              "File > New Session" item both invoke `handleNewSession`,
              which clears `pendingCwd` and opens the create-session
              dialog without a preselected project. The sidebar's "+"
              row and the palette's `new-session` command each have
              their own inline handlers (the sidebar passes a cwd; the
              palette opens the dialog directly), so they share the end
              state (`setShowCreateSession(true)`) but not this
              callback. */}
          <button
            type="button"
            className="chrome-new-session-btn"
            data-testid="chrome-new-session"
            onClick={handleNewSession}
            aria-label="New session"
            title={`New session (${formatShortcutKeys('Cmd+N')})`}
          >
            <span className="chrome-new-session-icon" aria-hidden="true">+</span>
            <span className="chrome-new-session-label">New Session</span>
          </button>
          {/* #4890 — Slack-style intervention notifications widget. Bell
              with unread badge → dropdown listing every intervention alert
              (read + unread) so the operator gets a durable "do I have
              outstanding interventions to deal with?" signal. The earlier
              transient banners (NotificationBanners — still rendered above
              the main content for unread alerts) keep their role as
              foreground popups; the widget owns the durable history. */}
          <NotificationsWidget
            notifications={sessionNotifications}
            onSwitchSession={handleSwitchSession}
            onMarkRead={markSessionNotificationRead}
            onMarkAllRead={markAllSessionNotificationsRead}
            onDismiss={dismissSessionNotification}
          />
          {/* #4974: Skills / Copy / Settings collapsed behind a single
              "⋯" overflow trigger. Previously these three icon buttons
              lived inline in header-right alongside `+ New Session` and
              the StatusBar, which at ≤1400px widths overlapped the
              model selector chevron in header-center. Each item keeps
              its existing handler, aria-label, and data-testid via the
              HeaderOverflowMenu's `items[]` (testids still discoverable
              from inside the open menu so the existing test coverage
              for the underlying actions continues to apply).
              The filter pattern (truthy `onClick`) mirrors the
              SessionContextMenu capability gate — Copy is only present
              when the chat view is active and has at least one
              message, so the dropdown grows/shrinks naturally without
              dead rows. */}
          {(() => {
            const overflowItems: HeaderOverflowItem[] = [
              {
                id: 'skills',
                label: 'Skills',
                icon: '\u{1F9E9}',
                title: 'Skills',
                onClick: () => {
                  setSkillsPanelOpen(prev => {
                    const next = !prev
                    if (next) requestListSkills()
                    return next
                  })
                },
              },
              viewMode === 'chat' && storeMessages.length > 0
                ? {
                    id: 'copy-transcript',
                    label: transcriptCopied ? 'Transcript copied' : 'Copy transcript',
                    icon: transcriptCopied ? '✓' : '⎘',
                    title: transcriptCopied ? 'Copied!' : `Copy transcript (${formatShortcutKeys('Cmd+Shift+T')})`,
                    onClick: handleCopyTranscript,
                  }
                : { id: 'copy-transcript', label: 'Copy transcript' },
              {
                id: 'settings',
                label: 'Settings',
                icon: '⚙',
                title: `Settings (${formatShortcutKeys('Cmd+,')})`,
                onClick: () => setSettingsOpen(true),
              },
            ]
            return <HeaderOverflowMenu items={overflowItems} />
          })()}
          <StatusBar
            cost={sessionCost ?? undefined}
            context={formatContext(contextUsage)}
            contextPercent={contextPercent}
            inputTokens={contextUsage?.inputTokens}
            outputTokens={contextUsage?.outputTokens}
            isBusy={!isIdle}
            agentCount={activeAgents.length}
            provider={sessions.find(s => s.sessionId === activeSessionId)?.provider}
          />
        </div>
      </header>

      {/* Sidebar */}
      {sidebarRepos.length > 0 && (
        <Sidebar
          repos={sidebarRepos}
          activeSessionId={activeSessionId}
          isOpen={sidebarOpen}
          width={sidebarWidth}
          filter={sidebarFilter}
          serverStatus={isConnected ? 'connected' : isReconnecting ? 'reconnecting' : 'disconnected'}
          tunnelUrl={null}
          clientCount={connectedClients.length}
          onFilterChange={setSidebarFilter}
          onSessionClick={handleSwitchSession}
          onResumeSession={resumeConversation}
          onNewSession={(cwd) => {
            setPendingCwd(cwd || null)
            setShowCreateSession(true)
          }}
          onToggle={() => setSidebarOpen(prev => !prev)}
          onWidthChange={(w: number) => { setSidebarWidth(w); persistSidebarWidth(w) }}
          onContextMenu={handleSidebarContextMenu}
          searchResults={searchResults}
          searchLoading={searchLoading}
          searchQuery={searchQuery}
          searchConversations={searchConversations}
          clearSearchResults={clearSearchResults}
          sessions={sessions}
          initialPanelHeight={loadPersistedSidebarPanelHeight() ?? 200}
          initialPanelView={loadPersistedSidebarPanelView()}
          initialPanelCollapsed={loadPersistedSidebarPanelCollapsed()}
          onReorderRepos={handleReorderRepos}
          onReorderSessions={handleReorderSidebarSessions}
        />
      )}

      {/* Main content wrapper (when sidebar present) */}
      <div className={sidebarRepos.length > 0 ? 'main-wrapper' : undefined}>
        {/* Session bar */}
        {sessionTabs.length > 0 && (
          <SessionBar
            sessions={sessionTabs}
            onSwitch={handleSwitchSession}
            onClose={handleCloseSession}
            onRename={renameSession}
            onNewSession={handleNewSession}
            onReorder={handleReorderTabs}
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

        {/* Startup error screen — shown when server failed to start (Tauri) */}
        {isStartupError && (
          <StartupErrorScreen
            error={connectionError}
            logs={serverStartupLogs}
            onRetry={handleRetry}
            onStartServer={isTauri() ? handleStartServer : undefined}
          />
        )}

        {/* Disconnected screen — shown when not connected with no error (e.g. server stopped) */}
        {connectionPhase === 'disconnected' && !connectionError && !isConnected && sessions.length === 0 && (
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

        {/* Welcome screen — shown when connected but no sessions */}
        {showWelcome && (
          <WelcomeScreen
            onNewSession={handleNewSession}
            recentSessions={recentSessions}
            onResumeSession={resumeConversation}
            className="main-content"
          />
        )}

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

        {/* Normal session UI */}
        {!showWelcome && (
          <>
            {/* View switcher */}
            <ViewSwitcher
              viewMode={viewMode}
              setViewMode={setViewMode}
              splitMode={splitMode}
              setSplitMode={setSplitMode}
              persistSplitMode={persistSplitMode}
              showConsoleTab={showConsoleTab}
              unreadSystemCount={unreadSystemCount}
              checkpointsOpen={checkpointsOpen}
              setCheckpointsOpen={setCheckpointsOpen}
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
                        renderMessage={renderMessage}
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
                        renderMessage={renderMessage}
                        hidden={viewMode !== 'chat'}
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
                {viewMode === 'environments' && connectionPhase !== 'connecting' && !isSwitchingSession && (
                  <EnvironmentPanel />
                )}
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
              placeholder={isConnected ? `Type a message... (${inputSettings.chatEnterToSend ? 'Enter' : formatShortcutKeys('Cmd+Enter')} to send)` : 'Connecting...'}
              controlledValue={inputDraftValue}
              onValueChange={handleDraftChange}
              filePickerFiles={filePickerFiles}
              onFileTrigger={fetchFileList}
              attachments={fileAttachments}
              onRemoveAttachment={handleRemoveAttachment}
              slashCommands={slashCommands}
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
        tunnelReady={tunnelReady}
        serverPhase={serverPhase}
        tunnelProgress={tunnelProgress}
        serverVersion={serverVersion}
        cwd={activeSessionCwd ?? sessionCwd ?? undefined}
        model={activeModel || undefined}
        cost={sessionCost ?? undefined}
        context={formatContext(contextUsage)}
        contextPercent={contextPercent}
        inputTokens={contextUsage?.inputTokens}
        outputTokens={contextUsage?.outputTokens}
        isBusy={!isIdle}
        agentCount={activeAgents.length}
        onShowQr={isConnected ? handleShowQr : undefined}
        onShareSession={isConnected && activeSessionId ? handleShareSession : undefined}
        provider={sessions.find(s => s.sessionId === activeSessionId)?.provider}
        contextWindow={(availableModels.find(m => m.id === activeModel || m.fullId === activeModel)?.contextWindow) ?? DEFAULT_CONTEXT_WINDOW}
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

      {/* Settings panel */}
      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        showConsoleTab={showConsoleTab}
        onToggleConsoleTab={(show) => {
          setShowConsoleTab(show)
          persistShowConsoleTab(show)
        }}
      />

      {/* Keyboard shortcut help */}
      <ShortcutHelp isOpen={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} shortcuts={SHORTCUTS} />

      {/* Pasted-text inspect modal (#3797) — read-only viewer for the
          collapsed paste whose chip the user clicked. */}
      {inspectedPastedTextId != null && (() => {
        const block = pastedTextBlocks.find(b => b.id === inspectedPastedTextId)
        if (!block) return null
        return (
          <PastedTextModal
            id={block.id}
            content={block.content}
            onClose={() => setInspectedPastedTextId(null)}
            onRemove={handleRemovePastedText}
          />
        )
      })()}

      {/* QR code modal — shared by linking-mode QR and per-session "Share" QR (#3070) */}
      <QrModal
        open={qrModalOpen}
        onClose={() => setQrModalOpen(false)}
        qrSvg={qrSvg}
        loading={qrLoading}
        error={qrError ?? undefined}
        title={qrShareMode === 'share' ? 'Share This Session' : 'Pair Mobile App'}
        instructions={
          qrShareMode === 'share'
            ? 'Scan to chat into this session only — the scanner cannot list, switch, or destroy other sessions.'
            : 'Scan with Chroxy app to pair your phone'
        }
      />

      {/* #3209: SkillsPanel — popover for manual-skill toggles + #3205 metadata */}
      {skillsPanelOpen && (
        <SkillsPanel
          skills={activeSkills}
          canToggle={!!sessions.find(s => s.sessionId === activeSessionId)?.capabilities?.skillToggle}
          mismatchedSkillNames={mismatchedSet}
          onActivate={activateSkill}
          onDeactivate={deactivateSkill}
          onAcceptTrust={skillTrustAcceptSupported ? acceptSkillTrust : undefined}
          pendingCommunitySkills={activePendingCommunitySkills}
          onGrantTrust={skillTrustGrantSupported ? grantCommunitySkillTrust : undefined}
          capabilities={{ skillTrustGrant: skillTrustGrantSupported }}
          pendingTrustGrants={activePendingTrustGrants}
          onClose={() => setSkillsPanelOpen(false)}
        />
      )}

      {/* #4045: sidebar right-click context menu. Rendered at top level so
          it floats above the sidebar without inheriting clip/overflow from
          ancestor containers; SessionContextMenu handles its own outside-
          click / Esc / blur dismissal. */}
      {sidebarContextMenu && (
        <SessionContextMenu
          x={sidebarContextMenu.x}
          y={sidebarContextMenu.y}
          items={sidebarContextMenuItems}
          onDismiss={dismissSidebarContextMenu}
        />
      )}

      {/* Modals */}
      <CreateSessionModal
        open={showCreateSession}
        onClose={() => { setShowCreateSession(false); setIsCreatingSession(false); setSessionCreateError(null) }}
        onCreate={handleCreateSession}
        initialCwd={pendingCwd}
        knownCwds={knownCwds}
        existingNames={sessions.map(s => s.name)}
        serverError={sessionCreateError ?? undefined}
        isCreating={isCreatingSession}
      />

      {/* Toasts */}
      <Toast items={toastItems} onDismiss={(id) => {
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
      }} />

      {/* Command palette */}
      <CommandPalette
        commands={trackedCommands}
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        mruList={paletteOpen ? getMruCommands() : undefined}
      />
    </div>
  )
}
