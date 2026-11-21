/**
 * FolderTrustBanner — per-folder trust for project settings.
 *
 * A session folder can carry settings that make Claude run commands (MCP
 * servers, hooks, a status line, plugins, agents, skills, commands). They are
 * not loaded until the owner trusts the folder. This is the per-session surface
 * for that decision, driven by the daemon's `folder_trust_state`:
 *
 *   - `untrusted` → a banner with Review, which opens a dialog that lists what
 *     would run and offers "Trust this folder".
 *   - `trusted`   → a small indicator with "Stop trusting".
 *   - `none` (or no state yet, or a provider that does not run claude) → nothing.
 *
 * The component only displays and forwards the two actions; the daemon decides
 * (primary token on an unbound connection) and says so in `error`.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { Modal } from './Modal'
import type { FolderTrustEntry } from '../store/types'

export interface FolderTrustBannerProps {
  entry: FolderTrustEntry | undefined
  /** A trust change for this session is in flight. */
  pending?: boolean
  /** Why the last trust change failed, or null. */
  error?: string | null
  onTrust: () => void
  onUntrust: () => void
}

const BUTTON_STYLE: CSSProperties = {
  marginLeft: 12,
  minHeight: 44,
  minWidth: 44,
  background: 'transparent',
  border: '1px solid currentColor',
  color: 'inherit',
  padding: '2px 14px',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.85em',
}

const LIST_STYLE: CSSProperties = { margin: '4px 0 12px', paddingLeft: 20, overflowWrap: 'anywhere' }
const CODE_STYLE: CSSProperties = { fontFamily: 'monospace', fontSize: '0.9em' }

export function appliesFromText(appliesFrom: FolderTrustEntry['appliesFrom']): string | null {
  if (appliesFrom === 'next_turn') return 'Applies from the next turn'
  if (appliesFrom === 'restart') return 'Restart the session to apply'
  return null
}

function SummaryList({ entry }: { entry: FolderTrustEntry }) {
  const summary = entry.summary
  if (!summary) return null
  const { mcpServers, hooks, statusLine, enabledPlugins, counts, files, warnings } = summary
  return (
    <div data-testid="folder-trust-summary">
      {mcpServers.length > 0 && (
        <section>
          <h4>MCP servers</h4>
          <ul style={LIST_STYLE}>
            {mcpServers.map((s, i) => (
              <li key={`${s.file}:${s.name}:${i}`} data-testid="folder-trust-mcp-server">
                <strong>{s.name}</strong>{' '}
                <code style={CODE_STYLE}>{[s.command ?? s.url ?? s.type ?? '', ...(s.args ?? [])].filter(Boolean).join(' ')}</code>
                {s.envKeys && s.envKeys.length > 0 && <> (sets environment: {s.envKeys.join(', ')})</>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {hooks.length > 0 && (
        <section>
          <h4>Hooks</h4>
          <ul style={LIST_STYLE}>
            {hooks.map((h, i) => (
              <li key={`${h.file}:${h.event}:${i}`} data-testid="folder-trust-hook">
                <strong>{h.event}</strong>{' '}
                {h.commands.map((c, j) => <code key={j} style={CODE_STYLE}>{c} </code>)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {statusLine.length > 0 && (
        <section>
          <h4>Status line</h4>
          <ul style={LIST_STYLE}>
            {statusLine.map((s, i) => <li key={i} data-testid="folder-trust-status-line"><code style={CODE_STYLE}>{s.command}</code></li>)}
          </ul>
        </section>
      )}
      {enabledPlugins.length > 0 && (
        <section>
          <h4>Plugins</h4>
          <ul style={LIST_STYLE}>
            {enabledPlugins.map((p, i) => <li key={i} data-testid="folder-trust-plugin">{p.plugin}</li>)}
          </ul>
        </section>
      )}
      {(counts.agents > 0 || counts.skills > 0 || counts.commands > 0) && (
        <section>
          <h4>Files</h4>
          <p data-testid="folder-trust-counts">
            {counts.agents} agent {counts.agents === 1 ? 'file' : 'files'}, {counts.skills} skill {counts.skills === 1 ? 'file' : 'files'}, {counts.commands} command {counts.commands === 1 ? 'file' : 'files'}
          </p>
        </section>
      )}
      <section>
        <h4>Settings files</h4>
        <ul style={LIST_STYLE}>
          {files.map((f) => <li key={f} data-testid="folder-trust-file"><code style={CODE_STYLE}>{f}</code></li>)}
        </ul>
      </section>
      {warnings.length > 0 && (
        <section>
          <h4>Notes</h4>
          <ul style={LIST_STYLE}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </section>
      )}
    </div>
  )
}

export function FolderTrustBanner({ entry, pending = false, error = null, onTrust, onUntrust }: FolderTrustBannerProps) {
  const [reviewing, setReviewing] = useState(false)
  const status = entry?.status
  const applies = entry ? appliesFromText(entry.appliesFrom) : null

  // Approving moves the state to trusted: the dialog has done its job.
  useEffect(() => {
    if (status !== 'untrusted') setReviewing(false)
  }, [status])

  if (!entry || entry.appliesFrom === 'n/a') return null

  if (status === 'trusted') {
    return (
      <div className="stream-stall-chip" data-testid="folder-trust-trusted" role="status">
        <span className="stream-stall-chip-text">Project settings for this folder are trusted.</span>
        <button
          type="button"
          onClick={onUntrust}
          disabled={pending}
          data-testid="folder-trust-untrust"
          aria-label="Stop trusting this folder's project settings"
          style={BUTTON_STYLE}
        >
          Stop trusting
        </button>
        {applies && <span data-testid="folder-trust-applies" style={{ marginLeft: 8, fontSize: '0.8em', opacity: 0.75 }}>{applies}</span>}
        {error && <span data-testid="folder-trust-error" role="alert" style={{ display: 'block', marginTop: 4 }}>{error}</span>}
      </div>
    )
  }

  if (status !== 'untrusted') return null

  return (
    <>
      <div className="stream-stall-chip" data-testid="folder-trust-banner" role="status">
        <span className="stream-stall-chip-text">This folder's project settings are not loaded.</span>
        <button
          type="button"
          onClick={() => setReviewing(true)}
          data-testid="folder-trust-review"
          aria-label="Review this folder's project settings"
          style={BUTTON_STYLE}
        >
          Review
        </button>
      </div>
      <Modal open={reviewing} onClose={() => setReviewing(false)} title="Trust this folder's project settings?">
        <div data-testid="folder-trust-dialog">
          <SummaryList entry={entry} />
          <p data-testid="folder-trust-warning">Trusting this folder lets these settings run, along with the code they point to.</p>
          {applies && <p data-testid="folder-trust-applies">{applies}</p>}
          {error && <p data-testid="folder-trust-error" role="alert">{error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setReviewing(false)} data-testid="folder-trust-cancel" style={BUTTON_STYLE}>
              Cancel
            </button>
            <button type="button" onClick={onTrust} disabled={pending} data-testid="folder-trust-confirm" style={BUTTON_STYLE}>
              Trust this folder
            </button>
          </div>
        </div>
      </Modal>
    </>
  )
}
