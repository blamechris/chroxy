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

import { createMcpClient, MCP_STATES, DEFAULT_TOOL_CALL_TIMEOUT_MS } from './byok-mcp-client.js'
import {
  loadTrustStore,
  recordTrust,
  isTrusted,
  withTrustStoreLock,
  defaultTrustStorePath,
} from './byok-mcp-trust.js'
import { MCP_PREFIX, parseMcpToolName } from './mcp-tools.js'

export const FLEET_KILL_GRACE_MS = 2000

// #4456: wall-clock cap on fleet.start() to bound the worst-case session-
// start latency on a misconfigured MCP server. The fleet awaits each
// client's first stable state (READY or DEAD); with the post-#4453 1/2/4s
// restart backoff a single broken server adds up to ~7s to session-start.
// At the cap, clients still in STARTING/RESTARTING contribute zero tools
// to the first turn but remain alive and will surface on subsequent turns
// (the fleet re-queries .tools per turn, so a late-arriving client lands
// naturally). 1500 ms is enough for a fast happy path (the common case
// completes in ~50–200 ms) without making the user feel the bad-config
// tax. Operators can override via the `startCapMs` constructor opt.
export const DEFAULT_FLEET_START_CAP_MS = 1500

// #4451: re-export under the legacy name from this module so existing
// callers (byok-session, tests) keep working. Canonical source is
// mcp-tools.js to prevent silent parser drift.
export const MCP_TOOL_PREFIX = MCP_PREFIX
export { parseMcpToolName }

