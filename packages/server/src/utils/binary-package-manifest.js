/**
 * Package-tree provenance manifest (#8040).
 *
 * `verify-provenance.js` used to hash exactly one file: the path preflight
 * resolved. For a provider whose resolved path is a script LAUNCHER — npm
 * `codex`'s `bin/codex.js`, which `spawn`s a native binary from a sibling
 * platform package; `gemini`'s `bundle/gemini.js`, which `require`s dozens of
 * sibling chunk files — that one file is not the code that actually runs. A
 * swap of the native binary or a bundle chunk left the pinned hash unchanged
 * and went undetected in `block` mode.
 *
 * **Decided (Chris, 2026-09-28): hash the package tree.** When the resolved
 * path is a launcher, the provenance hash covers a MANIFEST of the whole
 * installed package — the entry, every sibling file (including nested
 * `node_modules`, where npm-global codex's native binary lives), and any
 * hoisted `optionalDependencies` package that installs OUTSIDE the launcher's
 * own package root. A native (non-script) resolution is unaffected — it keeps
 * today's single-file hash, computed by the caller exactly as before.
 *
 * ## Launcher detection
 *
 * A resolved path is a launcher only when BOTH hold:
 *   1. It is a SCRIPT — either a `.js`/`.mjs`/`.cjs` extension, or its first
 *      two bytes are `#!` (a shebang). A native binary's magic bytes (ELF
 *      `\x7fELF`, Mach-O `\xcf\xfa\xed\xfe` / `\xca\xfe\xba\xbe`, PE `MZ`)
 *      never collide with `#!`, so this never misclassifies a native binary.
 *   2. It has an ENCLOSING PACKAGE ROOT — the nearest ancestor directory
 *      whose `package.json` declares a non-empty `name`. Climbing skips a
 *      name-less marker file (e.g. a bare `{"type":"module"}` some build
 *      tooling drops partway up a tree) and a malformed one — neither is a
 *      real package boundary — and keeps climbing past it.
 *
 * A script with no enclosing package root (e.g. a standalone shell wrapper
 * with no package.json anywhere above it) keeps the single-file hash — there
 * is no "whole package" to manifest.
 *
 * ## Manifest shape
 *
 * The package root is resolved to its REALPATH first, then walked
 * recursively, INCLUDING nested `node_modules`. For each entry:
 *   - a regular file is hashed by CONTENT (reusing the caller's injected
 *     hasher — in production, `sha256FileCached`, so an unchanged file is
 *     never re-read, only re-`stat`'d — see #8030);
 *   - a symlink is recorded by its link TEXT and never followed — the walk
 *     never `stat`s or reads through it, so a symlink swap changes the
 *     digest and a symlink pointing OUTSIDE the root cannot pull in
 *     arbitrary bytes from elsewhere on disk;
 *   - a directory is walked, contributing no line of its own — only the
 *     files/symlinks under it do;
 *   - anything else (a FIFO, socket, or device file — never legitimately
 *     present inside an npm package tree) makes the whole manifest
 *     UNREADABLE, the same fail-closed-in-`block`-mode status a cap breach
 *     or an unreadable file gets (see below) — there is no safe way to
 *     characterize its "content".
 *
 * Every (relative path, kind, hash) triple is sorted by POSIX relative path,
 * then folded into one SHA-256 digest over a versioned header plus one
 * `relpath\0kind\0hash\n` line per entry — changing, adding, or removing any
 * file/symlink anywhere in the tree changes the digest.
 *
 * ## Hoisted optional dependencies
 *
 * A non-global (local / nested `node_modules`) install can HOIST a launcher's
 * platform package (codex's `@openai/codex-<platform>`) OUTSIDE the
 * launcher's own package root, same as any other npm dependency hoisting.
 * For each name in the launcher package's `optionalDependencies`, this
 * resolves the installed root the way Node itself would FROM the launcher —
 * `createRequire(launcherPath).resolve('<name>/package.json')` — wrapped,
 * since a missing optional dependency is normal (npm did not install it for
 * this platform/arch). When that root lies OUTSIDE the main package root, its
 * tree is walked too, under a distinct `+optdep/<name>/…` manifest prefix
 * that cannot collide with a real in-root relative path.
 *
 * A regular (non-optional) hoisted `dependencies` package is a DOCUMENTED
 * LIMITATION, not covered here — see `docs/security/spawned-binary-
 * provenance.md`'s "Known limitations".
 *
 * ## Bounds
 *
 * The walk is capped on total dirents visited (`maxFiles`) and total regular-
 * file bytes (`maxBytes`), generous enough to clear gemini's real ~794-file
 * tree comfortably. Exceeding either cap — like any other unreadable tree —
 * is reported as `unreadable` so the caller fails CLOSED in `block` mode
 * rather than silently hashing a truncated, incomplete manifest.
 */
