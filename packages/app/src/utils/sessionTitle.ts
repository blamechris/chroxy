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
  // The daemon may run on macOS, Linux or Windows: shorten any of the three
  // home prefixes and split on either separator (a path can mix them).
  const shortened = cwd.replace(/^(?:\/Users\/[^/\\]+|\/home\/[^/\\]+|[A-Za-z]:[\\/]Users[\\/][^/\\]+)/, '~');
  const parts = shortened.split(/[\\/]/);
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

/**
 * Location label for the collapsed settings summary row (#8238). Per-session,
 * like the nav header: the active session's repo name for a worktree session
 * (`repoCwd` basename), else its cwd shortened at a path boundary
 * (`abbreviateSessionCwd`). Only with NO active session (or one without a cwd
 * yet) does it fall back to the server's default cwd, shortened the same way.
 * Returns `null` when there is nothing to show.
 */
export function deriveSummaryLocation(
  session: { cwd?: string | null; repoCwd?: string | null } | null | undefined,
  fallbackCwd?: string | null,
): string | null {
  const cwd = session?.cwd || fallbackCwd;
  if (!cwd) return null;
  return repoDisplayName(cwd, session?.cwd ? session.repoCwd : null, abbreviateSessionCwd);
}
