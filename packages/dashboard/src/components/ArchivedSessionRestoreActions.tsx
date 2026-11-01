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
          onClick={() => restore(id, 'native')}
          disabled={disabled || !restoreHint.native}
          aria-label={`Resume archived session ${label}`}
          data-testid={`${p}archived-restore-native-${id}`}
        >
          {pending ? 'Working…' : 'Resume'}
        </button>
        <button
          type="button"
          className="aa-restore-btn"
          onClick={() => restore(id, 'new_thread')}
          disabled={disabled || !restoreHint.newThread}
          aria-label={`Continue archived session ${label} as a new thread`}
          data-testid={`${p}archived-restore-new-thread-${id}`}
        >
          Continue as new thread
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

function RestoreOutcome({
  id,
  prefix,
  result,
}: {
  id: string;
  prefix: string;
  result: NonNullable<ReturnType<typeof useConnectionStore.getState>['archiveRestoreResults'][string]>;
}) {
  if (result.ok) {
    const seed = result.seed;
    return (
      <p className="aa-restore-note" data-testid={`${prefix}archived-restore-result-${id}`}>
        {result.mode === 'new_thread'
          ? `Started a NEW thread — not the original conversation. ${
              seed
                ? `${seed.messagesIncluded} of ${seed.messagesTotal} earlier messages will be sent as a transcript with your first message.`
                : 'There was no earlier conversation text to carry over.'
            }`
          : 'Resumed the original conversation. It is live again and no longer archived.'}
      </p>
    );
  }
  const text = result.refused
    ? 'This device is paired to a single session, so it cannot restore archived sessions.'
    : result.code === 'ARCHIVED_SESSION_NOT_FOUND'
      ? 'That archive no longer exists — it was restored, deleted or aged out.'
      : (result.message ?? 'Could not continue this session.');
  return (
    <p className="fr-result-error" data-testid={`${prefix}archived-restore-result-${id}`}>
      {text}
      {result.mode === 'native' && !result.refused && result.code !== 'ARCHIVED_SESSION_NOT_FOUND' && !result.sessionId
        ? ' You can continue it as a new thread instead.'
        : ''}
    </p>
  );
}
