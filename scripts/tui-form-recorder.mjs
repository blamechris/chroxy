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
 * 10+ option questions (#4625 + #4848 + #4880 — RESOLVED 2026-06-07):
 *   #4848 added native drive for single-select 10+ option picks via
 *   arrow-key navigation ('\x1b[B' down × matchIdx + '\r' Enter to commit),
 *   the conservative bet of two theoretically-possible paths (the
 *   multi-digit hotkey path was ruled out — claude TUI's single-digit
 *   commit-on-keystroke behaviour pinned in #4292 means a '1' would
 *   commit option 1 before the '0' arrived).
 *
 *   **Empirical finding (#4880):** the recorder pass against a 10+ option
 *   AskUserQuestion ran and proved the form is UNREACHABLE — claude TUI
 *   v2.1.168 hard-caps each AskUserQuestion question at 4 options. A prompt
 *   asking for 12 options fails server-side with
 *   `InputValidationError: too_big, maximum: 4, path: questions[0].options`
 *   before any form renders (recording: docs/empirical/4880-twelve-option-cap.jsonl).
 *   So `_writePtyArrowNavSequence` and the multi-select TOO_MANY_OPTIONS bail
 *   are dead code on this TUI version, kept as forward-compat for a future
 *   claude that raises the cap. Re-run this recorder if/when that happens;
 *   only then can the arrow-nav bytes be empirically pinned.
 *
 * Exit:
 *   Ctrl+D — clean exit (closes recording file)
 *   Ctrl+\ — kill claude immediately
 */

import { resolve } from 'node:path'
import { writeFileSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushAndExit } from './flush-and-exit.mjs'

// npm workspaces hoists node-pty to the root node_modules/.
const ptyMod = await import('/Users/blamechris/Projects/chroxy/node_modules/node-pty/lib/index.js')

const projectDir = resolve(process.argv[2] || process.cwd())
const claudeBin = '/Users/blamechris/.local/bin/claude'

const recordingPath = join(tmpdir(), `tui-form-recording-${Date.now()}.jsonl`)
const recording = createWriteStream(recordingPath, { encoding: 'utf8' })
const startMs = Date.now()

// Once true, log() becomes a no-op. flushAndExit() calls recording.end()
// internally and any later log() (e.g. a late term.onData chunk arriving
// after we kicked off shutdown in the Ctrl+D path) would otherwise throw
// ERR_STREAM_WRITE_AFTER_END (#4729 review feedback).
let recordingClosed = false

const log = (kind, data) => {
  if (recordingClosed) return
  recording.write(JSON.stringify({
    t: Date.now() - startMs,
    kind,
    data,
  }) + '\n')
}

const closeRecording = (exitCode) => {
  if (recordingClosed) return
  recordingClosed = true
  flushAndExit(recording, exitCode)
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
  process.stdout.write(`\n\x1b[33m=== claude exited (code=${exitCode} signal=${signal}) ===\x1b[0m\n`)
  process.stdout.write(`Recording: ${recordingPath}\n`)
  // Wait for the recording stream to flush before exiting — process.exit
  // does not wait for buffered writes and was silently truncating the JSONL
  // (#4729). closeRecording guards against double-close from the Ctrl+D
  // path also triggering onExit via SIGTERM.
  closeRecording(exitCode || 0)
})

// Raw mode so we capture every keystroke (arrow keys, Tab, etc.) as bytes
process.stdin.setRawMode(true)
process.stdin.resume()

// Ctrl+D detector — terminals with modify-other-keys / CSI u key encoding wrap
// Ctrl+letter combos in CSI sequences instead of sending the raw control byte.
// Without this coverage the recorder runs indefinitely when a user presses Ctrl+D
// in those emulators (originally surfaced for iTerm during the #4604 pass,
// extended to the broader CSI 27 / CSI u family for #4623).
//
// Accepted forms (verified against each terminal's docs / source):
//   \x04                  — raw 0x04 EOT byte. Default tty behaviour: Terminal.app,
//                           Alacritty (no modify-other-keys), plain xterm, tmux,
//                           screen, and any terminal that hasn't been switched into
//                           an enhanced keyboard mode.
//   \x1b[27;5;100~        — xterm modifyOtherKeys=2 form: CSI 27 ; <mods> ; <code> ~
//                           where 5 = Ctrl modifier and 100 = ASCII 'd'. Emitted by
//                           iTerm2, Konsole, and xterm with `modifyOtherKeys=2`.
//   \x1b[100;5u           — CSI u (fixterms / Paul Evans) form: <code> ; <mods> u.
//                           Emitted by kitty, WezTerm with
//                           `enable_csi_u_key_encoding = true`, foot, and other
//                           terminals advertising the kitty keyboard protocol.
const CTRL_D_SEQUENCES = new Set([
  '\x04',
  '\x1b[27;5;100~',
  '\x1b[100;5u',
])

process.stdin.on('data', (buf) => {
  const data = buf.toString('binary')
  if (CTRL_D_SEQUENCES.has(data)) {
    process.stdout.write(`\n\x1b[33m=== ending recording (Ctrl+D) ===\x1b[0m\n`)
    log('in', '<<CTRL-D EXIT>>')
    term.kill('SIGTERM')
    // Wait for the recording stream to flush before exiting — the SIGTERM
    // above races the JSONL flush, and process.exit does not wait for
    // buffered writes (#4729). closeRecording also flips recordingClosed
    // so any late onData chunk arriving after kill() becomes a no-op
    // instead of throwing ERR_STREAM_WRITE_AFTER_END.
    closeRecording(0)
    return
  }
  // Pass through to claude + log
  log('in', data)
  term.write(buf)
})

process.stdout.on('resize', () => {
  term.resize(process.stdout.columns || 120, process.stdout.rows || 40)
})
