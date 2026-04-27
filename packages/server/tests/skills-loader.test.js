import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadActiveSkills,
  loadActiveSkillsLayered,
  findRepoSkillsDir,
  formatSkillsForPrompt,
} from '../src/skills-loader.js'

describe('skills-loader', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-skills-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('loadActiveSkills', () => {
    it('returns [] when directory does not exist', () => {
      const skills = loadActiveSkills(join(dir, 'missing'))
      assert.deepEqual(skills, [])
    })

    it('returns [] when directory is empty', () => {
      const skills = loadActiveSkills(dir)
      assert.deepEqual(skills, [])
    })

    it('loads all *.md files as skills', () => {
      writeFileSync(join(dir, 'coding-style.md'), '# Coding style\n\nUse single quotes.\n')
      writeFileSync(join(dir, 'testing.md'), '# Testing\n\nWrite tests first.\n')

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 2)
      const names = skills.map((s) => s.name).sort()
      assert.deepEqual(names, ['coding-style', 'testing'])
    })

    it('captures filename (without .md) as name', () => {
      writeFileSync(join(dir, 'my-skill.md'), 'body')
      const [skill] = loadActiveSkills(dir)
      assert.equal(skill.name, 'my-skill')
    })

    it('captures file contents as body', () => {
      const body = '# Heading\n\nSome content here.\n'
      writeFileSync(join(dir, 'foo.md'), body)
      const [skill] = loadActiveSkills(dir)
      assert.equal(skill.body, body)
    })

    it('captures first non-empty line as description', () => {
      writeFileSync(join(dir, 'a.md'), '\n\n# My heading\n\nrest\n')
      const [skill] = loadActiveSkills(dir)
      assert.equal(skill.description, '# My heading')
    })

    it('ignores files ending in .disabled.md', () => {
      writeFileSync(join(dir, 'active.md'), 'active body')
      writeFileSync(join(dir, 'off.disabled.md'), 'off body')

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'active')
    })

    it('ignores non-.md files', () => {
      writeFileSync(join(dir, 'readme.txt'), 'not markdown')
      writeFileSync(join(dir, 'notes'), 'no extension')
      writeFileSync(join(dir, 'skill.md'), 'md body')

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'skill')
    })

    it('ignores subdirectories', () => {
      mkdirSync(join(dir, 'nested'))
      writeFileSync(join(dir, 'nested', 'deep.md'), 'deep')
      writeFileSync(join(dir, 'top.md'), 'top')

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'top')
    })

    it('sorts skills by name for deterministic ordering', () => {
      writeFileSync(join(dir, 'zebra.md'), 'z')
      writeFileSync(join(dir, 'alpha.md'), 'a')
      writeFileSync(join(dir, 'middle.md'), 'm')

      const names = loadActiveSkills(dir).map((s) => s.name)
      assert.deepEqual(names, ['alpha', 'middle', 'zebra'])
    })
  })

  describe('formatSkillsForPrompt', () => {
    it('returns empty string for empty list', () => {
      assert.equal(formatSkillsForPrompt([]), '')
    })

    it('returns empty string for null/undefined', () => {
      assert.equal(formatSkillsForPrompt(null), '')
      assert.equal(formatSkillsForPrompt(undefined), '')
    })

    it('concatenates skill bodies with separators', () => {
      const skills = [
        { name: 'a', body: 'Alpha body', description: 'Alpha body' },
        { name: 'b', body: 'Bravo body', description: 'Bravo body' },
      ]
      const out = formatSkillsForPrompt(skills)
      assert.ok(out.includes('Alpha body'))
      assert.ok(out.includes('Bravo body'))
    })

    it('includes each skill name as a label', () => {
      const skills = [
        { name: 'coding-style', body: 'Body', description: 'Body' },
      ]
      const out = formatSkillsForPrompt(skills)
      assert.ok(out.includes('coding-style'))
    })
  })

  // -----------------------------------------------------------------------
  // #3067: layered global + repo overlay
  // -----------------------------------------------------------------------

  describe('loadActiveSkills source tag', () => {
    it('omits source field when no opts passed (backwards compat with v1)', () => {
      writeFileSync(join(dir, 'a.md'), 'body')
      const [skill] = loadActiveSkills(dir)
      assert.equal(skill.source, undefined)
    })

    it('attaches source field when opts.source is provided', () => {
      writeFileSync(join(dir, 'a.md'), 'body')
      const [skill] = loadActiveSkills(dir, { source: 'repo' })
      assert.equal(skill.source, 'repo')
    })
  })

  describe('findRepoSkillsDir', () => {
    let repo
    beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'chroxy-repo-')) })
    afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

    it('returns null for null/undefined/non-string input', () => {
      assert.equal(findRepoSkillsDir(null), null)
      assert.equal(findRepoSkillsDir(undefined), null)
      assert.equal(findRepoSkillsDir(42), null)
    })

    it('returns null when no .chroxy/skills exists in cwd or any ancestor', () => {
      // tmpdir() ancestors are unlikely to contain .chroxy/skills, so this
      // doubles as an integration check that the walk-up cap is respected.
      assert.equal(findRepoSkillsDir(repo), null)
    })

    it('finds .chroxy/skills directly under cwd', () => {
      mkdirSync(join(repo, '.chroxy', 'skills'), { recursive: true })
      assert.equal(findRepoSkillsDir(repo), join(repo, '.chroxy', 'skills'))
    })

    it('walks up from a nested cwd to find a repo-level .chroxy/skills', () => {
      mkdirSync(join(repo, '.chroxy', 'skills'), { recursive: true })
      const nested = join(repo, 'packages', 'app', 'src')
      mkdirSync(nested, { recursive: true })
      assert.equal(findRepoSkillsDir(nested), join(repo, '.chroxy', 'skills'))
    })

    it('ignores a .chroxy/skills file (not a directory)', () => {
      mkdirSync(join(repo, '.chroxy'), { recursive: true })
      writeFileSync(join(repo, '.chroxy', 'skills'), 'oops, a file')
      // Should not match — we only accept directories.
      assert.equal(findRepoSkillsDir(repo), null)
    })
  })

  describe('loadActiveSkillsLayered', () => {
    let globalDir
    let repoDir
    beforeEach(() => {
      globalDir = mkdtempSync(join(tmpdir(), 'chroxy-global-'))
      repoDir = mkdtempSync(join(tmpdir(), 'chroxy-repo-skills-'))
    })
    afterEach(() => {
      rmSync(globalDir, { recursive: true, force: true })
      rmSync(repoDir, { recursive: true, force: true })
    })

    it('returns [] when both dirs missing/null', () => {
      assert.deepEqual(loadActiveSkillsLayered({}), [])
      assert.deepEqual(loadActiveSkillsLayered({ globalDir: null, repoDir: null }), [])
    })

    it('returns global only when repoDir is null', () => {
      writeFileSync(join(globalDir, 'g.md'), 'global body')
      const skills = loadActiveSkillsLayered({ globalDir, repoDir: null })
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'g')
      assert.equal(skills[0].source, 'global')
    })

    it('returns repo only when globalDir is null', () => {
      writeFileSync(join(repoDir, 'r.md'), 'repo body')
      const skills = loadActiveSkillsLayered({ globalDir: null, repoDir })
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'r')
      assert.equal(skills[0].source, 'repo')
    })

    it('merges global + repo with no overlap, sorted by name, source tagged', () => {
      writeFileSync(join(globalDir, 'global-only.md'), 'global body')
      writeFileSync(join(repoDir, 'repo-only.md'), 'repo body')

      const skills = loadActiveSkillsLayered({ globalDir, repoDir })
      assert.equal(skills.length, 2)
      assert.deepEqual(skills.map((s) => s.name), ['global-only', 'repo-only'])
      assert.equal(skills.find((s) => s.name === 'global-only').source, 'global')
      assert.equal(skills.find((s) => s.name === 'repo-only').source, 'repo')
    })

    it('repo overrides global on filename collision (single entry, repo body wins)', () => {
      writeFileSync(join(globalDir, 'coding-style.md'), 'global coding style')
      writeFileSync(join(repoDir, 'coding-style.md'), 'repo coding style')

      const skills = loadActiveSkillsLayered({ globalDir, repoDir })
      assert.equal(skills.length, 1, 'should dedup by filename')
      assert.equal(skills[0].name, 'coding-style')
      assert.equal(skills[0].source, 'repo')
      assert.equal(skills[0].body, 'repo coding style')
    })

    it('repo overrides only the colliding entry, leaving non-colliding global skills intact', () => {
      writeFileSync(join(globalDir, 'a.md'), 'global a')
      writeFileSync(join(globalDir, 'shared.md'), 'global shared')
      writeFileSync(join(repoDir, 'shared.md'), 'repo shared')
      writeFileSync(join(repoDir, 'b.md'), 'repo b')

      const skills = loadActiveSkillsLayered({ globalDir, repoDir })
      assert.equal(skills.length, 3)
      const byName = Object.fromEntries(skills.map((s) => [s.name, s]))
      assert.equal(byName.a.source, 'global')
      assert.equal(byName.b.source, 'repo')
      assert.equal(byName.shared.source, 'repo')
      assert.equal(byName.shared.body, 'repo shared')
    })

    it('still excludes .disabled.md files in both tiers', () => {
      writeFileSync(join(globalDir, 'g.md'), 'global active')
      writeFileSync(join(globalDir, 'g-off.disabled.md'), 'global off')
      writeFileSync(join(repoDir, 'r.md'), 'repo active')
      writeFileSync(join(repoDir, 'r-off.disabled.md'), 'repo off')

      const skills = loadActiveSkillsLayered({ globalDir, repoDir })
      assert.equal(skills.length, 2)
      assert.deepEqual(skills.map((s) => s.name).sort(), ['g', 'r'])
    })

    it('does not double-count when globalDir === repoDir (treats as repo)', () => {
      // Edge case: a user pointing both env vars at the same path. We avoid
      // emitting the same file twice with conflicting `source` tags by
      // skipping the global pass and tagging everything 'repo'.
      writeFileSync(join(globalDir, 'one.md'), 'body')
      const skills = loadActiveSkillsLayered({ globalDir, repoDir: globalDir })
      assert.equal(skills.length, 1)
      assert.equal(skills[0].source, 'repo')
    })
  })
})
