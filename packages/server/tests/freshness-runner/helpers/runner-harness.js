/**
 * Fixtures, the mutation loader and the outward-call trap for the freshness
 * runner. Everything is invented data in temp directories; no real state file,
 * registry or transcript is read. Registers no tests.
 *
 * A mutant is the real `src` tree with ONE edit applied to a copy, loaded as
 * its own module graph; `mustKillRunner` requires the check to fail it with an
 * assertion (a mutant that merely breaks the module does not count).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import dgram from 'node:dgram'
import childProcess from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { SRC, T0, MIN, tmp, entry } from '../../freshness-core/helpers/harness.js'
import { store, assistant, block, jsonl } from '../../freshness-sources/helpers/transcripts.js'

export { SRC, T0, MIN, tmp }
export const RUNNER_DIR = path.join(SRC, 'freshness-runner')
export const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function repoNodeModules() {
  let dir = SRC
  for (let i = 0; i < 6; i++) {
    const nm = path.join(dir, 'node_modules')
    if (fs.existsSync(path.join(nm, '@chroxy'))) return nm
    dir = path.dirname(dir)
  }
  throw new Error('cannot find the repository node_modules')
}
const NODE_MODULES = repoNodeModules()
const variantDirs = []

async function importRunner(srcRoot) {
  const url = (f) => pathToFileURL(path.join(srcRoot, 'freshness-runner', f)).href
  const core = await import(pathToFileURL(path.join(srcRoot, 'freshness', 'index.js')).href)
  const cmd = await import(pathToFileURL(path.join(srcRoot, 'cli', 'freshness-cmd.js')).href)
  return { SRC_ROOT: srcRoot, ...cmd, ...core, ...(await import(url('build-info.js'))), ...(await import(url('stamp.js'))), ...(await import(url('run-tick.js'))), ...(await import(url('cli.js'))) }
}

export const REAL_RUNNER = await importRunner(SRC)

/** The runner with `edits` applied: [{ file, from, to }], `file` relative to `src/`. */
export async function loadRunnerVariant(edits) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-runner-variant-'))
  variantDirs.push(tmpDir)
  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"type":"module"}')
  fs.cpSync(SRC, path.join(tmpDir, 'src'), { recursive: true })
  fs.symlinkSync(NODE_MODULES, path.join(tmpDir, 'node_modules'), 'junction')
  for (const { file, from, to } of edits) {
    const p = path.join(tmpDir, 'src', file)
    const text = fs.readFileSync(p, 'utf8')
    const n = text.split(from).length - 1
    assert.equal(n, 1, `mutant edit for ${file} must match exactly once, matched ${n}: ${from}`)
    fs.writeFileSync(p, text.replace(from, () => to))
  }
  return importRunner(path.join(tmpDir, 'src'))
}

export async function mustKillRunner(check, label, edits) {
  const M = await loadRunnerVariant(edits)
  await assert.rejects(async () => check(M), (e) => e instanceof assert.AssertionError, `the "${label}" mutant survived`)
}

export function cleanupVariants() {
  for (const d of variantDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
}

/** Run `fn`; a non-assertion error becomes an assertion failure, so a mutant that breaks it is caught cleanly. */
export function must(fn, what = 'the step') {
  try {
    return fn()
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err
    return assert.fail(`${what} threw ${err.name}: ${err.message}`)
  }
}

/**
 * A pinned install: `<root>/node_modules/@chroxy/server` with a package.json
 * and, unless `stamp` is false, a build-info.json. Also a `checkout` directory
 * (no node_modules in its path) holding the same package.
 */
export function install({ version = '0.11.10', stamp = COMMIT, name = '@chroxy/server' } = {}) {
  const root = fs.realpathSync.native(tmp())
  const pkg = path.join(root, 'node_modules', '@chroxy', 'server')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version }))
  if (stamp !== false) fs.writeFileSync(path.join(pkg, 'build-info.json'), JSON.stringify({ commit: stamp }))
  const checkout = path.join(root, 'checkout', 'packages', 'server')
  fs.mkdirSync(checkout, { recursive: true })
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name, version }))
  return { root, pkg, checkout }
}

const DECLARED = { state: 'running', next: 'build the thing', updatedAt: T0 - MIN }

