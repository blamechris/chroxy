/**
 * Built-in slash command registry per provider (#3856).
 *
 * Source-of-truth for the slash-command picker so users see the commands the
 * underlying CLI/SDK accepts — `/clear`, `/compact`, `/model`, etc. — alongside
 * the user-authored `.md` skill files we already scan. Without this list the
 * picker only surfaces the markdown skills (browser.js:375), so newcomers never
 * discover the most useful commands and Codex users see Claude-flavoured names
 * that don't match their CLI.
 *
 * The commands themselves are interpreted **downstream** by the provider's
 * CLI/SDK — Chroxy doesn't intercept `/clear` or `/compact`. We're purely
 * making them discoverable in the picker.
 *
 * Hand-maintained. Cost of staleness is low: a missing entry just means the
 * command isn't visible in the picker, but typing it still works.
 *
 * When updating, cross-reference:
 *   - Claude Code:  https://docs.claude.com/en/docs/claude-code/slash-commands
 *   - Codex CLI:    https://github.com/openai/codex (run `codex` and type `/`)
 *   - Gemini CLI:   https://github.com/google-gemini/gemini-cli
 */

/**
 * @typedef {Object} BuiltinCommand
 * @property {string} name - Command name (no leading slash)
 * @property {string} description - Short human-readable description
 * @property {boolean} [requiresModelSwitch] - When true, only surfaced for
 *   providers whose `capabilities.modelSwitch === true`. Used for `/model`.
 */

/** Commands available across every Claude-flavoured provider. */
const CLAUDE_COMMON = [
  { name: 'clear', description: 'Clear conversation history' },
  { name: 'compact', description: 'Compact conversation to a summary' },
  { name: 'cost', description: 'Show session cost / token usage' },
  { name: 'help', description: 'List all commands' },
  { name: 'model', description: 'Switch model mid-session', requiresModelSwitch: true },
  { name: 'memory', description: 'View or edit memory files' },
  { name: 'permissions', description: 'Manage tool permissions' },
  { name: 'agents', description: 'List custom agents' },
  { name: 'init', description: 'Initialize a CLAUDE.md for this repo' },
  { name: 'review', description: 'Review a pull request' },
]

/**
 * Per-provider registry. Keys match provider names registered in providers.js.
 * Unknown providers fall back to an empty list — the picker still shows
 * user/project commands; built-ins just don't surface (safe default).
 *
 * Docker variants reuse the Claude registry: `docker-cli` extends `CliSession`
 * and `docker-sdk` extends `SdkSession` (see docker-session.js / docker-sdk-
 * session.js), so the in-container CLI/SDK accepts the same `/clear`,
 * `/compact`, etc. The hidden `docker` alias (registered for backward compat
 * in providers.js) is intentionally omitted — new sessions never resolve to it.
 */
export const BUILTIN_COMMANDS = {
  'claude-sdk': CLAUDE_COMMON,
  'claude-cli': CLAUDE_COMMON,
  'claude-tui': CLAUDE_COMMON,
  'claude-byok': CLAUDE_COMMON,
  'docker-cli': CLAUDE_COMMON,
  'docker-sdk': CLAUDE_COMMON,
  'codex': [
    { name: 'clear', description: 'Clear conversation history' },
    { name: 'help', description: 'List all commands' },
    { name: 'init', description: 'Generate AGENTS.md for this repo' },
    { name: 'model', description: 'Switch model mid-session', requiresModelSwitch: true },
    { name: 'new', description: 'Start a new chat session' },
    { name: 'review', description: 'Review the pending diff' },
    { name: 'status', description: 'Show current session settings' },
  ],
  'gemini': [
    { name: 'clear', description: 'Clear conversation history' },
    { name: 'compress', description: 'Compress conversation context' },
    { name: 'help', description: 'List all commands' },
    { name: 'memory', description: 'View or edit memory files' },
    { name: 'model', description: 'Switch model mid-session', requiresModelSwitch: true },
    { name: 'stats', description: 'Show session token usage' },
    { name: 'tools', description: 'List available tools' },
  ],
}

/**
 * Resolve the built-in commands for a given provider, filtered by capabilities.
 *
 * `/model` is gated on `capabilities.modelSwitch` so Claude TUI sessions
 * (which can't hot-swap models — see claude-tui-session.js:225) don't show it.
 * Unknown providers return `[]` rather than throwing so callers don't need to
 * handle the "no built-ins registered" case as an error.
 *
 * @param {string|null|undefined} providerName
 * @param {{ modelSwitch?: boolean } | null | undefined} capabilities
 * @returns {Array<{ name: string, description: string, source: 'builtin' }>}
 */
export function getBuiltinCommands(providerName, capabilities = null) {
  if (!providerName || typeof providerName !== 'string') return []
  const list = BUILTIN_COMMANDS[providerName]
  if (!Array.isArray(list)) return []
  const supportsModelSwitch = !!(capabilities && capabilities.modelSwitch)
  const out = []
  for (const cmd of list) {
    if (cmd.requiresModelSwitch && !supportsModelSwitch) continue
    out.push({ name: cmd.name, description: cmd.description, source: 'builtin' })
  }
  return out
}
