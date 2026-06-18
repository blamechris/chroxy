#!/usr/bin/env node
/**
 * chroxy-hooks — CLI entry (#5413 Phase 4).
 *
 *   chroxy-hooks install     register hook emitters in ~/.claude/settings.json
 *                            (idempotent; CHROXY_HOOKS_SETTINGS_PATH overrides)
 *   chroxy-hooks uninstall   remove ONLY chroxy-hooks entries
 *   chroxy-hooks emit <t>    hook mode: read stdin payload, POST to the
 *                            daemon's /api/events, ALWAYS exit 0 silently
 *
 * `emit` is what Claude Code invokes on every hook fire — it must never
 * exit non-zero, never print to stdout, and stay under the ~100ms budget
 * (no npx, short fetch timeout, fail-silent when the daemon is down).
 */

import { runEmit } from '../src/emit.js'
import { installHooks, uninstallHooks, defaultSettingsPath } from '../src/installer.js'

const MAX_STDIN_BYTES = 1024 * 1024
const STDIN_TIMEOUT_MS = 1000

function readStdin() {
  return new Promise((resolvePromise) => {
    let buf = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolvePromise(buf)
    }
    // Hooks always close stdin promptly; the timer is a backstop so a
    // misbehaving parent can't wedge the emitter past its budget.
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS)
    timer.unref?.()
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
      if (buf.length > MAX_STDIN_BYTES) finish()
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
  })
}

function usage() {
  process.stderr.write(
    'Usage: chroxy-hooks <install|uninstall|emit <type>>\n' +
    '  install     register Claude Code hooks (idempotent)\n' +
    '  uninstall   remove chroxy-hooks entries only\n' +
    '  emit <t>    hook mode (reads stdin, POSTs to chroxy, always exits 0)\n'
  )
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === 'emit') {
    // Hook context: every failure is silent, exit code is ALWAYS 0.
    try {
      const stdinText = await readStdin()
      await runEmit({ hookEventArg: rest[0] || null, stdinText })
    } catch {
      // swallow — never break Claude Code
    }
    process.exit(0)
  }

  if (command === 'install') {
    try {
      const path = installHooks({ settingsPath: defaultSettingsPath() })
      process.stdout.write(`chroxy-hooks: hooks registered in ${path}\n`)
      process.stdout.write('Events: SessionStart, SessionEnd, SubagentStart, SubagentStop, Notification, PostToolUse, UserPromptSubmit, Stop\n')
      process.stdout.write('Re-run any time (idempotent). Remove with: chroxy-hooks uninstall\n')
      process.exit(0)
    } catch (err) {
      process.stderr.write(`chroxy-hooks: install failed: ${err.message}\n`)
      process.exit(1)
    }
  }

  if (command === 'uninstall') {
    try {
      const path = uninstallHooks({ settingsPath: defaultSettingsPath() })
      process.stdout.write(`chroxy-hooks: chroxy-hooks entries removed from ${path}\n`)
      process.exit(0)
    } catch (err) {
      process.stderr.write(`chroxy-hooks: uninstall failed: ${err.message}\n`)
      process.exit(1)
    }
  }

  usage()
  process.exit(command ? 1 : 0)
}

main()
