import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession, withHookFsTimeout } from '../src/claude-tui-session.js'
import { RespawnRateLimiter } from '../src/utils/respawn-rate-limiter.js'
import { addLogListener, removeLogListener } from '../src/logger.js'

describe('ClaudeTuiSession', () => {
  let emptySkillsDir
  let session

  beforeEach(() => {
    emptySkillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-skills-'))
  })

  afterEach(async () => {
    if (session) {
      try { await session.destroy() } catch { /* ignore */ }
      session = null
    }
    if (emptySkillsDir) rmSync(emptySkillsDir, { recursive: true, force: true })
    emptySkillsDir = null
  })

  describe('static metadata', () => {
    it('exposes a human-readable label', () => {
      assert.match(ClaudeTuiSession.displayLabel, /TUI/)
    })

    it('declares capabilities the dashboard reads', () => {
      const c = ClaudeTuiSession.capabilities
      assert.equal(c.permissions, true, 'MVP gates tools via permission-hook.sh')
      assert.equal(c.tools, true, 'MVP wires PreToolUse/PostToolUse hooks')
      assert.equal(c.modelSwitch, false, 'MVP does not support model switch')
      assert.equal(c.planMode, false, 'MVP does not support plan mode')
      assert.equal(c.streaming, false, 'MVP is deliver-on-complete, no incremental tokens')
    })

    it('declares no env-var credentials (subscription-only)', () => {
      // Critical: this provider must not accept ANTHROPIC_API_KEY in preflight.
      // The whole point is OAuth-only routing for subscription billing.
      const envVars = ClaudeTuiSession.preflight.credentials.envVars
      assert.deepEqual(envVars, [], 'no env-var auth — OAuth subscription only')
    })

    it('uses ~/.claude as data dir (shared with claude-cli/sdk)', () => {
      assert.match(ClaudeTuiSession.dataDir, /\.claude$/)
    })
  })

  // #5307 (WP-0.1) — conversation continuity across restart. The TUI must
  // persist its upstream conversation uuid (get resumeSessionId, read by
  // SessionManager.serializeState) and, on restore, respawn claude with
  // `--resume <id>` instead of minting a fresh uuid + `--session-id`. Without
  // this, every restart silently started a brand-new claude conversation while
  // the dashboard replayed stale history (audit TUI-AUDIT-001).
  describe('resume / conversation continuity (#5307 WP-0.1)', () => {
    let fakeHome
    let origSpawnPty
    let capturedArgs
    let session

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-resume-home-'))
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
      process.env._ORIG_HOME = process.env.HOME
      process.env.HOME = fakeHome
      capturedArgs = null
      origSpawnPty = ClaudeTuiSession.prototype._spawnPty
      ClaudeTuiSession.prototype._spawnPty = async function () {
        const idArgs = this._resumedFromPersisted
          ? ['--resume', this._sessionId]
          : ['--session-id', this._sessionId]
        capturedArgs = [...idArgs, '--settings', this._settingsPath, '--no-chrome']
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
      }
    })

    afterEach(async () => {
      if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
      ClaudeTuiSession.prototype._spawnPty = origSpawnPty
      if (process.env._ORIG_HOME) { process.env.HOME = process.env._ORIG_HOME; delete process.env._ORIG_HOME }
      if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    })

    it('declares capabilities.resume = true', () => {
      assert.equal(ClaudeTuiSession.capabilities.resume, true,
        'resume must be advertised so SessionManager round-trips the conversation uuid')
    })

    it('capabilities.multiSelectReinject reflects CHROXY_TUI_MULTISELECT_REINJECT (#5791)', () => {
      // The client gates its multi-select checkbox form on this bit, so it must
      // track the daemon's actual reinject flag — not be hard-coded. Read at
      // access time (listProviders calls the getter per connection).
      const prev = process.env.CHROXY_TUI_MULTISELECT_REINJECT
      try {
        delete process.env.CHROXY_TUI_MULTISELECT_REINJECT
        assert.equal(ClaudeTuiSession.capabilities.multiSelectReinject, false,
          'default (flag unset) → false, matching the server refusing the form')
        process.env.CHROXY_TUI_MULTISELECT_REINJECT = '1'
        assert.equal(ClaudeTuiSession.capabilities.multiSelectReinject, true,
          'flag on → true, so the client may offer the form')
        process.env.CHROXY_TUI_MULTISELECT_REINJECT = '0'
        assert.equal(ClaudeTuiSession.capabilities.multiSelectReinject, false,
          'explicit 0 → false')
      } finally {
        if (prev === undefined) delete process.env.CHROXY_TUI_MULTISELECT_REINJECT
        else process.env.CHROXY_TUI_MULTISELECT_REINJECT = prev
      }
    })

    it('fresh session: mints a uuid, exposes it via resumeSessionId, spawns with --session-id', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(session._sessionId, null, 'no uuid before start on a fresh session')
      assert.equal(session.resumeSessionId, null, 'resumeSessionId is null pre-start when fresh')
      await session.start()
      assert.ok(session._sessionId, 'a uuid is minted at start')
      assert.equal(session.resumeSessionId, session._sessionId,
        'resumeSessionId getter exposes the minted uuid for serializeState')
      const i = capturedArgs.indexOf('--session-id')
      assert.ok(i >= 0 && capturedArgs[i + 1] === session._sessionId, 'fresh spawn uses --session-id <uuid>')
      assert.equal(capturedArgs.includes('--resume'), false, 'fresh spawn must NOT use --resume')
      // Claude Code 2.1.186's "Claude in Chrome extension detected" prompt
      // interactively wedges the PTY; the TUI spawn must pass --no-chrome.
      assert.equal(capturedArgs.includes('--no-chrome'), true, 'TUI spawn passes --no-chrome')
    })

    // #6417 — the assertions above pin the *wholesale _spawnPty mock* (it
    // reconstructs the arg list), so dropping --no-chrome from the REAL method
    // would not fail them. This test runs the real _spawnPty against a capturing
    // node-pty stand-in (the _ptyModOverride seam), so drift on the real argv is
    // caught directly. The stub throws after capturing, which _spawnPty's own
    // spawn try-catch turns into an early return (no warmup, no live PTY).
    it('drift guard: the REAL _spawnPty argv carries --no-chrome (stubs only node-pty spawn)', async () => {
      ClaudeTuiSession.prototype._spawnPty = origSpawnPty // run the genuine method
      let realArgs = null
      let realCmd = null
      let errored = false
      session = new ClaudeTuiSession({ cwd: '/tmp', port: 12346, skillsDir: emptySkillsDir, repoSkillsDir: null })
      session.on('error', () => { errored = true }) // _spawnPty emits 'error' when our spawn throws
      session._sessionId = 'drift-guard-uuid'
      session._settingsPath = join(fakeHome, 'settings.json')
      session._ptyModOverride = {
        spawn: (cmd, args) => { realCmd = cmd; realArgs = args; throw new Error('captured-and-bail') },
      }
      await session._spawnPty(true)
      assert.ok(realArgs, 'the real _spawnPty invoked node-pty spawn (not a wholesale mock)')
      assert.ok(realCmd, 'spawn received a claude binary path')
      assert.equal(realArgs.includes('--no-chrome'), true,
        'the REAL _spawnPty argv carries --no-chrome — drift on the real method is now caught')
      assert.equal(realArgs.includes('--settings'), true, 'the real argv also carries --settings')
      // Clean-bail contract: the thrown spawn surfaces as an 'error' event and
      // leaves no live PTY behind (the catch returns before _term is assigned).
      assert.ok(errored, 'the spawn throw surfaces as an error event')
      assert.ok(!session._term, 'clean bail: no live PTY left behind after the throw')
    })

    it('restored session: seeds _sessionId from resumeSessionId, keeps it through start, spawns with --resume', async () => {
      const persisted = '11111111-2222-3333-4444-555555555555'
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345, skillsDir: emptySkillsDir, repoSkillsDir: null,
        resumeSessionId: persisted,
      })
      assert.equal(session._sessionId, persisted, 'constructor seeds _sessionId from the persisted resume id')
      assert.equal(session.resumeSessionId, persisted, 'getter round-trips the persisted id pre-start')
      await session.start()
      assert.equal(session._sessionId, persisted, 'start() must NOT overwrite the seeded uuid with a fresh one')
      const i = capturedArgs.indexOf('--resume')
      assert.ok(i >= 0 && capturedArgs[i + 1] === persisted, 'restore spawn uses --resume <persisted-uuid>')
      assert.equal(capturedArgs.includes('--session-id'), false, 'restore spawn must NOT re-use --session-id (claude rejects a reused id)')
    })

    it('blank/empty resumeSessionId is treated as fresh (back-compat with older state files)', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345, skillsDir: emptySkillsDir, repoSkillsDir: null,
        resumeSessionId: '',
      })
      assert.equal(session._sessionId, null, 'empty string does not seed a resume')
      assert.equal(session._resumedFromPersisted, false)
      await session.start()
      assert.ok(capturedArgs.includes('--session-id'), 'empty resume id falls back to a fresh --session-id spawn')
    })
  })

  describe('constructor', () => {
    it('defaults provider id to claude-tui', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(session._provider, 'claude-tui')
    })

    it('starts not-ready and idle', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(session._processReady, false)
      assert.equal(session._isBusy, false)
      assert.equal(session.sessionId, null)
    })

    it('generates a per-session hook secret when port is given', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(session._port, 12345)
      assert.ok(session._hookSecret, 'hook secret generated')
      assert.equal(typeof session._hookSecret, 'string')
      assert.equal(session._hookSecret.length, 64, '32 bytes hex = 64 chars')
    })

    it('omits hook secret when no port is provided (permission-less mode)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(session._port, null)
      assert.equal(session._hookSecret, null)
    })

    it('produces distinct hook secrets per session', () => {
      const a = new ClaudeTuiSession({ cwd: '/tmp', port: 1, skillsDir: emptySkillsDir, repoSkillsDir: null })
      const b = new ClaudeTuiSession({ cwd: '/tmp', port: 1, skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.notEqual(a._hookSecret, b._hookSecret, 'each session has its own secret')
    })
  })

  describe('start() — with mocked PTY spawn', () => {
    let fakeHome
    let origSpawnPty

    beforeEach(() => {
      // ensureCwdTrusted needs ~/.claude.json to read+write. Point HOME at a
      // temp dir with a minimal config.
      fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-home-'))
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
      process.env._ORIG_HOME = process.env.HOME
      process.env.HOME = fakeHome

      // Stub _spawnPty on the prototype so start() doesn't actually fork claude.
      // Sets a fake term so subsequent state assertions don't trip on null.
      origSpawnPty = ClaudeTuiSession.prototype._spawnPty
      ClaudeTuiSession.prototype._spawnPty = async function () {
        this._term = {
          write: () => {},
          kill: () => {},
          onData: () => {},
          onExit: () => {},
        }
      }
    })

    afterEach(() => {
      ClaudeTuiSession.prototype._spawnPty = origSpawnPty
      if (process.env._ORIG_HOME) {
        process.env.HOME = process.env._ORIG_HOME
        delete process.env._ORIG_HOME
      }
      if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    })

    it('pre-trusts the cwd in ~/.claude.json so the trust dialog is bypassed', async () => {
      const cwdReal = '/tmp'
      session = new ClaudeTuiSession({ cwd: cwdReal, skillsDir: emptySkillsDir, repoSkillsDir: null })

      let readyFired = false
      session.on('ready', () => { readyFired = true })
      await session.start()

      assert.equal(readyFired, true, 'start emits ready')
      assert.equal(session._processReady, true, 'session marked ready')

      const config = JSON.parse(readFileSync(join(fakeHome, '.claude.json'), 'utf8'))
      const projects = config.projects || {}
      const entries = Object.entries(projects).filter(([, v]) => v.hasTrustDialogAccepted === true)
      assert.ok(entries.length >= 1, 'at least one project entry was marked trusted')
      assert.ok(entries.some(([k]) => k.endsWith('/tmp') || k.includes('/tmp')),
        `expected a /tmp-ish trust entry, got: ${entries.map(([k]) => k).join(', ')}`)
    })

    it('is idempotent when cwd is already trusted AND onboarded (#5777)', async () => {
      const cwdReal = '/tmp'
      const initial = { projects: {} }
      const { realpathSync } = await import('fs')
      // #5777 FIX-2: the early-return now requires BOTH flags, so a fully
      // configured entry (trust + onboarding) must not be rewritten.
      initial.projects[realpathSync(cwdReal)] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify(initial))
      const before = readFileSync(join(fakeHome, '.claude.json'), 'utf8')

      session = new ClaudeTuiSession({ cwd: cwdReal, skillsDir: emptySkillsDir, repoSkillsDir: null })
      await session.start()

      const after = readFileSync(join(fakeHome, '.claude.json'), 'utf8')
      assert.equal(before, after, 'no rewrite when already trusted + onboarded')
    })

    it('adds hasCompletedProjectOnboarding to a trusted-but-unonboarded cwd (#5777 FIX-2)', async () => {
      const cwdReal = '/tmp'
      const initial = { projects: {} }
      const { realpathSync } = await import('fs')
      // Trusted but NOT onboarded — the worktree-isolation hole that rendered
      // claude's project-onboarding interstitial and swallowed the first prompt.
      initial.projects[realpathSync(cwdReal)] = { hasTrustDialogAccepted: true }
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify(initial))

      session = new ClaudeTuiSession({ cwd: cwdReal, skillsDir: emptySkillsDir, repoSkillsDir: null })
      await session.start()

      const config = JSON.parse(readFileSync(join(fakeHome, '.claude.json'), 'utf8'))
      const entry = config.projects[realpathSync(cwdReal)]
      assert.equal(entry.hasTrustDialogAccepted, true, 'trust preserved')
      assert.equal(entry.hasCompletedProjectOnboarding, true, 'onboarding flag added by FIX-2')
    })

    it('creates sink dir, writes settings.json, and assigns a session uuid', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      await session.start()
      assert.ok(session._sinkDir, 'sink dir set')
      assert.ok(existsSync(session._sinkDir), 'sink dir exists on disk')
      assert.ok(session._settingsPath, 'settings path set')
      assert.ok(existsSync(session._settingsPath), 'settings.json exists')
      assert.ok(session._sessionId, 'session uuid assigned at start (persistent process)')
      assert.match(session._sessionId, /^[0-9a-f-]{36}$/, 'looks like a uuid')
    })

    it('settings.json contains stop/pre/post hooks with mktemp filenames', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      await session.start()
      const settings = JSON.parse(readFileSync(session._settingsPath, 'utf8'))
      assert.ok(settings.hooks?.Stop, 'Stop hook present')
      assert.ok(settings.hooks?.PreToolUse, 'PreToolUse hook present')
      assert.ok(settings.hooks?.PostToolUse, 'PostToolUse hook present')
      const stopCmd = settings.hooks.Stop[0].hooks[0].command
      // Stop uses a $(...)-substituted unique name per turn (mktemp + .json
      // suffix breaks on BSD macOS — see writeHookSettings note).
      assert.match(stopCmd, /stop-\$\(uuidgen.*\)\.json/, 'Stop uses a $(...)-substituted unique-per-turn filename')
      // #6075: uuidgen is absent on minimal Debian/Ubuntu containers, so the
      // substitution MUST fall back to the kernel UUID source — otherwise every
      // turn collides on `stop-.json` and the poller drops all but the last.
      assert.match(stopCmd, /\/proc\/sys\/kernel\/random\/uuid/, 'uuid generation falls back to the kernel source when uuidgen is unavailable')
    })

    it('rejects + emits error if PTY exits during warmup (#5316)', async () => {
      // Override the stub for THIS test to simulate PTY death during warmup.
      ClaudeTuiSession.prototype._spawnPty = async function () {
        this._ptyExited = true
        this._ptyExitInfo = { exitCode: 1, signal: null }
      }

      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const errors = []
      const readys = []
      session.on('error', (e) => errors.push(e))
      session.on('ready', (e) => readys.push(e))
      // #5316 (WP-2.2) — start() must REJECT so SessionManager surfaces the
      // failure (previously it resolved + the dead session lingered as a zombie).
      await assert.rejects(session.start(), /exited during warmup/)

      assert.equal(session._processReady, false, 'not ready after PTY death')
      assert.equal(readys.length, 0, 'no ready emitted for a dead PTY')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /exited during warmup/)
    })

    it('rejects + never emits ready when _spawnPty leaves no live PTY (#5316)', async () => {
      // Mimic _spawnPty's early-return failure paths (node-pty import fail /
      // spawn throw): emit an error and return WITHOUT setting _ptyExited and
      // WITHOUT assigning a live _term. The old start() fell through these and
      // falsely emitted `ready` on a session with no process.
      ClaudeTuiSession.prototype._spawnPty = async function () {
        this.emit('error', { message: 'node-pty unavailable: boom' })
        this._term = null
      }

      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const readys = []
      session.on('error', () => {})
      session.on('ready', (e) => readys.push(e))
      await assert.rejects(session.start(), /failed to spawn/)

      assert.equal(session._processReady, false, 'not ready when no live PTY')
      assert.equal(readys.length, 0, 'no ready emitted for a session with no PTY')
    })

    it('resolves quietly (no ready) when destroy() races the spawn (#5316)', async () => {
      // destroy() sets _destroying mid-spawn; _spawnPty's post-spawn guard kills
      // the fresh PTY and nulls _term. This is a benign abort, NOT a start
      // failure to surface — start() must resolve without rejecting or emitting.
      ClaudeTuiSession.prototype._spawnPty = async function () {
        this._destroying = true
        this._term = null
      }

      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const readys = []
      session.on('error', () => {})
      session.on('ready', (e) => readys.push(e))
      await session.start() // must not reject

      assert.equal(session._processReady, false, 'not ready after destroy race')
      assert.equal(readys.length, 0, 'no ready emitted on a destroy-race abort')
    })
  })

  // #5321 (WP-4.1) — detect & surface a logged-out / expired subscription login
  // as a clear AUTH_REQUIRED error instead of a 90s silent warmup hang or a
  // generic stall/exit. The classifier matches claude's own logged-out output.
  describe('subscription auth failure detection (#5321 WP-4.1)', () => {
    function makeSession() {
      const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      s.on('error', () => {})
      return s
    }

    it('_scanOutputForAuthFailure matches claude\'s logged-out banner (command-token anchored)', () => {
      const s = makeSession()
      for (const sample of [
        'Invalid API key · Please run /login',
        'Please run /login to continue',
        'Please run `/login`',
        'You are signed out. Run claude login to authenticate.',
        // line-wrapped / box-padded banner still matches (whitespace-normalized)
        'Invalid API key ·\n   Please run\n   /login',
      ]) {
        s._outputTail = sample
        assert.ok(s._scanOutputForAuthFailure(), `should match: ${JSON.stringify(sample)}`)
      }
    })

    it('_scanOutputForAuthFailure does NOT match a model merely discussing auth (#5355 M1)', () => {
      const s = makeSession()
      // These are normal RESPONSE texts this user base produces constantly. The
      // command-token-anchored patterns must NOT mislabel them as AUTH_REQUIRED.
      for (const sample of [
        'If the user is not authenticated, return a 401.',
        'When authentication failed, redirect to the sign-in page.',
        'Your session token expired after 24h, so refresh it.',
        'An invalid API key triggers the retry path in the client.',
        'Add a not-logged-in guard before the dashboard route.',
        'Here is how to fix your code. The function returns a Promise.',
        '',
      ]) {
        s._outputTail = sample
        assert.ok(!s._scanOutputForAuthFailure(), `must NOT match: ${JSON.stringify(sample)}`)
      }
    })

    it('start() rejects with AUTH_REQUIRED when warmup classifies a logged-out session', async () => {
      const s = makeSession()
      // Stub _spawnPty to mimic a logged-out warmup: live PTY, never ready,
      // auth failure latched by the warmup scan.
      s._spawnPty = async function () {
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {}, on: () => {} }
        this._authFailureDetected = true
      }
      const errors = []
      const readys = []
      s.on('error', (e) => errors.push(e))
      s.on('ready', (e) => readys.push(e))

      await assert.rejects(s.start(), (err) => err.code === 'AUTH_REQUIRED')
      assert.equal(readys.length, 0, 'no ready emitted for a logged-out session')
      assert.equal(errors.length, 1)
      assert.equal(errors[0].code, 'AUTH_REQUIRED', 'AUTH_REQUIRED error surfaced')
      assert.match(errors[0].message, /claude login/, 'guidance included')
      assert.equal(s._processReady, false)
      await s.destroy() // start() created a sink dir under /tmp — clean it up
    })

    it('start() rejects with AUTH_REQUIRED when the warmup output (not the latch) shows logged-out', async () => {
      const s = makeSession()
      // _spawnPty leaves a live PTY + the login banner in the tail, but does not
      // set the latch (mimics the timeout-fallback path).
      s._spawnPty = async function () {
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {}, on: () => {} }
        this._outputTail = 'Invalid API key · Please run /login'
      }
      const errors = []
      s.on('error', (e) => errors.push(e))
      await assert.rejects(s.start(), (err) => err.code === 'AUTH_REQUIRED')
      assert.equal(errors[0].code, 'AUTH_REQUIRED')
      await s.destroy() // start() created a sink dir under /tmp — clean it up
    })

    it('_onPtyGone emits AUTH_REQUIRED when the PTY died with a logged-out banner', () => {
      const s = makeSession()
      const errors = []
      s.on('error', (e) => errors.push(e))
      s._outputTail = 'Invalid API key · Please run /login'
      s._onPtyGone({ exitCode: 1, signal: null }, 'exit') // no active turn

      const authErr = errors.find((e) => e.code === 'AUTH_REQUIRED')
      assert.ok(authErr, 'AUTH_REQUIRED surfaced on auth-related PTY death')
    })

    it('_handleStreamStall upgrades a stall to AUTH_REQUIRED when the tail shows logged-out', () => {
      const s = makeSession()
      s._isBusy = true
      s._currentMessageId = 'msg-auth'
      s._activeTurn = { startedAt: Date.now() - 100, synthSeq: 0 }
      s._term = { write: () => {}, kill: () => {} }
      s._outputTail = 'Invalid API key · Please run /login'
      const errors = []
      s.on('error', (e) => errors.push(e))

      s._handleStreamStall()
      const authErr = errors.find((e) => e.code === 'AUTH_REQUIRED')
      assert.ok(authErr, 'stall upgraded to AUTH_REQUIRED')
      assert.equal(s._isBusy, false, 'turn torn down')
    })

    it('_waitForPrompt short-circuits the warmup wait on a logged-out banner (#5355 m3 — no 90s hang)', async () => {
      const s = makeSession()
      // Real _waitForPrompt: a live pid + a never-ready session file, but the
      // login banner already in the tail. With detectAuthFailure it must bail on
      // the FIRST poll instead of burning the full timeout.
      s._term = { pid: 4242 }
      s._outputTail = 'Invalid API key · Please run /login'
      const origRead = ClaudeTuiSession.readSessionStatus
      ClaudeTuiSession.readSessionStatus = () => null // never reaches idle
      try {
        const startedAt = Date.now()
        const ready = await s._waitForPrompt(60_000, { detectAuthFailure: true })
        const elapsed = Date.now() - startedAt
        assert.equal(ready, false, 'not ready')
        assert.equal(s._authFailureDetected, true, 'auth failure latched')
        assert.ok(elapsed < 2_000, `short-circuited fast (elapsed=${elapsed}ms, not the 60s timeout)`)
      } finally {
        ClaudeTuiSession.readSessionStatus = origRead
      }
    })

    it('a logged-out respawn surfaces AUTH_REQUIRED instead of marking ready (#5355 M2)', async () => {
      const s = makeSession()
      // Pretend a prior start() ran; drive a respawn whose warmup classifies
      // a logged-out session (live PTY, latch set, not exited).
      s._sinkDir = '/tmp/fake-sink'
      s._settingsPath = '/tmp/fake-sink/settings.json'
      s._sessionId = 'conv-uuid-auth'
      s._spawnPty = async function () {
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {}, on: () => {} }
        this._authFailureDetected = true
      }
      const errors = []
      const readys = []
      const exhausted = []
      s.on('error', (e) => errors.push(e))
      s.on('ready', (e) => readys.push(e))
      s.on('respawn_exhausted', (e) => exhausted.push(e))

      await s._respawnPty()

      assert.equal(readys.length, 0, 'no ready emitted on a logged-out respawn')
      assert.ok(errors.some((e) => e.code === 'AUTH_REQUIRED'), 'AUTH_REQUIRED surfaced')
      assert.ok(exhausted.some((e) => e.reason === 'AUTH_REQUIRED'), 'respawn stops (no futile retry loop)')
      assert.equal(s._processReady, false, 'not marked ready while logged out')
      await s.destroy()
    })

    it('resolveAuth returns a well-formed auth descriptor (best-effort on-disk probe)', () => {
      const auth = ClaudeTuiSession.resolveAuth()
      assert.equal(auth.source, 'oauth')
      assert.equal(typeof auth.ready, 'boolean')
      assert.ok(typeof auth.hint === 'string' && auth.hint.length > 0)
      assert.ok(typeof auth.detail === 'string' && auth.detail.length > 0)
    })
  })

  // Audit P1-1 — per-turn teardown consolidation. The success path used to
  // hand-roll its clears and had drifted from _finishTurnError, omitting the
  // AskUserQuestion sibling-lock + stall-watchdog clears. _clearTurnEndState()
  // is the shared helper both now route through.
  describe('_clearTurnEndState (per-turn teardown helper)', () => {
    function makeSession() {
      const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      s.on('error', () => {})
      session = s
      return s
    }

    it('clears the busy triple, inactivity timers, AskUserQuestion lock and stall watchdogs', () => {
      const s = makeSession()
      // Arm a full turn's worth of per-turn state.
      s._isBusy = true
      s._currentMessageId = 'msg-1'
      s._activeTurn = { messageId: 'msg-1', startedAt: Date.now() - 50, aborted: false, synthSeq: 0 }
      s._resultTimeout = setTimeout(() => {}, 60_000)
      s._hardTimeout = setTimeout(() => {}, 60_000)
      s._streamStallTimeout = setTimeout(() => {}, 60_000)
      // A real sink dir with the sibling lock the permission hook leaves behind.
      s._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-'))
      const lockPath = join(s._sinkDir, 'askuserquestion-active')
      writeFileSync(lockPath, '1')
      // An armed per-toolUseId stall watchdog.
      s._askUserQuestionWatchdogs.set('tool-1', setTimeout(() => {}, 60_000))

      s._clearTurnEndState()

      assert.equal(s._isBusy, false, '_isBusy cleared')
      assert.equal(s._currentMessageId, null, '_currentMessageId cleared')
      assert.equal(s._activeTurn, null, '_activeTurn cleared')
      assert.equal(s._resultTimeout, null, 'result timer cleared')
      assert.equal(s._hardTimeout, null, 'hard timer cleared')
      assert.equal(s._streamStallTimeout, null, 'stream-stall timer cleared')
      assert.equal(existsSync(lockPath), false, 'askuserquestion-active sibling lock removed (#4604)')
      assert.equal(s._askUserQuestionWatchdogs.size, 0, 'all stall watchdogs cleared (#5319)')

      rmSync(s._sinkDir, { recursive: true, force: true })
    })

    it('clears the ephemeral intra-turn _pendingBackgroundCommands map (#4307 leak)', () => {
      const s = makeSession()
      s._isBusy = true
      s._currentMessageId = 'msg-1'
      s._activeTurn = { messageId: 'msg-1', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      // A run_in_background tool_use whose result never landed this turn.
      s._pendingBackgroundCommands.set('bg-tool-1', 'npm run dev')

      s._clearTurnEndState()

      assert.equal(s._pendingBackgroundCommands.size, 0,
        'stranded intra-turn command map dropped at turn-end, matching base _clearMessageState (#4307)')
    })

    it('does NOT touch the cross-turn background-shell tracker', () => {
      const s = makeSession()
      // The _backgroundShellTracker is the cross-turn "waiting on shell" state —
      // transient-by-design and quiesced separately, never per-turn-cleared here.
      assert.ok(s._backgroundShellTracker, 'tracker exists')
      const trackerBefore = s._backgroundShellTracker
      s._isBusy = true
      s._activeTurn = { messageId: 'm', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      s._clearTurnEndState()
      assert.strictEqual(s._backgroundShellTracker, trackerBefore, 'tracker instance untouched')
    })

    it('is idempotent (safe to call when nothing is armed)', () => {
      const s = makeSession()
      assert.doesNotThrow(() => { s._clearTurnEndState(); s._clearTurnEndState() })
      assert.equal(s._isBusy, false)
      assert.equal(s._askUserQuestionWatchdogs.size, 0)
    })

    // End-to-end linkage (review #5862): prove a REAL teardown path routes
    // through the helper, so a refactor that drops the _clearTurnEndState() call
    // from a turn-end path is caught — not just the helper-in-isolation test.
    it('_finishTurnError routes through the helper (clears lock, watchdogs, bg map, busy triple)', () => {
      const s = makeSession()
      s._isBusy = true
      s._currentMessageId = 'msg-err'
      s._activeTurn = { messageId: 'msg-err', startedAt: Date.now() - 10, aborted: false, synthSeq: 0 }
      s._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-'))
      const lockPath = join(s._sinkDir, 'askuserquestion-active')
      writeFileSync(lockPath, '1')
      s._askUserQuestionWatchdogs.set('tool-1', setTimeout(() => {}, 60_000))
      s._pendingBackgroundCommands.set('bg-1', 'sleep 99')

      s._finishTurnError('boom', 'msg-err')

      assert.equal(s._isBusy, false, '_finishTurnError cleared busy via the helper')
      assert.equal(s._currentMessageId, null)
      assert.equal(s._activeTurn, null)
      assert.equal(existsSync(lockPath), false, 'AskUserQuestion lock cleared')
      assert.equal(s._askUserQuestionWatchdogs.size, 0, 'stall watchdogs cleared')
      assert.equal(s._pendingBackgroundCommands.size, 0, 'intra-turn bg map cleared')

      rmSync(s._sinkDir, { recursive: true, force: true })
    })
  })

  // #5322 (WP-4.2, security) — the PTY diagnostic dumps (hex + readable tail)
  // ride into log lines AND client-facing `error` events. A pasted/echoed OAuth
  // token or API key in claude's output must not leak through them.
  describe('credential redaction in PTY diagnostics (#5322 WP-4.2)', () => {
    function makeSession() {
      const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      s.on('error', () => {})
      return s
    }

    it('_outputTailHexDump redacts a token-shaped run in BOTH the hex and ASCII columns', () => {
      const s = makeSession()
      // 44 A's keeps the token ≥40 chars (matches the sk-ant pattern) while
      // placing the trailing escape mid-row so its 4 hex bytes stay on one line
      // (length-preserving X-redaction doesn't shift the escape's position).
      const token = 'sk-ant-api03-' + 'A'.repeat(44)
      // Include an escape byte to prove control bytes survive the latin1 round-trip.
      s._outputTailRaw = Buffer.from(`Invalid API key ${token}\x1b[0m done`, 'latin1')
      const dump = s._outputTailHexDump()

      assert.ok(!dump.includes(token), 'raw token absent from the ASCII column')
      // The token's leading bytes ("sk-ant" → 73 6b 2d 61 6e 74) must be gone too.
      // (Fixture is sized so "sk-ant" lands within one 16-byte hex row.)
      const prefixHex = Buffer.from('sk-ant', 'latin1').toString('hex').match(/../g).join(' ')
      assert.ok(!dump.replace(/\s+/g, ' ').includes(prefixHex), 'token hex bytes absent from the hex column')
      // Token chars are scrubbed to 'X' (0x58) — the 'A' body run (0x41) is gone.
      assert.ok(!dump.replace(/\s+/g, ' ').includes('41 41 41 41 41 41'), 'token body bytes scrubbed (redacted)')
      // The full escape RUN `\x1b[0m` (1b 5b 30 6d) survives — proves redaction
      // scrubbed only the token, not the control bytes the dump exists to show.
      assert.ok(dump.replace(/\s+/g, ' ').includes('1b 5b 30 6d'), 'escape sequence preserved — diagnostic value intact')
    })

    it('_outputTailHexDump does not leak the tail of a MARKER-PREFIXED split token (#5358 Copilot)', () => {
      const s = makeSession()
      // The bypass: `token=<sk-ant head>\x1b...<tail>`. If redactSensitive ran
      // first it would collapse `token=sk-ant-AAAA` → `token= [REDACTED]`,
      // consuming the marker so the escape-aware pass couldn't reassemble the
      // run — leaking the BBBB tail. Using the escape-aware pass alone fixes it.
      const head = 'sk-ant-api03-' + 'A'.repeat(20)
      const tail = 'B'.repeat(30)
      s._outputTailRaw = Buffer.from(`token=${head}\x1b[1m${tail} end`, 'latin1')
      const dumpNorm = s._outputTailHexDump().replace(/\s+/g, ' ')
      // The tail "BBBB…" (0x42 run) must NOT survive after the escape.
      assert.ok(!dumpNorm.includes('42 42 42 42 42 42'), 'split-token TAIL must not leak past the escape')
      assert.ok(!dumpNorm.includes('41 41 41 41 41 41'), 'split-token HEAD redacted too')
      assert.ok(dumpNorm.includes('1b 5b 31 6d'), 'escape sequence preserved')
    })

    it('_outputTailHexDump redacts an ANSI-SPLIT token the contiguous patterns miss (#5358)', () => {
      const s = makeSession()
      // A token split mid-run by a CSI escape — the contiguous redactor sees
      // each half as too short (sk-ant-api03- + only 20 chars before the escape,
      // 30 after), so pre-#5358 the secret leaked in the dump.
      const head = 'sk-ant-api03-' + 'Z'.repeat(20)
      const tail = 'Z'.repeat(30)
      // "auth " (5 bytes) then "sk-ant" so its hex lands inside the first row.
      s._outputTailRaw = Buffer.from(`auth ${head}\x1b[1m${tail} end`, 'latin1')
      const dumpNorm = s._outputTailHexDump().replace(/\s+/g, ' ')

      // Meaningful (hex-column) check — the formatted dump wraps every 16 bytes,
      // so a string-contains check on the token would be vacuous. The "sk-ant"
      // bytes (73 6b 2d 61 6e 74) and the token's Z-run (5a) must be scrubbed to
      // 'X' (58); without the escape-preserving layer they'd survive split.
      assert.ok(!dumpNorm.includes('73 6b 2d 61 6e 74'), 'token "sk-ant" hex bytes scrubbed from the hex column')
      assert.ok(!dumpNorm.includes('5a 5a 5a 5a 5a 5a'), 'token Z-byte run scrubbed (no leaked token bytes)')
      // The escape RUN `\x1b[1m` (1b 5b 31 6d) survives — only token chars scrubbed.
      assert.ok(dumpNorm.includes('1b 5b 31 6d'), 'escape sequence preserved — diagnostic value intact')
    })

    it('_outputTailDiagnostic redacts a token-shaped run (client-facing error path)', () => {
      const s = makeSession()
      const token = 'sk-ant-api03-' + 'B'.repeat(50)
      s._outputTail = `something went wrong: ${token} — retrying`
      const diag = s._outputTailDiagnostic()
      assert.ok(!diag.includes(token), 'token redacted from the readable diagnostic')
      assert.ok(diag.includes('[REDACTED]'), 'redaction marker present')
    })

    it('_outputTailDiagnostic redacts a token straddling the slice boundary (#5357 review)', () => {
      const s = makeSession()
      const token = 'sk-ant-api03-' + 'C'.repeat(50)
      // Put the token near the END so its PREFIX falls before the last
      // PTY_TAIL_DIAGNOSTIC_BYTES and only its tail would survive a slice-first
      // approach. Redact-before-slice must still scrub it entirely.
      const pad = 'x '.repeat(ClaudeTuiSession.PTY_TAIL_DIAGNOSTIC_BYTES)
      s._outputTail = `${pad} ${token} tail`
      const diag = s._outputTailDiagnostic()
      assert.ok(!diag.includes(token), 'full token redacted despite straddling the slice boundary')
      // No partial token fragment leaks either (no run of the C-filler survives).
      assert.ok(!/C{20,}/.test(diag), 'no partial-token fragment leaked')
    })
  })

  // #5323 (WP-5.1) — bound the per-session sink dir + _consumedFiles over a
  // long-lived PTY (unlink consumed hook files), and sweep sink dirs orphaned
  // by prior crashes at boot.
  describe('hook-sink bounding + stale-dir sweep (#5323 WP-5.1)', () => {
    it('unlinks consumed hook files and prunes _consumedFiles', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-unlink'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-unlink-'))
      session._waitForPrompt = async () => true
      session._term = {
        write: () => {
          // Drop a pre- tool hook AND a stop hook so the poll loop processes the
          // pre then completes the turn.
          writeFileSync(join(session._sinkDir, 'pre-aaa.json'), JSON.stringify({
            tool_use_id: 'toolu_a', tool_name: 'Bash', tool_input: { command: 'ls' },
          }))
          writeFileSync(join(session._sinkDir, 'stop-bbb.json'), JSON.stringify({ last_assistant_message: 'done' }))
        },
        kill: () => {},
      }
      session.on('error', () => {})
      await session.sendMessage('hi')

      assert.ok(!existsSync(join(session._sinkDir, 'pre-aaa.json')), 'consumed pre- hook unlinked')
      assert.ok(!existsSync(join(session._sinkDir, 'stop-bbb.json')), 'consumed stop- hook unlinked')
      assert.equal(session._consumedFiles.size, 0, '_consumedFiles pruned after successful unlink')
    })

    // #6132 (HOL fix from #5337): the drain hot path is now async fs, processing
    // its file batch with `await` between each readFile/unlink. Lock in that the
    // causal prefix ordering (pre- before post-, see #3902) survives the
    // sequential-await rewrite — the regression the async migration most risks.
    it('emits a multi-file drain pass in causal order (pre→post) under async fs (#6132)', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-order-6132'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-order-'))
      session._waitForPrompt = async () => true
      const events = []
      session.on('tool_start', (e) => events.push(`start:${e.toolUseId}`))
      session.on('tool_result', (e) => events.push(`result:${e.toolUseId}`))
      session._term = {
        write: () => {
          // Write post- BEFORE pre- on disk: a naive lex sort would order
          // "post-" ahead of "pre-" ('o' < 'r'), which is exactly the #3902
          // bug. The prefix-ordered drain must still emit tool_start (pre)
          // before tool_result (post) even though both land in one async pass.
          writeFileSync(join(session._sinkDir, 'post-x.json'), JSON.stringify({
            tool_use_id: 'toolu_x', tool_name: 'Bash', tool_response: { stdout: 'ok' },
          }))
          writeFileSync(join(session._sinkDir, 'pre-x.json'), JSON.stringify({
            tool_use_id: 'toolu_x', tool_name: 'Bash', tool_input: { command: 'ls' },
          }))
          writeFileSync(join(session._sinkDir, 'stop-z.json'), JSON.stringify({ last_assistant_message: 'done' }))
        },
        kill: () => {},
      }
      session.on('error', () => {})
      await session.sendMessage('hi')

      const startIdx = events.indexOf('start:toolu_x')
      const resultIdx = events.indexOf('result:toolu_x')
      assert.ok(startIdx >= 0, 'tool_start emitted')
      assert.ok(resultIdx >= 0, 'tool_result emitted')
      assert.ok(startIdx < resultIdx, 'tool_start precedes tool_result despite post- sorting first on disk')
      // Every consumed hook in the pass is unlinked (async unlink path).
      assert.ok(!existsSync(join(session._sinkDir, 'pre-x.json')), 'pre- unlinked')
      assert.ok(!existsSync(join(session._sinkDir, 'post-x.json')), 'post- unlinked')
      assert.ok(!existsSync(join(session._sinkDir, 'stop-z.json')), 'stop- unlinked')
    })

    // #6178: per-session self-recovery — the hot-path fs ops are bounded so a
    // stuck sink fs can't wedge the turn that owns it (the cross-session win was
    // #6132; this is the single-session follow-up).
    it('self-recovers from a hung sink fs instead of wedging the turn (#6178)', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 400,
      })
      session._processReady = true
      session._sessionId = 'test-hung-fs-6178'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-hung-'))
      session._waitForPrompt = async () => true
      session._hookFsTimeoutMs = 40
      // Simulate a frozen mount: readdir never resolves. Pre-fix, the poll loop
      // would await this forever on the first pass and wedge until the PTY died
      // (the while-guard never re-evaluated). Post-fix, each pass rejects at
      // _hookFsTimeoutMs, the loop keeps iterating, and the hard-timeout watchdog
      // ends the turn. If the fix regressed, this test HANGS (node:test timeout).
      let readdirCalls = 0
      session._hookReaddir = () => { readdirCalls++; return new Promise(() => {}) }
      session._term = { write: () => {}, kill: () => {} }
      session.on('error', () => {})
      const start = Date.now()
      await session.sendMessage('hi')
      const elapsed = Date.now() - start
      assert.ok(elapsed < 3000, `turn self-terminated (${elapsed}ms), not wedged on the frozen readdir`)
      assert.equal(session._isBusy, false, 'busy cleared — the next turn isn\'t wedged')
      // #6178 (review): the stuck readdir is COALESCED — re-raced, not re-issued.
      // Across the multiple poll passes before the hard timeout, the underlying
      // op is started exactly once, so it can't pile up stuck libuv threadpool
      // work and exhaust the shared pool (which would re-block other sessions).
      assert.equal(readdirCalls, 1, 'frozen readdir issued once, not once-per-pass')
      rmSync(session._sinkDir, { recursive: true, force: true })
    })

    // #6178: the bound primitive itself.
    describe('withHookFsTimeout', () => {
      it('rejects with a tagged HOOK_FS_TIMEOUT after the bound on a stuck promise', async () => {
        const start = Date.now()
        await assert.rejects(
          () => withHookFsTimeout(new Promise(() => {}), 30, 'readdir'),
          (err) => err.code === 'HOOK_FS_TIMEOUT' && /readdir/.test(err.message),
        )
        assert.ok(Date.now() - start < 1000, 'rejected promptly at the bound, not hung')
      })

      it('resolves with the value when the promise settles before the bound', async () => {
        const v = await withHookFsTimeout(Promise.resolve(['a.json', 'b.json']), 1000, 'readdir')
        assert.deepEqual(v, ['a.json', 'b.json'])
      })

      it('propagates the underlying rejection (not a timeout) when the promise rejects first', async () => {
        await assert.rejects(
          () => withHookFsTimeout(Promise.reject(new Error('ENOENT: gone')), 1000, 'readFile'),
          (err) => /ENOENT/.test(err.message) && err.code !== 'HOOK_FS_TIMEOUT',
        )
      })
    })

    describe('sweepStaleSinkDirs', () => {
      const DEAD_PID = 4242424 // deterministically reported dead via the stub below
      let created
      let realKill
      beforeEach(() => {
        created = []
        // #5359 review — deterministic dead-pid (don't rely on 999999 being
        // unused; Linux pid_max can be in the millions). Stub process.kill to
        // ESRCH for DEAD_PID and delegate everything else to the real probe.
        realKill = process.kill.bind(process)
        mock.method(process, 'kill', (pid, sig) => {
          if (pid === DEAD_PID) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e }
          return realKill(pid, sig)
        })
      })
      afterEach(() => {
        mock.restoreAll()
        for (const d of created) rmSync(d, { recursive: true, force: true })
      })

      function makeSinkDir(suffix, pidContent, { ageMs = 0 } = {}) {
        const base = join(tmpdir(), 'chroxy-claude-tui')
        mkdirSync(base, { recursive: true })
        const dir = join(base, `s-${suffix}-${process.pid}-${Math.random().toString(36).slice(2)}`)
        mkdirSync(dir, { recursive: true })
        if (pidContent !== undefined) writeFileSync(join(dir, 'owner.pid'), pidContent)
        if (ageMs > 0) {
          const t = new Date(Date.now() - ageMs)
          utimesSync(dir, t, t)
        }
        created.push(dir)
        return dir
      }

      it('keeps live-pid dirs, sweeps dead-pid dirs, and sweeps only AGED pidfile-less dirs', () => {
        const liveDir = makeSinkDir('live', String(process.pid))             // our pid — alive
        const deadDir = makeSinkDir('dead', String(DEAD_PID))                // stubbed ESRCH → swept
        const freshOrphan = makeSinkDir('fresh-orphan')                       // no pidfile, new → kept (grace)
        const oldOrphan = makeSinkDir('old-orphan', undefined, { ageMs: ClaudeTuiSession.SINK_SWEEP_GRACE_MS + 60_000 })

        const result = ClaudeTuiSession.sweepStaleSinkDirs({ info() {}, warn() {} })

        assert.ok(existsSync(liveDir), 'live-pid dir kept')
        assert.ok(!existsSync(deadDir), 'dead-pid dir swept')
        assert.ok(existsSync(freshOrphan), 'fresh pidfile-less dir kept (mid-creation grace)')
        assert.ok(!existsSync(oldOrphan), 'aged pidfile-less dir swept')
        assert.ok(result.swept >= 2, 'reported the swept dirs')
        assert.ok(result.kept >= 2, 'reported the kept dirs (live + fresh orphan)')
      })

      it('returns zero counts (no throw) when the base dir does not exist', () => {
        // Genuinely exercise the missing-base catch: remove the base dir first.
        rmSync(join(tmpdir(), 'chroxy-claude-tui'), { recursive: true, force: true })
        const result = ClaudeTuiSession.sweepStaleSinkDirs({ info() {}, warn() {} })
        assert.deepEqual(result, { swept: 0, kept: 0 })
      })
    })
  })

  // #5315 (WP-2.1) — bounded per-session PTY auto-respawn. When the persistent
  // claude PTY dies unexpectedly mid-session, the session must self-heal
  // (bounded backoff, max 5 attempts) instead of becoming a permanently
  // input-rejecting zombie. Mirrors CliSession's respawn. Tests stub _spawnPty
  // on the prototype and drive mock.timers so no real claude is spawned and no
  // real backoff delay is waited.
  describe('PTY auto-respawn (#5315 WP-2.1)', () => {
    beforeEach(() => {
      mock.timers.enable({ apis: ['setTimeout'] })
    })
    afterEach(() => {
      mock.timers.reset()
    })

    // Build a session with _spawnPty stubbed to succeed (live term, not exited).
    // `onSpawn` lets a test observe / mutate each spawn (e.g. count calls,
    // capture the idArgs, or make the respawn die again). `ctorOpts` are merged
    // into the constructor opts — pass `resumeSessionId` to exercise the REAL
    // restore-seeding path (#5348: sets `_seededFromPersisted` in the ctor)
    // instead of poking the private flags.
    function makeSession(onSpawn, ctorOpts = {}) {
      const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null, ...ctorOpts })
      s._spawnPty = async function () {
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {}, on: () => {} }
        if (onSpawn) onSpawn(this)
      }
      // Pretend start() already ran: sink/settings/secret exist, PTY is live.
      s._sinkDir = '/tmp/fake-sink'
      s._settingsPath = '/tmp/fake-sink/settings.json'
      if (!ctorOpts.resumeSessionId) {
        // Fresh-session shape: start() minted the uuid (ctor left it null).
        s._sessionId = 'conv-uuid-1234'
        s._resumedFromPersisted = false
      }
      s._processReady = true
      // EventEmitter throws on an unhandled 'error'; _onPtyGone emits one on
      // the no-active-turn death path. Swallow by default — tests that assert
      // on errors add their own listener (additive, both fire).
      s.on('error', () => {})
      return s
    }

    // #5417 — mimic the real _spawnPty tail lifecycle for a dying spawn: the
    // real method resets both output tails at the top of every spawn, then the
    // child's dying output (the PTY merges stdout+stderr, so claude's
    // "No conversation found with session ID …" resume rejection lands here)
    // accumulates via onData before _onPtyGone fires. Tests stub _spawnPty, so
    // the stub has to reproduce that reset+append ordering itself.
    function dieWithTail(self, text) {
      self._outputTail = ''
      self._outputTailRaw = Buffer.alloc(0)
      if (text) self._appendToOutputTail(text)
      self._onPtyGone({ exitCode: 1, signal: null }, 'exit')
    }

    it('an unexpected PTY death schedules a respawn that re-invokes _spawnPty', async () => {
      let spawnCalls = 0
      session = makeSession(() => { spawnCalls++ })
      // Simulate the unexpected death (onExit path).
      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      assert.equal(session._respawnScheduled, true, 'a respawn is scheduled after unexpected death')
      assert.equal(session._respawnCount, 1, 'first attempt counted')

      // Advance the first backoff (1000ms) and let the async _respawnPty settle.
      mock.timers.tick(1000)
      await new Promise((r) => setImmediate(r))

      assert.equal(spawnCalls, 1, '_spawnPty re-invoked by the respawn')
      assert.equal(session._processReady, true, 'session is ready again after a successful respawn')
      assert.equal(session._respawnCount, 0, 'respawn count resets after a successful respawn that stays alive')
    })

    it('re-emits ready on a successful respawn so the dashboard knows it recovered', async () => {
      session = makeSession()
      const readies = []
      session.on('ready', (d) => readies.push(d))
      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      mock.timers.tick(1000)
      await new Promise((r) => setImmediate(r))
      assert.equal(readies.length, 1, 'ready re-emitted once on recovery')
      assert.equal(readies[0].sessionId, 'conv-uuid-1234', 'ready carries the preserved conversation id')
    })

    it('respawn uses --resume (not --session-id) to continue the conversation', async () => {
      let capturedArgs = null
      // Capture the idArgs _spawnPty would build from _resumedFromPersisted.
      session = makeSession((self) => {
        capturedArgs = self._resumedFromPersisted
          ? ['--resume', self._sessionId]
          : ['--session-id', self._sessionId]
      })
      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      mock.timers.tick(1000)
      await new Promise((r) => setImmediate(r))

      assert.equal(session._resumedFromPersisted, true, 'respawn flips _resumedFromPersisted so idArgs picks --resume')
      assert.ok(capturedArgs.includes('--resume'), 'respawn spawns with --resume')
      assert.equal(capturedArgs.includes('--session-id'), false, 'respawn must NOT reuse --session-id (claude rejects a reused id)')
      const i = capturedArgs.indexOf('--resume')
      assert.equal(capturedArgs[i + 1], 'conv-uuid-1234', 'respawn resumes the SAME (not a new) conversation uuid')
    })

    it('resets the _ptyExited guard so a SECOND death after respawn tears down again', async () => {
      let spawnCalls = 0
      session = makeSession(() => { spawnCalls++ })
      // First death → respawn.
      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      mock.timers.tick(1000)
      await new Promise((r) => setImmediate(r))
      assert.equal(session._ptyExited, false, 'guard reset after a successful respawn')
      assert.equal(spawnCalls, 1)

      // Second, independent death — must NOT be swallowed by a latched guard.
      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      assert.equal(session._ptyExited, true, 'second death tears down again (guard was reset)')
      assert.equal(session._respawnScheduled, true, 'second death schedules another respawn')
      mock.timers.tick(1000)
      await new Promise((r) => setImmediate(r))
      assert.equal(spawnCalls, 2, 'second death triggers a second respawn')
    })

    it('after 5 attempts a RESTORED session whose deaths carry NO resume-failure tail exhausts and stops (no infinite loop)', async () => {
      let spawnCalls = 0
      // Every respawn dies again during warmup → drives toward the cap. In
      // production the wired onExit/close handlers call _onPtyGone when the PTY
      // dies; the stub mimics that so the same scheduling path runs.
      // #5348/#5417 — the deaths here leave NO resume-failure diagnostic in the
      // PTY tail, so claude never confirmed the conversation id is unknown. A
      // restored session must NOT fall back to a fresh conversation on an
      // unconfirmed cause (the conversation may still exist — e.g. claude
      // crashing while loading it): exhaustion after exactly 5 attempts is the
      // honest outcome. Seed through the REAL ctor path (resumeSessionId opt)
      // so the restore wiring is what's under test, not a poked flag.
      session = makeSession((self) => {
        spawnCalls++
        self._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      }, { resumeSessionId: 'conv-uuid-1234' })
      assert.equal(session._seededFromPersisted, true, 'ctor seeds _seededFromPersisted from resumeSessionId')
      const errors = []
      const exhausted = []
      session.on('error', (e) => errors.push(e))
      session.on('respawn_exhausted', (d) => exhausted.push(d))

      // Initial unexpected death.
      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      // Drain all five backoffs (1,2,4,8,15s) — each respawn dies and the dead
      // _spawnPty calls _onPtyGone which schedules the next attempt.
      const delays = [1000, 2000, 4000, 8000, 15000]
      for (const d of delays) {
        mock.timers.tick(d)
        await new Promise((r) => setImmediate(r))
      }
      // One more tick to be sure nothing else is scheduled.
      mock.timers.tick(15000)
      await new Promise((r) => setImmediate(r))

      assert.equal(spawnCalls, 5, 'exactly 5 respawn attempts, then it gives up')
      assert.equal(exhausted.length, 1, 'respawn_exhausted emitted exactly once')
      assert.ok(errors.some((e) => e.code === 'pty_respawn_exhausted'), 'a categorized fatal error is emitted on exhaustion')
      assert.equal(errors.every((e) => e.code !== 'resume_unknown'), true, 'a restored session never falls back to a fresh conversation')
      assert.equal(session._sessionId, 'conv-uuid-1234', 'the restored conversation id is never replaced')
      assert.equal(session._respawnScheduled, false, 'no further respawn is scheduled after exhaustion')
    })

    // #5348 — drop-and-retry-FRESH fallback: an originally-fresh session whose
    // conversation was never persisted makes every --resume respawn doomed
    // (claude can't find it → exits during warmup). At the 5-attempt cap the
    // session gets ONE extra attempt with a brand-new --session-id before
    // giving up, instead of burning to exhaustion on a futile resume.
    // #5417 — the fallback now additionally requires the dying PTY tail to
    // CONFIRM the resume id is unknown (claude's own "No conversation found"
    // rejection), so the doomed resumes here die with that diagnostic in the
    // tail, exactly as the real claude TUI renders it before exiting.
    it('an originally-fresh session retries FRESH on the FIRST confirmed unknown-resume death, then exhausts if the fresh attempt also dies (#6576/#5348/#5417)', async () => {
      const spawns = []
      session = makeSession((self) => {
        spawns.push({ resumed: self._resumedFromPersisted, id: self._sessionId })
        dieWithTail(self, self._resumedFromPersisted
          ? `No conversation found with session ID: ${self._sessionId}`
          : null)
      })
      const errors = []
      const exhausted = []
      session.on('error', (e) => errors.push(e))
      session.on('respawn_exhausted', (d) => exhausted.push(d))

      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      // #6576: the FIRST respawn dies with claude's "No conversation found" tail →
      // retry FRESH immediately (no 5-respawn cap wait). The fresh attempt here also
      // dies (null tail) → one-shot latch → exhaust. Two spawns total, not six.
      for (const d of [1000, 2000, 4000]) {
        mock.timers.tick(d)
        await new Promise((r) => setImmediate(r))
      }

      assert.equal(spawns.length, 2, 'one doomed --resume attempt + exactly one fresh fallback attempt (no 5-respawn cap wait)')
      assert.equal(spawns[0].resumed, true, 'first respawn --resumes the original conversation')
      assert.equal(spawns[0].id, 'conv-uuid-1234')
      assert.equal(spawns[1].resumed, false, 'the fallback attempt spawns FRESH (--session-id, not --resume)')
      assert.notEqual(spawns[1].id, 'conv-uuid-1234', 'the fallback attempt mints a brand-new conversation uuid')
      const resumeUnknown = errors.filter((e) => e.code === 'resume_unknown')
      assert.equal(resumeUnknown.length, 1, 'one loud resume_unknown error so the dashboard can render "starting fresh"')
      assert.equal(resumeUnknown[0].attemptedResumeId, 'conv-uuid-1234', 'the error carries the abandoned conversation id')
      assert.equal(exhausted.length, 1, 'when the fresh attempt also dies, the session exhausts (one-shot latch, no loop)')
      // Failed-fallback exhaustion escalates with CliSession's terminal code so
      // the dashboard renders the "auto-recovery exhausted" affordance.
      assert.equal(exhausted[0].reason, 'resume_unknown_exhausted')
      const terminal = errors.find((e) => e.code === 'resume_unknown_exhausted')
      assert.ok(terminal, 'terminal error carries the resume_unknown_exhausted code')
      assert.equal(terminal.attemptedResumeId, 'conv-uuid-1234', 'terminal error carries the abandoned conversation id')
      assert.equal(session._respawnScheduled, false, 'no further respawn after exhaustion')
    })

    it('a retry-FRESH attempt that survives warmup re-emits ready with the new uuid and re-arms the latch (#6576/#5348)', async () => {
      let spawnCalls = 0
      // #6576: the FIRST respawn dies during warmup with claude's resume rejection
      // in the tail (#5417) → retry FRESH immediately; the fresh fallback (spawn #2)
      // survives. No 5-respawn cap wait.
      session = makeSession((self) => {
        spawnCalls++
        if (spawnCalls === 1) dieWithTail(self, `No conversation found with session ID: ${self._sessionId}`)
      })
      const readies = []
      session.on('ready', (d) => readies.push(d))

      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      for (const d of [1000, 2000, 4000]) {
        mock.timers.tick(d)
        await new Promise((r) => setImmediate(r))
      }

      assert.equal(spawnCalls, 2, 'one doomed --resume respawn + one fresh fallback that survives (no 5-respawn cap wait)')
      assert.equal(readies.length, 1, 'ready re-emitted once the fresh attempt survives warmup')
      assert.notEqual(readies[0].sessionId, 'conv-uuid-1234', 'ready carries the NEW conversation uuid (persistence picks it up via the resumeSessionId getter)')
      assert.equal(readies[0].sessionId, session._sessionId, 'emitted id matches the live session id')
      assert.equal(session._respawnCount, 0, 'retry budget restored after the surviving warmup')
      assert.equal(session._didFallbackFromUnknownResume, false, 'one-shot latch re-armed on success (a FUTURE doomed-resume window may fall back again)')
      assert.equal(session._processReady, true)
    })

    // #5417 — the blunt "5 warmup deaths" trigger alone is NOT enough: a fresh
    // session crash-looping for an unrelated cause (OOM, broken install,
    // corrupted-but-present conversation file) never had its conversation
    // confirmed missing, so abandoning the id would discard real context a
    // fresh spawn may not even fix. No tail match → honest exhaustion.
    it('an originally-fresh session whose deaths carry NO resume-failure tail exhausts WITHOUT the retry-FRESH fallback (#5417)', async () => {
      let spawnCalls = 0
      session = makeSession((self) => {
        spawnCalls++
        // Unrelated crash diagnostic — must not match the resume patterns.
        dieWithTail(self, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory')
      })
      const errors = []
      const exhausted = []
      session.on('error', (e) => errors.push(e))
      session.on('respawn_exhausted', (d) => exhausted.push(d))

      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      for (const d of [1000, 2000, 4000, 8000, 15000]) {
        mock.timers.tick(d)
        await new Promise((r) => setImmediate(r))
      }
      mock.timers.tick(15000)
      await new Promise((r) => setImmediate(r))

      assert.equal(spawnCalls, 5, 'exactly 5 respawn attempts — no extra fresh attempt without a confirming tail')
      assert.equal(errors.some((e) => e.code === 'resume_unknown'), false, 'no resume_unknown fallback on an unconfirmed cause')
      assert.ok(errors.some((e) => e.code === 'pty_respawn_exhausted'), 'plain exhaustion code (not resume_unknown_exhausted)')
      assert.equal(exhausted.length, 1)
      assert.equal(exhausted[0].reason, 'pty_respawn_exhausted')
      assert.equal(session._sessionId, 'conv-uuid-1234', 'the conversation id is never abandoned without confirmation')
      assert.equal(session._respawnScheduled, false, 'no further respawn after exhaustion')
    })

    // #5417 — CliSession parity for RESTORED sessions: when claude itself
    // reports the persisted conversation id as unknown (wiped
    // ~/.claude/projects/, state file copied from another machine), burning 5
    // doomed resumes and destroying the session helps nobody. With the tail
    // CONFIRMING the conversation is gone, the restored session now gets the
    // same loud one-shot retry-FRESH fallback an originally-fresh session gets.
    it('a RESTORED session falls back loudly when the tail confirms the conversation id is unknown (#5417)', async () => {
      const spawns = []
      session = makeSession((self) => {
        spawns.push({ resumed: self._resumedFromPersisted, id: self._sessionId })
        dieWithTail(self, self._resumedFromPersisted
          ? `No conversation found with session ID: ${self._sessionId}`
          : null)
      }, { resumeSessionId: 'restored-uuid-9999' })
      assert.equal(session._seededFromPersisted, true, 'ctor seeds _seededFromPersisted from resumeSessionId')
      const errors = []
      const exhausted = []
      session.on('error', (e) => errors.push(e))
      session.on('respawn_exhausted', (d) => exhausted.push(d))

      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      // #6576: the FIRST respawn dies with claude's "No conversation found" tail →
      // retry FRESH immediately; the fresh attempt also dies (null tail) → exhaust.
      for (const d of [1000, 2000, 4000]) {
        mock.timers.tick(d)
        await new Promise((r) => setImmediate(r))
      }

      assert.equal(spawns.length, 2, 'one doomed --resume attempt + exactly one fresh fallback attempt (no 5-respawn cap wait)')
      assert.equal(spawns[0].resumed, true, 'first respawn --resumes the restored conversation')
      assert.equal(spawns[0].id, 'restored-uuid-9999')
      assert.equal(spawns[1].resumed, false, 'the fallback attempt spawns FRESH (--session-id, not --resume)')
      assert.notEqual(spawns[1].id, 'restored-uuid-9999', 'the fallback attempt mints a brand-new conversation uuid')
      const resumeUnknown = errors.filter((e) => e.code === 'resume_unknown')
      assert.equal(resumeUnknown.length, 1, 'one loud resume_unknown error so the dashboard can render "starting fresh"')
      assert.equal(resumeUnknown[0].attemptedResumeId, 'restored-uuid-9999', 'the error carries the abandoned conversation id')
      assert.equal(exhausted.length, 1, 'when the fresh attempt also dies, the session exhausts (one-shot latch, no loop)')
      assert.equal(exhausted[0].reason, 'resume_unknown_exhausted')
      const terminal = errors.find((e) => e.code === 'resume_unknown_exhausted')
      assert.ok(terminal, 'terminal error carries the resume_unknown_exhausted code')
      assert.equal(terminal.attemptedResumeId, 'restored-uuid-9999')
      assert.equal(session._respawnScheduled, false, 'no further respawn after exhaustion')
    })

    // #5417 — the classifier itself: shares CliSession's pinned
    // RESUME_UNKNOWN_STDERR_PATTERNS, matched per ANSI-stripped tail line
    // plus adjacent-line pairs (the TUI line-wraps and box-pads its output,
    // so a pattern can straddle ONE rendered line break — but the `.*` in the
    // #4950 co-occurrence patterns must never span unrelated lines).
    // #6576 (Option A) — the ACTUAL restore-on-restart fix. start() must NOT reject
    // when the dying warmup armed a retry-FRESH, because SessionManager tears down
    // the provider on a restore start() rejection (`_handleAsyncStartFailure`),
    // which cancels the scheduled respawn — the wedge #6576 is about. This exercises
    // the FULL start() path (not `_onPtyGone` directly), covering the teardown race
    // the `_scheduleRespawn`-only tests could not see.
    it('start() does NOT reject a restore whose --resume ghost dies during warmup — recovers via the scheduled retry-FRESH and emits ready (#6576)', async () => {
      let spawnCalls = 0
      const prevHome = process.env.HOME
      const fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-6576a-'))
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
      process.env.HOME = fakeHome
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir: emptySkillsDir, repoSkillsDir: null, resumeSessionId: 'ghost-uuid-0001' })
        session._spawnPty = async function () {
          spawnCalls++
          this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {}, on: () => {} }
          if (spawnCalls === 1) {
            // The doomed --resume dies during warmup with claude's own rejection in
            // the tail — this arms the retry-FRESH (and pre-fix made start() throw →
            // SessionManager teardown → the restore-on-restart wedge).
            this._outputTail = ''
            this._outputTailRaw = Buffer.alloc(0)
            this._appendToOutputTail(`No conversation found with session ID: ${this._sessionId}`)
            this._onPtyGone({ exitCode: 1, signal: null }, 'exit')
          }
          // spawnCalls === 2 (the scheduled fresh retry) leaves a live _term → survives.
        }
        const readies = []
        // Swallow the session-scoped 'error' emits (the PTY-exit + the
        // `code: 'resume_unknown'` "starting fresh" signal both ride the 'error'
        // event) so EventEmitter doesn't throw on an unhandled 'error'.
        session.on('error', () => {})
        session.on('ready', (d) => readies.push(d))

        // The fix: start() RESOLVES (pre-fix it threw → session_restore_failed + teardown).
        await session.start()
        assert.equal(session._freshRetryPending, true, 'the first death armed a retry-FRESH that start() deferred to instead of rejecting')
        assert.equal(readies.length, 0, 'ready not emitted yet — the fresh conversation is still scheduled to spawn')

        for (const d of [1000, 2000]) { mock.timers.tick(d); await new Promise((r) => setImmediate(r)) }

        assert.equal(spawnCalls, 2, 'one doomed --resume + one fresh retry spawn')
        assert.equal(readies.length, 1, 'the fresh retry survived warmup and emitted ready — session recovered IN PLACE (no restore_failed / no teardown)')
        assert.notEqual(readies[0].sessionId, 'ghost-uuid-0001', 'ready carries the new fresh conversation uuid')
        assert.equal(session._processReady, true, 'session ready after inline recovery')
      } finally {
        if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
        try { rmSync(fakeHome, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    })

    describe('_scanOutputForUnknownResume (#5417)', () => {
      it('matches claude\'s resume rejection through ANSI codes and line wrapping', () => {
        session = makeSession()
        session._appendToOutputTail('\x1b[1m\x1b[31mNo conversation\r\n    found with session ID: abc-123\x1b[0m\r\n')
        assert.equal(session._scanOutputForUnknownResume(), true)
      })

      it('does not match unrelated crash output or an empty tail', () => {
        session = makeSession()
        assert.equal(session._scanOutputForUnknownResume(), false, 'empty tail never matches')
        session._appendToOutputTail('Segmentation fault (core dumped)\r\nnode exited with code 139\r\n')
        assert.equal(session._scanOutputForUnknownResume(), false, 'unrelated crash output never matches')
      })

      // The #4950 co-occurrence patterns carry `.*`, which CliSession bounds
      // by testing each stderr LINE separately. The TUI tail must keep that
      // boundedness: a `--resume` warmup re-renders the restored transcript
      // into the tail, so "error" / "resume" / "session" scattered across
      // UNRELATED conversation lines must never co-occur into a match (a
      // false positive here would abandon a real conversation id — the exact
      // amnesia this gate exists to prevent).
      it('does not match pattern words scattered across distant transcript lines', () => {
        session = makeSession()
        session._appendToOutputTail(
          '> the respawn loop hit an error during warmup yesterday\r\n' +
          'I dug through the logs for details\r\n' +
          'claude will resume automatically after the backoff\r\n' +
          'check the session state file under ~/.chroxy\r\n',
        )
        assert.equal(session._scanOutputForUnknownResume(), false, 'cross-line co-occurrence never matches')
      })
    })

    it('a flapping session (warmup keeps resetting _respawnCount) gives up via the rolling rate cap (#5349)', () => {
      session = makeSession()
      // Small cap + fixed clock so the rolling window is deterministic. Each
      // respawn "survives warmup" (resets the consecutive _respawnCount), so the
      // consecutive cap of 5 never trips — only the rate cap can stop the flap.
      session._respawnRateLimiter = new RespawnRateLimiter({ maxPerWindow: 3, windowMs: 5 * 60_000, now: () => 1000 })
      const exhausted = []
      session.on('respawn_exhausted', (d) => exhausted.push(d))

      for (let i = 0; i < 4; i++) {
        session._respawnCount = 0          // warmup success reset
        session._respawnScheduled = false  // allow the next schedule
        session._respawnTimer = null
        session._scheduleRespawn()
      }

      assert.equal(exhausted.length, 1, 'gives up exactly once despite the warmup resets')
      assert.equal(exhausted[0].reason, 'pty_respawn_rate_capped', 'distinct reason from the consecutive cap')
      assert.equal(session._respawnScheduled, false, 'no respawn scheduled after the rate cap')
    })

    it('suppresses respawn when _destroying (deliberate teardown)', () => {
      session = makeSession()
      session._destroying = true
      session._onPtyGone({ exitCode: 0, signal: null }, 'exit')
      assert.equal(session._respawnScheduled, false, 'deliberate teardown must not schedule a respawn')
      assert.equal(session._respawnCount, 0, 'no respawn attempt counted on a destroying teardown')
    })

    it('clears the respawn timer on destroy so it cannot fire after teardown', async () => {
      let spawnCalls = 0
      session = makeSession(() => { spawnCalls++ })
      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      assert.ok(session._respawnTimer, 'a respawn timer is armed')

      await session.destroy()
      assert.equal(session._respawnTimer, null, 'respawn timer cleared on destroy')
      assert.equal(session._respawnScheduled, false, 'respawn flag cleared on destroy')

      // Even if a stale timer somehow remained, _respawnPty bails on _destroying.
      mock.timers.tick(60000)
      await new Promise((r) => setImmediate(r))
      assert.equal(spawnCalls, 0, 'no respawn after destroy')
      session = null // already destroyed; skip afterEach double-destroy
    })

    it('kills the fresh PTY when destroy() races an in-flight respawn (no orphan) (#5315 review)', async () => {
      let killed = 0
      session = makeSession((self) => {
        // destroy() lands during the spawn await: _destroying flips and the
        // fresh PTY has just been assigned by the (stubbed) _spawnPty.
        self._destroying = true
        self._term = { kill: () => { killed++ }, onData: () => {}, onExit: () => {}, on: () => {}, write: () => {} }
      })
      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      mock.timers.tick(1000)
      await new Promise((r) => setImmediate(r))
      assert.equal(killed, 1, 'the freshly-spawned PTY is killed when destroy raced the respawn')
      assert.equal(session._term, null, 'no live _term left referenced (no orphan)')
      assert.equal(session._processReady, false, 'not marked ready on a raced destroy')
      session = null // _destroying already set; skip afterEach double-destroy
    })

    it('reschedules (does not falsely go ready) when a respawn leaves no live PTY (#5315 review)', async () => {
      session = makeSession((self) => {
        // Mimic _spawnPty's early-return error paths (node-pty import fail /
        // spawn throw): no live _term, _ptyExited not set.
        self._term = null
      })
      session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      mock.timers.tick(1000)
      await new Promise((r) => setImmediate(r))
      assert.equal(session._processReady, false, 'must NOT mark ready when no live PTY came up')
      assert.equal(session._respawnScheduled, true, 'rescheduled another attempt instead of declaring success')
      assert.ok(session._respawnCount >= 2, 'attempt count advanced')
    })
  })

  describe('sendMessage() error paths', () => {
    it('emits error if not started yet', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const errors = []
      session.on('error', (e) => errors.push(e))
      await session.sendMessage('hi')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /not started|no longer alive/)
    })

    it('emits error if PTY has exited', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Simulate post-start state with dead PTY.
      session._processReady = true
      session._term = { write: () => {}, kill: () => {} }
      session._ptyExited = true
      const errors = []
      session.on('error', (e) => errors.push(e))
      await session.sendMessage('hi')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /no longer alive/)
    })

    it('emits error if already busy', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._term = { write: () => {}, kill: () => {} }
      session._isBusy = true  // simulate in-flight turn
      const errors = []
      session.on('error', (e) => errors.push(e))
      await session.sendMessage('hi')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /Already processing/)
    })
  })

  describe('busy-signal lifecycle (#4010)', () => {
    // The dashboard derives `agent_busy` from `stream_start` and `agent_idle`
    // from `result` (event-normalizer.js). The TUI provider has to fire those
    // two events on every exit path of every turn, or the Stop button gets
    // stuck (busy without a way to abort) or never appears (silent stall).
    // These tests pin the contract for both the success path and the failure
    // paths so a future refactor cannot quietly drop one.

    it('emits stream_start at turn start, not at completion', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      // Skip readiness gating — this test pins event-emit ORDER, not
      // probe behavior. The probe gets its own coverage under the
      // readiness-probe describe block. Stubbing the probe (rather than
      // relying on a side effect of the no-pid path) keeps the test's
      // intent explicit and survives the #4040 review hardening that
      // made invalid-pid a not-ready signal.
      session._waitForPrompt = async () => true
      const events = []
      session._term = {
        write: () => { events.push('pty_write') },
        kill: () => {},
      }
      session.on('stream_start', () => events.push('stream_start'))
      // Catch the timeout 'error' so EventEmitter doesn't throw on it —
      // the test only cares about the start-of-turn emit order.
      session.on('error', () => {})
      session._hardTimeoutMs = 25  // fail fast so the test doesn't hang
      session._resultTimeoutMs = 5000

      await session.sendMessage('hi')

      const startIdx = events.indexOf('stream_start')
      const writeIdx = events.indexOf('pty_write')
      assert.ok(startIdx >= 0, 'stream_start fired at all')
      assert.ok(writeIdx >= 0, 'pty write happened')
      assert.ok(startIdx < writeIdx, `stream_start must precede pty write (got start=${startIdx}, write=${writeIdx})`)
    })

    it('emits exactly one stream_start per turn (no duplicate at completion)', async () => {
      // Pre-#4010 the success path also emitted stream_start, so moving the
      // early emit in without removing the late emit would render two
      // assistant bubbles per turn. Drop a fake stop hook to force the
      // success path and count emits.
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-uuid'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-busy-'))
      // Skip readiness gating — see note in the prior test.
      session._waitForPrompt = async () => true
      session._term = {
        write: () => {
          // Drop a stop hook immediately so the poll loop completes.
          writeFileSync(join(session._sinkDir, 'stop-fake.json'), JSON.stringify({
            last_assistant_message: 'hello',
          }))
        },
        kill: () => {},
      }
      let starts = 0, deltas = 0, ends = 0, results = 0
      session.on('stream_start', () => starts++)
      session.on('stream_delta', () => deltas++)
      session.on('stream_end', () => ends++)
      session.on('result', () => results++)

      await session.sendMessage('hi')

      assert.equal(starts, 1, 'stream_start fires once per turn')
      assert.equal(deltas, 1, 'stream_delta fires once with the response')
      assert.equal(ends, 1, 'stream_end fires once')
      assert.equal(results, 1, 'result fires once → triggers agent_idle')
    })

    it('emits result on hard timeout so dashboard clears busy state', async () => {
      // Without this, a stalled turn that trips the hard timeout would leave
      // the dashboard showing Stop forever — stream_end alone only clears
      // streamingMessageId, it does not flip isIdle back to true.
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 25,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-stall'
      session._activeTurn = { messageId: 'msg-stall', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      session._sessionId = 'sess-stall'
      session._term = { write: () => {}, kill: () => {} }

      const events = []
      session.on('stream_end', () => events.push('stream_end'))
      session.on('error', () => events.push('error'))
      session.on('result', () => events.push('result'))

      session._armResultTimeout()
      await new Promise((r) => setTimeout(r, 60))

      assert.ok(events.includes('stream_end'), 'stream_end emitted on timeout')
      assert.ok(events.includes('result'), 'result emitted on timeout → agent_idle')
      assert.equal(session._isBusy, false, 'busy state cleared')
    })

    it('emits result on _finishTurnError so aborted/failed turns clear busy', async () => {
      // _finishTurnError is the common exit for prompt-write failures and
      // poll-loop bailouts (aborted, pty-exit, stop-timeout). Each one must
      // round-trip agent_busy → agent_idle.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._isBusy = true
      session._currentMessageId = 'msg-fail'
      session._activeTurn = { messageId: 'msg-fail', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      session._sessionId = 'sess-fail'

      const events = []
      session.on('stream_end', (e) => events.push(['stream_end', e.messageId]))
      session.on('error', (e) => events.push(['error', e.message]))
      session.on('result', (e) => events.push(['result', e.sessionId]))

      session._finishTurnError('something broke')

      const types = events.map(([t]) => t)
      assert.ok(types.includes('stream_end'), 'stream_end emitted')
      assert.ok(types.includes('error'), 'error emitted')
      assert.ok(types.includes('result'), 'result emitted → agent_idle clears busy state')
      assert.equal(session._isBusy, false, 'busy flag cleared')
    })

    it('pairs stream_end with stream_start when PTY exits mid-turn (review follow-up)', async () => {
      // PTY-exit-mid-turn race: the onExit handler runs synchronously and
      // nulls _currentMessageId + _activeTurn BEFORE the poll loop notices
      // _ptyExited=true and falls into _finishTurnError. Without the
      // callerMessageId fallback, the if(messageId) guard would silently
      // skip stream_end, leaving the stream_start opened at turn-start
      // unbalanced and session-message-history._pendingStreams holding the
      // entry until destroy(). Simulate the race directly by calling
      // _finishTurnError after the onExit-style clear, with the original
      // messageId passed as the second arg (matching sendMessage's call).
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._sessionId = 'sess-pty-exit'
      // Simulate state AFTER onExit handler has nulled everything.
      session._isBusy = false
      session._currentMessageId = null
      session._activeTurn = null
      session._ptyExited = true
      session._ptyExitInfo = { exitCode: 137, signal: 'SIGKILL' }

      const events = []
      session.on('stream_end', (e) => events.push(['stream_end', e.messageId]))
      session.on('error', (e) => events.push(['error', e.message]))
      session.on('result', (e) => events.push(['result', e.sessionId]))

      // sendMessage passes the local messageId from the top of the function
      // as the second arg precisely to survive this race.
      session._finishTurnError('Claude PTY exited mid-turn (code=137 signal=SIGKILL)', 'msg-pty-race')

      const streamEnd = events.find(([t]) => t === 'stream_end')
      assert.ok(streamEnd, 'stream_end fires even after onExit nulled _currentMessageId')
      assert.equal(streamEnd[1], 'msg-pty-race', 'stream_end carries the original messageId so it pairs with the early stream_start')
      assert.ok(events.find(([t]) => t === 'error'), 'error emitted')
      assert.ok(events.find(([t]) => t === 'result'), 'result emitted → agent_idle')
    })
  })

  describe('readiness probe (#4040)', () => {
    // The probe watches claude's per-PID session file at
    // ~/.claude/sessions/<pid>.json. Claude TUI writes this file at
    // startup and updates the `status` field on every transition
    // (busy/idle/...) — the same field `claude ps` reads. When
    // status !== 'busy' the TUI is ready for input. This replaces the
    // glyph screen-scrape in #4014/#4031/#4035/#4039, which all had
    // false-positive vs. false-negative tradeoffs against the rendered
    // TUI and were fundamentally unstable across claude releases.
    //
    // Each test sets HOME to a temp dir so the fake session file lives
    // somewhere we can write without touching the real ~/.claude.

    let fakeHome
    let origHome
    let fakePid

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-sess-'))
      mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
      origHome = process.env.HOME
      process.env.HOME = fakeHome
      // node-pty assigns pids as kernel pids; for tests any positive
      // integer suffices, the probe only uses it to build the file path.
      fakePid = 9999
    })

    afterEach(() => {
      if (origHome !== undefined) process.env.HOME = origHome
      else delete process.env.HOME
      if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    })

    function writeSessionFile(pid, status) {
      const path = join(fakeHome, '.claude', 'sessions', `${pid}.json`)
      writeFileSync(path, JSON.stringify({
        pid, sessionId: 'fake', status, updatedAt: Date.now(),
      }))
      return path
    }

    // #6578: write a session file carrying an explicit `sessionId` and,
    // when `status` is undefined, OMIT the `status` field entirely (current
    // claude 2.1.186+ session files carry no `status` at all). The resolver
    // keys on `sessionId`, not the pid, so the FILE name pid may differ from
    // the pty pid (wrapper-shim MODE A).
    function writeSessionFileV2(pid, sessionId, status) {
      const path = join(fakeHome, '.claude', 'sessions', `${pid}.json`)
      const body = { pid, sessionId, cwd: '/tmp', startedAt: Date.now() }
      if (status !== undefined) body.status = status
      writeFileSync(path, JSON.stringify(body))
      return path
    }

    it('_waitForPrompt resolves true when session file reports status=idle', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      writeSessionFile(fakePid, 'idle')
      const ready = await session._waitForPrompt(100)
      assert.equal(ready, true, 'status=idle counts as ready')
    })

    it('_waitForPrompt resolves false when session file reports status=busy', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      writeSessionFile(fakePid, 'busy')
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, false, 'status=busy must NOT count as ready')
    })

    it('_waitForPrompt resolves false when session file is absent (claude not yet up)', async () => {
      // First few hundred ms after spawn the file may not exist yet.
      // The probe must keep polling, not crash, and return false on
      // timeout if it never appears (caller falls through with a warn).
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, false, 'absent session file is treated as not-ready')
    })

    // #6601: current claude's INTERACTIVE TUI writes no ~/.claude/sessions file,
    // so the file probe never resolves. The probe then falls back to PTY output
    // QUIESCENCE — once claude has rendered on this spawn and output has been
    // quiet for READY_QUIESCENCE_MS, the composer has settled and is ready. These
    // pin that fallback and its guards (no false-ready before render / while busy).
    it('#6601 _waitForPrompt resolves true when no session file but output has quiesced', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      // no session file written; simulate a rendered-then-settled composer
      session._sawFirstOutput = true
      session._lastOutputMs = session._nowMonotonic() - (ClaudeTuiSession.READY_QUIESCENCE_MS + 200)
      const ready = await session._waitForPrompt(100)
      assert.equal(ready, true, 'quiescent output (no file) counts as ready')
    })

    it('#6601 _waitForPrompt stays not-ready while output is still flowing (not yet quiesced)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      session._sawFirstOutput = true
      session._lastOutputMs = session._nowMonotonic() // just now — 0ms quiet
      const ready = await session._waitForPrompt(50) // well under READY_QUIESCENCE_MS
      assert.equal(ready, false, 'output still flowing (not quiescent) is not ready')
    })

    it('#6601 _waitForPrompt stays not-ready before ANY output (cold, pre-render — quiet-by-default trap)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      // _sawFirstOutput defaults false; _lastOutputMs defaults 0 (so now-0 LOOKS
      // quiescent) — the _sawFirstOutput guard is what prevents a false-ready.
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, false, 'no output yet must NOT count as ready')
    })

    it('#6601 a busy session file overrides output quiescence (no false-ready)', async () => {
      // Precedence: when a file DOES resolve and says busy, quiescence must not
      // override it — the file path returns before the quiescence fallback.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      writeSessionFile(fakePid, 'busy')
      session._sawFirstOutput = true
      session._lastOutputMs = session._nowMonotonic() - 10_000 // very quiescent
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, false, 'status=busy file wins over quiescence')
    })

    it('#6604 the per-spawn reset drops a previously-quiesced session back to not-ready until fresh output', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }

      // A session that HAD rendered and quiesced reads ready...
      session._sawFirstOutput = true
      session._lastOutputMs = session._nowMonotonic() - (ClaudeTuiSession.READY_QUIESCENCE_MS + 200)
      assert.equal(await session._waitForPrompt(100), true, 'sanity: a quiesced session reads ready')

      // ...but the per-spawn reset (run by _spawnPty on every respawn) must drop it
      // back to not-ready — the stale _lastOutputMs can't count until fresh output.
      session._resetQuiescenceForSpawn()
      assert.equal(session._sawFirstOutput, false, 'reset clears the saw-first-output gate')
      assert.equal(await session._waitForPrompt(50), false,
        'respawn reset reads not-ready despite the leftover (stale) _lastOutputMs')

      // Fresh output on the new spawn re-arms the gate; once it quiesces, ready again.
      session._appendToOutputTail('composer render')
      assert.equal(session._sawFirstOutput, true, 'fresh output re-arms the gate')
      session._lastOutputMs = session._nowMonotonic() - (ClaudeTuiSession.READY_QUIESCENCE_MS + 200)
      assert.equal(await session._waitForPrompt(100), true, 'ready again after fresh output quiesces')
    })

    it('#6603 READY_QUIESCENCE_MS honours CHROXY_TUI_READY_QUIESCENCE_MS (positive int, else 400)', () => {
      const prev = process.env.CHROXY_TUI_READY_QUIESCENCE_MS
      try {
        process.env.CHROXY_TUI_READY_QUIESCENCE_MS = '1200'
        assert.equal(ClaudeTuiSession.READY_QUIESCENCE_MS, 1200, 'a positive override is applied')
        for (const bad of ['0', '-50', 'abc', '']) {
          process.env.CHROXY_TUI_READY_QUIESCENCE_MS = bad
          assert.equal(ClaudeTuiSession.READY_QUIESCENCE_MS, 400, `invalid "${bad}" falls back to 400`)
        }
        delete process.env.CHROXY_TUI_READY_QUIESCENCE_MS
        assert.equal(ClaudeTuiSession.READY_QUIESCENCE_MS, 400, 'unset falls back to 400')
      } finally {
        if (prev === undefined) delete process.env.CHROXY_TUI_READY_QUIESCENCE_MS
        else process.env.CHROXY_TUI_READY_QUIESCENCE_MS = prev
      }
    })

    it('_waitForPrompt returns false when pid is missing or invalid (Copilot review on #4040)', async () => {
      // Returning true on a missing/invalid pid would silently disable
      // readiness gating on any platform/runtime where node-pty fails to
      // populate pid, reintroducing the race the probe exists to prevent.
      // Tests that explicitly want to skip the probe stub
      // `_waitForPrompt` directly rather than relying on this guard.
      const cases = [
        { pid: undefined, label: 'undefined' },
        { pid: null, label: 'null' },
        { pid: NaN, label: 'NaN' },
        { pid: -1, label: 'negative' },
        { pid: 0, label: 'zero' },
        { pid: 1.5, label: 'non-integer' },
        { pid: '12345', label: 'string' },
      ]
      for (const { pid, label } of cases) {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._term = { write: () => {}, kill: () => {}, pid }
        const ready = await session._waitForPrompt(20)
        assert.equal(ready, false,
          `pid=${label} must NOT count as ready (would silently disable gating)`)
      }
    })

    it('_waitForPrompt returns false when PTY exited even if status=idle', async () => {
      // PTY death overrides a stale idle marker — otherwise we'd write
      // bytes to a corpse and report success.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      writeSessionFile(fakePid, 'idle')
      session._ptyExited = true
      const ready = await session._waitForPrompt(100)
      assert.equal(ready, false, 'PTY exit overrides idle status')
    })

    it('_waitForPrompt polls until status transitions to idle', async () => {
      // Cold start: file appears mid-poll, status flips from absent ->
      // busy -> idle. The probe must continue past the first read miss.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      setTimeout(() => writeSessionFile(fakePid, 'busy'), 50)
      setTimeout(() => writeSessionFile(fakePid, 'idle'), 200)
      const ready = await session._waitForPrompt(800)
      assert.equal(ready, true, 'probe sees idle once it lands')
    })

    it('_waitForPrompt treats unknown non-busy statuses as ready', async () => {
      // Claude may introduce new statuses (waiting, paused, etc.) over
      // time. The probe's job is "not actively running a turn" — any
      // string other than "busy" counts. This is the forward-compat
      // choice and matches how `claude ps` already treats the field.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      writeSessionFile(fakePid, 'waiting')
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, true, 'status=waiting counts as ready')
    })

    it('_waitForPrompt sets _lastProbeSawStatus=false when session file never appeared', async () => {
      // Silent-degrade signal: if the probe runs full-duration without
      // ever reading a non-null status, the file format/path has likely
      // changed (e.g. claude entrypoint switched away from `cli` and no
      // longer writes `status`). The warn site at the timeout reads
      // `_lastProbeSawStatus` to surface this case distinctly from a
      // genuinely busy session.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, false, 'absent file → not-ready')
      assert.equal(session._lastProbeSawStatus, false,
        '_lastProbeSawStatus must be false when no readable status was ever seen')
    })

    it('_waitForPrompt sets _lastProbeSawStatus=true once a status is read, even on busy timeout', async () => {
      // Distinguish "stuck on busy" from "file never appeared". A long
      // busy stretch is normal during a real turn; the warn site should
      // NOT mention degraded probe in that case.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      writeSessionFile(fakePid, 'busy')
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, false, 'busy → not-ready')
      assert.equal(session._lastProbeSawStatus, true,
        '_lastProbeSawStatus must be true once any status was successfully read')
    })

    it('_waitForPrompt tolerates a malformed session file (transient mid-write race)', async () => {
      // Atomic-write races: claude rewrites the file by truncate+write
      // (not rename), so a JSON.parse can hit a half-written body. The
      // probe swallows the error and keeps polling, not crash.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      const path = join(fakeHome, '.claude', 'sessions', `${fakePid}.json`)
      writeFileSync(path, '{not-valid-json')
      setTimeout(() => writeSessionFile(fakePid, 'idle'), 80)
      const ready = await session._waitForPrompt(400)
      assert.equal(ready, true, 'probe survives JSON.parse errors and resolves once the file is sane')
    })

    // #6578 — the readiness signal is now resolved by matching `sessionId`,
    // not by the pty pid alone, and file-existence-with-matching-sessionId is
    // itself a startup readiness signal (claude writes the file at startup and
    // current versions carry NO `status` field). These lock in the four
    // resolution/gating cases plus the multi-session false-positive guard.

    it('_waitForPrompt resolves a session file under a DIFFERENT pid via matching sessionId (#6578 MODE A)', async () => {
      // Wrapper-shim install: real claude pid != pty pid, so the fast-path
      // ~/.claude/sessions/<pty-pid>.json never appears — but the real file
      // (named by claude's own pid) carries a matching sessionId. The dir-scan
      // must find it and treat file-existence as ready.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      session._sessionId = 'uuid-mode-a'
      // No file at fakePid; a file under a DIFFERENT pid with the matching id.
      writeSessionFileV2(fakePid + 7, 'uuid-mode-a', undefined)
      const ready = await session._waitForPrompt(200)
      assert.equal(ready, true, 'resolved by sessionId under a different pid → ready')
      assert.equal(session._lastProbeSawStatus, true,
        'resolving a matching session file counts as "saw status" (not degraded)')
    })

    it('_waitForPrompt treats a matching statusless session file as ready (#6578 MODE B)', async () => {
      // Current claude session files carry NO `status` field. File at the pty
      // pid, matching sessionId, no status → ready (not degraded).
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      session._sessionId = 'uuid-mode-b'
      writeSessionFileV2(fakePid, 'uuid-mode-b', undefined)
      const ready = await session._waitForPrompt(200)
      assert.equal(ready, true, 'statusless-but-present matching file → ready')
      assert.equal(session._lastProbeSawStatus, true,
        'a resolved matching file is not a degraded probe')
    })

    it('_waitForPrompt still gates on status=busy when the file carries a status (#6578 back-compat)', async () => {
      // Claude versions that still write `status` must keep between-turn
      // gating: a matching file with status:busy is NOT ready.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      session._sessionId = 'uuid-busy'
      writeSessionFileV2(fakePid, 'uuid-busy', 'busy')
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, false, 'status=busy on a matching file must still gate')
    })

    it('_waitForPrompt ignores a session file whose sessionId does not match (#6578 multi-session guard)', async () => {
      // A sibling session's file (different sessionId) must not be read as
      // THIS session's readiness — otherwise two concurrent TUIs false-positive
      // off each other.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      session._sessionId = 'uuid-mine'
      // Only a foreign file exists (statusless, would otherwise read as ready).
      writeSessionFileV2(fakePid + 3, 'uuid-someone-else', undefined)
      const ready = await session._waitForPrompt(60)
      assert.equal(ready, false, 'non-matching sessionId must not be treated as ready')
      assert.equal(session._lastProbeSawStatus, false,
        'no matching file resolved → degraded/no-file signal')
    })

    it('resolveSessionFile returns the pid path on the fast path and null on no match (#6578)', () => {
      // Fast path: file at the pty pid with a matching sessionId → returned.
      const p = writeSessionFileV2(fakePid, 'uuid-fast', undefined)
      assert.equal(
        ClaudeTuiSession.resolveSessionFile('uuid-fast', fakePid), p,
        'fast path returns the pty-pid file when its sessionId matches',
      )
      // No file anywhere with the id → null (swallowed I/O, never throws).
      assert.equal(
        ClaudeTuiSession.resolveSessionFile('uuid-absent', fakePid), null,
        'no matching file anywhere → null',
      )
      // Dir-scan fallback: fast path misses, another file matches.
      const q = writeSessionFileV2(fakePid + 11, 'uuid-scan', undefined)
      assert.equal(
        ClaudeTuiSession.resolveSessionFile('uuid-scan', fakePid), q,
        'dir-scan finds the matching file under a different pid',
      )
      // #6578 throttle: allowDirScan:false suppresses the (readdir-heavy) fallback,
      // so the same under-a-different-pid file is NOT found — only the fast path runs.
      assert.equal(
        ClaudeTuiSession.resolveSessionFile('uuid-scan', fakePid, { allowDirScan: false }), null,
        'allowDirScan:false skips the dir-scan (fast-path miss → null)',
      )
    })

    it('readSessionStatus returns null for missing/invalid files', () => {
      // Static helper isolation: covers the file-absent, JSON-invalid,
      // and missing-field branches without going through the polling
      // loop. The probe relies on this returning null on every error so
      // it keeps polling instead of throwing.
      assert.equal(ClaudeTuiSession.readSessionStatus('/no/such/path'), null,
        'missing file → null')
      const bad = join(fakeHome, 'bad.json')
      writeFileSync(bad, 'not json')
      assert.equal(ClaudeTuiSession.readSessionStatus(bad), null,
        'invalid JSON → null')
      const noStatus = join(fakeHome, 'no-status.json')
      writeFileSync(noStatus, JSON.stringify({ pid: 1, updatedAt: 0 }))
      assert.equal(ClaudeTuiSession.readSessionStatus(noStatus), null,
        'missing status field → null')
    })

    it('sessionFilePath uses ~/.claude/sessions/<pid>.json', () => {
      // The path must match claude's own convention (the file `claude ps`
      // reads). If claude ever moves this directory, the probe needs a
      // visible failure (this test) — silently reading the wrong path
      // would degrade us back to "never ready, always falls through".
      const path = ClaudeTuiSession.sessionFilePath(12345)
      assert.ok(path.endsWith(join('.claude', 'sessions', '12345.json')),
        `expected ~/.claude/sessions/12345.json, got: ${path}`)
      assert.ok(path.startsWith(fakeHome),
        `path should be under HOME, got: ${path}`)
    })

    describe('output tail hex dump (#4031)', () => {
      // The dump survives the #4040 probe rewrite because it's still
      // useful diagnostics for any TUI-rendered error inline. It's no
      // longer tied to a probe-scan window — it caps at
      // PTY_TAIL_DIAGNOSTIC_BYTES (1024) so log lines stay bounded.

      it('returns a readable hex+ascii dump for log lines', () => {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._outputTailRaw = Buffer.from('hello', 'utf8')
        const dump = session._outputTailHexDump()
        assert.match(dump, /\(5 bytes\)/, `dump should report byte count, got: ${JSON.stringify(dump)}`)
        assert.match(dump, /68 65 6c 6c 6f/, `hex side missing, got: ${JSON.stringify(dump)}`)
        assert.match(dump, /\|hello\|/, `ascii side missing, got: ${JSON.stringify(dump)}`)
      })

      it('handles empty buffer', () => {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._outputTailRaw = Buffer.alloc(0)
        assert.equal(session._outputTailHexDump(), '<empty>')
      })

      it('surfaces UNSTRIPPED escape/control bytes (#4031 review)', () => {
        // The original implementation sourced from the ANSI-stripped
        // _outputTail, so the diagnostic could never surface the very
        // escape sequences ("0x1b ...") we wanted to see. Lock in that
        // the dump reads from the raw buffer.
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._outputTail = '❯ '
        session._outputTailRaw = Buffer.from('\x1b]0;claude\x07❯ ', 'utf8')
        const dump = session._outputTailHexDump()
        assert.match(dump, /1b 5d/, `dump should surface raw ESC byte, got: ${JSON.stringify(dump)}`)
      })

      it('caps the dump at PTY_TAIL_DIAGNOSTIC_BYTES with a truncation header', () => {
        // Honesty invariant: large buffers must be truncated to a
        // bounded size with a header that names how much was elided.
        // Without the cap, a multi-KB tail could produce log lines that
        // get truncated by the logger itself and lose the diagnostic.
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const cap = ClaudeTuiSession.PTY_TAIL_DIAGNOSTIC_BYTES
        const totalBytes = cap * 3
        const omitted = totalBytes - cap
        session._outputTailRaw = Buffer.from('X'.repeat(totalBytes), 'utf8')
        const dump = session._outputTailHexDump()
        assert.ok(
          dump.includes(`(${cap} of ${totalBytes} bytes; first ${omitted} omitted)`),
          `dump should report cap with truncation header, got: ${dump.slice(0, 120)}`,
        )
      })
    })

    describe('_degradedProbeSuffix (#5328, WP-5.6; #6578)', () => {
      // #6578: readiness is now resolved by matching `sessionId` (via
      // resolveSessionFile), and `_lastProbeSawStatus` means "resolved a
      // matching session file". So the suffix collapses to a single degraded
      // case: NO session file for this sessionId was found anywhere (wrapper
      // shim under a fully different install, or claude never wrote it). The
      // found-but-busy case is healthy (`_lastProbeSawStatus === true` →
      // empty). The stub is on resolveSessionFile now, not sessionFilePath.
      let origResolve
      beforeEach(() => {
        origResolve = ClaudeTuiSession.resolveSessionFile
      })
      afterEach(() => {
        ClaudeTuiSession.resolveSessionFile = origResolve
      })

      it('returns empty when the probe resolved a matching file (healthy / real busy)', () => {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._lastProbeSawStatus = true
        assert.equal(session._degradedProbeSuffix(), '')
      })

      it('names the no-matching-file cause when no session file for this sessionId resolved (#6578)', () => {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._lastProbeSawStatus = false
        session._term = { pid: 4242 }
        session._sessionId = 'uuid-gone'
        ClaudeTuiSession.resolveSessionFile = () => null // nothing resolved
        const suffix = session._degradedProbeSuffix()
        assert.match(suffix, /no session file/, `got: ${suffix}`)
        assert.match(suffix, /uuid-gone/, `should name the sessionId, got: ${suffix}`)
        assert.match(suffix, /readiness gating is effectively disabled/)
      })

      it('does not claim a missing pid-file when the dir-scan DID resolve one (no misleading wrapper-shim wording) (#6578)', () => {
        // If a matching file was found (even under a different pid), the probe
        // is NOT degraded — the suffix must be empty, not the wrapper-shim note.
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._lastProbeSawStatus = true // resolved a matching file
        session._term = { pid: 4242 }
        session._sessionId = 'uuid-found'
        assert.equal(session._degradedProbeSuffix(), '',
          'a resolved matching file is not a degraded probe')
      })

      it('still degrades gracefully when there is no usable pid or sessionId (#6578)', () => {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._lastProbeSawStatus = false
        session._term = null
        session._sessionId = null
        const suffix = session._degradedProbeSuffix()
        assert.match(suffix, /no session file/, `got: ${suffix}`)
      })
    })

    describe('output tail ANSI stripping (#5325, WP-5.3)', () => {
      // _appendToOutputTail is the body of the PTY onData handler. It must
      // strip ANSI from the CONCATENATED tail, not per-chunk, so an escape
      // sequence split across two onData chunks is still removed.

      it('strips an ANSI escape split across two onData chunks', () => {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        // CSI "\x1b[31m" arrives split: "\x1b[3" then "1mred". A per-chunk
        // strip would leave the orphaned "\x1b[3" fragment in the tail.
        session._appendToOutputTail('hello \x1b[3')
        session._appendToOutputTail('1mred\x1b[0m done')
        assert.equal(
          session._outputTail,
          'hello red done',
          `split escape must be stripped once whole, got: ${JSON.stringify(session._outputTail)}`,
        )
      })

      it('strips an OSC sequence split across chunk boundaries', () => {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        // OSC "\x1b]0;claude\x07" split mid-payload and again before the BEL.
        session._appendToOutputTail('\x1b]0;cla')
        session._appendToOutputTail('ude')
        session._appendToOutputTail('\x07❯ ')
        assert.equal(
          session._outputTail,
          '❯ ',
          `split OSC must be stripped once whole, got: ${JSON.stringify(session._outputTail)}`,
        )
      })

      it('retains the UNSTRIPPED bytes in _outputTailRaw for the hex dump', () => {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._appendToOutputTail('a\x1b[3')
        session._appendToOutputTail('1mb')
        // Readable tail is clean...
        assert.equal(session._outputTail, 'ab')
        // ...but the raw buffer still carries the escape bytes for diagnostics.
        assert.ok(
          session._outputTailRaw.includes(0x1b),
          'raw tail must retain the ESC byte',
        )
      })

      it('strips a single-chunk escape (no regression)', () => {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._appendToOutputTail('x\x1b[0my')
        assert.equal(session._outputTail, 'xy')
      })
    })

    it('sendMessage waits for status=idle before writing to the PTY', async () => {
      // The whole point of the probe — bytes must not hit the PTY until
      // claude reports itself ready. We delay the idle transition and
      // assert the write fires AFTER it, not before.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-probe-'))
      writeSessionFile(fakePid, 'busy')   // not ready yet
      let writeAt = null
      session._term = {
        write: () => {
          writeAt = Date.now()
          writeFileSync(join(session._sinkDir, 'stop-x.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
        pid: fakePid,
      }
      session._hardTimeoutMs = 5000
      session._resultTimeoutMs = 5000
      session.on('error', () => {})

      const sendStart = Date.now()
      const idleAt = sendStart + 150
      setTimeout(() => writeSessionFile(fakePid, 'idle'), 150)

      await session.sendMessage('hello')

      assert.ok(writeAt, 'PTY write happened')
      assert.ok(writeAt >= idleAt - 30,
        `PTY write must wait for status=idle (write@${writeAt - sendStart}ms, idle@${idleAt - sendStart}ms)`)
    })

    it('sendMessage falls through and writes anyway on probe timeout', async () => {
      // A timeout is logged but never blocks the write — if claude's
      // session-file convention changes or the file is unreadable for
      // some reason, we'd rather risk a stall than silently swallow
      // every prompt the user types.
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        hardTimeoutMs: 5000, resultTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-probe-to-'))
      // No session file at all — probe will keep returning false.
      let wrote = false
      session._term = {
        write: () => {
          wrote = true
          writeFileSync(join(session._sinkDir, 'stop-y.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
        pid: fakePid,
      }
      session.on('error', () => {})

      // Shrink the probe budget to keep the test fast — same code path.
      // Capture the original descriptor (a static getter) and restore it
      // verbatim. A naive { value: origMax } restore would replace the
      // getter with a data property, permanently mutating the class shape
      // for the rest of the process and silently breaking later tests.
      const origDesc = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS')
      Object.defineProperty(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS', { value: 80, configurable: true })
      try {
        await session.sendMessage('hello')
      } finally {
        Object.defineProperty(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS', origDesc)
      }

      assert.equal(wrote, true, 'probe miss does not block the write')
    })

    it('sendMessage routes to _finishTurnError when PTY dies during the probe wait', async () => {
      // Edge case: probe is waiting, PTY exits, probe returns false. We
      // must surface a clear error and clear busy — not silently fall
      // through to a write on a dead PTY.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      // No session file → probe stays in its polling loop until either
      // _ptyExited flips or the timeout elapses.
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      session._hardTimeoutMs = 5000
      session._resultTimeoutMs = 5000

      const errors = []
      session.on('error', (e) => errors.push(e))

      setTimeout(() => {
        session._ptyExited = true
        session._ptyExitInfo = { exitCode: 1, signal: null }
      }, 40)

      const result = await session.sendMessage('hello')

      assert.ok(errors.find((e) => /exited before prompt write/.test(e.message)),
        `expected "exited before prompt write" error, got: ${errors.map((e) => e.message).join(' | ')}`)
      assert.equal(session._isBusy, false, 'busy cleared after probe-time PTY death')
      // #5813: the late-failure path returns the typed { ok:false } (like the
      // up-front guards) so callers keying off result.ok — e.g. the reinject
      // stop-and-wait watch-close — don't depend on _finishTurnError's side-effect.
      assert.deepEqual(result, { ok: false, reason: 'pty_exited' })
    })

    it('sendMessage bails out via _finishTurnError when interrupt() fires during the probe wait', async () => {
      // Race: user clicks Stop while the readiness probe is still polling.
      // Without the abort guard, sendMessage would happily write the
      // prompt after interrupt() has already sent Ctrl-C, queuing a turn
      // behind the cancel and desynchronizing busy state with the TUI.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      // No session file → probe stays in its polling loop.
      let promptWritten = false
      session._term = {
        write: (bytes) => {
          // Track only the prompt write (Ctrl-C from interrupt() is a
          // single 0x03 byte; the prompt is 'hello\r').
          if (typeof bytes === 'string' && bytes.length > 1) promptWritten = true
        },
        kill: () => {},
        pid: fakePid,
      }
      session._hardTimeoutMs = 5000
      session._resultTimeoutMs = 5000

      const errors = []
      session.on('error', (e) => errors.push(e))

      // Fire interrupt() partway through the probe wait. No session
      // file is ever written so the probe is still polling when this
      // runs.
      setTimeout(() => session.interrupt(), 40)

      // Shrink the probe budget so the test doesn't wait 5s for the
      // timeout fall-through.
      const origDesc = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS')
      Object.defineProperty(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS', { value: 200, configurable: true })
      try {
        await session.sendMessage('hello')
      } finally {
        Object.defineProperty(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS', origDesc)
      }

      assert.equal(promptWritten, false,
        'prompt MUST NOT be written after interrupt() during probe wait')
      assert.ok(errors.find((e) => /aborted before prompt write/.test(e.message)),
        `expected "aborted before prompt write" error, got: ${errors.map((e) => e.message).join(' | ')}`)
      assert.equal(session._isBusy, false, 'busy cleared after probe-time abort')
      assert.equal(session._activeTurn, null, 'active turn cleared after probe-time abort')
    })
  })

  describe('throttled prompt write + bracketed-paste suppression (#4269)', () => {
    // claude TUI's paste detector triggers on byte-arrival rate, not DEC
    // mode 2004 — a single bulk write of the whole prompt is collapsed
    // into a "[Pasted text #1 +N lines] paste again to expand"
    // placeholder that the user has to confirm. chroxy's writes never
    // get that confirmation, so the prompt sits in claude's input
    // buffer forever and the turn hangs with no output and no claude
    // activity. Fix is to throttle the write character-by-character so
    // the bytes look like typed input. The bracketed-paste-disable /
    // re-enable wrap (`ESC [ ? 2004 l` / `h`) is kept as
    // defense-in-depth for any claude version that DOES honor mode
    // 2004 — the throttle is what actually fixes the bug.
    let fakeHome
    let origHome
    let fakePid

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-bp-'))
      mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
      origHome = process.env.HOME
      process.env.HOME = fakeHome
      fakePid = 8765
    })

    afterEach(() => {
      if (origHome !== undefined) process.env.HOME = origHome
      else delete process.env.HOME
      if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    })

    function writeIdleSessionFile(pid) {
      const path = join(fakeHome, '.claude', 'sessions', `${pid}.json`)
      writeFileSync(path, JSON.stringify({
        pid, sessionId: 'fake', status: 'idle', updatedAt: Date.now(),
      }))
      return path
    }

    it('writes the prompt character-by-character so claude does not see a bulk paste', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-bp-sink-'))
      writeIdleSessionFile(fakePid)
      const writes = []
      session._term = {
        write: (data) => {
          writes.push(data)
          // Synthesize a stop file so the poll loop unblocks.
          writeFileSync(join(session._sinkDir, 'stop-x.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
        pid: fakePid,
      }
      session._hardTimeoutMs = 2000
      session._resultTimeoutMs = 2000
      session.on('error', () => {})

      const prompt = 'a test prompt with no newlines'
      await session.sendMessage(prompt)

      // The fix issues N+3 writes: one for the bracketed-paste-disable
      // prefix, one per prompt code-point, one for the \r submit, and
      // one for the bracketed-paste re-enable suffix. The throttle
      // between char writes is what actually defeats claude's paste
      // detector (which fires on byte-arrival rate, not mode 2004).
      //
      // #4274: use `[...prompt]` for code-point counting. String#length
      // counts UTF-16 code units, so non-BMP chars (emoji, some CJK)
      // would yield a stale count under bare ASCII assumptions. ASCII
      // is unaffected (1 code unit == 1 code point), but writing the
      // code-point form keeps these assertions valid for any prompt
      // the multi-byte fixture below exercises.
      const codePoints = [...prompt]
      assert.equal(writes.length, codePoints.length + 3,
        `expected ${codePoints.length + 3} writes (disable + N chars + \\r + enable), got ${writes.length}`)
      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      assert.equal(writes.slice(1, 1 + codePoints.length).join(''), prompt,
        'chars 1..N concatenate back to the original prompt')
      for (let i = 0; i < codePoints.length; i++) {
        assert.equal(writes[1 + i], codePoints[i], `write index ${1 + i} is the i-th code-point of the prompt`)
      }
      assert.equal(writes[1 + codePoints.length], '\r', 'penultimate write is the submit')
      assert.equal(writes[2 + codePoints.length], '\x1b[?2004h', 'final write is bracketed-paste re-enable')
    })

    it('delivers multi-line prompts via a single bracketed-paste write (#4678)', async () => {
      // #4678 superseded the per-char throttle for multi-line input.
      // Claude TUI v2.1.x treats embedded \n in the input box as
      // "insert newline in multi-line composition" and the trailing
      // bare \r we appended was being interpreted as another newline
      // rather than submit — the input box stayed in composition mode
      // forever and the 5-min stream-stall watchdog was the only escape.
      // Multi-line prompts now wrap the body in CSI bracketed-paste
      // markers (\x1b[200~ ... \x1b[201~) so claude TUI receives the
      // block as a paste and the trailing \r fires as submit. The
      // per-char throttle is still used for single-line input (#4269
      // paste-detector defence) — see the emoji/CJK test below.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-bp-sink-ml-'))
      writeIdleSessionFile(fakePid)
      const writes = []
      session._term = {
        write: (data) => {
          writes.push(data)
          writeFileSync(join(session._sinkDir, 'stop-ml.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
        pid: fakePid,
      }
      session._hardTimeoutMs = 2000
      session._resultTimeoutMs = 2000
      session.on('error', () => {})

      const multiline = 'line one\nline two\nline three'
      await session.sendMessage(multiline)

      // Exactly ONE write for the whole multi-line input — no per-char
      // throttle for this path. The disable/enable mode-2004 wrap is
      // also skipped because bracketed paste IS the mode signal.
      assert.equal(writes.length, 1, 'multi-line prompt sent as one atomic paste, not per-char')
      const sent = writes[0]
      assert.ok(sent.startsWith('\x1b[200~'), `must start with paste-start CSI (got ${JSON.stringify(sent.slice(0, 10))})`)
      assert.ok(sent.endsWith('\x1b[201~\r'), `must end with paste-end CSI + CR (got ${JSON.stringify(sent.slice(-12))})`)
      assert.ok(sent.includes(multiline), 'body preserves embedded \\n chars verbatim inside the paste')
      const newlineCount = (sent.match(/\n/g) || []).length
      assert.equal(newlineCount, 2, 'each embedded \\n survives literally inside the bracketed-paste body')
    })

    // #4274: bare String#length counts UTF-16 code units, so a single
    // non-BMP code-point (emoji, some CJK supplementary chars) reports
    // as length 2. `for (const ch of text)` iterates by code-point, so
    // each emoji is ONE write of a 2-UTF-16-unit string. Pre-fix the
    // tests assumed 1 write == 1 code-unit and would over-count + fail
    // the per-write `length === 1` assertion. This test pins the
    // production behavior under multi-byte input.
    it('reproduces emoji + CJK prompts verbatim (one write per code-point, not per UTF-16 unit) (#4274)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-bp-sink-mb-'))
      writeIdleSessionFile(fakePid)
      const writes = []
      session._term = {
        write: (data) => {
          writes.push(data)
          writeFileSync(join(session._sinkDir, 'stop-mb.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
        pid: fakePid,
      }
      session._hardTimeoutMs = 2000
      session._resultTimeoutMs = 2000
      session.on('error', () => {})

      // Mix of: BMP ASCII, BMP CJK (length 1 in UTF-16), and non-BMP
      // emoji (length 2 in UTF-16, length 1 in code-points). If the
      // throttle loop walks UTF-16 units it splits the emoji surrogate
      // pair and corrupts the prompt. Iterating by code-point keeps
      // every grapheme intact.
      const prompt = 'hi 😀 こんにちは 👋'
      await session.sendMessage(prompt)

      const codePoints = [...prompt]
      assert.ok(prompt.length > codePoints.length,
        'fixture exercises non-BMP — UTF-16 length must exceed code-point length')
      assert.equal(writes.length, codePoints.length + 3,
        `expected ${codePoints.length + 3} writes (disable + N code-points + \\r + enable), got ${writes.length}`)
      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      assert.equal(writes.slice(1, 1 + codePoints.length).join(''), prompt,
        'code-point writes concatenate back to the original prompt verbatim')
      for (let i = 0; i < codePoints.length; i++) {
        assert.equal(writes[1 + i], codePoints[i],
          `write index ${1 + i} is the i-th code-point (UTF-16 length ${codePoints[i].length})`)
      }
      assert.equal(writes[1 + codePoints.length], '\r', 'penultimate write is the submit')
      assert.equal(writes[2 + codePoints.length], '\x1b[?2004h', 'final write is bracketed-paste re-enable')
    })
  })

  describe('attachment passthrough (#4012)', () => {
    // Pre-fix, sendMessage's second positional was `_attachments` (the
    // underscore meaning "intentionally unused") and attachments were
    // silently dropped. The fix materializes each attachment under
    // <sinkDir>/attachments/<messageId>/ and appends a structured suffix
    // to the prompt so the spawned `claude` TUI can find the files via
    // its Read tool. These tests pin both halves of the contract: the
    // files reach disk AND the prompt the PTY receives names them.

    it('appends an attachments suffix to the prompt and writes files to disk', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-send-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-att'
      session._sinkDir = sinkDir
      // Skip readiness gating — attachment behavior is independent of
      // the #4040 probe. Probe-specific tests live under their own
      // describe block.
      session._waitForPrompt = async () => true

      let writtenToPty = ''
      // Inspect attachment state DURING the turn (before the success path
      // cleans up under #4022). The poll loop runs after term.write so by
      // the time await sendMessage() returns, _cleanupTurnAttachments has
      // fired and the per-turn dir is gone — we have to snapshot disk
      // state inside the write callback to verify it landed at all.
      let midTurnSubdirCount = -1
      let midTurnFiles = []
      session._term = {
        write: (s) => {
          // #4269: writes are now per-character throttled. Accumulate
          // so the final string equals what would have been a single
          // pre-throttle write — keeps existing assertions valid.
          writtenToPty += s
          // Snapshot the attachments dir contents at the moment the
          // prompt is being written to the PTY. This is the state claude
          // sees when it tries to Read the file path from the suffix.
          const attDir = join(sinkDir, 'attachments')
          try {
            const subdirs = readdirSync(attDir)
            midTurnSubdirCount = subdirs.length
            if (subdirs.length > 0) {
              midTurnFiles = readdirSync(join(attDir, subdirs[0]))
            }
          } catch { midTurnSubdirCount = 0 }
          // Drop a stop hook so the poll loop completes the turn.
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({
            last_assistant_message: 'ok',
          }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      await session.sendMessage('Look at this screenshot', [
        { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'shot.png' },
      ])

      // 1) Prompt that hit the PTY contains the original text PLUS the suffix.
      assert.ok(writtenToPty.includes('Look at this screenshot'), 'original prompt text preserved')
      assert.ok(writtenToPty.includes('attached the following file'),
        `expected suffix in PTY write, got: ${JSON.stringify(writtenToPty.slice(0, 200))}`)
      assert.ok(writtenToPty.includes('shot.png'), 'display name appears in suffix')
      // #4269: the write is now `ESC [ ? 2004 l <prompt body> \r ESC [ ? 2004 h`
      // so the submit \r is no longer the trailing byte. The contract is
      // unchanged in spirit: exactly one \r submit, no embedded \r/\n in
      // the prompt body that would prematurely-submit or split the turn
      // (#4012 review finding).
      const disableIdx = writtenToPty.indexOf('\x1b[?2004l')
      const submitIdx = writtenToPty.indexOf('\r')
      const enableIdx = writtenToPty.indexOf('\x1b[?2004h')
      assert.ok(disableIdx === 0, 'write begins with bracketed-paste-disable')
      assert.ok(submitIdx > disableIdx, '\\r submit appears after the disable + body')
      assert.ok(enableIdx > submitIdx, 're-enable appears after the submit')
      const body = writtenToPty.slice(disableIdx + '\x1b[?2004l'.length, submitIdx)
      assert.ok(!body.includes('\n'), `no embedded LF in prompt body, got ${JSON.stringify(body)}`)
      assert.ok(!body.includes('\r'), 'no embedded CR in prompt body either')

      // 2) File actually materialized on disk at the moment the prompt
      // was handed to the PTY — the snapshot taken in term.write above.
      // Post-turn cleanup (#4022) will have removed the dir by now.
      assert.equal(midTurnSubdirCount, 1, 'exactly one per-turn subdir was on disk when PTY received the prompt')
      assert.equal(midTurnFiles.length, 1)
      assert.ok(midTurnFiles[0].endsWith('.png'), `expected .png, got ${midTurnFiles[0]}`)
    })

    it('does NOT touch the prompt when no attachments are present', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-noatt-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = sinkDir
      session._waitForPrompt = async () => true

      let writtenToPty = ''
      session._term = {
        write: (s) => {
          // #4269: writes are now per-character throttled. Accumulate
          // so the final string equals what would have been a single
          // pre-throttle write — keeps existing assertions valid.
          writtenToPty += s
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      await session.sendMessage('Just a plain prompt')

      // #4269: write is now wrapped with bracketed-paste mode toggles so
      // claude TUI doesn't collapse the input into a "paste again to
      // expand" placeholder. The prompt body itself is still
      // byte-for-byte identical to the user input.
      assert.equal(writtenToPty, '\x1b[?2004lJust a plain prompt\r\x1b[?2004h',
        'plain prompt is wrapped in bracketed-paste-disable / re-enable with body unmodified')
    })

    it('logs and proceeds with unaugmented prompt when materialization throws', async () => {
      // Failure to write the attachment must NOT lose the user's text.
      // Force the catch path by setting _sinkDir to a path containing a
      // NUL byte so mkdirSync inside materializeAttachments throws.
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-fail-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = `${sinkDir}\0invalid`   // mkdirSync will reject
      session._waitForPrompt = async () => true

      let writtenToPty = ''
      session._term = {
        write: (s) => {
          // #4269: writes are now per-character throttled. Accumulate
          // so the final string equals what would have been a single
          // pre-throttle write — keeps existing assertions valid.
          writtenToPty += s
          // The stop hook needs to land in a VALID sink dir for the
          // poll loop to read it. Use the real sinkDir for that.
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      // Point poll loop at the real sinkDir AFTER the failed materialize
      // (drainHookFiles reads _sinkDir each tick). The sendMessage
      // function doesn't snapshot it, so mutating mid-call works.
      const realSinkDir = sinkDir
      const send = session.sendMessage('Important message', [
        { type: 'image', mediaType: 'image/png', data: Buffer.from('x').toString('base64'), name: 'a.png' },
      ])
      // After the materialize-then-write block runs, swap sinkDir so the
      // poll loop can find the stop hook.
      queueMicrotask(() => { session._sinkDir = realSinkDir })
      await send

      // #4269: write is wrapped with bracketed-paste mode toggles. The
      // user's prompt body itself is still preserved verbatim — that's
      // the invariant this test pins.
      assert.equal(writtenToPty, '\x1b[?2004lImportant message\r\x1b[?2004h',
        'materialization failure must NOT drop the user prompt')

      rmSync(sinkDir, { recursive: true, force: true })
    })

    // #4287 follow-up to #4285: when `_activeTurn?.aborted` trips
    // mid-loop, `_writePtyTextThrottled` previously returned early
    // WITHOUT writing the `\x1b[?2004h` re-enable, leaving the PTY in
    // bracketed-paste-disabled mode for subsequent writes. The fix
    // wraps the for-loop in try/finally so the re-enable always runs.
    it('_writePtyTextThrottled: aborted mid-loop still writes bracketed-paste re-enable in finally (#4287)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const writes = []
      session._activeTurn = { messageId: 'm-abort', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      let charsSeen = 0
      session._term = {
        write: (data) => {
          writes.push(data)
          if (data.length === 1 && /^[a-z]$/.test(data)) {
            charsSeen += 1
            // Flip aborted after the 3rd char — next loop tick observes it.
            if (charsSeen === 3) session._activeTurn.aborted = true
          }
        },
        kill: () => {},
      }

      let onAbortCalled = false
      const completed = await session._writePtyTextThrottled('abcdefgh', {
        onAbort: () => { onAbortCalled = true },
      })

      assert.equal(completed, false, 'aborted mid-loop returns false')
      assert.equal(onAbortCalled, true, 'onAbort callback fires')
      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      assert.equal(writes[writes.length - 1], '\x1b[?2004h',
        'final write is bracketed-paste re-enable even though loop aborted early')
      assert.equal(writes.includes('\r'), false, 'no submit on abort path')
    })

    it('_writePtyTextThrottled: throw inside loop still writes bracketed-paste re-enable in finally (#4287)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const writes = []
      let charsSeen = 0
      session._term = {
        write: (data) => {
          writes.push(data)
          if (data.length === 1 && /^[a-z]$/.test(data)) {
            charsSeen += 1
            if (charsSeen === 2) throw new Error('PTY exited mid-write')
          }
        },
        kill: () => {},
      }
      session._activeTurn = { messageId: 'm-throw', startedAt: Date.now(), aborted: false, synthSeq: 0 }

      await assert.rejects(
        () => session._writePtyTextThrottled('abcdef'),
        /PTY exited mid-write/,
        'underlying throw propagates to the caller',
      )

      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      // The finally block runs the re-enable. The spy only throws on
      // single lowercase letters; the re-enable byte sequence (length>1)
      // pushes cleanly.
      assert.equal(writes[writes.length - 1], '\x1b[?2004h',
        'final write is bracketed-paste re-enable even though loop threw')
    })

    it('_writePtyTextThrottled: finally swallows a re-enable write that itself throws (PTY exited) (#4287)', async () => {
      // If the PTY exited entirely, term.write may throw on the
      // re-enable byte sequence too. The finally block must swallow
      // that so it does not mask the underlying loop error.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const writes = []
      session._term = {
        write: (data) => {
          writes.push(data)
          if (data === 'a') throw new Error('loop-error')
          if (data === '\x1b[?2004h') throw new Error('reenable-error-should-be-swallowed')
        },
        kill: () => {},
      }
      session._activeTurn = { messageId: 'm-double', startedAt: Date.now(), aborted: false, synthSeq: 0 }

      await assert.rejects(
        () => session._writePtyTextThrottled('a'),
        /loop-error/,
        'original loop error surfaces, not the swallowed re-enable error',
      )
      assert.deepEqual(writes, ['\x1b[?2004l', 'a', '\x1b[?2004h'],
        'finally always attempts the re-enable even if it will throw')
    })

    // #4275: the throttle loop checks `_activeTurn?.aborted` between
    // each char but did NOT re-check `_ptyExited`. If the PTY exits
    // mid-write (e.g. claude crashed during a long prompt), remaining
    // chars get pushed at a dead PTY and only surface via the
    // _term.write throw catch path. Cleaner to mirror the pre-write
    // guard (line ~768) inside the loop body so the bail is explicit.
    it('_writePtyTextThrottled: bails out cleanly when _ptyExited flips mid-loop (#4275)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const writes = []
      let charsSeen = 0
      session._term = {
        write: (data) => {
          writes.push(data)
          if (data.length === 1 && /^[a-z]$/.test(data)) {
            charsSeen += 1
            // Flip _ptyExited after the 3rd char — next loop tick must
            // observe it BEFORE attempting another _term.write.
            if (charsSeen === 3) session._ptyExited = true
          }
        },
        kill: () => {},
      }
      session._activeTurn = { messageId: 'm-ptyexit', startedAt: Date.now(), aborted: false, synthSeq: 0 }

      let onAbortCalled = false
      const completed = await session._writePtyTextThrottled('abcdefgh', {
        onAbort: () => { onAbortCalled = true },
      })

      assert.equal(completed, false, '_ptyExited mid-loop returns false (same shape as abort)')
      assert.equal(onAbortCalled, true, 'onAbort fires so caller can surface a PTY-exit error')
      // Loop wrote a,b,c then noticed _ptyExited and bailed before d.
      // Char writes (single lowercase letter) should be exactly 3.
      const charWrites = writes.filter((d) => /^[a-z]$/.test(d))
      assert.equal(charWrites.length, 3, 'loop bails after the char that tripped _ptyExited, not after d')
      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      assert.equal(writes[writes.length - 1], '\x1b[?2004h',
        'final write is bracketed-paste re-enable (finally still runs on _ptyExited bail)')
      assert.equal(writes.includes('\r'), false, 'no submit when PTY exited mid-write')
    })

    // #4276: per-char throttling for huge prompts (e.g. pasted file
    // contents) is unbounded — 100K chars × ~1-4ms each = minutes of
    // blocked turn. Above MAX_THROTTLED_CHARS the helper falls back
    // to a single bulk _term.write, accepting that very large prompts
    // may trip claude TUI's paste detector (the user-visible symptom
    // is far better than a multi-minute silent block).
    it('exposes MAX_THROTTLED_CHARS for callers / regression tests (#4276)', () => {
      assert.equal(typeof ClaudeTuiSession.MAX_THROTTLED_CHARS, 'number',
        'MAX_THROTTLED_CHARS is a numeric static for tunability + assertions')
      assert.ok(ClaudeTuiSession.MAX_THROTTLED_CHARS > 0, 'must be positive')
    })

    it('_writePtyTextThrottled: bulk-writes the body in one call when text exceeds MAX_THROTTLED_CHARS (#4276)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-bulk', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      // One code-point beyond the threshold — must take the bulk path.
      const huge = 'x'.repeat(ClaudeTuiSession.MAX_THROTTLED_CHARS + 1)
      const completed = await session._writePtyTextThrottled(huge)

      assert.equal(completed, true, 'bulk path returns true on success')
      // Bulk path: disable + ONE write of the whole body + \r + enable.
      assert.deepEqual(writes, ['\x1b[?2004l', huge, '\r', '\x1b[?2004h'],
        'large prompts bypass the per-char throttle entirely')
    })

    it('_writePtyTextThrottled: stays on the per-char throttle path at exactly MAX_THROTTLED_CHARS (#4276)', async () => {
      // Boundary check — the threshold is "above MAX", so EQUAL to MAX
      // still gets the paste-detector-friendly per-char throttle. This
      // pins the comparison so a future refactor doesn't accidentally
      // make `> MAX` into `>= MAX` and silently downgrade the typical
      // medium-sized prompt UX.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-edge', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      const atCap = 'x'.repeat(ClaudeTuiSession.MAX_THROTTLED_CHARS)
      const completed = await session._writePtyTextThrottled(atCap)

      assert.equal(completed, true)
      // disable + N chars + \r + enable.
      assert.equal(writes.length, atCap.length + 3,
        'exactly-at-cap still gets per-char writes')
    })

    it('_writePtyTextThrottled: bulk path still honors _ptyExited / abort pre-write guards (#4276)', async () => {
      // The bulk path skips the loop, but still has to respect the
      // outer turn lifecycle. If the turn was already aborted (or PTY
      // dead) before we hit the bulk write, we must NOT send bytes —
      // same contract the per-char path provides via its loop guards.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-bulk-abort', startedAt: Date.now(), aborted: true, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      let onAbortCalled = false
      const huge = 'x'.repeat(ClaudeTuiSession.MAX_THROTTLED_CHARS + 100)
      const completed = await session._writePtyTextThrottled(huge, {
        onAbort: () => { onAbortCalled = true },
      })

      assert.equal(completed, false, 'bulk path returns false when aborted before write')
      assert.equal(onAbortCalled, true, 'onAbort still fires on the bulk path')
      // The bulk body must NOT appear in writes. The disable + finally
      // re-enable are bookkeeping — what matters is no big payload was
      // sent at a stale PTY.
      assert.equal(writes.includes(huge), false, 'large body never reaches a torn-down PTY')
    })

    // #4805: the single-line throttled path fed each code-point verbatim
    // into _term.write — no defense against C0 control bytes or ANSI
    // CSI / OSC sequences embedded in the freeform input. The newline
    // bracketed-paste branch (#4678) already strips embedded `\x1b[201~`
    // markers and explicitly cites attacker-controlled MCP tool results
    // as the threat model; the single-line branch has the same input
    // shape (freeformText from the dashboard, Zod-bounded only to
    // string + 100KB length) and so needs parallel defense.
    //
    // Known damage paths from the audit:
    //   - `\x03` (Ctrl-C) aborts the active form
    //   - OSC `\x1b]0;...\x07` → terminal-title injection on some hosts
    //   - Long ANSI CSI sequences desync the TUI input state machine
    //     (the recurring wedge symptom class)
    //
    // The fix strips C0 control bytes (excluding \t which is whitespace
    // the user might paste) and ANSI CSI / OSC sequences before the
    // per-char loop. Tab is kept because it's a normal printable
    // whitespace; \r and \n never reach this path (the multi-line branch
    // handles them).
    it('_writePtyTextThrottled: strips C0 control bytes (Ctrl-C) from single-line input (#4805)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-c0', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      // Ctrl-C embedded mid-prompt. Without the strip the per-char loop
      // would write \x03 verbatim and abort the TUI form.
      const completed = await session._writePtyTextThrottled('hello\x03world')

      assert.equal(completed, true)
      // The combined per-char writes (chars between the disable/enable
      // bookends and the \r submit) must contain no \x03 byte.
      const charWrites = writes.slice(1, writes.indexOf('\r'))
      const joined = charWrites.join('')
      assert.equal(joined.includes('\x03'), false, 'Ctrl-C byte is stripped from the per-char write stream')
      assert.equal(joined, 'helloworld', 'surrounding printable text passes through with the control byte excised')
    })

    it('_writePtyTextThrottled: strips ANSI CSI cursor sequences from single-line input (#4805)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-csi', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      // ANSI CSI cursor-up sequence embedded in the body — drives the
      // TUI's input cursor in ways the user never typed.
      const completed = await session._writePtyTextThrottled('foo\x1b[Abar')

      assert.equal(completed, true)
      const charWrites = writes.slice(1, writes.indexOf('\r'))
      const joined = charWrites.join('')
      assert.equal(joined.includes('\x1b'), false, 'ESC byte is stripped (no surviving CSI introducer)')
      assert.equal(joined.includes('[A'), false, 'CSI tail bytes go with the introducer')
      assert.equal(joined, 'foobar', 'CSI sequence is fully excised, surrounding text preserved')
    })

    it('_writePtyTextThrottled: strips OSC title-set sequences from single-line input (#4805)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-osc', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      // OSC title-set: ESC ] 0 ; <title> BEL. On terminal hosts that
      // honour OSC even inside the input box this rewrites the window
      // title from attacker-controlled bytes.
      const completed = await session._writePtyTextThrottled('hi\x1b]0;evil\x07there')

      assert.equal(completed, true)
      const charWrites = writes.slice(1, writes.indexOf('\r'))
      const joined = charWrites.join('')
      assert.equal(joined.includes('\x1b'), false, 'OSC ESC is stripped')
      assert.equal(joined.includes('\x07'), false, 'BEL terminator is stripped')
      assert.equal(joined.includes('evil'), false, 'OSC payload between ESC ] and BEL is dropped')
      assert.equal(joined, 'hithere', 'OSC sequence is fully excised, surrounding text preserved')
    })

    it('_writePtyTextThrottled: passes normal printable text through untouched (#4805)', async () => {
      // Regression guard for the strip — printable ASCII, tabs, and
      // multi-byte BMP/non-BMP characters must survive byte-for-byte.
      // (Newlines are handled by the multi-line branch, not this one.)
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-clean', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      const clean = 'hello\tworld 你好 🚀 !@#$%^&*()'
      const completed = await session._writePtyTextThrottled(clean)

      assert.equal(completed, true)
      const charWrites = writes.slice(1, writes.indexOf('\r'))
      assert.equal(charWrites.join(''), clean,
        'printable + tab + multi-byte text is preserved byte-for-byte')
    })

    // #4805 Wave 2: the original strip regex left three classes of bytes
    // through (Copilot + agent-review caught these post-merge):
    //   1. Lone \x1b — char class [\x00-\x08\x0b-\x1a\x1c-\x1f\x7f] has
    //      a gap at 0x1b (between 0x1a and 0x1c). The comment claimed
    //      lone ESC was stripped; the code didn't deliver.
    //   2. CSI parameter bytes 0x30-0x3f — the original `[\d;]*` covers
    //      only digits + ';', missing DEC-private intro bytes `?`/`<`/
    //      `=`/`>`/`:`. So `\x1b[?25l`, `\x1b[?1049h`, `\x1b[?1000h`,
    //      `\x1b[?1006h` all pass through.
    //   3. String-control introducers other than OSC — DCS `\x1b P`,
    //      APC `\x1b _`, PM `\x1b ^`, SOS `\x1b X` were not in the
    //      alternation. Some terminals (iTerm2) execute APC payloads.
    //
    // The Wave 2 regex broadens CSI to the full ECMA-48 grammar
    // (params 0x30-0x3f, intermediates 0x20-0x2f, final 0x40-0x7e),
    // adds DCS/APC/PM/SOS to the string-control alternation, adds a
    // `\x1b.?` catch-all for stray two-byte ESC + final-byte sequences
    // (RIS \x1b c, DECSC/DECRC \x1b 7/8, IND/RI/NEL/HTS \x1b D/M/E/H),
    // and extends the C0 class to \x1f so a lone ESC is always stripped.
    it('_writePtyTextThrottled: strips DEC-private CSI sequences (W2 #4805)', async () => {
      // \x1b[?25l hides the cursor; \x1b[?1049h switches to the alt
      // screen. Both are CSI sequences with `?` as the first parameter
      // byte (0x3F, in the 0x30-0x3f param range). The original
      // `[\d;]*` regex skipped them.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-dec', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      const completed = await session._writePtyTextThrottled('a\x1b[?25lb\x1b[?1049hc')

      assert.equal(completed, true)
      const charWrites = writes.slice(1, writes.indexOf('\r'))
      const joined = charWrites.join('')
      assert.equal(joined.includes('\x1b'), false, 'no ESC bytes survive DEC-private strip')
      assert.equal(joined.includes('?'), false, 'no DEC-private parameter intro bytes survive')
      assert.equal(joined.includes('25l'), false, 'no DEC sequence tail leaks as printable garbage')
      assert.equal(joined.includes('1049h'), false, 'no alt-screen sequence tail leaks')
      assert.equal(joined, 'abc', 'surrounding text preserved with both DEC sequences fully excised')
    })

    it('_writePtyTextThrottled: strips stray two-byte ESC + final-byte sequences like RIS (W2 #4805)', async () => {
      // RIS (ESC + 'c', byte sequence `\x1bc`) is the full terminal-
      // reset escape — clears scrollback, resets colours/attributes.
      // The original regex matched CSI/OSC only; `\x1bc` passed
      // through entirely (ESC in the char-class gap, `c` printable).
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-ris', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      const completed = await session._writePtyTextThrottled('keep\x1bcmore')

      assert.equal(completed, true)
      const charWrites = writes.slice(1, writes.indexOf('\r'))
      const joined = charWrites.join('')
      assert.equal(joined.includes('\x1b'), false, 'ESC byte stripped')
      // The \x1b.? alternation consumes ESC + one trailing byte, so the
      // `c` final byte of RIS goes with it; the surrounding "keep" and
      // "more" land cleanly with no `c` between them.
      assert.equal(joined, 'keepmore', 'RIS escape sequence fully excised')
    })

    it('_writePtyTextThrottled: strips APC payloads terminated by ST (W2 #4805)', async () => {
      // APC (\x1b _ ... \x1b\\) — iTerm2 interprets these for
      // proprietary commands. Original regex matched OSC only; APC
      // body passed through as printable text.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-apc', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      const completed = await session._writePtyTextThrottled('pre\x1b_evil\x1b\\post')

      assert.equal(completed, true)
      const charWrites = writes.slice(1, writes.indexOf('\r'))
      const joined = charWrites.join('')
      assert.equal(joined.includes('\x1b'), false, 'no ESC bytes survive')
      assert.equal(joined.includes('evil'), false, 'APC payload between introducer and ST is dropped')
      assert.equal(joined, 'prepost', 'APC sequence fully excised with surrounding text preserved')
    })

    it('_writePtyTextThrottled: strips a lone ESC byte (W2 #4805 regression guard)', async () => {
      // The original char class [\x00-\x08\x0b-\x1a\x1c-\x1f\x7f] had a
      // gap at 0x1b. The block comment claimed ESC was stripped; the
      // code didn't. The Wave 2 regex either matches ESC via the
      // \x1b.? catch-all OR via the broadened class [\x00-\x08\x0b-\x1f
      // \x7f]. Either way a bare ESC must not survive.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-lone-esc', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      // Trailing ESC at end-of-string — the \x1b.? alternation matches
      // ESC + optional next byte, so a trailing bare ESC matches with
      // an empty optional group and is dropped.
      const completed = await session._writePtyTextThrottled('hello\x1b')

      assert.equal(completed, true)
      const charWrites = writes.slice(1, writes.indexOf('\r'))
      const joined = charWrites.join('')
      assert.equal(joined.includes('\x1b'), false, 'lone trailing ESC stripped')
      assert.equal(joined, 'hello', 'surrounding text preserved')
    })

    it('_writePtyTextThrottled: handles all-control-byte input cleanly (W2 #4805 empty-after-strip)', async () => {
      // Mirror the multi-line branch's `body.length === 0` guard
      // (:1358): if the post-strip body is empty, abort the turn
      // cleanly rather than submitting a bare \r to the TUI. Without
      // the guard the single-line path would still write the bracketed-
      // paste-disable + zero-iteration loop + \r submit, which is at
      // best a no-op and at worst an empty prompt the TUI doesn't
      // expect.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-empty', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      let onAbortCalled = false
      const completed = await session._writePtyTextThrottled('\x03\x1b[A\x07\x1b]0;t\x07', {
        onAbort: () => { onAbortCalled = true },
      })

      assert.equal(completed, false, 'empty-after-strip returns false (no message left chroxy)')
      assert.equal(onAbortCalled, true, 'onAbort fires so caller surfaces a finished-but-empty turn')
      assert.equal(writes.includes('\r'), false, 'no bare \\r submit on empty body')
      // The disable + finally re-enable bookends are fine to emit
      // (they're idempotent terminal state) — what matters is no body
      // and no \r reached the PTY.
    })

    it('_writePtyTextThrottled: audit log includes hex sample of stripped bytes (W2 #4805)', async () => {
      // The original warn line said only "stripped N bytes" — useless
      // for forensics on a real attack. The Wave 2 audit log includes
      // a bounded hex-encoded sample (first 32 bytes) so an operator
      // can grep for known-bad signatures and an incident-response
      // run-book has the bytes themselves.
      const warnLines = []
      const logSpy = (entry) => {
        if (entry.level === 'warn' && entry.component === 'claude-tui-session') {
          warnLines.push(entry.message)
        }
      }
      addLogListener(logSpy)
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._activeTurn = { messageId: 'm-audit', startedAt: Date.now(), aborted: false, synthSeq: 0 }
        session._term = { write: () => {}, kill: () => {} }

        // \x03 (Ctrl-C) + \x1b[A (CSI cursor-up). Hex-encoded these are
        // "03" and "1b5b41".
        await session._writePtyTextThrottled('a\x03b\x1b[Ac')

        const strip = warnLines.find((m) => /stripped \d+ control\/escape bytes/.test(m))
        assert.ok(strip, `expected strip warn line, got warnLines=${JSON.stringify(warnLines)}`)
        assert.match(strip, /msg=m-audit/, 'warn carries the active turn messageId')
        assert.match(strip, /sample=/, 'warn includes a stripped-bytes sample field')
        // The hex sample must contain the bytes we sent — both \x03
        // (Ctrl-C) and the full CSI \x1b[A sequence.
        assert.match(strip, /03/, 'hex sample contains the stripped Ctrl-C byte (0x03)')
        assert.match(strip, /1b5b41/, 'hex sample contains the stripped CSI cursor-up bytes (\\x1b[A)')
      } finally {
        removeLogListener(logSpy)
      }
    })
  })

  describe('attachment-cap warn lines (#4216)', () => {
    // #4215 added two distinct log.warn lines in the attachment-suffix
    // path: a regular-truncation warn and a bare-fallback warn. The
    // suffix builder itself is unit-tested in claude-tui-attachments,
    // but the caller-side logging was not pinned — a future refactor
    // could downgrade these to info, swap the branches, or drop one
    // entirely without any test catching it. These two tests pin the
    // exact warn-line text per branch, end-to-end through sendMessage.
    //
    // Both trigger conditions are forced via crafted attachments that
    // push the suffix past MAX_ATTACHMENT_SUFFIX_BYTES (8 KiB). The
    // session-level validateAttachments() runs at the WS boundary so
    // calling sendMessage() directly here bypasses it — exactly what
    // we want for synthetic over-cap payloads.

    let warnLines
    let logSpy

    beforeEach(() => {
      warnLines = []
      logSpy = (entry) => {
        if (entry.level === 'warn' && entry.component === 'claude-tui-session') {
          warnLines.push(entry.message)
        }
      }
      addLogListener(logSpy)
    })

    afterEach(() => {
      if (logSpy) removeLogListener(logSpy)
      logSpy = null
      warnLines = null
    })

    async function sendOneTurn(sinkDir, prompt, attachments) {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-warn'
      session._sinkDir = sinkDir
      session._outputTail = ClaudeTuiSession.PROMPT_GLYPH

      session._term = {
        write: () => {
          // Drop the stop hook so the poll loop ends the turn.
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({
            last_assistant_message: 'ok',
          }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      await session.sendMessage(prompt, attachments)
    }

    it('emits a truncated warn when the full suffix exceeds the cap but a trimmed list fits', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-warn-trunc-'))
      // 100 small attachments. Each materialized item produces a line
      // like `<sinkDir>/attachments/<msgId>/att-N.png (img-N.png, image/png, 1B)`
      // — roughly 130-160 bytes once the per-item separator is counted —
      // so 100 items pushes the full suffix well past 8 KiB while
      // leaving room for a trimmed list to fit.
      const png = Buffer.from([0x89]).toString('base64')
      const attachments = []
      for (let i = 0; i < 100; i++) {
        attachments.push({
          type: 'image', mediaType: 'image/png',
          data: png, name: `img-${String(i).padStart(3, '0')}.png`,
        })
      }

      await sendOneTurn(sinkDir, 'lots of files', attachments)

      const truncated = warnLines.find((m) => /TUI attachment suffix truncated/.test(m))
      const bare = warnLines.find((m) => /bare-fallback fired/.test(m))
      assert.ok(truncated, `expected a "truncated" warn, got warnLines=${JSON.stringify(warnLines)}`)
      assert.ok(!bare, 'must NOT emit the bare-fallback warn when a trimmed list fits')
      // Pin the structured fields the warn carries — these are what an
      // operator greps for, so swapping in something less specific
      // (e.g. dropping the "omitted=N of=M" tail) should fail this test.
      assert.match(truncated, /msg=/, 'warn includes message id')
      assert.match(truncated, /suffixBytes=\d+/, 'warn includes final suffix bytes')
      assert.match(truncated, /cap=\d+B/, 'warn includes cap in bytes')
      assert.match(truncated, /omitted=\d+ of=\d+/, 'warn includes omitted-of-total counts')

      rmSync(sinkDir, { recursive: true, force: true })
    })

    it('emits the bare-fallback warn when even a single-entry suffix exceeds the cap', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-warn-bare-'))
      // mediaType is not length-capped inside materializeAttachments
      // (sanitization happens at the WS boundary, not here), so a
      // single attachment carrying a >8 KiB mediaType string is enough
      // to push the single-entry suffix past the cap. The truncation
      // loop pops the only item, sees the list is now empty, breaks,
      // and falls through to the bare-fallback marker.
      const png = Buffer.from([0x89]).toString('base64')
      const giantMediaType = 'image/png' + ';x='.repeat(3000)   // ~9 KiB
      const attachments = [{
        type: 'image', mediaType: giantMediaType, data: png, name: 'one.png',
      }]

      await sendOneTurn(sinkDir, 'one giant-typed file', attachments)

      const bare = warnLines.find((m) => /bare-fallback fired/.test(m))
      const truncated = warnLines.find((m) => /TUI attachment suffix truncated/.test(m))
      assert.ok(bare, `expected a bare-fallback warn, got warnLines=${JSON.stringify(warnLines)}`)
      // The two branches are mutually exclusive in the source (if/else);
      // pin that here so a future refactor that runs both can't slip in
      // unnoticed.
      assert.ok(!truncated, 'truncated warn must NOT fire on the bare-fallback path')
      assert.match(bare, /msg=/, 'warn includes message id')
      assert.match(bare, /count=\d+/, 'warn includes file count')
      assert.match(bare, /cap=\d+B/, 'warn includes cap in bytes')
      assert.match(bare, /file paths omitted/, 'warn explains the lossy outcome')

      rmSync(sinkDir, { recursive: true, force: true })
    })
  })

  describe('per-turn attachment cleanup (#4022)', () => {
    // Long-running sessions with many large attachments would
    // accumulate gigabytes in tmpfs without per-turn cleanup. Drop the
    // turn's attachment dir on the success path AND every failure exit
    // path (abort, _finishTurnError, _handleHardTimeout, onExit).
    //
    // The session-level rmSync(_sinkDir) in destroy() remains as a
    // backstop for anything we miss here.

    it('removes the per-turn dir after the success path completes', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-cleanup-success-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-cleanup-success'
      session._sinkDir = sinkDir
      session._waitForPrompt = async () => true

      session._term = {
        write: () => {
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      await session.sendMessage('Look', [
        { type: 'image', mediaType: 'image/png', data: Buffer.from('abc').toString('base64'), name: 'a.png' },
      ])

      const turnDir = join(sinkDir, 'attachments')
      // attachments/ parent may exist (we only rm the per-turn child),
      // but the per-turn child MUST be gone after the success path.
      if (existsSync(turnDir)) {
        const subdirs = readdirSync(turnDir)
        assert.equal(subdirs.length, 0,
          `expected per-turn subdir to be removed after success, found: ${subdirs.join(', ')}`)
      }
    })

    it('removes the per-turn dir when _finishTurnError fires', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-cleanup-err-'))
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._sessionId = 'test-cleanup-err'
      session._sinkDir = sinkDir
      // Simulate a turn that materialized attachments but then failed
      // post-write — _finishTurnError is the common error exit.
      const turnSubdir = join(sinkDir, 'attachments', 'msg-err')
      writeFileSync(`${sinkDir}/.placeholder`, '')   // ensure sinkDir exists
      session._activeTurn = {
        messageId: 'msg-err',
        startedAt: Date.now(),
        aborted: false,
        synthSeq: 0,
        attachmentsDir: turnSubdir,
      }
      // Materialize a real file there so the rm has something to delete.
      writeFileSync(`${sinkDir}/.scratch`, '')
      const fs = await import('fs')
      fs.mkdirSync(turnSubdir, { recursive: true })
      fs.writeFileSync(join(turnSubdir, 'att-1.png'), Buffer.from('xyz'))
      assert.ok(existsSync(turnSubdir), 'precondition: dir exists before failure')

      session.on('error', () => {})
      session._finishTurnError('something broke', 'msg-err')

      assert.equal(existsSync(turnSubdir), false,
        'per-turn attachment dir must be removed when _finishTurnError fires')
    })

    it('removes the per-turn dir when the hard timeout fires', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-cleanup-hto-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 25,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-hto'
      session._sessionId = 'test-cleanup-hto'
      session._sinkDir = sinkDir
      session._term = { write: () => {}, kill: () => {} }
      const turnSubdir = join(sinkDir, 'attachments', 'msg-hto')
      const fs = await import('fs')
      fs.mkdirSync(turnSubdir, { recursive: true })
      fs.writeFileSync(join(turnSubdir, 'att-1.png'), Buffer.from('xyz'))
      session._activeTurn = {
        messageId: 'msg-hto', startedAt: Date.now(), aborted: false, synthSeq: 0,
        attachmentsDir: turnSubdir,
      }

      session.on('error', () => {})

      session._armResultTimeout()
      await new Promise((r) => setTimeout(r, 60))

      assert.equal(existsSync(turnSubdir), false,
        'per-turn attachment dir must be removed when the hard timeout fires')
    })

    it('cleanup helper no-ops gracefully when turn had no attachments', () => {
      // The common case: 99% of turns have no attachments. The helper
      // must not throw when activeTurn lacks attachmentsDir, and must
      // not fall over if activeTurn itself is null (the PTY-exit race).
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Both of these must be no-throw.
      session._cleanupTurnAttachments(null)
      session._cleanupTurnAttachments({ messageId: 'x', startedAt: 0, aborted: false, synthSeq: 0 })
    })

    it('cleans up the per-turn dir even when every attachment is skipped', async () => {
      // Regression for the case where materializeAttachments() creates
      // the per-turn dir but every entry is malformed (missing .data),
      // so the function returns []. Pre-fix, attachmentsDir was only
      // recorded when the suffix was truthy, so an "all skipped" outcome
      // left an empty dir on disk until destroy(). After the fix, the
      // per-turn dir is recorded up-front and gets rm'd by the normal
      // success-path cleanup.
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-cleanup-skipped-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-cleanup-skipped'
      session._sinkDir = sinkDir
      session._waitForPrompt = async () => true

      let midTurnSubdirCount = -1
      session._term = {
        write: () => {
          // Snapshot disk state at the moment the PTY received the prompt;
          // success cleanup runs after the stop hook below.
          const attDir = join(sinkDir, 'attachments')
          try { midTurnSubdirCount = readdirSync(attDir).length } catch { midTurnSubdirCount = 0 }
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      // Every attachment is malformed — materializeAttachments() will
      // create the per-turn dir, skip each entry, and return [].
      await session.sendMessage('Try anyway', [
        { type: 'image', mediaType: 'image/png', data: undefined, name: 'broken1.png' },
        { type: 'image', mediaType: 'image/png', data: undefined, name: 'broken2.png' },
      ])

      // The per-turn dir was created mid-turn (mkdirSync inside materialize)
      // even though all entries were skipped — sanity-check that.
      assert.equal(midTurnSubdirCount, 1,
        'per-turn subdir should exist during the turn even when all attachments are skipped')

      // And the post-turn cleanup MUST have removed it. Pre-fix this
      // assertion would fail: the empty dir would linger because
      // attachmentsDir was never set on the activeTurn.
      const attDir = join(sinkDir, 'attachments')
      if (existsSync(attDir)) {
        const subdirs = readdirSync(attDir)
        assert.equal(subdirs.length, 0,
          `expected empty per-turn dir to be cleaned up, found: ${subdirs.join(', ')}`)
      }
    })
  })

  describe('permissionMode switch (#4013)', () => {
    // The TUI provider supports mid-session permission switch via a
    // sidecar file the permission-hook.sh script re-reads on every tool
    // call. Unlike CliSession (which restarts the process), the TUI must
    // NOT restart — that would lose the resumed conversation context that
    // the persistent PTY exists to preserve.

    it('declares permissionModeSwitch: true in capabilities', () => {
      // Dashboard gates the picker on caps.permissionModeSwitch (App.tsx:311).
      // Pre-#4013 this was false and the picker was hidden.
      assert.equal(ClaudeTuiSession.capabilities.permissionModeSwitch, true)
    })

    it('writes initial permission mode to a sidecar file at start()', async () => {
      const home = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-home-'))
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {} }))
      const origHome = process.env.HOME
      process.env.HOME = home
      const origSpawn = ClaudeTuiSession.prototype._spawnPty
      ClaudeTuiSession.prototype._spawnPty = async function () {
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
      }
      try {
        session = new ClaudeTuiSession({
          cwd: '/tmp', port: 12345, permissionMode: 'acceptEdits',
          skillsDir: emptySkillsDir, repoSkillsDir: null,
        })
        await session.start()

        assert.ok(session._permissionModeFile, 'sidecar path set')
        assert.ok(session._permissionModeFile.startsWith(session._sinkDir),
          'sidecar lives under the per-session sink dir')
        const contents = readFileSync(session._permissionModeFile, 'utf8')
        assert.equal(contents, 'acceptEdits', 'initial mode written to sidecar')
      } finally {
        ClaudeTuiSession.prototype._spawnPty = origSpawn
        process.env.HOME = origHome
        rmSync(home, { recursive: true, force: true })
      }
    })

    it('does NOT create a sidecar when permissions are disabled (no port)', async () => {
      const home = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-home2-'))
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {} }))
      const origHome = process.env.HOME
      process.env.HOME = home
      const origSpawn = ClaudeTuiSession.prototype._spawnPty
      ClaudeTuiSession.prototype._spawnPty = async function () {
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
      }
      try {
        session = new ClaudeTuiSession({
          cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        })
        await session.start()
        assert.equal(session._permissionModeFile, null, 'no sidecar without port')
      } finally {
        ClaudeTuiSession.prototype._spawnPty = origSpawn
        process.env.HOME = origHome
        rmSync(home, { recursive: true, force: true })
      }
    })

    it('setPermissionMode rewrites the sidecar without restarting the PTY', () => {
      // Hot-swap path: rewrite the file in place, keep the same PTY. If
      // we ever accidentally introduce a restart (copy-paste from
      // CliSession's override), this fails on the _term identity check.
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-sink-'))
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._sinkDir = sinkDir
      session._permissionModeFile = join(sinkDir, 'permission-mode')
      writeFileSync(session._permissionModeFile, 'approve')
      session.permissionMode = 'approve'
      const originalTerm = { write: () => {}, kill: () => {} }
      session._term = originalTerm

      session.setPermissionMode('auto')

      assert.equal(session.permissionMode, 'auto', 'instance state updated')
      assert.equal(readFileSync(session._permissionModeFile, 'utf8'), 'auto', 'sidecar rewritten')
      assert.strictEqual(session._term, originalTerm, 'PTY reference unchanged — no restart')
    })

    it('setPermissionMode no-ops cleanly when sidecar path is null', () => {
      // After destroy() or in the no-port case, _permissionModeFile is null.
      // setPermissionMode should still update instance state without throwing.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._permissionModeFile = null
      session.permissionMode = 'approve'

      session.setPermissionMode('plan')
      assert.equal(session.permissionMode, 'plan', 'state still updated')
    })

    it('setPermissionMode rejects invalid modes via super', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session.permissionMode = 'approve'
      session._permissionModeFile = null

      session.setPermissionMode('nonsense-mode')
      assert.equal(session.permissionMode, 'approve', 'state unchanged on rejection')
    })

    it('passes CHROXY_PERMISSION_MODE_FILE in env so the hook script can find the sidecar', async () => {
      // Without this env var the hook would silently fall back to the
      // env-var-only resolution and mid-session switch would never take
      // effect. Spy the env that _spawnPty would hand to node-pty.
      const home = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-home3-'))
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {} }))
      const origHome = process.env.HOME
      process.env.HOME = home
      const origSpawn = ClaudeTuiSession.prototype._spawnPty
      let capturedEnv = null
      ClaudeTuiSession.prototype._spawnPty = async function (permissionsEnabled) {
        // Mirror production env-build so the test stays honest about
        // which env vars node-pty actually receives.
        const env = { ...process.env }
        delete env.ANTHROPIC_API_KEY
        env.TERM = 'xterm-256color'
        if (permissionsEnabled) {
          env.CHROXY_PORT = String(this._port)
          env.CHROXY_HOOK_SECRET = this._hookSecret
          env.CHROXY_PERMISSION_MODE = this.permissionMode || 'approve'
          if (this._permissionModeFile) {
            env.CHROXY_PERMISSION_MODE_FILE = this._permissionModeFile
          }
        }
        capturedEnv = env
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
      }
      try {
        session = new ClaudeTuiSession({
          cwd: '/tmp', port: 12345,
          skillsDir: emptySkillsDir, repoSkillsDir: null,
        })
        await session.start()

        assert.ok(capturedEnv.CHROXY_PERMISSION_MODE_FILE, 'env var set')
        assert.equal(capturedEnv.CHROXY_PERMISSION_MODE_FILE, session._permissionModeFile,
          'env var points at the actual sidecar')
      } finally {
        ClaudeTuiSession.prototype._spawnPty = origSpawn
        process.env.HOME = origHome
        rmSync(home, { recursive: true, force: true })
      }
    })

    it('destroy() clears the sidecar reference so post-destroy setPermissionMode no-ops', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-destroy-'))
      session._sinkDir = sinkDir
      session._permissionModeFile = join(sinkDir, 'permission-mode')
      writeFileSync(session._permissionModeFile, 'approve')
      session.permissionMode = 'approve'

      await session.destroy()

      assert.equal(session._permissionModeFile, null, 'sidecar path nulled')
      session.setPermissionMode('auto')
      assert.equal(session.permissionMode, 'auto')
    })

    it('setPermissionMode writes atomically (no truncated read window)', () => {
      // The hook script reads the sidecar on every PreToolUse. A naive
      // truncate-then-write would let a concurrent reader observe an
      // empty/partial value. We verify the impl uses a tmp+rename dance
      // by asserting the final file contents are complete and no .tmp
      // siblings linger after the call.
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-atomic-'))
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._sinkDir = sinkDir
      session._permissionModeFile = join(sinkDir, 'permission-mode')
      writeFileSync(session._permissionModeFile, 'approve')
      session.permissionMode = 'approve'
      session._term = { write: () => {}, kill: () => {} }

      session.setPermissionMode('acceptEdits')

      assert.equal(readFileSync(session._permissionModeFile, 'utf8'), 'acceptEdits')
      // No leftover .tmp-<uuid> siblings — rename either succeeded
      // (sidecar replaced) or failed (tmp cleaned up in the catch).
      const lingering = readdirSync(sinkDir).filter((f) => f.startsWith('permission-mode.tmp-'))
      assert.deepEqual(lingering, [], 'no .tmp-* siblings remain after atomic update')
      rmSync(sinkDir, { recursive: true, force: true })
    })

    it('setPermissionMode swallows sidecar write failures (instance state still updates)', () => {
      // Production failure mode: disk fills mid-session, or a tmpdir
      // remount changes permissions. setPermissionMode must NOT throw
      // out to its caller (the WS handler) — the handler treats a throw
      // as session-fatal. Verify both that:
      //   (a) the call returns without throwing, and
      //   (b) instance permissionMode still reflects the requested mode
      //       (super.setPermissionMode updates state before the file
      //       write, so the in-process bookkeeping is still consistent).
      const sinkParent = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-fail-'))
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Point sidecar at a path whose PARENT directory doesn't exist.
      // writeFileSync will fail with ENOENT — the catch must swallow it.
      session._sinkDir = sinkParent
      session._permissionModeFile = join(sinkParent, 'no-such-dir', 'permission-mode')
      session.permissionMode = 'approve'
      session._term = { write: () => {}, kill: () => {} }

      // Must not throw.
      session.setPermissionMode('auto')

      assert.equal(session.permissionMode, 'auto',
        'instance state updated even though sidecar write failed')
      rmSync(sinkParent, { recursive: true, force: true })
    })
  })

  describe('destroy()', () => {
    it('kills the persistent PTY and clears state', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      let killed = false
      session._processReady = true
      session._term = {
        write: () => {},
        kill: () => { killed = true },
      }

      await session.destroy()
      assert.equal(killed, true, 'PTY killed on destroy')
      assert.equal(session._term, null, 'term reference cleared')
      assert.equal(session._destroying, true)
      assert.equal(session._processReady, false)
      assert.equal(session._isBusy, false)
    })

    it('removes the sink dir to avoid /tmp leak (#3918)', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-'))
      writeFileSync(join(sinkDir, 'stop-abc.json'), '{}')

      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._sinkDir = sinkDir
      session._processReady = true

      await session.destroy()

      assert.equal(existsSync(sinkDir), false, 'sink dir removed on destroy')
      assert.equal(session._sinkDir, null, 'reference cleared')
    })

    // #5317 (WP-2.3) — SIGTERM alone leaves a hung claude (and its tool
    // children) orphaned. destroy() must escalate to SIGKILL after a grace
    // window, and reap the whole process group, but NOT fire when the process
    // exits cleanly in response to SIGTERM.
    describe('SIGKILL escalation (#5317 WP-2.3)', () => {
      beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }) })
      afterEach(() => { mock.timers.reset(); mock.restoreAll() })

      function makeLiveSession(onKill) {
        const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        s._processReady = true
        s._sessionId = 'conv-uuid-1234'
        s._term = { write: () => {}, kill: (sig) => onKill(sig), onData: () => {}, onExit: () => {}, on: () => {}, pid: 4242 }
        s.on('error', () => {})
        return s
      }

      it('SIGTERMs immediately and arms the escalation timer', async () => {
        const signals = []
        const s = makeLiveSession((sig) => signals.push(sig))
        await s.destroy()
        assert.deepEqual(signals, ['SIGTERM'], 'SIGTERM sent on destroy')
        assert.ok(s._killTimer, 'SIGKILL escalation timer armed')
        assert.equal(s._term, null, 'term reference cleared')
      })

      it('escalates to SIGKILL when the PTY ignores SIGTERM past the grace window', async () => {
        const termSignals = []
        const procSignals = []
        // Mock process.kill so no real signal leaves the test. Signal 0 is the
        // liveness probe — return success (still alive). Throw on the
        // process-group SIGKILL to deterministically exercise the term.kill fallback.
        mock.method(process, 'kill', (pid, sig) => {
          procSignals.push([pid, sig])
          if (sig === 0) return // liveness probe: process is alive
          throw new Error('ESRCH')
        })
        const s = makeLiveSession((sig) => termSignals.push(sig))
        await s.destroy()
        assert.deepEqual(termSignals, ['SIGTERM'])

        mock.timers.tick(ClaudeTuiSession.DESTROY_GRACE_MS)

        assert.deepEqual(procSignals[0], [4242, 0], 'probes liveness with signal 0 first')
        assert.deepEqual(procSignals[1], [-4242, 'SIGKILL'], 'then attempts process-group SIGKILL')
        assert.deepEqual(termSignals, ['SIGTERM', 'SIGKILL'], 'falls back to term SIGKILL when the group signal fails')
        assert.equal(s._killTimer, null, 'escalation timer cleared after firing')
      })

      it('reaps the whole process group when the group signal is deliverable', async () => {
        const termSignals = []
        const procSignals = []
        mock.method(process, 'kill', (pid, sig) => { procSignals.push([pid, sig]) })
        const s = makeLiveSession((sig) => termSignals.push(sig))
        await s.destroy()
        mock.timers.tick(ClaudeTuiSession.DESTROY_GRACE_MS)

        assert.deepEqual(procSignals, [[4242, 0], [-4242, 'SIGKILL']], 'liveness probe then group SIGKILL')
        assert.deepEqual(termSignals, ['SIGTERM'], 'no per-pid fallback when the group kill succeeds')
      })

      it('does NOT escalate when the PTY exits within the grace window', async () => {
        const termSignals = []
        const s = makeLiveSession((sig) => termSignals.push(sig))
        await s.destroy()
        // Process exits in response to SIGTERM (onExit → _onPtyGone), which must
        // cancel the escalation timer.
        s._onPtyGone({ exitCode: 0, signal: 'SIGTERM' }, 'exit')
        assert.equal(s._killTimer, null, 'escalation timer cancelled on clean exit')

        mock.timers.tick(ClaudeTuiSession.DESTROY_GRACE_MS)
        assert.deepEqual(termSignals, ['SIGTERM'], 'no SIGKILL after a clean exit')
      })

      it('does NOT escalate when the _ptyExited latch is set before the timer fires (#5351 review)', async () => {
        // node-pty reaps the pid before firing the JS onExit, so the timer can
        // fire while onExit is still queued. The latch check inside the timer is
        // the primary guard against killing a (possibly recycled) pid.
        const termSignals = []
        const procSignals = []
        mock.method(process, 'kill', (pid, sig) => { procSignals.push([pid, sig]) })
        const s = makeLiveSession((sig) => termSignals.push(sig))
        await s.destroy()
        // Simulate "onExit latched but did NOT clear the timer" (defensive — the
        // timer must self-guard even if the clear was somehow missed). The timer
        // is still armed from destroy() above.
        assert.ok(s._killTimer, 'timer armed')
        s._ptyExited = true

        mock.timers.tick(ClaudeTuiSession.DESTROY_GRACE_MS)
        assert.deepEqual(procSignals, [], 'no kill signal sent once the process is known gone')
        assert.deepEqual(termSignals, ['SIGTERM'], 'no SIGKILL when _ptyExited is set')
      })

      it('does NOT escalate when the liveness probe shows the pid already gone (#5351 review)', async () => {
        const termSignals = []
        const procSignals = []
        // Liveness probe (signal 0) throws ESRCH → pid already exited (reaped,
        // not recycled). Must bail before any SIGKILL.
        mock.method(process, 'kill', (pid, sig) => {
          procSignals.push([pid, sig])
          if (sig === 0) throw new Error('ESRCH')
        })
        const s = makeLiveSession((sig) => termSignals.push(sig))
        await s.destroy()
        // Latch NOT set (onExit callback hasn't run), but the OS already reaped it.
        mock.timers.tick(ClaudeTuiSession.DESTROY_GRACE_MS)

        assert.deepEqual(procSignals, [[4242, 0]], 'only the liveness probe ran; no kill followed')
        assert.deepEqual(termSignals, ['SIGTERM'], 'no SIGKILL when the liveness probe says the pid is gone')
      })

      it('arms no escalation timer when the PTY has no usable pid', async () => {
        const signals = []
        const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        s._processReady = true
        s._term = { write: () => {}, kill: (sig) => signals.push(sig) } // no pid
        s.on('error', () => {})
        await s.destroy()
        assert.deepEqual(signals, ['SIGTERM'], 'SIGTERM still sent')
        assert.equal(s._killTimer, null, 'no escalation timer without a pid')
      })

      it('sends NO signal when the PTY already exited before destroy() (#5351 review)', async () => {
        // Crash / respawn-exhaustion teardown: _onPtyGone already ran (_ptyExited
        // true) but did NOT null _term, so destroy() sees a non-null _term for an
        // already-reaped (possibly recycled) pid. It must signal nothing.
        const termSignals = []
        const procSignals = []
        mock.method(process, 'kill', (pid, sig) => { procSignals.push([pid, sig]) })
        const s = makeLiveSession((sig) => termSignals.push(sig))
        s._ptyExited = true // process already gone, _term still set

        await s.destroy()
        assert.deepEqual(termSignals, [], 'no SIGTERM to an already-reaped pid')
        assert.equal(s._killTimer, null, 'no escalation timer armed')

        mock.timers.tick(ClaudeTuiSession.DESTROY_GRACE_MS)
        assert.deepEqual(procSignals, [], 'no signals sent at all')
      })
    })
  })

  describe('inactivity timer (#3920)', () => {
    it('emits inactivity_warning after _resultTimeoutMs of silence', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 25, hardTimeoutMs: 5000,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-7'

      let warning = null
      session.on('inactivity_warning', (e) => { warning = e })

      session._armResultTimeout()
      await new Promise((r) => setTimeout(r, 60))

      assert.ok(warning, 'warning fired')
      assert.equal(warning.messageId, 'msg-7')
      assert.equal(warning.idleMs, 25)
      assert.equal(warning.prefab, 'Status update?')
    })

    it('hard timeout force-clears busy state + emits error', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 25,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-9'
      session._term = { write: () => {}, kill: () => {} }

      const errors = []
      session.on('error', (e) => errors.push(e))

      session._armResultTimeout()
      await new Promise((r) => setTimeout(r, 60))

      assert.equal(session._isBusy, false, 'force-cleared')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /timed out/)
    })
  })

  // #5318 (WP-3.1) — while a human is answering an AskUserQuestion, the human is
  // the bottleneck, not claude, so the silence-detecting backstops
  // (soft-inactivity, stream-stall, first-output) are suspended. The HARD cap
  // deliberately stays armed (last-resort backstop). A slow human must not trip
  // a misleading force-cancel; a genuinely wedged form still recovers via the
  // dedicated AskUserQuestion watchdog.
  describe('backstop suspension during pending AskUserQuestion (#5318 WP-3.1)', () => {
    function makeSession() {
      return new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 10_000, hardTimeoutMs: 20_000,
        streamStallTimeoutMs: 5_000, firstOutputTimeoutMs: 5_000,
      })
    }
    function setPending(s, tid = 'tid-1') {
      s._pendingUserAnswer = { toolUseId: tid, questions: [{ options: [] }], options: [] }
    }

    it('_armResultTimeout arms all backstops when no question is pending', async () => {
      const s = makeSession()
      s._isBusy = true
      s._currentMessageId = 'msg-1'
      s._armResultTimeout()
      assert.ok(s._resultTimeout, 'soft inactivity armed')
      assert.ok(s._hardTimeout, 'hard armed')
      assert.ok(s._streamStallTimeout, 'stream-stall armed')
      await s.destroy()
    })

    it('_armResultTimeout suspends the silence backstops (hard cap stays armed) while a question is pending', async () => {
      const s = makeSession()
      s._isBusy = true
      s._currentMessageId = 'msg-1'
      s._armResultTimeout() // arm normally first
      setPending(s)
      s._armResultTimeout() // a hook-drain re-arm while pending must NOT resurrect them
      assert.equal(s._resultTimeout, null, 'soft suspended')
      assert.equal(s._streamStallTimeout, null, 'stream-stall suspended')
      assert.equal(s._firstOutputTimeout, null, 'first-output suspended')
      assert.ok(s._hardTimeout, 'hard cap stays armed (last-resort backstop)')
      await s.destroy()
    })

    it('resumes the backstops once the pending answer clears', async () => {
      const s = makeSession()
      s._isBusy = true
      s._currentMessageId = 'msg-1'
      setPending(s)
      s._armResultTimeout()
      assert.equal(s._streamStallTimeout, null, 'suspended while pending')

      s._clearPendingAnswerByToolUseId('tid-1')
      s._armResultTimeout() // mirrors the drain-loop re-arm after PostToolUse
      assert.ok(s._streamStallTimeout, 'stream-stall re-armed after the answer clears')
      assert.ok(s._hardTimeout, 'hard re-armed')
      assert.ok(s._resultTimeout, 'soft re-armed')
      await s.destroy()
    })

    it('_handleStreamStall does NOT tear down while a question is pending', async () => {
      const s = makeSession()
      s._isBusy = true
      s._currentMessageId = 'msg-1'
      setPending(s)
      const errors = []
      s.on('error', (e) => errors.push(e))
      s._handleStreamStall()
      assert.equal(s._isBusy, true, 'still busy — no force-cancel mid-answer')
      assert.equal(errors.length, 0, 'no stream_stall error emitted')
      await s.destroy()
    })

    it('_handleHardTimeout STILL force-clears + clears pending (last-resort backstop is not suspended)', async () => {
      const s = makeSession()
      s._isBusy = true
      s._currentMessageId = 'msg-1'
      setPending(s)
      const errors = []
      s.on('error', (e) => errors.push(e))
      s._handleHardTimeout()
      assert.equal(s._isBusy, false, 'hard cap force-clears even across a pending question')
      assert.equal(s._pendingUserAnswers.size, 0, 'hard timeout also clears the pending answer (#4691)')
      assert.equal(errors.length, 1, 'hard-timeout error emitted')
      await s.destroy()
    })

    it('driving an AskUserQuestion PreToolUse suspends the backstops end-to-end', async () => {
      const s = makeSession()
      s._activeTurn = { uuid: 'test', synthSeq: 0 }
      s._isBusy = true
      s._currentMessageId = 'msg-aq'
      s.on('user_question', () => {})
      s._armResultTimeout()
      assert.ok(s._streamStallTimeout, 'armed before the question')

      s._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_aq',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Q?', options: [{ label: 'a' }] }] },
      }, 'msg-aq')

      assert.equal(s._pendingUserAnswers.size, 1, 'question pending')
      assert.equal(s._streamStallTimeout, null, 'stream-stall suspended on user_question')
      assert.equal(s._resultTimeout, null, 'soft suspended')
      assert.ok(s._hardTimeout, 'hard cap stays armed')

      // #5352 review — drive the matching PostToolUse and re-arm exactly as the
      // hook-drain loop does (clear pending inside _emitToolHookEvent, then
      // _armResultTimeout) to prove resume happens via the production path.
      s._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_aq',
        tool_name: 'AskUserQuestion',
        tool_response: 'done',
      }, 'msg-aq')
      assert.equal(s._pendingUserAnswers.size, 0, 'PostToolUse cleared the pending answer')
      s._armResultTimeout() // the drain loop's re-arm after a consumed hook
      assert.ok(s._streamStallTimeout, 'stream-stall re-armed once the answer cleared')
      assert.ok(s._resultTimeout, 'soft re-armed')
      await s.destroy()
    })

    it('suspending backstops does NOT cancel the AskUserQuestion watchdog (wedge recovery survives)', async () => {
      const s = makeSession()
      s._armAskUserQuestionWatchdog('toolu_wd')
      const wd = s._askUserQuestionWatchdogs.get('toolu_wd')
      assert.ok(wd, 'watchdog armed')
      s._suspendBackstopsForPendingQuestion()
      assert.equal(s._askUserQuestionWatchdogs.get('toolu_wd'), wd, 'the dedicated watchdog is left intact')
      await s.destroy()
    })
  })

  // #4638 — stream-stall active-recovery watchdog. CLI + SDK got this in
  // #4467; TUI was the outlier and surfaced the wedge as a "Working…"
  // banner that ticked forever when claude TUI accepted the prompt and
  // emitted nothing. The fire path mirrors CliSession._handleStreamStall
  // and SdkSession._handleStreamStall — stream_end + result fan-out +
  // error{code:'stream_stall'} — so the dashboard's existing recovery
  // affordance triggers without provider-specific handling.
  describe('stream-stall watchdog (#4638)', () => {
    it('fires after _streamStallTimeoutMs, clears busy state, emits the full recovery burst', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        // Long soft+hard so the stall timer wins; short stall so the
        // test doesn't sleep for seconds.
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 25,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-stall'
      // Backdated startedAt so we can assert duration > 0 below — proves the
      // computed duration is derived from _activeTurn.startedAt rather than
      // the fallback to _streamStallTimeoutMs. #5332: startedAt is now on the
      // monotonic clock, so seed it from the same clock (not Date.now()).
      const TURN_AGE_MS = 100
      session._activeTurn = { startedAt: session._nowMonotonic() - TURN_AGE_MS, aborted: false }
      const ptyWrites = []
      session._term = { write: (b) => ptyWrites.push(b), kill: () => {} }

      const events = []
      session.on('stream_end', (e) => events.push({ type: 'stream_end', ...e }))
      session.on('result', (e) => events.push({ type: 'result', ...e }))
      session.on('error', (e) => events.push({ type: 'error', ...e }))

      session._armResultTimeout()
      await new Promise((r) => setTimeout(r, 80))

      assert.equal(session._isBusy, false, 'busy cleared')
      assert.equal(session._currentMessageId, null, 'messageId nulled')
      // Best-effort Ctrl-C interrupt so claude TUI itself unsticks.
      assert.ok(ptyWrites.includes('\x03'), 'Ctrl-C written to PTY')

      const types = events.map((e) => e.type)
      assert.deepEqual(types, ['stream_end', 'result', 'error'],
        'fan-out order: stream_end → result → error')

      const streamEnd = events.find((e) => e.type === 'stream_end')
      assert.equal(streamEnd.messageId, 'msg-stall')

      const result = events.find((e) => e.type === 'result')
      assert.equal(result.cost, null, 'cost=null skips billing accumulation')
      assert.ok(Number.isFinite(result.duration), 'duration is finite')
      assert.ok(result.duration >= TURN_AGE_MS,
        `duration ≥ TURN_AGE_MS (${TURN_AGE_MS}ms) — sourced from _activeTurn.startedAt`)

      const err = events.find((e) => e.type === 'error')
      assert.equal(err.code, 'stream_stall', 'distinct code for dashboard chip')
      assert.match(err.message, /Stream stalled/)
    })

    it('is a no-op when not busy (late fire after natural turn-end)', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
      })
      session._isBusy = false  // turn already ended

      const events = []
      session.on('stream_end', () => events.push('stream_end'))
      session.on('result', () => events.push('result'))
      session.on('error', () => events.push('error'))

      session._handleStreamStall()
      assert.deepEqual(events, [], 'no events fired when not busy')
    })

    it('is disabled when streamStallTimeoutMs=0 (operator opt-out)', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 0,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-disabled'
      session._term = { write: () => {}, kill: () => {} }

      session._armResultTimeout()
      assert.equal(session._streamStallTimeout, null, 'stall timer not armed when disabled')

      // Wait a few ticks just to be extra sure nothing fires.
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(session._isBusy, true, 'still busy — watchdog opted out')
    })

    it('is cleared by _finishTurnError so a stalled-after-error fire cannot land', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
      })
      session.on('error', () => {})  // swallow
      session._isBusy = true
      session._currentMessageId = 'msg-x'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }

      session._armResultTimeout()
      assert.ok(session._streamStallTimeout, 'stall timer armed')

      session._finishTurnError('test', 'msg-x')
      assert.equal(session._streamStallTimeout, null, 'stall timer cleared on error path')
    })

    it('is cleared by destroy() so a late fire cannot land on a torn-down session', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-d'
      session._armResultTimeout()
      assert.ok(session._streamStallTimeout, 'stall timer armed')

      await session.destroy()
      assert.equal(session._streamStallTimeout, null, 'stall timer cleared on destroy')
    })
  })

  // #4732 — pre-first-output silence watchdog. The existing #4638
  // streamStallTimeout only re-arms BETWEEN hook events; a turn where
  // claude TUI accepts the prompt write but never emits ANY hook (stuck
  // Anthropic API call, frozen dialog screen) had no recoverable
  // watchdog short of the 2h hard cap. _firstOutputTimeout arms at
  // _armResultTimeout() time and disarms on the first consumed hook
  // event, surfacing a stream_stall with the same dashboard chip the
  // inter-stream watchdog uses so the user can retry within minutes.
  describe('first-turn submit nudge (#5777)', () => {
    // A freshly-spawned TUI can report ready before its composer accepts the
    // submit, so the first message's \r is dropped. _scheduleFirstTurnSubmitNudge
    // re-sends a bare \r if no hook output arrives within the window.
    function nudgeSession(overrides = {}) {
      const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      s._isBusy = true
      s._ptyExited = false
      s._firstOutputDisarmed = false
      s._activeTurn = { startedAt: Date.now(), aborted: false }
      s._firstTurnSubmitNudgeMs = 20
      const writes = []
      s._term = { write: (b) => writes.push(b), kill: () => {} }
      Object.assign(s, overrides)
      s._termWrites = writes
      return s
    }

    it('re-sends a bare \\r when no hook output arrives within the window', async () => {
      session = nudgeSession()
      session._scheduleFirstTurnSubmitNudge('m1')
      await new Promise((r) => setTimeout(r, 35))
      assert.ok(session._termWrites.includes('\r'), 'bare \\r re-sent to nudge the submit')
    })

    it('does NOT nudge once first output arrived (disarm clears the timer)', async () => {
      session = nudgeSession()
      session._scheduleFirstTurnSubmitNudge('m1')
      // First consumed hook → _clearFirstOutputWatchdog also cancels the nudge.
      session._clearFirstOutputWatchdog()
      assert.equal(session._firstTurnSubmitNudgeTimer, null, 'nudge timer cancelled on first output')
      await new Promise((r) => setTimeout(r, 35))
      assert.equal(session._termWrites.length, 0, 'no \\r written after first output')
    })

    it('stops after FIRST_TURN_SUBMIT_NUDGE_MAX_ATTEMPTS', async () => {
      session = nudgeSession()
      session._scheduleFirstTurnSubmitNudge('m1')
      await new Promise((r) => setTimeout(r, 120))
      const crs = session._termWrites.filter((w) => w === '\r').length
      assert.equal(crs, ClaudeTuiSession.FIRST_TURN_SUBMIT_NUDGE_MAX_ATTEMPTS, 'caps at MAX_ATTEMPTS then defers to the first-output watchdog')
    })

    it('does not nudge when the PTY has exited or the turn aborted', async () => {
      session = nudgeSession({ _ptyExited: true })
      session._scheduleFirstTurnSubmitNudge('m1')
      await new Promise((r) => setTimeout(r, 35))
      assert.equal(session._termWrites.length, 0, 'no \\r when PTY exited')

      const s2 = nudgeSession()
      s2._activeTurn.aborted = true
      s2._scheduleFirstTurnSubmitNudge('m2')
      await new Promise((r) => setTimeout(r, 35))
      assert.equal(s2._termWrites.length, 0, 'no \\r when turn aborted')
      s2.destroy?.()
    })

    it('cancels a live armed nudge on PTY death (_onPtyGone) (#5788)', async () => {
      session = nudgeSession({ _destroying: true })  // _destroying → _onPtyGone returns early after clearing
      session._scheduleFirstTurnSubmitNudge('m1')
      assert.ok(session._firstTurnSubmitNudgeTimer, 'nudge armed')
      session._onPtyGone({ exitCode: 1 }, 'test')
      assert.equal(session._firstTurnSubmitNudgeTimer, null, 'nudge cancelled by _onPtyGone')
      await new Promise((r) => setTimeout(r, 35))
      assert.equal(session._termWrites.length, 0, 'no \\r after PTY death')
    })

    it('cancels a live armed nudge on destroy() (via _clearFirstOutputWatchdog)', async () => {
      session = nudgeSession()
      session._scheduleFirstTurnSubmitNudge('m1')
      assert.ok(session._firstTurnSubmitNudgeTimer, 'nudge armed')
      session.destroy()
      assert.equal(session._firstTurnSubmitNudgeTimer, null, 'nudge cancelled by destroy()')
      await new Promise((r) => setTimeout(r, 35))
      assert.equal(session._termWrites.length, 0, 'no \\r after destroy')
    })

    it('is disabled when _firstTurnSubmitNudgeMs <= 0', async () => {
      session = nudgeSession({ _firstTurnSubmitNudgeMs: 0 })
      session._scheduleFirstTurnSubmitNudge('m1')
      assert.equal(session._firstTurnSubmitNudgeTimer, null, 'no timer scheduled when disabled')
      await new Promise((r) => setTimeout(r, 35))
      assert.equal(session._termWrites.length, 0, 'no \\r when disabled')
    })

    // #5794 (3): slow-but-healthy first turn. The submit DID land — the TUI
    // re-rendered (output landed in _outputTail) — but the first hook arrives
    // after the nudge window. The no-progress guard must NOT fire a stray \r.
    it('does NOT nudge a slow-but-healthy first turn (output grew, hook not yet drained) (#5794)', async () => {
      session = nudgeSession()
      session._totalOutputBytes = 0 // armed with no output yet
      session._scheduleFirstTurnSubmitNudge('m1')
      // Submit landed: claude re-renders the composer + spinner, which arrives as
      // PTY output BEFORE its first hook file is written (_firstOutputDisarmed
      // still false). #5809: use the uncapped byte total, not _outputTail.length.
      session._totalOutputBytes += 14
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(session._termWrites.filter((w) => w === '\r').length, 0, 'no stray \\r when output grew since arm')
    })

    // #5809: the cap case — _outputTail is already pinned at PTY_TAIL_BYTES (long
    // resume transcript) so its length can't grow, but _totalOutputBytes still
    // does, so the guard correctly suppresses the nudge on a healthy turn.
    it('does NOT nudge when the tail is at cap but total output still grew (#5809)', async () => {
      session = nudgeSession()
      session._outputTail = 'x'.repeat(ClaudeTuiSession.PTY_TAIL_BYTES) // pinned at cap
      session._totalOutputBytes = ClaudeTuiSession.PTY_TAIL_BYTES
      session._scheduleFirstTurnSubmitNudge('m1')
      // More output arrives; _outputTail.length stays at the cap, _totalOutputBytes grows.
      session._totalOutputBytes += 50
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(session._termWrites.filter((w) => w === '\r').length, 0, 'no stray \\r when total output grew despite a capped tail')
    })

    // #5794 (3): the no-progress guard only suppresses when output GREW. A
    // genuinely wedged turn (no new output) still gets nudged.
    it('still nudges when output has NOT grown since arm (#5794)', async () => {
      session = nudgeSession()
      session._totalOutputBytes = 100 // some prior output, but none after arm
      session._scheduleFirstTurnSubmitNudge('m1')
      await new Promise((r) => setTimeout(r, 35))
      assert.ok(session._termWrites.includes('\r'), 'wedged turn (no output growth) still nudged')
    })
  })

  // #5794 (1) + (2): the sendMessage-level arming gates — bracketed-paste path
  // is never nudged, and the nudge re-arms on the first message of each spawn.
  describe('first-turn submit nudge arming gates (#5794)', () => {
    // Mirrors the gate in sendMessage so we can assert it without driving a full
    // PTY turn. sendMessage arms iff: !_firstTurnNudgedForSpawn && !hasNewlines,
    // and flips the latch true when it arms. _spawnPty resets the latch to false.
    function wouldArm(s, promptToSend) {
      const hasNewlines = /\r?\n/.test(promptToSend || '')
      if (!s._firstTurnNudgedForSpawn && !hasNewlines) {
        s._firstTurnNudgedForSpawn = true
        return true
      }
      return false
    }

    it('arms for a single-line first message', () => {
      const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(s._firstTurnNudgedForSpawn, false, 'latch starts unset')
      assert.equal(wouldArm(s, 'hello world'), true, 'single-line first message arms')
      assert.equal(s._firstTurnNudgedForSpawn, true, 'latch set after arming')
    })

    it('does NOT arm for a multi-line (bracketed-paste) first message', () => {
      const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(wouldArm(s, 'line one\nline two'), false, 'multi-line first message takes the bracketed-paste path — not nudged')
      assert.equal(s._firstTurnNudgedForSpawn, false, 'latch stays unset so a later single-line message can still arm')
      // CRLF also counts as multi-line (matches _writePtyTextThrottled).
      assert.equal(wouldArm(s, 'a\r\nb'), false, 'CRLF first message not nudged either')
    })

    it('arms only once per spawn (second message does not re-arm)', () => {
      const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(wouldArm(s, 'first'), true, 'first message arms')
      assert.equal(wouldArm(s, 'second'), false, 'second message of the same spawn does not re-arm')
    })

    it('re-arms on the first message after a (re)spawn resets the latch (#5794)', () => {
      const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(wouldArm(s, 'first'), true, 'lifetime-first message arms')
      assert.equal(wouldArm(s, 'second'), false, 'subsequent same-spawn message does not')
      // _spawnPty resets the latch on every successful (re)spawn.
      s._firstTurnNudgedForSpawn = false
      assert.equal(wouldArm(s, 'post-respawn first'), true, 'first message after respawn re-arms even though _messageCounter > 1')
    })
  })

  describe('first-output watchdog (#4732)', () => {
    it('fires after _firstOutputTimeoutMs of zero hook events, clears busy state, emits stream_stall', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        // Long soft+hard+stream-stall so the first-output timer wins;
        // short first-output so the test doesn't sleep for seconds.
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
        firstOutputTimeoutMs: 25,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-first-output'
      const TURN_AGE_MS = 100
      session._activeTurn = { startedAt: Date.now() - TURN_AGE_MS, aborted: false }
      const ptyWrites = []
      session._term = { write: (b) => ptyWrites.push(b), kill: () => {} }

      const events = []
      session.on('stream_end', (e) => events.push({ type: 'stream_end', ...e }))
      session.on('result', (e) => events.push({ type: 'result', ...e }))
      session.on('error', (e) => events.push({ type: 'error', ...e }))

      session._armResultTimeout()
      assert.ok(session._firstOutputTimeout, 'first-output timer armed by _armResultTimeout')
      await new Promise((r) => setTimeout(r, 80))

      assert.equal(session._isBusy, false, 'busy cleared')
      assert.equal(session._currentMessageId, null, 'messageId nulled')
      assert.ok(ptyWrites.includes('\x03'), 'Ctrl-C written to PTY')

      const types = events.map((e) => e.type)
      assert.deepEqual(types, ['stream_end', 'result', 'error'],
        'fan-out order matches stream-stall path: stream_end → result → error')

      const err = events.find((e) => e.type === 'error')
      assert.equal(err.code, 'stream_stall', 'distinct code reuses dashboard chip wire')
      assert.match(err.message, /No response/i)
    })

    it('is disarmed by the first consumed hook event (does not fire on healthy turn)', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
        firstOutputTimeoutMs: 50,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-healthy'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }

      session._armResultTimeout()
      assert.ok(session._firstOutputTimeout, 'first-output timer armed')

      // Disarm helper the sendMessage poll loop calls when any hook
      // file is consumed; documents that the watchdog can be cleared
      // without re-arming the inter-stream timer.
      session._clearFirstOutputWatchdog()
      assert.equal(session._firstOutputTimeout, null, 'first-output timer cleared')

      // Wait past the original window — should NOT fire.
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(session._isBusy, true, 'still busy — watchdog disarmed before fire')
    })

    it('is disabled when firstOutputTimeoutMs=0 (operator opt-out)', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
        firstOutputTimeoutMs: 0,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-opt-out'
      session._term = { write: () => {}, kill: () => {} }

      session._armResultTimeout()
      assert.equal(session._firstOutputTimeout, null, 'first-output timer not armed when disabled')

      await new Promise((r) => setTimeout(r, 30))
      assert.equal(session._isBusy, true, 'still busy — watchdog opted out')
    })

    it('is cleared by _finishTurnError so a stalled-after-error fire cannot land', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
        firstOutputTimeoutMs: 5000,
      })
      session.on('error', () => {})  // swallow
      session._isBusy = true
      session._currentMessageId = 'msg-fte'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }

      session._armResultTimeout()
      assert.ok(session._firstOutputTimeout, 'first-output timer armed')

      session._finishTurnError('test', 'msg-fte')
      assert.equal(session._firstOutputTimeout, null, 'first-output timer cleared on error path')
    })

    it('is cleared by destroy() so a late fire cannot land on a torn-down session', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
        firstOutputTimeoutMs: 5000,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-d-fo'
      session._armResultTimeout()
      assert.ok(session._firstOutputTimeout, 'first-output timer armed')

      await session.destroy()
      assert.equal(session._firstOutputTimeout, null, 'first-output timer cleared on destroy')
    })

    it('logs explicit elapsedMs line when fired', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
        firstOutputTimeoutMs: 25,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-log'
      session._activeTurn = { startedAt: Date.now() - 30, aborted: false }
      session._term = { write: () => {}, kill: () => {} }
      session.on('error', () => {})
      session.on('result', () => {})
      session.on('stream_end', () => {})

      const logs = []
      const listener = (entry) => logs.push(entry)
      addLogListener(listener)
      try {
        session._armResultTimeout()
        await new Promise((r) => setTimeout(r, 80))
      } finally {
        removeLogListener(listener)
      }

      const matched = logs.find((l) => /first-output watchdog fired/i.test(l.message ?? ''))
      assert.ok(matched, 'log line present: ' + JSON.stringify(logs.map((l) => l.message).slice(-5)))
      assert.match(matched.message, /elapsedMs=\d+/, 'log line includes elapsedMs')
      assert.match(matched.message, /claude TUI did not respond/, 'log line includes did-not-respond marker')
    })
  })

  // #4641 — `_teardownTurn` is the shared helper extracted from
  // `_handleHardTimeout` and `_handleStreamStall`. Both call sites
  // already have their own end-to-end coverage (see `inactivity timer`
  // and `stream-stall watchdog` describe blocks above) which is the
  // primary behaviour pin. These tests exercise the helper's flag
  // surface directly so the asymmetry between callers stays visible:
  //   - `gateStreamEndOnMessageId: false` (hard-timeout) emits
  //     stream_end even when messageId is null.
  //   - `gateStreamEndOnMessageId: true` (stream-stall) skips the
  //     stream_end when messageId is null.
  //   - `errorBeforeResult: true` (hard-timeout) places `error` before
  //     `result` in the fan-out.
  //   - `errorBeforeResult: false` (stream-stall) places `result`
  //     before `error`.
  //   - Common cleanup (Ctrl-C, attachment dir drop, busy/messageId
  //     null, AskUserQuestion slot/lock/watchdog clear) happens
  //     regardless of flags.
  describe('_teardownTurn shared helper (#4641)', () => {
    it('clears per-turn state and writes Ctrl-C regardless of flags', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session.on('error', () => {})  // swallow
      session._isBusy = true
      session._currentMessageId = 'msg-helper'
      session._activeTurn = { startedAt: Date.now() - 50, aborted: false }
      session._pendingUserAnswer = { toolUseId: 'toolu_helper' }
      session._armAskUserQuestionWatchdog('toolu_helper')
      const ptyWrites = []
      session._term = { write: (b) => ptyWrites.push(b), kill: () => {} }

      session._teardownTurn('helper_unit', { duration: 50 })

      assert.ok(ptyWrites.includes('\x03'), 'Ctrl-C written to PTY')
      assert.equal(session._activeTurn, null, '_activeTurn nulled')
      assert.equal(session._isBusy, false, '_isBusy cleared')
      assert.equal(session._currentMessageId, null, '_currentMessageId nulled')
      assert.equal(session._pendingUserAnswer, null, '_pendingUserAnswer cleared')
      assert.equal(session._askUserQuestionWatchdogs.size, 0, 'all AskUserQuestion watchdogs cleared')
    })

    it('emits stream_end + result; skips error when no errorPayload given', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-noerr'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }

      const events = []
      session.on('stream_end', (e) => events.push({ type: 'stream_end', ...e }))
      session.on('result', (e) => events.push({ type: 'result', ...e }))
      session.on('error', (e) => events.push({ type: 'error', ...e }))

      session._teardownTurn('helper_no_error', { duration: 10 })

      const types = events.map((e) => e.type)
      assert.deepEqual(types, ['stream_end', 'result'], 'no error emitted without errorPayload')
    })

    it('errorBeforeResult=true emits error → result (hard-timeout shape)', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-order-a'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }

      const events = []
      session.on('stream_end', () => events.push('stream_end'))
      session.on('result', () => events.push('result'))
      session.on('error', () => events.push('error'))

      session._teardownTurn('helper_err_first', {
        duration: 1,
        errorPayload: { message: 'boom' },
        errorBeforeResult: true,
      })

      assert.deepEqual(events, ['stream_end', 'error', 'result'],
        'fan-out: stream_end → error → result when errorBeforeResult=true')
    })

    it('errorBeforeResult=false emits result → error (stream-stall shape)', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-order-b'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }

      const events = []
      session.on('stream_end', () => events.push('stream_end'))
      session.on('result', () => events.push('result'))
      session.on('error', () => events.push('error'))

      session._teardownTurn('helper_result_first', {
        duration: 1,
        errorPayload: { code: 'stream_stall', message: 'stalled' },
        errorBeforeResult: false,
      })

      assert.deepEqual(events, ['stream_end', 'result', 'error'],
        'fan-out: stream_end → result → error when errorBeforeResult=false (default)')
    })

    it('gateStreamEndOnMessageId=true skips stream_end when messageId is null (stream-stall shape)', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session.on('error', () => {})  // swallow
      session._isBusy = true
      session._currentMessageId = null  // contract violation, but the gate exists for a reason (#4642)
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }

      const events = []
      session.on('stream_end', () => events.push('stream_end'))

      session._teardownTurn('helper_gated', {
        duration: 1,
        errorPayload: { message: 'x' },
        gateStreamEndOnMessageId: true,
      })

      assert.deepEqual(events, [], 'stream_end suppressed when messageId is null and gate is on')
    })

    it('gateStreamEndOnMessageId=false emits stream_end with null messageId (hard-timeout shape)', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session.on('error', () => {})  // swallow
      session._isBusy = true
      session._currentMessageId = null
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }

      const events = []
      session.on('stream_end', (e) => events.push(e))

      session._teardownTurn('helper_ungated', {
        duration: 1,
        errorPayload: { message: 'x' },
        gateStreamEndOnMessageId: false,
      })

      assert.equal(events.length, 1, 'stream_end emitted unconditionally')
      assert.equal(events[0].messageId, null, 'messageId propagated as null — matches historical hard-timeout behaviour')
    })

    it('forwards duration + sessionId into the result event payload', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-reason'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._sessionId = 'sess-helper-42'
      session._term = { write: () => {}, kill: () => {} }

      let resultEvent = null
      session.on('result', (e) => { resultEvent = e })

      session._teardownTurn('hard_timeout', { duration: 42 })

      assert.ok(resultEvent, 'result event fired')
      assert.equal(resultEvent.cost, null, 'cost null (subscription billing) — matches inline historical payload')
      assert.equal(resultEvent.duration, 42, 'duration propagated from caller')
      assert.equal(resultEvent.usage, null, 'usage null (no token accounting on the teardown path)')
      assert.equal(resultEvent.sessionId, 'sess-helper-42', 'sessionId stamped from _sessionId')
    })
  })

  // #4682 — per-turn summary log emitted from the shared _teardownTurn
  // helper. PR #4681 added _logSendMessageSummary for the wedge
  // investigation but originally only wired it into the success path
  // and _finishTurnError. The stream-stall watchdog (#4638) and
  // hard-timeout (#3920) finishers also null _activeTurn but skipped
  // the helper, so the very wedge modes the instrumentation was
  // designed to diagnose left no grep-able trail. After #4641
  // refactored both finishers to delegate to _teardownTurn, the
  // summary log lives at the top of the helper so every teardown path
  // gets a uniform `sendMessage done` line.
  describe('per-turn summary log on teardown paths (#4682)', () => {
    it('_teardownTurn emits the `sendMessage done` summary line with the reason tag', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-summary-1'
      session._sessionId = 'sess-summary-1'
      session._activeTurn = { startedAt: Date.now() - 10, aborted: false, messageId: 'msg-summary-1' }
      session._term = { write: () => {}, kill: () => {} }
      session.on('error', () => {})
      session.on('result', () => {})

      const summaryLines = []
      const logSpy = (entry) => {
        if (entry.level === 'info' && /sendMessage done/.test(entry.message)) summaryLines.push(entry.message)
      }
      addLogListener(logSpy)
      try {
        session._teardownTurn('stream_stall', {
          duration: 11,
          errorPayload: { code: 'stream_stall', message: 'stalled' },
        })
        assert.equal(summaryLines.length, 1, 'one summary line per teardown call')
        const summary = summaryLines[0]
        assert.match(summary, /msg=msg-summary-1/, 'summary tags the messageId')
        assert.match(summary, /reason=stream_stall/, 'summary tags the reason passed to _teardownTurn')
      } finally {
        removeLogListener(logSpy)
      }
    })

    it('_handleHardTimeout end-to-end produces the summary with reason=hard_timeout', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 50,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-summary-ht'
      session._sessionId = 'sess-summary-ht'
      session._activeTurn = { startedAt: Date.now() - 60, aborted: false, messageId: 'msg-summary-ht' }
      session._term = { write: () => {}, kill: () => {} }
      session.on('error', () => {})
      session.on('result', () => {})

      const summaryLines = []
      const logSpy = (entry) => {
        if (entry.level === 'info' && /sendMessage done/.test(entry.message)) summaryLines.push(entry.message)
      }
      addLogListener(logSpy)
      try {
        session._handleHardTimeout()
        assert.equal(summaryLines.length, 1, 'hard-timeout path emits exactly one summary line')
        assert.match(summaryLines[0], /reason=hard_timeout/, 'summary tags reason=hard_timeout')
      } finally {
        removeLogListener(logSpy)
      }
    })

    it('_handleStreamStall end-to-end produces the summary with reason=stream_stall', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 50,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-summary-ss'
      session._sessionId = 'sess-summary-ss'
      session._activeTurn = { startedAt: Date.now() - 60, aborted: false, messageId: 'msg-summary-ss' }
      session._term = { write: () => {}, kill: () => {} }
      session.on('error', () => {})
      session.on('result', () => {})

      const summaryLines = []
      const logSpy = (entry) => {
        if (entry.level === 'info' && /sendMessage done/.test(entry.message)) summaryLines.push(entry.message)
      }
      addLogListener(logSpy)
      try {
        session._handleStreamStall()
        assert.equal(summaryLines.length, 1, 'stream-stall path emits exactly one summary line')
        assert.match(summaryLines[0], /reason=stream_stall/, 'summary tags reason=stream_stall')
      } finally {
        removeLogListener(logSpy)
      }
    })
  })

  describe('PTY output ring buffer (#3919)', () => {
    it('keeps a tail of recent output with ANSI stripped', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Simulate the onData handler by writing to _outputTail directly.
      const stripped = 'plain text'.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      session._outputTail = (session._outputTail + '\x1b[31mplain text\x1b[0m').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      assert.equal(session._outputTail, stripped)
    })

    it('_outputTailDiagnostic returns empty when no output captured', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(session._outputTailDiagnostic(), '')
    })

    it('_outputTailDiagnostic collapses whitespace + returns last bytes', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._outputTail = '   rate-limit exceeded  \n\n\nretry  in  60s   '
      const tail = session._outputTailDiagnostic()
      assert.match(tail, /rate-limit exceeded/)
      assert.match(tail, /retry in 60s/, 'multi-space collapsed')
    })
  })

  describe('interrupt()', () => {
    it('is a no-op when no turn is active', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Should not throw.
      session.interrupt()
    })
  })

  describe('_emitToolHookEvent()', () => {
    beforeEach(() => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Simulate a turn in flight so synthetic-id fallback works.
      session._activeTurn = { uuid: 'test', synthSeq: 0 }
    })

    it('emits tool_start with toolUseId, tool name, and input on PreToolUse', () => {
      const events = []
      session.on('tool_start', (e) => events.push(e))

      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_123',
        tool_name: 'Edit',
        tool_input: { file_path: '/foo.js', new_string: 'x' },
      }, 'msg-1')

      assert.equal(events.length, 1)
      assert.equal(events[0].toolUseId, 'toolu_123')
      assert.equal(events[0].messageId, 'toolu_123')
      assert.equal(events[0].tool, 'Edit')
      assert.deepEqual(events[0].input, { file_path: '/foo.js', new_string: 'x' })
    })

    it('emits tool_result with toolUseId and result on PostToolUse', () => {
      const events = []
      session.on('tool_result', (e) => events.push(e))

      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_123',
        tool_name: 'Edit',
        tool_response: 'File edited successfully',
      }, 'msg-1')

      assert.equal(events.length, 1)
      assert.equal(events[0].toolUseId, 'toolu_123')
      assert.equal(events[0].result, 'File edited successfully')
      assert.equal(events[0].truncated, false)
    })

    it('stringifies object tool_response for the dashboard', () => {
      const events = []
      session.on('tool_result', (e) => events.push(e))

      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_456',
        tool_name: 'Bash',
        tool_response: { stdout: 'hello\n', stderr: '', exitCode: 0 },
      }, 'msg-1')

      assert.equal(events.length, 1)
      const parsed = JSON.parse(events[0].result)
      assert.equal(parsed.stdout, 'hello\n')
      assert.equal(parsed.exitCode, 0)
    })

    it('truncates tool_response over 10KB', () => {
      const events = []
      session.on('tool_result', (e) => events.push(e))
      const huge = 'x'.repeat(15000)

      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_999',
        tool_name: 'Read',
        tool_response: huge,
      }, 'msg-1')

      assert.equal(events.length, 1)
      assert.equal(events[0].truncated, true)
      assert.equal(events[0].result.length, 10240)
    })

    it('synthesizes a STABLE toolUseId so Pre/Post pair correctly', () => {
      const startEvents = []
      const resultEvents = []
      session.on('tool_start', (e) => startEvents.push(e))
      session.on('tool_result', (e) => resultEvents.push(e))

      // PreToolUse without tool_use_id, then PostToolUse without it —
      // both must emit the SAME toolUseId so the dashboard can pair them.
      session._emitToolHookEvent('PreToolUse', { tool_name: 'Bash', tool_input: { cmd: 'ls' } }, 'msg-7')
      session._emitToolHookEvent('PostToolUse', { tool_name: 'Bash', tool_response: 'foo bar' }, 'msg-7')

      assert.equal(startEvents.length, 1)
      assert.equal(resultEvents.length, 1)
      assert.equal(startEvents[0].toolUseId, resultEvents[0].toolUseId, 'Pre and Post pair on the same synth id')
      assert.match(startEvents[0].toolUseId, /^msg-7-tool-1$/, 'synth id format: <messageId>-tool-<seq>')
    })

    it('synthesizes distinct ids across multiple tool calls in one turn', () => {
      const startEvents = []
      session.on('tool_start', (e) => startEvents.push(e))

      // Two separate tool calls, neither with tool_use_id.
      session._emitToolHookEvent('PreToolUse', { tool_name: 'Bash', tool_input: { cmd: 'ls' } }, 'msg-8')
      session._emitToolHookEvent('PostToolUse', { tool_name: 'Bash', tool_response: 'a' }, 'msg-8')
      session._emitToolHookEvent('PreToolUse', { tool_name: 'Read', tool_input: { path: '/foo' } }, 'msg-8')
      session._emitToolHookEvent('PostToolUse', { tool_name: 'Read', tool_response: 'b' }, 'msg-8')

      assert.equal(startEvents.length, 2)
      assert.match(startEvents[0].toolUseId, /^msg-8-tool-1$/)
      assert.match(startEvents[1].toolUseId, /^msg-8-tool-2$/)
    })

    it('falls through silently when no active turn (defensive)', () => {
      session._activeTurn = null
      // Must not throw.
      session._emitToolHookEvent('PreToolUse', { tool_name: 'Bash' }, 'msg-1')
    })

    // #5798 — observability-only: detect when the model ignores the multi-select
    // reinject "stop and wait" steer (emits a tool_use instead of stopping).
    describe('#5798 — reinject stop-and-wait violation telemetry', () => {
      function captureWarns() {
        const warns = []
        const logSpy = (entry) => { if (entry.level === 'warn') warns.push(entry.message) }
        addLogListener(logSpy)
        return { warns, stop: () => removeLogListener(logSpy) }
      }

      it('WARNs (greppable #5798 / reinject_stop_wait_violation) when a PreToolUse arrives while the watch is open', () => {
        // Simulate the FormDriver having opened the window after a flag-on reinject.
        session._reinjectStopWaitWatch = { deniedToolUseId: 'toolu_denied', at: session._nowMonotonic() }
        const { warns, stop } = captureWarns()
        try {
          session._emitToolHookEvent('PreToolUse', {
            tool_use_id: 'toolu_after',
            tool_name: 'Bash',
            tool_input: { command: 'ls' },
          }, 'msg-violation')
        } finally {
          stop()
        }
        const hit = warns.find((w) => /reinject_stop_wait_violation/.test(w))
        assert.ok(hit, 'a violation WARN fired')
        assert.match(hit, /#5798/, 'WARN carries the issue token')
        assert.match(hit, /deniedToolUseId=toolu_denied/, 'WARN names the denied tool id')
        assert.match(hit, /newTool=Bash/, 'WARN names the offending tool')
        assert.match(hit, /newToolUseId=toolu_after/, 'WARN names the offending tool id')
        assert.match(hit, /deltaMs=\d+/, 'WARN includes a deltaMs')
        // One-shot: the marker is cleared so a later tool_use does not re-fire.
        assert.equal(session._reinjectStopWaitWatch, null, 'marker cleared after the WARN')
      })

      it('fires the violation WARN exactly once (one-shot per reinject)', () => {
        session._reinjectStopWaitWatch = { deniedToolUseId: 'toolu_denied', at: session._nowMonotonic() }
        const { warns, stop } = captureWarns()
        try {
          session._emitToolHookEvent('PreToolUse', { tool_use_id: 'a', tool_name: 'Bash' }, 'm')
          session._emitToolHookEvent('PreToolUse', { tool_use_id: 'b', tool_name: 'Read' }, 'm')
        } finally {
          stop()
        }
        const hits = warns.filter((w) => /reinject_stop_wait_violation/.test(w))
        assert.equal(hits.length, 1, 'only the first post-reinject tool_use trips the WARN')
      })

      it('does NOT WARN when the watch was never opened', () => {
        assert.equal(session._reinjectStopWaitWatch, null, 'precondition: no watch open')
        const { warns, stop } = captureWarns()
        try {
          session._emitToolHookEvent('PreToolUse', { tool_use_id: 'x', tool_name: 'Bash' }, 'm')
        } finally {
          stop()
        }
        assert.ok(!warns.some((w) => /reinject_stop_wait_violation/.test(w)), 'no spurious violation WARN')
      })

      it('does NOT WARN when the legit turn-start clear runs BEFORE any tool_use', () => {
        // The reinjected turn legitimately starts (first consumed hook →
        // _clearFirstOutputWatchdog) before the model tool-calls; the window
        // closes, so a subsequent tool_use is a normal in-turn tool, not a
        // violation.
        session._reinjectStopWaitWatch = { deniedToolUseId: 'toolu_denied', at: session._nowMonotonic() }
        session._clearFirstOutputWatchdog()
        assert.equal(session._reinjectStopWaitWatch, null, 'turn-start clear closed the window')
        const { warns, stop } = captureWarns()
        try {
          session._emitToolHookEvent('PreToolUse', { tool_use_id: 'legit', tool_name: 'Edit' }, 'm')
        } finally {
          stop()
        }
        assert.ok(!warns.some((w) => /reinject_stop_wait_violation/.test(w)), 'no violation after a legit turn-start clear')
      })
    })

    // #4307: parity with SdkSession — PreToolUse with Bash +
    // run_in_background stashes the command; PostToolUse with the
    // canonical "Command running in background with ID:" text
    // promotes it to a pending shell.
    describe('#4307 — background-shell tracking', () => {
      it('records a pending shell when PreToolUse + PostToolUse pair carries a backgrounded Bash', () => {
        const events = []
        session.on('background_work_changed', (e) => events.push(e))

        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_bg_1',
          tool_name: 'Bash',
          tool_input: { command: 'sleep 600', run_in_background: true },
        }, 'msg-bg-1')
        session._emitToolHookEvent('PostToolUse', {
          tool_use_id: 'toolu_bg_1',
          tool_name: 'Bash',
          tool_response: 'Command running in background with ID: tui-shell-1. Output…',
        }, 'msg-bg-1')

        assert.equal(session._pendingBackgroundShells.size, 1)
        const entry = session._pendingBackgroundShells.get('tui-shell-1')
        assert.equal(entry.command, 'sleep 600')
        assert.equal(events.length, 1)
        assert.equal(events[0].pending[0].shellId, 'tui-shell-1')
        // isRunning reports waiting even with _isBusy=false (default).
        assert.equal(session._isBusy, false)
        assert.equal(session.isRunning, true)
      })

      it('PostToolUse without the canonical text is a no-op for the pending map', () => {
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_bg_2',
          tool_name: 'Bash',
          tool_input: { command: 'ls', run_in_background: true },
        }, 'msg-bg-2')
        session._emitToolHookEvent('PostToolUse', {
          tool_use_id: 'toolu_bg_2',
          tool_name: 'Bash',
          tool_response: 'random output, no shell id',
        }, 'msg-bg-2')
        assert.equal(session._pendingBackgroundShells.size, 0)
      })

      it('BashOutput PreToolUse clears the matching pending shell', () => {
        const events = []
        // Seed a pending shell.
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_bg_3',
          tool_name: 'Bash',
          tool_input: { command: 'sleep 600', run_in_background: true },
        }, 'msg-bg-3')
        session._emitToolHookEvent('PostToolUse', {
          tool_use_id: 'toolu_bg_3',
          tool_name: 'Bash',
          tool_response: 'Command running in background with ID: tui-shell-3. Output…',
        }, 'msg-bg-3')
        session.on('background_work_changed', (e) => events.push(e))

        // Agent polls — clears.
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_bo_1',
          tool_name: 'BashOutput',
          tool_input: { bash_id: 'tui-shell-3' },
        }, 'msg-bg-3')
        assert.equal(session._pendingBackgroundShells.size, 0)
        assert.equal(events.length, 1)
        assert.equal(events[0].pending.length, 0)
        assert.equal(session.isRunning, false)
      })

      it('destroy() clears the pending map', async () => {
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_bg_4',
          tool_name: 'Bash',
          tool_input: { command: 'sleep 600', run_in_background: true },
        }, 'msg-bg-4')
        session._emitToolHookEvent('PostToolUse', {
          tool_use_id: 'toolu_bg_4',
          tool_name: 'Bash',
          tool_response: 'Command running in background with ID: tui-shell-4. Output…',
        }, 'msg-bg-4')
        assert.equal(session._pendingBackgroundShells.size, 1)
        await session.destroy()
        assert.equal(session._pendingBackgroundShells.size, 0)
      })
    })
  })

  // #4278: TUI sessions previously had ZERO handling for AskUserQuestion.
  // claude TUI calls the tool through its own prompt mechanism in the PTY;
  // chroxy's PreToolUse hook fired but only emitted a generic tool_start.
  // The dashboard rendered the tool_use inside the collapsed tool group
  // with no interactive way to answer, and claude sat on its own TTY-style
  // prompt waiting for stdin input — until the inactivity hard timeout.
  describe('AskUserQuestion handling (#4278)', () => {
    beforeEach(() => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { uuid: 'test', synthSeq: 0 }
    })

    it('PreToolUse for AskUserQuestion emits user_question with toolUseId + questions', () => {
      const questionEvents = []
      const toolStartEvents = []
      session.on('user_question', (e) => questionEvents.push(e))
      session.on('tool_start', (e) => toolStartEvents.push(e))

      const questions = [
        {
          question: 'Which release strategy?',
          options: [{ label: 'Patch' }, { label: 'Minor' }],
        },
      ]
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_aq_1',
        tool_name: 'AskUserQuestion',
        tool_input: { questions },
      }, 'msg-aq')

      assert.equal(questionEvents.length, 1, 'user_question emitted exactly once')
      assert.equal(questionEvents[0].toolUseId, 'toolu_aq_1')
      assert.deepEqual(questionEvents[0].questions, questions)

      // tool_start STILL emits so the dashboard's tool-pairing (tool_use →
      // tool_result on PostToolUse) continues to work after the user
      // answers. We accept the duplicate display (tool_use bubble in the
      // group AND the QuestionPrompt UI outside) — #4279 makes the bubble
      // usefully expandable so this is acceptable for MVP.
      assert.equal(toolStartEvents.length, 1, 'tool_start still emitted')
      assert.equal(toolStartEvents[0].toolUseId, 'toolu_aq_1')
      assert.equal(toolStartEvents[0].tool, 'AskUserQuestion')
    })

    it('tracks _pendingUserAnswer with toolUseId AND the options array (#4290)', () => {
      // The options array is needed at respondToQuestion time so we can
      // look up the chosen label's index and write the numbered shortcut
      // (e.g. "2\\r") rather than the raw label text. v0.9.3 wrote the
      // label text and claude TUI's prompt parser mis-resolved it to
      // "Other" — see #4288.
      const options = [{ label: 'App runners only (2)' }, { label: 'App + docs (all 3)' }]
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_aq_2',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Q?', options }] },
      }, 'msg-aq')
      assert.ok(session._pendingUserAnswer, 'pending answer tracked')
      assert.equal(session._pendingUserAnswer.toolUseId, 'toolu_aq_2')
      assert.deepEqual(session._pendingUserAnswer.options, options, 'options stashed for index lookup')
    })

    // #4290 — the v0.9.3 strategy (write the label text) caused claude
    // TUI's prompt to single-character-jump-navigate through the menu,
    // landing on "Other" with empty custom text. New strategy: when the
    // chosen answer matches an option label exactly, write the 1-indexed
    // option number — most TUI menus map "1", "2", "3" as direct hotkeys.
    it('respondToQuestion writes the 1-indexed option number when the answer matches a label (#4290)', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      session._pendingUserAnswer = {
        toolUseId: 'toolu_aq_idx',
        options: [
          { label: 'App runners only (2)' },
          { label: 'App + docs (all 3)' },
          { label: 'Other' },
        ],
      }

      session.respondToQuestion('App + docs (all 3)')
      await new Promise((resolve) => setTimeout(resolve, 50))

      // disable + '2' + \\r + enable = 4 writes
      assert.equal(writes.length, 4, `expected 4 writes for index path, got ${writes.length}: ${JSON.stringify(writes)}`)
      assert.equal(writes[0], '\x1b[?2004l', 'first is bracketed-paste-disable')
      assert.equal(writes[1], '2', 'second is the 1-indexed option number as a single char')
      assert.equal(writes[2], '\r', 'third is submit')
      assert.equal(writes[3], '\x1b[?2004h', 'fourth is re-enable')
      assert.equal(session._pendingUserAnswer, null, 'pending cleared')
    })

    // #4668 — when claude TUI emits parallel AskUserQuestion tool_use
    // blocks in one assistant turn (observed post-#4648 deny), chroxy's
    // pre-#4668 single-field `_pendingUserAnswer` got overwritten by
    // each new tool_use → user answers routed to the wrong toolUseId's
    // slot. New behaviour: a Map keyed by toolUseId preserves every
    // pending entry; respondToQuestion(text, answersMap, toolUseId)
    // routes by toolUseId to the right entry. Per-entry cleanup leaves
    // sibling pending answers alive.
    it('Map-keyed _pendingUserAnswers preserves sibling tool_uses; respondToQuestion routes by toolUseId (#4668)', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      // Two parallel AskUserQuestion tool_uses arrive in one turn.
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_first',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Q1?', options: [{ label: 'A' }, { label: 'B' }] }] },
      }, 'msg-1')
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_second',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Q2?', options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] }] },
      }, 'msg-1')

      // Both entries present in the Map — pre-#4668 the second overwrote the first.
      assert.equal(session._pendingUserAnswers.size, 2, 'both tool_uses tracked independently')
      assert.ok(session._pendingUserAnswers.has('toolu_first'), 'first preserved')
      assert.ok(session._pendingUserAnswers.has('toolu_second'), 'second present')

      // Dashboard answers the FIRST one (by toolUseId).
      session.respondToQuestion('A', undefined, 'toolu_first')
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Wrote '1' (1-indexed option for 'A') — proving the route went to the first entry's options.
      assert.equal(writes[1], '1', 'wrote 1-indexed digit for first entry\'s option A')
      // First entry cleared; SECOND entry preserved (no all-or-nothing wipe).
      assert.ok(!session._pendingUserAnswers.has('toolu_first'), 'first entry cleared after response')
      assert.ok(session._pendingUserAnswers.has('toolu_second'), 'second sibling entry SURVIVES first\'s response')

      // Now dashboard answers the SECOND one.
      writes.length = 0
      session.respondToQuestion('Z', undefined, 'toolu_second')
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(writes[1], '3', 'wrote 1-indexed digit for second entry\'s option Z')
      assert.equal(session._pendingUserAnswers.size, 0, 'Map empty after both answered')
    })

    // #4668 — defensive: dashboard sends an answer for a toolUseId that's
    // already been cleared (late arrival after watchdog teardown). Pre-fix
    // this would write keystrokes into whatever pending entry happened to
    // exist (or into nothing). Now: log warn + drop, never write.
    it('respondToQuestion drops + logs when toolUseId has no matching pending entry (#4668)', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_live',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] },
      }, 'msg-1')

      // Dashboard sends an answer for a DIFFERENT (stale) toolUseId.
      session.respondToQuestion('A', undefined, 'toolu_stale_or_missing')
      await new Promise((resolve) => setTimeout(resolve, 50))

      // No PTY writes — the stale answer was dropped, not written into the live entry's slot.
      assert.equal(writes.length, 0, 'no PTY writes for stale toolUseId')
      // Live entry still pending, ready for its own answer.
      assert.ok(session._pendingUserAnswers.has('toolu_live'), 'live entry untouched')
    })

    it('respondToQuestion writes the label text when the answer does NOT match any option (custom / Other path)', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      session._pendingUserAnswer = {
        toolUseId: 'toolu_aq_other',
        options: [{ label: 'Patch' }, { label: 'Minor' }],
      }

      session.respondToQuestion('Brand new freeform answer')
      await new Promise((resolve) => setTimeout(resolve, 100))

      // No match → fall through to typing the text per the v0.9.3 behavior.
      // (claude TUI's Other-path may still mis-parse this; tracked at #4288
      // as a separate problem. The point of THIS PR is to make the
      // happy-path label-match case work.)
      assert.ok(writes.length > 4, `expected per-char writes for fallback path, got ${writes.length}`)
      assert.equal(writes[0], '\x1b[?2004l', 'disable mode first')
      const text = 'Brand new freeform answer'
      const charWrites = writes.slice(1, 1 + text.length)
      assert.equal(charWrites.join(''), text, 'chars reproduce the freeform answer')
    })

    // #4293 (review of #4290): boundary check on the index lookup.
    // First option → "1"; ninth option → "9" (the last single-digit
    // index supported per the #4292 guard). Pre-fix an off-by-one in
    // the index → string conversion would shift every selection.
    it('respondToQuestion: first option → "1", ninth option → "9" (boundary)', async () => {
      const options = Array.from({ length: 9 }, (_, i) => ({ label: `opt-${i}` }))
      session._term = { write: () => {}, kill: () => {} }

      const expectations = [
        { label: 'opt-0', digit: '1' },
        { label: 'opt-8', digit: '9' },
      ]
      for (const { label, digit } of expectations) {
        const writes = []
        session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
        session._pendingUserAnswer = { toolUseId: 'toolu-boundary', options }
        session.respondToQuestion(label)
        await new Promise((resolve) => setTimeout(resolve, 30))
        assert.equal(writes[1], digit, `option "${label}" maps to digit "${digit}"`)
      }
    })

    it('respondToQuestion drives matchIdx >= 9 via arrow-key navigation (#4848)', async () => {
      // #4292 originally fell through to writing the label text verbatim
      // when matchIdx >= 9, which #4288 showed lands on whichever option's
      // label starts with the same first character (jump-nav footgun).
      // #4746 replaced the silent label-text fallback with a structured
      // ASK_USER_QUESTION_TOO_MANY_OPTIONS error. #4848 takes the
      // remaining step: drive the form natively via arrow-key navigation
      // (Down arrow × matchIdx + Enter) so the user's explicit pick of
      // option 10/11/12 actually lands on the right option instead of
      // tearing the turn down.
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      session._isBusy = true
      session._currentMessageId = 'msg-arrownav'
      session._activeTurn = { uuid: 'turn-arrownav', synthSeq: 0, startedAt: Date.now() }
      const options = Array.from({ length: 12 }, (_, i) => ({ label: `opt-${i}` }))
      session._pendingUserAnswer = { toolUseId: 'toolu-arrownav', options }

      const errors = []
      session.on('error', (e) => errors.push(e))

      // opt-9 is index 9 → drive via 9 Down arrows + Enter.
      session.respondToQuestion('opt-9')
      await new Promise((resolve) => setTimeout(resolve, 50))

      // No too-many error — arrow-nav drives the form natively.
      assert.equal(errors.length, 0, `expected no errors, got ${JSON.stringify(errors)}`)
      // disable + 9× Down arrow + Enter + enable.
      const expected = ['\x1b[?2004l', ...Array(9).fill('\x1b[B'), '\r', '\x1b[?2004h']
      assert.deepEqual(writes, expected,
        `expected 9× Down + Enter sequence, got ${JSON.stringify(writes)}`)
    })

    // #4848 boundary: opt-11 (idx 11) in a 12-option question — pin the
    // larger-N arrow-nav case so the loop count tracks idx exactly.
    it('respondToQuestion drives matchIdx=11 via 11× Down + Enter (#4848 boundary)', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      const options = Array.from({ length: 12 }, (_, i) => ({ label: `opt-${i}` }))
      session._pendingUserAnswer = { toolUseId: 'toolu-arrownav-11', options }

      const errors = []
      session.on('error', (e) => errors.push(e))

      // opt-11 is the LAST option (idx 11) → 11 Down arrows + Enter.
      session.respondToQuestion('opt-11')
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(errors.length, 0, `expected no errors, got ${JSON.stringify(errors)}`)
      const expected = ['\x1b[?2004l', ...Array(11).fill('\x1b[B'), '\r', '\x1b[?2004h']
      assert.deepEqual(writes, expected,
        `expected 11× Down + Enter sequence, got ${JSON.stringify(writes)}`)
    })

    it('respondToQuestion writes the text when options array is missing or empty (free-text-only AskUserQuestion)', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      session._pendingUserAnswer = { toolUseId: 'toolu_aq_free' /* no options */ }

      session.respondToQuestion('hello')
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Same shape as a regular throttled write — disable + 5 chars + \\r + enable.
      assert.ok(writes.length >= 5 + 3)
      assert.equal(writes[0], '\x1b[?2004l')
      const text = 'hello'
      const charWrites = writes.slice(1, 1 + text.length)
      assert.equal(charWrites.join(''), text)
    })

    it('respondToQuestion is a no-op when no pending answer (defensive)', () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      // #4802: explicit clear-all replaces the old `_pendingUserAnswer = null`
      // back-compat setter (the implicit-clear pattern is now forbidden — it
      // silently wiped sibling AskUserQuestion entries that still had answers
      // in flight on the wire, per the audit P1.2 root cause).
      session._pendingUserAnswers_clearAll()

      session.respondToQuestion('whatever')
      assert.equal(writes.length, 0, 'no PTY writes when there is no pending answer')
    })

    // #4651 — "Other" / freeform answer support. claude TUI's AskUserQuestion
    // renders an "Other" option that, when picked via its digit, opens a
    // text-input prompt. Pre-#4651 the dashboard's freeform Other path sent
    // only the typed string; the server then tried to type that string at
    // the digit-select menu (jump-nav landed wherever the first char
    // happened to point — #4288). New protocol: dashboard sends the typed
    // text in `freeformText`, with `answer` = the Other option label. The
    // server resolves Other → digit, writes the digit to enter text-input
    // mode, then writes the freeform text + Enter to submit.
    describe('Other / freeform answer (#4651)', () => {
      it('writes the Other digit, then the freeform text + Enter', async () => {
        const writes = []
        session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_other_freeform',
          options: [
            { label: 'Patch' },
            { label: 'Minor' },
            { label: 'Other' },
          ],
        }

        // Dashboard sends: answer='Other' (the Other option label),
        // freeformText='my custom answer' (the typed text).
        session.respondToQuestion('Other', undefined, 'toolu_aq_other_freeform', {
          freeformText: 'my custom answer',
        })
        // Allow throttled writes (digit + settle + per-char text) to drain.
        await new Promise((resolve) => setTimeout(resolve, 250))

        // Sequence shape: [paste-disable, '3' (Other digit), <settle pause>,
        // paste-disable-again, per-char text, '\r', paste-enable]. We pin
        // the digit and the text presence to keep the assertion stable
        // regardless of intermediate enable/disable toggles.
        const joined = writes.join('')
        assert.ok(joined.includes('3'), `expected Other digit "3" in writes, got: ${JSON.stringify(writes)}`)
        assert.ok(joined.includes('my custom answer'), `expected freeform text in writes, got: ${JSON.stringify(writes)}`)
        const otherIdx = writes.indexOf('3')
        const firstTextCharIdx = writes.indexOf('m')
        assert.ok(otherIdx >= 0 && firstTextCharIdx > otherIdx, 'Other digit must be written BEFORE the freeform text')
        // Trailing Enter so claude TUI submits the text-input prompt.
        assert.ok(writes.includes('\r'), 'trailing Enter submits the freeform answer')
        assert.equal(session._pendingUserAnswer, null, 'pending cleared after answer write')
      })

      it('falls through to legacy single-write path when no freeformText is supplied', async () => {
        const writes = []
        session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_other_legacy',
          options: [
            { label: 'Patch' },
            { label: 'Other' },
          ],
        }

        // Legacy path: answer matches an option label exactly → 1-indexed digit.
        session.respondToQuestion('Patch')
        await new Promise((resolve) => setTimeout(resolve, 50))

        // disable + '1' + \\r + enable = 4 writes (matches the #4290 test shape).
        assert.equal(writes.length, 4, `expected 4 writes for legacy path, got ${writes.length}: ${JSON.stringify(writes)}`)
        assert.equal(writes[1], '1', 'legacy index path unchanged when freeformText is absent')
      })

      it('is a no-op when freeformText is supplied but no Other option exists', async () => {
        const writes = []
        session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_no_other',
          options: [{ label: 'A' }, { label: 'B' }],
        }

        // Defensive: dashboard sent freeformText for an AskUserQuestion that
        // has no "Other" option. Don't blindly write the freeform text at
        // the digit menu (that's the #4288 jump-nav footgun). Drop + clear.
        session.respondToQuestion('Other', undefined, 'toolu_aq_no_other', {
          freeformText: 'should be dropped',
        })
        await new Promise((resolve) => setTimeout(resolve, 50))

        assert.equal(writes.length, 0, `no PTY writes when freeform requested but no Other option exists, got: ${JSON.stringify(writes)}`)
      })

      // #4808 — the Other/freeform path is driven by an async IIFE that
      // awaits stage-1 write → settle delay → re-arms the watchdog →
      // awaits stage-2 write. destroy() can run during any of these
      // awaits but the IIFE keeps going. Pre-#4808 it would:
      //   1. Re-arm `_askUserQuestionWatchdog` AFTER destroy() already
      //      cleared it, leaking a 30s timer that holds `this` in its
      //      closure (the `_onAskUserQuestionStall` guard prevents the
      //      emit but doesn't release the closure).
      //   2. Call `_writePtyTextThrottled(freeformText)` on a null
      //      `_term`, which throws inside the write loop (or worse —
      //      revives a write path against a torn-down session).
      // Fix is `if (this._destroying) return` after each `await` and a
      // null-check on `this._term` before stage 2.
      describe('destroy() during the two-stage IIFE (#4808)', () => {
        it('destroy() between stage-1 and stage-2 does NOT re-arm the watchdog', async () => {
          const writes = []
          session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
          session._pendingUserAnswer = {
            toolUseId: 'toolu_aq_destroy_race',
            options: [
              { label: 'Patch' },
              { label: 'Minor' },
              { label: 'Other' },
            ],
          }

          // Kick off the two-stage IIFE.
          session.respondToQuestion('Other', undefined, 'toolu_aq_destroy_race', {
            freeformText: 'race text',
          })

          // Stage 1 (the digit '3') finishes within ~5ms — give it a
          // beat to land but tear the session down DURING the
          // OTHER_FREEFORM_SETTLE_MS (150ms) sleep. Targeting 60ms
          // hits well inside that window on any reasonable machine.
          await new Promise((resolve) => setTimeout(resolve, 60))
          await session.destroy()
          // Null `session` so the afterEach hook does not double-destroy.
          const torn = session
          session = null

          // The watchdogs were cleared by destroy(). If the IIFE re-arms
          // after `await new Promise(setTimeout(SETTLE_MS))` resolves, a fresh
          // entry appears in `_askUserQuestionWatchdogs` (#5319) — detectable by
          // sampling the Map size repeatedly until well past the settle delay.
          const samples = []
          for (let i = 0; i < 4; i++) {
            await new Promise((resolve) => setTimeout(resolve, 60))
            samples.push(torn._askUserQuestionWatchdogs.size)
          }

          // Pre-#4808: at least one sample is non-zero (re-armed).
          // Post-fix: every sample stays 0.
          for (const s of samples) {
            assert.equal(s, 0, `_askUserQuestionWatchdogs must stay empty past destroy(); saw size=${s}. samples=${samples.join(',')}`)
          }
        })

        it('destroy() between stage-1 and stage-2 does NOT attempt to write on a null _term', async () => {
          // Capture the "Other-freeform PTY write failed" warning — this
          // is the symptom of the IIFE blindly calling
          // `_writePtyTextThrottled(freeformText)` against a `_term` that
          // destroy() set to null. Pre-#4808 the inner `this._term.write`
          // throws `Cannot read properties of null (reading 'write')`,
          // the IIFE's .catch logs that warning, and the session has just
          // demonstrated that it can still execute write logic past
          // destroy(). Post-fix the IIFE returns early after the
          // settle-await and the warning never fires.
          const warnLines = []
          const captureWarn = (entry) => {
            if (entry.level === 'warn' && /Other-freeform PTY write failed/.test(entry.message || '')) {
              warnLines.push(entry.message)
            }
          }
          addLogListener(captureWarn)

          const stage1Writes = []
          session._term = {
            write: (data) => { stage1Writes.push(data) },
            kill: () => {},
          }
          session._pendingUserAnswer = {
            toolUseId: 'toolu_aq_destroy_term',
            options: [
              { label: 'Patch' },
              { label: 'Minor' },
              { label: 'Other' },
            ],
          }

          try {
            session.respondToQuestion('Other', undefined, 'toolu_aq_destroy_term', {
              freeformText: 'after destroy',
            })

            // Let stage-1 (digit '3') land, then destroy during the
            // OTHER_FREEFORM_SETTLE_MS (150ms) pause.
            await new Promise((resolve) => setTimeout(resolve, 60))
            await session.destroy()
            const torn = session
            session = null
            // Sanity: destroy() nulled `_term`.
            assert.equal(torn._term, null, 'destroy() nulls _term')

            // Wait past the settle (150ms) + per-char throttle time for
            // stage-2 to run if it's going to. Post-fix the IIFE returns
            // after `if (this._destroying) return` and never touches
            // `_term`.
            await new Promise((resolve) => setTimeout(resolve, 250))

            assert.equal(
              warnLines.length, 0,
              `IIFE must not execute stage-2 write into a null _term post-destroy; saw warns: ${JSON.stringify(warnLines)}`,
            )
            // Stage-1 digit DID land (it ran before destroy).
            assert.ok(stage1Writes.some((w) => w === '3'), `stage-1 digit "3" expected to have written before destroy, got: ${JSON.stringify(stage1Writes)}`)
          } finally {
            removeLogListener(captureWarn)
          }
        })
      })
    })

    it('PostToolUse for AskUserQuestion clears _pendingUserAnswer if it was still set', () => {
      // Cleanup invariant: claude eventually resolved its own prompt
      // (maybe via the underlying terminal multiplexer, maybe via the
      // answer chroxy wrote). Either way, once PostToolUse fires the
      // chroxy-side pending state has to be cleared — otherwise the next
      // user_question_response would write into a dead PTY context.
      session._pendingUserAnswer = { toolUseId: 'toolu_aq_4' }
      const resultEvents = []
      session.on('tool_result', (e) => resultEvents.push(e))

      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_aq_4',
        tool_name: 'AskUserQuestion',
        tool_response: { selectedLabel: 'Patch' },
      }, 'msg-aq')

      assert.equal(resultEvents.length, 1, 'tool_result still emitted as normal')
      assert.equal(session._pendingUserAnswer, null, 'pending cleared after PostToolUse')
    })

    // #4689 — when the hook payload omits tool_use_id (older claude builds,
    // certain MCP tools), `_emitToolHookEvent` synthesizes a stable id from
    // `${messageId}-tool-${synthSeq}` and the PreToolUse branch stores the
    // pending entry under THAT synthesized id. Pre-#4689 PostToolUse cleanup
    // gated on the RAW `payload.tool_use_id`, which was null in this path,
    // so the cleanup branch was skipped and both the _pendingUserAnswers
    // Map entry AND the askuserquestion-active lock dir leaked forever —
    // the next AskUserQuestion turn wedged on the sibling-deny check.
    //
    // This test pins the fix: PostToolUse for AskUserQuestion with NO
    // payload.tool_use_id must still clear the entry by the resolved local
    // toolUseId and drop the lock dir. Reverting line ~1439 of
    // claude-tui-session.js to gate on `payload.tool_use_id` fails this
    // test on the "pending entry not cleared" assertion.
    it('PostToolUse cleanup uses resolved local toolUseId when payload tool_use_id is missing (#4689)', () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-4689-sink-'))
      session._sinkDir = sinkDir
      // _emitToolHookEvent requires _activeTurn to synthesize ids; the
      // synthSeq counter increments on PreToolUse and is reused on the
      // matching PostToolUse so the pair shares one id.
      session._activeTurn = { uuid: 'test-4689', synthSeq: 0 }

      // Drop the askuserquestion-active lock onto disk so we can assert
      // PostToolUse removes it (mirrors the sibling-deny path the
      // permission-hook.sh script would have created on PreToolUse).
      const lockDir = join(sinkDir, 'askuserquestion-active')
      mkdirSync(lockDir, { recursive: true })
      assert.ok(existsSync(lockDir), 'precondition: lock dir exists before PostToolUse')

      // PreToolUse with NO tool_use_id — forces synthesis. The id lands
      // at `msg-aq-synth-tool-1` (synthSeq goes 0 → 1).
      session._emitToolHookEvent('PreToolUse', {
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] },
      }, 'msg-aq-synth')
      const synthesizedId = 'msg-aq-synth-tool-1'
      assert.ok(
        session._pendingUserAnswers.has(synthesizedId),
        `pending entry armed under synthesized id ${synthesizedId} (keys=${[...session._pendingUserAnswers.keys()].join(',')})`,
      )

      // PostToolUse with NO tool_use_id either — `_emitToolHookEvent`
      // reuses the current synthSeq (does NOT increment), so the local
      // toolUseId resolves to the SAME synthesized id. Pre-#4689 the
      // cleanup branch was gated on `payload.tool_use_id` which is null
      // here → skipped → entry leaked, lock dir leaked.
      session._emitToolHookEvent('PostToolUse', {
        tool_name: 'AskUserQuestion',
        tool_response: { selectedLabel: 'A' },
      }, 'msg-aq-synth')

      assert.equal(
        session._pendingUserAnswers.size, 0,
        'pending entry cleared via resolved local toolUseId (not raw payload.tool_use_id)',
      )
      assert.ok(
        !session._pendingUserAnswers.has(synthesizedId),
        'specifically: the synthesized-id entry is gone from the Map',
      )
      assert.ok(
        !existsSync(lockDir),
        'askuserquestion-active lock dir removed via _clearAskUserQuestionLock',
      )
      // sinkDir cleanup happens in the outer afterEach via session.destroy()
      // (claude-tui-session.js rmSyncs _sinkDir with force:true). An inline
      // rmSync here would be redundant AND get skipped if any assertion
      // above throws — the centralized path is unconditional.
    })

    it('PostToolUse for a non-AskUserQuestion tool does NOT touch _pendingUserAnswer (defensive)', () => {
      session._pendingUserAnswer = { toolUseId: 'toolu_aq_5' }
      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_bash',
        tool_name: 'Bash',
        tool_response: 'ok',
      }, 'msg-mixed')
      assert.deepEqual(
        session._pendingUserAnswer,
        { toolUseId: 'toolu_aq_5' },
        'unrelated PostToolUse leaves the pending question alone',
      )
    })

    // #4286 + #4802 (audit P1.2): _finishTurnError's original #4286 fix
    // wiped the pending-answer slot for symmetry with interrupt/destroy,
    // but the audit re-evaluated that decision once `_pendingUserAnswer`
    // became a Map (#4668). `_finishTurnError` runs on paths that do NOT
    // issue Ctrl-C (PTY exit / Stop hook timeout / prompt-write failure),
    // so a parallel sibling AskUserQuestion's late answer may still be
    // legitimately consumable. Post-#4802 `_finishTurnError` PRESERVES
    // the Map; `_handleHardTimeout` (which DOES Ctrl-C via _teardownTurn)
    // still wipes — see the #4691 + #4802 audit tests further down for
    // the per-callsite intent matrix.
    it('_finishTurnError preserves _pendingUserAnswer (audit P1.2 #4802)', () => {
      session._pendingUserAnswer = { toolUseId: 'toolu_aq_finish' }
      session.on('error', () => {})  // swallow
      session._currentMessageId = 'msg-x'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._finishTurnError('test-error', 'msg-x')
      assert.ok(session._pendingUserAnswer, 'finishTurnError preserves pending answer (#4802)')
      assert.equal(session._pendingUserAnswer.toolUseId, 'toolu_aq_finish',
        'entry survives so a late respondToQuestion can still consume it')
    })

    it('_handleHardTimeout clears _pendingUserAnswer (symmetry with interrupt/destroy via Ctrl-C)', () => {
      session._pendingUserAnswer = { toolUseId: 'toolu_aq_hard' }
      session.on('error', () => {})
      session._isBusy = true
      session._currentMessageId = 'msg-y'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }
      session._hardTimeoutMs = 1000
      session._handleHardTimeout()
      assert.equal(session._pendingUserAnswer, null, 'hard timeout clears pending answer')
    })

    // #4693 — the diagnostic added in #4687 (PTY tail hex dump before each
    // answer write) is unbounded per-turn: a multi-question retry-as-singles
    // wedge can fire 4+ respondToQuestion calls in succession, each pumping
    // ~70 hex-dump lines into chroxy.log. Rate-limit to once per turn — the
    // first answer write still captures the diagnostic; subsequent writes
    // in the same turn emit a compact one-line skip notice instead of the
    // full dump.
    it('respondToQuestion PTY tail hex dump is rate-limited to once per turn (#4693)', async () => {
      const hexDumpLines = []
      const skipLines = []
      const logSpy = (entry) => {
        if (entry.component !== 'claude-tui-session') return
        if (entry.level !== 'info') return
        if (/respondToQuestion PTY tail before write/.test(entry.message)) hexDumpLines.push(entry.message)
        if (/respondToQuestion PTY tail hex dump skipped/.test(entry.message)) skipLines.push(entry.message)
      }
      addLogListener(logSpy)
      try {
        session._term = { write: () => {}, kill: () => {} }
        // Mark a single active turn so the rate-limiter has a stable scope.
        session._activeTurn = { messageId: 'msg-hex-rate', startedAt: Date.now(), aborted: false, synthSeq: 0 }

        // Three sibling AskUserQuestion tool_uses in the SAME turn (mirrors
        // the multi-question retry-as-singles wedge that motivated #4693).
        for (const id of ['toolu_one', 'toolu_two', 'toolu_three']) {
          session._emitToolHookEvent('PreToolUse', {
            tool_use_id: id,
            tool_name: 'AskUserQuestion',
            tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] },
          }, 'msg-hex-rate')
        }

        // Dashboard answers all three in quick succession.
        session.respondToQuestion('A', undefined, 'toolu_one')
        session.respondToQuestion('B', undefined, 'toolu_two')
        session.respondToQuestion('A', undefined, 'toolu_three')
        await new Promise((resolve) => setTimeout(resolve, 50))

        assert.equal(
          hexDumpLines.length, 1,
          `expected exactly 1 hex dump for 3 same-turn answers, got ${hexDumpLines.length}: ${JSON.stringify(hexDumpLines.map((l) => l.split('\n')[0]))}`,
        )
        assert.equal(
          skipLines.length, 2,
          `expected 2 compact skip notices for the rate-limited calls, got ${skipLines.length}`,
        )

        // After a new turn starts, the next answer emits a fresh hex dump.
        hexDumpLines.length = 0
        skipLines.length = 0
        session._activeTurn = { messageId: 'msg-hex-rate-2', startedAt: Date.now(), aborted: false, synthSeq: 0 }
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_turn2',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] },
        }, 'msg-hex-rate-2')
        session.respondToQuestion('A', undefined, 'toolu_turn2')
        await new Promise((resolve) => setTimeout(resolve, 50))

        assert.equal(hexDumpLines.length, 1, 'new turn resets the rate-limit; first answer emits the dump again')
        assert.equal(skipLines.length, 0, 'no skip notice on the first answer of a new turn')
      } finally {
        removeLogListener(logSpy)
      }
    })

    // #4690 (review of #4687) — pin the Map-isolation invariant on the
    // PostToolUse cleanup path. The PreToolUse branch arms one entry in
    // `_pendingUserAnswers` per tool_use_id; PostToolUse for tool A must
    // surgically clear ONLY A's entry via `_clearPendingAnswerByToolUseId`
    // (claude-tui-session.js:1438-1440). A future refactor that goes back
    // to the pre-#4668 all-or-nothing wipe (e.g. `_pendingUserAnswer = null`
    // in the PostToolUse branch → setter calls Map.clear()) would silently
    // wipe sibling B's pending entry and re-introduce the #4668 wedge.
    // This test pins per-tool isolation so that regression is loud.
    it('PostToolUse for tool A leaves tool B\'s pending entry intact (Map isolation, #4690)', () => {
      // Two parallel AskUserQuestion tool_uses arrive in one turn (the
      // #4668 setup). Both armed in the Map under their own toolUseIds.
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_A',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'QA?', options: [{ label: 'a1' }, { label: 'a2' }] }] },
      }, 'msg-aq-AB')
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_B',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'QB?', options: [{ label: 'b1' }, { label: 'b2' }] }] },
      }, 'msg-aq-AB')

      assert.equal(session._pendingUserAnswers.size, 2, 'both A and B armed')
      assert.ok(session._pendingUserAnswers.has('toolu_A'), 'A present pre-PostToolUse')
      assert.ok(session._pendingUserAnswers.has('toolu_B'), 'B present pre-PostToolUse')

      // PostToolUse for tool A only — must NOT touch B's pending entry.
      const resultEvents = []
      session.on('tool_result', (e) => resultEvents.push(e))
      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_A',
        tool_name: 'AskUserQuestion',
        tool_response: { selectedLabel: 'a1' },
      }, 'msg-aq-AB')

      // The cleanup branch fires for A only.
      assert.equal(session._pendingUserAnswers.size, 1, 'exactly one entry left after PostToolUse(A)')
      assert.ok(!session._pendingUserAnswers.has('toolu_A'), 'A cleared by its own PostToolUse')
      assert.ok(session._pendingUserAnswers.has('toolu_B'),
        'B SURVIVES — PostToolUse(A) must not wipe sibling entries')

      // The tool_result for A still fired (Map cleanup is in addition to,
      // not instead of, the normal PostToolUse fan-out).
      assert.equal(resultEvents.length, 1, 'tool_result for A still emitted')
      assert.equal(resultEvents[0].toolUseId, 'toolu_A')

      // B's entry is unchanged — same options shape we armed it with.
      const bEntry = session._pendingUserAnswers.get('toolu_B')
      assert.equal(bEntry.toolUseId, 'toolu_B')
      assert.deepEqual(bEntry.options, [{ label: 'b1' }, { label: 'b2' }],
        'B\'s options array preserved verbatim')
    })

    // #4690 (review of #4687) — pin the fallback path in respondToQuestion
    // when the dashboard omits `toolUseId` but multiple pending entries
    // exist. Per claude-tui-session.js:1896-1899 the current contract is:
    //   1. Emit a warn log naming the omitted-toolUseId condition + Map
    //      size + the pending keys (greppable in chroxy.log so the wedge
    //      symptom is visible).
    //   2. Fall back to the back-compat `_pendingUserAnswer` getter, which
    //      returns the MOST-RECENTLY-SET entry (insertion order via
    //      `_lastPendingAnswerToolUseId`).
    //   3. Consume that entry only (surgical _clearPendingAnswerByToolUseId
    //      on `entry.toolUseId`); siblings remain pending.
    //
    // The fallback is intentional — legacy mobile clients that don't pass
    // toolUseId would otherwise wedge. The behaviour decision (warn vs.
    // drop) is tracked separately in #4688; #4690 pins the CURRENT
    // semantics so any future change to "drop on ambiguity" is loud, not
    // silent.
    it('respondToQuestion: no toolUseId + N>1 pending fires WARN, routes to most-recent, preserves siblings (#4690)', async () => {
      // Capture warn lines so we can assert on the #4688 diagnostic.
      const warnLines = []
      const logSpy = (entry) => {
        if (entry.component !== 'claude-tui-session') return
        if (entry.level === 'warn') warnLines.push(entry.message)
      }
      addLogListener(logSpy)
      try {
        const writes = []
        session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

        // Arm A first, then B — Map insertion order tracks "most recent".
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_first',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'QA?', options: [{ label: 'a1' }, { label: 'a2' }] }] },
        }, 'msg-fallback')
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_second',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'QB?', options: [{ label: 'b1' }, { label: 'b2' }, { label: 'b3' }] }] },
        }, 'msg-fallback')

        assert.equal(session._pendingUserAnswers.size, 2, 'precondition: both pending')
        assert.equal(session._lastPendingAnswerToolUseId, 'toolu_second',
          'precondition: "most recent" pointer is at B (the second insert)')

        // Dashboard sends an answer matching B's option, but OMITS toolUseId
        // (legacy client path). Per fallback contract: warn + route to B,
        // leave A alone.
        session.respondToQuestion('b3', undefined, undefined)
        await new Promise((resolve) => setTimeout(resolve, 50))

        // (1) WARN log fires naming the fallback condition. Pre-#4688
        // this was silent and the wedge symptom required a code read to
        // diagnose.
        const fallbackWarn = warnLines.find(
          (m) => /omitted toolUseId/.test(m) && /falling back to most-recent/.test(m),
        )
        assert.ok(fallbackWarn,
          `expected fallback warn, got warnLines=${JSON.stringify(warnLines)}`)
        assert.match(fallbackWarn, /2 pending entries/,
          'warn includes the Map size for triage')
        assert.match(fallbackWarn, /toolu_first/, 'warn lists pending keys (A)')
        assert.match(fallbackWarn, /toolu_second/, 'warn lists pending keys (B)')

        // (2) Most-recent entry (B) received the answer — PTY write of the
        // 1-indexed digit for "b3" (option 3 of toolu_second's options).
        assert.equal(writes[0], '\x1b[?2004l', 'bracketed-paste-disable')
        assert.equal(writes[1], '3',
          'wrote 1-indexed digit for B\'s option "b3" — routed to most-recent entry')

        // (3) A's entry is UNTOUCHED — the surgical
        // _clearPendingAnswerByToolUseId(entry.toolUseId) on the fallback
        // path only removes the entry it consumed, not every sibling.
        assert.equal(session._pendingUserAnswers.size, 1,
          'one entry left after fallback consumed the most-recent')
        assert.ok(session._pendingUserAnswers.has('toolu_first'),
          'A (the older entry) SURVIVES — fallback must not collapse the Map')
        assert.ok(!session._pendingUserAnswers.has('toolu_second'),
          'B (the consumed most-recent) is gone')
      } finally {
        removeLogListener(logSpy)
      }
    })
  })

  // #4604 — observability + watchdog around AskUserQuestion. The root
  // cause (claude TUI multi-question forms render a per-question form
  // that needs more than one keystroke) is fixed in a separate refactor
  // (Chunk B). These tests pin the defensive layers:
  //   - A WARN log fires when a PreToolUse arrives with >1 question so
  //     the wedge condition is visible in chroxy.log.
  //   - A 30s watchdog clears the busy state + emits ASK_USER_QUESTION_STALL
  //     when claude TUI never emits PostToolUse after chroxy writes the
  //     answer (i.e. the keystroke didn't satisfy the form).
  //   - The watchdog is cancelled on PostToolUse arrival (happy path) and
  //     on destroy() (clean teardown).
  describe('AskUserQuestion stall watchdog (#4604)', () => {
    let warnLines
    let infoLines
    let logSpy

    beforeEach(() => {
      warnLines = []
      infoLines = []
      logSpy = (entry) => {
        if (entry.component !== 'claude-tui-session') return
        if (entry.level === 'warn') warnLines.push(entry.message)
        if (entry.level === 'info') infoLines.push(entry.message)
      }
      addLogListener(logSpy)
    })

    afterEach(() => {
      if (logSpy) removeLogListener(logSpy)
      logSpy = null
      warnLines = null
      infoLines = null
    })

    it('PreToolUse with >1 question fires a multi-question warn (#4604 chunk A)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { uuid: 'test', synthSeq: 0 }

      const questions = [
        { question: 'Q1?', options: [{ label: 'a' }, { label: 'b' }] },
        { question: 'Q2?', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }] },
        { question: 'Q3?', options: [{ label: 'p' }] },
        { question: 'Q4?', options: [{ label: 'q' }] },
      ]
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_aq_multi',
        tool_name: 'AskUserQuestion',
        tool_input: { questions },
      }, 'msg-aq-multi')

      const multiWarn = warnLines.find((m) => /multi-question forms are not yet supported/.test(m))
      assert.ok(multiWarn, `expected multi-question warn, got warnLines=${JSON.stringify(warnLines)}`)
      assert.match(multiWarn, /4 questions/, 'warn includes the question count')
      assert.match(multiWarn, /#4604/, 'warn references the tracking issue')

      const pendingInfo = infoLines.find((m) => /AskUserQuestion pending/.test(m))
      assert.ok(pendingInfo, 'PreToolUse also fires an info log with the toolUseId + counts')
      assert.match(pendingInfo, /questions=4/)
    })

    it('does NOT fire the multi-question warn for a single-question prompt (happy path)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { uuid: 'test', synthSeq: 0 }

      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_aq_single',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Q1?', options: [{ label: 'a' }] }] },
      }, 'msg-aq-single')

      const multiWarn = warnLines.find((m) => /multi-question forms are not yet supported/.test(m))
      assert.equal(multiWarn, undefined, 'single-question must not trigger the multi-question warn')
    })

    it('watchdog fires after 30s when PostToolUse never arrives — clears busy + emits ASK_USER_QUESTION_STALL', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const errors = []
        session.on('error', (e) => errors.push(e))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_stall',
          options: [{ label: 'a' }, { label: 'b' }],
        }

        session.respondToQuestion('a')
        // respondToQuestion clears _pendingUserAnswer synchronously at the
        // top — simulate the stuck-form condition by reinstating it (this
        // is what would happen if PostToolUse never arrived: chroxy wrote
        // one digit but claude TUI is sitting on question 2).
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_stall',
          options: [{ label: 'a' }, { label: 'b' }],
        }

        // Just under the watchdog window — nothing should fire yet.
        mock.timers.tick(29_000)
        assert.equal(errors.length, 0, 'no error before the 30s watchdog window')
        assert.equal(session._isBusy, true, 'still busy before fire')

        // Cross the threshold.
        mock.timers.tick(2_000)

        assert.equal(errors.length, 1, 'exactly one error after the watchdog fires')
        assert.equal(errors[0].code, 'ASK_USER_QUESTION_STALL', 'error carries the structured code')
        assert.equal(errors[0].toolUseId, 'toolu_aq_stall', 'error carries the toolUseId we armed with')
        assert.match(errors[0].message, /retry/i, 'message tells the user to retry')

        assert.equal(session._isBusy, false, 'busy cleared so the session is recoverable')
        assert.equal(session._pendingUserAnswer, null, 'pending answer slot cleared')

        const stallWarn = warnLines.find((m) => /AskUserQuestion stall/.test(m))
        assert.ok(stallWarn, 'watchdog fire also logs a warn for triage')
        assert.match(stallWarn, /toolu_aq_stall/, 'warn includes toolUseId')
      } finally {
        mock.timers.reset()
      }
    })

    // #4645 — pre-fix the stall handler only cleared _isBusy + emitted the
    // ASK_USER_QUESTION_STALL error, leaving stream_start orphaned (no
    // matching stream_end, no result, no agent_idle fan-out). The dashboard
    // kept showing "Working… Ns ago" + Stop button forever even though the
    // turn had been given up on — and the input was still in
    // "Type to send follow-up…" mode so the user had no Send affordance to
    // retry from. Pin the full teardown so a regression can't re-introduce
    // the misleading UI state.
    it('stall fires full teardown (stream_end + result + error) so dashboard banner + Stop button clear (#4645)', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const events = []
        session.on('tool_result', (e) => events.push({ type: 'tool_result', ...e }))
        session.on('stream_end', (e) => events.push({ type: 'stream_end', ...e }))
        session.on('result', (e) => events.push({ type: 'result', ...e }))
        session.on('error', (e) => events.push({ type: 'error', ...e }))

        const ptyWrites = []
        session._term = { write: (b) => ptyWrites.push(b), kill: () => {} }
        session._isBusy = true
        session._currentMessageId = 'msg-stall'
        session._activeTurn = { startedAt: Date.now() - 50, aborted: false, uuid: 't', synthSeq: 0 }
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_stall',
          options: [{ label: 'a' }, { label: 'b' }],
        }

        session.respondToQuestion('a')
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_stall',
          options: [{ label: 'a' }, { label: 'b' }],
        }

        mock.timers.tick(31_000)

        // Full teardown: synthetic tool_result → stream_end → result → error.
        // tool_result first so the activeTools pill clears before the result
        // fan-out; error last so the toast surfaces after busy state settles.
        const types = events.map((e) => e.type)
        assert.deepEqual(types, ['tool_result', 'stream_end', 'result', 'error'],
          'fan-out order: tool_result → stream_end → result → error')

        const streamEnd = events.find((e) => e.type === 'stream_end')
        assert.equal(streamEnd.messageId, 'msg-stall', 'stream_end carries the current messageId')

        const result = events.find((e) => e.type === 'result')
        assert.equal(result.cost, null, 'cost=null skips billing accumulation')
        assert.ok(Number.isFinite(result.duration), 'duration is finite')

        const err = events.find((e) => e.type === 'error')
        assert.equal(err.code, 'ASK_USER_QUESTION_STALL', 'error code preserved for dashboard chip')
        assert.equal(err.toolUseId, 'toolu_aq_stall')

        // Best-effort Ctrl-C so claude TUI itself unsticks for the next turn.
        assert.ok(ptyWrites.includes('\x03'), 'Ctrl-C written to PTY')

        assert.equal(session._isBusy, false, 'busy cleared')
        assert.equal(session._currentMessageId, null, 'messageId nulled')
        assert.equal(session._activeTurn, null, 'active turn nulled')
        assert.equal(session._pendingUserAnswer, null, 'pending answer slot cleared')
      } finally {
        mock.timers.reset()
      }
    })

    it('watchdog does NOT fire when PostToolUse arrives in time (happy path)', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._activeTurn = { uuid: 'test', synthSeq: 0 }
        const errors = []
        session.on('error', (e) => errors.push(e))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_ok',
          options: [{ label: 'a' }, { label: 'b' }],
        }

        session.respondToQuestion('a')

        // Halfway through the watchdog window — claude TUI emits PostToolUse.
        mock.timers.tick(15_000)
        assert.equal(errors.length, 0, 'no error before PostToolUse')

        session._emitToolHookEvent('PostToolUse', {
          tool_use_id: 'toolu_aq_ok',
          tool_name: 'AskUserQuestion',
          tool_response: { selectedLabel: 'a' },
        }, 'msg-aq-ok')

        // Push well past the original 30s window — watchdog must have been
        // cleared by PostToolUse, so no late fire.
        mock.timers.tick(60_000)
        assert.equal(errors.length, 0, 'watchdog cancelled by PostToolUse, no late stall error')
      } finally {
        mock.timers.reset()
      }
    })

    // #4691 — surgical watchdog teardown when sibling pending entries
    // exist in `_pendingUserAnswers`. Setup:
    //
    //   1. PreToolUse arms A and B in the Map (parallel AskUserQuestion).
    //   2. respondToQuestion(A) consumes A's entry (surgical
    //      `_clearPendingAnswerByToolUseId`) AND arms the stall watchdog
    //      with A's toolUseId. B remains pending in the Map.
    //   3. PostToolUse for A never arrives → watchdog fires →
    //      `_onAskUserQuestionStall(A)`.
    //
    // Pre-#4691 behaviour was `_pendingUserAnswer = null` → back-compat
    // setter → `_pendingUserAnswers.clear()`: the watchdog wiped EVERY
    // pending entry, including B which had nothing to do with A's stall.
    // Post-#4691: the watchdog only knows about A (the toolUseId it was
    // armed with), so it surgically clears A via
    // `_clearPendingAnswerByToolUseId('toolu_A_stall')` and leaves B
    // intact. B's PostToolUse can still arrive without finding a
    // collapsed entry. The other teardown sites (destroy, hard timeout,
    // interrupt, _finishTurnError) remain all-or-nothing because the
    // whole turn is over there — no live sibling can survive a turn
    // ending — so wiping the Map matches their semantics exactly.
    it('watchdog fire with N>1 sibling pending entries surgically clears ONLY the timed-out tool; siblings survive (#4691)', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._activeTurn = { uuid: 'test-watchdog-siblings', synthSeq: 0 }
        const errors = []
        session.on('error', (e) => errors.push(e))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true

        // Arm both A and B in the Map.
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_A_stall',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'QA?', options: [{ label: 'a1' }, { label: 'a2' }] }] },
        }, 'msg-watchdog-AB')
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_B_pending',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'QB?', options: [{ label: 'b1' }, { label: 'b2' }] }] },
        }, 'msg-watchdog-AB')
        assert.equal(session._pendingUserAnswers.size, 2, 'precondition: A and B armed')

        // Dashboard answers A — consumes A's entry, arms the watchdog with
        // A's toolUseId, leaves B pending.
        session.respondToQuestion('a1', undefined, 'toolu_A_stall')

        // State after respondToQuestion: A is gone, B is still pending.
        assert.ok(!session._pendingUserAnswers.has('toolu_A_stall'),
          'A consumed by respondToQuestion')
        assert.ok(session._pendingUserAnswers.has('toolu_B_pending'),
          'B still pending — its turn has not started yet')
        assert.equal(session._pendingUserAnswers.size, 1, 'only B left')

        // PostToolUse for A never arrives. Cross the watchdog threshold.
        mock.timers.tick(31_000)

        // Error fires for the toolUseId we ARMED the watchdog with (A) —
        // NOT for B which had nothing to do with the stall.
        assert.equal(errors.length, 1, 'exactly one stall error')
        assert.equal(errors[0].code, 'ASK_USER_QUESTION_STALL')
        assert.equal(errors[0].toolUseId, 'toolu_A_stall',
          'error attributes the stall to A (the timed-out tool), not B')

        // #4691 surgical-teardown semantics: the watchdog ONLY clears
        // the entry it was armed for (A). Sibling B survives because its
        // PostToolUse path is still live. A regression that re-introduces
        // the pre-#4691 back-compat `_pendingUserAnswer = null` here
        // would silently wipe B and re-create the #4691 state-shape
        // mismatch.
        assert.equal(session._pendingUserAnswers.size, 1,
          'watchdog clears ONLY the timed-out tool, not the whole Map')
        assert.ok(session._pendingUserAnswers.has('toolu_B_pending'),
          'B SURVIVES — its turn is still live, do not collapse it under A\'s teardown')
        assert.ok(!session._pendingUserAnswers.has('toolu_A_stall'),
          'A is gone (it was the watchdog\'s target)')

        // Busy state cleared so the session is recoverable.
        assert.equal(session._isBusy, false, 'busy cleared')
      } finally {
        mock.timers.reset()
      }
    })

    // #5319 (WP-3.2) — two parallel ANSWERED questions each get an independent
    // watchdog. Pre-#5319 the single `_askUserQuestionWatchdog` field meant the
    // second respondToQuestion clobbered the first's watchdog, and a PostToolUse
    // for either tool cancelled whichever watchdog happened to be live — so
    // answering one question silently disarmed the other's stall protection.
    it('two answered questions get independent watchdogs; PostToolUse for one leaves the other armed + firing (#5319)', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._activeTurn = { uuid: 'test-5319', synthSeq: 0 }
        const errors = []
        session.on('error', (e) => errors.push(e))
        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        session._currentMessageId = 'msg-5319'

        // Two parallel AskUserQuestions pending.
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_A', tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'QA?', options: [{ label: 'a1' }] }] },
        }, 'msg-5319')
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_B', tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'QB?', options: [{ label: 'b1' }] }] },
        }, 'msg-5319')

        // Answer BOTH → each arms its OWN watchdog (keyed by toolUseId).
        session.respondToQuestion('a1', undefined, 'toolu_A')
        session.respondToQuestion('b1', undefined, 'toolu_B')
        assert.equal(session._askUserQuestionWatchdogs.size, 2, 'two independent watchdogs armed')

        // PostToolUse for A cancels ONLY A's watchdog; B's stays armed.
        session._emitToolHookEvent('PostToolUse', {
          tool_use_id: 'toolu_A', tool_name: 'AskUserQuestion', tool_response: 'ok',
        }, 'msg-5319')
        assert.equal(session._askUserQuestionWatchdogs.has('toolu_A'), false, "A's watchdog cancelled by its own PostToolUse")
        assert.ok(session._askUserQuestionWatchdogs.has('toolu_B'), "B's watchdog NOT disarmed by answering A")

        // B never gets a PostToolUse → its independent watchdog still fires.
        mock.timers.tick(31_000)
        assert.ok(
          errors.some((e) => e.code === 'ASK_USER_QUESTION_STALL' && e.toolUseId === 'toolu_B'),
          "B's independent watchdog still recovers the session",
        )
      } finally {
        mock.timers.reset()
      }
    })

    // #4691 — single-pending-entry watchdog still tears the slot down
    // (no regression from the surgical refactor). When only one entry
    // is armed AND the watchdog fires for it, surgical clear and
    // all-or-nothing clear produce the same end state — empty Map.
    // This pins that the common single-question case isn't accidentally
    // left behind by the per-toolUseId change.
    it('watchdog fire with exactly 1 pending entry still clears it (single-question, #4691)', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._activeTurn = { uuid: 'test-watchdog-single', synthSeq: 0 }
        const errors = []
        session.on('error', (e) => errors.push(e))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true

        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_solo',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'Q?', options: [{ label: 's1' }, { label: 's2' }] }] },
        }, 'msg-watchdog-solo')

        // respondToQuestion consumes the entry then we need to simulate
        // the "no PostToolUse arrived" wedge by reinstating it (the
        // production scenario where chroxy wrote the digit but TUI sat
        // on a multi-question form). The watchdog still tears it down.
        session.respondToQuestion('s1', undefined, 'toolu_solo')
        session._pendingUserAnswers.set('toolu_solo', {
          toolUseId: 'toolu_solo',
          options: [{ label: 's1' }, { label: 's2' }],
        })
        session._lastPendingAnswerToolUseId = 'toolu_solo'

        mock.timers.tick(31_000)

        assert.equal(errors.length, 1)
        assert.equal(errors[0].toolUseId, 'toolu_solo')
        assert.equal(session._pendingUserAnswers.size, 0,
          'single-entry case still ends empty (surgical clear of the only entry)')
        assert.equal(session._isBusy, false, 'busy cleared')
      } finally {
        mock.timers.reset()
      }
    })

    // #4802 — per-callsite intent audit. Each teardown site now picks an
    // explicit method (`_pendingUserAnswers_clearAll()` or
    // `_clearPendingAnswerByToolUseId(tid)`) instead of routing through
    // a back-compat `_pendingUserAnswer = null` setter that implicitly
    // wiped the entire Map. The audit flagged `_finishTurnError` in
    // particular: it does NOT issue Ctrl-C and is invoked for several
    // "turn ended unexpectedly" reasons (PTY exit, Stop hook timeout,
    // prompt-write failure) where a sibling AskUserQuestion's answer can
    // still be in flight on the wire. Wiping the sibling there hits the
    // "no matching pending entry — dropping" path in respondToQuestion
    // and produces the silent #4668-class wedge described in #4802.
    //
    // Post-#4802: `_finishTurnError` PRESERVES the Map (no clear-all);
    // late respondToQuestion calls still find their entry. The other
    // turn-ending sites (`_teardownTurn` via hard timeout / stream stall /
    // first-output timeout, `interrupt()`, `destroy()`) keep clear-all
    // because they all issue Ctrl-C (or kill the PTY outright), so any
    // late keystroke would be writing into a torn-down TUI anyway.
    it('_finishTurnError preserves pending entries (surgical, audit P1.2 #4802)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._pendingUserAnswers.set('toolu_one', { toolUseId: 'toolu_one', options: [] })
      session._pendingUserAnswers.set('toolu_two', { toolUseId: 'toolu_two', options: [] })
      session._lastPendingAnswerToolUseId = 'toolu_two'
      session.on('error', () => {})
      session._isBusy = true
      session._currentMessageId = 'msg-finish'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._finishTurnError('test-error', 'msg-finish')
      assert.equal(session._pendingUserAnswers.size, 2,
        '_finishTurnError must NOT wipe pending entries — siblings can have answers in flight (#4802)')
      assert.ok(session._pendingUserAnswers.has('toolu_one'), 'sibling one preserved')
      assert.ok(session._pendingUserAnswers.has('toolu_two'), 'sibling two preserved')
    })

    it('_handleHardTimeout wipes ALL pending entries (turn-level teardown, #4691)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._pendingUserAnswers.set('toolu_one', { toolUseId: 'toolu_one', options: [] })
      session._pendingUserAnswers.set('toolu_two', { toolUseId: 'toolu_two', options: [] })
      session._lastPendingAnswerToolUseId = 'toolu_two'
      session.on('error', () => {})
      session._isBusy = true
      session._currentMessageId = 'msg-hard'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }
      session._hardTimeoutMs = 1000
      session._handleHardTimeout()
      assert.equal(session._pendingUserAnswers.size, 0,
        'hard timeout ends the turn with Ctrl-C — every pending answer is now stale')
    })

    it('interrupt() wipes ALL pending entries (turn-level teardown, #4691)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._pendingUserAnswers.set('toolu_one', { toolUseId: 'toolu_one', options: [] })
      session._pendingUserAnswers.set('toolu_two', { toolUseId: 'toolu_two', options: [] })
      session._lastPendingAnswerToolUseId = 'toolu_two'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }
      session.interrupt()
      assert.equal(session._pendingUserAnswers.size, 0,
        'interrupt ends the turn with Ctrl-C — every pending answer is now stale')
    })

    // #4802 — pin the parallel-questions-with-mid-flight-stall regression
    // scenario from the audit verbatim. The audit's failure mode:
    //
    //   1. Turn emits AskUserQuestion A + B in parallel (post-#4668 deny
    //      retry-as-singles shape).
    //   2. PostToolUse for A arrives → A's entry is cleared surgically.
    //   3. Stream stalls for an UNRELATED reason (Stop hook timeout, PTY
    //      exit, etc.) → `_finishTurnError` runs.
    //   4. Pre-#4802 the back-compat `_pendingUserAnswer = null` setter
    //      called `_pendingUserAnswers.clear()` and wiped B.
    //   5. B's answer arrives microseconds later from the dashboard,
    //      finds the Map empty, hits the "no matching pending entry —
    //      dropping" path, and silently wedges.
    //
    // Post-#4802: `_finishTurnError` does NOT wipe — B survives so the
    // late response can still consume it.
    it('parallel A+B with mid-flight _finishTurnError preserves sibling B (audit P1.2 #4802)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {} }
      session.on('error', () => {})
      session._isBusy = true
      session._currentMessageId = 'msg-parallel-stall'
      session._activeTurn = { startedAt: Date.now(), aborted: false, uuid: 'test-4802' }

      // (1) Two parallel AskUserQuestion tool_uses arrive in one turn.
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_A',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'QA?', options: [{ label: 'a1' }, { label: 'a2' }] }] },
      }, 'msg-parallel-stall')
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_B',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'QB?', options: [{ label: 'b1' }, { label: 'b2' }] }] },
      }, 'msg-parallel-stall')
      assert.equal(session._pendingUserAnswers.size, 2, 'precondition: A and B armed')

      // (2) PostToolUse for A only — A cleared, B still pending.
      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_A',
        tool_name: 'AskUserQuestion',
        tool_response: { selectedLabel: 'a1' },
      }, 'msg-parallel-stall')
      assert.ok(!session._pendingUserAnswers.has('toolu_A'), 'A cleared by its own PostToolUse')
      assert.ok(session._pendingUserAnswers.has('toolu_B'), 'B still pending pre-stall')

      // (3) Stream stalls for an unrelated reason → _finishTurnError fires.
      session._finishTurnError('Stop hook timeout', 'msg-parallel-stall')

      // (4) Pre-#4802: B was wiped by the back-compat null setter →
      //     `_pendingUserAnswers.clear()`. Post-#4802: B SURVIVES — a
      //     late response from the dashboard can still consume it.
      assert.ok(session._pendingUserAnswers.has('toolu_B'),
        'B\'s pending answer SURVIVES the unrelated turn teardown — late dashboard response must still find its entry (#4802)')
      assert.equal(session._pendingUserAnswers.size, 1, 'only B remains (A already consumed)')
    })

    it('watchdog is cleared on destroy() (clean teardown)', async () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const errors = []
        session.on('error', (e) => errors.push(e))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_destroy',
          options: [{ label: 'a' }],
        }

        session.respondToQuestion('a')

        // Tear down before the watchdog fires.
        await session.destroy()
        session = null  // afterEach should not double-destroy

        // Push well past the watchdog window.
        mock.timers.tick(60_000)
        assert.equal(errors.length, 0, 'destroy() must cancel the watchdog — no late stall error')
      } finally {
        mock.timers.reset()
      }
    })

    it('watchdog also emits synthetic tool_result so dashboard activeTools clears (#4616)', () => {
      // #4616 — without the synthetic tool_result the dashboard's
      // activeTools entry for this AskUserQuestion is never paired/cleared
      // (handlers.handleToolResult.applyToActiveTools removes by toolUseId).
      // Result: footer pill "Running AskUserQuestion · Ns" keeps ticking
      // forever even though _isBusy is clear and the user sees the toast.
      // Both events MUST emit, and tool_result MUST precede error so the
      // dashboard's tool-pairing path resolves before the error toast lands.
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const events = []
        session.on('tool_result', (e) => events.push({ name: 'tool_result', payload: e }))
        session.on('error', (e) => events.push({ name: 'error', payload: e }))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_pair',
          options: [{ label: 'a' }],
        }

        session.respondToQuestion('a')
        // Reinstate the stuck-form condition as in the original watchdog test.
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_pair',
          options: [{ label: 'a' }],
        }

        mock.timers.tick(31_000)

        assert.equal(events.length, 2,
          `expected exactly tool_result + error, got ${events.map(e => e.name).join(',')}`)
        assert.deepEqual(events.map((e) => e.name), ['tool_result', 'error'],
          'tool_result MUST precede error so activeTools clears before the toast lands')

        const trEvent = events[0].payload
        assert.equal(trEvent.toolUseId, 'toolu_aq_pair',
          'tool_result.toolUseId must match the armed toolUseId so store-core applyToActiveTools removes the entry')
        assert.equal(typeof trEvent.result, 'string',
          'tool_result.result must be a string (store-core handleToolResult coerces non-strings to "")')
        assert.equal(trEvent.truncated, false,
          'tool_result.truncated must be boolean (store-core handleToolResult coerces non-booleans to false)')
        assert.match(trEvent.result, /stalled/i,
          'tool_result.result text references the stall so the bubble shows context')

        const errEvent = events[1].payload
        assert.equal(errEvent.code, 'ASK_USER_QUESTION_STALL',
          'error event still carries the structured code so the dashboard toast renders correctly')
        assert.equal(errEvent.toolUseId, 'toolu_aq_pair',
          'error event still carries toolUseId for triage')
      } finally {
        mock.timers.reset()
      }
    })

    it('watchdog is cleared on interrupt() so a user-interrupted answer does not fire ASK_USER_QUESTION_STALL', () => {
      // #4604 review follow-up: interrupt() does NOT clear _isBusy directly
      // (Ctrl-C resolves via _finishTurn* async). Without clearing the
      // watchdog in interrupt(), the guard in _onAskUserQuestionStall
      // (_pendingUserAnswer=null + _isBusy=true → does not bail) would
      // emit a spurious ASK_USER_QUESTION_STALL ~30s after the user
      // already interrupted the session.
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const errors = []
        session.on('error', (e) => errors.push(e))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        session._activeTurn = { uuid: 'test', synthSeq: 0, aborted: false, startedAt: Date.now() }
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_interrupt',
          options: [{ label: 'a' }],
        }

        session.respondToQuestion('a')
        // User interrupts before claude TUI emits PostToolUse.
        session.interrupt()

        // Push well past the watchdog window — interrupt() must have
        // cancelled the watchdog so no spurious stall error fires.
        mock.timers.tick(60_000)
        assert.equal(errors.length, 0, 'interrupt() must cancel the watchdog — no late stall error')
      } finally {
        mock.timers.reset()
      }
    })
  })

  // #5320 (WP-3.3) — recovery on every respondToQuestion path + crash-isolation
  // for the intervention emit. Before this, the validation-failure early-returns
  // in the Other/freeform path cleared the pending answer but armed no watchdog
  // and emitted no error (the turn wedged until the 2h hard cap), the freeform
  // IIFE ignored interrupt()'s abort, and a throwing multi_question_intervention
  // listener orphaned the pending by skipping the user_question emit.
  describe('respondToQuestion recovery on every path (#5320 WP-3.3)', () => {
    function makeAnsweringSession() {
      const s = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      s._activeTurn = { synthSeq: 0, aborted: false, startedAt: Date.now() }
      s._isBusy = true
      s._currentMessageId = 'msg-5320'
      s.on('error', () => {})
      return s
    }

    it('a freeform answer with no selectable options still arms a stall watchdog', async () => {
      const s = makeAnsweringSession()
      s._term = { write: () => {}, kill: () => {} }
      s._pendingUserAnswer = { toolUseId: 'toolu_no_opts', questions: [{ options: [] }], options: [] }
      s.respondToQuestion('whatever', undefined, 'toolu_no_opts', { freeformText: 'hi' })
      assert.ok(s._askUserQuestionWatchdogs.has('toolu_no_opts'), 'watchdog armed despite the drop')
      assert.equal(s._pendingUserAnswers.size, 0, 'pending cleared')
      await s.destroy()
    })

    it('an empty answer arms a recovery watchdog WITHOUT consuming the pending', async () => {
      // The dashboard clears its QuestionPrompt UI when it submits, even for an
      // empty answer. respondToQuestion returns early on empty text + no
      // answersMap (it can't drive the form with nothing), so without recovery
      // the turn would wedge. #5320: arm a watchdog before that early-return —
      // but DON'T consume the pending, so a real follow-up answer still works.
      const s = makeAnsweringSession()
      s._term = { write: () => {}, kill: () => {} }
      s._pendingUserAnswer = { toolUseId: 'toolu_empty', questions: [{ options: [{ label: 'a' }] }], options: [{ label: 'a' }] }
      s.respondToQuestion('', undefined, 'toolu_empty')
      assert.ok(s._askUserQuestionWatchdogs.has('toolu_empty'), 'recovery watchdog armed for the empty answer')
      assert.equal(s._pendingUserAnswers.size, 1, 'empty answer does NOT consume the pending entry')
      await s.destroy()
    })

    it('a freeform answer whose option is not found still arms a stall watchdog', async () => {
      const s = makeAnsweringSession()
      s._term = { write: () => {}, kill: () => {} }
      s._pendingUserAnswer = { toolUseId: 'toolu_nomatch', questions: [{ options: [{ label: 'a' }] }], options: [{ label: 'a' }] }
      s.respondToQuestion('NotAnOption', undefined, 'toolu_nomatch', { freeformText: 'hi' })
      assert.ok(s._askUserQuestionWatchdogs.has('toolu_nomatch'), 'watchdog armed despite the drop')
      await s.destroy()
    })

    it('interrupt() during the Other-freeform settle stops the IIFE re-arming the watchdog', async () => {
      const s = makeAnsweringSession()
      const writes = []
      s._term = { write: (b) => writes.push(String(b)), kill: () => {} }
      s._pendingUserAnswer = { toolUseId: 'toolu_abort', questions: [{ options: [{ label: 'Other' }] }], options: [{ label: 'Other' }] }

      s.respondToQuestion('Other', undefined, 'toolu_abort', { freeformText: 'SECRET_FREEFORM' })
      // The arm-after-clear watchdog (#5320) is live during the settle.
      assert.ok(s._askUserQuestionWatchdogs.has('toolu_abort'), 'watchdog armed during the answer write')

      // Interrupt DURING the 150ms settle window. interrupt() sets
      // _activeTurn.aborted and clears all watchdogs synchronously; the IIFE's
      // post-settle abort guard must then bail BEFORE re-arming at stage 2.
      await new Promise((r) => setTimeout(r, 40))
      s.interrupt()

      // Wait past the settle + would-be stage-2 re-arm/write.
      await new Promise((r) => setTimeout(r, 250))

      // Distinct contribution of the abort guard: no watchdog re-armed after
      // interrupt() cleared them. Without the guard the IIFE would re-arm
      // 'toolu_abort' at stage 2 (this assertion fails on main / without the fix).
      assert.ok(!s._askUserQuestionWatchdogs.has('toolu_abort'), 'IIFE did NOT re-arm the watchdog after interrupt()')
      assert.ok(!writes.join('').includes('SECRET_FREEFORM'), 'stage-2 freeform write skipped after interrupt')
      await s.destroy()
    })

    it('a throwing multi_question_intervention listener does not orphan the pending', () => {
      const s = makeAnsweringSession()
      s.on('multi_question_intervention', () => { throw new Error('listener boom') })
      let userQ = null
      s.on('user_question', (e) => { userQ = e })
      // Multi-question PreToolUse triggers the intervention emit before user_question.
      s._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_mq', tool_name: 'AskUserQuestion',
        tool_input: { questions: [
          { question: 'Q1?', options: [{ label: 'a' }] },
          { question: 'Q2?', options: [{ label: 'b' }] },
        ] },
      }, 'msg-5320')
      assert.ok(userQ, 'user_question still emitted despite the intervention listener throwing')
      assert.equal(s._pendingUserAnswers.size, 1, 'pending recorded — not orphaned')
    })
  })

  // #5311 (WP-1.1) — a PTY socket fault must tear down only THIS session and
  // emit a session-scoped error, never crash the daemon. _onPtyGone is the
  // single idempotent teardown reached from onExit + the close/error socket
  // events; these tests exercise its contract directly.
  describe('PTY failure teardown _onPtyGone (#5311 WP-1.1)', () => {
    function makeSession() {
      return new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
    }

    it('resets state and emits ONE session error when the PTY dies with no active turn', () => {
      const s = makeSession()
      const errors = []
      s.on('error', (e) => errors.push(e))
      s._isBusy = true
      s._processReady = true
      s._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      assert.equal(s._ptyExited, true, 'marks the PTY dead')
      assert.equal(s._isBusy, false, 'clears busy so the next sendMessage isn\'t wedged')
      assert.equal(s._processReady, false)
      assert.equal(errors.length, 1, 'exactly one error')
      assert.match(errors[0].message, /Claude PTY exited \(code=1\)/)
    })

    it('renders code=unknown (never "undefined") when failing via close/error with no exit info (#5311)', () => {
      const s = makeSession()
      const errors = []
      s.on('error', (e) => errors.push(e))
      s._onPtyGone(null, 'close') // socket fault: no exit info
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /Claude PTY exited \(code=unknown\)/)
      assert.doesNotMatch(errors[0].message, /undefined/)
    })

    it('is idempotent — onExit + close + error collapse to ONE error emit', () => {
      const s = makeSession()
      const errors = []
      s.on('error', (e) => errors.push(e))
      s._onPtyGone(null, 'close')
      s._onPtyGone({ exitCode: 0 }, 'exit')
      s._onPtyGone(null, 'error: boom')
      assert.equal(errors.length, 1, 'one error despite three teardown events in any order')
    })

    it('suppresses the generic error when a turn was in flight (sendMessage emits the specific one)', () => {
      const s = makeSession()
      const errors = []
      s.on('error', (e) => errors.push(e))
      s._activeTurn = { messageId: 'm1', startedAt: Date.now(), aborted: false }
      s._onPtyGone({ exitCode: 137 }, 'exit')
      assert.equal(s._activeTurn, null, 'active turn cleared')
      assert.equal(s._isBusy, false)
      assert.equal(errors.length, 0, 'no generic error while a turn was in flight')
    })

    it('captures the most specific exit info even on a guarded repeat event', () => {
      const s = makeSession()
      s.on('error', () => {})
      s._onPtyGone(null, 'close')            // close fires first, no info
      s._onPtyGone({ exitCode: 42 }, 'exit') // exit arrives after; guarded, but info updates
      assert.equal(s._ptyExitInfo?.exitCode, 42)
    })

    it('marks the PTY dead but emits nothing while destroying', () => {
      const s = makeSession()
      const errors = []
      s.on('error', (e) => errors.push(e))
      s._destroying = true
      s._onPtyGone({ exitCode: 1 }, 'exit')
      assert.equal(s._ptyExited, true, 'still marks exited so sendMessage rejects')
      assert.equal(errors.length, 0, 'no error emit during teardown')
    })
  })

  // #4044: per-session option that spawns claude TUI with the literal
  // --dangerously-skip-permissions flag and elides chroxy's permission
  // hook entirely. Distinct from `permissionMode: 'auto'`, which still
  // routes every tool call through chroxy's hook script.
  describe('skipPermissions (#4044)', () => {
    let fakeHome
    let origSpawnPty
    let capturedPermissionsEnabled
    let capturedArgs
    let session

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-skip-perm-home-'))
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
      process.env._ORIG_HOME = process.env.HOME
      process.env.HOME = fakeHome

      capturedPermissionsEnabled = null
      capturedArgs = null
      origSpawnPty = ClaudeTuiSession.prototype._spawnPty
      ClaudeTuiSession.prototype._spawnPty = async function (permissionsEnabled) {
        capturedPermissionsEnabled = permissionsEnabled
        // Mirror the production arg list (claude-tui-session.js _spawnPty) so
        // the test stays honest about what node-pty would actually receive.
        // #5307 (WP-0.1): fresh → --session-id, restore → --resume.
        const idArgs = this._resumedFromPersisted
          ? ['--resume', this._sessionId]
          : ['--session-id', this._sessionId]
        const args = [
          ...idArgs,
          '--settings', this._settingsPath,
        ]
        if (this.skipPermissions) args.push('--dangerously-skip-permissions')
        if (this.model) args.push('--model', this.model)
        capturedArgs = args
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
      }
    })

    afterEach(async () => {
      if (session) {
        try { await session.destroy() } catch { /* ignore */ }
        session = null
      }
      ClaudeTuiSession.prototype._spawnPty = origSpawnPty
      if (process.env._ORIG_HOME) {
        process.env.HOME = process.env._ORIG_HOME
        delete process.env._ORIG_HOME
      }
      if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    })

    it('default (skipPermissions undefined): permissionsEnabled=true when port is set, no flag in args', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345,
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      await session.start()
      assert.equal(capturedPermissionsEnabled, true, 'hook enabled by default when port given')
      assert.equal(capturedArgs.includes('--dangerously-skip-permissions'), false,
        '--dangerously-skip-permissions must NOT appear unless skipPermissions is set')
    })

    it('skipPermissions=true overrides port: permissionsEnabled=false, flag in args', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345, skipPermissions: true,
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      await session.start()
      // permissionsEnabled is the gate for hook install + sidecar write.
      assert.equal(capturedPermissionsEnabled, false,
        'skipPermissions must beat port — the whole point is to elide chroxy permissions')
      assert.ok(capturedArgs.includes('--dangerously-skip-permissions'),
        '--dangerously-skip-permissions must be in claude TUI args')
    })

    it('skipPermissions=true: PreToolUse settings does NOT include the permission hook script', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345, skipPermissions: true,
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      await session.start()
      // The settings.json on disk (written by writeHookSettings) must
      // only contain the per-event capture command — not the chroxy
      // permission gate. Otherwise the hook would still gate every call.
      const settings = JSON.parse(readFileSync(session._settingsPath, 'utf8'))
      const preToolUseCommands = settings.hooks.PreToolUse[0].hooks.map((h) => h.command)
      assert.equal(preToolUseCommands.length, 1,
        'expected only the capture command, not capture + permission hook')
      assert.match(preToolUseCommands[0], /cat > .*pre-/,
        'remaining hook is the observability capture')
      // Sidecar write also gated on permissionsEnabled → no permission-mode
      // file written.
      assert.equal(session._permissionModeFile, null,
        'permission-mode sidecar not written when skipPermissions is on')
    })

    it('skipPermissions defaults to false when omitted (constructor coercion)', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp',
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      assert.equal(session.skipPermissions, false)
    })

    it('skipPermissions=true coerces truthy non-booleans (defensive constructor)', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skipPermissions: 'yes',
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      assert.equal(session.skipPermissions, true,
        '!!"yes" === true — the constructor accepts truthy passthrough cleanly')
    })

    it('skipPermissions=true: spawn env omits CHROXY_PORT/HOOK_SECRET/PERMISSION_MODE_FILE (#4207 agent-review)', async () => {
      // The env gate at claude-tui-session.js:498-508 is a distinct site
      // from settings.json — both have to be off or the hook script can
      // still phone home. Mirror the production env-build in the stub.
      let capturedEnv = null
      ClaudeTuiSession.prototype._spawnPty = async function (permissionsEnabled) {
        const env = { ...process.env }
        delete env.ANTHROPIC_API_KEY
        env.TERM = 'xterm-256color'
        if (permissionsEnabled) {
          env.CHROXY_PORT = String(this._port)
          env.CHROXY_HOOK_SECRET = this._hookSecret
          env.CHROXY_PERMISSION_MODE = this.permissionMode || 'approve'
          if (this._permissionModeFile) {
            env.CHROXY_PERMISSION_MODE_FILE = this._permissionModeFile
          }
        }
        capturedEnv = env
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
      }
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345, skipPermissions: true,
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      await session.start()
      assert.equal(capturedEnv.CHROXY_PORT, undefined,
        'CHROXY_PORT must not leak to TUI env when permissions are skipped')
      assert.equal(capturedEnv.CHROXY_HOOK_SECRET, undefined)
      assert.equal(capturedEnv.CHROXY_PERMISSION_MODE, undefined)
      assert.equal(capturedEnv.CHROXY_PERMISSION_MODE_FILE, undefined)
    })

    it('skipPermissions=true: post-start setPermissionMode() is a safe no-op for the sidecar (#4207 agent-review)', async () => {
      // start() with skipPermissions doesn't create the sidecar, so
      // _permissionModeFile is null. setPermissionMode walks the same
      // early-return guard (`if (!this._permissionModeFile)`), so the
      // call must be a no-op rather than crash/leak.
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345, skipPermissions: true,
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      await session.start()
      assert.equal(session._permissionModeFile, null)
      // Must not throw + must not retroactively create a sidecar.
      session.setPermissionMode('auto')
      assert.equal(session._permissionModeFile, null,
        'setPermissionMode must NOT lazy-create the sidecar after skipPermissions start')
      assert.equal(session.permissionMode, 'auto',
        'in-process bookkeeping still updates so capabilities checks stay coherent')
    })
  })

  describe('_assertBusyHasMessageId invariant (#4642)', () => {
    // #4642: observability-only defensive instrumentation. Every sendMessage
    // sets `_isBusy=true` AND `_currentMessageId` together (claude-tui-session.js
    // lines 848/851), and every teardown clears both together. If a future
    // regression breaks that pairing, the `if(messageId)` guards in
    // _finishTurnError / _handleHardTimeout / _handleStreamStall /
    // _onAskUserQuestionStall would silently skip stream_end and recreate the
    // #4638 wedge. These tests pin the warn line so a regression is observable
    // in chroxy.log rather than only triageable from screenshots.

    let warnLines
    let logSpy

    beforeEach(() => {
      warnLines = []
      logSpy = (entry) => {
        if (entry.level === 'warn' && entry.component === 'claude-tui-session') {
          warnLines.push(entry.message)
        }
      }
      addLogListener(logSpy)
    })

    afterEach(() => {
      if (logSpy) removeLogListener(logSpy)
      logSpy = null
      warnLines = null
    })

    it('emits a warn when _isBusy=true and _currentMessageId is null', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._isBusy = true
      session._currentMessageId = null

      session._assertBusyHasMessageId('test-callsite')

      const violation = warnLines.find((m) => /invariant violation/.test(m))
      assert.ok(violation, `expected an invariant-violation warn, got warnLines=${JSON.stringify(warnLines)}`)
      // Pin the structured fields the warn carries — an operator greps for
      // these; a future refactor that drops the callsite tag or the
      // `_isBusy=true but _currentMessageId=null` phrasing should fail.
      assert.match(violation, /test-callsite/, 'warn includes callsite tag for greppability')
      assert.match(violation, /_isBusy=true/, 'warn names the busy flag')
      assert.match(violation, /_currentMessageId=null/, 'warn names the missing id')
      assert.match(violation, /#4638/, 'warn cross-references the wedge this prevents')
    })

    it('is a no-op when both _isBusy=true AND _currentMessageId are set (healthy state)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._isBusy = true
      session._currentMessageId = 'msg-healthy'

      session._assertBusyHasMessageId('test-callsite')

      const violation = warnLines.find((m) => /invariant violation/.test(m))
      assert.ok(!violation, `must NOT warn when invariant holds, got warnLines=${JSON.stringify(warnLines)}`)
    })

    it('is a no-op when _isBusy=false (idle session — invariant only applies mid-turn)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._isBusy = false
      session._currentMessageId = null

      session._assertBusyHasMessageId('test-callsite')

      const violation = warnLines.find((m) => /invariant violation/.test(m))
      assert.ok(!violation, `must NOT warn on idle session, got warnLines=${JSON.stringify(warnLines)}`)
    })

    it('fires from _finishTurnError when invariant is broken at that callsite', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session.on('error', () => {})  // swallow

      // Corrupt state: busy but no messageId. This is the contract violation
      // the assertion exists to surface — a future regression that sets one
      // without the other should fail this test.
      session._isBusy = true
      session._currentMessageId = null

      session._finishTurnError('synthetic error', null)

      const violation = warnLines.find((m) => /_finishTurnError/.test(m) && /invariant violation/.test(m))
      assert.ok(violation, `_finishTurnError must emit the invariant warn, got warnLines=${JSON.stringify(warnLines)}`)
    })

    it('fires from _handleHardTimeout when invariant is broken at that callsite', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session.on('error', () => {})  // swallow
      session._term = { write: () => {}, kill: () => {} }

      session._isBusy = true
      session._currentMessageId = null

      session._handleHardTimeout()

      const violation = warnLines.find((m) => /_handleHardTimeout/.test(m) && /invariant violation/.test(m))
      assert.ok(violation, `_handleHardTimeout must emit the invariant warn, got warnLines=${JSON.stringify(warnLines)}`)
    })

    it('fires from _handleStreamStall when invariant is broken at that callsite', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
      })
      session.on('error', () => {})  // swallow
      session._term = { write: () => {}, kill: () => {} }

      session._isBusy = true
      session._currentMessageId = null

      session._handleStreamStall()

      const violation = warnLines.find((m) => /_handleStreamStall/.test(m) && /invariant violation/.test(m))
      assert.ok(violation, `_handleStreamStall must emit the invariant warn, got warnLines=${JSON.stringify(warnLines)}`)
    })

    it('does NOT fire from teardown sites when invariant holds (healthy turn end)', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session.on('error', () => {})  // swallow
      session._term = { write: () => {}, kill: () => {} }

      // Healthy state: both set together as the contract requires.
      session._isBusy = true
      session._currentMessageId = 'msg-healthy'
      session._activeTurn = { messageId: 'msg-healthy', startedAt: Date.now(), aborted: false }

      session._finishTurnError('synthetic error', 'msg-healthy')

      const violation = warnLines.find((m) => /invariant violation/.test(m))
      assert.ok(!violation, `must NOT warn on healthy teardown, got warnLines=${JSON.stringify(warnLines)}`)
    })
  })
})

