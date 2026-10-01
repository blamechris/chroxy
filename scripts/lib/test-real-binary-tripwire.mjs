// test-real-binary-tripwire.mjs — #8096: catches a test that reaches a REAL,
// host-installed `cloudflared`/`claude`/`codex`/`gemini` instead of a fixture.
//
// The #8096 investigation found pre-existing tests that resolved, hashed and
// exec'd the developer's REAL `cloudflared` (cloudflare-provenance.test.js's
// #6937 spawn tests) and the REAL `cloudflared`/`claude` (doctor-binary-
// provenance*.test.js) — not because anyone intended it, but because a bare
// PATH-resolved name or a fixed well-known install path (`/opt/homebrew/bin/…`)
// is indistinguishable from a fixture at the call site unless something checks.
// Fixing the three known call sites (#8096 items 1-3) closes the doors found
// so far; this module is the backstop so the NEXT one goes red immediately,
// legibly, instead of quietly shelling out to the host again.
//
// ── What this guards ─────────────────────────────────────────────────────
//
// A `child_process` launcher call whose resolved command is:
//   - a BARE name (no path separator — resolved via the OS's own PATH search,
//     exactly how `resolveBinary()`/`_spawnCloudflared()` fall back) matching
//     one of GUARDED_BASENAMES, OR
//   - an ABSOLUTE (or otherwise separator-containing) path whose basename
//     matches GUARDED_BASENAMES AND which sits under a real package-manager
//     install prefix (REAL_INSTALL_PREFIXES) — a fixture written under
//     `os.tmpdir()`/the repo's own scratch dirs never matches a prefix here,
//     so `makeGateShim()`-style fixtures (named e.g. `gate-shim.mjs`, not
//     `cloudflared`/`claude`/…) are untouched regardless of where they live,
//     and a REAL binary under a fixture-shaped tmp path (never happens in
//     practice, but matters for the "narrow" contract) is untouched too.
//
// `node`, `git`, `sh`, `which`, `where`, `xattr`, etc. are never in
// GUARDED_BASENAMES, so ordinary test plumbing (a spawned `node` fixture
// script, `resolveBinary()`'s own `which`/`where` probe, a throwaway git repo)
// is unaffected regardless of its resolved path — this is deliberately NOT a
// blanket "tests may never touch child_process" guard; see docs/false-safety-
// guards.md and this repo's own CLAUDE.md ("every guard must be proven to
// fail") for why a guard that is too broad is exactly as unproven as one that
// is too narrow until something demonstrates the boundary.
//
// ── Shell command lines: what is inspected (#8102, #8186) ────────────────
//
// `exec`/`execSync` ALWAYS hand `args[0]` to a shell. `spawn`/`spawnSync`/
// `execFile`/`execFileSync` do the same when `options.shell` is truthy (a
// boolean, or a shell path STRING — anything truthy), joining `[file, ...args]`
// with a space, the shape Node's own spawn-argument normalization builds
// (`buildShellLine()`; `fork` has no such option). Either way the line goes
// through `shellCommandTokens()`, which is the one place that reads shell
// syntax: it lexes the line into simple commands (`parseShellLine()`), then
// reduces each to the program name(s) it would exec (`simpleCommandTokens()`).
//
// The lexer. A new simple command starts at any of these, OUTSIDE quotes:
// `&&`, `||`, `;`, `|`, a lone `&` (not the `>&` / `<&` redirections),
// a newline, `(`, `)`, a backtick, and `$(`. Quoting follows the shell: inside
// single quotes everything is literal; inside double quotes every operator is
// literal EXCEPT `$(` and a backtick, which still run a command. A backslash
// escapes the next character where that character is quote/operator syntax
// (`\"`, `\\`, `\$`, `\;`, `\ ` ...) and is otherwise kept as a literal
// backslash, so the usual Windows path (`C:\Program Files\...\claude.cmd`)
// survives intact. `echo "a && claude"` is therefore one command with one
// argument, not two commands (#8186), while `echo "$(claude -v)"` and
// `echo "x" && claude` still reach `claude`. A quote left open runs to the end
// of the line. An unquoted `#` that STARTS a word begins a comment, which runs
// to the end of the line; the newline still ends it and the next line is lexed
// normally (`true # it's a note\nclaude` reaches `claude`; `echo a#b && claude`
// does too, because a mid-word `#` is not a comment).
//
// The reducer. Per simple command, in order:
//   1. leading `NAME=value` assignments are skipped (`FOO=1 claude`);
//   2. the bare `exec` builtin and its own flags (`-c`, `-l`, `-a NAME`) are
//      skipped (`exec claude`);
//   3. the first remaining word is the PROGRAM, and is looked at by basename
//      (case-folded, `.exe`/`.cmd`/`.bat`/`.com` stripped, so `/usr/bin/env`,
//      `/bin/bash` and `bash.exe` all match):
//        - `env`  : its flags, `-u NAME`/`-C DIR`, and `NAME=value` operands are
//                   skipped, and what follows is reduced again;
//        - `npx`  : its flags and `-p`/`--package PKG` are skipped, and what
//                   follows is reduced again;
//        - `sh` `bash` `zsh` `dash` : when the options contain a `-c` (alone or
//                   in a cluster: `-c`, `-lc`, `-ec` ...), the first operand
//                   after the options is a COMMAND STRING and is lexed again,
//                   recursively — the POSIX counterpart of the cmd.exe case
//                   below, and it is the same code path (`shellWrapperTokens()`);
//        - `cmd`  : the win-spawn.js wrapper, below;
//        - anything else: the program itself is the candidate.
//   4. in a SHELL line, a leading `~`, `~/`, `$HOME` or `${HOME}` on the
//      program word is expanded with `os.homedir()` before the name check, so
//      `~/.local/bin/claude` (the default dev-machine install) is the real
//      install it names. `~user` and `$HOMEX` are left alone.
//
// The same reduction runs on the argv of a call with NO shell
// (`spawn('sh', ['-c', 'claude -v'])`, `spawn('env', ['claude'])`) — there the
// words are the already-split `[file, ...args]` rather than a lexed line, and
// a LEADING assignment or `exec` is NOT unwrapped, and a leading `~`/`$HOME`
// is NOT expanded, because without a shell they are ordinary (and nonexistent)
// program names. (`env`'s own `NAME=value`
// operands are still skipped: that is `env` parsing its argv, not a shell.)
//
// Deliberately narrow in the OTHER direction too: a guarded name that appears
// as an ARGUMENT rather than in command position —
// `spawn('echo cloudflared', { shell: true })` — is NOT flagged. `echo`
// never execs `cloudflared`; scanning every whitespace-separated word for a
// substring match would degenerate into the "denies everything" shape
// docs/false-safety-guards.md warns about (that catalogue's `#7273`), and
// would also be wrong on its own terms — the risk this module guards
// against is a real BINARY being exec'd, not a string that merely mentions
// one. `setup-real-binary-tripwire.test.js` proves this call passes through
// un-flagged.
//
// ── Limits: what this does NOT detect, and where it over-flags ───────────
//
// This is a small, explicit grammar, NOT a shell parser, and the wrapper and
// shell lists above are CLOSED — a hand-written list beside a set that grows
// is a recurring false-safety shape (docs/false-safety-guards.md), so the
// edges are written down here and the tests pin a sample of both lists.
//
// MISSED — a guarded name that reaches an exec through any of these is
// invisible, exactly as before #8186:
//   - Wrappers outside the closed list above: `sudo`, `nohup`, `time`,
//     `timeout`, `nice`, `xargs`, `command`, `builtin`, `npm exec`,
//     `pnpm dlx`, `yarn dlx`, `bunx`, `watch`, `find -exec`, ... — and any
//     `env`/`npx` flag that takes a value other than the ones named above:
//     `env -S 'claude -v'` (its string operand is not re-lexed), `env -P DIR`,
//     `npx -c '...'`, `npx --cache DIR`.
//   - Shells outside `sh`/`bash`/`zsh`/`dash` (`ksh`, `fish`, `busybox ash`,
//     `pwsh`, `powershell`).
//   - A command string that is not in the argv: `echo claude | sh`, a heredoc
//     fed to a shell, `bash script.sh` (the script's contents are never read),
//     `eval`, `trap 'claude' EXIT`, `source` and `.`, and
//     `node -e "require('child_process')..."`. `bash claude` (a script operand
//     named like a guarded binary) is not flagged either: right for a native
//     binary, which bash refuses to read as a script, wrong for a `#!/bin/sh`
//     wrapper script.
//   - A name that is PRODUCED rather than written: `$(echo claude)` and its
//     backtick form, `"$(echo claude)"`, `bash -c "$(echo claude)"`, `$CLAUDE_BIN`
//     and any other variable, an alias or a function, brace expansion
//     (`{claude,x}`). The guarded name must be a literal word in command
//     position.
//   - A word that is not literally the name: a redirect glued to it
//     (`claude>/dev/null`, `claude</dev/null`, `claude>out` — the word is the
//     whole `claude>/dev/null`) and a backslash before an ordinary character
//     (`\claude`, `cl\aude`), which is kept as a literal backslash on purpose so
//     a Windows path survives.
//   - Package specifiers: `npx @openai/codex`, `npx claude@latest` — the word
//     must equal the binary name (or an absolute path to it under a real
//     install prefix) exactly.
//   - Syntax the lexer does not model: redirections before the command
//     (`>out claude`, `2>/dev/null claude`), brace groups (`{ claude; }`),
//     function bodies, reserved words (`! claude`, and `then`/`do`/`else`/
//     `elif`/`while`/`until` as the first word of a command, as in
//     `if true; then claude; fi` and `for x in 1; do claude; done`), `${...}`
//     and arithmetic expansion, `$'...'` quoting (a regression against the old
//     regex splitter: `echo $'a\'b' && claude`), and backslash-newline line
//     continuation (`cla\<newline>ude`).
//   - A QUOTED Windows path that ends in a backslash (`"C:\dir\"`): inside
//     double quotes `\"` reads as an escaped quote and the quote stays open,
//     hiding whatever follows it on the line.
//
// OVER-FLAGGED — a call that cannot exec a guarded binary but is flagged
// anyway (conservative: a false alarm is a visible red, a miss is not):
//   - A heredoc BODY line that starts with a guarded name
//     (`cat <<EOF\nclaude\nEOF`, quoted delimiter or not) is lexed as a
//     command, because a newline starts one. The pre-#8186 module passed it.
//   - `case` patterns (`case x in claude) ... esac`) and unbalanced groups
//     (`claude --version (`, `echo $(claude`), which are syntax errors in a
//     real shell; a test pins the unbalanced case.
//   - A backslash-newline continuation (`echo \<newline>claude`) and a `>|`
//     redirect target (`echo hi >| claude`): the newline and the `|` split.
//   - A PATH that cannot resolve the name is not honoured the way
//     `options.env.PATH` is: `PATH= claude`, `env -i claude`, `env PATH=
//     claude` and `env -u PATH claude` are flagged although they cannot find
//     it. (`env FOO=1 -- claude` is flagged too, although `env` takes the
//     `--` after an operand as the program name.)
//   - A command a shell would short-circuit past or never reach
//     (`[ -x claude ] && claude`, a function named `claude`) is flagged: the
//     lexer reads "could run", not "does run".
//
// If a real call shape turns up in either list, extend the grammar and the
// tests together — and move it out of the list in the same change.
//
// ── win-spawn.js's `cmd.exe` wrapper (#8102) ────────────────────────────────
//
// On win32, a resolved `.cmd`/`.bat` npm shim (an npm-global `claude.cmd`,
// say) is never spawned directly — `src/utils/win-spawn.js`'s `prepareSpawn()`
// rewrites the call into `spawn(comspec, ['/d', '/s', '/c',
// '"<cmd.exe-escaped command line>"'], { windowsVerbatimArguments: true })`,
// where `comspec` is `process.env.COMSPEC` (normally `cmd.exe`, sometimes a
// full `C:\Windows\system32\cmd.exe`) — so Node's own `.cmd`/`.bat` spawn
// restrictions and argument-quoting bugs (CVE-2024-27980, DEP0190 — see that
// module's header) don't apply. By the time this guard sees that call,
// `args[0]`'s basename is `cmd`/`cmd.exe` — never a guarded name directly —
// and the actual target binary is inside the escaped `/c` string.
//
// `shellWrapperTokens()` recognizes the SHAPE rather than reversing
// the full cross-spawn escaping: a program whose basename (after
// `stripExeExtension`) is `cmd`, with a `/c` (or `-c`) flag among its words. It
// joins everything after that flag, strips one layer of
// wrapping quotes (the single outer pair `/s` strips — see `prepareSpawn`'s
// own comment), reverses one layer of `^`-escaping (`escapeCommand()`'s
// single pass over the COMMAND token — unlike an argument, it is never
// double-escaped, and none of `cloudflared`/`claude`/`codex`/`gemini`
// contain a cmd.exe metacharacter that would need escaping to begin with),
// and runs the result through the SAME `shellCommandTokens()` used for the
// `options.shell` case above. Still not a full parser — an adversarially
// crafted shim PATH containing a caret-escaped space ahead of the binary
// name could still confuse the split — but it catches the shape win-spawn.js
// actually produces, which is what this guard exists to backstop. The line it
// recovers is lexed with POSIX rules (single quotes quote, `#` starts a
// comment, a lone `&` separates, `^` does not escape), none of which is true of
// cmd.exe: a directory literally named like `a & claude.cmd`, whose `&`
// escapeCommand() caret-escapes and this function un-escapes, is read as a
// real separator.
//
// ── Bypass ───────────────────────────────────────────────────────────────
//
// `process.env.CHROXY_TEST_ALLOW_REAL_BINARY === '1'` disables the guard
// entirely, for the rare test that deliberately, knowingly exercises a real
// provider binary. Two existing files set it themselves, right where they
// already decide a real spawn is intentional:
//   - `tests/tunnel.integration.test.js` — opt-in `CHROXY_TEST_REAL_CLOUDFLARED=1`
//     (#8096 item 3).
//   - `tests/integration/codex-spawn-argv.integration.test.js` — a PRE-EXISTING,
//     deliberate real-`codex` integration test (#3873), gated behind its own
//     REQUIRED `RUN_CODEX_INTEGRATION=1` opt-in (#8101 — it used to ALSO
//     auto-run whenever `codex` happened to be resolvable, with no env var
//     needed, which is exactly this issue's defect class in a fourth file;
//     confirmed running for real on a persistent self-hosted Windows CI
//     runner before that fix). Its resolved `CODEX_BIN` is an absolute path
//     under a real install prefix (e.g. `/opt/homebrew/bin` on a Homebrew
//     host), which — absent this — would trip the SAME guard this file
//     installs. It sets the flag itself, once, only inside the branch that
//     already required the explicit opt-in to be true.
// Nothing else in this repo's test suite is known to legitimately need it as
// of #8096 — the full suite ran clean under this guard with normal PATH once
// those two call sites were accounted for (see the PR for the two-run proof).
//
// ── #7262-style import rule ──────────────────────────────────────────────
//
// Same rule as `test-spawn-home-sandbox.mjs` (which this module also
// imports SPAWN_LAUNCHERS from — a plain string array, not `child_process`
// itself, so importing it does not link the synthetic ESM module early):
// this file must not ESM-import `node:child_process`, or ANYTHING that
// transitively does, ahead of the patch below. `node:module`, `node:os` and
// `node:path` are safe — none of them import `child_process`.

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { SPAWN_LAUNCHERS, findOptionsIndex } from './test-spawn-home-sandbox.mjs'

