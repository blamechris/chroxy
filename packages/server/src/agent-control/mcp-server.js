#!/usr/bin/env node
/**
 * chroxy-agent-control — stdio MCP server exposing an ORDINARY chroxy session
 * to an external agent harness (Codex, Claude, Gemini, …) as a small set of
 * tools, over the daemon's existing authenticated WebSocket protocol.
 *
 * This is NOT a new control plane: it is a thin MCP adapter over
 * `agent-control/client.js`, which itself is a thin client over the protocol
 * `ws-server.js` already serves. See docs/guides/agent-control.md for the
 * connection to #7823 (durable task/handoff identity), #7437 (universal
 * mailbox) and epic #6691 (in-daemon orchestration) — none of which this file
 * duplicates or supersedes.
 *
 * Usage: `chroxy agent-control --stdio` (see cli/agent-control-cmd.js), which
 * runs this module. Do NOT run it directly for interactive use — like
 * chroxy-channel-server.js, it has no stdio peer unless something (the CLI
 * command, or an MCP host such as Claude Desktop / Codex's own MCP client
 * config) spawns it over stdio. This running session cannot hot-load this
 * MCP server into itself — it must be configured in the HOST's own MCP
 * config and started by that host (see docs/guides/agent-control.md).
 *
 * IMPORTANT: this process's stdout MUST carry ONLY MCP JSON-RPC frames — the
 * SDK's StdioServerTransport owns stdout. Every diagnostic goes to stderr via
 * the client's `log` option (defaults to stderr) or `logToStderr` below.
 * Nothing in this file or in client.js ever calls console.log / process.stdout.write.
 */
import { z } from 'zod'
import { parseArgs } from 'node:util'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { isEntryPoint } from '../utils/is-entry-point.js'
import { getErrorMessage } from '../utils/error-message.js'
import { AgentControlClient, redactPublicText, CLIENT_MESSAGE_ID_PATTERN, RESERVED_CLIENT_MESSAGE_IDS } from './client.js'
import { resolveConnectionTarget } from './local-connection.js'

export const SERVER_NAME = 'chroxy-agent-control'
export const SERVER_VERSION = '0.1.0'

// Mutation tools — absent from ListTools AND hard-refused at CallTool time
// when readOnly, so "read-only" is enforced by the dispatch gate, not merely
// by which tools got advertised (an MCP host could in principle call an
// un-advertised tool name).
const MUTATION_TOOL_NAMES = new Set(['chroxy_create_session', 'chroxy_send_input', 'chroxy_interrupt_session', 'chroxy_respond_permission'])

function logToStderr(...args) {
  console.error(`[${SERVER_NAME}]`, ...args)
}

function textResult(value) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(value && typeof value === 'object' ? { structuredContent: value } : {}),
  }
}

function errorResult(message, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }],
    structuredContent: { error: message, ...extra },
    isError: true,
  }
}

// Shared across tool schemas.
const SessionId = z.string().min(1).max(256)
const ClientMessageId = z.string()
  .regex(CLIENT_MESSAGE_ID_PATTERN)
  .refine((v) => !RESERVED_CLIENT_MESSAGE_IDS.has(v.toLowerCase()), { message: 'reserved clientMessageId value' })
// Matches ALLOWED_PERMISSION_MODE_IDS minus 'auto' (see handler-utils.js
// MODE_IDS) — 'auto' is rejected by client.js regardless; enumerating the
// permitted set here gives the MCP host real validation instead of a
// description-only claim.
const PermissionMode = z.enum(['approve', 'acceptEdits', 'plan'])

