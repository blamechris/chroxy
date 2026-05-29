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

import { MCPClient, MCP_STATES } from './byok-mcp-client.js'

export const FLEET_KILL_GRACE_MS = 2000

function mcpToolName(serverName, toolName) {
  return `mcp__${serverName}__${toolName}`
}

export class MCPFleet {
  constructor(configs, opts = {}) {
    this._clients = configs.map((cfg) => new MCPClient(cfg, opts))
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

  async destroy() {
    await Promise.race([
      Promise.all(this._clients.map((c) => c.destroy())),
      new Promise((resolve) => setTimeout(resolve, FLEET_KILL_GRACE_MS + 500)),
    ])
  }
}
