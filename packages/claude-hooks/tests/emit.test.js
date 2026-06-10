// #5413 Phase 4: emitter pins.
//
//   - every hook event builds an envelope that validates against the REAL
//     IngestEventSchema from @chroxy/protocol (source charset, flat data
//     bag, ts bounds) — the contract the server enforces
//   - project is sent EXPLICITLY (cwd git-root walk, .git dir AND .git
//     file, $CLAUDE_PROJECT_DIR fallback)
//   - runEmit: bearer header + body on the wire; silent no-op when the
//     daemon is down, when no secret resolves, on garbage stdin
//   - sanitizeData clamps to schema bounds instead of failing
//   - config resolution: env overrides win; config.json port; defaults
//
// All paths are temp dirs; env is passed explicitly (never process.env).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IngestEventSchema } from '@chroxy/protocol'
import { buildEnvelope, resolveHookEvent, runEmit, sanitizeData, SOURCE } from '../src/emit.js'
import { EMITTERS } from '../src/emitters.js'
import { resolveIngestUrl, resolveIngestSecret, DEFAULT_PORT } from '../src/config.js'
import { classifyNonProjectCwd, deriveProject, worktreeParent } from '../src/project.js'

const SECRET = 'test-hooks-secret'
const NOW = 1_750_000_000_000

