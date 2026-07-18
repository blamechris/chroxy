/**
 * DevPreviewChip — dashboard surface for active dev-server preview tunnels (#6790).
 *
 * The server auto-detects a localhost dev server started inside a session,
 * opens an ephemeral Cloudflare tunnel, and pushes the resulting
 * `{ port, url }` pair into the session's `devPreviews` array (see
 * `packages/store-core/src/handlers/dev-preview.ts`). The dashboard store
 * has tracked this state and exposed a `closeDevPreview` action
 * (`connection.ts`) since #614, but no dashboard component ever read it —
 * this is the first UI consumer, mirroring the mobile app's
 * `DevPreviewBanner` (`packages/app/src/components/DevPreviewBanner.tsx`),
 * which opens the URL via `Linking.openURL` (OS browser) on tap.
 *
 * Renders one small chip per active preview: a link that opens the tunnel
 * URL in a new tab, a copy-URL button, and a dismiss control that calls
 * `closeDevPreview`. Renders nothing when there are no active previews, and
 * updates live as `devPreviews` changes (the caller feeds this from the
 * active session's store state, so a `dev_preview` / `dev_preview_stopped`
 * dispatch re-renders it automatically).
 *
 * Does NOT embed the preview — that's #6789's scope (an inline iframe /
 * webview pane). This is deliberately the minimal "so the URL is
 * discoverable" fix: the server already does the hard part (detection +
 * tunnel), the dashboard just needed to show it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { writeText } from '../utils/clipboard'
import { useConnectionStore } from '../store/connection'
import type { DevPreview } from '../store/types'

export interface DevPreviewChipProps {
  previews: DevPreview[]
  onClose: (port: number) => void
}

/** A single chip: open link + copy + dismiss for one active dev preview. */
function DevPreviewChipItem({ preview, onClose }: { preview: DevPreview; onClose: (port: number) => void }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const onCopy = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    setCopied(false)
    void writeText(preview.url).then((ok) => {
      if (!mounted.current) return
      if (!ok) {
        useConnectionStore.getState().addServerError('Failed to copy dev preview URL. Please try again.', undefined, 'warning')
        return
      }
      setCopied(true)
      timer.current = setTimeout(() => { if (mounted.current) setCopied(false) }, 1500)
    })
  }, [preview.url])

  return (
    <span
      className="dev-preview-chip"
      data-testid={`dev-preview-chip-${preview.port}`}
      title={preview.url}
    >
      <a
        className="dev-preview-chip__link"
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open dev preview on port ${preview.port}: ${preview.url}`}
      >
        <span className="dev-preview-chip__icon" aria-hidden="true">{'\u{1F310}'}</span>
        <span className="dev-preview-chip__port">:{preview.port}</span>
      </a>
      <button
        type="button"
        className="dev-preview-chip__copy"
        data-testid={`dev-preview-chip-copy-${preview.port}`}
        data-copied={copied ? 'true' : undefined}
        onClick={onCopy}
        aria-label={copied ? 'Copied' : `Copy dev preview URL: ${preview.url}`}
        title={copied ? 'Copied' : 'Copy URL'}
      >
        {copied ? '✓' : '⧉'}
      </button>
      <button
        type="button"
        className="dev-preview-chip__close"
        data-testid={`dev-preview-chip-close-${preview.port}`}
        onClick={() => onClose(preview.port)}
        aria-label={`Dismiss dev preview on port ${preview.port}`}
        title="Dismiss dev preview"
      >
        &times;
      </button>
    </span>
  )
}

export function DevPreviewChip({ previews, onClose }: DevPreviewChipProps) {
  // Defensive: several App-level test fixtures mock `getActiveSessionState()`
  // with a partial shape that predates this field (App.test.tsx), so
  // `previews` can arrive `undefined` at runtime despite the required prop
  // type. Treat that the same as "no active previews" rather than crashing.
  if (!previews || previews.length === 0) return null

  return (
    <div className="dev-preview-chips" data-testid="dev-preview-chips">
      {previews.map(preview => (
        <DevPreviewChipItem key={preview.port} preview={preview} onClose={onClose} />
      ))}
    </div>
  )
}
