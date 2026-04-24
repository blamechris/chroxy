/**
 * chroxy doctor — Check dependencies and environment
 */
export function registerDoctorCommand(program) {
  program
    .command('doctor')
    .description('Check that all dependencies are installed and configured correctly')
    .option('-p, --port <port>', 'Port to check availability (default: 8765)')
    .option('--provider <name>', 'Override provider(s) to preflight (comma-separated)')
    .action(async (options) => {
      const { runDoctorChecks } = await import('../doctor.js')

      const port = options.port ? parseInt(options.port, 10) : undefined
      const providers = options.provider
        ? options.provider.split(',').map(s => s.trim()).filter(Boolean)
        : undefined
      const result = await runDoctorChecks({ port, providers })
      const { checks, passed } = result

      console.log('\nChroxy Doctor\n')

      const STATUS_ICONS = { pass: '\x1b[32m OK \x1b[0m', warn: '\x1b[33mWARN\x1b[0m', fail: '\x1b[31mFAIL\x1b[0m' }

      // Group checks into sections: general checks (no provider), then per-provider.
      const general = checks.filter(c => !c.provider)
      const byProvider = new Map()
      for (const c of checks) {
        if (!c.provider) continue
        if (!byProvider.has(c.provider)) byProvider.set(c.provider, [])
        byProvider.get(c.provider).push(c)
      }

      for (const check of general) {
        console.log(`  [${STATUS_ICONS[check.status]}] ${check.name.padEnd(18)} ${check.message}`)
      }

      for (const [providerName, providerChecks] of byProvider) {
        console.log(`\n  Provider: ${providerName}`)
        for (const check of providerChecks) {
          console.log(`    [${STATUS_ICONS[check.status]}] ${check.name.padEnd(18)} ${check.message}`)
        }
      }

      console.log('')
      if (passed) {
        console.log('All checks passed. Ready to start.\n')
      } else {
        console.log('Some checks failed. Fix the issues above and try again.\n')
        process.exitCode = 1
      }
    })
}
