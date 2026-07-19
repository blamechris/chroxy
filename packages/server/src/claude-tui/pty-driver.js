// claude-tui/pty-driver.js — PTY-write / paste-throttle layer for ClaudeTuiSession.
//
// #5559 — pure-move extraction of the PTY layer out of claude-tui-session.js.
// These helpers + the throttled-write methods carry the most empirically-tuned
// behaviour in the repo (paste detector defeat via per-char throttle, bracketed-
// paste handling, the arrow-nav writer). Bodies are moved
// BYTE-IDENTICAL from the original; only the module location changed. The write
// methods live on `PtyDriverMixin` and are copied onto ClaudeTuiSession.prototype
// via applyMixin() in claude-tui-session.js, so `this` still refers to the
// session instance and every `this._*` / static reference resolves as before.
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { resolveBinary } from '../utils/resolve-binary.js'
import { createLogger } from '../logger.js'
// Imported at call-time only (circular-safe): the writer methods read the
// PROMPT_CHAR_DELAY_MS / MAX_THROTTLED_CHARS static getters off the class.
import { ClaudeTuiSession } from '../claude-tui-session.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const log = createLogger('claude-tui-session')


// Permission hook script — same one CliSession uses. Lives at
// packages/server/hooks/permission-hook.sh.
const PERMISSION_HOOK_SCRIPT = resolve(__dirname, '..', '..', 'hooks', 'permission-hook.sh')

// ANSI strip pattern covering the escape categories claude TUI emits
// during startup + redraw — keeps _outputTail readable for inline
// diagnostics (#3919) and the timeout hex dump.
//
//   CSI:                ESC [ <params> <final byte 0x40..0x7E>
//   OSC:                ESC ] <data> ( BEL | ESC \ )    e.g. title set
//   SS3:                ESC O <byte>                    e.g. function keys
//   Bracketed paste:    ESC [ ? 2004 [hl]               handled by CSI re
//   Single-char:        ESC = | ESC > | ESC c | ...     terminal-mode bytes
export const ANSI_STRIP = new RegExp(
  [
    '\\x1b\\[[0-9;?]*[\\x40-\\x7E]', // CSI
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC ... BEL or ST
    '\\x1bO.', // SS3
    '\\x1b[=>cN]', // common single-char terminal-mode codes
    '[\\x00-\\x08\\x0b-\\x1f\\x7f]', // stray C0 controls except \t and \n
  ].join('|'),
  'g',
)

