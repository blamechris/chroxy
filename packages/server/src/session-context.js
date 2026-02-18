import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { basename, join } from 'path'

const TIMEOUT_MS = 3000

/**
 * Read git and project context for a session's working directory.
 * All operations are read-only with short timeouts. Returns partial
 * results on failure (graceful degradation).
 *
 * @param {string} cwd - Working directory to inspect
 * @returns {Promise<{ gitBranch, gitDirty, gitAhead, projectName }>}
 */
export async function readSessionContext(cwd) {
  const [gitBranch, gitDirty, gitAhead, projectName] = await Promise.all([
    gitCommand(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null),
    gitCommand(cwd, ['status', '--porcelain']).then(
      (out) => out.split('\n').filter(Boolean).length,
      () => 0,
    ),
    gitCommand(cwd, ['rev-list', '--count', '@{upstream}..HEAD']).then(
      (out) => parseInt(out, 10) || 0,
      () => 0,
    ),
    readProjectName(cwd),
  ])

  return { gitBranch, gitDirty, gitAhead, projectName }
}

function gitCommand(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout.trim())
    })
  })
}

async function readProjectName(cwd) {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw)
    if (typeof pkg.name === 'string' && pkg.name) return pkg.name
  } catch {}
  return basename(cwd)
}
