/**
 * node-pty-support.js (#8151) — one shared message for "node-pty failed to
 * load", used by every provider that dynamically `import('node-pty')`s.
 *
 * `claude-tui-session.js` and `user-shell-session.js` both do:
 *
 *   let ptyMod
 *   try {
 *     ptyMod = await import('node-pty')
 *   } catch (err) {
 *     // ... surface err somehow ...
 *   }
 *
 * node-pty is a REGULAR (non-optional) server dependency, so its JS wrapper
 * is always present, but its native addon is not: the official Docker image
 * runs `npm ci --ignore-scripts` (no build-essential/python3 either), which
 * skips the node-gyp rebuild / prebuilt-binary fetch that would normally
 * produce `build/Release/pty.node`. Importing node-pty there throws — often
 * a bare `Cannot find module '.../build/Release/pty.node'`, which is a true
 * statement but not an ACTIONABLE one: it doesn't say the embedded terminal
 * and the claude-tui provider are simply unsupported in this environment, or
 * what to use instead. Before #8151 both catch blocks reported that raw
 * message verbatim (still not a crash — see session-manager.js's
 * `_handleAsyncStartFailure` / claude-tui's own `error` emit — just an
 * unhelpful one).
 *
 * This is deliberately NOT Docker-specific: node-pty can just as validly fail
 * to load on a bare-metal host with no native build toolchain, or after a
 * Node ABI bump with no matching prebuild. The message names the Docker image
 * as the expected case (since that's the one shipped, deliberately, without a
 * build toolchain) while staying correct for any other cause.
 */

import { getErrorMessage } from './error-message.js'

/**
 * A stable, greppable marker independent of the human-readable wording in
 * `describeNodePtyUnavailable()` below.
 *
 * #8151 round-2 review (Critical 4): `scripts/docker-image-smoke.sh`'s check
 * 3 asserts that a healthy container's logs contain NEITHER this failure
 * signature NOR "Destroyed session" — the fingerprint of a PTY-based
 * provider failing silently behind a healthy HTTP server. That assertion
 * used to `grep -qF 'node-pty unavailable'`, a SUBSTRING of the prose
 * message below — S8 reworded that prose ("node-pty unavailable" →
 * "node-pty is unavailable here"), which silently broke the match: the
 * negative assertion could no longer fire on a real failure, so a
 * regression that reintroduced claude-tui as the Default provider would
 * have passed checks 1-6 clean. A hardcoded prose fragment beside wording
 * that's free to change is exactly the "guard whose comment describes a
 * stronger check than its code performs" class in
 * docs/false-safety-guards.md. This constant is the ONE literal both the
 * message below and the smoke script's needle are built from — reworded
 * prose can't desync the two, because there's only one string to reword.
 *
 * It doubles as this failure's `.code` (see `claude-tui-session.js` /
 * `user-shell-session.js`), so a client-side error handler and a bash grep
 * key off literally the same token.
 */
export const NODE_PTY_UNAVAILABLE_CODE = 'PTY_UNAVAILABLE'

/**
 * Build the user-visible error message for a failed `import('node-pty')`.
 *
 * #8151 review (S8): the ACTIONABLE sentence leads — a client showing only
 * the first N characters of a toast still shows the fix, not just a fact.
 * The cause is appended LAST, and only its FIRST LINE: node-pty's own
 * "Cannot find module '.../build/Release/pty.node'" is one line, but some
 * native-addon load failures (a segfault backtrace, an N-API ABI-mismatch
 * dump) are many, and a multi-line cause buried in the middle of an already
 * long message is unreadable in a one-line toast.
 *
 * #8151 round-2 review (S4): "reinstall it" undersold the fix — `npm rebuild
 * node-pty` only rebuilds the native addon for the CURRENT process's already
 * -loaded module graph; the already-running daemon must actually restart to
 * pick up the rebuilt binding. Worded as a two-step instruction.
 *
 * @param {unknown} err - the caught import rejection
 * @returns {string}
 */
export function describeNodePtyUnavailable(err) {
  const cause = getErrorMessage(err, 'unknown error').split('\n')[0]
  return (
    `node-pty is unavailable here [${NODE_PTY_UNAVAILABLE_CODE}] — use the ` +
    `claude-sdk provider instead. The embedded terminal and the claude-tui ` +
    `provider both require a native PTY binding that failed to load. This is ` +
    `expected inside the official chroxy Docker image, which ships without a ` +
    `native build toolchain (node-pty has no linux prebuild). Outside ` +
    `Docker, run \`npm rebuild node-pty\` and restart the chroxy daemon — on ` +
    `Linux the rebuild needs python3, make and a C++ compiler. ` +
    `Cause: ${cause}`
  )
}

/**
 * Build the Error to throw/latch for a failed `import('node-pty')` — the
 * ONE catch body both providers' two import-invocation shapes (the real
 * `await import('node-pty')` and a test's function-shaped `_ptyModOverride`
 * override) share.
 *
 * #8151 round-2 review (Critical 1): before this, `claude-tui-session.js`'s
 * `_spawnPty` and `user-shell-session.js`'s `start()` each duplicated this
 * exact `describeNodePtyUnavailable` + `Object.assign(..., { code })`
 * construction across TWO catch blocks per file (one per import shape) —
 * correct duplication at the time (each catch body was too small to be
 * worth a shared helper on its own), but it meant a future edit to one
 * copy silently not reaching the other three. Factored out here so there
 * is exactly one place that builds this error; the two `try`/`await
 * import(...)` call sites stay separate (not wrapped in a shared function)
 * so `lint-argv-sinks.mjs`'s AST recognition of the literal `ptyMod = await
 * import('node-pty')` shape keeps seeing the real spawn sink.
 *
 * @param {unknown} err - the caught import rejection
 * @returns {Error & { code: 'PTY_UNAVAILABLE' }}
 */
export function nodePtyImportFailureError(err) {
  return Object.assign(new Error(describeNodePtyUnavailable(err)), { code: NODE_PTY_UNAVAILABLE_CODE })
}
