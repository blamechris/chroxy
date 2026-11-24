/**
 * Stamp an installed daemon package with the commit it was built from.
 *
 * This is the only writer in the runner and it is not part of a tick: an
 * operator runs it once after installing a pinned build. It writes one small
 * file, `build-info.json`, into the package directory it is given, and
 * refuses a directory that is not the installed daemon package or that is a
 * development checkout.
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { BUILD_INFO_FILE, BuildError, DAEMON_PACKAGE_NAME, installKind, isCommit } from './build-info.js'

/**
 * @param {string} packageRoot
 * @param {string} commit
 * @param {{ force?: boolean }} [opts]  replace a different existing stamp
 * @returns {string} the path written
 */
export function stampBuild(packageRoot, commit, { force = false } = {}) {
  if (!isCommit(commit)) throw new BuildError('bad_commit', 'the commit must be a full 40-character lowercase id')
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  } catch {
    throw new BuildError('not_daemon_package', `${packageRoot} has no readable package.json`)
  }
  if (pkg?.name !== DAEMON_PACKAGE_NAME) throw new BuildError('not_daemon_package', `${packageRoot} is not the ${DAEMON_PACKAGE_NAME} package`)
  if (installKind(packageRoot) !== 'pinned') throw new BuildError('development_checkout', 'refusing to stamp a development checkout; stamp the installed copy under node_modules')
  const file = path.join(packageRoot, BUILD_INFO_FILE)
  if (fs.existsSync(file)) {
    let existing = null
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'))?.commit ?? null
    } catch {
      existing = null
    }
    if (existing === commit) return file
    if (!force) throw new BuildError('already_stamped', `${BUILD_INFO_FILE} already holds ${existing === null ? 'an unreadable stamp' : 'a different commit'}; pass --force to replace it`)
  }
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify({ commit }) + '\n', { mode: 0o644, flag: 'wx' })
  fs.renameSync(tmp, file)
  return file
}
