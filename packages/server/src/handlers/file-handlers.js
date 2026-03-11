/**
 * File operations and git command handlers.
 *
 * Handles: list_directory, browse_files, list_files, read_file, write_file,
 *          get_diff, git_status, git_branches, git_stage, git_unstage,
 *          git_commit, list_slash_commands, list_agents
 */

function handleListDirectory(ws, client, msg, ctx) {
  ctx.fileOps.listDirectory(ws, msg.path)
}

function handleBrowseFiles(ws, client, msg, ctx) {
  const browseSessionId = msg.sessionId || client.activeSessionId
  const browseEntry = ctx.sessionManager.getSession(browseSessionId)
  ctx.fileOps.browseFiles(ws, msg.path, browseEntry?.cwd || null)
}

function handleListFiles(ws, client, msg, ctx) {
  const listFilesSessionId = msg.sessionId || client.activeSessionId
  const listFilesEntry = ctx.sessionManager.getSession(listFilesSessionId)
  ctx.fileOps.listFiles(ws, listFilesEntry?.cwd || null, msg.query || null, listFilesSessionId)
}

function handleReadFile(ws, client, msg, ctx) {
  const readSessionId = msg.sessionId || client.activeSessionId
  const readEntry = ctx.sessionManager.getSession(readSessionId)
  ctx.fileOps.readFile(ws, msg.path, readEntry?.cwd || null)
}

function handleWriteFile(ws, client, msg, ctx) {
  const writeSessionId = msg.sessionId || client.activeSessionId
  const writeEntry = ctx.sessionManager.getSession(writeSessionId)
  ctx.fileOps.writeFile(ws, msg.path, msg.content, writeEntry?.cwd || null)
}

function handleGetDiff(ws, client, msg, ctx) {
  const diffSessionId = msg.sessionId || client.activeSessionId
  const diffEntry = ctx.sessionManager.getSession(diffSessionId)
  ctx.fileOps.getDiff(ws, msg.base, diffEntry?.cwd || null)
}

function handleGitStatus(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = ctx.sessionManager.getSession(sid)
  ctx.fileOps.gitStatus(ws, entry?.cwd || null)
}

function handleGitBranches(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = ctx.sessionManager.getSession(sid)
  ctx.fileOps.gitBranches(ws, entry?.cwd || null)
}

function handleGitStage(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = ctx.sessionManager.getSession(sid)
  ctx.fileOps.gitStage(ws, msg.files, entry?.cwd || null)
}

function handleGitUnstage(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = ctx.sessionManager.getSession(sid)
  ctx.fileOps.gitUnstage(ws, msg.files, entry?.cwd || null)
}

function handleGitCommit(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = ctx.sessionManager.getSession(sid)
  ctx.fileOps.gitCommit(ws, msg.message, entry?.cwd || null)
}

function handleListSlashCommands(ws, client, msg, ctx) {
  const cmdSessionId = msg.sessionId || client.activeSessionId
  const entry = ctx.sessionManager.getSession(cmdSessionId)
  ctx.fileOps.listSlashCommands(ws, entry?.cwd || null, cmdSessionId)
}

function handleListAgents(ws, client, msg, ctx) {
  const agentSessionId = msg.sessionId || client.activeSessionId
  const entry = ctx.sessionManager.getSession(agentSessionId)
  ctx.fileOps.listAgents(ws, entry?.cwd || null, agentSessionId)
}

export const fileHandlers = {
  list_directory: handleListDirectory,
  browse_files: handleBrowseFiles,
  list_files: handleListFiles,
  read_file: handleReadFile,
  write_file: handleWriteFile,
  get_diff: handleGetDiff,
  git_status: handleGitStatus,
  git_branches: handleGitBranches,
  git_stage: handleGitStage,
  git_unstage: handleGitUnstage,
  git_commit: handleGitCommit,
  list_slash_commands: handleListSlashCommands,
  list_agents: handleListAgents,
}
