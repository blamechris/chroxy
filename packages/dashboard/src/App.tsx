/**
 * App — root component wiring all dashboard components to the Zustand store.
 *
 * Auto-connects to the server on mount using the injected config + auth cookie.
 * Layout: header → session bar → view switcher → main content → input bar.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DEFAULT_CONTEXT_WINDOW } from '@chroxy/store-core'
import { useConnectionStore } from './store/connection'
import type { ChatMessage } from './store/connection'
import type { ChatViewMessage } from './components/ChatView'

import { Sidebar, type RepoNode } from './components/Sidebar'
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
import { PermissionPrompt } from './components/PermissionPrompt'
import { formatTranscript } from './lib/transcript'
import { QuestionPrompt } from './components/QuestionPrompt'
import { ToolBubble } from './components/ToolBubble'
import { PlanApproval } from './components/PlanApproval'
import { ReconnectBanner } from './components/ReconnectBanner'
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
import { formatShortcutKeys } from './utils/platform'
import { useTauriEvents } from './hooks/useTauriEvents'
import { isTauri } from './utils/tauri'
import { startServer } from './hooks/useTauriIPC'
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
  const defaultCwd = useConnectionStore(s => s.defaultCwd)
  const sessions = useConnectionStore(s => s.sessions)
  const activeSessionId = useConnectionStore(s => s.activeSessionId)
  const viewMode = useConnectionStore(s => s.viewMode)
  const availableModels = useConnectionStore(s => s.availableModels)
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
  } = useConnectionStore(useShallow(s => s.getActiveSessionState()))

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
    destroySession(sessionId)
  }, [destroySession])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Prevent Backspace from triggering browser/webview "back" navigation
      const target = e.target instanceof HTMLElement ? e.target : null
      if (e.key === 'Backspace' && (!target || (!['INPUT', 'TEXTAREA'].includes(target.tagName) && !target.isContentEditable))) {
        e.preventDefault()
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

  // Convert store messages to ChatViewMessage[], filtering out system events from chat
  const chatMessages = useMemo(
    () => storeMessages.filter(m => m.type !== 'system').map(toChatViewMessage),
    [storeMessages],
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

  // Map sessions to SessionTabData[] with status indicators (#2091)
  const sessionTabs: SessionTabData[] = useMemo(
    () => sessions.map(s => {
      let status: SessionStatus = 'idle'
      const hasNotification = sessionNotifications.some(
        n => n.sessionId === s.sessionId && (n.eventType === 'permission' || n.eventType === 'question' || n.eventType === 'error'),
      )
      if (hasNotification) {
        status = 'needs-attention'
      } else if (s.isBusy) {
        status = 'busy'
      }
      return {
        sessionId: s.sessionId,
        name: s.name,
        isBusy: s.isBusy,
        isActive: s.sessionId === activeSessionId,
        cwd: s.cwd,
        model: s.model ?? undefined,
        provider: s.provider,
        status,
      }
    }),
    [sessions, activeSessionId, sessionNotifications],
  )

  // Derive sidebar repo tree from sessions
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
      repo.activeSessions.push({ sessionId: s.sessionId, name: s.name, isBusy: s.isBusy, provider: s.provider, worktree: s.worktree })
    }

    // If no repos from sessions, create a default
    if (repoMap.size === 0) {
      return []
    }

    return [...repoMap.values()]
  }, [sessions])

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
  const toastItems: ToastItem[] = useMemo(
    () => [
      ...serverErrors
        .filter(e => !e.sessionId || e.sessionId === activeSessionId)
        .map(e => ({ id: e.id, message: e.message, level: 'error' as const })),
      ...infoNotifications
        .map(e => ({ id: e.id, message: e.message, level: 'info' as const })),
    ],
    [serverErrors, infoNotifications, activeSessionId],
  )

  // Per-session input draft persistence
  const inputDraftsRef = useRef<Map<string, string>>(new Map())
  const [inputDraftValue, setInputDraftValue] = useState('')
  const handleDraftChange = useCallback((text: string) => {
    setInputDraftValue(text)
    if (activeSessionId) inputDraftsRef.current.set(activeSessionId, text)
  }, [activeSessionId])
  // Restore draft when switching sessions
  useEffect(() => {
    if (activeSessionId) {
      setInputDraftValue(inputDraftsRef.current.get(activeSessionId) ?? '')
    }
  }, [activeSessionId])

  // Handlers
  const handleSend = useCallback((text: string, files?: FileAttachment[]) => {
    const allFiles = files || fileAttachments
    const wire = toWireAttachments(
      allFiles.length > 0 ? allFiles : undefined,
      imageAttachments.length > 0 ? imageAttachments : undefined,
    )
    sendInput(text, wire.length > 0 ? wire : undefined)
    setFileAttachments([])
    setImageAttachments([])
    // Clear draft for the session that sent the message
    if (activeSessionId) inputDraftsRef.current.delete(activeSessionId)
    setInputDraftValue('')
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
    setImageAttachments(prev => [...prev, ...accepted])
  }, [])

  const handleImageDrop = useCallback(async (files: File[]) => {
    const images = filterImageFiles(files)
    if (images.length === 0) return
    const { accepted } = await processImageFiles(images)
    setImageAttachments(prev => [...prev, ...accepted])
  }, [])

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
    const storeMsg = storeMsgMap.get(msg.id)
    if (!storeMsg) return null

    // Permission prompt
    if (storeMsg.requestId && storeMsg.expiresAt && !storeMsg.answered) {
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

    // Default rendering
    return null
  }, [storeMsgMap, sendPermissionResponse, sendUserQuestionResponse, markPromptAnswered])

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
            availableModels={availableModels}
            activeModel={activeModel}
            defaultModelId={defaultModelId}
            onModelChange={setModel}
            availablePermissionModes={availablePermissionModes}
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            showThinkingLevel={(() => {
              const activeProvider = sessions.find(s => s.sessionId === activeSessionId)?.provider
              const providerInfo = availableProviders.find(p => p.name === activeProvider)
              return !!(activeProvider && providerInfo?.capabilities?.thinkingLevel)
            })()}
            thinkingLevel={thinkingLevel}
            onThinkingLevelChange={level => setThinkingLevel(level as 'default' | 'high' | 'max')}
          />
        </div>
        <div className="header-right">
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
          onContextMenu={() => {
            /* Context menus will be added in a follow-up */
          }}
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
        cwd={sessionCwd ?? undefined}
        model={activeModel || undefined}
        cost={sessionCost ?? undefined}
        context={formatContext(contextUsage)}
        contextPercent={contextPercent}
        isBusy={!isIdle}
        agentCount={activeAgents.length}
        onShowQr={isConnected ? handleShowQr : undefined}
        onShareSession={isConnected && activeSessionId ? handleShareSession : undefined}
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
