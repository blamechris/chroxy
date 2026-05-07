/**
 * Shared environment-status vocabulary used by both `environment-manager.js`
 * (the owner of `EnvironmentManager.reconnect()`) and `server-cli.js` (the
 * boot-path aggregate-warn helper).
 *
 * This is kept as a tiny, side-effect-free module so importing it does not
 * pull in `environment-manager.js` (and its transitive `DockerBackend`
 * dependency) eagerly. `server-cli.js` imports `environment-manager.js`
 * dynamically inside `if (config?.environments?.enabled)`; importing the
 * status set from this file preserves that lazy-load behaviour even when
 * environments are disabled (#3492 review).
 */

/**
 * Statuses that indicate an environment is unreachable after `reconnect()`.
 * Consumed by `server-cli.js#logEnvironmentManagerReconnectResult` to derive
 * the boot-path aggregate-warn count. Kept in sync with every code path in
 * `EnvironmentManager.reconnect()` that flips `allHealthy = false` (#3492).
 */
export const UNREACHABLE_STATUSES = new Set(['error', 'stopped'])
