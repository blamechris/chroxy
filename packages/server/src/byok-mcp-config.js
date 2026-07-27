/**
 * MCP config discovery for the claude-byok provider.
 *
 * Foundation only for #4048/#4076: parse Claude-style mcpServers blocks and
 * expose safe read-only metadata. This module deliberately does not spawn MCP
 * children or wire tools.
 *
 * NOT byok-only despite the filename: `resolveClaudeConfigWritePath` +
 * `writeClaudeConfigAtomic` are the SINGLE writer for `~/.claude.json` across the
 * whole server, and `claude-tui/pty-driver.js`'s `ensureCwdTrusted` goes through
 * them too (#7046). A second hand-rolled `writeFileSync(tmp)` → `renameSync(tmp,
 * config)` over this file is how the symlink-destroying / mode-widening defect
 * came to exist in two places at once — add callers here, not copies.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { lookup as dnsLookup } from 'node:dns/promises'
import { fsyncForDurability, confirmRenameDurable } from './platform.js'

/**
 * Defensive upper bound on the size of `~/.claude.json`. Today the file is
 * small (a few KB), but it is owned by Claude Code, not by us — a future
 * schema change that starts persisting conversation history into it could
 * grow it substantially. Reading hundreds of MB synchronously at session-start
 * would block the server, so we bail with a single warning above this cap.
 */
export const CLAUDE_CONFIG_MAX_BYTES = 10 * 1024 * 1024

export function defaultClaudeConfigPath() {
  return process.env.CHROXY_CLAUDE_CONFIG || join(homedir(), '.claude.json')
}

/**
 * Coerce an args array to strings only. Pushes one warning per dropped entry
 * naming the server, the offending index (`args[<i>]`), and the value's type
 * so a user who typoed a number-as-number gets a signal instead of a silent
 * strip. Non-arrays drop the whole field with a single warning.
 */
function coerceStringArray(value, { warnings, serverName }) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    warnings.push(
      `MCP server ${serverName}: ignoring args (expected array, got ${typeof value})`,
    )
    return []
  }
  const out = []
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (typeof item === 'string') {
      out.push(item)
    } else {
      warnings.push(
        `MCP server ${serverName}: dropping args[${i}] (expected string, got ${typeof item})`,
      )
    }
  }
  return out
}

/**
 * Keys that must never be assigned into a string→string map we build with `{}`.
 * `map.__proto__ = 'some string'` hits `Object.prototype`'s `__proto__` setter,
 * which ignores non-object values — so the key vanished SILENTLY, and a caller
 * who asked for `env.__proto__` got a server spawned without it and no
 * explanation. `constructor` / `prototype` are plain own-property writes (no
 * setter) but are refused alongside it: a map key that shadows an object internal
 * is never a legitimate environment variable or HTTP header (#7001 review).
 */
const UNSAFE_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Coerce an env object to string→string only. Pushes one warning per dropped
 * key naming the server, the offending field (`env.<KEY>`), and the value's
 * type. Non-objects drop the whole field with a single warning.
 */
function coerceEnv(value, { warnings, serverName }) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(
      `MCP server ${serverName}: ignoring env (expected object, got ${Array.isArray(value) ? 'array' : typeof value})`,
    )
    return {}
  }
  const env = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (UNSAFE_MAP_KEYS.has(key)) {
      // Warn rather than drop silently: on the WRITE path
      // (normalizeMcpServerConfig) any warning is escalated to a rejection, so
      // the caller is told the key is refused instead of receiving an `ok` for a
      // config that quietly lost it.
      warnings.push(`MCP server ${serverName}: refusing env.${key} (reserved object key, never a real environment variable)`)
      continue
    }
    if (typeof raw === 'string') {
      env[key] = raw
    } else {
      warnings.push(
        `MCP server ${serverName}: dropping env.${key} (expected string, got ${typeof raw})`,
      )
    }
  }
  return env
}

/**
 * Coerce an HTTP `headers` object to string→string only, for remote (#6821)
 * MCP transports. Same defensive shape as coerceEnv: one warning per dropped
 * key naming the field (`headers.<KEY>`), and the whole field is dropped with
 * a single warning if it is not a plain object. Header VALUES (bearer tokens,
 * api keys) are never logged or surfaced — the warning names only the key.
 */
function coerceHeaders(value, { warnings, serverName }) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(
      `MCP server ${serverName}: ignoring headers (expected object, got ${Array.isArray(value) ? 'array' : typeof value})`,
    )
    return {}
  }
  const headers = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (UNSAFE_MAP_KEYS.has(key)) {
      // Same silent-drop hazard as env.__proto__ — refuse explicitly (#7001 review).
      warnings.push(`MCP server ${serverName}: refusing headers.${key} (reserved object key, never a real HTTP header)`)
      continue
    }
    if (typeof raw === 'string') {
      headers[key] = raw
    } else {
      warnings.push(
        `MCP server ${serverName}: dropping headers.${key} (expected string, got ${typeof raw})`,
      )
    }
  }
  return headers
}

/**
 * True when a hostname (or a bare IP from dns.lookup) targets the cloud
 * metadata service / IPv4 link-local range — never a legitimate MCP server
 * (#6821, sharpest edge of #6834). Covers:
 *   - 169.254.0.0/16 (link-local; the metadata endpoint 169.254.169.254
 *     lives here). The WHATWG URL parser canonicalizes hex/decimal/octal
 *     host tricks (0xa9fea9fe, 2852039166) to dotted-quad first, so a
 *     literal-host check on the PARSED hostname catches those too.
 *   - IPv4-mapped IPv6 forms of the same range: the URL parser serializes
 *     them as hex groups (`::ffff:a9fe:xxxx`; a9fe == 169.254), dns.lookup
 *     may return the dotted form (`::ffff:169.254.x.x`).
 *   - fd00:ec2::254, the AWS IMDS IPv6 endpoint (URL-canonical compressed
 *     form plus the expanded spelling).
 * Deliberately does NOT block loopback / RFC1918 generally — localhost MCP
 * servers are legitimate; the broader egress policy is #6834's scope.
 */
export function isBlockedMetadataHost(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return false
  let h = hostname.toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (v4) return Number(v4[1]) === 169 && Number(v4[2]) === 254
  if (/^::ffff:a9fe:[0-9a-f]{1,4}$/.test(h)) return true
  const mapped = h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (mapped) return Number(mapped[1]) === 169 && Number(mapped[2]) === 254
  if (h === 'fd00:ec2::254' || h === 'fd00:ec2:0:0:0:0:0:254') return true
  return false
}

/**
 * Return a credential-stripped form of an MCP server url, safe to log or
 * surface as metadata (#6821). Strips URL userinfo (`user:pass@`), the query
 * string, and the fragment — any of which can carry a token — while keeping
 * the origin + path that identify the endpoint. An unparseable url yields a
 * fixed placeholder so a malformed value can never leak verbatim.
 */
export function redactMcpUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return ''
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return '[unparseable url]'
  }
}