import {
  readFileSync,
  statSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from 'fs'
import { createRequire } from 'module'
import { createHash } from 'crypto'
import { dirname, join, relative, extname, isAbsolute } from 'path'

/** Bumped whenever the manifest's line shape or hashing rule changes. */
export const MANIFEST_FORMAT_VERSION = 'chroxy-binary-manifest-v1'

// Generous defaults: gemini's real installed tree is ~794 files / ~98 MB;
// npm-global codex's nested platform package is 10 files / ~277 MB (the
// native binary dominates). Both clear these caps comfortably. Tests override
// both to exercise the fail-closed path without building a huge fixture.
export const DEFAULT_MANIFEST_MAX_FILES = 20000
export const DEFAULT_MANIFEST_MAX_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB

const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

/**
 * Does `path` begin with a `#!` shebang? Reads only the first two bytes (an
 * open + one positioned read), never the whole file — the entry files this
 * runs against are small, but there is no reason to read more than needed.
 *
 * @param {string} path
 * @param {object} [seams]
 * @param {typeof openSync} [seams.openSync]
 * @param {typeof readSync} [seams.readSync]
 * @param {typeof closeSync} [seams.closeSync]
 * @returns {boolean}
 */
export function hasShebang(path, { openSync: open = openSync, readSync: read = readSync, closeSync: close = closeSync } = {}) {
  let fd
  try {
    fd = open(path, 'r')
    const buf = Buffer.alloc(2)
    const n = read(fd, buf, 0, 2, 0)
    return n === 2 && buf[0] === 0x23 && buf[1] === 0x21
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        close(fd)
      } catch {
        // ignore — best-effort close, nothing left to clean up on failure
      }
    }
  }
}

/**
 * Is `path` a SCRIPT — `.js`/`.mjs`/`.cjs` extension, or a `#!` shebang?
 *
 * @param {string} path
 * @param {object} [seams] — forwarded to {@link hasShebang}
 * @returns {boolean}
 */
export function isScriptFile(path, seams = {}) {
  const ext = extname(path).toLowerCase()
  if (SCRIPT_EXTENSIONS.has(ext)) return true
  return hasShebang(path, seams)
}

/**
 * Find the nearest ancestor directory of `entryPath` whose `package.json`
 * declares a non-empty `name`. Skips a name-less marker file and a malformed
 * one — neither is a real package boundary — and keeps climbing past either.
 *
 * @param {string} entryPath
 * @param {object} [seams]
 * @param {typeof readFileSync} [seams.readFileSync]
 * @param {typeof existsSync} [seams.existsSync]
 * @returns {{ root: string, packageJson: object }|null}
 */
export function findEnclosingPackageRoot(entryPath, { readFileSync: readFile = readFileSync, existsSync: exists = existsSync } = {}) {
  let dir = dirname(entryPath)
  let prev = null
  while (dir !== prev) {
    const pkgPath = join(dir, 'package.json')
    if (exists(pkgPath)) {
      try {
        const pkg = JSON.parse(readFile(pkgPath, 'utf8'))
        if (pkg && typeof pkg.name === 'string' && pkg.name.length > 0) {
          return { root: dir, packageJson: pkg }
        }
        // name-less marker (e.g. `{"type":"module"}`) — not a boundary, keep climbing.
      } catch {
        // malformed JSON — not a boundary either, keep climbing.
      }
    }
    prev = dir
    dir = dirname(dir)
  }
  return null
}

/**
 * Classify a resolved binary path as a launcher (script + enclosing package)
 * or native (everything else, including a script with no enclosing package).
 *
 * @param {string} path
 * @param {object} [seams] — forwarded to {@link isScriptFile} / {@link findEnclosingPackageRoot}
 * @param {typeof realpathSync} [seams.realpathSync]
 * @returns {{ kind: 'native' } | { kind: 'launcher', packageRoot: string, packageJson: object, entryPath: string }}
 */
