import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * View-mode / panel-visibility state for SessionScreen (#5654).
 *
 * Owns the *local* UI-toggle state that drives SessionScreen's secondary-panel
 * routing: the chat compact filter (with its session-switch reset effect) and
 * the three modal panels (diff viewer, checkpoints, git view) plus their
 * stable close callbacks.
 *
 * Deliberately NOT here:
 * - `viewMode` / `setViewMode` — store-backed via `useConnectionStore`
 * - the create-session modal and attachment bottom-sheet — belong to those flows
 * - `showMoreTools`, `showSessionOverview`, `settingsExpanded` — plain UI
 *   layout-chrome toggles with no functional relationship to modal routing or
 *   the compact filter; they live as local `useState` in SessionScreen directly
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

  // Stable close callbacks so SessionPanels' React.memo (if any) isn't
  // defeated by fresh inline arrows on each SessionScreen re-render.
  const closeDiffViewer = useCallback(() => setShowDiffViewer(false), []);
  const closeCheckpoints = useCallback(() => setShowCheckpoints(false), []);
  const closeGitView = useCallback(() => setShowGitView(false), []);

  return {
    chatFilterCompact,
    setChatFilterCompact,
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
