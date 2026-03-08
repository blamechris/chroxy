/**
 * ServerPicker — UI for managing multiple Chroxy server connections.
 *
 * Shows a list of registered servers with connection status indicators.
 * Provides add/remove/switch actions and an inline "Add Server" form.
 */
import { useState, useCallback } from 'react'
import { useConnectionStore } from '../store/connection'
import type { ServerEntry, ConnectionPhase } from '../store/types'

function statusDot(phase: ConnectionPhase, isActive: boolean): string {
  if (!isActive) return 'server-dot disconnected'
  switch (phase) {
    case 'connected': return 'server-dot connected'
    case 'connecting':
    case 'reconnecting': return 'server-dot connecting'
    case 'server_restarting': return 'server-dot restarting'
    default: return 'server-dot disconnected'
  }
}

function statusLabel(phase: ConnectionPhase, isActive: boolean): string {
  if (!isActive) return 'Idle'
  switch (phase) {
    case 'connected': return 'Connected'
    case 'connecting': return 'Connecting...'
    case 'reconnecting': return 'Reconnecting...'
    case 'server_restarting': return 'Restarting...'
    default: return 'Disconnected'
  }
}

function formatLastConnected(ts: number | null): string {
  if (!ts) return 'Never connected'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString()
}

interface AddServerFormProps {
  onAdd: (name: string, wsUrl: string, token: string) => void
  onCancel: () => void
}

function AddServerForm({ onAdd, onCancel }: AddServerFormProps) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')

  const handleSubmit = useCallback((e?: React.FormEvent) => {
    e?.preventDefault()
    if (!url.trim() || !token.trim()) return
    onAdd(name.trim() || url.trim(), url.trim(), token.trim())
  }, [name, url, token, onAdd])

  return (
    <form className="server-add-form" data-testid="server-add-form" onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Server name (optional)"
        value={name}
        onChange={e => setName(e.target.value)}
        className="server-input"
        data-testid="server-name-input"
      />
      <input
        type="text"
        placeholder="wss://your-server.example.com/ws"
        value={url}
        onChange={e => setUrl(e.target.value)}
        className="server-input"
        data-testid="server-url-input"
      />
      <input
        type="password"
        placeholder="Auth token"
        value={token}
        onChange={e => setToken(e.target.value)}
        className="server-input"
        data-testid="server-token-input"
      />
      <div className="server-add-actions">
        <button
          type="submit"
          className="server-btn server-btn-primary"
          disabled={!url.trim() || !token.trim()}
          data-testid="server-add-submit"
        >
          Add
        </button>
        <button
          type="button"
          className="server-btn"
          onClick={onCancel}
          data-testid="server-add-cancel"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

interface ServerItemProps {
  server: ServerEntry
  isActive: boolean
  connectionPhase: ConnectionPhase
  onConnect: () => void
  onRemove: () => void
}

function ServerItem({ server, isActive, connectionPhase, onConnect, onRemove }: ServerItemProps) {
  const [confirmRemove, setConfirmRemove] = useState(false)

  return (
    <div
      className={`server-item${isActive ? ' active' : ''}`}
      data-testid="server-item"
    >
      <button
        type="button"
        className="server-item-main"
        onClick={onConnect}
        title={`Connect to ${server.name}`}
      >
        <span className={statusDot(connectionPhase, isActive)} />
        <div className="server-item-info">
          <span className="server-item-name">{server.name}</span>
          <span className="server-item-url">{server.wsUrl.replace(/^wss?:\/\//, '').replace(/\/ws$/, '')}</span>
        </div>
        <span className="server-item-status">
          {isActive ? statusLabel(connectionPhase, true) : formatLastConnected(server.lastConnectedAt)}
        </span>
      </button>
      {confirmRemove ? (
        <div className="server-item-confirm">
          <button
            type="button"
            className="server-btn server-btn-danger"
            onClick={() => { setConfirmRemove(false); onRemove() }}
            data-testid="server-remove-confirm"
          >
            Remove
          </button>
          <button
            type="button"
            className="server-btn"
            onClick={() => setConfirmRemove(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="server-remove-btn"
          onClick={() => setConfirmRemove(true)}
          aria-label={`Remove ${server.name}`}
          data-testid="server-remove-btn"
        >
          <span aria-hidden="true">&times;</span>
        </button>
      )}
    </div>
  )
}

export function ServerPicker() {
  const serverRegistry = useConnectionStore(s => s.serverRegistry)
  const activeServerId = useConnectionStore(s => s.activeServerId)
  const connectionPhase = useConnectionStore(s => s.connectionPhase)
  const addServer = useConnectionStore(s => s.addServer)
  const removeServer = useConnectionStore(s => s.removeServer)
  const switchServer = useConnectionStore(s => s.switchServer)

  const [showAddForm, setShowAddForm] = useState(false)

  const handleAdd = useCallback((name: string, wsUrl: string, token: string) => {
    const entry = addServer(name, wsUrl, token)
    setShowAddForm(false)
    // Auto-connect to newly added server
    switchServer(entry.id)
  }, [addServer, switchServer])

  return (
    <div className="server-picker" data-testid="server-picker">
      <div className="server-picker-header">
        <span className="server-picker-title">Servers</span>
        <button
          type="button"
          className="server-btn server-btn-add"
          onClick={() => setShowAddForm(true)}
          data-testid="server-add-btn"
          aria-label="Add server"
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>

      {showAddForm && (
        <AddServerForm
          onAdd={handleAdd}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {serverRegistry.length === 0 && !showAddForm && (
        <div className="server-empty" data-testid="server-empty">
          No servers configured.
        </div>
      )}

      {serverRegistry.map(server => (
        <ServerItem
          key={server.id}
          server={server}
          isActive={server.id === activeServerId}
          connectionPhase={server.id === activeServerId ? connectionPhase : 'disconnected'}
          onConnect={() => switchServer(server.id)}
          onRemove={() => removeServer(server.id)}
        />
      ))}
    </div>
  )
}
