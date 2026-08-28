#!/usr/bin/env node
/**
 * lint-write-only-ctx-fields.mjs — fail a handler-context field that is WRITTEN
 * but never READ (#7452; the class #7421 named).
 *
 * THE CLASS
 * ---------
 * `packages/app/src/store/message-handler.ts` keeps all resettable
 * per-connection state on one module-level object, `_ctx`. A field there can
 * lose its last reader — a guard is deleted, a branch is simplified, a handler
 * moves to store-core — while every `_ctx.field = ...` assignment survives. The
 * result compiles, type-checks, lints, and passes every test: writing to a
 * field nobody reads is indistinguishable from working code. TypeScript has
 * nothing to say about it either — `noUnusedLocals` does not reach interface
 * members, and the field IS "used", by its own writes.
 *
 * It has now happened twice in a row, in the same file:
 *   - #7421  `isSessionSwitchReplay` — four write sites, zero readers, found
 *            only by a hand archaeology pass across the app store.
 *   - PR #7446, first commit — the FIX for #7421 removed the last reader of
 *            `pendingSwitchSessionId` and left its setter plus three clears
 *            behind. Caught by the review panel on the PR that existed to
 *            remove exactly this shape, and fixed in 052227e36.
 *
 * Two instances, the second created while removing the first, with nothing
 * automated in between. That is what this lint is for.
 *
 * THE HEURISTIC
 * -------------
 * For each field declared on the target interface (and on base interfaces it
 * `extends` that are declared in the same file), every reference of the form
 * `<receiver>.<field>` in the target's non-test sources is classified:
 *
 *   WRITE  the reference is the TARGET of an assignment — `=` (not `==`, `===`
 *          or `=>`), any compound assignment (`+=`, `??=`, `>>>=`, …), a
 *          `++`/`--` in either position, or a `delete`.
 *   READ   anything else — a condition, a right-hand side, a property or method
 *          access through it (`_ctx.set.clear()` must read `_ctx.set` first), a
 *          template interpolation, an argument.
 *
 * A field with at least one WRITE and zero READs FAILS the lint, naming the
 * field and every write site.
 *
 * `++`/`--` counts as a write and NOT as a read, deliberately. A field whose
 * only consumer is its own increment has no reader in any sense that matters.
 *
 * A field with NO reference at all is a WARNING, not a failure — and the
 * distinction is load-bearing rather than squeamish. Zero references is the
 * signature of both "dead field" and "reached some way this regex cannot see",
 * and the live tree contains the second: `rttSmoother` is held on the context
 * so that replacing the context replaces it, while its two consumers close over
 * the LOCAL `const rttSmoother` that `createDefaultContext` built it from.
 * `_ctx.rttSmoother` is never written either, so it is not the #7421 class and
 * failing on it would buy an allowlist entry that suppresses a whole category
 * rather than a case. The warning names the field on every run (as a GitHub
 * `::warning::` annotation) so it stays visible instead of silent.
 *
 * WHAT IT CANNOT SEE — read this before trusting a green run
 * ----------------------------------------------------------
 * The classifier is a regex over comment-stripped source, not a type-aware
 * parse. `scripts/` sits outside every workspace package and installs no
 * dependencies — the Scripts Tests CI job does not run `npm ci` at all — so a
 * real TS parse is not available here. The gaps, stated rather than papered
 * over:
 *
 *   - ALIASING. `const c = _ctx; c.field` is invisible unless `c` is listed in
 *     the target's `receivers`. So are `Object.assign(_ctx, {...})`, a spread
 *     copy, a bracket access `_ctx['field']`, and the closure-capture shape
 *     described above. All of these read as ZERO references, i.e. a warning.
 *   - DESTRUCTURING. `const { field } = _ctx` is a read the classifier does not
 *     count. If a field's ONLY reader destructures, it reads as write-only and
 *     fails — a false positive, resolved by an allowlist entry naming the
 *     destructure site.
 *   - STRINGS. Comments are stripped, so a commented-out reader cannot mask a
 *     write-only field — dead readers are routinely left commented out, which
 *     is the whole point. String and template-literal CONTENT is deliberately
 *     left intact, because `${_ctx.field}` is a genuine read. A field name
 *     inside a quoted string spelled exactly `_ctx.field` would therefore read
 *     as a reference; no such string exists today.
 *   - TEST FILES ARE NOT SCANNED, on either side. A test asserting on a
 *     write-only field would otherwise mask it — which is not hypothetical:
 *     every mock context under `packages/app/src/__tests__/store/` carried
 *     `isSessionSwitchReplay: false` for the whole life of that bug. A field
 *     read only by a test is still write-only in production.
 *   - Multi-line references (`_ctx\n  .field`) and optional chaining
 *     (`_ctx?.field`) ARE handled: each file is matched as one string with
 *     newline-tolerant separators, never line by line. A line-anchored grep
 *     undercounts exactly this shape.
 *
 * ALLOWLIST
 * ---------
 * A field that is genuinely write-only on purpose goes in its target's `allow`
 * map WITH a justification string. An entry with an empty justification is
 * refused, and so is a STALE entry — one naming a field that no longer exists,
 * or one whose field has since gained a reader. An allowlist that cannot expire
 * is a second way to be wrong quietly. There are no entries today.
 *
 * FAIL-LOUD
 * ---------
 * Every "cannot check" is exit 2, never exit 0: a missing declaring file, an
 * interface that is not found (renamed, moved, converted to a type alias), an
 * unterminated interface body, an interface that yields ZERO fields, a scan
 * root with no source files, or a bad allowlist entry. "Could not check" and
 * "nothing to check" must never be the same observable outcome
 * (docs/false-safety-guards.md).
 *
 * Usage:
 *   node scripts/lint-write-only-ctx-fields.mjs [--root <dir>] [--verbose] [--quiet]
 *
 * Exit: 0 clean · 1 a write-only field · 2 cannot check.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isEntryPoint } from './lib/is-entry-point.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The contexts under guard.
 *
 * `receivers` is the set of identifiers a field is reached through. `_ctx` is
 * the module-level singleton; `ctx` is the local name `createDefaultContext`
 * uses for the same object while building it. Both are message-handler-local —
 * `_ctx` appears nowhere else in the app outside two unrelated comments.
 *
 * The dashboard's store keeps its per-connection state in module-level `let`
 * bindings rather than on a context object, so there is no interface for this
 * lint to read fields off. Its equivalent guard is a different shape and is not
 * in scope here.
 */
