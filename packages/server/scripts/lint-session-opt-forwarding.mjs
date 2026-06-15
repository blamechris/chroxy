#!/usr/bin/env node
/**
 * Lint: every class that extends `BaseSession` (or
 * `JsonlSubprocessSession`, the middle layer above the subprocess
 * providers) MUST forward every constructor opt accepted by
 * `BaseSession` down to `super()`. Otherwise the opt is silently dropped
 * on its way down — the middle-layer trap documented in project memory as
 * `feedback_jsonl_subprocess_middle_layer.md` and repeated three times
 * historically (#3224, #3231, #4790).
 *
 * #5367 inverted the policing model. Subclasses no longer hand-maintain a
 * parallel destructure + `super({ ... })`; they call the canonical picker
 * `super(buildBaseSessionOpts(opts, { ...overrides }))`. The lint now:
 *
 * 1. Parses the canonical opt set from the `BaseSession` constructor
 *    destructure (parseBaseSessionOpts).
 * 2. Parses the exported `BASE_SESSION_OPT_KEYS` array literal
 *    (parseBaseSessionOptKeysArray) and ASSERTS it equals (1). This array
 *    is what `buildBaseSessionOpts()` iterates at runtime, so a drift
 *    between it and the real ctor would silently drop the mismatched key —
 *    this is the NEW primary drift guard (exit 2).
 * 3. Walks every `*.js` under `packages/server/src/` and, for each
 *    `export class X extends (BaseSession|JsonlSubprocessSession)`,
 *    inspects the `super(...)` shape:
 *      - `super(buildBaseSessionOpts(...))` → COMPLIANT by construction
 *        (coverage guaranteed by step 2 + the picker copying every key).
 *      - `super(opts)` / `super({ ...opts })` → naturally immune.
 *      - `super({ explicit, keys })` object literal → analyzed per-key
 *        against the canonical set (catches a hand-rolled drop, including
 *        a single-arg ctor that writes `super({ cwd })` and loses the rest).
 *      - anything else (e.g. `super(someOtherFn(opts))`) → OFFENSE, since
 *        it could silently drop keys.
 *
 * Opt-out:
 *   - A `// lint-ignore-opt-forwarding: <key1>,<key2>` comment placed
 *     immediately above the class declaration whitelists specific opts
 *     for that class (object-literal path only). Use sparingly — the
 *     comment should explain why.
 *
 * Issue: #4797 (original), #5367 (picker + inversion). Trap that motivated
 * this lint: #4790 (fixed in #4795).
 *
 * Exit codes:
 *   0 — every subclass forwards every BaseSession opt (or is whitelisted)
 *   1 — at least one subclass offender found (printed with file:line)
 *   2 — BASE_SESSION_OPT_KEYS drifted from the ctor, or a parser failure
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

// #5367: parse the `BASE_SESSION_OPT_KEYS = [ ... ]` array literal exported by
// base-session.js. This array is the runtime source of truth that
// `buildBaseSessionOpts()` iterates, so the lint asserts it stays in lockstep
// with the constructor destructure (parseBaseSessionOpts above). If the two
// drift — a key added to the ctor but not the array, or vice-versa — the
// picker would silently stop forwarding it, re-arming the middle-layer trap.
// Returns { keys: Set<string>, order: string[] }.
function parseBaseSessionOptKeysArray(baseSessionPath) {
  const src = readFileSync(baseSessionPath, 'utf8')
  const stripped = stripComments(src)
  const declIdx = stripped.indexOf('BASE_SESSION_OPT_KEYS')
  if (declIdx === -1) {
    throw new Error(`Could not find "BASE_SESSION_OPT_KEYS" in ${baseSessionPath}`)
  }
  const bracketOpen = stripped.indexOf('[', declIdx)
  if (bracketOpen === -1) {
    throw new Error(`Could not find [ opening BASE_SESSION_OPT_KEYS array`)
  }
  const bracketClose = findMatchingBracket(stripped, bracketOpen, '[', ']')
  if (bracketClose === -1) {
    throw new Error(`Unbalanced brackets in BASE_SESSION_OPT_KEYS array`)
  }
  const inner = stripped.slice(bracketOpen + 1, bracketClose)
  const order = []
  const keys = new Set()
  for (const m of inner.matchAll(/['"`]([A-Za-z_$][\w$]*)['"`]/g)) {
    order.push(m[1])
    keys.add(m[1])
  }
  return { keys, order }
}

// ----------------------------------------------------------------------
// Subclass scanning
// ----------------------------------------------------------------------

// Root session base classes. Every class whose `extends` chain reaches one of
// these — transitively — is a session subclass the opt-forwarding rule applies
// to. The full set is discovered by fixpoint (discoverSessionBases) so the
// SECOND middle layer is analyzed too: DockerSdkSession extends SdkSession, the
// four ClaudeByokSession variants (Anthropic-compatible/DeepSeek/Ollama/
// docker-byok), and DockerSession extends CliSession (audit P2-1). The old fixed
// regex matched only the two roots, so those six were invisible to the lint.
const ROOT_SESSION_BASES = ['BaseSession', 'JsonlSubprocessSession']

// Parents whose subclasses must NOT forward via the buildBaseSessionOpts()
// picker: ClaudeByokSession reads provider-local opts (mcpConfigPath /
// mcpToolCallTimeoutMs / mcpStartCapMs) off the RAW opts object, which the
// picker — copying only the 20 BASE_SESSION_OPT_KEYS — would silently drop. A
// spread/positional super forwards them. #5367 moved the middle-layer trap from
// base opts onto these provider-local opts (audit P2-1, second finding).
const PICKER_FORBIDDEN_PARENTS = new Set(['ClaudeByokSession'])

// Matches `class X extends Y` (with or without `export`, any indentation — the
// factory-defined AnthropicCompatibleSession is a plain `class`, not exported).
const ANY_CLASS_RE = /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)\b/g

/**
 * Transitively discover every session subclass name by fixpoint: seed with the
 * roots, then repeatedly add any `class X extends Y` whose Y is already known
 * until closure. `allStrippedSources` is every session file's comment-stripped
 * source. Returns the full Set of base names (roots included).
 */
