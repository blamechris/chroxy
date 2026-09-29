/**
 * #6999 — client-side mirror of the server's `add_mcp_server` validation.
 *
 * The authoritative rules live server-side in
 * `packages/server/src/byok-mcp-config.js` (`validateNewMcpServerName` and
 * the ambiguous-transport check in `parseClaudeMcpConfig`). This module
 * exists ONLY to give the add-server form a fast, clear error before the
 * round-trip — the server re-validates from scratch on write and is the sole
 * authority (`normalizeMcpServerConfig`), so drift here can make the form too
 * STRICT (annoying, caught immediately) but never too lenient in a way that
 * reaches disk.
 *
 * #7030 — the security-adjacent constants (`MCP_SERVER_NAME_RE`, the
 * reserved-key set, `isBlockedMetadataHost`) used to be hand-duplicated here;
 * they now come from `@chroxy/protocol/mcp-validation`, the same module
 * `byok-mcp-config.js` imports, so the two can no longer drift.
 */

import type { McpServerConfigInput } from '../store/types';
import {
  MCP_SERVER_NAME_RE,
  UNSAFE_MCP_KEYS,
  containsMcpToolNamespaceSeparator,
  isBlockedMetadataHost,
} from '@chroxy/protocol/mcp-validation';

export { MCP_SERVER_NAME_RE };

/**
 * Validate a proposed server NAME for adding (the strict charset — mirrors
 * `validateNewMcpServerName`). Returns an error string, or `null` when valid.
 * Check order matches the server: reserved name, charset, then the `__`
 * tool-namespace-separator rule.
 */
export function validateMcpServerName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name is required.';
  if (UNSAFE_MCP_KEYS.has(trimmed)) return `'${trimmed}' is a reserved name.`;
  if (!MCP_SERVER_NAME_RE.test(trimmed)) {
    return 'Name must be a lowercase identifier: letters, digits, dash, underscore; must start with a letter; max 64 characters.';
  }
  if (containsMcpToolNamespaceSeparator(trimmed)) {
    return "'__' is the MCP tool-namespace separator (mcp__<server>__<tool>) and would mis-route this server's tools.";
  }
  return null;
}

/** Mirrors the `env`/`headers` reserved-key refusal (`UNSAFE_MCP_KEYS`). */
function validateKeyMap(map: Record<string, string> | undefined, label: string): string | null {
  if (!map) return null;
  for (const key of Object.keys(map)) {
    if (UNSAFE_MCP_KEYS.has(key)) return `${label} key '${key}' is reserved and cannot be used.`;
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
