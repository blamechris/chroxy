/**
 * Which Claude settings scopes a chroxy-launched Claude process may load.
 *
 * This is the one place that decision is made. Every launch path (SDK, CLI,
 * claude-tui, web tasks) and the status-line reader go through it.
 *
 * The user's own settings (`~/.claude`, or `CLAUDE_CONFIG_DIR`) are always used.
 * Settings that live in the session's working directory (`.mcp.json`,
 * `.claude/settings.json`, project `CLAUDE.md`, skills, agents, commands) are
 * loaded only after the owner trusted the folder (folder-trust.js); every folder
 * starts untrusted. Any change to the listed files makes the folder untrusted
 * again until it is re-approved. The `local` scope
 * (`.claude/settings.local.json`) is never included, whatever the folder's state.
 *
 * With no `cwd` the answer is "not allowed".
 */

import { getFolderTrustState, loadFolderTrustRecords, resolveRealPath } from './folder-trust.js'

/**
 * Setting-source names for a project-settings decision already taken.
 * @param {boolean} allowed
 * @returns {string[]}
 */
export function claudeSettingSourcesFor(allowed) {
  return allowed ? ['user', 'project'] : ['user']
}

/**
 * The same, as the value of the CLI's `--setting-sources` flag.
 * @param {boolean} allowed
 * @returns {string}
 */
export function claudeSettingSourcesValueFor(allowed) {
  return claudeSettingSourcesFor(allowed).join(',')
}

/**
 * Setting-source names for the SDK `settingSources` option.
 * @param {string} [cwd] - session working directory
 * @returns {string[]}
 */
export function claudeSettingSources(cwd) {
  return claudeSettingSourcesFor(projectSettingsAllowed(cwd))
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
 * May settings files in `cwd` (project scope) be read or executed? True ONLY when
 * the owner trusted the folder and its files are still the ones they approved.
 * There is no implicit rule: a folder with nothing command-bearing is untrusted
 * until it is trusted too. Evaluated against the files as they are now.
 * @param {string} [cwd] - session working directory
 * @param {{ cached?: boolean }} [opts] - `cached` reuses a scan up to 2 s old (display only)
 * @returns {boolean}
 */
export function projectSettingsAllowed(cwd, opts) {
  if (typeof cwd !== 'string' || cwd === '') return false
  // A folder with no trust record is untrusted whatever a scan would find, so
  // the common case answers without walking the folder.
  const real = resolveRealPath(cwd)
  if (real.error) return false
  if (!loadFolderTrustRecords().some((r) => r.path === real.path)) return false
  return getFolderTrustState(cwd, opts).status === 'trusted'
}
