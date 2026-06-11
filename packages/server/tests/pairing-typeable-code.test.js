/**
 * Typeable short pairing code (#5512, epic #5509).
 *
 * The TV-app pattern: a camera-less device pairs by reading a short, human-typable
 * code off the host's own screen. Pairing ids therefore become uppercase,
 * ambiguity-free, 8-char codes; entry is case-insensitive and tolerant of spaces
 * and dashes (normalized before lookup). One mechanism — the QR carries the same
 * code in its chroxy://…?pair= URL.
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'

describe('typeable pairing codes (#5512)', () => {
  let PairingManager
  let normalizePairingCode
  let TYPEABLE_ALPHABET

  before(async () => {
    const mod = await import('../src/pairing.js')
    PairingManager = mod.PairingManager
    normalizePairingCode = mod.normalizePairingCode
    TYPEABLE_ALPHABET = mod.TYPEABLE_ALPHABET
  })

  describe('alphabet & shape', () => {
    it('exports an ambiguity-free uppercase alphabet (no 0/O/1/I/L)', () => {
      assert.equal(typeof TYPEABLE_ALPHABET, 'string')
      assert.ok(TYPEABLE_ALPHABET.length > 0)
      for (const bad of ['0', 'O', '1', 'I', 'L']) {
        assert.ok(!TYPEABLE_ALPHABET.includes(bad), `alphabet must not include ${bad}`)
      }
      // Uppercase + digits only.
      assert.match(TYPEABLE_ALPHABET, /^[A-Z2-9]+$/)
    })

    it('generates an 8-char code drawn only from the typeable alphabet', () => {
      const pm = new PairingManager({})
      const id = pm.currentPairingId
      assert.equal(id.length, 8, 'pairing code should be 8 chars')
      for (const ch of id) {
        assert.ok(TYPEABLE_ALPHABET.includes(ch), `char ${ch} not in alphabet`)
      }
      pm.destroy()
    })

    it('bound pairing ids also use the typeable alphabet', () => {
      const pm = new PairingManager({ wsUrl: 'wss://example.com' })
      const { pairingId } = pm.generateBoundPairing('sess-A')
      assert.equal(pairingId.length, 8)
      for (const ch of pairingId) {
        assert.ok(TYPEABLE_ALPHABET.includes(ch), `char ${ch} not in alphabet`)
      }
      pm.destroy()
    })

    it('codes vary across refreshes (crypto-random)', () => {
      const pm = new PairingManager({ ttlMs: 60_000 })
      const seen = new Set()
      for (let i = 0; i < 20; i++) {
        seen.add(pm.currentPairingId)
        pm.refresh()
      }
      assert.ok(seen.size >= 18, 'codes should be effectively unique across refreshes')
      pm.destroy()
    })
  })

  describe('normalizePairingCode', () => {
    it('uppercases and strips spaces and dashes', () => {
      assert.equal(normalizePairingCode('abcd-2345'), 'ABCD2345')
      assert.equal(normalizePairingCode('ab cd 23 45'), 'ABCD2345')
      assert.equal(normalizePairingCode('  AB-CD 2345  '), 'ABCD2345')
    })

    it('returns empty string for null/undefined/non-string', () => {
      assert.equal(normalizePairingCode(null), '')
      assert.equal(normalizePairingCode(undefined), '')
      assert.equal(normalizePairingCode(42), '')
    })
  })

  describe('case-insensitive / formatting-tolerant validation', () => {
    it('accepts a lowercased copy of the current code', () => {
      const pm = new PairingManager({})
      const id = pm.currentPairingId
      const result = pm.validatePairing(id.toLowerCase())
      assert.equal(result.valid, true, 'lowercase entry should validate')
      assert.ok(result.sessionToken)
      pm.destroy()
    })

    it('accepts a code typed with dashes and spaces', () => {
      const pm = new PairingManager({})
      const id = pm.currentPairingId
      const messy = `${id.slice(0, 4)}-${id.slice(4)}`.toLowerCase()
      const result = pm.validatePairing(messy)
      assert.equal(result.valid, true, 'dashed/lowercased entry should validate')
      pm.destroy()
    })

    it('still rejects an unknown code after normalization', () => {
      const pm = new PairingManager({})
      const result = pm.validatePairing('zz-zz-zz-zz')
      assert.equal(result.valid, false)
      assert.equal(result.reason, 'invalid_pairing_id')
      pm.destroy()
    })
  })

  describe('current code snapshot helper', () => {
    it('currentPairingCode returns code + expiry for host display', () => {
      const pm = new PairingManager({ wsUrl: 'wss://example.com', ttlMs: 60_000 })
      const snap = pm.currentPairingCode
      assert.ok(snap, 'should return a snapshot')
      assert.equal(snap.code, pm.currentPairingId)
      assert.ok(typeof snap.expiresAtMs === 'number')
      assert.ok(snap.expiresAtMs > Date.now())
      assert.ok(snap.url.startsWith('chroxy://example.com?pair='))
      pm.destroy()
    })

    it('currentPairingCode is null after destroy', () => {
      const pm = new PairingManager({})
      pm.destroy()
      assert.equal(pm.currentPairingCode, null)
    })
  })
})
