import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { fileHandlers } from '../src/handlers/file-handlers.js'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { createReadLimiter, ReadLimitError, admissionFor } from '../src/utils/read-limiter.js'
import { isBoundClient } from '../src/environments/authority.js'
import { searchConversations } from '../src/conversation-search.js'
import { resolveFileRefAttachments } from '../src/handler-utils.js'
import { readSessionContext } from '../src/session-context.js'
import { nsCtx, makeSessionIndexCtx, createSpy, createMockSession } from './test-helpers.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

const POSIX = process.platform !== 'win32'

// ---------------------------------------------------------------------------
describe('catalogs for a session-scoped connection are the project\'s own', () => {
  let root, home, cwd, realHome, realProfile, realConfig, fileOps
  const out = []
  before(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-catalogs-')))
    home = join(root, 'home')
    cwd = join(root, 'work', 'proj')
    mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true })
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    mkdirSync(join(home, '.claude', 'commands'), { recursive: true })
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'commands', 'projcmd.md'), 'project command description\n')
    writeFileSync(join(cwd, '.claude', 'agents', 'projagent.md'), 'project agent description\n')
    writeFileSync(join(home, '.claude', 'commands', 'hostcmd.md'), 'HOST-COMMAND-DESCRIPTION\n')
    writeFileSync(join(home, '.claude', 'agents', 'hostagent.md'), 'HOST-AGENT-DESCRIPTION\n')
    realHome = process.env.HOME; realProfile = process.env.USERPROFILE; realConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR
    fileOps = createFileOps((_ws, m) => out.push(m), root)
  })
  after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile
    if (realConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = realConfig
    rmSync(root, { recursive: true, force: true })
  })

  it('an unconfined listing still includes the user-level catalog (control)', async () => {
    const cmds = await fileOps.computeSlashCommands(cwd, null, [])
    assert.ok(cmds.some((c) => c.name === 'hostcmd' && c.source === 'user'))
    const agents = await fileOps.computeAgents(cwd, {})
    assert.ok(agents.some((a) => a.name === 'hostagent'))
  })

  it('a project-only listing carries the project\'s entries and none of the user-level ones', async () => {
    const cmds = await fileOps.computeSlashCommands(cwd, null, [], { projectOnly: true })
    assert.ok(cmds.some((c) => c.name === 'projcmd' && c.description === 'project command description'))
    assert.equal(JSON.stringify(cmds).includes('HOST-COMMAND-DESCRIPTION'), false)
    assert.equal(cmds.some((c) => c.source === 'user'), false)
    const agents = await fileOps.computeAgents(cwd, { projectOnly: true })
    assert.deepEqual(agents.map((a) => a.name), ['projagent'])
  })

  it('a project command that is a link out of the project yields no description', { skip: SKIP_NO_SYMLINK }, async () => {
    writeFileSync(join(home, 'secret.md'), 'LINKED-OUT-SECRET\n')
    symlinkSync(join(home, 'secret.md'), join(cwd, '.claude', 'commands', 'linked.md'))
    const cmds = await fileOps.computeSlashCommands(cwd, null, [], { projectOnly: true })
    assert.equal(JSON.stringify(cmds).includes('LINKED-OUT-SECRET'), false)
  })

  it('a project catalog directory that is a link out of the project is not listed as the project\'s', { skip: SKIP_NO_SYMLINK }, async () => {
    const cwd2 = join(root, 'work', 'linked-catalogs')
    mkdirSync(join(cwd2, '.claude'), { recursive: true })
    symlinkSync(join(home, '.claude', 'commands'), join(cwd2, '.claude', 'commands'))
    symlinkSync(join(home, '.claude', 'agents'), join(cwd2, '.claude', 'agents'))
    const cmds = await fileOps.computeSlashCommands(cwd2, null, [], { projectOnly: true })
    assert.equal(cmds.some((c) => c.name === 'hostcmd'), false)
    assert.equal(JSON.stringify(cmds).includes('HOST-COMMAND-DESCRIPTION'), false)
    const agents = await fileOps.computeAgents(cwd2, { projectOnly: true })
    assert.equal(agents.some((a) => a.name === 'hostagent'), false)
    assert.equal(JSON.stringify(agents).includes('HOST-AGENT-DESCRIPTION'), false)
    // Unconfined, the same project is listed as before (control).
    const open = await fileOps.computeSlashCommands(cwd2, null, [])
    assert.ok(open.some((c) => c.name === 'hostcmd'))
  })

  it('the handlers ask for a project-only listing exactly when the connection is session-scoped', () => {
    const calls = []
    const ctx = {
      sessions: { sessionManager: { getSession: () => ({ cwd: '/work/x', provider: null, session: {} }) } },
      runtime: {},
      services: { fileOps: { listSlashCommands: (...a) => calls.push(['slash', a[5]]), listAgents: (...a) => calls.push(['agents', a[3]]) } },
    }
    for (const client of [{ activeSessionId: 's', boundSessionId: 's' }, { activeSessionId: 's' }]) {
      fileHandlers.list_slash_commands({}, client, { sessionId: 's' }, ctx)
      fileHandlers.list_agents({}, client, { sessionId: 's' }, ctx)
    }
    assert.deepEqual(calls.map((c) => c[1].projectOnly), [true, true, false, false])
  })
})

