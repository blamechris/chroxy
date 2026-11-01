/**
 * ArchivedSessionRestoreActions — the explicit "continue this session" actions of
 * one archived row (#8866), shared by the Control Room tab and the sidebar.
 *
 * Two different things, named differently on purpose:
 *   - Resume: the SAME conversation, resumed from the provider's own transcript.
 *     The record leaves the archive (the session is live again).
 *   - Continue as new thread: a NEW session in the same folder. The model does
 *     not have the old conversation; it gets a transcript of it with the FIRST
 *     message you send. The record stays in the archive.
 *
 * Nothing runs unless a button is clicked; viewing history stays read-only. The
 * daemon's `restore` hint is advisory (cheap checks), so the outcome line
 * carries the authoritative reason when a click is refused, and a refused Resume
 * points at the new-thread action.
 *
 * Plain text only; class names only (rules in theme/components.css, 44px floor).
 */
import { useState } from 'react';
import { useConnectionStore } from '../store/connection';
import { useShallow } from 'zustand/react/shallow';
import type { ServerArchivedSessionMeta } from '@chroxy/protocol';

export type ArchivedRestoreSurface = 'control-room' | 'sidebar';

const PREFIX: Record<ArchivedRestoreSurface, string> = { 'control-room': '', sidebar: 'sidebar-' };

export function ArchivedSessionRestoreActions({
  row,
  surface = 'control-room',
}: {
  row: ServerArchivedSessionMeta;
  surface?: ArchivedRestoreSurface;
}) {
  // An older daemon sends no `restore` hint and cannot restore: offer nothing
  // (and subscribe to nothing; the inner component owns the store hooks).
  if (!row.restore) return null;
  return <RestoreActions row={row} hint={row.restore} surface={surface} />;
}

function RestoreActions({
  row,
  hint: restoreHint,
  surface,
}: {
  row: ServerArchivedSessionMeta;
  hint: NonNullable<ServerArchivedSessionMeta['restore']>;
  surface: ArchivedRestoreSurface;
}) {
  const { connected, pending, result } = useConnectionStore(
    useShallow((s) => ({
      connected: s.connectionPhase === 'connected',
      pending: s.restoringArchiveIds.has(row.archiveId),
      result: s.archiveRestoreResults[row.archiveId],
    })),
  );
  const restore = useConnectionStore((s) => s.restoreArchivedSession);
  // Which button was clicked, so only THAT one reads "Working…" while pending.
  const [clicked, setClicked] = useState<'native' | 'new_thread' | null>(null);
  const click = (mode: 'native' | 'new_thread') => {
    setClicked(mode);
    restore(row.archiveId, mode);
  };

  const id = row.archiveId;
  const label = row.name || row.sessionId;
  const p = PREFIX[surface];
  const disabled = pending || !connected;

  return (
    <div className="aa-restore" data-testid={`${p}archived-restore-${id}`}>
      <div className="aa-restore-actions">
        <button
          type="button"
          className="aa-restore-btn"
          onClick={() => click('native')}
          disabled={disabled || !restoreHint.native}
          aria-label={`Resume archived session ${label}`}
          data-testid={`${p}archived-restore-native-${id}`}
        >
          {pending && clicked === 'native' ? 'Working…' : 'Resume'}
        </button>
        <button
          type="button"
          className="aa-restore-btn"
          onClick={() => click('new_thread')}
          disabled={disabled || !restoreHint.newThread}
          aria-label={`Continue archived session ${label} as a new thread`}
          data-testid={`${p}archived-restore-new-thread-${id}`}
        >
          {pending && clicked === 'new_thread' ? 'Working…' : 'Continue as new thread'}
        </button>
      </div>
      {!restoreHint.native && restoreHint.nativeReason ? (
        <p className="aa-restore-note" data-testid={`${p}archived-restore-native-reason-${id}`}>
          Can&apos;t resume: {restoreHint.nativeReason}
        </p>
      ) : null}
      {!restoreHint.newThread && restoreHint.newThreadReason && restoreHint.newThreadReason !== restoreHint.nativeReason ? (
        <p className="aa-restore-note" data-testid={`${p}archived-restore-new-thread-reason-${id}`}>
          Can&apos;t continue as a new thread: {restoreHint.newThreadReason}
        </p>
      ) : null}
      {result ? <RestoreOutcome id={id} prefix={p} result={result} /> : null}
    </div>
  );
}

