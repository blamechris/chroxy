/**
 * chroxy sessions / chroxy resume — Session management commands
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { configDir, configFile } from './shared.js'
import { resolveBinaryProvenanceMode, isBinarySignatureGateEnabled } from '../config.js'
import { runProviderPreflight, buildBinaryProvenanceOptions } from '../utils/preflight.js'
import { BinaryProvenanceLedger } from '../binary-provenance-trust.js'
import { CliSession } from '../cli-session.js'

/** Read config.json best-effort — never throws, never exits (mirrors worktree-gc-cmd.js / schedule-cmd.js). */
function readConfigSoft(configPath) {
  try {
    if (!existsSync(configPath)) return {}
    return JSON.parse(readFileSync(configPath, 'utf-8')) || {}
  } catch {
    return {}
  }
}

/**
 * #8061 — resolve AND verify the exact `claude` binary `chroxy session resume`
 * is about to exec, through the SAME opt-in provenance gate a fresh chat
 * session (or the summarizer/web-task one-shots) would run:
 * `runProviderPreflight(ProviderClass, { provenance })`, the machinery
 * `SessionManager.verifyOneShotExecutable()` wraps (#8030/#8036) — reused
 * here rather than a second gate implementation.
 *
 * This CLI subcommand runs standalone, with no daemon `SessionManager`
 * instance to read `_binaryProvenanceMode` / `_binarySignatureGate` /
 * `binaryProvenanceLedger` off of. So the two flags are resolved straight
 * from the loaded config via the exact same resolvers `chroxy start` uses
 * (`resolveBinaryProvenanceMode` / `isBinarySignatureGateEnabled`), folded
 * into the options bag through the SAME normalizer
 * `SessionManager._binaryProvenanceOptions()` uses
 * (`buildBinaryProvenanceOptions`, utils/preflight.js) — so "the gate is off"
 * is defined once, not twice — and the ledger opens at its default path
 * (`BinaryProvenanceLedger()` → `~/.chroxy/binary-trust.json`, or
 * `$CHROXY_CONFIG_DIR/binary-trust.json`): the SAME file the daemon
 * pins/approves against, so a hash already trusted (or already refused) by
 * the daemon is honored here too.
 *
 * `chroxy session resume` always shells out to the `claude` CLI directly —
 * never the Agent SDK, never claude-tui's PTY — so `CliSession` (whose
 * `preflight` / `resolvedBinary` describe exactly that binary, the same
 * class `web-task-manager.js`'s one-shot spawns gate against, #8039) is the
 * provider to verify: the same binary a fresh `claude-cli` chat session
 * would refuse under `binaryProvenance.mode: 'block'` is refused here too.
 *
 * Fails CLOSED: any thrown error — one of `runProviderPreflight`'s typed
 * errors (`ProviderBinaryProvenanceError`, `ProviderBinaryNotFoundError`, …)
 * or the `PROVIDER_BINARY_UNVERIFIED` this throws itself when preflight
 * resolves no path — propagates to the caller, which must print it and exit
 * non-zero WITHOUT spawning anything. Never calls `process.exit` itself, so
 * it stays safely unit-testable in-process (#8061 tests).
 *
 * @param {object} [deps] - test seams; production supplies none of them.
 * @param {Function} [deps.readConfig] - defaults to reading config.json soft.
 * @param {object} [deps.ledger] - defaults to the real, default-path ledger.
 * @param {Function} [deps.preflight] - defaults to `runProviderPreflight`.
 * @param {Function} [deps.ProviderClass] - defaults to `CliSession`.
 * @returns {string} the verified, spawnable absolute path to `claude`.
 */
export function resolveVerifiedClaudeBinary({
  readConfig = () => readConfigSoft(configFile()),
  ledger = new BinaryProvenanceLedger(),
  preflight = runProviderPreflight,
  ProviderClass = CliSession,
} = {}) {
  const config = readConfig()
  const provenance = buildBinaryProvenanceOptions({
    mode: resolveBinaryProvenanceMode(config),
    signatureGate: isBinarySignatureGateEnabled(config),
    ledger,
  })
  const result = preflight(ProviderClass, { provenance })
  if (!result.binaryPath) {
    const err = new Error(`Could not verify a spawnable binary for provider "${ProviderClass.displayLabel || ProviderClass.name || 'claude-cli'}".`)
    err.code = 'PROVIDER_BINARY_UNVERIFIED'
    throw err
  }
  return result.binaryPath
}

export function registerSessionCommands(program) {
  program
    .command('sessions')
    .description('List saved sessions with conversation IDs for terminal handoff')
    .action(() => {
      const stateFile = join(configDir(), 'session-state.json')

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
      await runSessionResume(sessionArg, options)
    })
}

/**
 * Core `chroxy session resume` logic, extracted from the Commander `.action()`
 * above so it is directly callable — with injectable deps — from tests
 * without spawning a subprocess (#8061). Production callers (the `.action()`
 * above) pass no `deps`, so every seam below resolves to the exact same
 * behaviour this command always had, plus the #8061 binary-verification gate.
 *
 * @param {string|undefined} sessionArg - session name or 1-based index.
 * @param {{ dangerouslySkipPermissions?: boolean }} options - Commander options.
 * @param {object} [deps]
 * @param {string} [deps.stateFile] - defaults to `<configDir>/session-state.json`.
 * @param {Function} [deps.resolveBinary] - defaults to `resolveVerifiedClaudeBinary`
 *   (called with no args, i.e. every production default). Tests inject a
 *   thunk that calls `resolveVerifiedClaudeBinary` with a fixture provider /
 *   ledger / config instead of exercising the real host `claude` install.
 */
export async function runSessionResume(sessionArg, options, deps = {}) {
  const {
    stateFile = join(configDir(), 'session-state.json'),
    resolveBinary = resolveVerifiedClaudeBinary,
  } = deps

  const { execFileSync } = await import('child_process')

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

  // #8061 — resolve AND verify the exact binary before printing anything that
  // implies a resume is actually happening, and before touching execFileSync
  // at all. A refusal here fails CLOSED: nothing is spawned, and this
  // function never calls `process.exit` itself (see `runSessionResume`'s
  // docblock) so it stays unit-testable in-process — `process.exitCode` is
  // set instead, which the real CLI process exits with exactly the same way.
  let verifiedClaudePath
  try {
    verifiedClaudePath = resolveBinary()
  } catch (err) {
    console.error(`\nRefusing to resume: ${err.message}`)
    process.exitCode = 1
    return
  }

  console.log(`\nResuming "${target.name}" in ${target.cwd}`)
  console.log(`Conversation: ${target.convId}\n`)

  const args = ['--resume', target.convId]
  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions')
  }

  try {
    execFileSync(verifiedClaudePath, args, {
      stdio: 'inherit',
      cwd: target.cwd,
    })
  } catch (err) {
    if (err.status != null) process.exit(err.status)
    throw err
  }
}
