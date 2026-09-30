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
 * `SessionBar`'s tab-cwd badge is the first consumer. #8123 wires the same
 * derivation into the three sites the #7328 thread flagged as sharing the
 * same bug — the sidebar repo-group header (`App.tsx`'s `sidebarRepos`,
 * which also changes its GROUPING key, not just a label), the footer cwd
 * breadcrumb (`FooterBar.tsx`), and the file-tree root label
 * (`fileTreeLogic.ts`'s `buildBreadcrumbs`, via an optional label override
 * threaded in from `FileBrowserPanel.tsx`) — all four surfaces now call
 * this one function rather than each growing its own copy.
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
 * else `fallback(cwd)` (today's behaviour, unchanged for plain sessions and
 * for any input this helper can't make sense of).
 *
 * `fallback` defaults to `abbreviateCwd` (SessionBar / the sidebar / the
 * file-tree root all want the single-segment shape). #8123: FooterBar's
 * cwd breadcrumb has its own, intentionally-different non-worktree display
 * rule (last 2 path segments, not 1) that predates this helper — passing it
 * as `fallback` shares the worktree-repo-name PART across all four surfaces
 * without disturbing FooterBar's existing shape for a plain session.
 */
export function repoDisplayName(
  cwd: string | undefined,
  repoCwd: string | null | undefined,
  fallback: (cwd: string) => string = abbreviateCwd,
): string {
  if (typeof repoCwd === 'string' && repoCwd.length > 0) {
    return abbreviateCwd(repoCwd)
  }
  return fallback(cwd || '')
}
