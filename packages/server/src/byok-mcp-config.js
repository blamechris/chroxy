/**
 * MCP config discovery for the claude-byok provider.
 *
 * Foundation only for #4048/#4076: parse Claude-style mcpServers blocks and
 * expose safe read-only metadata. This module deliberately does not spawn MCP
 * children or wire tools.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lookup as dnsLookup } from 'node:dns/promises'

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
  if (h.startsWith('fe80:') || h.startsWith('fe80::')) return 'link-local'
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
 */
export async function resolveTrustAddress(url, { lookup = dnsLookup } = {}) {
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
  const isLiteral = /^[\d.]+$/.test(bare) || bare.includes(':')
  if (isLiteral) {
    const classification = classifyIpAddress(bare)
    return {
      resolved: true,
      hostname,
      addresses: [bare],
      classification,
      display: `resolves to ${bare} (${_CLASSIFICATION_LABELS[classification] || classification})`,
    }
  }
  try {
    const addrs = await lookup(bare, { all: true })
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
