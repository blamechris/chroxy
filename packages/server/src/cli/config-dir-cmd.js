// `chroxy config-dir` — inspect and migrate the daemon's config/state root (#7240).
//
// #7052 made CHROXY_CONFIG_DIR relocate ALL daemon state. Anyone who already set
// it has ~20 files silently stranded at ~/.chroxy on upgrade. The daemon warns
// at startup and `chroxy doctor` reports it, but neither moves anything: copying
// an identity key and credentials into a directory the operator may have pointed
// at a shared, synced or bind-mounted volume is the operator's security decision,
// and the daemon cannot tell a fresh relocation from a deliberately clean root.
// So the copy lives here, behind an explicit command.

import { detectStrandedState, migrateStrandedState } from '../config-dir-migration.js'

/**
 * `chroxy config-dir status` — report the resolved root and anything stranded.
 *
 * @param {object} [deps] Injected seams: `write`, `detect`.
 * @returns {{ relocated: boolean, stranded: string[] }}
 */
export function runConfigDirStatus(deps = {}) {
  const out = deps.write || console.log
  const detect = deps.detect || detectStrandedState
  const d = detect()

  out(`Config/state root: ${d.target}${d.relocated ? ' (from CHROXY_CONFIG_DIR)' : ''}`)

  if (!d.relocated) {
    out('Not relocated — nothing can be stranded.')
    return { relocated: false, stranded: [] }
  }
  if (d.unreadable) {
    out(`Could not check ${d.source} for stranded state: ${d.unreadable}`)
    return { relocated: true, stranded: [] }
  }
  if (d.stranded.length === 0) {
    out(`No state stranded at ${d.source}.`)
    return { relocated: true, stranded: [] }
  }

  out('')
  out(`${d.stranded.length} state ${d.stranded.length === 1 ? 'entry is' : 'entries are'} still at ${d.source}:`)
  for (const name of d.stranded) {
    out(`  ${name}${d.highConsequence.includes(name) ? '   <- high consequence' : ''}`)
  }
  out('')
  out('Copy them forward with:  chroxy config-dir migrate --yes')
  return { relocated: true, stranded: d.stranded }
}

/**
 * `chroxy config-dir migrate` — copy stranded entries into the resolved root.
 *
 * Consequential (it moves secrets across a directory boundary the operator drew),
 * so it requires an explicit `--yes`; without it the command only explains.
 * Never overwrites: only entries absent from the target are copied.
 *
 * @param {{ yes?: boolean }} options
 * @param {object} [deps] Injected seams: `write`, `detect`, `migrate`.
 * @returns {{ migrated: boolean, result: object|null }}
 */
export function runConfigDirMigrate(options = {}, deps = {}) {
  const out = deps.write || console.log
  const detect = deps.detect || detectStrandedState
  const migrate = deps.migrate || migrateStrandedState
  const d = detect()

  if (!d.relocated) {
    out(`Config/state root is ${d.target} — not relocated, so nothing can be stranded.`)
    return { migrated: false, result: null }
  }
  if (d.unreadable) {
    out(`Could not read ${d.source}: ${d.unreadable}`)
    return { migrated: false, result: null }
  }
  if (d.stranded.length === 0) {
    out(`No state stranded at ${d.source} — ${d.target} is already up to date.`)
    return { migrated: false, result: null }
  }

  if (!options.yes) {
    out(
      [
        'chroxy config-dir migrate — copy stranded daemon state into the relocated root.',
        '',
        `  from: ${d.source}`,
        `  to:   ${d.target}`,
        '',
        `Would copy ${d.stranded.length} ${d.stranded.length === 1 ? 'entry' : 'entries'}:`,
        ...d.stranded.map((n) => `  ${n}${d.highConsequence.includes(n) ? '   <- high consequence' : ''}`),
        '',
        'Nothing already present in the destination is overwritten, and the source is',
        'left in place — this copies, it does not move.',
        '',
        'Note this copies secrets (identity key, credentials, API token) into the',
        'destination. If that directory is shared, synced or bind-mounted into a',
        'container, decide whether you want them there before proceeding.',
        '',
        'Re-run with --yes to proceed:',
        '  chroxy config-dir migrate --yes',
      ].join('\n'),
    )
    return { migrated: false, result: null }
  }

  const result = migrate({ detection: d })

  if (result.copied.length > 0) {
    out(`Copied ${result.copied.length} ${result.copied.length === 1 ? 'entry' : 'entries'} to ${result.target}:`)
    for (const name of result.copied) out(`  ${name}`)
  }
  if (result.failed.length > 0) {
    out('')
    out(`${result.failed.length} ${result.failed.length === 1 ? 'entry' : 'entries'} could NOT be copied:`)
    for (const f of result.failed) out(`  ${f.name}: ${f.error}`)
  }
  out('')
  out(`The original files are still at ${result.source} — remove them once the daemon`)
  out('has restarted successfully against the new root.')

  return { migrated: result.copied.length > 0, result }
}

export function registerConfigDirCommand(program) {
  const configDirCmd = program
    .command('config-dir')
    .description('Inspect and migrate the daemon\'s config/state root (CHROXY_CONFIG_DIR)')

  configDirCmd
    .command('status')
    .description('Show the resolved config/state root and any state stranded at ~/.chroxy')
    .action(() => {
      try {
        runConfigDirStatus()
      } catch (err) {
        console.error(`config-dir status failed: ${err.message}`)
        process.exitCode = 1
      }
    })

  configDirCmd
    .command('migrate')
    .description('Copy state stranded at ~/.chroxy into the relocated root (never overwrites)')
    .option('--yes', 'Confirm the copy (without this, the command only explains what it would do)')
    .action((options) => {
      try {
        const { result } = runConfigDirMigrate(options)
        // A partial copy is a failure the caller must be able to see — a script
        // that ignores it would report a migration that only half happened.
        if (result?.failed.length > 0) process.exitCode = 1
      } catch (err) {
        console.error(`config-dir migrate failed: ${err.message}`)
        process.exitCode = 1
      }
    })
}
