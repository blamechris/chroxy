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
import { join } from 'path'
import { homedir } from 'os'
import { cachedResolveCredentialFile } from './auth-probes.js'
import { readStoredField } from './credential-store.js'

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

  // #5490: route the file read through credential-store's cipher-aware reader.
  // The webhook URL lives in the SAME credentials.json the BYOK/API-key
  // resolvers read, and the #5154 at-rest migration rewrites that file into an
  // encrypted envelope on first daemon start. A plain JSON.parse here finds no
  // `discordWebhookUrl` key in the envelope, so the sink silently goes
  // unconfigured. `readStoredField` applies the same 0600 mode enforcement,
  // envelope decryption, and keychain-unavailable handling as the other
  // resolvers — plaintext (not-yet-encrypted) files still pass through. Never
  // throws (readStore catches fs/JSON/decrypt errors); never logs or returns
  // the URL in a reason string.
  let read
  try {
    read = readStoredField('discordWebhookUrl')
  } catch (err) {
    // Defensive: readStoredField is non-throwing by contract, but if it ever
    // does, degrade to source:'none' rather than crash the sink's probe.
    return {
      url: null,
      source: 'none',
      reason: `unable to read ${CREDENTIALS_FILE}: ${err.message}`,
    }
  }

  if (!read.fileExists) {
    return {
      url: null,
      source: 'none',
      reason: `CHROXY_DISCORD_WEBHOOK_URL not set and ${CREDENTIALS_FILE} does not exist`,
    }
  }

  // A read error covers bad mode, malformed JSON, an encrypted envelope whose
  // keychain data key is unavailable, and a corrupt/undecryptable envelope.
  // The reason is value-free (built by credential-store from the path/cause).
  if (read.error) {
    return { url: null, source: 'none', reason: read.error }
  }

  if (read.value === null) {
    return {
      url: null,
      source: 'none',
      reason: `${CREDENTIALS_FILE} missing or empty "discordWebhookUrl" field`,
    }
  }

  return { url: read.value, source: 'file' }
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
