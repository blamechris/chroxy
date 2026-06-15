/**
 * Shared project-name derivation (audit P2-2, closes #5850).
 *
 * Single source of truth for turning a working directory into a project name,
 * consumed by BOTH:
 *   - the claude-hooks emitter (`packages/claude-hooks/src/project.js`), which
 *     walks the tree right where the session runs and sends `project` explicitly;
 *   - the server's `POST /api/events` fallback (`event-ingest.js`), used when an
 *     event arrives without `project`.
 *
 * Previously these were two byte-divergent copies; the hook half accreted the
 * worktree fixes (#5439/#5464/#5483) the server half lacked, so every fix had to
 * be re-derived. This module unifies them.
 *
 * **Zod-free by design.** This file imports ONLY node builtins so the
 * `@chroxy/protocol/project` subpath stays free of the Zod barrel — the hook
 * runs on every Claude Code event inside a <100ms budget and must not pull Zod.
 *
 * Path handling is cross-platform (`isAbsolute`/`relative`/`sep`); the two
 * test-surface env overrides from each former copy are both honored so neither
 * package's fixtures change (`CHROXY_WORKTREES_ROOT` /
 * `CHROXY_HOOKS_CHROXY_WORKTREES_ROOT`, and `CHROXY_HOOKS_TMP_PREFIXES`).
 */
type ProjectEnv = Record<string, string | undefined>;
/**
 * #5439 GAP B: a cwd inside a worktree checkout belongs to the PARENT project —
 * the segment before /.claude/worktrees/ — not the agent-* checkout. #5464
 * extends this to chroxy session worktrees (~/.chroxy/worktrees/<id>): their
 * basename is an opaque session id, so the parent is parsed from the worktree
 * `.git` file's gitdir instead. The chroxy check runs FIRST — an agent worktree
 * nested INSIDE a chroxy worktree should still resolve to the real repo.
 */
export declare function worktreeParent(cwd: string, env?: ProjectEnv): string | null;
/**
 * Classify cwds that should not mint their own status embeds (#5439 GAP B):
 *
 *   'tmp'      — /tmp, /var/tmp (and their /private macOS realpaths)
 *   'home'     — the home directory ROOT itself (basename = username, not a
 *                project); projects under home are fine
 *   'worktree' — .claude/worktrees agent checkouts AND chroxy session worktrees
 *                under ~/.chroxy/worktrees/<id> (#5464)
 *
 * Returns null for normal project cwds or when no cwd is available.
 */
export declare function classifyNonProjectCwd(cwd: string, env?: ProjectEnv): 'tmp' | 'home' | 'worktree' | null;
/**
 * HOOK entry point. Resolve the project name for the envelope: worktree-parent
 * remap first (#5439 GAP B — a worktree's own `.git` FILE would otherwise win
 * the walk and name the checkout), then the git root of the payload's cwd, then
 * $CLAUDE_PROJECT_DIR (Claude Code exports the project root there for hook
 * processes), then null (server-side derivation remains the last-resort fallback).
 */
export declare function deriveProject(cwd: string, env?: ProjectEnv): string | null;
/**
 * SERVER entry point. Derive a project name from a working directory by walking
 * up to the nearest `.git` (directory OR file — worktrees use a `.git` file) and
 * taking that directory's basename. Falls back to `basename(cwd)` when no git
 * root is found, and `null` for unusable input. Pure fs probing.
 *
 * #5483/#5850: a cwd inside a chroxy session worktree (`~/.chroxy/worktrees/<id>`)
 * is handled FIRST — the git walk there would name the project after the opaque
 * session id (the worktree's `.git` is a file pointing back at the real repo), so
 * recover the parent repo from that file, or return null rather than mint the id.
 */
export declare function deriveProjectFromCwd(cwd: string, env?: ProjectEnv): string | null;
export {};
