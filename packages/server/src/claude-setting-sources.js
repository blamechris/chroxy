/**
 * Which Claude settings scopes a chroxy-launched Claude process may load.
 *
 * This is the one place that decision is made. Every launch path (SDK, CLI,
 * claude-tui, web tasks) and the status-line reader go through it, so a later
 * per-folder trust decision extends this module and nothing else.
 *
 * Today only the user's own settings (`~/.claude`, or `CLAUDE_CONFIG_DIR`)
 * are used. Settings that live in the session's working directory
 * (`.mcp.json`, `.claude/settings.json`, project `CLAUDE.md`, skills, agents,
 * commands) are not loaded. The `local` scope (`.claude/settings.local.json`)
 * is intentionally never included, whatever a later per-folder decision says.
 *
 * `cwd` is accepted by every function so call sites already pass the folder a
 * per-folder decision will need; it is unused until then.
 */

/**
 * Setting-source names for the SDK `settingSources` option.
 * @param {string} [_cwd] - session working directory
 * @returns {string[]}
 */
export function claudeSettingSources(_cwd) {
  return ['user']
}

/**
 * The same decision as the value of the CLI's `--setting-sources` flag.
 * @param {string} [cwd] - session working directory
 * @returns {string}
 */
export function claudeSettingSourcesValue(cwd) {
  return claudeSettingSources(cwd).join(',')
}

/**
 * The same decision as CLI arguments: `--setting-sources user`.
 * @param {string} [cwd] - session working directory
 * @returns {string[]}
 */
export function claudeSettingSourcesArgs(cwd) {
  return ['--setting-sources', claudeSettingSourcesValue(cwd)]
}

/**
 * May settings files in `cwd` (project scope) be read or executed?
 * @param {string} [_cwd] - session working directory
 * @returns {boolean}
 */
export function projectSettingsAllowed(_cwd) {
  return false
}
