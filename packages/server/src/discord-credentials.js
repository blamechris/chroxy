/**
 * Credential sourcing for the Discord webhook notification sink (#5413
 * Phase 2).
 *
 * A Discord webhook URL IS a secret: anyone holding it can post arbitrary
 * messages to (and delete the sink's messages from) the target channel. It
 * is therefore sourced exactly like the provider API keys — mirrors
 * byok-credentials.js / deepseek-credentials.js: priority order, 0600 mode
 * enforcement, lazy path resolution, masking helper. Kept as a separate
 * module so a credentials.json carrying API keys AND the webhook URL routes
 * each secret to its consumer without either path knowing about the other.
 *
 * Priority order:
 *   1. process.env.CHROXY_DISCORD_WEBHOOK_URL
 *   2. ~/.chroxy/credentials.json — { discordWebhookUrl: "https://discord.com/api/webhooks/..." }
 *      File MUST be mode 0600. We refuse to read it otherwise (security
 *      boundary: secrets must not be world-readable).
 *
 * The URL is deliberately NOT a config.json key — config.json is not
 * permission-restricted and gets echoed in verbose/diagnostic output.
 * validateConfig warns if someone puts a webhookUrl in the
 * notifications.discord block.
 *
 * Never logged. The redactor at logger.js scrubs discord.com/api/webhooks
 * URLs (token part is the secret); masking at the use site via
 * maskWebhookUrl is the second layer.
 */
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { cachedResolveCredentialFile } from './auth-probes.js'

// Lazy-resolved per call so tests that mutate process.env.HOME between
// cases pick up the new home (same rationale as byok-credentials.js).
function credentialsFilePath() {
  return join(homedir(), '.chroxy', 'credentials.json')
}

// Accepted webhook URL shapes. discordapp.com is the legacy domain Discord
// still serves; ptb/canary are Discord's test builds. The path may carry an
// API version segment (`/api/v10/webhooks/...`).
const WEBHOOK_URL_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/(\d+)\/([A-Za-z0-9_-]+)(?:[/?#]|$)/

/**
 * Whether a string looks like a real Discord webhook URL.
 * @param {string} url
 * @returns {boolean}
 */
export function isValidDiscordWebhookUrl(url) {
  return typeof url === 'string' && WEBHOOK_URL_RE.test(url)
}

/**
 * Extract the `<id>/<token>` pair from a webhook URL (used to build the
 * per-message endpoints: `/webhooks/<id>/<token>/messages/<messageId>`).
 * Strips query params / fragments / trailing slashes.
 *
 * @param {string} url
 * @returns {{ id: string, token: string } | null}
 */
export function extractWebhookIdToken(url) {
  if (typeof url !== 'string') return null
  const m = WEBHOOK_URL_RE.exec(url)
  if (!m) return null
  return { id: m[1], token: m[2] }
}

/**
 * Resolve the Discord webhook URL for the notification sink.
 *
 * @returns {{ url: string, source: 'env' | 'file' } | { url: null, source: 'none', reason: string }}
 */
export function resolveDiscordWebhookUrl() {
  const envUrl = process.env.CHROXY_DISCORD_WEBHOOK_URL
  if (typeof envUrl === 'string' && envUrl.length > 0) {
    return { url: envUrl, source: 'env' }
  }

  const CREDENTIALS_FILE = credentialsFilePath()
  let stat
  try {
    stat = statSync(CREDENTIALS_FILE)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        url: null,
        source: 'none',
        reason: `CHROXY_DISCORD_WEBHOOK_URL not set and ${CREDENTIALS_FILE} does not exist`,
      }
    }
    return {
      url: null,
      source: 'none',
      reason: `unable to stat ${CREDENTIALS_FILE}: ${err.message}`,
    }
  }

  // Refuse anything more permissive than 0600 — same security boundary as
  // the BYOK/DeepSeek resolvers. A pasted-in credentials.json defaulting to
  // 0644 on macOS would otherwise leak the webhook to every local user.
  const perms = stat.mode & 0o777
  if (perms !== 0o600) {
    return {
      url: null,
      source: 'none',
      reason: `${CREDENTIALS_FILE} has mode ${perms.toString(8).padStart(3, '0')}; refusing to read (must be 0600 — run: chmod 600 ${CREDENTIALS_FILE})`,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'))
  } catch (err) {
    return {
      url: null,
      source: 'none',
      reason: `${CREDENTIALS_FILE} unreadable or not valid JSON: ${err.message}`,
    }
  }

  if (typeof parsed?.discordWebhookUrl !== 'string' || parsed.discordWebhookUrl.length === 0) {
    return {
      url: null,
      source: 'none',
      reason: `${CREDENTIALS_FILE} missing or empty "discordWebhookUrl" field`,
    }
  }

  return { url: parsed.discordWebhookUrl, source: 'file' }
}

/**
 * Mask a webhook URL for display in logs / UI / errors. The webhook ID is
 * not secret (it's a channel-ish identifier); the token after it is. Never
 * returns the token — even for malformed inputs the whole string is
 * replaced with a fixed marker rather than echoed.
 *
 * @param {string} url
 * @returns {string}
 */
export function maskWebhookUrl(url) {
  const parts = extractWebhookIdToken(url)
  if (!parts) return '<invalid webhook url>'
  return `https://discord.com/api/webhooks/${parts.id}/[REDACTED]`
}

/**
 * Cached resolver — same result as resolveDiscordWebhookUrl, but routed
 * through auth-probes' mtime+size+mode-keyed credentials.json cache
 * (#5427 review): the sink's isConfigured() is probed by the registry on
 * every notification (and again inside send()/heartbeat), and the raw
 * resolver statSync+readFileSync+JSON.parses the file each time. The
 * cache repeats the parsed result until the env var or the file actually
 * changes. Tests that need isolation call auth-probes'
 * resetCachesForTest() (the suites already do, via the providers tests'
 * shared setup) or inject their own resolveWebhookUrl.
 */
export function cachedResolveDiscordWebhookUrl() {
  return cachedResolveCredentialFile('discord', process.env.CHROXY_DISCORD_WEBHOOK_URL, resolveDiscordWebhookUrl)
}
