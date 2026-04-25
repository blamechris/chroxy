/**
 * File operations and git command handlers.
 *
 * Handles: list_directory, browse_files, list_files, read_file, write_file,
 *          get_diff, git_status, git_branches, git_stage, git_unstage,
 *          git_commit, list_slash_commands, list_agents
 */
import { resolveSession } from '../handler-utils.js'

function handleListDirectory(ws, client, msg, ctx) {
  ctx.fileOps.listDirectory(ws, msg.path)
}

function handleBrowseFiles(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.fileOps.browseFiles(ws, msg.path, entry?.cwd || null)
}

function handleListFiles(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  ctx.fileOps.listFiles(ws, entry?.cwd || null, msg.query || null, sid)
}

function handleReadFile(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.fileOps.readFile(ws, msg.path, entry?.cwd || null)
}

function handleWriteFile(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.fileOps.writeFile(ws, msg.path, msg.content, entry?.cwd || null)
}

function handleGetDiff(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.fileOps.getDiff(ws, msg.base, entry?.cwd || null)
}

function handleGitStatus(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.fileOps.gitStatus(ws, entry?.cwd || null)
}

function handleGitBranches(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.fileOps.gitBranches(ws, entry?.cwd || null)
}

function handleGitStage(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.fileOps.gitStage(ws, msg.files, entry?.cwd || null)
}

function handleGitUnstage(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.fileOps.gitUnstage(ws, msg.files, entry?.cwd || null)
}

function handleGitCommit(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  ctx.fileOps.gitCommit(ws, msg.message, entry?.cwd || null)
}

function handleListSlashCommands(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  ctx.fileOps.listSlashCommands(ws, entry?.cwd || null, sid)
}

function handleListAgents(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  const opts = ctx.userAgentsDirs ? { userAgentsDirs: ctx.userAgentsDirs } : {}
  ctx.fileOps.listAgents(ws, entry?.cwd || null, sid, opts)
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
