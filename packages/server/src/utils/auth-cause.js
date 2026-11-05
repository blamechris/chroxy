/**
 * #8970: classify HOW a Claude session authenticates, so an AUTH_REQUIRED error
 * can name the remedy that applies. Pure given its inputs; the only I/O is one
 * read of the USER-LEVEL `<claudeConfigDir>/settings.json` (apiKeyHelper, `env`
 * block), located with the shared `claudeConfigDir` resolver. Project
 * `.claude/settings.json`, `settings.local.json` and managed settings are NOT
 * consulted yet.
 *
 * Precedence mirrors Claude Code's own credential order:
 *   cloud provider (Bedrock / Vertex) > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY
 *   > apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN (ambiguous: `undefined`) > host login.
 * A containerised session is `container` before any of them.
 *
 * Only the PRESENCE of a variable is inspected; no value is returned, logged
 * or echoed.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { claudeConfigDir } from './claude-config-dir.js'

export { AUTH_REQUIRED_CAUSES } from '@chroxy/protocol'

function truthy(value) {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim())
}

function present(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** Read `<claude config dir>/settings.json`; `{}` when absent or malformed. */
function readClaudeSettings(env) {
  try {
    const parsed = JSON.parse(readFileSync(join(claudeConfigDir(env), 'settings.json'), 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * @param {Record<string, string|undefined>} env - the env the session's claude is spawned with
 * @param {{ containerized?: boolean, settings?: object }} [opts] - `settings` replaces the file read (tests)
 * @returns {import('@chroxy/protocol').AuthRequiredCause | undefined}
 */
export function classifyAuthCause(env, { containerized = false, settings } = {}) {
  if (containerized) return 'container'
  const cfg = settings ?? readClaudeSettings(env)
  // claude also honours the `env` block of settings.json; the process env wins.
  const settingsEnv = cfg.env && typeof cfg.env === 'object' ? cfg.env : {}
  const get = (name) => (present(env[name]) ? env[name] : settingsEnv[name])

  if (truthy(get('CLAUDE_CODE_USE_BEDROCK'))) return 'bedrock'
  if (truthy(get('CLAUDE_CODE_USE_VERTEX'))) return 'vertex'
  if (present(get('ANTHROPIC_AUTH_TOKEN'))) return 'auth_token'
  if (present(get('ANTHROPIC_API_KEY'))) return 'api_key'
  if (present(cfg.apiKeyHelper)) return 'api_key_helper'
  if (present(get('CLAUDE_CODE_OAUTH_TOKEN'))) return undefined
  return 'login'
}
