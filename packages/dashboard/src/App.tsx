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
  groupMessages,
  applyStreamingOverlay,
  formatPasteMarker,
  expandPasteMarkers,
  type SessionInfo,
} from '@chroxy/store-core'
import { useConnectionStore } from './store/connection'
import type { ChatMessage } from './store/connection'
import type { BaseSessionState } from '@chroxy/store-core'
import type { ChatViewMessage } from './components/ChatView'

import { Sidebar, type RepoNode, type ContextMenuTarget } from './components/Sidebar'
import { SessionContextMenu, type ContextMenuItem } from './components/SessionContextMenu'
import { CommandPalette } from './components/CommandPalette'
import { useCommands, recordMruCommand, getMruCommands } from './store/commands'
import { ChatView } from './components/ChatView'
import { MultiTerminalView } from './components/MultiTerminalView'
import { InputBar, type FileAttachment, type ImageAttachment } from './components/InputBar'
import { useVoiceInput } from './hooks/useVoiceInput'
import { toWireAttachments } from './utils/attachment-utils'
import { processImageFiles, processBase64Image, filterImageFiles } from './utils/image-utils'
import { getAuthToken } from './utils/auth'
import { SessionBar, type SessionTabData, type SessionStatus } from './components/SessionBar'
import { StatusBar } from './components/StatusBar'
import { ChatSettingsDropdown } from './components/ChatSettingsDropdown'
import { SkillsPanel } from './components/SkillsPanel'
import { PermissionPrompt } from './components/PermissionPrompt'
import { formatTranscript } from './lib/transcript'
import { QuestionPrompt } from './components/QuestionPrompt'
import { ActivityIndicator } from './components/ActivityIndicator'
import { CheckInChip } from './components/CheckInChip'
import { ToolBubble } from './components/ToolBubble'
import { ToolGroup } from './components/ToolGroup'
import { PastedTextModal } from './components/PastedTextModal'
import { EvaluatorRewriteBanner, EvaluatorClarifyPrompt } from './components/EvaluatorPrompts'
import { PlanApproval } from './components/PlanApproval'
import { ReconnectBanner } from './components/ReconnectBanner'
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
import { readClipboardImage } from './utils/clipboard-image'
import { useTauriEvents } from './hooks/useTauriEvents'
import { isTauri } from './utils/tauri'
import { startServer, revealInFinder } from './hooks/useTauriIPC'
import { usePermissionNotification, type PermissionPromptInfo } from './hooks/usePermissionNotification'
import { SplitPane, type SplitDirection } from './components/SplitPane'
import { persistSidebarWidth, loadPersistedSidebarWidth, persistSplitMode, loadPersistedSplitMode, persistShowConsoleTab, loadPersistedShowConsoleTab } from './store/persistence'
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


/** Format context usage as a compact string */
function formatContext(usage: { inputTokens: number; outputTokens: number } | null): string | undefined {
  if (!usage) return undefined
  const total = usage.inputTokens + usage.outputTokens
  if (total === 0) return undefined
  if (total < 1000) return `${total} tokens`
  return `${(total / 1000).toFixed(1)}k tokens`
}