/**
 * Classify a bare IP address for trust-prompt display (#6834). Returns one of
 * 'loopback' | 'private' | 'link-local' | 'public' | 'unknown'. Purely for the
 * human-facing consent string — the cloud-metadata range is hard-BLOCKED
 * upstream (isBlockedMetadataHost, at config-parse and request time) so a
 * metadata address never reaches this classifier.
 *
 * Covers the common private ranges a "remote" MCP server might secretly point
 * at: IPv4 loopback (127/8), RFC1918 (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16), and their IPv6 equivalents (::1, fc00::/7 ULA, fe80::/10
 * link-local). IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is unwrapped to its v4 form
 * first. Anything else is 'public'. Best-effort — an unrecognisable string maps
 * to 'unknown' (shown as such), never throws.
 */
export function classifyIpAddress(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return 'unknown'
  let h = ip.toLowerCase().trim()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  const zone = h.indexOf('%') // strip an IPv6 zone id (fe80::1%en0)
  if (zone !== -1) h = h.slice(0, zone)
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — classify by the embedded v4 address.
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) h = mapped[1]
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (v4.slice(1).some((o) => Number(o) > 255)) return 'unknown'
    if (a === 127) return 'loopback'
    if (a === 10) return 'private'
    if (a === 172 && b >= 16 && b <= 31) return 'private'
    if (a === 192 && b === 168) return 'private'
    if (a === 169 && b === 254) return 'link-local'
    return 'public'
  }
  // IPv6 literals.
  if (h === '::1') return 'loopback'
  // Link-local is fe80::/10 — the leading hextet spans fe80 through febf (top
  // 10 bits fixed: 1111111010). Match the first two hex digits (fe) plus the
  // third digit constrained to 8..b, not just the `fe80` literal. The trailing
  // `:` covers both `fe80:...` and the compressed `fe80::...` (which begins `:`).
  if (/^fe[89ab][0-9a-f]:/.test(h)) return 'link-local'
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return 'private' // fc00::/7 unique-local
  if (h.includes(':')) return 'public'
  return 'unknown'
}

// Human-readable label per classification, for the trust-prompt string.
const _CLASSIFICATION_LABELS = {
  loopback: 'loopback',
  private: 'private LAN',
  'link-local': 'link-local',
  public: 'public',
  unknown: 'unknown',
}

// Order of "notability" when a host resolves to several addresses — the most
// internal wins the summary label so a remote server that ALSO resolves to an
// internal address surfaces that fact at consent time.
const _CLASSIFICATION_PRIORITY = ['loopback', 'private', 'link-local', 'public', 'unknown']

// #6852 — cap on the trust-prompt DNS lookup. resolveTrustAddress runs inside
// the fleet's withTrustStoreLock (byok-mcp-fleet.js), so a slow/hanging
// resolver would both delay the consent prompt AND hold the lock for every
// other MCP client. 2s is generous for a real resolver yet bounds the worst
// case; on timeout we fall back to the same graceful "could not resolve host".
export const DEFAULT_TRUST_DNS_TIMEOUT_MS = 2000

// Resolved by the timeout arm of the lookup race (distinct from any address the
// resolver could return), so a timeout maps to the graceful fallback.
const _LOOKUP_TIMEOUT = Symbol('trust-address-lookup-timeout')

function _summariseClassification(classifications) {
  for (const c of _CLASSIFICATION_PRIORITY) {
    if (classifications.includes(c)) return c
  }
  return 'unknown'
}

/**
 * Best-effort resolution of a remote MCP server url's host, for the first-use
 * trust prompt (#6834). Returns a small structured record describing WHERE the
 * host actually points so a user approving a 'remote' server can see when it
 * resolves to a loopback / private / internal address and make an informed
 * consent decision (owner decision 2026-07-18: display, don't block).
 *
 * Shape: `{ resolved, hostname, addresses, classification, display }`.
 *   - resolved:false + display 'could not resolve host' when the url is
 *     unparseable OR DNS lookup fails / returns nothing. NEVER throws.
 *   - a literal IP host is classified directly (no DNS round-trip).
 *   - a DNS name is resolved via `lookup(..., { all: true })`; the summary
 *     classification is the most-internal of the returned addresses.
 *
 * The `lookup` seam is injectable (defaults to node:dns/promises lookup — the
 * same resolver the transport's metadata guard uses) so tests never touch real
 * DNS. Credentials are NOT this function's concern: pass an already-redacted or
 * raw url — only the hostname is read, and only IPs are returned.
 *
 * The lookup is bounded by `timeoutMs` (#6852): resolveTrustAddress runs under
 * the fleet's trust-store lock, so a hanging resolver must not stall the prompt
 * or the lock — a timeout falls back to 'could not resolve host'. The timer
 * itself is injectable via `setTimer`/`clearTimer` (default node globals) so a
 * test can drive the timeout deterministically — firing it by hand instead of
 * waiting on the wall clock (#6908) — with no real DNS and no real timer.
 */
