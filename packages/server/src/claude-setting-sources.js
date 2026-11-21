/**
 * Which Claude settings scopes a chroxy-launched Claude process may load.
 *
 * This is the one place that decision is made. Every launch path (SDK, CLI,
 * claude-tui, web tasks) and the status-line reader go through it.
 *
 * The user's own settings (`~/.claude`, or `CLAUDE_CONFIG_DIR`) are always used.
 * Settings that live in the session's working directory (`.mcp.json`,
 * `.claude/settings.json`, project `CLAUDE.md`, skills, agents, commands) are
 * loaded when the folder carries no command-bearing files, or when the owner has
 * trusted the folder's current files (folder-trust.js). Any change to those files
 * makes the folder untrusted again until it is re-approved. The `local` scope
 * (`.claude/settings.local.json`) is never included, whatever the folder's state.
 *
 * With no `cwd` the answer is "not allowed".
 */

import { getFolderTrustState } from './folder-trust.js'

/**
 * Setting-source names for the SDK `settingSources` option.
 * @param {string} [cwd] - session working directory
 * @returns {string[]}
 */
export function claudeSettingSources(cwd) {
  return projectSettingsAllowed(cwd) ? ['user', 'project'] : ['user']
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
 * May settings files in `cwd` (project scope) be read or executed? True when the
 * folder has no command-bearing files, or the owner trusted their current
 * contents. Evaluated against the files as they are now.
 * @param {string} [cwd] - session working directory
 * @param {{ cached?: boolean }} [opts] - `cached` reuses a scan up to 2 s old (pollers)
 * @returns {boolean}
 */
export function projectSettingsAllowed(cwd, opts) {
  if (typeof cwd !== 'string' || cwd === '') return false
  return getFolderTrustState(cwd, opts).status !== 'untrusted'
}