// #5334 (IP-6): the permission-mode sidecar is the IPC channel the
// PreToolUse hook `cat`s on every tool call. A plain writeFileSync
// truncates-then-writes, so a concurrent read can see an empty/partial value
// and fall through to the stale env var. Both writers (initial start + mid-
// session change) must go through the atomic tmp+rename helper.
describe('ClaudeTuiSession — atomic permission-mode sidecar write (#5334)', () => {
  let dir, skillsDir, fakeHome, origSpawnPty, session
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sidecar-atomic-'))
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-sidecar-skills-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-sidecar-home-'))
    writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
    process.env._ORIG_HOME = process.env.HOME
    process.env.HOME = fakeHome
    // Stub the PTY spawn so start() doesn't launch real node-pty/claude.
    origSpawnPty = ClaudeTuiSession.prototype._spawnPty
    ClaudeTuiSession.prototype._spawnPty = async function () {
      this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
    }
  })
  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    ClaudeTuiSession.prototype._spawnPty = origSpawnPty
    if (process.env._ORIG_HOME) { process.env.HOME = process.env._ORIG_HOME; delete process.env._ORIG_HOME }
    rmSync(dir, { recursive: true, force: true })
    rmSync(skillsDir, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  function makeSession() {
    return new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir, repoSkillsDir: null })
  }

  it('helper writes the value and leaves no .tmp file behind', () => {
    session = makeSession()
    const target = join(dir, 'permission-mode')
    session._writePermissionModeSidecarAtomic(target, 'plan')
    assert.equal(readFileSync(target, 'utf8'), 'plan')
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'no temp file should survive a successful write')
  })

  it('helper replaces an existing value cleanly (no torn intermediate left on disk)', () => {
    session = makeSession()
    const target = join(dir, 'permission-mode')
    writeFileSync(target, 'approve')
    session._writePermissionModeSidecarAtomic(target, 'acceptEdits')
    assert.equal(readFileSync(target, 'utf8'), 'acceptEdits')
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'no temp file should survive replacing an existing value')
  })

  it('helper rethrows and orphans no tmp file when the write fails (target dir missing)', () => {
    session = makeSession()
    // tmp + target both live under the missing subdir, so writeFileSync throws
    // ENOENT before renameSync is reached — the catch must still rethrow and
    // leave nothing behind in the (existing) parent dir.
    const target = join(dir, 'missing-subdir', 'permission-mode')
    assert.throws(() => session._writePermissionModeSidecarAtomic(target, 'plan'))
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'failed write must not orphan a tmp file')
  })

  it('_onPermissionModeChanged routes through the atomic helper', () => {
    session = makeSession()
    session._permissionModeFile = join(dir, 'permission-mode')
    const spy = mock.method(session, '_writePermissionModeSidecarAtomic')
    session._onPermissionModeChanged('plan')
    assert.equal(spy.mock.callCount(), 1, 'update path must use the atomic helper')
    assert.deepEqual(spy.mock.calls[0].arguments, [session._permissionModeFile, 'plan'])
  })

  it('the initial sidecar write at start() uses the atomic helper', async () => {
    session = makeSession()
    const spy = mock.method(session, '_writePermissionModeSidecarAtomic')
    await session.start()
    assert.ok(spy.mock.callCount() >= 1, 'initial sidecar write must use the atomic helper')
    assert.equal(spy.mock.calls[0].arguments[1], session.permissionMode || 'approve')
    assert.equal(session._permissionModeFile, join(session._sinkDir, 'permission-mode'))
  })
})

