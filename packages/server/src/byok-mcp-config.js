/**
 * MCP config discovery for the claude-byok provider.
 *
 * Foundation only for #4048/#4076: parse Claude-style mcpServers blocks and
 * expose safe read-only metadata. This module deliberately does not spawn MCP
 * children or wire tools.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Defensive upper bound on the size of `~/.claude.json`. Today the file is
 * small (a few KB), but it is owned by Claude Code, not by us — a future
 * schema change that starts persisting conversation history into it could
 * grow it substantially. Reading hundreds of MB synchronously at session-start
 * would block the server, so we bail with a single warning above this cap.
 */
export const CLAUDE_CONFIG_MAX_BYTES = 10 * 1024 * 1024

export function defaultClaudeConfigPath() {
  return process.env.CHROXY_CLAUDE_CONFIG || join(homedir(), '.claude.json')
}

/**
 * Coerce an args array to strings only. Pushes one warning per dropped entry
 * naming the server, the offending index (`args[<i>]`), and the value's type
 * so a user who typoed a number-as-number gets a signal instead of a silent
 * strip. Non-arrays drop the whole field with a single warning.
 */
function coerceStringArray(value, { warnings, serverName }) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    warnings.push(
      `MCP server ${serverName}: ignoring args (expected array, got ${typeof value})`,
    )
    return []
  }
  const out = []
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (typeof item === 'string') {
      out.push(item)
    } else {
      warnings.push(
        `MCP server ${serverName}: dropping args[${i}] (expected string, got ${typeof item})`,
      )
    }
  }
  return out
}

/**
 * Coerce an env object to string→string only. Pushes one warning per dropped
 * key naming the server, the offending field (`env.<KEY>`), and the value's
 * type. Non-objects drop the whole field with a single warning.
 */
function coerceEnv(value, { warnings, serverName }) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(
      `MCP server ${serverName}: ignoring env (expected object, got ${Array.isArray(value) ? 'array' : typeof value})`,
    )
    return {}
  }
  const env = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (typeof raw === 'string') {
      env[key] = raw
    } else {
      warnings.push(
        `MCP server ${serverName}: dropping env.${key} (expected string, got ${typeof raw})`,
      )
    }
  }
  return env
}

/**
 * Parse a Claude-style MCP config object.
 *
 * @param {unknown} raw
 * @returns {{ servers: Array<{ name: string, command: string, args: string[], env: Record<string, string> }>, warnings: string[] }}
 */
export function parseClaudeMcpConfig(raw) {
  const warnings = []
  const servers = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { servers, warnings: ['MCP config root must be an object'] }
  }
  const block = raw.mcpServers
  if (block == null) return { servers, warnings }
  if (typeof block !== 'object' || Array.isArray(block)) {
    return { servers, warnings: ['mcpServers must be an object'] }
  }

  for (const [name, entry] of Object.entries(block)) {
    if (!name) {
      warnings.push('Skipping MCP server with empty name')
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`Skipping MCP server ${name}: entry must be an object`)
      continue
    }
    if (typeof entry.command !== 'string' || entry.command.length === 0) {
      warnings.push(`Skipping MCP server ${name}: command is required`)
      continue
    }
    servers.push({
      name,
      command: entry.command,
      args: coerceStringArray(entry.args, { warnings, serverName: name }),
      env: coerceEnv(entry.env, { warnings, serverName: name }),
    })
  }
  return { servers, warnings }
}

/**
 * Read and parse a Claude-style MCP config file.
 *
 * @param {string} filePath
 * @returns {{ servers: Array<{ name: string, command: string, args: string[], env: Record<string, string> }>, warnings: string[], missing: boolean }}
 */
export function loadClaudeMcpConfig(filePath = defaultClaudeConfigPath()) {
  if (!filePath || !existsSync(filePath)) {
    return { servers: [], warnings: [], missing: true }
  }
  try {
    // statSync is cheap; do it before readFileSync so a pathologically large
    // file (see CLAUDE_CONFIG_MAX_BYTES) does not block startup.
    const stat = statSync(filePath)
    if (stat.size > CLAUDE_CONFIG_MAX_BYTES) {
      const warning = `MCP config ${filePath} exceeds size cap (${stat.size} bytes > ${CLAUDE_CONFIG_MAX_BYTES} bytes); skipping load`
      console.warn(`[byok-mcp-config] ${warning}`)
      return { servers: [], warnings: [warning], missing: false }
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    return { ...parseClaudeMcpConfig(raw), missing: false }
  } catch (err) {
    return {
      servers: [],
      warnings: [`Failed to parse MCP config ${filePath}: ${err?.message || String(err)}`],
      missing: false,
    }
  }
}

export function toMcpServerMetadata(server) {
  return Object.freeze({
    name: server.name,
    command: server.command,
    args: Object.freeze([...server.args]),
    envKeys: Object.freeze(Object.keys(server.env).sort()),
  })
}

/**
 * Collect the NAMES of every configured MCP server in an `mcpServers` block,
 * without the exec-oriented validation `parseClaudeMcpConfig` applies.
 *
 * `parseClaudeMcpConfig` is built for the byok stdio exec path — it requires a
 * `command` and drops any entry without one. For pure VISIBILITY (#6820) we
 * want every declared server by name, including remote/HTTP transports (which
 * carry `url`/`type` instead of `command`). So this is deliberately lenient:
 * any key mapping to a non-null object counts. Malformed entries accumulate a
 * warning rather than throwing.
 *
 * @param {unknown} mcpBlock — the `mcpServers` object from a config source
 * @param {{ warnings: string[], source: string }} ctx
 * @returns {string[]} declared server names (order preserved)
 */
function collectConfiguredNames(mcpBlock, { warnings, source }) {
  const names = []
  if (mcpBlock == null) return names
  if (typeof mcpBlock !== 'object' || Array.isArray(mcpBlock)) {
    warnings.push(`${source}: mcpServers must be an object`)
    return names
  }
  for (const [name, entry] of Object.entries(mcpBlock)) {
    if (!name) {
      warnings.push(`${source}: skipping MCP server with empty name`)
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`${source}: skipping MCP server ${name} (entry must be an object)`)
      continue
    }
    names.push(name)
  }
  return names
}