const require = createRequire(import.meta.url)

// Captured ONCE, so the install prefixes below and the `~`/`$HOME` expansion in
// shellCommandTokens() can never disagree about where "home" is.
const HOME_DIR = homedir()

/** Marks a patched function so a test can enumerate what was ACTUALLY installed. */
export const REAL_BINARY_MARKER = Symbol.for('chroxy.testRealBinaryTripwire')

export const REAL_BINARY_ERROR_CODE = 'CHROXY_TEST_REAL_BINARY'

/**
 * Binary basenames this guard cares about. Deliberately the small,
 * security-sensitive set `verify-binary.js`'s own docblock names as "external
 * provider binaries chroxy execs, resolved off PATH": `claude`, `codex`,
 * `gemini`, plus `cloudflared` (folded into the same provenance gate since
 * #6858). NOT a stand-in for "every executable" — see the module docblock.
 */
export const GUARDED_BASENAMES = new Set(['cloudflared', 'claude', 'codex', 'gemini'])

/**
 * Real, host-wide package-manager / installer locations. Matches the set
 * `verify-provenance.js`'s package-tree classifier and this repo's
 * `CLAUDE_BINARY_CANDIDATES`/`CLOUDFLARED_CANDIDATES` fixed-path lists already
 * treat as "a real install", so this guard's idea of "real" tracks the
 * production code's, not a separate guess.
 */