type RestoreResult = NonNullable<ReturnType<typeof useConnectionStore.getState>['archiveRestoreResults'][string]>;

/** The one sentence that says what a restore attempt did (or why not), shared by the row and the section status. */
export function restoreOutcomeText(result: RestoreResult): string {
  const who = result.name ? `"${result.name}"` : 'the archived session';
  if (result.ok) {
    const seed = result.seed;
    return result.mode === 'new_thread'
      ? `Started a NEW thread from ${who} — not the original conversation. ${
          seed
            ? `${seed.messagesIncluded} of ${seed.messagesTotal} earlier messages will be sent as a transcript with your first message.`
            : 'There was no earlier conversation text to carry over.'
        }`
      : `Resumed the original conversation of ${who}. It is live again and no longer archived.`;
  }
  if (result.refused) return 'This device is paired to a single session, so it cannot restore archived sessions.';
  if (result.code === 'ARCHIVED_SESSION_NOT_FOUND') return 'That archive no longer exists — it was restored, deleted or aged out.';
  if (result.code === 'ARCHIVE_RESTORE_ALREADY_LIVE') {
    return result.message ?? `${who} is already live or parked.`;
  }
  if (result.mode === 'native' && result.sessionId) {
    // The session was restored but its provider failed to start: it is now parked.
    return `${who} was restored but could not start (${result.message ?? 'start failed'}). It moved to Failed restores — use Retry there.`;
  }
  const text = result.message ?? 'Could not continue this session.';
  return result.mode === 'native' ? `${text} You can continue it as a new thread instead.` : text;
}

function RestoreOutcome({ id, prefix, result }: { id: string; prefix: string; result: RestoreResult }) {
  const dismiss = useConnectionStore((s) => s.dismissArchiveRestoreResult);
  const switchSession = useConnectionStore((s) => s.switchSession);
  // Only a LIVE session can be switched to; a parked one is not on the session list.
  const ownerListed = useConnectionStore((s) =>
    result.code === 'ARCHIVE_RESTORE_ALREADY_LIVE' && !!result.sessionId
      && (s.sessions ?? []).some((x) => x.sessionId === result.sessionId));
  return (
    <div className="aa-restore-outcome">
      <p className={result.ok ? 'aa-restore-note' : 'fr-result-error'} data-testid={`${prefix}archived-restore-result-${id}`}>
        {restoreOutcomeText(result)}
      </p>
      {ownerListed ? (
        <button
          type="button"
          className="aa-restore-btn"
          onClick={() => switchSession(result.sessionId as string, { allowStarting: true })}
          data-testid={`${prefix}archived-restore-goto-${id}`}
        >
          Go to session
        </button>
      ) : null}
      <button
        type="button"
        className="aa-restore-btn aa-restore-dismiss"
        onClick={() => dismiss(id)}
        aria-label="Dismiss this message"
        data-testid={`${prefix}archived-restore-dismiss-${id}`}
      >
        ×
      </button>
    </div>
  );
}

/**
 * Outcome lines for restore attempts whose row is no longer listed. A native
 * restore removes its record, and a failed one re-parks the session, so the row
 * that held the outcome is gone by the time the reply is read; this keeps it
 * visible at the section level.
 */
export function ArchivedRestoreStatus({ listedIds, loaded, surface = 'control-room' }: { listedIds: string[]; loaded: boolean; surface?: ArchivedRestoreSurface }) {
  const results = useConnectionStore((s) => s.archiveRestoreResults);
  const p = PREFIX[surface];
  // Until the roster has loaded EVERY stored result would look orphaned and
  // duplicate the outcome its own row is about to show.
  if (!loaded) return null;
  const orphaned = Object.entries(results ?? {}).filter(([id]) => !listedIds.includes(id));
  if (orphaned.length === 0) return null;
  return (
    <div className="aa-restore-status" data-testid={`${p}archived-restore-status`}>
      {orphaned.map(([id, result]) => (
        <RestoreOutcome key={id} id={id} prefix={`${p}status-`} result={result} />
      ))}
    </div>
  );
}
