/**
 * `chroxy freshness` — the session freshness reconciler's runner (#9282).
 *
 * `tick` runs one read-only tick over the daemon's state file, the Claude
 * Code session registry and the Claude transcripts, then exits. `stamp`
 * records the commit of a pinned install. Both delegate to the runner, which
 * a timer can also start directly without this CLI (docs/guides/freshness-runner.md).
 */
/* Usage errors are the runner's to report (exit 2), so the options here are not
 * required and unknown ones are passed through to its strict parser. */
export function registerFreshnessCommand(program) {
  const freshness = program.command('freshness').description('Session freshness reconciler: run one read-only tick, or stamp a pinned install')
  freshness
    .command('tick')
    .description('Run one read-only tick and exit')
    .option('--ledger-dir <dir>', 'ledger directory; must be outside the daemon state directory (required)')
    .option('--state-file <file>', "the daemon's session-state file (default: <config dir>/session-state.json)")
    .option('--registry-dir <dir>', 'Claude Code session registry (default: <claude config dir>/sessions)')
    .option('--projects-dir <dir>', 'Claude transcripts root (default: <claude config dir>/projects)')
    .option('--cadence-minutes <n>', 'tick cadence; the timer period should match')
    .option('--lease-minutes <n>', 'writer lease; must exceed the cadence')
    .option('--ledger-id <id>', 'ledger identity')
    .option('--mode <mode>', 'read-only is the only mode')
    .option('--allow-dev-checkout', 'run from a development checkout (not for a timer)')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (options, cmd) => {
      const { main } = await import('../freshness-runner/cli.js')
      process.exitCode = main(['tick', ...toArgs(options), ...cmd.args])
    })
  freshness
    .command('stamp')
    .description('Record the commit of a pinned install in its package directory')
    .option('--commit <sha>', 'full 40-character commit id the install was built from (required)')
    .option('--package-dir <dir>', 'installed daemon package directory (default: this package)')
    .option('--force', 'replace a different existing stamp')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (options, cmd) => {
      const { main } = await import('../freshness-runner/cli.js')
      process.exitCode = main(['stamp', ...toArgs(options), ...cmd.args])
    })
}

function toArgs(options) {
  const args = []
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === false) continue
    const flag = '--' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
    args.push(value === true ? flag : `${flag}=${value}`)
  }
  return args
}
