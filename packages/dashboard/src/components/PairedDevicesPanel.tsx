/**
 * PairedDevicesPanel (#6678, part of epic #6597) — list and revoke the paired
 * devices (session tokens) the daemon has issued.
 *
 * The `chroxy tokens list` / `tokens revoke` CLI (#6599) landed first, but it
 * edits the PERSISTED store and only takes effect on the daemon's NEXT start.
 * This panel drives the LIVE surface instead: it fetches GET /api/paired-devices
 * (the running daemon's in-memory PairingManager roster) and revokes via
 * DELETE /api/paired-devices/:id (per-device) or DELETE /api/paired-devices
 * (revoke-all panic button), so a revoke takes effect immediately — the device's
 * next connect fails auth, no restart required.
 *
 * All three routes are PRIMARY-token only server-side (a scoped/paired device
 * must not enumerate or revoke its siblings), so the panel just forwards the
 * dashboard's auth token like SnapshotsPanel does.
 *
 * Device labels (deviceName) are not captured yet — the wire carries a
 * `deviceName` field for the follow-up, and until then a device is identified by
 * its session binding + age.
 */
import { useCallback, useEffect, useState } from 'react'
import { getAuthToken } from '../utils/auth'

export interface PairedDevice {
  /** Stable, non-reversible wire id (never the token itself). */
  id: string
  /** Bound session, or null for an unbound/full-access (linking-mode) token. */
  sessionId: string | null
  /** When the token was minted or last refreshed (sliding), epoch ms. */
  createdAt: number | null
  /** now − createdAt at fetch time, ms. */
  ageMs: number | null
  /** Optional device label — not captured yet (deviceName follow-up). */
  deviceName: string | null
}

interface PairedDevicesPanelProps {
  /** Override the fetch impl. Tests inject a stub; production uses window.fetch. */
  fetchImpl?: typeof fetch
  /** Override the auth-token resolver. Tests pass a fixed string. */
  getToken?: () => string | null
}

