#!/usr/bin/env node
/**
 * lint-write-only-ctx-fields.mjs — fail per-connection state that is WRITTEN
 * but never READ, whether it lives on a handler context (#7452) or in a
 * module-level binding (#7467). The class is the one #7421 named.
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
 * The DASHBOARD store holds the same per-connection state and is exposed to
 * the same class, without a context object to hang it on: `_store`,
 * `_evaluatorPending`, `_pendingTrustGrants`, `_pendingMcpServerOps` and ~74
 * more are module-level `let`/`const` bindings spread across
 * `packages/dashboard/src/store/` (#7467). A `Map` there that is populated and
 * cleared but never consulted compiles, type-checks and passes every test in
 * exactly the same way. `noUnusedLocals` does not reach it either: the binding
 * IS used, by its own writes.
 *
 * THE HEURISTIC
 * -------------
 * A target declares a ROSTER of names and a REFERENCE SHAPE, then every
 * reference of that shape in the target's non-test sources is classified. Two
 * kinds, sharing one classifier (see TARGETS):
 *
 *   kind 'interface'        roster = the members of a named `interface` (plus
 *                           base interfaces it `extends` in the same file);
 *                           reference = `<receiver>.<field>`.
 *   kind 'module-bindings'  roster = module-level `let`/`const` STATE declared
 *                           in each discovered file; reference = a BARE
 *                           identifier. A `const` bound to a literal, to a
 *                           plain alias or to a function is a constant, not
 *                           state, and is not in the roster.
 *
 * Either way each reference is classified:
 *
 *   WRITE  the reference is the TARGET of an assignment — `=` (not `==`, `===`
 *          or `=>`), any compound assignment (`+=`, `??=`, `>>>=`, …), a
 *          `++`/`--` in either position, or a `delete`.
 *   READ   anything else — a condition, a right-hand side, a property or method
 *          access through it (`_ctx.set.clear()` must read `_ctx.set` first), a
 *          template interpolation, an argument.
 *
 * A name with at least one WRITE and zero READs FAILS the lint, naming it and
 * every write site.
 *
 * `++`/`--` is a write and NOT a read — but only where its value is DISCARDED.
 * `n++;` and `for (;; n++)` consume nothing, so a name whose sole consumer is
 * its own increment still has no reader. `return n++` and `String(++n)` hand
 * the value on and are therefore reads as well. The refinement is not
 * hypothetical: both live shapes exist in the dashboard store
 * (`nextReconnectAttempt`, `requestFileContent`), and without it the lint's
 * first run reported two false positives. It changes nothing for the app
 * target, which has no `++` on a context field at all.
 *
 * A `const` module-level binding cannot be reassigned, so for the
 * module-bindings kind a MUTATOR CALL at statement position — `m.set(k, v);`,
 * `m.clear();`, `arr.push(x);` — is its write. Without that rule every
 * `const _x = new Map()` in the roster would have zero writes by construction
 * and could never reach the failure bucket: a guard reporting clean on state
 * it structurally cannot fail. Statement position is what keeps
 * `if (m.delete(k))` and `const last = arr.pop()` reads.
 *
 * A field with NO reference at all is a WARNING, not a failure — and the
 * distinction is load-bearing rather than squeamish. Zero references is the
 * signature of both "dead field" and "reached some way this regex cannot see",
 * and when this lint landed the tree contained the second: `rttSmoother` was
 * held on the context so that replacing the context replaced it, while its two
 * consumers closed over the LOCAL `const rttSmoother` that
 * `createDefaultContext` built it from. `_ctx.rttSmoother` was never written
 * either, so it was not the #7421 class, and failing on it would have bought an
 * allowlist entry that suppresses a whole category rather than a case. The
 * warning names such a field on every run (as a GitHub `::warning::`
 * annotation) so it stays visible instead of silent.
 *
 * #7468 resolved that one instance the other way — both consumers now read
 * `ctx.rttSmoother` — so the bucket is EMPTY today and a clean run emits no
 * `::warning::` at all. That is the point of the bucket: a standing warning on
 * every green run trains readers to skip warnings, which is precisely the
 * signal a genuinely dead field would have to arrive on. The closure-capture
 * shape stays documented here because the lint still cannot see it, not
 * because an instance of it survives.
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
 *     described above. A FULLY aliased field reads as ZERO references — a
 *     warning; a field with mixed direct and aliased references keeps its
 *     direct classification, which can land in the failure bucket (#7464 N1) —
 *     the safe-direction claim holds only for the all-aliased case.
 *   - DESTRUCTURING. `const { field } = _ctx` is a read the classifier does not
 *     count. If a field's ONLY reader destructures, it reads as write-only and
 *     fails — a false positive, resolved by an allowlist entry naming the
 *     destructure site. The WRITE direction is the unsafe mirror (#7464 S2):
 *     `({ f: _ctx.field } = o)` and `[_ctx.field] = arr` classify as READS, so
 *     a field written only that way is invisibly rescued. No such write exists
 *     in the tree; a real parser is the honest fix.
 *   - SELF-REFERENTIAL RHS (#7464 S1). `_ctx.f = _ctx.f + 1` counts its own
 *     right-hand side as a read, so a field consumed only by its own
 *     read-modify-write never fails — partially negating the `++`-is-not-a-read
 *     rule above. Zero such writes exist in the tree today.
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
 * And for the module-bindings kind specifically:
 *
 *   - SHADOWING. A local, parameter or catch binding sharing a module-level
 *     binding's name reads as a reference to it. That direction is safe (it
 *     rescues rather than accuses) but it is a real gap.
 *   - A PRIVATE binding is scanned in its OWN module only, which is what the
 *     language guarantees and what stops a same-named local in an unrelated
 *     file from rescuing it. An EXPORTED binding is scanned across the whole
 *     target, with `import {…}` / `export {…}` clauses blanked first so a
 *     re-export line cannot count as a reader.
 *   - Two EXPORTED bindings sharing a name is a cannot-check, not a guess: a
 *     bare-identifier scan cannot tell them apart. Two PRIVATE ones are fine
 *     and exist today (`pending`, in two dashboard store modules).
 *   - A destructuring declaration contributes nothing, and only the first
 *     declarator of `let a = 1, b = 2` is seen. Both are missing COVERAGE, not
 *     a false green on something already in the roster.
 *   - A mutator call in a concise arrow body (`() => m.clear()`) is not at
 *     statement position and reads as a READ — safe direction, still a gap.
 *
 * ALLOWLIST
 * ---------
 * A name that is genuinely exempt — write-only on purpose, or referenced only
 * in a way this lint does not scan — goes in its target's `allow` map WITH a
 * justification string. An entry with an empty justification is refused, and so
 * is a STALE entry: one naming something no longer in the roster, or one whose
 * subject has since gained a reader. An allowlist that cannot expire is a
 * second way to be wrong quietly.
 *
 * Keys are the roster key: a bare field name for the interface kind,
 * `<declaring file>::<binding>` for the module-bindings kind (two modules may
 * declare the same private name). The two entries that exist today are the
 * dashboard's `_testQueueInternals` and `_testMessageHandler` — exported
 * surfaces whose only consumers are test files, which are deliberately not
 * scanned.
 *
 * FAIL-LOUD
 * ---------
 * Every "cannot check" is exit 2, never exit 0: a missing declaring file, an
 * interface that is not found (renamed, moved, converted to a type alias), an
 * unterminated interface body, an interface that yields ZERO fields, a
 * module-bindings target that discovers NO declaring file or extracts ZERO
 * bindings, two exported bindings sharing a name, a scan root with no source
 * files, or a bad allowlist entry. "Could not check" and "nothing to check"
 * must never be the same observable outcome (docs/false-safety-guards.md).
 *
 * Usage:
 *   node scripts/lint-write-only-ctx-fields.mjs [--root <dir>] [--verbose] [--quiet]
 *
 * Exit: 0 clean · 1 write-only state · 2 cannot check.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isEntryPoint } from './lib/is-entry-point.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The state under guard.
 *
 * TWO KINDS, ONE CORE. Both read a roster of names out of a declaring file and
 * classify every reference to those names across a scan set, using the SAME
 * comment stripper, the same 64-byte classification windows, the same
 * statement-position rule, the same test-path exclusion, the same allowlist
 * hygiene and the same fail-loud posture. Exactly two things differ, and they
 * are the two things that genuinely differ in the code:
 *
 *   kind: 'interface'        Roster: the members of a named `interface`.
 *                            Reference shape: `<receiver>.<field>`.
 *                            The app store keeps every resettable
 *                            per-connection value on one context object, so
 *                            the interface IS the roster.
 *
 *   kind: 'module-bindings'  Roster: module-level `let`/`const` STATE declared
 *                            in each discovered file.
 *                            Reference shape: a BARE identifier.
 *                            The dashboard store has no context object — the
 *                            same per-connection state lives in module-level
 *                            bindings spread across
 *                            `packages/dashboard/src/store/` (#7467).
 *
 * A second hand-written copy of a classifier is the drift this repo keeps
 * paying for, and this lint exists to catch one flavour of it. So the second
 * detector is a second TARGET KIND inside this file rather than a sibling
 * script: `stripComments`, `atStatementStart`, the assignment/inc-dec
 * predicates, the allowlist hygiene, the failure/warning split, the stats and
 * every exit code are shared verbatim.
 */
