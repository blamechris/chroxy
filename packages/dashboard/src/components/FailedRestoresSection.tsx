/**
 * FailedRestoresSection (#7625) — the Control Room "Failed restores" tab.
 *
 * A session the daemon could not bring back at boot is parked server-side with
 * its history and worktree preserved. Until #7625 there was no in-product way
 * to act on one: `clearFailedRestore` had zero callers, and the only signal was
 * a transient `session_restore_failed` toast in a 10-item ring that a reconnect
 * re-fires and can crowd out. This is the durable surface.
 *
 * WHY ITS OWN TAB. A failed restore is deliberately NOT in `session_list`
 * (`listSessions()` iterates `_sessions`, which it is absent from), so it can
 * never be the active session and no per-session surface can host it — not
 * session tabs, not a session panel.
 *
 * WHAT THE ACTION IS. A RETRY, not a dismiss. The dominant real case is an
 * environment that was down at boot and is back now (a host reboot; the
 * `docker run` args carry no `--restart` policy), so the operator wants the
 * session back. Retry is also non-destructive — a failed attempt re-parks the
 * entry untouched — which matters because the server publishes `historyLength`
 * but never the history, so a discard button here would destroy data the
 * operator was never shown.
 *
 * STYLING follows MemoryPanel: class names only, zero inline `style`, rules in
 * theme/components.css using `var(--token)`. EnvironmentPanel and
 * ByokPoolSection are NOT the models to copy — both carry grandfathered raw
 * hex literals in scripts/no-raw-color-literals-baseline.txt. The Retry button
 * also does NOT inherit bare `.cr-action` (padding: 3px 8px), which is far
 * under the repo's 44x44 floor; `.fr-retry-btn` sets it explicitly.
 */
import { useConnectionStore } from '../store/connection';
import { useShallow } from 'zustand/react/shallow';

function relativeAge(errorCode: string): string {
  // The roster carries no timestamp — `getFailedRestores()` publishes the error
  // and a history COUNT, nothing time-based — so the row leads with the code
  // rather than inventing an age the server never sent.
  return errorCode;
}

export function FailedRestoresSection() {
  const { snapshot, loading, connected, retrying, results } = useConnectionStore(
    useShallow((s) => ({
      snapshot: s.failedRestores,
      loading: s.failedRestoresLoading,
      connected: s.connectionPhase === 'connected',
      retrying: s.retryingRestoreIds,
      results: s.retryRestoreResults,
    })),
  );
  // `null` is "not asked yet" — deliberately distinct from a snapshot whose
  // `restores` is empty ("asked, nothing failed").
  const rows = snapshot?.restores ?? null;
  const refused = snapshot?.refused === true;
  const requestFailedRestores = useConnectionStore((s) => s.requestFailedRestores);
  const sendRetryFailedRestore = useConnectionStore((s) => s.sendRetryFailedRestore);

  const refreshDisabled = loading || !connected;

  return (
    <div className="fr-section" data-testid="failed-restores-section">
      <div className="fr-toolbar">
        <span className="fr-title">Failed restores</span>
        <button
          className="fr-refresh-btn"
          onClick={() => requestFailedRestores()}
          disabled={refreshDisabled}
          data-testid="failed-restores-refresh"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {refused ? (
        <p className="fr-empty" data-testid="failed-restores-refused">
          This device is paired to a single session, so it cannot view the host&apos;s failed
          restores. Open the dashboard with the primary token to manage them.
        </p>
      ) : rows === null ? (
        // `null` is "not asked yet" — distinct from an empty roster. Rendering
        // "nothing failed" here would be an authoritative-looking claim the
        // dashboard has not actually made a request to support.
        <p className="fr-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="fr-empty" data-testid="failed-restores-empty">
          Every saved session was restored.
        </p>
      ) : (
        <ul className="fr-list">
          {rows.map((r) => {
            const busy = retrying.has(r.sessionId);
            const result = results[r.sessionId];
            return (
              <li className="fr-row" key={r.sessionId} data-testid={`failed-restore-${r.sessionId}`}>
                <div className="fr-row-main">
                  <span className="fr-name">{r.name}</span>
                  <span className="fr-provider">{r.provider}</span>
                  {r.cwd ? <span className="fr-cwd">{r.cwd}</span> : null}
                </div>
                <div className="fr-row-detail">
                  <span className="fr-code">{relativeAge(r.errorCode)}</span>
                  <span className="fr-error">{r.errorMessage}</span>
                  {typeof r.historyLength === 'number' ? (
                    <span className="fr-history">
                      {r.historyLength} message{r.historyLength === 1 ? '' : 's'} preserved
                    </span>
                  ) : null}
                </div>
                {result && !result.ok ? (
                  <p className="fr-result-error" data-testid={`failed-restore-result-${r.sessionId}`}>
                    {result.code === 'FAILED_RESTORE_NOT_FOUND'
                      ? 'That entry is no longer parked — refresh the list.'
                      : (result.message ?? 'Retry failed.')}
                  </p>
                ) : null}
                <button
                  className="fr-retry-btn"
                  onClick={() => sendRetryFailedRestore(r.sessionId)}
                  disabled={busy || !connected}
                  data-testid={`failed-restore-retry-${r.sessionId}`}
                >
                  {busy ? 'Retrying…' : 'Retry'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