export const REAL_INSTALL_PREFIXES = Object.freeze([
  '/opt/homebrew/',
  '/usr/local/',
  join(HOME_DIR, '.local') + sep,
  join(HOME_DIR, '.npm-global') + sep,
  join(HOME_DIR, '.bun') + sep,
  join(HOME_DIR, '.volta') + sep,
  join(HOME_DIR, 'Library', 'pnpm') + sep,
])

// win32 resolves paths case-insensitively and accepts EITHER separator in a
// path string regardless of which one is canonical (a resolved `C:\...` and a
// hand-typed `c:/...` fixture address the same real location); darwin's
// default HFS+/APFS is ALSO case-insensitive. Fold both onto one comparable
// form before any prefix comparison on those two platforms — same FOLD_CASE
// shape `scripts/lib/test-fs-sandbox.mjs` already uses for the identical
// reason. NOT applied on Linux, where a literal backslash is a normal
// filename character (folding `\`->`/` there would be wrong, not just
// unnecessary) and the filesystem is case-sensitive by default.
const FOLD_CASE_AND_SEP = process.platform === 'darwin' || process.platform === 'win32'
function comparablePath(p) {
  return FOLD_CASE_AND_SEP ? p.replace(/\\/g, '/').toLowerCase() : p
}
// Precomputed once — REAL_INSTALL_PREFIXES never changes at runtime.
const COMPARABLE_REAL_INSTALL_PREFIXES = REAL_INSTALL_PREFIXES.map(comparablePath)