// Render a byte buffer as a compact hex + ASCII dump suitable for log
// lines. Used by the probe-timeout diagnostic so the actual TUI output
// is visible — no more guessing whether the glyph was missing, mangled,
// or just past the search window (#4031).
//
// Accepts either a Buffer (preferred — see #4031 review on the
// stripped-tail problem) or a string (utf8-encoded to bytes). `maxBytes`
// caps the dump size; caller is expected to pass at least the probe-
// scan window so the dump covers the full region. A smaller cap would
// hide bytes the probe actually checked, defeating the diagnostic's
// purpose (review-caught regression: PR originally hardcoded 256
// internally while the probe widened to 1024).
export function formatHexDump(input, maxBytes) {
  let buf
  if (Buffer.isBuffer(input)) {
    buf = input
  } else if (typeof input === 'string') {
    buf = Buffer.from(input, 'utf8')
  } else {
    return '<empty>'
  }
  if (buf.length === 0) return '<empty>'
  const cap = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : buf.length
  const slice = buf.subarray(-Math.min(buf.length, cap))
  const omitted = buf.length - slice.length
  const lines = []
  for (let i = 0; i < slice.length; i += 16) {
    const chunk = slice.subarray(i, i + 16)
    const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(chunk).map((b) => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('')
    lines.push(`${hex.padEnd(48)}  |${ascii}|`)
  }
  const header = omitted > 0
    ? `(${slice.length} of ${buf.length} bytes; first ${omitted} omitted)`
    : `(${slice.length} bytes)`
  return `${header}\n${lines.join('\n')}`
}

// Well-known fallback locations for the `claude` binary. Under a GUI launch
// (e.g. Tauri on macOS) PATH is minimal and may exclude the user's install dir.
export const CLAUDE_BINARY_CANDIDATES = [
  join(homedir(), '.local/bin/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  join(homedir(), '.claude/local/node_modules/.bin/claude'),
  join(homedir(), '.npm-global/bin/claude'),
]

// Re-resolve fresh on each call (NOT a frozen module-load const) so a binary
// quarantined / moved / reinstalled after daemon start is spawned from its
// CURRENT path — and matches what preflight verified (#6708 defect #3).
export function resolveClaudeBinary() {
  return resolveBinary('claude', CLAUDE_BINARY_CANDIDATES)
}

// Back-compat: kept as a lazy-resolved snapshot for any consumer that still
// imports the constant. Prefer `resolveClaudeBinary()` at spawn time.
export const CLAUDE = resolveClaudeBinary()

// #5321 (WP-4.1) — subscription-auth failure detection. claude-tui routes via
// the OAuth subscription (ANTHROPIC_API_KEY is deleted from the spawn env), so a
// logged-out / expired login can't be caught by an env-var check. Instead we
// classify claude's own logged-out banner.
//
// CRITICAL: these are NOT generic-English auth phrases. This user base writes a
// lot of auth code, so "authentication failed" / "not logged in" / "session
// token expired" appear constantly in normal model RESPONSE text — and the
// stall/exit scan paths see that rendered response. So every pattern requires
// claude's own remediation COMMAND token — the `/login` slash command or the
// `claude login` CLI command in a "run …" instruction — which essentially only
// appears in claude's logged-out banner ("Invalid API key · Please run /login"),
// not in a model discussing auth. Matched on the whitespace-normalized tail so a
// line-wrapped banner still matches. Best-effort pending a real logged-out
// capture (scripts/tui-form-recorder.mjs) — tune the tokens, not loosen them.
export const AUTH_FAILURE_PATTERNS = [
  /please run `?\/login`?/i,            // claude's exact logged-out instruction
  /invalid api key.{0,60}\/login/i,     // full banner: "Invalid API key · Please run /login"
  /\brun `?\/login`?/i,                 // "run /login" / "run `/login`"
  /\brun `?claude login`?/i,            // CLI-command guidance: "run claude login"
]
// Structured error surfaced when an auth failure is classified.
export const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED'
export const AUTH_REQUIRED_MESSAGE = 'Claude is not logged in (or the subscription login expired). Run `claude login` in a terminal on the host, then retry. This provider uses the Claude subscription and does NOT accept ANTHROPIC_API_KEY.'

// Pre-trust the cwd in ~/.claude.json so the workspace-trust dialog doesn't
// block headless spawn. The dialog is interactive-only — without this, the
// PTY would render "Is this a project you trust?" and wait for Enter.
// Idempotent: if already trusted, no write.
export function ensureCwdTrusted(cwd) {
  const realCwd = realpathSync(cwd)
  const claudeConfig = join(homedir(), '.claude.json')
  let config = {}
  if (existsSync(claudeConfig)) {
    try {
      config = JSON.parse(readFileSync(claudeConfig, 'utf8'))
    } catch (err) {
      log.warn(`~/.claude.json unreadable, skipping trust pre-write: ${err.message}`)
      return
    }
  }
  if (!config.projects || typeof config.projects !== 'object') {
    config.projects = {}
  }
  const existing = config.projects[realCwd]
  // #5777 FIX-2 — also require hasCompletedProjectOnboarding. Pre-#5777 the
  // early-return fired on trust alone, so a trusted-but-unonboarded cwd (every
  // fresh worktree-isolated spawn — ensureCwdTrusted set trust but never the
  // onboarding flag) still rendered claude's project-onboarding interstitial,
  // which swallows the injected first prompt → the consumed=0 first_output
  // wedge. Pre-writing both flags suppresses that screen. NOTE: this does NOT
  // cover account-level one-shot notices (release notes / opus / remote-control
  // upsell) which render even on a fully-onboarded trusted folder — those are
  // gated/surfaced by FIX-1, not by per-project config.
  if (existing && existing.hasTrustDialogAccepted === true && existing.hasCompletedProjectOnboarding === true) return

  config.projects[realCwd] = {
    ...(existing || {}),
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
    projectOnboardingSeenCount: existing?.projectOnboardingSeenCount ?? 0,
  }
  // Atomic write via temp + rename. Use a per-call random suffix rather
  // than process.pid — concurrent ClaudeTuiSessions in the same chroxy
  // server share the pid, so two start()s racing for a different cwd
  // would clobber each other's temp file (#3922). The realpathSync()
  // earlier in this function still means each session writes a
  // different *target* path, but the temp file is global and needs to
  // be unique per write.
  const tmp = `${claudeConfig}.chroxy.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2))
  renameSync(tmp, claudeConfig)
}

// Build a settings.json that registers Stop + tool hooks. Claude pipes the
// hook event JSON to the command's stdin. Per-event filename pattern:
//   Stop         → <sink>/stop-<uuid>.json   (one per turn)
//   PreToolUse   → <sink>/pre-<uuid>.json    (one per tool call)
//   PostToolUse  → <sink>/post-<uuid>.json   (one per tool call)
//
// Unique filenames come from UUID_CMD below. `uuidgen` is the first choice
// (always present on macOS, and on Linux when `uuid-runtime` is installed) but
// it is NOT in a minimal Debian/Ubuntu container — a bare `$(uuidgen)` there
// collapses to an empty string, so every event collides on `pre-.json` /
// `post-.json` and the poller silently sees only the last one (#6075). We fall
// back to the kernel UUID source (`/proc/sys/kernel/random/uuid`, present on
// every Linux with no package) and finally to pid+nanoseconds. The expression
// is POSIX-sh safe (no `$RANDOM`/bashisms) since claude may run hooks under sh.
// IMPORTANT: do not use `mktemp <sink>/foo-XXXXXX.json` — macOS BSD mktemp
// does NOT expand the X-template when there's a `.json` suffix after it,
// so the file ends up named literally "foo-XXXXXX.json" and every turn
// overwrites the same file. Found the hard way during the #3902 smoke
// test: turn-2 Stop hook was written but then skipped by the poller
// because its filename was already in _consumedFiles from turn 1.
//
// Each turn's poller scans the sink for files it hasn't yet consumed —
// so a persistent PTY can fire 1..N Stop events across the session
// lifetime and each turn picks up only its own.
//
// This is written ONCE per session at start() — the same settings.json is
// reused across every turn, so changing it mid-session has no effect
// (claude reads it at spawn time).
export function writeHookSettings(sinkDir, { permissionsEnabled }) {
  const settingsPath = join(sinkDir, 'settings.json')
  const sinkDirEsc = JSON.stringify(sinkDir)
  // Portable unique-id source for hook filenames — see the UUID note above.
  const UUID_CMD = '$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "$$-$(date +%s%N)")'
  // PreToolUse runs ALL registered hooks in order. We always capture the
  // event for our own observability; when permissions are enabled the
  // chroxy permission-hook.sh runs SECOND, gating the tool call via long-
  // poll to /permission. Claude waits for every hook to exit non-zero
  // before running the tool.
  const preToolUseHooks = [
    { type: 'command', command: `cat > ${sinkDirEsc}/pre-${UUID_CMD}.json` },
  ]
  if (permissionsEnabled) {
    preToolUseHooks.push({
      type: 'command',
      command: PERMISSION_HOOK_SCRIPT,
      timeout: 300,
    })
  }
  const settings = {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: `cat > ${sinkDirEsc}/stop-${UUID_CMD}.json` }] },
      ],
      PreToolUse: [
        { hooks: preToolUseHooks },
      ],
      PostToolUse: [
        // First hook: forensic sink — tee preserves stdin for the
        // sibling-cleanup hook below. Replaces the pre-#4668 cat-to-file
        // because cat would consume stdin entirely, leaving the cleanup
        // hook with an empty payload.
        { hooks: [
          { type: 'command', command: `tee ${sinkDirEsc}/post-${UUID_CMD}.json | grep -q '"tool_name":"AskUserQuestion"' && rm -rf ${sinkDirEsc}/askuserquestion-active || true` },
        ] },
      ],
    },
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return settingsPath
}

// --- PTY writer methods (mixed onto ClaudeTuiSession.prototype) ---
export class PtyDriverMixin {
  /**
   * Write a string to the PTY one character at a time with
   * PROMPT_CHAR_DELAY_MS between each, wrapped in bracketed-paste-disable
   * / re-enable so claude TUI's paste detector accepts it as typed input
   * (#4269). Returns true on completion, false if `_activeTurn.aborted`
   * or `_ptyExited` (#4275) tripped mid-write — in either case `onAbort`
   * was called.
   *
   * Used by both sendMessage's prompt write and respondToQuestion's
   * answer write (#4278). The control sequences (\x1b[?2004l/h, \r) are
   * single writes — only the visible text is throttled, since that's
   * what claude's heuristic measures.
   *
   * Above MAX_THROTTLED_CHARS the helper switches to a single bulk
   * `_term.write(text)` (#4276). Per-char throttling is O(N) blocking
   * latency and unbounded for huge prompts (e.g. pasted file contents)
   * — the bulk path may trip claude's paste detector but that's
   * preferable to multi-minute silent hangs.
   *
   * Multi-line input (any embedded `\n`) takes a separate fast-path
   * (#4678): the body is normalised, wrapped in CSI bracketed-paste
   * markers, and delivered as a single atomic write — see the inline
   * comment in the function body for the why.
   *
   * @param {string} text — the text to write (no trailing CR; \r appended)
   * @param {object} [opts]
   * @param {() => void} [opts.onAbort] — called if abort tripped; caller
   *   typically uses this to surface a turn-level error.
   * @returns {Promise<boolean>} true if completed, false if aborted.
   */
  async _writePtyTextThrottled(text, { onAbort } = {}) {
    // Wedge instrumentation (#4678 follow-up): track which path the
    // write took, the byte/code-point count, and elapsed ms. The wedge
    // symptom (`stream_start` then silence) is consistent with this
    // function never returning OR returning but the bytes never being
    // consumed by claude TUI. The log line at finish() distinguishes
    // the two — if the line never appears in the log, the wedge is in
    // here; if it appears with completed=true, the wedge is downstream
    // (hook poll loop, or claude TUI itself).
    const writeStartMs = this._nowMonotonic()
    const codePointCount = [...text].length
    const byteLength = Buffer.byteLength(text, 'utf8')
    const finish = (path, completed) => {
      const elapsedMs = this._nowMonotonic() - writeStartMs
      if (this._activeTurn) {
        this._activeTurn.writePath = path
        this._activeTurn.writeMs = elapsedMs
        this._activeTurn.writeBytes = byteLength
        this._activeTurn.writeCompleted = completed
      }
      log.info(`writePtyText (msg=${this._activeTurn?.messageId ?? 'none'} path=${path} codePoints=${codePointCount} bytes=${byteLength} elapsedMs=${elapsedMs} completed=${completed})`)
      return completed
    }
    // #4678: multi-line prompts (from Shift+Enter in the dashboard
    // composer) need to be delivered as a single bracketed paste —
    // claude TUI v2.1.x treats raw \n in the input box as "insert
    // newline in multi-line composition" with no way to break out via
    // a subsequent \r (the bare \r is also interpreted as a newline
    // when the cursor is in a multi-line composition). Wrapping the
    // content in CSI bracketed-paste markers (\x1b[200~ ... \x1b[201~)
    // tells claude TUI the content was pasted; on receipt of the close
    // marker the input is ready to submit and the trailing \r fires.
    //
    // Single-line content keeps the per-char throttled write — the
    // #4269 throttle exists to defeat claude TUI's heuristic paste
    // detector when the input is typed input (not a real paste). For
    // genuine paste we use the explicit markers and rely on claude TUI
    // honouring DEC mode 2004 for those bytes.
    const hasNewlines = /\r?\n/.test(text)
    if (hasNewlines) {
      // Normalise CRLF → LF so the pasted body contains a single line
      // break per logical newline. Trailing newlines are dropped so
      // the close marker lands at the end of the visible content
      // rather than after an empty trailing line. Embedded paste-end
      // markers (`\x1b[201~`) are stripped from the body — leaving
      // them intact would let attacker-controlled content (an MCP tool
      // result echoed into a follow-up prompt, an evaluator rewrite,
      // any future content-injection path) terminate the bracketed
      // paste early and land the suffix as typed input in claude TUI.
      // Defense-in-depth; the typing-user case is zero-risk today.
      // Order matters: strip embedded \x1b[201~ markers BEFORE the
      // trailing-newline strip. Removing markers can expose trailing
      // newlines that were hidden by them — e.g. "\n\x1b[201~\n" needs
      // to become "" (empty body → abort), not "\n" (a degenerate
      // one-newline paste). Doing trailing-strip first would keep the
      // newline that the marker was masking.
      const body = text
        .replace(/\r\n/g, '\n')
        .replace(/\x1b\[201~/g, '')
        .replace(/\n+$/, '')
      if (this._activeTurn?.aborted || this._ptyExited) {
        onAbort?.()
        return finish('paste-abort', false)
      }
      // After stripping, an all-whitespace or all-control-bytes prompt
      // can collapse to an empty body. Sending the degenerate
      // `\x1b[200~\x1b[201~\r` produces a CR-on-empty-input — at best
      // a no-op, at worst behaviour the TUI doesn't expect. Drop the
      // turn cleanly via the abort path so the caller sees a finished
      // turn (no message ever leaves chroxy) rather than chroxy
      // claiming to have sent and then waiting forever for a reply.
      if (body.length === 0) {
        onAbort?.()
        return finish('paste-empty', false)
      }
      this._term.write('\x1b[200~' + body + '\x1b[201~\r')
      return finish('paste', true)
    }

    // #4805: single-line throttled path used to feed `freeformText`
    // verbatim into _term.write — no defense against C0 control bytes
    // or ANSI escape sequences embedded in the input. The newline
    // bracketed-paste branch above (#4678) already strips embedded
    // `\x1b[201~` markers and explicitly cites attacker-controlled MCP
    // tool results as the threat model; the single-line branch has the
    // same input shape and applies the parallel defense.
    //
    // Stripped (in this order, since the first match wins):
    //   - ANSI CSI: ESC [ <params 0x30-0x3f> <intermediates 0x20-0x2f>
    //     <final 0x40-0x7e> — the full ECMA-48 grammar including
    //     DEC-private sequences `?`/`<`/`=`/`>`/`:` (W2 #4805)
    //   - String controls: ESC ] / P / X / ^ / _ <payload> (BEL | ESC \)
    //     — covers OSC (title-set), DCS (sixel/ReGIS/termcap),
    //     SOS / PM / APC (W2 #4805 — original regex covered OSC only)
    //   - Stray two-byte ESC + final-byte sequences: RIS `\x1b c`,
    //     DECSC/DECRC `\x1b 7`/`8`, IND/RI/NEL/HTS `\x1b D`/`M`/`E`/`H`,
    //     keypad-mode `\x1b =`/`>` — `\x1b.?` catch-all (W2 #4805)
    //   - C0 control bytes \x00-\x08 + \x0b-\x1f + \x7f — the range
    //     now includes \x1b so any unmatched lone ESC is stripped
    //     (W2 #4805 closed the 0x1b char-class gap). Excludes \t (a
    //     normal printable whitespace a user may paste); \r/\n never
    //     reach this path (the multi-line branch handles them).
    // Note: the sequence-matching alternations come BEFORE the
    // C0 class so a full escape is matched as one unit. If the
    // lone-byte class came first the regex would peel off the \x1b
    // introducer and leave the [<final> bytes as printable garbage.
    // Known damage paths covered:
    //   - \x03 (Ctrl-C) aborts the active TUI form
    //   - OSC \x1b]0;...\x07 rewrites the window title on some hosts
    //   - DEC-private CSI (\x1b[?25l hide-cursor, \x1b[?1049h alt-
    //     screen, \x1b[?1000h / \x1b[?1006h mouse-tracking) desync
    //     the TUI input state machine — the recurring wedge symptom
    //     class
    //   - RIS \x1b c full-terminal-reset clears the scrollback
    //   - APC payloads (iTerm2 proprietary commands)
    const stripped = []
    text = text.replace(
      // eslint-disable-next-line no-control-regex
      /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)|\x1b.?|[\x00-\x08\x0b-\x1f\x7f]/g,
      (match) => {
        stripped.push(match)
        return ''
      },
    )
    if (stripped.length > 0) {
      // Bounded hex preview (first 32 stripped bytes total) gives an
      // incident-response footprint without blowing the log on a
      // malicious flood. Sequences are concatenated then truncated so
      // each warn line carries the same payload shape regardless of
      // how many distinct sequences were stripped.
      const totalBytes = stripped.reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0)
      const sampleHex = Buffer.from(stripped.join(''), 'utf8').slice(0, 32).toString('hex')
      const truncated = totalBytes > 32 ? ',…' : ''
      log.warn(`writePtyText (msg=${this._activeTurn?.messageId ?? 'none'}) stripped ${totalBytes} control/escape bytes from single-line input (sample=${sampleHex}${truncated}) (#4805)`)
    }
    // After stripping, an all-control-byte prompt can collapse to an
    // empty body. Mirror the multi-line branch's `body.length === 0`
    // guard (:1358): abort the turn cleanly rather than write a bare
    // \r submit to the TUI — the caller sees a finished turn (no
    // message ever leaves chroxy) instead of chroxy claiming to have
    // sent and waiting forever for a reply.
    if (text.length === 0) {
      onAbort?.()
      return finish('throttled-empty', false)
    }
    // Re-compute counts now that the body may have shrunk so the bulk-
    // path threshold check + finish() bookkeeping stay accurate.
    const sanitizedCodePointCount = [...text].length

    this._term.write('\x1b[?2004l')
    try {
      // #4276: huge prompts bypass the throttle. Code-point count
      // (counted once at function entry) keeps the threshold
      // consistent with how the loop iterates — an emoji-only 5000-
      // char string [...].length is 5000, not 10000.
      if (sanitizedCodePointCount > ClaudeTuiSession.MAX_THROTTLED_CHARS) {
        // Re-check the turn lifecycle exactly once before the bulk
        // write — same shape as the loop's per-iter guards, so a
        // caller that aborted between scheduling and execution doesn't
        // flood a torn-down PTY with a huge payload.
        if (this._activeTurn?.aborted || this._ptyExited) {
          onAbort?.()
          return finish('bulk-abort', false)
        }
        this._term.write(text)
        this._term.write('\r')
        return finish('bulk', true)
      }
      for (const ch of text) {
        // #4275: re-check _ptyExited inside the loop, mirroring the
        // pre-write guard in sendMessage. A long prompt + a mid-write
        // PTY crash previously relied on the next _term.write throwing
        // to bubble up — correct but not the explicit-state-machine
        // pattern the rest of this file uses.
        if (this._activeTurn?.aborted || this._ptyExited) {
          onAbort?.()
          return finish('throttled-abort', false)
        }
        this._term.write(ch)
        if (ClaudeTuiSession.PROMPT_CHAR_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, ClaudeTuiSession.PROMPT_CHAR_DELAY_MS))
        }
      }
      this._term.write('\r')
      return finish('throttled', true)
    } finally {
      // Always restore bracketed-paste mode, even on abort/throw. Write may
      // throw if PTY has exited mid-loop (#4287) — swallow so we don't mask
      // the original error path.
      try { this._term.write('\x1b[?2004h') } catch {}
    }
  }

  /**
   * Write an arrow-key navigation sequence for the single-question
   * AskUserQuestion form when the user picked an option beyond the
   * single-digit hotkey range (idx >= 9). Emits `targetIdx` Down arrow
   * keystrokes (`\x1b[B`, 3 bytes each) — claude TUI's form cursor
   * starts at idx 0, so `targetIdx` downs land on the picked option —
   * followed by Enter (`\r`) to commit (#4848).
   *
   * Wrapped in bracketed-paste-disable / re-enable exactly once (same
   * defense as _writePtyTextThrottled).
   * A PROMPT_CHAR_DELAY_MS pause runs BETWEEN each Down-arrow write so
   * claude TUI's paste detector doesn't reject the burst. The trailing
   * Enter (`\r`) and the bracketed-paste re-enable write fire
   * immediately after the final delay — no extra pause separates them
   * from the last arrow (the arrival rate at that point is already well
   * under any reasonable paste threshold). Each arrow is one `_term.write`
   * call (3 bytes); 10 arrows ≈ 30 bytes total form-byte payload.
   *
   * **Empirically unreachable (#4880, 2026-06-07):** the recorder pass
   * against a 10+ option AskUserQuestion ran and found the form can't be
   * produced — claude TUI v2.1.168 hard-caps each AskUserQuestion question
   * at 4 options (the call fails server-side with
   * `InputValidationError: too_big, maximum: 4` before any form renders;
   * see docs/empirical/4880-twelve-option-cap.jsonl). So this writer is
   * currently DEAD CODE on real AskUserQuestion forms, kept as forward-compat
   * for a future TUI that raises the cap. The `\x1b[B` + `\r` sequence is the
   * conservative bet (multi-digit chord '1','0' was ruled out — the digit
   * hotkey auto-commits on the first keystroke); it could not be confirmed
   * because the form is unproducible. Revisit if/when the option cap rises.
   *
   * @param {number} targetIdx — 0-indexed option to land on
   * @returns {Promise<boolean>} true if completed, false if PTY aborted mid-write
   */
  async _writePtyArrowNavSequence(targetIdx) {
    if (!this._term) return false
    if (typeof targetIdx !== 'number' || targetIdx < 0) return false
    this._term.write('\x1b[?2004l')
    try {
      for (let i = 0; i < targetIdx; i++) {
        if (this._activeTurn?.aborted || this._ptyExited) return false
        this._term.write('\x1b[B')
        if (ClaudeTuiSession.PROMPT_CHAR_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, ClaudeTuiSession.PROMPT_CHAR_DELAY_MS))
        }
      }
      if (this._activeTurn?.aborted || this._ptyExited) return false
      this._term.write('\r')
      return true
    } finally {
      try { this._term.write('\x1b[?2004h') } catch {}
    }
  }
}
