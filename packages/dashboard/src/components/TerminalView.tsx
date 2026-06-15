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
  fit: () => void
}

export interface TerminalViewProps {
  className?: string
  initialData?: string
  onReady?: (handle: TerminalHandle) => void
  /**
   * #5835 (PR2): pin the terminal to a fixed cols×rows and letterbox it
   * (centered, no FitAddon stretch). Used for the live claude-tui PTY mirror,
   * whose server-side PTY is a fixed 120×30 grid — rendering at exactly that
   * size keeps the mirror 1:1 faithful (the authenticity surface) instead of
   * scaling the xterm to the pane and misaligning the TUI's absolute cursor
   * positioning. Omit for the normal fit-to-pane behaviour.
   */
  fixedSize?: { cols: number; rows: number }
}

export const BATCH_INTERVAL = 50 // ms — coalesce rapid writes
const RESIZE_DEBOUNCE = 150 // ms — debounce resize/fit calls

/** Safely call fit() — can throw when container is hidden or has zero size */
function safeFit(fit: FitAddon) {
  try { fit.fit() } catch { /* container not visible */ }
}

export function TerminalView({ className, initialData, onReady, fixedSize }: TerminalViewProps) {
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

  const fit = useCallback(() => {
    if (fitRef.current) safeFit(fitRef.current)
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    disposedRef.current = false

    const term = new Terminal({
      disableStdin: true,
      // A fixed-size mirror reproduces the server PTY's exact line layout, so
      // DON'T translate \n→\r\n (the PTY already emits the control bytes). For
      // the normal fit mode keep convertEol for plain text streams.
      convertEol: !fixedSize,
      scrollback: 5000,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, Consolas, monospace",
      ...(fixedSize ? { cols: fixedSize.cols, rows: fixedSize.rows } : {}),
      theme: {
        background: '#000000',
        foreground: '#e0e0e0',
        cursor: '#4a9eff',
        selectionBackground: '#4a9eff44',
      },
    })

    // #5835 (PR2): a fixedSize mirror renders at exactly cols×rows and is
    // centered/letterboxed by the container — no FitAddon (stretching the xterm
    // to the pane would make its grid disagree with the server PTY's 120×30 and
    // misrender the TUI). FitAddon is only for the normal fit-to-pane mode.
    let fitAddon: FitAddon | null = null
    if (!fixedSize) {
      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
    }
    term.open(containerRef.current)
    if (fitAddon) safeFit(fitAddon)

    termRef.current = term
    fitRef.current = fitAddon

    // Write initial data if provided
    if (initialData) {
      term.write(initialData)
    }

    // Notify parent
    onReady?.({ write, clear, fit })

    // Debounced resize handler — prevents excessive reflows during drag-resize.
    // Skipped entirely in fixedSize mode: a letterboxed 120×30 mirror never
    // re-fits (the container just centers it / adds scroll if the pane is small).
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let resizeObserver: ResizeObserver | undefined
    const debouncedFit = () => {
      if (disposedRef.current || !fitAddon) return
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (disposedRef.current || !fitAddon) return
        safeFit(fitAddon)
      }, RESIZE_DEBOUNCE)
    }

    if (fitAddon) {
      window.addEventListener('resize', debouncedFit)
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(debouncedFit)
        resizeObserver.observe(containerRef.current)
      }
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
      // #5835 (PR2): letterbox a fixed-size mirror — center the 120×30 grid in
      // the pane, with scroll if the pane is smaller than the grid (faithful
      // beats wrap-distorted). Normal mode fills the pane for FitAddon.
      style={fixedSize
        ? { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', background: '#000000' }
        : { width: '100%', height: '100%' }}
    />
  )
}