export const TARGETS = [
  {
    id: 'app/MessageHandlerContext',
    kind: 'interface',
    declFile: 'packages/app/src/store/message-handler.ts',
    interfaceName: 'MessageHandlerContext',
    followExtends: true,
    receivers: ['_ctx', 'ctx'],
    scanDirs: ['packages/app/src'],
    // field: 'why it is legitimately write-only'
    allow: {},
  },
  {
    id: 'dashboard/store-module-state',
    kind: 'module-bindings',
    // Every non-test source under these directories contributes its
    // module-level state to the roster. A hardcoded LIST of files here would
    // be the "hardcoded list beside a growing set" shape catalogued in
    // docs/false-safety-guards.md — a new store file would be silently out of
    // scope, and the lint would stay green while checking less. Discovery is a
    // directory walk; a walk that finds no file, or a roster that comes out
    // empty, is a cannot-check.
    declDirs: ['packages/dashboard/src/store'],
    scanDirs: ['packages/dashboard/src'],
    // Mutating a `const` container in place is the only WRITE shape a `const`
    // binding has — it can never be reassigned. Without this the whole
    // write-only class would be UNREACHABLE for every `const _x = new Map()`
    // in the roster, and the guard would be inert for two thirds of it while
    // still reporting "clean". See MUTATORS below for the statement-position
    // rule that keeps `if (m.delete(k))` a read.
    mutatorsAreWrites: true,
    // '<declaring file>::<binding>': 'why it is legitimately unreferenced'
    allow: {
      'packages/dashboard/src/store/message-handler.ts::_testQueueInternals':
        'A test-only export. Its only consumers are in ' +
        'packages/dashboard/src/store/store.test.ts, and this lint scans no ' +
        'test file on either side, so it reads as zero references rather than ' +
        'as state. Stale-checked: a production reader refuses the entry.',
      'packages/dashboard/src/store/message-handler.ts::_testMessageHandler':
        'A test-only export — the handler surface re-exported so the dashboard ' +
        'suite can drive it. Same consumers, same reasoning as ' +
        '_testQueueInternals above.',
    },
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

/**
 * Member names whose call MUTATES the receiver in place.
 *
 * Needed only by the module-bindings kind, and there it is load-bearing rather
 * than a nicety: a `const` binding cannot be reassigned, so `m.set(k, v)` is
 * the ONLY write shape `const m = new Map()` has. Without this rule every such
 * binding would have zero writes by construction, could never reach the
 * failure bucket, and the lint would report it clean forever — the "guard that
 * cannot fail" shape from docs/false-safety-guards.md.
 *
 * The return values (`Map.prototype.delete`'s boolean, `push`'s new length,
 * `pop`'s element) are exactly why the statement-position rule below applies:
 * `m.delete(k);` discards it and is a write, `if (m.delete(k))` consumes it and
 * is a read.
 */
const MUTATORS = ['set', 'add', 'clear', 'delete', 'push', 'unshift', 'pop', 'shift', 'splice']
const MUTATOR_AHEAD = new RegExp(`^\\s*\\??\\s*\\.\\s*(?:${MUTATORS.join('|')})\\s*\\(`)

// A statement's left edge: the last significant character before the reference
// closed the previous statement (or there is none). `)` is in the set for
// `if (x) n++;` and `for (;; n++)`. `=`, `>` (an arrow's concise body), `(`,
// `[`, `,` and a word such as `return` are NOT — which is precisely the
// difference between an increment whose value is discarded and one whose value
// is consumed.
const STATEMENT_BOUNDARY = new Set(['', ';', '{', '}', ')'])

/**
 * Does the reference at `index` begin a statement?
 *
 * Scans BACK over whitespace in the full stripped text rather than over a
 * fixed window, because a stripped comment is BLANKED TO SPACES: an inline
 * comment sitting between `n` and its `++` must read the same as `n++;`
 * however long that comment was. An attached prefix
 * `++`/`--` is stepped over, so `++n;` and `n++;` answer alike.
 */
export function atStatementStart(text, index) {
  let i = index - 1
  while (i >= 0 && /\s/.test(text[i])) i--
  if (i >= 1 && ((text[i] === '+' && text[i - 1] === '+') || (text[i] === '-' && text[i - 1] === '-'))) {
    i -= 2
    while (i >= 0 && /\s/.test(text[i])) i--
  }
  return i < 0 || STATEMENT_BOUNDARY.has(text[i])
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++
  return line
}

/**
 * The shared write predicate for one matched reference.
 *
 * `index` is where the reference starts, `end` where it ends, both in the
 * already comment-stripped `text`.
 *
 * Review on #7464 (C1): the lookahead/lookbehind windows are 64 bytes, not 8.
 * Stripping a comment leaves blanks between the reference and its `=`, and an
 * 8-byte window filed such a write as a READ — one rescued write silences a
 * whole write-only field, demonstrated on the real #7421 regression by adding
 * a single inline comment. 64 covers any stripped span this repo produces, and
 * both windows are pinned by tests.
 */
function isWriteAt(text, index, end, { mutatorsAreWrites = false } = {}) {
  const after = text.slice(end, end + 64)
  const before = text.slice(Math.max(0, index - 64), index)
  if (ASSIGN_AHEAD.test(after)) return true
  if (DELETE_BEHIND.test(before)) return true
  // An increment is a write ONLY where its value is discarded. `n++;` and
  // `for (;; n++)` consume nothing; `return n++` and `String(++n)` hand the
  // value on and are therefore reads as well, so they must not be filed as
  // writes. Both live shapes are in the dashboard store today — the rule was
  // written against them, not imagined (#7467).
  if (INCDEC_AHEAD.test(after) || INCDEC_BEHIND.test(before)) {
    return atStatementStart(text, index)
  }
  if (mutatorsAreWrites && MUTATOR_AHEAD.test(after)) return atStatementStart(text, index)
  return false
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
    const isWrite = isWriteAt(strippedText, m.index, end)
    ;(isWrite ? writes : reads).push(lineOf(strippedText, m.index))
  }
  return { reads, writes }
}

/**
 * Classify every BARE-IDENTIFIER reference to a module-level binding in one
 * ALREADY comment-stripped source. Returns `{ reads, writes }` of 1-based line
 * numbers.
 *
 * `skipIndex` is the offset of the binding's own DECLARATION, which is neither
 * a read nor a write — the same treatment the interface kind gives an
 * `interface` member. Counting it as a write would push "declared and never
 * mentioned again" into the failure bucket, where the interface kind puts a
 * never-referenced field into the WARNING bucket; and `noUnusedLocals` already
 * covers a genuinely unused private binding.
 *
 * The `(?<![\w$.])` lookbehind keeps `obj.name` from matching, so a property
 * that happens to share a binding's name is not a reference to it.
 */
export function classifyBindingReferences(strippedText, name, { skipIndex = -1, mutatorsAreWrites = false } = {}) {
  const re = new RegExp(`(?<![\\w$.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g')
  const reads = []
  const writes = []
  let m
  while ((m = re.exec(strippedText)) !== null) {
    if (m.index === skipIndex) continue
    const end = m.index + m[0].length
    const isWrite = isWriteAt(strippedText, m.index, end, { mutatorsAreWrites })
    ;(isWrite ? writes : reads).push(lineOf(strippedText, m.index))
  }
  return { reads, writes }
}

// ---------------------------------------------------------------------------
// Module-level binding extraction
// ---------------------------------------------------------------------------

/**
 * Blank out `import ... from '...'`, bare `import '...'` and `export { ... }`
 * clauses, preserving offsets and line breaks.
 *
 * Only the module-bindings kind needs this, and it needs it for one reason: a
 * bare-identifier classifier counts `export { reconnectAttempt }` and
 * `import { reconnectAttempt } from './message-handler'` as READS, so a single
 * re-export line would rescue a genuinely write-only exported binding without
 * anything consuming it. `export const` / `export let` DECLARATIONS are not
 * touched — the regex requires a `{` immediately after `export`.
 */
export function blankModuleClauses(text) {
  const out = text.split('')
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n') out[i] = ' '
    }
  }
  const patterns = [
    /\bimport\s+(?:type\s+)?[^;]*?\bfrom\s*['"][^'"\n]*['"]/g,
    /\bimport\s*['"][^'"\n]*['"]/g,
    /\bexport\s+(?:type\s+)?\{[^}]*\}(?:\s*from\s*['"][^'"\n]*['"])?/g,
  ]
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) blank(m.index, m.index + m[0].length)
  }
  return out.join('')
}

/**
 * Is this declaration's initializer a CONSTANT rather than state?
 *
 * The roster is module-level STATE. A `const` bound to a literal, to a plain
 * reference (`const HEARTBEAT_INTERVAL_MS = SC_HEARTBEAT_INTERVAL_MS`) or to a
 * function is not state, and including such a binding buys nothing but a
 * standing warning on every green run — which is how a warning bucket stops
 * being read at all (#7523). `let` is always state: it exists to be reassigned.
 */
function isConstantInitializer(init) {
  const t = init.trimStart()
  if (t === '') return false
  if (/^(?:-?\s*\d|0[xXbBoO]|'|"|`|\/|true\b|false\b|null\b|undefined\b)/.test(t)) return true
  if (/^(?:async\s+)?function\b/.test(t)) return true
  if (/^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=>/.test(t)) return true
  // A bare identifier or dotted path that ends the declaration — an alias, not
  // new state. A `(` or `<` after it means a CALL, which is state.
  if (/^[A-Za-z_$][\w$]*(?:\s*\??\s*\.\s*[A-Za-z_$][\w$]*)*\s*(?:;|$)/m.test(t)) return true
  return false
}

/**
 * Module-level `let`/`const` STATE declared in one ALREADY comment-stripped,
 * clause-blanked source.
 *
 * Returns `[{ name, index, exported, keyword }]`, where `index` is the offset
 * of the declared NAME (so the classifier can skip the declaration itself).
 *
 * Only brace-depth 0 counts: a `let` inside a function is a local, and
 * TypeScript's own `noUnusedLocals` already covers it.
 *
 * NOT SEEN, deliberately stated rather than implied:
 *   - a destructuring declaration (`const { a, b } = o`) contributes nothing;
 *   - only the FIRST declarator of `let a = 1, b = 2` is seen;
 *   - `declare`/ambient declarations are treated like any other.
 * Each of those is missing COVERAGE, never a false green on a binding that is
 * in the roster.
 */
export function extractModuleBindings(strippedText) {
  const s = strippedText
  const found = []
  const decl = /(export\s+)?(let|const|var)\s+([A-Za-z_$][\w$]*)/y
  let depth = 0
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '{' || c === '(' || c === '[') { depth++; i++; continue }
    if (c === '}' || c === ')' || c === ']') { depth--; i++; continue }
    if (c === '"' || c === "'" || c === '`') {
      // stripComments leaves string CONTENT intact, so skip the span here too
      // or a `{` inside a string would unbalance the depth counter.
      let j = i + 1
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue }
        if (s[j] === c) { j++; break }
        if (c !== '`' && s[j] === '\n') break
        j++
      }
      i = j
      continue
    }
    if (depth === 0 && /[A-Za-z_$]/.test(c) && !/[\w$.]/.test(s[i - 1] ?? '\n')) {
      decl.lastIndex = i
      const m = decl.exec(s)
      if (m) {
        const name = m[3]
        const nameIndex = m.index + m[0].length - name.length
        // Walk to this declarator's `=` at nesting depth 0 to read its
        // initializer; stop at `;` or a newline if there is none.
        let k = m.index + m[0].length
        let nest = 0
        let init = null
        while (k < s.length) {
          const d = s[k]
          if (d === '(' || d === '[' || d === '{' || d === '<') nest++
          else if (d === ')' || d === ']' || d === '}' || d === '>') nest--
          else if (nest === 0 && d === '=' && s[k + 1] !== '=' && !'=!<>'.includes(s[k - 1])) {
            init = s.slice(k + 1, k + 200)
            break
          } else if (nest === 0 && (d === ';' || d === '\n')) break
          k++
        }
        if (m[2] !== 'const' || (init !== null && !isConstantInitializer(init))) {
          found.push({ name, index: nameIndex, exported: Boolean(m[1]), keyword: m[2] })
        }
        i = m.index + m[0].length
        continue
      }
    }
    i++
  }
  return found
}