function discoverSessionBases(allStrippedSources) {
  const edges = []
  for (const stripped of allStrippedSources) {
    for (const m of stripped.matchAll(ANY_CLASS_RE)) {
      edges.push({ child: m[1], parent: m[2] })
    }
  }
  const bases = new Set(ROOT_SESSION_BASES)
  let changed = true
  while (changed) {
    changed = false
    for (const { child, parent } of edges) {
      if (bases.has(parent) && !bases.has(child)) {
        bases.add(child)
        changed = true
      }
    }
  }
  return bases
}

/** Build a `class X extends <one of baseNames>` global matcher (m[1]=class, m[2]=parent). */
function buildSessionClassRegex(baseNames) {
  const alt = [...baseNames].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return new RegExp(`(?:export\\s+)?class\\s+([A-Za-z_$][\\w$]*)\\s+extends\\s+(${alt})\\b`, 'g')
}

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
  // Find the constructor arg list. Two shapes:
  //   constructor({ a, b } = {}) — legacy hand-rolled destructure
  //   constructor(opts = {})     — #5367 single-arg picker style
  const parenOpen = strippedSrc.indexOf('(', ctorAbsIdx)
  const parenClose = findMatchingBracket(strippedSrc, parenOpen, '(', ')')
  if (parenClose === -1) return { skipped: true, reason: 'unbalanced ctor parens' }
  const args = strippedSrc.slice(parenOpen + 1, parenClose).trim()
  const hasDestructureArg = args.startsWith('{')

  // Legacy destructure keys (only meaningful when the ctor destructures its
  // arg). For single-arg `constructor(opts = {})` there's nothing to check on
  // the destructure side — coverage is proven by the super() shape instead.
  let destructureKeys = null
  if (hasDestructureArg) {
    const destructureOpenAbs = strippedSrc.indexOf('{', parenOpen)
    const destructureCloseAbs = findMatchingBracket(strippedSrc, destructureOpenAbs, '{', '}')
    if (destructureCloseAbs === -1) return { skipped: true, reason: 'unbalanced destructure' }
    const destructureBlock = strippedSrc.slice(destructureOpenAbs, destructureCloseAbs + 1)
    destructureKeys = extractDestructureKeys(destructureBlock)
  }

  // Find the super(...) call in the constructor body.
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

  const classDeclLine = lineOf(strippedSrc, classDeclIdx)
  const ctorLine = lineOf(strippedSrc, ctorAbsIdx)

  // #5367: `super(buildBaseSessionOpts(...))` — the sanctioned picker. Coverage
  // of every BaseSession opt is guaranteed by the picker copying every key in
  // BASE_SESSION_OPT_KEYS, which main() has already asserted equals the ctor
  // destructure. Per-subclass `overrides` only ADD or replace values; they
  // cannot drop a key. So this shape is compliant-by-construction.
  if (/^buildBaseSessionOpts\s*\(/.test(superArgs)) {
    return { className, compliant: 'picker', classDeclLine, ctorLine }
  }

  // super(opts) or super({ ...opts, ... }) — every opt forwarded by reference.
  if (superArgs.startsWith('...') || /^[A-Za-z_$][\w$]*$/.test(superArgs)) {
    return { skipped: true, reason: 'super forwards rest-spread/positional' }
  }

  // super({ ...explicit object literal... }) — the legacy hand-rolled path AND
  // the shape a regression would take in a single-arg ctor (someone writes
  // `super({ cwd })` and silently drops the rest). Analyze per-key below.
  if (superArgs.startsWith('{')) {
    const superBraceOpenAbs = strippedSrc.indexOf('{', superOpenAbs)
    const superBraceCloseAbs = findMatchingBracket(strippedSrc, superBraceOpenAbs, '{', '}')
    if (superBraceCloseAbs === -1) return { skipped: true, reason: 'unbalanced super({})' }
    const superBlock = strippedSrc.slice(superBraceOpenAbs, superBraceCloseAbs + 1)
    // `super({ ...identifier, ... })` spreads every opt — naturally immune.
    if (/\{\s*\.\.\.[A-Za-z_$]/.test(superBlock)) {
      return { skipped: true, reason: 'super spreads an identifier' }
    }
    const superKeys = extractObjectKeys(superBlock)
    return { className, destructureKeys, superKeys, classDeclLine, ctorLine }
  }

  // #5367: any other super() shape (e.g. `super(someOtherFn(opts))`) is NOT a
  // recognized safe forwarder and could silently drop keys. Flag it as an
  // offense rather than skipping (the pre-#5367 lint skipped these, which is
  // exactly the hole the picker would have slipped through).
  return { className, unrecognizedSuper: superArgs.slice(0, 60), classDeclLine, ctorLine }
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

  // #5367: the array `BASE_SESSION_OPT_KEYS` is what `buildBaseSessionOpts()`
  // iterates at runtime. Assert it equals the set parsed from the constructor
  // destructure — if they drift, the picker silently stops forwarding the
  // mismatched key(s), re-arming the middle-layer trap. This is the new drift
  // guard that replaces the per-subclass destructure check for picker classes.
  let optArray
  try {
    optArray = parseBaseSessionOptKeysArray(baseSessionPath)
  } catch (err) {
    console.error(`ERROR: failed to parse BASE_SESSION_OPT_KEYS from ${baseSessionPath}: ${err.message}`)
    process.exit(2)
  }
  if (optArray.keys.size === 0) {
    console.error(`ERROR: parsed 0 keys from BASE_SESSION_OPT_KEYS at ${baseSessionPath} — parser is broken`)
    process.exit(2)
  }
  {
    const inArrayNotCtor = [...optArray.keys].filter(k => !baseOpts.has(k))
    const inCtorNotArray = [...baseOpts].filter(k => !optArray.keys.has(k))
    if (inArrayNotCtor.length || inCtorNotArray.length) {
      console.error('ERROR: BASE_SESSION_OPT_KEYS has drifted from the BaseSession constructor destructure.')
      console.error(`  in ${baseSessionPath}`)
      if (inCtorNotArray.length) {
        console.error(`    In constructor but MISSING from BASE_SESSION_OPT_KEYS: ${inCtorNotArray.join(', ')}`)
      }
      if (inArrayNotCtor.length) {
        console.error(`    In BASE_SESSION_OPT_KEYS but MISSING from constructor: ${inArrayNotCtor.join(', ')}`)
      }
      console.error('')
      console.error('buildBaseSessionOpts() iterates BASE_SESSION_OPT_KEYS, so any key only in the')
      console.error('constructor would be silently dropped on its way to super() — the middle-layer')
      console.error('trap (feedback_jsonl_subprocess_middle_layer.md, bit #3224/#3231/#4790).')
      console.error('Fix: keep BASE_SESSION_OPT_KEYS in lockstep with the constructor destructure.')
      process.exit(2)
    }
  }

  const allFiles = walk(SRC_DIR)
  // Discover the transitive session-base closure across ALL files (incl.
  // base-session.js) so the fixpoint sees every `class … extends …` edge, then
  // build the matcher that picks up direct AND second-tier subclasses.
  const sessionBases = discoverSessionBases(allFiles.map(f => stripComments(readFileSync(f, 'utf8'))))
  const classRe = buildSessionClassRegex(sessionBases)

  const files = allFiles.filter(f => !f.endsWith('/base-session.js'))
  const offenders = []
  let analyzedCount = 0

  for (const file of files) {
    const origSrc = readFileSync(file, 'utf8')
    if (!classRe.test(origSrc)) continue
    classRe.lastIndex = 0
    const strippedSrc = stripComments(origSrc)
    let m
    while ((m = classRe.exec(strippedSrc)) !== null) {
      const className = m[1]
      const parentName = m[2]
      const classDeclIdx = m.index
      const declLine = lineOf(strippedSrc, classDeclIdx)
      const ignore = findIgnoreList(origSrc, declLine)
      const analysis = analyzeClass(file, origSrc, strippedSrc, classDeclIdx, className)
      if (analysis.skipped) continue
      analyzedCount++

      // #5367: `super(buildBaseSessionOpts(...))` — compliant by construction
      // for BASE opts (coverage guaranteed by the array-vs-ctor assertion above
      // + the picker copying every key). Counts as analyzed-and-ok — UNLESS the
      // parent reads provider-local opts off raw opts (audit P2-1), where the
      // picker drops them.
      if (analysis.compliant === 'picker') {
        if (PICKER_FORBIDDEN_PARENTS.has(parentName)) {
          offenders.push({ file, line: declLine, className, pickerForbidden: parentName })
        }
        continue
      }

      // #5367: an unrecognized super() shape (not the picker, not a bare
      // identifier/spread, not an object literal) could silently drop keys.
      if (analysis.unrecognizedSuper !== undefined) {
        offenders.push({
          file,
          line: declLine,
          className,
          unrecognizedSuper: analysis.unrecognizedSuper,
        })
        continue
      }

      // Legacy / hand-rolled `super({ ... })` object-literal path: every
      // BaseSession opt must appear in the super() object (and, when the ctor
      // destructures its arg, in the destructure too).
      const { destructureKeys, superKeys } = analysis
      const missingDestructure = []
      const missingSuper = []
      for (const opt of baseOpts) {
        if (ignore.has(opt)) continue
        // destructureKeys is null for single-arg `constructor(opts = {})` —
        // there's no destructure to check, only the super() object.
        if (destructureKeys && !destructureKeys.has(opt)) missingDestructure.push(opt)
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
    classRe.lastIndex = 0
  }

  if (offenders.length) {
    console.error('ERROR: the following session subclasses drop BaseSession opts on their way to super():')
    console.error('')
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  class ${o.className}`)
      if (o.pickerForbidden) {
        console.error(`    Uses super(buildBaseSessionOpts(...)) but extends ${o.pickerForbidden}, which`)
        console.error('    reads provider-local opts (mcpConfigPath / mcpToolCallTimeoutMs / mcpStartCapMs)')
        console.error('    off raw opts — the picker copies only BASE_SESSION_OPT_KEYS and would silently')
        console.error('    drop them. Forward with super({ ...opts, <overrides> }) instead.')
        continue
      }
      if (o.unrecognizedSuper !== undefined) {
        console.error(`    Unrecognized super() shape: super(${o.unrecognizedSuper}...)`)
        console.error('    Expected super(buildBaseSessionOpts(opts, { ...overrides })), super(opts),')
        console.error('    super({ ...opts }), or an explicit super({ <every BaseSession opt> }).')
        continue
      }
      if (o.missingDestructure && o.missingDestructure.length) {
        console.error(`    Missing from constructor destructure: ${o.missingDestructure.join(', ')}`)
      }
      if (o.missingSuper && o.missingSuper.length) {
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
