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
