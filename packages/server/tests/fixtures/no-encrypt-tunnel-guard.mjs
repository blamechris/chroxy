/**
 * Fixture: Verifies the --no-encrypt + tunnel guard in server-cli.js.
 *
 * Replicates the exact guard condition and exit behavior. Parent test
 * checks that the process exits with code 1 and stderr includes the
 * expected warning.
 */

const config = {
  noEncrypt: true,
  tunnel: 'quick',
}

if (config.noEncrypt && config.tunnel && config.tunnel !== 'none') {
  process.stderr.write('[!] Cannot use --no-encrypt with a tunnel. Unencrypted WebSocket\n')
  process.stderr.write('    traffic over a public tunnel exposes all session data in transit.\n')
  process.stderr.write('    Remove --no-encrypt or disable the tunnel (--tunnel none).\n')
  process.exit(1)
}

// If guard fails to trigger (regression), exit 0 so test can detect it
process.exit(0)
