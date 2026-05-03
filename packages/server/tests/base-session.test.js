import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BaseSession } from '../src/base-session.js'
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

  describe('setPermissionMode', () => {
    it('returns false for invalid modes', () => {
      assert.equal(session.setPermissionMode('invalid'), false)
    })

    it('returns false when busy', () => {
      session._isBusy = true
      assert.equal(session.setPermissionMode('auto'), false)
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

  describe('_getSkills', () => {
    it('returns empty array by default (no skills loaded)', () => {
      assert.deepEqual(session._getSkills(), [])
    })

    it('returns cached skills when set', () => {
      session._skills = [{ name: 'a', body: 'x', description: 'x' }]
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
})
