import { useState } from 'react'

export function DevPreviewRequest({ onOpen, onClose }: { onOpen?: (port: number) => boolean; onClose?: (port: number) => void }) {
  const [port, setPort] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  if (!onOpen) return null
  const value = Number(port)
  const valid = /^\d+$/.test(port) && Number.isInteger(value) && value >= 1024 && value <= 65535
  return (
    <details className="dev-preview-request">
      <summary>Preview HTTP service</summary>
      <form onSubmit={event => { event.preventDefault(); if (valid) { const admitted = onOpen(value); setSent(admitted === true); setError(admitted === true ? '' : 'Preview request was not sent. Reconnect to this session and try again.') } }}>
        <p>Publish a service running in this session directory on 127.0.0.1. HTTP only; no WebSockets or reconnect. Primary token required.</p>
        <p>The public URL adds no authentication. Review the actual service and choose Allow once in the consent prompt.</p>
        <label>Service port <input aria-label="Preview service port" inputMode="numeric" value={port} onChange={event => { setPort(event.target.value); setSent(false) }} /></label>
        <button type="submit" disabled={!valid}>Request preview consent</button>
        {error && <p role="alert">{error}</p>}
        {sent && <><p role="status">Request sent. Review the consent prompt before publication.</p><button type="button" onClick={() => { onClose?.(value); setSent(false) }}>Cancel preview</button></>}
      </form>
    </details>
  )
}
