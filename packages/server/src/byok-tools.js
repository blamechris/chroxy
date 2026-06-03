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
 *   - MCP — #4048
 */

/**
 * Valid TodoWrite status values. Single source of truth — the JSON-schema
 * enum below and the Set used for runtime validation both derive from
 * `TODO_STATUS_LIST` so they can't drift apart.
 */
export const TODO_STATUS_LIST = Object.freeze(['pending', 'in_progress', 'completed'])
export const TODO_STATUSES = new Set(TODO_STATUS_LIST)

/**
 * Permissiveness ranking for the Task tool's per-launch `permission_mode`
 * override (#5017). Lower number = more restrictive; higher = more permissive.
 *
 *   plan        (0) — model is asked to plan before acting; tool calls still
 *                     gate on approval (and `plan` mode itself short-circuits
 *                     write tools server-side).
 *   approve     (1) — default; every tool call gates on user approval.
 *   acceptEdits (2) — Read/Write/Edit/NotebookEdit/Glob/Grep auto-approved.
 *   auto        (3) — every tool call auto-approved (skip-permissions).
 *
 * The Task tool refuses to launch a subagent under a mode strictly more
 * permissive than the parent's. Equal-or-stricter is allowed.
 *
 * Kept here (next to the schema enum) so the JSON-schema property, the
 * runtime validator in byok-session, and the test matrix all read from
 * one source of truth.
 */
export const TASK_PERMISSION_MODE_LIST = Object.freeze(['plan', 'approve', 'acceptEdits', 'auto'])
export const TASK_PERMISSION_MODE_RANK = Object.freeze({
  plan: 0,
  approve: 1,
  acceptEdits: 2,
  auto: 3,
})

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
      '`pending`, `in_progress`, `completed`. Within a single call each `id` must ' +
      'be unique — duplicates are rejected as EINVAL so the model sees the mistake ' +
      'and can self-correct rather than have the last write silently win. ' +
      'The list is in-memory only — it resets when the session is destroyed. ' +
      'Returns a short summary of the current list.',
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
    name: 'Task',
    description:
      'Spawn a focused sub-agent (subagent) to handle a delegated piece of work. The ' +
      'sub-agent runs as a fresh ClaudeByokSession with its own isolated message history, ' +
      'inheriting this session\'s permission mode and cwd by default. Use it to: research a topic ' +
      'without polluting the parent context, run multi-step work in a focused scope, or delegate ' +
      'a task that needs its own tool budget. The sub-agent\'s final assistant text is returned ' +
      'as the tool_result — intermediate tool calls happen inside the child and are NOT ' +
      'surfaced to the parent (only `agent_spawned` / `agent_completed` events fire). ' +
      'Token cost is accumulated into the parent turn\'s `result.cost` so accounting stays ' +
      'attributed to the user-facing session. ' +
      'Cancellation: interrupting the parent cascades to the child via a shared AbortSignal. ' +
      'Optional `permission_mode` overrides the inherited mode for this single launch, but ' +
      'is constrained to be at-most-as-permissive as the parent (ranking: plan < approve < ' +
      'acceptEdits < auto). Requesting a stricter mode is allowed; requesting a more ' +
      'permissive mode is rejected with an is_error tool_result.',
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short (3-5 word) description of the task. Surfaced as the sub-agent label in the UI.',
        },
        prompt: {
          type: 'string',
          description: 'Full task prompt sent to the sub-agent as its initial user message.',
        },
        subagent_type: {
          type: 'string',
          description: 'Optional subagent profile id (e.g. "general", "researcher"). Currently informational only — ignored by the runner in v1.',
        },
        permission_mode: {
          type: 'string',
          enum: [...TASK_PERMISSION_MODE_LIST],
          description: 'Optional per-launch permission mode for the subagent. Must be at-most-as-permissive as the parent (plan < approve < acceptEdits < auto). When omitted, the subagent inherits the parent\'s mode.',
        },
      },
      required: ['description', 'prompt'],
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