export async function resolveTrustAddress(
  url,
  {
    lookup = dnsLookup,
    timeoutMs = DEFAULT_TRUST_DNS_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  const miss = (hostname = null) => ({
    resolved: false,
    hostname,
    addresses: [],
    classification: 'unknown',
    display: 'could not resolve host',
  })
  let hostname
  try {
    hostname = new URL(url).hostname
  } catch {
    return miss()
  }
  if (!hostname) return miss()
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  // Short-circuit ONLY for a syntactically-valid IP literal. A dotted-quad-
  // shaped string with an out-of-range octet (e.g. 999.1.1.1) is NOT an IP —
  // classifyIpAddress returns 'unknown' — so it is really a hostname and must
  // go through the DNS path, not be echoed as a misleading "resolves to
  // 999.1.1.1". A bracketed / colon-bearing IPv6 host is always a literal.
  const looksLikeLiteral = /^[\d.]+$/.test(bare) || bare.includes(':')
  const literalClass = looksLikeLiteral ? classifyIpAddress(bare) : 'unknown'
  if (looksLikeLiteral && literalClass !== 'unknown') {
    return {
      resolved: true,
      hostname,
      addresses: [bare],
      classification: literalClass,
      display: `resolves to ${bare} (${_CLASSIFICATION_LABELS[literalClass] || literalClass})`,
    }
  }
  let timer
  try {
    // Bound the lookup: whichever settles first wins. The timeout arm RESOLVES
    // with a sentinel (never rejects) so a slow resolver maps to the graceful
    // fallback, not an error. Promise.race registers a reaction on the lookup
    // promise, so a late rejection from the loser stays handled. The timer is
    // NOT unref'd — it is always cleared in `finally` once the race settles, so
    // it never outlives this (awaited) resolution, and keeping the loop alive
    // while we resolve is the intended behaviour. `setTimer`/`clearTimer` are
    // injectable (default globals) so a test drives the timeout deterministically.
    const timeoutArm = new Promise((resolve) => {
      timer = setTimer(() => resolve(_LOOKUP_TIMEOUT), timeoutMs)
    })
    const addrs = await Promise.race([lookup(bare, { all: true }), timeoutArm])
    if (addrs === _LOOKUP_TIMEOUT) return miss(hostname)
    const addresses = (Array.isArray(addrs) ? addrs : [])
      .map((a) => (a && typeof a.address === 'string' ? a.address : null))
      .filter(Boolean)
    if (addresses.length === 0) return miss(hostname)
    const classifications = addresses.map(classifyIpAddress)
    const classification = _summariseClassification(classifications)
    return {
      resolved: true,
      hostname,
      addresses,
      classification,
      display: `resolves to ${addresses.join(', ')} (${_CLASSIFICATION_LABELS[classification] || classification})`,
    }
  } catch {
    return miss(hostname)
  } finally {
    clearTimer(timer)
  }
}

/**
 * Parse a remote (streamable-HTTP / SSE) MCP server entry (#6821). Claude
 * Code represents these in `~/.claude.json` as `{ "type": "http"|"sse",
 * "url": "https://...", "headers": { ... } }` — no `command`. Returns a
 * normalized `{ name, type, url, headers }` server or null (with a warning)
 * when the entry is unusable. Only http(s) urls are accepted; file:/ws:/etc.
 * are rejected so a config typo can't point the transport at a local socket.
 */
function parseRemoteEntry(name, entry, { warnings }) {
  const url = typeof entry.url === 'string' ? entry.url.trim() : ''
  if (!url) {
    warnings.push(`Skipping MCP server ${name}: url is required for a remote (http/sse) server`)
    return null
  }
  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    warnings.push(`Skipping MCP server ${name}: url is not a valid URL`)
    return null
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    warnings.push(`Skipping MCP server ${name}: url must be http(s) (got ${parsedUrl.protocol})`)
    return null
  }
  // #6834 sharp edge, folded in pre-merge: the cloud-metadata service /
  // link-local range is never a legitimate MCP server. Refused again at
  // request time in MCPRemoteClient for configs that bypass this parser.
  if (isBlockedMetadataHost(parsedUrl.hostname)) {
    warnings.push(`Skipping MCP server ${name}: url targets a cloud-metadata / link-local address (refused)`)
    return null
  }
  const rawType = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : ''
  // 'sse' selects the legacy HTTP+SSE two-endpoint transport; everything else
  // ('http', 'streamable-http', or an inferred remote with only a url) maps to
  // the modern Streamable HTTP transport.
  const type = rawType === 'sse' ? 'sse' : 'http'
  return {
    name,
    type,
    url,
    headers: coerceHeaders(entry.headers, { warnings, serverName: name }),
  }
}

/**
 * Parse a Claude-style MCP config object.
 *
 * Handles two server shapes (#6821):
 *   - stdio: `{ command, args, env }` — spawned as a local child process.
 *   - remote: `{ type: 'http'|'sse', url, headers }` — connected over the
 *     network. A remote entry is recognised by an explicit `type` of
 *     http/streamable-http/sse, or by carrying a `url` without a `command`.
 *
 * @param {unknown} raw
 * @returns {{ servers: Array<object>, warnings: string[] }}
 */
export function parseClaudeMcpConfig(raw) {
  const warnings = []
  const servers = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { servers, warnings: ['MCP config root must be an object'] }
  }
  const block = raw.mcpServers
  if (block == null) return { servers, warnings }
  if (typeof block !== 'object' || Array.isArray(block)) {
    return { servers, warnings: ['mcpServers must be an object'] }
  }

  for (const [name, entry] of Object.entries(block)) {
    if (!name) {
      warnings.push('Skipping MCP server with empty name')
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`Skipping MCP server ${name}: entry must be an object`)
      continue
    }
    const rawType = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : ''
    const hasCommand = typeof entry.command === 'string' && entry.command.length > 0
    const hasUrl = typeof entry.url === 'string' && entry.url.trim().length > 0
    const isRemote =
      rawType === 'http' || rawType === 'streamable-http' || rawType === 'sse' || (!hasCommand && hasUrl)
    // #7001 review: an entry carrying BOTH a command and a url is AMBIGUOUS —
    // whichever branch wins, the other field is dropped and the caller is never
    // told which transport it actually got. The read path stays lenient (it warns
    // and still resolves a usable server, so a hand-edited config keeps working),
    // but a WRITE escalates every warning to a rejection, so `add_mcp_server`
    // refuses it rather than silently persisting one of the two shapes.
    if (hasCommand && hasUrl) {
      warnings.push(
        `MCP server ${name}: ambiguous config — carries BOTH command (stdio) and url (remote); ` +
        `resolving as ${isRemote ? 'remote (command ignored)' : 'stdio (url ignored)'}. Specify exactly one transport.`,
      )
    }
    if (isRemote) {
      const remote = parseRemoteEntry(name, entry, { warnings })
      if (remote) servers.push(remote)
      continue
    }
    if (!hasCommand) {
      warnings.push(`Skipping MCP server ${name}: command is required`)
      continue
    }
    servers.push({
      name,
      command: entry.command,
      args: coerceStringArray(entry.args, { warnings, serverName: name }),
      env: coerceEnv(entry.env, { warnings, serverName: name }),
    })
  }
  return { servers, warnings }
}

/**
 * Read and parse a Claude-style MCP config file.
 *
 * @param {string} filePath
 * @returns {{ servers: Array<{ name: string, command: string, args: string[], env: Record<string, string> }>, warnings: string[], missing: boolean }}
 */
export function loadClaudeMcpConfig(filePath = defaultClaudeConfigPath()) {
  if (!filePath || !existsSync(filePath)) {
    return { servers: [], warnings: [], missing: true }
  }
  try {
    // statSync is cheap; do it before readFileSync so a pathologically large
    // file (see CLAUDE_CONFIG_MAX_BYTES) does not block startup.
    const stat = statSync(filePath)
    if (stat.size > CLAUDE_CONFIG_MAX_BYTES) {
      const warning = `MCP config ${filePath} exceeds size cap (${stat.size} bytes > ${CLAUDE_CONFIG_MAX_BYTES} bytes); skipping load`
      console.warn(`[byok-mcp-config] ${warning}`)
      return { servers: [], warnings: [warning], missing: false }
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    return { ...parseClaudeMcpConfig(raw), missing: false }
  } catch (err) {
    return {
      servers: [],
      warnings: [`Failed to parse MCP config ${filePath}: ${err?.message || String(err)}`],
      missing: false,
    }
  }
}

export function toMcpServerMetadata(server) {
  // Remote transport (#6821): expose the transport type + a credential-stripped
  // url + header KEY names only. Header values (bearer tokens, api keys) and any
  // url userinfo/query never appear in metadata that could reach a log or wire.
  if (typeof server.url === 'string' && server.url.length > 0) {
    return Object.freeze({
      name: server.name,
      type: server.type || 'http',
      url: redactMcpUrl(server.url),
      headerKeys: Object.freeze(Object.keys(server.headers || {}).sort()),
    })
  }
  return Object.freeze({
    name: server.name,
    command: server.command,
    args: Object.freeze([...server.args]),
    envKeys: Object.freeze(Object.keys(server.env).sort()),
  })
}

/**
 * Collect the NAMES of every configured MCP server in an `mcpServers` block,
 * without the exec-oriented validation `parseClaudeMcpConfig` applies.
 *
 * `parseClaudeMcpConfig` is built for the byok stdio exec path — it requires a
 * `command` and drops any entry without one. For pure VISIBILITY (#6820) we
 * want every declared server by name, including remote/HTTP transports (which
 * carry `url`/`type` instead of `command`). So this is deliberately lenient:
 * any key mapping to a non-null object counts. Malformed entries accumulate a
 * warning rather than throwing.
 *
 * @param {unknown} mcpBlock — the `mcpServers` object from a config source
 * @param {{ warnings: string[], source: string }} ctx
 * @returns {string[]} declared server names (order preserved)
 */
function collectConfiguredNames(mcpBlock, { warnings, source }) {
  const names = []
  if (mcpBlock == null) return names
  if (typeof mcpBlock !== 'object' || Array.isArray(mcpBlock)) {
    warnings.push(`${source}: mcpServers must be an object`)
    return names
  }
  for (const [name, entry] of Object.entries(mcpBlock)) {
    if (!name) {
      warnings.push(`${source}: skipping MCP server with empty name`)
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`${source}: skipping MCP server ${name} (entry must be an object)`)
      continue
    }
    names.push(name)
  }
  return names
}

