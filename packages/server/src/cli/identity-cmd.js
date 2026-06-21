// `chroxy identity rotate` — rotate the daemon's long-lived signing identity
// while minting a single-hop continuity cert (#5616/#5976).
//
// The daemon's identity key is what clients PIN at pairing time. Rotating it
// (reinstall, machine migration, key hygiene) would normally force every paired
// client to manually re-pair — and look indistinguishable from a MITM. This
// command instead signs the NEW identity with the OLD secret ("old signs new"),
// so a previously-pinned client that reconnects chains its pin forward
// automatically. Single-hop: only the most-recent rotation is bridged; a client
// that is ≥2 rotations behind still re-pairs.
//
// Admin-initiated and CONSEQUENTIAL, so it requires an explicit `--yes`. Without
// it, the command explains what will happen and changes nothing.

import { rotateServerIdentity } from '../server-identity.js'

/**
 * Run the rotation. Pure aside from the injected `rotate` seam + writer, so a
 * test can assert the output + that the rotation ran without touching real
 * keychain/disk.
 *
 * @param {{ yes?: boolean }} options
 * @param {object} [deps]
 * @returns {{ rotated: boolean, result: object|null }}
 */
export function runIdentityRotate(options = {}, deps = {}) {
  const out = deps.write || console.log
  const rotate = deps.rotate || rotateServerIdentity

  if (!options.yes) {
    out(
      [
        'chroxy identity rotate — mint a NEW daemon identity (continuity cert preserved).',
        '',
        'What happens:',
        '  • A fresh identity keypair is minted and stored in place of the current one.',
        '  • The OLD identity signs the NEW one (a single-hop continuity cert), so a',
        '    client that pinned the current identity reconnects WITHOUT re-pairing.',
        '  • A client that is ≥2 rotations behind, or that never pinned this daemon,',
        '    will re-pair as usual.',
        '  • Restart the daemon afterwards to serve the new identity.',
        '',
        'This is consequential — re-run with --yes to proceed:',
        '  chroxy identity rotate --yes',
      ].join('\n'),
    )
    return { rotated: false, result: null }
  }

  const result = rotate(deps.rotateOpts || {})
  out(
    [
      'Rotated server identity.',
      `  previous: ${result.previousPublicKey}`,
      `  new:      ${result.newPublicKey}`,
      `  backend:  ${result.backend}`,
      '',
      'A single-hop continuity cert was written — previously-pinned clients chain',
      'forward without re-pairing. Restart the daemon to serve the new identity.',
    ].join('\n'),
  )
  return { rotated: true, result }
}

export function registerIdentityCommand(program) {
  const identity = program
    .command('identity')
    .description('Manage the daemon\'s long-lived signing identity (E2E key pinning)')

  identity
    .command('rotate')
    .description('Rotate the identity key, preserving a single-hop continuity cert so pinned clients don\'t re-pair')
    .option('--yes', 'Confirm the rotation (without this, the command only explains what it would do)')
    .action((options) => {
      try {
        const { rotated } = runIdentityRotate(options)
        if (!rotated) process.exitCode = 0
      } catch (err) {
        console.error(`identity rotate failed: ${err.message}`)
        process.exitCode = 1
      }
    })
}
