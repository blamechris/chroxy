/**
 * The reconciler opens no credential store, holds no secret and makes no
 * network call. Asserted three ways: the source it ships is scanned for
 * imports and names that would do any of those, a full run (ticks, takeover,
 * a failing adapter) is made with every network, process and file entry point
 * trapped, and the configuration carries no secret-shaped field. Each is
 * shown to fail on a mutant that does the forbidden thing.
 */

import { afterEach } from 'node:test'
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
import { FIXTURE_CAPS, MIN, REAL, SRC, T0, cleanupTmp, cleanupVariants, entry, fixtureAdapter, fixtureSession, loadVariant, proves, rig } from './helpers.js'

afterEach(() => cleanupTmp())
process.on('exit', cleanupVariants)

const edit = (file, from, to) => ({ file, from, to })
const FRESHNESS_DIR = path.join(SRC, 'freshness')
const ALLOWED_BUILTINS = new Set(['node:fs', 'node:os', 'node:path', 'node:crypto'])
const FORBIDDEN_WORDS = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|keychain|keytar|libsecret|dpapi|credential|credentials|secret|password|passwd|apikey|api_key|homedir|process\.env)\b/i

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** What a source text imports, and every forbidden name it uses. */
export function scanSource(file, text) {
  const code = stripComments(text)
  const violations = []
  const specs = [...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g), ...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g), ...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g), ...code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  for (const spec of specs) {
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(file), spec)
      const inside = path.dirname(target) === FRESHNESS_DIR
      if (!inside && target !== path.join(SRC, 'declared-status.js')) violations.push(`imports ${spec}`)
    } else if (spec !== '@chroxy/protocol' && !ALLOWED_BUILTINS.has(spec)) {
      violations.push(`imports ${spec}`)
    }
  }
  const word = FORBIDDEN_WORDS.exec(code)
  if (word) violations.push(`uses ${word[0]}`)
  return violations
}

function shippedFiles() {
  return fs.readdirSync(FRESHNESS_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(FRESHNESS_DIR, f))
}

proves(
  'static: nothing shipped under src/freshness imports a network, process or credential module or names one',
  () => {
    const files = shippedFiles()
    assert.ok(files.length >= 10, 'the scan covers the module')
    for (const f of files) assert.deepEqual(scanSource(f, fs.readFileSync(f, 'utf8')), [], path.basename(f))
  },
)

// The scanner itself, shown to fail on each forbidden thing added to a real file.
const INJECTED = {
  'a socket module': "import net from 'node:net'",
  'a dynamic http import': "const h = () => import('node:http')",
  'a package import': "import keytar from 'keytar'",
  'a child process require': "const cp = require('node:child_process')",
  'an import of the session manager': "import { SessionManager } from '../session-manager.js'",
  'an import of a credential store module': "import { read } from '../credential-store.js'",
  'a bare fetch': "const f = () => fetch('http://example.invalid')",
  'an env read': 'const e = process.env.X',
  'a websocket': 'const w = new WebSocket("ws://x")',
  'a home directory': 'const h = os.homedir()',
}
for (const [label, line] of Object.entries(INJECTED)) {
  proves(`static: the scan flags ${label}`, () => {
    const file = path.join(FRESHNESS_DIR, 'core.js')
    const text = fs.readFileSync(file, 'utf8') + '\n' + line + '\n'
    assert.notDeepEqual(scanSource(file, text), [])
  })
}