/**
 * Resolve the project-scoped config block Claude Code stores under
 * `projects[<realpath(cwd)>]` in `~/.claude.json`. Claude keys these by the
 * realpath, so try that first and fall back to the literal `cwd` (a cwd that no
 * longer resolves — e.g. a removed test tmp dir — still matches a literal key).
 *
 * @param {unknown} raw — parsed `~/.claude.json`
 * @param {string} cwd
 * @returns {object|null}
 */
function resolveProjectBlock(raw, cwd) {
  if (!cwd) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const projects = raw.projects
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null
  let realCwd = cwd
  try {
    realCwd = realpathSync(cwd)
  } catch {
    // cwd may not exist (tests / stale dir) — fall through to the literal key.
  }
  if (Object.prototype.hasOwnProperty.call(projects, realCwd)) return projects[realCwd]
  if (Object.prototype.hasOwnProperty.call(projects, cwd)) return projects[cwd]
  return null
}

/**
 * Discover the CONFIGURED (not live-connected) MCP servers a Claude Code
 * session running in `cwd` would load. This is the honest fallback the
 * claude-tui provider uses (#6820): the interactive TUI communicates over a
 * PTY + hook payloads and exposes NO runtime MCP status, unlike the SDK/CLI
 * stream-json `system/init` event that carries live `mcp_servers` with real
 * connection status. So the TUI path can only report what the config DECLARES.
 *
 * Merges the three sources Claude Code itself reads, deduped by name (first
 * source wins on a name collision, matching read precedence):
 *   1. user/global scope  — `mcpServers` at the root of `~/.claude.json`
 *   2. project scope      — `projects[<realpath(cwd)>].mcpServers` in `~/.claude.json`
 *   3. project-local      — `mcpServers` in `<cwd>/.mcp.json`
 *
 * Never throws: each read is guarded and failures accumulate as warnings, so a
 * corrupt config can't take down session start.
 *
 * @param {string} cwd — the session's working directory
 * @param {{ configPath?: string }} [opts]
 * @returns {{ servers: Array<{ name: string }>, warnings: string[] }}
 */
export function discoverConfiguredMcpServers(cwd, { configPath = defaultClaudeConfigPath() } = {}) {
  const warnings = []
  const byName = new Map()
  const add = (names) => {
    for (const name of names) {
      if (!byName.has(name)) byName.set(name, { name })
    }
  }

  const readJson = (filePath, source) => {
    try {
      // statSync before readFileSync so a pathologically large file (see
      // CLAUDE_CONFIG_MAX_BYTES) doesn't block session start.
      const stat = statSync(filePath)
      if (stat.size > CLAUDE_CONFIG_MAX_BYTES) {
        warnings.push(
          `MCP config ${filePath} exceeds size cap (${stat.size} bytes > ${CLAUDE_CONFIG_MAX_BYTES} bytes); skipping load`,
        )
        return null
      }
      return JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (err) {
      warnings.push(`${source}: failed to read ${filePath}: ${err?.message || String(err)}`)
      return null
    }
  }

  // 1 + 2 — ~/.claude.json global root + project-scoped block.
  if (configPath && existsSync(configPath)) {
    const raw = readJson(configPath, 'user config')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      add(collectConfiguredNames(raw.mcpServers, { warnings, source: 'user config mcpServers' }))
      const projectBlock = resolveProjectBlock(raw, cwd)
      if (projectBlock && typeof projectBlock === 'object' && !Array.isArray(projectBlock)) {
        add(collectConfiguredNames(projectBlock.mcpServers, {
          warnings,
          source: 'project config mcpServers',
        }))
      }
    }
  }

  // 3 — <cwd>/.mcp.json project-local.
  if (cwd) {
    const mcpJsonPath = join(cwd, '.mcp.json')
    if (existsSync(mcpJsonPath)) {
      const raw = readJson(mcpJsonPath, 'project .mcp.json')
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        add(collectConfiguredNames(raw.mcpServers, {
          warnings,
          source: 'project .mcp.json mcpServers',
        }))
      }
    }
  }

  return { servers: [...byName.values()], warnings }
}

// ---------------------------------------------------------------------------
// #6974 — MCP server add/remove (config MUTATION).
//
// Everything above this line READS. This section is the only write path into
// `~/.claude.json`, a file this module's header explicitly calls out as "owned
// by Claude Code, not by us". We are a guest in someone else's file, so the
// rules below are deliberately conservative:
//
//   1. READ-MODIFY-WRITE, never generate. We parse the whole file, touch only
//      the one `mcpServers` key we were asked to, and write the rest back
//      byte-equivalent. Any key Claude Code owns (projects, history,
//      oauthAccount, …) survives untouched.
//   2. BAIL on a malformed file — never clobber. If the existing config is
//      unparseable we refuse the mutation with a clear error rather than
//      "recovering" by overwriting it with a fresh object. A user whose config
//      we cannot read is a user whose config we must not destroy.
//   3. ATOMIC + durable write (temp file + fsync + rename + parent-dir fsync).
//      A crash mid-write leaves the original file intact, never a truncated
//      one. See writeClaudeConfigAtomic for the mode-preservation rationale.
//   4. Persist only NORMALIZED entries. What lands on disk is rebuilt from
//      `parseClaudeMcpConfig`'s output, not copied from the caller's payload,
//      so a client cannot inject arbitrary keys into the user's config.
//
// Note on execution: adding a server does NOT itself execute anything. The
// live-fleet wiring (byok-mcp-fleet `addServer`) spawns through the SAME
// first-use trust gate as any other server, so the user still gets the
// `requestMcpTrust` prompt before a new command runs (#4457).
// ---------------------------------------------------------------------------

