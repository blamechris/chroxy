import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BaseSession,
  DEFAULT_RESULT_TIMEOUT_MS,
  DEFAULT_HARD_TIMEOUT_MS,
  DEFAULT_STREAM_STALL_TIMEOUT_MS,
  BACKGROUND_SHELL_HARD_QUIESCE_MS,
  BASE_SESSION_OPT_KEYS,
  buildBaseSessionOpts,
} from '../src/base-session.js'
import { SkillsTrustStore, sha256Hex } from '../src/skills-trust.js'

describe('BaseSession', () => {
  let session
  let emptySkillsDir

  beforeEach(() => {
    // Pin skillsDir + repoSkillsDir to empty temp dirs so the tests don't
    // pick up whatever lives in the developer's real ~/.chroxy/skills/ (#3067).
    // cwd: '/tmp' is also passed repoSkillsDir: null to bypass walk-up.
    emptySkillsDir = mkdtempSync(join(tmpdir(), 'chroxy-base-skills-'))
    session = new BaseSession({
      cwd: '/tmp',
      model: 'test-model',
      permissionMode: 'approve',
      skillsDir: emptySkillsDir,
      repoSkillsDir: null,
    })
  })

  afterEach(() => {
    if (emptySkillsDir) rmSync(emptySkillsDir, { recursive: true, force: true })
    emptySkillsDir = null
  })

  describe('constructor defaults', () => {
    it('sets cwd, model, permissionMode from options', () => {
      assert.equal(session.cwd, '/tmp')
      assert.equal(session.model, 'test-model')
      assert.equal(session.permissionMode, 'approve')
    })

    it('defaults cwd to process.cwd()', () => {
      const s = new BaseSession()
      assert.equal(s.cwd, process.cwd())
    })

    it('initializes state flags', () => {
      assert.equal(session._isBusy, false)
      assert.equal(session._processReady, false)
      assert.equal(session._messageCounter, 0)
      assert.equal(session._currentMessageId, null)
      assert.equal(session._destroying, false)
      assert.equal(session._activeAgents.size, 0)
      assert.equal(session._resultTimeout, null)
    })

    it('generates a 6-hex-char _messageIdPrefix per session (#3700)', () => {
      assert.match(session._messageIdPrefix, /^[0-9a-f]{6}$/, 'matches 6-hex format')
    })

    // #5288 / #5304: the configurable hard-quiesce opt must land in the field,
    // with the constant as default and an explicit 0 preserved (?? not ||).
    it('backgroundShellHardQuiesceMs: defaults to the constant when unset (#5288)', () => {
      const s = new BaseSession()
      assert.equal(s._backgroundShellHardQuiesceMs, BACKGROUND_SHELL_HARD_QUIESCE_MS)
    })

    it('backgroundShellHardQuiesceMs: explicit 0 disables (preserved, not defaulted) (#5288)', () => {
      const s = new BaseSession({ backgroundShellHardQuiesceMs: 0 })
      assert.equal(s._backgroundShellHardQuiesceMs, 0)
    })

    it('backgroundShellHardQuiesceMs: a positive value is applied verbatim (#5288)', () => {
      const s = new BaseSession({ backgroundShellHardQuiesceMs: 6 * 60 * 60 * 1000 })
      assert.equal(s._backgroundShellHardQuiesceMs, 6 * 60 * 60 * 1000)
    })

    it('each new BaseSession draws an independent _messageIdPrefix (#3700)', () => {
      // Each instance MUST call randomBytes(3) at construction so prefixes
      // are independent across server boots. Asserting strict uniqueness
      // would be probabilistic (16⁶ collision space — a 20-instance set
      // has ~1.2e-5 collision odds, low but non-zero — flaky in CI). Test
      // the deterministic invariant instead: every instance has the right
      // format and 20 instances produce >= 18 distinct values (the lower
      // bound passes for any reasonable RNG without ever flaking on a
      // legitimate collision).
      const prefixes = new Set()
      for (let i = 0; i < 20; i++) {
        const p = new BaseSession({ cwd: '/tmp', model: 't', permissionMode: 'approve' })._messageIdPrefix
        assert.match(p, /^[0-9a-f]{6}$/, `instance ${i} has well-formed prefix`)
        prefixes.add(p)
      }
      assert.ok(prefixes.size >= 18, `>= 18 distinct of 20 (got ${prefixes.size})`)
    })
  })

  describe('isRunning', () => {
    it('returns _isBusy', () => {
      assert.equal(session.isRunning, false)
      session._isBusy = true
      assert.equal(session.isRunning, true)
    })
  })

  describe('isReady', () => {
    it('returns true only when process is ready and not busy', () => {
      assert.equal(session.isReady, false)
      session._processReady = true
      assert.equal(session.isReady, true)
      session._isBusy = true
      assert.equal(session.isReady, false)
    })
  })

  describe('intentional-stop flag (#5375 — hoisted from the 3 providers)', () => {
    it('initializes disarmed', () => {
      assert.equal(new BaseSession()._intentionalStop, false)
    })

    it('markIntentionalStop arms it', () => {
      const s = new BaseSession()
      s.markIntentionalStop()
      assert.equal(s._intentionalStop, true)
    })

    it('_consumeIntentionalStop captures-and-clears in one step', () => {
      const s = new BaseSession()
      s.markIntentionalStop()
      // First consume returns the armed state AND disarms.
      assert.equal(s._consumeIntentionalStop(), true)
      assert.equal(s._intentionalStop, false)
      // Second consume sees the cleared state — the next natural exit is not
      // misread as a user stop.
      assert.equal(s._consumeIntentionalStop(), false)
    })

    it('_clearIntentionalStop disarms without reading (kept separate from consume so SDK catch-then-finally stays two-step)', () => {
      const s = new BaseSession()
      s.markIntentionalStop()
      s._clearIntentionalStop()
      assert.equal(s._intentionalStop, false)
      // Idempotent — a finally safety-net after the catch already consumed it.
      s._clearIntentionalStop()
      assert.equal(s._intentionalStop, false)
    })
  })

  describe('setModel', () => {
    it('returns false when busy', () => {
      session._isBusy = true
      assert.equal(session.setModel('new-model'), false)
    })

    it('returns false when model unchanged', () => {
      session.model = null
      assert.equal(session.setModel(null), false)
    })

    it('returns true and updates model when changed', () => {
      session.model = null
      const result = session.setModel('claude-sonnet-4-5-20250514')
      assert.equal(result, true)
      assert.equal(session.model, 'claude-sonnet-4-5-20250514')
    })
  })

  describe('setter hooks (#5374)', () => {
    it('setModel fires _onModelChanged once with the resolved model, only when it changes', () => {
      const s = new BaseSession()
      const calls = []
      s._onModelChanged = (m) => calls.push(m)
      s.model = null
      assert.equal(s.setModel('claude-sonnet-4-5-20250514'), true)
      assert.deepEqual(calls, [s.model], 'hook fired once with the resolved model')
      // No-op set (same model) must NOT fire the hook.
      assert.equal(s.setModel('claude-sonnet-4-5-20250514'), false)
      assert.equal(calls.length, 1, 'hook not fired on a no-op set')
      // Busy guard rejects → hook not fired.
      s._isBusy = true
      assert.equal(s.setModel('claude-opus-4-1-20250805'), false)
      assert.equal(calls.length, 1, 'hook not fired when busy guard rejects')
    })

    it('setPermissionMode fires _onPermissionModeChanged once with the mode, only when it changes', () => {
      const s = new BaseSession()
      const calls = []
      s._onPermissionModeChanged = (m) => calls.push(m)
      s.permissionMode = 'approve'
      assert.equal(s.setPermissionMode('plan'), true)
      assert.deepEqual(calls, ['plan'], 'hook fired once with the new mode')
      // Invalid mode rejected → hook not fired.
      assert.equal(s.setPermissionMode('bogus'), false)
      // No-op (same mode) → hook not fired.
      assert.equal(s.setPermissionMode('plan'), false)
      assert.equal(calls.length, 1, 'hook only fired on the real change')
    })
  })

  // #3185: per-session promptEvaluator toggle. Default is `false` so the
  // auto-evaluator chain (sub-tasks of #3068) is opt-in per session — the
  // manual `evaluate_draft` flow (PR #3089) is the existing behaviour and
  // continues to work regardless of this flag. Tests cover construction,
  // setter behaviour, and rejection of non-boolean inputs.
  describe('promptEvaluator (#3185)', () => {
    it('defaults to false when omitted from constructor opts', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: emptySkillsDir,
        repoSkillsDir: null,
      })
      assert.equal(s.promptEvaluator, false)
    })

    it('coerces truthy / falsy constructor values to a strict boolean', () => {
      const a = new BaseSession({ promptEvaluator: true, skillsDir: emptySkillsDir, repoSkillsDir: null })
      const b = new BaseSession({ promptEvaluator: false, skillsDir: emptySkillsDir, repoSkillsDir: null })
      const c = new BaseSession({ promptEvaluator: 1, skillsDir: emptySkillsDir, repoSkillsDir: null })
      const d = new BaseSession({ promptEvaluator: undefined, skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(a.promptEvaluator, true)
      assert.equal(b.promptEvaluator, false)
      // Strict boolean — truthy non-bools coerce, but the field is always
      // typeof 'boolean' so dashboard code can rely on JSON.stringify
      // emitting `true`/`false` rather than `1`/`null`.
      assert.equal(c.promptEvaluator, true)
      assert.equal(typeof c.promptEvaluator, 'boolean')
      assert.equal(d.promptEvaluator, false)
    })

    describe('setPromptEvaluator', () => {
      it('accepts boolean true and updates state', () => {
        assert.equal(session.promptEvaluator, false)
        const result = session.setPromptEvaluator(true)
        assert.equal(result, true)
        assert.equal(session.promptEvaluator, true)
      })

      it('accepts boolean false and updates state', () => {
        session.promptEvaluator = true
        const result = session.setPromptEvaluator(false)
        assert.equal(result, true)
        assert.equal(session.promptEvaluator, false)
      })

      it('returns false when value is unchanged (idempotent no-op)', () => {
        assert.equal(session.promptEvaluator, false)
        // Already false — setter reports "no change" so the session manager
        // can skip a state-file write on a redundant toggle.
        assert.equal(session.setPromptEvaluator(false), false)
      })

      it('rejects non-boolean inputs without mutating state', () => {
        // Strings, numbers, objects all fail-closed — defends against a
        // malformed WS payload that would otherwise flip the flag to a
        // truthy value the server can't reason about.
        for (const bad of ['true', 1, 0, null, undefined, {}, []]) {
          assert.equal(session.setPromptEvaluator(bad), false, `expected setPromptEvaluator(${JSON.stringify(bad)}) to return false`)
          assert.equal(session.promptEvaluator, false)
        }
      })
    })
  })

  // #3639: per-session promptEvaluatorSkipPattern. Mirrors the #3185
  // toggle's strict-validation pattern — the setter accepts a string
  // (compiled & verified as a real regex) or null/empty (clear), and
  // returns true when state changed so the WS handler knows whether
  // to broadcast.
  describe('promptEvaluatorSkipPattern (#3639)', () => {
    it('defaults to null when omitted from constructor opts', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: emptySkillsDir,
        repoSkillsDir: null,
      })
      assert.equal(s.promptEvaluatorSkipPattern, null)
    })

    it('accepts a valid regex source from the constructor', () => {
      const s = new BaseSession({
        promptEvaluatorSkipPattern: '^lgtm$',
        skillsDir: emptySkillsDir,
        repoSkillsDir: null,
      })
      assert.equal(s.promptEvaluatorSkipPattern, '^lgtm$')
    })

    it('rejects a malformed regex source from the constructor (falls back to null)', () => {
      // Constructor must not throw on bad input — sessions might be
      // restored from a state file that contains an invalid pattern
      // (operator hand-edit, schema drift). Defaulting to null preserves
      // session creation; the runtime setter is where invalid input
      // surfaces an error to the operator.
      const s = new BaseSession({
        promptEvaluatorSkipPattern: '[unclosed',
        skillsDir: emptySkillsDir,
        repoSkillsDir: null,
      })
      assert.equal(s.promptEvaluatorSkipPattern, null)
    })

    describe('setPromptEvaluatorSkipPattern', () => {
      it('accepts a valid regex source and updates state', () => {
        assert.equal(session.promptEvaluatorSkipPattern, null)
        const result = session.setPromptEvaluatorSkipPattern('^ack$')
        assert.equal(result, true)
        assert.equal(session.promptEvaluatorSkipPattern, '^ack$')
      })

      it('clears when value is empty string', () => {
        session.promptEvaluatorSkipPattern = '^old$'
        const result = session.setPromptEvaluatorSkipPattern('')
        assert.equal(result, true)
        assert.equal(session.promptEvaluatorSkipPattern, null)
      })

      it('clears when value is null', () => {
        session.promptEvaluatorSkipPattern = '^old$'
        const result = session.setPromptEvaluatorSkipPattern(null)
        assert.equal(result, true)
        assert.equal(session.promptEvaluatorSkipPattern, null)
      })

      it('returns false when value is unchanged (idempotent no-op)', () => {
        assert.equal(session.setPromptEvaluatorSkipPattern(null), false)
        session.promptEvaluatorSkipPattern = '^same$'
        assert.equal(session.setPromptEvaluatorSkipPattern('^same$'), false)
      })

      it('rejects non-string non-null inputs without mutating state', () => {
        for (const bad of [42, true, false, {}, []]) {
          assert.equal(session.setPromptEvaluatorSkipPattern(bad), false,
            `expected setPromptEvaluatorSkipPattern(${JSON.stringify(bad)}) to return false`)
          assert.equal(session.promptEvaluatorSkipPattern, null)
        }
      })

      it('rejects malformed regex source without mutating state', () => {
        // Returning false (not throwing) lets the WS handler decide how
        // to surface the error — same pattern setPromptEvaluator uses
        // for non-boolean rejection.
        const result = session.setPromptEvaluatorSkipPattern('[unclosed')
        assert.equal(result, false)
        assert.equal(session.promptEvaluatorSkipPattern, null)
      })
    })
  })

  // #3209: runtime activate/deactivate of manual skills. The WS layer
  // (skill_activate / skill_deactivate handlers) calls these and uses
  // the boolean return to decide whether to broadcast.
  describe('activateSkill / deactivateSkill (#3209)', () => {
    let dir
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-base-session-3209-'))
      // One auto skill (always loaded), two manual ones (off by default).
      writeFileSync(join(dir, 'auto-skill.md'), '# Auto\n\nalways on\n')
      writeFileSync(join(dir, 'manual-a.md'), '---\nactivation: manual\n---\n\nmanual A body\n')
      writeFileSync(join(dir, 'manual-b.md'), '---\nactivation: manual\n---\n\nmanual B body\n')
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('only auto skills load by default; manual ones stay off', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: dir,
        repoSkillsDir: null,
      })
      const names = s._getSkills().map((sk) => sk.name).sort()
      assert.deepEqual(names, ['auto-skill'])
    })

    it('activateSkill flips a manual skill on and reloads the prompt context', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: dir,
        repoSkillsDir: null,
      })
      const before = s._buildSystemPrompt()
      assert.ok(!before.includes('manual A body'), 'manual skill must not be in prompt before activation')

      const changed = s.activateSkill('manual-a')
      assert.equal(changed, true)
      assert.deepEqual(s.getActiveManualSkills(), ['manual-a'])
      const after = s._buildSystemPrompt()
      assert.ok(after.includes('manual A body'), 'manual skill must be in prompt after activation')
    })

    it('activateSkill is idempotent — second call returns false, no reload churn', () => {
      const s = new BaseSession({ cwd: '/tmp', skillsDir: dir, repoSkillsDir: null })
      assert.equal(s.activateSkill('manual-a'), true)
      assert.equal(s.activateSkill('manual-a'), false, 'second call returns false')
      assert.deepEqual(s.getActiveManualSkills(), ['manual-a'])
    })

    it('deactivateSkill flips a manual skill off and reloads', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: dir,
        repoSkillsDir: null,
        activeManualSkills: ['manual-a'],
      })
      assert.ok(s._buildSystemPrompt().includes('manual A body'))

      const changed = s.deactivateSkill('manual-a')
      assert.equal(changed, true)
      assert.deepEqual(s.getActiveManualSkills(), [])
      assert.ok(!s._buildSystemPrompt().includes('manual A body'),
        'manual skill must be removed from prompt after deactivation')
    })

    it('deactivateSkill is idempotent on a not-currently-active name', () => {
      const s = new BaseSession({ cwd: '/tmp', skillsDir: dir, repoSkillsDir: null })
      assert.equal(s.deactivateSkill('manual-a'), false)
      assert.deepEqual(s.getActiveManualSkills(), [])
    })

    it('rejects empty / non-string names without mutating state', () => {
      const s = new BaseSession({ cwd: '/tmp', skillsDir: dir, repoSkillsDir: null })
      for (const bad of ['', null, undefined, 42, {}, []]) {
        assert.equal(s.activateSkill(bad), false)
        assert.equal(s.deactivateSkill(bad), false)
      }
      assert.deepEqual(s.getActiveManualSkills(), [])
    })

    // #3246: activateSkill must verify the name corresponds to a real
    // `activation: manual` skill on disk. Without this guard, typos
    // would land in `_activeManualSkills` permanently, the loader
    // would silently drop them, and the dashboard checkbox would
    // falsely report success while the model never sees the change.
    it('rejects unknown skill names without mutating state', () => {
      const s = new BaseSession({ cwd: '/tmp', skillsDir: dir, repoSkillsDir: null })
      assert.equal(s.activateSkill('does-not-exist'), false)
      assert.deepEqual(s.getActiveManualSkills(), [])
    })

    it('rejects auto-skill names (only manual ones can be toggled)', () => {
      const s = new BaseSession({ cwd: '/tmp', skillsDir: dir, repoSkillsDir: null })
      // 'auto-skill' exists but is not `activation: manual` — toggling
      // it makes no sense (it's always loaded).
      assert.equal(s.activateSkill('auto-skill'), false)
      assert.deepEqual(s.getActiveManualSkills(), [])
    })

    // #3209/#3246: the runtime-toggle capability defaults to false at
    // BaseSession; only providers that rebuild the system prompt each
    // turn (SdkSession) override to true. Other providers' WS
    // handlers reject the toggle with `SKILL_TOGGLE_UNSUPPORTED`.
    it('supportsRuntimeSkillToggle defaults to false on BaseSession', () => {
      const s = new BaseSession({ cwd: '/tmp', skillsDir: dir, repoSkillsDir: null })
      assert.equal(s.supportsRuntimeSkillToggle(), false)
    })

    // #3253: a layered scan is exactly one `_loadSkills()` call —
    // that's the method that invokes loadActiveSkillsLayered. After
    // the refactor, validation no longer scans (it reads the cached
    // `_manualSkillNames` populated by the most-recent `_loadSkills`).
    // #5376: the layered scan moved to SkillsManager.loadSkills — activate /
    // deactivate now call it on the manager, not via session._loadSkills — so
    // spy there to count the real scans.
    function countScans(s) {
      const counts = { load: 0 }
      const mgr = s._skillsManager
      const origLoad = mgr.loadSkills.bind(mgr)
      mgr.loadSkills = function loadSpy(...args) {
        counts.load++
        return origLoad(...args)
      }
      return counts
    }

    it('activateSkill performs exactly one full layered scan in the success path (#3253)', () => {
      const s = new BaseSession({ cwd: '/tmp', skillsDir: dir, repoSkillsDir: null })
      const counts = countScans(s)

      const ok = s.activateSkill('manual-a')
      assert.equal(ok, true)
      assert.equal(counts.load, 1,
        `expected exactly one _loadSkills call on success — got ${counts.load} (was 2 before #3253: list + reload)`)
    })

    // #3253: deactivateSkill is symmetric — already a single scan
    // pre-fix (no validation step), but we lock that in with a regression
    // guard so a future "add validation symmetry" refactor doesn't
    // regress to two scans.
    it('deactivateSkill performs exactly one full layered scan (#3253)', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: dir,
        repoSkillsDir: null,
        activeManualSkills: ['manual-a'],
      })
      const counts = countScans(s)

      const ok = s.deactivateSkill('manual-a')
      assert.equal(ok, true)
      assert.equal(counts.load, 1,
        `deactivateSkill must stay at one scan — got ${counts.load}`)
    })

    // #3253: invalid input (typo / auto-skill name) is the rare path.
    // The current implementation does ONE rollback scan after the
    // speculative add, so two _loadSkills calls total. This is
    // acceptable per the issue's "at most one in success path"
    // criterion — locked in here so a future "skip rollback" attempt
    // doesn't accidentally leave a bogus name in `_activeManualSkills`.
    it('activateSkill on a bogus name does not pollute the active set (#3253)', () => {
      const s = new BaseSession({ cwd: '/tmp', skillsDir: dir, repoSkillsDir: null })
      assert.equal(s.activateSkill('does-not-exist'), false)
      assert.deepEqual(s.getActiveManualSkills(), [])
      assert.equal(s.activateSkill('auto-skill'), false)
      assert.deepEqual(s.getActiveManualSkills(), [])
      // After a rejected activation, a real one still works — confirms
      // the rollback restored a clean state.
      assert.equal(s.activateSkill('manual-a'), true)
      assert.deepEqual(s.getActiveManualSkills(), ['manual-a'])
    })

    // #3248: mtime-keyed parse cache. activate/deactivate toggles
    // re-run _loadSkills() on every flip; without caching, every
    // file's body is re-read + re-parsed even when nothing on disk
    // changed. The cache stores the parsed result keyed by realpath
    // + mtime so toggles skip readFileSync / parseFrontmatter for
    // unchanged files.
    describe('skills parse cache (#3248)', () => {
      it('populates the parse cache at construction', () => {
        const s = new BaseSession({ cwd: '/tmp', skillsDir: dir, repoSkillsDir: null })
        assert.ok(s._skillsParseCache instanceof Map,
          '_skillsParseCache should be a Map')
        assert.ok(s._skillsParseCache.size >= 3,
          `expected at least 3 cached skills (auto, manual-a, manual-b) — got ${s._skillsParseCache.size}`)
        // Each cache entry should carry mtime + parsed body fields.
        for (const [path, entry] of s._skillsParseCache) {
          assert.equal(typeof entry.mtimeMs, 'number', `entry for ${path} missing mtimeMs`)
          assert.equal(typeof entry.body, 'string', `entry for ${path} missing body`)
          assert.ok('frontmatter' in entry, `entry for ${path} missing frontmatter`)
        }
      })

      it('invalidates cache when file mtime changes', () => {
        const s = new BaseSession({ cwd: '/tmp', skillsDir: dir, repoSkillsDir: null })

        // Bump mtime AHEAD by 5s to defeat any sub-second filesystem
        // mtime resolution. statSync.mtimeMs is in milliseconds, so
        // this is unambiguous across HFS+/APFS/ext4.
        const target = join(dir, 'manual-a.md')
        // Mutate body first so the new content is on disk.
        writeFileSync(target, '---\nactivation: manual\n---\n\nupdated A body\n')
        const future = new Date(Date.now() + 5000)
        utimesSync(target, future, future)

        const ok = s.activateSkill('manual-a')
        assert.equal(ok, true)
        const prompt = s._buildSystemPrompt()
        assert.ok(prompt.includes('updated A body'),
          'cache must invalidate on mtime change so the new body is in the prompt')
      })

      // #3248 acceptance criterion 4: 100-skill toggle should
      // complete in <10ms. Measures the cached toggle path — first
      // toggle warms, second toggle is the steady-state target.
      // Loose threshold (50ms) for CI variance — the goal is to
      // catch order-of-magnitude regressions, not micro-benchmark.
      it('100-skill toggle stays well under regression threshold', () => {
        const big = mkdtempSync(join(tmpdir(), 'chroxy-3248-big-'))
        try {
          // Create 100 manual skills (off by default).
          for (let i = 0; i < 100; i++) {
            writeFileSync(
              join(big, `manual-${i}.md`),
              `---\nactivation: manual\n---\n\nSkill ${i} body content for benchmarking.\n`,
            )
          }
          const s = new BaseSession({ cwd: '/tmp', skillsDir: big, repoSkillsDir: null })
          // Warm: first activate populates the cache for any
          // file the constructor scan didn't see (in this setup
          // they're all seen, so the warm-up just exercises the
          // hot path once).
          s.activateSkill('manual-0')
          s.deactivateSkill('manual-0')

          const start = process.hrtime.bigint()
          s.activateSkill('manual-50')
          s.deactivateSkill('manual-50')
          const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000

          assert.ok(elapsedMs < 50,
            `100-skill toggle took ${elapsedMs.toFixed(2)}ms — expected <50ms with cache (issue target: <10ms)`)
        } finally {
          rmSync(big, { recursive: true, force: true })
        }
      })

      it('still records trust hashes correctly when cache is hot', () => {
        const trustDir = mkdtempSync(join(tmpdir(), 'chroxy-3248-trust-'))
        try {
          const trustStore = new SkillsTrustStore({
            filePath: join(trustDir, 'trust.json'),
            mode: 'warn',
          })
          const s = new BaseSession({
            cwd: '/tmp',
            skillsDir: dir,
            repoSkillsDir: null,
            trustStore,
          })

          // Force a cache-hit path by toggling. Trust store should
          // still see verifications (hashes already recorded at
          // construction; subsequent calls are 'verified' not 'recorded').
          s.activateSkill('manual-a')
          s.deactivateSkill('manual-a')

          // Both manual files should be in the trust store after the
          // active toggle (manual-a was active for one cycle).
          const records = trustStore._records
          const recordedSkills = Object.keys(records)
          assert.ok(recordedSkills.length > 0, 'trust store should have recorded hashes')
          for (const path of recordedSkills) {
            assert.ok(records[path].sha256, 'each record must carry a sha256')
            assert.ok(records[path].firstSeen, 'each record must carry firstSeen')
          }
        } finally {
          rmSync(trustDir, { recursive: true, force: true })
        }
      })
    })

    it('multiple toggles compose — A, then B, then A off — all reflected in prompt', () => {
      const s = new BaseSession({ cwd: '/tmp', skillsDir: dir, repoSkillsDir: null })
      s.activateSkill('manual-a')
      s.activateSkill('manual-b')
      let prompt = s._buildSystemPrompt()
      assert.ok(prompt.includes('manual A body'))
      assert.ok(prompt.includes('manual B body'))

      s.deactivateSkill('manual-a')
      prompt = s._buildSystemPrompt()
      assert.ok(!prompt.includes('manual A body'))
      assert.ok(prompt.includes('manual B body'))

      assert.deepEqual(s.getActiveManualSkills(), ['manual-b'])
    })
  })

  // #3252 — public getters for trust store + active manual skills set.
  // The settings handler used to reach into `_trustStore` /
  // `_activeManualSkills` directly. If those internals ever move (e.g.
  // wrapped in a layered manager, hoisted into SessionManager) the
  // direct reach turns into a silent no-op without a type error.
  describe('public getters (#3252)', () => {
    it('getTrustStore returns the wired trust store instance', () => {
      const trustDir = mkdtempSync(join(tmpdir(), 'chroxy-3252-trust-'))
      try {
        const trustStore = new SkillsTrustStore({
          filePath: join(trustDir, 'trust.json'),
          mode: 'warn',
        })
        const s = new BaseSession({
          cwd: '/tmp',
          skillsDir: emptySkillsDir,
          repoSkillsDir: null,
          trustStore,
        })
        assert.equal(s.getTrustStore(), trustStore,
          'getTrustStore should return the same instance passed at construction')
      } finally {
        rmSync(trustDir, { recursive: true, force: true })
      }
    })

    it('getTrustStore returns null when no trust store is wired', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: emptySkillsDir,
        repoSkillsDir: null,
      })
      assert.equal(s.getTrustStore(), null,
        'getTrustStore returns null (not undefined) when trust is disabled')
    })

    it('getActiveManualSkillsRaw returns the underlying Set (not a copy)', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: emptySkillsDir,
        repoSkillsDir: null,
        activeManualSkills: ['preset-a'],
      })
      const raw = s.getActiveManualSkillsRaw()
      assert.ok(raw instanceof Set, 'getActiveManualSkillsRaw must return a Set')
      assert.ok(raw.has('preset-a'))
      // Same identity contract as the issue describes — callers can use
      // `.has()` cheaply without rebuilding from the array form.
      assert.equal(raw, s._activeManualSkills,
        'returns the same Set instance (read-only contract — mutate via activate/deactivateSkill)')
    })

    it('getActiveManualSkillsRaw stays empty Set when no preset skills', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: emptySkillsDir,
        repoSkillsDir: null,
      })
      const raw = s.getActiveManualSkillsRaw()
      assert.ok(raw instanceof Set)
      assert.equal(raw.size, 0)
    })
  })

  describe('setPermissionMode', () => {
    it('returns false for invalid modes', () => {
      assert.equal(session.setPermissionMode('invalid'), false)
    })

    it('rejects non-auto mode change when busy', () => {
      // #3729: only 'auto' is permitted to override the busy guard —
      // it's the panic-button that lets a user staring at a permission
      // prompt declare "approve everything" and have it actually take
      // effect. Other mode changes still defer until the turn settles.
      session._isBusy = true
      assert.equal(session.setPermissionMode('plan'), false)
      assert.equal(session.setPermissionMode('acceptEdits'), false)
    })

    it('allows auto mode change even when busy (panic button, #3729)', () => {
      session._isBusy = true
      session.permissionMode = 'approve'
      assert.equal(session.setPermissionMode('auto'), true)
      assert.equal(session.permissionMode, 'auto')
    })

    it('returns false when unchanged', () => {
      session.permissionMode = 'approve'
      assert.equal(session.setPermissionMode('approve'), false)
    })

    it('returns true and updates when changed', () => {
      assert.equal(session.setPermissionMode('auto'), true)
      assert.equal(session.permissionMode, 'auto')
    })

    it('accepts all valid modes', () => {
      for (const mode of ['approve', 'auto', 'plan', 'acceptEdits']) {
        session.permissionMode = 'other'
        assert.equal(session.setPermissionMode(mode), true)
      }
    })
  })

  describe('_clearMessageState', () => {
    it('resets busy and message state', () => {
      session._isBusy = true
      session._currentMessageId = 'msg-1'
      session._clearMessageState()
      assert.equal(session._isBusy, false)
      assert.equal(session._currentMessageId, null)
    })

    it('emits agent_completed for active agents', () => {
      const completed = []
      session.on('agent_completed', (e) => completed.push(e))
      session._activeAgents.set('a1', { toolUseId: 'a1' })
      session._activeAgents.set('a2', { toolUseId: 'a2' })
      session._clearMessageState()
      assert.equal(completed.length, 2)
      assert.deepEqual(completed.map(c => c.toolUseId), ['a1', 'a2'])
      assert.equal(session._activeAgents.size, 0)
    })

    it('clears result timeout', () => {
      session._resultTimeout = setTimeout(() => {}, 10000)
      session._clearMessageState()
      assert.equal(session._resultTimeout, null)
    })
  })

  describe('EventEmitter', () => {
    it('is an EventEmitter', () => {
      assert.equal(typeof session.on, 'function')
      assert.equal(typeof session.emit, 'function')
    })
  })

  describe('_buildSystemPrompt', () => {
    it('returns empty string when no skills are loaded', () => {
      session._skillsText = ''
      assert.equal(session._buildSystemPrompt(), '')
    })

    it('returns formatted skills text when skills are loaded', () => {
      session._skillsText = '# Skill: foo\n\nbody text'
      const out = session._buildSystemPrompt()
      assert.ok(out.includes('body text'))
    })
  })

  // #3805: opt-in Chroxy context hint. When enabled, a short paragraph
  // telling the model it's running inside Chroxy is prepended to the
  // system prompt so it can adjust output (narrower code blocks, no
  // wide ASCII diagrams) for mobile clients.
  describe('chroxyContextHint (#3805)', () => {
    it('defaults to false when omitted from constructor opts', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: emptySkillsDir,
        repoSkillsDir: null,
      })
      assert.equal(s.chroxyContextHint, false)
    })

    it('coerces truthy / falsy constructor values to a strict boolean', () => {
      const a = new BaseSession({ chroxyContextHint: true, skillsDir: emptySkillsDir, repoSkillsDir: null })
      const b = new BaseSession({ chroxyContextHint: false, skillsDir: emptySkillsDir, repoSkillsDir: null })
      const c = new BaseSession({ chroxyContextHint: 1, skillsDir: emptySkillsDir, repoSkillsDir: null })
      const d = new BaseSession({ chroxyContextHint: undefined, skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(a.chroxyContextHint, true)
      assert.equal(b.chroxyContextHint, false)
      assert.equal(c.chroxyContextHint, true)
      assert.equal(typeof c.chroxyContextHint, 'boolean')
      assert.equal(d.chroxyContextHint, false)
    })

    describe('_buildSystemPrompt with hint', () => {
      it('returns empty string when hint is OFF and no skills loaded (default OFF — byte-identical to pre-#3805)', () => {
        session._skillsText = ''
        assert.equal(session.chroxyContextHint, false)
        assert.equal(session._buildSystemPrompt(), '')
      })

      it('prepends the Chroxy hint paragraph when flag is ON and no skills loaded', () => {
        session._skillsText = ''
        session.chroxyContextHint = true
        const out = session._buildSystemPrompt()
        assert.ok(out.length > 0, 'hint paragraph is non-empty')
        assert.ok(/Chroxy/.test(out), `expected output to mention "Chroxy": ${out}`)
        assert.ok(/mobile/i.test(out), `expected hint to mention mobile context: ${out}`)
      })

      it('prepends hint BEFORE skills text when both are present (skills not overwritten)', () => {
        session._skillsText = '# Skill: foo\n\nbody text'
        session.chroxyContextHint = true
        const out = session._buildSystemPrompt()
        const hintIdx = out.indexOf('Chroxy')
        const skillsIdx = out.indexOf('body text')
        assert.ok(hintIdx >= 0, 'hint present')
        assert.ok(skillsIdx >= 0, 'skills text still present (not overwritten)')
        assert.ok(hintIdx < skillsIdx, `hint should precede skills text (hint at ${hintIdx}, skills at ${skillsIdx})`)
      })

      it('leaves skills text byte-identical when hint is OFF (no observable change for existing users)', () => {
        session._skillsText = '# Skill: foo\n\nbody text'
        // Compare with the existing pre-#3805 behaviour: skills text only.
        const out = session._buildSystemPrompt()
        assert.equal(out, '# Skill: foo\n\nbody text')
        assert.ok(!out.includes('Chroxy'), 'no Chroxy hint when flag is OFF')
      })
    })

    describe('setChroxyContextHint', () => {
      it('accepts boolean true and updates state', () => {
        assert.equal(session.chroxyContextHint, false)
        const result = session.setChroxyContextHint(true)
        assert.equal(result, true)
        assert.equal(session.chroxyContextHint, true)
      })

      it('accepts boolean false and updates state', () => {
        session.chroxyContextHint = true
        const result = session.setChroxyContextHint(false)
        assert.equal(result, true)
        assert.equal(session.chroxyContextHint, false)
      })

      it('returns false when value is unchanged (idempotent no-op)', () => {
        assert.equal(session.chroxyContextHint, false)
        assert.equal(session.setChroxyContextHint(false), false)
      })

      it('rejects non-boolean inputs without mutating state', () => {
        for (const bad of ['true', 1, 0, null, undefined, {}, []]) {
          assert.equal(session.setChroxyContextHint(bad), false, `expected setChroxyContextHint(${JSON.stringify(bad)}) to return false`)
          assert.equal(session.chroxyContextHint, false)
        }
      })
    })
  })

  // #4660: per-session user-authored preamble. Free-text string prepended
  // to the system prompt every turn so the user can pre-load context
  // (style rules, stack notes, response format) without retyping it.
  describe('sessionPreamble (#4660)', () => {
    it('defaults to empty string when omitted from constructor opts', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: emptySkillsDir,
        repoSkillsDir: null,
      })
      assert.equal(s.sessionPreamble, '')
    })

    it('coerces non-string constructor values to empty string', () => {
      for (const bad of [123, true, null, undefined, {}, []]) {
        const s = new BaseSession({ sessionPreamble: bad, skillsDir: emptySkillsDir, repoSkillsDir: null })
        assert.equal(s.sessionPreamble, '', `expected non-string ${JSON.stringify(bad)} → ''`)
      }
    })

    it('trims whitespace on construction', () => {
      const s = new BaseSession({ sessionPreamble: '   hello world   ', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(s.sessionPreamble, 'hello world')
    })

    it('treats whitespace-only as empty string', () => {
      const s = new BaseSession({ sessionPreamble: '   \n\t  ', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(s.sessionPreamble, '')
    })

    it('caps over-length input at SESSION_PREAMBLE_MAX_LENGTH (4000 chars)', () => {
      const huge = 'x'.repeat(5000)
      const s = new BaseSession({ sessionPreamble: huge, skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(s.sessionPreamble.length, 4000)
    })

    describe('_buildSystemPrompt with preamble', () => {
      it('returns empty string when preamble is empty and hint is OFF (byte-identical to pre-#4660)', () => {
        session._skillsText = ''
        assert.equal(session.sessionPreamble, '')
        assert.equal(session.chroxyContextHint, false)
        assert.equal(session._buildSystemPrompt(), '')
      })

      it('returns just the preamble when set and hint is OFF and no skills', () => {
        session._skillsText = ''
        session.sessionPreamble = 'always use bullet points'
        assert.equal(session._buildSystemPrompt(), 'always use bullet points')
      })

      it('puts preamble BEFORE chroxy hint when both are present', () => {
        session._skillsText = ''
        session.sessionPreamble = 'always use bullet points'
        session.chroxyContextHint = true
        const out = session._buildSystemPrompt()
        const preIdx = out.indexOf('always use bullet points')
        const hintIdx = out.indexOf('Chroxy')
        assert.ok(preIdx >= 0 && hintIdx >= 0)
        assert.ok(preIdx < hintIdx, `preamble should precede chroxy hint (preamble at ${preIdx}, hint at ${hintIdx})`)
      })

      it('puts preamble BEFORE skills text when both are present (skills not overwritten)', () => {
        session._skillsText = '# Skill: foo\n\nbody text'
        session.sessionPreamble = 'always use bullet points'
        const out = session._buildSystemPrompt()
        const preIdx = out.indexOf('always use bullet points')
        const skillsIdx = out.indexOf('body text')
        assert.ok(preIdx >= 0 && skillsIdx >= 0)
        assert.ok(preIdx < skillsIdx)
      })

      it('full ordering — preamble, then hint, then skills', () => {
        session._skillsText = '# Skill: foo\n\nbody text'
        session.sessionPreamble = 'always use bullet points'
        session.chroxyContextHint = true
        const out = session._buildSystemPrompt()
        const preIdx = out.indexOf('always use bullet points')
        const hintIdx = out.indexOf('Chroxy')
        const skillsIdx = out.indexOf('body text')
        assert.ok(preIdx < hintIdx && hintIdx < skillsIdx,
          `expected preamble (${preIdx}) < hint (${hintIdx}) < skills (${skillsIdx})`)
      })

      it('byte-identical to pre-#4660 when preamble is empty (skills only)', () => {
        session._skillsText = '# Skill: foo\n\nbody text'
        const out = session._buildSystemPrompt()
        assert.equal(out, '# Skill: foo\n\nbody text')
      })

      it('joins multiple non-empty layers with double-newline', () => {
        session._skillsText = 'SKILL'
        session.sessionPreamble = 'PRE'
        session.chroxyContextHint = false
        assert.equal(session._buildSystemPrompt(), 'PRE\n\nSKILL')
      })
    })

    describe('setSessionPreamble', () => {
      it('accepts a string and updates state', () => {
        assert.equal(session.sessionPreamble, '')
        const result = session.setSessionPreamble('hello')
        assert.equal(result, true)
        assert.equal(session.sessionPreamble, 'hello')
      })

      it('accepts empty string to clear', () => {
        session.sessionPreamble = 'something'
        const result = session.setSessionPreamble('')
        assert.equal(result, true)
        assert.equal(session.sessionPreamble, '')
      })

      it('trims input on set', () => {
        const result = session.setSessionPreamble('   trimmed   ')
        assert.equal(result, true)
        assert.equal(session.sessionPreamble, 'trimmed')
      })

      it('returns false when the trimmed value is unchanged (idempotent no-op)', () => {
        session.sessionPreamble = 'hello'
        assert.equal(session.setSessionPreamble('hello'), false)
        assert.equal(session.setSessionPreamble('  hello  '), false, 'whitespace-only differences should not count as a change')
      })

      it('rejects non-string inputs without mutating state', () => {
        session.sessionPreamble = 'existing'
        for (const bad of [123, true, null, undefined, {}, []]) {
          assert.equal(session.setSessionPreamble(bad), false, `expected setSessionPreamble(${JSON.stringify(bad)}) to return false`)
          assert.equal(session.sessionPreamble, 'existing')
        }
      })

      it('caps over-length input at SESSION_PREAMBLE_MAX_LENGTH', () => {
        const huge = 'y'.repeat(5000)
        const result = session.setSessionPreamble(huge)
        assert.equal(result, true)
        assert.equal(session.sessionPreamble.length, 4000)
      })
    })
  })

  describe('_getSkills', () => {
    it('returns empty array by default (no skills loaded)', () => {
      assert.deepEqual(session._getSkills(), [])
    })

    it('returns cached skills when set', () => {
      // #5376: skills state lives on the manager; set it there (the session
      // exposes `_skills` as a read-through getter).
      session._skillsManager._skills = [{ name: 'a', body: 'x', description: 'x' }]
      const out = session._getSkills()
      assert.equal(out.length, 1)
      assert.equal(out[0].name, 'a')
    })
  })

  // -------------------------------------------------------------------------
  // Skills v2 frontmatter consumers (#3198, #3199, #3200) — wiring through
  // BaseSession's constructor into the loader.
  // -------------------------------------------------------------------------

  describe('provider gating (#3198)', () => {
    let skillsDir
    beforeEach(() => { skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-bs-prov-')) })
    afterEach(() => { rmSync(skillsDir, { recursive: true, force: true }) })

    it('provider id flows from constructor into the skills loader filter', () => {
      writeFileSync(join(skillsDir, 'codex-only.md'), '---\nname: codex-only\nproviders: [codex]\n---\nbody\n')
      writeFileSync(join(skillsDir, 'shared.md'), '# shared\n\nbody\n')

      const sdkSession = new BaseSession({
        cwd: '/tmp',
        provider: 'claude-sdk',
        skillsDir,
        repoSkillsDir: null,
      })
      assert.deepEqual(sdkSession._getSkills().map((s) => s.name), ['shared'])

      const codexSession = new BaseSession({
        cwd: '/tmp',
        provider: 'codex',
        skillsDir,
        repoSkillsDir: null,
      })
      assert.deepEqual(codexSession._getSkills().map((s) => s.name).sort(), ['codex-only', 'shared'])
    })
  })

  describe('manual activation (#3199)', () => {
    let skillsDir
    beforeEach(() => { skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-bs-act-')) })
    afterEach(() => { rmSync(skillsDir, { recursive: true, force: true }) })

    it('manual skills are off by default', () => {
      writeFileSync(join(skillsDir, 'manual.md'), '---\nname: manual\nactivation: manual\n---\nbody\n')
      writeFileSync(join(skillsDir, 'auto.md'), '# auto\n\nbody\n')

      const s = new BaseSession({ cwd: '/tmp', skillsDir, repoSkillsDir: null })
      assert.deepEqual(s._getSkills().map((sk) => sk.name), ['auto'])
    })

    it('activeManualSkills set in the constructor activates manual skills', () => {
      writeFileSync(join(skillsDir, 'manual.md'), '---\nname: manual\nactivation: manual\n---\nbody\n')

      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        activeManualSkills: new Set(['manual']),
      })
      assert.deepEqual(s._getSkills().map((sk) => sk.name), ['manual'])
    })

    it('activeManualSkills as an array is also accepted', () => {
      writeFileSync(join(skillsDir, 'manual.md'), '---\nname: manual\nactivation: manual\n---\nbody\n')

      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        activeManualSkills: ['manual'],
      })
      assert.deepEqual(s._getSkills().map((sk) => sk.name), ['manual'])
    })

    it('exposes an _activeManualSkills Set for the future toggle handler (#3209)', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        activeManualSkills: ['x', 'y'],
      })
      assert.ok(s._activeManualSkills instanceof Set)
      assert.ok(s._activeManualSkills.has('x'))
      assert.ok(s._activeManualSkills.has('y'))
    })
  })

  describe('per-skill injection (#3200)', () => {
    let skillsDir
    beforeEach(() => { skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-bs-inj-')) })
    afterEach(() => { rmSync(skillsDir, { recursive: true, force: true }) })

    it('claude-sdk session: append-mode skill goes to system prompt, prepend-mode skill goes to first user message', () => {
      writeFileSync(join(skillsDir, 'sys.md'), '---\nname: sys\ninjection: append\n---\nappend body\n')
      writeFileSync(join(skillsDir, 'pre.md'), '---\nname: pre\ninjection: prepend\n---\nprepend body\n')

      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'claude-sdk',
        skillsDir,
        repoSkillsDir: null,
      })

      const sys = s._buildSystemPrompt()
      const pre = s._buildPrependPrompt()

      assert.ok(sys.includes('append body'), 'append skill should be in the system prompt')
      assert.ok(!sys.includes('prepend body'), 'prepend skill should NOT be in the system prompt')
      assert.ok(pre.includes('prepend body'), 'prepend skill should be in the prepend bucket')
      assert.ok(!pre.includes('append body'), 'append skill should NOT be in the prepend bucket')
    })

    it('codex session: bare skills default to prepend (provider default)', () => {
      writeFileSync(join(skillsDir, 'a.md'), '# a\n\nbody\n')

      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'codex',
        skillsDir,
        repoSkillsDir: null,
      })

      assert.equal(s._buildSystemPrompt(), '', 'no skills in system bucket on codex by default')
      const pre = s._buildPrependPrompt()
      assert.ok(pre.length > 0)
      assert.ok(pre.includes('body'))
    })

    it('claude-sdk session: bare skills default to append (provider default)', () => {
      writeFileSync(join(skillsDir, 'a.md'), '# a\n\nbody\n')

      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'claude-sdk',
        skillsDir,
        repoSkillsDir: null,
      })

      assert.equal(s._buildPrependPrompt(), '', 'no skills in prepend bucket on claude-sdk by default')
      const sys = s._buildSystemPrompt()
      assert.ok(sys.length > 0)
      assert.ok(sys.includes('body'))
    })
  })

  // -----------------------------------------------------------------------
  // #3228: subprocess providers concat the prepend + append buckets into a
  // single user-message prefix. Each `_buildSystemPrompt()` /
  // `_buildPrependPrompt()` call returns text WITH the `# User skills`
  // header, so a naive concat produced two headers. The combined helper
  // renders the header exactly once.
  // -----------------------------------------------------------------------

  describe('_buildCombinedSkillsPrefix (#3228)', () => {
    let skillsDir
    beforeEach(() => { skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-bs-comb-')) })
    afterEach(() => { rmSync(skillsDir, { recursive: true, force: true }) })

    it('returns empty string when no skills are loaded', () => {
      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'codex',
        skillsDir,
        repoSkillsDir: null,
      })
      assert.equal(s._buildCombinedSkillsPrefix(), '')
    })

    it('emits exactly ONE `# User skills` header when both prepend and append buckets are populated', () => {
      // One skill in each bucket.
      writeFileSync(join(skillsDir, 'pre.md'), '---\nname: pre\ninjection: prepend\n---\nprepend body\n')
      writeFileSync(join(skillsDir, 'sys.md'), '---\nname: sys\ninjection: append\n---\nappend body\n')

      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'claude-sdk',
        skillsDir,
        repoSkillsDir: null,
      })

      const combined = s._buildCombinedSkillsPrefix()
      const headerCount = (combined.match(/# User skills/g) || []).length
      assert.equal(headerCount, 1,
        `expected exactly one '# User skills' header, found ${headerCount}\n---\n${combined}`)
      // Both bodies should be present.
      assert.ok(combined.includes('prepend body'), 'prepend skill body must be present')
      assert.ok(combined.includes('append body'), 'append skill body must be present')
    })

    it('emits one header when only the prepend bucket is populated (codex default)', () => {
      writeFileSync(join(skillsDir, 'a.md'), '# a\n\nbody\n')
      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'codex',
        skillsDir,
        repoSkillsDir: null,
      })

      const combined = s._buildCombinedSkillsPrefix()
      const headerCount = (combined.match(/# User skills/g) || []).length
      assert.equal(headerCount, 1)
      assert.ok(combined.includes('body'))
    })

    it('emits one header when only the append bucket is populated', () => {
      writeFileSync(join(skillsDir, 'sys.md'), '---\nname: sys\ninjection: append\n---\nappend body\n')
      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'claude-sdk',
        skillsDir,
        repoSkillsDir: null,
      })

      const combined = s._buildCombinedSkillsPrefix()
      const headerCount = (combined.match(/# User skills/g) || []).length
      assert.equal(headerCount, 1)
      assert.ok(combined.includes('append body'))
    })

    // PR #3231 Copilot #3 / #4: the SKILLS_PROMPT_HEADER previously
    // ended with a single `\n`, so a naive concat with the first
    // `## Skill: …` section produced output where the preamble ran
    // straight into the heading without a blank-line separator. Pin
    // the visual separator so a future refactor doesn't regress it.
    it('separates the header from the first skill section with a blank line (#3231)', () => {
      writeFileSync(join(skillsDir, 'a.md'), '# a\n\nbody a\n')
      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'codex',
        skillsDir,
        repoSkillsDir: null,
      })

      const combined = s._buildCombinedSkillsPrefix()
      // The preamble line ends with the period after "task at hand."; a
      // blank line should precede the first `## Skill:` heading.
      assert.ok(
        /task at hand\.\n\n## Skill: /.test(combined),
        `expected blank line between header and first skill heading\n---\n${combined}`,
      )
    })
  })

  // -----------------------------------------------------------------------
  // #3207: per-provider skill allowlist threaded through the constructor.
  // The loader-level semantics are exhaustively covered in
  // skills-loader.test.js; these tests verify BaseSession actually
  // forwards the option to the layered loader rather than dropping it.
  // -----------------------------------------------------------------------

  describe('providerSkillAllowlist plumbing (#3207)', () => {
    let skillsDir
    beforeEach(() => { skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-bs-allow-')) })
    afterEach(() => { rmSync(skillsDir, { recursive: true, force: true }) })

    it('codex session with allowlist drops out-of-list skills', () => {
      writeFileSync(join(skillsDir, 'allowed.md'), 'allowed body')
      writeFileSync(join(skillsDir, 'denied.md'), 'denied body')
      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'codex',
        skillsDir,
        repoSkillsDir: null,
        providerSkillAllowlist: { codex: ['allowed'] },
      })
      const names = s._getSkills().map((sk) => sk.name)
      assert.deepEqual(names, ['allowed'])
    })

    it('codex session with no entry in allowlist drops everything (fail-secure)', () => {
      writeFileSync(join(skillsDir, 'a.md'), 'a body')
      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'codex',
        skillsDir,
        repoSkillsDir: null,
        providerSkillAllowlist: { gemini: ['a'] },
      })
      assert.deepEqual(s._getSkills(), [])
    })

    it('claude-sdk session ignores the allowlist (permissive)', () => {
      writeFileSync(join(skillsDir, 'a.md'), 'a body')
      writeFileSync(join(skillsDir, 'b.md'), 'b body')
      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'claude-sdk',
        skillsDir,
        repoSkillsDir: null,
        providerSkillAllowlist: { codex: [] },
      })
      assert.equal(s._getSkills().length, 2)
    })

    it('without providerSkillAllowlist option, every skill loads (back-compat)', () => {
      writeFileSync(join(skillsDir, 'a.md'), 'a body')
      writeFileSync(join(skillsDir, 'b.md'), 'b body')
      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'codex',
        skillsDir,
        repoSkillsDir: null,
      })
      assert.equal(s._getSkills().length, 2)
    })

    it('non-object providerSkillAllowlist (array) is silently ignored', () => {
      writeFileSync(join(skillsDir, 'a.md'), 'a body')
      const s = new BaseSession({
        cwd: '/tmp',
        provider: 'codex',
        skillsDir,
        repoSkillsDir: null,
        providerSkillAllowlist: ['a'], // wrong shape
      })
      assert.equal(s._getSkills().length, 1)
    })
  })

  // -----------------------------------------------------------------------
  // #3204: trust-store integration. We always pin a `trustStore` with a
  // temp file path so the developer's real ~/.chroxy/skills-trust.json is
  // never touched by these tests.
  // -----------------------------------------------------------------------

  describe('skill content-hash trust (#3204)', () => {
    let skillsDir
    let trustDir
    let trustPath

    beforeEach(() => {
      skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-bs-trust-skills-'))
      trustDir = mkdtempSync(join(tmpdir(), 'chroxy-bs-trust-store-'))
      trustPath = join(trustDir, 'trust.json')
    })

    afterEach(() => {
      rmSync(skillsDir, { recursive: true, force: true })
      rmSync(trustDir, { recursive: true, force: true })
    })

    function waitForNextTick() {
      return new Promise((resolve) => process.nextTick(resolve))
    }

    it('without trustStore + without trustMismatchMode: trust check is skipped (no file written)', () => {
      writeFileSync(join(skillsDir, 'a.md'), 'body')
      // Default constructor — no trust opts at all.
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
      })
      assert.equal(s._trustStore, null,
        'trust check should be opt-in: no store wired by default')
      assert.equal(s._getSkills().length, 1)
    })

    it('first activation records hashes for every loaded skill', () => {
      writeFileSync(join(skillsDir, 'a.md'), 'body a')
      writeFileSync(join(skillsDir, 'b.md'), 'body b')
      const trustStore = new SkillsTrustStore({ filePath: trustPath })

      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustStore,
      })
      assert.equal(s._getSkills().length, 2)

      // The store should have flushed inside the constructor.
      assert.ok(existsSync(trustPath), 'trust file should be persisted on first activation')
      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.equal(Object.keys(persisted).length, 2)
    })

    it('second activation with unchanged content fires no skill_changed event', async () => {
      writeFileSync(join(skillsDir, 'a.md'), 'unchanged')
      // First load — records the hash.
      new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustStore: new SkillsTrustStore({ filePath: trustPath }),
      })

      // Second load — listen for skill_changed.
      const events = []
      const s2 = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustStore: new SkillsTrustStore({ filePath: trustPath }),
      })
      s2.on('skill_changed', (info) => events.push(info))
      await waitForNextTick()
      assert.deepEqual(events, [])
      assert.equal(s2._getSkills().length, 1, 'unchanged skill loads as before')
    })

    it('changed content (warn mode) fires skill_changed with old + new hashes; skill still loads', async () => {
      writeFileSync(join(skillsDir, 'a.md'), 'original')
      new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustStore: new SkillsTrustStore({ filePath: trustPath }),
      })

      writeFileSync(join(skillsDir, 'a.md'), 'tampered')
      const s2 = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustStore: new SkillsTrustStore({ filePath: trustPath, mode: 'warn' }),
      })
      const events = []
      s2.on('skill_changed', (info) => events.push(info))
      await waitForNextTick()

      assert.equal(events.length, 1)
      assert.equal(events[0].name, 'a')
      assert.equal(events[0].oldHash, sha256Hex('original'))
      assert.equal(events[0].newHash, sha256Hex('tampered'))
      assert.equal(events[0].blocked, false)
      assert.equal(s2._getSkills().length, 1, 'warn mode still loads the skill')
    })

    it('changed content (block mode) fires skill_changed AND filters the skill out', async () => {
      writeFileSync(join(skillsDir, 'a.md'), 'original')
      new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustStore: new SkillsTrustStore({ filePath: trustPath, mode: 'block' }),
      })

      writeFileSync(join(skillsDir, 'a.md'), 'tampered')
      const s2 = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustStore: new SkillsTrustStore({ filePath: trustPath, mode: 'block' }),
      })
      const events = []
      s2.on('skill_changed', (info) => events.push(info))
      await waitForNextTick()

      assert.equal(events.length, 1)
      assert.equal(events[0].blocked, true)
      assert.equal(s2._getSkills().length, 0, 'block mode must filter the changed skill out')
    })

    it('skill_changed events fire on process.nextTick (after listeners can attach)', async () => {
      writeFileSync(join(skillsDir, 'a.md'), 'original')
      new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustStore: new SkillsTrustStore({ filePath: trustPath }),
      })

      writeFileSync(join(skillsDir, 'a.md'), 'tampered')
      const s2 = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustStore: new SkillsTrustStore({ filePath: trustPath }),
      })
      // Listener attached AFTER construction — must still receive the event
      // because BaseSession defers emit() to nextTick.
      const events = []
      s2.on('skill_changed', (info) => events.push(info))
      await waitForNextTick()
      assert.equal(events.length, 1, 'listener attached post-construction must still fire')
    })

    it('trustMismatchMode opt-in (no explicit store) creates a default-pathed store; pinned by passing trustStore', () => {
      // Tests must always pin a trustStore — verifying that the opt-in
      // path is gated by `trustMismatchMode`.
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        // No trustStore, no trustMismatchMode → no store wired.
      })
      assert.equal(s._trustStore, null)

      writeFileSync(join(skillsDir, 'a.md'), 'body')
      const customStore = new SkillsTrustStore({ filePath: trustPath })
      const s2 = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustStore: customStore,
      })
      assert.equal(s2._trustStore, customStore)
    })

    it('malformed trust file is treated as missing — first activation re-records cleanly', () => {
      // Pre-seed a corrupted file.
      writeFileSync(trustPath, '{ this is not valid json')
      writeFileSync(join(skillsDir, 'a.md'), 'body')

      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir,
        repoSkillsDir: null,
        trustStore: new SkillsTrustStore({ filePath: trustPath }),
      })
      assert.equal(s._getSkills().length, 1, 'malformed trust file must not break loading')
    })
  })

  // #4628: in-flight tool_start tracking + sweep at turn-end
  describe('in-flight tool_start sweep (#4628)', () => {
    let s, sweepSkillsDir
    beforeEach(() => {
      sweepSkillsDir = mkdtempSync(join(tmpdir(), 'chroxy-bs-4628-'))
      s = new BaseSession({ cwd: '/tmp', skillsDir: sweepSkillsDir, repoSkillsDir: null })
    })
    afterEach(() => { rmSync(sweepSkillsDir, { recursive: true, force: true }) })

    it('_trackToolStart adds to in-flight map; _trackToolResult removes', () => {
      s._trackToolStart('toolu_1', 'Bash')
      s._trackToolStart('toolu_2', 'Read')
      assert.equal(s._inFlightToolStarts.size, 2)
      s._trackToolResult('toolu_1')
      assert.equal(s._inFlightToolStarts.size, 1)
      assert.ok(s._inFlightToolStarts.has('toolu_2'))
    })

    it('_trackToolStart ignores empty / non-string ids (defensive)', () => {
      s._trackToolStart('', 'Bash')
      s._trackToolStart(null, 'Bash')
      s._trackToolStart(undefined, 'Bash')
      s._trackToolStart(42, 'Bash')
      assert.equal(s._inFlightToolStarts.size, 0)
    })

    it('_sweepUnresolvedToolStarts emits one synthetic tool_result per orphan and clears the map', () => {
      s._trackToolStart('toolu_A', 'Bash')
      s._trackToolStart('toolu_B', 'Read')
      const events = []
      s.on('tool_result', (ev) => events.push(ev))
      const swept = s._sweepUnresolvedToolStarts('test_reason')
      assert.equal(swept, 2)
      assert.equal(events.length, 2)
      const ids = events.map((e) => e.toolUseId).sort()
      assert.deepEqual(ids, ['toolu_A', 'toolu_B'])
      for (const ev of events) {
        assert.equal(ev.synthetic, true, 'synthetic flag for grep-ability')
        assert.equal(ev.interrupted, true)
        assert.equal(ev.isError, true)
        assert.equal(ev.reason, 'test_reason')
        assert.equal(ev.truncated, false)
        assert.ok(typeof ev.result === 'string' && ev.result.length > 0)
      }
      assert.equal(s._inFlightToolStarts.size, 0, 'map cleared after sweep')
    })

    it('_sweepUnresolvedToolStarts is a no-op when no orphans (returns 0, emits nothing)', () => {
      const events = []
      s.on('tool_result', (ev) => events.push(ev))
      const swept = s._sweepUnresolvedToolStarts('test_reason')
      assert.equal(swept, 0)
      assert.equal(events.length, 0)
    })

    it('_emitResult sweeps orphans BEFORE emitting result (ordering matters for dashboard activeTools clear)', () => {
      s._trackToolStart('toolu_orphan', 'Bash')
      const events = []
      s.on('tool_result', (ev) => events.push({ type: 'tool_result', toolUseId: ev.toolUseId, synthetic: ev.synthetic }))
      s.on('result', (ev) => events.push({ type: 'result', cost: ev.cost }))
      s._emitResult({ cost: null, duration: 100, usage: null, sessionId: 'sess_1' }, 'turn_end')
      assert.equal(events.length, 2)
      assert.equal(events[0].type, 'tool_result', 'synthetic tool_result fires FIRST')
      assert.equal(events[0].toolUseId, 'toolu_orphan')
      assert.equal(events[0].synthetic, true)
      assert.equal(events[1].type, 'result', 'result fires SECOND')
    })

    it('_clearMessageState sweeps orphans (belt-and-braces for paths that bypass _emitResult)', () => {
      s._trackToolStart('toolu_orphan', 'Bash')
      const events = []
      s.on('tool_result', (ev) => events.push(ev))
      s._clearMessageState()
      assert.equal(events.length, 1, 'sweep ran from within _clearMessageState')
      assert.equal(events[0].toolUseId, 'toolu_orphan')
      assert.equal(events[0].synthetic, true)
      assert.equal(s._inFlightToolStarts.size, 0)
    })
  })

  // #6706 — the turn-boundary queue-length stamp (#6627) is applied centrally in
  // the emit() override, so EVERY `result` carries queueLength regardless of
  // which provider emits it (the direct-emit providers — CLI/exec-codex/gemini/
  // byok/stall fallbacks — bypass _emitResult but still pass through emit()).
  describe('result queueLength stamping via emit() override (#6627/#6706)', () => {
    let s
    beforeEach(() => {
      s = new BaseSession({ cwd: '/tmp', repoSkillsDir: null })
    })

    it('stamps queueLength: 0 on a direct emit when the outgoing queue is empty', () => {
      let received = null
      s.on('result', (ev) => { received = ev })
      // Simulate a direct-emit provider (e.g. cli-session) bypassing _emitResult.
      s.emit('result', { cost: null, duration: 5, usage: null, sessionId: 'sess_1' })
      assert.equal(received.queueLength, 0)
      assert.equal(received.sessionId, 'sess_1', 'original fields preserved')
    })

    it('stamps queueLength reflecting the current outgoing-queue length', () => {
      s._outgoingQueue.push({ clientMessageId: 'uin-1' }, { clientMessageId: 'uin-2' })
      let received = null
      s.on('result', (ev) => { received = ev })
      s.emit('result', { cost: 1, duration: 5, usage: null, sessionId: 'sess_1' })
      assert.equal(received.queueLength, 2)
    })

    it('_emitResult results also carry queueLength (regression for #6627)', () => {
      s._outgoingQueue.push({ clientMessageId: 'uin-1' })
      let received = null
      s.on('result', (ev) => { received = ev })
      s._emitResult({ cost: null, duration: 100, usage: null, sessionId: 'sess_1' }, 'turn_end')
      assert.equal(received.queueLength, 1)
    })

    it('does not overwrite a queueLength already present on the payload (idempotent)', () => {
      s._outgoingQueue.push({ clientMessageId: 'uin-1' }, { clientMessageId: 'uin-2' })
      let received = null
      s.on('result', (ev) => { received = ev })
      s.emit('result', { sessionId: 'sess_1', queueLength: 7 })
      assert.equal(received.queueLength, 7, 'pre-stamped value is preserved')
    })

    it('leaves non-result events untouched and preserves the has-listeners return', () => {
      let received = null
      s.on('stream', (ev) => { received = ev })
      const hadListeners = s.emit('stream', { chunk: 'x' })
      assert.equal(hadListeners, true)
      assert.deepStrictEqual(received, { chunk: 'x' }, 'no queueLength added to non-result events')
      assert.equal(s.emit('result', { sessionId: 'n' }), false, 'returns false when result has no listener')
    })

    it('does not mutate the caller-supplied payload object (spreads a copy)', () => {
      const payload = { cost: null, sessionId: 'sess_1' }
      s.on('result', () => {})
      s.emit('result', payload)
      assert.equal('queueLength' in payload, false, 'original payload is not mutated')
    })

    it("preserves the EventEmitter 'error' contract through the override", () => {
      // The override must NOT swallow or reshape 'error': an unhandled 'error'
      // still throws (Node's default), and a handled one is delivered verbatim
      // (never queueLength-stamped). This is the override's highest-risk path.
      assert.throws(() => s.emit('error', new Error('boom')), /boom/)
      let received = null
      s.on('error', (e) => { received = e })
      const errPayload = { message: 'handled', queueLength: undefined }
      s.emit('error', errPayload)
      assert.equal(received, errPayload, 'error payload delivered by identity, unstamped')
      assert.equal('queueLength' in received && received.queueLength !== undefined, false)
    })

    it('forwards all args for non-result events (multi-arg pass-through)', () => {
      const seen = []
      s.on('foo', (a, b, c) => seen.push(a, b, c))
      const had = s.emit('foo', 1, 'two', { three: true })
      assert.equal(had, true)
      assert.deepStrictEqual(seen, [1, 'two', { three: true }])
    })
  })
})