function mcpToolName(serverName, toolName) {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`
}

// #6823: prompts share the tools' `mcp__<server>__<name>` namespace so the
// slash-command surface (`/mcp__server__prompt`) and the tool router use one
// parser (parseMcpToolName). Same shape, distinct call — keep a named alias so
// the intent reads clearly at the call site.
const mcpPromptName = mcpToolName

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
    // #4460: resolve the path eagerly so the per-path async mutex below
    // can key on a stable value (withTrustStoreLock uses the path as the
    // map key). Without this, undefined paths would all share a single
    // chain — fine for the real default case but bug-magnet if any test
    // ever called the constructor without setting trustStorePath.
    const resolvedTrustPath = trustStorePath || defaultTrustStorePath()
    // #4456: per-fleet wall-clock cap on start(). Same defensive guard
    // pattern as resultTimeoutMs in byok-session: non-finite / non-positive
    // values fall back to the module default. Setting opts.startCapMs to
    // Infinity (legacy behavior — wait for full convergence) requires
    // explicitly opting in below.
    this._startCapMs =
      Number.isFinite(opts.startCapMs) && opts.startCapMs > 0
        ? opts.startCapMs
        : DEFAULT_FLEET_START_CAP_MS
    this._clients = configs.map((cfg) => {
      const clientOpts = { ...opts }
      if (permissionManager) {
        clientOpts.trustGate = async () => {
          // #4460: serialise the load→prompt→recordTrust sequence across
          // all fleet clients that share this trust-store path. Without
          // the lock, two concurrent gates can both observe an empty
          // store, both prompt, both call recordTrust — and the last
          // writer's snapshot (read at step 1, missing the other's
          // entry) clobbers the first allow. The lock also surfaces
          // prompts one at a time, which the dashboard / mobile UI
          // already assumes (one modal at a time).
          return withTrustStoreLock(resolvedTrustPath, async () => {
            const store = loadTrustStore(resolvedTrustPath, { log: opts.log })
            if (isTrusted(store, cfg)) return true
            // #6821: a remote server has no command/args — prompt on
            // (name, url) + header KEY names. Header VALUES (tokens) never
            // reach the permission payload, the trust store, or any log.
            const isRemote = typeof cfg.url === 'string' && cfg.url.length > 0
            const trustReq = isRemote
              ? { name: cfg.name, url: cfg.url, headerKeys: Object.keys(cfg.headers || {}).sort() }
              : { name: cfg.name, command: cfg.command, args: cfg.args, envKeys: Object.keys(cfg.env || {}).sort() }
            const allowed = await permissionManager.requestMcpTrust(trustReq)
            if (allowed) recordTrust(cfg, resolvedTrustPath)
            return allowed
          })
        }
      }
      return createMcpClient(cfg, clientOpts)
    })
  }

  get clients() { return this._clients }

  /**
   * Spawn every client and resolve when either (a) every client has reached
   * a stable state (READY or DEAD), or (b) the wall-clock cap fires —
   * whichever is first (#4456).
   *
   * Trade-off: a session with one broken MCP server (e.g. command-not-found
   * from a deleted binary) used to wait the FULL ~7s restart budget on
   * session start. With the cap, the user gets a ready session in ≤
   * `startCapMs` ms even on broken configs; clients still in STARTING /
   * RESTARTING at the cap contribute zero tools to the first turn but get
   * picked up automatically on the next turn (byok-session re-queries
   * `fleet.tools` per turn). A transiently-flaky server that would have
   * recovered on attempt 2 also loses its first-turn contribution under
   * the cap — that's the cost of bounding the worst case.
   *
   * The per-client `start()` promises are *not* dropped at the cap — they
   * continue running in the background and update `client.state` as they
   * settle. We just stop *awaiting* them so the caller can move on.
   */
  async start() {
    const startPromises = this._clients.map((c) => c.start().catch(() => {}))
    if (!Number.isFinite(this._startCapMs) || this._startCapMs <= 0) {
      // Defensive — should be unreachable given the constructor guard, but
      // an explicit Infinity opt-in would land here and we just wait.
      await Promise.all(startPromises)
      return
    }
    let capTimer = null
    const capPromise = new Promise((resolve) => {
      capTimer = setTimeout(resolve, this._startCapMs)
      // Don't keep the event loop alive solely for this timer — if every
      // client settles before the cap, the timer's still pending and would
      // otherwise hold the process open.
      if (typeof capTimer.unref === 'function') capTimer.unref()
    })
    try {
      await Promise.race([Promise.all(startPromises), capPromise])
    } finally {
      if (capTimer) clearTimeout(capTimer)
    }
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
   * #6823: aggregate MCP prompts across READY servers, namespaced
   * `mcp__<server>__<prompt>` so they slot into the slash-command surface next
   * to built-ins. Dead servers contribute zero (state gate), matching `tools`.
   * Each entry keeps the server's `description` + `arguments` (for prompts/get
   * argument mapping) plus the internal `_mcpServer` / `_mcpOriginalName`
   * routing markers.
   */
  get prompts() {
    const out = []
    for (const client of this._clients) {
      if (client.state !== MCP_STATES.READY) continue
      for (const prompt of client.prompts) {
        out.push({
          ...prompt,
          name: mcpPromptName(client.name, prompt.name),
          _mcpServer: client.name,
          _mcpOriginalName: prompt.name,
        })
      }
    }
    return out
  }

  /**
   * #6823: aggregate MCP resources across READY servers. Resources are
   * identified by `uri` (not name), so routing a read back to the owning server
   * needs the `_mcpServer` marker rather than a namespaced name. Kept flat +
   * read-only for the dashboard `@`-picker.
   */
  get resources() {
    const out = []
    for (const client of this._clients) {
      if (client.state !== MCP_STATES.READY) continue
      for (const resource of client.resources) {
        out.push({
          ...resource,
          _mcpServer: client.name,
        })
      }
    }
    return out
  }

  /**
   * #6823: fetch one prompt's messages by its namespaced `mcp__<server>__<name>`
   * name. Parses + routes exactly like callTool. Throws on a malformed name, an
   * unknown server, or a non-READY client; JSON-RPC errors (e.g. a missing
   * required argument) propagate from the client.
   */
  async getPrompt(prefixedName, args, timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS) {
    const parsed = parseMcpToolName(prefixedName)
    if (!parsed) throw new Error(`malformed MCP prompt name: ${prefixedName}`)
    const client = this._clients.find((c) => c.name === parsed.serverName)
    if (!client) throw new Error(`MCP server not found: ${parsed.serverName}`)
    if (client.state !== MCP_STATES.READY) {
      throw new Error(`MCP server ${parsed.serverName} not ready (state=${client.state})`)
    }
    // parseMcpToolName names the second segment `toolName`; here it's the prompt.
    return client.getPrompt(parsed.toolName, args, timeoutMs)
  }

  /**
   * #6823: read one resource's contents. Routed by (server, uri) — the server
   * comes from the aggregated resource entry's `_mcpServer` marker, the uri is
   * the server's own identifier.
   */
  async readResource(serverName, uri, timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS) {
    const client = this._clients.find((c) => c.name === serverName)
    if (!client) throw new Error(`MCP server not found: ${serverName}`)
    if (client.state !== MCP_STATES.READY) {
      throw new Error(`MCP server ${serverName} not ready (state=${client.state})`)
    }
    return client.readResource(uri, timeoutMs)
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