export function classifyResolvedBinary(path, { realpathSync: realpath = realpathSync, ...seams } = {}) {
  if (typeof path !== 'string' || path.length === 0) return { kind: 'native' }
  // A shebang/extension check reads the file's CONTENT, which a symlinked
  // path already resolves transparently at the OS level — no realpath
  // needed for this half. Package-root detection is different: it climbs
  // ancestor DIRECTORIES of `dirname(path)`, a pure string operation with no
  // syscall of its own, so a path that is itself a symlink (npm's real
  // `/opt/homebrew/bin/codex` -> `../lib/node_modules/@openai/codex/bin/
  // codex.js`) would climb from the SYMLINK's own directory (`/opt/homebrew/
  // bin`) and never reach the real package tree at all. Resolve the
  // realpath FIRST — best-effort; a failure (dangling symlink) falls back
  // to the raw path rather than erroring, matching every other realpath
  // fallback in this module.
  if (!isScriptFile(path, seams)) return { kind: 'native' }
  let realPath = path
  try {
    realPath = realpath(path)
  } catch {
    // fall back to the raw path
  }
  const found = findEnclosingPackageRoot(realPath, seams)
  if (!found) return { kind: 'native' }
  return { kind: 'launcher', packageRoot: found.root, packageJson: found.packageJson, entryPath: realPath }
}

