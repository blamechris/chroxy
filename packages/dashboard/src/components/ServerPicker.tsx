/**
 * ServerPicker — UI for managing multiple Chroxy server connections.
 *
 * Shows a list of registered servers with connection status indicators.
 * Provides add/remove/switch actions and an inline "Add Server" form.
 */
import { useState, useCallback } from 'react'
import { useConnectionStore } from '../store/connection'
import type { ServerEntry, ConnectionPhase } from '../store/types'
import { isTauri } from '../utils/tauri'
import { discoverLanServers, type DiscoveredServer } from '../utils/discovery'
import { parsePairingUrl } from '../utils/pairing'

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

// #3619: relative-time renderers ("X minutes ago") deliberately stay on
// `Date.now()` because the input timestamp `ts` is itself wall-clock
// (persisted across browser refreshes / reconnects). Switching to
// `performance.now()` would compare a process-local monotonic clock
// against a wall-clock timestamp and produce nonsense. Same rationale
// applies to the analogous renderers in WelcomeScreen.tsx and
// CheckpointTimeline.tsx — pinned here as the canonical site.
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
  error: string | null
  /** Pre-fill from a LAN-discovered daemon (#5281 ③); token is still entered. */
  initialName?: string
  initialUrl?: string
  /** Pair via a pasted chroxy://…?pair= URL — no token typed (#5281 ③ PR 2). */
  onPair: (name: string, wsUrl: string, pairingId: string) => void
}

