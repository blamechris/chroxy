/**
 * Shared MCP server-name / reserved-key / metadata-host validation (#7030).
 *
 * SINGLE SOURCE for the security-adjacent constants that used to be
 * hand-duplicated in `packages/server/src/byok-mcp-config.js` (the
 * authority — it re-validates from scratch on write and is the sole
 * authority for `~/.claude.json`) and
 * `packages/dashboard/src/lib/mcp-server-validation.ts` (a client-side
 * fast pre-check that gives the add-server form an early error before the
 * round-trip). The copies were verified byte-identical at review time
 * (#6999 / #7001), but hand-duplicated security-adjacent constants are
 * precisely how #6986 and #7001 happened: one copy gets updated and the
 * other quietly doesn't. This module is now the ONLY place these rules are
 * spelled out; both packages import from here.
 *
 * **Zod-free by design**, exported from the `@chroxy/protocol/mcp-validation`
 * subpath rather than the root barrel: the root barrel re-exports `./schemas`,
 * which pulls in the whole Zod dependency graph. `byok-mcp-config.js` — the
 * module that parses `~/.claude.json` on every session start and every
 * trust/consent decision — has ZERO existing dependency on `@chroxy/protocol`;
 * importing the root here would newly load Zod into that hot path just to
 * read a regex and a Set. This mirrors the same Zod-free convention already
 * used for `./project` (audit P2-2, #5850) and `./handler-coverage` (#6021).
 *
 * Behaviour here must stay byte-for-byte identical to what
 * `packages/server/src/byok-mcp-config.js` enforced before #7030 — the
 * server is the security boundary, so this module is a relocation, not a
 * rewrite. See `packages/protocol/tests/mcp-validation-parity.test.js` for the
 * table pinning that claim, and
 * `packages/protocol/tests/mcp-validation-no-duplicate.test.js` for the guard
 * that fails if a second copy of these constants reappears in
 * packages/server/src, packages/dashboard/src, packages/app/src, or
 * packages/store-core/src.
 */
/**
 * Charset for a NEWLY ADDED MCP server name: a lowercase identifier — leading
 * lowercase letter, then lowercase letters / digits / dash / underscore, max
 * 64 chars. Widened by `_` because real MCP server names use it
 * (`ccd_session_mgmt`).
 *
 * Being a strict allow-list, this also forecloses a family of problems for
 * free: no `.` or `/` (so a name can never read as a path or traverse), no
 * uppercase (so two names can't collide case-insensitively), and no
 * whitespace/control characters (so a name can't be visually spoofed in the
 * picker).
 *
 * This regex alone does NOT reject a doubled underscore (`a__b` matches the
 * charset) — see `containsMcpToolNamespaceSeparator` below for that rule.
 */
export const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/**
 * Names/keys that must never be used as an object key assigned into with `{}`
 * or as an MCP server name, regardless of charset — assigning `__proto__` as
 * a plain-object key hits `Object.prototype`'s `__proto__` setter (which
 * silently ignores non-object values), and `constructor` / `prototype` are
 * plain own-property writes that shadow object internals. `__proto__` is
 * already refused by `MCP_SERVER_NAME_RE` (leading `_`), but `constructor`
 * and `prototype` are pure lowercase letters and WOULD pass it, so all three
 * are refused explicitly via this set.
 *
 * One Set serves both call sites that used to carry separate names
 * (`UNSAFE_MCP_SERVER_NAMES` for the server-name check, `UNSAFE_MAP_KEYS` for
 * the `env`/`headers` map-key check) — the values were always identical.
 */
export const UNSAFE_MCP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * MCP tools are namespaced on the wire as `mcp__<server>__<tool>` and
 * `parseMcpToolName` (server `src/mcp-tools.js`) splits on the FIRST `__`
 * after the prefix — so a server named e.g. `a__b` would have its tools
 * parsed as server `a`, tool `b__…`, silently routing calls to the wrong (or
 * a nonexistent) server. `MCP_SERVER_NAME_RE`'s charset alone does not
 * exclude this (underscore is a valid charset character), so this check is a
 * separate, deliberate rule — refuse a name carrying the separator at the
 * door rather than persisting one that mis-routes.
 */
export function containsMcpToolNamespaceSeparator(name) {
    return name.includes('__');
}
/**
 * True when a hostname (or a bare IP) targets the cloud metadata service /
 * IPv4 link-local range — never a legitimate MCP server. Covers:
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
 * servers are legitimate; the broader egress policy is a separate concern.
 */
export function isBlockedMetadataHost(hostname) {
    if (typeof hostname !== 'string' || hostname.length === 0)
        return false;
    let h = hostname.toLowerCase();
    if (h.startsWith('[') && h.endsWith(']'))
        h = h.slice(1, -1);
    const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (v4)
        return Number(v4[1]) === 169 && Number(v4[2]) === 254;
    if (/^::ffff:a9fe:[0-9a-f]{1,4}$/.test(h))
        return true;
    const mapped = h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (mapped)
        return Number(mapped[1]) === 169 && Number(mapped[2]) === 254;
    if (h === 'fd00:ec2::254' || h === 'fd00:ec2:0:0:0:0:0:254')
        return true;
    return false;
}
