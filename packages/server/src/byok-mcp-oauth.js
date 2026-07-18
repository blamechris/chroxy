/**
 * OAuth 2.1 authorization-code + PKCE flow for remote MCP servers (#6822).
 *
 * Implements the MCP authorization spec's browser-based flow for the BYOK remote
 * transport (#6821 / #6833): when a remote MCP server answers a connect attempt
 * with 401 + `WWW-Authenticate` resource metadata, the daemon
 *   1. discovers the protected-resource metadata → the authorization server(s),
 *   2. discovers the authorization-server metadata (RFC 8414 / OIDC fallback),
 *   3. runs dynamic client registration (RFC 7591) when the AS supports it,
 *   4. generates a PKCE verifier/challenge + a state parameter, and builds the
 *      authorization URL the USER opens in a browser (on their own device),
 *   5. redeems the returned code (+ PKCE verifier) at the token endpoint for
 *      access/refresh tokens, and later refreshes them on expiry.
 *
 * CORE CONSTRAINT (remote user): the browser that completes consent lives on the
 * user's phone/dashboard, while token REDEMPTION must land at the daemon. So the
 * daemon holds the PKCE verifier + state server-side and only surfaces the
 * authorization URL over the wire. The redirect can either hit a daemon-hosted
 * loopback/tunnel callback (auto-complete) or the user copy-pastes the code back
 * over the wire (the universal fallback). Both converge on `completeAuthorization`.
 *
 * SECURITY: this module handles secrets (client secrets, codes, tokens) but never
 * logs any of them. `fetchImpl` is injectable (defaults to global fetch) so tests
 * drive the whole flow against an in-process mock AS/RS with no real network.
 * Redirects are followed by fetch for the well-known GETs (metadata is public),
 * but every credentialed POST (registration, token) uses `redirect: 'manual'` so
 * a token request can never be bounced off-origin with the code/secret attached.
 */
import { createHash, randomBytes } from 'node:crypto'
import { URL, URLSearchParams } from 'node:url'
import { lookup } from 'node:dns/promises'
import { createLogger } from './logger.js'
import { isBlockedMetadataHost } from './byok-mcp-config.js'

const DEFAULT_TIMEOUT_MS = 10_000
const CLIENT_NAME = 'Chroxy'

// -- SSRF hardening (#6822 / #6834) -----------------------------------------
//
// Every OAuth endpoint the daemon fetches — the resource_metadata URL from a
// server's WWW-Authenticate header, the authorization server's issuer, and the
// registration/token endpoints inside the discovered AS metadata — is
// ATTACKER-INFLUENCEABLE (a malicious/compromised MCP server chooses them). A
// server could point any of them at the cloud-metadata service (169.254.169.254
// / fd00:ec2::254) to make the daemon fetch instance credentials on its behalf.
// This is the exact hole the remote transport closed in #6834; the OAuth flow
// threads the SAME guard. Loopback / RFC1918 are deliberately NOT blocked — a
// localhost authorization server is legitimate (that broader egress policy is
// #6834's scope, which the user chose to keep permissive).

/**
 * Return a refusal reason when `url` targets the cloud-metadata service /
 * link-local range (literal host OR a DNS name that resolves into it), else
 * null. Mirrors MCPRemoteClient._refuseMetadataTarget: literal hosts are checked
 * directly (the URL parser already canonicalized hex/decimal tricks); DNS names
 * get a best-effort lookup so a name resolving into the blocked range is refused
 * too. Lookup ERRORS pass through (the subsequent fetch surfaces them as an
 * ordinary connect failure). An unparseable url returns null — fetch surfaces it.
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function refuseUnsafeMetadataUrl(url) {
  let hostname
  try {
    hostname = new URL(url).hostname
  } catch {
    return null
  }
  if (isBlockedMetadataHost(hostname)) {
    return 'refusing cloud-metadata / link-local OAuth endpoint (never a legitimate authorization server)'
  }
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const isLiteral = /^[\d.]+$/.test(bare) || bare.includes(':')
  if (!isLiteral) {
    try {
      const addrs = await lookup(bare, { all: true })
      if (addrs.some(({ address }) => isBlockedMetadataHost(address))) {
        return 'refusing DNS name resolving to a cloud-metadata / link-local address'
      }
    } catch { /* resolution failures surface via the fetch */ }
  }
  return null
}

