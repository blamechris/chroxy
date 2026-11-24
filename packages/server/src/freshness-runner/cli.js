#!/usr/bin/env node
/**
 * Entry point of the freshness runner: `tick` runs one read-only tick and
 * exits, `stamp` records the commit of a pinned install.
 *
 *   node <install>/node_modules/@chroxy/server/src/freshness-runner/cli.js tick --ledger-dir <dir> [options]
 *   node <install>/node_modules/@chroxy/server/src/freshness-runner/cli.js stamp --commit <sha>
 *
 * It starts no daemon and loads no daemon command. Exit codes: 0 ticked,
 * 1 a source's tick failed (the others ran), 2 refused (usage, build not
 * pinned or not stamped, ledger inside the daemon's state directory or a
 * source, ledger corrupt or fenced), 3 the ledger is held by another reconciler.
 */

import { parseArgs } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BuildError, readBuild } from './build-info.js'
import { runTick } from './run-tick.js'
import { stampBuild } from './stamp.js'
import { LedgerHeldError } from '../freshness/index.js'
import { isEntryPoint } from '../utils/is-entry-point.js'

export const USAGE = [
  'usage: freshness tick --ledger-dir <dir> [--state-file <file>] [--registry-dir <dir>] [--projects-dir <dir>]',
  '                      [--cadence-minutes <n>] [--lease-minutes <n>] [--ledger-id <id>] [--mode read-only] [--allow-dev-checkout]',
  '       freshness stamp --commit <40-hex sha> [--package-dir <dir>] [--force]',
].join('\n')

/** The daemon package directory this file belongs to. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const OPTIONS = {
  'ledger-dir': { type: 'string' },
  'state-file': { type: 'string' },
  'registry-dir': { type: 'string' },
  'projects-dir': { type: 'string' },
  'cadence-minutes': { type: 'string' },
  'lease-minutes': { type: 'string' },
  'ledger-id': { type: 'string' },
  mode: { type: 'string' },
  'allow-dev-checkout': { type: 'boolean' },
  commit: { type: 'string' },
  'package-dir': { type: 'string' },
  force: { type: 'boolean' },
}

function num(name, v) {
  if (v === undefined) return undefined
  if (!/^[0-9]+(\.[0-9]+)?$/.test(v)) throw new TypeError(`${name} must be a number`)
  return Number(v)
}

/**
 * Run the command in `argv` (the arguments after the script). Returns the
 * exit code; writes one JSON line to `out` on success and a message to `err`.
 */
export function main(argv, { out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n'), packageRoot = PACKAGE_ROOT, now = Date.now() } = {}) {
  let cmd
  let values
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
    ;[cmd] = parsed.positionals
    values = parsed.values
    if (parsed.positionals.length !== 1 || (cmd !== 'tick' && cmd !== 'stamp')) throw new TypeError('expected one command: tick or stamp')
  } catch (e) {
    err(`${e.message}\n${USAGE}`)
    return 2
  }
  try {
    if (cmd === 'stamp') {
      if (values.commit === undefined) throw new TypeError('--commit is required')
      const file = stampBuild(values['package-dir'] ? path.resolve(values['package-dir']) : packageRoot, values.commit, { force: values.force === true })
      out(JSON.stringify({ stamped: file }))
      return 0
    }
    if (values['ledger-dir'] === undefined) throw new TypeError('--ledger-dir is required: the ledger must sit outside the daemon state directory, so it has no default')
    const build = readBuild(packageRoot, { allowCheckout: values['allow-dev-checkout'] === true })
    const summary = runTick({
      ledgerDir: path.resolve(values['ledger-dir']),
      build,
      stateFile: values['state-file'] && path.resolve(values['state-file']),
      registryDir: values['registry-dir'] && path.resolve(values['registry-dir']),
      projectsDir: values['projects-dir'] && path.resolve(values['projects-dir']),
      ledgerId: values['ledger-id'],
      cadenceMinutes: num('--cadence-minutes', values['cadence-minutes']),
      leaseMinutes: num('--lease-minutes', values['lease-minutes']),
      mode: values.mode,
      now,
    })
    out(JSON.stringify(summary))
    return summary.failed.length === 0 ? 0 : 1
  } catch (e) {
    if (e instanceof LedgerHeldError) {
      err('the ledger is held by another reconciler; no source was ticked')
      return 3
    }
    err(e instanceof BuildError || e instanceof TypeError ? `refused: ${e.message}` : `refused: ${e?.name ?? 'Error'}: ${e?.message}`)
    return 2
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
