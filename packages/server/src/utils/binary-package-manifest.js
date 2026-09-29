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
 * The resolved path is realpath'd FIRST (best-effort) — before either check
 * below runs — because npm's real bin symlink (`/opt/homebrew/bin/codex` ->
 * `../lib/node_modules/@openai/codex/bin/codex.js`) would otherwise be
 * classified by its own (extension-less) name and directory instead of the
 * real script it points to.
 *
 * A resolved path is a launcher only when ALL of these hold, checked against
 * that realpath:
 *   1. It is a SCRIPT — either a `.js`/`.mjs`/`.cjs` extension, or its first
 *      two bytes are `#!` (a shebang). A native binary's magic bytes (ELF
 *      `\x7fELF`, Mach-O `\xcf\xfa\xed\xfe` / `\xca\xfe\xba\xbe`, PE `MZ`)
 *      never collide with `#!`, so this never misclassifies a native binary.
 *   2. It has an ENCLOSING PACKAGE ROOT — the nearest ancestor directory
 *      whose `package.json` declares a non-empty `name` AND whose `bin`
 *      (string or map) or `main` field actually resolves to this entry file
 *      (#8093 review S3). Climbing skips a name-less marker file (e.g. a bare
 *      `{"type":"module"}` some build tooling drops partway up a tree), a
 *      malformed one, and a NAMED one that doesn't claim this entry as its
 *      own — none of those are a real boundary for THIS entry — and keeps
 *      climbing past any of them. Without the bin/main check, any stray
 *      named `package.json` above a shebang script (an accidental `npm init
 *      -y` left in `$HOME`, say) would become the root for an unrelated
 *      script somewhere underneath it, walking the entire home directory on
 *      every cold turn — it still fails CLOSED (the cap, or a permission
 *      error, refuses it), so this isn't a bypass, just a confusing,
 *      avoidable denial of service.
 *
 * A script with no enclosing package root (e.g. a standalone shell wrapper
 * with no package.json anywhere above it, or one whose only named ancestor
 * doesn't claim it via bin/main) keeps the single-file hash — there is no
 * "whole package" to manifest.
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
 * file/symlink anywhere in the tree changes the digest. The header ALSO folds
 * in the entry's own package-root-relative path (#8093 review C4) — without
 * this, the digest covers the tree's CONTENT but not WHICH file is the one
 * actually launched, so retargeting the resolved bin symlink at a DIFFERENT
 * script already inside the same tree (a nested dependency's own CLI, say)
 * would leave the digest unchanged, a strict regression versus the pre-#8040
 * single-file pin (which DID change when the pinned path's target changed).
 *
 * A symlink INSIDE the tree whose target is OUTSIDE it is still only pinned
 * by its link TEXT — the target's bytes are never covered, even though Node
 * (and the OS) follow it at runtime if the launcher ever loads it. This is a
 * known, documented limitation (see `docs/security/spawned-binary-
 * provenance.md`), not a bug: covering it would mean walking arbitrary
 * locations on disk that a package's own tree doesn't own.
 *
 * ## Hoisted optional dependencies
 *
 * A non-global (local / nested `node_modules`) install can HOIST a launcher's
 * platform package (codex's `@openai/codex-<platform>`) OUTSIDE the
 * launcher's own package root, same as any other npm dependency hoisting.
 * For each name in the launcher package's `optionalDependencies`, this
 * resolves the installed root the way Node itself would FROM the launcher —
 * by directory, via `require.resolve.paths(name)` (#8093 review S6 — NOT
 * `require.resolve('<name>/package.json')`, which throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` for a real package whose `exports` map
 * omits `./package.json`, misreading it as "not installed") — since a
 * missing optional dependency is normal (npm did not install it for this
 * platform/arch). When that root lies OUTSIDE the main package root, its
 * tree is walked too, under a manifest prefix (`\0optdep\0<name>/…`) keyed
 * off a NUL byte (#8093 review N1) — a real dirent name can never contain
 * `\0`, so this can never collide with an in-root relative path, unlike the
 * original `+optdep/<name>` spelling, which an in-root directory literally
 * named `+optdep` could reproduce byte-for-byte.
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
import { dirname, join, relative, extname, isAbsolute, sep } from 'path'

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
 * Does `pkg` (a parsed `package.json` at `root`) actually claim `entryPath`
 * as one of its own `bin` targets (string or map) or its `main`? (#8093
 * review S3.) Without this check, ANY named `package.json` anywhere above a
 * shebang script becomes a "package root" — including a stray, accidental
 * one in `$HOME` (an `npm init -y` left behind is common), which would then
 * make a totally unrelated shebang script somewhere underneath it (a pnpm
 * shim under `~/Library/pnpm`, say) resolve to a walk of the entire home
 * directory. That fails closed (the cap, or a permission error, refuses it),
 * so it is not a bypass — but it is a confusing, non-obvious denial of
 * service on every cold turn. Requiring the entry to be a real bin/main
 * target bounds the climb to packages that actually claim to own this file.
 *
 * @param {string} root
 * @param {object} pkg
 * @param {string} entryPath — already realpath'd
 * @param {(p: string) => string} realpath
 * @returns {boolean}
 */
function packageClaimsEntry(root, pkg, entryPath, realpath) {
  const candidates = []
  if (typeof pkg.bin === 'string') {
    candidates.push(pkg.bin)
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const v of Object.values(pkg.bin)) {
      if (typeof v === 'string') candidates.push(v)
    }
  }
  if (typeof pkg.main === 'string') candidates.push(pkg.main)
  if (candidates.length === 0) return false
  for (const rel of candidates) {
    const abs = join(root, rel)
    let resolved = abs
    try {
      resolved = realpath(abs)
    } catch {
      // the candidate might not exist as a real path (e.g. a build step
      // hasn't run yet) — fall back to comparing the raw joined path.
    }
    if (resolved === entryPath || abs === entryPath) return true
  }
  return false
}

/**
 * Find the nearest ancestor directory of `entryPath` whose `package.json`
 * declares a non-empty `name` AND claims `entryPath` as one of its own `bin`
 * targets or its `main` (#8093 review S3 — see {@link packageClaimsEntry}).
 * Skips a name-less marker file, a malformed one, and a named-but-non-
 * claiming one — none of those are a real package boundary for THIS entry —
 * and keeps climbing past any of them.
 *
 * @param {string} entryPath — already realpath'd
 * @param {object} [seams]
 * @param {typeof readFileSync} [seams.readFileSync]
 * @param {typeof existsSync} [seams.existsSync]
 * @param {typeof realpathSync} [seams.realpathSync]
 * @returns {{ root: string, packageJson: object }|null}
 */
export function findEnclosingPackageRoot(
  entryPath,
  { readFileSync: readFile = readFileSync, existsSync: exists = existsSync, realpathSync: realpath = realpathSync } = {},
) {
  let dir = dirname(entryPath)
  let prev = null
  while (dir !== prev) {
    const pkgPath = join(dir, 'package.json')
    if (exists(pkgPath)) {
      try {
        const pkg = JSON.parse(readFile(pkgPath, 'utf8'))
        if (pkg && typeof pkg.name === 'string' && pkg.name.length > 0 && packageClaimsEntry(dir, pkg, entryPath, realpath)) {
          return { root: dir, packageJson: pkg }
        }
        // name-less marker (e.g. `{"type":"module"}`), or a named package
        // that doesn't claim this entry as its own bin/main — neither is a
        // boundary for THIS entry — keep climbing.
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
  // Resolve the realpath FIRST, before either check — best-effort; a failure
  // (dangling symlink) falls back to the raw path rather than erroring,
  // matching every other realpath fallback in this module. Package-root
  // detection NEEDS this: it climbs ancestor DIRECTORIES of `dirname(path)`,
  // a pure string operation with no syscall of its own, so a path that is
  // itself a symlink (npm's real `/opt/homebrew/bin/codex` ->
  // `../lib/node_modules/@openai/codex/bin/codex.js`) would climb from the
  // SYMLINK's own directory (`/opt/homebrew/bin`) and never reach the real
  // package tree at all. #8093 review N3: the extension half of the script
  // check must also run on the REALPATH, not the original — a bin symlink
  // with no extension of its own (e.g. a bare `codex` link, as opposed to
  // one npm happens to name `codex.js`) would otherwise be classified by its
  // own (possibly extension-less) name instead of the real script it points
  // to. The shebang half doesn't strictly need this (reading FILE CONTENT
  // through a symlink already resolves transparently at the OS level), but
  // running both checks on the same, already-resolved path is simpler than
  // splitting them.
  let realPath = path
  try {
    realPath = realpath(path)
  } catch {
    // fall back to the raw path
  }
  if (!isScriptFile(realPath, seams)) return { kind: 'native' }
  const found = findEnclosingPackageRoot(realPath, { ...seams, realpathSync: realpath })
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
 * @param {typeof existsSync} [seams.existsSync]
 * @returns {{ name: string, root: string }[]}
 */
export function resolveHoistedOptionalDependencyRoots(
  { packageRoot, packageJson, entryPath },
  { createRequire: makeRequire = createRequire, realpathSync: realpath = realpathSync, existsSync: seamsExists = existsSync } = {},
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
    const root = resolvePackageDirectory(req, name, { existsSync: seamsExists })
    if (root === null) continue // not installed for this platform/arch — normal, not an error
    if (!isPathInside(canonicalPackageRoot, canon(root))) {
      roots.push({ name, root })
    }
  }
  return roots
}

/**
 * Locate an installed package's ROOT DIRECTORY by name, the way Node itself
 * would resolve it from `req`'s module, without going through the package's
 * `exports` map (#8093 review S6). `req.resolve('<name>/package.json')`
 * throws `ERR_PACKAGE_PATH_NOT_EXPORTED` for a package whose `exports` map
 * omits `./package.json` — real, published packages do this — which reads
 * exactly like "not installed" and silently skips a hoisted dependency that
 * `require(name)` would happily find. `require.resolve.paths(name)` returns
 * the ordered list of `node_modules` directories Node would search for
 * `name` (the same list used internally, unaffected by `exports`), so the
 * first `<dir>/<name>/package.json` that actually EXISTS on disk is the
 * package root, however unusual its `exports` map is.
 *
 * @param {NodeJS.Require} req
 * @param {string} name
 * @param {object} [seams]
 * @param {typeof existsSync} [seams.existsSync]
 * @returns {string|null} the package's root directory, or null if not found
 */
function resolvePackageDirectory(req, name, { existsSync: exists = existsSync } = {}) {
  let searchPaths
  try {
    searchPaths = req.resolve.paths(name)
  } catch {
    return null
  }
  if (!Array.isArray(searchPaths)) return null
  for (const dir of searchPaths) {
    const candidateRoot = join(dir, name)
    if (exists(join(candidateRoot, 'package.json'))) {
      return candidateRoot
    }
  }
  return null
}

/**
 * Walk `packageRoot` (plus any hoisted `extraRoots`, each under its own
 * manifest prefix) and fold every regular file / symlink into one SHA-256
 * digest. See the module docblock for the exact shape and the cap/unreadable
 * semantics.
 *
 * @param {object} opts
 * @param {string} opts.packageRoot
 * @param {string} [opts.entryPath] — the launcher's own entry file (#8093
 *   review C4). When given, its package-root-relative POSIX path is folded
 *   into the digest header — otherwise retargeting the resolved bin symlink
 *   at a DIFFERENT script already inside the same tree (a nested
 *   dependency's own CLI, say) would leave the digest unchanged: the
 *   manifest covers the tree's CONTENT, not which file is the one actually
 *   launched. Omitted only by tests that don't care which file is "the
 *   entry" — every production caller (`verify-provenance.js`) always
 *   supplies it, since `classifyResolvedBinary` always returns one for a
 *   `kind: 'launcher'` result.
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
    entryPath = null,
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
    // #8093 review N1: prefix with a NUL byte, not a leading `+` — a real
    // dirent name can never contain `\0` (it's a hard OS-level guarantee on
    // every platform this runs on), so this prefix can never collide with an
    // in-root relative path no matter what an attacker names a directory.
    // The old `+optdep/<name>` prefix was merely conventionally unlikely: an
    // in-root directory literally named `+optdep` produced an IDENTICAL
    // digest to an extra root of the same name/content.
    walk(canonicalExtra, `\0optdep\0${name}`)
  }

  if (cappedReason) {
    return { digest: null, fileCount, totalBytes, capped: true, unreadable: false, error: cappedReason }
  }
  if (unreadableReason) {
    return { digest: null, fileCount, totalBytes, capped: false, unreadable: true, error: unreadableReason }
  }

  lines.sort()
  // #8093 review C4: bind WHICH file is the entry into the digest, not just
  // the tree's content — see the `entryPath` param doc above. `entryRelPath`
  // is empty when no `entryPath` was given (test-only), which still folds a
  // well-formed, deterministic (if unbound) header line.
  let entryRelPath = ''
  if (entryPath) {
    let canonicalEntry = entryPath
    try {
      canonicalEntry = realpath(entryPath)
    } catch {
      // fall back to the raw path — still folded into the header either way
    }
    entryRelPath = relative(canonicalRoot, canonicalEntry).split(sep).join('/')
  }
  const hash = createHash('sha256')
  hash.update(`${MANIFEST_FORMAT_VERSION}\0entry\0${entryRelPath}\n`)
  for (const line of lines) hash.update(`${line}\n`)
  return { digest: hash.digest('hex'), fileCount, totalBytes, capped: false, unreadable: false, error: null }
}