/** `true` when `cmd` has no path separator — resolved via the OS's PATH search. */
function isBareName(cmd) {
  return !cmd.includes('/') && !cmd.includes('\\')
}

// Windows npm shims/native installers append an extension the bare
// GUARDED_BASENAMES entries don't carry (`claude.cmd`, `cloudflared.exe`).
// Stripped case-insensitively before comparison so the guard's coverage
// doesn't quietly stop at the platform this module was written on.
const EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com']
function stripExeExtension(name) {
  const lower = name.toLowerCase()
  for (const ext of EXECUTABLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return name.slice(0, name.length - ext.length)
  }
  return name
}

// A leading `NAME=value` shell assignment word (`FOO=1`, `PATH=/x`).
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

// Characters a backslash escapes, per context. Outside quotes a backslash
// before any OTHER character is kept as a literal backslash (a Windows path
// separator in `C:\Program Files\nodejs\claude.cmd`); inside double quotes the
// shell's own set is `"`, `\`, `$` and a backtick.
const UNQUOTED_ESCAPABLE = ' \t"\'\\$`&;|()<>'
const DOUBLE_QUOTED_ESCAPABLE = '"\\$`'

/**
 * Lex a shell command LINE into simple commands, each a list of WORDS with
 * quoting removed — see the module docblock's "The lexer" for exactly which
 * syntax starts a new command and what is not modelled. Command substitutions
 * (`$(...)`, backticks) and `( ... )` groups are parsed as commands of their
 * own and the line they sit in resumes, with its partial word, once they close
 * — so `echo "$(date) claude"` is ONE command (`echo`) whose argument contains
 * a substitution, never a second command whose program is the tail `claude`.
 */
