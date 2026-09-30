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
 * @param {unknown} err - the caught import rejection
 * @returns {string}
 */
export function describeNodePtyUnavailable(err) {
  const cause = getErrorMessage(err, 'unknown error').split('\n')[0]
  return (
    `node-pty is unavailable here — use the claude-sdk provider instead. ` +
    `The embedded terminal and the claude-tui provider both require a ` +
    `native PTY binding that failed to load. This is expected inside the ` +
    `official chroxy Docker image, which ships without a native build ` +
    `toolchain (node-pty has no linux prebuild). Outside Docker, reinstall ` +
    `it (\`npm rebuild node-pty\`) — on Linux this needs python3, make and ` +
    `a C++ compiler. Cause: ${cause}`
  )
}