// -- PKCE (RFC 7636) --------------------------------------------------------

/** base64url with no padding — the PKCE + state encoding. */
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Generate a PKCE verifier + S256 challenge. The verifier is a 32-byte
 * base64url random string (43 chars, within the RFC's 43–128 range); the
 * challenge is base64url(SHA-256(verifier)).
 *
 * @returns {{ verifier: string, challenge: string, method: 'S256' }}
 */
export function generatePkce() {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

/** A high-entropy opaque `state` value bound (by the caller's registry) to a session+server. */
export function generateState() {
  return base64url(randomBytes(24))
}

// -- fetch helpers ----------------------------------------------------------

function withTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort() } catch { /* already settled */ } }, timeoutMs)
  return Promise.resolve(fetchImpl(url, { ...init, signal: controller.signal }))
    .finally(() => clearTimeout(timer))
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const res = await withTimeout(fetchImpl, url, init, timeoutMs)
  const text = await res.text()
  let json = null
  if (text) { try { json = JSON.parse(text) } catch { json = null } }
  return { status: res.status, json, res }
}

/**
 * SSRF-guarded `fetchJson`: refuse a cloud-metadata / link-local target BEFORE
 * any request leaves the process, and force `redirect: 'manual'` so a benign URL
 * that 3xx-redirects to an internal host can never carry the request off-origin
 * (a host check on only the initial URL would otherwise be bypassed by a 302).
 * A refused target throws — `fetchImpl` is never called for it.
 */
async function guardedFetchJson(fetchImpl, url, init, timeoutMs) {
  const refusal = await refuseUnsafeMetadataUrl(url)
  if (refusal) throw new Error(`MCP OAuth: ${refusal}`)
  return fetchJson(fetchImpl, url, { redirect: 'manual', ...init }, timeoutMs)
}

// -- Discovery --------------------------------------------------------------

/**
 * Parse `resource_metadata="<url>"` out of a `WWW-Authenticate: Bearer ...`
 * header (MCP spec / RFC 9728). Returns the url or null when absent/malformed.
 *
 * @param {string|null|undefined} header
 * @returns {string|null}
 */
export function parseResourceMetadataUrl(header) {
  if (typeof header !== 'string' || header.length === 0) return null
  const m = header.match(/resource_metadata\s*=\s*"([^"]+)"/i) || header.match(/resource_metadata\s*=\s*([^\s,]+)/i)
  return m ? m[1] : null
}

/**
 * Discover the protected-resource metadata → the authorization server issuer(s).
 * Prefers the `resource_metadata` URL from the WWW-Authenticate header; falls
 * back to `<origin>/.well-known/oauth-protected-resource` (MCP spec default).
 * Returns `{ authorizationServers: string[], resource: string|null, scopesSupported: string[] }`.
 *
 * @param {{ serverUrl: string, wwwAuthenticate?: string|null, fetchImpl: Function, timeoutMs?: number }} args
 */
