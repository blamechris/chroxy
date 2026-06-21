/**
 * `chroxy identity rotate` CLI (#5616/#5976).
 *
 * Rotates the daemon's signing identity, minting a single-hop continuity cert so
 * previously-pinned clients chain forward without re-pairing. Consequential, so
 * it requires `--yes`; without it the command only explains what it would do.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runIdentityRotate } from '../src/cli/identity-cmd.js'

function capture() {
  const lines = []
  return { write: (s) => lines.push(String(s)), text: () => lines.join('\n') }
}

describe('identity rotate CLI (#5616)', () => {
  it('explains and does NOT rotate without --yes', () => {
    const out = capture()
    let rotateCalled = false
    const res = runIdentityRotate({}, { write: out.write, rotate: () => { rotateCalled = true; return {} } })
    assert.equal(res.rotated, false)
    assert.equal(rotateCalled, false)
    assert.match(out.text(), /re-run with --yes/)
    assert.match(out.text(), /continuity cert/i)
  })

  it('rotates with --yes and prints the previous/new keys + backend', () => {
    const out = capture()
    const fakeResult = { previousPublicKey: 'OLDPUB==', newPublicKey: 'NEWPUB==', backend: 'file' }
    let passedOpts = null
    const res = runIdentityRotate(
      { yes: true },
      { write: out.write, rotate: (opts) => { passedOpts = opts; return fakeResult }, rotateOpts: { filePath: '/tmp/x' } },
    )
    assert.equal(res.rotated, true)
    assert.deepEqual(res.result, fakeResult)
    assert.deepEqual(passedOpts, { filePath: '/tmp/x' })
    assert.match(out.text(), /OLDPUB==/)
    assert.match(out.text(), /NEWPUB==/)
    assert.match(out.text(), /backend:\s+file/)
    assert.match(out.text(), /Restart the daemon/)
  })
})
