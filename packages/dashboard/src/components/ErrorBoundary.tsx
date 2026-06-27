import { Component, type ErrorInfo, type ReactNode, type CSSProperties } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}
interface ErrorBoundaryState {
  error: Error | null
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
  fontWeight: 600,
  cursor: 'pointer',
}
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
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] render error:', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const { error } = this.state
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
          <details style={detailsStyle}>
            <summary>Error detail</summary>
            <pre style={preStyle}>
              {error.message}
              {error.stack ? `\n\n${error.stack}` : ''}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}
