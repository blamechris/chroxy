/**
 * #6999 — client-side mirror of the server's `add_mcp_server` validation.
 *
 * The authoritative rules live server-side in
 * `packages/server/src/byok-mcp-config.js` (`MCP_SERVER_NAME_RE`,
 * `validateNewMcpServerName`, `UNSAFE_MAP_KEYS` / `UNSAFE_MCP_SERVER_NAMES`,
 * and the ambiguous-transport check in `parseClaudeMcpConfig`). This module
 * exists ONLY to give the add-server form a fast, clear error before the
 * round-trip — the server re-validates from scratch on write and is the sole
 * authority (`normalizeMcpServerConfig`), so drift here can make the form too
 * STRICT (annoying, caught immediately) but never too lenient in a way that
 * reaches disk.
 *
 * Do not let this drift from byok-mcp-config.js — if the server's rules
 * change, update both in the same PR.
 */

import type { McpServerConfigInput } from '../store/types';

/** Mirrors `MCP_SERVER_NAME_RE` in byok-mcp-config.js exactly. */
export const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Mirrors `UNSAFE_MCP_SERVER_NAMES` / `UNSAFE_MAP_KEYS` in byok-mcp-config.js
 * — reserved because assigning them as an object key shadows or mutates
 * object internals, regardless of charset.
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Mirrors `isBlockedMetadataHost` in byok-mcp-config.js — the cloud-metadata
 * service / IPv4 link-local range (169.254.0.0/16, including its IPv4-mapped
 * IPv6 forms) plus the AWS IMDS IPv6 endpoint. The server enforces this
 * independently at write time (and again at request time); this is purely a
 * client-side head start on the same narrow check.
 */
function isBlockedMetadataHost(hostname: string): boolean {
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) return Number(v4[1]) === 169 && Number(v4[2]) === 254;
  if (/^::ffff:a9fe:[0-9a-f]{1,4}$/.test(h)) return true;
  const mapped = h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (mapped) return Number(mapped[1]) === 169 && Number(mapped[2]) === 254;
  if (h === 'fd00:ec2::254' || h === 'fd00:ec2:0:0:0:0:0:254') return true;
  return false;
}

/**
 * Validate a proposed server NAME for adding (the strict charset — mirrors
 * `validateNewMcpServerName`). Returns an error string, or `null` when valid.
 * Check order matches the server: reserved name, charset, then the `__`
 * tool-namespace-separator rule.
 */
export function validateMcpServerName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name is required.';
  if (RESERVED_KEYS.has(trimmed)) return `'${trimmed}' is a reserved name.`;
  if (!MCP_SERVER_NAME_RE.test(trimmed)) {
    return 'Name must be a lowercase identifier: letters, digits, dash, underscore; must start with a letter; max 64 characters.';
  }
  if (trimmed.includes('__')) {
    return "'__' is the MCP tool-namespace separator (mcp__<server>__<tool>) and would mis-route this server's tools.";
  }
  return null;
}

/** Mirrors the `env`/`headers` reserved-key refusal (`UNSAFE_MAP_KEYS`). */
function validateKeyMap(map: Record<string, string> | undefined, label: string): string | null {
  if (!map) return null;
  for (const key of Object.keys(map)) {
    if (RESERVED_KEYS.has(key)) return `${label} key '${key}' is reserved and cannot be used.`;
  }
  return null;
}

/**
 * Validate a candidate `config` payload. Returns the first error found, or
 * `null` when it looks safe to submit. Order mirrors the server: ambiguous
 * transport, then missing transport, then per-transport field checks.
 */
export function validateMcpServerConfig(config: McpServerConfigInput): string | null {
  const hasCommand = typeof config.command === 'string' && config.command.trim().length > 0;
  const hasUrl = typeof config.url === 'string' && config.url.trim().length > 0;

  // #7001-mirrored rule: a config carrying BOTH is ambiguous — the server
  // refuses it outright on write rather than silently picking one transport.
  if (hasCommand && hasUrl) {
    return 'A server config cannot carry both a command (stdio) and a url (remote) — pick exactly one transport.';
  }
  if (!hasCommand && !hasUrl) {
    return 'Provide either a command (stdio) or a url (remote).';
  }

  if (hasUrl) {
    let parsed: URL;
    try {
      parsed = new URL(config.url!.trim());
    } catch {
      return 'url is not a valid URL.';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `url must be http(s) (got ${parsed.protocol}).`;
    }
    if (isBlockedMetadataHost(parsed.hostname)) {
      return 'url targets a cloud-metadata / link-local address and is refused.';
    }
    return validateKeyMap(config.headers, 'headers');
  }

  return validateKeyMap(config.env, 'env');
}