// #4509: BaseSession's three per-session inactivity timeouts must also clamp
// to the shared MAX_SANE_DURATION_MS (24h) ceiling. Even when an operator
// over-ceiling value somehow gets past session-manager (e.g. a provider
// that hand-builds providerOpts), BaseSession is the final destination — it
// arms the actual setTimeout against the value and a >24h timer would
// silently make the inactivity-warning / hard-cap / stream-stall paths
// effectively never fire.
describe('BaseSession operator-timeout MAX_SANE_DURATION_MS ceiling (#4509)', () => {
  const MAX_SANE_DURATION_MS = 24 * 60 * 60 * 1000

  // Each row: ctor key, internal slot the value lands in, BaseSession default
  // it falls back to, display name in the warn log.
  const TIMEOUT_SPECS = [
    {
      ctorKey: 'resultTimeoutMs',
      internalField: '_resultTimeoutMs',
      fallback: DEFAULT_RESULT_TIMEOUT_MS,
      displayName: 'resultTimeoutMs',
    },
    {
      ctorKey: 'hardTimeoutMs',
      internalField: '_hardTimeoutMs',
      fallback: DEFAULT_HARD_TIMEOUT_MS,
      displayName: 'hardTimeoutMs',
    },
    {
      ctorKey: 'streamStallTimeoutMs',
      internalField: '_streamStallTimeoutMs',
      fallback: DEFAULT_STREAM_STALL_TIMEOUT_MS,
      displayName: 'streamStallTimeoutMs',
    },
  ]

  let skillsDirLocal

  beforeEach(() => {
    skillsDirLocal = mkdtempSync(join(tmpdir(), 'chroxy-base-ceiling-'))
  })

  afterEach(() => {
    if (skillsDirLocal) rmSync(skillsDirLocal, { recursive: true, force: true })
    skillsDirLocal = null
    mock.restoreAll()
  })

  for (const { ctorKey, internalField, fallback, displayName } of TIMEOUT_SPECS) {
    it(`clamps ${ctorKey} above MAX_SANE_DURATION_MS back to the default and warns`, () => {
      const warnings = []
      mock.method(console, 'warn', (msg) => warnings.push(msg))
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: skillsDirLocal,
        repoSkillsDir: null,
        [ctorKey]: MAX_SANE_DURATION_MS + 1,
      })
      assert.equal(s[internalField], fallback,
        `${internalField} must fall back to its BaseSession default when ${ctorKey} exceeds the 24h ceiling`)
      const hit = warnings.find((w) => w.includes(displayName) && w.includes('MAX_SANE_DURATION_MS'))
      assert.ok(hit, `expected a single warn log mentioning ${displayName} + MAX_SANE_DURATION_MS, got: ${warnings.join(' | ')}`)
    })

    it(`accepts the exact MAX_SANE_DURATION_MS boundary for ${ctorKey}`, () => {
      const s = new BaseSession({
        cwd: '/tmp',
        skillsDir: skillsDirLocal,
        repoSkillsDir: null,
        [ctorKey]: MAX_SANE_DURATION_MS,
      })
      assert.equal(s[internalField], MAX_SANE_DURATION_MS,
        `the boundary must be INCLUSIVE — clamping it would surprise operators who tuned the dial to exactly 24h`)
    })
  }
})

