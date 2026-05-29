/**
 * MCP config discovery for the claude-byok provider.
 *
 * Foundation only for #4048/#4076: parse Claude-style mcpServers blocks and
 * expose safe read-only metadata. This module deliberately does not spawn MCP
 * children or wire tools.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
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

function coerceStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string')
}

function coerceEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const env = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (typeof raw === 'string') env[key] = raw
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
      args: coerceStringArray(entry.args),
      env: coerceEnv(entry.env),
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