// ---------------------------------------------------------------------------
describe('readers keep to the file they checked', () => {
  let dir
  before(() => { dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-readers2-'))) })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a file reference that does not exist is reported as missing and not read later', () => {
    const [att] = resolveFileRefAttachments([{ type: 'file_ref', path: 'nope.txt' }], dir)
    assert.match(Buffer.from(att.data, 'base64').toString(), /file not found/)
  })

  it('a file reference whose realpath is inside but whose name is later pointed outside is not served', { skip: SKIP_NO_SYMLINK }, () => {
    mkdirSync(join(dir, 'p'), { recursive: true })
    writeFileSync(join(dir, 'p', 'a.txt'), 'plain\n')
    writeFileSync(join(dir, 'outside.txt'), 'OUTSIDE\n')
    symlinkSync(join(dir, 'outside.txt'), join(dir, 'p', 'l.txt'))
    const [att] = resolveFileRefAttachments([{ type: 'file_ref', path: 'p/l.txt' }], join(dir, 'p'))
    assert.equal(Buffer.from(att.data, 'base64').toString().includes('OUTSIDE'), false)
  })

  it('a package.json that is a link out of the project is not read for the project name', { skip: SKIP_NO_SYMLINK }, async () => {
    mkdirSync(join(dir, 'proj'), { recursive: true })
    writeFileSync(join(dir, 'real-pkg.json'), JSON.stringify({ name: 'name-from-outside' }))
    symlinkSync(join(dir, 'real-pkg.json'), join(dir, 'proj', 'package.json'))
    assert.equal((await readSessionContext(join(dir, 'proj'))).projectName, 'proj')
    writeFileSync(join(dir, 'proj2.json'), '{}')
    mkdirSync(join(dir, 'proj2'), { recursive: true })
    writeFileSync(join(dir, 'proj2', 'package.json'), JSON.stringify({ name: 'own-name' }))
    assert.equal((await readSessionContext(join(dir, 'proj2'))).projectName, 'own-name')
  })

  it('a transcript path that is a FIFO does not block the transcript scanner', { skip: !POSIX && 'needs mkfifo' }, () => {
    const mod = new URL('../src/transcript-tasks.js', import.meta.url).href
    const fifo = join(dir, 'task.jsonl')
    execFileSync('mkfifo', [fifo])
    const code = `import(${JSON.stringify(mod)}).then((m) => {
      const s = new m.TranscriptTaskScanner(${JSON.stringify(fifo)})
      s.scan()
      console.log('RETURNED')
    })`
    const r = spawnSync(process.execPath, ['--input-type=commonjs', '-e', code], { timeout: 5000, encoding: 'utf8' })
    assert.equal(r.error, undefined, `the scan did not return: ${r.error?.message}`)
    assert.match(r.stdout, /RETURNED/)
  })
})

// ---------------------------------------------------------------------------
describe('conversation search with the same id in two projects', () => {
  let dir
  const ID = '88888888-8888-4888-8888-888888888888'
  const rec = (cwd, text) => JSON.stringify({ type: 'user', cwd, message: { content: [{ type: 'text', text }] } }) + '\n'
  before(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-search-dup-')))
    mkdirSync(join(dir, '-work-bound'), { recursive: true })
    mkdirSync(join(dir, '-work-sibling'), { recursive: true })
    writeFileSync(join(dir, '-work-bound', `${ID}.jsonl`), rec('/work/bound', 'needle once, padded padded padded padded padded'))
    writeFileSync(join(dir, '-work-sibling', `${ID}.jsonl`), rec('/work/sibling', 'needle needle needle one') + rec('/work/sibling', 'needle needle two'))
  })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  it('with the conversation id alone the sibling project\'s copy still wins the cap (control)', async () => {
    const out = await searchConversations('needle', { projectsDir: dir, maxResults: 1, conversationId: ID })
    assert.equal(out[0].cwd, '/work/sibling')
  })

  it('with the project selected too, only the authorised copy is read and returned', async () => {
    const out = await searchConversations('needle', { projectsDir: dir, maxResults: 1, conversationId: ID, projectDirName: '-work-bound' })
    assert.deepEqual(out.map((r) => r.cwd), ['/work/bound'])
  })

  it('the handler derives the project from the session\'s own directory', async () => {
    const sessions = new Map()
    const bound = createMockSession()
    bound.resumeSessionId = ID
    sessions.set('b1', { session: bound, name: 'S', cwd: '/work/bound' })
    const sent = []
    const ctx = nsCtx({
      send: createSpy((_w, m) => sent.push(m)),
      ...makeSessionIndexCtx(),
      sessionManager: { getSession: (id) => sessions.get(id), getConversationId: (id) => sessions.get(id)?.session?.resumeSessionId ?? null },
    })
    let seen
    ctx.searchConversations = createSpy(async (_q, opts) => { seen = opts; return [] })
    await conversationHandlers.search_conversations({ readyState: 1 }, { id: 'c', boundSessionId: 'b1' }, { query: 'needle' }, ctx)
    assert.equal(seen.conversationId, ID)
    assert.equal(seen.projectDirName, '-work-bound')
  })
})

