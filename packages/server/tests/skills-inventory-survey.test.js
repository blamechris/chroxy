import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  surveySkillsInventory,
  parseSkillsLock,
  lockPathForSkillsDir,
  toInventoryEntry,
} from '../src/control-room/skills-inventory.js'

/**
 * #5554 — tests for the Skills inventory survey (control-room/skills-inventory.js).
 *
 * All filesystem access is injected (`_loadActiveSkills` / `_readLock` /
 * `_findRepoSkillsDir`) so the survey never touches the real disk or the user's
 * home directory.
 */

/** A loader descriptor like loadActiveSkills returns (body present, dropped on map). */
function loaderSkill(name, extra = {}) {
  return {
    name,
    description: `desc for ${name}`,
    body: 'SECRET BODY — must never leave the server',
    metadata: null,
    source: extra.source || 'global',
    active: extra.active !== false,
    path: `/real/${name}.md`,
    ...extra,
  }
}

describe('parseSkillsLock', () => {
  it('parses the registry lock shape into a name → { hash, installed } map', () => {
    const lock = parseSkillsLock(JSON.stringify({
      registry: 'blamechris/skill-templates',
      skills: {
        'batch-merge': { hash: '0a76684', installed: '2026-06-03' },
        'bug-hunt': { hash: 'ebdb14e', installed: '2026-06-02' },
      },
    }))
    assert.equal(lock.get('batch-merge').hash, '0a76684')
    assert.equal(lock.get('batch-merge').installed, '2026-06-03')
    assert.equal(lock.get('bug-hunt').hash, 'ebdb14e')
  })

  it('degrades a missing / unparseable / wrong-shape lock to an empty map', () => {
    assert.equal(parseSkillsLock(null).size, 0)
    assert.equal(parseSkillsLock('not json').size, 0)
    assert.equal(parseSkillsLock(JSON.stringify([1, 2, 3])).size, 0)
    assert.equal(parseSkillsLock(JSON.stringify({ skills: 'oops' })).size, 0)
  })
})

describe('lockPathForSkillsDir', () => {
  it('pairs the lock as a sibling of the skills dir', () => {
    assert.equal(lockPathForSkillsDir('/home/u/.chroxy/skills'), '/home/u/.chroxy/skills.lock')
    assert.equal(lockPathForSkillsDir('/repo/.chroxy/skills'), '/repo/.chroxy/skills.lock')
  })
})

describe('toInventoryEntry', () => {
  it('drops the body + absolute path and joins lock + usage', () => {
    const lock = new Map([['batch-merge', { hash: 'abc1234', installed: '2026-06-03' }]])
    const usage = new Map([['batch-merge', { lastUsed: Date.parse('2026-06-10T00:00:00.000Z'), count: 7, repos: ['/p/chroxy'] }]])
    const entry = toInventoryEntry(loaderSkill('batch-merge'), lock, usage, null)

    assert.equal(entry.name, 'batch-merge')
    assert.equal(entry.description, 'desc for batch-merge')
    assert.ok(!('body' in entry), 'body must never appear on a wire entry')
    assert.ok(!('path' in entry), 'absolute path must never appear on a wire entry')
    assert.equal(entry.hash, 'abc1234')
    assert.equal(entry.installed, '2026-06-03')
    assert.equal(entry.lastUsed, '2026-06-10T00:00:00.000Z')
    assert.equal(entry.useCount, 7)
    assert.deepEqual(entry.usedRepos, ['/p/chroxy'])
  })

  it('reports null hash/installed + zeroed usage when the joins miss', () => {
    const entry = toInventoryEntry(loaderSkill('lonely'), new Map(), new Map(), null)
    assert.equal(entry.hash, null)
    assert.equal(entry.installed, null)
    assert.equal(entry.lastUsed, null)
    assert.equal(entry.useCount, 0)
    assert.deepEqual(entry.usedRepos, [])
  })

  it('derives activation + providers from frontmatter and flags overrides', () => {
    const skill = loaderSkill('coding-style', {
      source: 'repo',
      metadata: { activation: 'manual', providers: ['claude-sdk'], version: '2' },
      active: false,
    })
    const globalNames = new Set(['coding-style'])
    const entry = toInventoryEntry(skill, new Map(), new Map(), globalNames)
    assert.equal(entry.activation, 'manual')
    assert.equal(entry.active, false)
    assert.deepEqual(entry.providers, ['claude-sdk'])
    assert.equal(entry.version, '2')
    assert.equal(entry.overridesGlobal, true)
  })

  it('carries community trust state through', () => {
    const skill = loaderSkill('shared', { trustState: 'pending', communityAuthor: 'alice' })
    const entry = toInventoryEntry(skill, new Map(), new Map(), null)
    assert.equal(entry.trustState, 'pending')
    assert.equal(entry.communityAuthor, 'alice')
  })
})