// #5329 (IP-1): the hook sink lives under /tmp; a tmpwatch sweep / tmpfs clear
// / manual rm can delete it mid-turn. The poll loop's readdir then fails and
// (pre-fix) returned silently, spinning to the hard timeout while claude's hook
// `cat > <sink>/…` writes also fail. _recoverSinkDir recreates the sink so hook
// delivery resumes, and fails loud if recreation itself fails.
describe('ClaudeTuiSession — hook-sink vanish recovery (#5329)', () => {
  let dir, skillsDir, session, warnLines, errorLines
  const logSpy = (entry) => {
    if (entry.component !== 'claude-tui-session') return
    if (entry.level === 'warn') warnLines.push(entry.message)
    if (entry.level === 'error') errorLines.push(entry.message)
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sink-recover-'))
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-sink-recover-skills-'))
    warnLines = []; errorLines = []
    addLogListener(logSpy)
  })
  afterEach(async () => {
    removeLogListener(logSpy)
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    rmSync(dir, { recursive: true, force: true })
    rmSync(skillsDir, { recursive: true, force: true })
  })
  function makeSession() {
    return new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir, repoSkillsDir: null })
  }

  it('recreates a vanished sink dir (+ owner.pid) and reports it', () => {
    session = makeSession()
    session._sinkDir = join(dir, 's-gone')
    // dir does not exist yet — simulates a tmpwatch sweep mid-turn
    const ok = session._recoverSinkDir(new Error('ENOENT: no such file or directory'))
    assert.equal(ok, true, 'sink is usable after recovery')
    assert.ok(existsSync(session._sinkDir), 'sink dir recreated')
    assert.equal(readFileSync(join(session._sinkDir, 'owner.pid'), 'utf8'), String(process.pid))
    assert.ok(warnLines.some((m) => /vanished mid-turn and was recreated/.test(m)), 'logs the recovery loudly')
  })

  it('restores the permission-mode sidecar so the hook reads the live mode', () => {
    session = makeSession()
    session._sinkDir = join(dir, 's-perm')
    session._permissionModeFile = join(session._sinkDir, 'permission-mode')
    session.permissionMode = 'plan'
    session._recoverSinkDir(new Error('ENOENT'))
    assert.equal(readFileSync(session._permissionModeFile, 'utf8'), 'plan',
      'sidecar rewritten with the current mode (not the stale env fallback)')
  })

  it('fails LOUD (error) and returns false when the sink cannot be recreated', () => {
    session = makeSession()
    // Parent is a FILE, so mkdirSync(recursive) cannot create a child dir.
    const filePath = join(dir, 'not-a-dir')
    writeFileSync(filePath, 'x')
    session._sinkDir = join(filePath, 's-blocked')
    const ok = session._recoverSinkDir(new Error('ENOENT'))
    assert.equal(ok, false, 'returns false when recovery is impossible')
    assert.ok(errorLines.some((m) => /could NOT be recreated/.test(m)), 'surfaces a loud error, not a silent spin')
  })

  it('throttles the can-not-recreate error to avoid 150ms poll-loop spam', () => {
    session = makeSession()
    const filePath = join(dir, 'not-a-dir-2')
    writeFileSync(filePath, 'x')
    session._sinkDir = join(filePath, 's-blocked')
    for (let i = 0; i < 5; i++) session._recoverSinkDir(new Error('ENOENT'))
    assert.equal(errorLines.length, 1, 'only one error logged across rapid repeated failures')
  })

  it('does not thrash recreation when the path is a directory but readdir failed transiently (warn throttled)', () => {
    session = makeSession()
    session._sinkDir = join(dir, 's-exists')
    mkdirSync(session._sinkDir, { recursive: true })
    for (let i = 0; i < 5; i++) {
      assert.equal(session._recoverSinkDir(new Error('EACCES: permission denied')), true)
    }
    const transient = warnLines.filter((m) => /readdir failed though .* is a directory/.test(m))
    assert.equal(transient.length, 1, 'transient warn is throttled to one across rapid repeats')
  })

  it('replaces a non-directory squatting the sink path (file/symlink) with a real dir', () => {
    session = makeSession()
    session._sinkDir = join(dir, 's-squatted')
    writeFileSync(session._sinkDir, 'not a dir') // a file occupies the sink path
    const ok = session._recoverSinkDir(new Error('ENOTDIR'))
    assert.equal(ok, true, 'a squatted path must be recoverable, not a permanent spin')
    assert.ok(statSync(session._sinkDir).isDirectory(), 'the squatter file is replaced by a directory')
    assert.equal(readFileSync(join(session._sinkDir, 'owner.pid'), 'utf8'), String(process.pid))
  })
})

