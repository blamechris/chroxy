import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CloudflareTunnelAdapter, TunnelBinaryProvenanceError } from '../src/tunnel/cloudflare.js'
import { PROVENANCE_STATUS } from '../src/utils/verify-provenance.js'

/**
 * Tests for the opt-in cloudflared provenance gate (#6858). The gate is folded
 * into the SAME pin ledger + signature gate as the provider binaries and runs
 * BEFORE either tunnel-start path spawns cloudflared. All binary / ledger /
 * verification touchpoints are injected so no real cloudflared or ledger is
 * needed.
 */

const okHealth = (path) => ({ ok: true, status: 'ok', path, quarantine: null })

function makeAdapter({ binaryProvenance, resolveBinary, verifyBinary, verifyProvenance } = {}) {
  return new CloudflareTunnelAdapter({
    port: 8765,
    mode: 'quick',
    config: { binaryProvenance: binaryProvenance ?? null },
    resolveBinary: resolveBinary || (() => '/opt/homebrew/bin/cloudflared'),
    verifyBinary: verifyBinary || okHealth,
    verifyProvenance: verifyProvenance || (() => ({ ok: true, status: PROVENANCE_STATUS.OK, blocked: false })),
  })
}

describe('cloudflared provenance gate (#6858)', () => {
  it('is a no-op when no provenance config is supplied', () => {
    let resolved = false
    const adapter = makeAdapter({
      binaryProvenance: null,
      resolveBinary: () => { resolved = true; return '/x' },
    })
    assert.doesNotThrow(() => adapter._verifyCloudflaredProvenance())
    assert.equal(resolved, false, 'must not even resolve the binary when off')
  })

  it('is a no-op when mode is off and the signature gate is off', () => {
    let verified = false
    const adapter = makeAdapter({
      binaryProvenance: { mode: 'off', signatureGate: false, ledger: {} },
      verifyProvenance: () => { verified = true; return { blocked: false } },
    })
    assert.doesNotThrow(() => adapter._verifyCloudflaredProvenance())
    assert.equal(verified, false)
  })

  it('block mode + a blocked verdict throws TunnelBinaryProvenanceError BEFORE any spawn', async () => {
    let spawned = false
    const adapter = makeAdapter({
      binaryProvenance: { mode: 'block', signatureGate: false, ledger: {} },
      verifyProvenance: () => ({
        ok: false,
        status: PROVENANCE_STATUS.HASH_MISMATCH,
        blocked: true,
        path: '/opt/homebrew/bin/cloudflared',
        message: 'binary hash changed since it was pinned',
        remediation: 're-approve it',
      }),
    })
    adapter._spawnCloudflared = () => { spawned = true; return {} }

    await assert.rejects(
      () => adapter._startTunnel(),
      (err) => {
        assert.ok(err instanceof TunnelBinaryProvenanceError, `got ${err?.name}`)
        assert.equal(err.code, 'TUNNEL_BINARY_PROVENANCE')
        assert.match(err.message, /cloudflared/)
        assert.match(err.message, /changed/i)
        return true
      },
    )
    assert.equal(spawned, false, 'gate must block before cloudflared is spawned')
  })

  it('warn mode + a non-blocked mismatch does NOT throw (surfaced, allowed)', () => {
    const adapter = makeAdapter({
      binaryProvenance: { mode: 'warn', signatureGate: false, ledger: {} },
      verifyProvenance: () => ({
        ok: true,
        status: PROVENANCE_STATUS.HASH_MISMATCH,
        blocked: false,
        path: '/opt/homebrew/bin/cloudflared',
        message: 'binary hash changed since it was pinned',
      }),
    })
    assert.doesNotThrow(() => adapter._verifyCloudflaredProvenance())
  })

  it('does not gate (nor call verifyProvenance) when the binary is not resolvable/healthy', () => {
    let verified = false
    const adapter = makeAdapter({
      binaryProvenance: { mode: 'block', signatureGate: false, ledger: {} },
      verifyBinary: (path) => ({ ok: false, status: 'not_found', path, quarantine: null }),
      verifyProvenance: () => { verified = true; return { blocked: true } },
    })
    // A missing cloudflared is surfaced by the normal spawn / doctor path — the
    // provenance gate must not mask it, and must not block.
    assert.doesNotThrow(() => adapter._verifyCloudflaredProvenance())
    assert.equal(verified, false)
  })

  it('passes the resolved healthy path + ledger through to verifyProvenance', () => {
    let seen = null
    const ledger = { getRecord: () => null, approve: () => true }
    const adapter = makeAdapter({
      binaryProvenance: { mode: 'block', signatureGate: true, ledger },
      resolveBinary: () => '/usr/local/bin/cloudflared',
      verifyProvenance: (args) => { seen = args; return { blocked: false, status: PROVENANCE_STATUS.OK } },
    })
    adapter._verifyCloudflaredProvenance()
    assert.equal(seen.resolvedPath, '/usr/local/bin/cloudflared')
    assert.equal(seen.mode, 'block')
    assert.equal(seen.signatureGate, true)
    assert.equal(seen.ledger, ledger)
  })
})