// ---------------------------------------------------------------------------
// Target analysis
// ---------------------------------------------------------------------------

/**
 * Allowlist hygiene, the failure/warning split and the stats — shared by both
 * target kinds so there is exactly one place where "written but never read"
 * becomes a failure.
 *
 * `perName` maps a roster KEY to `{reads, writes}`; `subject(key)` renders that
 * key for a human.
 */
function judge({ keys, perName, allow, noun, rosterLabel, subject, unreferencedTail, fileCount }) {
  // Allowlist hygiene FIRST: a bad entry means the lint's own configuration no
  // longer describes the code, which is a cannot-check rather than a finding.
  for (const [key, why] of Object.entries(allow)) {
    if (!keys.includes(key)) {
      throw new CannotCheckError(
        `allowlist names '${key}', which is not declared on ${rosterLabel}. Remove the stale entry.`,
      )
    }
    if (typeof why !== 'string' || why.trim() === '') {
      throw new CannotCheckError(
        `allowlist entry '${key}' has no justification. Every exemption must say why.`,
      )
    }
    const { reads } = perName.get(key)
    if (reads.length > 0) {
      throw new CannotCheckError(
        `allowlist entry '${key}' is stale — the ${noun} now has ${reads.length} read(s), ` +
        `first at ${reads[0]}. Remove the exemption.`,
      )
    }
  }

  const failures = []
  const warnings = []
  let totalRefs = 0
  for (const key of keys) {
    const { reads, writes } = perName.get(key)
    totalRefs += reads.length + writes.length
    if (Object.prototype.hasOwnProperty.call(allow, key)) continue
    if (reads.length > 0) continue
    if (writes.length > 0) {
      failures.push(
        `${subject(key)} is WRITE-ONLY: ${writes.length} write site(s), 0 reads.\n` +
        writes.map((w) => `      write: ${w}`).join('\n') +
        `\n      Nothing consumes this ${noun}. Delete it and its writes, or add an allowlist ` +
        'entry with a justification.',
      )
    } else {
      warnings.push(`${subject(key)} is UNREFERENCED ${unreferencedTail}`)
    }
  }

  return {
    fields: keys,
    perName,
    failures,
    warnings,
    stats: {
      noun,
      fields: keys.length,
      files: fileCount,
      references: totalRefs,
      withReads: keys.filter((k) => perName.get(k).reads.length > 0).length,
      writeOnly: failures.length,
      unreferenced: warnings.length,
      allowlisted: Object.keys(allow).length,
    },
  }
}

