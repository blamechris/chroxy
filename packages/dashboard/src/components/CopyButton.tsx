import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { writeText } from '../utils/clipboard'
import { useConnectionStore } from '../store/connection'

/**
 * #6631 — a subtle "copy" control for a response bubble. Copies `content` to the
 * OS clipboard via the shared clipboard helper (Tauri native plugin in
 * WKWebView, `navigator.clipboard` otherwise — see utils/clipboard), showing a
 * brief ✓ confirmation. A failed write surfaces a non-destructive `warning`
 * toast, mirroring App.tsx's `copyToClipboard`. The layout leaves room for
 * future per-response actions alongside it.
 */
export function CopyButton({ content, label = 'Copy response' }: { content: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const onCopy = useCallback(
    (e: MouseEvent) => {
      // Don't let the copy click also trigger the bubble/row click handlers
      // (e.g. the #6625 link handler or a future select-message gesture).
      e.stopPropagation()
      void writeText(content).then((ok) => {
        if (!ok) {
          useConnectionStore.getState().addServerError('Failed to copy to clipboard. Please try again.', undefined, 'warning')
          return
        }
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      })
    },
    [content],
  )

  return (
    <button
      type="button"
      className="msg-copy-btn"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      data-testid="msg-copy-button"
      data-copied={copied ? 'true' : undefined}
      onClick={onCopy}
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}
