// test-fs-sandbox.mjs — the ONE write sandbox both test harnesses install.
//
// #4633: a test that forgets a temp path must fail LOUDLY instead of silently
// clobbering the developer's live `~/.chroxy` / `~/.claude`. Two packages need
// that guard — `packages/server/tests/_setup.mjs` and
// `packages/claude-hooks/tests/_setup.mjs` — and until #7267/#7268 each carried
// its own hand-written patch list. They drifted in BOTH directions: the server
// patched `openSync`/`appendFileSync`/four `promises` methods that claude-hooks
// did not, claude-hooks patched `rmSync`/`unlinkSync` that the server did not,
// and neither patched anything that copies, links, or changes a mode. So there
// is one list, here, imported by both — the same reasoning
// `scripts/lib/entry-point-guard-copies.mjs` records for its own list.
//
// ── #7262: this module MUST NOT ESM-import `node:fs` ────────────────────────
//
// Node builds the `node:fs` synthetic ESM module LAZILY, snapshotting its named
// exports off `module.exports` the first time some ESM module imports it. Every
// `import { … } from 'node:fs'` — named, namespace, or bare side-effect — takes
// that snapshot at LINK time, before any module body runs. A single such import
// anywhere in the graph a `_setup.mjs` pulls in therefore freezes the UNPATCHED
// exports, and every `import { writeFileSync } from 'node:fs'` consumer (45
// modules under `packages/server/src` at the time of writing) bypasses the
// sandbox while it still reports success for CJS and default importers.
//
// That is not hypothetical: `import { mkdtempSync } from 'node:fs'` sat at the
// top of the server's `_setup.mjs` for months and did exactly this.
// `createRequire` reaches the live CJS `module.exports` WITHOUT linking the
// synthetic module, so the snapshot is taken later, already patched.
//
// Because this module is imported BY the setup files, the rule now extends to
// it and to anything it imports. `node:module`, `node:path` and `node:url` are
// safe — importing them does not link `node:fs`'s synthetic module — and the
// structural test walks the whole graph rather than trusting this comment.
import { createRequire } from 'node:module'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/**
 * Every `fs` API that takes a PATH and mutates the filesystem, as one row per
 * operation. Each row expands to up to three real methods — `<base>Sync`,
 * `<base>` (callback form) and `fs.promises.<base>` — so a new operation cannot
 * be added to the sync surface while its promise twin is forgotten, which is
 * how the two sandboxes drifted apart in the first place.
 *
 * `paths` is how many LEADING arguments are paths, and every one of them is
 * checked. For the two-path operations that is deliberate in both directions:
 *
 *   rename(old, new)      moving real state OUT is data loss, same as writing in
 *   cp/copyFile(src,dest) dest CREATES; src reads real user state into a fixture
 *   link(existing, new)   new CREATES; existing is the thing being aliased
 *   symlink(target, path) path CREATES — and a symlink whose TARGET is the real
 *                         tree is a bypass of this very guard, because
 *                         `path.resolve` does not follow links: write through
 *                         the alias and `isProtected` never sees `~/.chroxy`
 *
 * `writeIntentArg` marks an operation whose second argument is an open mode;
 * only write-intent opens are blocked, so tests that legitimately READ the
 * developer's real config (provider detection, for one) keep working.
 */
export const FS_PATH_MUTATORS = [
  { base: 'writeFile', paths: 1 },
  { base: 'appendFile', paths: 1 },
  { base: 'mkdir', paths: 1 },
  { base: 'mkdtemp', paths: 1 },
  { base: 'rm', paths: 1 },
  { base: 'rmdir', paths: 1 },
  { base: 'unlink', paths: 1 },
  { base: 'truncate', paths: 1 },
  { base: 'chmod', paths: 1 },
  { base: 'lchmod', paths: 1 },
  { base: 'chown', paths: 1 },
  { base: 'lchown', paths: 1 },
  { base: 'utimes', paths: 1 },
  { base: 'lutimes', paths: 1 },
  { base: 'rename', paths: 2 },
  { base: 'cp', paths: 2 },
  { base: 'copyFile', paths: 2 },
  { base: 'symlink', paths: 2 },
  { base: 'link', paths: 2 },
  { base: 'open', paths: 1, writeIntentArg: 1 },
]

