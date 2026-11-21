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

import { getFolderTrustStateForLaunch, loadFolderTrustRecords, resolveRealPath } from './folder-trust.js'

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
 * Decide, without any scan, a folder that cannot be trusted: no folder, one that
 * cannot be resolved, or one with no trust record (whatever a scan would find, it is
 * untrusted, so the common case answers without walking the folder).
 * @param {string} [cwd] - session working directory
 * @returns {false|null} `false` when decided untrusted, `null` when a scan must decide
 */
export function projectSettingsDecidedWithoutScan(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return false
  const real = resolveRealPath(cwd)
  if (real.error) return false
  if (!loadFolderTrustRecords().some((r) => r.path === real.path)) return false
  return null
}

/**
 * May settings files in `cwd` (project scope) be read or executed? True ONLY when
 * the owner trusted the folder and its files are still the ones they approved.
 * There is no implicit rule: a folder with nothing command-bearing is untrusted
 * until it is trusted too.
 *
 * This is the launch decision. A folder with no record is decided at once. For a
 * recorded folder the files are scanned as they are NOW, in a worker thread, by a
 * scan started for this call: never the display cache, never a scan another caller
 * started. Any error, timeout or incomplete scan is "not allowed".
 * @param {string} [cwd] - session working directory
 * @returns {Promise<boolean>}
 */
export async function projectSettingsAllowedAsync(cwd) {
  const decided = projectSettingsDecidedWithoutScan(cwd)
  if (decided !== null) return decided
  try {
    return (await getFolderTrustStateForLaunch(cwd)).status === 'trusted'
  } catch {
    return false
  }
}