export const TARGETS = [
  {
    id: 'app/MessageHandlerContext',
    declFile: 'packages/app/src/store/message-handler.ts',
    interfaceName: 'MessageHandlerContext',
    followExtends: true,
    receivers: ['_ctx', 'ctx'],
    scanDirs: ['packages/app/src'],
    // field: 'why it is legitimately write-only'
    allow: {},
  },
]

const SOURCE_EXT = ['.ts', '.tsx']

// A test file's references are excluded from BOTH sides — see the header.
const TEST_PATH = /(^|[/\\])__tests__[/\\]|\.(test|spec)\.[cm]?tsx?$/

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

// A `/` starts a REGEX literal (rather than a division) when the last
// significant character is one of these, or the last identifier was one of the
// keywords below. Getting this wrong is what would blank a live line: a naive
// stripper reads `/a\/\/b/` as a `//` comment and erases the rest of the line.
const REGEX_MAY_FOLLOW = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*',
  '%', '~', '^', '<', '>', '\n',
])
const REGEX_MAY_FOLLOW_WORD = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete',
  'void', 'do', 'else', 'yield', 'await',
])

/**
 * Blank out `//` and block comments, preserving every byte offset and line
 * break so reported line numbers still match the file on disk.
 *
 * Strings, template literals and regex literals are lexed only well enough to
 * avoid mistaking their contents for a comment start; their content is left
 * untouched. `${...}` inside a template literal is treated as string content,
 * so a `//` comment written inside an interpolation is not stripped — an
 * accepted, documented gap.
 */
