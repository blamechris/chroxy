#!/usr/bin/env node
/**
 * Lint: the sessionId→clients reverse index introduced in #5575 is only
 * correct if every change to a client's subscription Set or active session
 * routes through the index-maintaining mutators on `ws-client-manager.js`
 * (`subscribe` / `unsubscribe` / `setActiveSession`). A bare
 * `client.activeSessionId = x` or `client.subscribedSessionIds.add(...)`
 * outside that file mutates the per-client state WITHOUT updating the reverse
 * index, so the index silently drifts — exactly the failure #5575's comment
 * contract warns against. This lint turns that comment contract into a CI gate.
 *
 * Forbidden OUTSIDE `ws-client-manager.js`:
 *   - `<expr>.activeSessionId = <…>`            (bare active-session write)
 *   - `<expr>.subscribedSessionIds.add(<…>)`    (bare subscribe)
 *   - `<expr>.subscribedSessionIds.delete(<…>)` (bare unsubscribe)
 *   - `<expr>.subscribedSessionIds.clear()`     (bare clear)
 *
 * NOT forbidden (and not matched):
 *   - comparisons: `client.activeSessionId === sessionId`, `!==`, `==`
 *   - reads: `if (client.activeSessionId)`, `client.subscribedSessionIds.has(...)`
 *   - anything inside a `//` or block comment
 *
 * Allow-list / opt-out:
 *   - `ws-client-manager.js` — the OWNER of the index; its mutators are the
 *     sanctioned write path, so it is exempt wholesale.
 *   - `// lint-ignore-ws-index-mutation` placed on the line immediately above an
 *     offending statement whitelists that one site. Used for the two guarded
 *     fixture-fallback else-branches in ws-history.js / handler-utils.js (#5563),
 *     where the helper path is always taken in production and the bare write
 *     only runs for legacy test fixtures whose ctx predates the helper.
 *
 * Issue: #5579 (this lint). Index it guards: #5575. Helper contract: #5563.
 *
 * Exit codes:
 *   0 — no bare reverse-index mutations outside the owner / allow-list
 *   1 — at least one offender found (printed with file:line)
 *
 * Flags:
 *   --src-dir <path>   Override the src directory (used by tests against
 *                      fixture trees). Defaults to `../src` relative to this
 *                      script.
 *   --dry-run          Print offenders without failing the exit code.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = { srcDir: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src-dir') out.srcDir = argv[++i]
    else if (argv[i] === '--dry-run') out.dryRun = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const SRC_DIR = args.srcDir ? resolve(args.srcDir) : resolve(__dirname, '..', 'src')

// The owner of the reverse index — its mutators are the sanctioned write path.
const OWNER_FILE = 'ws-client-manager.js'

// Per-line opt-out comment (matched against the line ABOVE an offending line).
const IGNORE_COMMENT = 'lint-ignore-ws-index-mutation'

// Bare active-session write: `.activeSessionId =` but NOT `==` / `===` / `=>`.
const ACTIVE_WRITE_RE = /\.activeSessionId\s*=(?![=>])/g
// Bare subscription-Set mutation.
const SET_MUTATE_RE = /\.subscribedSessionIds\.(add|delete|clear)\s*\(/g

function walk(dir, acc = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (st.isFile() && p.endsWith('.js')) acc.push(p)
  }
  return acc
}

function isInsideComment(src, idx) {
  const lineStart = src.lastIndexOf('\n', idx) + 1
  const lineSoFar = src.slice(lineStart, idx)
  if (lineSoFar.trimStart().startsWith('//')) return true
  if (lineSoFar.trimStart().startsWith('*')) return true
  // Trailing inline `//` comment: a `//` opener earlier on the SAME line puts
  // `idx` inside a line comment (e.g. `foo() // client.activeSessionId = x`).
  // Ignore a `://` (URL scheme) so an inline URL before the match doesn't
  // spuriously suppress a real offense; the matched tokens are code-like so a
  // `//` inside a string literal on the same line is vanishingly unlikely.
  for (let i = lineSoFar.indexOf('//'); i !== -1; i = lineSoFar.indexOf('//', i + 1)) {
    if (i === 0 || lineSoFar[i - 1] !== ':') return true
  }
  const lastOpen = src.lastIndexOf('/*', idx)
  const lastClose = src.lastIndexOf('*/', idx)
  return lastOpen > lastClose
}

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length
}

// True if the opt-out comment appears in the contiguous block of `//` comment
// lines immediately preceding `idx`. Scanning the whole block (not just the
// single line above) lets the marker lead a multi-line justification comment
// without forcing it onto the last line.
function hasIgnoreAbove(src, idx) {
  let lineStart = src.lastIndexOf('\n', idx) + 1
  while (lineStart > 0) {
    const prevLineEnd = lineStart - 1
    const prevLineStart = src.lastIndexOf('\n', prevLineEnd - 1) + 1
    const prevLine = src.slice(prevLineStart, prevLineEnd).trim()
    if (!prevLine.startsWith('//')) return false
    if (prevLine.includes(IGNORE_COMMENT)) return true
    lineStart = prevLineStart
  }
  return false
}

function findOffenders(src, label) {
  const offenders = []
  for (const re of [ACTIVE_WRITE_RE, SET_MUTATE_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src)) !== null) {
      const idx = m.index
      if (isInsideComment(src, idx)) continue
      if (hasIgnoreAbove(src, idx)) continue
      offenders.push({ line: lineOf(src, idx), kind: label })
    }
  }
  return offenders.sort((a, b) => a.line - b.line)
}

const errors = []
for (const file of walk(SRC_DIR)) {
  const rel = pathSep === '/' ? relative(SRC_DIR, file) : relative(SRC_DIR, file).split(pathSep).join('/')
  if (rel === OWNER_FILE) continue
  const src = readFileSync(file, 'utf8')
  for (const o of findOffenders(src)) {
    errors.push({ file, line: o.line })
  }
}

if (errors.length) {
  console.error('ERROR: bare reverse-index mutation(s) found outside ws-client-manager.js.')
  console.error('')
  console.error('The sessionId→clients reverse index (#5575) drifts silently when a client\'s')
  console.error('active session or subscription Set is mutated without going through the')
  console.error('index-maintaining mutators on ws-client-manager.js. Route the change through:')
  console.error('  ctx.transport.setActiveSession(client, sessionId)')
  console.error('  ctx.transport.subscribeClient(client, sessionId)')
  console.error('  ctx.transport.unsubscribeClient(client, sessionId)')
  console.error('instead of `client.activeSessionId = …` / `client.subscribedSessionIds.add(…)`.')
  console.error('')
  console.error('If a site is a guarded fixture fallback (the helper is always taken in prod),')
  console.error(`add a \`// ${IGNORE_COMMENT}\` comment on the line immediately above it.`)
  console.error('')
  for (const e of errors) {
    console.error(`  ${e.file}:${e.line}`)
  }
  console.error('')
  console.error('Background: issue #5579 (this lint), #5575 (the index), #5563 (the helpers).')
  if (args.dryRun) process.exit(0)
  process.exit(1)
}

console.log('OK: no bare reverse-index mutations outside ws-client-manager.js')
