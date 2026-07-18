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
 *
 * #6790 — `className` / `testId` are overridable so non-bubble hosts (the
 * dev-preview chip) can reuse the full copy behaviour (clipboard write,
 * failure toast, ✓ state, sr-only announcement) without inheriting
 * `.msg-copy-btn`'s bubble-specific CSS (absolute top-right positioning,
 * hidden until `.msg:hover`). Defaults preserve the original bubble usage.
 */
export function CopyButton({
  content,
  label = 'Copy response',
  className = 'msg-copy-btn',
  testId = 'msg-copy-button',
}: {
  content: string
  label?: string
  className?: string
  testId?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const onCopy = useCallback(
    (e: MouseEvent) => {
      // Don't let the copy click also trigger the bubble/row click handlers
      // (e.g. the #6625 link handler or a future select-message gesture).
      e.stopPropagation()
      // Reset the confirmation at the start of every attempt so the visual
      // state always reflects the LATEST click — a re-click whose write then
      // fails must not keep showing a stale ✓ until the old timer expires.
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
      setCopied(false)
      void writeText(content).then((ok) => {
        if (!mounted.current) return // row windowed-out mid-write — don't touch state
        if (!ok) {
          useConnectionStore.getState().addServerError('Failed to copy to clipboard. Please try again.', undefined, 'warning')
          return
        }
        setCopied(true)
        timer.current = setTimeout(() => { if (mounted.current) setCopied(false) }, 1500)
      })
    },
    [content],
  )

  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={copied ? 'Copied' : label}
        title={copied ? 'Copied' : label}
        data-testid={testId}
        data-copied={copied ? 'true' : undefined}
        onClick={onCopy}
      >
        {copied ? '✓' : '⧉'}
      </button>
      {/* #6631: announce the success to AT — an aria-label flip on an already-
          focused control isn't reliably re-announced across screen readers. */}
      <span className="sr-only" role="status" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </>
  )
}