// ── dynamic ────────────────────────────────────────────────────────────
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
const FS_ENTRY_POINTS = ['openSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'statSync', 'readdirSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'utimesSync', 'existsSync', 'rmSync', 'copyFileSync', 'truncateSync', 'ftruncateSync', 'accessSync', 'lstatSync', 'realpathSync', 'linkSync', 'symlinkSync']
const FS_WRITES = new Set(['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'utimesSync', 'rmSync', 'copyFileSync', 'truncateSync', 'linkSync', 'symlinkSync'])

/** Run `fn` with every outward entry point trapped; returns what it touched. */
function trapped(fn) {
  const hits = []
  const restore = []
  for (const [obj, name] of TRAPPED) {
    const real = obj[name]
    obj[name] = () => {
      hits.push(`${obj === globalThis ? 'global' : obj.constructor?.name ?? 'module'}.${name}`)
      throw new Error(`trapped ${name}`)
    }
    restore.push(() => { obj[name] = real })
  }
  const paths = []
  const writes = []
  for (const name of FS_ENTRY_POINTS) {
    const real = fs[name]
    fs[name] = (...args) => {
      if (typeof args[0] === 'string') {
        paths.push(path.resolve(args[0]))
        if (FS_WRITES.has(name) || (name === 'openSync' && /[wa+]/.test(String(args[1] ?? 'r')))) writes.push(path.resolve(args[0]))
      }
      return real(...args)
    }
    restore.push(() => { fs[name] = real })
  }
  try {
    fn()
  } finally {
    for (const r of restore.reverse()) r()
  }
  return { hits, paths, writes }
}

/** The whole core in one run: state-file ticks, a takeover, a failing adapter, a closed lease. */
function scenario(M) {
  const r = rig(M)
  r.writeState([entry('s1', { state: 'running', next: 'build', updatedAt: T0 - 5 * MIN }), entry('s2', { state: 'blocked', blockedOn: 'x', decision: 'pick', updatedAt: T0 - 2 * 60 * MIN })])
  const out = trapped(() => {
    r.ticks([T0, T0 + 30 * MIN])
    // a crashed holder, then a takeover
    const dead = r.open({ now: T0 + 60 * MIN, pid: 4_000_001, host: 'h' })
    void dead
    const b = r.open({ now: T0 + 61 * MIN, host: 'h', isAlive: (p) => p === process.pid })
    b.tick({ source: 'chroxy-state-file', slotStart: T0 + 60 * MIN, now: T0 + 61 * MIN })
    b.close()
    // an adapter that fails
    const cfg = M.coreConfig({ sources: { fixture: FIXTURE_CAPS } })
    const bad = r.open({ now: T0 + 90 * MIN, adapters: [fixtureAdapter('fixture', { list: [fixtureSession('a')], read: () => { throw new Error('x') } })], config: cfg })
    bad.tick({ source: 'fixture', slotStart: T0 + 90 * MIN, now: T0 + 90 * MIN })
    bad.close()
  })
  return { ...out, root: r.root }
}

proves(
  'dynamic: a full run makes no network call, starts no process and touches only the ledger directory and the state file',
  (M) => {
    const { hits, paths, writes, root } = scenario(M)
    assert.deepEqual(hits, [], 'no network or process entry point was used')
    assert.ok(paths.length > 20, 'the trap saw the run')
    const outside = [...new Set(paths.filter((p) => !(p === root || p.startsWith(root + path.sep))))]
    assert.deepEqual(outside, [], 'every path touched is under the test root, the state file and the ledger directory')
    const home = os.homedir()
    assert.ok(!paths.some((p) => p.startsWith(path.join(home, '.chroxy'))), 'the daemon\'s config directory is never touched')
    const stateWrites = writes.filter((p) => p.endsWith('session-state.json') && p !== path.join(root, 'session-state.json'))
    assert.deepEqual(stateWrites, [])
    assert.ok(!writes.includes(path.join(root, 'session-state.json')), 'the state file is never written')
  },
  {
    'a fetch is made': [edit('core.js', 'const sealed = new Map()', "try { fetch('http://127.0.0.1:9/') } catch {}\n  const sealed = new Map()")],
    'a credential file is read': [edit('file-ledger.js', "fs.mkdirSync(dir, { recursive: true, mode: 0o700 })", "try { fs.readFileSync(path.join(os.homedir(), '.chroxy', 'credentials.json')) } catch {}\n  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })")],
    'a keychain is queried': [
      edit('adapter.js', 'export const ADAPTER_MEMBERS =', "import cp from 'node:child_process'\nexport const ADAPTER_MEMBERS ="),
      edit('adapter.js', 'export function sealAdapter(adapter) {', "export function sealAdapter(adapter) {\n  try { cp.execFileSync('security', ['find-generic-password', '-s', 'x']) } catch {}"),
    ],
    'a socket is opened': [
      edit('adapter.js', 'export const ADAPTER_MEMBERS =', "import net from 'node:net'\nexport const ADAPTER_MEMBERS ="),
      edit('adapter.js', 'export function sealAdapter(adapter) {', "export function sealAdapter(adapter) {\n  try { net.connect(9, '127.0.0.1') } catch {}"),
    ],
    'the state file is written': [edit('state-file-adapter.js', "text = fs.readFileSync(path, 'utf8')", "text = fs.readFileSync(path, 'utf8'); fs.writeFileSync(path, text)")],
  },
)

function keysDeep(v, out = []) {
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k)
      keysDeep(x, out)
    }
  }
  return out
}

proves(
  'secrets: the configuration, and the options the reconciler accepts, name no secret',
  (M) => {
    assert.deepEqual(keysDeep(M.coreConfig()).filter((k) => /secret|token|password|credential|api.?key|auth|bearer|private/i.test(k)), [])
    // a ledger written under every kind of record holds no key of that shape either
    const r = rig(M)
    r.writeState([entry('s1', { state: 'running', updatedAt: T0 - MIN })])
    r.ticks([T0])
    const recordKeys = r.records().flatMap((rec) => keysDeep(rec.body)).filter((k) => /secret|token|password|credential|api.?key|bearer/i.test(k))
    assert.deepEqual(recordKeys, [])
  },
  { 'the configuration carries a key': [edit('config.js', 'owner_name: null,', "owner_name: null,\n  api_key: 'not-a-real-key',")] },
)

void MIN
void REAL
void loadVariant