/**
 * `createWriteStream` has no `Sync`/promise twins, so it does not fit the table
 * above. It is the only member of its shape.
 */
export const FS_STREAM_MUTATORS = [{ name: 'createWriteStream', paths: 1 }]

/**
 * The COMPLEMENT: every remaining function on `node:fs` / `fs.promises`, with
 * the reason it needs no guard.
 *
 * This exists so the guard is a CATEGORY and not a list. `docs/false-safety-guards.md`
 * the "Checked a subset" mode is "a hardcoded list next to a set that grows" — and `fs` grows. A
 * test asserts that GUARDED ∪ EXEMPT covers the live `fs` surface exactly, so a
 * Node upgrade that adds a path-taking mutator turns the suite RED and forces a
 * classification, instead of quietly widening the hole.
 *
 * Two reasons appear repeatedly and both are load-bearing:
 *
 *   'read'  — reads cannot corrupt user state, and tests legitimately read the
 *             developer's real config. Guarding these would break them.
 *   'fd'    — takes a file descriptor, not a path. An fd that can WRITE to a
 *             protected path can only have come from `open`/`openSync`, which
 *             IS guarded for write-intent flags, so the check happens one step
 *             earlier and this surface needs no path check of its own.
 *             Measured, not assumed: on a read-only fd `writeSync` gives EBADF
 *             and `ftruncateSync` gives EINVAL.
 *   'fd-metadata-known-residual'
 *           — the same, EXCEPT that these gate on OWNERSHIP rather than write
 *             access, so they succeed on the read-only fd the guard
 *             deliberately allows. Measured on darwin: `openSync(cred, 'r')`
 *             then `fchmodSync(fd, 0)` changed a real file's mode 600 -> 0, and
 *             `futimesSync` reset its mtime. A path-based guard cannot see this
 *             — by the time the fd exists there is no path to check — so
 *             closing it needs fd bookkeeping in the sandbox. It is named here
 *             rather than hidden under 'fd', because the 'fd' rationale would
 *             otherwise be a guarantee this code does not make. Tracked
 *             separately; no call site in this repo does it.
 */
export const FS_EXEMPTIONS = {
  // Constructors. `createWriteStream` is the documented entry point and is
  // guarded; `new fs.WriteStream(path)` would sidestep it. Measured: zero call
  // sites anywhere in this repo. Named here rather than left silent so the
  // residual is on the record.
  Dir: 'class', Dirent: 'class', Stats: 'class',
  ReadStream: 'class', WriteStream: 'class-known-residual',
  FileReadStream: 'class', FileWriteStream: 'class-known-residual',

  access: 'read', accessSync: 'read',
  exists: 'read', existsSync: 'read',
  glob: 'read', globSync: 'read',
  lstat: 'read', lstatSync: 'read',
  openAsBlob: 'read',
  opendir: 'read', opendirSync: 'read',
  read: 'read', readSync: 'read',
  readFile: 'read', readFileSync: 'read',
  readdir: 'read', readdirSync: 'read',
  readlink: 'read', readlinkSync: 'read',
  readv: 'read', readvSync: 'read',
  realpath: 'read', realpathSync: 'read',
  stat: 'read', statSync: 'read',
  statfs: 'read', statfsSync: 'read',
  watch: 'read', watchFile: 'read', unwatchFile: 'read',
  createReadStream: 'read',

  close: 'fd', closeSync: 'fd',
  fchmod: 'fd-metadata-known-residual', fchmodSync: 'fd-metadata-known-residual',
  fchown: 'fd-metadata-known-residual', fchownSync: 'fd-metadata-known-residual',
  fdatasync: 'fd', fdatasyncSync: 'fd',
  fstat: 'fd', fstatSync: 'fd',
  fsync: 'fd', fsyncSync: 'fd',
  ftruncate: 'fd', ftruncateSync: 'fd',
  futimes: 'fd-metadata-known-residual', futimesSync: 'fd-metadata-known-residual',
  write: 'fd', writeSync: 'fd',
  writev: 'fd', writevSync: 'fd',

  _toUnixTimestamp: 'internal',
}

/** The `fs.promises` complement. Same reasons. */
export const FS_PROMISES_EXEMPTIONS = {
  access: 'read', glob: 'read', lstat: 'read', opendir: 'read',
  readFile: 'read', readdir: 'read', readlink: 'read', realpath: 'read',
  stat: 'read', statfs: 'read', watch: 'read',
}

