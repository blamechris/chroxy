# chroxy-channel — `claude --channels` MCP prototype

Standalone prototype that proves the `claude --channels` round-trip end-to-end
against a real `claude` binary. **No chroxy wiring** — this is intentionally not
registered in `providers.js`, `ws-server.js`, or any session class. It exists to
de-risk the channel protocol before the provider scaffold (#3953) and bridge
(#3954) are built on top of it.

See [`docs/architecture/claude-channels-provider-spike.md`](../../../../docs/architecture/claude-channels-provider-spike.md)
(the #3951 spike) for the verified protocol contract and the go/no-go rationale.

## What it does

[`chroxy-channel-server.js`](./chroxy-channel-server.js) is a Node 22 stdio MCP
server that:

1. Declares the `experimental: { 'claude/channel': {} }` capability — the
   presence of this key is what registers Claude's channel notification listener.
2. Declares `tools: {}` and registers a two-way `reply(chat_id, text)` tool whose
   handler logs the reply to **stderr** (the prototype has nowhere else to send
   it yet; the bridge in #3954 will route it back over IPC).
3. Listens on a **localhost-only** HTTP port (default `8788`, override with
   `CHROXY_CHANNEL_PORT`). Every `POST` body is forwarded into Claude as a
   `notifications/claude/channel` event with an incrementing `meta.chat_id`.
4. Sets `instructions` on the `Server` constructor explaining the `<channel>`
   envelope and how to reply.
5. Connects over `StdioServerTransport` — `claude` spawns it as a subprocess.

Permission relay (`claude/channel/permission`) is **out of scope** here (sub 4,
#3955) — the prototype declares only the inbound channel + reply-tool surface.

## Run it manually

The server is spawned by `claude` over stdio, so running it directly just exits
(it has no stdio peer — that is expected).

```bash
# Terminal 1 — register it in .mcp.json (run from your project root).
# Use an absolute path to the file so claude can spawn it from any cwd.
cat > .mcp.json <<'EOF'
{
  "mcpServers": {
    "chroxy-channel": {
      "command": "node",
      "args": ["packages/server/src/channels/chroxy-channel-server.js"]
    }
  }
}
EOF

# Start an interactive claude session that loads the channel. The dev flag is
# required during the research preview because custom channels are not on the
# approved allowlist.
claude --dangerously-load-development-channels server:chroxy-channel

# Terminal 2 — push a message into the live session.
curl -X POST localhost:8788 -d "list the files in this directory"
```

Expected: the message lands in Claude's transcript as

```text
<channel source="chroxy-channel" chat_id="1" path="/" method="POST">list the files in this directory</channel>
```

Claude responds in the session and, when it calls the `reply` tool, the
prototype logs the reply to stderr (visible in Terminal 1, or in the channel's
debug log at `~/.claude/debug/<session-id>.txt`).

### Override the port

```bash
CHROXY_CHANNEL_PORT=9001 claude --dangerously-load-development-channels server:chroxy-channel
curl -X POST localhost:9001 -d "hello from a different port"
```

## Troubleshooting

- **`curl` succeeds but nothing reaches Claude** — run `/mcp` in the session to
  check the channel's status. "Failed to connect" usually means an import error;
  check `~/.claude/debug/<session-id>.txt` for the stderr trace.
- **`curl` fails with "connection refused"** — the port is not bound yet, or a
  stale process from a previous run is holding it. `lsof -i :8788` shows what is
  listening; kill the stale process and restart the session.
- **"blocked by org policy"** — a Team/Enterprise admin must enable channels for
  the org (`channelsEnabled`). Channels are not available on Bedrock/Vertex.

## Security note

The HTTP control surface binds to `127.0.0.1` only. Even so, **anything that can
POST to the port injects text directly into the live Claude session** — a
prompt-injection surface (spike risk R8). This prototype keeps the surface for
`curl` testing; the real bridge (#3954) replaces it with a Unix socket driven
solely by `ClaudeChannelSession`, and any permission-relay opt-in (#3955) gates
on that single trusted writer.