/** A state file, a registry, a transcript store and a ledger directory, all invented. */
export function world({ stateVersion = 1 } = {}) {
  const root = fs.realpathSync.native(tmp())
  const stateDir = path.join(root, 'chroxy-config')
  fs.mkdirSync(stateDir)
  const stateFile = path.join(stateDir, 'session-state.json')
  fs.writeFileSync(stateFile, JSON.stringify({ version: stateVersion, timestamp: T0, sessions: [entry('s1', DECLARED), entry('s2', null)] }))
  const registryDir = path.join(root, 'claude', 'sessions')
  fs.mkdirSync(registryDir, { recursive: true })
  fs.writeFileSync(path.join(registryDir, '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'reg-1', cwd: '/work/project-a', status: 'busy', statusUpdatedAt: T0 - MIN, entrypoint: 'cli', name: 'canary title' }))
  const st = store()
  st.write('t-1', jsonl([assistant(block({ done: 'wrote the thing' }), T0 - 5 * MIN)]))
  return { root, stateDir, stateFile, registryDir, projectsDir: st.projects, ledgerDir: path.join(root, 'ledger'), ledgerFile: path.join(root, 'ledger', 'ledger.jsonl'), now: T0 }
}

export function ledgerRecords(w) {
  return fs.readFileSync(w.ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/** Flags for `main` pointing every source at the world, plus extras. */
export function tickArgs(w, extra = []) {
  return ['tick', '--ledger-dir', w.ledgerDir, '--state-file', w.stateFile, '--registry-dir', w.registryDir, '--projects-dir', w.projectsDir, ...extra]
}

/** Run `main` with its output captured. */
export function runMain(M, argv, { packageRoot, now = T0 } = {}) {
  const out = []
  const err = []
  const code = M.main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), packageRoot, now })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** Every file under `dir` with its bytes, for before/after comparison. */
export function snapshot(dir) {
  const out = {}
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

const TRAPPED = [
  [globalThis, 'fetch'],
  [net.Socket.prototype, 'connect'],
  [net, 'connect'],
  [tls, 'connect'],
  [dns, 'lookup'],
  [http, 'request'],
  [https, 'request'],
  [dgram, 'createSocket'],
  [childProcess, 'spawn'],
  [childProcess, 'spawnSync'],
  [childProcess, 'exec'],
  [childProcess, 'execSync'],
  [childProcess, 'execFile'],
  [childProcess, 'execFileSync'],
  [childProcess, 'fork'],
]
const FS_ENTRY_POINTS = ['openSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'utimesSync', 'rmSync', 'copyFileSync', 'truncateSync', 'ftruncateSync', 'linkSync', 'symlinkSync']
const FS_WRITES = new Set(['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'utimesSync', 'rmSync', 'copyFileSync', 'truncateSync', 'linkSync', 'symlinkSync'])

/**
 * Run `fn` with every network, process and fs-write entry point trapped, and
 * return what it touched: `hits` (network and child-process calls, each of
 * which throws) and `writes` (paths opened for writing or modified, which are
 * allowed through). Entry points reached through the default `fs`, `net`,
 * `http` and `child_process` objects are covered; a named import of one is not.
 */
export function trapped(fn) {
  const hits = []
  const writes = []
  const restore = []
  for (const [obj, name] of TRAPPED) {
    const real = obj[name]
    obj[name] = () => {
      hits.push(`${obj === globalThis ? 'global' : obj.constructor?.name ?? 'module'}.${name}`)
      throw new Error(`trapped ${name}`)
    }
    restore.push(() => {
      obj[name] = real
    })
  }
  for (const name of FS_ENTRY_POINTS) {
    const real = fs[name]
    fs[name] = (...args) => {
      if (typeof args[0] === 'string' && (FS_WRITES.has(name) || (name === 'openSync' && /[wa+]/.test(String(args[1] ?? 'r'))))) writes.push(path.resolve(args[0]))
      return real(...args)
    }
    restore.push(() => {
      fs[name] = real
    })
  }
  try {
    const result = fn()
    return { result, hits, writes }
  } finally {
    for (const r of restore.reverse()) r()
  }
}

/** Set environment variables for `fn`, restoring them after. */
export function withEnv(env, fn) {
  const saved = {}
  for (const k of Object.keys(env)) saved[k] = process.env[k]
  Object.assign(process.env, env)
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
