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

  async destroy() {
    await Promise.race([
      Promise.all(this._clients.map((c) => c.destroy())),
      new Promise((resolve) => setTimeout(resolve, FLEET_KILL_GRACE_MS + 500)),
    ])
  }
}
