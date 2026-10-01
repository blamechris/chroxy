/**
 * Worktree-aware repo display label for a session's cwd badge (#7328, #8123).
 *
 * #8181 hoisted `abbreviateCwd` / `repoDisplayName` / `sessionGroupKey` into
 * `@chroxy/store-core` (`repo-label.ts`) so the mobile app's nav header can
 * share the exact same derivation as the dashboard's SessionBar tab badge,
 * sidebar repo-group header, footer cwd breadcrumb, and file-tree root label.
 * This module re-exports them unchanged so every existing dashboard import
 * site (and `repoLabel.test.ts`) keeps working without a path update.
 */
export { abbreviateCwd, repoDisplayName, sessionGroupKey } from '@chroxy/store-core'
