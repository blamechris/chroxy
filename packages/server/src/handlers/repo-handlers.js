/**
 * Repository management handlers.
 *
 * Handles: list_repos, add_repo, remove_repo
 */
import { statSync, realpathSync } from 'fs'
import { basename } from 'path'
import { scanConversations as defaultScanConversations, groupConversationsByRepo } from '../conversation-scanner.js'
import { readReposFromConfig as defaultReadRepos, writeReposToConfig as defaultWriteRepos } from '../config.js'
import { validateCwdAllowed } from '../handler-utils.js'

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
  const scanOpts = ctx.projectsDirs ? { projectsDirs: ctx.projectsDirs } : {}
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
    ctx.send(ws, { type: 'repo_list', repos })
  } catch (err) {
    ctx.send(ws, { type: 'server_error', message: `Failed to list repos: ${err.message}`, recoverable: true })
  }
}

async function handleAddRepo(ws, client, msg, ctx) {
  const repoPath = msg.path
  const cwdError = validateCwdAllowed(repoPath, ctx.config)
  if (cwdError) {
    ctx.send(ws, { type: 'session_error', message: cwdError })
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
    ctx.send(ws, { type: 'repo_list', repos })
  } catch (err) {
    ctx.send(ws, { type: 'session_error', message: `Failed to add repo: ${err.message}` })
  }
}

async function handleRemoveRepo(ws, client, msg, ctx) {
  let targetPath = msg.path
  try { targetPath = realpathSync(msg.path) } catch { /* fall back to raw path */ }
  const readRepos = ctx.readReposFromConfig || defaultReadRepos
  const writeRepos = ctx.writeReposToConfig || defaultWriteRepos
  const existing = readRepos()
  const filtered = existing.filter(r => r.path !== targetPath)
  writeRepos(filtered)

  try {
    const repos = await buildRepoList(ctx)
    ctx.send(ws, { type: 'repo_list', repos })
  } catch (err) {
    ctx.send(ws, { type: 'server_error', message: `Failed to list repos: ${err.message}`, recoverable: true })
  }
}

export const repoHandlers = {
  list_repos: handleListRepos,
  add_repo: handleAddRepo,
  remove_repo: handleRemoveRepo,
}
