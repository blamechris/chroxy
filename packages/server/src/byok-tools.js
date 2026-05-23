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
 *   - Task (subagent) — #4049
 *   - MCP — #4048
 */

/**
 * Valid TodoWrite status values. Single source of truth — the JSON-schema
 * enum below and the Set used for runtime validation both derive from
 * `TODO_STATUS_LIST` so they can't drift apart.
 */
export const TODO_STATUS_LIST = Object.freeze(['pending', 'in_progress', 'completed'])
export const TODO_STATUSES = new Set(TODO_STATUS_LIST)

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
    name: 'WebFetch',
    description:
      'Fetch a public web URL and return readable text. HTML pages are stripped of <script>/<style> ' +
      'and tags, with entities decoded. JSON and plaintext are returned as-is. Binary content-types ' +
      '(images, octet-stream, etc.) are refused. Response body is capped — overflow is marked ' +
      '`[truncated …]` so the model knows it saw a slice. Only http(s) URLs are allowed; file://, ' +
      'ftp://, javascript: are refused. Outbound network call: by default the user must approve ' +
      'each call via a permission prompt. Exception: when the session is in `auto` permission mode ' +
      'the prompt is bypassed and the call runs immediately — auto mode is a system-wide opt-out ' +
      'of per-call approval.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
        prompt: { type: 'string', description: 'What the model wants out of the page (passed back verbatim in the result header so the model retains intent).' },
        timeout: { type: 'number', description: 'Optional fetch timeout in milliseconds. Max 120000 (2 min).' },
      },
      required: ['url', 'prompt'],
    },
  },
  {
    name: 'TodoWrite',
    description:
      'Update the session-scoped todo list. Items are merged by `id` — a call that ' +
      'omits an item leaves that item unchanged (partial updates are supported). ' +
      'Each item: `{ id, content, status, activeForm? }`. Status must be one of ' +
      '`pending`, `in_progress`, `completed`. The list is in-memory only — it resets ' +
      'when the session is destroyed. Returns a short summary of the current list.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Array of todo items to merge into the list (by id).',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable identifier — used as the merge key.' },
              content: { type: 'string', description: 'Short description of the task.' },
              status: { type: 'string', enum: TODO_STATUS_LIST, description: 'Current state.' },
              activeForm: { type: 'string', description: 'Optional present-continuous form (e.g. "Running tests") shown when in_progress.' },
            },
            required: ['id', 'content', 'status'],
          },
        },
      },
      required: ['todos'],
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