/**
 * Charset for a NEWLY ADDED MCP server name: a lowercase identifier — leading
 * lowercase letter, then lowercase letters / digits / dash / underscore, max 64
 * chars. Mirrors the `PROVIDER_ID_RE` "lowercase identifier" rule in
 * anthropic-compatible-config.js, widened by `_` because real MCP server names
 * use it (`ccd_session_mgmt`).
 *
 * Being a strict allow-list, this also forecloses a family of problems for free:
 * no `.` or `/` (so a name can never read as a path or traverse), no uppercase
 * (so two names can't collide case-insensitively), and no whitespace/control
 * characters (so a name can't be visually spoofed in the picker).
 */
export const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/

/**
 * Names that must never be used as an object key we assign into, regardless of
 * charset — assigning these shadows or mutates object internals. `__proto__` is
 * already refused by MCP_SERVER_NAME_RE (leading `_`), but `constructor` and
 * `prototype` are pure lowercase letters and WOULD pass it, so they are refused
 * explicitly here. Also applied on the removal path, which uses a laxer charset.
 */
const UNSAFE_MCP_SERVER_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Upper bound on a removable name. Removal accepts a much laxer charset than
 * `add` (see validateMcpServerNameForRemoval) so a server the `claude` CLI
 * created under a name Chroxy would not have minted is still removable.
 */
const MCP_SERVER_NAME_MAX = 256

/**
 * Validate a name for ADDING a server: the strict lowercase-identifier rule.
 *
 * Beyond the charset there is one non-obvious hard constraint: the name must not
 * contain `__`. MCP tools are namespaced on the wire as `mcp__<server>__<tool>`
 * and `parseMcpToolName` (src/mcp-tools.js) splits on the FIRST `__` after the
 * prefix — so a server named `a__b` would have its tools parsed as server `a`,
 * tool `b__…`, silently routing calls to the wrong (or a nonexistent) server.
 * Refuse it at the door rather than persisting a name that mis-routes.
 *
 * @param {unknown} name
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateNewMcpServerName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'MCP server name is required' }
  }
  if (UNSAFE_MCP_SERVER_NAMES.has(name)) {
    return { ok: false, error: `MCP server name '${name}' is reserved` }
  }
  if (!MCP_SERVER_NAME_RE.test(name)) {
    return {
      ok: false,
      error:
        `Invalid MCP server name ${JSON.stringify(name)}: expected a lowercase identifier ` +
        '(letters, digits, dash, underscore; must start with a letter, max 64 chars)',
    }
  }
  if (name.includes('__')) {
    return {
      ok: false,
      error:
        `Invalid MCP server name ${JSON.stringify(name)}: '__' is the MCP tool-namespace ` +
        'separator (mcp__<server>__<tool>) and would mis-route this server\'s tools',
    }
  }
  return { ok: true, name }
}

/**
 * Validate a name for REMOVING a server. Deliberately laxer than the add rule:
 * a server configured by the `claude` CLI (or hand-edited) may carry a name
 * Chroxy would never mint — uppercase, dots, whatever — and the user must still
 * be able to remove it. So this only refuses what is genuinely unsafe to use as
 * a lookup/delete key: empty, over-long, control characters, or a reserved key.
 * Removal cannot create anything, so no charset policy is warranted.
 *
 * @param {unknown} name
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateMcpServerNameForRemoval(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'MCP server name is required' }
  }
  if (name.length > MCP_SERVER_NAME_MAX) {
    return { ok: false, error: `MCP server name exceeds ${MCP_SERVER_NAME_MAX} characters` }
  }
  if (UNSAFE_MCP_SERVER_NAMES.has(name)) {
    return { ok: false, error: `MCP server name '${name}' is reserved` }
  }
  if (/[\x00-\x1f\x7f]/.test(name)) {
    return { ok: false, error: 'MCP server name must not contain control characters' }
  }
  return { ok: true, name }
}

/**
 * Validate + normalize a proposed server config into the exact object to
 * persist. Validation is delegated to `parseClaudeMcpConfig` — the SAME parser
 * the read path uses — by round-tripping a single-entry probe block through it,
 * so a config we accept for writing is by construction a config we can read
 * back. Two deliberate tightenings over the read path:
 *
 *   - the read path is LENIENT (it coerces a bad `args[3]` away with a warning
 *     and carries on, because a partly-usable config beats no session). A WRITE
 *     must not silently persist something other than what the user asked for, so
 *     ANY warning is escalated to a rejection.
 *   - the persisted entry is rebuilt from the parser's normalized output, so
 *     unknown/extra keys in the caller's payload are dropped rather than written
 *     into the user's config.
 *
 * @param {string} name — already validated by validateNewMcpServerName
 * @param {unknown} config
 * @returns {{ ok: true, entry: object } | { ok: false, error: string }}
 */
export function normalizeMcpServerConfig(name, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, error: 'MCP server config must be an object' }
  }
  // A computed key always defines an OWN property (unlike a literal
  // `__proto__:`), and `name` is validated upstream, so this probe cannot be
  // turned into a prototype write.
  const { servers, warnings } = parseClaudeMcpConfig({ mcpServers: { [name]: config } })
  if (servers.length !== 1) {
    return {
      ok: false,
      error: warnings[0] || `config for '${name}' is not a usable MCP server entry`,
    }
  }
  if (warnings.length > 0) return { ok: false, error: warnings[0] }

  const parsed = servers[0]
  // Remote (http/sse) transport — persist type + url + non-empty headers only.
  if (typeof parsed.url === 'string' && parsed.url.length > 0) {
    const entry = { type: parsed.type, url: parsed.url }
    if (Object.keys(parsed.headers || {}).length > 0) entry.headers = { ...parsed.headers }
    return { ok: true, entry }
  }
  // stdio transport — persist command + non-empty args/env only, so a minimal
  // add produces a minimal diff in the user's file.
  const entry = { command: parsed.command }
  if (parsed.args.length > 0) entry.args = [...parsed.args]
  if (Object.keys(parsed.env || {}).length > 0) entry.env = { ...parsed.env }
  return { ok: true, entry }
}

/**
 * Read `~/.claude.json` for a read-modify-write cycle.
 *
 * Unlike `loadClaudeMcpConfig` (which fails OPEN — a corrupt config yields an
 * empty server list so session start survives), this fails CLOSED: a file we
 * cannot parse is a file we must not overwrite, so every unreadable/malformed
 * case returns `ok: false` and the caller aborts the mutation. A MISSING file is
 * not an error — it is the first-write case and yields an empty object.
 *
 * @param {string} filePath
 * @returns {{ ok: true, raw: object, mode: number|null, existed: boolean } | { ok: false, error: string }}
 */
