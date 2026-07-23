import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBinaryProvenanceMode, isBinarySignatureGateEnabled, validateConfig } from '../src/config.js'

/**
 * #6858 — the opt-in provenance resolvers are the fail-closed single source of
 * truth for the pin-ledger mode + macOS signature gate. Precedence:
 *   env  >  config.binaryProvenance.*  >  off/false (default, behaviour unchanged).
 */

describe('resolveBinaryProvenanceMode (#6858)', () => {
  let savedEnv

  beforeEach(() => { savedEnv = process.env.CHROXY_BINARY_PROVENANCE; delete process.env.CHROXY_BINARY_PROVENANCE })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CHROXY_BINARY_PROVENANCE
    else process.env.CHROXY_BINARY_PROVENANCE = savedEnv
  })

  it('defaults to off with no config and no env', () => {
    assert.equal(resolveBinaryProvenanceMode(undefined), 'off')
    assert.equal(resolveBinaryProvenanceMode({}), 'off')
  })

  it('reads warn / block from config.binaryProvenance.mode', () => {
    assert.equal(resolveBinaryProvenanceMode({ binaryProvenance: { mode: 'warn' } }), 'warn')
    assert.equal(resolveBinaryProvenanceMode({ binaryProvenance: { mode: 'block' } }), 'block')
  })

  it('fails closed to off for an unrecognised config mode', () => {
    assert.equal(resolveBinaryProvenanceMode({ binaryProvenance: { mode: 'loud' } }), 'off')
    assert.equal(resolveBinaryProvenanceMode({ binaryProvenance: { mode: true } }), 'off')
  })

  it('env overrides config (both directions)', () => {
    process.env.CHROXY_BINARY_PROVENANCE = 'block'
    assert.equal(resolveBinaryProvenanceMode({ binaryProvenance: { mode: 'warn' } }), 'block')
    process.env.CHROXY_BINARY_PROVENANCE = 'off'
    assert.equal(resolveBinaryProvenanceMode({ binaryProvenance: { mode: 'block' } }), 'off')
  })

  it('is case-insensitive on the env value', () => {
    process.env.CHROXY_BINARY_PROVENANCE = 'WARN'
    assert.equal(resolveBinaryProvenanceMode({}), 'warn')
  })
})

describe('isBinarySignatureGateEnabled (#6858)', () => {
  let savedEnv

  beforeEach(() => { savedEnv = process.env.CHROXY_BINARY_SIGNATURE_GATE; delete process.env.CHROXY_BINARY_SIGNATURE_GATE })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CHROXY_BINARY_SIGNATURE_GATE
    else process.env.CHROXY_BINARY_SIGNATURE_GATE = savedEnv
  })

  it('defaults to false (fail-closed — bundled providers are ad-hoc signed)', () => {
    assert.equal(isBinarySignatureGateEnabled(undefined), false)
    assert.equal(isBinarySignatureGateEnabled({}), false)
    assert.equal(isBinarySignatureGateEnabled({ binaryProvenance: {} }), false)
  })

  it('reads the boolean from config.binaryProvenance.signatureGate', () => {
    assert.equal(isBinarySignatureGateEnabled({ binaryProvenance: { signatureGate: true } }), true)
    assert.equal(isBinarySignatureGateEnabled({ binaryProvenance: { signatureGate: false } }), false)
  })

  it('env 1/0 overrides config', () => {
    process.env.CHROXY_BINARY_SIGNATURE_GATE = '1'
    assert.equal(isBinarySignatureGateEnabled({ binaryProvenance: { signatureGate: false } }), true)
    process.env.CHROXY_BINARY_SIGNATURE_GATE = '0'
    assert.equal(isBinarySignatureGateEnabled({ binaryProvenance: { signatureGate: true } }), false)
  })
})

describe('config schema — binaryProvenance is a known key (#6858)', () => {
  it('does not warn "Unknown config key" for a binaryProvenance block', () => {
    const result = validateConfig({ binaryProvenance: { mode: 'warn', signatureGate: true } })
    assert.ok(
      !result.warnings.some((w) => w.includes('binaryProvenance') && w.includes('Unknown')),
      `unexpected unknown-key warning: ${JSON.stringify(result.warnings)}`,
    )
  })
})
