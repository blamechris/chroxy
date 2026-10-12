import { constants as fsConstants } from 'fs'
import { homedir } from 'os'
import { join, relative, resolve, sep } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { realpath } from 'fs/promises'
import { openNoFollow } from './ws-file-ops/open-nofollow.js'
import { isPathWithin } from './utils/path-containment.js'
import { resolveTargetComponentwiseAsync } from './utils/componentwise-resolver.js'
import { resolveOpenedFilePath } from './utils/opened-file-path.js'
import { PROJECT_INSTRUCTION_BUDGET_BYTES } from './provider-customization.js'
import {
  CHROXY_INHERITED_SESSION_ENV,
  CHROXY_SECRET_DENYLIST,
  stripInheritedChroxySecrets,
} from './utils/spawn-env.js'
import {
  boundedInstructionIdentity,
  compileInstructionPolicy,
  inspectInstructionSource,
} from './instruction-policy-compiler.js'
export {
  boundedInstructionIdentity,
  compileInstructionPolicy,
  inspectInstructionSource,
  INSTRUCTION_COMPILER_VERSION,
  INSTRUCTION_SEPARATOR,
  REQUIRED_RULE_START,
  REQUIRED_RULE_END,
} from './instruction-policy-compiler.js'

const execFileAsync = promisify(execFile)
const MAX_SOURCE_BYTES = 256 * 1024

function fail(message) {
  throw new Error(`Instruction policy: ${message}`)
}

function sameInstructionPath(left, right) {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

async function verifyOpenedInstructionHandle(handle, {
  instructionRoot,
  expectedPath,
  displayPath,
  resolveOpenedPath,
}) {
  if (!instructionRoot) return
  let openedPath
  try {
    openedPath = await resolveOpenedPath(handle.fd)
  } catch (err) {
    throw new Error(`Instruction source '${displayPath}' opened-file identity cannot be verified: ${err.message}`, { cause: err })
  }
  if (!isPathWithin(openedPath, instructionRoot) || !sameInstructionPath(openedPath, expectedPath)) {
    fail(`source '${displayPath}' opened outside its verified instruction path`)
  }
}

export async function readRegularInstructionFile(path, {
  optional = false,
  tracker,
  displayPath = path,
  maxBytes = MAX_SOURCE_BYTES,
  openFile = openNoFollow,
  instructionRoot,
  expectedPath = path,
  resolveOpenedPath = resolveOpenedFilePath,
} = {}) {
  let handle
  try {
    handle = await openFile(path, fsConstants.O_RDONLY)
  } catch (err) {
    if (optional && err?.code === 'ENOENT') return null
    throw new Error(`Instruction source '${displayPath}' cannot be opened safely: ${err.message}`, { cause: err })
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) fail(`source '${displayPath}' is not a regular file`)
    if (stat.size > maxBytes) fail(`source '${displayPath}' exceeds ${maxBytes} bytes`)
    await verifyOpenedInstructionHandle(handle, {
      instructionRoot, expectedPath, displayPath, resolveOpenedPath,
    })
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    await verifyOpenedInstructionHandle(handle, {
      instructionRoot, expectedPath, displayPath, resolveOpenedPath,
    })
    if (offset > maxBytes) fail(`source '${displayPath}' grew beyond ${maxBytes} bytes while being read`)
    if (offset === 0) fail(`source '${displayPath}' is empty`)
    if (tracker) {
      tracker.count++
      tracker.bytes += offset
      if (tracker.count > 32) fail('discovery exceeds 32 instruction files')
      if (tracker.bytes > PROJECT_INSTRUCTION_BUDGET_BYTES) {
        fail(`discovered instruction files exceed ${PROJECT_INSTRUCTION_BUDGET_BYTES} bytes before compilation`)
      }
    }
    const bytes = buffer.subarray(0, offset)
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { fail(`source '${displayPath}' is not valid UTF-8`) }
  } finally {
    await handle.close()
  }
}

async function refuseUnsupportedFile(path, label, displayPath, readOptions) {
  const text = await readRegularInstructionFile(path, {
    optional: true,
    displayPath,
    ...readOptions,
  })
  if (text !== null) fail(`unsupported ${label} '${displayPath}' must be removed or explicitly supported`)
}

export function buildInstructionGitEnv(parentEnv = process.env) {
  const entries = parentEnv === process.env ? Object.entries(process.env) : Object.entries(parentEnv)
  const secretKeys = new Set(
    [...CHROXY_SECRET_DENYLIST, ...CHROXY_INHERITED_SESSION_ENV].map(key => key.toUpperCase()),
  )
  const env = Object.fromEntries(entries.filter(([key]) => {
    const folded = key.toUpperCase()
    return !folded.startsWith('GIT_') && !secretKeys.has(folded)
  }))
  // Keep the canonical strip on the exact object returned to Git. The
  // case-folded filter above additionally handles Windows aliases.
  stripInheritedChroxySecrets(env)
  return env
}

