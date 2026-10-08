import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { transcriptPathForSessionFile } from '../src/transcript-tasks.js'
import { pinTmpDaemonBase } from './helpers/pin-tmp-daemon-base.js'

/**
 * #7396 -- claude-tui (the DEFAULT provider) tracks subagents.
 *
 * Before this, `ClaudeTuiSession` never populated `_activeAgents` and never
 * emitted `agent_spawned` / `agent_completed`, so every background-subagent
 * surface (dashboard AgentMonitorPanel, the mobile "N agents running" badge,
 * the working status on the tab, Control Room agent nodes) was dark on the
 * provider most users run, and a session read idle while subagents ran.
 *
 * Signals, and where each shape comes from (none of it invented):
 *
 *  - PreToolUse / PostToolUse hook payloads in the per-session sink dir. Their
 *    envelope is the Agent SDK's `PreToolUseHookInput` / `PostToolUseHookInput`
 *    (sdk.d.ts: `tool_name`, `tool_input`, `tool_response`, `tool_use_id`), and
 *    the Agent tool's input / output are the SDK's `AgentInput` / `AgentOutput`
 *    (sdk-tools.d.ts): output is a union on `status` -- `'completed'` for a
 *    subagent that ran to the end inside the call, `'async_launched'` (+
 *    `agentId`, `outputFile`, ...) for one that was started in the background.
 *    Observed on a live transcript: the async launch's `toolUseResult` also
 *    carries `isAsync: true`, and Claude Code backgrounds an Agent call that
 *    never asked for it (no `run_in_background` in the input).
 *
 *  - The session transcript JSONL, the same one `transcript-tasks.js` scans.
 *    A backgrounded subagent's end is a `<task-notification>` naming its
 *    `<tool-use-id>`, written as a `queue-operation` `enqueue`, re-delivered as
 *    an `attachment` / `queued_command`, and `remove`d when dequeued.
 */

const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR

describe('ClaudeTuiSession background-agent tracking (#7396)', () => {
  let unpinSinkBase
  let fakeHome
  let origHome
  let origUserProfile
  let fakePid
  let fakeCwd
  let session
  let skillsDir
  let origPollMsDescriptor
  let transcriptPath

  beforeEach(() => {
    unpinSinkBase = pinTmpDaemonBase(ClaudeTuiSession, 'SINK_BASE')
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-agents-'))
    mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
    origHome = process.env.HOME
    origUserProfile = process.env.USERPROFILE
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    fakePid = 2 ** 30
    fakeCwd = join(tmpdir(), 'chroxy-7396-fake-cwd')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-agents-skills-'))
    transcriptPath = null
    // Getter-only static -- shorten the idle poll so a tick is observable
    // without waiting out the real 15s.
    origPollMsDescriptor = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'BACKGROUND_TASK_POLL_MS')
    Object.defineProperty(ClaudeTuiSession, 'BACKGROUND_TASK_POLL_MS', { value: 20, configurable: true })
  })

  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } }
    session = null
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile
    else delete process.env.USERPROFILE
    process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    if (skillsDir) rmSync(skillsDir, { recursive: true, force: true })
    Object.defineProperty(ClaudeTuiSession, 'BACKGROUND_TASK_POLL_MS', origPollMsDescriptor)
    if (unpinSinkBase) unpinSinkBase()
    unpinSinkBase = null
  })

  // ---- fixtures ------------------------------------------------------------

  function makeSession() {
    const s = new ClaudeTuiSession({ cwd: fakeCwd, skillsDir, repoSkillsDir: null, resultTimeoutMs: 5000, hardTimeoutMs: 5000 })
    s.on('error', () => {})
    session = s
    return s
  }

  /** A session with a live (fake) PTY and a resolvable transcript on disk. */
  function makeLiveSession({ withTranscript = true } = {}) {
    const s = makeSession()
    s._term = { pid: fakePid, write: () => {}, kill: () => {} }
    s._processReady = true
    s._sessionId = 'uuid-7396'
    if (withTranscript) {
      const sessFile = join(fakeHome, '.claude', 'sessions', `${fakePid}.json`)
      writeFileSync(sessFile, JSON.stringify({ pid: fakePid, sessionId: s._sessionId, cwd: fakeCwd, startedAt: Date.now() }))
      transcriptPath = transcriptPathForSessionFile(sessFile)
      mkdirSync(dirname(transcriptPath), { recursive: true })
      writeFileSync(transcriptPath, '')
    }
    return s
  }

  function record(s, extra = []) {
    const events = []
    for (const name of ['agent_spawned', 'agent_completed', ...extra]) {
      s.on(name, (d) => events.push({ name, ...d }))
    }
    return events
  }

  const names = (events) => events.map((e) => e.name)

  // PreToolUse hook payload for the Agent tool. `tool_input` is the SDK's
  // `AgentInput`; the envelope is `PreToolUseHookInput`.
  function preAgent(toolUseId, { name = 'Agent', background } = {}) {
    const tool_input = { description: 'Audit the config loader', prompt: 'Read config.js and report anything odd.', subagent_type: 'general-purpose' }
    if (background !== undefined) tool_input.run_in_background = background
    return { session_id: 'uuid-7396', transcript_path: '/x/uuid-7396.jsonl', cwd: fakeCwd, hook_event_name: 'PreToolUse', tool_name: name, tool_input, tool_use_id: toolUseId }
  }

  // PostToolUse for an Agent call that was started in the background:
  // `AgentOutput` { status: 'async_launched', ... } plus the `isAsync` flag
  // observed on the live transcript's `toolUseResult`.
  function postAsync(toolUseId, { name = 'Agent', withId = true } = {}) {
    const p = {
      session_id: 'uuid-7396', transcript_path: '/x/uuid-7396.jsonl', cwd: fakeCwd, hook_event_name: 'PostToolUse', tool_name: name,
      tool_input: { description: 'Audit the config loader', prompt: 'Read config.js and report anything odd.', subagent_type: 'general-purpose' },
      tool_response: {
        isAsync: true,
        status: 'async_launched',
        agentId: 'a0123456789abcdef',
        description: 'Audit the config loader',
        prompt: 'Read config.js and report anything odd.',
        outputFile: '/tmp/tasks/a0123456789abcdef.output',
        canReadOutputFile: true,
      },
    }
    if (withId) p.tool_use_id = toolUseId
    return p
  }

  // PostToolUse for an Agent call that ran to the end inside the call:
  // `AgentOutput` { status: 'completed', ... }.
  function postSync(toolUseId, { name = 'Agent' } = {}) {
    return {
      session_id: 'uuid-7396', transcript_path: '/x/uuid-7396.jsonl', cwd: fakeCwd, hook_event_name: 'PostToolUse', tool_name: name,
      tool_input: { description: 'Audit the config loader', prompt: 'Read config.js and report anything odd.', subagent_type: 'general-purpose' },
      tool_response: {
        status: 'completed',
        agentId: 'a0123456789abcdef',
        agentType: 'general-purpose',
        content: [{ type: 'text', text: 'Nothing odd.' }],
        totalToolUseCount: 2,
        totalDurationMs: 4100,
        totalTokens: 9000,
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: 'standard', cache_creation: null },
        prompt: 'Read config.js and report anything odd.',
      },
      tool_use_id: toolUseId,
    }
  }

  const notificationXml = (toolUseId, status = 'completed') =>
    `<task-notification>\n<task-id>a0123456789abcdef</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/tasks/a0123456789abcdef.output</output-file>\n<status>${status}</status>\n<summary>Agent "Audit the config loader" finished</summary>\n</task-notification>`

  // The three places the transcript carries one notification.
  const enqueueLine = (id, status) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-04T07:47:25.847Z', sessionId: 'uuid-7396', content: notificationXml(id, status) })
  const attachmentLine = (id, status) => JSON.stringify({ parentUuid: 'p1', isSidechain: false, attachment: { type: 'queued_command', prompt: notificationXml(id, status) }, type: 'attachment', uuid: 'u1', timestamp: '2026-10-04T07:47:26.000Z', sessionId: 'uuid-7396' })
  const removeLine = (id, status) => JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: '2026-10-04T07:47:35.943Z', sessionId: 'uuid-7396', content: notificationXml(id, status) })

  function appendTranscript(lines) {
    appendFileSync(transcriptPath, lines.map((l) => l + '\n').join(''))
  }

  async function waitFor(cond, what, timeoutMs = 3000) {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  // Drive a real turn through the hook-drain poll: the PTY write drops the
  // given hook files, the last of which is the Stop hook.
  async function runTurn(s, files) {
    const sink = mkdtempSync(join(tmpdir(), 'chroxy-tui-agents-base-'))
    const dir = join(sink, 's-test')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    s._sinkDir = dir
    s._waitForPrompt = async () => true
    s._term.write = () => {
      for (const [name, payload] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(payload))
    }
    try { await s.sendMessage('go') } finally { rmSync(sink, { recursive: true, force: true }) }
  }

  const stopHook = { last_assistant_message: 'done' }

  // ---- spawn ---------------------------------------------------------------

  describe('spawn', () => {
    for (const name of ['Agent', 'Task']) {
      it(`PreToolUse of the ${name} tool emits one agent_spawned with the SDK payload shape`, () => {
        const s = makeLiveSession()
        const events = record(s)
        s._activeTurn = { uuid: 't', synthSeq: 0 }
        s._emitToolHookEvent('PreToolUse', preAgent('toolu_a1', { name, background: true }), 'msg-1')

        const spawned = events.filter((e) => e.name === 'agent_spawned')
        assert.equal(spawned.length, 1)
        assert.equal(spawned[0].toolUseId, 'toolu_a1')
        assert.equal(spawned[0].description, 'Audit the config loader')
        assert.equal(typeof spawned[0].startedAt, 'number')
        assert.equal(spawned[0].background, true)
        // The model's REQUEST does not exempt the agent from the turn-end sweep.
        assert.equal(spawned[0].backgroundConfirmed, false)
        assert.deepEqual(s.getActiveAgents().map((a) => a.toolUseId), ['toolu_a1'])
      })
    }

    it('a non-agent tool spawns nothing', () => {
      const s = makeLiveSession()
      const events = record(s)
      s._activeTurn = { uuid: 't', synthSeq: 0 }
      s._emitToolHookEvent('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls', run_in_background: true }, tool_use_id: 'toolu_b1' }, 'msg-1')
      assert.deepEqual(names(events), [])
      assert.equal(s._activeAgents.size, 0)
    })

    it('the same PreToolUse delivered twice spawns once', () => {
      const s = makeLiveSession()
      const events = record(s)
      s._activeTurn = { uuid: 't', synthSeq: 0 }
      s._emitToolHookEvent('PreToolUse', preAgent('toolu_dup', { background: true }), 'msg-1')
      s._emitToolHookEvent('PreToolUse', preAgent('toolu_dup', { background: true }), 'msg-1')
      assert.equal(events.filter((e) => e.name === 'agent_spawned').length, 1)
    })
  })

  // ---- foreground ----------------------------------------------------------

  describe('foreground subagent', () => {
    it('is completed by its own PostToolUse (AgentOutput status "completed")', () => {
      const s = makeLiveSession()
      const events = record(s)
      s._activeTurn = { uuid: 't', synthSeq: 0 }
      s._emitToolHookEvent('PreToolUse', preAgent('toolu_fg'), 'msg-1')
      assert.equal(s._activeAgents.size, 1)
      s._emitToolHookEvent('PostToolUse', postSync('toolu_fg'), 'msg-1')

      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
      assert.equal(events[1].toolUseId, 'toolu_fg')
      assert.equal(s._activeAgents.size, 0)
    })

    it('a requested-background Agent whose PostToolUse says it ran in the foreground is completed, not parked', () => {
      const s = makeLiveSession()
      const events = record(s)
      s._activeTurn = { uuid: 't', synthSeq: 0 }
      s._emitToolHookEvent('PreToolUse', preAgent('toolu_req', { background: true }), 'msg-1')
      s._emitToolHookEvent('PostToolUse', postSync('toolu_req'), 'msg-1')
      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
    })

    it('one whose PostToolUse never arrives is swept at the turn end (never "N agents running" forever)', async () => {
      const s = makeLiveSession()
      const events = record(s)
      await runTurn(s, { 'pre-a.json': preAgent('toolu_lost'), 'stop-z.json': stopHook })
      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
      assert.equal(s._activeAgents.size, 0)
    })
  })

  // ---- background: spawn, survive the turn, complete ------------------------

  describe('background subagent', () => {
    it('a PostToolUse async_launched confirms it as background and it survives the turn end', async () => {
      const s = makeLiveSession()
      const events = record(s)
      await runTurn(s, {
        'pre-a.json': preAgent('toolu_bg', { background: true }),
        'post-a.json': postAsync('toolu_bg'),
        'stop-z.json': stopHook,
      })
      assert.deepEqual(names(events), ['agent_spawned'], 'no agent_completed at turn end')
      assert.equal(s._activeAgents.get('toolu_bg').backgroundConfirmed, true)
      assert.equal(s._isBusy, false)
      assert.deepEqual(s.getActiveAgents().map((a) => a.toolUseId), ['toolu_bg'])
      assert.deepEqual(s.getRestartBlockers(), ['1 active background agent(s)'])
    })

    it('Claude Code backgrounding an Agent that never asked for it (no run_in_background) is still confirmed from the response', async () => {
      const s = makeLiveSession()
      const events = record(s)
      await runTurn(s, {
        'pre-a.json': preAgent('toolu_implicit'),
        'post-a.json': postAsync('toolu_implicit'),
        'stop-z.json': stopHook,
      })
      assert.deepEqual(names(events), ['agent_spawned'])
      assert.equal(s._activeAgents.get('toolu_implicit').backgroundConfirmed, true)
    })

    it('the transcript task-notification completes it after the turn is over, and the poll stops', async () => {
      const s = makeLiveSession()
      const events = record(s)
      await runTurn(s, {
        'pre-a.json': preAgent('toolu_bg', { background: true }),
        'post-a.json': postAsync('toolu_bg'),
        'stop-z.json': stopHook,
      })
      assert.ok(s._backgroundTaskPollTimer, 'the idle poll is armed while an agent runs')

      appendTranscript([enqueueLine('toolu_bg')])
      await waitFor(() => events.some((e) => e.name === 'agent_completed'), 'agent_completed')

      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
      assert.equal(events[1].toolUseId, 'toolu_bg')
      assert.equal(s._activeAgents.size, 0)
      await waitFor(() => s._backgroundTaskPollTimer === null, 'the poll to stop')
    })

    it('the poll keeps ticking while the agent is still running (no notification yet), and finds the notification when it lands', async () => {
      const s = makeLiveSession()
      const events = record(s)
      await runTurn(s, { 'pre-a.json': preAgent('toolu_bg'), 'post-a.json': postAsync('toolu_bg'), 'stop-z.json': stopHook })
      // Several 20ms ticks with nothing outstanding in the transcript but the agent.
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.ok(s._backgroundTaskPollTimer, 'an idle poll with a running agent must not stop itself')
      assert.equal(s._activeAgents.size, 1)

      appendTranscript([enqueueLine('toolu_bg')])
      await waitFor(() => s._activeAgents.size === 0, 'the agent to clear')
      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
    })

    it('a readiness read of an empty task snapshot (the `ready` broadcast) does not stop the poll a running agent needs', async () => {
      const s = makeLiveSession()
      const events = record(s)
      await runTurn(s, { 'pre-a.json': preAgent('toolu_bg'), 'post-a.json': postAsync('toolu_bg'), 'stop-z.json': stopHook })

      const snap = s.getBackgroundTaskSnapshot()
      assert.equal(snap.backgroundTasks.length, 0, 'precondition: the transcript tasks list knows nothing of the agent')
      assert.ok(s._backgroundTaskPollTimer, 'the agent still needs the poll')

      appendTranscript([enqueueLine('toolu_bg')])
      await waitFor(() => s._activeAgents.size === 0, 'the agent to clear')
      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
    })

    it('a notification that landed before the turn ended completes it AT the turn end, not a poll interval later', () => {
      const s = makeLiveSession()
      const events = record(s)
      s._activeTurn = { uuid: 't', synthSeq: 0 }
      s._isBusy = true
      s._currentMessageId = 'msg-1'
      s._emitToolHookEvent('PreToolUse', preAgent('toolu_bg', { background: true }), 'msg-1')
      s._emitToolHookEvent('PostToolUse', postAsync('toolu_bg'), 'msg-1')
      appendTranscript([enqueueLine('toolu_bg')])

      s._clearTurnEndState({ turnEndedCleanly: true }) // synchronously: no poll tick has run

      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
      assert.equal(s._activeAgents.size, 0)
    })

    for (const status of ['failed', 'killed', 'stopped']) {
      it(`a "${status}" notification clears it too (every terminal status, or a dead agent pins the session working)`, async () => {
        const s = makeLiveSession()
        const events = record(s)
        await runTurn(s, { 'pre-a.json': preAgent('toolu_bg'), 'post-a.json': postAsync('toolu_bg'), 'stop-z.json': stopHook })
        appendTranscript([enqueueLine('toolu_bg', status)])
        await waitFor(() => s._activeAgents.size === 0, 'the agent to clear')
        assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
      })
    }

    it('a notification delivered three ways (enqueue, queued_command attachment, remove) completes exactly once', async () => {
      const s = makeLiveSession()
      const events = record(s)
      await runTurn(s, { 'pre-a.json': preAgent('toolu_bg'), 'post-a.json': postAsync('toolu_bg'), 'stop-z.json': stopHook })
      appendTranscript([enqueueLine('toolu_bg'), attachmentLine('toolu_bg'), removeLine('toolu_bg')])
      await waitFor(() => s._activeAgents.size === 0, 'the agent to clear')
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(events.filter((e) => e.name === 'agent_completed').length, 1)
      assert.equal(events.filter((e) => e.name === 'agent_spawned').length, 1, 'the transcript never re-spawns')
    })

    it('a notification for an id nobody tracks spawns and completes nothing', async () => {
      const s = makeLiveSession()
      const events = record(s)
      await runTurn(s, { 'pre-a.json': preAgent('toolu_bg'), 'post-a.json': postAsync('toolu_bg'), 'stop-z.json': stopHook })
      appendTranscript([enqueueLine('toolu_someone_else')])
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.deepEqual(names(events), ['agent_spawned'])
      assert.equal(s._activeAgents.size, 1)
    })

    it('completes mid-turn (a long turn must not keep a finished agent on the badge)', async () => {
      const s = makeLiveSession()
      const events = record(s, ['background_tasks_changed'])
      s._activeTurn = { uuid: 't', synthSeq: 0 }
      s._isBusy = true
      s._emitToolHookEvent('PreToolUse', preAgent('toolu_bg', { background: true }), 'msg-1')
      s._emitToolHookEvent('PostToolUse', postAsync('toolu_bg'), 'msg-1')
      assert.ok(s._backgroundTaskPollTimer, 'armed as soon as the agent is confirmed')
      appendTranscript([enqueueLine('toolu_bg')])
      await waitFor(() => s._activeAgents.size === 0, 'the agent to clear while busy')
      assert.equal(events.filter((e) => e.name === 'background_tasks_changed').length, 0, 'no task broadcast while busy')
    })

    it('a notification already in the transcript when the launch is confirmed completes at once', async () => {
      const s = makeLiveSession()
      const events = record(s)
      appendTranscript([enqueueLine('toolu_fast')])
      s._activeTurn = { uuid: 't', synthSeq: 0 }
      s._emitToolHookEvent('PreToolUse', preAgent('toolu_fast', { background: true }), 'msg-1')
      s._emitToolHookEvent('PostToolUse', postAsync('toolu_fast'), 'msg-1')
      await waitFor(() => s._activeAgents.size === 0, 'the agent to clear')
      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
    })
  })

  // ---- positive controls: nothing may pin the session working --------------

  describe('liveness (a tracked agent must always have a way out)', () => {
    it('async_launched but the transcript cannot be read: not confirmed, swept at the turn end', async () => {
      const s = makeLiveSession({ withTranscript: false })
      const events = record(s)
      await runTurn(s, { 'pre-a.json': preAgent('toolu_bg'), 'post-a.json': postAsync('toolu_bg'), 'stop-z.json': stopHook })
      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
      assert.equal(s._activeAgents.size, 0)
    })

    it('async_launched but the hook carried no tool_use_id (synthesized id cannot match a notification): swept at the turn end', async () => {
      const s = makeLiveSession()
      const events = record(s)
      const pre = preAgent('x'); delete pre.tool_use_id
      await runTurn(s, { 'pre-a.json': pre, 'post-a.json': postAsync('x', { withId: false }), 'stop-z.json': stopHook })
      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
      assert.equal(s._activeAgents.size, 0)
    })

    it('spawn then Stop (the turn dies in error): a confirmed background agent is completed', async () => {
      const s = makeLiveSession()
      const events = record(s)
      s._activeTurn = { uuid: 't', synthSeq: 0 }
      s._isBusy = true
      s._currentMessageId = 'msg-1'
      s._emitToolHookEvent('PreToolUse', preAgent('toolu_bg', { background: true }), 'msg-1')
      s._emitToolHookEvent('PostToolUse', postAsync('toolu_bg'), 'msg-1')
      assert.equal(s._activeAgents.get('toolu_bg').backgroundConfirmed, true)

      s._finishTurnError('boom', 'msg-1')

      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
      assert.equal(s._activeAgents.size, 0)
    })

    it('spawn then a hard-cap / stall teardown (Ctrl-C into the PTY): completed', () => {
      const s = makeLiveSession()
      const events = record(s)
      s._activeTurn = { uuid: 't', synthSeq: 0 }
      s._isBusy = true
      s._currentMessageId = 'msg-1'
      s._emitToolHookEvent('PreToolUse', preAgent('toolu_bg', { background: true }), 'msg-1')
      s._emitToolHookEvent('PostToolUse', postAsync('toolu_bg'), 'msg-1')

      s._teardownTurn('hard_timeout', { duration: 1 })

      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
      assert.equal(s._activeAgents.size, 0)
    })

    it('spawn, turn ends cleanly, then the PTY dies: completed (its agents died with it)', async () => {
      const s = makeLiveSession()
      const events = record(s)
      await runTurn(s, { 'pre-a.json': preAgent('toolu_bg'), 'post-a.json': postAsync('toolu_bg'), 'stop-z.json': stopHook })
      assert.equal(s._activeAgents.size, 1)

      s._onPtyGone({ exitCode: 1 }, 'test')

      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
      assert.equal(s._activeAgents.size, 0)
    })

    it('spawn, turn ends cleanly, then the session is destroyed: completed, poll stopped, nothing left to emit', async () => {
      const s = makeLiveSession()
      const events = record(s)
      await runTurn(s, { 'pre-a.json': preAgent('toolu_bg'), 'post-a.json': postAsync('toolu_bg'), 'stop-z.json': stopHook })
      assert.ok(s._backgroundTaskPollTimer)

      await s.destroy()

      assert.equal(s._activeAgents.size, 0)
      assert.equal(s._backgroundTaskPollTimer, null)
      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
      // A late transcript line must not resurrect anything.
      appendTranscript([enqueueLine('toolu_bg')])
      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.deepEqual(names(events), ['agent_spawned', 'agent_completed'])
    })

    it('removeAllListeners() (the teardown most providers use) clears the tracked agents', async () => {
      const s = makeLiveSession()
      await runTurn(s, { 'pre-a.json': preAgent('toolu_bg'), 'post-a.json': postAsync('toolu_bg'), 'stop-z.json': stopHook })
      assert.equal(s._activeAgents.size, 1)
      s.removeAllListeners()
      assert.equal(s._activeAgents.size, 0)
    })
  })

  // ---- coexistence with the existing background-task poll ------------------

  describe('the existing background-task poll', () => {
    it('keeps running for an outstanding transcript task after the last agent clears, and still broadcasts the drain', async () => {
      const s = makeLiveSession()
      const bashLaunch = JSON.stringify({ type: 'assistant', timestamp: '2026-10-04T07:40:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sh', name: 'Bash', input: { command: 'sleep 99', description: 'long build', run_in_background: true } }] } })
      appendTranscript([bashLaunch])
      s.getBackgroundTaskSnapshot() // the readiness broadcast: baseline + arms the poll
      assert.ok(s._backgroundTaskPollTimer)
      const events = record(s, ['background_tasks_changed'])
      await runTurn(s, { 'pre-a.json': preAgent('toolu_bg'), 'post-a.json': postAsync('toolu_bg'), 'stop-z.json': stopHook })

      appendTranscript([enqueueLine('toolu_bg')])
      await waitFor(() => events.some((e) => e.name === 'agent_completed'), 'the agent to clear')
      assert.ok(s._backgroundTaskPollTimer, 'the Bash task is still outstanding, so the poll must keep running')

      appendTranscript([`${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-04T07:50:00.000Z', sessionId: 'uuid-7396', content: notificationXml('toolu_sh') })}`])
      await waitFor(() => events.some((e) => e.name === 'background_tasks_changed' && e.backgroundTasks.length === 0), 'the task drain broadcast')
      await waitFor(() => s._backgroundTaskPollTimer === null, 'the poll to stop once nothing is outstanding')
    })
  })
})