// Each tool's JSON Schema (advertised in `tools/list`) is DERIVED from its
// zod `argsSchema` via `z.toJSONSchema` — one definition, not two hand-kept
// in sync. `.describe()` on the object and each field supplies what would
// otherwise have lived in a duplicated JSON Schema `description`.
const TOOLS = {
  chroxy_daemon_info: {
    description: 'Safe daemon metadata: server/protocol version, encryption mode, and a bounded capabilities map for the connected chroxy daemon. Does not disclose the auth token, connection.json, or any session content.',
    argsSchema: z.object({}).strict(),
    async handler(client) {
      return textResult(client.daemonInfo)
    },
  },

  chroxy_list_sessions: {
    description: "List the daemon's ordinary chroxy sessions. Each row carries `modelStatus: { requested, observed, unknown, mismatch }` — `observed` is what the daemon actually reports (null means the daemon has not resolved/exposed a model, reported as `unknown: true`, never guessed); `requested` is populated only for sessions this same MCP process created.",
    argsSchema: z.object({}).strict(),
    async handler(client) {
      const result = await client.listSessions()
      return textResult(result)
    },
  },

  chroxy_create_session: {
    description: "Create a new ordinary chroxy session. Refuses provider 'user-shell' and any skipPermissions option (out of scope for agent-control — see docs/guides/agent-control.md); always sends skipPermissions:false explicitly regardless of the daemon's own default. The result's `modelStatus` MUST be checked before treating the session as running the requested model — a daemon can silently fall back to a different model (observed in production: an explicit 'claude-sonnet-5' create request booting Opus instead). Do not send an implementation task under an assumed model when `modelStatus.mismatch` or `modelStatus.unknown` is true.",
    argsSchema: z.object({
      name: z.string().min(1).max(200).optional().describe('Display name for the session'),
      cwd: z.string().min(1).max(4096).optional().describe('Working directory (must be within the daemon-allowed cwd roots)'),
      provider: z.string().min(1).max(64).optional().describe("Provider id (e.g. 'claude-sdk', 'codex', 'gemini'). Never 'user-shell'."),
      model: z.string().min(1).max(200).optional().describe('Requested model id. The daemon may resolve a different one — see modelStatus in the result.'),
      permissionMode: PermissionMode.optional().describe("Permission mode. Defaults to 'approve'. Never 'auto' via this tool — that mode requires host-level confirmation this client cannot honestly supply."),
      worktree: z.boolean().optional().describe('Create the session in an isolated git worktree (requires cwd).'),
    }).strict().refine(
      (v) => v.provider === undefined || v.provider.trim() !== 'user-shell',
      { message: "provider 'user-shell' is not permitted through agent-control", path: ['provider'] },
    ),
    async handler(client, args) {
      const result = await client.createSession(args || {})
      return textResult(result)
    },
  },

  chroxy_send_input: {
    description: "Send text input to a session and return the daemon's correlated input_ack VERBATIM (status/delivery/retrySafe/dedupScope). `status: 'uncertain'` means no FINAL ack arrived in time or the connection dropped — this is NOT a failure and NOT permission to retry; it means the outcome is unknown. `status: 'blocked'` means this client refused to send because the session's resolved model doesn't verifiably match what was requested at creation (see modelStatus), or because the daemon doesn't advertise input_context_v1 support — re-check with chroxy_list_sessions or pass acknowledgeModelMismatch:true to send anyway. Never infer task completion from this call alone.",
    argsSchema: z.object({
      sessionId: SessionId.describe('Target session id (from chroxy_list_sessions / chroxy_create_session)'),
      data: z.string().min(1).max(200_000).describe('Text to send as user input to the session'),
      clientMessageId: ClientMessageId.optional().describe("Optional: supply your own id (matches /^[A-Za-z0-9_-]{1,128}$/) to make a deliberate retry land on the daemon's dedup path instead of being treated as a brand-new send."),
      acknowledgeModelMismatch: z.boolean().optional().describe('Send even though the model-mismatch/unknown gate would otherwise block this call.'),
    }).strict(),
    async handler(client, args) {
      const ack = await client.sendInput(args.sessionId, args.data, { clientMessageId: args.clientMessageId, acknowledgeModelMismatch: args.acknowledgeModelMismatch })
      return textResult(ack)
    },
  },

  chroxy_get_events: {
    description: "Bounded, cursor-based read of a session's retained event log (aggregated assistant text, tool start/result, permission requests, model/mode changes — never raw PTY output or, by default, thinking text). Pass the `cursor` from a previous call to read only new events. `gap: true` means some events between your cursor and what's returned could not be retained or the cursor named a wrong/future/reset point (see `gapReason`) — not that anything failed. An empty `events` array means no NEW retained events, never 'the agent finished'. `waitMs` (<=30000) long-polls for new events instead of returning immediately.",
    argsSchema: z.object({
      sessionId: SessionId,
      cursor: z.string().min(1).max(2048).optional().describe('Opaque cursor from a previous chroxy_get_events call. Omit to start from the oldest retained event.'),
      limit: z.number().int().min(1).max(200).optional().describe('Max events to return (default 50, max 200).'),
      waitMs: z.number().int().min(0).max(30_000).optional().describe('Long-poll up to this many ms for new events (default 0 = return immediately).'),
    }).strict(),
    async handler(client, args) {
      const result = await client.getEvents(args.sessionId, { cursor: args.cursor, limit: args.limit, waitMs: args.waitMs })
      return textResult(result)
    },
  },

  chroxy_interrupt_session: {
    description: 'Best-effort interrupt of a running session (the protocol defines no correlated ack for this). The result reports what was observed, not a synthesized "stopped".',
    argsSchema: z.object({ sessionId: SessionId }).strict(),
    async handler(client, args) {
      const result = await client.interrupt(args.sessionId)
      return textResult(result)
    },
  },

  chroxy_respond_permission: {
    description: "Answer a pending permission request (e.g. a Bash tool-use approval) with 'allow' or 'deny' — NEVER 'allowAlways', which persists a durable project rule and is out of scope here. Refuses (before any network I/O) to answer a requestId this MCP process has not itself observed as pending for the given sessionId, via chroxy_get_events' permission_request events — an unknown, already-resolved, or sibling-session requestId is rejected, never guessed at. `status: 'uncertain'` on the result means no confirmation arrived in time; do not assume the decision was or was not applied, and do not retry automatically. Some legacy (non-SDK) daemon code paths do not broadcast a confirmation at all — 'uncertain' in that case reflects a real protocol limitation, not a client bug.",
    argsSchema: z.object({
      sessionId: SessionId,
      requestId: z.string().min(1).max(256).describe("The permission request id, from a chroxy_get_events 'permission_request' event."),
      decision: z.enum(['allow', 'deny']),
    }).strict(),
    async handler(client, args) {
      const result = await client.respondPermission(args.sessionId, args.requestId, args.decision)
      return textResult(result)
    },
  },
}

