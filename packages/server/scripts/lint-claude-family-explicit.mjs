#!/usr/bin/env node
/**
 * Lint: every class that `extends ClaudeByokSession` MUST declare its own
 * `static claudeFamily = true|false`.
 *
 * Background (#5858 / #5890 / #5891): Claude-family membership — which decides
 * whether a provider's model ids validate STRICTLY or soft-fall-back to a stale
 * Claude default — is the single `static claudeFamily` flag (models.js reads
 * `ProviderClass.claudeFamily`). `ClaudeByokSession` is the shared base for the
 * agent-loop providers and sets `static claudeFamily = true`. The residual drift
 * mode: a NEW non-Claude provider that `extends ClaudeByokSession` and forgets to
 * override `static claudeFamily = false` silently INHERITS `true` and is
 * mis-classified as Claude-family.
 *
 * This lint closes that gap at the source — mirroring the opt-forwarding lint
 * discipline (#4797). It requires every subclass to state its membership
 * explicitly (true or false), so inheritance is never the load-bearing answer.
 * The test-authored truth (per-provider expectation) stays out of production; the
 * production source keeps a literal-free single source of membership.
 *
 * Exit codes:
 *   0 — every `extends ClaudeByokSession` subclass declares `static claudeFamily`
 *   1 — at least one subclass omits it (printed with file:line + class name)
 *   2 — parser failure
 *
 * Flags:
 *   --src-dir <path>   Override the src directory (used by the test against a
 *                      fixture tree). Defaults to `../src` relative to this file.
 *   --dry-run          Print offenders without failing the exit code.
 */

import { readFileSync, readdirSync } from 'node:fs'
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

// Find the index of the `}` matching the `{` at openIdx, skipping strings,
// template literals, and comments. Returns -1 if unbalanced.
function findMatchingBrace(src, openIdx) {
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
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

// Blank out `//` line and `/* */` block comments, preserving every character
// position and newline so downstream index/line math stays valid. Run the
// subclass scan on the stripped text so a `class X extends ClaudeByokSession {`
// written inside a comment is never matched as a real subclass (PR #5925
// review). String literals are left intact — like the repo's other lints, we
// don't strip strings (a class declaration inside a string is not a real case).
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  let inStr = null
  while (i < n) {
    const ch = src[i]
    if (inStr) {
      out += ch
      if (ch === '\\' && i + 1 < n) { out += src[i + 1]; i += 2; continue }
      if (ch === inStr) inStr = null
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; out += ch; i++; continue }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      out += '  '; i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++ }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    out += ch
    i++
  }
  return out
}

function listJsFiles(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dashboard-next') continue
      out.push(...listJsFiles(p))
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      out.push(p)
    }
  }
  return out
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length

// `class X extends ClaudeByokSession {` (named; covers the factory-created
// AnthropicCompatibleSession too, regardless of the enclosing function).
const SUBCLASS_RE = /\bclass\s+([A-Za-z0-9_$]+)\s+extends\s+ClaudeByokSession\s*\{/g
// A direct `static claudeFamily = true|false` member.
const DECLARES_RE = /\bstatic\s+claudeFamily\s*=\s*(?:true|false)\b/

function main() {
  let files
  try {
    files = listJsFiles(SRC_DIR)
  } catch (err) {
    console.error(`lint-claude-family-explicit: cannot read ${SRC_DIR}: ${err.message}`)
    return 2
  }

  const offenders = []
  let subclassCount = 0
  for (const file of files) {
    const raw = readFileSync(file, 'utf8')
    if (!raw.includes('ClaudeByokSession')) continue
    // Scan comment-stripped text (indices preserved) so a subclass declaration
    // inside a comment isn't matched. `static claudeFamily = …` is real code and
    // survives stripping intact.
    const src = stripComments(raw)
    SUBCLASS_RE.lastIndex = 0
    let m
    while ((m = SUBCLASS_RE.exec(src)) !== null) {
      const name = m[1]
      const braceIdx = src.indexOf('{', m.index + m[0].length - 1)
      const end = findMatchingBrace(src, braceIdx)
      if (end === -1) {
        console.error(`lint-claude-family-explicit: unbalanced braces for class ${name} in ${file}`)
        return 2
      }
      subclassCount++
      const body = src.slice(braceIdx, end + 1)
      if (!DECLARES_RE.test(body)) {
        offenders.push({ file, line: lineOf(src, m.index), name })
      }
    }
  }

  if (offenders.length > 0) {
    console.error('ERROR: class(es) extending ClaudeByokSession without an explicit `static claudeFamily`:')
    console.error('')
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  class ${o.name}`)
    }
    console.error('')
    console.error('Claude-family membership must be DECLARED, not inherited. Add')
    console.error('`static claudeFamily = true` (a Claude/Anthropic-key provider) or')
    console.error('`static claudeFamily = false` (a non-Claude provider whose model ids')
    console.error('validate strictly) to each subclass body. See models.js + #5858/#5891.')
    return dryRun ? 0 : 1
  }

  console.log(`OK: ${subclassCount} ClaudeByokSession subclass(es) declare static claudeFamily explicitly.`)
  return 0
}

process.exit(main())
