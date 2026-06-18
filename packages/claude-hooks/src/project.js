/**
 * Explicit project derivation for the hook emitters.
 *
 * The derivation logic now lives in the shared, Zod-free
 * `@chroxy/protocol/project` module (audit P2-2, #5850) so the hook and the
 * server's `event-ingest.js` fallback can no longer drift — the hook half used
 * to accrete the worktree fixes (#5439/#5464/#5483) the server half lacked.
 * This file is a thin re-export preserving the hook's existing import surface.
 *
 * The subpath imports ONLY node builtins (no Zod), so the <100ms hook budget is
 * unaffected. See the note in claude-hooks/package.json: this makes
 * `@chroxy/protocol` a real (workspace) runtime dependency of the hook.
 */
export { deriveProject, classifyNonProjectCwd, worktreeParent } from '@chroxy/protocol/project'
