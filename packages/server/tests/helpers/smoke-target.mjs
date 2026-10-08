/**
 * Target resolution for `tests/smoke-test.mjs` (#8225).
 *
 * The smoke used to find its target by itself: it read the API token from
 * `~/.chroxy/config.json` (then the OS keychain), probed 8765, 3131, 8080 and
 * 3000 and attached to whatever answered, and started `chroxy start` with the
 * operator's real config when nothing did. On a normal dev machine that is the
 * production daemon with the production token. This module is the replacement:
 * the target is NAMED by the caller or the run does not happen.
 *
 * Pure on purpose (no Playwright, no network, filesystem access injected) so the
 * refusals can be proven in the ordinary server suite, and so a run that is
 * refused never reaches a browser.
 *
 * Accepted targets, in the only two shapes there are:
 *   --url <origin> | --port <n>   plus  --token <t>   (or SMOKE_URL / SMOKE_PORT / SMOKE_TOKEN)
 *   --preview <preview.json>      a record with { port, configDir, ... }; the token
 *                                 is read from <configDir>/config.json
 *
 * Refused unless `--i-mean-production` is passed:
 *   - port 8765, by any route (`--port`, `--url`, `--preview`)
 *   - a preview whose configDir is a production config dir, by IDENTITY ((dev, ino), so
 *     a differently-cased spelling on a case-insensitive volume is caught): `$HOME/.chroxy`,
 *     the account's own home `.chroxy` (`os.userInfo().homedir`, which `HOME=` cannot
 *     change), or the `CHROXY_CONFIG_DIR` of the calling shell
 * With the flag, and only then, a missing token is read from `~/.chroxy/config.json`.
 * Nothing in this module ever consults the keychain.
 *
 * KNOWN LIMIT, stated rather than hidden: a production token pasted into
 * `--token` against a non-8765 port is not detected, because detecting it would
 * mean reading `~/.chroxy` on every run, which is the thing this file stopped
 * doing. The port and config-dir checks are what is enforced.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const PRODUCTION_PORT = 8765
export const PRODUCTION_FLAG = '--i-mean-production'

export const USAGE = `Usage: node tests/smoke-test.mjs <target> [options]

Target (required; there is no default and no port probing):
  --url <origin>          e.g. http://127.0.0.1:9123
  --port <n>              shorthand for http://127.0.0.1:<n>
  --token <token>         API token of that daemon (or env SMOKE_TOKEN)
  --preview <file.json>   a preview-daemon record with { port, configDir, ... };
                          the token is read from <configDir>/config.json
  (env SMOKE_URL / SMOKE_PORT / SMOKE_TOKEN are accepted; a flag wins)

Options:
  --headed                show the browser window
  --dry-run               resolve and print the target, then exit without running
  ${PRODUCTION_FLAG}   permit port ${PRODUCTION_PORT} and a production config dir
                          (~/.chroxy, the account's home, or $CHROXY_CONFIG_DIR).
                          This drives the real daemon. Do not pass it from an
                          agent session.
  --help                  print this text

Exit codes: 0 pass, 1 test failure, 2 usage error, 3 refused (production target).`

const VALUE_FLAGS = new Set(['--url', '--port', '--token', '--preview'])
const BOOL_FLAGS = new Set(['--headed', '--dry-run', '--help', PRODUCTION_FLAG])

/**
 * @param {string[]} argv Arguments after the script name.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ args: object, error: string|null }}
 */
export function parseSmokeArgs(argv, env = {}) {
  const args = {
    url: null,
    port: null,
    token: null,
    preview: null,
    headed: false,
    dryRun: false,
    help: false,
    productionOk: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1
    const flag = eq === -1 ? raw : raw.slice(0, eq)
    if (BOOL_FLAGS.has(flag)) {
      if (eq !== -1) return { args, error: `${flag} does not take a value` }
      if (flag === '--headed') args.headed = true
      else if (flag === '--dry-run') args.dryRun = true
      else if (flag === '--help') args.help = true
      else args.productionOk = true
    } else if (VALUE_FLAGS.has(flag)) {
      let value
      if (eq !== -1) value = raw.slice(eq + 1)
      else {
        value = argv[i + 1]
        i++
      }
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
        return { args, error: `${flag} needs a value` }
      }
      args[flag.slice(2)] = value
    } else {
      return { args, error: `unknown argument: ${raw}` }
    }
  }
  // A flag overrides the environment, including the environment's CHOICE of
  // target shape: SMOKE_URL in the shell must not collide with an explicit --port,
  // and none of the three applies once --preview names the whole target.
  if (!args.preview) {
    if (!args.url && !args.port) {
      args.url = env.SMOKE_URL || null
      args.port = args.url ? null : (env.SMOKE_PORT || null)
    }
    if (!args.token) args.token = env.SMOKE_TOKEN || null
  }
  return { args, error: null }
}

function parsePort(value) {
  if (!/^\d{1,5}$/.test(String(value))) return null
  const n = Number(value)
  return n >= 1 && n <= 65535 ? n : null
}

