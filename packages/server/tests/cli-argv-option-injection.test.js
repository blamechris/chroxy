/**
 * #7296 — the remaining CLI argv option-injection sites.
 *
 * Two datums reach a bare positional in an argv built by a CLI command:
 *
 *   1. the cloudflared tunnel NAME, prompted interactively by
 *      `chroxy tunnel setup` and then re-used in three argv slots
 *      (`tunnel create <name>`, `tunnel route dns <name> <hostname>`, and
 *      `tunnel run … <name>` in tunnel/cloudflare.js);
 *   2. `known-good-ref`, read from the config dir by `chroxy deploy` and
 *      handed to `git diff`. The existing `--` in that argv sits AFTER the
 *      ref, and `--` cannot retroactively protect what precedes it.
 *
 * Both fixes are asserted as POSITIONS and REFUSALS, not as presence: a `--`
 * in the wrong slot, or a validator that accepts a dash-leading value, turns
 * these red.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidTunnelName,
  cloudflaredCreateArgv,
  cloudflaredRouteDnsArgv,
} from '../src/cli/tunnel-cmd.js'
import { gitChangedServerFilesArgv } from '../src/cli/deploy-cmd.js'
import { isGitShaRef } from '../src/utils/argv-safety.js'

describe('isValidTunnelName — writer-side check on the prompted name (#7296)', () => {
  it('refuses option-shaped and control-character names', () => {
    for (const name of [
      '--config=/tmp/evil.yml',
      '--loglevel=debug',
      '-h',
      '--',
      '-',
      'chroxy\nchroxy2',
      'chroxy\rx',
      'chroxy\0',
      '',
    ]) {
      assert.equal(isValidTunnelName(name), false, `must refuse ${JSON.stringify(name)}`)
    }
  })

  it('refuses non-strings and absurdly long names', () => {
    assert.equal(isValidTunnelName(null), false)
    assert.equal(isValidTunnelName(undefined), false)
    assert.equal(isValidTunnelName(42), false)
    assert.equal(isValidTunnelName('a'.repeat(200)), false)
  })

  it('positive control: ordinary tunnel names are accepted', () => {
    for (const name of ['chroxy', 'chroxy-prod', 'chroxy_dev', 'chroxy.dev1', 'C9']) {
      assert.equal(isValidTunnelName(name), true, `must accept ${JSON.stringify(name)}`)
    }
  })
})

describe('cloudflared argv builders — separator position (#7296)', () => {
  // Measured against cloudflared 2026.8.3, each probe run with a bogus
  // `--origincert /nonexistent/cert.pem` so nothing reaches the account:
  //   cloudflared tunnel create --help        → prints create's help
  //   cloudflared tunnel create -- --help     → origin-cert error (consumed as NAME)
  //   cloudflared tunnel route dns -- --help x → origin-cert error
  // So `--` terminates option parsing ahead of the positionals in both.
  it('puts -- immediately before the name in tunnel create', () => {
    assert.deepEqual(cloudflaredCreateArgv('chroxy'), ['tunnel', 'create', '--', 'chroxy'])
  })

  it('puts -- immediately before the positionals in tunnel route dns', () => {
    assert.deepEqual(
      cloudflaredRouteDnsArgv('chroxy', 'chroxy.example.com'),
      ['tunnel', 'route', 'dns', '--', 'chroxy', 'chroxy.example.com']
    )
  })

  it('an option-shaped name lands after the separator, which is the only bare --', () => {
    // The subject is the SEPARATOR'S POSITION relative to the caller-supplied
    // value, so that is all this asserts. It deliberately does NOT assert that
    // no token ahead of the separator starts with `-`: a constant flag
    // (`--origincert`, say) is legitimate there, and an assertion that forbids
    // one would go red on a safe change while catching no attacker. What DOES
    // matter is that the separator we placed is the FIRST bare `--` in the
    // argv — an earlier one would terminate option parsing ahead of ours and
    // silently change which tokens are flags.
    for (const [argv, prefix] of [
      [cloudflaredCreateArgv('--config=/tmp/evil.yml'), ['tunnel', 'create']],
      [cloudflaredRouteDnsArgv('--config=/tmp/evil.yml', 'h.example.com'), ['tunnel', 'route', 'dns']],
    ]) {
      const dashIndex = argv.indexOf('--')
      assert.notEqual(dashIndex, -1, 'argv must carry a bare -- separator')
      assert.deepEqual(argv.slice(0, dashIndex), prefix,
        'only the constant subcommand may precede the separator')
      assert.equal(argv[dashIndex + 1], '--config=/tmp/evil.yml',
        'the value must be the FIRST token after the separator')
    }
  })
})

describe('gitChangedServerFilesArgv — known-good-ref (#7296)', () => {
  const SRC = 'packages/server/src/'

  it('refuses an option-shaped ref and falls back to ls-files', () => {
    for (const ref of [
      '--output=/tmp/x',
      '-O/etc/passwd',
      '--ext-diff',
      '--',
      '-',
      'HEAD',
      'main',
      'refs/heads/main',
      'deadbee\n--exit-code',
      '',
      null,
      undefined,
      123,
    ]) {
      const argv = gitChangedServerFilesArgv(ref)
      assert.deepEqual(argv, ['ls-files', '--', SRC],
        `must fall back for ${JSON.stringify(ref)}`)
      // Nothing ahead of the pathspec separator — i.e. nothing git would
      // option-parse or resolve as a revision — may carry the rejected value.
      // (`'--'` is itself a rejected ref, so an `includes` check here would
      // collide with the separator; the revision slot is the real subject.)
      assert.ok(!argv.slice(0, argv.indexOf('--')).includes(ref),
        'the rejected ref must not reach git as a revision')
    }
  })

  it('positive control: a real short or full SHA takes the diff branch', () => {
    assert.deepEqual(
      gitChangedServerFilesArgv('0123abc'),
      ['diff', '--name-only', '0123abc', '--', SRC]
    )
    const full = 'a'.repeat(40)
    assert.deepEqual(
      gitChangedServerFilesArgv(full),
      ['diff', '--name-only', full, '--', SRC]
    )
    assert.deepEqual(
      gitChangedServerFilesArgv('0123ABCDEF'),
      ['diff', '--name-only', '0123ABCDEF', '--', SRC],
      'git SHAs are matched case-insensitively, as supervisor.js has always done'
    )
  })
})

describe('isGitShaRef — the one shared SHA predicate (#7296)', () => {
  it('refuses refs that are not hex SHAs', () => {
    for (const ref of ['HEAD', 'main', '--output=/tmp/x', '-O/x', 'abcdef', 'g'.repeat(8), 'a'.repeat(41), '', null, {}]) {
      assert.equal(isGitShaRef(ref), false, `must refuse ${JSON.stringify(ref)}`)
    }
  })

  it('positive control: accepts 7–40 hex chars in either case', () => {
    assert.equal(isGitShaRef('0123abc'), true)
    assert.equal(isGitShaRef('0123ABC'), true)
    assert.equal(isGitShaRef('f'.repeat(40)), true)
  })
})
