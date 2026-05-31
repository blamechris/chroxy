#!/usr/bin/env node
/**
 * tui-form-recorder.mjs — record keystrokes + PTY output while driving
 * claude TUI through a multi-question AskUserQuestion form (#4604).
 *
 * Usage:
 *   node scripts/tui-form-recorder.mjs [project-dir]
 *
 * Project-dir defaults to the cwd. Output is written to:
 *   /tmp/tui-form-recording-<timestamp>.jsonl
 *
 * Each line is one event:
 *   { t: <ms_since_start>, kind: 'in' | 'out', data: <string> }
 *
 * Driver workflow:
 *   1. Run the recorder
 *   2. Wait for claude TUI to render its prompt
 *   3. Type a prompt that triggers a multi-question AskUserQuestion
 *      (e.g. "Help me scope a new project — ask me about tech stack, inputs, provider, platform")
 *   4. When the form renders, answer it manually using whatever keys work
 *   5. After Submit succeeds, press Ctrl+D to end the recording cleanly
 *
 * Analysis: tail the JSONL file to find the keystroke patterns that
 * advance between questions, toggle multiSelect, and reach Submit.
 *
 * Exit:
 *   Ctrl+D — clean exit (closes recording file)
 *   Ctrl+\ — kill claude immediately
 */

import { resolve } from 'node:path'
import { writeFileSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// npm workspaces hoists node-pty to the root node_modules/.
const ptyMod = await import('/Users/blamechris/Projects/chroxy/node_modules/node-pty/lib/index.js')

const projectDir = resolve(process.argv[2] || process.cwd())
const claudeBin = '/Users/blamechris/.local/bin/claude'

const recordingPath = join(tmpdir(), `tui-form-recording-${Date.now()}.jsonl`)
const recording = createWriteStream(recordingPath, { encoding: 'utf8' })
const startMs = Date.now()

const log = (kind, data) => {
  recording.write(JSON.stringify({
    t: Date.now() - startMs,
    kind,
    data,
  }) + '\n')
}

process.stdout.write(`\x1b[33m=== tui-form-recorder ===\x1b[0m\n`)
process.stdout.write(`Recording to: ${recordingPath}\n`)
process.stdout.write(`Spawning claude in: ${projectDir}\n`)
process.stdout.write(`Press Ctrl+D when done (recording flushed cleanly).\n`)
process.stdout.write(`Press Ctrl+\\ to kill claude.\n\n`)

const cols = process.stdout.columns || 120
const rows = process.stdout.rows || 40

const term = ptyMod.spawn(claudeBin, [], {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: projectDir,
  env: process.env,
})

term.onData((chunk) => {
  process.stdout.write(chunk)
  log('out', chunk)
})

term.onExit(({ exitCode, signal }) => {
  recording.end()
  process.stdout.write(`\n\x1b[33m=== claude exited (code=${exitCode} signal=${signal}) ===\x1b[0m\n`)
  process.stdout.write(`Recording: ${recordingPath}\n`)
  process.exit(exitCode || 0)
})

// Raw mode so we capture every keystroke (arrow keys, Tab, etc.) as bytes
process.stdin.setRawMode(true)
process.stdin.resume()

process.stdin.on('data', (buf) => {
  const data = buf.toString('binary')
  // Ctrl+D — accept both plain 0x04 (most terminals) AND iTerm's modify-other-keys
  // form `\x1b[27;5;100~` (CSI 27 = modify-other-keys, 5 = Ctrl modifier, 100 = ASCII
  // 'd' lowercase). Without the second branch the script ran indefinitely after the
  // user's Ctrl+D was eaten by iTerm's CSI encoding during the #4604 empirical pass.
  if (data === '\x04' || data === '\x1b[27;5;100~') {
    process.stdout.write(`\n\x1b[33m=== ending recording (Ctrl+D) ===\x1b[0m\n`)
    log('in', '<<CTRL-D EXIT>>')
    recording.end()
    term.kill('SIGTERM')
    process.exit(0)
  }
  // Pass through to claude + log
  log('in', data)
  term.write(buf)
})

process.stdout.on('resize', () => {
  term.resize(process.stdout.columns || 120, process.stdout.rows || 40)
})
