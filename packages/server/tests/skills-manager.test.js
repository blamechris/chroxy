// #5376: standalone unit tests for SkillsManager — the collaborator extracted
// from BaseSession. These exercise the load / activate / deactivate-rollback
// logic in isolation (the payoff of the extraction) against the real layered
// loader over a temp skills dir, with an injected emit callback. The
// session-level delegation contract stays pinned by base-session.test.js +
// skills-integration.test.js.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillsManager } from '../src/skills-manager.js'

function makeManager(dir, opts = {}) {
  const events = []
  const mgr = new SkillsManager({
    cwd: '/tmp',
    skillsDir: dir,
    repoSkillsDir: null,
    emit: (event, payload) => events.push({ event, payload }),
    ...opts,
  })
  // The caller controls the construction load timing (BaseSession runs it then
  // re-emits on nextTick) — run it here so the manager is in its loaded state.
  const constructionEvents = mgr.loadSkills({ collectTrustEvents: true })
  return { mgr, events, constructionEvents }
}

describe('SkillsManager — construction / load', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-skills-mgr-'))
    writeFileSync(join(dir, 'auto-skill.md'), '# Auto\n\nalways on\n')
    writeFileSync(join(dir, 'manual-a.md'), '---\nactivation: manual\n---\n\nmanual A body\n')
    writeFileSync(join(dir, 'manual-b.md'), '---\nactivation: manual\n---\n\nmanual B body\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('requires an emit callback', () => {
    assert.throws(() => new SkillsManager({ cwd: '/tmp' }), /requires an emit callback/)
  })

  it('loads only auto skills by default; manual ones stay off but are known', () => {
    const { mgr } = makeManager(dir)
    assert.deepEqual(mgr._skills.map((s) => s.name).sort(), ['auto-skill'])
    assert.deepEqual([...mgr._manualSkillNames].sort(), ['manual-a', 'manual-b'],
      'manual names are scanned (includeInactive) so activate can validate without a re-scan')
  })

  it('populates the append/prepend buckets + text caches', () => {
    const { mgr } = makeManager(dir)
    assert.ok(Array.isArray(mgr._skillsByMode.append))
    assert.ok(Array.isArray(mgr._skillsByMode.prepend))
    assert.equal(typeof mgr._skillsText, 'string')
    assert.equal(typeof mgr._prependSkillsText, 'string')
  })

  it('loads a manual skill when its name is in activeManualSkills', () => {
    const { mgr } = makeManager(dir, { activeManualSkills: ['manual-a'] })
    assert.deepEqual(mgr._skills.map((s) => s.name).sort(), ['auto-skill', 'manual-a'])
  })
})

describe('SkillsManager — activate / deactivate (#3209/#3253)', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-skills-mgr-'))
    writeFileSync(join(dir, 'auto-skill.md'), '# Auto\n\nalways on\n')
    writeFileSync(join(dir, 'manual-a.md'), '---\nactivation: manual\n---\n\nmanual A body\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('activateSkill flips a manual skill on and reloads the caches', () => {
    const { mgr } = makeManager(dir)
    assert.ok(!mgr._skillsText.includes('manual A body'))
    assert.equal(mgr.activateSkill('manual-a'), true)
    assert.deepEqual([...mgr._activeManualSkills], ['manual-a'])
    assert.ok(mgr._skills.some((s) => s.name === 'manual-a'), 'manual-a now active')
  })

  it('activateSkill is idempotent — second call returns false', () => {
    const { mgr } = makeManager(dir)
    assert.equal(mgr.activateSkill('manual-a'), true)
    assert.equal(mgr.activateSkill('manual-a'), false)
  })

  it('activateSkill performs exactly one layered scan on the success path', () => {
    const { mgr } = makeManager(dir)
    let scans = 0
    const orig = mgr.loadSkills.bind(mgr)
    mgr.loadSkills = (...a) => { scans++; return orig(...a) }
    mgr.activateSkill('manual-a')
    assert.equal(scans, 1, 'one scan covers validation + reload (#3253)')
  })

  it('activateSkill on a bogus name does not pollute the active set (rollback)', () => {
    const { mgr } = makeManager(dir)
    let scans = 0
    const orig = mgr.loadSkills.bind(mgr)
    mgr.loadSkills = (...a) => { scans++; return orig(...a) }
    assert.equal(mgr.activateSkill('does-not-exist'), false)
    assert.deepEqual([...mgr._activeManualSkills], [], 'bogus name rolled back out of the active set')
    assert.equal(scans, 2, 'speculative add + rollback = two scans on the rare failure path')
  })

  it('activateSkill rejects an auto-skill name (only manual skills toggle)', () => {
    const { mgr } = makeManager(dir)
    assert.equal(mgr.activateSkill('auto-skill'), false)
    assert.deepEqual([...mgr._activeManualSkills], [])
  })

  it('activateSkill rejects invalid input shapes', () => {
    const { mgr } = makeManager(dir)
    assert.equal(mgr.activateSkill(''), false)
    assert.equal(mgr.activateSkill(null), false)
    assert.equal(mgr.activateSkill(42), false)
  })

  it('deactivateSkill flips a manual skill off and reloads', () => {
    const { mgr } = makeManager(dir, { activeManualSkills: ['manual-a'] })
    assert.ok(mgr._skills.some((s) => s.name === 'manual-a'))
    assert.equal(mgr.deactivateSkill('manual-a'), true)
    assert.deepEqual([...mgr._activeManualSkills], [])
    assert.ok(!mgr._skills.some((s) => s.name === 'manual-a'))
  })

  it('deactivateSkill is idempotent on a not-currently-active name', () => {
    const { mgr } = makeManager(dir)
    assert.equal(mgr.deactivateSkill('manual-a'), false)
  })
})
