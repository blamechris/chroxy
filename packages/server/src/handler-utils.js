/**
 * Shared utilities, constants, and validators for message handlers.
 *
 * This module is the dependency root for handler modules — it must NOT
 * import from ws-message-handlers.js or any handler module to avoid
 * circular dependencies.
 */
import { statSync, realpathSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { resolve, relative, sep } from 'path'
import { createLogger } from './logger.js'

const log = createLogger('handler-utils')

// -- Permission modes --
// `description` is a short, plain-English sentence the dashboard
// surfaces as a tooltip / inline hint (#4013). Keep terse — the picker
// space is limited and screen readers re-narrate the whole string.
// The default (Claude) auto-mode description deliberately names
// `--dangerously-skip-permissions` so users searching for that Claude CLI flag
// find the chroxy equivalent.
//
// #6638: the mode IDs are provider-independent, but the descriptions are NOT —
// the default copy is Claude-oriented (Read/Write/Edit tool names, the
// `--dangerously-skip-permissions` flag, real plan mode). Codex has different
// tools (apply_patch / shell / connectors) and no plan enforcement, so
// `getPermissionModes('codex')` returns codex-tuned copy. Callers pass the active
// session's provider; a switch re-sends `available_permission_modes` (session-handlers).
const MODE_LABELS = { approve: 'Approve', acceptEdits: 'Accept Edits', auto: 'Auto (skip all prompts)', plan: 'Plan' }
const MODE_DESCRIPTIONS = {
  default: {
    approve: 'Default. Every tool call gates on your approval in the dashboard or mobile app.',
    acceptEdits: 'Auto-approve Read/Write/Edit/NotebookEdit/Glob/Grep. Bash, MCP, and other tools still gate on approval.',
    auto: 'Auto-approve every tool call without prompting. Equivalent to `claude --dangerously-skip-permissions`.',
    plan: 'Plan mode — Claude is asked to plan before acting; each tool call still gates on approval.',
  },
  codex: {
    approve: 'Default. Every codex command, file edit, and connector action gates on your approval.',
    acceptEdits: 'Auto-approve codex file edits (apply_patch). Shell commands, connector actions, and permission escalations still gate on approval.',
    auto: 'Auto-approve every codex action without prompting (codex runs with approvalPolicy `never`).',
    plan: 'Not a distinct codex mode — behaves like Approve (codex has no plan enforcement).',
  },
}
const MODE_IDS = ['approve', 'acceptEdits', 'auto', 'plan']
const buildModes = (desc) => MODE_IDS.map((id) => ({ id, label: MODE_LABELS[id], description: desc[id] }))

// The default (Claude) mode list. Kept as a named export for back-compat.
export const PERMISSION_MODES = buildModes(MODE_DESCRIPTIONS.default)

/**
 * The permission-mode list with descriptions tuned to the given provider (#6638).
 * Codex gets codex-specific copy; everything else gets the default. The mode IDs
 * are identical across providers, so validation (ALLOWED_PERMISSION_MODE_IDS) is
 * provider-independent.
 * @param {string|null|undefined} provider
 */
export function getPermissionModes(provider) {
  return provider === 'codex' ? buildModes(MODE_DESCRIPTIONS.codex) : PERMISSION_MODES
}

export const ALLOWED_PERMISSION_MODE_IDS = new Set(PERMISSION_MODES.map((m) => m.id))

// -- Attachment validation constants --
export const MAX_ATTACHMENT_COUNT = 5
export const MAX_IMAGE_SIZE = 2 * 1024 * 1024       // 2MB decoded
export const MAX_DOCUMENT_SIZE = 5 * 1024 * 1024    // 5MB decoded
export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const ALLOWED_DOC_TYPES = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'])

/**
 * Validate an attachments array from a WebSocket message.
 * Returns null if valid, or an error string if invalid.
 */
export function validateAttachments(attachments) {
  if (!Array.isArray(attachments)) return 'attachments must be an array'
  if (attachments.length > MAX_ATTACHMENT_COUNT) return `too many attachments (max ${MAX_ATTACHMENT_COUNT})`
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    if (!att || typeof att !== 'object') return `attachment[${i}]: not an object`
    if (typeof att.type !== 'string' || (att.type !== 'image' && att.type !== 'document' && att.type !== 'file_ref')) {
      return `attachment[${i}]: type must be 'image', 'document', or 'file_ref'`
    }

    // file_ref: project-relative path — server reads content before sending to Claude
    if (att.type === 'file_ref') {
      if (typeof att.path !== 'string' || !att.path.trim()) {
        return `attachment[${i}]: file_ref requires a non-empty path`
      }
      if (att.path.startsWith('/')) {
        return `attachment[${i}]: file_ref path must not be absolute`
      }
      if (att.path.split('/').includes('..')) {
        return `attachment[${i}]: file_ref path must not contain traversal (..)`
      }
      continue
    }

    if (typeof att.mediaType !== 'string') return `attachment[${i}]: missing mediaType`
    if (typeof att.data !== 'string') return `attachment[${i}]: missing data`
    if (typeof att.name !== 'string') return `attachment[${i}]: missing name`

    if (att.type === 'image' && !ALLOWED_IMAGE_TYPES.has(att.mediaType)) {
      return `attachment[${i}]: type 'image' requires an image mediaType`
    }
    if (att.type === 'document' && !ALLOWED_DOC_TYPES.has(att.mediaType)) {
      return `attachment[${i}]: type 'document' requires a document mediaType`
    }

    const decodedSize = Math.ceil(att.data.length * 3 / 4)
    const maxSize = att.type === 'image' ? MAX_IMAGE_SIZE : MAX_DOCUMENT_SIZE
    if (decodedSize > maxSize) {
      return `attachment[${i}]: exceeds ${maxSize / (1024 * 1024)}MB limit`
    }
  }
  return null
}