function tempRepo({ gitFile = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hooks-repo-'))
  if (gitFile) {
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/worktrees/x\n')
  } else {
    mkdirSync(join(root, '.git'))
  }
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  return root
}

/**
 * #5464: chroxy's SECOND worktree source — session worktrees under
 * ~/.chroxy/worktrees/<sessionId> (DEFAULT_WORKTREE_BASE in
 * session-manager.js). The basename is an opaque hex session id, so the
 * parent project is only recoverable from the worktree's .git FILE
 * (`gitdir: <repo>/.git/worktrees/<id>` — written by `git worktree add`).
 * The root is env-injected (CHROXY_HOOKS_CHROXY_WORKTREES_ROOT) so fixtures
 * are hermetic on any OS, same pattern as CHROXY_HOOKS_TMP_PREFIXES.
 */
function chroxyWorktreeFixture({ gitdir, noGitFile = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'hooks-chroxywt-'))
  const root = join(base, 'worktrees')
  const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  const wt = join(root, id)
  mkdirSync(join(wt, 'packages', 'server'), { recursive: true })
  const repoRoot = join(base, 'projects', 'coolproj')
  mkdirSync(join(repoRoot, '.git', 'worktrees', id), { recursive: true })
  if (!noGitFile) {
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir ?? join(repoRoot, '.git', 'worktrees', id)}\n`)
  }
  return { base, root, id, wt, repoRoot }
}

describe('buildEnvelope', () => {
  const repo = tempRepo()
  const basePayload = { session_id: 'sess-abc', cwd: join(repo, 'src', 'deep') }

  for (const hookEvent of Object.keys(EMITTERS)) {
    it(`${hookEvent} envelope validates against IngestEventSchema`, () => {
      const envelope = buildEnvelope(hookEvent, basePayload, { env: {}, now: () => NOW })
      const result = IngestEventSchema.safeParse(envelope)
      assert.equal(result.success, true, JSON.stringify(result.error?.issues))
      assert.equal(envelope.source, SOURCE)
      assert.equal(envelope.sessionId, 'sess-abc')
      assert.equal(envelope.ts, NOW)
      assert.equal(envelope.project, repo.split('/').pop())
    })
  }

  it('maps each hook event to its snake_cased ingest type', () => {
    const expectations = {
      SessionStart: 'session_start',
      SessionEnd: 'session_end',
      SubagentStart: 'subagent_start',
      SubagentStop: 'subagent_stop',
      Notification: 'notification',
      PostToolUse: 'post_tool_use',
    }
    for (const [hookEvent, type] of Object.entries(expectations)) {
      assert.equal(buildEnvelope(hookEvent, {}, { env: {}, now: () => NOW }).type, type)
    }
  })

  it('carries hook-specific fields into the data bag with server-known keys', () => {
    const notif = buildEnvelope('Notification', { message: 'Needs approval', title: 'Hold up' }, { env: {}, now: () => NOW })
    assert.equal(notif.data.message, 'Needs approval')
    assert.equal(notif.data.title, 'Hold up')

    const tool = buildEnvelope('PostToolUse', { tool_name: 'Bash' }, { env: {}, now: () => NOW })
    assert.equal(tool.data.tool, 'Bash')

    const end = buildEnvelope('SessionEnd', { reason: 'logout' }, { env: {}, now: () => NOW })
    assert.equal(end.data.reason, 'logout')

    const start = buildEnvelope('SessionStart', { source: 'resume' }, { env: {}, now: () => NOW })
    assert.equal(start.data.startSource, 'resume')
  })

  it('returns null for unknown hook events', () => {
    assert.equal(buildEnvelope('PreCompact', {}, { env: {}, now: () => NOW }), null)
  })

  // #5439 GAP A: the Notification emitter must forward the matcher
  // discriminator — without it the server cannot tell idle prompts from
  // permission prompts and every "ready for input" renders as 🔐.
  it('Notification forwards notification_type as data.notificationType (#5439 GAP A)', () => {
    const idle = buildEnvelope('Notification', { notification_type: 'idle_prompt', message: 'Ready' }, { env: {}, now: () => NOW })
    assert.equal(idle.data.notificationType, 'idle_prompt')
    assert.equal(IngestEventSchema.safeParse(idle).success, true)

    const perm = buildEnvelope('Notification', { notification_type: 'permission_prompt' }, { env: {}, now: () => NOW })
    assert.equal(perm.data.notificationType, 'permission_prompt')

    const none = buildEnvelope('Notification', { message: 'hi' }, { env: {}, now: () => NOW })
    assert.equal('notificationType' in none.data, false, 'absent on payloads without notification_type')
  })

  it('omits sessionId/project when underivable and still validates', () => {
    const envelope = buildEnvelope('Notification', {}, { env: {}, now: () => NOW })
    assert.equal('sessionId' in envelope, false)
    assert.equal('project' in envelope, false)
    assert.equal(IngestEventSchema.safeParse(envelope).success, true)
  })
})

describe('deriveProject', () => {
  it('walks up to a .git directory', () => {
    const repo = tempRepo()
    assert.equal(deriveProject(join(repo, 'src', 'deep'), {}), repo.split('/').pop())
  })

  it('treats a .git FILE as a root (worktrees)', () => {
    const repo = tempRepo({ gitFile: true })
    assert.equal(deriveProject(join(repo, 'src'), {}), repo.split('/').pop())
  })

  it('falls back to $CLAUDE_PROJECT_DIR basename when cwd is missing', () => {
    assert.equal(deriveProject(null, { CLAUDE_PROJECT_DIR: '/some/path/myproject' }), 'myproject')
  })

  it('returns null with no cwd and no CLAUDE_PROJECT_DIR', () => {
    assert.equal(deriveProject(null, {}), null)
  })

  // #5439 GAP B: worktree-agent cwds belong to the PARENT project — the
  // segment before /.claude/worktrees/ — not the agent-* checkout (port of
  // extract_project_name's worktree remap).
  it('maps .claude/worktrees/agent-* cwds to the parent project (#5439 GAP B)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hooks-wt-'))
    const proj = join(root, 'myproj')
    const wt = join(proj, '.claude', 'worktrees', 'agent-abc123')
    mkdirSync(join(wt, 'packages', 'server'), { recursive: true })
    // Worktree checkouts carry a .git FILE — the remap must win over the walk.
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere/worktrees/agent-abc123\n')
    assert.equal(deriveProject(wt, {}), 'myproj')
    assert.equal(deriveProject(join(wt, 'packages', 'server'), {}), 'myproj', 'nested worktree cwd remaps too')
  })

  // #5464: the SECOND worktree source — chroxy session worktrees under
  // ~/.chroxy/worktrees/<id>. The opaque id basename must never name the
  // project; the parent is recovered from the worktree .git file's gitdir.
  it('maps ~/.chroxy/worktrees/<id> cwds to the parent project via the .git gitdir (#5464)', () => {
    const { root, wt } = chroxyWorktreeFixture()
    const env = { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: root }
    assert.equal(deriveProject(wt, env), 'coolproj')
    assert.equal(deriveProject(join(wt, 'packages', 'server'), env), 'coolproj', 'nested chroxy worktree cwd remaps too')
  })

  it('resolves the chroxy worktrees root from $HOME when no override is set (#5464)', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-chroxyhome-'))
    const id = 'feedfacefeedfacefeedfacefeedface'
    const wt = join(home, '.chroxy', 'worktrees', id)
    mkdirSync(wt, { recursive: true })
    const repoRoot = join(home, 'projects', 'homeproj')
    mkdirSync(join(repoRoot, '.git', 'worktrees', id), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repoRoot, '.git', 'worktrees', id)}\n`)
    assert.equal(deriveProject(wt, { HOME: home }), 'homeproj')
  })
})

