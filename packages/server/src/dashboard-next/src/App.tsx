/**
 * App — root component wiring all dashboard components to the Zustand store.
 *
 * Auto-connects to the server on mount using the injected config + auth cookie.
 * Layout: header → session bar → view switcher → main content → input bar.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConnectionStore } from './store/connection'
import type { ChatMessage } from './store/connection'
import type { ChatViewMessage } from './components/ChatView'

import { Sidebar, type RepoNode } from './components/Sidebar'
import { CommandPalette } from './components/CommandPalette'
import { useCommands, recordMruCommand } from './store/commands'
import { ChatView } from './components/ChatView'
import { MultiTerminalView } from './components/MultiTerminalView'
import { InputBar, type FileAttachment, type ImageAttachment } from './components/InputBar'
import { toWireAttachments } from './utils/attachment-utils'
import { processImageFiles, filterImageFiles } from './utils/image-utils'
import { SessionBar, type SessionTabData } from './components/SessionBar'
import { StatusBar } from './components/StatusBar'
import { PermissionPrompt } from './components/PermissionPrompt'
import { QuestionPrompt } from './components/QuestionPrompt'
import { ToolBubble } from './components/ToolBubble'
import { PlanApproval } from './components/PlanApproval'
import { ReconnectBanner } from './components/ReconnectBanner'
import { WelcomeScreen } from './components/WelcomeScreen'
import { CreateSessionModal } from './components/CreateSessionModal'
import { Toast, type ToastItem } from './components/Toast'
import { useTauriEvents, isTauri } from './hooks/useTauriEvents'

/** Server-injected config from window.__CHROXY_CONFIG__ */
interface ChroxyConfig {
  port: number
  noEncrypt: boolean
}

declare const __APP_VERSION__: string

declare global {
  interface Window {
    __CHROXY_CONFIG__?: ChroxyConfig
  }
}

/** Read auth token from URL query param (preferred) or cookie (fallback) */
function getAuthToken(): string | null {
  const params = new URLSearchParams(window.location.search)
  const queryToken = params.get('token')
  if (queryToken) return queryToken
  const match = document.cookie.match(/(?:^|;\s*)chroxy_auth=([^;]*)/)
  if (!match || !match[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
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
  const sessions = useConnectionStore(s => s.sessions)
  const activeSessionId = useConnectionStore(s => s.activeSessionId)
  const viewMode = useConnectionStore(s => s.viewMode)
  const availableModels = useConnectionStore(s => s.availableModels)
  const availablePermissionModes = useConnectionStore(s => s.availablePermissionModes)
  const serverErrors = useConnectionStore(s => s.serverErrors)
  const connectionRetryCount = useConnectionStore(s => s.connectionRetryCount)
  const filePickerFiles = useConnectionStore(s => s.filePickerFiles)

  // Listen for Tauri desktop events (no-op in browser context)
  useTauriEvents()

  // Session-level state — useShallow prevents re-renders when getActiveSessionState()
  // returns a new fallback object with the same property values
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
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([])
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth] = useState(240)
  const [sidebarFilter, setSidebarFilter] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(prev => !prev)
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
        if (target) switchSession(target.sessionId)
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
        switchSession(sessions[nextIdx]!.sessionId)
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
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [sessions, activeSessionId, switchSession, destroySession])

  const trackedCommands = useMemo(
    () => commands.map(cmd => ({
      ...cmd,
      action: () => {
        recordMruCommand(cmd.id)
        // Override new-session to open the modal instead of creating directly
        if (cmd.id === 'new-session') {
          setShowCreateSession(true)
        } else {
          cmd.action()
        }
      },
    })),
    [commands],
  )

  // Auto-connect on mount
  useEffect(() => {
    const token = getAuthToken()
    if (!token) return

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${proto}://${window.location.host}/ws`
    connect(wsUrl, token)
  }, [connect])

  // Convert store messages to ChatViewMessage[]
  const chatMessages = useMemo(
    () => storeMessages.map(toChatViewMessage),
    [storeMessages],
  )

  // Map sessions to SessionTabData[]
  const sessionTabs: SessionTabData[] = useMemo(
    () => sessions.map(s => ({
      sessionId: s.sessionId,
      name: s.name,
      isBusy: s.isBusy,
      isActive: s.sessionId === activeSessionId,
      cwd: s.cwd,
      model: s.model ?? undefined,
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
      repo.activeSessions.push({ sessionId: s.sessionId, name: s.name, isBusy: s.isBusy })
    }

    // If no repos from sessions, create a default
    if (repoMap.size === 0) {
      return []
    }

    return [...repoMap.values()]
  }, [sessions])

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

  // Toast items from server errors
  const toastItems: ToastItem[] = useMemo(
    () => serverErrors.map(e => ({ id: e.id, message: e.message })),
    [serverErrors],
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

  const handleCreateSession = useCallback((data: { name: string; cwd: string }) => {
    createSession(data.name, data.cwd || undefined)
    setShowCreateSession(false)
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
          <span className="version-badge">v{__APP_VERSION__}</span>
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
          clientCount={1}
          onFilterChange={setSidebarFilter}
          onSessionClick={switchSession}
          onResumeSession={(convId) => {
            /* Will be wired in #1107 */
            console.log('Resume session:', convId)
          }}
          onNewSession={(cwd) => {
            setPendingCwd(cwd || null)
            setShowCreateSession(true)
          }}
          onToggle={() => setSidebarOpen(prev => !prev)}
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
            onSwitch={switchSession}
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

        {/* Normal session UI */}
        {!showWelcome && (
          <>
            {/* View switcher */}
            <div className="view-switch">
              <button
                className={`view-tab${viewMode === 'chat' ? ' active' : ''}`}
                onClick={() => setViewMode('chat')}
                type="button"
              >
                Chat
              </button>
              <button
                className={`view-tab${viewMode === 'terminal' ? ' active' : ''}`}
                onClick={() => setViewMode('terminal')}
                type="button"
              >
                Output
              </button>
            </div>

            {/* Main content */}
            <div className="main-content">
              {viewMode === 'chat' && (
                <ChatView
                  messages={chatMessages}
                  isStreaming={streamingMessageId !== null}
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
            </div>

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
              isStreaming={streamingMessageId !== null}
              placeholder={isConnected ? 'Type a message... (Cmd+Enter to send)' : 'Connecting...'}
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
            />
          </>
        )}
      </div>

      {/* Modals */}
      <CreateSessionModal
        open={showCreateSession}
        onClose={() => setShowCreateSession(false)}
        onCreate={handleCreateSession}
        initialCwd={pendingCwd}
      />

      {/* Toasts */}
      <Toast items={toastItems} onDismiss={dismissServerError} />

      {/* Command palette */}
      <CommandPalette
        commands={trackedCommands}
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  )
}