export const SANDBOX_ERROR_CODE = 'CHROXY_TEST_SANDBOX'

/** Marks a patched function so a test can enumerate what was ACTUALLY installed. */
export const SANDBOX_MARKER = Symbol.for('chroxy.testFsSandbox')

// The write-intent mask, taken from THIS runtime's `fs.constants` rather than
// written down. The literals are not portable and the old ones were Linux's:
// `O_CREAT` is 64 on Linux but 512 on macOS and 256 on Windows, so a hardcoded
// `flags & 64` classified `openSync(p, O_CREAT)` as a READ on every platform
// this repo actually develops on. `O_TRUNC` was not in the mask at all.
// Measured on darwin before the fix: `openSync('<protected>/state.json',
// O_TRUNC)` emptied a real file with the sandbox armed and silent.
const WRITE_INTENT_MASK =
  require('node:fs').constants.O_WRONLY |
  require('node:fs').constants.O_RDWR |
  require('node:fs').constants.O_CREAT |
  require('node:fs').constants.O_TRUNC |
  require('node:fs').constants.O_APPEND

/**
 * `true` when `flags` requests write access. `flags` is a string ('w', 'a',
 * 'r+', 'wx'…) or a number of OR'd O_* constants.
 */
export function isWriteIntent (flags) {
  if (typeof flags === 'string') return /[wa+]/.test(flags)
  if (typeof flags === 'number') return (flags & WRITE_INTENT_MASK) !== 0
  // `undefined` defaults to 'r' — a read, which is allowed by design.
  return false
}

/** Every method name this module would patch, in install order. */
export function guardedMethodNames () {
  const sync = []
  const callback = []
  const promises = []
  for (const { base } of FS_PATH_MUTATORS) {
    sync.push(`${base}Sync`)
    callback.push(base)
    promises.push(base)
  }
  for (const { name } of FS_STREAM_MUTATORS) sync.push(name)
  return { sync, callback, promises }
}

/**
 * Install the sandbox on the live `node:fs` CJS exports object.
 *
 * @param {object} opts
 * @param {string[]} opts.protectedRoots  Absolute dirs; the dir itself and
 *   everything under it is protected.
 * @param {string[]} [opts.protectedFiles] Absolute files protected on their own
 *   (e.g. `~/.claude.json`, which sits NEXT TO the protected dirs).
 * @param {string} [opts.allowEnv] Name of an env var whose value `'1'` disables
 *   the guard for a test that genuinely must write to the real home.
 * @param {(method: string, target: string) => string} [opts.message] Builds the
 *   error message body. The `code` is always `CHROXY_TEST_SANDBOX`.
 * @returns {{installed: string[], skipped: Array<{name: string, reason: string}>, isProtected: Function}}
 */