/**
 * Analyse one target from in-memory sources.
 *
 * kind 'interface' (the default) takes `{declText, interfaceName, followExtends,
 * receivers, sources, allow}`.
 *
 * kind 'module-bindings' takes `{declSources, sources, mutatorsAreWrites, allow}`,
 * where `declSources` are the files whose module-level state forms the roster
 * and `sources` is the full non-test scan set (which normally CONTAINS them).
 *
 * @returns {{fields: string[], perName: Map, failures: string[], warnings: string[], stats: object}}
 * @throws {CannotCheckError}
 */
export function analyzeTarget(opts) {
  return (opts.kind ?? 'interface') === 'module-bindings'
    ? analyzeModuleBindings(opts)
    : analyzeInterfaceTarget(opts)
}

function analyzeInterfaceTarget({ declText, interfaceName, followExtends = false, receivers, sources, allow = {} }) {
  if (!sources || sources.length === 0) {
    throw new CannotCheckError(
      `${interfaceName}: no source files to scan. An empty scan set reports every field clean, ` +
      'which is the one answer a guard must never give.',
    )
  }
  const fields = extractInterfaceFields(declText, interfaceName, { followExtends })
  const stripped = sources.map((s) => ({ path: s.path, text: stripComments(s.text) }))

  const perName = new Map()
  for (const field of fields) {
    const reads = []
    const writes = []
    for (const s of stripped) {
      const r = classifyReferences(s.text, field, receivers)
      for (const line of r.reads) reads.push(`${s.path}:${line}`)
      for (const line of r.writes) writes.push(`${s.path}:${line}`)
    }
    perName.set(field, { reads, writes })
  }

  return judge({
    keys: fields,
    perName,
    allow,
    noun: 'field',
    rosterLabel: interfaceName,
    subject: (f) => `${interfaceName}.${f}`,
    unreferencedTail:
      `through ${receivers.map((r) => `${r}.`).join(' / ')} — 0 reads, 0 writes. Either dead ` +
      'state, or reached by an alias/closure this lint cannot see. Not a failure (see the header).',
    fileCount: sources.length,
  })
}