// Freeze each tool's derived MCP `definition` (name/description/inputSchema)
// once, at module load — the JSON Schema is pure derivation from argsSchema
// and never changes at runtime, so deriving it per `tools/list` call would
// just be repeated work for the same answer.
for (const [name, tool] of Object.entries(TOOLS)) {
  tool.definition = {
    name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.argsSchema),
  }
}

/**
 * Lazily owns ONE connected AgentControlClient, reconnecting a fresh client
 * (AgentControlClient is single-use per connection — see client.js doc) on
 * demand if the previous one is not ready. Never auto-retries a MUTATION —
 * this only re-establishes the TRANSPORT; individual tool calls still surface
 * their own uncertain/failed outcomes rather than silently retrying.
 *
 * Concurrency-safe: `get()` may be called by several CallTool dispatches
 * before any of them resolve (an MCP host is free to pipeline requests).
 * Without coordination, each concurrent caller would see `this._client` as
 * not-ready and start its OWN `connect()`, leaving all-but-one connection
 * (and its in-memory event log / model expectations) orphaned. A single
 * shared in-flight promise means every concurrent caller awaits the SAME
 * connect attempt and gets the SAME client.
 */
class ClientManager {
  constructor(connectionOpts, clientOpts = {}) {
    this._connectionOpts = connectionOpts
    this._clientOpts = clientOpts
    this._client = null
    this._connecting = null
    // The RAW client instance currently inside `client.connect()`, tracked
    // separately from `this._client` (which is only set once `connect()`
    // SUCCEEDS) — this is what lets `close()` interrupt an in-flight connect
    // immediately instead of idling for up to `connectTimeoutMs`.
    this._connectingClient = null
    this._lastToken = null
    // Owned by the MANAGER, not any one client instance, and passed into
    // every client it creates — a model expectation recorded by
    // `createSession` must survive a reconnect within this same MCP-server
    // process (the transport dropping has nothing to do with what model a
    // session was created with).
    this._modelExpectations = new Map()
    // Set by `close()`. Once true, `get()` refuses outright and an
    // in-flight `_connect()` self-closes its result instead of storing it —
    // without this, `close()` racing an in-flight connect would return
    // having closed nothing (this._client is still null at that point), and
    // the connect would then resurrect a live client moments later; a
    // subsequent `get()` could reconnect a manager that was told to shut
    // down.
    this._closed = false
  }

  /** For redacting a resolved token out of error text at the MCP layer too. */
  get lastToken() {
    return this._lastToken
  }

