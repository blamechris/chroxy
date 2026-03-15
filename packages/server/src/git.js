import { resolveBinary } from './utils/resolve-binary.js'

/**
 * Fully-resolved path to the git binary.
 *
 * When the process runs with a minimal PATH (e.g. only the Node bin
 * directory), `execFileSync('git', ...)` fails with ENOENT.  This
 * module resolves the git path once at import time and exports it
 * for all callers that need to spawn git.
 */
export const GIT = resolveBinary('git', [
  '/opt/homebrew/bin/git',  // macOS ARM (Homebrew)
  '/usr/local/bin/git',     // macOS Intel / Linux manual install
  '/usr/bin/git',           // Linux package manager
])
