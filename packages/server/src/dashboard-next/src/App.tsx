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

import { ChatView } from './components/ChatView'
import { TerminalView, type TerminalHandle } from './components/TerminalView'
import { InputBar } from './components/InputBar'
import { SessionBar, type SessionTabData } from './components/SessionBar'
import { StatusBar } from './components/StatusBar'
import { PermissionPrompt } from './components/PermissionPrompt'
import { QuestionPrompt } from './components/QuestionPrompt'
import { ToolBubble } from './components/ToolBubble'
import { PlanApproval } from './components/PlanApproval'
import { ReconnectBanner } from './components/ReconnectBanner'
import { CreateSessionModal } from './components/CreateSessionModal'
import { Toast, type ToastItem } from './components/Toast'

/** Server-injected config from window.__CHROXY_CONFIG__ */
interface ChroxyConfig {
  port: number
  noEncrypt: boolean
}

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
  const terminalRawBuffer = useConnectionStore(s => s.terminalRawBuffer)
  const filePickerFiles = useConnectionStore(s => s.filePickerFiles)

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
  const setTerminalWriteCallback = useConnectionStore(s => s.setTerminalWriteCallback)
  const sendUserQuestionResponse = useConnectionStore(s => s.sendUserQuestionResponse)
  const markPromptAnswered = useConnectionStore(s => s.markPromptAnswered)
  const fetchFileList = useConnectionStore(s => s.fetchFileList)
  const fetchSlashCommands = useConnectionStore(s => s.fetchSlashCommands)

  // Local state
  const [showCreateSession, setShowCreateSession] = useState(false)

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
  const handleSend = useCallback((text: string) => {
    sendInput(text)
  }, [sendInput])

  const handleInterrupt = useCallback(() => {
    sendInterrupt()
  }, [sendInterrupt])

  const handleNewSession = useCallback(() => {
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

  const handleRetry = useCallback(() => {
    const token = getAuthToken()
    if (!token) return
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${proto}://${window.location.host}/ws`
    connect(wsUrl, token)
  }, [connect])

  // Terminal integration
  const handleTerminalReady = useCallback((handle: TerminalHandle) => {
    setTerminalWriteCallback(handle.write)
  }, [setTerminalWriteCallback])

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

  return (
    <div id="app">
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
          Terminal
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
          <TerminalView
            className="terminal-container"
            initialData={terminalRawBuffer}
            onReady={handleTerminalReady}
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
        slashCommands={slashCommands}
        onSlashTrigger={fetchSlashCommands}
      />

      {/* Modals */}
      <CreateSessionModal
        open={showCreateSession}
        onClose={() => setShowCreateSession(false)}
        onCreate={handleCreateSession}
      />

      {/* Toasts */}
      <Toast items={toastItems} onDismiss={dismissServerError} />
    </div>
  )
}
