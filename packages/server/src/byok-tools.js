/**
 * Tool definitions for the claude-byok provider.
 *
 * Schemas match Claude Code's documented input shapes so the model sees
 * a consistent interface across providers — switching from claude-cli /
 * claude-tui / claude-sdk to claude-byok shouldn't require the model to
 * relearn tool calling.
 *
 * These are passed verbatim into `client.messages.stream({ tools })` —
 * the SDK consumes them as Anthropic API tool definitions.
 *
 * Deferred to follow-up issues (see #4047 epic):
 *   - WebFetch — #4050
 *   - TodoWrite — #4051
 *   - Task (subagent) — #4049
 *   - MCP — #4048
 */

export const BUILTIN_TOOLS = [
  {
    name: 'Read',
    description:
      'Read a text file from the workspace. Returns line-numbered content. ' +
      'Optionally read a slice via `offset` (1-indexed start line) and `limit` (max lines to return). ' +
      'Refuses binary files. Use the Glob tool to discover paths first if unsure.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or workspace-relative path to read.' },
        offset: { type: 'number', description: 'Optional 1-indexed start line.' },
        limit: { type: 'number', description: 'Optional max number of lines to return (default 2000).' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description:
      'Write a file, truncating any existing content. Creates the file and any missing parent ' +
      'directories. Returns the number of bytes written and whether the file is new.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or workspace-relative path to write.' },
        content: { type: 'string', description: 'New file content.' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description:
      'Replace `old_string` with `new_string` in a file. Refuses if `old_string` matches multiple ' +
      'sites (pass `replace_all: true` to override) or matches zero sites. Add surrounding context ' +
      'to `old_string` to disambiguate when needed.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or workspace-relative path to edit.' },
        old_string: { type: 'string', description: 'Exact substring to replace. Must be unique unless replace_all is true.' },
        new_string: { type: 'string', description: 'Replacement substring.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of refusing on multi-match.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Bash',
    description:
      'Run a shell command via `bash -c`. Returns stdout, stderr, exit code. Timeout default ' +
      '30s (override via `timeout`, max 600s). Output capped at ~1MB total — exceeding the cap ' +
      'kills the process. Use for build/test/git operations and one-off shell pipelines.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Full shell command to run via `bash -c`.' },
        description: { type: 'string', description: 'Short human-readable summary of what the command does.' },
        timeout: { type: 'number', description: 'Optional timeout in milliseconds. Max 600000 (10 min).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Glob',
    description:
      'List files matching a glob pattern. Pattern is shell-style (e.g. `**/*.ts`, `packages/server/src/*.js`). ' +
      '`path` is the search root (default: workspace cwd). Returns file paths relative to the search root.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (supports ** for recursive match).' },
        path: { type: 'string', description: 'Optional search root. Defaults to workspace cwd.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description:
      'Search file contents for a regex pattern using ripgrep when available. ' +
      'Returns matching lines with file path + line number. `path` narrows the scope. ' +
      '`glob` further filters by filename pattern (e.g. `*.js`).',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern (PCRE-style via ripgrep when available).' },
        path: { type: 'string', description: 'Optional search root. Defaults to workspace cwd.' },
        glob: { type: 'string', description: 'Optional filename glob to filter matched files.' },
        '-i': { type: 'boolean', description: 'Case-insensitive match.' },
        '-n': { type: 'boolean', description: 'Include line numbers (default true).' },
      },
      required: ['pattern'],
    },
  },
]

/**
 * The set of tool names this provider knows how to execute locally.
 * Models that emit a tool_use for a name NOT in this set produce a
 * tool_result with `is_error: true` and a clear message so the chain
 * doesn't silently hang.
 */
export const BUILTIN_TOOL_NAMES = new Set(BUILTIN_TOOLS.map((t) => t.name))