export function readClaudeConfigForMutation(filePath) {
  if (!filePath) return { ok: false, error: 'No Claude config path resolved' }
  if (!existsSync(filePath)) {
    // First write — we create the file. `mode: null` tells the writer to use a
    // fresh-file default (0600) rather than preserving anything.
    return { ok: true, raw: {}, mode: null, existed: false }
  }
  let stat
  try {
    stat = statSync(filePath)
  } catch (err) {
    return { ok: false, error: `Cannot stat ${filePath}: ${err?.message || String(err)}` }
  }
  if (stat.size > CLAUDE_CONFIG_MAX_BYTES) {
    return {
      ok: false,
      error: `Config ${filePath} exceeds the ${CLAUDE_CONFIG_MAX_BYTES}-byte cap (${stat.size} bytes); refusing to rewrite it`,
    }
  }
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    return { ok: false, error: `Cannot read ${filePath}: ${err?.message || String(err)}` }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    // The parser's message can quote surrounding bytes (which may include a
    // token from elsewhere in the file), so it is deliberately NOT echoed.
    return {
      ok: false,
      error: `Config ${filePath} is not valid JSON; refusing to overwrite it. Fix or move the file, then retry.`,
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `Config ${filePath} root must be a JSON object; refusing to overwrite it` }
  }
  return { ok: true, raw, mode: stat.mode & 0o777, existed: true }
}

/**
 * #7002 — resolve the path the atomic write must actually LAND on.
 *
 * The write is `writeFileSync(tmp)` → `renameSync(tmp, dest)`, and `rename(2)`
 * replaces the FINAL PATH COMPONENT itself. If that component is a symlink — the
 * common dotfiles-repo arrangement, `~/.claude.json` → `~/dotfiles/claude.json` —
 * the rename destroys the LINK and leaves a regular file in its place: the user's
 * dotfiles link silently disappears and their real config stops receiving
 * updates. (The read path follows the link, so nothing complains.) So a symlinked
 * destination must be resolved to its target and written THERE.
 *
 * TRUST ASSUMPTION, stated plainly: `~/.claude.json` and any link the user has
 * put in its place are USER-OWNED, USER-AUTHORED configuration. We follow the
 * link because a user who symlinked their own config meant it. What we do NOT do
 * is follow it blindly — resolving a symlink and writing to whatever it points at
 * is precisely how a planted link turns "write my config" into "write an arbitrary
 * file", so the resolved target must satisfy all of:
 *
 *   - it resolves at all (a DANGLING link is refused, not materialized — creating
 *     the missing target would be us inventing a file at an attacker-chosen path)
 *   - it is a REGULAR file (no directory, fifo, socket or device)
 *   - it is owned by the uid we run as (a link into another user's file is refused)
 *
 * RACE HONESTY: resolution happens ONCE, and the subsequent `rename` re-walks the
 * path by name, so an attacker who can replace the link between the two syscalls
 * can still redirect the write (classic TOCTOU). This is NOT closed here — POSIX
 * offers no "rename onto this exact inode" primitive to close it with. The
 * residual exposure requires write access to the user's own `$HOME`, which is
 * already game over for a config the daemon reads and executes commands from;
 * see the follow-up issue referenced in the PR for a fully race-free design.
 *
 * @param {string} filePath
 * @returns {{ ok: true, path: string, viaSymlink: boolean } | { ok: false, error: string }}
 */
export function resolveClaudeConfigWritePath(filePath) {
  let link
  try {
    link = lstatSync(filePath)
  } catch {
    // Missing (the first-write case) or unstattable — write the path as given,
    // exactly as before this fix.
    return { ok: true, path: filePath, viaSymlink: false }
  }
  if (!link.isSymbolicLink()) return { ok: true, path: filePath, viaSymlink: false }

  let resolved
  try {
    resolved = realpathSync(filePath)
  } catch (err) {
    return {
      ok: false,
      error: `${filePath} is a symlink whose target cannot be resolved (${err?.code || err?.message || String(err)}); refusing to replace the link with a regular file. Fix or remove the link, then retry.`,
    }
  }
  let target
  try {
    target = lstatSync(resolved)
  } catch (err) {
    return {
      ok: false,
      error: `${filePath} is a symlink to ${resolved}, which cannot be stat'd (${err?.code || err?.message || String(err)}); refusing to write through it.`,
    }
  }
  if (!target.isFile()) {
    return {
      ok: false,
      error: `${filePath} is a symlink to ${resolved}, which is not a regular file; refusing to write through it.`,
    }
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && target.uid !== uid) {
    return {
      ok: false,
      error: `${filePath} is a symlink to ${resolved}, which is owned by uid ${target.uid} rather than uid ${uid}; refusing to write through it.`,
    }
  }
  return { ok: true, path: resolved, viaSymlink: true }
}

/**
 * #7002 — the residual risk of PRESERVING a destination's mode.
 *
 * `writeClaudeConfigAtomic` deliberately does not force 0600 on a file the user
 * (or Claude Code) already owns. That is the right call for permissions, but it
 * leaves one case where Chroxy is the party making things worse: an existing
 * config that is group/world-readable, plus a new entry carrying `env` or
 * `headers` — the two fields that routinely hold API tokens. We do not silently
 * re-permission the file; we say so loudly instead, naming the file and its mode,
 * so the user can tighten it themselves.
 *
 * Returns `null` when there is nothing to warn about (owner-only mode, no
 * secret-bearing field, or a file WE created — those get 0600). The message never
 * echoes a secret VALUE, only the field names.
 *
 * @param {{ filePath: string, mode: number|null|undefined, entry: object }} args
 * @returns {string|null}
 */
export function describeConfigModeSecretWarning({ filePath, mode, entry } = {}) {
  if (mode === null || mode === undefined) return null
  // The trigger is the WHOLE `0o077` superset, not just the read bits, and the
  // wording says "accessible" rather than "readable" to match it (review of
  // #7040). Group/other WRITE is the sharper edge, not a lesser one: another
  // local user who can rewrite `~/.claude.json` substitutes MCP server commands
  // the daemon then spawns. Including the (meaningless-on-a-JSON-file) execute
  // bit costs at most a harmless false positive on a pathological mode like
  // 0o611, which is the right side to err on for a security advisory.
  const otherBits = mode & 0o077
  if (otherBits === 0) return null
  const fields = ['env', 'headers'].filter((key) => {
    const value = entry?.[key]
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
  })
  if (fields.length === 0) return null
  const octal = (mode & 0o777).toString(8).padStart(3, '0')
  return (
    `${filePath} is mode ${octal} (accessible beyond its owner) and the MCP server entry just added carries ` +
    `${fields.join(' and ')}, which commonly hold API tokens. Chroxy preserved the file's existing permissions ` +
    `rather than changing them — tighten it yourself with: chmod 600 ${filePath}`
  )
}

