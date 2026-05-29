/**
 * MCPFleet orchestrates one MCPClient per configured MCP server (#4077).
 *
 * One fleet per BYOK session. Lazy: start() spawns all clients in parallel;
 * destroy() kills all children, waiting up to KILL_GRACE_MS for SIGTERM then
 * escalating to SIGKILL.
 *
 * Tools are surfaced flat with the chroxy mcp__<server>__<tool> namespace
 * convention (matches `mcp-tools.js` parser). Dead servers contribute zero
 * tools, so a crashed-then-restart-exhausted server cleanly disappears from
 * the next turn's tool list.
 */

import { MCPClient, MCP_STATES, DEFAULT_TOOL_CALL_TIMEOUT_MS } from './byok-mcp-client.js'
import { loadTrustStore, recordTrust, isTrusted } from './byok-mcp-trust.js'
import { MCP_PREFIX, parseMcpToolName } from './mcp-tools.js'

export const FLEET_KILL_GRACE_MS = 2000
// #4451: re-export under the legacy name from this module so existing
// callers (byok-session, tests) keep working. Canonical source is
// mcp-tools.js to prevent silent parser drift.
export const MCP_TOOL_PREFIX = MCP_PREFIX
export { parseMcpToolName }

function mcpToolName(serverName, toolName) {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`
}

export class MCPFleet {
  constructor(configs, opts = {}) {
    // #4457: build a per-client trust gate when a PermissionManager is
    // available. The gate consults the on-disk trust store first (zero
    // user friction for tuples already trusted in a prior session); on
    // a miss it asks the PermissionManager — emitting a prompt visible to
    // the dashboard / mobile permission UI — and persists allow decisions
    // to the store so the prompt only fires once per (name, command, args[0]).
    //
    // No PermissionManager → no gate → spawn behaves exactly as in #4077.
    // This keeps the lifecycle module testable in isolation; integration
    // (session passes its _permissions in) is wired in byok-session.
    const permissionManager = opts.permissionManager || null
    const trustStorePath = opts.trustStorePath  // tests override; undefined falls through to default
    this._clients = configs.map((cfg) => {
      const clientOpts = { ...opts }
      if (permissionManager) {
        clientOpts.trustGate = async () => {
          const store = loadTrustStore(trustStorePath, { log: opts.log })
          if (isTrusted(store, cfg)) return true
          const allowed = await permissionManager.requestMcpTrust({
            name: cfg.name,
            command: cfg.command,
            args: cfg.args,
            envKeys: Object.keys(cfg.env || {}).sort(),
          })
          if (allowed) recordTrust(cfg, trustStorePath)
          return allowed
        }
      }
      return new MCPClient(cfg, clientOpts)
    })
  }

  get clients() { return this._clients }

  async start() {
    await Promise.all(this._clients.map((c) => c.start().catch(() => {})))
  }

  get tools() {
    const out = []
    for (const client of this._clients) {
      if (client.state !== MCP_STATES.READY) continue
      for (const tool of client.tools) {
        out.push({
          ...tool,
          name: mcpToolName(client.name, tool.name),
          _mcpServer: client.name,
          _mcpOriginalName: tool.name,
        })
      }
    }
    return out
  }

  /**
   * Anthropic-shaped tool definitions for messages.stream({ tools }).
   *
   * MCP's tools/list returns { name, description, inputSchema } per tool.
   * Anthropic's API wants { name, description, input_schema }. The rename
   * happens here so byok-session can `[...BUILTIN_TOOLS, ...fleet.anthropicTools]`
   * without knowing the MCP shape.
   *
   * Internal markers (_mcpServer, _mcpOriginalName) are stripped — they're
   * useful inside chroxy for routing tool_use back to the right client (#4079)
   * but the SDK would reject unknown keys.
   *
   * Dead servers (post-restart-exhaustion) contribute zero tools because
   * `this.tools` already filters by READY state.
   */
  get anthropicTools() {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.inputSchema || { type: 'object' },
    }))
  }

  /**
   * Dispatch a tool_use to the right MCP server. `prefixedName` is the
   * chroxy-namespaced name the model emitted (`mcp__<server>__<tool>`).
   * Throws if the prefix is malformed, no client owns that server name,
   * or the client is not READY. JSON-RPC errors from the server
   * propagate as throws — caller turns them into is_error tool_results.
   */
  async callTool(prefixedName, args, timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS) {
    const parsed = parseMcpToolName(prefixedName)
    if (!parsed) throw new Error(`malformed MCP tool name: ${prefixedName}`)
    const client = this._clients.find((c) => c.name === parsed.serverName)
    if (!client) throw new Error(`MCP server not found: ${parsed.serverName}`)
    if (client.state !== MCP_STATES.READY) {
      throw new Error(`MCP server ${parsed.serverName} not ready (state=${client.state})`)
    }
    return client.callTool(parsed.toolName, args, timeoutMs)
  }

  async destroy() {
    await Promise.race([
      Promise.all(this._clients.map((c) => c.destroy())),
      new Promise((resolve) => setTimeout(resolve, FLEET_KILL_GRACE_MS + 500)),
    ])
  }
}