// ---------------------------------------------------------------------------
describe('read admission fairness', () => {
  const gate = () => { let release; const done = new Promise((r) => { release = r }); return { done, release } }
  const tick = () => new Promise((r) => setImmediate(r))

  it('counts a session-scoped connection by its credential, not by connection', () => {
    const a = admissionFor({ id: 'c1', authToken: 'tok-1', boundSessionId: 's' }, isBoundClient)
    const b = admissionFor({ id: 'c2', authToken: 'tok-1', boundSessionId: 's' }, isBoundClient)
    assert.equal(a.clientKey, b.clientKey)
    assert.equal(a.restricted, true)
    const u1 = admissionFor({ id: 'c1' }, isBoundClient)
    const u2 = admissionFor({ id: 'c2' }, isBoundClient)
    assert.notEqual(u1.clientKey, u2.clientKey)
    assert.equal(u1.restricted, false)
  })

  it('one credential opening several connections still gets one share', async () => {
    const lim = createReadLimiter({ maxConcurrent: 4, maxPerClient: 2, maxQueued: 32 })
    const g = gate()
    const key = admissionFor({ id: 'c1', authToken: 'tok-9', boundSessionId: 's' }, isBoundClient).clientKey
    const first = [0, 1].map((i) => lim.submit({ key: `k${i}`, clientKey: key, restricted: true }, () => g.done))
    await assert.rejects(lim.submit({ key: 'k2', clientKey: key, restricted: true }, () => g.done), (e) => e instanceof ReadLimitError)
    g.release()
    await Promise.all(first)
  })

  it('a restricted caller cannot take the last running slot', async () => {
    const lim = createReadLimiter({ maxConcurrent: 2, maxPerClient: 10, maxQueued: 32 })
    const g = gate()
    let started = 0
    const run = () => { started++; return g.done }
    const r1 = lim.submit({ key: 'r1', clientKey: 'a', restricted: true }, run)
    const r2 = lim.submit({ key: 'r2', clientKey: 'b', restricted: true }, run)
    await tick()
    assert.equal(started, 1, 'the second restricted read waits: one slot is held back')
    const u = lim.submit({ key: 'u', clientKey: 'c' }, run)
    await tick()
    assert.equal(started, 2, 'an unrestricted read takes the reserved slot')
    g.release()
    await Promise.all([r1, r2, u])
    assert.equal(started, 3)
  })

  it('a restricted caller cannot fill the queue', async () => {
    const lim = createReadLimiter({ maxConcurrent: 1, maxPerClient: 100, maxQueued: 16 })
    const g = gate()
    const held = lim.submit({ key: 'hold', clientKey: 'x' }, () => g.done)
    const queued = []
    let refused = 0
    for (let i = 0; i < 16; i++) {
      queued.push(lim.submit({ key: `q${i}`, clientKey: `c${i}`, restricted: true }, () => g.done).catch((e) => { if (e instanceof ReadLimitError) refused++ }))
    }
    await tick()
    assert.ok(refused > 0, 'some restricted requests were refused before the queue was full')
    const u = lim.submit({ key: 'unrestricted', clientKey: 'z' }, async () => 'ok')
    g.release()
    assert.equal(await u, 'ok')
    await Promise.all([held, ...queued])
  })
})

