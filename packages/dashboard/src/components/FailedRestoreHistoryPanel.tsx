/**
 * FailedRestoreHistoryPanel (#8860) — the read-only transcript of ONE parked
 * failed restore, opened from the Failed restores tab ("View history").
 *
 * WHY IT EXISTS. A Codex app-server session in `auto` permission mode never
 * captures a native resume locator, so after a daemon restart it is refused
 * (`CODEX_NATIVE_LOCATOR_MISSING`) and parked, and every Retry re-parks it. That
 * fail-closed behaviour is deliberate (docs/providers.md "Native restart
 * continuity"): Chroxy must not resume, or rebuild a native thread from
 * displayed history, with approval authority it cannot prove. The gap this
 * closes is only that the preserved transcript was unreachable. This panel READS
 * it; it offers no way to resume, continue or re-send — a replacement still
 * needs an explicit new session.
 *
 * RENDERING. Every value is a React text node: no `dangerouslySetInnerHTML`, no
 * markdown, no links. The history is transcript content the daemon stored
 * verbatim (prompts, tool inputs, tool output), so nothing in it is treated as
 * markup or as a URL. Each entry is modelled loosely on the wire (only `type` is
 * guaranteed), so every field is read defensively and an unknown entry type is
 * shown as a bare type label rather than dropped, which would hide that the
 * transcript has something this build cannot draw.
 *
 * STYLING: class names only, rules in theme/components.css with `var(--token)`,
 * same as FailedRestoresSection. The "Load more" control sets its own 44px floor.
 */
import { useConnectionStore } from '../store/connection';
import type { ServerFailedRestoreHistoryEntry } from '@chroxy/protocol';

const SUMMARY_MAX = 140;
/** What an entry the server could only send as metadata (`_truncated`) shows instead of its text. */
const TOO_LARGE = '(too large to show)';

/** A string for display, from anything the entry might carry in a field. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function oneLine(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The input keys that best name what a tool call is about, most telling first. */
const INPUT_SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description'];

/**
 * One line naming what a tool call did. A persisted input over the size bound
 * becomes `{ _truncated: true, summary }`; that summary is JSON text, so it is
 * shown as-is rather than parsed.
 */
export function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return oneLine(input);
  if (typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (record._truncated === true && typeof record.summary === 'string') return oneLine(record.summary);
    for (const key of INPUT_SUMMARY_KEYS) {
      const v = record[key];
      if (typeof v === 'string' && v.trim() !== '') return oneLine(v);
    }
  }
  return oneLine(asText(input));
}

function roleLabel(messageType: unknown): string {
  switch (messageType) {
    case 'user_input':
      return 'You';
    case 'response':
      return 'Assistant';
    case 'system':
      return 'System';
    case 'error':
      return 'Error';
    case 'thinking':
      return 'Thinking';
    default:
      return typeof messageType === 'string' && messageType !== '' ? messageType : 'message';
  }
}

function formatResultLine(entry: ServerFailedRestoreHistoryEntry): string {
  const parts: string[] = ['Turn finished'];
  if (typeof entry.duration === 'number' && Number.isFinite(entry.duration)) {
    parts.push(`${(entry.duration / 1000).toFixed(1)}s`);
  }
  if (typeof entry.cost === 'number' && Number.isFinite(entry.cost)) {
    parts.push(`$${entry.cost.toFixed(4)}`);
  }
  return parts.join(' · ');
}

