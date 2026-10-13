import { useState } from 'react'
import { isDevPreviewPending, type DevPreviewRequestState } from '@chroxy/store-core'

export function DevPreviewRequest({ onOpen, onClose, requests }: { onOpen?: (port: number) => boolean; onClose?: (port: number) => void; requests?: DevPreviewRequestState[] }) {
  const [port, setPort] = useState('')
  const [sentPort, setSentPort] = useState<number | null>(null)
  const [error, setError] = useState('')
  if (!onOpen) return null
  const value = Number(port)
  const valid = /^\d+$/.test(port) && Number.isInteger(value) && value >= 1024 && value <= 65535
  const status = requests?.find(request => request.port === sentPort)
  const pending = sentPort !== null && (status ? isDevPreviewPending(status) : requests === undefined)
  return (
    <details className="dev-preview-request">
      <summary>Preview HTTP service</summary>
      <form onSubmit={event => { event.preventDefault(); if (valid && !pending) { const admitted = onOpen(value); if (admitted) setSentPort(value); setError(admitted === true ? '' : 'Preview request was not sent. Reconnect to this session and try again.') } }}>
        <p>Publish a service running in this session directory on 127.0.0.1. HTTP only; no WebSockets or reconnect. Primary token required.</p>
        <p>The public URL adds no authentication. Review the actual service and choose Allow once in the consent prompt.</p>
        <label>Service port <input aria-label="Preview service port" inputMode="numeric" value={port} onChange={event => setPort(event.target.value)} /></label>
        <button type="submit" disabled={!valid || pending}>Request preview consent</button>
        {error && <p role="alert">{error}</p>}
        {sentPort !== null && <p role="status" data-testid="dev-preview-request-status">Port {sentPort}: {status?.reason || (status ? `HTTP preview ${status.state.replace('_', ' ')}` : requests !== undefined ? 'Connection changed. HTTP preview status is unconfirmed; reconnect before requesting a new preview.' : 'Request sent. Review the consent prompt before publication.')}</p>}
        {pending && <button type="button" disabled={status?.state === 'closing'} onClick={() => onClose?.(sentPort!)}>{status?.state === 'active' || status?.state === 'stop_failed' ? 'Close preview' : 'Cancel preview'}</button>}
      </form>
    </details>
  )
}
