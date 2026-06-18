#!/usr/bin/env node
/**
 * chroxy-channel — standalone `claude --channels` MCP server prototype (#3952).
 *
 * This is a STANDALONE prototype, intentionally NOT wired into chroxy's provider
 * registry, ws-server, or any session class. Its only job is to prove the live
 * `claude --channels` round-trip end-to-end before the provider scaffold (#3953)
 * and bridge (#3954) are built on top of it. See:
 *   - docs/architecture/claude-channels-provider-spike.md  (the #3951 spike)
 *   - packages/server/src/channels/README.md               (how to run it)
 *
 * Protocol contract (verified against the published Channels reference and the
 * installed CLI v2.1.163 in the spike):
 *   - Declares the `experimental: { 'claude/channel': {} }` capability — the
 *     presence of this key is what registers the channel notification listener.
 *   - Declares `tools: {}` and registers a two-way `reply(chat_id, text)` tool.
 *     For this prototype the handler just logs the reply to stderr.
 *   - Pushes inbound events with `mcp.notification({ method:
 *     'notifications/claude/channel', params: { content, meta } })`. Each `meta`
 *     key becomes an attribute on the `<channel source="…">` envelope.
 *   - Connects over `StdioServerTransport` — `claude` spawns this file as a
 *     subprocess and talks stdio, so running it directly exits immediately (it
 *     has no stdio peer). That is expected; spawn it via `claude --channels`.
 *
 * Permission relay (`claude/channel/permission`) is deliberately OUT OF SCOPE
 * here — that is sub 4 (#3955), where it can be gated behind a trusted sender.
 *
 * Security: the HTTP control surface binds to 127.0.0.1 only. It is a debug /
 * prototype affordance — anything that can POST to it injects text into the
 * live Claude session (a prompt-injection surface, see spike R8). The real
 * bridge (#3954) replaces this with a Unix socket driven solely by the session.
 */
import { createServer } from 'http'
import { pathToFileURL } from 'url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export const SERVER_NAME = 'chroxy-channel'
export const SERVER_VERSION = '0.0.1'
export const DEFAULT_PORT = 8788

// The channel notification method, verbatim from the protocol contract. Each
// `meta` key becomes an attribute on the <channel source="…"> envelope.
export const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel'

// Injected into Claude's system prompt. Tells Claude the envelope shape and how
// to reply. `source` is filled in automatically from SERVER_NAME by the CLI.
export const INSTRUCTIONS = [
  `Events from the ${SERVER_NAME} channel arrive as`,
  `<channel source="${SERVER_NAME}" chat_id="…" path="…" method="…">…</channel>.`,
  'They carry text a remote user sent over the chroxy-channel prototype.',
  'To send a message back to that user, call the `reply` tool, passing the',
  '`chat_id` from the inbound tag and your `text`. Anything you want the sender',
  'to see must go through the `reply` tool — the channel is otherwise one-way.'
].join(' ')

// The reply tool definition, shaped exactly as the protocol reference shows.
export const REPLY_TOOL = {
  name: 'reply',
  description: 'Send a message back to the sender over the chroxy-channel.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: 'The conversation to reply in (from the inbound <channel> tag).' },
      text: { type: 'string', description: 'The message to send back to the sender.' }
    },
    required: ['chat_id', 'text']
  }
}

/**
 * MCP `meta` keys must be identifiers (letters, digits, underscores). Per the
 * protocol reference, keys containing hyphens or other characters are silently
 * dropped by Claude Code. We drop them up front so the prototype's behaviour is
 * explicit and testable rather than relying on the silent drop.
 *
 * @param {Record<string, unknown>} meta
 * @returns {Record<string, string>} identifier-safe, string-valued meta
 */
export function sanitizeMeta(meta) {
  const out = {}
  if (!meta || typeof meta !== 'object') return out
  for (const [key, value] of Object.entries(meta)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue
    if (value === undefined || value === null) continue
    out[key] = String(value)
  }
  return out
}

/**
 * Build the channel `notifications/claude/channel` payload for a given request.
 * Factored out so the envelope shape (method + content + sanitized meta) can be
 * unit-tested without a live transport.
 *
 * @param {object} args
 * @param {string} args.content  the message body (becomes the <channel> body)
 * @param {string} args.chatId   incrementing per-request id (becomes chat_id attr)
 * @param {string} [args.path]   request path (becomes path attr)
 * @param {string} [args.method] request method (becomes method attr)
 * @returns {{ method: string, params: { content: string, meta: Record<string,string> } }}
 */
export function buildChannelNotification({ content, chatId, path = '/', method = 'POST' }) {
  return {
    method: CHANNEL_NOTIFICATION_METHOD,
    params: {
      content: String(content ?? ''),
      meta: sanitizeMeta({ chat_id: chatId, path, method })
    }
  }
}

