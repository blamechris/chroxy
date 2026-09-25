import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  McpServerSourceSchema,
  McpTrustServerInputSchema,
} from '@chroxy/protocol'

/**
 * #7939: the MCP spawn-trust prompt (`permission_request` with
 * `tool: 'mcp_spawn'`) carries a `source` field naming which of the three
 * config scopes (`local` / `project-mcp-json` / `user` — see
 * `MCP_SERVER_SOURCE` in packages/server/src/byok-mcp-config.js) the server
 * config was resolved from. It is a CLOSED enum on the wire, not a free-form
 * string — a repo-provided `.mcp.json` server ('project-mcp-json') is
 * attacker-influenceable content, so the value set a client can be told to
 * render must be fixed, not whatever text a (possibly compromised or buggy)
 * server sends.
 *
 * `ServerPermissionRequestSchema.input` itself stays `z.any()` (documented in
 * stream.ts) — these tests pin the narrower `McpTrustServerInputSchema` that
 * validates the mcp_spawn-specific sub-shape on its own.
 */
describe('McpServerSourceSchema (#7939)', () => {
  it('accepts each of the three enum values', () => {
    for (const value of ['local', 'project-mcp-json', 'user']) {
      assert.equal(McpServerSourceSchema.safeParse(value).success, true, value)
    }
  })

  it('rejects an unrecognized string', () => {
    const result = McpServerSourceSchema.safeParse('some-other-scope')
    assert.equal(result.success, false)
  })

  it('rejects a non-string value', () => {
    assert.equal(McpServerSourceSchema.safeParse(42).success, false)
    assert.equal(McpServerSourceSchema.safeParse(null).success, false)
    assert.equal(McpServerSourceSchema.safeParse({}).success, false)
  })
})

describe('McpTrustServerInputSchema (#7939)', () => {
  describe('stdio variant', () => {
    const base = { name: 'github', command: 'node', args: ['gh.js'], envKeys: ['GITHUB_TOKEN'] }

    it('accepts a valid source', () => {
      const result = McpTrustServerInputSchema.safeParse({ ...base, source: 'project-mcp-json' })
      assert.equal(result.success, true)
      assert.equal(result.data.source, 'project-mcp-json')
    })

    it('accepts absence of source — wire-compat with an older server', () => {
      const result = McpTrustServerInputSchema.safeParse(base)
      assert.equal(result.success, true)
      assert.equal('source' in result.data, false)
    })

    it('rejects an unrecognized source rather than passing it through', () => {
      const result = McpTrustServerInputSchema.safeParse({ ...base, source: 'not-a-real-scope' })
      assert.equal(result.success, false)
    })
  })

  describe('remote variant', () => {
    const base = { name: 'lmstudio', url: 'https://mcp.example.com/sse', headerKeys: [] }

    it('accepts a valid source', () => {
      const result = McpTrustServerInputSchema.safeParse({ ...base, source: 'local' })
      assert.equal(result.success, true)
      assert.equal(result.data.source, 'local')
    })

    it('accepts absence of source', () => {
      const result = McpTrustServerInputSchema.safeParse(base)
      assert.equal(result.success, true)
    })

    it('accepts the resolvedAddress mirror alongside source', () => {
      const result = McpTrustServerInputSchema.safeParse({
        ...base,
        source: 'user',
        resolvedAddress: { resolved: true, addresses: ['10.0.0.5'], classification: 'private', display: 'resolves to 10.0.0.5 (private LAN)' },
      })
      assert.equal(result.success, true)
    })

    it('rejects an unrecognized source', () => {
      const result = McpTrustServerInputSchema.safeParse({ ...base, source: 'evil' })
      assert.equal(result.success, false)
    })
  })
})
