#!/usr/bin/env node
/**
 * Lint: session-aware modules in `packages/server/src/` MUST scope their
 * log entries with `sessionId` — either via the `loggerForSession(...)`
 * factory or via an explicit `.withSession(...)` chain on `createLogger`.
 *
 * Background: PR #4787 (security P0) added a defensive filter to the
 * WsServer `_logListener` that drops UNSCOPED log entries from BOUND
 * dashboard clients to prevent cross-session leaks of PTY hex dumps,
 * prompt sizes, toolUseIds, and attachment metadata. The defensive
 * filter ships in #4793. Issue #4792 (this lint) is the durable
 * follow-up: ensure session-aware modules emit scoped entries so the
 * legitimate per-session diagnostic value (operators watching THEIR
 * session in the dashboard) is preserved.
 *
 * The lint has two layers, both ratcheted by file:
 *
 *   1. REQUIRES_FACTORY_IMPORT — the module must `import { loggerForSession }`
 *      from logger.js. Catches drive-by edits that add a new log line
 *      without realising the file participates in the session-scoping
 *      contract.
 *
 *   2. FORBIDS_BARE_CREATELOGGER — every `createLogger(...)` in the
 *      module MUST be followed by `.withSession(...)`. Stronger: blocks
 *      ALL bare `createLogger` once the module has been fully migrated
 *      and no longer needs the pre-session-id fallback. Files in the
 *      first set need not be in the second.
 *
 * As more modules migrate, add them to the appropriate set. Start with
 * REQUIRES_FACTORY_IMPORT for any file you touch session-side; promote
 * to FORBIDS_BARE_CREATELOGGER once the module has zero bare
 * createLogger calls left.
 *
 * Exit codes:
 *   0 — all enforced rules pass
 *   1 — at least one offender found (printed with file:line)
 *
 * Set `DRY_RUN=1` to list offenders without failing the exit code.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = resolve(__dirname, '..', 'src')

/**
 * Files that MUST import `loggerForSession` from logger.js. Signals to
 * future contributors that the module participates in session-scoped
 * logging — a new log line in this file should reach for
 * `loggerForSession(...)` (or `this._log` when the class stashes one).
 *
 * Add a file here when you migrate one of its log sites to the factory.
 * Removing the import then becomes a lint failure, catching drive-by
 * regressions.
 */
const REQUIRES_FACTORY_IMPORT = new Set([
  // #4792 first wave — 4 audit-flagged sites in claude-tui-session.js,
  // 1 in input-handlers.js. See PR opening this issue for the full
  // migration list and the deferred-sweep follow-up issue for the rest.
  'claude-tui-session.js',
  'handlers/input-handlers.js',
  // #4828 second wave — sweep across the remaining per-session
  // surfaces. claude-tui-session.js stays from the first wave; sdk-session
  // and cli-session now bind `this._log` on the init message (where the
  // session id becomes known) and route every post-init log line through
  // it. The handler files migrated every session-aware call site to
  // `loggerForSession('ws', sessionId)`. None of these can promote into
  // FORBIDS_BARE_CREATELOGGER yet because each one keeps a module-level
  // `createLogger('...')` for the pre-session-id / cross-session
  // fallback paths.
  'sdk-session.js',
  'cli-session.js',
  'handlers/conversation-handlers.js',
  'handlers/feature-handlers.js',
  'handlers/session-handlers.js',
  'handlers/settings-handlers.js',
])

/**
 * Files where EVERY `createLogger(...)` call MUST be followed by
 * `.withSession(...)`. Use this once a module is fully migrated and no
 * longer needs the pre-session-id fallback path (i.e. all logging
 * happens after the session id is known).
 *
 * Empty for now — both #4792 first-wave files still keep a bare
 * module-level `const log = createLogger('...')` for the early-boot
 * fallback paths. Promote files here in a follow-up PR once that
 * fallback is gone.
 */
const FORBIDS_BARE_CREATELOGGER = new Set([
  // Add files here once they no longer keep a module-level
  // `createLogger(...)` for pre-session-id fallback.
])

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
  const lastOpen = src.lastIndexOf('/*', idx)
  const lastClose = src.lastIndexOf('*/', idx)
  return lastOpen > lastClose
}

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length
}