/**
 * Resolve the project-scoped config block Claude Code stores under
 * `projects[<realpath(cwd)>]` in `~/.claude.json`. Claude keys these by the
 * realpath, so try that first and fall back to the literal `cwd` (a cwd that no
 * longer resolves — e.g. a removed test tmp dir — still matches a literal key).
 *
 * @param {unknown} raw — parsed `~/.claude.json`
 * @param {string} cwd
 * @returns {object|null}
 */
function resolveProjectBlock(raw, cwd) {
  if (!cwd) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const projects = raw.projects
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null
  let realCwd = cwd
  try {
    realCwd = realpathSync(cwd)
  } catch {
    // cwd may not exist (tests / stale dir) — fall through to the literal key.
  }
  if (Object.prototype.hasOwnProperty.call(projects, realCwd)) return projects[realCwd]
  if (Object.prototype.hasOwnProperty.call(projects, cwd)) return projects[cwd]
  return null
}

/**
 * Discover the CONFIGURED (not live-connected) MCP servers a Claude Code
 * session running in `cwd` would load. This is the honest fallback the
 * claude-tui provider uses (#6820): the interactive TUI communicates over a
 * PTY + hook payloads and exposes NO runtime MCP status, unlike the SDK/CLI
 * stream-json `system/init` event that carries live `mcp_servers` with real
 * connection status. So the TUI path can only report what the config DECLARES.
 *
 * Merges the three sources Claude Code itself reads, deduped by name (first
 * source wins on a name collision, matching read precedence):
 *   1. user/global scope  — `mcpServers` at the root of `~/.claude.json`
 *   2. project scope      — `projects[<realpath(cwd)>].mcpServers` in `~/.claude.json`
 *   3. project-local      — `mcpServers` in `<cwd>/.mcp.json`
 *
 * Never throws: each read is guarded and failures accumulate as warnings, so a
 * corrupt config can't take down session start.
 *
 * @param {string} cwd — the session's working directory
 * @param {{ configPath?: string }} [opts]
 * @returns {{ servers: Array<{ name: string }>, warnings: string[] }}
 */
export function discoverConfiguredMcpServers(cwd, { configPath = defaultClaudeConfigPath() } = {}) {
  const warnings = []
  const byName = new Map()
  const add = (names) => {
    for (const name of names) {
      if (!byName.has(name)) byName.set(name, { name })
    }
  }

  const readJson = (filePath, source) => {
    try {
      // statSync before readFileSync so a pathologically large file (see
      // CLAUDE_CONFIG_MAX_BYTES) doesn't block session start.
      const stat = statSync(filePath)
      if (stat.size > CLAUDE_CONFIG_MAX_BYTES) {
        warnings.push(
          `MCP config ${filePath} exceeds size cap (${stat.size} bytes > ${CLAUDE_CONFIG_MAX_BYTES} bytes); skipping load`,
        )
        return null
      }
      return JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (err) {
      warnings.push(`${source}: failed to read ${filePath}: ${err?.message || String(err)}`)
      return null
    }
  }

  // 1 + 2 — ~/.claude.json global root + project-scoped block.
  if (configPath && existsSync(configPath)) {
    const raw = readJson(configPath, 'user config')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      add(collectConfiguredNames(raw.mcpServers, { warnings, source: 'user config mcpServers' }))
      const projectBlock = resolveProjectBlock(raw, cwd)
      if (projectBlock && typeof projectBlock === 'object' && !Array.isArray(projectBlock)) {
        add(collectConfiguredNames(projectBlock.mcpServers, {
          warnings,
          source: 'project config mcpServers',
        }))
      }
    }
  }

  // 3 — <cwd>/.mcp.json project-local.
  if (cwd) {
    const mcpJsonPath = join(cwd, '.mcp.json')
    if (existsSync(mcpJsonPath)) {
      const raw = readJson(mcpJsonPath, 'project .mcp.json')
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        add(collectConfiguredNames(raw.mcpServers, {
          warnings,
          source: 'project .mcp.json mcpServers',
        }))
      }
    }
  }

  return { servers: [...byName.values()], warnings }
}
