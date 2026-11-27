import { Component, type ErrorInfo, type ReactNode, type CSSProperties } from 'react'
import { writeText } from '../utils/clipboard'
import { formatLiveErrorReport, recordDashboardError } from '../utils/error-history'

interface ErrorBoundaryProps {
  children: ReactNode
}
interface ErrorBoundaryState {
  error: Error | null
  /** #9234 — React component stack from componentDidCatch, shown + copyable. */
  componentStack: string | null
  /** When the error was caught: keeps the report stable across re-renders. */
  caughtAt: number
  /**
   * The formatted report, computed ONCE per catch. The preview renders it and Copy writes it,
   * so what the operator reviewed is byte-for-byte what is copied.
   */
  report: string
  copyState: 'idle' | 'copied' | 'failed'
}

// Inline styles (not a CSS class) on purpose: an error boundary is the last line
// of defence, so its fallback must render even if a stylesheet failed to load or
// the very chrome that threw owned the relevant CSS. Colours use theme tokens
// (resolved when theme.css loaded — the common case); if even that is missing the
// fallback degrades to unstyled-but-readable rather than a blank page.
const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  font: '14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}
const card: CSSProperties = {
  maxWidth: 560,
  width: '100%',
  background: 'var(--bg-card)',
  border: '1px solid var(--scrollbar-thumb)',
  borderRadius: 12,
  padding: 24,
}
const titleStyle: CSSProperties = { margin: '0 0 8px', fontSize: 18, fontWeight: 600 }
const textStyle: CSSProperties = { margin: '0 0 16px', color: 'var(--text-dim)' }
const reloadStyle: CSSProperties = {
  background: 'var(--accent-blue)',
  color: 'var(--bg-primary)',
  border: 'none',
  borderRadius: 8,
  padding: '8px 16px',
  minHeight: 44,
  fontWeight: 600,
  cursor: 'pointer',
}
const copyStyle: CSSProperties = {
  marginLeft: 8,
  background: 'transparent',
  color: 'var(--text-primary)',
  border: '1px solid var(--scrollbar-thumb)',
  borderRadius: 8,
  padding: '8px 16px',
  minHeight: 44,
  cursor: 'pointer',
}
const copyStatusStyle: CSSProperties = { marginLeft: 8, fontSize: 12, color: 'var(--text-dim)' }
const savedNoteStyle: CSSProperties = { margin: '12px 0 0', fontSize: 12, color: 'var(--text-dim)' }
const summaryStyle: CSSProperties = { minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }
const detailsStyle: CSSProperties = { marginTop: 16, color: 'var(--text-dim)' }
const preStyle: CSSProperties = {
  marginTop: 8,
  maxHeight: 240,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

/**
 * ErrorBoundary — top-level render-error guard (swarm-audit hardening).
 *
 * Previously a render throw in any surface (ChatView, InputBar, the Control Room,
 * …) white-screened the whole dashboard. This catches it, logs it to the console
 * (so a white-screen-class failure is at least diagnosable from the logs), and
 * shows a recoverable fallback — a Reload button plus the error detail — instead
 * of a blank page.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, caughtAt: 0, report: '', copyState: 'idle' }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    const caughtAt = Date.now()
    return {
      error, componentStack: null, caughtAt, copyState: 'idle',
      report: formatLiveErrorReport({ category: 'render', error, componentStack: null }, caughtAt),
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is outside the stored / displayed / copied boundary: it keeps the raw error
    // for live debugging and is never read back by the dashboard.
    console.error('[ErrorBoundary] render error:', error, info.componentStack)
    // #9235 — the one place a render error is recorded (never from getDerivedStateFromError,
    // which can run more than once). Stores classifier output only.
    recordDashboardError({ category: 'render', error, componentStack: info.componentStack })
    // The component stack arrives only here: recompute the report once, now that it is complete.
    this.setState(prev => ({
      componentStack: info.componentStack ?? null,
      report: formatLiveErrorReport(
        { category: 'render', error, componentStack: info.componentStack }, prev.caughtAt || Date.now()),
    }))
  }

  private handleCopy = async (): Promise<void> => {
    const ok = await writeText(this.state.report)
    this.setState({ copyState: ok ? 'copied' : 'failed' })
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const { error, copyState, report } = this.state
    if (!error) return this.props.children
    return (
      <div style={overlay} role="alert" data-testid="error-boundary">
        <div style={card}>
          <h1 style={titleStyle}>Something went wrong</h1>
          <p style={textStyle}>
            The dashboard hit an unexpected error and couldn&apos;t render this view.
          </p>
          <button
            type="button"
            style={reloadStyle}
            onClick={this.handleReload}
            data-testid="error-boundary-reload"
          >
            Reload
          </button>
          <button
            type="button"
            style={copyStyle}
            onClick={this.handleCopy}
            data-testid="error-boundary-copy"
          >
            Copy report
          </button>
          {copyState !== 'idle' && (
            <span style={copyStatusStyle} role="status" data-testid="error-boundary-copy-status">
              {copyState === 'copied' ? 'Copied' : 'Copy failed'}
            </span>
          )}
          <p style={savedNoteStyle} data-testid="error-boundary-saved-note">
            Saved locally in Settings → Diagnostics. Nothing is uploaded.
          </p>
          <details style={detailsStyle} open>
            <summary style={summaryStyle}>Error detail (exactly what Copy report copies)</summary>
            <pre style={preStyle} data-testid="error-boundary-report">{report}</pre>
          </details>
        </div>
      </div>
    )
  }
}
