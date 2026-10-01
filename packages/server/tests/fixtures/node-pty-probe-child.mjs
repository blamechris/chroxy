/**
 * #8151 round-2 review (Critical 3a) — calls probeNodePtyAvailable() TWICE
 * in a real child process under a `node:module` resolve hook (either
 * reject-node-pty-import.mjs or resolve-node-pty-import-success.mjs), and
 * prints the two results plus the cached read. The hook counts actual
 * resolve() attempts via PTY_RESOLVE_COUNT_FILE — the test asserts that
 * file has exactly ONE call recorded despite two probe calls here, proving
 * the module-level cache actually avoids a second import attempt (not just
 * that it RETURNS the same value, which a non-caching probe would too).
 */
import { probeNodePtyAvailable, cachedNodePtyAvailable } from '../../src/utils/node-pty-probe.js'

const first = await probeNodePtyAvailable()
const second = await probeNodePtyAvailable()
console.log(JSON.stringify({ first, second, cached: cachedNodePtyAvailable() }))
