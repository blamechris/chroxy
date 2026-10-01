/**
 * Worktree-aware repo display label for a session's cwd badge (#7328, #8123,
 * #8181).
 *
 * A session isolated into a chroxy-managed git worktree runs out of
 * `~/.chroxy/worktrees/<32-hex session id>` (`session-manager.js`'s
 * `_createSession`), so the last path segment(s) of `cwd` are an opaque hash
 * rather than anything recognisable — e.g. a tab badge rendering
 * `34914672f8578ecdf71accf8f8aec47e`, or the mobile nav header rendering
 * `worktrees/34914672f8578ecdf71accf8f8aec47e` (#8181).
 *
 * No new server/protocol plumbing is needed to fix this: the server already
 * threads the ORIGINAL repo directory through as `repoCwd` on every
 * `session_list` entry (`ServerSessionListEntrySchema.repoCwd` in
 * `@chroxy/protocol`, sourced from `session-manager.js`'s
 * `entry.worktreeRepoDir`) — `null` for a non-worktree session, `undefined`
 * on a server that predates the field. This helper just prefers
 * `basename(repoCwd)` over `basename(cwd)` when a usable `repoCwd` is
 * present, and falls back to the caller's own non-worktree display rule
 * otherwise (no `repoCwd`, an old server, or a non-worktree session).
 *
 * Originally lived only in `packages/dashboard/src/utils/repoLabel.ts`
 * (#7328's `SessionBar` tab-cwd badge, then #8123's sidebar/footer/file-tree
 * surfaces). #8181 hoisted it here so the mobile app's nav header
 * (`App.tsx`'s `sessionTitle`) can share the exact same derivation instead of
 * growing a second copy — the dashboard module now re-exports these three
 * functions for its existing import sites and tests.
 */

/**
 * Last path segment of `cwd`, or `cwd` itself when that's empty (e.g. `cwd`
 * is itself empty, or a bare `/`). Matches the dashboard's pre-#7328
 * `abbreviateCwd` exactly.
 *
 * Splits on a run of forward OR backslash separators (review nitpick on PR
 * #8180) so a Windows daemon's backslash cwd abbreviates the same way
 * `RepoEventsSection.tsx`'s `repoBasename` already does — the two
 * "basename of a path" helpers must not silently disagree on a Windows
 * session.
 */
export function abbreviateCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : cwd
}

/**
 * The label a cwd badge should render: the basename of `repoCwd` when it's a
 * non-empty string (a worktree-isolated session's original repo directory),
 * else `fallback(cwd)` (today's behaviour, unchanged for plain sessions and
 * for any input this helper can't make sense of).
 *
 * `fallback` defaults to `abbreviateCwd` (the dashboard's SessionBar / sidebar
 * / file-tree root all want the single-segment shape). Callers with their own
 * non-worktree display rule (the dashboard's `FooterBar` cwd breadcrumb wants
 * the last 2 path segments; the mobile app's nav header wants the same, with a
 * `~`-shortened home directory) pass it as `fallback` to share the
 * worktree-repo-name PART without disturbing their existing shape for a plain
 * session.
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

/**
 * The sidebar's repo GROUP KEY for a session: `repoCwd` when it's a
 * non-empty string (a worktree-isolated session), else `cwd`.
 *
 * Review follow-up on PR #8180 (issuecomment-5921537989, Critical #1):
 * the dashboard's `sidebarRepos` memo and `sidebarContextMenuItems.ts`'s
 * repo-group "Summarize & start new session" filter both need to agree on
 * which sessions belong to a repo group. Before this helper existed they
 * independently computed the same rule as two separate expressions — #8123
 * changed the memo's rule (`s.cwd` → `s.repoCwd || s.cwd`) but left the
 * menu's copy comparing against raw `s.cwd`, so a worktree-only group's
 * Summarize item silently disappeared (`groupSessions` computed to `[]`)
 * and a mixed group could only ever target its plain session. Sharing this
 * one function is what makes that class of drift impossible to reintroduce.
 */
export function sessionGroupKey(s: { cwd?: string; repoCwd?: string | null }): string {
  return s.repoCwd || s.cwd || ''
}
