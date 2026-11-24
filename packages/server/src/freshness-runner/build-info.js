/**
 * What build is running, for the freshness runner's tick records.
 *
 * Three facts go into every tick record, all read from disk at run time:
 *   - the commit of the build, from `build-info.json` stamped into the
 *     installed package by `stamp.js` at install time (nothing here asks git);
 *   - the installed daemon package's version, from the package's own
 *     `package.json` (never from a module imported at startup);
 *   - the state file's schema version (`version`), read from the file the
 *     runner is pointed at; null when it cannot be read.
 *
 * A pinned install is a copy of the package under a `node_modules`
 * directory. A development checkout is any other location, and switching
 * branches there changes what runs, so the runner refuses it unless asked.
 */

import fs from 'node:fs'
import path from 'node:path'

export const BUILD_INFO_FILE = 'build-info.json'
// Built from parts: the image smoke script reads any quoted scope-slash string as an import specifier.
export const DAEMON_PACKAGE_NAME = ['@chroxy', 'server'].join('/')
const COMMIT_RE = /^[0-9a-f]{40}$/
const VERSION_RE = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,40})?$/
const MAX_INFO_BYTES = 4096
const MAX_STATE_BYTES = 64 * 1024 * 1024

export class BuildError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BuildError'
    this.code = code
  }
}

/** Is `s` a full 40-character lowercase commit id? */
export function isCommit(s) {
  return typeof s === 'string' && COMMIT_RE.test(s)
}

function readSmallJson(file, what) {
  let text
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_INFO_BYTES) throw new BuildError('build_unreadable', `${what} is not a small regular file`)
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err instanceof BuildError) throw err
    if (err?.code === 'ENOENT') return null
    throw new BuildError('build_unreadable', `${what} cannot be read`)
  }
  try {
    const v = JSON.parse(text)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape')
    return v
  } catch {
    throw new BuildError('build_unreadable', `${what} is not a JSON object`)
  }
}

function hasGitAtOrAbove(dir) {
  for (let cur = dir; ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) return true
    if (path.dirname(cur) === cur) return false
  }
}

/**
 * `pinned` when the real path of the package ends in `node_modules/@chroxy/server`
 * and no `.git` entry exists at or above it; otherwise `checkout`. A workspace
 * link into a checkout resolves out of `node_modules` and so reads `checkout`.
 */
export function installKind(packageRoot) {
  const real = fs.realpathSync(packageRoot)
  const tail = real.split(path.sep).slice(-3)
  if (tail.join('/') !== `node_modules/${DAEMON_PACKAGE_NAME}`) return 'checkout'
  return hasGitAtOrAbove(real) ? 'checkout' : 'pinned'
}

/**
 * Read the build facts of the package at `packageRoot`. Throws `BuildError`
 * unless the build is a stamped pinned install; `allowCheckout` lets an
 * unstamped development checkout through, recorded with `commit: null`.
 *
 * @param {string} packageRoot  the directory holding the daemon package's package.json
 * @param {{ allowCheckout?: boolean }} [opts]
 * @returns {{ install: 'pinned'|'checkout', commit: string|null, daemon_version: string }}
 */
export function readBuild(packageRoot, { allowCheckout = false } = {}) {
  const pkg = readSmallJson(path.join(packageRoot, 'package.json'), 'package.json')
  if (!pkg || pkg.name !== DAEMON_PACKAGE_NAME) throw new BuildError('not_daemon_package', `${packageRoot} is not the ${DAEMON_PACKAGE_NAME} package`)
  if (typeof pkg.version !== 'string' || !VERSION_RE.test(pkg.version)) throw new BuildError('bad_version', 'the installed package has no readable version')
  const install = installKind(packageRoot)
  if (install === 'checkout' && !allowCheckout) {
    throw new BuildError('development_checkout', 'this is a development checkout, whose files change with the branch; run a pinned install (see docs/guides/freshness-runner.md) or pass --allow-dev-checkout')
  }
  const info = readSmallJson(path.join(packageRoot, BUILD_INFO_FILE), BUILD_INFO_FILE)
  let commit = null
  if (info !== null) {
    if (!isCommit(info.commit)) throw new BuildError('bad_stamp', `${BUILD_INFO_FILE} does not carry a full commit id`)
    commit = info.commit
  } else if (install === 'pinned') {
    throw new BuildError('unstamped', `the install carries no ${BUILD_INFO_FILE}; stamp it with "freshness stamp" after installing`)
  }
  return { install, commit, daemon_version: pkg.version }
}

/** The state file's schema version (its `version` integer), or null when it cannot be read. */
export function readStateSchemaVersion(stateFile) {
  try {
    const st = fs.statSync(stateFile)
    if (!st.isFile() || st.size > MAX_STATE_BYTES) return null
    const doc = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    return doc !== null && typeof doc === 'object' && Number.isSafeInteger(doc.version) ? doc.version : null
  } catch {
    return null
  }
}

/** The `build` object a tick record carries. */
export function tickBuild(build, stateSchemaVersion) {
  return { commit: build.commit, state_schema_version: stateSchemaVersion, daemon_version: build.daemon_version, install: build.install }
}