export function stripComments(text) {
  const out = text.split('')
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n') out[i] = ' '
    }
  }
  let i = 0
  let lastSignificant = '\n'
  let lastWord = ''
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      let j = i + 2
      while (j < text.length && text[j] !== '\n') j++
      blank(i, j)
      i = j
      continue
    }
    if (c === '/' && next === '*') {
      let j = i + 2
      while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++
      j = Math.min(j + 2, text.length)
      blank(i, j)
      i = j
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === c) { j++; break }
        // Review on #7464 (S3): a raw '\'' or '"' span cannot cross a newline
        // in JS/TS. Without this stop, a lone JSX apostrophe opened a blind
        // span that swallowed following lines (live case: CreateSessionModal).
        if (c !== '`' && text[j] === '\n') break
        j++
      }
      i = j
      lastSignificant = c
      lastWord = ''
      continue
    }
    if (c === '/' && (REGEX_MAY_FOLLOW.has(lastSignificant) || REGEX_MAY_FOLLOW_WORD.has(lastWord))) {
      let j = i + 1
      let inClass = false
      while (j < text.length) {
        const d = text[j]
        if (d === '\\') { j += 2; continue }
        if (d === '\n') break
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) { j++; break }
        j++
      }
      i = j
      lastSignificant = '/'
      lastWord = ''
      continue
    }
    if (/\s/.test(c)) {
      // Whitespace does NOT reset `lastWord`: `return /re/` must still see the
      // keyword. It does reset `lastSignificant` on a newline so a regex at the
      // start of a line is recognised.
      if (c === '\n') lastSignificant = '\n'
      i++
      continue
    }
    lastWord = /[A-Za-z_$]/.test(c) || (lastWord !== '' && /[\w$]/.test(c)) ? lastWord + c : ''
    lastSignificant = c
    i++
  }
  return out.join('')
}

// ---------------------------------------------------------------------------
// Interface field extraction
// ---------------------------------------------------------------------------

export class CannotCheckError extends Error {}

function interfaceBody(text, name) {
  const decl = new RegExp(`(?:^|[^\\w$])interface\\s+${name}\\b`, 'm')
  const m = decl.exec(text)
  if (!m) {
    throw new CannotCheckError(
      `interface ${name} not found — renamed, moved, or converted to a type alias? ` +
      'This lint cannot check what it cannot find.',
    )
  }
  const open = text.indexOf('{', m.index + m[0].length)
  if (open === -1) throw new CannotCheckError(`interface ${name}: no opening brace found`)
  const header = text.slice(m.index, open)
  const extendsMatch = /\bextends\s+([^{]+)/.exec(header)
  const bases = extendsMatch
    ? extendsMatch[1].split(',').map((s) => s.trim().replace(/<.*$/, '')).filter(Boolean)
    : []

  let depth = 0
  let close = -1
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) { close = i; break }
    }
  }
  if (close === -1) {
    throw new CannotCheckError(`interface ${name}: unterminated body (unbalanced braces)`)
  }
  return { body: text.slice(open + 1, close), bases }
}

/**
 * Property names declared directly on `name`'s body (depth 0 of that body).
 *
 * Method signatures (`foo(): void`), index signatures and members of nested
 * object types are all skipped: only `name:`/`name?:` at the top level of the
 * body is a state field.
 *
 * @throws {CannotCheckError} if the interface is absent, unterminated, or
 *   yields zero fields.
 */
export function extractInterfaceFields(text, name, { followExtends = false, _seen = new Set(), _top = true } = {}) {
  if (_seen.has(name)) return []
  _seen.add(name)
  const stripped = stripComments(text)
  const { body, bases } = interfaceBody(stripped, name)

  const fields = []
  let depth = 0
  let atMemberStart = true
  const member = /(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/y
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '{' || c === '(' || c === '[') { depth++; atMemberStart = false; continue }
    if (c === '}' || c === ')' || c === ']') { depth--; atMemberStart = false; continue }
    if (depth === 0 && (c === ';' || c === ',' || c === '\n')) { atMemberStart = true; continue }
    if (/\s/.test(c)) continue
    if (depth === 0 && atMemberStart) {
      member.lastIndex = i
      const m = member.exec(body)
      if (m) fields.push(m[1])
    }
    atMemberStart = false
  }

  let all = fields
  if (followExtends) {
    for (const base of bases) {
      // Only a base declared in THIS file can be followed. One imported from
      // another module contributes nothing and is not an error: it is out of
      // this target's scope, not unreadable.
      try {
        all = all.concat(extractInterfaceFields(text, base, { followExtends, _seen, _top: false }))
      } catch (err) {
        if (!(err instanceof CannotCheckError)) throw err
      }
    }
  }
  const unique = [...new Set(all)]
  if (_top && unique.length === 0) {
    throw new CannotCheckError(
      `interface ${name} yielded ZERO fields. Either it is empty or the extractor no ` +
      'longer understands its shape — both are "cannot check", not "clean".',
    )
  }
  return unique
}

// ---------------------------------------------------------------------------
// Reference classification
// ---------------------------------------------------------------------------

