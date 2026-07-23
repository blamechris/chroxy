/**
 * @chroxy/protocol/codex — shared Codex constants.
 *
 * Single source of truth for the Codex sandbox modes so the wire contract
 * (`create_session`'s `codexSandbox`, see `./schemas/client.ts`), the server
 * (`packages/server/src/codex-session.js` re-exports these), and the clients
 * (the dashboard + mobile session-creation controls) all agree on exactly one
 * list — the same single-source pattern as `DEFAULT_PROVIDER` in `./index.ts`.
 *
 * Zod-free (plain consts) so this module stays importable from the
 * dependency-light `./project` consumers if ever needed, and so the client
 * schema can `z.enum(CODEX_SANDBOX_MODES)` without a circular import.
 */

/**
 * The Codex CLI sandbox modes, in ascending order of filesystem authority.
 * Verified against codex-cli 0.128.0 — Codex accepts exactly these three
 * `--sandbox` values.
 *
 *   - `read-only`          — Codex may read the workspace but cannot write.
 *   - `workspace-write`    — Codex may read/write within the workspace (default).
 *   - `danger-full-access` — no sandbox; Codex may touch anything the daemon can.
 */
export const CODEX_SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number]

/**
 * Default sandbox mode when nothing overrides it. `workspace-write` so a fresh
 * codex session can edit files (Codex would otherwise fall back to read-only in
 * any non-trusted dir — the #3846 stopgap).
 */
export const CODEX_DEFAULT_SANDBOX: CodexSandboxMode = 'workspace-write'

/** The codex provider id — single-sourced so the clients gate the sandbox
 * control on exactly this string. */
export const CODEX_PROVIDER = 'codex'

/**
 * UI-facing metadata for the sandbox selector: a short label and a one-line
 * description per mode. Kept next to the canonical list so a new mode can't be
 * added without a label. Descriptions are intentionally concise — the clients
 * render them as form hints.
 */
export const CODEX_SANDBOX_MODE_META: ReadonlyArray<{
  readonly id: CodexSandboxMode
  readonly label: string
  readonly description: string
}> = [
  {
    id: 'read-only',
    label: 'Read-only',
    description: 'Codex can read the workspace but every write is blocked.',
  },
  {
    id: 'workspace-write',
    label: 'Workspace write',
    description: 'Default. Codex can read and write within the workspace.',
  },
  {
    id: 'danger-full-access',
    label: 'Full access (danger)',
    description: 'No sandbox — Codex can touch anything the daemon can. Use only in trusted, isolated contexts.',
  },
] as const
