/**
 * Tests for the shared argv option-injection guards (#7290, #7291).
 *
 * Every case here is a NEGATIVE CONTROL in the sense of
 * docs/false-safety-guards.md: it asserts a value the guard must REFUSE (or a
 * flag it must NOT claim), so weakening the guard turns it red. Cases that
 * assert acceptance are labelled as positive controls — without them a guard
 * that simply refused everything would pass the whole file.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSafeArgvValue,
  assertSafeArgvValue,
  cliHelpAdvertisesFlag,
} from '../src/utils/argv-safety.js'

describe('isSafeArgvValue', () => {
  it('refuses every leading-dash form git/CLIs parse as an option', () => {
    // Measured against git 2.54.0 while fixing #7290: each of these was
    // accepted by the old `/^[a-zA-Z0-9._\-\/~^@{}:]+$/` allowlist (which put
    // `-` INSIDE the character class) and then option-parsed by git.
    for (const v of [
      '--stat', '-p', '--raw', '--exit-code', '--ext-diff', '--word-diff',
      '-U99999', '-O/etc/passwd', '--no-index', '-', '--',
      '--dangerously-skip-permissions', '--print',
    ]) {
      assert.equal(isSafeArgvValue(v), false, `must refuse ${JSON.stringify(v)}`)
    }
  })

  it('refuses NUL / CR / LF, which can smuggle a second argument', () => {
    for (const v of ['a\0b', 'a\nb', 'a\r\nb', 'main\n--upload-pack=x', '\n']) {
      assert.equal(isSafeArgvValue(v), false, `must refuse ${JSON.stringify(v)}`)
    }
  })

  it('refuses non-strings and the empty string', () => {
    for (const v of [null, undefined, 0, 42, {}, [], true, '']) {
      assert.equal(isSafeArgvValue(v), false, `must refuse ${JSON.stringify(v)}`)
    }
  })

  // POSITIVE CONTROL — a guard that refused everything would pass all of the
  // above. These are the values real callers depend on.
  it('accepts legitimate refs, branches and names (positive control)', () => {
    for (const v of [
      'HEAD', 'HEAD~1', 'HEAD^', 'main', 'origin/main', 'feature/argv-fix',
      'v1.2.3', 'a1b2c3d', 'refs/heads/main', '@', 'HEAD@{1}',
      'release-2026', 'my-branch', 'x',
    ]) {
      assert.equal(isSafeArgvValue(v), true, `must accept ${JSON.stringify(v)}`)
    }
  })

  it('accepts a dash that is not leading', () => {
    // The check is about POSITION, not about the character.
    assert.equal(isSafeArgvValue('my-branch'), true)
    assert.equal(isSafeArgvValue('a--b'), true)
    assert.equal(isSafeArgvValue('-a'), false)
  })
})

describe('assertSafeArgvValue', () => {
  it('throws on a dash-leading value, naming the kind', () => {
    assert.throws(() => assertSafeArgvValue('--stat', 'ref'), /unsafe ref/)
    assert.throws(() => assertSafeArgvValue('-x', 'branch'), /unsafe branch/)
  })

  it('distinguishes empty from unsafe', () => {
    // orchestration/git-ops.js pins this split — its callers surface the two
    // as different GitOpsError messages.
    assert.throws(() => assertSafeArgvValue('', 'ref'), /empty ref/)
    assert.throws(() => assertSafeArgvValue(null, 'ref'), /empty ref/)
    assert.throws(() => assertSafeArgvValue('-x', 'ref'), /unsafe ref/)
  })

  it('does not throw for a legitimate value (positive control)', () => {
    assert.doesNotThrow(() => assertSafeArgvValue('main', 'branch'))
  })
})

describe('cliHelpAdvertisesFlag', () => {
  // The #7291 defect, verbatim. The installed Claude Code CLI advertises
  // --remote-control and --remote-control-session-name-prefix, and has NO
  // --remote — yet `help.includes('--remote')` returns true.
  const REAL_HELP = [
    'Usage: claude [options] [command] [prompt]',
    '  --remote-control                       Enable remote control',
    '  --remote-control-session-name-prefix <prefix>  Prefix',
    '  --teleport                             Teleport a task',
    '  --print                                Non-interactive output',
  ].join('\n')

  it('does not let a LONGER flag satisfy a shorter probe', () => {
    assert.equal(cliHelpAdvertisesFlag(REAL_HELP, '--remote'), false)
    // The bug this replaces, asserted explicitly so the contrast is pinned:
    assert.equal(REAL_HELP.includes('--remote'), true,
      'the naive substring check really does say true — that is the defect')
  })

  it('detects a flag that IS advertised (positive control)', () => {
    assert.equal(cliHelpAdvertisesFlag(REAL_HELP, '--teleport'), true)
    assert.equal(cliHelpAdvertisesFlag(REAL_HELP, '--print'), true)
    assert.equal(cliHelpAdvertisesFlag(REAL_HELP, '--remote-control'), true)
  })

  it('accepts a flag at any legitimate boundary', () => {
    assert.equal(cliHelpAdvertisesFlag('  --remote\n', '--remote'), true, 'newline')
    assert.equal(cliHelpAdvertisesFlag('  --remote', '--remote'), true, 'end of string')
    assert.equal(cliHelpAdvertisesFlag('  --remote  Launch', '--remote'), true, 'space')
    assert.equal(cliHelpAdvertisesFlag('  --remote=<url>', '--remote'), true, 'equals')
    assert.equal(cliHelpAdvertisesFlag('  --remote, -r', '--remote'), true, 'comma')
  })

  it('rejects a flag only ever seen as a longer one', () => {
    assert.equal(cliHelpAdvertisesFlag('--remotely', '--remote'), false)
    assert.equal(cliHelpAdvertisesFlag('--remote_control', '--remote'), false)
    assert.equal(cliHelpAdvertisesFlag('--remote-control', '--remote'), false)
  })

  it('treats a missing or non-string help text as "not advertised"', () => {
    // "cannot check this" must never be read as "nothing to check" — the
    // #7195 / #7210 shape. Failing closed is the only safe answer.
    for (const h of [undefined, null, 0, {}, '']) {
      assert.equal(cliHelpAdvertisesFlag(h, '--remote'), false)
    }
    assert.equal(cliHelpAdvertisesFlag('--remote', ''), false, 'empty flag')
  })

  it('does not let a regex metacharacter in the flag change the match', () => {
    // The flag is interpolated into a RegExp, so it must be escaped.
    assert.equal(cliHelpAdvertisesFlag('--a.c', '--a.c'), true)
    assert.equal(cliHelpAdvertisesFlag('--abc', '--a.c'), false,
      'an unescaped "." would match "b" here')
  })
})
