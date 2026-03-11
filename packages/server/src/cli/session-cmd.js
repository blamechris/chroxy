/**
 * chroxy sessions / chroxy resume — Session management commands
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { CONFIG_DIR } from './shared.js'

export function registerSessionCommands(program) {
  program
    .command('sessions')
    .description('List saved sessions with conversation IDs for terminal handoff')
    .action(() => {
      const stateFile = join(CONFIG_DIR, 'session-state.json')

      if (!existsSync(stateFile)) {
        console.log('\nNo saved sessions found.')
        console.log('Sessions are saved when the server runs.\n')
        process.exit(0)
      }

      let state
      try {
        state = JSON.parse(readFileSync(stateFile, 'utf-8'))
      } catch (err) {
        console.error(`Failed to read session state: ${err.message}`)
        process.exit(1)
      }

      if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
        console.log('\nNo saved sessions.\n')
        process.exit(0)
      }

      console.log(`\nSaved Sessions (${state.sessions.length})\n`)

      for (const session of state.sessions) {
        const convId = session.conversationId || session.sdkSessionId || null
        console.log(`  ${session.name}`)
        console.log(`    cwd: ${session.cwd}`)
        if (convId) {
          console.log(`    conversation: ${convId}`)
          console.log(`    resume: claude --resume ${convId}`)
        } else {
          console.log(`    conversation: (none — no messages sent yet)`)
        }
        console.log('')
      }

      if (state.timestamp) {
        const age = Math.round((Date.now() - state.timestamp) / 60000)
        console.log(`  Last saved: ${age} minute(s) ago\n`)
      }
    })

  program
    .command('resume')
    .description('Resume a Chroxy session in your terminal')
    .argument('[session]', 'Session name or number (default: most recent)')
    .option('--dangerously-skip-permissions', 'Pass --dangerously-skip-permissions to claude')
    .action(async (sessionArg, options) => {
      const { execFileSync } = await import('child_process')
      const stateFile = join(CONFIG_DIR, 'session-state.json')

      if (!existsSync(stateFile)) {
        console.error('No saved sessions found. Start the server first.')
        process.exit(1)
      }

      let state
      try {
        state = JSON.parse(readFileSync(stateFile, 'utf-8'))
      } catch (err) {
        console.error(`Failed to read session state: ${err.message}`)
        process.exit(1)
      }

      if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
        console.error('No saved sessions.')
        process.exit(1)
      }

      const resumable = state.sessions
        .map((s, i) => ({ ...s, index: i, convId: s.conversationId || s.sdkSessionId }))
        .filter(s => s.convId)

      if (resumable.length === 0) {
        console.error('No sessions have conversation IDs yet. Send a message first.')
        process.exit(1)
      }

      let target
      if (sessionArg) {
        const num = parseInt(sessionArg, 10)
        if (!isNaN(num) && num >= 1 && num <= resumable.length) {
          target = resumable[num - 1]
        } else {
          target = resumable.find(s => s.name.toLowerCase() === sessionArg.toLowerCase())
        }
        if (!target) {
          console.error(`Session "${sessionArg}" not found. Available:`)
          resumable.forEach((s, i) => console.error(`  ${i + 1}. ${s.name}`))
          process.exit(1)
        }
      } else if (resumable.length === 1) {
        target = resumable[0]
      } else {
        const readline = await import('readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        console.log('\nAvailable sessions:\n')
        resumable.forEach((s, i) => {
          console.log(`  ${i + 1}. ${s.name} (${s.cwd})`)
        })
        const answer = await new Promise(resolve => {
          rl.question(`\nPick session [1]: `, resolve)
        })
        rl.close()
        const pick = parseInt(answer, 10) || 1
        if (pick < 1 || pick > resumable.length) {
          console.error('Invalid selection.')
          process.exit(1)
        }
        target = resumable[pick - 1]
      }

      console.log(`\nResuming "${target.name}" in ${target.cwd}`)
      console.log(`Conversation: ${target.convId}\n`)

      const args = ['--resume', target.convId]
      if (options.dangerouslySkipPermissions) {
        args.push('--dangerously-skip-permissions')
      }

      try {
        execFileSync('claude', args, {
          stdio: 'inherit',
          cwd: target.cwd,
        })
      } catch (err) {
        if (err.status != null) process.exit(err.status)
        throw err
      }
    })
}