// #5332 — turn-duration logging and watchdog poll-loop deadlines used to read
// the wall clock (Date.now()). A laptop sleep / NTP step that moves the wall
// clock backward made `Date.now() - startedAt` negative (bogus durations) and
// could make a `while (Date.now() - start < timeout)` poll-loop deadline never
// expire — a silent hang. These now read a monotonic clock (performance.now()),
// injectable here so the wall clock can be frozen/stepped to prove immunity.
describe('ClaudeTuiSession — monotonic watchdog clocks (#5332)', () => {
  let skillsDir, session
  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-mono-skills-'))
  })
  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    rmSync(skillsDir, { recursive: true, force: true })
  })

  it('honors an injected monotonicNow clock', () => {
    let mono = 1000
    session = new ClaudeTuiSession({
      cwd: '/tmp', skillsDir, repoSkillsDir: null,
      monotonicNow: () => mono,
    })
    assert.equal(session._nowMonotonic(), 1000, 'reads the injected clock')
    mono = 4200
    assert.equal(session._nowMonotonic(), 4200, 'advances with the injected clock')
  })

  it('truncates an injected fractional clock to integer ms (the documented invariant)', () => {
    // Copilot #5414: an injected monotonicNow could return fractional ms; the
    // seam truncates so every call site gets the integer-ms drop-in it expects.
    session = new ClaudeTuiSession({
      cwd: '/tmp', skillsDir, repoSkillsDir: null,
      monotonicNow: () => 1234.987,
    })
    assert.equal(session._nowMonotonic(), 1234, 'fractional injected clock is truncated')
    assert.ok(Number.isInteger(session._nowMonotonic()), 'always integer ms')
  })

  it('the default clock never regresses when the wall clock (Date.now) steps backward', (t) => {
    session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir, repoSkillsDir: null })
    const before = session._nowMonotonic()
    // Laptop sleep / NTP step: wall clock jumps an hour into the past.
    t.mock.method(Date, 'now', () => 0)
    const after = session._nowMonotonic()
    assert.ok(after >= before, `monotonic clock does not regress (before=${before} after=${after})`)
    assert.ok(Number.isInteger(after), 'integer ms — a drop-in for the Date.now() deltas the logs print')
  })

  it('stream-stall duration is the bounded monotonic turn age, not a wall-clock delta', async () => {
    // Fixed monotonic clock at 10_000; turn started 100 monotonic-ms ago.
    const mono = 10_000
    session = new ClaudeTuiSession({
      cwd: '/tmp', skillsDir, repoSkillsDir: null,
      resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 25,
      monotonicNow: () => mono,
    })
    session._isBusy = true
    session._currentMessageId = 'msg-mono-stall'
    const TURN_AGE_MS = 100
    session._activeTurn = { startedAt: mono - TURN_AGE_MS, aborted: false }
    session._term = { write: () => {}, kill: () => {} }
    const results = []
    session.on('result', (e) => results.push(e))
    session.on('error', () => {})

    session._armResultTimeout()
    await new Promise((r) => setTimeout(r, 80))

    const result = results.find(Boolean)
    assert.ok(result, 'stall watchdog fired and emitted a result')
    // The fix discriminator: a wall-clock `Date.now() - startedAt` (startedAt
    // ≈ 9900) would be ~1.7e12. The monotonic delta is exactly the turn age.
    assert.ok(result.duration >= TURN_AGE_MS && result.duration < 60_000,
      `duration is the bounded monotonic turn age (got ${result.duration})`)
  })

  it('the _waitForPrompt deadline loop terminates via the monotonic clock even with the wall clock frozen (no hang)', async (t) => {
    // Monotonic clock advances 1s per read, so the 50ms deadline trips on the
    // first while-check. Pre-fix the loop read Date.now(); with the wall clock
    // frozen below it would spin on `while (0 - 0 < 50)` forever — a hang.
    let mono = 0
    session = new ClaudeTuiSession({
      cwd: '/tmp', skillsDir, repoSkillsDir: null,
      monotonicNow: () => { mono += 1000; return mono },
    })
    // Valid-looking pid with no session file → readSessionStatus stays null →
    // never "ready", so only the deadline can end the loop.
    session._term = { pid: 2 ** 30, write: () => {}, kill: () => {} }
    t.mock.method(Date, 'now', () => 0) // wall clock frozen in the past
    const ready = await Promise.race([
      session._waitForPrompt(50),
      new Promise((res) => setTimeout(() => res('HANG'), 2000)),
    ])
    assert.equal(ready, false, 'loop exits not-ready via the monotonic deadline (did not hang on the frozen wall clock)')
  })

  describe('_buildPtyEnv secret stripping (#6311)', () => {
    let envSkillsDir
    let envSession

    beforeEach(() => {
      envSkillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-env-'))
    })

    afterEach(async () => {
      if (envSession) {
        try { await envSession.destroy() } catch { /* ignore */ }
        envSession = null
      }
      if (envSkillsDir) rmSync(envSkillsDir, { recursive: true, force: true })
      envSkillsDir = null
    })

    it('strips the primary API_TOKEN from the spawned TUI env', () => {
      const prev = process.env.API_TOKEN
      process.env.API_TOKEN = 'primary-bearer-token'
      try {
        envSession = new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir: envSkillsDir, repoSkillsDir: null })
        const env = envSession._buildPtyEnv(true)
        assert.equal(env.API_TOKEN, undefined,
          'the full-authority primary API_TOKEN must never reach a tool/MCP/subagent the TUI runs')
      } finally {
        if (prev === undefined) delete process.env.API_TOKEN
        else process.env.API_TOKEN = prev
      }
    })

    it('still strips ANTHROPIC_API_KEY (OAuth-only invariant preserved)', () => {
      const prev = process.env.ANTHROPIC_API_KEY
      process.env.ANTHROPIC_API_KEY = 'sk-ant-leak'
      try {
        envSession = new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir: envSkillsDir, repoSkillsDir: null })
        const env = envSession._buildPtyEnv(true)
        assert.equal(env.ANTHROPIC_API_KEY, undefined,
          'ANTHROPIC_API_KEY stays stripped so the TUI keeps using OAuth/subscription auth')
      } finally {
        if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
        else process.env.ANTHROPIC_API_KEY = prev
      }
    })

    it('passes the scoped CHROXY_HOOK_SECRET when permissions are enabled', () => {
      envSession = new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir: envSkillsDir, repoSkillsDir: null })
      const env = envSession._buildPtyEnv(true)
      assert.equal(env.CHROXY_HOOK_SECRET, envSession._hookSecret,
        'the per-session hook secret is the only chroxy secret the child legitimately needs')
      assert.equal(env.TERM, 'xterm-256color')
    })

    it('forwards non-secret operator env (denylist semantics preserved)', () => {
      const prev = process.env.CHROXY_TUI_ENV_PASSTHROUGH
      process.env.CHROXY_TUI_ENV_PASSTHROUGH = 'visible-to-tools'
      try {
        envSession = new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir: envSkillsDir, repoSkillsDir: null })
        const env = envSession._buildPtyEnv(false)
        assert.equal(env.CHROXY_TUI_ENV_PASSTHROUGH, 'visible-to-tools',
          'the TUI still inherits the full operator shell env minus secrets')
      } finally {
        if (prev === undefined) delete process.env.CHROXY_TUI_ENV_PASSTHROUGH
        else process.env.CHROXY_TUI_ENV_PASSTHROUGH = prev
      }
    })
  })
})