function HistoryEntry({ entry }: { entry: ServerFailedRestoreHistoryEntry }) {
  switch (entry.type) {
    case 'message': {
      const text = asText(entry.content) || (entry._truncated === true ? TOO_LARGE : '');
      return (
        <li className="fr-hist-entry fr-hist-message" data-testid="fr-hist-message">
          <span className="fr-hist-role">{roleLabel(entry.messageType)}</span>
          <div className="fr-hist-text">{text}</div>
        </li>
      );
    }
    case 'tool_start': {
      const name = asText(entry.tool) || 'tool';
      const summary = summarizeToolInput(entry.input);
      return (
        <li className="fr-hist-entry fr-hist-tool" data-testid="fr-hist-tool-start">
          <span className="fr-hist-role">{name}</span>
          {summary ? <span className="fr-hist-summary">{summary}</span> : null}
        </li>
      );
    }
    case 'tool_result': {
      const text = asText(entry.result);
      const failed = entry.isError === true;
      return (
        <li className="fr-hist-entry fr-hist-tool-result" data-testid="fr-hist-tool-result">
          <details>
            <summary className="fr-hist-result-toggle">
              <span className="fr-hist-role">{failed ? 'Tool error' : 'Tool result'}</span>
              <span className="fr-hist-summary">{oneLine(text) || (entry._truncated === true ? TOO_LARGE : '(empty)')}</span>
            </summary>
            <div className="fr-hist-text">{text}</div>
          </details>
        </li>
      );
    }
    case 'result':
      return (
        <li className="fr-hist-entry fr-hist-result" data-testid="fr-hist-result">
          {formatResultLine(entry)}
        </li>
      );
    default:
      return (
        <li className="fr-hist-entry fr-hist-other" data-testid="fr-hist-other">
          <span className="fr-hist-role">{asText(entry.type) || 'entry'}</span>
          {entry._truncated === true ? <span className="fr-hist-summary">{TOO_LARGE}</span> : null}
        </li>
      );
  }
}

/** The panel's element id, which the row's View history toggle points `aria-controls` at. */
export function failedRestoreHistoryPanelId(sessionId: string): string {
  return `failed-restore-history-panel-${sessionId}`;
}

export function FailedRestoreHistoryPanel({ sessionId }: { sessionId: string }) {
  const view = useConnectionStore((s) => s.failedRestoreHistories[sessionId]);
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected');
  const requestHistory = useConnectionStore((s) => s.requestFailedRestoreHistory);

  // The parent only mounts this while the view exists; guard anyway so a close
  // racing a render cannot throw.
  if (!view) return null;

  const { entries, total, loading, error } = view;
  const hasMore = total !== null && entries.length < total;
  const firstLoad = loading && entries.length === 0;

  return (
    <div
      className="fr-hist-panel"
      id={failedRestoreHistoryPanelId(sessionId)}
      data-testid={`failed-restore-history-${sessionId}`}
    >
      {error ? (
        <p className="fr-result-error" data-testid={`failed-restore-history-error-${sessionId}`}>
          {error.refused
            ? 'This device is paired to a single session, so it cannot read a failed restore’s history. Open the dashboard with the primary token.'
            : error.code === 'FAILED_RESTORE_NOT_FOUND'
              ? 'That entry is no longer parked — refresh the list.'
              : (error.message ?? 'Could not load the history.')}
        </p>
      ) : null}
      {firstLoad ? (
        <p className="fr-empty" data-testid={`failed-restore-history-loading-${sessionId}`}>
          Loading history…
        </p>
      ) : entries.length === 0 && !error && total !== null ? (
        <p className="fr-empty" data-testid={`failed-restore-history-empty-${sessionId}`}>
          Nothing was preserved for this session.
        </p>
      ) : (
        <ol className="fr-hist-list">
          {entries.map((e, i) => (
            <HistoryEntry key={i} entry={e} />
          ))}
        </ol>
      )}
      {total !== null && entries.length > 0 ? (
        <p className="fr-hist-count" data-testid={`failed-restore-history-count-${sessionId}`}>
          Showing {entries.length} of {total}
        </p>
      ) : null}
      {hasMore || (error && entries.length > 0) ? (
        <button
          type="button"
          className="fr-hist-more-btn"
          onClick={() => requestHistory(sessionId, true)}
          disabled={loading || !connected}
          data-testid={`failed-restore-history-more-${sessionId}`}
        >
          {loading ? 'Loading…' : error ? 'Retry loading more' : 'Load more'}
        </button>
      ) : null}
      {error && entries.length === 0 && !error.refused && error.code !== 'FAILED_RESTORE_NOT_FOUND' ? (
        <button
          type="button"
          className="fr-hist-more-btn"
          onClick={() => requestHistory(sessionId, false)}
          disabled={loading || !connected}
          data-testid={`failed-restore-history-reload-${sessionId}`}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
