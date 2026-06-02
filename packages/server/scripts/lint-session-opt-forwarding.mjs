#!/usr/bin/env node
/**
 * Lint: every class that extends `BaseSession` (or
 * `JsonlSubprocessSession`, the middle layer above the subprocess
 * providers) MUST destructure every constructor opt accepted by
 * `BaseSession` AND forward it via `super({ ... })`. Otherwise the opt
 * is silently dropped on its way down — the middle-layer trap
 * documented in project memory as `feedback_jsonl_subprocess_middle_layer.md`
 * and repeated three times historically (#3224, #3231, #4790).
 *
 * Detection strategy (regex, intentionally — same style as
 * `lint-tests-state-file-path.mjs`):
 *
 * 1. Parse `base-session.js` to extract the canonical set of opt names
 *    from the destructure inside the `BaseSession` constructor.
 * 2. Walk every `*.js` file under `packages/server/src/`.
 * 3. For each `export class X extends (BaseSession|JsonlSubprocessSession)`,
 *    locate the constructor's destructure list and the matching
 *    `super({ ... })` call.
 * 4. Diff the canonical opt set against the destructure + super forward
 *    sets. Any opt that is missing from EITHER side is reported.
 *
 * Two opt-outs:
 *
 *   - `super(opts)` or `super({ ...opts })` style is naturally immune
 *     because every opt is forwarded by reference; the lint skips these
 *     classes.
 *   - A `// lint-ignore-opt-forwarding: <key1>,<key2>` comment placed
 *     immediately above the class declaration whitelists specific opts
 *     for that class. Use sparingly — the comment should explain why.
 *
 * Issue: #4797. Trap that motivated this lint: #4790 (fixed in #4795).
 *
 * Exit codes:
 *   0 — every subclass forwards every BaseSession opt (or is whitelisted)
 *   1 — at least one offender found (printed with file:line + missing key)
 *
 * Flags:
 *   --src-dir <path>   Override the src directory (used by tests against
 *                      fixture trees). Defaults to `../src` relative to
 *                      this script.
 *   --dry-run          Print offenders without failing the exit code.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function parseFlags(argv) {
  const flags = { srcDir: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--src-dir') flags.srcDir = argv[++i]
    else if (a === '--dry-run') flags.dryRun = true
  }
  return flags
}

const { srcDir: srcDirOverride, dryRun } = parseFlags(process.argv.slice(2))
const SRC_DIR = resolve(srcDirOverride || join(__dirname, '..', 'src'))

// ----------------------------------------------------------------------
// Tiny lexer-aware helpers (lifted in spirit from
// `lint-tests-state-file-path.mjs`). Regex is fine here because the
// patterns we care about are stable — destructure-on-one-or-many-lines,
// super({...}) in the constructor body.
// ----------------------------------------------------------------------

function findMatchingBracket(src, openIdx, open, close) {
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
    } else if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl
      continue
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    } else if (ch === open) {
      depth++
    } else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

function stripComments(src) {
  // Strip // line comments and /* block */ comments. Keeps newlines so
  // line-number math downstream still tracks the original source.
  let out = ''
  let i = 0
  let inStr = null
  while (i < src.length) {
    const ch = src[i]
    const prev = src[i - 1]
    if (inStr) {
      out += ch
      if (ch === inStr && prev !== '\\') inStr = null
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      out += ch
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      if (nl === -1) { i = src.length; continue }
      i = nl
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) { i = src.length; continue }
      // Preserve newlines so any downstream line-counting stays sane.
      const block = src.slice(i, end + 2)
      for (const c of block) if (c === '\n') out += '\n'
      i = end + 2
      continue
    }
    out += ch
    i++
  }
  return out
}