/** Map store ChatMessage to ChatViewMessage */
function toChatViewMessage(msg: ChatMessage): ChatViewMessage {
  return {
    id: msg.id,
    type: msg.type === 'prompt' ? 'response' : msg.type,
    content: msg.content,
    timestamp: msg.timestamp,
  }
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

  // Listen for Tauri desktop events (no-op in browser context)
  useTauriEvents()

  // Voice input (Tauri only — no-op in browser)
  const voiceInput = useVoiceInput()

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
  } = useConnectionStore(useShallow(s => s.getActiveSessionState()))

  // #3205: stable Set for SkillsPanel mismatch indicator. useMemo
  // keyed by the array reference so the Set only re-derives when the
  // store actually mutated the list (skill_changed event fired).
  const mismatchedSet = useMemo(
    () => new Set(activeMismatched || []),
    [activeMismatched],
  )

  // #3839: dropdown-gating flags derived from the active session's provider
  // capabilities. Hoisted out of the JSX so the lookups don't re-run on every
  // render of <App>, which fires on most WS messages.
  const dropdownFlags = useMemo(() => {
    const activeProvider = sessions.find(s => s.sessionId === activeSessionId)?.provider
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
      showPermissionMode: caps?.permissionModeSwitch !== false,
      showThinkingLevel: !!caps?.thinkingLevel,
    }
  }, [sessions, activeSessionId, availableProviders, availableModelsProvider])

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

  const slashCommands = useConnectionStore(s => s.slashCommands)

  // Store actions (stable refs)
  const connect = useConnectionStore(s => s.connect)
  const sendInput = useConnectionStore(s => s.sendInput)
  const sendInterrupt = useConnectionStore(s => s.sendInterrupt)
  const evaluateDraft = useConnectionStore(s => s.evaluateDraft)
  const sendPermissionResponse = useConnectionStore(s => s.sendPermissionResponse)
  const switchSession = useConnectionStore(s => s.switchSession)
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
    // navigator.clipboard is undefined in non-secure contexts (and some
    // embedded webviews). Accessing .writeText on undefined would throw
    // synchronously — bypass the .catch() and surface as a runtime error
    // in the keyboard handler. Guard with the same pattern as the other
    // dashboard copy paths.
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(text).then(() => {
      setTranscriptCopied(true)
      if (transcriptResetTimerRef.current) clearTimeout(transcriptResetTimerRef.current)
      transcriptResetTimerRef.current = setTimeout(() => setTranscriptCopied(false), 1500)
    }).catch(() => {
      // Clipboard rejected (e.g. user denied permissions). Surface the
      // failure quietly — the user can copy manually from the chat view.
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
  const handleSidebarContextMenu = useCallback((target: ContextMenuTarget, event: React.MouseEvent) => {
    setSidebarContextMenu({ target, x: event.clientX, y: event.clientY })
  }, [])
  const dismissSidebarContextMenu = useCallback(() => {
    setSidebarContextMenu(null)
  }, [])

  // #4045: build the menu item list for the currently-targeted sidebar row.
  // Items are capability-gated:
  //   - "Open in Finder" only appears under Tauri (we shell out to `open`
  //     / `explorer` / `xdg-open` via the reveal_in_finder Rust command —
  //     no server-side endpoint exists for the browser dashboard).
  //   - "Archive" is intentionally omitted; the server has no archive
  //     store yet (#4045 splits this into a follow-up).
  const sidebarContextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!sidebarContextMenu) return []
    const { target } = sidebarContextMenu
    const tauriRuntime = isTauri()

    if (target.type === 'session' && target.sessionId) {
      const session = sessions.find(s => s.sessionId === target.sessionId)
      if (!session) return []
      return [
        {
          id: 'duplicate',
          label: 'Duplicate Session',
          onClick: () => {
            createSession({
              name: session.name,
              cwd: session.cwd || undefined,
              provider: session.provider,
              model: session.model || undefined,
              permissionMode: session.permissionMode || undefined,
              worktree: session.worktree,
            })
          },
        },
        {
          id: 'reveal',
          label: 'Open in Finder',
          onClick: tauriRuntime && session.cwd
            ? () => {
                // #4045: surface Rust-side errors (missing path, spawn
                // failure, restricted-window rejection) as a toast so the
                // user knows the action failed instead of getting an
                // unhandled promise rejection in the console.
                const cwd = session.cwd
                revealInFinder(cwd).catch((err: unknown) => {
                  useConnectionStore.getState().addServerError(
                    `Failed to reveal in Finder: ${err instanceof Error ? err.message : String(err)}`,
                  )
                })
              }
            : undefined,
        },
        {
          id: 'close',
          label: 'Close Session',
          destructive: true,
          separatorAbove: true,
          onClick: () => handleCloseSession(session.sessionId),
        },
      ]
    }

    if (target.type === 'repo' && target.path) {
      const repoPath = target.path
      return [
        {
          id: 'new-session',
          label: 'New Session Here',
          onClick: () => {
            setPendingCwd(repoPath)
            setShowCreateSession(true)
          },
        },
        {
          id: 'reveal',
          label: 'Open in Finder',
          onClick: tauriRuntime
            ? () => {
                // #4045: see session-row reveal — same pattern, surface
                // Rust-side errors as a toast instead of an unhandled
                // promise rejection.
                revealInFinder(repoPath).catch((err: unknown) => {
                  useConnectionStore.getState().addServerError(
                    `Failed to reveal in Finder: ${err instanceof Error ? err.message : String(err)}`,
                  )
                })
              }
            : undefined,
        },
      ]
    }

    return []
  }, [sidebarContextMenu, sessions, createSession, handleCloseSession])

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Prevent Backspace from triggering browser/webview "back" navigation
      const target = e.target instanceof HTMLElement ? e.target : null
      if (e.key === 'Backspace' && (!target || (!['INPUT', 'TEXTAREA'].includes(target.tagName) && !target.isContentEditable))) {
        e.preventDefault()
        return
      }
      // Ctrl+V on macOS in Tauri = paste image from clipboard (#3748).
      // Cmd+V remains the native text paste (handled by the OS / textarea
      // onPaste handler, untouched here). On non-Mac platforms Ctrl+V is
      // the native text paste — we leave it alone there. On non-Tauri
      // (web dashboard) there's no way to read the OS clipboard image
      // reliably, so the shortcut only fires inside the Tauri webview.
      if (
        isTauri() &&
        isMacPlatform() &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === 'v' || e.key === 'V')
      ) {
        e.preventDefault()
        void (async () => {
          try {
            const image = await readClipboardImage()
            if (!image) {
              useConnectionStore.getState().addInfoNotification('No image on clipboard')
              return
            }
            // Use processBase64Image (not processImageFiles) to skip the
            // base64 → Blob → File → FileReader → base64 round-trip the
            // File path would otherwise perform on a payload we already
            // have in the canonical shape (#3796 review).
            const { accepted, rejected } = await processBase64Image(image.base64, image.mediaType, image.name)
            if (accepted) {
              appendImageAttachments([accepted])
            } else if (rejected) {
              useConnectionStore.getState().addInfoNotification(rejected)
            }
          } catch (err) {
            useConnectionStore.getState().addInfoNotification(
              `Failed to read clipboard image: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        })()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(prev => !prev)
        return
      }
      // Cmd+Shift+P: toggle command palette (VSCode-style alias)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPaletteOpen(prev => !prev)
        return
      }
      // Cmd+Shift+D: toggle view mode (chat ↔ terminal)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setViewMode(viewMode === 'chat' ? 'terminal' : 'chat')
        return
      }
      // Cmd+N / Ctrl+N: open new session modal
      if ((e.metaKey || e.ctrlKey) && e.key === 'n' && !e.shiftKey) {
        e.preventDefault()
        setShowCreateSession(true)
        return
      }
      // Cmd+1-9: switch to tab by index
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = parseInt(e.key, 10) - 1
        const target = sessions[idx]
        if (target) handleSwitchSession(target.sessionId)
        return
      }
      // Cmd+Shift+[ / ]: prev/next tab
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        const currentIdx = sessions.findIndex(s => s.sessionId === activeSessionId)
        if (currentIdx < 0) return
        const nextIdx = e.key === '['
          ? (currentIdx - 1 + sessions.length) % sessions.length
          : (currentIdx + 1) % sessions.length
        handleSwitchSession(sessions[nextIdx]!.sessionId)
        return
      }
      // Cmd+W: close active tab (if more than 1 session) — Tauri only (#1378)
      if (isTauri() && (e.metaKey || e.ctrlKey) && e.key === 'w' && !e.shiftKey) {
        if (activeSessionId && sessions.length > 1) {
          e.preventDefault()
          handleCloseSession(activeSessionId)
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        setSidebarOpen(prev => !prev)
        return
      }
      // Cmd+Shift+P: command palette (VSCode alias)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPaletteOpen(prev => !prev)
        return
      }
      // Cmd+Shift+D: toggle chat/terminal view
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setViewMode(viewMode === 'chat' ? 'terminal' : 'chat')
        return
      }
      // Cmd+\: cycle split mode (none → horizontal → vertical → none)
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setSplitMode(prev => {
          const next = prev === null ? 'horizontal' : prev === 'horizontal' ? 'vertical' : null
          persistSplitMode(next)
          return next
        })
        return
      }
      // Cmd+,: open settings
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(prev => !prev)
        return
      }
      // Cmd+Shift+T: copy chat transcript (#3073)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        handleCopyTranscript()
        return
      }
      // Cmd+.: interrupt active session
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault()
        sendInterrupt()
        return
      }
      // Shift+Tab: toggle plan mode
      if (e.shiftKey && e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return  // Allow native reverse-tab
        e.preventDefault()
        const state = useConnectionStore.getState()
        const currentMode = state.permissionMode
        if (currentMode === 'plan') {
          // Switch back to previous mode (default to 'approve')
          setPermissionMode(state.previousPermissionMode || 'approve')
        } else {
          // Switch to plan mode
          setPermissionMode('plan')
        }
        return
      }
      // ?: toggle shortcut help (no modifiers, not in text input)
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !(e.target as HTMLElement).isContentEditable) {
          const overlays = document.querySelectorAll('[data-modal-overlay]')
          const onlyShortcutHelp = overlays.length === 1 && overlays[0]?.classList.contains('shortcut-help-overlay')
          if (overlays.length === 0 || onlyShortcutHelp) {
            e.preventDefault()
            setShortcutHelpOpen(prev => !prev)
          }
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [sessions, activeSessionId, handleSwitchSession, handleCloseSession, viewMode, setViewMode, sendInterrupt, handleCopyTranscript])

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

  // Convert store messages to ChatViewMessage[], filtering out system events
  // and collapsing contiguous tool_use/thinking runs into a single synthetic
  // `tool_group` row (#3747). The full group payload is kept in
  // `chatToolGroupPayloads` so renderMessage can look it up by synthetic id.
  const chatFilteredMessages = useMemo(
    () => storeMessages.filter(m => m.type !== 'system'),
    [storeMessages],
  )
  const chatDisplayGroups = useMemo(() => {
    const base = groupMessages(chatFilteredMessages)
    return applyStreamingOverlay(base, chatFilteredMessages, streamingMessageId ?? null)
  }, [chatFilteredMessages, streamingMessageId])
  // Singleton activity groups (1 tool, no thinking) pass through as plain
  // `tool_use` rows so the existing ToolBubble — with its full expandable
  // result panel — stays reachable. Groups only collapse into one
  // `tool_group` row when there is a run of 2+ messages worth collapsing
  // (#3794 review).
  const chatToolGroupPayloads = useMemo(() => {
    const map = new Map<string, { messages: ChatMessage[]; isActive: boolean }>()
    for (const g of chatDisplayGroups) {
      if (g.type === 'activity' && g.messages.length >= 2) {
        map.set(g.key, { messages: g.messages, isActive: g.isActive })
      }
    }
    return map
  }, [chatDisplayGroups])
  const chatMessages = useMemo<ChatViewMessage[]>(
    () =>
      chatDisplayGroups.map((g) => {
        if (g.type === 'single') return toChatViewMessage(g.message)
        if (g.messages.length < 2) {
          // Singleton — emit as the original tool_use / thinking row.
          return toChatViewMessage(g.messages[0]!)
        }
        const last = g.messages[g.messages.length - 1]
        return {
          id: g.key,
          type: 'tool_group',
          content: '',
          timestamp: last?.timestamp ?? 0,
        }
      }),
    [chatDisplayGroups],
  )

  // System events for the System tab
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

  // Map sessions to SessionTabData[] with unified status indicators.
  const sessionTabs: SessionTabData[] = useMemo(
    () => sessions.map(s => {
      return {
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
      }
    }),
    [sessions, activeSessionId, getSessionVisualStatus],
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

    return [...repoMap.values()]
  }, [sessions, getSessionVisualStatus, sidebarCumulativeUsage])

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

  const handleCreateSession = useCallback((data: { name: string; cwd: string; provider?: string; permissionMode?: string; model?: string; worktree?: boolean }) => {
    setSessionCreateError(null)
    setIsCreatingSession(true)
    createSession({ name: data.name, cwd: data.cwd || undefined, provider: data.provider, model: data.model, permissionMode: data.permissionMode, worktree: data.worktree })
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

  // Build id->message map for O(1) lookups in renderMessage
  const storeMsgMap = useMemo(
    () => new Map(storeMessages.map(m => [m.id, m])),
    [storeMessages],
  )

  // Custom message renderer for permission prompts and tool bubbles
  const renderMessage = useCallback((msg: ChatViewMessage) => {
    // Tool-group synthetic row (#3747) — id is a group key, not a store id.
    if (msg.type === 'tool_group') {
      const payload = chatToolGroupPayloads.get(msg.id)
      if (!payload) return null
      return <ToolGroup messages={payload.messages} isActive={payload.isActive} />
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
      return (
        <QuestionPrompt
          question={storeMsg.content}
          options={storeMsg.options}
          answered={storeMsg.answered}
          onSelect={(value) => {
            sendUserQuestionResponse(value, storeMsg.toolUseId)
            markPromptAnswered(storeMsg.id, value)
          }}
        />
      )
    }

    // Tool bubble
    if (storeMsg.type === 'tool_use' && storeMsg.toolUseId) {
      return (
        <ToolBubble
          toolName={storeMsg.tool || 'Tool'}
          toolUseId={storeMsg.toolUseId}
          input={storeMsg.toolInput}
          result={storeMsg.toolResult}
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

    // Default rendering
    return null
  }, [storeMsgMap, chatToolGroupPayloads, sendPermissionResponse, sendUserQuestionResponse, markPromptAnswered])

  const SHORTCUTS: ShortcutEntry[] = useMemo(() => {
    // #2883: author entries with canonical `Cmd+...` labels and rewrite to
    // `Ctrl+...` at render time on non-Mac platforms so the cheat-sheet
    // matches the modifier the user can actually press.
    const rawEntries: ShortcutEntry[] = [
      { keys: '?', description: 'Show keyboard shortcuts', section: 'Global' },
      { keys: 'Cmd+K', description: 'Command palette', section: 'Global' },
      { keys: 'Cmd+Shift+P', description: 'Command palette (VSCode)', section: 'Global' },
      { keys: 'Cmd+N', description: 'New session', section: 'Global' },
      { keys: 'Cmd+B', description: 'Toggle sidebar', section: 'Global' },
      { keys: 'Cmd+,', description: 'Settings', section: 'Global' },
      { keys: 'Cmd+.', description: 'Interrupt session', section: 'Session' },
      { keys: 'Cmd+Shift+D', description: 'Toggle chat / terminal', section: 'Session' },
      { keys: 'Cmd+\\', description: 'Cycle split view', section: 'Session' },
      { keys: 'Cmd+1-9', description: 'Switch to tab by number', section: 'Session' },
      { keys: 'Cmd+Shift+[', description: 'Previous tab', section: 'Session' },
      { keys: 'Cmd+Shift+]', description: 'Next tab', section: 'Session' },
      { keys: 'Cmd+W', description: 'Close tab (desktop)', section: 'Session' },
      { keys: 'Shift+Tab', description: 'Toggle plan mode', section: 'Session' },
      { keys: 'Cmd+Y', description: 'Allow current permission prompt', section: 'Session' },
      { keys: 'Cmd+Shift+Y', description: 'Allow current permission prompt for this session (rule-eligible tools)', section: 'Session' },
      { keys: 'Cmd+Enter', description: 'Send message', section: 'Input' },
      { keys: 'Escape', description: 'Close modal / cancel', section: 'Global' },
    ]
    // #3748 — Ctrl+V (image-paste) only works in the Tauri desktop on macOS,
    // since on other platforms Ctrl+V is the native text-paste shortcut.
    // Show the entry only where the shortcut is actually wired.
    if (isTauri() && isMacPlatform()) {
      rawEntries.push({
        keys: 'Ctrl+V',
        description: 'Paste image from clipboard (Cmd+V stays as text paste)',
        section: 'Input',
      })
    }
    return rawEntries.map(entry => ({ ...entry, keys: formatShortcutKeys(entry.keys) }))
  }, [])

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
          <span className="version-badge">v{serverVersion ?? __APP_VERSION__}</span>
          <span className={`status-dot ${serverPhase === 'tunnel_warming' || serverPhase === 'tunnel_verifying' || (isConnected && !tunnelReady && serverPhase == null) ? 'connecting' : connectionPhase}`} />
        </div>
        <div className="header-center">
          <ChatSettingsDropdown
            availableModels={dropdownFlags.showModelPicker ? availableModels : []}
            activeModel={activeModel}
            defaultModelId={defaultModelId}
            onModelChange={setModel}
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
          {/* #3209: Skills toggle, moved to header-right as an icon
              button. Was previously a text button in header-center
              where it competed for space with the model dropdown. */}
          <button
            type="button"
            className="header-icon-btn"
            data-testid="btn-toggle-skills-panel"
            onClick={() => {
              setSkillsPanelOpen(prev => {
                const next = !prev
                if (next) requestListSkills()
                return next
              })
            }}
            aria-label="Skills"
            title="Skills"
          >
            &#129513;
          </button>
          {viewMode === 'chat' && storeMessages.length > 0 && (
            <button
              className="header-icon-btn"
              onClick={handleCopyTranscript}
              aria-label="Copy chat transcript"
              data-testid="btn-copy-transcript"
              title={transcriptCopied ? 'Copied!' : `Copy transcript (${formatShortcutKeys('Cmd+Shift+T')})`}
              type="button"
            >
              {transcriptCopied ? '✓' : '⎘'}
            </button>
          )}
          <button
            className="header-icon-btn"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title={`Settings (${formatShortcutKeys('Cmd+,')})`}
            type="button"
          >
            &#9881;
          </button>
          <StatusBar
            cost={sessionCost ?? undefined}
            context={formatContext(contextUsage)}
            contextPercent={contextPercent}
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
                    {viewMode === 'chat' && (
                      <ChatView
                        messages={chatMessages}
                        isStreaming={streamingMessageId !== null}
                        isBusy={!isIdle}
                        renderMessage={renderMessage}
                      />
                    )}
                    {viewMode === 'terminal' && (
                      <MultiTerminalView
                        sessions={sessions}
                        activeSessionId={activeSessionId}
                        className="terminal-container"
                      />
                    )}
                  </>
                )}
                {viewMode === 'files' && connectionPhase !== 'connecting' && !isSwitchingSession && (
                  <FileBrowserPanel />
                )}
                {viewMode === 'system' && connectionPhase !== 'connecting' && !isSwitchingSession && (
                  <ChatView
                    messages={systemMessages}
                    isStreaming={false}
                    isBusy={false}
                    renderMessage={renderMessage}
                  />
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
        isBusy={!isIdle}
        agentCount={activeAgents.length}
        onShowQr={isConnected ? handleShowQr : undefined}
        onShareSession={isConnected && activeSessionId ? handleShareSession : undefined}
        provider={sessions.find(s => s.sessionId === activeSessionId)?.provider}
        contextWindow={(availableModels.find(m => m.id === activeModel || m.fullId === activeModel)?.contextWindow) ?? DEFAULT_CONTEXT_WINDOW}
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
