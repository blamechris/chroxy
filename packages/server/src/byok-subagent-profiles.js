/**
 * Subagent profile registry for the claude-byok provider's Task tool (#5018).
 *
 * A "profile" is a named bundle of overrides that the model can request when
 * spawning a sub-agent via the `Task` tool's `subagent_type` field. The byok
 * runner looks the id up here and applies the bundle to the child session
 * before its first `sendMessage` call.
 *
 * Each profile carries:
 *   - `systemPrompt`: text that becomes the child's system prompt (prepended
 *     to the child's `_buildSystemPrompt()` output). Used to bias the child
 *     toward a focused mode (researcher, code-reviewer, etc.) without
 *     polluting the parent's prompt.
 *   - `toolSet`: either the string `'all'` (no filtering — child sees the
 *     parent's full BUILTIN_TOOLS + MCP tools) or an array of tool names
 *     to allow. When an array, the child's `_buildTools()` filters down to
 *     only those built-in tools (MCP tools pass through unchanged — gating
 *     MCP per profile is a follow-up).
 *
 * This Phase-1 MVP seeds three profiles. Additional profiles (researcher
 * with WebFetch-heavy bias, summariser with a model override, etc.) can land
 * as small follow-up PRs against #5018. The registry stays in-source for
 * now; a `~/.chroxy/subagents.json` parser is the v2 path tracked on the
 * issue (the original PR #5015 scope-note explicitly defers that piece).
 *
 * The exported registry is `Object.freeze`d so subagent-side code can't
 * mutate the bundle and accidentally bleed customisations across parents.
 */

/**
 * Frozen profile registry. Keyed by the value the model passes in
 * `Task.input.subagent_type`. Profile names are kebab-case to match the
 * Anthropic convention used in the official Claude Code subagent UX
 * (`general-purpose`, etc.).
 *
 * Each `systemPrompt` MUST stay under `SESSION_PREAMBLE_MAX_LENGTH` (4000
 * chars). The byok Task tool applies the profile via
 * `child.setSessionPreamble(profile.systemPrompt)` (see
 * `byok-session.js:_executeTaskTool`), which silently trims and caps at
 * `SESSION_PREAMBLE_MAX_LENGTH`. An over-long profile wouldn't crash, but
 * its tail would be truncated and the child would see only a half-
 * instruction — the model behaviour silently degrades. The bound is
 * pinned by a unit test in `tests/byok-subagent-profiles.test.js`
 * (#5073) so a profile addition that would rely on silent truncation
 * fails at CI rather than at runtime.
 *
 * @type {Readonly<Record<string, Readonly<{systemPrompt: string, toolSet: 'all' | readonly string[]}>>>}
 */
export const SUBAGENT_PROFILES = Object.freeze({
  'general-purpose': Object.freeze({
    systemPrompt:
      'You are a general-purpose sub-agent spawned to handle a delegated piece of work. '
      + 'Stay focused on the task in the user message — do not re-derive the parent context. '
      + 'Use the available tools to research, read, edit, or compute as needed. When the work '
      + 'is complete, return a concise summary of what you did and any output the parent '
      + 'agent needs in order to continue.',
    toolSet: 'all',
  }),
  'code-reviewer': Object.freeze({
    systemPrompt:
      'You are a code-review sub-agent. Read the files in scope, identify correctness bugs, '
      + 'reuse / simplification opportunities, and style issues. Be specific (file:line) and '
      + 'cite the offending code. Do NOT modify files — your job is to surface findings, not '
      + 'apply fixes. Return a structured list of findings grouped by severity (high / medium / low).',
    toolSet: Object.freeze(['Read', 'Grep', 'Glob']),
  }),
  'research': Object.freeze({
    systemPrompt:
      'You are a research sub-agent. Gather information from the codebase and the web to answer '
      + 'the delegated question. Prefer Read / Grep / Glob to explore code and WebFetch to pull '
      + 'in external context. Do NOT modify files — return a synthesised summary with citations '
      + '(file:line for code, URL for web sources) so the parent can verify the basis.',
    toolSet: Object.freeze(['Read', 'Grep', 'Glob', 'WebFetch']),
  }),
})

/**
 * Sorted list of available profile ids. Used by the Task tool's
 * `subagent_type` schema description so the model sees the enumeration.
 *
 * Frozen so a misuse downstream (`SUBAGENT_PROFILE_NAMES.push(...)`) can't
 * desync this list from the registry keys.
 *
 * @type {readonly string[]}
 */
export const SUBAGENT_PROFILE_NAMES = Object.freeze(Object.keys(SUBAGENT_PROFILES).sort())

/**
 * Look up a profile by id. Returns the frozen profile bundle or `null`
 * when the id is unknown. Caller decides how to handle unknowns — the
 * Task tool falls back to the v1 default (no profile applied) and emits
 * a warn log per #5018's acceptance criteria, so a model that requests a
 * profile id this server doesn't yet know stays forward-compatible.
 *
 * @param {unknown} id
 * @returns {Readonly<{systemPrompt: string, toolSet: 'all' | readonly string[]}>|null}
 */
export function getSubagentProfile(id) {
  if (typeof id !== 'string' || id.length === 0) return null
  return SUBAGENT_PROFILES[id] || null
}