function parseShellLine(line) {
  const commands = []
  let words = []
  let word = ''
  let inWord = false
  let dq = false
  // Open `$(`/`(`/backtick groups. Each remembers the OUTER line's partial
  // state so closing the group restores it.
  const frames = []

  const endWord = () => {
    if (inWord) {
      words.push(word)
      word = ''
      inWord = false
    }
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) {
      commands.push(words)
      words = []
    }
  }
  const append = (ch) => {
    word += ch
    inWord = true
  }
  const openGroup = (tick) => {
    frames.push({ tick, resumeDq: dq, words, word, inWord })
    words = []
    word = ''
    inWord = false
    dq = false
  }
  const closeGroup = () => {
    endCommand()
    const frame = frames.pop()
    dq = frame.resumeDq
    words = frame.words
    word = frame.word
    inWord = frame.inWord
  }

  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    const next = line[i + 1]
    const top = frames[frames.length - 1]

    if (dq) {
      if (c === '"') {
        dq = false
      } else if (c === '\\' && next !== undefined && DOUBLE_QUOTED_ESCAPABLE.includes(next)) {
        append(next)
        i++
      } else if (c === '$' && next === '(') {
        openGroup(false)
        i++
      } else if (c === '`') {
        openGroup(true)
      } else {
        append(c)
      }
      continue
    }

    switch (c) {
      case ' ':
      case '\t':
      case '\r':
        endWord()
        break
      case '\n':
      case ';':
      case '|':
        endCommand()
        break
      case '&':
        // `>&` and `<&` are redirections, not command separators — and the
        // word after one is a redirect TARGET (`echo hi >& claude`), not a command.
        if (line[i - 1] === '>' || line[i - 1] === '<') append(c)
        else endCommand()
        break
      case "'": {
        const close = line.indexOf("'", i + 1)
        const stop = close === -1 ? line.length : close
        word += line.slice(i + 1, stop)
        inWord = true
        i = stop
        break
      }
      case '"':
        dq = true
        inWord = true
        break
      case '\\':
        if (next !== undefined && UNQUOTED_ESCAPABLE.includes(next)) {
          append(next)
          i++
        } else {
          append(c)
        }
        break
      case '#':
        // A comment runs to the end of the line — but only when the `#` STARTS
        // a word. `a#b` and `$#` are ordinary text. The newline is left for the
        // next iteration, so the following line is lexed normally.
        if (inWord) {
          append(c)
        } else {
          const newline = line.indexOf('\n', i)
          i = newline === -1 ? line.length : newline - 1
        }
        break
      case '(':
        openGroup(false)
        break
      case ')':
        // An unmatched `)` (or one inside a backtick pair) just ends the command.
        if (top && !top.tick) closeGroup()
        else endCommand()
        break
      case '`':
        if (top && top.tick) closeGroup()
        else openGroup(true)
        break
      default:
        append(c)
    }
  }
  // An unbalanced `(`/backtick must not swallow the commands around it: unwind
  // every still-open group so the outer line's words are kept.
  while (frames.length > 0) closeGroup()
  endCommand()
  return commands
}

// Long flags of a POSIX shell that take a VALUE word, which must not be
// mistaken for the command string or for the end of the options. (The SHORT
// value flags, `-o`/`+o`/`-O`/`+O`, are matched by SHELL_VALUE_CLUSTER_RE.)
const POSIX_SHELL_VALUE_FLAGS = new Set(['--rcfile', '--init-file'])
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])

/** `-c` alone or in a short-flag cluster: `-c`, `-lc`, `-ec`, `-ce` ... */
const SHELL_C_FLAG_CLUSTER_RE = /^-[A-Za-z]*c[A-Za-z]*$/

/**
 * A short flag or cluster that ENDS in `o`/`O` takes the next word as its
 * value — the option name: `-o pipefail`, `+o pipefail`, `-O extglob`, and the
 * common `-eo pipefail` (so `pipefail` is not mistaken for the command string).
 */
const SHELL_VALUE_CLUSTER_RE = /^[-+][A-Za-z]*[oO]$/

/**
 * The `-c` COMMAND STRING of an explicit POSIX shell invocation (`words[0]` is
 * the shell): the first operand after the options when those options include a
 * `-c`, or `null` when this is not a `-c` invocation (`bash script.sh`, a bare
 * `sh`, `bash -l`).
 */
function posixShellCommandString(words) {
  let sawC = false
  let i = 1
  for (; i < words.length; i++) {
    const w = words[i]
    if (POSIX_SHELL_VALUE_FLAGS.has(w)) {
      i++
      continue
    }
    if (!/^[-+]/.test(w)) break
    if (SHELL_C_FLAG_CLUSTER_RE.test(w)) sawC = true
    if (SHELL_VALUE_CLUSTER_RE.test(w)) i++
  }
  return sawC && i < words.length ? words[i] : null
}

