/**
 * TerminalView — React wrapper for xterm.js with direct DOM integration.
 *
 * Uses xterm.js as a direct npm import (not WebView like mobile).
 * FitAddon handles responsive sizing. Write batching coalesces
 * rapid writes into single xterm.write() calls.
 */
import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface TerminalHandle {
  write: (data: string) => void
  clear: () => void
}

export interface TerminalViewProps {
  className?: string
  initialData?: string
  onReady?: (handle: TerminalHandle) => void
}

const BATCH_INTERVAL = 50 // ms — coalesce rapid writes
const RESIZE_DEBOUNCE = 150 // ms — debounce resize/fit calls

/** Safely call fit() — can throw when container is hidden or has zero size */
function safeFit(fit: FitAddon) {
  try { fit.fit() } catch { /* container not visible */ }
}

export function TerminalView({ className, initialData, onReady }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const batchRef = useRef<string[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disposedRef = useRef(false)

  const flush = useCallback(() => {
    if (disposedRef.current) {
      batchRef.current = []
      timerRef.current = null
      return
    }
    if (batchRef.current.length > 0 && termRef.current) {
      const data = batchRef.current.join('')
      batchRef.current = []
      termRef.current.write(data)
    }
    timerRef.current = null
  }, [])

  const write = useCallback((data: string) => {
    if (disposedRef.current) return
    batchRef.current.push(data)
    if (!timerRef.current) {
      timerRef.current = setTimeout(flush, BATCH_INTERVAL)
    }
  }, [flush])

  const clear = useCallback(() => {
    batchRef.current = []
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    termRef.current?.clear()
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    disposedRef.current = false

    const term = new Terminal({
      disableStdin: true,
      convertEol: true,
      scrollback: 5000,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, Consolas, monospace",
      theme: {
        background: '#000000',
        foreground: '#e0e0e0',
        cursor: '#4a9eff',
        selectionBackground: '#4a9eff44',
      },
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    safeFit(fit)

    termRef.current = term
    fitRef.current = fit

    // Write initial data if provided
    if (initialData) {
      term.write(initialData)
    }

    // Notify parent
    onReady?.({ write, clear })

    // Debounced resize handler — prevents excessive reflows during drag-resize
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const debouncedFit = () => {
      if (disposedRef.current) return
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (disposedRef.current) return
        safeFit(fit)
      }, RESIZE_DEBOUNCE)
    }

    window.addEventListener('resize', debouncedFit)

    // ResizeObserver for container-level resizing
    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(debouncedFit)
      resizeObserver.observe(containerRef.current)
    }

    return () => {
      disposedRef.current = true
      window.removeEventListener('resize', debouncedFit)
      resizeObserver?.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      batchRef.current = []
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // Mount-once: onReady/initialData/write/clear are stable refs captured at
    // mount time. The terminal lifecycle is tied to the DOM container, not to
    // prop changes. Re-running this effect would destroy and recreate the
    // terminal instance, losing all scrollback.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      className={className}
      data-testid="terminal-container"
      style={{ width: '100%', height: '100%' }}
    />
  )
}