function AddServerForm({ onAdd, onCancel, error, initialName = '', initialUrl = '', onPair }: AddServerFormProps) {
  const [name, setName] = useState(initialName)
  const [url, setUrl] = useState(initialUrl)
  const [token, setToken] = useState('')

  // #5281 ③ PR 2 — a pasted connection URL can embed credentials: a pairing id
  // (?pair=) or a legacy token (?token=). Either way the token field is
  // unnecessary; we route on the embedded credential. host:port reads nicer as
  // the default name than the full ws URL.
  const parsed = parsePairingUrl(url)
  const pairingMode = !!parsed?.pairingId
  const tokenUrlMode = !pairingMode && !!parsed?.token
  const embeddedCreds = pairingMode || tokenUrlMode

  const handleSubmit = useCallback((e?: React.FormEvent) => {
    e?.preventDefault()
    const p = parsePairingUrl(url)
    let host = p?.wsUrl ?? ''
    try { if (p) host = new URL(p.wsUrl).host } catch { /* keep wsUrl */ }
    if (p?.pairingId) {
      onPair(name.trim() || host, p.wsUrl, p.pairingId)
      return
    }
    if (p?.token) {
      // Legacy ?token= URL — use the embedded token, no separate entry needed.
      onAdd(name.trim() || host, p.wsUrl, p.token)
      return
    }
    if (!url.trim() || !token.trim()) return
    onAdd(name.trim() || url.trim(), url.trim(), token.trim())
  }, [name, url, token, onAdd, onPair])

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
        placeholder="wss://your-server/ws or chroxy://…?pair=…"
        value={url}
        onChange={e => setUrl(e.target.value)}
        className={`server-input${error ? ' server-input-error' : ''}`}
        data-testid="server-url-input"
      />
      {error && (
        <span className="server-form-error" data-testid="server-url-error" role="alert">
          {error}
        </span>
      )}
      {embeddedCreds ? (
        <span className="server-form-hint" data-testid="server-pairing-hint">
          {pairingMode
            ? 'Pairing URL detected — no token needed.'
            : 'Connection URL includes a token — no token needed.'}
        </span>
      ) : (
        <input
          type="password"
          placeholder="Auth token"
          value={token}
          onChange={e => setToken(e.target.value)}
          className="server-input"
          data-testid="server-token-input"
        />
      )}
      <div className="server-add-actions">
        <button
          type="submit"
          className="server-btn server-btn-primary"
          disabled={embeddedCreds ? false : (!url.trim() || !token.trim())}
          data-testid="server-add-submit"
        >
          {pairingMode ? 'Pair' : 'Add'}
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
        aria-describedby={`server-status-${server.id}`}
      >
        <span className={statusDot(connectionPhase, isActive)} aria-label={isActive ? statusLabel(connectionPhase, true) : 'Idle'} />
        <div className="server-item-info">
          <span className="server-item-name">{server.name}</span>
          <span className="server-item-url">{server.wsUrl.replace(/^wss?:\/\//, '').replace(/\/ws$/, '')}</span>
        </div>
        <span className="server-item-status" id={`server-status-${server.id}`}>
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
  const hasLocalServer = useConnectionStore(s => s.hasLocalServer)
  const addServer = useConnectionStore(s => s.addServer)
  const removeServer = useConnectionStore(s => s.removeServer)
  const switchServer = useConnectionStore(s => s.switchServer)
  const connectLocal = useConnectionStore(s => s.connectLocal)
  const pairServer = useConnectionStore(s => s.pairServer)

  const [showAddForm, setShowAddForm] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // #5281 ③ — pre-fill the add form from a LAN-discovered daemon.
  const [prefill, setPrefill] = useState<{ name: string; url: string } | null>(null)
  // #5281 ③ — LAN discovery (desktop/Tauri only).
  const [discovered, setDiscovered] = useState<DiscoveredServer[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const canDiscover = isTauri()

  const handleAdd = useCallback((name: string, wsUrl: string, token: string) => {
    try {
      const entry = addServer(name, wsUrl, token)
      setAddError(null)
      setShowAddForm(false)
      setPrefill(null)
      // Auto-connect to newly added server
      switchServer(entry.id)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add server')
    }
  }, [addServer, switchServer])

  const handlePair = useCallback((name: string, wsUrl: string, pairingId: string) => {
    try {
      pairServer(name, wsUrl, pairingId)
      setAddError(null)
      setShowAddForm(false)
      setPrefill(null)
      // A bad/expired pairing id surfaces later as a pair_fail alert; the
      // optimistic entry is cleaned up there.
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to pair')
    }
  }, [pairServer])

  const runDiscovery = useCallback(async () => {
    setDiscovering(true)
    setDiscoverError(null)
    try {
      setDiscovered(await discoverLanServers())
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : 'Discovery failed')
      setDiscovered([])
    } finally {
      setDiscovering(false)
    }
  }, [])

  // Open the add form pre-filled from a discovered daemon. The form is keyed on
  // the prefill URL below so a fresh selection re-seeds its inputs.
  const handlePickDiscovered = useCallback((srv: DiscoveredServer) => {
    setPrefill({ name: srv.name, url: srv.wsUrl })
    setAddError(null)
    setShowAddForm(true)
  }, [])

  // Hide daemons already in the registry (match on wsUrl).
  const knownUrls = new Set(serverRegistry.map(s => s.wsUrl))
  const freshDiscovered = discovered.filter(d => !knownUrls.has(d.wsUrl))

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
          key={prefill?.url ?? 'blank'}
          onAdd={handleAdd}
          onPair={handlePair}
          onCancel={() => { setShowAddForm(false); setAddError(null); setPrefill(null) }}
          error={addError}
          initialName={prefill?.name ?? ''}
          initialUrl={prefill?.url ?? ''}
        />
      )}

      {canDiscover && (
        <div className="server-discover" data-testid="server-discover">
          <button
            type="button"
            className="server-btn server-discover-btn"
            onClick={runDiscovery}
            disabled={discovering}
            data-testid="server-discover-btn"
          >
            {discovering ? 'Scanning LAN…' : 'Discover on LAN'}
          </button>
          {discoverError && (
            <span className="server-form-error" data-testid="server-discover-error" role="alert">
              {discoverError}
            </span>
          )}
          {!discovering && !discoverError && discovered.length > 0 && freshDiscovered.length === 0 && (
            <span className="server-discover-empty" data-testid="server-discover-allknown">
              All discovered servers are already added.
            </span>
          )}
          {freshDiscovered.map(srv => (
            <button
              type="button"
              key={srv.wsUrl}
              className="server-item-main server-discover-item"
              onClick={() => handlePickDiscovered(srv)}
              data-testid={`server-discover-item-${srv.host}`}
              title={`Add ${srv.name} (${srv.host}:${srv.port})`}
            >
              <span className="server-item-info">
                <span className="server-item-name">{srv.name}</span>
                <span className="server-item-url">{srv.host}:{srv.port}{srv.version ? ` • v${srv.version}` : ''}</span>
              </span>
              <span className="server-discover-add" aria-hidden="true">+</span>
            </button>
          ))}
        </div>
      )}

      {hasLocalServer && (
        <div
          className={`server-item${activeServerId === null ? ' active' : ''}`}
          data-testid="server-item-local"
        >
          <button
            type="button"
            className="server-item-main"
            onClick={() => connectLocal()}
            title="Connect to the daemon on this machine"
          >
            <span
              className={statusDot(connectionPhase, activeServerId === null)}
              aria-label={activeServerId === null ? statusLabel(connectionPhase, true) : 'Idle'}
            />
            <div className="server-item-info">
              <span className="server-item-name">This machine</span>
              <span className="server-item-url">local daemon</span>
            </div>
            <span className="server-item-status">
              {activeServerId === null ? statusLabel(connectionPhase, true) : 'Idle'}
            </span>
          </button>
        </div>
      )}

      {serverRegistry.length === 0 && !showAddForm && !hasLocalServer && (
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
