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
 *   - no state yet, or a provider that does not run claude → nothing.
 *
 * Every folder starts untrusted, including one with nothing command-bearing (trusting
 * it loads its CLAUDE.md and other project settings). Trust is offered only for a
 * reviewable snapshot: with no summary and digest (a session-bound client) or an
 * incomplete scan, the dialog is read-only.
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
  /** Called with the digest of the SNAPSHOT the owner reviewed, never the latest one. */
  onTrust: (digest: string) => void
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
      {!summary.hasCommandBearingFiles && (
        <p data-testid="folder-trust-no-commands">
          No commands found; trusting loads this folder&apos;s CLAUDE.md, rules and other project settings.
        </p>
      )}
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
      {files.length > 0 && (
        <section>
          <h4>Settings files</h4>
          <ul style={LIST_STYLE}>
            {files.map((f) => (
              <li key={f.path} data-testid="folder-trust-file">
                <code style={CODE_STYLE}>{f.path}</code>
                {f.linkTarget && <> <span data-testid="folder-trust-link">→ <code style={CODE_STYLE}>{f.linkTarget}</code></span></>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {warnings.length > 0 && (
        <section>
          <h4>Notes</h4>
          <ul style={LIST_STYLE} data-testid="folder-trust-warnings">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </section>
      )}
    </div>
  )
}

export function FolderTrustBanner({ entry, pending = false, error = null, onTrust, onUntrust }: FolderTrustBannerProps) {
  // What the owner is looking at: the state when Review was clicked. The dialog renders
  // from it, and Trust sends ITS digest, whatever newer state has arrived since.
  const [snapshot, setSnapshot] = useState<FolderTrustEntry | null>(null)
  const status = entry?.status
  const applies = entry ? appliesFromText(entry.appliesFrom) : null

  // Approving moves the state to trusted: the dialog has done its job.
  useEffect(() => {
    if (status !== 'untrusted') setSnapshot(null)
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

  // The owner approves what they reviewed: needs the summary and its digest, and a
  // folder that could be reviewed completely.
  const shown = snapshot ?? entry
  const canTrust = Boolean(shown.summary && shown.digest && !shown.summary.untrustable)
  const changed = snapshot !== null && entry.digest !== snapshot.digest

  return (
    <>
      <div className="stream-stall-chip" data-testid="folder-trust-banner" role="status">
        <span className="stream-stall-chip-text">This folder's project settings are not loaded.</span>
        {entry.launchedWithProject === true && (
          <span data-testid="folder-trust-still-loaded" style={{ display: 'block', fontSize: '0.8em', opacity: 0.85 }}>
            Project settings stay loaded in this running session until it restarts.
          </span>
        )}
        <button
          type="button"
          onClick={() => setSnapshot(entry)}
          data-testid="folder-trust-review"
          aria-label="Review this folder's project settings"
          style={BUTTON_STYLE}
        >
          Review
        </button>
      </div>
      <Modal open={snapshot !== null} onClose={() => setSnapshot(null)} title="Trust this folder's project settings?">
        <div data-testid="folder-trust-dialog">
          {changed && (
            <p data-testid="folder-trust-changed" role="alert">
              This folder changed since you opened it. Review again.{' '}
              <button type="button" onClick={() => setSnapshot(entry)} data-testid="folder-trust-reload" style={BUTTON_STYLE}>
                Reload
              </button>
            </p>
          )}
          <SummaryList entry={shown} />
          {canTrust && !changed && <p data-testid="folder-trust-warning">Trusting this folder lets these settings run, along with the code they point to.</p>}
          {!canTrust && <p data-testid="folder-trust-readonly">This folder's settings cannot be trusted from here.</p>}
          {appliesFromText(shown.appliesFrom) && <p data-testid="folder-trust-applies">{appliesFromText(shown.appliesFrom)}</p>}
          {error && <p data-testid="folder-trust-error" role="alert">{error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setSnapshot(null)} data-testid="folder-trust-cancel" style={BUTTON_STYLE}>
              Cancel
            </button>
            {canTrust && (
              <button type="button" onClick={() => onTrust(shown.digest as string)} disabled={pending || changed} data-testid="folder-trust-confirm" style={BUTTON_STYLE}>
                Trust this folder
              </button>
            )}
          </div>
        </div>
      </Modal>
    </>
  )
}
