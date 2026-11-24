/**
 * Fixtures and the mutation harness for the freshness reconciler core.
 *
 * A mutant is the real source with ONE edit applied to a copy of
 * src/freshness, loaded as its own module graph. `proves` runs a check against
 * the real modules (it must pass) and against each mutant (it must fail with
 * an assertion, not with some other error, so a mutant that merely breaks the
 * module cannot pass as "caught"). Every edit's `from` text must occur
 * exactly once, so a mutant that no longer applies is itself a failure.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SRC = path.resolve(import.meta.dirname, '../../../src')
export const T0 = Date.parse('2026-01-05T00:00:00.000Z')
export const MIN = 60_000
export const HOUR = 60 * MIN
export const STATE_SOURCE = 'chroxy-state-file'

export const REAL = await import(pathToFileURL(path.join(SRC, 'freshness/index.js')).href)

/** The real core and the real transcript sources, merged, as `loadTreeVariant` returns for no edits. */
export const REAL_TREE = { ...REAL, ...(await import(pathToFileURL(path.join(SRC, 'freshness-sources/index.js')).href)) }

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

/** Load src/freshness with `edits` applied: [{ file, from, to }]. */
export async function loadVariant(edits) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-variant-'))
  variantDirs.push(tmp)
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}')
  fs.cpSync(path.join(SRC, 'freshness'), path.join(tmp, 'src/freshness'), { recursive: true })
  fs.copyFileSync(path.join(SRC, 'declared-status.js'), path.join(tmp, 'src/declared-status.js'))
  fs.symlinkSync(NODE_MODULES, path.join(tmp, 'node_modules'))
  for (const { file, from, to } of edits) {
    const p = path.join(tmp, 'src/freshness', file)
    const text = fs.readFileSync(p, 'utf8')
    const n = text.split(from).length - 1
    assert.equal(n, 1, `mutant edit for ${file} must match exactly once, matched ${n}: ${from}`)
    fs.writeFileSync(p, text.replace(from, () => to))
  }
  return import(pathToFileURL(path.join(tmp, 'src/freshness/index.js')).href)
}

/**
 * Load the freshness core and the transcript sources with `edits` applied:
 * [{ file, from, to }], `file` relative to `src/`. The whole `src` tree is
 * copied, because the sources import the daemon's transcript locator. Returns
 * both public surfaces merged.
 */
export async function loadTreeVariant(edits) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-variant-'))
  variantDirs.push(tmp)
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}')
  fs.cpSync(SRC, path.join(tmp, 'src'), { recursive: true })
  fs.symlinkSync(NODE_MODULES, path.join(tmp, 'node_modules'))
  for (const { file, from, to } of edits) {
    const p = path.join(tmp, 'src', file)
    const text = fs.readFileSync(p, 'utf8')
    const n = text.split(from).length - 1
    assert.equal(n, 1, `mutant edit for ${file} must match exactly once, matched ${n}: ${from}`)
    fs.writeFileSync(p, text.replace(from, () => to))
  }
  const core = await import(pathToFileURL(path.join(tmp, 'src/freshness/index.js')).href)
  const sources = await import(pathToFileURL(path.join(tmp, 'src/freshness-sources/index.js')).href)
  return { ...core, ...sources }
}

export async function mustKillTree(check, label, edits) {
  const M = await loadTreeVariant(edits)
  await assert.rejects(async () => check(M), isAssertion, `the "${label}" mutant survived`)
}

export function cleanupVariants() {
  for (const d of variantDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
}

const isAssertion = (e) => e instanceof assert.AssertionError

/**
 * Prove that `check` fails on a mutant. The check runs against the variant
 * built from `edits`; it must reject with an assertion, so a mutant that merely
 * breaks the module cannot pass as "caught". Registers nothing: each
 * `*.test.js` file calls describe/it itself (see `proves` there), so the
 * Windows runner's derived file set is the test files alone.
 */
export async function mustKill(check, label, edits) {
  const M = await loadVariant(edits)
  await assert.rejects(async () => check(M), isAssertion, `the "${label}" mutant survived`)
}

const tmpDirs = []
export function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-test-'))
  tmpDirs.push(d)
  return d
}
export function cleanupTmp() {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
}

/** One persisted-session entry as the daemon writes it, plus content the reconciler must never read. */
export function entry(id, declared, extra = {}) {
  return { id, name: 'session name', cwd: '/work/dir', sdkSessionId: null, conversationId: null, ...extra, ...(declared ? { declaredStatus: { summary: 'a summary', source: 'marker', ...declared } } : {}) }
}

