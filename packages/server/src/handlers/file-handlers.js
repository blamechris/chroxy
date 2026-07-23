/**
 * File operations and git command handlers.
 *
 * Handles: list_directory, browse_files, list_files, read_file, write_file,
 *          get_diff, git_status, git_branches, git_stage, git_unstage,
 *          git_commit, git_create_pr, list_slash_commands, list_agents
 */
import { resolveSession, sendError } from '../handler-utils.js'
import { loggerForSession } from '../logger.js'

/**
 * #6541 — file/git MUTATION gate: reject pairing-bound (share-a-session) tokens.
 *
 * The write / git-mutation handlers were path-confined (`validatePathWithinCwd`)
 * but otherwise ungated — any authenticated client, INCLUDING a pairing-bound
 * (share-a-session) token, could overwrite files or mutate git state in the
 * session's cwd. A bound token is scoped to observe/collaborate on ONE session,
 * not to mutate the host filesystem; letting it write is the same class of
 * integrity risk the auto-mode / permission-rules / credential-write gates
 * already close (docs/security/bearer-token-authority.md §"Host-level writes a
 * bound token must NOT reach").
 *
 * Only BOUND tokens are rejected. The primary API token and the main mobile
 * app's UNBOUND linking-mode token (WsServer passes `null` binding, so linking
 * tokens behave like the primary token) still write — so the existing authorized
 * FileEditor is unaffected. This is client-write-authority, NOT `features.ide`
 * (that gates the new editable-diff affordances, #6542–#6544).
 *
 * @returns {boolean} true if the caller was rejected (handler must return).
 */
function rejectMutationIfBound(ws, client, msg, ctx, op) {
  if (client?.boundSessionId) {
    loggerForSession('ws', client.boundSessionId).warn(
      `Client ${client.id} (bound to ${client.boundSessionId}) attempted ${op} — rejected (bound tokens cannot mutate files/git)`,
    )
    sendError(
      ws,
      msg?.requestId,
      'FILE_MUTATION_FORBIDDEN_BOUND_CLIENT',
      'Pairing-issued session tokens cannot modify files or git state — this requires a host-level (unbound) client, such as the primary token or the app\'s own device.',
      undefined,
      ctx,
    )
    return true
  }
  return false
}

function handleListDirectory(ws, client, msg, ctx) {
  ctx.services.fileOps.listDirectory(ws, msg.path)
}

function handleBrowseFiles(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.services.fileOps.browseFiles(ws, msg.path, entry?.cwd || null)
}

function handleListFiles(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  // #6823: BYOK sessions surface their connected MCP servers' resources in the
  // same `@`-picker data source. Other providers return no resources here.
  const mcpResources = typeof entry?.session?.getMcpResources === 'function'
    ? entry.session.getMcpResources()
    : []
  ctx.services.fileOps.listFiles(ws, entry?.cwd || null, msg.query || null, sid, mcpResources)
}

function handleReadFile(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  // #6502 — forward the optional request nonce so the file_content reply echoes
  // it, letting the dashboard drop superseded replies without path-matching.
  ctx.services.fileOps.readFile(ws, msg.path, entry?.cwd || null, msg.requestId)
}

function handleWriteFile(ws, client, msg, ctx) {
  if (rejectMutationIfBound(ws, client, msg, ctx, 'write_file')) return
  const entry = resolveSession(ctx, msg, client)
  ctx.services.fileOps.writeFile(ws, msg.path, msg.content, entry?.cwd || null)
}

function handleAppendMemory(ws, client, msg, ctx) {
  // #6861 — `#`-prefix composer quick-append. Same mutation gate as write_file:
  // a bound (share-a-session) token cannot append to the host's CLAUDE.md.
  if (rejectMutationIfBound(ws, client, msg, ctx, 'append_memory')) return
  const entry = resolveSession(ctx, msg, client)
  ctx.services.fileOps.appendMemory(ws, msg.text, entry?.cwd || null)
}

function handleGetDiff(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.services.fileOps.getDiff(ws, msg.base, entry?.cwd || null)
}

function handleGitStatus(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.services.fileOps.gitStatus(ws, entry?.cwd || null)
}

function handleGitBranches(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.services.fileOps.gitBranches(ws, entry?.cwd || null)
}

function handleGitStage(ws, client, msg, ctx) {
  if (rejectMutationIfBound(ws, client, msg, ctx, 'git_stage')) return
  const entry = resolveSession(ctx, msg, client)
  ctx.services.fileOps.gitStage(ws, msg.files, entry?.cwd || null)
}

function handleGitUnstage(ws, client, msg, ctx) {
  if (rejectMutationIfBound(ws, client, msg, ctx, 'git_unstage')) return
  const entry = resolveSession(ctx, msg, client)
  ctx.services.fileOps.gitUnstage(ws, msg.files, entry?.cwd || null)
}

function handleGitCommit(ws, client, msg, ctx) {
  if (rejectMutationIfBound(ws, client, msg, ctx, 'git_commit')) return
  const entry = resolveSession(ctx, msg, client)
  ctx.services.fileOps.gitCommit(ws, msg.message, entry?.cwd || null)
}

function handleGitCreatePr(ws, client, msg, ctx) {
  // #6876 — same pairing-bound mutation gate as stage/commit: opening a PR
  // pushes a branch + creates a remote PR, a host-level side effect a bound
  // (share-a-session) token must not reach.
  if (rejectMutationIfBound(ws, client, msg, ctx, 'git_create_pr')) return
  const entry = resolveSession(ctx, msg, client)
  ctx.services.fileOps.gitCreatePR(
    ws,
    { title: msg.title, body: msg.body, base: msg.base, draft: msg.draft },
    entry?.cwd || null,
  )
}

function handleListSlashCommands(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  // #3856: pass the session's provider so listSlashCommands can merge in
  // provider-specific built-ins (`/clear`, `/compact`, `/model`, etc.).
  // Falls back to null in legacy single-cliSession mode — built-ins simply
  // don't surface there (safe default; project/user .md skills still work).
  const provider = entry?.provider || null
  // #6823: merge the session's MCP-server prompts (`/mcp__<server>__<prompt>`)
  // into the slash-command surface. Only BYOK sessions expose the accessor;
  // other providers fall back to an empty list.
  const mcpPrompts = typeof entry?.session?.getMcpPromptCommands === 'function'
    ? entry.session.getMcpPromptCommands()
    : []
  ctx.services.fileOps.listSlashCommands(ws, entry?.cwd || null, sid, provider, mcpPrompts)
}

function handleListAgents(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  const opts = ctx.runtime.userAgentsDirs ? { userAgentsDirs: ctx.runtime.userAgentsDirs } : {}
  ctx.services.fileOps.listAgents(ws, entry?.cwd || null, sid, opts)
}

export const fileHandlers = {
  list_directory: handleListDirectory,
  browse_files: handleBrowseFiles,
  list_files: handleListFiles,
  read_file: handleReadFile,
  write_file: handleWriteFile,
  append_memory: handleAppendMemory,
  get_diff: handleGetDiff,
  git_status: handleGitStatus,
  git_branches: handleGitBranches,
  git_stage: handleGitStage,
  git_unstage: handleGitUnstage,
  git_commit: handleGitCommit,
  git_create_pr: handleGitCreatePr,
  list_slash_commands: handleListSlashCommands,
  list_agents: handleListAgents,
}
