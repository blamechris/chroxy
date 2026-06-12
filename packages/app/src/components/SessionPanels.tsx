import React from 'react';
import { DiffViewer } from './DiffViewer';
import { CheckpointView } from './CheckpointView';
import { GitView } from './GitView';

/**
 * Secondary modal panels for SessionScreen (#5654).
 *
 * Groups the three modal "tools" panels that hang off SessionScreen's
 * secondary-tools row — the diff viewer, the checkpoint timeline, and the
 * git view. Each is a self-contained modal that pulls its own data from the
 * connection store; SessionScreen only owns the show/hide flag (via
 * `useSessionViewState`) and the close callback, both threaded through here.
 *
 * FileBrowser is intentionally NOT included: it renders inline in the
 * content-area view switch (`viewMode === 'files'`), not as a modal, so it
 * stays wired into SessionScreen's main content path.
 *
 * Behaviour-preserving: identical components, identical props, identical
 * render conditions (each modal self-gates on its `visible` prop exactly as
 * it did inline in SessionScreen).
 */
export interface SessionPanelsProps {
  showDiffViewer: boolean;
  onCloseDiffViewer: () => void;
  showCheckpoints: boolean;
  onCloseCheckpoints: () => void;
  showGitView: boolean;
  onCloseGitView: () => void;
}

export function SessionPanels({
  showDiffViewer,
  onCloseDiffViewer,
  showCheckpoints,
  onCloseCheckpoints,
  showGitView,
  onCloseGitView,
}: SessionPanelsProps) {
  return (
    <>
      {/* Diff viewer modal */}
      <DiffViewer visible={showDiffViewer} onClose={onCloseDiffViewer} />

      {/* Checkpoint timeline modal */}
      <CheckpointView visible={showCheckpoints} onClose={onCloseCheckpoints} />

      {/* Git view modal */}
      <GitView visible={showGitView} onClose={onCloseGitView} />
    </>
  );
}