/**
 * Atomically write the mutated config back.
 *
 * temp file → exact mode → fsync(file) → rename → fsync(parent dir), the same
 * shape as `writeFileRestricted(..., { durable: true })` in platform.js, with
 * one deliberate difference: this PRESERVES the destination's existing mode
 * instead of forcing 0600. `~/.claude.json` belongs to Claude Code; silently
 * re-permissioning a user's file as a side effect of "add an MCP server" is not
 * ours to do. A file we CREATE gets 0600 (it can hold OAuth material).
 *
 * The write is durable (fsync before rename, dir fsync after) on BOTH add and
 * remove. Remove is the load-bearing case — it is a capability REDUCTION, and
 * the #6914/#6927 precedent is that a security-tightening write must survive
 * power loss rather than silently reappearing after a crash. Add rides the same
 * path because one code path is cheaper to keep correct than two, and the cost
 * (one fsync of a few KB, on an operation a user performs rarely) is noise.
 *
 * A SYMLINKED destination is written THROUGH (the link survives, its target gets
 * the bytes) or refused — never replaced. See `resolveClaudeConfigWritePath` for
 * the trust assumption and the race caveat (#7002).
 *
 * SHARED, not byok-local: `claude-tui/pty-driver.js`'s `ensureCwdTrusted` (the
 * DEFAULT provider's trust pre-write, which runs on far more start()s than any
 * MCP mutation) commits through this function too (#7046). Callers that need
 * "best effort" — a refusal must not fail session start — catch and log; callers
 * that owe the user an answer surface the error.
 *
 * @param {string} filePath
 * @param {object} value — the full config object to serialize
 * @param {{ mode: number|null }} opts — `null` mode = new file, use 0600
 */
export function writeClaudeConfigAtomic(filePath, value, { mode }) {
  const resolved = resolveClaudeConfigWritePath(filePath)
  if (!resolved.ok) throw new Error(resolved.error)
  // Everything below targets the RESOLVED path: the sidecar has to live in the
  // target's directory (rename is only atomic within one filesystem, and a
  // dotfiles target is frequently on a different one from $HOME), and the
  // dir-fsync has to be the target's directory too.
  const destPath = resolved.path
  const payload = `${JSON.stringify(value, null, 2)}\n`
  const targetMode = mode === null || mode === undefined ? 0o600 : mode
  // Per-call random suffix, NOT process.pid: concurrent sessions in one daemon
  // share a pid and would race for the same sidecar path (#3922).
  const tmpPath = `${destPath}.chroxy.${randomUUID()}.tmp`
  try {
    // `mode` is only honoured on create, and umask can strip bits from it — so
    // restate the exact mode afterwards. The intermediate mode can only ever be
    // TIGHTER than the target (umask removes bits, never adds), so there is no
    // window in which the temp file is more permissive than the destination
    // already was.
    writeFileSync(tmpPath, payload, { mode: targetMode })
    chmodSync(tmpPath, targetMode)
    fsyncForDurability(tmpPath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* nothing to clean up */ }
    throw err
  }
  // A failing rename (EXDEV, FS quota, ACL) would otherwise leave the sidecar
  // behind — and this sidecar is not inert: it holds the full config, including
  // any `env` / `headers` the caller just supplied. Unlink it and re-throw the
  // ORIGINAL rename error, not a cleanup-side ENOENT. Same shape as the #4463 fix
  // in byok-mcp-trust.js `recordTrust`.
  try {
    renameSync(tmpPath, destPath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* may already be gone */ }
    throw err
  }
  // Make the rename itself durable, not just the bytes it points at.
  //
  // #7054/#7067: this used to be an UNWRAPPED call, so a post-rename
  // directory-fsync failure THREW — after the rename had already published the
  // file. The write succeeded; only its directory entry's durability was
  // unproven. Both callers were harmed by that lie: `ensureCwdTrusted` treats a
  // throw as "skip the pre-write", so the user got claude's trust dialog for a
  // trust write that had actually landed; the MCP add/remove paths reported a
  // failure for a config change that was on disk. Shared verdict now — report,
  // never throw — via the one implementation in platform.js.
  return confirmRenameDurable(destPath, { durable: true })
}

/**
 * Resolve the `projects` key under which cwd's config block lives, for a WRITE.
 *
 * Claude Code keys project blocks by `realpath(cwd)`. Reads tolerate either
 * spelling (see resolveProjectBlock), so a write must target the key that
 * ALREADY exists — writing the realpath when a literal-cwd key is present would
 * create a second, shadowed block that the read path never reaches. Falls back
 * to the realpath (or literal cwd, if it does not resolve) as the key to create.
 *
 * @param {object} raw — parsed config
 * @param {string} cwd
 * @returns {string} the projects key to read/write
 */
function resolveProjectKeyForWrite(raw, cwd) {
  let realCwd = cwd
  try {
    realCwd = realpathSync(cwd)
  } catch {
    // cwd may not resolve (removed dir) — the literal key is the best we have.
  }
  const projects = raw?.projects
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    if (Object.prototype.hasOwnProperty.call(projects, realCwd)) return realCwd
    if (Object.prototype.hasOwnProperty.call(projects, cwd)) return cwd
  }
  return realCwd
}

/** The config scopes a mutation may target. */
export const MCP_WRITE_SCOPES = Object.freeze(['user', 'project'])

/**
 * Why `.mcp.json` is NOT a writable scope: the third read source
 * (`<cwd>/.mcp.json`) is a project-local file that is normally checked into the
 * user's git repository. Mutating it from a chat client would dirty their
 * working tree and could land in a commit unnoticed. Both writable scopes live
 * in `~/.claude.json`, which is machine-local user state.
 */

/**
 * Everything `addMcpServerToConfig` does EXCEPT the write: validate the name and
 * scope, normalize the config, read the existing file, locate the target block,
 * and refuse a duplicate name. Returns the located block + parsed tree so the
 * caller can either commit (write) or discard (plan).
 *
 * Split out for #7001's deny-before-write ordering: the trust prompt has to run
 * BEFORE anything is persisted, and prompting for an add that was going to fail
 * validation or EXISTS anyway is both bad UX and a needless prompt. `raw` is a
 * per-call freshly-parsed tree, so the plan path mutating it (creating an empty
 * `mcpServers` block) is discarded harmlessly.
 *
 * The commit path re-runs this, so the read→check→write critical section stays
 * synchronous and `await`-free: a plan result is ADVISORY, never the authority.
 */
