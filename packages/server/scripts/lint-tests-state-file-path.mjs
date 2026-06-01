#!/usr/bin/env node
/**
 * Lint: every `new SessionManager(...)` call in `packages/server/tests/`
 * must include `stateFilePath`. Otherwise the manager defaults to
 * `~/.chroxy/session-state.json` and the test silently writes to the
 * developer's (or CI runner's) real user state file.
 *
 * The setup hook in `tests/_setup.mjs` reroutes HOME to a tmp dir as a
 * safety net, but the explicit option is still required so the intent is
 * obvious in review and a future setup-hook regression cannot reintroduce
 * the original bug class.
 *
 * Issue: #4633. Prior incidents: #2314, #429, 2026-05-30 contamination.
 *
 * Exit codes:
 *   0 — every `new SessionManager(...)` in tests passes `stateFilePath`
 *   1 — at least one offender found (printed with file:line)
 *
 * Set `DRY_RUN=1` to list offenders without failing the exit code.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TESTS_DIR = resolve(__dirname, '..', 'tests')

function walk(dir, acc = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (st.isFile() && p.endsWith('.test.js')) acc.push(p)
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

function findMatchingParen(src, openIdx) {
  let depth = 0
  let i = openIdx
  let inStr = null
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
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

const offenders = []
for (const file of walk(TESTS_DIR)) {
  const src = readFileSync(file, 'utf8')
  const NEEDLE = 'new SessionManager('
  let i = 0
  while (true) {
    const idx = src.indexOf(NEEDLE, i)
    if (idx === -1) break
    i = idx + 1
    if (isInsideComment(src, idx)) continue
    const openParen = idx + NEEDLE.length - 1
    const closeParen = findMatchingParen(src, openParen)
    if (closeParen === -1) continue
    const callBody = src.slice(idx, closeParen + 1)
    if (!/\bstateFilePath\b/.test(callBody)) {
      const before = src.slice(0, idx)
      const line = before.split('\n').length
      offenders.push(`${file}:${line}`)
    }
  }
}

if (offenders.length) {
  console.error('ERROR: the following test sites construct SessionManager without an explicit stateFilePath:')
  for (const o of offenders) console.error(`  ${o}`)
  console.error('')
  console.error('Fix: add `stateFilePath: tmpStateFile()` (or another temp path) to the constructor options.')
  console.error('Pattern: see packages/server/tests/session-manager.test.js (`tmpStateFile()` helper).')
  console.error('Background: issue #4633, packages/server/tests/_setup.mjs.')
  if (process.env.DRY_RUN === '1') process.exit(0)
  process.exit(1)
}

console.log('OK: every new SessionManager(...) in tests includes stateFilePath')