/**
 * Whether two paths name the same directory. Identity, not spelling: on a
 * case-insensitive volume (the macOS default) `<home>/.CHROXY` IS `<home>/.chroxy`,
 * and `realpathSync` keeps the spelling it was given, so it alone lets that through.
 * (dev, ino) settles it; the native realpath is the fallback when a path cannot be
 * stat'ed.
 */
function sameDir(a, b, { realpath, stat }) {
  try {
    const sa = stat(a)
    const sb = stat(b)
    if (sa.dev === sb.dev && sa.ino === sb.ino) return true
  } catch { /* one of them does not exist: fall through to the spelling check */ }
  const real = (p) => { try { return realpath(p) } catch { return resolve(p) } }
  return real(a) === real(b)
}

function osHome() {
  try { return userInfo().homedir } catch { return null }
}

/**
 * Turn parsed args into a target, or a reason there isn't one.
 *
 * @param {object} args From parseSmokeArgs.
 * @param {{ home: string, userHome?: string|null, env?: Record<string, string|undefined>,
 *   readFile?: (p: string, enc: string) => string, realpath?: (p: string) => string,
 *   stat?: (p: string) => { dev: number, ino: number|bigint } }} deps
 * @returns {{ ok: true, origin: string, port: number, token: string, source: string }
 *         | { ok: false, kind: 'usage'|'refused', error: string }}
 */
export function resolveSmokeTarget(args, {
  home,
  userHome = osHome(),
  env = {},
  readFile = readFileSync,
  realpath = realpathSync.native,
  stat = statSync,
}) {
  const usage = (error) => ({ ok: false, kind: 'usage', error })
  const refused = (error) => ({ ok: false, kind: 'refused', error })
  if (!home) return usage('cannot resolve a home directory')
  const realDir = join(home, '.chroxy')
  // Every place the production daemon's config can live from this shell: $HOME can be
  // overridden (HOME=/tmp/x node ...) while the account's real home cannot, and
  // CHROXY_CONFIG_DIR is where a daemon started from this shell would read.
  const productionDirs = [realDir]
  if (userHome) productionDirs.push(join(userHome, '.chroxy'))
  if (env.CHROXY_CONFIG_DIR && isAbsolute(env.CHROXY_CONFIG_DIR)) productionDirs.push(env.CHROXY_CONFIG_DIR)

  if (args.preview && (args.url || args.port || args.token)) {
    return usage('--preview supplies the port and token; do not combine it with --url, --port or --token')
  }
  if (args.url && args.port) return usage('give --url or --port, not both')
  if (!args.preview && !args.url && !args.port) {
    return usage('no target given: pass --url/--port with --token, or --preview <file.json>')
  }

  let origin
  let port
  let token = args.token
  let source
  let configDir = null

  if (args.preview) {
    source = `preview ${args.preview}`
    let record
    try {
      record = JSON.parse(readFile(args.preview, 'utf8'))
    } catch (err) {
      return usage(`cannot read preview record ${args.preview}: ${err.message}`)
    }
    port = parsePort(record && record.port)
    if (port === null) return usage('preview record has no valid "port"')
    if (!record.configDir || typeof record.configDir !== 'string' || !isAbsolute(record.configDir)) {
      return usage('preview record has no absolute "configDir"')
    }
    configDir = record.configDir
    origin = `http://127.0.0.1:${port}`
  } else if (args.url) {
    source = '--url'
    let parsed
    try { parsed = new URL(args.url) } catch { return usage(`--url is not a URL: ${args.url}`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return usage('--url must be http or https')
    port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80)
    origin = parsed.origin
  } else {
    source = '--port'
    port = parsePort(args.port)
    if (port === null) return usage(`--port is not a valid port: ${args.port}`)
    origin = `http://127.0.0.1:${port}`
  }

  if (!args.productionOk) {
    if (port === PRODUCTION_PORT) {
      return refused(`port ${PRODUCTION_PORT} is the production daemon; refusing (pass ${PRODUCTION_FLAG} to override)`)
    }
    const hit = configDir && productionDirs.find(d => sameDir(configDir, d, { realpath, stat }))
    if (hit) {
      return refused(`preview configDir is the real config dir ${hit}; refusing (pass ${PRODUCTION_FLAG} to override)`)
    }
  }

  if (configDir) {
    try {
      token = JSON.parse(readFile(join(configDir, 'config.json'), 'utf8')).apiToken
    } catch (err) {
      return usage(`cannot read the token from ${join(configDir, 'config.json')}: ${err.message}`)
    }
  } else if (!token && args.productionOk) {
    try {
      token = JSON.parse(readFile(join(realDir, 'config.json'), 'utf8')).apiToken
      source += ' + token from the real ~/.chroxy'
    } catch (err) {
      return usage(`cannot read the token from ${join(realDir, 'config.json')}: ${err.message}`)
    }
  }
  if (!token || typeof token !== 'string') return usage('no API token: pass --token (or SMOKE_TOKEN), or use --preview')

  return { ok: true, origin, port, token, source }
}
