import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuthToken } from '../utils/auth'
import { useConnectionStore } from '../store/connection'
import './ContinuationOpportunities.css'

interface Opportunity {
  id: string
  seedPath: string
  cwd: string
  ts: number
  available: boolean
  unavailable: string | null
}

/** A path-only announcement never creates a session until Continue is pressed. */
export function ContinuationOpportunities({ connected, onContinue }: {
  connected: boolean
  onContinue: (options: { cwd: string; seed: string }) => void
}) {
  const apiToken = useConnectionStore((state) => state.apiToken)
  const wsUrl = useConnectionStore((state) => state.wsUrl)
  const [items, setItems] = useState<Opportunity[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dismissed = useRef(new Map<string, number>())
  const controller = useRef<AbortController | null>(null)
  const continuing = useRef(false)

  const refresh = useCallback(async () => {
    const token = apiToken || getAuthToken()
    if (!connected || !token) return null
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    const timeout = setTimeout(() => request.abort(), 5000)
    try {
      const endpoint = wsUrl ? new URL('/api/continuations', wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')).href : '/api/continuations'
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        signal: request.signal,
        cache: 'no-store',
      })
      // Old servers and session-bound clients have no global continuation view.
      if (response.status === 404 || response.status === 403) {
        setItems([])
        return null
      }
      if (!response.ok) throw new Error('unavailable')
      const body = await response.json()
      if (request.signal.aborted) return null
      if (!Array.isArray(body.continuations)) throw new Error('invalid response')
      const next: Opportunity[] = body.continuations.filter((item: Opportunity) =>
        typeof item.id === 'string' && typeof item.seedPath === 'string' && typeof item.cwd === 'string' &&
        typeof item.ts === 'number' && typeof item.available === 'boolean')
      setItems(next)
      setError(null)
      return next
    } catch {
      if (!request.signal.aborted) setError('Unable to check this seed. Copy the path below and continue manually.')
      return null
    } finally { clearTimeout(timeout) }
  }, [connected, apiToken, wsUrl])

  useEffect(() => {
    setItems([])
    setError(null)
    dismissed.current.clear()
    if (!connected) { setItems([]); return }
    const check = () => { if (!document.hidden && !continuing.current) void refresh() }
    check()
    const timer = setInterval(check, 15_000)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(timer)
      controller.current?.abort()
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [connected, refresh])

  const visible = items.filter((item) => dismissed.current.get(item.id) !== item.ts)
  if (!connected || visible.length === 0) return null
  return <section aria-label="Continue from seed" className="continuation-opportunities">
    {visible.map((item) => <div key={item.id} className="continuation-opportunity">
      <strong>Wave complete — next session ready</strong>
      <div className="continuation-path">{item.seedPath}</div>
      <div className="continuation-path">{item.cwd}</div>
      {(!item.available || error) && <p role="status">{error || `Seed unavailable (${item.unavailable || 'unknown'}). Copy the path above and continue manually.`}</p>}
      <button type="button" disabled={busy || !item.available} onClick={async () => {
        if (continuing.current) return
        continuing.current = true
        setBusy(true)
        try {
          const fresh = (await refresh())?.find((next) => next.id === item.id && next.ts === item.ts)
          if (!fresh?.available) {
            setError('Seed unavailable or changed. Copy the path above and continue manually.')
            return
          }
          onContinue({ cwd: fresh.cwd, seed: fresh.seedPath })
          dismissed.current.set(item.id, item.ts)
          setItems((current) => [...current])
        } finally { continuing.current = false; setBusy(false) }
      }}>Continue from seed</button>
      <button type="button" onClick={() => {
        dismissed.current.set(item.id, item.ts)
        setItems((current) => [...current])
      }}>Dismiss</button>
    </div>)}
  </section>
}
