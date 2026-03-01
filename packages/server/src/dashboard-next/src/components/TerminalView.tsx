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

export function TerminalView({ className, initialData, onReady }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const batchRef = useRef<string[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    if (batchRef.current.length > 0 && termRef.current) {
      const data = batchRef.current.join('')
      batchRef.current = []
      termRef.current.write(data)
    }
    timerRef.current = null
  }, [])

  const write = useCallback((data: string) => {
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
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    // Write initial data if provided
    if (initialData) {
      term.write(initialData)
    }

    // Notify parent
    onReady?.({ write, clear })

    // Resize handler
    const onResize = () => fit.fit()
    window.addEventListener('resize', onResize)

    // ResizeObserver for container-level resizing
    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => fit.fit())
      resizeObserver.observe(containerRef.current)
    }

    return () => {
      window.removeEventListener('resize', onResize)
      resizeObserver?.disconnect()
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
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