export async function discoverProtectedResource({ serverUrl, wwwAuthenticate, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const candidates = []
  const fromHeader = parseResourceMetadataUrl(wwwAuthenticate)
  if (fromHeader) candidates.push(fromHeader)
  try {
    const origin = new URL(serverUrl).origin
    candidates.push(`${origin}/.well-known/oauth-protected-resource`)
  } catch { /* serverUrl already validated upstream; ignore */ }

  for (const url of candidates) {
    try {
      // (a) resource_metadata is attacker-influenceable (WWW-Authenticate) —
      // SSRF-guarded + redirect:'manual' via guardedFetchJson.
      const { status, json } = await guardedFetchJson(fetchImpl, url, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs)
      if (status >= 200 && status < 300 && json && typeof json === 'object') {
        const servers = Array.isArray(json.authorization_servers) ? json.authorization_servers.filter((s) => typeof s === 'string') : []
        return {
          authorizationServers: servers,
          resource: typeof json.resource === 'string' ? json.resource : null,
          scopesSupported: Array.isArray(json.scopes_supported) ? json.scopes_supported.filter((s) => typeof s === 'string') : [],
        }
      }
    } catch { /* refused target or fetch failure — try the next candidate */ }
  }
  return { authorizationServers: [], resource: null, scopesSupported: [] }
}

/**
 * Discover the authorization-server metadata for an issuer. Tries the RFC 8414
 * well-known (`/.well-known/oauth-authorization-server` with the issuer's path
 * inserted per spec), then the OIDC `/.well-known/openid-configuration`. Returns
 * the metadata object, or null when neither resolves.
 *
 * @param {{ issuer: string, fetchImpl: Function, timeoutMs?: number }} args
 */
export async function discoverAuthorizationServer({ issuer, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let base
  try { base = new URL(issuer) } catch { return null }
  const path = base.pathname.replace(/\/$/, '')
  // RFC 8414: for an issuer with a path, the well-known segment is inserted
  // between the host and the path. For a root issuer both forms coincide.
  const candidates = [
    `${base.origin}/.well-known/oauth-authorization-server${path}`,
    `${base.origin}${path}/.well-known/oauth-authorization-server`,
    `${base.origin}/.well-known/openid-configuration${path}`,
    `${base.origin}${path}/.well-known/openid-configuration`,
  ]
  for (const url of candidates) {
    try {
      // (b) the issuer (→ these well-known URLs) is attacker-influenceable
      // (resource metadata's authorization_servers) — SSRF-guarded.
      const { status, json } = await guardedFetchJson(fetchImpl, url, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs)
      if (status >= 200 && status < 300 && json && typeof json.authorization_endpoint === 'string' && typeof json.token_endpoint === 'string') {
        // RFC 8414 §3.3: the metadata `issuer` MUST exactly match the issuer
        // that was used to build the well-known URL. A mismatch is a mix-up /
        // spoofing signal — reject it rather than trusting the endpoints.
        if (typeof json.issuer === 'string' && json.issuer !== issuer) continue
        return json
      }
    } catch { /* refused target or fetch failure — try the next candidate */ }
  }
  return null
}

// -- Dynamic client registration (RFC 7591) ---------------------------------

/**
 * Register a client dynamically at the AS `registration_endpoint`. Returns
 * `{ clientId, clientSecret? }`, or null when the AS has no registration endpoint
 * (caller falls back to a pre-provisioned/public client id) or registration
 * fails. Never logs the response body (may carry a client secret).
 *
 * @param {{ registrationEndpoint: string, redirectUri: string, scope?: string, fetchImpl: Function, timeoutMs?: number }} args
 */
export async function registerClient({ registrationEndpoint, redirectUri, scope, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof registrationEndpoint !== 'string' || !registrationEndpoint) return null
  // (c) registration_endpoint comes from the (attacker-influenceable) AS
  // metadata body — refuse a cloud-metadata / link-local target BEFORE the POST.
  // A refusal THROWS (propagates to beginAuthorization) rather than returning
  // null so it is never confused with "the AS supports no DCR".
  const refusal = await refuseUnsafeMetadataUrl(registrationEndpoint)
  if (refusal) throw new Error(`MCP OAuth: ${refusal}`)
  const body = {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  }
  if (scope) body.scope = scope
  try {
    const { status, json } = await fetchJson(fetchImpl, registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    }, timeoutMs)
    if (status >= 200 && status < 300 && json && typeof json.client_id === 'string') {
      return {
        clientId: json.client_id,
        clientSecret: typeof json.client_secret === 'string' ? json.client_secret : undefined,
      }
    }
  } catch { /* registration failed — caller falls back */ }
  return null
}

// -- Authorization URL ------------------------------------------------------

/**
 * Build the browser authorization URL (OAuth 2.1 authorization-code + PKCE).
 *
 * @param {{ authorizationEndpoint: string, clientId: string, redirectUri: string,
 *   codeChallenge: string, state: string, scope?: string, resource?: string }} args
 * @returns {string}
 */
export function buildAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, codeChallenge, state, scope, resource }) {
  const u = new URL(authorizationEndpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('code_challenge', codeChallenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', state)
  if (scope) u.searchParams.set('scope', scope)
  // RFC 8707 resource indicator — MCP spec requires binding the token to the
  // resource so a token minted for one MCP server can't be replayed at another.
  if (resource) u.searchParams.set('resource', resource)
  return u.toString()
}

// -- Token endpoint ---------------------------------------------------------

function normalizeTokenResponse(json) {
  if (!json || typeof json.access_token !== 'string' || !json.access_token) {
    throw new Error('token endpoint returned no access_token')
  }
  const expiresIn = Number(json.expires_in)
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
    scope: typeof json.scope === 'string' ? json.scope : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
  }
}

/**
 * Redeem an authorization code for tokens (grant_type=authorization_code).
 * `redirect: 'manual'` keeps the credentialed POST on-origin. Throws with a
 * value-free message on any non-2xx / missing access_token.
 *
 * @param {{ tokenEndpoint: string, clientId: string, clientSecret?: string, code: string,
 *   redirectUri: string, codeVerifier: string, resource?: string, fetchImpl: Function, timeoutMs?: number }} args
 */
export async function redeemCode({ tokenEndpoint, clientId, clientSecret, code, redirectUri, codeVerifier, resource, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  // (d) token_endpoint comes from the (attacker-influenceable) AS metadata —
  // refuse a cloud-metadata / link-local target before the credentialed POST.
  const refusal = await refuseUnsafeMetadataUrl(tokenEndpoint)
  if (refusal) throw new Error(`MCP OAuth: ${refusal}`)
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  })
  if (resource) form.set('resource', resource)
  if (clientSecret) form.set('client_secret', clientSecret)
  const { status, json } = await fetchJson(fetchImpl, tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    redirect: 'manual',
  }, timeoutMs)
  if (status < 200 || status >= 300) {
    throw new Error(`token endpoint returned HTTP ${status}${json && typeof json.error === 'string' ? ` (${json.error})` : ''}`)
  }
  return normalizeTokenResponse(json)
}