describe('worktreeParent (#5464 chroxy worktrees)', () => {
  it('parses an absolute gitdir back to the parent repo basename', () => {
    const { root, wt } = chroxyWorktreeFixture()
    const env = { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: root }
    assert.equal(worktreeParent(wt, env), 'coolproj')
    assert.equal(worktreeParent(join(wt, 'packages', 'server'), env), 'coolproj')
  })

  it('resolves a relative gitdir against the worktree dir', () => {
    const { root, wt } = chroxyWorktreeFixture({
      gitdir: join('..', '..', 'projects', 'coolproj', '.git', 'worktrees', 'x'),
    })
    assert.equal(worktreeParent(wt, { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: root }), 'coolproj')
  })

  it('returns null when the .git file is missing or malformed (classification still suppresses)', () => {
    const missing = chroxyWorktreeFixture({ noGitFile: true })
    const env = { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: missing.root }
    assert.equal(worktreeParent(missing.wt, env), null, 'no .git file')

    const garbled = chroxyWorktreeFixture({ gitdir: null })
    writeFileSync(join(garbled.wt, '.git'), 'not a gitdir line\n')
    assert.equal(worktreeParent(garbled.wt, { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: garbled.root }), null, 'malformed .git file')

    const wrongShape = chroxyWorktreeFixture({ gitdir: '/somewhere/unrelated' })
    assert.equal(worktreeParent(wrongShape.wt, { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: wrongShape.root }), null, 'gitdir not under */worktrees/<id>')
  })

  it('does not match the worktrees root itself or paths outside it', () => {
    const { base, root } = chroxyWorktreeFixture()
    const env = { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: root }
    assert.equal(worktreeParent(root, env), null, 'the base dir is not a worktree')
    assert.equal(worktreeParent(join(base, 'projects', 'coolproj'), env), null, 'sibling paths are untouched')
  })

  // Ordering pin: the chroxy-root check must run BEFORE the /.claude/worktrees/
  // marker split. An agent worktree nested INSIDE a chroxy worktree must
  // resolve via the chroxy worktree's .git file to the real repo — the marker
  // split alone would yield the opaque session id (basename of the segment
  // before the marker). Reordering the checks regresses this silently.
  it('resolves an agent worktree nested inside a chroxy worktree to the real repo, not the opaque id', () => {
    const { root, id, wt } = chroxyWorktreeFixture()
    const nested = join(wt, '.claude', 'worktrees', 'agent-deadbeef', 'src')
    mkdirSync(nested, { recursive: true })
    const env = { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: root }
    assert.equal(worktreeParent(nested, env), 'coolproj')
    assert.notEqual(worktreeParent(nested, env), id, 'the marker split must not win over the chroxy gitdir parse')
    assert.equal(deriveProject(nested, env), 'coolproj')
  })

  // #5470 lesson, pinned: an unusable override must FALL BACK to the $HOME
  // default, not silently disable the chroxy-worktree handling.
  it('falls back to the $HOME default when CHROXY_HOOKS_CHROXY_WORKTREES_ROOT is unusable', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-chroxyhome-'))
    const id = 'cafebabecafebabecafebabecafebabe'
    const wt = join(home, '.chroxy', 'worktrees', id)
    mkdirSync(wt, { recursive: true })
    const repoRoot = join(home, 'projects', 'fallbackproj')
    mkdirSync(join(repoRoot, '.git', 'worktrees', id), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repoRoot, '.git', 'worktrees', id)}\n`)
    for (const bad of ['relative/junk', '   ', '/']) {
      const env = { HOME: home, CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: bad }
      assert.equal(worktreeParent(wt, env), 'fallbackproj', `override ${JSON.stringify(bad)} falls back to $HOME default`)
      assert.equal(
        classifyNonProjectCwd(wt, { ...env, CHROXY_HOOKS_TMP_PREFIXES: '/chroxy-nonexistent-tmp' }),
        'worktree',
        `classification survives unusable override ${JSON.stringify(bad)}`
      )
    }
  })
})

describe('classifyNonProjectCwd (#5464 chroxy worktrees)', () => {
  it("classifies ~/.chroxy/worktrees/<id> cwds as 'worktree'", () => {
    const { root, wt } = chroxyWorktreeFixture()
    const env = { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: root, CHROXY_HOOKS_TMP_PREFIXES: '/chroxy-nonexistent-tmp' }
    assert.equal(classifyNonProjectCwd(wt, env), 'worktree')
    assert.equal(classifyNonProjectCwd(join(wt, 'packages', 'server'), env), 'worktree', 'nested cwds too')
  })

  it("still classifies as 'worktree' when the .git file is unreadable (suppression must not depend on the parse)", () => {
    const { root, wt } = chroxyWorktreeFixture({ noGitFile: true })
    const env = { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: root, CHROXY_HOOKS_TMP_PREFIXES: '/chroxy-nonexistent-tmp' }
    assert.equal(classifyNonProjectCwd(wt, env), 'worktree')
  })

  it('does not classify the worktrees base dir itself or sibling paths', () => {
    const { base, root } = chroxyWorktreeFixture()
    const env = { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: root, CHROXY_HOOKS_TMP_PREFIXES: '/chroxy-nonexistent-tmp' }
    assert.equal(classifyNonProjectCwd(root, env), null)
    assert.equal(classifyNonProjectCwd(join(base, 'projects', 'coolproj'), env), null)
  })
})

describe('sanitizeData', () => {
  it('truncates strings to 4096 chars (schema per-value cap)', () => {
    const out = sanitizeData({ big: 'x'.repeat(5000) })
    assert.equal(out.big.length, 4096)
  })

  it('caps at 32 keys (schema key cap)', () => {
    const input = {}
    for (let i = 0; i < 40; i++) input[`k${i}`] = i
    assert.equal(Object.keys(sanitizeData(input)).length, 32)
  })

  it('drops nested objects/arrays/undefined, keeps flat primitives', () => {
    const out = sanitizeData({ s: 'a', n: 1, b: true, z: null, o: { nested: 1 }, a: [1], u: undefined, inf: Infinity })
    assert.deepEqual(out, { s: 'a', n: 1, b: true, z: null })
  })
})

describe('resolveHookEvent', () => {
  it('accepts hook event names and snake_cased types', () => {
    assert.equal(resolveHookEvent('SessionStart', {}), 'SessionStart')
    assert.equal(resolveHookEvent('session_start', {}), 'SessionStart')
    assert.equal(resolveHookEvent('post_tool_use', {}), 'PostToolUse')
  })

  it('falls back to the payload hook_event_name', () => {
    assert.equal(resolveHookEvent(null, { hook_event_name: 'SubagentStop' }), 'SubagentStop')
  })

  it('returns null for unknown values', () => {
    assert.equal(resolveHookEvent('TotallyMadeUp', {}), null)
    assert.equal(resolveHookEvent(null, { hook_event_name: 'Nope' }), null)
    assert.equal(resolveHookEvent(null, {}), null)
  })
})

describe('config resolution', () => {
  it('CHROXY_INGEST_URL and CHROXY_INGEST_SECRET env overrides win', () => {
    const env = { CHROXY_INGEST_URL: 'http://127.0.0.1:9999/api/events', CHROXY_INGEST_SECRET: 's3cret' }
    assert.equal(resolveIngestUrl(env), 'http://127.0.0.1:9999/api/events')
    assert.equal(resolveIngestSecret(env), 's3cret')
  })

  it('reads port from config.json and secret from ingest-secret under CHROXY_CONFIG_DIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-cfg-'))
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 4242 }))
    writeFileSync(join(dir, 'ingest-secret'), 'file-secret\n')
    const env = { CHROXY_CONFIG_DIR: dir }
    assert.equal(resolveIngestUrl(env), 'http://127.0.0.1:4242/api/events')
    assert.equal(resolveIngestSecret(env), 'file-secret')
  })

  it('falls back to the default port on missing/garbled config and null on missing secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-cfg-'))
    writeFileSync(join(dir, 'config.json'), 'not json{{{')
    const env = { CHROXY_CONFIG_DIR: dir }
    assert.equal(resolveIngestUrl(env), `http://127.0.0.1:${DEFAULT_PORT}/api/events`)
    assert.equal(resolveIngestSecret(env), null)
  })

  it('ignores out-of-range ports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-cfg-'))
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 99999 }))
    assert.equal(resolveIngestUrl({ CHROXY_CONFIG_DIR: dir }), `http://127.0.0.1:${DEFAULT_PORT}/api/events`)
  })
})

