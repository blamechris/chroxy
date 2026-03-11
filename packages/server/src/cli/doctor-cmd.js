/**
 * chroxy doctor — Check dependencies and environment
 */
export function registerDoctorCommand(program) {
  program
    .command('doctor')
    .description('Check that all dependencies are installed and configured correctly')
    .option('-p, --port <port>', 'Port to check availability (default: 8765)')
    .action(async (options) => {
      const { runDoctorChecks } = await import('../doctor.js')

      const port = options.port ? parseInt(options.port, 10) : undefined
      const { checks, passed } = await runDoctorChecks({ port })

      console.log('\nChroxy Doctor\n')

      const STATUS_ICONS = { pass: '\x1b[32m OK \x1b[0m', warn: '\x1b[33mWARN\x1b[0m', fail: '\x1b[31mFAIL\x1b[0m' }

      for (const check of checks) {
        console.log(`  [${STATUS_ICONS[check.status]}] ${check.name.padEnd(12)} ${check.message}`)
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
