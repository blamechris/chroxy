import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadActiveSkills, formatSkillsForPrompt } from '../src/skills-loader.js'

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
})
