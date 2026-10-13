/** Active previews opened by an explicit, one-time consent request. */
import { CopyButton } from './CopyButton'
import type { DevPreview } from '../store/types'

export interface DevPreviewChipProps {
  /**
   * Active previews for the session. Optional because several App-level
   * test fixtures mock `getActiveSessionState()` with partial shapes that
   * predate this field (App.test.tsx), so the value can genuinely arrive
   * `undefined` at runtime — treated the same as "no active previews".
   */
  previews?: DevPreview[]
  onClose: (port: number) => void
}

/**
 * Defensive scheme guard (#6812 review): only URLs that parse with an
 * http: or https: scheme may become a clickable anchor. The server only
 * ever emits Cloudflare tunnel https URLs here, but the value crosses the
 * wire — a malicious/compromised sender must not be able to smuggle a
 * `javascript:` (or other active-scheme) href into the header.
 */
function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** A single chip: open link + copy + dismiss for one active dev preview. */
function DevPreviewChipItem({ preview, onClose }: { preview: DevPreview; onClose: (port: number) => void }) {
  const label = (
    <>
      <span className="dev-preview-chip__icon" aria-hidden="true">{'\u{1F310}'}</span>
      <span className="dev-preview-chip__port">:{preview.port}</span>
      {preview.exposure && <span>Public HTTP · no added auth · no WebSockets</span>}
    </>
  )
  return (
    <span
      className="dev-preview-chip"
      data-testid={`dev-preview-chip-${preview.port}`}
      title={`${preview.url} · ${preview.exposure || 'Public HTTP preview'}`}
    >
      {preview.target && <span>{preview.target.command} (PID {preview.target.pid}) · {preview.target.host}:{preview.target.port}</span>}
      {isHttpUrl(preview.url) ? (
        <a
          className="dev-preview-chip__link"
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open dev preview on port ${preview.port}: ${preview.url}`}
        >
          {label}
        </a>
      ) : (
        // Non-http(s) scheme: render the same label as plain text — the
        // chip (and its dismiss control) stays visible, but nothing is
        // navigable.
        <span
          className="dev-preview-chip__link"
          aria-label={`Dev preview on port ${preview.port}`}
        >
          {label}
        </span>
      )}
      <CopyButton
        content={preview.url}
        label={`Copy dev preview URL: ${preview.url}`}
        className="dev-preview-chip__copy"
        testId={`dev-preview-chip-copy-${preview.port}`}
      />
      <button
        type="button"
        className="dev-preview-chip__close"
        data-testid={`dev-preview-chip-close-${preview.port}`}
        onClick={() => onClose(preview.port)}
        aria-label={`Dismiss dev preview on port ${preview.port}`}
        title="Dismiss dev preview"
      >
        &times;
      </button>
    </span>
  )
}

export function DevPreviewChip({ previews, onClose }: DevPreviewChipProps) {
  if (!previews || previews.length === 0) return null

  return (
    <div className="dev-preview-chips" data-testid="dev-preview-chips">
      {previews.map(preview => (
        <DevPreviewChipItem key={preview.port} preview={preview} onClose={onClose} />
      ))}
    </div>
  )
}