const ASSIGN_AHEAD = /^\s*(?:=(?![=>])|\+=|-=|\*\*=|\*=|\/=|%=|<<=|>>>=|>>=|&&=|\|\|=|\?\?=|&=|\|=|\^=)/
const INCDEC_AHEAD = /^\s*(?:\+\+|--)/
const INCDEC_BEHIND = /(?:\+\+|--)\s*$/
const DELETE_BEHIND = /\bdelete\s+$/

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++
  return line
}

/**
 * Classify every `<receiver>.<field>` in one ALREADY comment-stripped source.
 * Returns `{ reads, writes }`, each an array of 1-based line numbers.
 */
export function classifyReferences(strippedText, field, receivers) {
  const recv = receivers.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  // Newline-tolerant on BOTH separators: `_ctx\n  .field` and `_ctx?.\n field`
  // are the same reference as `_ctx.field`. Never match line by line.
  const re = new RegExp(`(?<![\\w$.])(?:${recv})\\s*\\??\\s*\\.\\s*${field}(?![\\w$])`, 'g')
  const reads = []
  const writes = []
  let m
  while ((m = re.exec(strippedText)) !== null) {
    const end = m.index + m[0].length
    // Review on #7464 (C1): an 8-byte lookahead filed a write as a READ when
    // a stripped comment padded the gap before `=` — and one rescued write
    // silences a whole write-only field (demonstrated on the real #7421
    // regression by adding one inline comment). 64 bytes covers any stripped
    // span this repo produces; both windows are pinned by tests.
    const after = strippedText.slice(end, end + 64)
    const before = strippedText.slice(Math.max(0, m.index - 64), m.index)
    const isWrite =
      ASSIGN_AHEAD.test(after) ||
      INCDEC_AHEAD.test(after) ||
      INCDEC_BEHIND.test(before) ||
      DELETE_BEHIND.test(before)
    ;(isWrite ? writes : reads).push(lineOf(strippedText, m.index))
  }
  return { reads, writes }
}

// ---------------------------------------------------------------------------
// Target analysis
// ---------------------------------------------------------------------------

/**
 * Analyse one target from in-memory sources.
 *
 * @param {object} t
 * @param {string} t.declText   source of the file declaring the interface
 * @param {string} t.interfaceName
 * @param {boolean} [t.followExtends]
 * @param {string[]} t.receivers
 * @param {{path: string, text: string}[]} t.sources   non-test sources to scan
 * @param {Record<string,string>} [t.allow]
 * @returns {{fields: string[], perField: Map, failures: string[], warnings: string[], stats: object}}
 * @throws {CannotCheckError}
 */
export function analyzeTarget({ declText, interfaceName, followExtends = false, receivers, sources, allow = {} }) {
  if (!sources || sources.length === 0) {
    throw new CannotCheckError(
      `${interfaceName}: no source files to scan. An empty scan set reports every field clean, ` +
      'which is the one answer a guard must never give.',
    )
  }
  const fields = extractInterfaceFields(declText, interfaceName, { followExtends })
  const stripped = sources.map((s) => ({ path: s.path, text: stripComments(s.text) }))

  const perField = new Map()
  let totalRefs = 0
  for (const field of fields) {
    const reads = []
    const writes = []
    for (const s of stripped) {
      const r = classifyReferences(s.text, field, receivers)
      for (const line of r.reads) reads.push(`${s.path}:${line}`)
      for (const line of r.writes) writes.push(`${s.path}:${line}`)
    }
    totalRefs += reads.length + writes.length
    perField.set(field, { reads, writes })
  }

  // Allowlist hygiene FIRST: a bad entry means the lint's own configuration no
  // longer describes the code, which is a cannot-check rather than a finding.
  for (const [field, why] of Object.entries(allow)) {
    if (!fields.includes(field)) {
      throw new CannotCheckError(
        `allowlist names '${field}', which is not declared on ${interfaceName}. Remove the stale entry.`,
      )
    }
    if (typeof why !== 'string' || why.trim() === '') {
      throw new CannotCheckError(
        `allowlist entry '${field}' has no justification. Every exemption must say why.`,
      )
    }
    const { reads } = perField.get(field)
    if (reads.length > 0) {
      throw new CannotCheckError(
        `allowlist entry '${field}' is stale — the field now has ${reads.length} read(s), ` +
        `first at ${reads[0]}. Remove the exemption.`,
      )
    }
  }

  const failures = []
  const warnings = []
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(allow, field)) continue
    const { reads, writes } = perField.get(field)
    if (reads.length > 0) continue
    if (writes.length > 0) {
      failures.push(
        `${interfaceName}.${field} is WRITE-ONLY: ${writes.length} write site(s), 0 reads.\n` +
        writes.map((w) => `      write: ${w}`).join('\n') +
        '\n      Nothing consumes this field. Delete it and its writes, or add an allowlist ' +
        'entry with a justification.',
      )
    } else {
      warnings.push(
        `${interfaceName}.${field} is UNREFERENCED through ` +
        `${receivers.map((r) => `${r}.`).join(' / ')} — 0 reads, 0 writes. Either dead state, ` +
        'or reached by an alias/closure this lint cannot see. Not a failure (see the header).',
      )
    }
  }

  return {
    fields,
    perField,
    failures,
    warnings,
    stats: {
      fields: fields.length,
      files: sources.length,
      references: totalRefs,
      withReads: fields.filter((f) => perField.get(f).reads.length > 0).length,
      writeOnly: failures.length,
      unreferenced: warnings.length,
      allowlisted: Object.keys(allow).length,
    },
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function listSources(root, dir) {
  const abs = join(root, dir)
  let entries
  try {
    entries = readdirSync(abs, { withFileTypes: true, recursive: true })
  } catch (err) {
    throw new CannotCheckError(`scan dir '${dir}' is unreadable (${err.code || err.message})`)
  }
  const out = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!SOURCE_EXT.some((ext) => e.name.endsWith(ext))) continue
    const full = join(e.parentPath ?? e.path, e.name)
    const rel = relative(root, full).split(sep).join('/')
    if (TEST_PATH.test(rel)) continue
    out.push(rel)
  }
  return out.sort()
}