// ---------------------------------------------------------------------------
describe('request_full_history reports a refusal for load', () => {
  it('answers with a retryable error, not with the in-memory history', async () => {
    const sent = []
    const ctx = nsCtx({
      send: createSpy((_w, m) => sent.push(m)),
      ...makeSessionIndexCtx(),
      reseedActiveAgents: createSpy(),
      resendPendingQuestions: createSpy(),
      resendPendingPermissions: createSpy(),
      sessionManager: {
        getSession: () => ({ session: {}, cwd: '/tmp/x' }),
        getFullHistoryAsync: async () => { throw new ReadLimitError('client', 'Too many transcript requests from this connection are in progress') },
      },
    })
    const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0 })
    await conversationHandlers.request_full_history(ws, { id: 'c', activeSessionId: 's1', subscribedSessionIds: new Set() }, { sessionId: 's1' }, ctx)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'session_error')
    assert.match(sent[0].message, /Try again/)
  })
})

// ---------------------------------------------------------------------------
describe('malformed bindings in the settings handlers', () => {
  it('an empty binding is refused a rules write and a permission-audit query, not treated as unscoped', () => {
    const sent = []
    const ctx = nsCtx({
      send: createSpy((_w, m) => sent.push(m)),
      sessionManager: { getSession: () => ({ session: { setPermissionMode: () => {} } }) },
    })
    const client = { id: 'c', boundSessionId: '', activeSessionId: 's' }
    settingsHandlers.set_permission_rules({ readyState: 1 }, client, { type: 'set_permission_rules', rules: [] }, ctx)
    settingsHandlers.query_permission_audit({ readyState: 1 }, client, { type: 'query_permission_audit', sessionId: 'other' }, ctx)
    const codes = sent.map((m) => m.code)
    assert.ok(codes.includes('PERMISSION_RULES_FORBIDDEN_BOUND_CLIENT'), JSON.stringify(codes))
    assert.equal(sent.some((m) => m.type === 'permission_audit_result' && Array.isArray(m.entries) && m.entries.length > 0), false)
  })
})