  async get() {
    if (this._closed) {
      throw Object.assign(new Error('ClientManager is closed'), { code: 'MANAGER_CLOSED' })
    }
    if (this._client && this._client.state === 'ready') return this._client
    if (this._connecting) return this._connecting
    this._connecting = this._connect().finally(() => { this._connecting = null })
    return this._connecting
  }

  async _connect() {
    const target = resolveConnectionTarget(this._connectionOpts)
    if (!target.ok) {
      throw Object.assign(new Error(describeConnectionFailure(target.reason)), { code: target.reason })
    }
    this._lastToken = target.token
    const client = new AgentControlClient({
      url: target.url,
      token: target.token,
      readOnly: this._clientOpts.readOnly === true,
      identityPublicKey: this._clientOpts.identityPublicKey,
      modelExpectations: this._modelExpectations,
      log: logToStderr,
    })
    this._connectingClient = client
    try {
      await client.connect()
    } catch (err) {
      // A FAILED connect must not linger as `this._client` — the next
      // `get()` needs to try again, not return a dead/half-open client.
      try { await client.close() } catch { /* already tearing down */ }
      throw err
    } finally {
      this._connectingClient = null
    }
    if (this._closed) {
      // `close()` ran while this connect was in flight — do not resurrect a
      // client after the manager was told to shut down; close what we just
      // opened instead of storing it.
      try { await client.close() } catch { /* already tearing down */ }
      throw Object.assign(new Error('ClientManager was closed while connecting'), { code: 'MANAGER_CLOSED' })
    }
    // A SUPERSEDED client (this._client was set by a still-open call from a
    // previous, now-replaced connection attempt — shouldn't happen given the
    // single in-flight promise above, but closing defensively costs nothing
    // and prevents a leaked socket if that invariant is ever loosened).
    if (this._client && this._client !== client && this._client.state !== 'closed') {
      try { await this._client.close() } catch { /* best effort */ }
    }
    this._client = client
    return client
  }

  async close() {
    this._closed = true
    // Interrupt an in-flight connect IMMEDIATELY, rather than idling until
    // its own `connectTimeoutMs` elapses: closing the raw client's socket
    // makes `client.connect()`'s pending handshake awaits reject right away
    // (see AgentControlClient's `_onSocketClosed` / `_abortHandshakeWaiters`),
    // so the `await this._connecting` below returns promptly instead of
    // after a potentially many-second timeout.
    if (this._connectingClient) {
      try { await this._connectingClient.close() } catch { /* best effort */ }
    }
    // Wait out any in-flight connect — otherwise its client (once
    // `_connect()` finishes moments after this method returns) would never
    // get closed, and would sit there as a live, un-tracked socket. The
    // `_closed` check inside `_connect()` (above) is what makes this await
    // actually terminate the connection rather than just observe it land.
    if (this._connecting) {
      try { await this._connecting } catch { /* connect failed/self-closed on its own */ }
    }
    if (this._client) {
      try { await this._client.close() } catch { /* best effort */ }
      this._client = null
    }
  }
}

function describeConnectionFailure(reason) {
  switch (reason) {
    case 'not_running':
      return 'chroxy daemon is not running locally (no connection.json). Start it with `chroxy start`, or pass --url with CHROXY_AGENT_CONTROL_TOKEN set for a remote daemon.'
    case 'no_local_token':
      return 'chroxy daemon is running without an auth token (--no-auth) or the token could not be read locally.'
    case 'remote_requires_token':
      return '--url was given without a token. Set CHROXY_AGENT_CONTROL_TOKEN — there is no --token argv flag (a token in argv is visible in process listings).'
    case 'invalid_url':
    case 'invalid_url_scheme':
      return '--url must be a valid ws:// or wss:// URL.'
    case 'url_contains_credentials':
      return '--url must not embed credentials (ws://token@host/...) — pass the token via CHROXY_AGENT_CONTROL_TOKEN instead.'
    default:
      return `could not resolve a daemon connection (${reason})`
  }
}

/**
 * Build the MCP `Server` with every agent-control tool registered, gated by
 * `readOnly`. Connection is NOT established here — it happens lazily on the
 * first tool call via `ClientManager`, so `chroxy agent-control --stdio` can
 * be spawned by an MCP host before (or independently of) the daemon starting.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.readOnly]
 * @param {string} [opts.url] - explicit remote URL (never inferred)
 * @param {string} [opts.token] - explicit token for a remote URL
 * @param {string} [opts.identityPublicKey] - pin the daemon identity
 * @returns {{ mcp: Server, clientManager: ClientManager }}
 */
