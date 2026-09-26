/**
 * chroxy agent-control — stdio MCP server exposing this daemon's session
 * control surface to an external agent harness (Codex, Claude, Gemini, …).
 *
 *   chroxy agent-control --stdio                            → local daemon, read-write
 *   chroxy agent-control --stdio --read-only                → local daemon, mutation tools absent
 *   chroxy agent-control --stdio --url wss://host --pin-identity <key>
 *                                                             → remote daemon (token via env — see below)
 *
 * This is a thin CLI wrapper around `agent-control/mcp-server.js`'s own
 * `main()`, passing Commander's parsed options so both `--url value` and
 * `--url=value` preserve the explicit target and identity pin. See
 * docs/guides/agent-control.md for the full design, security
 * model, and MCP-host configuration examples.
 *
 * There is deliberately NO `--token` flag: argv is visible to every other
 * process on this machine via `ps`. A remote connection's token is read
 * ONLY from the `CHROXY_AGENT_CONTROL_TOKEN` environment variable; the local
 * (default) case needs no token in argv or config at all — it reads
 * connection.json itself.
 */

export function registerAgentControlCommand(program) {
  program
    .command('agent-control')
    .description('Run a stdio MCP server exposing chroxy session control to an external agent harness (Codex, Claude, Gemini, …). Requires --stdio (the only supported mode). Remote connections read the token ONLY from CHROXY_AGENT_CONTROL_TOKEN — there is no --token flag.')
    .option('--stdio', 'Run as a stdio MCP server (required — this command has no other mode)')
    .option('--read-only', 'Disable mutation tools (create/send-input/interrupt/respond-permission)')
    .option('--url <url>', 'Explicit remote daemon URL (ws:// or wss://) — never inferred; token via CHROXY_AGENT_CONTROL_TOKEN')
    .option('--pin-identity <key>', "Pin the daemon's Ed25519 identity public key (base64) — or set CHROXY_AGENT_CONTROL_PIN")
    .option('--allow-command-approvals', "Let the connected planner approve command-style tool calls (Bash, PowerShell, Monitor, codex shell) via chroxy_respond_permission — off by default because the protected-path floor cannot see through an arbitrary command string (e.g. `cat .env` looks like an ordinary, unfloored Bash call). Still subject to the floored/ownership gates. Logs a startup warning when enabled.")
    .action(async (options) => {
      if (!options.stdio) {
        process.stderr.write('chroxy agent-control requires --stdio (the only supported mode).\n')
        process.stderr.write('Usage: chroxy agent-control --stdio [--read-only] [--url <url>] [--pin-identity <key>] [--allow-command-approvals]\n')
        process.exitCode = 1
        return
      }
      const { main } = await import('../agent-control/mcp-server.js')
      await main({ readOnly: options.readOnly, url: options.url, identityPublicKey: options.pinIdentity, allowCommandApprovals: options.allowCommandApprovals })
    })
}
