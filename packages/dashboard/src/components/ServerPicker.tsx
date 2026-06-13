/**
 * ServerPicker — UI for managing multiple Chroxy server connections.
 *
 * Shows a list of registered servers with connection status indicators.
 * Provides add/remove/switch actions and an inline "Add Server" form.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import { useConnectionStore } from '../store/connection'
import type { ServerEntry, ConnectionPhase } from '../store/types'
import { isTauri } from '../utils/tauri'
import { discoverLanServers, type DiscoveredServer } from '../utils/discovery'
import { parsePairingUrl, parsePairingCodeEntry } from '../utils/pairing'
import { requestPairing, type PairRequestState, type PairRequestHandle } from '../utils/request-pairing'

function statusDot(phase: ConnectionPhase, isActive: boolean): string {
  if (!isActive) return 'server-dot disconnected'
  switch (phase) {
    case 'connected': return 'server-dot connected'
    case 'connecting':
    case 'reconnecting': return 'server-dot connecting'
    case 'server_restarting': return 'server-dot restarting'
    case 'server_down': return 'server-dot down' // #5698 — terminal
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
    case 'server_down': return 'Server down' // #5698 — terminal
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
  onPair: (name: string, wsUrl: string, pairingId: string, identityKey?: string) => void
  /** #5510 — request approval-gated pairing for a known wss:// URL (no token). */
  onRequestPair: (name: string, wsUrl: string) => void
}