export function createAgentControlMcpServer(opts = {}) {
  const readOnly = opts.readOnly === true
  const clientManager = opts.clientManager || new ClientManager(
    { explicitUrl: opts.url, explicitToken: opts.token },
    { readOnly, identityPublicKey: opts.identityPublicKey },
  )

  const toolNames = Object.keys(TOOLS).filter((name) => readOnly ? !MUTATION_TOOL_NAMES.has(name) : true)

  const mcp = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolNames.map((name) => TOOLS[name].definition),
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const tool = TOOLS[name]
    if (!tool) return errorResult(`unknown tool: ${name}`)
    // Hard gate — independent of what ListTools advertised. "read-only mode
    // mutation tools must be absent AND unavailable by direct call."
    if (readOnly && MUTATION_TOOL_NAMES.has(name)) {
      return errorResult(`'${name}' is a mutation tool and this agent-control server is running in --read-only mode`, { code: 'READ_ONLY_MODE' })
    }
    // Runtime validation against the BOUNDED zod schema — the JSON Schema in
    // `definition.inputSchema` documents shape to the MCP host, but a
    // description is not a guard; this is the actual enforcement, run
    // before any connect/I/O.
    const parsed = tool.argsSchema.safeParse(req.params.arguments || {})
    if (!parsed.success) {
      return errorResult(`invalid arguments for '${name}': ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`, { code: 'INVALID_ARGUMENTS' })
    }
    try {
      const client = await clientManager.get()
      return await tool.handler(client, parsed.data)
    } catch (err) {
      const message = redactPublicText(getErrorMessage(err), clientManager.lastToken)
      logToStderr(`tool '${name}' failed:`, message)
      return errorResult(message, typeof err?.code === 'string' ? { code: redactPublicText(err.code, clientManager.lastToken) } : {})
    }
  })

  return { mcp, clientManager }
}

export async function main(options) {
  const parsed = options ?? (() => {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        stdio: { type: 'boolean' },
        'read-only': { type: 'boolean' },
        url: { type: 'string' },
        'pin-identity': { type: 'string' },
      },
    })
    return { readOnly: values['read-only'], url: values.url, identityPublicKey: values['pin-identity'] }
  })()
  const readOnly = parsed.readOnly === true
  const url = parsed.url
  // Deliberately NO --token argv flag — argv is visible to every other
  // process on the machine (`ps`), unlike an env var scoped to this
  // process's own environment block. A remote connection's token is read
  // ONLY from CHROXY_AGENT_CONTROL_TOKEN.
  const token = url ? process.env.CHROXY_AGENT_CONTROL_TOKEN : undefined
  const identityPublicKey = parsed.identityPublicKey ?? process.env.CHROXY_AGENT_CONTROL_PIN

  const { mcp, clientManager } = createAgentControlMcpServer({ readOnly, url, token, identityPublicKey })

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    logToStderr(`shutting down (${signal})`)
    await clientManager.close()
    process.exit(0)
  }
  // The MCP host normally tears this process down by closing stdin (the
  // transport's 'close' fires) or sending a signal — either way, the
  // underlying WS socket and any in-flight `getEvents` long-poll must be
  // closed explicitly, or the process can linger on an open timer/socket
  // after its stdio peer is gone.
  process.stdin.on('end', () => { shutdown('stdin-eof') })
  process.on('SIGTERM', () => { shutdown('SIGTERM') })
  process.on('SIGINT', () => { shutdown('SIGINT') })

  await mcp.connect(new StdioServerTransport())
  // Deliberately never logs the URL itself — even a validated ws(s):// URL
  // with no embedded credentials is still connection metadata this process
  // doesn't need to put in a log stream; "remote" vs "local" is all a reader
  // needs to know which path was taken.
  logToStderr(`ready (readOnly=${readOnly}, target=${url ? 'remote' : 'local'})`)
}

const isDirectRun = isEntryPoint(import.meta.url)
if (isDirectRun) {
  main().catch((err) => {
    logToStderr('fatal:', getErrorMessage(err))
    process.exit(1)
  })
}