/**
 * Refresh an access token (grant_type=refresh_token). Preserves the existing
 * refresh token when the AS rotates-optional (does not return a new one). Throws
 * on any non-2xx / missing access_token so the caller can fall back to a full
 * re-authorization.
 *
 * @param {{ tokenEndpoint: string, clientId: string, clientSecret?: string, refreshToken: string,
 *   scope?: string, resource?: string, fetchImpl: Function, timeoutMs?: number }} args
 */
export async function refreshAccessToken({ tokenEndpoint, clientId, clientSecret, refreshToken, scope, resource, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  // (d) token_endpoint (from stored record / AS metadata) — same SSRF guard as
  // redeemCode so a refresh can't be steered at the metadata service either.
  const refusal = await refuseUnsafeMetadataUrl(tokenEndpoint)
  if (refusal) throw new Error(`MCP OAuth: ${refusal}`)
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  })
  if (scope) form.set('scope', scope)
  if (resource) form.set('resource', resource)
  if (clientSecret) form.set('client_secret', clientSecret)
  const { status, json } = await fetchJson(fetchImpl, tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    redirect: 'manual',
  }, timeoutMs)
  if (status < 200 || status >= 300) {
    throw new Error(`refresh token endpoint returned HTTP ${status}${json && typeof json.error === 'string' ? ` (${json.error})` : ''}`)
  }
  const normalized = normalizeTokenResponse(json)
  // Rotation-optional: keep the old refresh token when the AS didn't issue one.
  if (!normalized.refreshToken) normalized.refreshToken = refreshToken
  return normalized
}

// -- High-level orchestration -----------------------------------------------

/**
 * @typedef {object} OAuthPending
 * @property {string} authorizationEndpoint
 * @property {string} tokenEndpoint
 * @property {string} [registrationEndpoint]
 * @property {string} clientId
 * @property {string} [clientSecret]
 * @property {string} codeVerifier
 * @property {string} redirectUri
 * @property {string} state
 * @property {string} [scope]
 * @property {string} [resource]
 */

