/**
 * `chroxy credentials` CLI subcommands.
 *
 * `rekey` (#5229) rotates the at-rest credential data key: it mints a fresh
 * OS-keychain data key, re-encrypts ~/.chroxy/credentials.json under it
 * atomically (temp → chmod 0600 → rename), and replaces the old keychain entry
 * in place. Use it after a suspected keychain compromise, or to periodically
 * rotate the key, WITHOUT re-entering any provider credentials.
 */
import { rekeyCredentialStore } from '../credential-store.js'
import { createLogger } from '../logger.js'

const REKEY_MESSAGES = {
  rekeyed: 'Rotated the credential data key and re-encrypted credentials.json.',
  'no-keychain': 'No OS keychain available — nothing to rotate (credentials are stored as plaintext 0600).',
  'no-file': 'No credentials.json found — nothing to rotate.',
  empty: 'credentials.json holds no credentials — nothing to rotate.',
  'read-error': 'Could not read credentials.json safely — aborted without changing anything.',
  'write-error': 'Re-encryption failed — the keychain key was rolled back; the existing store is unchanged.',
}

/**
 * Run `chroxy credentials rekey`. Returns the {@link rekeyCredentialStore}
 * result. `deps` is a test seam (`write`, `log`, `rekey`).
 */
export async function runCredentialsRekey(options = {}, deps = {}) {
  const out = deps.write || console.log
  const log = deps.log || createLogger('credentials')
  const rekey = deps.rekey || rekeyCredentialStore
  const result = rekey({ log })

  if (options.json) {
    out(JSON.stringify(result, null, 2))
  } else {
    const msg = REKEY_MESSAGES[result.reason] || result.reason
    out(`${result.rekeyed ? '✓' : '•'} ${msg}`)
  }
  return result
}

export function registerCredentialsCommand(program) {
  const creds = program
    .command('credentials')
    .description('Manage stored provider credentials')

  creds
    .command('rekey')
    .description('Rotate the at-rest credential data key and re-encrypt credentials.json')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      const result = await runCredentialsRekey(options)
      // Signal failure to scripts/CI only when we INTENDED to rotate but
      // couldn't (the store was readable yet the swap failed). Benign no-ops
      // (no-file, empty, no-keychain) exit 0.
      if (!result.rekeyed && (result.reason === 'read-error' || result.reason === 'write-error')) {
        process.exitCode = 1
      }
    })
}