describe('runEmit', () => {
  let server
  let baseUrl
  const received = []

  before(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        received.push({ url: req.url, auth: req.headers['authorization'], body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${server.address().port}/api/events`
  })

  after(() => server.close())

  // CHROXY_HOOKS_TMP_PREFIXES points at a nonexistent root so fixtures built
  // under os.tmpdir() — which IS /tmp on Linux CI — don't classify as 'tmp'
  // and get suppressed before the behavior under test runs (#5439 GAP B).
  // The tests that exercise tmp suppression itself override this explicitly.
  const envFor = () => ({
    CHROXY_INGEST_URL: baseUrl,
    CHROXY_INGEST_SECRET: SECRET,
    CHROXY_HOOKS_TMP_PREFIXES: '/chroxy-nonexistent-tmp',
  })

  it('POSTs a schema-valid envelope with the bearer secret', async () => {
    const repo = tempRepo()
    const payload = { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: repo, source: 'startup' }
    const result = await runEmit({
      hookEventArg: 'session_start',
      stdinText: JSON.stringify(payload),
      env: envFor(),
      now: () => NOW,
    })
    assert.deepEqual(result, { sent: true })
    const req = received.at(-1)
    assert.equal(req.auth, `Bearer ${SECRET}`)
    const sent = JSON.parse(req.body)
    assert.equal(IngestEventSchema.safeParse(sent).success, true)
    assert.equal(sent.type, 'session_start')
    assert.equal(sent.sessionId, 'sess-1')
    assert.equal(sent.project, repo.split('/').pop())
    assert.equal(sent.data.startSource, 'startup')
  })

  it('resolves the hook event from stdin when no arg is given', async () => {
    const result = await runEmit({
      stdinText: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 's2' }),
      env: envFor(),
      now: () => NOW,
    })
    assert.deepEqual(result, { sent: true })
    assert.equal(JSON.parse(received.at(-1).body).type, 'subagent_stop')
  })

  it('still emits on garbage stdin (envelope without payload fields)', async () => {
    const result = await runEmit({
      hookEventArg: 'notification',
      stdinText: 'this is not json',
      env: envFor(),
      now: () => NOW,
    })
    assert.deepEqual(result, { sent: true })
    const sent = JSON.parse(received.at(-1).body)
    assert.equal(sent.type, 'notification')
    assert.equal(IngestEventSchema.safeParse(sent).success, true)
  })

  it('is a silent no-op when no secret resolves (no network call)', async () => {
    const countBefore = received.length
    const result = await runEmit({
      hookEventArg: 'session_end',
      stdinText: '{}',
      env: { CHROXY_INGEST_URL: baseUrl, CHROXY_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'hooks-nosecret-')) },
      now: () => NOW,
    })
    assert.deepEqual(result, { sent: false, reason: 'no_secret' })
    assert.equal(received.length, countBefore)
  })

  it('fails silent (no throw) when the daemon is down', async () => {
    const result = await runEmit({
      hookEventArg: 'session_start',
      stdinText: '{}',
      env: { CHROXY_INGEST_URL: 'http://127.0.0.1:1/api/events', CHROXY_INGEST_SECRET: SECRET },
      now: () => NOW,
      timeoutMs: 200,
    })
    assert.equal(result.sent, false)
  })

  it('reports non-2xx responses without throwing', async () => {
    const deny = createServer((req, res) => { res.writeHead(401); res.end() })
    deny.listen(0, '127.0.0.1')
    await once(deny, 'listening')
    try {
      const result = await runEmit({
        hookEventArg: 'session_start',
        stdinText: '{}',
        env: { CHROXY_INGEST_URL: `http://127.0.0.1:${deny.address().port}/api/events`, CHROXY_INGEST_SECRET: 'wrong' },
        now: () => NOW,
      })
      assert.deepEqual(result, { sent: false, reason: 'http_401' })
    } finally {
      deny.close()
    }
  })

  it('returns unknown_event for unmapped hooks without touching the network', async () => {
    const countBefore = received.length
    const result = await runEmit({ hookEventArg: 'PreCompact', stdinText: '{}', env: envFor(), now: () => NOW })
    assert.deepEqual(result, { sent: false, reason: 'unknown_event' })
    assert.equal(received.length, countBefore)
  })

  // #5439 GAP B — non-project session filtering (port of claude-notify.sh's
  // tmp / home / worktree cwd filter). Suppressed events never touch the
  // network; worktree cwds still pass SUBAGENT events through (their counts
  // belong to the parent project).
  describe('non-project cwd suppression (#5439 GAP B)', () => {
    it('suppresses events from /tmp cwds', async () => {
      const tmpCwd = mkdtempSync('/tmp/hooks-tmpfilter-')
      const countBefore = received.length
      const result = await runEmit({
        hookEventArg: 'session_start',
        stdinText: JSON.stringify({ cwd: tmpCwd, session_id: 's-tmp' }),
        // real prefixes, stated explicitly (incl. the macOS /tmp realpath)
        env: { ...envFor(), CHROXY_HOOKS_TMP_PREFIXES: '/tmp:/private/tmp' },
        now: () => NOW,
      })
      assert.deepEqual(result, { sent: false, reason: 'non_project_cwd' })
      assert.equal(received.length, countBefore, 'no network call for a /tmp session')
    })

    it('suppresses events from the home directory root (basename = username, not a project)', async () => {
      const home = mkdtempSync(join(tmpdir(), 'hooks-home-'))
      const countBefore = received.length
      const result = await runEmit({
        hookEventArg: 'notification',
        stdinText: JSON.stringify({ cwd: home }),
        env: { ...envFor(), HOME: home },
        now: () => NOW,
      })
      assert.deepEqual(result, { sent: false, reason: 'non_project_cwd' })
      assert.equal(received.length, countBefore)
    })

    it('does NOT suppress a project under the home directory', async () => {
      const home = mkdtempSync(join(tmpdir(), 'hooks-home-'))
      const proj = join(home, 'realproject')
      mkdirSync(join(proj, '.git'), { recursive: true })
      const result = await runEmit({
        hookEventArg: 'session_start',
        stdinText: JSON.stringify({ cwd: proj, session_id: 's-proj' }),
        env: { ...envFor(), HOME: home },
        now: () => NOW,
      })
      assert.deepEqual(result, { sent: true })
      assert.equal(JSON.parse(received.at(-1).body).project, 'realproject')
    })

    it('suppresses non-subagent events from worktree cwds, but lets subagent events through remapped to the parent', async () => {
      const root = mkdtempSync(join(tmpdir(), 'hooks-wtfilter-'))
      const wt = join(root, 'parentproj', '.claude', 'worktrees', 'agent-xyz')
      mkdirSync(wt, { recursive: true })

      const countBefore = received.length
      const start = await runEmit({
        hookEventArg: 'session_start',
        stdinText: JSON.stringify({ cwd: wt, session_id: 's-wt' }),
        env: envFor(),
        now: () => NOW,
      })
      assert.deepEqual(start, { sent: false, reason: 'non_project_cwd' })
      assert.equal(received.length, countBefore, 'worktree SessionStart suppressed')

      const stop = await runEmit({
        hookEventArg: 'subagent_stop',
        stdinText: JSON.stringify({ cwd: wt, session_id: 's-wt' }),
        env: envFor(),
        now: () => NOW,
      })
      assert.deepEqual(stop, { sent: true }, 'worktree SubagentStop reaches the counting code')
      const sent = JSON.parse(received.at(-1).body)
      assert.equal(sent.type, 'subagent_stop')
      assert.equal(sent.project, 'parentproj', 'subagent counts belong to the parent project')
    })

    // #5464: chroxy session worktrees (~/.chroxy/worktrees/<id>) get the
    // SAME semantics as agent worktrees — without this, every chroxy
    // worktree session mints a noise embed keyed on the opaque hex id.
    it('suppresses non-subagent events from ~/.chroxy/worktrees cwds, but lets subagent events through remapped to the parent (#5464)', async () => {
      const { root, wt } = chroxyWorktreeFixture()
      const env = { ...envFor(), CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: root }

      const countBefore = received.length
      const start = await runEmit({
        hookEventArg: 'session_start',
        stdinText: JSON.stringify({ cwd: wt, session_id: 's-cwt' }),
        env,
        now: () => NOW,
      })
      assert.deepEqual(start, { sent: false, reason: 'non_project_cwd' })
      assert.equal(received.length, countBefore, 'chroxy worktree SessionStart suppressed')

      const stop = await runEmit({
        hookEventArg: 'subagent_stop',
        stdinText: JSON.stringify({ cwd: wt, session_id: 's-cwt' }),
        env,
        now: () => NOW,
      })
      assert.deepEqual(stop, { sent: true }, 'chroxy worktree SubagentStop reaches the counting code')
      const sent = JSON.parse(received.at(-1).body)
      assert.equal(sent.type, 'subagent_stop')
      assert.equal(sent.project, 'coolproj', 'subagent counts belong to the parent repo, not the opaque worktree id')
    })

    it('CHROXY_HOOKS_SKIP_CWD_FILTER=1 bypasses the filter (test/debug escape hatch)', async () => {
      const tmpCwd = mkdtempSync('/tmp/hooks-tmpfilter-')
      const result = await runEmit({
        hookEventArg: 'session_start',
        stdinText: JSON.stringify({ cwd: tmpCwd, session_id: 's-bypass' }),
        env: {
          ...envFor(),
          CHROXY_HOOKS_TMP_PREFIXES: '/tmp:/private/tmp',
          CHROXY_HOOKS_SKIP_CWD_FILTER: '1',
        },
        now: () => NOW,
      })
      assert.deepEqual(result, { sent: true })
    })
  })
})
