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
   * #5835 (PR2): pin the terminal to a cols×rows grid and letterbox it (centered,
   * no FitAddon stretch). Used for the live claude-tui PTY mirror, whose server
   * PTY is a fixed grid — rendering at exactly that size keeps the mirror 1:1
   * faithful (the authenticity surface) instead of scaling the xterm to the pane
   * and misaligning the TUI's absolute cursor positioning. Omit for the normal
   * fit-to-pane behaviour.
   *
   * #5835 Phase 2: this is now DYNAMIC — when it changes (the server reports a new
   * authoritative size via terminal_size) the live terminal is resized in place,
   * preserving scrollback. Pair with `onMeasure` to drive the size from the pane.
   */
  fixedSize?: { cols: number; rows: number }
  /**
   * #5835 Phase 2: in mirror (fixedSize) mode, called with the cols×rows that
   * would fit the current pane (measured via FitAddon, never auto-applied) on
   * mount and whenever the pane resizes. The parent debounces/dedupes and asks
   * the server to resize the real PTY (terminal_resize); the authoritative size
   * comes back via `fixedSize`. No-op in normal fit-to-pane mode.
   */
  onMeasure?: (cols: number, rows: number) => void
}

export const BATCH_INTERVAL = 50 // ms — coalesce rapid writes
const RESIZE_DEBOUNCE = 150 // ms — debounce resize/fit calls

/** Safely call fit() — can throw when container is hidden or has zero size */
function safeFit(fit: FitAddon) {
  try { fit.fit() } catch { /* container not visible */ }
}

export function TerminalView({ className, initialData, onReady, fixedSize, onMeasure }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const batchRef = useRef<string[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disposedRef = useRef(false)
  // #5835 Phase 2: keep the latest onMeasure callback in a ref so the mount-once
  // effect's resize/measure handler always calls the current one (the parent
  // recreates the closure each render, but the terminal lifecycle is mount-once).
  const onMeasureRef = useRef(onMeasure)
  onMeasureRef.current = onMeasure
  // Whether this terminal is a fixed-size letterboxed mirror. Mode is fixed at
  // MOUNT — the xterm is constructed with mode-specific options (convertEol,
  // initial cols/rows) and the mount-once onResize handler closes over this — so
  // a caller must NOT toggle `fixedSize` between defined/undefined for a live
  // terminal (the size VALUE may change freely; that's the resize effect below).
  // The only consumer (MultiTerminalView) always passes a fixedSize.
  const isMirror = !!fixedSize

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
    // centered/letterboxed by the container — it must NOT stretch the xterm to
    // the pane (that would make its grid disagree with the server PTY and
    // misrender the TUI). #5835 Phase 2: still load a FitAddon in mirror mode,
    // but ONLY to MEASURE the pane (proposeDimensions) — never fit() — so the
    // parent can drive the server PTY to the pane's size. fit() (auto-apply) is
    // still only for the normal fit-to-pane mode.
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    if (!fixedSize) safeFit(fitAddon)

    termRef.current = term
    fitRef.current = fitAddon

    // Write initial data if provided
    if (initialData) {
      term.write(initialData)
    }

    // Notify parent
    onReady?.({ write, clear, fit })

    // Debounced resize handler — prevents excessive reflows during drag-resize.
    // Normal mode: fit() the xterm to the pane. #5835 Phase 2 mirror mode: MEASURE
    // the pane (proposeDimensions, no fit) and report the fitting cols×rows up so
    // the parent can drive the server PTY — the xterm itself is resized only when
    // the authoritative size comes back (the fixedSize effect below).
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let resizeObserver: ResizeObserver | undefined
    const onResize = () => {
      if (disposedRef.current) return
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (disposedRef.current) return
        if (isMirror) {
          // Measure only — proposeDimensions returns the grid that fits the pane.
          const dims = fitAddon.proposeDimensions()
          if (dims && dims.cols > 0 && dims.rows > 0) {
            onMeasureRef.current?.(dims.cols, dims.rows)
          }
        } else {
          safeFit(fitAddon)
        }
      }, RESIZE_DEBOUNCE)
    }

    window.addEventListener('resize', onResize)
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(onResize)
      resizeObserver.observe(containerRef.current)
    }
    // Mirror mode: take an initial measurement so the server can size the PTY to
    // the pane on first view (the ResizeObserver also fires on mount in most
    // browsers, but don't rely on it). Normal mode already fit() above.
    if (isMirror) {
      const dims = fitAddon.proposeDimensions()
      if (dims && dims.cols > 0 && dims.rows > 0) onMeasureRef.current?.(dims.cols, dims.rows)
    }

    return () => {
      disposedRef.current = true
      window.removeEventListener('resize', onResize)
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

  // #5835 Phase 2: when the authoritative mirror size changes (the server reports
  // a new terminal_size), resize the live xterm in place — preserving scrollback
  // and avoiding the mount-once teardown. Depend on the primitive cols/rows (not
  // the object identity) so a new {cols,rows} object with the same values is a
  // no-op. Normal fit-to-pane mode has no fixedSize and skips this.
  useEffect(() => {
    if (!fixedSize || disposedRef.current || !termRef.current) return
    try {
      termRef.current.resize(fixedSize.cols, fixedSize.rows)
    } catch { /* terminal not ready / disposed */ }
  }, [fixedSize?.cols, fixedSize?.rows]) // eslint-disable-line react-hooks/exhaustive-deps

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
