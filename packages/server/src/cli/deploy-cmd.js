/**
 * chroxy deploy — Validate and restart the running server
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { CONFIG_DIR } from './shared.js'
import { isWindows } from '../platform.js'

export function registerDeployCommand(program) {
  program
    .command('deploy')
    .description('Validate and restart the running Chroxy server')
    .option('--dry-run', 'Validate only, do not restart')
    .option('--skip-tests', 'Skip running server tests')
    .action(async (options) => {
      const { execFileSync } = await import('child_process')

      const PID_FILE = join(CONFIG_DIR, 'supervisor.pid')
      const LOCK_FILE = join(CONFIG_DIR, 'update.lock')
      const KNOWN_GOOD_FILE = join(CONFIG_DIR, 'known-good-ref')

      let lockAcquired = false
      try {
        // 1. Pre-checks
        console.log('\n[deploy] Pre-checks...')

        const gitStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trim()
        if (gitStatus) {
          console.error('[deploy] Working tree is not clean. Commit or stash changes first.')
          console.error(gitStatus)
          process.exitCode = 1
          return
        }

        if (existsSync(LOCK_FILE)) {
          const lockPid = readFileSync(LOCK_FILE, 'utf-8').trim()
          try {
            process.kill(parseInt(lockPid, 10), 0)
            console.error(`[deploy] Another deploy is in progress (pid: ${lockPid})`)
            process.exitCode = 1
            return
          } catch {
            unlinkSync(LOCK_FILE)
          }
        }

        if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
        writeFileSync(LOCK_FILE, String(process.pid))
        lockAcquired = true

        // 2. Validate JS files
        console.log('[deploy] Validating JavaScript files...')
        const knownGoodRef = existsSync(KNOWN_GOOD_FILE)
          ? readFileSync(KNOWN_GOOD_FILE, 'utf-8').trim()
          : null

        const jsFiles = knownGoodRef
          ? execFileSync('git', ['diff', '--name-only', knownGoodRef, '--', 'packages/server/src/'], { encoding: 'utf-8' })
              .trim().split('\n').filter((f) => f.endsWith('.js'))
          : execFileSync('git', ['ls-files', '--', 'packages/server/src/'], { encoding: 'utf-8' })
              .trim().split('\n').filter((f) => f.endsWith('.js'))

        let validationErrors = 0
        for (const file of jsFiles) {
          if (!file) continue
          const fullPath = join(process.cwd(), file)
          if (!existsSync(fullPath)) continue
          try {
            execFileSync('node', ['--check', fullPath], { stdio: 'pipe' })
          } catch (err) {
            console.error(`[deploy] Syntax error in ${file}:`)
            console.error(err.stderr?.toString() || err.message)
            validationErrors++
          }
        }

        if (validationErrors > 0) {
          console.error(`[deploy] ${validationErrors} file(s) failed validation`)
          process.exitCode = 1
          return
        }
        console.log(`[deploy] ${jsFiles.filter(Boolean).length || 0} file(s) validated`)

        // 3. Run tests
        if (!options.skipTests) {
          const testDir = join(process.cwd(), 'packages', 'server', 'tests')
          if (existsSync(testDir)) {
            console.log('[deploy] Running server tests...')
            try {
              execFileSync('node', ['--test', testDir], {
                stdio: 'inherit',
                timeout: 120000,
              })
              console.log('[deploy] Tests passed')
            } catch {
              console.error('[deploy] Tests failed')
              process.exitCode = 1
              return
            }
          }
        } else {
          console.log('[deploy] Skipping tests (--skip-tests)')
        }

        if (options.dryRun) {
          console.log('[deploy] Dry run complete. No restart performed.')
          return
        }

        // 4. Tag known-good commit
        const headHash = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
        const tagName = `known-good-${Date.now()}`
        execFileSync('git', ['tag', tagName])
        writeFileSync(KNOWN_GOOD_FILE, headHash)
        console.log(`[deploy] Tagged ${headHash.slice(0, 8)} as ${tagName}`)

        try {
          const allTags = execFileSync('git', ['tag', '--list', 'known-good-*', '--sort=-creatordate'], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)
          const stale = allTags.slice(5)
          for (const old of stale) {
            execFileSync('git', ['tag', '-d', old], { stdio: 'pipe' })
          }
          if (stale.length > 0) console.log(`[deploy] Pruned ${stale.length} old known-good tag(s)`)
        } catch (err) {
          console.warn(`[deploy] Warning: failed to prune old tags: ${err.message}`)
        }

        // 5. Signal supervisor
        if (!existsSync(PID_FILE)) {
          console.error('[deploy] Supervisor PID file not found. Is chroxy running with supervisor mode?')
          process.exitCode = 1
          return
        }

        const supervisorPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
        if (isNaN(supervisorPid)) {
          console.error('[deploy] Invalid supervisor PID')
          process.exitCode = 1
          return
        }

        try {
          process.kill(supervisorPid, 0)
        } catch {
          console.error(`[deploy] Supervisor (pid ${supervisorPid}) is not running`)
          process.exitCode = 1
          return
        }

        if (isWindows) {
          console.error('[deploy] Deploy restart via SIGUSR2 is not supported on Windows.')
          console.error('   Restart the server manually: npx chroxy start')
          process.exitCode = 1
          return
        }

        console.log(`[deploy] Signaling supervisor (pid ${supervisorPid}) to restart...`)
        process.kill(supervisorPid, 'SIGUSR2')
        console.log('[deploy] Deploy signal sent. Server will restart momentarily.\n')

      } finally {
        if (lockAcquired) {
          try { unlinkSync(LOCK_FILE) } catch {}
        }
      }
    })
}