describe('surveySkillsInventory', () => {
  function makeSeams(byDir) {
    return {
      _loadActiveSkills: (dir, opts) => {
        // Assert the inventory always asks for the full browse-all view.
        assert.equal(opts.includeInactive, true)
        assert.equal(opts.includeAllProviders, true)
        return (byDir[dir] || []).map((s) => ({ ...s, source: opts.source }))
      },
      _readLock: (lockPath) => {
        const text = byDir[`__lock__${lockPath}`]
        if (text === undefined) throw new Error('ENOENT')
        return text
      },
      _findRepoSkillsDir: (repoPath) => byDir[`__repodir__${repoPath}`] ?? null,
      _now: () => new Date('2026-06-11T00:00:00.000Z'),
    }
  }

  it('scans global + per-repo overlays and flags repo overrides of global', async () => {
    const globalDir = '/g/skills'
    const repoDir = '/repo/.chroxy/skills'
    const seams = makeSeams({
      [globalDir]: [loaderSkill('batch-merge'), loaderSkill('coding-style')],
      [repoDir]: [loaderSkill('coding-style'), loaderSkill('repo-only')],
      '__repodir__/repo': repoDir,
    })
    const result = await surveySkillsInventory([{ name: 'repo', path: '/repo' }], {
      globalDir, root: '/root', ...seams,
    })

    assert.equal(result.generatedAt, '2026-06-11T00:00:00.000Z')
    assert.equal(result.root, '/root')
    assert.equal(result.globalError, null)
    assert.deepEqual(result.global.map((e) => e.name), ['batch-merge', 'coding-style'])

    const repo = result.repos[0]
    assert.equal(repo.error, null)
    // Sorted by name; coding-style overrides the global of the same name.
    const codingStyle = repo.skills.find((s) => s.name === 'coding-style')
    const repoOnly = repo.skills.find((s) => s.name === 'repo-only')
    assert.equal(codingStyle.overridesGlobal, true, 'repo skill shadowing a global one is an override')
    assert.ok(!repoOnly.overridesGlobal, 'a repo-only skill is not an override')
  })

  it('reports a quiet empty overlay (no error) when a repo has no .chroxy/skills/', async () => {
    const seams = makeSeams({ '/g/skills': [] }) // no __repodir__ entry → findRepoSkillsDir returns null
    const result = await surveySkillsInventory([{ name: 'bare', path: '/bare' }], {
      globalDir: '/g/skills', root: '/root', ...seams,
    })
    assert.deepEqual(result.repos[0].skills, [])
    assert.equal(result.repos[0].error, null)
  })

  it('degrades a per-repo scan failure to an error chip, never a dead snapshot', async () => {
    const repoDir = '/repo/.chroxy/skills'
    const seams = {
      _loadActiveSkills: (dir) => {
        if (dir === repoDir) throw new Error('overlay blew up')
        return []
      },
      _readLock: () => { throw new Error('ENOENT') },
      _findRepoSkillsDir: () => repoDir,
      _now: () => new Date('2026-06-11T00:00:00.000Z'),
    }
    const result = await surveySkillsInventory([{ name: 'repo', path: '/repo' }], {
      globalDir: '/g/skills', root: '/root', ...seams,
    })
    // Global tier survived; the repo card carries the error.
    assert.equal(result.globalError, null)
    assert.deepEqual(result.global, [])
    assert.equal(result.repos[0].error, 'overlay blew up')
    assert.deepEqual(result.repos[0].skills, [])
  })

  it('degrades a global-tier scan failure to globalError without blanking repos', async () => {
    const repoDir = '/repo/.chroxy/skills'
    const seams = {
      _loadActiveSkills: (dir, opts) => {
        if (dir === '/g/skills') throw new Error('global blew up')
        return (dir === repoDir ? [loaderSkill('repo-only', { source: opts.source })] : [])
      },
      _readLock: () => { throw new Error('ENOENT') },
      _findRepoSkillsDir: () => repoDir,
      _now: () => new Date('2026-06-11T00:00:00.000Z'),
    }
    const result = await surveySkillsInventory([{ name: 'repo', path: '/repo' }], {
      globalDir: '/g/skills', root: '/root', ...seams,
    })
    assert.equal(result.globalError, 'global blew up')
    assert.deepEqual(result.global, [])
    assert.equal(result.repos[0].skills[0].name, 'repo-only')
  })

  it('joins the skills.lock paired with each scanned dir', async () => {
    const globalDir = '/g/skills'
    const lockPath = lockPathForSkillsDir(globalDir) // /g/skills.lock
    const seams = makeSeams({
      [globalDir]: [loaderSkill('batch-merge')],
      [`__lock__${lockPath}`]: JSON.stringify({ skills: { 'batch-merge': { hash: 'deadbee', installed: '2026-06-03' } } }),
    })
    const result = await surveySkillsInventory([], { globalDir, root: '/root', ...seams })
    assert.equal(result.global[0].hash, 'deadbee')
    assert.equal(result.global[0].installed, '2026-06-03')
  })

  it('joins usage aggregates onto the entries', async () => {
    const globalDir = '/g/skills'
    const usage = new Map([['batch-merge', { lastUsed: Date.parse('2026-06-09T00:00:00.000Z'), count: 3, repos: ['/p'] }]])
    const seams = makeSeams({ [globalDir]: [loaderSkill('batch-merge')] })
    const result = await surveySkillsInventory([], { globalDir, root: '/root', usage, ...seams })
    assert.equal(result.global[0].useCount, 3)
    assert.equal(result.global[0].lastUsed, '2026-06-09T00:00:00.000Z')
    assert.deepEqual(result.global[0].usedRepos, ['/p'])
  })
})
