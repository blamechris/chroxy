/**
 * App — root component wiring all dashboard components to the Zustand store.
 *
 * Auto-connects to the server on mount using the injected config + auth cookie.
 * Layout: header → session bar → view switcher → main content → input bar.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useConnectionStore } from './store/connection'
import type { ChatMessage } from './store/connection'
import type { ChatViewMessage } from './components/ChatView'

import { ChatView } from './components/ChatView'
import { TerminalView, type TerminalHandle } from './components/TerminalView'
import { InputBar } from './components/InputBar'
import { SessionBar, type SessionTabData } from './components/SessionBar'
import { StatusBar } from './components/StatusBar'
import { PermissionPrompt } from './components/PermissionPrompt'
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

/** Read chroxy_auth cookie value */
function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
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

  // Session-level state
  const sessionState = useConnectionStore(s => s.getActiveSessionState())
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
  } = sessionState

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

  // Local state
  const [showCreateSession, setShowCreateSession] = useState(false)
  const inputBarRef = useRef<HTMLTextAreaElement>(null)

  // Auto-connect on mount
  useEffect(() => {
    const token = getCookie('chroxy_auth')
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
    inputBarRef.current?.focus()
  }, [])

  const handleRetry = useCallback(() => {
    const token = getCookie('chroxy_auth')
    if (!token) return
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${proto}://${window.location.host}/ws`
    connect(wsUrl, token)
  }, [connect])

  // Terminal integration
  const handleTerminalReady = useCallback((handle: TerminalHandle) => {
    setTerminalWriteCallback(handle.write)
  }, [setTerminalWriteCallback])

  // Custom message renderer for permission prompts and tool bubbles
  const renderMessage = useCallback((msg: ChatViewMessage) => {
    // Find the corresponding store message for full data
    const storeMsg = storeMessages.find(m => m.id === msg.id)
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
  }, [storeMessages, sendPermissionResponse])

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
          planHtml="<p>Claude has prepared a plan for your review.</p>"
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