/** Human-readable relative age; '' when unknown. */
function formatAge(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

/** A short, readable session handle for display. */
function shortSession(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId
}

function DeviceCard({
  device,
  onRevoke,
  isRevoking,
}: {
  device: PairedDevice
  onRevoke: (id: string) => void
  isRevoking: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const age = formatAge(device.ageMs)
  const title = device.deviceName || (device.sessionId ? 'Paired device' : 'Paired device (full access)')

  return (
    <div className="env-card" data-testid={`paired-device-card-${device.id}`}>
      <div className="env-card-header">
        <span className="env-card-name" data-testid={`paired-device-name-${device.id}`}>
          {title}
        </span>
        {age && (
          <span
            className="env-status-badge"
            data-testid={`paired-device-age-${device.id}`}
            style={{ color: 'var(--text-secondary)' }}
            title="Time since this device last connected (the token slides on each connect)"
          >
            Last seen {age}
          </span>
        )}
      </div>
      <div className="env-card-details">
        <div className="env-card-row">
          <span className="env-card-label">Access</span>
          <span className="env-card-value" data-testid={`paired-device-access-${device.id}`}>
            {device.sessionId ? 'Single session' : 'Full access (unbound)'}
          </span>
        </div>
        {device.sessionId && (
          <div className="env-card-row">
            <span className="env-card-label">Session</span>
            <span
              className="env-card-value"
              style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.85em' }}
            >
              {shortSession(device.sessionId)}
            </span>
          </div>
        )}
      </div>
      <div className="env-card-actions">
        {!confirming ? (
          <button
            className="btn-env-destroy"
            data-testid={`paired-device-revoke-${device.id}`}
            onClick={() => setConfirming(true)}
            disabled={isRevoking}
            title="Revoke this device (it must re-pair to reconnect)"
          >
            {isRevoking ? 'Revoking…' : 'Revoke'}
          </button>
        ) : (
          <div className="env-confirm-row">
            <span>Revoke this device?</span>
            <button
              className="btn-env-confirm-yes"
              data-testid={`paired-device-confirm-yes-${device.id}`}
              onClick={() => {
                setConfirming(false)
                onRevoke(device.id)
              }}
            >
              Yes
            </button>
            <button
              className="btn-env-confirm-no"
              data-testid={`paired-device-confirm-no-${device.id}`}
              onClick={() => setConfirming(false)}
            >
              No
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function PairedDevicesPanel({ fetchImpl, getToken }: PairedDevicesPanelProps = {}) {
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokingAll, setRevokingAll] = useState<boolean>(false)
  const [confirmingAll, setConfirmingAll] = useState<boolean>(false)

  const resolvedFetch: typeof fetch =
    fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => window.fetch(input, init))
  const resolvedGetToken = getToken ?? getAuthToken

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const token = resolvedGetToken()
    try {
      const res = await resolvedFetch('/api/paired-devices', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
      }
      const body = (await res.json()) as { devices: PairedDevice[] }
      setDevices(Array.isArray(body.devices) ? body.devices : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load paired devices')
    } finally {
      setLoading(false)
    }
  }, [resolvedFetch, resolvedGetToken])

  const handleRevoke = useCallback(
    async (id: string) => {
      setRevokingId(id)
      setError(null)
      const token = resolvedGetToken()
      try {
        const res = await resolvedFetch(`/api/paired-devices/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
          throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
        }
        // Drop locally so the row disappears immediately; refresh reconciles.
        setDevices((prev) => prev.filter((d) => d.id !== id))
        void refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to revoke device')
      } finally {
        setRevokingId(null)
      }
    },
    [refresh, resolvedFetch, resolvedGetToken],
  )

  const handleRevokeAll = useCallback(async () => {
    setRevokingAll(true)
    setError(null)
    setConfirmingAll(false)
    const token = resolvedGetToken()
    try {
      const res = await resolvedFetch('/api/paired-devices', {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
      }
      setDevices([])
      void refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke all devices')
    } finally {
      setRevokingAll(false)
    }
  }, [refresh, resolvedFetch, resolvedGetToken])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The revoke-all confirmation UI only renders behind `devices.length > 0`,
  // so once the roster empties there's no "No" button left to dismiss it —
  // clear it here instead. Otherwise a stale `confirmingAll=true` survives
  // an empty roster and the "Revoke ALL devices?" prompt unexpectedly
  // reopens the moment a device reappears (refresh / new pairing).
  useEffect(() => {
    if (devices.length === 0 && confirmingAll) {
      setConfirmingAll(false)
    }
  }, [devices.length, confirmingAll])

  return (
    <div className="environment-panel" data-testid="paired-devices-panel">
      <div className="env-panel-header">
        <h2>Paired devices</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {devices.length > 0 &&
            (!confirmingAll ? (
              <button
                className="btn-env-destroy"
                data-testid="paired-devices-revoke-all"
                onClick={() => setConfirmingAll(true)}
                disabled={revokingAll || loading}
                title="Revoke every paired device — all must re-pair"
              >
                {revokingAll ? 'Revoking all…' : 'Revoke all'}
              </button>
            ) : (
              <div className="env-confirm-row" data-testid="paired-devices-revoke-all-confirm">
                <span>Revoke ALL devices?</span>
                <button
                  className="btn-env-confirm-yes"
                  data-testid="paired-devices-revoke-all-yes"
                  onClick={() => void handleRevokeAll()}
                >
                  Yes
                </button>
                <button
                  className="btn-env-confirm-no"
                  data-testid="paired-devices-revoke-all-no"
                  onClick={() => setConfirmingAll(false)}
                >
                  No
                </button>
              </div>
            ))}
          <button
            className="btn-env-new"
            data-testid="paired-devices-refresh"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div
          className="env-empty"
          data-testid="paired-devices-error"
          style={{ color: 'var(--status-error, #ef4444)' }}
        >
          {error}
        </div>
      )}

      {!error && !loading && devices.length === 0 && (
        <div className="env-empty" data-testid="paired-devices-empty">
          <p>No paired devices.</p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9em' }}>
            Devices pair by scanning the QR or entering the pairing code. A paired
            device holds a session token so it can reconnect without re-scanning —
            revoke one here to force it to re-pair.
          </p>
        </div>
      )}

      <div className="env-grid">
        {devices.map((device) => (
          <DeviceCard
            key={device.id}
            device={device}
            onRevoke={handleRevoke}
            isRevoking={revokingId === device.id}
          />
        ))}
      </div>
    </div>
  )
}
