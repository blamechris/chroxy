import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * View-mode / panel-visibility state for SessionScreen (#5654).
 *
 * Owns the *local* UI-toggle state that drives SessionScreen's chrome — the
 * chat compact filter and the show/hide flags for the secondary panels
 * (the "more tools" row, the session-overview panel, the collapsible
 * settings bar, and the three modal panels: diff viewer, checkpoints, git
 * view). None of this lives in the connection store; it is purely
 * presentational state scoped to the screen.
 *
 * Deliberately NOT here: `viewMode` / `setViewMode` (store-backed via
 * `useConnectionStore`, asserted by SessionScreenSelectors.test), the
 * create-session modal, and the attachment bottom-sheet — those belong to
 * the session-creation / attachment flows rather than the secondary-panel
 * chrome, so they stay in SessionScreen for this conservative pass.
 *
 * Behaviour-preserving: the `chatFilterCompact` reset-on-session-switch
 * effect is moved verbatim (same dependency, same prev-ref guard) so the
 * compact filter still resets exactly when the active session changes.
 */
export interface UseSessionViewStateParams {
  /** Active session id — used to reset the compact filter on session switch. */
  activeSessionId: string | null;
}

export interface UseSessionViewState {
  /** Chat filter: false = all messages, true = hide tool_use + thinking. */
  chatFilterCompact: boolean;
  setChatFilterCompact: React.Dispatch<React.SetStateAction<boolean>>;

  /** Secondary "more tools" row visibility (collapsed by default). */
  showMoreTools: boolean;
  setShowMoreTools: React.Dispatch<React.SetStateAction<boolean>>;

  /** Session overview panel visibility. */
  showSessionOverview: boolean;
  setShowSessionOverview: React.Dispatch<React.SetStateAction<boolean>>;

  /** Collapsible settings bar expanded state. */
  settingsExpanded: boolean;
  setSettingsExpanded: React.Dispatch<React.SetStateAction<boolean>>;

  /** Diff viewer modal visibility. */
  showDiffViewer: boolean;
  setShowDiffViewer: React.Dispatch<React.SetStateAction<boolean>>;

  /** Checkpoint timeline modal visibility. */
  showCheckpoints: boolean;
  setShowCheckpoints: React.Dispatch<React.SetStateAction<boolean>>;

  /** Git view modal visibility. */
  showGitView: boolean;
  setShowGitView: React.Dispatch<React.SetStateAction<boolean>>;

  /** Stable callbacks to close each modal panel (for SessionPanels). */
  closeDiffViewer: () => void;
  closeCheckpoints: () => void;
  closeGitView: () => void;
}

export function useSessionViewState({
  activeSessionId,
}: UseSessionViewStateParams): UseSessionViewState {
  // Chat filter: 'all' shows everything, 'compact' hides tool_use and thinking
  const [chatFilterCompact, setChatFilterCompact] = useState(false);

  // Reset compact filter when switching sessions
  const prevSessionRef = useRef(activeSessionId);
  useEffect(() => {
    if (activeSessionId !== prevSessionRef.current) {
      prevSessionRef.current = activeSessionId;
      setChatFilterCompact(false);
    }
  }, [activeSessionId]);

  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [showGitView, setShowGitView] = useState(false);
  const [showMoreTools, setShowMoreTools] = useState(false);
  const [showSessionOverview, setShowSessionOverview] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  // Stable close callbacks so SessionPanels' React.memo (if any) isn't
  // defeated by fresh inline arrows on each SessionScreen re-render.
  const closeDiffViewer = useCallback(() => setShowDiffViewer(false), []);
  const closeCheckpoints = useCallback(() => setShowCheckpoints(false), []);
  const closeGitView = useCallback(() => setShowGitView(false), []);

  return {
    chatFilterCompact,
    setChatFilterCompact,
    showMoreTools,
    setShowMoreTools,
    showSessionOverview,
    setShowSessionOverview,
    settingsExpanded,
    setSettingsExpanded,
    showDiffViewer,
    setShowDiffViewer,
    showCheckpoints,
    setShowCheckpoints,
    showGitView,
    setShowGitView,
    closeDiffViewer,
    closeCheckpoints,
    closeGitView,
  };
}