function isPathInside(parent, child) {
  if (parent === child) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * For each name in the launcher package's `optionalDependencies`, resolve its
 * installed package root the way Node itself would resolve it FROM the
 * launcher, and return only the ones that land OUTSIDE the main package
 * root — i.e. hoisted. A missing optional dependency (not installed for this
 * platform/arch) is normal and silently skipped.
 *
 * @param {{ packageRoot: string, packageJson: object, entryPath: string }} launcher
 * @param {object} [seams]
 * @param {(path: string) => NodeJS.Require} [seams.createRequire]
 * @param {typeof realpathSync} [seams.realpathSync]
 * @returns {{ name: string, root: string }[]}
 */
export function resolveHoistedOptionalDependencyRoots(
  { packageRoot, packageJson, entryPath },
  { createRequire: makeRequire = createRequire, realpathSync: realpath = realpathSync } = {},
) {
  const deps = packageJson && typeof packageJson.optionalDependencies === 'object' && packageJson.optionalDependencies !== null
    ? packageJson.optionalDependencies
    : null
  if (!deps) return []
  const names = Object.keys(deps)
  if (names.length === 0) return []

  let req
  try {
    req = makeRequire(entryPath)
  } catch {
    return []
  }

  // Node's own module resolution realpath's what it resolves (unless
  // `--preserve-symlinks`), so `require.resolve()` below can return a path
  // through a DIFFERENT (but equivalent) prefix than `packageRoot` — e.g. on
  // macOS, `/var` is itself a symlink to `/private/var`, and `os.tmpdir()`
  // returns the `/var/...` spelling while `require.resolve` returns the
  // realpath'd `/private/var/...` one. Canonicalize BOTH sides before the
  // inside/outside check, or a purely spelling difference gets misread as
  // "hoisted outside the root". A realpath failure (a dangling symlink, a
  // removed dir) falls back to the raw path rather than erroring — this is
  // a best-effort canonicalization, not a correctness requirement of its own.
  const canon = (p) => {
    try {
      return realpath(p)
    } catch {
      return p
    }
  }
  const canonicalPackageRoot = canon(packageRoot)

  const roots = []
  for (const name of names) {
    let pkgJsonPath
    try {
      pkgJsonPath = req.resolve(`${name}/package.json`)
    } catch {
      continue // not installed for this platform/arch — normal, not an error
    }
    const root = dirname(pkgJsonPath)
    if (!isPathInside(canonicalPackageRoot, canon(root))) {
      roots.push({ name, root })
    }
  }
  return roots
}

/**
 * Walk `packageRoot` (plus any hoisted `extraRoots`, each under its own
 * manifest prefix) and fold every regular file / symlink into one SHA-256
 * digest. See the module docblock for the exact shape and the cap/unreadable
 * semantics.
 *
 * @param {object} opts
 * @param {string} opts.packageRoot
 * @param {{ name: string, root: string }[]} [opts.extraRoots]
 * @param {(path: string, opts: { platform: string }) => string} opts.hashFile — content hasher (e.g. `sha256FileCached`)
 * @param {string} [opts.platform]
 * @param {number} [opts.maxFiles=DEFAULT_MANIFEST_MAX_FILES]
 * @param {number} [opts.maxBytes=DEFAULT_MANIFEST_MAX_BYTES]
 * @param {object} [seams]
 * @param {typeof statSync} [seams.statSync]
 * @param {typeof readdirSync} [seams.readdirSync]
 * @param {typeof readlinkSync} [seams.readlinkSync]
 * @param {typeof realpathSync} [seams.realpathSync]
 * @returns {{ digest: string|null, fileCount: number, totalBytes: number, capped: boolean, unreadable: boolean, error: string|null }}
 */
export function buildPackageTreeManifest(
  {
    packageRoot,
    extraRoots = [],
    hashFile,
    platform = process.platform,
    maxFiles = DEFAULT_MANIFEST_MAX_FILES,
    maxBytes = DEFAULT_MANIFEST_MAX_BYTES,
  },
  {
    statSync: stat = statSync,
    readdirSync: readdir = readdirSync,
    readlinkSync: readlink = readlinkSync,
    realpathSync: realpath = realpathSync,
  } = {},
) {
  const lines = []
  let fileCount = 0
  let totalBytes = 0
  let cappedReason = null
  let unreadableReason = null

  function walk(dirAbs, prefix) {
    if (cappedReason || unreadableReason) return
    let entries
    try {
      entries = readdir(dirAbs, { withFileTypes: true })
    } catch (err) {
      unreadableReason = `could not read directory ${dirAbs} (${(err && err.code) || (err && err.message) || 'error'})`
      return
    }
    for (const entry of entries) {
      if (cappedReason || unreadableReason) return
      fileCount += 1
      if (fileCount > maxFiles) {
        cappedReason = `exceeds the file-count cap (${maxFiles})`
        return
      }
      const fullPath = join(dirAbs, entry.name)
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isSymbolicLink()) {
        let target
        try {
          target = readlink(fullPath)
        } catch (err) {
          unreadableReason = `could not read symlink ${fullPath} (${(err && err.code) || 'error'})`
          return
        }
        const hash = createHash('sha256').update(target).digest('hex')
        lines.push(`${relPath}\0symlink\0${hash}`)
        continue
      }
      if (entry.isDirectory()) {
        walk(fullPath, relPath)
        continue
      }
      if (entry.isFile()) {
        let st
        try {
          st = stat(fullPath)
        } catch (err) {
          unreadableReason = `could not stat ${fullPath} (${(err && err.code) || 'error'})`
          return
        }
        totalBytes += st.size
        if (totalBytes > maxBytes) {
          cappedReason = `exceeds the byte-size cap (${maxBytes})`
          return
        }
        let hash
        try {
          hash = hashFile(fullPath, { platform })
        } catch (err) {
          unreadableReason = `could not hash ${fullPath} (${(err && err.code) || 'error'})`
          return
        }
        lines.push(`${relPath}\0file\0${hash}`)
        continue
      }
      // A FIFO, socket, or device file — never legitimately present inside an
      // npm package tree, and there is no safe way to characterize it.
      unreadableReason = `unsupported file type at ${fullPath}`
    }
  }

  let canonicalRoot
  try {
    canonicalRoot = realpath(packageRoot)
  } catch (err) {
    return {
      digest: null, fileCount: 0, totalBytes: 0, capped: false, unreadable: true,
      error: `could not resolve package root (${(err && err.code) || 'error'})`,
    }
  }
  walk(canonicalRoot, '')

  for (const { name, root } of extraRoots) {
    if (cappedReason || unreadableReason) break
    let canonicalExtra
    try {
      canonicalExtra = realpath(root)
    } catch (err) {
      unreadableReason = `could not resolve optional dependency root "${name}" (${(err && err.code) || 'error'})`
      break
    }
    walk(canonicalExtra, `+optdep/${name}`)
  }

  if (cappedReason) {
    return { digest: null, fileCount, totalBytes, capped: true, unreadable: false, error: cappedReason }
  }
  if (unreadableReason) {
    return { digest: null, fileCount, totalBytes, capped: false, unreadable: true, error: unreadableReason }
  }

  lines.sort()
  const hash = createHash('sha256')
  hash.update(`${MANIFEST_FORMAT_VERSION}\n`)
  for (const line of lines) hash.update(`${line}\n`)
  return { digest: hash.digest('hex'), fileCount, totalBytes, capped: false, unreadable: false, error: null }
}