/** Strips exactly one matched pair of wrapping quotes, if present. */
function stripOuterQuotes(s) {
  const t = s.trim()
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * The command line a `cmd`/`cmd.exe` program would run via its `/c` flag
 * (win-spawn.js's wrapper — see the module docblock), or `null` when there is
 * no `/c`/`-c` flag among the words (nothing for the caller to do, distinct
 * from "found the flag but nothing after it").
 */
function cmdExeCommandString(words) {
  const flagIndex = words.findIndex((a, i) => i > 0 && /^[/-]c$/i.test(a))
  if (flagIndex === -1) return null
  const rest = words.slice(flagIndex + 1).join(' ')
  if (rest.length === 0) return ''
  const unwrapped = stripOuterQuotes(rest)
  // Reverse ONE layer of `^`-escaping (escapeCommand()'s single pass over the
  // command token — see the module docblock for why a single pass is enough
  // for the names this guard cares about).
  return unwrapped.replace(/\^(.)/g, '$1')
}

/**
 * Recognize a SHELL invoked with an inline command string — an explicit POSIX
 * shell with `-c` (#8186), or win-spawn.js's `cmd.exe /c "<line>"` wrapper
 * (#8102) — and return the candidates inside that string, or `null` when
 * `base` is not such a shell or the call has no command string. One function
 * for both dialects: find the flag, take the string, lex it again.
 */
function shellWrapperTokens(base, words) {
  let commandString = null
  if (POSIX_SHELLS.has(base)) commandString = posixShellCommandString(words)
  else if (base === 'cmd') commandString = cmdExeCommandString(words)
  return commandString === null ? null : shellCommandTokens(commandString)
}

// `env` flags that take a value word (`env -u NAME claude`, `env -C DIR claude`).
const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir'])
// `npx` flags that take a value word (`npx -p some-pkg claude`).
const NPX_VALUE_FLAGS = new Set(['-p', '--package'])

/**
 * Drop an `env`/`npx` wrapper's own flags (and, for `env`, its `NAME=value`
 * operands) from `words` — `words[0]` is the wrapper — and return the rest,
 * which starts at the command the wrapper runs.
 */
function skipWrapperArgs(words, valueFlags, skipAssignments) {
  let i = 1
  for (; i < words.length; i++) {
    const w = words[i]
    if (valueFlags.has(w)) {
      i++
      continue
    }
    if (w.startsWith('-')) continue
    if (skipAssignments && ASSIGNMENT_RE.test(w)) continue
    break
  }
  return words.slice(i)
}

/**
 * Reduce an ARGV (`words[0]` is the program) to the program name(s) it would
 * exec — unwrapping `env`, `npx` and shells run with an inline command string
 * (see the module docblock's reducer list). The common case is `[words[0]]`.
 */
function argvTokens(words) {
  const program = words[0]
  const base = stripExeExtension(basename(program)).toLowerCase()
  if (base === 'env' || base === 'npx') {
    const rest = base === 'env'
      ? skipWrapperArgs(words, ENV_VALUE_FLAGS, true)
      : skipWrapperArgs(words, NPX_VALUE_FLAGS, false)
    return rest.length > 0 ? argvTokens(rest) : []
  }
  const wrapped = shellWrapperTokens(base, words)
  if (wrapped !== null) return wrapped
  return [program]
}

/**
 * Reduce one SIMPLE COMMAND of a shell line (a word list from
 * `parseShellLine`) to the program name(s) it would exec: skip leading
 * assignments and the `exec` builtin, then `argvTokens`. A command that is
 * only assignments execs nothing.
 */
function simpleCommandTokens(words) {
  let i = 0
  while (i < words.length && ASSIGNMENT_RE.test(words[i])) i++
  if (words[i] === 'exec') {
    i++
    // exec's own flags: `-c` (empty env), `-l` (login), `-a NAME` (argv[0]).
    while (i < words.length && words[i].startsWith('-')) i += words[i] === '-a' ? 2 : 1
  }
  return i < words.length ? argvTokens(words.slice(i)) : []
}

// A shell expands a leading `~`, `~/`, `$HOME` or `${HOME}` before it execs
// the word, so `~/.local/bin/claude` IS the real install under REAL_INSTALL_
// PREFIXES (the default dev-machine location for the claude CLI). `~user` and
// `$HOMEX` are other things and are left alone.
const HOME_PREFIX_RE = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/

/** `word` with a leading `~`/`$HOME`/`${HOME}` replaced by the home directory. */
function expandHomePrefix(word) {
  return word.replace(HOME_PREFIX_RE, () => HOME_DIR)
}

/**
 * Split a shell command LINE into the program name(s) of every simple
 * command in it — see the module docblock for exactly what this does and does
 * not read. Empty segments (e.g. two operators in a row) contribute nothing.
 * Exported so the tests can pin the exact candidate list, not just "it threw".
 */
export function shellCommandTokens(cmdString) {
  if (typeof cmdString !== 'string' || cmdString.length === 0) return []
  // Home-prefix expansion is a SHELL's job, so it lives here and not in
  // argvTokens(): a no-shell `spawn('~/.local/bin/claude')` is a literal name.
  return parseShellLine(cmdString).flatMap(simpleCommandTokens).map(expandHomePrefix)
}

/**
 * The index of the `args` ARRAY argument (the `['--version']` in
 * `spawn('cloudflared', ['--version'])`), distinct from `findOptionsIndex`'s
 * plain-object `options` argument — every launcher that accepts one puts it
 * at index 1 or later, never index 0 (the command itself). Returns -1 when
 * no positional call took the array form (`spawn(cmd, options)`, or no args
 * at all).
 */
function findArgsArrayIndex(args) {
  for (let i = 1; i < args.length; i++) {
    if (Array.isArray(args[i])) return i
  }
  return -1
}

/**
 * Reconstruct the shell command line a truthy `options.shell` call actually
 * runs: `args[0]` alone when no separate args array was passed (already the
 * whole line for `spawn('cloudflared --version', { shell: true })`), or
 * `[args[0], ...argsArray].join(' ')` when one was (`spawn('true', ['&&',
 * 'codex', 'exec'], { shell: true })` — the guarded name hides in the args
 * ARRAY, not `args[0]`, and only the join reveals it). Same shape Node's own
 * spawn-argument normalization builds for the real child.
 */
function buildShellLine(args) {
  const first = args[0]
  const argsArrayIndex = findArgsArrayIndex(args)
  if (argsArrayIndex === -1) return first
  return [first, ...args[argsArrayIndex]].join(' ')
}

/** `s` cut to 120 characters, for an error message. */
function abbreviate(s) {
  return s.length > 120 ? `${s.slice(0, 117)}...` : s
}

/** The call's argv as a word list — `[file, ...argsArray]`, every word a string. */
function buildArgv(args) {
  const argsArrayIndex = findArgsArrayIndex(args)
  const rest = argsArrayIndex === -1 ? [] : args[argsArrayIndex]
  return [args[0], ...rest.map((a) => (typeof a === 'string' ? a : String(a)))]
}

/**
 * Extract "the command(s) this call would resolve/exec" as an ARRAY of
 * candidate strings — one per launcher shape:
 *   - exec/execSync: args[0] is ALWAYS a shell command STRING; lexed and
 *     reduced by shellCommandTokens.
 *   - spawn/spawnSync/execFile/execFileSync with a truthy `options.shell`
 *     (#8102): Node shell-parses the joined `args[0]` + args-array line
 *     exactly like exec/execSync do; same path, via buildShellLine() +
 *     shellCommandTokens().
 *   - spawn/spawnSync/execFile/execFileSync without a shell: `args[0]` is the
 *     literal program and the args array its argv — never shell-parsed — but
 *     the program may itself be a wrapper that runs another command: `env`,
 *     `npx`, an explicit POSIX shell with `-c` (#8186) or win-spawn.js's
 *     `cmd.exe /c "<line>"` (#8102). argvTokens() unwraps those; for any other
 *     program it returns `args[0]` untouched as the sole candidate.
 *   - fork: args[0] IS the module path — a literal name, never shell-parsed,
 *     never a wrapper — returned as the sole candidate.
 * Returns null when args[0] isn't a usable string (malformed call — let the
 * real function's own validation report that; not this guard's job).
 */
function resolveCommandArg(launcherName, args) {
  const first = args[0]
  if (typeof first !== 'string' || first.length === 0) return null
  if (launcherName === 'exec' || launcherName === 'execSync') return shellCommandTokens(first)
  if (launcherName !== 'fork') {
    const optIndex = findOptionsIndex(args)
    const options = optIndex === -1 ? undefined : args[optIndex]
    if (options && options.shell) return shellCommandTokens(buildShellLine(args))
    return argvTokens(buildArgv(args))
  }
  return [first]
}

/**
 * The `PATH` a launcher call would ACTUALLY resolve a bare command name
 * against: the call's own `options.env.PATH` when it passed one (an explicit
 * `env` always replaces, never merges with, `process.env` — see
 * `resolveEffectivePath`'s doc), else this process's own `process.env.PATH`.
 * Reuses `findOptionsIndex` from `test-spawn-home-sandbox.mjs` rather than a
 * second "which arg is options" parser (same reasoning that module gives for
 * exporting it).
 */
function resolveEffectivePath(args) {
  const optIndex = findOptionsIndex(args)
  const options = optIndex === -1 ? undefined : args[optIndex]
  const env = options && options.env
  if (env && typeof env === 'object') return env.PATH
  return process.env.PATH
}

/**
 * `true` when `cmd` is a guarded real binary per the module docblock's rule,
 * IGNORING PATH — a pure name/path-shape check. `guard()` below additionally
 * consults `resolveEffectivePath` for the bare-name case: a bare name whose
 * call scoped PATH to empty (or omitted it from a replacement `env`) can never
 * resolve to anything, real or otherwise, so it is not flagged even though its
 * NAME matches — see `cloudflare-provenance.test.js`'s #6937 tests, which
 * deliberately spawn bare `cloudflared` with `env: { PATH: '' }` specifically
 * so the OS can't find the real one (#8096 fix 1); this function alone can't
 * tell that call apart from the mutant that reverts it (dropping the empty
 * PATH so a real ambient PATH resolves it again), which is exactly why that
 * distinction lives in `guard()`, where the call's actual args are in hand.
 */
export function isGuardedRealBinary(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) return false
  const base = stripExeExtension(basename(cmd)).toLowerCase()
  if (!GUARDED_BASENAMES.has(base)) return false
  if (isBareName(cmd)) return true
  const comparableCmd = comparablePath(cmd)
  return COMPARABLE_REAL_INSTALL_PREFIXES.some((prefix) => comparableCmd.startsWith(prefix))
}

/**
 * Install the tripwire on the live `node:child_process` CJS exports object,
 * or onto a supplied `target` instead (#8185).
 *
 * The real install (`_setup.mjs`, called with no `target`) is unaffected —
 * `cp` resolves to `require('node:child_process')` exactly as before, so its
 * behaviour is byte-identical. The seam exists so
 * `setup-real-binary-tripwire.test.js` can install this SAME wrapping logic
 * onto a throwaway object of recording, always-safe stub launchers instead
 * of the real module: when the guard below regresses and fails to throw for
 * a guarded binary, the call falls through to that stub — never to a real
 * `claude`/`codex`/`gemini`/`cloudflared` — and the regression shows up as
 * the stub recording a call the test asserts should never happen.
 *
 * Safe to install alongside (before or after) `installSpawnHomeSandbox` —
 * each layer wraps whatever `cp[name]` currently is and calls through to it,
 * so the two compose regardless of install order.
 *
 * @param {object} [opts]
 * @param {string} [opts.allowEnv] Env var name whose value `'1'` disables the
 *   guard entirely. Defaults to `CHROXY_TEST_ALLOW_REAL_BINARY`.
 * @param {object} [opts.target] The object to patch in place of the real
 *   `node:child_process` CJS exports — must expose the same launcher names
 *   (`SPAWN_LAUNCHERS`) as plain functions. Test-only seam; defaults to the
 *   real module.
 * @returns {{installed: string[], skipped: Array<{name: string, reason: string}>}}
 */
export function installRealBinaryTripwire({ allowEnv = 'CHROXY_TEST_ALLOW_REAL_BINARY', target } = {}) {
  const cp = target ?? require('node:child_process')

  function makeError(launcherName, cmd, line) {
    // A guarded name found INSIDE a wrapper or shell line (`sh -c 'claude -v'`)
    // is not the call's own first argument — name the line it was found in, or
    // the message points at a command that does not appear at the call site.
    const where = line !== cmd ? ` (found inside ${JSON.stringify(abbreviate(line))})` : ''
    const err = new Error(
      `[chroxy-test-real-binary] BLOCKED ${launcherName}(${JSON.stringify(cmd)})${where} — this call would ` +
      `resolve/exec a REAL, host-installed provider binary (or cloudflared) instead of a fixture (#8096).\n` +
      `  Point this test at a fixture (a fake, always-present absolute path, or a scoped-empty PATH plus\n` +
      `  empty candidates so resolution can never fall through to a real install), or set\n` +
      `  process.env.${allowEnv} = '1' if a real binary is genuinely, deliberately intended here.\n` +
      `  See scripts/lib/test-real-binary-tripwire.mjs and issue #8096.`,
    )
    err.code = REAL_BINARY_ERROR_CODE
    return err
  }

  function wrap(launcherName, original) {
    const guard = (args) => {
      if (process.env[allowEnv] === '1') return null
      const candidates = resolveCommandArg(launcherName, args)
      if (candidates === null) return null
      // A shell command line can name a guarded binary in more than one
      // position (`true && codex exec`) — check every candidate this call
      // could resolve/exec, not just the first, and report the first match.
      for (const cmd of candidates) {
        if (!isGuardedRealBinary(cmd)) continue
        // A guarded BARE name is only a live risk if the effective PATH this
        // exact call would search is non-empty — an empty (or absent-from-a-
        // replacement-env) PATH means the OS's own search can't find ANYTHING,
        // real binary or not, so flagging it would punish the fix (#8096 fix
        // 1's `env: { PATH: '' }`) instead of the defect. An absolute path
        // under a real install prefix has no such out: it names a specific
        // file on disk regardless of PATH, so it is always flagged.
        if (isBareName(cmd)) {
          const effectivePath = resolveEffectivePath(args)
          if (!(typeof effectivePath === 'string' && effectivePath.length > 0)) continue
        }
        return cmd
      }
      return null
    }

    const patched = function guardedLauncher(...args) {
      const hit = guard(args)
      if (hit !== null) throw makeError(launcherName, hit, hit === args[0] ? hit : buildShellLine(args))
      return original.apply(this, args)
    }

    // Same reasoning as `installSpawnHomeSandbox`: `exec`/`execFile` carry a
    // custom `util.promisify.custom` in Node itself, and this repo's
    // production code relies on the `{ stdout, stderr }` promisified shape
    // (`src/control-room/*`, session-pr-status.js). Preserve it, routed
    // through `patched` (not `original`) so a promisified call is guarded too.
    if (original[promisify.custom]) {
      patched[promisify.custom] = function guardedPromisified(...args) {
        return new Promise((resolvePromise, rejectPromise) => {
          patched.call(this, ...args, (err, stdout, stderr) => {
            if (err) {
              if (stdout !== undefined) err.stdout = stdout
              if (stderr !== undefined) err.stderr = stderr
              rejectPromise(err)
            } else {
              resolvePromise({ stdout, stderr })
            }
          })
        })
      }
    }

    // Forward any OTHER marker symbol `original` already carries (this repo's
    // `installSpawnHomeSandbox`'s `SPAWN_HOME_MARKER`, most concretely) onto
    // `patched`. This module composes on top of the spawn-home sandbox — each
    // layer wraps whatever `cp[name]` currently is — and without this,
    // `setup-spawn-home-sandbox.test.js`'s own "every guarded launcher
    // actually carries the sandbox marker on the LIVE module" coverage test
    // goes red the moment this tripwire installs on top of it: the live
    // `cp[name]` is then THIS module's `patched` function, which never had
    // `SPAWN_HOME_MARKER` set on it directly (only the function it CLOSES
    // OVER does), so a plain `cp[name][SPAWN_HOME_MARKER]` lookup no longer
    // finds it — the mark is real but invisible from outside the closure.
    // Skips symbols already set above (`REAL_BINARY_MARKER`, `promisify.custom`)
    // so this can never clobber either.
    for (const sym of Object.getOwnPropertySymbols(original)) {
      if (!(sym in patched)) patched[sym] = original[sym]
    }

    return patched
  }

  const installed = []
  const skipped = []

  for (const name of SPAWN_LAUNCHERS) {
    const original = cp[name]
    if (typeof original !== 'function') {
      skipped.push({ name, reason: 'absent' })
      continue
    }
    if (original[REAL_BINARY_MARKER]) {
      skipped.push({ name, reason: 'already-guarded' })
      continue
    }
    const patched = wrap(name, original)
    patched[REAL_BINARY_MARKER] = name
    cp[name] = patched
    installed.push(name)
  }

  return { installed, skipped }
}