// #5367: the canonical opt picker that every session subclass now uses to
// forward BaseSession opts via `super(buildBaseSessionOpts(opts, overrides))`.
describe('buildBaseSessionOpts (#5367)', () => {
  it('copies only BaseSession opts, omitting absent keys and subclass-local opts', () => {
    const out = buildBaseSessionOpts({
      cwd: '/tmp/x',
      model: 'sonnet',
      // subclass-local opts that must NOT be copied:
      allowedTools: ['Bash'],
      resumeSessionId: 'abc',
      port: 9999,
    })
    assert.deepEqual(Object.keys(out).sort(), ['cwd', 'model'])
    assert.equal(out.cwd, '/tmp/x')
    assert.equal(out.model, 'sonnet')
  })

  it('preserves an explicit falsy value (backgroundShellHardQuiesceMs: 0) via `in`, not `??`', () => {
    const out = buildBaseSessionOpts({ backgroundShellHardQuiesceMs: 0 })
    assert.ok('backgroundShellHardQuiesceMs' in out, 'explicit 0 must be carried through')
    assert.equal(out.backgroundShellHardQuiesceMs, 0)
  })

  it('omits keys that are absent entirely (no undefined leakage)', () => {
    const out = buildBaseSessionOpts({ cwd: '/tmp/x' })
    assert.equal('model' in out, false, 'absent keys must be omitted so BaseSession `|| default` fallbacks apply')
  })

  it('overrides win over picked values', () => {
    const out = buildBaseSessionOpts({ provider: 'gemini', model: 'm1' }, { provider: 'codex' })
    assert.equal(out.provider, 'codex')
    assert.equal(out.model, 'm1')
  })

  it('every key it can emit is a real BaseSession opt (array is the source of truth)', () => {
    // Build a full bag and confirm the picker never invents a key.
    const full = Object.fromEntries(BASE_SESSION_OPT_KEYS.map((k) => [k, `s_${k}`]))
    const out = buildBaseSessionOpts(full)
    for (const k of Object.keys(out)) {
      assert.ok(BASE_SESSION_OPT_KEYS.includes(k), `${k} is not in BASE_SESSION_OPT_KEYS`)
    }
    assert.equal(Object.keys(out).length, BASE_SESSION_OPT_KEYS.length)
  })
})