function AddServerForm({ onAdd, onCancel, error, initialName = '', initialUrl = '', onPair, onRequestPair }: AddServerFormProps) {
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
      // #5536 — pass the pinned identity from the URL `idk=` through to pairing.
      onPair(name.trim() || host, p.wsUrl, p.pairingId, p.identityKey)
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
        {/* #5510 — when a plain ws(s):// URL is known but no token/pairing id is
            present, offer approval-gated pairing: send a pair_request and wait
            for the host to approve. */}
        {!embeddedCreds && (() => {
          const trimmed = url.trim()
          const looksLikeWs = /^wss?:\/\//i.test(trimmed)
          return (
            <button
              type="button"
              className="server-btn"
              disabled={!looksLikeWs}
              onClick={() => onRequestPair(name.trim() || trimmed, trimmed)}
              data-testid="server-request-pair"
              title="Request approval-gated pairing from the host (no token needed)"
            >
              Request to pair
            </button>
          )
        })()}
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

interface RequestPairPanelProps {
  /** Normalized ws(s):// URL of the daemon to request pairing from. */
  wsUrl: string
  /** Display name to store on the registry entry once approved. */
  name: string
  /** Token in hand → store the server + connect (mirrors the ?pair= flow). */
  onApproved: (name: string, wsUrl: string, token: string) => void
  onCancel: () => void
}

/**
 * RequestPairPanel — the requester side of the pairing-approval primitive
 * (#5510, epic #5509). Opens a short-lived pre-auth WS to the daemon, sends
 * `pair_request`, shows the 6-digit verify code to compare with the host
 * surface, and waits for `pair_result`. On approval it hands the issued token up
 * so the server is added + connected exactly like the `chroxy://?pair=` flow.
 */
function RequestPairPanel({ wsUrl, name, onApproved, onCancel }: RequestPairPanelProps) {
  const [state, setState] = useState<PairRequestState>({
    phase: 'requesting', verifyCode: null, token: null, reason: null,
  })
  const handleRef = useRef<PairRequestHandle | null>(null)
  // Latch onApproved so the effect can run exactly once without re-subscribing.
  const onApprovedRef = useRef(onApproved)
  onApprovedRef.current = onApproved

  useEffect(() => {
    // deviceName identifies the REQUESTER on the approver's surface — always
    // this dashboard, never the target daemon's name (`name` only labels the
    // saved server entry on approval).
    const handle = requestPairing(wsUrl, 'Desktop Browser', (s) => {
      setState(s)
      if (s.phase === 'approved' && s.token) {
        onApprovedRef.current(name, wsUrl, s.token)
      }
    })
    handleRef.current = handle
    return () => handle.cancel()
  }, [wsUrl, name])

  const host = wsUrl.replace(/^wss?:\/\//, '').replace(/\/ws$/, '')

  return (
    <div className="server-pair-request" data-testid="request-pair-panel">
      <div className="server-pair-request-host">{host}</div>
      {(state.phase === 'requesting' || state.phase === 'code-shown') && (
        <>
          <div className="server-pair-request-status" data-testid="request-pair-status">
            {state.phase === 'requesting'
              ? 'Requesting pairing…'
              : 'Waiting for approval on the host'}
          </div>
          {state.verifyCode && (
            <>
              <div className="server-pair-request-compare">
                Compare this code with the host:
              </div>
              <div className="server-pair-request-code" data-testid="request-pair-code">
                {state.verifyCode}
              </div>
            </>
          )}
        </>
      )}
      {state.phase === 'denied' && (
        <div className="server-pair-request-status server-pair-request-status--error" data-testid="request-pair-denied">
          Pairing denied by the host.
        </div>
      )}
      {state.phase === 'expired' && (
        <div className="server-pair-request-status server-pair-request-status--error" data-testid="request-pair-expired">
          Request expired. Try again.
        </div>
      )}
      {state.phase === 'error' && (
        <div className="server-pair-request-status server-pair-request-status--error" data-testid="request-pair-error">
          Could not pair{state.reason ? ` (${state.reason})` : ''}.
        </div>
      )}
      <button
        type="button"
        className="server-btn"
        onClick={onCancel}
        data-testid="request-pair-cancel"
      >
        {state.phase === 'approved' ? 'Done' : 'Cancel'}
      </button>
    </div>
  )
}

interface HaveCodePanelProps {
  /** Pair via host + typed code — same path as the chroxy://?pair= flow (#5512). */
  onPair: (name: string, wsUrl: string, pairingId: string, identityKey?: string) => void
  onCancel: () => void
}

/**
 * HaveCodePanel — the camera-less "Have a code?" entry (#5512, epic #5509). The
 * host displays a short typeable code (read off its OWN screen → physical presence,
 * so no extra approval, matching QR trust). The user types the host + code here;
 * `parsePairingCodeEntry` synthesizes the same `chroxy://host?pair=<code>` request
 * the QR/paste path builds, so this drives the identical pairing handshake. A
 * bad/expired code is rejected SERVER-SIDE and surfaces as a `pair_fail` alert.
 */
function HaveCodePanel({ onPair, onCancel }: HaveCodePanelProps) {
  const [host, setHost] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback((e?: React.FormEvent) => {
    e?.preventDefault()
    const parsed = parsePairingCodeEntry(host, code)
    if (!parsed?.pairingId) {
      setError('Enter the host (e.g. my.tunnel.tld or 192.168.1.5:8765) and the code shown on it.')
      return
    }
    setError(null)
    let name = parsed.wsUrl
    try { name = new URL(parsed.wsUrl).host } catch { /* keep wsUrl */ }
    onPair(name, parsed.wsUrl, parsed.pairingId, parsed.identityKey)
  }, [host, code, onPair])

  return (
    <form className="server-add-form" data-testid="have-code-form" onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Host (e.g. my.tunnel.tld or 192.168.1.5:8765)"
        value={host}
        onChange={e => setHost(e.target.value)}
        className="server-input"
        data-testid="have-code-host-input"
      />
      <input
        type="text"
        placeholder="Pairing code"
        value={code}
        onChange={e => setCode(e.target.value)}
        className={`server-input${error ? ' server-input-error' : ''}`}
        data-testid="have-code-code-input"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
      />
      {error && (
        <span className="server-form-error" data-testid="have-code-error" role="alert">
          {error}
        </span>
      )}
      <div className="server-add-actions">
        <button
          type="submit"
          className="server-btn server-btn-primary"
          disabled={!host.trim() || !code.trim()}
          data-testid="have-code-submit"
        >
          Pair
        </button>
        <button
          type="button"
          className="server-btn"
          onClick={onCancel}
          data-testid="have-code-cancel"
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
  // #5513 — a redeemed ?pair= link that turned out approval-gated lands here so
  // we transparently open the request-pair flow for that host.
  const pendingApprovalPairHost = useConnectionStore(s => s.pendingApprovalPairHost)
  const clearPendingApprovalPairHost = useConnectionStore(s => s.clearPendingApprovalPairHost)

  const [showAddForm, setShowAddForm] = useState(false)
  // #5512 — camera-less "Have a code?" entry (host + typeable code).
  const [showCodeForm, setShowCodeForm] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // #5510 — active "Request to pair" round-trip (requester surface).
  const [pairRequest, setPairRequest] = useState<{ name: string; wsUrl: string } | null>(null)
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

  const handlePair = useCallback((name: string, wsUrl: string, pairingId: string, identityKey?: string) => {
    try {
      pairServer(name, wsUrl, pairingId, identityKey)
      setAddError(null)
      setShowAddForm(false)
      setShowCodeForm(false)
      setPrefill(null)
      // A bad/expired pairing id surfaces later as a pair_fail alert; the
      // optimistic entry is cleaned up there.
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to pair')
    }
  }, [pairServer])

  // #5510 — open the requester panel for a known wss:// URL.
  const handleRequestPair = useCallback((name: string, wsUrl: string) => {
    setAddError(null)
    setShowAddForm(false)
    setPrefill(null)
    setPairRequest({ name, wsUrl })
  }, [])

  // #5510 — pair_result approved with a token: store + connect like ?pair=.
  const handlePairApproved = useCallback((name: string, wsUrl: string, token: string) => {
    try {
      const entry = addServer(name, wsUrl, token)
      switchServer(entry.id)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add paired server')
    }
  }, [addServer, switchServer])

  // #5513 — when the store flags an approval-gated redemption, open the
  // request-pair panel for that host (the existing #5510 requester flow issues a
  // fresh pair_request on a new connection). Clear the signal once consumed so
  // it fires exactly once per redemption.
  useEffect(() => {
    if (!pendingApprovalPairHost) return
    setAddError(null)
    setShowAddForm(false)
    setShowCodeForm(false)
    setPrefill(null)
    setPairRequest({ name: pendingApprovalPairHost.name, wsUrl: pendingApprovalPairHost.wsUrl })
    clearPendingApprovalPairHost()
  }, [pendingApprovalPairHost, clearPendingApprovalPairHost])

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
        <div className="server-picker-header-actions">
          {/* #5512 — camera-less entry: type the host + the short code shown on it. */}
          <button
            type="button"
            className="server-btn server-have-code-btn"
            onClick={() => { setShowCodeForm(true); setShowAddForm(false); setAddError(null) }}
            data-testid="server-have-code-btn"
          >
            Have a code?
          </button>
          <button
            type="button"
            className="server-btn server-btn-add"
            onClick={() => { setShowAddForm(true); setShowCodeForm(false) }}
            data-testid="server-add-btn"
            aria-label="Add server"
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
      </div>

      {showCodeForm && (
        <HaveCodePanel
          onPair={handlePair}
          onCancel={() => setShowCodeForm(false)}
        />
      )}

      {showAddForm && (
        <AddServerForm
          key={prefill?.url ?? 'blank'}
          onAdd={handleAdd}
          onPair={handlePair}
          onRequestPair={handleRequestPair}
          onCancel={() => { setShowAddForm(false); setAddError(null); setPrefill(null) }}
          error={addError}
          initialName={prefill?.name ?? ''}
          initialUrl={prefill?.url ?? ''}
        />
      )}

      {pairRequest && (
        <RequestPairPanel
          key={pairRequest.wsUrl}
          wsUrl={pairRequest.wsUrl}
          name={pairRequest.name}
          onApproved={handlePairApproved}
          onCancel={() => setPairRequest(null)}
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
            <div
              key={srv.wsUrl}
              className="server-discover-item"
              data-testid={`server-discover-row-${srv.host}`}
            >
              <span className="server-item-info">
                <span className="server-item-name">{srv.name}</span>
                <span className="server-item-url">{srv.host}:{srv.port}{srv.version ? ` • v${srv.version}` : ''}</span>
              </span>
              <div className="server-discover-actions">
                {/* #5511 — one-click approval-gated pairing: no token needed, the
                    host approves and the issued token is stored + connected. */}
                <button
                  type="button"
                  className="server-btn server-btn-primary server-discover-pair"
                  onClick={() => handleRequestPair(srv.name, srv.wsUrl)}
                  data-testid={`server-discover-pair-${srv.host}`}
                  title={`Request to pair with ${srv.name} (no token needed)`}
                >
                  Request to pair
                </button>
                {/* Token-entry fallback: pre-fill the add form so a known token
                    can be supplied manually (#5281 ③). */}
                <button
                  type="button"
                  className="server-btn server-discover-add-btn"
                  onClick={() => handlePickDiscovered(srv)}
                  data-testid={`server-discover-item-${srv.host}`}
                  title={`Add ${srv.name} with a token`}
                >
                  Add with token
                </button>
              </div>
            </div>
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