const MAX_FILE_REF_SIZE = 1 * 1024 * 1024 // 1MB max per file_ref

/**
 * Resolve file_ref attachments by reading file content from the session's cwd.
 * Converts file_ref entries to standard document attachments with base64 data.
 * Non-file_ref attachments are passed through unchanged.
 *
 * @param {Array} attachments - Validated attachment array
 * @param {string} cwd - Session working directory
 * @returns {Array} Resolved attachments (file_ref → document with inline text)
 */
export function resolveFileRefAttachments(attachments, cwd) {
  if (!attachments?.length || !cwd) return attachments
  return attachments.map(att => {
    if (att.type !== 'file_ref') return att
    const absPath = resolve(cwd, att.path)
    // Security: ensure resolved path is within cwd
    const rel = relative(cwd, absPath)
    if (rel.startsWith('..') || resolve(cwd, rel) !== absPath) {
      return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: cannot read file outside project: ${att.path}]`).toString('base64'), name: att.name || att.path }
    }
    // Security: verify after symlink resolution to prevent symlink escape
    try {
      const realAbs = realpathSync(absPath)
      const realCwd = realpathSync(cwd)
      const realRel = relative(realCwd, realAbs)
      if (realRel.startsWith('..')) {
        return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: cannot read file outside project: ${att.path}]`).toString('base64'), name: att.name || att.path }
      }
    } catch {
      // realpathSync fails if file doesn't exist — let readFileSync handle ENOENT below
    }
    try {
      const stat = statSync(absPath)
      if (stat.size > MAX_FILE_REF_SIZE) {
        return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: file too large (${(stat.size / 1024).toFixed(0)}KB, max 1MB): ${att.path}]`).toString('base64'), name: att.name || att.path }
      }
      // Detect binary files by checking for null bytes in the first 8KB
      const raw = readFileSync(absPath)
      const sample = raw.subarray(0, 8192)
      if (sample.includes(0)) {
        return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: binary file not supported: ${att.path}]`).toString('base64'), name: att.name || att.path }
      }
      const content = raw.toString('utf-8')
      return { type: 'document', mediaType: 'text/plain', data: Buffer.from(content).toString('base64'), name: att.name || att.path }
    } catch (err) {
      const msg = err?.code === 'ENOENT' ? 'file not found' : err?.code === 'EACCES' ? 'permission denied' : 'read error'
      return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: ${msg}: ${att.path}]`).toString('base64'), name: att.name || att.path }
    }
  })
}

/**
 * Directories within $HOME that hold credentials or other sensitive
 * material a session should NEVER use as a working directory. Found in
 * the 2026-04-11 production readiness audit (Adversary A1 + Blocker 1):
 * the old validateCwdWithinHome accepted any $HOME-relative path,
 * letting an authenticated client set cwd to ~/.ssh / ~/.aws / etc. and
 * read or write credentials via the normal file-op handlers.
 *
 * Match semantics: the FIRST path segment of the real-resolved cwd
 * relative to $HOME must not match any entry. So `~/.ssh/keys` is
 * rejected (first segment `.ssh`) but `~/projects/foo/.ssh/keys` is
 * allowed (first segment `projects`). Project-local directories that
 * happen to contain a `.ssh` subdir are NOT blocked — blocking them
 * would be overly restrictive for legitimate tooling that scaffolds
 * these directories inside project trees.
 *
 * The check is layered on top of the existing home-prefix check, so
 * it's defense-in-depth — active whether or not the user has also set
 * an explicit workspaceRoots allowlist.
 */
const FORBIDDEN_HOME_SUBDIRS = new Set([
  '.ssh',
  '.aws',
  '.azure',         // `az login` tokens + service-principal secrets
  '.gcloud',        // legacy path (GCP's newer tools use ~/.config/gcloud)
  '.gnupg',
  '.docker',
  '.kube',
  '.config',        // blocks ~/.config/gcloud, ~/.config/gh, ~/.config/op, etc.
  '.netrc',         // file, but catch accidental dir usage
  '.password-store',
  '.pgpass',
  '.git-credentials',
  '.npmrc',
  '.yarnrc',
  '.pypirc',
  '.m2',            // Maven settings.xml frequently holds repo credentials
  '.terraform.d',   // Terraform Cloud login tokens
  '.helm',          // Helm repo credentials
  '.rclone',        // rclone remote configs with cloud-storage keys
  '.dbt',           // dbt profiles with warehouse passwords
  '.passage',       // passage password store
  // Chroxy's own internal state: supervisor PID, known-good git ref,
  // push tokens, config. Added 2026-04-11 (Adversary A9) — without
  // this, an authenticated client could create a session in
  // ~/.chroxy, write_file `known-good-ref`, and poison the
  // supervisor's crash-rollback target.
  '.chroxy',
  // Claude Code's own internal state: conversation JSONLs, settings,
  // hooks. Pairs with the A8 conversation-scope fix — prevents a
  // bound client from creating a session that writes directly into
  // the JSONL ring Claude Code is reading from.
  '.claude',
])

/**
 * Returns true if `absPath` is underneath OR equal to `baseDir`,
 * using segment-aware comparison so `/home/user/workspace` is NOT
 * considered within `/home/user/work`.
 *
 * Both arguments must already be realpath-resolved and absolute.
 *
 * Edge case: when `baseDir` already ends with a path separator (e.g.
 * POSIX `'/'` filesystem root, or Windows drive roots like `'C:\\'`),
 * `baseDir + sep` would become `'//'` / `'C:\\\\'` and startsWith()
 * would return false for paths that ARE inside the base. Strip the
 * trailing separator first to normalize. Found by Copilot review on
 * PR #2808.
 */
// #5835: a client "views" a session iff it's its active session or in its
// subscribed set — the SAME viewing clause ws-forwarding's terminalSubscriberFilter
// uses to scope terminal_output/terminal_size broadcasts. Every PTY-touching
// terminal handler (terminal_size send, terminal_resize, terminal_input) gates on
// this so a client that merely knows a session id — but isn't watching it — can't
// drive or leak its terminal (#5840 review; extended to terminal_input in #5842).
// Shared here so the session-handlers and input-handlers copies can't drift.
//
// #6030: this is ALSO the single source of truth for the answer-authorization
// invariant "who may ANSWER a permission/question == who could have RECEIVED it".
// The broadcaster's recipient predicate (_matchesSession), the unbound
// AskUserQuestion answer guard (input-handlers.js, #4788), and the unbound
// permission-response guard (settings-handlers.js, #4798) all route through this
// SAME function — so if the receiver set is ever widened (a new viewer class, the
// LAN shared-session epic), the answer guards follow automatically and cannot
// drift back into the cross-session answer-hijack vector #4788/#4798 closed.
export function isSessionViewer(client, sid) {
  return client.activeSessionId === sid ||
    Boolean(client.subscribedSessionIds && client.subscribedSessionIds.has(sid))
}

// #5985b (epic #5982): is this session entry a general-purpose user shell? The
// session-scoped viewer/primary-claim gates that suffice for the claude-tui
// mirror are NOT enough for a root shell — terminal_subscribe (output exfil),
// terminal_resize, and terminal_input must additionally require the PRIMARY
// token class (swarm-audit findings C1/C4). Reads the positive `isUserShell`
// class discriminator (false on every existing session type), so the gates that
// call this are inert until the UserShellSession provider lands (#5983).
export function isUserShellSession(entry) {
  return entry?.session?.constructor?.isUserShell === true
}

// #5835 / audit P1-2: the single predicate for who RECEIVES a session's live
// terminal mirror — opted into the terminal (`terminalSessionIds`) AND a viewer
// of the session (`isSessionViewer`). The delivery filter
// (ws-forwarding's terminalSubscriberFilter) and the coalescer gate
// (ws-server's _syncTerminalMirror) MUST use the SAME predicate: gate-true /
// filter-false wastes the coalescer on nobody, and gate-false / filter-true is
// a black terminal for a real viewer. Both inlined it before and could drift;
// shared here so they can't.
export function terminalMirrorRecipient(client, sid) {
  return Boolean(client.terminalSessionIds && client.terminalSessionIds.has(sid)) &&
    isSessionViewer(client, sid)
}

export function isPathWithin(absPath, baseDir) {
  if (absPath === baseDir) return true
  // Normalize: strip a trailing separator so filesystem root and
  // drive roots work correctly. After this, baseDir is never
  // '/' or 'C:\\' — it's '' or 'C:'. We then append sep before the
  // prefix match so we still require a separator boundary.
  const normalized = baseDir.endsWith(sep) ? baseDir.slice(0, -1) : baseDir
  // If the normalization drove baseDir to an empty string, the
  // original was '/' (posix) — everything absolute is within it.
  if (normalized === '') return true
  return absPath.startsWith(normalized + sep)
}

/**
 * Returns true if `absPath` touches any FORBIDDEN_HOME_SUBDIRS entry
 * at any depth below $HOME. E.g. `/home/user/.ssh` and
 * `/home/user/.config/gcloud/credentials` both match.
 *
 * The match is CASE-INSENSITIVE on purpose: on case-insensitive
 * filesystems (macOS APFS default, Windows NTFS default), `~/.SSH` is
 * the same directory as `~/.ssh` but the raw Set lookup would miss it
 * — trivially bypassing the deny-list with `cwd: ~/.SSH`. Doing a
 * lowercase compare closes that bypass on every filesystem. On
 * case-sensitive filesystems nobody sensibly creates two distinct
 * `.ssh`/`.SSH` directories, so the broader match is safe.
 * Found by agent review on PR #2808.
 */
function pathTouchesForbiddenSubdir(absPath, home) {
  if (!isPathWithin(absPath, home)) return false
  const rel = relative(home, absPath)
  if (rel === '') return false
  const firstSegment = rel.split(sep)[0].toLowerCase()
  return FORBIDDEN_HOME_SUBDIRS.has(firstSegment)
}

/**
 * Validate that a cwd path is allowed as a session working directory.
 *
 * Layers (each must pass):
 *
 * 1. Path hygiene — must exist, be a directory, and be realpath-
 *    resolvable. Catches broken or non-directory paths up front.
 *
 * 2. Credential-directory deny-list — regardless of any allowlist, the
 *    cwd must NOT be inside any FORBIDDEN_HOME_SUBDIRS entry below
 *    $HOME. Closes the 2026-04-11 audit Adversary A1 attack where an
 *    authenticated client could set cwd to ~/.ssh to read credentials.
 *
 * 3. Workspace allowlist (opt-in) — if `config.workspaceRoots` is a
 *    non-empty array, the cwd must be inside at least one of the
 *    realpath-resolved entries. This is the strict mode audit blocker 1
 *    recommends for security-conscious deployments.
 *
 * 4. Home fallback (default) — if no allowlist is configured, the cwd
 *    must still be inside $HOME. Preserves backward compatibility for
 *    existing deployments while the deny-list (layer 2) closes the
 *    worst of the attack surface.
 *
 * @param {string} cwd - Directory path to validate
 * @param {object} [config] - Optional runtime config. `config.workspaceRoots` is an array of absolute paths that form the allowlist. `config.homeOverride` is a test-only override for `os.homedir()`; setting it lets tests run hermetically against a throwaway directory without touching the real user home. Never use homeOverride in production code.
 * @returns {string|null} Error message or null if valid
 */
export function validateCwdAllowed(cwd, config = null) {
  // Layer 1: path hygiene
  try {
    const s = statSync(cwd)
    if (!s.isDirectory()) return `Not a directory: ${cwd}`
  } catch {
    return `Directory does not exist: ${cwd}`
  }
  let realCwd
  try {
    realCwd = realpathSync(cwd)
  } catch {
    return `Cannot resolve path: ${cwd}`
  }

  // Layer 2: credential-directory deny-list (always active).
  // `homeOverride` exists so tests can use a hermetic fake home
  // directory instead of creating throwaway dirs under the user's
  // real ~/.config. Never used in production — config.js does not
  // declare or forward homeOverride from user config.
  const home = (config?.homeOverride && typeof config.homeOverride === 'string')
    ? realpathSync(config.homeOverride)
    : homedir()
  if (pathTouchesForbiddenSubdir(realCwd, home)) {
    return 'Directory is not allowed: credential/config directories under $HOME are blocked for security'
  }

  // Layer 3: explicit allowlist (opt-in, strict)
  const roots = Array.isArray(config?.workspaceRoots)
    ? config.workspaceRoots.filter((r) => typeof r === 'string' && r.length > 0)
    : []
  if (roots.length > 0) {
    let anyRootResolved = false
    for (const root of roots) {
      let realRoot
      try {
        realRoot = realpathSync(root)
      } catch {
        // Configured root that doesn't resolve is a config error — skip
        // it rather than failing the whole check, but it can't match.
        continue
      }
      anyRootResolved = true
      if (isPathWithin(realCwd, realRoot)) return null
    }
    // If at least ONE root resolved, enforce strictly. Otherwise every
    // configured root is stale (mount offline, typo, removed dir) and
    // the user would be silently locked out of every session. Fall
    // through to the home-fallback in that case rather than denying
    // everything. Found by Copilot review on PR #2808.
    if (anyRootResolved) {
      return `Directory is not within any configured workspace root (${roots.length} configured)`
    }
    // else fall through to layer 4 home fallback
  }

  // Layer 4: home fallback (default)
  if (!isPathWithin(realCwd, home)) {
    return 'Directory must be within your home directory'
  }
  return null
}

/**
 * @deprecated Use validateCwdAllowed(cwd, config) instead.
 *
 * Kept as a back-compat alias that calls validateCwdAllowed with no
 * config, so the deny-list layer is still active for callers that
 * haven't been migrated yet. New code and tests should use the name
 * that reflects the current behavior.
 */
export function validateCwdWithinHome(cwd) {
  return validateCwdAllowed(cwd, null)
}

// Exported for tests
export { FORBIDDEN_HOME_SUBDIRS }

/**
 * Check whether a connected WS client declared a specific capability during auth.
 *
 * @param {WebSocket} ws - The WebSocket connection object
 * @param {string} capability - The capability string to check
 * @returns {boolean} true if the client declared the capability, false otherwise
 */
export function clientHasCapability(ws, capability) {
  return ws.clientCapabilities?.has(capability) ?? false
}

/** Broadcast client_focus_changed to other clients when a client's active session changes */
export function broadcastFocusChanged(client, sessionId, ctx) {
  ctx.transport.broadcast(
    { type: 'client_focus_changed', clientId: client.id, sessionId, timestamp: Date.now() },
    (c) => c.id !== client.id
  )
}

/**
 * Auto-subscribe all other authenticated clients to a session.
 * Call after creating a session so streaming messages reach every connected client
 * (dashboard, other mobile clients, etc.) without requiring explicit subscribe_sessions.
 */
export function autoSubscribeOtherClients(sessionId, excludeWs, ctx) {
  for (const [clientWs, c] of ctx.transport.clients) {
    if (c.authenticated && clientWs !== excludeWs) {
      // #5563: route through the index-maintaining helper so the
      // sessionId→clients reverse index stays in sync. Falls back to a bare
      // add for fixtures whose ctx predates the helper.
      if (typeof ctx.transport.subscribeClient === 'function') {
        ctx.transport.subscribeClient(c, sessionId)
      } else {
        // lint-ignore-ws-index-mutation: guarded fixture fallback. This
        // else-branch only runs for legacy test fixtures whose ctx predates the
        // #5563 index-maintaining subscribeClient helper; production always takes
        // the helper path above, so this bare add can't drift the reverse index.
        c.subscribedSessionIds.add(sessionId)
      }
    }
  }
}

/**
 * Resolve a session from a message and client context.
 * Prefers msg.sessionId, falls back to client.activeSessionId.
 * Returns the session entry, or null if not found.
 *
 * If the client has a boundSessionId, enforces that the resolved session
 * matches the binding. Returns null if the binding is violated.
 *
 * @param {object} ctx - Handler context with sessionManager
 * @param {object} msg - Incoming WebSocket message
 * @param {object} client - Connected client state
 * @returns {object|null} Session entry or null
 */
export function resolveSession(ctx, msg, client) {
  const sid = msg.sessionId || client?.activeSessionId

  // Enforce session token binding: a bound client can only resolve its own
  // session. If a specific sid was requested and it doesn't match, reject.
  if (sid && client?.boundSessionId && client.boundSessionId !== sid) {
    return null
  }

  // Delegate to sessionManager — its getSession handles null/undefined sid
  // (real SessionManager returns null, cliSession adapter returns default entry).
  return ctx.sessions?.sessionManager?.getSession(sid) ?? null
}

/**
 * Send a `session_error` envelope to a WebSocket client (#4773, #4809).
 *
 * All `ctx.transport.send(ws, { type: 'session_error', message })` sites across the
 * handler modules build the same two-field payload by hand. Centralising the
 * shape here means a future schema tweak (adding `code`, `recoverable`,
 * `sessionId`, etc.) lands in one place instead of being scattered across
 * every handler. As of #4809 only ~11 deliberate-soft-fallback sites remain
 * in src/handlers/ — every one of them carries an extra field beyond
 * `message` (the `input_conflict` category, the SESSION_TOKEN_MISMATCH
 * `buildSessionTokenMismatchPayload` spread, or the create-session `code`
 * field) so they cannot use this helper without extending its signature.
 *
 * Routed through `ctx.transport.send` rather than `ws.send` so it stays compatible
 * with the existing handler tests (which monkey-patch `ctx.transport.send` and
 * inspect the captured payloads). In production both surfaces ultimately
 * call `ws.send(JSON.stringify(msg))` via WsServer._send, so behaviour is
 * identical.
 *
 * @param {WebSocket} ws - Target WebSocket connection
 * @param {object} ctx - Handler context with `send(ws, msg)`
 * @param {string} message - Human-readable, user-facing error message
 */
export function sendSessionError(ws, ctx, message) {
  if (!ws || !ctx || typeof ctx.transport?.send !== 'function') return
  ctx.transport.send(ws, { type: 'session_error', message })
}

/**
 * Resolve a session and emit a canonical "No active session" error on miss (#4773).
 *
 * Wraps the 13-times-verbatim handler pattern:
 *
 *   const entry = resolveSession(ctx, msg, client)
 *   if (!entry) {
 *     ctx.transport.send(ws, { type: 'session_error', message: 'No active session' })
 *     return
 *   }
 *
 * Returning `null` on miss (after emitting the envelope) preserves the
 * existing call-site idiom — callers stay `if (!entry) return`. On a hit
 * the helper is a pure pass-through to `resolveSession`, including its
 * session-token-binding enforcement (a bound client asking for a different
 * session resolves to `null` and triggers the same error envelope, matching
 * the pre-refactor behaviour).
 *
 * @param {WebSocket} ws - Target WebSocket connection for the error envelope
 * @param {object} ctx - Handler context with sessionManager + send
 * @param {object} msg - Incoming WebSocket message
 * @param {object} client - Connected client state
 * @returns {object|null} Session entry on hit, null after emitting on miss
 */
export function resolveSessionOrError(ws, ctx, msg, client) {
  const entry = resolveSession(ctx, msg, client)
  if (!entry) {
    sendSessionError(ws, ctx, 'No active session')
    return null
  }
  return entry
}

/**
 * Capability-gate the bound session's provider before invoking a method (#4773).
 *
 * Wraps the 6-times-repeated handler pattern:
 *
 *   if (typeof entry.session.setX !== 'function') {
 *     ctx.transport.send(ws, { type: 'session_error',
 *       message: 'This provider does not support X' })
 *     return
 *   }
 *
 * Returns `true` when the method is callable so the caller can proceed,
 * `false` (after emitting the `session_error` envelope) otherwise. The
 * helper also defends against a missing `entry` / `entry.session` so call
 * sites don't need a second null-check before reaching the gate.
 *
 * @param {WebSocket} ws - Target WebSocket connection for the error envelope
 * @param {object} ctx - Handler context with `send(ws, msg)`
 * @param {object|null} entry - Session entry from resolveSession[OrError]
 * @param {string} method - Method name to probe on entry.session
 * @param {string} message - Human-readable capability-gate error message
 * @returns {boolean} true if method is callable, false after emitting on miss
 */
export function requireSessionMethod(ws, ctx, entry, method, message) {
  if (!entry || !entry.session || typeof entry.session[method] !== 'function') {
    sendSessionError(ws, ctx, message)
    return false
  }
  return true
}

/**
 * Send a structured error response to a WebSocket client.
 * Use in handler catch blocks so the client can clear loading state
 * and surface a user-facing message instead of silently spinning.
 *
 * Optionally accepts a `data` object whose own enumerable fields are merged
 * onto the wire payload alongside the canonical four (#3538). Use this to
 * attach structured context — e.g. `actualAuthor` on `INVALID_AUTHOR` — so
 * dashboard clients can branch on `code` and read fields directly instead of
 * regex-parsing the human-readable `message`. Canonical fields always win:
 * `data` keys named `type`/`requestId`/`code`/`message` are ignored, so a
 * misbehaving caller cannot spoof the wire shape.
 *
 * #5632: routes through the encryption-aware transport when a handler `ctx`
 * is supplied. `sendError` emits a plaintext `{ type: 'error' }` frame, and the
 * client's post-handshake plaintext guard (connection.ts) closes the socket on
 * any non-`encrypted` frame that isn't a handshake frame once E2E encryption is
 * established. Passing `ctx` makes the error go out through `ctx.transport.send`
 * (→ WsServer._send → the per-client encrypting sender), so a post-handshake
 * error is encrypted (the client decrypts it normally) and a pre-handshake one
 * stays cleartext (the client's guard is inactive while encState is null —
 * correct). When `ctx` is absent (pre-auth call sites with no handler context,
 * e.g. pairing rejectIfBound) we fall back to the raw `ws.send`; those paths run
 * before encryption is established, so cleartext is correct there too.
 *
 * @param {WebSocket} ws - Target WebSocket connection
 * @param {string|null} requestId - Correlating request ID (may be null)
 * @param {string} code - Machine-readable error code (e.g. 'HANDLER_ERROR')
 * @param {string} message - Human-readable error description
 * @param {object} [data] - Optional structured fields merged into the payload
 * @param {object} [ctx] - Handler context; when present routes via
 *   `ctx.transport.send` so the frame is encrypted for post-handshake clients
 */
export function sendError(ws, requestId, code, message, data, ctx) {
  if (!ws || ws.readyState !== 1) return
  const payload = { type: 'error', requestId: requestId ?? null, code, message }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      // Canonical fields are reserved — never let a caller clobber them.
      if (key === 'type' || key === 'requestId' || key === 'code' || key === 'message') continue
      // #3578: block prototype-pollution keys. event-normalizer.js applies
      // the same guard. sendError is a generic utility that may end up
      // called with partially user-derived data, so harden defensively even
      // though no current caller passes untrusted input.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      payload[key] = value
    }
  }
  // #5632: prefer the encryption-aware transport so post-handshake errors are
  // encrypted; fall back to raw send for pre-auth call sites without a ctx.
  // #5702 (8a): guard both sends. A throw here (e.g. a torn-down socket) would
  // otherwise escape an error-reporting path — which often runs from a catch
  // block — and could mask the original failure or take down the caller. The
  // error frame failing to reach a half-open client is itself non-fatal, so we
  // log and move on rather than rethrow.
  if (ctx && typeof ctx.transport?.send === 'function') {
    try {
      ctx.transport.send(ws, payload)
    } catch (err) {
      log.warn(`sendError: transport send failed for ${payload.code || 'error'}: ${String(err?.message || err)}`)
    }
    return
  }
  try {
    ws.send(JSON.stringify(payload))
  } catch (err) {
    log.warn(`sendError: raw send failed for ${payload.code || 'error'}: ${String(err?.message || err)}`)
  }
}

// Issue #2912: every handler that rejects with SESSION_TOKEN_MISMATCH used to
// build its own ad-hoc payload — some included boundSessionId/boundSessionName
// (PR #2911 for create_session + resume_conversation), some included only
// `code` and `message`. Clients branching on `code === 'SESSION_TOKEN_MISMATCH'`
// therefore saw divergent shapes depending on which handler rejected them.
// Centralise the shape here so every call site produces the same four fields.
export const SESSION_TOKEN_MISMATCH_DEFAULT_MESSAGE = 'Not authorized to access this session'

/**
 * Build the canonical SESSION_TOKEN_MISMATCH error payload fields.
 *
 * Always returns `{ code, message, boundSessionId, boundSessionName }` so
 * clients can rely on the shape regardless of which handler rejected. When
 * the bound session is still resolvable via `sessionManager`, `boundSessionName`
 * is the session's name; when the binding is stale or no sessionManager is
 * available, it is `null`. When the client has no bound session at all (the
 * HTTP fallback path), both `boundSessionId` and `boundSessionName` are `null`.
 *
 * @param {object} opts
 * @param {object|null} [opts.sessionManager] - Session manager for name lookup (optional)
 * @param {string|null|undefined} [opts.boundSessionId] - The client's bound session id
 * @param {string} [opts.message] - Human-readable error message
 * @returns {{code: string, message: string, boundSessionId: string|null, boundSessionName: string|null}}
 */
export function buildSessionTokenMismatchPayload({
  sessionManager = null,
  boundSessionId = null,
  message = SESSION_TOKEN_MISMATCH_DEFAULT_MESSAGE,
} = {}) {
  const normalisedBoundId = typeof boundSessionId === 'string' && boundSessionId ? boundSessionId : null
  let boundSessionName = null
  if (normalisedBoundId && sessionManager && typeof sessionManager.getSession === 'function') {
    const entry = sessionManager.getSession(normalisedBoundId)
    boundSessionName = (entry && typeof entry.name === 'string') ? entry.name : null
  }
  return {
    code: 'SESSION_TOKEN_MISMATCH',
    message,
    boundSessionId: normalisedBoundId,
    boundSessionName,
  }
}
