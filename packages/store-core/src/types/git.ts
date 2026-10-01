/**
 * Git / diff result element types (#3132).
 *
 * Re-exported via ../types (barrel) — see ./index.ts.
 */

// Git result element types (#3132). Concrete shapes used by the dashboard
// and app. Moved up from per-client store/types.ts so per-element validation
// in `@chroxy/store-core/handlers` can reference the canonical type.

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'unknown';
  // #7292 — present only on a 'renamed' entry (never 'copied', #8183 review):
  // the pre-rename path (same cwd-relative base as `path`). git records a
  // rename as two independent index operations (remove the source, add the
  // destination), so staging/unstaging this entry should send BOTH `path`
  // and `oldPath` back on git_stage/git_unstage — see
  // expandRenamePathsForStaging in ../handlers/git.ts. A copy's source is
  // NOT removed (the two index entries are independent), so `oldPath` is
  // never set for a 'copied' entry even though git reports its source the
  // same way on the wire.
  oldPath?: string;
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

export interface DiffHunkLine {
  type: 'context' | 'addition' | 'deletion';
  content: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffHunkLine[];
}

export interface DiffFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}
