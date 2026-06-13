/**
 * Repository management handlers.
 *
 * Handles: list_repos, add_repo, remove_repo, and the per-repo session-preset
 * surface (#5553): session_preset_get, session_preset_set (daemon override
 * write), session_preset_approve / session_preset_revoke (trust gate).
 *
 * Authority (bearer-token-authority.md): the session-preset map is HOST-WIDE
 * config — the same scope as the Control Room host survey, broader than any
 * single session. So the four preset handlers require HOST-LEVEL authority: a
 * client with `client.boundSessionId` set (a share-a-session pairing client) is
 * scoped to one session and is rejected. Authentication itself is already
 * enforced before dispatch in ws-server._handleMessage.
 */
import { statSync, realpathSync } from 'fs'
import { basename } from 'path'
import { scanConversations as defaultScanConversations, groupConversationsByRepo } from '../conversation-scanner.js'
import {
  readReposFromConfig as defaultReadRepos,
  writeReposToConfig as defaultWriteRepos,
  writeSessionPresetOverrideToConfig as defaultWriteOverride,
} from '../config.js'
import { validatePreset } from '../session-preset.js'
import { validateCwdAllowed, sendSessionError } from '../handler-utils.js'

/**
 * Reject a non-host (session-bound) client from a host-authority preset
 * operation. Returns true when the request was rejected (caller should return).
 */
function rejectIfNotHost(ws, client, ctx) {
  if (client.boundSessionId) {
    ctx.transport.send(ws, {
      type: 'session_error',
      code: 'NOT_AUTHORIZED',
      message: 'Per-repo session presets require host-level authority',
    })
    return true
  }
  return false
}

/**
 * Project a resolver descriptor onto the wire shape for the per-repo drawer.
 * Unlike the create-confirm disclosure (length-only preamble), the drawer
 * needs the full preamble + seed TEXT so the operator can preview/edit it. The
 * full preset text only reaches HOST-level clients here (rejectIfNotHost gate).
 */
function projectPresetForDrawer(resolved) {
  if (!resolved) return null
  return {
    source: resolved.source,
    active: resolved.active,
    trustState: resolved.trustState,
    enabled: resolved.enabled,
    preamble: resolved.preamble || '',
    seed: resolved.seed || '',
    preambleLength: resolved.preambleLength,
    seedLength: resolved.seedLength,
    capped: !!resolved.capped,
    repoPath: resolved.repoPath || null,
  }
}

/**
 * Build merged repo list from auto-discovered and manual repos.
 * Manual repos come first, auto-discovered repos are deduplicated.
 *
 * Tests may pass `ctx` overrides for `scanConversations` / `readReposFromConfig` to
 * avoid touching the real filesystem.
 */
async function buildRepoList(ctx = {}) {
  const scan = ctx.scanConversations || defaultScanConversations
  const readRepos = ctx.readReposFromConfig || defaultReadRepos
  // Pass provider-driven projectsDirs when available (#2965); falls back to
  // the scanner's default (~/.claude/projects) when not set.
  const scanOpts = ctx.runtime?.projectsDirs ? { projectsDirs: ctx.runtime.projectsDirs } : {}
  const conversations = await scan(scanOpts)
  const autoRepos = groupConversationsByRepo(conversations)
  const manualRepos = readRepos()
  const seen = new Set()
  const repos = []

  for (const repo of manualRepos) {
    seen.add(repo.path)
    let exists = false
    try { statSync(repo.path); exists = true } catch { /* noop */ }
    repos.push({ path: repo.path, name: repo.name || basename(repo.path), source: 'manual', exists })
  }

  for (const repo of autoRepos) {
    if (seen.has(repo.path)) continue
    seen.add(repo.path)
    let exists = false
    try { statSync(repo.path); exists = true } catch { /* noop */ }
    repos.push({ path: repo.path, name: repo.name, source: 'auto', exists })
  }

  return repos
}

async function handleListRepos(ws, client, msg, ctx) {
  try {
    const repos = await buildRepoList(ctx)
    ctx.transport.send(ws, { type: 'repo_list', repos })
  } catch (err) {
    ctx.transport.send(ws, { type: 'server_error', message: `Failed to list repos: ${err.message}`, recoverable: true })
  }
}

async function handleAddRepo(ws, client, msg, ctx) {
  const repoPath = msg.path
  const cwdError = validateCwdAllowed(repoPath, ctx.services.config)
  if (cwdError) {
    sendSessionError(ws, ctx, cwdError)
    return
  }

  const readRepos = ctx.readReposFromConfig || defaultReadRepos
  const writeRepos = ctx.writeReposToConfig || defaultWriteRepos
  try {
    const resolvedPath = realpathSync(repoPath)
    const existing = readRepos()
    if (!existing.some(r => r.path === resolvedPath)) {
      existing.push({ path: resolvedPath, name: msg.name || basename(resolvedPath) })
      writeRepos(existing)
    }
    const repos = await buildRepoList(ctx)
    ctx.transport.send(ws, { type: 'repo_list', repos })
  } catch (err) {
    sendSessionError(ws, ctx, `Failed to add repo: ${err.message}`)
  }
}

