import { useState, useEffect, useCallback, useRef } from 'react'
import DOMPurify from 'dompurify'
import { getAuthToken } from '../utils/auth'
import { LogPanel } from './LogPanel'

interface ConnectionInfo {
  connectionUrl: string
  wsUrl: string
  httpUrl: string
  apiToken: string
  tunnelMode: string
}

export function ConsolePage() {
  const [connInfo, setConnInfo] = useState<ConnectionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [settingUpTunnel, setSettingUpTunnel] = useState(false)
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Fetch connection info on mount, retry while tunnel is being set up
  useEffect(() => {
    const token = getAuthToken()
    if (!token) {
      setError('No auth token available')
      setLoading(false)
      return
    }

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    async function fetchData() {
      try {
        const res = await fetch('/connect', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Request failed' }))
          const errMsg = body.error || `HTTP ${res.status}`
          // If connection info isn't available yet, keep polling (tunnel still setting up)
          if (res.status === 404 && !cancelled) {
            setSettingUpTunnel(true)
            setLoading(false)
            retryTimer = setTimeout(fetchData, 3000)
            return
          }
          if (!cancelled) setError(errMsg)
        } else {
          const data = await res.json()
          if (!cancelled) {
            setConnInfo(data)
            setSettingUpTunnel(false)
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to fetch')
      } finally {
        if (!cancelled) setLoading(false)
      }

      // Fetch QR code
      try {
        const qrRes = await fetch('/qr', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (qrRes.ok) {
          const svg = await qrRes.text()
          if (!cancelled) setQrSvg(svg)
        }
      } catch {
        // QR is optional — don't set error
      }
    }

    fetchData()
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer) }
  }, [])

  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear copy feedback timer on unmount
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const copyToClipboard = useCallback((text: string, label: string) => {
    if (!navigator.clipboard) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(null), 2000)
    }).catch(() => {
      // Clipboard write failed (e.g. insecure context) — ignore silently
    })
  }, [])

  if (loading) {
    return (
      <div className="console-page">
        <h2>Connection Info</h2>
        <div className="console-loading">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="console-page">
        <h2>Connection Info</h2>
        <div className="console-error">{error}</div>
      </div>
    )
  }

  if (!connInfo) {
    return (
      <div className="console-page">
        <h2>Connection Info</h2>
        {settingUpTunnel ? (
          <div className="console-tunnel-setup">
            <div className="console-tunnel-spinner" />
            <span>Setting up Cloudflare tunnel...</span>
          </div>
        ) : (
          <div className="console-error">No connection info available</div>
        )}
        <h2>Server Logs</h2>
        <LogPanel />
      </div>
    )
  }

  const dashboardUrl = `${connInfo.httpUrl}/dashboard?token=${encodeURIComponent(connInfo.apiToken)}`

  return (
    <div className="console-page">
      <h2>Connection Info</h2>

      <div className="console-card">
        {/* Tunnel URL */}
        <div className="console-row">
          <span className="console-label">Tunnel URL</span>
          <span className="console-value" data-testid="tunnel-url">{connInfo.httpUrl}</span>
          <button
            className="console-copy-btn"
            data-testid="copy-tunnel-url"
            onClick={() => copyToClipboard(connInfo.httpUrl, 'tunnel')}
            type="button"
          >
            {copied === 'tunnel' ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {/* Dashboard Link */}
        <div className="console-row">
          <span className="console-label">Dashboard</span>
          <span className="console-value" data-testid="dashboard-url">{connInfo.httpUrl}/dashboard</span>
          <button
            className="console-copy-btn"
            data-testid="copy-dashboard-url"
            onClick={() => copyToClipboard(dashboardUrl, 'dashboard')}
            type="button"
          >
            {copied === 'dashboard' ? 'Copied!' : 'Copy'}
          </button>
          <a
            href={dashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="console-open-btn"
          >
            Open
          </a>
        </div>

        {/* API Token */}
        <div className="console-row">
          <span className="console-label">API Token</span>
          <span className="console-value console-token" data-testid="token-value">
            {tokenRevealed ? connInfo.apiToken : '••••••••'}
          </span>
          <button
            className="console-copy-btn"
            data-testid="token-reveal"
            onClick={() => setTokenRevealed(prev => !prev)}
            type="button"
          >
            {tokenRevealed ? 'Hide' : 'Reveal'}
          </button>
          <button
            className="console-copy-btn"
            data-testid="copy-token"
            onClick={() => copyToClipboard(connInfo.apiToken, 'token')}
            type="button"
          >
            {copied === 'token' ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {/* Tunnel Mode */}
        <div className="console-row">
          <span className="console-label">Tunnel Mode</span>
          <span className="console-value">{connInfo.tunnelMode}</span>
        </div>
      </div>

      {/* QR Code */}
      {qrSvg && (
        <div className="console-qr-section">
          <h3>Pair Mobile App</h3>
          <div
            className="console-qr"
            data-testid="qr-container"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(qrSvg, { USE_PROFILES: { svg: true } }),
            }}
          />
          <p className="console-qr-hint">Scan with the Chroxy app to pair your phone</p>
        </div>
      )}

      {/* Server Logs */}
      <h2>Server Logs</h2>
      <LogPanel />
    </div>
  )
}
