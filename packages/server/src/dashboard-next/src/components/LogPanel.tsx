import { useState, useEffect, useRef, useCallback } from 'react'
import { useConnectionStore } from '../store/connection'
import type { LogEntry } from '../store/types'

type LogLevel = LogEntry['level']

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export function LogPanel() {
  const logEntries = useConnectionStore((state) => state.logEntries)
  const clearLogEntries = useConnectionStore((state) => state.clearLogEntries)

  const [filter, setFilter] = useState<Set<LogLevel>>(new Set(['info', 'warn', 'error']))
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const filtered = logEntries.filter((e) => filter.has(e.level))
  const lastFilteredId = filtered.length > 0 ? filtered[filtered.length - 1]!.id : null

  // Auto-scroll to bottom on new entries. Use last entry's id instead of
  // filtered.length so scrolling still triggers when the ring buffer is full
  // (length stays constant at 500 but the newest id changes).
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [lastFilteredId, autoScroll])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const toggleLevel = useCallback((level: LogLevel) => {
    setFilter((prev) => {
      const next = new Set(prev)
      if (next.has(level)) {
        next.delete(level)
      } else {
        next.add(level)
      }
      return next
    })
  }, [])

  const handleCopy = useCallback(() => {
    const text = filtered
      .map((e) => `${formatTimestamp(e.timestamp)} [${e.level.toUpperCase()}] [${e.component}] ${e.message}`)
      .join('\n')
    if (!navigator.clipboard) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }, [filtered])

  return (
    <div className="log-panel" data-testid="log-panel">
      <div className="log-toolbar" data-testid="log-toolbar">
        <div className="log-filters">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`log-filter-btn log-filter-${level}${filter.has(level) ? ' active' : ''}`}
              data-testid={`log-filter-${level}`}
              onClick={() => toggleLevel(level)}
            >
              {level}
            </button>
          ))}
        </div>
        <div className="log-actions">
          <label className="log-autoscroll" data-testid="log-autoscroll">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <button
            type="button"
            className="log-action-btn"
            data-testid="log-copy"
            onClick={handleCopy}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <button
            type="button"
            className="log-action-btn"
            data-testid="log-clear"
            onClick={clearLogEntries}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="log-list" ref={listRef} data-testid="log-list">
        {filtered.length === 0 ? (
          <div className="log-empty" data-testid="log-empty">No log entries</div>
        ) : (
          filtered.map((entry) => (
            <div
              key={entry.id}
              className={`log-line log-level-${entry.level}`}
              data-testid="log-line"
            >
              <span className="log-time">{formatTimestamp(entry.timestamp)}</span>
              <span className={`log-level log-level-tag-${entry.level}`}>{entry.level.toUpperCase()}</span>
              <span className="log-component">[{entry.component}]</span>
              <span className="log-message">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
