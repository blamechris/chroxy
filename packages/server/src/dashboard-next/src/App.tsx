/**
 * App — root component wiring all dashboard components to the Zustand store.
 *
 * Auto-connects to the server on mount using the injected config + auth cookie.
 * Layout: header → session bar → view switcher → main content → input bar.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConnectionStore } from './store/connection'
import type { ChatMessage } from './store/connection'
import type { ChatViewMessage } from './components/ChatView'

import { Sidebar, type RepoNode } from './components/Sidebar'
import { CommandPalette } from './components/CommandPalette'
import { useCommands, recordMruCommand, getMruCommands } from './store/commands'
import { ChatView } from './components/ChatView'
import { MultiTerminalView } from './components/MultiTerminalView'
import { InputBar, type FileAttachment, type ImageAttachment } from './components/InputBar'
import { toWireAttachments } from './utils/attachment-utils'
import { processImageFiles, filterImageFiles } from './utils/image-utils'
import { getAuthToken } from './utils/auth'
import { SessionBar, type SessionTabData } from './components/SessionBar'
import { StatusBar } from './components/StatusBar'
import { PermissionPrompt } from './components/PermissionPrompt'
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
import { useTauriEvents, isTauri } from './hooks/useTauriEvents'
import { usePermissionNotification, type PermissionPromptInfo } from './hooks/usePermissionNotification'
import { SplitPane, type SplitDirection } from './components/SplitPane'
import { persistSidebarWidth, loadPersistedSidebarWidth, persistSplitMode, loadPersistedSplitMode, persistShowConsoleTab, loadPersistedShowConsoleTab } from './store/persistence'
import { DiffViewerPanel } from './components/DiffViewerPanel'
import { AgentMonitorPanel } from './components/AgentMonitorPanel'
import { SessionLoadingSkeleton } from './components/SessionLoadingSkeleton'
import { ConsolePage } from './components/ConsolePage'

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
  const availablePermissionModes = useConnectionStore(s => s.availablePermissionModes)
  const serverErrors = useConnectionStore(s => s.serverErrors)
  const infoNotifications = useConnectionStore(s => s.infoNotifications ?? [])
  const connectionRetryCount = useConnectionStore(s => s.connectionRetryCount)
  const filePickerFiles = useConnectionStore(s => s.filePickerFiles)
  const sessionNotifications = useConnectionStore(s => s.sessionNotifications)
  const inputSettings = useConnectionStore(s => s.inputSettings)
  const connectedClients = useConnectionStore(s => s.connectedClients)

  // Listen for Tauri desktop events (no-op in browser context)
  useTauriEvents()

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
  const sendPermissionResponse = useConnectionStore(s => s.sendPermissionResponse)
  const switchSession = useConnectionStore(s => s.switchSession)
  const destroySession = useConnectionStore(s => s.destroySession)
  const renameSession = useConnectionStore(s => s.renameSession)
  const createSession = useConnectionStore(s => s.createSession)
  const setViewMode = useConnectionStore(s => s.setViewMode)
  const setModel = useConnectionStore(s => s.setModel)
  const setPermissionMode = useConnectionStore(s => s.setPermissionMode)
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(() => loadPersistedSidebarWidth() ?? 240)
  const [sidebarFilter, setSidebarFilter] = useState('')
  const [splitMode, setSplitMode] = useState<SplitDirection | null>(() => loadPersistedSplitMode())
  const [checkpointsOpen, setCheckpointsOpen] = useState(false)
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
          destroySession(activeSessionId)
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
      // Cmd+.: interrupt active session
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault()
        sendInterrupt()
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
  }, [sessions, activeSessionId, handleSwitchSession, destroySession, viewMode, setViewMode, sendInterrupt])

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

  // Map sessions to SessionTabData[]
  const sessionTabs: SessionTabData[] = useMemo(
    () => sessions.map(s => ({
      sessionId: s.sessionId,
      name: s.name,
      isBusy: s.isBusy,
      isActive: s.sessionId === activeSessionId,
      cwd: s.cwd,
      model: s.model ?? undefined,
      provider: s.provider,
    })),
    [sessions, activeSessionId],
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
      repo.activeSessions.push({ sessionId: s.sessionId, name: s.name, isBusy: s.isBusy, provider: s.provider })
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
  }, [sendInput, fileAttachments, imageAttachments])

  const handleInterrupt = useCallback(() => {
    sendInterrupt()
  }, [sendInterrupt])

  const handleNewSession = useCallback(() => {
    setPendingCwd(null)
    setShowCreateSession(true)
  }, [])

  const handleCreateSession = useCallback((data: { name: string; cwd: string; provider?: string }) => {
    setSessionCreateError(null)
    setIsCreatingSession(true)
    createSession(data.name, data.cwd || undefined, data.provider)
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

  const handleShowQr = useCallback(async () => {
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
      const res = await fetch('/qr', {
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

  const SHORTCUTS: ShortcutEntry[] = useMemo(() => [
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
    { keys: 'Cmd+Enter', description: 'Send message', section: 'Input' },
    { keys: 'Escape', description: 'Close modal / cancel', section: 'Global' },
  ], [])

  const isConnected = connectionPhase === 'connected'
  const isReconnecting = connectionPhase === 'reconnecting' || connectionPhase === 'server_restarting'
  const showWelcome = isConnected && sessions.length === 0

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

  return (
    <div id="app" className={sidebarRepos.length > 0 ? 'with-sidebar' : ''}>
      {/* Reconnect banner */}
      <ReconnectBanner
        visible={isReconnecting}
        attempt={connectionRetryCount}
        maxAttempts={5}
        message={connectionPhase === 'server_restarting' ? 'Server restarting...' : undefined}
        onRetry={handleRetry}
      />

      {/* Header */}
      <header id="header">
        <div className="header-left">
          <span className="logo">Chroxy</span>
          <span className="version-badge">v{serverVersion ?? __APP_VERSION__}</span>
          <span className={`status-dot ${connectionPhase}`} />
        </div>
        <div className="header-center">
          {/* Model selector */}
          {availableModels.length > 0 && (
            <select
              value={activeModel || ''}
              onChange={e => setModel(e.target.value)}
              aria-label="Select model"
            >
              {availableModels.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          )}
          {/* Permission mode selector */}
          {availablePermissionModes.length > 0 && (
            <select
              value={permissionMode || ''}
              onChange={e => setPermissionMode(e.target.value)}
              aria-label="Select permission mode"
            >
              {availablePermissionModes.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          )}
        </div>
        <div className="header-right">
          <button
            className="header-icon-btn"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings (Cmd+,)"
            type="button"
          >
            &#9881;
          </button>
          <StatusBar
            model={activeModel || undefined}
            cost={sessionCost ?? undefined}
            context={formatContext(contextUsage)}
            isBusy={!isIdle}
            agentCount={activeAgents.length}
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
          onResumeSession={(convId) => {
            /* Will be wired in #1107 */
            console.log('Resume session:', convId)
          }}
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
            onClose={destroySession}
            onRename={renameSession}
            onNewSession={handleNewSession}
          />
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
            <div className="view-switch">
              <button
                className={`view-tab${viewMode === 'chat' && !splitMode ? ' active' : ''}`}
                onClick={() => { setViewMode('chat'); setSplitMode(null); persistSplitMode(null) }}
                type="button"
              >
                Chat
              </button>
              <button
                className={`view-tab${viewMode === 'terminal' && !splitMode ? ' active' : ''}`}
                onClick={() => { setViewMode('terminal'); setSplitMode(null); persistSplitMode(null) }}
                type="button"
              >
                Output
              </button>
              <button
                className={`view-tab${splitMode ? ' active' : ''}`}
                onClick={() => {
                  const next: SplitDirection | null = splitMode ? null : 'horizontal'
                  setSplitMode(next)
                  persistSplitMode(next)
                }}
                type="button"
                title="Split view (Cmd+\)"
              >
                Split
              </button>
              <button
                className={`view-tab${viewMode === 'files' ? ' active' : ''}`}
                onClick={() => setViewMode('files')}
                type="button"
              >
                Files
              </button>
              <button
                className={`view-tab${viewMode === 'system' ? ' active' : ''}`}
                onClick={() => { setViewMode('system'); setSplitMode(null); persistSplitMode(null) }}
                type="button"
              >
                System
                {unreadSystemCount > 0 && (
                  <span className="system-badge">{unreadSystemCount}</span>
                )}
              </button>
              {showConsoleTab && (
                <button
                  className={`view-tab${viewMode === 'console' ? ' active' : ''}`}
                  onClick={() => { setViewMode('console'); setSplitMode(null); persistSplitMode(null) }}
                  type="button"
                >
                  Console
                </button>
              )}
              <div className="view-switch-spacer" />
              <button
                className={`view-tab view-tab-right${checkpointsOpen ? ' active' : ''}`}
                onClick={() => setCheckpointsOpen(prev => !prev)}
                type="button"
                title="Toggle checkpoint timeline"
              >
                Checkpoints
              </button>
              <button
                className={`view-tab${viewMode === 'diff' ? ' active' : ''}`}
                onClick={() => setViewMode('diff')}
                type="button"
              >
                Diff
              </button>
            </div>

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
              placeholder={isConnected ? `Type a message... (${inputSettings.chatEnterToSend ? 'Enter' : 'Cmd+Enter'} to send)` : 'Connecting...'}
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
            />
          </>
        )}
      </div>

      {/* Footer bar */}
      <FooterBar
        connectionPhase={connectionPhase}
        serverVersion={serverVersion}
        cwd={sessionCwd ?? undefined}
        model={activeModel || undefined}
        cost={sessionCost ?? undefined}
        context={formatContext(contextUsage)}
        isBusy={!isIdle}
        agentCount={activeAgents.length}
        onShowQr={isConnected ? handleShowQr : undefined}
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

      {/* QR code modal */}
      <QrModal
        open={qrModalOpen}
        onClose={() => setQrModalOpen(false)}
        qrSvg={qrSvg}
        loading={qrLoading}
        error={qrError ?? undefined}
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
      <Toast items={toastItems} onDismiss={(id) => { dismissServerError(id); dismissInfoNotification(id); }} />

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