async function handleRemoveRepo(ws, client, msg, ctx) {
  let targetPath = msg.path
  try { targetPath = realpathSync(msg.path) } catch { /* fall back to raw path */ }
  const readRepos = ctx.readReposFromConfig || defaultReadRepos
  const writeRepos = ctx.writeReposToConfig || defaultWriteRepos
  // The config read + write were previously OUTSIDE this try/catch: a failing
  // readReposFromConfig / writeReposToConfig (disk full, locked file, read-only
  // home) threw out of the handler, so the client got NO response at all and the
  // removal silently failed — the client's repo list stayed showing a repo the
  // user thought they'd removed. Wrap them like handleAddRepo so a config-write
  // failure surfaces a session_error the user can act on, and the repo_list
  // refresh only runs when the mutation actually persisted.
  try {
    const existing = readRepos()
    const filtered = existing.filter(r => r.path !== targetPath)
    writeRepos(filtered)
    const repos = await buildRepoList(ctx)
    ctx.transport.send(ws, { type: 'repo_list', repos })
  } catch (err) {
    sendSessionError(ws, ctx, `Failed to remove repo: ${err.message}`)
  }
}

/**
 * #5553: read the resolved per-repo session preset for a cwd (host-authority).
 * Returns the full preset metadata + text so the drawer can preview/edit it.
 * `cwd` is the repo path; the server walks up + applies daemon-override
 * precedence + the trust gate (same resolution createSession uses).
 */
function handleSessionPresetGet(ws, client, msg, ctx) {
  if (rejectIfNotHost(ws, client, ctx)) return
  const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : null
  if (!cwd) {
    ctx.transport.send(ws, { type: 'session_preset_snapshot', cwd: null, preset: null, requestId: msg.requestId })
    return
  }
  const resolved = ctx.sessions.sessionManager.resolveSessionPresetForCwd(cwd)
  ctx.transport.send(ws, {
    type: 'session_preset_snapshot',
    cwd,
    preset: projectPresetForDrawer(resolved),
    requestId: msg.requestId,
  })
}

/**
 * #5553: write (or clear) the daemon-side session-preset override for a repo
 * path (host-authority). The override lives in ~/.chroxy/config.json keyed by
 * the repo path; a daemon override is pre-trusted (the operator wrote it).
 * Pass `preset: null` to clear the override. The validated/coerced preset is
 * persisted; the reply re-resolves so the client sees the live state.
 */
function handleSessionPresetSet(ws, client, msg, ctx) {
  if (rejectIfNotHost(ws, client, ctx)) return
  const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : null
  if (!cwd) {
    sendSessionError(ws, ctx, 'A repo path (cwd) is required to set a session preset')
    return
  }
  const cwdError = validateCwdAllowed(cwd, ctx.services.config)
  if (cwdError) {
    sendSessionError(ws, ctx, cwdError)
    return
  }

  let resolvedPath = cwd
  try { resolvedPath = realpathSync(cwd) } catch { /* fall back to raw path */ }

  // Normalise the incoming preset. `null` (or an unusable object) clears the
  // override. A valid preset is coerced to the canonical { preamble, seed,
  // enabled } shape before persisting (so a hand-edited oversized seed is
  // capped at write time, never silently at run time).
  let toWrite = null
  if (msg.preset && typeof msg.preset === 'object') {
    const validated = validatePreset(msg.preset)
    if (validated) {
      toWrite = {
        preamble: validated.preamble,
        seed: validated.seed,
        enabled: validated.enabled,
      }
    }
  }

  const writeOverride = ctx.writeSessionPresetOverrideToConfig || defaultWriteOverride
  try {
    writeOverride(resolvedPath, toWrite, ctx.services.config?.configPath)
  } catch (err) {
    // Leak guard: never echo preset contents in the failure path.
    sendSessionError(ws, ctx, `Failed to write session preset override: ${err && err.message ? err.message : 'error'}`)
    return
  }

  const resolved = ctx.sessions.sessionManager.resolveSessionPresetForCwd(cwd)
  ctx.transport.send(ws, {
    type: 'session_preset_snapshot',
    cwd,
    preset: projectPresetForDrawer(resolved),
    requestId: msg.requestId,
  })
}

/**
 * #5553: approve the current content hash of a repo-local preset so it becomes
 * trusted + active for future sessions (host-authority). Re-resolves to get the
 * live hash so a stale client value can't pin a different version.
 */
function handleSessionPresetApprove(ws, client, msg, ctx) {
  if (rejectIfNotHost(ws, client, ctx)) return
  const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : null
  if (!cwd) {
    sendSessionError(ws, ctx, 'A repo path (cwd) is required to approve a session preset')
    return
  }
  const resolved = ctx.sessions.sessionManager.approveSessionPreset(cwd)
  ctx.transport.send(ws, {
    type: 'session_preset_snapshot',
    cwd,
    preset: projectPresetForDrawer(resolved),
    requestId: msg.requestId,
  })
}

/**
 * #5553: revoke trust for a repo-local preset so it goes inert again
 * (host-authority).
 */
function handleSessionPresetRevoke(ws, client, msg, ctx) {
  if (rejectIfNotHost(ws, client, ctx)) return
  const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : null
  if (!cwd) {
    sendSessionError(ws, ctx, 'A repo path (cwd) is required to revoke a session preset')
    return
  }
  const resolved = ctx.sessions.sessionManager.revokeSessionPreset(cwd)
  ctx.transport.send(ws, {
    type: 'session_preset_snapshot',
    cwd,
    preset: projectPresetForDrawer(resolved),
    requestId: msg.requestId,
  })
}

export const repoHandlers = {
  list_repos: handleListRepos,
  add_repo: handleAddRepo,
  remove_repo: handleRemoveRepo,
  session_preset_get: handleSessionPresetGet,
  session_preset_set: handleSessionPresetSet,
  session_preset_approve: handleSessionPresetApprove,
  session_preset_revoke: handleSessionPresetRevoke,
}