/** A rig: a state file, a ledger directory and a way to open a reconciler over them. */
export function rig(M) {
  const root = tmp()
  const stateFile = path.join(root, 'session-state.json')
  const ledgerDir = path.join(root, 'ledger')
  const r = {
    root,
    stateFile,
    ledgerDir,
    ledgerFile: path.join(ledgerDir, 'ledger.jsonl'),
    writeState(sessions, extra = {}) {
      fs.writeFileSync(stateFile, JSON.stringify({ version: 1, timestamp: T0, sessions, ...extra }))
    },
    writeRaw(text) {
      fs.writeFileSync(stateFile, text)
    },
    config: (o) => M.coreConfig(o),
    open({ now = T0, adapters, config, ...rest } = {}) {
      return M.openReconciler({ dir: ledgerDir, ledgerId: 'ledger-test', config: config ?? M.coreConfig(), adapters: adapters ?? [M.createStateFileAdapter({ path: stateFile })], now, ...rest })
    },
    /** Open, run ticks at the given times, close. Returns the last tick result. */
    ticks(times, opts = {}) {
      let rec
      let last
      try {
        rec = r.open({ now: times[0], ...opts })
        for (const at of times) last = rec.tick({ source: opts.source ?? STATE_SOURCE, slotStart: at, now: at })
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err
        assert.fail(`a tick threw ${err.name}: ${err.message}`)
      } finally {
        rec?.close()
      }
      return last
    },
    records() {
      if (!fs.existsSync(r.ledgerFile)) return []
      return fs.readFileSync(r.ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    },
    kinds(kind, filter = () => true) {
      return r.records().filter((x) => x.kind === kind && filter(x))
    },
  }
  return r
}

/** A non-state-file adapter whose answers a test sets. */
export function fixtureAdapter(source, answer) {
  return { source, list: () => answer.list ?? null, read: (session, now) => (typeof answer.read === 'function' ? answer.read(session, now) : answer.read) }
}

export const FIXTURE_CAPS = Object.freeze({ native_in_read: true, activity_read: false, scope: false, can_confirm_gone: true, report_time_basis: 'authored_at' })

export function fixtureSession(id, source = 'fixture') {
  return { session: { source, native_id: id, incarnation: null }, scope: null }
}

/** Run `fn`; anything it throws that is not an assertion becomes one, so a mutant that breaks it is caught cleanly. */
export function must(fn, what = 'the step') {
  try {
    return fn()
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err
    return assert.fail(`${what} threw ${err.name}: ${err.message}`)
  }
}


/**
 * A rig with an exchange directory: the owner queue runs and its shows go to
 * an outbox file. `tick` opens a reconciler, runs one tick and closes it, so
 * every tick is also a restart.
 */
export function xrig(M, configOverrides = {}) {
  const r = rig(M)
  r.exchangeDir = path.join(r.root, 'exchange')
  r.outboxFile = path.join(r.exchangeDir, 'outbox.jsonl')
  r.cfg = M.coreConfig(configOverrides)
  r.tick = (at, opts = {}) => {
    let rec
    try {
      rec = r.open({ now: at, config: r.cfg, exchangeDir: r.exchangeDir, ...opts })
      return rec.tick({ source: STATE_SOURCE, slotStart: at, now: at })
    } catch (err) {
      if (err instanceof assert.AssertionError) throw err
      return assert.fail(`a tick threw ${err.name}: ${err.message}`)
    } finally {
      rec?.close()
    }
  }
  /** The one session, blocked on the owner with a decision (an owner item). */
  r.blocked = (extra = {}) => r.writeState([entry('s1', { state: 'blocked', blockedOn: 'the deploy', decision: 'pick one', updatedAt: T0 - MIN, ...extra })])
  /** The one session, running again with a newer report (the block is over). */
  r.running = (at) => r.writeState([entry('s1', { state: 'running', next: 'build', updatedAt: at })])
  r.outbox = () => (fs.existsSync(r.outboxFile) ? fs.readFileSync(r.outboxFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  r.lines = (cls) => r.outbox().filter((l) => l.class === cls)
  /** Append lines (objects are written as JSON, strings as they are) to one of the consumer's files. */
  r.add = (name, ...lines) => {
    fs.mkdirSync(r.exchangeDir, { recursive: true })
    fs.appendFileSync(path.join(r.exchangeDir, name), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)) + '\n').join(''))
  }
  r.dispositions = (input) => r.kinds('system', (x) => x.body.event === 'input_line' && (!input || x.body.detail.input === input)).map((x) => x.body.detail)
  r.events = (event) => r.kinds('system', (x) => x.body.event === event)
  r.conflicts = () => r.events('idempotency_conflict')
  r.attempts = (phase = 'attempt') => r.kinds('surface', (x) => x.body.phase === phase)
  return r
}