function findUnscopedCreateLoggerCalls(src) {
  const offenders = []
  const re = /\bcreateLogger\s*\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    const idx = m.index
    if (isInsideComment(src, idx)) continue

    // Skip import/export lines — `import { createLogger } from ...` is
    // a reference to the symbol, not a call.
    const lineStart = src.lastIndexOf('\n', idx) + 1
    const lineSoFar = src.slice(lineStart, idx)
    if (/^import\b/.test(lineSoFar.trimStart())) continue
    if (/^export\b/.test(lineSoFar.trimStart())) continue

    // Find the matching `)`, then look at what follows.
    let depth = 0
    let i = idx + m[0].length - 1
    let inStr = null
    let close = -1
    while (i < src.length) {
      const ch = src[i]
      const prev = src[i - 1]
      if (inStr) {
        if (ch === inStr && prev !== '\\') inStr = null
      } else if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch
      } else if (ch === '(') {
        depth++
      } else if (ch === ')') {
        depth--
        if (depth === 0) { close = i; break }
      }
      i++
    }
    if (close === -1) continue

    const after = src.slice(close + 1).trimStart()
    if (after.startsWith('.withSession(')) continue

    offenders.push({ line: lineOf(src, idx) })
  }
  return offenders
}

const errors = []
const allEnforced = new Set([
  ...REQUIRES_FACTORY_IMPORT,
  ...FORBIDS_BARE_CREATELOGGER,
])

for (const file of walk(SRC_DIR)) {
  // Normalize to POSIX-style separators so set membership works on Windows
  // (relative() returns \\-separated paths there). REQUIRES_FACTORY_IMPORT
  // / FORBIDS_BARE_CREATELOGGER are authored with POSIX-style paths so the
  // sets stay readable in the source; this normalization is what makes the
  // lint cross-platform.
  const rel = pathSep === '/' ? relative(SRC_DIR, file) : relative(SRC_DIR, file).split(pathSep).join('/')
  if (!allEnforced.has(rel)) continue

  const src = readFileSync(file, 'utf8')

  if (REQUIRES_FACTORY_IMPORT.has(rel)) {
    // Find the logger.js import block and check a session-scoping factory
    // appears: `loggerForSession` directly, or `sessionLogger` (#5378) — the
    // helper that wraps loggerForSession and falls back to the unscoped logger
    // only when sessionId is genuinely absent. Either keeps log entries scoped.
    const importRe = /import\s*\{([^}]*)\}\s*from\s*['"](?:\.{1,2}\/)+logger\.js['"]/g
    let mm
    let found = false
    while ((mm = importRe.exec(src)) !== null) {
      if (/\bloggerForSession\b/.test(mm[1]) || /\bsessionLogger\b/.test(mm[1])) { found = true; break }
    }
    if (!found) {
      // The import path depends on directory depth: src/foo.js uses
      // './logger.js' but src/handlers/foo.js uses '../logger.js'.
      // Compute the correct hint per file so the guidance isn't misleading
      // for nested modules.
      const depth = rel.split('/').length - 1
      const importPath = depth === 0 ? './logger.js' : '../'.repeat(depth) + 'logger.js'
      errors.push({
        file,
        line: 1,
        msg: `session-aware module must \`import { loggerForSession }\` (or \`sessionLogger\`) from '${importPath}' — see issue #4792`,
      })
    }
  }

  if (FORBIDS_BARE_CREATELOGGER.has(rel)) {
    for (const o of findUnscopedCreateLoggerCalls(src)) {
      errors.push({
        file,
        line: o.line,
        msg: 'bare createLogger(...) is forbidden in this module — chain .withSession(...) or use loggerForSession(component, sessionId)',
      })
    }
  }
}

if (errors.length) {
  console.error('ERROR: session-aware modules must scope their log entries with sessionId.')
  console.error('Either import { loggerForSession } and use loggerForSession(component, sessionId)')
  console.error('at the call site, or chain createLogger(component).withSession(sessionId).')
  console.error('See packages/server/src/logger.js and issue #4792.')
  console.error('')
  for (const e of errors) {
    console.error(`  ${e.file}:${e.line} — ${e.msg}`)
  }
  console.error('')
  console.error('Background: issue #4792 (durable fix), PR #4787 / #4793 (defensive filter).')
  if (process.env.DRY_RUN === '1') process.exit(0)
  process.exit(1)
}

const reqCount = REQUIRES_FACTORY_IMPORT.size
const forbidCount = FORBIDS_BARE_CREATELOGGER.size
console.log(`OK: ${reqCount} module(s) import loggerForSession; ${forbidCount} module(s) forbid bare createLogger`)