export function runCli(argv = process.argv.slice(2)) {
  const rootIdx = argv.indexOf('--root')
  const root = rootIdx === -1 ? REPO_ROOT : resolve(argv[rootIdx + 1] ?? '')
  const quiet = argv.includes('--quiet')
  const verbose = argv.includes('--verbose')
  const log = (...a) => { if (!quiet) console.log(...a) }

  let failed = 0
  for (const target of TARGETS) {
    let declText
    try {
      declText = readFileSync(join(root, target.declFile), 'utf8')
    } catch (err) {
      console.error(
        `::error::[write-only-ctx] ${target.id}: cannot read ${target.declFile} ` +
        `(${err.code || err.message}). Moved or renamed? Update TARGETS in ` +
        'scripts/lint-write-only-ctx-fields.mjs.',
      )
      return 2
    }

    let result
    try {
      const paths = target.scanDirs.flatMap((d) => listSources(root, d))
      result = analyzeTarget({
        declText,
        interfaceName: target.interfaceName,
        followExtends: target.followExtends,
        receivers: target.receivers,
        allow: target.allow,
        sources: paths.map((p) => ({ path: p, text: readFileSync(join(root, p), 'utf8') })),
      })
    } catch (err) {
      if (err instanceof CannotCheckError) {
        console.error(`::error::[write-only-ctx] ${target.id}: CANNOT CHECK — ${err.message}`)
        return 2
      }
      throw err
    }

    const { stats, failures, warnings, perField } = result
    log(
      `[write-only-ctx] ${target.id}: ${stats.fields} field(s), ${stats.files} source file(s), ` +
      `${stats.references} reference(s) classified — ${stats.withReads} read, ` +
      `${stats.writeOnly} write-only, ${stats.unreferenced} unreferenced, ` +
      `${stats.allowlisted} allowlisted.`,
    )
    if (verbose) {
      for (const [field, { reads, writes }] of perField) {
        log(`  ${String(reads.length).padStart(3)}r ${String(writes.length).padStart(3)}w  ${field}`)
      }
    }
    for (const w of warnings) console.warn(`::warning::[write-only-ctx] ${target.id}: ${w}`)
    for (const f of failures) {
      failed++
      console.error(`::error::[write-only-ctx] ${target.id}: ${f}`)
    }
  }

  if (failed > 0) {
    console.error(
      `\n[write-only-ctx] FAIL — ${failed} field(s) written but never read. See the header of ` +
      'scripts/lint-write-only-ctx-fields.mjs for the heuristic and its limits.',
    )
    return 1
  }
  log('[write-only-ctx] OK — no context field is written without a reader.')
  return 0
}

if (isEntryPoint(import.meta.url)) {
  process.exit(runCli())
}