// Extract the set of destructure keys from a `{ ... }` block. Handles
// trailing commas, default values (`= foo`), rename (`a: b` — rare here),
// and inline comments (already stripped).
function extractDestructureKeys(block) {
  // block includes the surrounding braces. Trim them.
  const inner = block.slice(1, -1)
  const keys = new Set()
  let depth = 0
  let parenDepth = 0
  let bracketDepth = 0
  let inStr = null
  let buf = ''
  const flush = () => {
    let token = buf.trim()
    buf = ''
    if (!token) return
    // Strip default-value clause: `foo = bar` → `foo`
    const eqIdx = token.indexOf('=')
    if (eqIdx !== -1) token = token.slice(0, eqIdx).trim()
    // Strip type annotation (defensive — server is JS, no TS): `foo: bar`
    const colonIdx = token.indexOf(':')
    if (colonIdx !== -1) token = token.slice(0, colonIdx).trim()
    // Strip rest spread: `...rest` — not a forwardable key, skip.
    if (token.startsWith('...')) return
    if (/^[A-Za-z_$][\w$]*$/.test(token)) keys.add(token)
  }
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    const prev = inner[i - 1]
    if (inStr) {
      buf += ch
      if (ch === inStr && prev !== '\\') inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; buf += ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '(') parenDepth++
    else if (ch === ')') parenDepth--
    else if (ch === '[') bracketDepth++
    else if (ch === ']') bracketDepth--
    if (ch === ',' && depth === 0 && parenDepth === 0 && bracketDepth === 0) {
      flush()
      continue
    }
    buf += ch
  }
  flush()
  return keys
}

// Extract the set of keys passed in a `super({ key1, key2: foo, ... })`
// call. Same parser as the destructure — shorthand `{ a }` and explicit
// `{ a: b }` both register `a` (which is the key BaseSession sees).
function extractObjectKeys(block) {
  return extractDestructureKeys(block)
}

// ----------------------------------------------------------------------
// BaseSession opt parsing
// ----------------------------------------------------------------------

function parseBaseSessionOpts(baseSessionPath) {
  const src = readFileSync(baseSessionPath, 'utf8')
  const stripped = stripComments(src)
  // Anchor on `export class BaseSession` (the class we care about — the
  // file may export helpers and constants too).
  const classIdx = stripped.indexOf('export class BaseSession')
  if (classIdx === -1) {
    throw new Error(`Could not find "export class BaseSession" in ${baseSessionPath}`)
  }
  // Find the `constructor(` after the class declaration.
  const ctorIdx = stripped.indexOf('constructor(', classIdx)
  if (ctorIdx === -1) {
    throw new Error(`Could not find constructor() in BaseSession at ${baseSessionPath}`)
  }
  // The constructor takes a single destructured object: `constructor({ ... } = {})`.
  // Find the `{` that opens the destructure.
  const parenOpen = stripped.indexOf('(', ctorIdx)
  const braceOpen = stripped.indexOf('{', parenOpen)
  if (braceOpen === -1) {
    throw new Error(`Could not find destructure { in BaseSession constructor`)
  }
  const braceClose = findMatchingBracket(stripped, braceOpen, '{', '}')
  if (braceClose === -1) {
    throw new Error(`Unbalanced braces in BaseSession constructor`)
  }
  const block = stripped.slice(braceOpen, braceClose + 1)
  return extractDestructureKeys(block)
}

// ----------------------------------------------------------------------
// Subclass scanning
// ----------------------------------------------------------------------

const CLASS_RE = /export\s+class\s+([A-Za-z_$][\w$]*)\s+extends\s+(BaseSession|JsonlSubprocessSession)\b/g

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length
}

// Find the comment line `// lint-ignore-opt-forwarding: a,b,c` (if any)
// in the few lines immediately preceding the class declaration. `lineNo`
// is the 1-indexed line number of the class declaration in the ORIGINAL
// source (matches strippedSrc's line numbers because stripComments
// preserves newlines). Returns a Set of allow-listed opt names.
function findIgnoreList(origSrc, lineNo) {
  const origLines = origSrc.split('\n')
  // origLines is 0-indexed; the class declaration is at origLines[lineNo - 1].
  // Walk backwards starting from the line above.
  const ignore = new Set()
  for (let i = lineNo - 2; i >= 0; i--) {
    const raw = origLines[i]
    const trimmed = raw.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('//')) {
      const m = trimmed.match(/lint-ignore-opt-forwarding\s*:\s*(.+)$/)
      if (m) {
        for (const k of m[1].split(',')) {
          const key = k.trim()
          if (key) ignore.add(key)
        }
      }
      continue
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.endsWith('*/')) continue
    // First non-comment line — stop searching upward.
    break
  }
  return ignore
}