async function defaultRepoRoot(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', timeout: 5000, env: buildInstructionGitEnv(),
    })
    return stdout.trim()
  } catch (err) {
    if (err?.code === 128 && /not a git repository/i.test(err.stderr || '')) return null
    throw err
  }
}

function directoriesFromRoot(root, cwd) {
  const rel = relative(root, cwd)
  if (rel === '' || rel === '.') return [root]
  if (rel.startsWith(`..${sep}`) || rel === '..') fail(`cwd '${cwd}' is outside repository root`)
  const dirs = [root]
  let cursor = root
  for (const part of rel.split(sep)) { cursor = join(cursor, part); dirs.push(cursor) }
  return dirs
}

async function verifyInstructionCandidate(root, path, displayPath) {
  const relativePath = relative(root, path)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    fail(`source '${displayPath}' escapes its instruction root`)
  }
  const resolvedPath = await resolveTargetComponentwiseAsync(root, relativePath)
  if (!isPathWithin(resolvedPath, root)) fail(`source '${displayPath}' escapes its instruction root`)
  if (resolvedPath !== path) fail(`source '${displayPath}' uses a symlink and is unsupported`)
  return resolvedPath
}

export async function discoverByokInstructionSources({
  cwd,
  machinePath = join(homedir(), '.fleet', 'AGENTS.md'),
  machineRoot = homedir(),
  resolveRepoRoot = defaultRepoRoot,
  openFile = openNoFollow,
  resolveOpenedPath = resolveOpenedFilePath,
} = {}) {
  const cwdReal = await realpath(resolve(cwd || process.cwd()))
  const sources = []
  const tracker = { count: 0, bytes: 0 }
  if (machinePath) {
    const machineRootPath = resolve(machineRoot)
    const machineRootReal = await realpath(machineRootPath)
    const machineRelative = relative(machineRootPath, resolve(machinePath))
    if (machineRelative === '..' || machineRelative.startsWith(`..${sep}`)) {
      fail("source 'machine:fleet' escapes its instruction root")
    }
    const machineCandidate = join(machineRootReal, machineRelative)
    await verifyInstructionCandidate(machineRootReal, machineCandidate, 'machine:fleet')
    const text = await readRegularInstructionFile(machineCandidate, {
      optional: true,
      tracker,
      displayPath: 'machine:fleet',
      instructionRoot: machineRootReal,
      expectedPath: machineCandidate,
      openFile,
      resolveOpenedPath,
    })
    if (text) sources.push({ id: 'machine:fleet', text })
  }
  const discoveredRoot = await resolveRepoRoot(cwdReal)
  const rootReal = discoveredRoot ? await realpath(resolve(discoveredRoot)) : cwdReal
  if (!isPathWithin(cwdReal, rootReal)) fail('working directory is outside the discovered repository root')
  for (const dir of directoriesFromRoot(rootReal, cwdReal)) {
    const override = join(dir, 'AGENTS.override.md')
    const overrideDisplay = relative(rootReal, override) || 'AGENTS.override.md'
    await refuseUnsupportedFile(
      await verifyInstructionCandidate(rootReal, override, overrideDisplay),
      'discovery override',
      overrideDisplay,
      { instructionRoot: rootReal, expectedPath: override, openFile, resolveOpenedPath },
    )
    const codexConfig = join(dir, '.codex', 'config.toml')
    const configDisplay = relative(rootReal, codexConfig).split(sep).join('/')
    await refuseUnsupportedFile(
      await verifyInstructionCandidate(rootReal, codexConfig, configDisplay),
      'discovery config',
      configDisplay,
      { instructionRoot: rootReal, expectedPath: codexConfig, openFile, resolveOpenedPath },
    )
    const path = join(dir, 'AGENTS.md')
    const rel = relative(rootReal, path).split(sep).join('/')
    const candidate = await verifyInstructionCandidate(rootReal, path, rel)
    const text = await readRegularInstructionFile(candidate, {
      optional: true,
      tracker,
      displayPath: rel,
      instructionRoot: rootReal,
      expectedPath: candidate,
      openFile,
      resolveOpenedPath,
    })
    if (text) {
      sources.push({ id: boundedInstructionIdentity('project', rel), text })
    }
  }
  return sources
}

export async function loadByokInstructionPolicy(opts = {}) {
  const sources = await discoverByokInstructionSources(opts)
  if (sources.length === 0) return null
  const inspected = sources.map(inspectInstructionSource)
  const requiredRuleIds = inspected.flatMap((source) => source.requiredRuleIds)
  return compileInstructionPolicy({
    sources,
    targets: [{ id: 'byok-api', budgetBytes: PROJECT_INSTRUCTION_BUDGET_BYTES, requiredRuleIds }],
  })['byok-api']
}
