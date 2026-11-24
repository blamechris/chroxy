/**
 * `chroxy freshness`: usage errors reach the runner and exit 2 (refused), as
 * the guide says, instead of commander's default exit 1. Each rule has a mutant
 * (an edit to a copy of `src`) that must fail its check.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Command } from 'commander'
import { REAL_RUNNER, cleanupVariants, must, mustKillRunner } from './helpers/runner-harness.js'

process.on('exit', cleanupVariants)

const proves = (name, check, mutants = {}) =>
  describe(name, () => {
    it('holds on the real code', async () => {
      await check(REAL_RUNNER)
    })
    for (const [label, edits] of Object.entries(mutants)) it(`mutant "${label}" fails it`, () => mustKillRunner(check, label, edits))
  })

const edit = (file, from, to) => ({ file, from, to })
const C = 'cli/freshness-cmd.js'

/** Parse `argv` through the registered command; returns the exit code the action left, quietly. */
async function exitCodeOf(M, argv) {
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  M.registerFreshnessCommand(program)
  const realWrite = process.stderr.write
  const before = process.exitCode
  process.exitCode = undefined
  process.stderr.write = () => true
  try {
    await must(() => program.parseAsync(['node', 'chroxy', 'freshness', ...argv]), 'the parse')
    return process.exitCode
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err
    return assert.fail(`the command threw ${err.name}: ${err.message}`)
  } finally {
    process.stderr.write = realWrite
    process.exitCode = before
  }
}

proves(
  'a missing required option, or an unknown one, exits 2 through the front door',
  async (M) => {
    assert.equal(await exitCodeOf(M, ['tick']), 2, 'no --ledger-dir')
    assert.equal(await exitCodeOf(M, ['stamp']), 2, 'no --commit')
    assert.equal(await exitCodeOf(M, ['tick', '--ledger-dir', '/nonexistent/x', '--nope']), 2, 'an unknown option')
    assert.equal(await exitCodeOf(M, ['tick', '--ledger-dir', '/nonexistent/x', 'extra']), 2, 'an extra argument')
  },
  {
    'tick requires its option in commander': [edit(C, ".option('--ledger-dir <dir>', 'ledger directory; must be outside the daemon state directory (required)')", ".requiredOption('--ledger-dir <dir>', 'ledger directory')")],
    'stamp requires its option in commander': [edit(C, ".option('--commit <sha>', 'full 40-character commit id the install was built from (required)')", ".requiredOption('--commit <sha>', 'commit')")],
    'unknown options are rejected by commander': [edit(C, '    .allowUnknownOption()\n    .allowExcessArguments()\n    .action(async (options, cmd) => {\n      const { main } = await import(\'../freshness-runner/cli.js\')\n      process.exitCode = main([\'tick\'', "    .action(async (options, cmd) => {\n      const { main } = await import('../freshness-runner/cli.js')\n      process.exitCode = main(['tick'")],
  },
)
