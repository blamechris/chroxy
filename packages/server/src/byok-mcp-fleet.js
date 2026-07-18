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

// #6824: map an MCPClient's internal lifecycle state to the wire `status`
// string the `mcp_servers` broadcast carries. Kept aligned with the sdk/cli
// convention (dashboard/mobile only treat `connected` as the live/green dot;
// everything else renders muted). A parked (disabled) server has NO client, so
// this is only ever called for enabled ones — the disabled status is applied
// by `getServerStatuses()` directly.
export function mcpStateToStatus(state) {
  switch (state) {
    case MCP_STATES.READY:
      return 'connected'
    case MCP_STATES.DEAD:
      return 'failed'
    default:
      // IDLE / STARTING / RESTARTING — spawned but not yet handshaken.
      return 'connecting'
  }
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
    // #6824: retain the raw config list + the wiring inputs so a re-enable can
    // rebuild a client from scratch (a destroyed MCPClient can't be revived —
    // start() throws once `_destroyed`). `getServerStatuses()` also iterates
    // `_configs` so it can report parked servers the live `_clients` array no
    // longer holds.
    this._configs = configs
    this._opts = opts
    this._permissionManager = permissionManager
    this._resolvedTrustPath = resolvedTrustPath
    // #6824: per-session parked (disabled) server names. Seeded from the
    // caller's persisted set (byok-session forwards the restored
    // `disabledMcpServers`), filtered to names that are actually configured so
    // a stale entry for a removed server can't wedge. Parked servers get NO
    // client on construction — they contribute zero tools and report status
    // 'disabled' until re-enabled.
    const configuredNames = new Set(configs.map((c) => c.name))
    this._disabled = new Set(
      (Array.isArray(opts.disabledServers) ? opts.disabledServers : [])
        .filter((name) => configuredNames.has(name)),
    )
    // #6824: per-server in-flight toggle latch — names whose park/unpark is
    // currently awaiting (destroy grace / restart handshake). A second toggle
    // for the same server arriving mid-flight is churn and is ignored (see
    // setEnabled) rather than interleaving destroy/start on one client.
    this._toggling = new Set()
    this._clients = configs
      .filter((cfg) => !this._disabled.has(cfg.name))
      .map((cfg) => this._makeClient(cfg))
  }

  /**
   * #6824: build one MCPClient for a config, wiring the trust gate exactly as
   * the constructor did inline pre-#6824. Extracted so the re-enable path
   * (`setEnabled(name, true)`) rebuilds a client with an IDENTICAL gate — an
   * already-trusted (name, command, args[0]) tuple reconnects silently; an
   * untrusted one still prompts, so re-enabling can never bypass trust.
   */
  _makeClient(cfg) {
    const clientOpts = { ...this._opts }
    if (this._permissionManager) {
      clientOpts.trustGate = async () => {
        // #4460: serialise the load→prompt→recordTrust sequence across
        // all fleet clients that share this trust-store path. Without
        // the lock, two concurrent gates can both observe an empty
        // store, both prompt, both call recordTrust — and the last
        // writer's snapshot (read at step 1, missing the other's
        // entry) clobbers the first allow. The lock also surfaces
        // prompts one at a time, which the dashboard / mobile UI
        // already assumes (one modal at a time).
        return withTrustStoreLock(this._resolvedTrustPath, async () => {
          const store = loadTrustStore(this._resolvedTrustPath, { log: this._opts.log })
          if (isTrusted(store, cfg)) return true
          // #6821: a remote server has no command/args — prompt on
          // (name, url) + header KEY names. Header VALUES (tokens) never
          // reach the permission payload, the trust store, or any log.
          const isRemote = typeof cfg.url === 'string' && cfg.url.length > 0
          const trustReq = isRemote
            ? { name: cfg.name, url: cfg.url, headerKeys: Object.keys(cfg.headers || {}).sort() }
            : { name: cfg.name, command: cfg.command, args: cfg.args, envKeys: Object.keys(cfg.env || {}).sort() }
          const allowed = await this._permissionManager.requestMcpTrust(trustReq)
          if (allowed) recordTrust(cfg, this._resolvedTrustPath)
          return allowed
        })
      }
    }
    return createMcpClient(cfg, clientOpts)
  }

  get clients() { return this._clients }

  /**
   * #6824: read-only view of the parked (disabled) server names. Byok-session
   * reads this to persist the set into session state so a respawn honours it.
   */
  get disabledServers() { return [...this._disabled].sort() }

  /**
   * #6824: status snapshot for EVERY configured server — the payload the
   * `mcp_servers` broadcast carries. Parked servers report status 'disabled'
   * with `enabled: false`; live ones map their MCPClient state. `canToggle`
   * is true for all (the whole BYOK fleet is toggleable) so the client can
   * gate its per-row switch on a single field.
   */
  getServerStatuses() {
    return this._configs.map((cfg) => {
      if (this._disabled.has(cfg.name)) {
        return { name: cfg.name, status: 'disabled', enabled: false, canToggle: true }
      }
      const client = this._clients.find((c) => c.name === cfg.name)
      // #6822: a remote server awaiting OAuth reports `oauth-required` + the
      // browser authorization URL (never a token/secret), so the client can
      // render an "Authorize" affordance instead of a bare failure.
      if (client && client.needsAuthorization) {
        const entry = { name: cfg.name, status: 'oauth-required', enabled: true, canToggle: true }
        if (client.authorizationUrl) entry.authUrl = client.authorizationUrl
        return entry
      }
      const status = client ? mcpStateToStatus(client.state) : 'connecting'
      return { name: cfg.name, status, enabled: true, canToggle: true }
    })
  }

  /**
   * #6822: submit a pasted OAuth authorization code for a configured remote MCP
   * server, redeeming it at the daemon and reconnecting authenticated. Returns
   * `{ found, ok?, status?, error? }` — `found: false` when `name` is not a
   * configured server; `ok: false` with a value-free `error` on a redemption
   * failure. On success the fleet re-emits nothing itself (byok-session re-emits
   * `mcp_servers` after the call so all clients converge).
   */
  async submitAuthCode(name, code) {
    const client = this._clients.find((c) => c.name === name)
    if (!client) return { found: false }
    if (typeof client.completeAuthorization !== 'function') {
      return { found: true, ok: false, error: 'This MCP server does not use OAuth authorization.' }
    }
    try {
      await client.completeAuthorization(code)
      const status = client.needsAuthorization ? 'oauth-required' : mcpStateToStatus(client.state)
      return { found: true, ok: true, status }
    } catch (err) {
      return { found: true, ok: false, error: err?.message || String(err) }
    }
  }

  /**
   * #6824: park or unpark a single configured server without tearing down the
   * rest of the fleet.
   *
   *   - disable: destroy the server's MCPClient (SIGTERM→SIGKILL grace) and
   *     add it to `_disabled`. Its tools/prompts/resources drop from the next
   *     turn's aggregates immediately; it never respawns while parked.
   *   - enable: remove it from `_disabled`, rebuild a fresh client through the
   *     SAME trust gate, and start it (bounded by the client's own
   *     restart budget). Already-trusted servers reconnect with no prompt.
   *
   * Idempotent: toggling to the current state is a no-op (`changed: false`).
   * Returns `{ found, changed, status }` — `found: false` when `name` is not a
   * configured server (caller surfaces a clean error rather than silently
   * creating a phantom entry).
   */
  async setEnabled(name, enabled) {
    const cfg = this._configs.find((c) => c.name === name)
    if (!cfg) return { found: false, changed: false, status: null }

    // #6824 review follow-up: churn guard. If a park/unpark for THIS server is
    // already awaiting, ignore the new toggle (changed: false) — interleaving a
    // start into an in-flight destroy (or vice versa) on one client is the only
    // way this API can corrupt fleet state. The in-flight op's completion
    // re-emit is the authoritative state the client converges to.
    if (this._toggling.has(name)) {
      const client = this._clients.find((c) => c.name === name)
      const status = this._disabled.has(name)
        ? 'disabled'
        : (client ? mcpStateToStatus(client.state) : 'connecting')
      return { found: true, changed: false, status }
    }

    const currentlyDisabled = this._disabled.has(name)
    // Target state already holds → no-op.
    if (enabled && !currentlyDisabled) {
      const client = this._clients.find((c) => c.name === name)
      return { found: true, changed: false, status: client ? mcpStateToStatus(client.state) : 'connecting' }
    }
    if (!enabled && currentlyDisabled) {
      return { found: true, changed: false, status: 'disabled' }
    }

    this._toggling.add(name)
    try {
      if (!enabled) {
        // Disable: destroy the live client, mark parked.
        this._disabled.add(name)
        const idx = this._clients.findIndex((c) => c.name === name)
        if (idx !== -1) {
          const [client] = this._clients.splice(idx, 1)
          try {
            await client.destroy()
          } catch (err) {
            ;(this._opts.log || console).warn?.(`MCP fleet: destroy of ${name} on disable threw: ${err?.message || err}`)
          }
        }
        return { found: true, changed: true, status: 'disabled' }
      }

      // Enable: unpark + rebuild + start through the same trust gate.
      this._disabled.delete(name)
      const client = this._makeClient(cfg)
      this._clients.push(client)
      try {
        await client.start()
      } catch (err) {
        // A failed start leaves the client in DEAD (contributes zero tools) —
        // mirror fleet.start()'s non-fatal handling. Keep it in `_clients` so its
        // 'failed' status still surfaces on the next snapshot.
        ;(this._opts.log || console).warn?.(`MCP fleet: start of ${name} on enable threw: ${err?.message || err}`)
      }
      return { found: true, changed: true, status: mcpStateToStatus(client.state) }
    } finally {
      this._toggling.delete(name)
    }
  }

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
