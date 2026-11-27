/**
 * DiagnosticsSettingsSection — Settings → "Diagnostics" (#9235).
 *
 * Lists the dashboard's recent errors from the local history (utils/error-history). Nothing
 * here touches the store or the network. Selecting an entry shows the EXACT report text, and
 * Copy report copies exactly that text, so the operator reviews before anything leaves the
 * page. Every field shown is classifier output, re-validated on read.
 *
 * STYLING: class names only (theme/components.css), 44px floors.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { writeText } from '../utils/clipboard'
import {
  clearErrorHistory,
  currentAssetBasenames,
  formatHistoryEntry,
  readErrorHistory,
  subscribeErrorHistory,
  type ErrorHistoryEntry,
} from '../utils/error-history'

const CATEGORY_LABEL: Record<string, string> = {
  'render': 'Render',
  'window-error': 'Window error',
  'unhandled-rejection': 'Unhandled rejection',
}

export function DiagnosticsSettingsSection() {
  const [entries, setEntries] = useState<ErrorHistoryEntry[]>(() => readErrorHistory())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    setEntries(readErrorHistory())
    return subscribeErrorHistory(() => setEntries(readErrorHistory()))
  }, [])

  const selected = entries.find(e => e.id === selectedId) ?? null
  // Re-derived whenever the selection or the list changes; the asset set is never stored.
  const report = useMemo(() => {
    if (!selected) return ''
    return formatHistoryEntry(selected, currentAssetBasenames())
  }, [selected])

  const select = useCallback((id: string) => {
    setSelectedId(prev => (prev === id ? null : id))
    setCopyState('idle')
  }, [])

  const handleCopy = async (): Promise<void> => {
    const ok = await writeText(report)
    setCopyState(ok ? 'copied' : 'failed')
  }

  const handleClear = (): void => {
    clearErrorHistory()
    setSelectedId(null)
    setCopyState('idle')
  }

  return (
    <section className="settings-section" data-testid="diagnostics-section">
      <h3>Diagnostics</h3>
      <p className="settings-hint">
        Stored only in this browser. Messages are kept only when they match known engine error templates;
        nothing is uploaded.
      </p>
      {entries.length === 0 ? (
        <p className="settings-hint" data-testid="diagnostics-empty">No errors recorded.</p>
      ) : (
        <>
          <h4 className="diagnostics-subheading">Recent errors</h4>
          <ul className="diagnostics-list" data-testid="diagnostics-list">
            {entries.map(e => {
              const open = e.id === selectedId
              return (
                <li key={e.id} className="diagnostics-item" data-testid={`diagnostics-entry-${e.id}`}>
                  <button
                    type="button"
                    className="diagnostics-entry-button"
                    aria-expanded={open}
                    onClick={() => select(e.id)}
                    data-testid={`diagnostics-select-${e.id}`}
                  >
                    <span className="diagnostics-entry-meta">
                      <time dateTime={e.time}>{e.time}</time>
                      {' · '}
                      {CATEGORY_LABEL[e.category] ?? e.category}
                      {e.version !== 'unknown' ? ` · v${e.version}` : ''}
                    </span>
                    <span className="diagnostics-entry-text">
                      {e.name}: {e.text}
                      {e.count > 1 && (
                        <span className="diagnostics-count" data-testid={`diagnostics-count-${e.id}`}>
                          {' '}×{e.count}
                        </span>
                      )}
                    </span>
                  </button>
                  {open && (
                    <div className="diagnostics-detail">
                      <p className="settings-hint">Stack</p>
                      <pre className="diagnostics-pre" data-testid="diagnostics-stack">
                        {e.stack.length > 0 ? e.stack.join('\n') : '(none)'}
                      </pre>
                      <p className="settings-hint">
                        This is exactly what Copy report copies. Review it first.
                      </p>
                      <pre className="diagnostics-pre" data-testid="diagnostics-report">{report}</pre>
                      <div className="settings-field">
                        <button
                          type="button"
                          className="settings-secondary-button diagnostics-button"
                          onClick={handleCopy}
                          data-testid="diagnostics-copy"
                        >
                          Copy report
                        </button>
                        {copyState !== 'idle' && (
                          <span className="settings-hint" role="status" data-testid="diagnostics-copy-status">
                            {copyState === 'copied' ? 'Copied' : 'Copy failed'}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="settings-field">
            <button
              type="button"
              className="settings-secondary-button diagnostics-button"
              onClick={handleClear}
              data-testid="diagnostics-clear"
            >
              Clear history
            </button>
          </div>
        </>
      )}
    </section>
  )
}