export function installFsWriteSandbox ({ protectedRoots, protectedFiles = [], allowEnv, message }) {
  const fs = require('node:fs')

  // macOS (APFS/HFS+ by default) and Windows resolve paths case-insensitively,
  // so `~/.Chroxy/session-state.json` addresses the same real file as
  // `~/.chroxy/...` — and a case-sensitive comparison does not match it. Both
  // platforms run this sandbox in CI. Folding case there can only ever produce
  // a false POSITIVE (a loud refusal on a path that differs from the real home
  // by case alone), which is the safe direction for a guard.
  const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32'
  const norm = (p) => (FOLD_CASE ? p.toLowerCase() : p)

  const roots = protectedRoots.map((r) => norm(resolve(r)))
  const files = new Set(protectedFiles.map((f) => norm(resolve(f))))

  function isProtected (rawPath) {
    if (allowEnv && process.env[allowEnv] === '1') return false
    // `createWriteStream(null, { fd })` and `open`'s fd forms pass no path.
    if (rawPath === null || rawPath === undefined) return false
    // Node accepts a bare Uint8Array as a path and it is NOT `instanceof
    // Buffer`, so the old type test let one through unexamined.
    const isPathLike = typeof rawPath === 'string' ||
      rawPath instanceof URL ||
      rawPath instanceof Uint8Array
    // FAIL CLOSED. Returning `false` for a shape we do not recognise is
    // "silently skipped an input" — a guard reporting success over something it
    // declined to look at. A false positive here is a loud test failure with
    // the value in hand; a false negative is #4633.
    if (!isPathLike) return true
    let p
    try {
      // `fileURLToPath` (not `.pathname`) handles the cross-platform quirks:
      // Windows `file:///C:/…` yields `C:\…`, and percent-encoded segments are
      // decoded. `.pathname` would leave a leading slash on Windows and never
      // match an `os.homedir()`-derived path.
      if (rawPath instanceof URL) p = fileURLToPath(rawPath)
      else if (rawPath instanceof Uint8Array) p = Buffer.from(rawPath).toString('utf8')
      else p = rawPath
      p = norm(resolve(p))
    } catch {
      // Undecodable: fail closed for the same reason as above.
      return true
    }
    if (files.has(p)) return true
    for (const root of roots) {
      if (p === root || p.startsWith(root + sep)) return true
    }
    return false
  }

  const body = message || ((method, target) =>
    `[chroxy-test-sandbox] BLOCKED ${method} to real user-state path: ${target}`)

  function makeGuardError (method, target) {
    const err = new Error(body(method, target))
    err.code = SANDBOX_ERROR_CODE
    return err
  }

  // Which of the leading `paths` arguments is protected, rendered for the
  // message. Returns null when none of them is.
  function offender (args, paths) {
    const hits = []
    for (let i = 0; i < paths; i++) if (isProtected(args[i])) hits.push(String(args[i]))
    if (hits.length === 0) return null
    return paths === 1 ? hits[0] : args.slice(0, paths).map(String).join(' -> ')
  }

  const installed = []
  const skipped = []

  function patch (host, name, label, wrap) {
    const original = host[name]
    if (typeof original !== 'function') {
      // `lchmod`/`lchmodSync` exist only on macOS, and `fs.promises` gains
      // methods across Node releases. An absent method is skipped rather than
      // assumed present; the test asserts absence is the ONLY reason.
      skipped.push({ name: label, reason: 'absent' })
      return
    }
    if (original[SANDBOX_MARKER]) {
      skipped.push({ name: label, reason: 'already-guarded' })
      return
    }
    const patched = wrap(original)
    patched[SANDBOX_MARKER] = label
    host[name] = patched
    installed.push(label)
  }

  for (const spec of FS_PATH_MUTATORS) {
    const { base, paths, writeIntentArg } = spec

    const blocked = (args) => {
      if (writeIntentArg !== undefined && !isWriteIntent(args[writeIntentArg])) return null
      return offender(args, paths)
    }

    patch(fs, `${base}Sync`, `${base}Sync`, (orig) => function guardedSync (...args) {
      const hit = blocked(args)
      if (hit !== null) throw makeGuardError(`${base}Sync`, hit)
      return orig.apply(this, args)
    })

    // The CALLBACK form throws SYNCHRONOUSLY rather than handing the error to
    // the callback, and that is deliberate. `fs.unlink(p, () => {})` is a
    // common fire-and-forget idiom; delivering a sandbox breach into a callback
    // that ignores its argument would make the guard silent — the exact failure
    // this file exists to prevent. Node itself throws synchronously from these
    // functions for invalid input, so a sync throw is not a novel contract.
    // Measured: zero callback-form `fs` call sites under `packages/*/src`, so
    // nothing in production code can be surprised by it.
    patch(fs, base, `${base} (callback)`, (orig) => function guardedCallback (...args) {
      const hit = blocked(args)
      if (hit !== null) throw makeGuardError(`${base} (callback)`, hit)
      return orig.apply(this, args)
    })

    if (fs.promises) {
      patch(fs.promises, base, `promises.${base}`, (orig) => function guardedPromise (...args) {
        const hit = blocked(args)
        if (hit !== null) return Promise.reject(makeGuardError(`promises.${base}`, hit))
        return orig.apply(this, args)
      })
    }
  }

  for (const { name, paths } of FS_STREAM_MUTATORS) {
    patch(fs, name, name, (orig) => function guardedStream (...args) {
      const hit = offender(args, paths)
      if (hit !== null) throw makeGuardError(name, hit)
      return orig.apply(this, args)
    })
  }

  return { installed, skipped, isProtected }
}