/**
 * Run the full discovery → DCR → PKCE → authorization-URL sequence for a server
 * that answered a connect with 401. Returns `{ authorizationUrl, pending }` where
 * `pending` is the server-side secret material (`completeAuthorization` consumes
 * it), or throws a value-free Error when the AS can't be discovered / registered.
 *
 * @param {{ serverUrl: string, wwwAuthenticate?: string|null, redirectUri: string,
 *   clientId?: string, fetchImpl: Function, log?: object, timeoutMs?: number }} args
 * @returns {Promise<{ authorizationUrl: string, pending: OAuthPending }>}
 */
export async function beginAuthorization({ serverUrl, wwwAuthenticate, redirectUri, clientId: preClientId, fetchImpl, log = createLogger('byok-mcp-oauth'), timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const resourceMeta = await discoverProtectedResource({ serverUrl, wwwAuthenticate, fetchImpl, timeoutMs })
  // The issuer is the first advertised authorization server, else the server's
  // own origin (some MCP servers co-locate the AS and skip resource metadata).
  const issuer = resourceMeta.authorizationServers[0] || new URL(serverUrl).origin
  const asMeta = await discoverAuthorizationServer({ issuer, fetchImpl, timeoutMs })
  if (!asMeta) {
    throw new Error('could not discover the authorization server metadata')
  }
  const scope = resourceMeta.scopesSupported.length > 0 ? resourceMeta.scopesSupported.join(' ') : undefined
  const resource = resourceMeta.resource || undefined

  let clientId = preClientId
  let clientSecret
  if (!clientId) {
    const registered = await registerClient({
      registrationEndpoint: asMeta.registration_endpoint,
      redirectUri,
      scope,
      fetchImpl,
      timeoutMs,
    })
    if (!registered) {
      throw new Error('the authorization server does not support dynamic client registration and no client id is configured')
    }
    clientId = registered.clientId
    clientSecret = registered.clientSecret
  }

  const pkce = generatePkce()
  const state = generateState()
  const authorizationUrl = buildAuthorizationUrl({
    authorizationEndpoint: asMeta.authorization_endpoint,
    clientId,
    redirectUri,
    codeChallenge: pkce.challenge,
    state,
    scope,
    resource,
  })
  log.info(`MCP OAuth: authorization URL generated for a remote server (issuer=${redactUrl(issuer)})`)
  return {
    authorizationUrl,
    pending: {
      authorizationEndpoint: asMeta.authorization_endpoint,
      tokenEndpoint: asMeta.token_endpoint,
      registrationEndpoint: asMeta.registration_endpoint,
      clientId,
      clientSecret,
      codeVerifier: pkce.verifier,
      redirectUri,
      state,
      scope,
      resource,
    },
  }
}

/**
 * Complete authorization by redeeming a code against a `pending` bag from
 * `beginAuthorization`. Returns a persistable token record (the shape
 * byok-mcp-oauth-store expects). Throws (value-free) on redemption failure.
 *
 * @param {{ pending: OAuthPending, code: string, fetchImpl: Function, timeoutMs?: number }} args
 */
export async function completeAuthorization({ pending, code, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const tokens = await redeemCode({
    tokenEndpoint: pending.tokenEndpoint,
    clientId: pending.clientId,
    clientSecret: pending.clientSecret,
    code,
    redirectUri: pending.redirectUri,
    codeVerifier: pending.codeVerifier,
    resource: pending.resource,
    fetchImpl,
    timeoutMs,
  })
  return {
    ...tokens,
    clientId: pending.clientId,
    clientSecret: pending.clientSecret,
    tokenEndpoint: pending.tokenEndpoint,
    authorizationEndpoint: pending.authorizationEndpoint,
    registrationEndpoint: pending.registrationEndpoint,
    scope: tokens.scope || pending.scope,
    resource: pending.resource,
  }
}

/** Origin+path only, for logs — never carries a token/secret/query. */
function redactUrl(url) {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return '[unparseable url]'
  }
}

// -- Callback registry (loopback/tunnel auto-complete) ----------------------
//
// Process-wide map keyed by the high-entropy `state` value. A client registers
// its completion handler when it builds the authorization URL; the daemon's
// `/mcp/oauth/callback` route (http-routes.js) looks it up by state and drives
// the redemption. The state's entropy IS the capability — an attacker cannot
// guess it — and entries expire so a never-completed flow can't leak.

const CALLBACK_TTL_MS = 15 * 60 * 1000 // an authorization attempt is abandoned after 15m
const MAX_PENDING_CALLBACKS = 100
const _pendingCallbacks = new Map() // state -> { handler, expiresAt }

/**
 * Register a callback handler for a `state`. `handler(code)` returns a promise
 * resolving to `{ ok: true }` (or throwing). Overwrites a prior entry for the
 * same state; evicts the oldest when the map is full.
 *
 * @param {string} state
 * @param {(code: string) => Promise<any>} handler
 */
export function registerOAuthCallback(state, handler) {
  if (typeof state !== 'string' || !state || typeof handler !== 'function') return
  pruneCallbacks()
  if (_pendingCallbacks.size >= MAX_PENDING_CALLBACKS) {
    const oldest = _pendingCallbacks.keys().next().value
    if (oldest !== undefined) _pendingCallbacks.delete(oldest)
  }
  _pendingCallbacks.set(state, { handler, expiresAt: Date.now() + CALLBACK_TTL_MS })
}

/** Drop a pending callback (called after completion / on teardown). */
export function unregisterOAuthCallback(state) {
  if (typeof state === 'string') _pendingCallbacks.delete(state)
}

function pruneCallbacks() {
  const now = Date.now()
  for (const [state, entry] of _pendingCallbacks) {
    if (entry.expiresAt <= now) _pendingCallbacks.delete(state)
  }
}

/**
 * Resolve a callback by state, invoking its handler with the code. Returns
 * `{ found: boolean, ok?: boolean, error?: string }`. The entry is consumed on a
 * successful handler run; a failed run leaves it so the user can retry (e.g. paste
 * the code) without re-authorizing.
 *
 * @param {string} state
 * @param {string} code
 */
export async function resolveOAuthCallback(state, code) {
  pruneCallbacks()
  const entry = typeof state === 'string' ? _pendingCallbacks.get(state) : undefined
  if (!entry) return { found: false }
  try {
    await entry.handler(code)
    _pendingCallbacks.delete(state)
    return { found: true, ok: true }
  } catch (err) {
    return { found: true, ok: false, error: err?.message || String(err) }
  }
}

/** Test-only: clear the pending-callback registry between cases. */
export function _clearOAuthCallbacksForTests() {
  _pendingCallbacks.clear()
}

// -- Redirect URI configuration ---------------------------------------------
//
// The redirect_uri the daemon registers + surfaces. Set once at server start to
// the daemon's reachable callback (loopback for desktop-local, or an operator-
// supplied base). Remote/tunneled users whose browser can't reach it fall back to
// the paste-code path — the code is redeemed at the daemon regardless.

const DEFAULT_CALLBACK_PATH = '/mcp/oauth/callback'
let _callbackBaseUrl = null

/**
 * Configure the base URL the OAuth callback is reachable at (no trailing path).
 * e.g. `http://127.0.0.1:8765`. Called by ws-server once it knows its port.
 *
 * @param {string|null} baseUrl
 */
export function setMcpOAuthCallbackBase(baseUrl) {
  _callbackBaseUrl = typeof baseUrl === 'string' && baseUrl ? baseUrl.replace(/\/$/, '') : null
}

/**
 * The redirect_uri to register + surface. Precedence:
 *   1. `CHROXY_MCP_OAUTH_REDIRECT_URI` (operator override — a full URI),
 *   2. `<configured base>` + callback path,
 *   3. a loopback default on the conventional daemon port.
 *
 * @returns {string}
 */
export function mcpOAuthRedirectUri() {
  const override = process.env.CHROXY_MCP_OAUTH_REDIRECT_URI
  if (typeof override === 'string' && override) return override
  const base = _callbackBaseUrl || 'http://127.0.0.1:8765'
  return `${base}${DEFAULT_CALLBACK_PATH}`
}

export const MCP_OAUTH_CALLBACK_PATH = DEFAULT_CALLBACK_PATH
