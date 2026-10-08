import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { challengeFromUrl, computeHealthProof, isValidChallenge } from '../src/health-proof.js'

const NONCE = 'ab'.repeat(32)

describe('health proof', () => {
  it('matches an independently computed HMAC-SHA256 vector', () => {
    assert.equal(
      computeHealthProof('test-token', 4242, NONCE),
      'e8c3801feb0b5d7b91ce06777985620c52141ff9f1b981dad2e40afe2880c9e6',
    )
  })

  it('is bound to the port, the nonce and the token', () => {
    const base = computeHealthProof('test-token', 4242, NONCE)
    assert.notEqual(computeHealthProof('test-token', 4243, NONCE), base)
    assert.notEqual(computeHealthProof('test-token', 4242, 'cd'.repeat(32)), base)
    assert.notEqual(computeHealthProof('other-token', 4242, NONCE), base)
  })

  it('accepts exactly 64 lowercase hex characters as a challenge', () => {
    assert.equal(isValidChallenge(NONCE), true)
    for (const bad of ['', 'ab', 'AB'.repeat(32), 'ab'.repeat(33), 'g'.repeat(64), ` ${NONCE}`, `${NONCE}\n`, 42, null, undefined]) {
      assert.equal(isValidChallenge(bad), false, JSON.stringify(bad))
    }
  })

  it('reads a single valid challenge parameter from the request URL', () => {
    assert.equal(challengeFromUrl(`/health?challenge=${NONCE}`), NONCE)
    assert.equal(challengeFromUrl(`/health?x=1&challenge=${NONCE}`), NONCE)
    assert.equal(challengeFromUrl('/health'), null)
    assert.equal(challengeFromUrl('/health?challenge='), null)
    assert.equal(challengeFromUrl('/health?challenge=abc'), null)
    assert.equal(challengeFromUrl(`/health?challenge=${NONCE}&challenge=${NONCE}`), null)
    assert.equal(challengeFromUrl(undefined), null)
  })
})