function findConstructorBlock(strippedSrc, classDeclIdx) {
  // Locate the `{` opening the class body, then the `constructor(` inside.
  const classBodyOpen = strippedSrc.indexOf('{', classDeclIdx)
  if (classBodyOpen === -1) return null
  const classBodyClose = findMatchingBracket(strippedSrc, classBodyOpen, '{', '}')
  if (classBodyClose === -1) return null
  const body = strippedSrc.slice(classBodyOpen, classBodyClose + 1)
  const ctorOffsetInBody = body.indexOf('constructor(')
  if (ctorOffsetInBody === -1) return null
  const ctorAbsIdx = classBodyOpen + ctorOffsetInBody
  return { ctorAbsIdx, classBodyClose }
}

function analyzeClass(filePath, origSrc, strippedSrc, classDeclIdx, className) {
  const block = findConstructorBlock(strippedSrc, classDeclIdx)
  if (!block) {
    return { skipped: true, reason: 'no constructor found' }
  }
  const { ctorAbsIdx } = block
  // Find the destructure pattern inside `constructor(`. Two shapes:
  //   constructor({ a, b } = {}) — destructured
  //   constructor(opts = {}) — single-arg, naturally immune (rest-spread)
  const parenOpen = strippedSrc.indexOf('(', ctorAbsIdx)
  const parenClose = findMatchingBracket(strippedSrc, parenOpen, '(', ')')
  if (parenClose === -1) return { skipped: true, reason: 'unbalanced ctor parens' }
  const args = strippedSrc.slice(parenOpen + 1, parenClose).trim()
  if (!args.startsWith('{')) {
    // Single positional arg — caller is `super(opts)` or `super({ ...opts })`.
    // Naturally immune, skip.
    return { skipped: true, reason: 'single-arg constructor (rest-spread style)' }
  }
  // Find the destructure `{ ... }` inside the args.
  const destructureOpenAbs = strippedSrc.indexOf('{', parenOpen)
  const destructureCloseAbs = findMatchingBracket(strippedSrc, destructureOpenAbs, '{', '}')
  if (destructureCloseAbs === -1) return { skipped: true, reason: 'unbalanced destructure' }
  const destructureBlock = strippedSrc.slice(destructureOpenAbs, destructureCloseAbs + 1)
  const destructureKeys = extractDestructureKeys(destructureBlock)

  // Find the super({ ... }) call in the constructor body.
  const ctorBodyOpen = strippedSrc.indexOf('{', parenClose)
  const ctorBodyClose = findMatchingBracket(strippedSrc, ctorBodyOpen, '{', '}')
  if (ctorBodyClose === -1) return { skipped: true, reason: 'unbalanced ctor body' }
  const ctorBody = strippedSrc.slice(ctorBodyOpen, ctorBodyClose + 1)

  // Locate `super(` — there should be exactly one, at the top of the body.
  const superMatch = ctorBody.match(/super\s*\(/)
  if (!superMatch) return { skipped: true, reason: 'no super() call' }
  const superOpenInBody = ctorBody.indexOf(superMatch[0]) + superMatch[0].length - 1
  const superOpenAbs = ctorBodyOpen + superOpenInBody
  const superCloseAbs = findMatchingBracket(strippedSrc, superOpenAbs, '(', ')')
  if (superCloseAbs === -1) return { skipped: true, reason: 'unbalanced super()' }
  const superArgs = strippedSrc.slice(superOpenAbs + 1, superCloseAbs).trim()

  // super({ ...opts, ... }) or super(opts) — naturally immune.
  if (superArgs.startsWith('...') || /^[A-Za-z_$][\w$]*$/.test(superArgs)) {
    return { skipped: true, reason: 'super forwards rest-spread/positional' }
  }
  if (!superArgs.startsWith('{')) {
    return { skipped: true, reason: 'super() call shape not recognised' }
  }

  // Detect `{ ...opts, ... }` style super calls — also naturally immune.
  // (Look at the inner content for a leading `...identifier`.)
  const superBraceOpenAbs = strippedSrc.indexOf('{', superOpenAbs)
  const superBraceCloseAbs = findMatchingBracket(strippedSrc, superBraceOpenAbs, '{', '}')
  if (superBraceCloseAbs === -1) return { skipped: true, reason: 'unbalanced super({})' }
  const superBlock = strippedSrc.slice(superBraceOpenAbs, superBraceCloseAbs + 1)
  if (/\{\s*\.\.\.[A-Za-z_$]/.test(superBlock)) {
    return { skipped: true, reason: 'super spreads an identifier' }
  }
  const superKeys = extractObjectKeys(superBlock)

  return {
    className,
    destructureKeys,
    superKeys,
    classDeclLine: lineOf(strippedSrc, classDeclIdx),
    ctorLine: lineOf(strippedSrc, ctorAbsIdx),
  }
}

function walk(dir, acc = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (st.isFile() && p.endsWith('.js')) acc.push(p)
  }
  return acc
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

function main() {
  const baseSessionPath = join(SRC_DIR, 'base-session.js')
  let baseOpts
  try {
    baseOpts = parseBaseSessionOpts(baseSessionPath)
  } catch (err) {
    console.error(`ERROR: failed to parse BaseSession opts from ${baseSessionPath}: ${err.message}`)
    process.exit(2)
  }
  if (baseOpts.size === 0) {
    console.error(`ERROR: parsed 0 opts from BaseSession at ${baseSessionPath} — parser is broken`)
    process.exit(2)
  }

  const files = walk(SRC_DIR).filter(f => !f.endsWith('/base-session.js'))
  const offenders = []
  let analyzedCount = 0

  for (const file of files) {
    const origSrc = readFileSync(file, 'utf8')
    if (!CLASS_RE.test(origSrc)) continue
    CLASS_RE.lastIndex = 0
    const strippedSrc = stripComments(origSrc)
    let m
    while ((m = CLASS_RE.exec(strippedSrc)) !== null) {
      const className = m[1]
      const classDeclIdx = m.index
      const declLine = lineOf(strippedSrc, classDeclIdx)
      const ignore = findIgnoreList(origSrc, declLine)
      const analysis = analyzeClass(file, origSrc, strippedSrc, classDeclIdx, className)
      if (analysis.skipped) continue
      analyzedCount++
      const { destructureKeys, superKeys } = analysis
      const missingDestructure = []
      const missingSuper = []
      for (const opt of baseOpts) {
        if (ignore.has(opt)) continue
        if (!destructureKeys.has(opt)) missingDestructure.push(opt)
        // Only flag missing-from-super if it's NOT also missing from
        // destructure (avoids double-reporting; the destructure miss
        // is the root cause and the super miss is its symptom).
        else if (!superKeys.has(opt)) missingSuper.push(opt)
      }
      if (missingDestructure.length || missingSuper.length) {
        offenders.push({
          file,
          line: declLine,
          className,
          missingDestructure,
          missingSuper,
        })
      }
    }
    CLASS_RE.lastIndex = 0
  }

  if (offenders.length) {
    console.error('ERROR: the following session subclasses drop BaseSession opts on their way to super():')
    console.error('')
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  class ${o.className}`)
      if (o.missingDestructure.length) {
        console.error(`    Missing from constructor destructure: ${o.missingDestructure.join(', ')}`)
      }
      if (o.missingSuper.length) {
        console.error(`    Destructured but not forwarded via super(): ${o.missingSuper.join(', ')}`)
      }
    }
    console.error('')
    console.error('This is the "middle-layer trap" documented in project memory as')
    console.error('  feedback_jsonl_subprocess_middle_layer.md')
    console.error('and previously bit #3224, #3231, #4790.')
    console.error('')
    console.error('Fix: add the missing key to both the constructor destructure list AND the')
    console.error('super({ ... }) call. Or, if the omission is deliberate, annotate the class')
    console.error('with `// lint-ignore-opt-forwarding: <key1>,<key2>` immediately above the')
    console.error('class declaration and explain why in a comment.')
    if (dryRun) process.exit(0)
    process.exit(1)
  }

  console.log(
    `OK: ${analyzedCount} session subclass(es) forward all ${baseOpts.size} BaseSession opt(s) ` +
    `(or are explicitly whitelisted).`,
  )
}

main()
