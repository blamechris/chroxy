import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MCP_SERVER_NAME_RE,
  UNSAFE_MCP_KEYS,
  containsMcpToolNamespaceSeparator,
  isBlockedMetadataHost,
} from '@chroxy/protocol/mcp-validation'

/**
 * #7030 parity table.
 *
 * Pins the pre-#7030 behaviour of `packages/server/src/byok-mcp-config.js`'s
 * `MCP_SERVER_NAME_RE`, `UNSAFE_MCP_SERVER_NAMES` / `UNSAFE_MAP_KEYS`, and
 * `isBlockedMetadataHost` — verified against the server's own tests
 * (`packages/server/tests/byok-mcp-config-mutation.test.js` #6974 name
 * validation, `packages/server/tests/byok-mcp-config.test.js` metadata-host
 * cases) before this module existed. The server is the security boundary, so
 * this table must pass UNCHANGED against the shared `@chroxy/protocol/mcp-
 * validation` module — a relocation, not a rewrite.
 *
 * `isNewMcpServerNameAccepted` below composes the three primitives exactly
 * the way `validateNewMcpServerName` (server) and `validateMcpServerName`
 * (dashboard) each do independently, so this table pins the END-TO-END
 * accept/reject decision, not just the raw regex — that is what lets it
 * catch a regression in the `__`-separator rule (which is NOT encoded in the
 * charset regex; `a__b` matches `MCP_SERVER_NAME_RE` on its own).
 */
function isNewMcpServerNameAccepted(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (UNSAFE_MCP_KEYS.has(name)) return false
  if (!MCP_SERVER_NAME_RE.test(name)) return false
  if (containsMcpToolNamespaceSeparator(name)) return false
  return true
}

describe('#7030 MCP_SERVER_NAME_RE / UNSAFE_MCP_KEYS parity (name acceptance)', () => {
  const accepted = ['repo-memory', 'ccd_session_mgmt', 'a', 'x1', 'my-server-2', 'filesystem', 'a-b-c']
  const rejected = [
    // charset violations
    'MyServer', '1server', 'my.server', 'my/server', '../evil', 'my server', 'a'.repeat(65),
    '', '   ', '-abc', '1abc',
    // the tool-namespace separator (charset-valid, rejected by the separate rule)
    'a__b', 'server__x', '__proto__',
    // reserved keys (charset-valid on their own, refused regardless)
    'constructor', 'prototype',
  ]

  for (const name of accepted) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      assert.equal(isNewMcpServerNameAccepted(name), true, name)
    })
  }

  for (const name of rejected) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      assert.equal(isNewMcpServerNameAccepted(name), false, name)
    })
  }
})

describe('#7030 UNSAFE_MCP_KEYS parity (reserved object keys)', () => {
  it('flags __proto__, constructor, prototype', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(UNSAFE_MCP_KEYS.has(key), true, key)
    }
  })

  it('does not flag an ordinary env/header key', () => {
    for (const key of ['API_TOKEN', 'Authorization', 'my_key', '']) {
      assert.equal(UNSAFE_MCP_KEYS.has(key), false, key)
    }
  })
})

describe('#7030 isBlockedMetadataHost parity', () => {
  const blocked = [
    '169.254.169.254',
    '169.254.0.1',
    '::ffff:a9fe:a9fe', // 169.254.169.254 as IPv4-mapped IPv6 hex groups
    '::ffff:169.254.169.254',
    'fd00:ec2::254', // AWS IMDS IPv6, compressed
    'fd00:ec2:0:0:0:0:0:254', // AWS IMDS IPv6, expanded
    '[fd00:ec2::254]', // bracketed form (as a URL.hostname would never bracket, but the fn strips brackets defensively)
  ]

  const allowed = [
    'metadata.google.internal', // GCP's metadata host is a NAME, not caught by this literal-IP/host check
    'localhost',
    '127.0.0.1',
    '10.0.0.5',
    '192.168.1.1',
    'example.com',
    '169.253.0.1', // one below the link-local range
    '169.255.0.1', // one above the link-local range
    '',
  ]

  for (const host of blocked) {
    it(`blocks ${host}`, () => {
      assert.equal(isBlockedMetadataHost(host), true, host)
    })
  }

  for (const host of allowed) {
    it(`allows ${host}`, () => {
      assert.equal(isBlockedMetadataHost(host), false, host)
    })
  }

  it('canonicalizes hex/decimal host tricks via the WHATWG URL parser first', () => {
    // isBlockedMetadataHost itself only recognizes the canonical dotted-quad /
    // hex-group forms — the URL parser is what canonicalizes 0xa9fea9fe etc.
    // to 169.254.169.254 before this function ever sees it (mirrors the
    // server's own trick-host regression test).
    for (const trick of ['http://0xa9fea9fe/', 'http://2852039166/']) {
      assert.equal(isBlockedMetadataHost(new URL(trick).hostname), true, trick)
    }
  })

  it('is case-insensitive and tolerates a non-string gracefully', () => {
    assert.equal(isBlockedMetadataHost('FD00:EC2::254'), true)
    assert.equal(isBlockedMetadataHost(undefined), false)
    assert.equal(isBlockedMetadataHost(null), false)
  })
})
