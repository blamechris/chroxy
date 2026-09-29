/**
 * Worktree-aware repo display label for a session's cwd badge (#7328).
 *
 * A session isolated into a chroxy-managed git worktree runs out of
 * `~/.chroxy/worktrees/<32-hex session id>` (`session-manager.js`'s
 * `_createSession`), so the last path segment of `cwd` is an opaque hash
 * rather than anything recognisable — the tab badge used to render e.g.
 * `34914672f8578ecdf71accf8f8aec47e` instead of the repo name.
 *
 * No new server/protocol plumbing was needed to fix this: the server already
 * threads the ORIGINAL repo directory through as `repoCwd` on every
 * `session_list` entry (`ServerSessionListEntrySchema.repoCwd` in
 * `@chroxy/protocol`, sourced from `session-manager.js`'s
 * `entry.worktreeRepoDir`) — `null` for a non-worktree session, `undefined`
 * on a server that predates the field. This helper just prefers
 * `basename(repoCwd)` over `basename(cwd)` when a usable `repoCwd` is present,
 * and falls back to the pre-#7328 basename-of-cwd behaviour otherwise (no
 * `repoCwd`, an old server, or a non-worktree session).
 *
 * `SessionBar`'s tab-cwd badge is the first consumer. The issue thread
 * (#7328) also flags three more cwd-basename sites that leak the same
 * opaque hex — the sidebar repo-group header (`App.tsx`), the footer cwd
 * breadcrumb (`FooterBar.tsx`), and the file-tree root label
 * (`fileTreeLogic.ts`) — tracked as a follow-up so they can share this same
 * repo-name derivation rather than growing a second copy of it.
 */

/**
 * Last path segment of `cwd`, or `cwd` itself when that's empty (e.g. `cwd`
 * is itself empty, or a bare `/`). Matches `SessionBar`'s pre-#7328
 * `abbreviateCwd` exactly — moved here unchanged so the worktree-aware
 * fallback path stays byte-identical to today's behaviour.
 */
export function abbreviateCwd(cwd: string): string {
  const parts = cwd.split('/')
  return parts[parts.length - 1] || cwd
}

/**
 * The label a cwd badge should render: the basename of `repoCwd` when it's a
 * non-empty string (a worktree-isolated session's original repo directory),
 * else the basename of `cwd` (today's behaviour, unchanged for plain
 * sessions and for any input this helper can't make sense of).
 */
export function repoDisplayName(cwd: string | undefined, repoCwd: string | null | undefined): string {
  if (typeof repoCwd === 'string' && repoCwd.length > 0) {
    return abbreviateCwd(repoCwd)
  }
  return abbreviateCwd(cwd || '')
}