// #5367: the "no opt dropped" proof. Instantiate every session subclass with
// every BaseSession opt set to a distinct, coercion-surviving sentinel and
// assert each landed on the resulting instance's BaseSession-owned field. This
// is hand-list-INDEPENDENT: it derives the opt list from BASE_SESSION_OPT_KEYS,
// so a future opt added to the array (and the ctor) is automatically covered.
describe('subclass opt forwarding — no opt dropped (#5367)', () => {
  let tmpDir
  let trustStore
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-opt-fwd-'))
    trustStore = new SkillsTrustStore({ filePath: join(tmpDir, 'trust.json'), mode: 'warn' })
  })
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  // Each entry: how to make a valid sentinel for the opt, the instance field
  // BaseSession stores it on, and how to assert it landed. Values are chosen to
  // SURVIVE BaseSession's coercion (valid permissionMode, in-range timeouts,
  // real regex, object allowlist, etc.) so a forwarded value is observable.
  function sentinelOpts() {
    return {
      cwd: join(tmpDir, 'work'),
      model: 'sentinel-model',
      permissionMode: 'plan',
      skillsDir: join(tmpDir, 'skills'),
      repoSkillsDir: join(tmpDir, 'repo-skills'),
      maxSkillBytes: 4242,
      maxTotalSkillBytes: 8484,
      // An explicit truthy provider survives every subclass's
      // `opts.provider || '<default>'` override, so it lands verbatim.
      provider: 'sentinel-provider',
      activeManualSkills: ['skill-a', 'skill-b'],
      providerSkillAllowlist: { 'claude-sdk': ['x'] },
      trustStore,
      trustMismatchMode: 'block',
      promptEvaluator: true,
      promptEvaluatorSkipPattern: '^ack$',
      chroxyContextHint: true,
      sessionPreamble: 'sentinel preamble',
      resultTimeoutMs: 11 * 60 * 1000,
      hardTimeoutMs: 33 * 60 * 1000,
      streamStallTimeoutMs: 7 * 60 * 1000,
      backgroundShellHardQuiesceMs: 0, // explicit 0 — the falsy-preservation case
    }
  }

  // (instance) => assertions. Each checks the BaseSession-owned field landed.
  // permissionMode is special: jsonl-family subclasses default it to 'auto',
  // but an explicit 'plan' survives the `|| 'auto'` override, so it lands.
  const assertions = {
    cwd: (s, o) => assert.equal(s.cwd, o.cwd),
    model: (s, o) => assert.equal(s.model, o.model),
    permissionMode: (s, o) => assert.equal(s.permissionMode, o.permissionMode),
    skillsDir: (s, o) => assert.equal(s._skillsDir, o.skillsDir),
    repoSkillsDir: (s, o) => assert.equal(s._repoSkillsDir, o.repoSkillsDir),
    maxSkillBytes: (s, o) => assert.equal(s._maxSkillBytes, o.maxSkillBytes),
    maxTotalSkillBytes: (s, o) => assert.equal(s._maxTotalSkillBytes, o.maxTotalSkillBytes),
    provider: (s, o) => assert.equal(s._provider, o.provider),
    activeManualSkills: (s) => {
      assert.ok(s._activeManualSkills.has('skill-a'))
      assert.ok(s._activeManualSkills.has('skill-b'))
    },
    providerSkillAllowlist: (s, o) => assert.deepEqual(s._providerSkillAllowlist, o.providerSkillAllowlist),
    trustStore: (s) => assert.equal(s._trustStore, trustStore),
    // trustMismatchMode only matters when trustStore is absent; with an
    // explicit trustStore the store wins (so no separate field to assert).
    trustMismatchMode: () => {},
    promptEvaluator: (s) => assert.equal(s.promptEvaluator, true),
    promptEvaluatorSkipPattern: (s, o) => assert.equal(s.promptEvaluatorSkipPattern, o.promptEvaluatorSkipPattern),
    chroxyContextHint: (s) => assert.equal(s.chroxyContextHint, true),
    sessionPreamble: (s, o) => assert.equal(s.sessionPreamble, o.sessionPreamble),
    resultTimeoutMs: (s, o) => assert.equal(s._resultTimeoutMs, o.resultTimeoutMs),
    hardTimeoutMs: (s, o) => assert.equal(s._hardTimeoutMs, o.hardTimeoutMs),
    streamStallTimeoutMs: (s, o) => assert.equal(s._streamStallTimeoutMs, o.streamStallTimeoutMs),
    backgroundShellHardQuiesceMs: (s) => assert.equal(s._backgroundShellHardQuiesceMs, 0),
  }

  // Guard: the assertion table must cover exactly the canonical opt set, so a
  // new BaseSession opt forces this test to be extended (it can't silently
  // pass with a stale list).
  it('assertion table covers exactly BASE_SESSION_OPT_KEYS', () => {
    assert.deepEqual(
      Object.keys(assertions).sort(),
      [...BASE_SESSION_OPT_KEYS].sort(),
      'add the new opt to BOTH the sentinel bag and the assertions table',
    )
  })

  const subclasses = [
    ['CliSession', '../src/cli-session.js', 'CliSession'],
    ['SdkSession', '../src/sdk-session.js', 'SdkSession'],
    ['ClaudeTuiSession', '../src/claude-tui-session.js', 'ClaudeTuiSession'],
    ['ClaudeByokSession', '../src/byok-session.js', 'ClaudeByokSession'],
    ['JsonlSubprocessSession', '../src/jsonl-subprocess-session.js', 'JsonlSubprocessSession'],
    ['CodexSession', '../src/codex-session.js', 'CodexSession'],
    ['GeminiSession', '../src/gemini-session.js', 'GeminiSession'],
  ]

  for (const [label, modPath, exportName] of subclasses) {
    it(`${label} forwards every BaseSession opt to super()`, async () => {
      const mod = await import(modPath)
      const Klass = mod[exportName]
      const opts = sentinelOpts()
      const inst = new Klass(opts)
      for (const key of BASE_SESSION_OPT_KEYS) {
        assertions[key](inst, opts)
      }
      // Clean teardown so timers/processes don't leak between cases.
      if (typeof inst.destroy === 'function') {
        try { await inst.destroy() } catch {}
      }
    })
  }
})