/**
 * Create the channel MCP `Server` with the channel capability, the reply tool,
 * and the instructions wired up — but without connecting any transport. The
 * caller connects stdio (the CLI path) or drives it directly (tests).
 *
 * @param {object} [opts]
 * @param {(args: { chat_id: string, text: string }) => void} [opts.onReply]
 *   invoked when Claude calls the `reply` tool. Defaults to logging to stderr.
 * @param {(...args: unknown[]) => void} [opts.log] stderr logger seam (tests).
 * @returns {{ mcp: import('@modelcontextprotocol/sdk/server/index.js').Server }}
 */
export function createChannelServer(opts = {}) {
  const log = opts.log || ((...args) => console.error('[chroxy-channel]', ...args))
  const onReply = opts.onReply || (({ chat_id, text }) => {
    log(`reply chat_id=${chat_id}: ${text}`)
  })

  const mcp = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      // Presence of `claude/channel` registers the channel notification
      // listener; `tools` lets Claude discover the `reply` tool.
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {}
      },
      instructions: INSTRUCTIONS
    }
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [REPLY_TOOL] }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    if (req.params.name === REPLY_TOOL.name) {
      const args = req.params.arguments || {}
      const chat_id = String(args.chat_id ?? '')
      const text = String(args.text ?? '')
      onReply({ chat_id, text })
      return { content: [{ type: 'text', text: 'sent' }] }
    }
    throw new Error(`unknown tool: ${req.params.name}`)
  })

  return { mcp }
}

/**
 * Start the localhost-only HTTP control surface that forwards every POST body
 * into Claude as a channel notification, with an incrementing `chat_id`.
 *
 * @param {object} args
 * @param {import('@modelcontextprotocol/sdk/server/index.js').Server} args.mcp
 * @param {number} [args.port]
 * @param {(...args: unknown[]) => void} [args.log]
 * @returns {import('http').Server}
 */
export function startHttpControlSurface({ mcp, port = DEFAULT_PORT, log = (...a) => console.error('[chroxy-channel]', ...a) }) {
  let nextChatId = 1

  const httpServer = createServer((req, res) => {
    // The control surface only accepts POST (the documented `curl -X POST`
    // path). Reject anything else up front so it's clear exactly what reaches
    // the Claude session.
    if ((req.method || '') !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'POST' })
      res.end('method not allowed')
      req.resume() // drain any body so the socket can be reused/closed cleanly
      return
    }

    const chunks = []
    // Body is read fully into memory: fine for a localhost debug prototype, not
    // for the real bridge. No size cap by design — the surface is trusted-local.
    req.on('error', err => {
      log('request error:', err && err.message ? err.message : err)
    })
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const chatId = String(nextChatId++)
      const path = (req.url || '/').split('?')[0]
      const notification = buildChannelNotification({
        content: body,
        chatId,
        path,
        method: req.method || 'POST'
      })
      try {
        // Fire-and-forget: resolves on transport write, not on Claude
        // processing. Dropped silently if the session didn't load the channel.
        await mcp.notification(notification)
        log(`forwarded chat_id=${chatId} (${body.length} bytes)`)
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
      } catch (err) {
        log('notification failed:', err && err.message ? err.message : err)
        res.writeHead(502, { 'Content-Type': 'text/plain' })
        res.end('channel notification failed')
      }
    })
  })

  // localhost-only: nothing outside this machine can POST. See spike R8.
  httpServer.listen(port, '127.0.0.1', () => {
    log(`HTTP control surface listening on 127.0.0.1:${port}`)
  })
  return httpServer
}

/**
 * CLI entrypoint: build the server, connect stdio, and start the HTTP surface.
 * Exported so it can be invoked in tests with injected seams if ever needed,
 * but it is normally run by `claude` spawning this file over stdio.
 */
export async function main() {
  const port = Number(process.env.CHROXY_CHANNEL_PORT) || DEFAULT_PORT
  const { mcp } = createChannelServer()
  // Connect stdio FIRST so notifications have a transport to write to.
  await mcp.connect(new StdioServerTransport())
  startHttpControlSurface({ mcp, port })
}

// Only auto-run when executed directly (not when imported by tests). Compare
// against pathToFileURL(process.argv[1]) — argv[1] can be a RELATIVE path (e.g.
// `node ./chroxy-channel-server.js`), so a naive `file://${argv[1]}` would never
// match the absolute `import.meta.url` and main() would silently never run.
const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main().catch(err => {
    console.error('[chroxy-channel] fatal:', err)
    process.exit(1)
  })
}