function analyzeModuleBindings({ declSources, sources, mutatorsAreWrites = false, allow = {} }) {
  if (!sources || sources.length === 0) {
    throw new CannotCheckError(
      'module bindings: no source files to scan. An empty scan set reports every binding clean, ' +
      'which is the one answer a guard must never give.',
    )
  }
  if (!declSources || declSources.length === 0) {
    throw new CannotCheckError(
      'module bindings: no declaring file was discovered. The roster would be empty and every ' +
      'run green — "cannot check" is not "nothing to check".',
    )
  }

  const prepare = (text) => blankModuleClauses(stripComments(text))
  const byPath = new Map(sources.map((s) => [s.path, prepare(s.text)]))
  const declPrepared = declSources.map((s) => ({
    path: s.path,
    text: byPath.get(s.path) ?? prepare(s.text),
  }))

  // Two decl files may each declare a PRIVATE binding of the same name — the
  // dashboard store has two `const pending = new Map()` today — and that is
  // fine, because a private binding is only ever classified inside its own
  // module. Two EXPORTED bindings sharing a name is not fine: the cross-file
  // bare-identifier scan cannot tell which one an importer meant, and the
  // wrong answer would be a silent rescue. Refuse rather than guess.
  const exportedSeen = new Map()
  const keys = []
  const perName = new Map()
  for (const decl of declPrepared) {
    for (const b of extractModuleBindings(decl.text)) {
      if (b.exported) {
        if (exportedSeen.has(b.name)) {
          throw new CannotCheckError(
            `two files export a module-level binding named '${b.name}' ` +
            `(${exportedSeen.get(b.name)} and ${decl.path}). A bare-identifier scan cannot tell ` +
            'them apart, so neither can be classified honestly.',
          )
        }
        exportedSeen.set(b.name, decl.path)
      }
      const key = `${decl.path}::${b.name}`
      const own = classifyBindingReferences(decl.text, b.name, {
        skipIndex: b.index,
        mutatorsAreWrites,
      })
      const reads = own.reads.map((l) => `${decl.path}:${l}`)
      const writes = own.writes.map((l) => `${decl.path}:${l}`)
      // A binding that is NOT exported cannot be named outside its own module,
      // so its scan set is exactly that module — which also keeps a same-named
      // local in an unrelated file from rescuing it. Only an exported binding
      // is worth scanning the package for.
      if (b.exported) {
        for (const s of sources) {
          if (s.path === decl.path) continue
          const r = classifyBindingReferences(byPath.get(s.path), b.name, { mutatorsAreWrites })
          for (const line of r.reads) reads.push(`${s.path}:${line}`)
          for (const line of r.writes) writes.push(`${s.path}:${line}`)
        }
      }
      keys.push(key)
      perName.set(key, { reads, writes })
    }
  }

  if (keys.length === 0) {
    throw new CannotCheckError(
      `${declSources.length} declaring file(s) yielded ZERO module-level bindings. Either they ` +
      'hold no state any more or the extractor no longer understands their shape — both are ' +
      '"cannot check", not "clean".',
    )
  }

  return judge({
    keys,
    perName,
    allow,
    noun: 'binding',
    rosterLabel: 'any scanned module',
    subject: (k) => k,
    unreferencedTail:
      '— 0 reads, 0 writes. Either dead state, or reached only from a test file, a destructure ' +
      'or an alias this lint cannot see. Not a failure (see the header).',
    fileCount: sources.length,
  })
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
    const kind = target.kind ?? 'interface'
    const readSource = (rel) => ({ path: rel, text: readFileSync(join(root, rel), 'utf8') })

    let declText = null
    if (kind === 'interface') {
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
    }

    let result
    try {
      const paths = target.scanDirs.flatMap((d) => listSources(root, d))
      result = kind === 'module-bindings'
        ? analyzeTarget({
          kind,
          declSources: target.declDirs.flatMap((d) => listSources(root, d)).map(readSource),
          sources: paths.map(readSource),
          mutatorsAreWrites: target.mutatorsAreWrites,
          allow: target.allow,
        })
        : analyzeTarget({
          kind,
          declText,
          interfaceName: target.interfaceName,
          followExtends: target.followExtends,
          receivers: target.receivers,
          allow: target.allow,
          sources: paths.map(readSource),
        })
    } catch (err) {
      if (err instanceof CannotCheckError) {
        console.error(`::error::[write-only-ctx] ${target.id}: CANNOT CHECK — ${err.message}`)
        return 2
      }
      throw err
    }

    const { stats, failures, warnings, perName } = result
    log(
      `[write-only-ctx] ${target.id}: ${stats.fields} ${stats.noun}(s), ${stats.files} source ` +
      `file(s), ${stats.references} reference(s) classified — ${stats.withReads} read, ` +
      `${stats.writeOnly} write-only, ${stats.unreferenced} unreferenced, ` +
      `${stats.allowlisted} allowlisted.`,
    )
    if (verbose) {
      for (const [key, { reads, writes }] of perName) {
        log(`  ${String(reads.length).padStart(3)}r ${String(writes.length).padStart(3)}w  ${key}`)
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
      `\n[write-only-ctx] FAIL — ${failed} field(s)/binding(s) written but never read. See the ` +
      'header of scripts/lint-write-only-ctx-fields.mjs for the heuristic and its limits.',
    )
    return 1
  }
  log('[write-only-ctx] OK — no guarded state is written without a reader.')
  return 0
}

if (isEntryPoint(import.meta.url)) {
  process.exit(runCli())
}
