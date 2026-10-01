/**
 * Nav header title derivation for the active session (#8181).
 *
 * A worktree-isolated session's `cwd` is an opaque
 * `~/.chroxy/worktrees/<32-hex session id>` checkout (`session-manager.js`'s
 * `_createSession`), so deriving the nav header purely from `cwd` renders e.g.
 * `worktrees/34914672f8578ecdf71accf8f8aec47e` instead of the repo name. The
 * server already threads the session's ORIGINAL repo directory through as
 * `repoCwd` on every `session_list` entry (`SessionInfo.repoCwd` in
 * `@chroxy/store-core` — `null` for a non-worktree session, `undefined` on a
 * server that predates the field).
 *
 * This mirrors the dashboard's `repoDisplayName` fix (#7328 / #8123,
 * `packages/dashboard/src/utils/repoLabel.ts`), now hoisted into
 * `@chroxy/store-core` (`repo-label.ts`) so both clients share one
 * implementation rather than growing a second copy of the same derivation.
 */
import { repoDisplayName } from '@chroxy/store-core';

/**
 * The nav header's pre-#8181 non-worktree display rule, passed to
 * `repoDisplayName` as its `fallback`: shorten `/Users/<name>` → `~`, then
 * take the last two path components for readability. Unchanged from the
 * inline logic `App.tsx`'s `sessionTitle` selector used before #8181 — a
 * worktree session now takes the `repoCwd`-basename branch instead, but a
 * plain session (or one from a server predating `repoCwd`) renders exactly
 * as it did before.
 */
export function abbreviateSessionCwd(cwd: string): string {
  const shortened = cwd.replace(/^\/Users\/[^/]+/, '~');
  const parts = shortened.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : shortened;
}

/**
 * The nav header title for the active session, or `'Session'` when there is
 * none (no active session, or the active session has no `cwd` yet). Prefers
 * the basename of `repoCwd` (the repo name) when it's a non-empty string,
 * else falls back to {@link abbreviateSessionCwd} applied to `cwd` — matching
 * the pre-#8181 behaviour byte-for-byte for a plain session or an old server.
 */
export function deriveSessionTitle(
  session: { cwd?: string | null; repoCwd?: string | null } | null | undefined,
): string {
  if (!session?.cwd) return 'Session';
  return repoDisplayName(session.cwd, session.repoCwd, abbreviateSessionCwd);
}