function prepareAddMcpServer({ name, config, scope = 'user', cwd, configPath = defaultClaudeConfigPath() } = {}) {
  const validName = validateNewMcpServerName(name)
  if (!validName.ok) return { ok: false, error: validName.error }
  if (!MCP_WRITE_SCOPES.includes(scope)) {
    return { ok: false, error: `Unknown MCP config scope '${scope}' (expected 'user' or 'project')` }
  }
  if (scope === 'project' && (typeof cwd !== 'string' || cwd.length === 0)) {
    return { ok: false, error: 'Project scope requires a session working directory' }
  }
  const normalized = normalizeMcpServerConfig(validName.name, config)
  if (!normalized.ok) return { ok: false, error: normalized.error }

  // Read-modify-write, synchronously and with no `await` in between, so the
  // window in which a concurrent `claude` CLI edit could be lost is the syscall
  // span rather than an event-loop turn. (A cross-process lock is not available
  // — `claude` takes none — so narrowing the window is the honest ceiling.)
  const read = readClaudeConfigForMutation(configPath)
  if (!read.ok) return { ok: false, error: read.error }
  const raw = read.raw

  let block
  if (scope === 'user') {
    if (raw.mcpServers != null && (typeof raw.mcpServers !== 'object' || Array.isArray(raw.mcpServers))) {
      return { ok: false, error: 'Existing user-scope mcpServers is not an object; refusing to replace it' }
    }
    if (raw.mcpServers == null) raw.mcpServers = {}
    block = raw.mcpServers
  } else {
    if (raw.projects != null && (typeof raw.projects !== 'object' || Array.isArray(raw.projects))) {
      return { ok: false, error: 'Existing projects block is not an object; refusing to replace it' }
    }
    if (raw.projects == null) raw.projects = {}
    const key = resolveProjectKeyForWrite(raw, cwd)
    const existing = raw.projects[key]
    if (existing != null && (typeof existing !== 'object' || Array.isArray(existing))) {
      return { ok: false, error: `Existing project block for ${key} is not an object; refusing to replace it` }
    }
    // Preserve every other key Claude Code keeps on the project block
    // (allowedTools, history, …) — only mcpServers is ours to touch.
    if (existing == null) raw.projects[key] = {}
    const projectBlock = raw.projects[key]
    if (projectBlock.mcpServers != null && (typeof projectBlock.mcpServers !== 'object' || Array.isArray(projectBlock.mcpServers))) {
      return { ok: false, error: `Existing project-scope mcpServers for ${key} is not an object; refusing to replace it` }
    }
    if (projectBlock.mcpServers == null) projectBlock.mcpServers = {}
    block = projectBlock.mcpServers
  }

  if (Object.prototype.hasOwnProperty.call(block, validName.name)) {
    return {
      ok: false,
      code: 'EXISTS',
      error: `An MCP server named '${validName.name}' already exists in ${scope} scope. Remove it first to replace it.`,
    }
  }
  return { ok: true, raw, block, mode: read.mode, entry: normalized.entry, scope, name: validName.name, configPath }
}

/**
 * #7001: DRY-RUN of an add — every check `addMcpServerToConfig` performs, with no
 * write. Returns the exact normalized `entry` that WOULD be persisted, so a caller
 * can obtain the user's spawn-trust decision for that precise config before
 * anything reaches disk (a denied add must leave no config entry behind).
 *
 * @returns {{ ok: true, entry: object, scope: string } | { ok: false, error: string, code?: string }}
 */
export function planAddMcpServerToConfig(opts = {}) {
  const prepared = prepareAddMcpServer(opts)
  if (!prepared.ok) return prepared.code ? { ok: false, error: prepared.error, code: prepared.code } : { ok: false, error: prepared.error }
  return { ok: true, entry: prepared.entry, scope: prepared.scope }
}

/**
 * Add (or refuse to overwrite) one MCP server in the user's config.
 *
 * Scope selects WHERE: 'user' → the root `mcpServers` block; 'project' →
 * `projects[<realpath(cwd)>].mcpServers`. There is no "wherever it fits"
 * fallback — an ambiguous write to a user's config is worse than an error.
 *
 * Refuses (rather than overwrites) an existing name in the target scope: an
 * overwrite would silently replace a command the user trusts with a different
 * one, which is exactly the substitution the trust store exists to prevent.
 *
 * NOTE (#7001): this is the COMMIT. On the WS add path the caller must already
 * have obtained the user's spawn-trust decision (via `planAddMcpServerToConfig`)
 * — persisting first and prompting afterwards leaves a denied server configured.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {unknown} opts.config
 * @param {'user'|'project'} [opts.scope]
 * @param {string} [opts.cwd] — required for scope 'project'
 * @param {string} [opts.configPath]
 * @returns {{ ok: true, entry: object, scope: string, warning?: string } | { ok: false, error: string, code?: string }}
 */
export function addMcpServerToConfig(opts = {}) {
  const prepared = prepareAddMcpServer(opts)
  if (!prepared.ok) return prepared.code ? { ok: false, error: prepared.error, code: prepared.code } : { ok: false, error: prepared.error }
  prepared.block[prepared.name] = prepared.entry
  writeClaudeConfigAtomic(prepared.configPath, prepared.raw, { mode: prepared.mode })
  // #7002: computed from the mode we just PRESERVED and the entry we just wrote,
  // so it only fires when Chroxy is the party that put secret material into a
  // group/world-readable file. Advisory — we still do not re-permission the file.
  const warning = describeConfigModeSecretWarning({
    filePath: prepared.configPath,
    mode: prepared.mode,
    entry: prepared.entry,
  })
  const result = { ok: true, entry: prepared.entry, scope: prepared.scope }
  if (warning) result.warning = warning
  return result
}

/**
 * Remove one MCP server from the user's config, in the named scope only.
 *
 * Returns `found: false` (no write performed) when the name is absent from the
 * REQUESTED scope, even if it exists in the other one — a remove that silently
 * jumped scope could delete a shared user-scope server when the caller meant to
 * detach a project-scope one. The caller surfaces the scope in its error so a
 * client can retry against the right one.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {'user'|'project'} [opts.scope]
 * @param {string} [opts.cwd] — required for scope 'project'
 * @param {string} [opts.configPath]
 * @returns {{ ok: true, found: boolean, scope: string } | { ok: false, error: string }}
 */
export function removeMcpServerFromConfig({ name, scope = 'user', cwd, configPath = defaultClaudeConfigPath() } = {}) {
  const validName = validateMcpServerNameForRemoval(name)
  if (!validName.ok) return { ok: false, error: validName.error }
  if (!MCP_WRITE_SCOPES.includes(scope)) {
    return { ok: false, error: `Unknown MCP config scope '${scope}' (expected 'user' or 'project')` }
  }
  if (scope === 'project' && (typeof cwd !== 'string' || cwd.length === 0)) {
    return { ok: false, error: 'Project scope requires a session working directory' }
  }

  const read = readClaudeConfigForMutation(configPath)
  if (!read.ok) return { ok: false, error: read.error }
  if (!read.existed) return { ok: true, found: false, scope }
  const raw = read.raw

  let block = null
  if (scope === 'user') {
    if (raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)) {
      block = raw.mcpServers
    }
  } else {
    const projects = raw.projects
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      const key = resolveProjectKeyForWrite(raw, cwd)
      const projectBlock = Object.prototype.hasOwnProperty.call(projects, key) ? projects[key] : null
      if (projectBlock && typeof projectBlock === 'object' && !Array.isArray(projectBlock)) {
        const servers = projectBlock.mcpServers
        if (servers && typeof servers === 'object' && !Array.isArray(servers)) block = servers
      }
    }
  }
  if (!block || !Object.prototype.hasOwnProperty.call(block, validName.name)) {
    // Nothing to do — and crucially, NO write. A no-op remove must not rewrite
    // the user's file (nor risk clobbering a concurrent edit for nothing).
    return { ok: true, found: false, scope }
  }

  delete block[validName.name]
  writeClaudeConfigAtomic(configPath, raw, { mode: read.mode })
  return { ok: true, found: true, scope }
}
