import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadActiveSkills,
  loadActiveSkillsLayered,
  findRepoSkillsDir,
  formatSkillsForPrompt,
  parseFrontmatter,
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

    // ---------------------------------------------------------------------
    // #3088: walk-up must not return ~/.chroxy/skills (the global tier) as
    // a repo overlay. We point HOME at a temp dir and re-import the module
    // with a unique query string so DEFAULT_SKILLS_DIR / homedir() pick up
    // the fake home.
    // ---------------------------------------------------------------------
    describe('home-directory boundary (#3088)', () => {
      let fakeHome
      let originalHome
      let originalUserprofile

      beforeEach(() => {
        fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-home-'))
        originalHome = process.env.HOME
        originalUserprofile = process.env.USERPROFILE
        process.env.HOME = fakeHome
        process.env.USERPROFILE = fakeHome
      })

      afterEach(() => {
        if (originalHome === undefined) delete process.env.HOME
        else process.env.HOME = originalHome
        if (originalUserprofile === undefined) delete process.env.USERPROFILE
        else process.env.USERPROFILE = originalUserprofile
        rmSync(fakeHome, { recursive: true, force: true })
      })

      it('returns null when walk-up would otherwise hit ~/.chroxy/skills (global)', async () => {
        // Plant the global skills dir at the fake home.
        mkdirSync(join(fakeHome, '.chroxy', 'skills'), { recursive: true })

        // Re-import with a unique query string to force a fresh module
        // evaluation against the patched HOME env var.
        const mod = await import(`../src/skills-loader.js?home=${encodeURIComponent(fakeHome)}`)

        // Sanity: DEFAULT_SKILLS_DIR should now resolve under fakeHome.
        assert.equal(mod.DEFAULT_SKILLS_DIR, join(fakeHome, '.chroxy', 'skills'))

        // Session cwd is under $HOME but in a directory with no repo overlay.
        const sessionCwd = join(fakeHome, 'scratch', 'project')
        mkdirSync(sessionCwd, { recursive: true })

        assert.equal(mod.findRepoSkillsDir(sessionCwd), null)
      })

      it('still finds a real repo overlay nested under $HOME', async () => {
        const mod = await import(`../src/skills-loader.js?home2=${encodeURIComponent(fakeHome)}`)

        // No global skills planted; a project under $HOME has its own overlay.
        const project = join(fakeHome, 'code', 'my-app')
        mkdirSync(join(project, '.chroxy', 'skills'), { recursive: true })

        const nested = join(project, 'src', 'feature')
        mkdirSync(nested, { recursive: true })

        assert.equal(
          mod.findRepoSkillsDir(nested),
          join(project, '.chroxy', 'skills'),
        )
      })

      it('refuses to return DEFAULT_SKILLS_DIR even when cwd is exactly $HOME', async () => {
        mkdirSync(join(fakeHome, '.chroxy', 'skills'), { recursive: true })
        const mod = await import(`../src/skills-loader.js?home3=${encodeURIComponent(fakeHome)}`)

        assert.equal(mod.findRepoSkillsDir(fakeHome), null)
      })

      // #3098 review (Copilot): macOS HFS+/APFS and Windows NTFS are
      // case-insensitive by default. A path like `/Users/Bob/proj` resolves
      // equal to `/Users/bob/proj` on disk but unequal as strings, so the
      // HOME boundary check needs case-insensitive comparison to catch it.
      const isCaseInsensitivePlatform = process.platform === 'darwin' || process.platform === 'win32'
      it(
        'stops the walk at $HOME even when cwd disagrees in case (darwin/win32)',
        { skip: !isCaseInsensitivePlatform },
        async () => {
          // Plant the global skills dir at the fake home so a missed HOME
          // boundary would otherwise return it as a "repo overlay".
          mkdirSync(join(fakeHome, '.chroxy', 'skills'), { recursive: true })

          const mod = await import(`../src/skills-loader.js?case=${encodeURIComponent(fakeHome)}`)

          // Build a cwd that's equivalent to fakeHome on disk but uppercased
          // — on case-insensitive filesystems both paths name the same dir.
          // We can't actually mkdir an uppercased copy on the same volume
          // (would collide), so we just feed the uppercased string as cwd
          // and trust path.resolve preserves it; the boundary check is what
          // we're exercising, not the filesystem.
          const upperHome = fakeHome.toUpperCase()
          const sessionCwd = join(upperHome, 'scratch', 'project')

          assert.equal(
            mod.findRepoSkillsDir(sessionCwd),
            null,
            'walk-up should hit case-insensitive $HOME boundary and return null',
          )
        },
      )
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

  // -----------------------------------------------------------------------
  // #3201: symlink defense — realpath each candidate; reject escapes unless
  // they land under an explicit allowlist root.
  // -----------------------------------------------------------------------

  describe('symlink defense (#3201)', () => {
    let outsideDir
    beforeEach(() => {
      outsideDir = mkdtempSync(join(tmpdir(), 'chroxy-skills-outside-'))
    })
    afterEach(() => {
      rmSync(outsideDir, { recursive: true, force: true })
    })

    // Note: each test wraps `symlinkSync` in a try/catch + early-return so the
    // test silently skips on platforms where symlink creation is disallowed
    // (Windows CI without Developer Mode / admin). Repo precedent — see e.g.
    // packages/server/tests/file-ref-attachments.test.js:120.

    it('rejects a skill that is a symlink to a file outside the skills root', () => {
      const evilSource = join(outsideDir, 'evil.md')
      writeFileSync(evilSource, '# Evil\n\nLeaked from outside.\n')

      const linkPath = join(dir, 'evil.md')
      try { symlinkSync(evilSource, linkPath) } catch { return }

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 0, 'symlink to outside should be rejected')
    })

    it('accepts a symlink to a file within the skills root', () => {
      // Real file inside the dir, plus a symlink (also inside) pointing at it.
      const realPath = join(dir, 'real.md')
      writeFileSync(realPath, '# Real\n\nbody\n')

      const linkPath = join(dir, 'link.md')
      try { symlinkSync(realPath, linkPath) } catch { return }

      const skills = loadActiveSkills(dir)
      const names = skills.map((s) => s.name).sort()
      assert.deepEqual(names, ['link', 'real'])
    })

    it('accepts a symlink that resolves into an allowlisted root', () => {
      const sharedRoot = mkdtempSync(join(tmpdir(), 'chroxy-shared-skills-'))
      try {
        const sharedSkill = join(sharedRoot, 'community.md')
        writeFileSync(sharedSkill, '# Community skill\n\nshared body\n')

        const linkPath = join(dir, 'community.md')
        try { symlinkSync(sharedSkill, linkPath) } catch { return }

        // Without the allowlist, the symlink is rejected.
        const rejected = loadActiveSkills(dir)
        assert.equal(rejected.length, 0)

        // With the allowlist, it's accepted.
        const accepted = loadActiveSkills(dir, { allowedRoots: [sharedRoot] })
        assert.equal(accepted.length, 1)
        assert.equal(accepted[0].name, 'community')
        assert.equal(accepted[0].body, '# Community skill\n\nshared body\n')
      } finally {
        rmSync(sharedRoot, { recursive: true, force: true })
      }
    })

    it('rejects a symlink whose target was deleted (broken link)', () => {
      const evilSource = join(outsideDir, 'gone.md')
      writeFileSync(evilSource, 'temp')
      const linkPath = join(dir, 'gone.md')
      try { symlinkSync(evilSource, linkPath) } catch { return }
      rmSync(evilSource)

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 0)
    })
  })

  // -----------------------------------------------------------------------
  // #3203: markdown-only enforcement — extension allowlist, content sniffing,
  // vendored-directory skip list.
  // -----------------------------------------------------------------------

  describe('markdown-only enforcement (#3203)', () => {
    it('rejects files with a non-markdown extension by default', () => {
      writeFileSync(join(dir, 'evil.sh'), '#!/bin/sh\necho hi\n')
      writeFileSync(join(dir, 'note.txt'), 'plain text but wrong extension')
      writeFileSync(join(dir, 'good.md'), '# good')

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'good')
    })

    it('rejects a binary file even if it has a .md extension', () => {
      // First bytes contain a NUL — common signature for executables / images.
      const binaryContents = Buffer.concat([
        Buffer.from('# Looks markdown but ', 'utf8'),
        Buffer.from([0x00, 0x01, 0x02, 0x7f]),
        Buffer.from(' more', 'utf8'),
      ])
      writeFileSync(join(dir, 'binary.md'), binaryContents)
      writeFileSync(join(dir, 'fine.md'), '# Fine\n\nbody\n')

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'fine')
    })

    it('accepts UTF-8 markdown with multi-byte characters', () => {
      // 你好 (Chinese), café (latin-1 supplement), and an emoji — every byte
      // here is >= 0x80 and must NOT trip the binary detector.
      const body = '# 你好\n\nA café in 東京 — 🎉\n'
      writeFileSync(join(dir, 'unicode.md'), body)

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].body, body)
    })

    it('skips vendored-looking directories during scan', () => {
      // Create vendored dirs (each with a planted "skill" inside) plus a
      // legitimate top-level skill. The loader only looks at top-level files
      // anyway; this confirms the dirs are filtered out cleanly when listed.
      for (const name of ['.git', 'node_modules', '__pycache__', 'dist', 'build']) {
        mkdirSync(join(dir, name), { recursive: true })
        writeFileSync(join(dir, name, 'planted.md'), 'should not be loaded')
      }
      writeFileSync(join(dir, 'real.md'), '# real')

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 1, 'only the top-level real.md should load')
      assert.equal(skills[0].name, 'real')
    })

    it('honors a custom allowedExtensions list', () => {
      writeFileSync(join(dir, 'instructions.txt'), 'I am a text-format skill.\n')
      writeFileSync(join(dir, 'note.md'), '# Note')

      // Default: only .md
      const def = loadActiveSkills(dir)
      assert.deepEqual(def.map((s) => s.name).sort(), ['note'])

      // Custom: accept both .md and .txt — also confirms the leading-dot and
      // case variants are normalized away.
      const ext = loadActiveSkills(dir, { allowedExtensions: ['.MD', 'TXT'] })
      assert.deepEqual(ext.map((s) => s.name).sort(), ['instructions', 'note'])
    })

    it('still respects the disabled-suffix convention for custom extensions', () => {
      writeFileSync(join(dir, 'on.txt'), 'active')
      writeFileSync(join(dir, 'off.disabled.txt'), 'disabled')

      const skills = loadActiveSkills(dir, { allowedExtensions: ['txt'] })
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'on')
    })
  })

  // -----------------------------------------------------------------------
  // #3216: full-content sniff — reject NUL/control bytes anywhere in the
  // file, not just the first 512 bytes.
  // -----------------------------------------------------------------------

  describe('full-content sniff (#3216)', () => {
    it('rejects a 600-byte file with valid head and a NUL at offset 580', () => {
      // 580 bytes of valid ASCII markdown, NUL byte, then a trailing tail.
      // The legacy 512-byte sniff would have seen only printable text and
      // accepted it.
      const headStr = '# Looks fine\n\n' + 'a'.repeat(580 - '# Looks fine\n\n'.length)
      const headBytes = Buffer.from(headStr, 'utf8')
      assert.equal(headBytes.length, 580, 'head buffer setup')
      const tail = Buffer.concat([
        Buffer.from([0x00]),
        Buffer.from(' tail bytes past the legacy sniff window\n', 'utf8'),
      ])
      const full = Buffer.concat([headBytes, tail])
      assert.ok(full.length > 600, 'file should exceed 600 bytes')
      writeFileSync(join(dir, 'sneaky.md'), full)
      writeFileSync(join(dir, 'fine.md'), '# Fine')

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'fine')
    })

    it('rejects a control byte (0x01) past the 512-byte boundary', () => {
      const head = Buffer.from('# Heading\n\n' + 'a'.repeat(600), 'utf8')
      const evil = Buffer.concat([head, Buffer.from([0x01]), Buffer.from('\nmore\n', 'utf8')])
      writeFileSync(join(dir, 'late-control.md'), evil)

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 0)
    })

    it('still accepts large valid markdown (no control bytes anywhere)', () => {
      const body = '# ok\n\n' + 'word '.repeat(2000)
      writeFileSync(join(dir, 'big.md'), body)

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'big')
    })
  })

  // -----------------------------------------------------------------------
  // #3215: rejection warnings must not leak absolute paths through the
  // logger fan-out (warn → addLogListener → log_entry → paired clients).
  // -----------------------------------------------------------------------

  describe('rejection log sanitization (#3215)', () => {
    let originalWarn
    let warnLines

    beforeEach(() => {
      warnLines = []
      // The createLogger output goes through console.warn for warn-level.
      originalWarn = console.warn
      console.warn = (line) => { warnLines.push(String(line)) }
    })

    afterEach(() => {
      console.warn = originalWarn
    })

    it('warn output for a binary skill omits absolute path, includes basename + hash', () => {
      const binaryContents = Buffer.concat([
        Buffer.from('# Looks markdown but ', 'utf8'),
        Buffer.from([0x00, 0x01]),
      ])
      writeFileSync(join(dir, 'leaky.md'), binaryContents)

      loadActiveSkills(dir)

      assert.ok(warnLines.length > 0, 'expected at least one warn line')
      const joined = warnLines.join('\n')
      assert.ok(
        joined.includes('leaky.md#'),
        `expected basename#hash label in warn output, got:\n${joined}`,
      )
      assert.ok(
        !joined.includes(dir),
        `warn output must NOT include absolute path ${dir}, got:\n${joined}`,
      )
    })

    it('warn output for an oversized skill omits absolute path', () => {
      const big = Buffer.alloc(64 * 1024, 0x61) // 64KB of 'a'
      writeFileSync(join(dir, 'oversized.md'), big)

      loadActiveSkills(dir, { maxSkillBytes: 1024 })

      const joined = warnLines.join('\n')
      assert.ok(joined.includes('oversized.md#'), `expected sanitized label, got:\n${joined}`)
      assert.ok(!joined.includes(dir), `warn output must NOT include absolute path, got:\n${joined}`)
    })

    // Note: the realpath-fail warn path (`Skipping skill X: realpath failed
    // (CODE)`) was hardened in this round to surface only the error code,
    // not the embedded path that Node interpolates into `err.message`. The
    // path is hard to exercise deterministically — statSync usually fails
    // first on dangling/circular symlinks and short-circuits via the silent
    // continue. The fix is straightforward (`err.message` → `err.code`)
    // and verified by inspection in the diff.
  })

  // -----------------------------------------------------------------------
  // #3219: `markdown` extension is in the default allowlist alongside `md`.
  // -----------------------------------------------------------------------

  describe('default allowedExtensions includes markdown (#3219)', () => {
    it('loads .markdown files at default settings', () => {
      writeFileSync(join(dir, 'long-form.markdown'), '# Long form\n\nbody\n')
      writeFileSync(join(dir, 'short.md'), '# Short')

      const skills = loadActiveSkills(dir)
      const names = skills.map((s) => s.name).sort()
      assert.deepEqual(names, ['long-form', 'short'])
    })

    it('still excludes .disabled.markdown files', () => {
      writeFileSync(join(dir, 'on.markdown'), 'active')
      writeFileSync(join(dir, 'off.disabled.markdown'), 'disabled')

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'on')
    })
  })

  // -----------------------------------------------------------------------
  // #3202: per-skill cap and global skills budget.
  // -----------------------------------------------------------------------

  describe('size budgets (#3202)', () => {
    it('rejects a single skill that exceeds the per-skill cap', () => {
      const big = Buffer.alloc(40 * 1024, 0x61) // 40KB
      writeFileSync(join(dir, 'huge.md'), big)
      writeFileSync(join(dir, 'small.md'), '# small')

      const skills = loadActiveSkills(dir)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'small')
    })

    it('honors a custom maxSkillBytes', () => {
      writeFileSync(join(dir, 'a.md'), 'a'.repeat(2000)) // 2KB
      writeFileSync(join(dir, 'b.md'), 'b'.repeat(500))

      const tight = loadActiveSkills(dir, { maxSkillBytes: 1024 })
      assert.deepEqual(tight.map((s) => s.name), ['b'])

      const loose = loadActiveSkills(dir, { maxSkillBytes: 4096 })
      assert.deepEqual(loose.map((s) => s.name).sort(), ['a', 'b'])
    })

    it('drops lower-priority skills first when the global budget is exceeded', () => {
      // priority 10 → keep, priority 1 → drop. Bodies are sized so the pair
      // exceeds the budget but either alone fits.
      const fmHigh = '---\nname: high\npriority: 10\n---\n' + 'a'.repeat(2000)
      const fmLow = '---\nname: low\npriority: 1\n---\n' + 'b'.repeat(2000)

      writeFileSync(join(dir, 'high.md'), fmHigh)
      writeFileSync(join(dir, 'low.md'), fmLow)

      // Total budget 3KB — only one fits.
      const skills = loadActiveSkillsLayered({
        globalDir: dir,
        repoDir: null,
        maxTotalSkillBytes: 3 * 1024,
      })
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'high')
    })

    it('falls back to alphabetical order when no priority info is present', () => {
      writeFileSync(join(dir, 'alpha.md'), 'a'.repeat(2000))
      writeFileSync(join(dir, 'bravo.md'), 'b'.repeat(2000))

      const skills = loadActiveSkillsLayered({
        globalDir: dir,
        repoDir: null,
        maxTotalSkillBytes: 3 * 1024,
      })
      // Alphabetical tiebreaker — alpha wins, bravo is dropped.
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'alpha')
    })

    it('honors a custom maxTotalSkillBytes', () => {
      writeFileSync(join(dir, 'one.md'), 'x'.repeat(1500))
      writeFileSync(join(dir, 'two.md'), 'y'.repeat(1500))
      writeFileSync(join(dir, 'three.md'), 'z'.repeat(1500))

      // Default 256KB budget keeps all three.
      const wide = loadActiveSkillsLayered({ globalDir: dir, repoDir: null })
      assert.equal(wide.length, 3)

      // 2KB budget keeps just one (alphabetical wins).
      const tight = loadActiveSkillsLayered({
        globalDir: dir,
        repoDir: null,
        maxTotalSkillBytes: 2 * 1024,
      })
      assert.equal(tight.length, 1)
      assert.equal(tight[0].name, 'one')
    })
  })

  // -----------------------------------------------------------------------
  // #3197: YAML frontmatter parser. Adds `metadata` to every loaded Skill.
  // -----------------------------------------------------------------------

  describe('parseFrontmatter (#3197)', () => {
    it('returns null metadata for empty / non-string input', () => {
      assert.deepEqual(parseFrontmatter(''), { frontmatter: null, body: '' })
      assert.deepEqual(parseFrontmatter(null), { frontmatter: null, body: '' })
      assert.deepEqual(parseFrontmatter(undefined), { frontmatter: null, body: '' })
    })

    it('returns null metadata when body has no frontmatter (back-compat with v1)', () => {
      const text = '# A heading\n\nbody only\n'
      const out = parseFrontmatter(text)
      assert.equal(out.frontmatter, null)
      assert.equal(out.body, text)
    })

    it('parses scalar fields', () => {
      const text = '---\nname: my-skill\ndescription: short text\nversion: "1.0"\npriority: 5\n---\n# body\n'
      const out = parseFrontmatter(text)
      assert.deepEqual(out.frontmatter, {
        name: 'my-skill',
        description: 'short text',
        version: '1.0',
        priority: 5,
      })
      assert.equal(out.body, '# body\n')
    })

    it('parses inline list values', () => {
      const text = "---\nallowed-tools: [Read, Edit, Bash]\nproviders: ['claude', 'codex']\n---\nbody\n"
      const out = parseFrontmatter(text)
      assert.deepEqual(out.frontmatter['allowed-tools'], ['Read', 'Edit', 'Bash'])
      assert.deepEqual(out.frontmatter.providers, ['claude', 'codex'])
    })

    it('parses indented list values', () => {
      const text = '---\nallowed-tools:\n  - Read\n  - Edit\n  - Bash\nname: x\n---\nbody\n'
      const out = parseFrontmatter(text)
      assert.deepEqual(out.frontmatter['allowed-tools'], ['Read', 'Edit', 'Bash'])
      assert.equal(out.frontmatter.name, 'x')
    })

    it('drops unknown keys silently', () => {
      const text = '---\nname: x\nbogus: should-be-dropped\n---\nbody\n'
      const out = parseFrontmatter(text)
      assert.equal(out.frontmatter.name, 'x')
      assert.equal(out.frontmatter.bogus, undefined)
    })

    it('returns null metadata for malformed frontmatter (no crash)', () => {
      // Missing closing fence — treat as no frontmatter.
      const text = '---\nname: x\nbody never closes the fence\n'
      const out = parseFrontmatter(text)
      assert.equal(out.frontmatter, null)
      assert.equal(out.body, text)
    })

    it('returns null metadata when a value cannot be parsed', () => {
      // priority must be numeric.
      const text = '---\nname: x\npriority: not-a-number\n---\nbody\n'
      const out = parseFrontmatter(text)
      assert.equal(out.frontmatter, null)
    })

    it('partial frontmatter (only one known key) parses', () => {
      const text = '---\nname: just-a-name\n---\nbody\n'
      const out = parseFrontmatter(text)
      assert.deepEqual(out.frontmatter, { name: 'just-a-name' })
      assert.equal(out.body, 'body\n')
    })

    // Regression for the Copilot review on PR #3220: the inline-comment
    // stripper was not quote-aware. A value like `description: "Fix issue
    // #123"` contains a ` #` sequence INSIDE the quoted string, so the old
    // stripper truncated to `"Fix issue` and returned malformed metadata.
    it('preserves "#" inside double-quoted values (no false-positive comment strip)', () => {
      const text = '---\nname: x\ndescription: "Fix issue #123 in repo"\n---\nbody\n'
      const out = parseFrontmatter(text)
      assert.deepEqual(out.frontmatter, { name: 'x', description: 'Fix issue #123 in repo' })
    })

    it('preserves "#" inside single-quoted values', () => {
      const text = "---\nname: 'C# tips'\ndescription: 'short'\n---\nbody\n"
      const out = parseFrontmatter(text)
      assert.deepEqual(out.frontmatter, { name: 'C# tips', description: 'short' })
    })

    it('strips an actual trailing comment after whitespace + # outside quotes', () => {
      const text = '---\nname: foo  # this is a comment\ndescription: bar\n---\nbody\n'
      const out = parseFrontmatter(text)
      assert.deepEqual(out.frontmatter, { name: 'foo', description: 'bar' })
    })
  })

  describe('skill metadata field (#3197 integration)', () => {
    it('attaches metadata: null when no frontmatter', () => {
      writeFileSync(join(dir, 'plain.md'), '# Plain\n\nbody\n')
      const [skill] = loadActiveSkills(dir)
      assert.equal(skill.metadata, null)
      // body unchanged when no frontmatter
      assert.equal(skill.body, '# Plain\n\nbody\n')
    })

    it('attaches parsed metadata and strips frontmatter from body', () => {
      const text = '---\nname: coding-style\npriority: 7\n---\n# Coding style\n\nUse single quotes.\n'
      writeFileSync(join(dir, 'coding-style.md'), text)

      const [skill] = loadActiveSkills(dir)
      assert.deepEqual(skill.metadata, { name: 'coding-style', priority: 7 })
      assert.equal(skill.body, '# Coding style\n\nUse single quotes.\n')
      assert.equal(skill.description, '# Coding style')
    })

    it('falls back to metadata: null on malformed frontmatter, keeps full body', () => {
      const text = '---\nname: bad\npriority: not-a-number\n---\nbody\n'
      writeFileSync(join(dir, 'bad.md'), text)

      const [skill] = loadActiveSkills(dir)
      assert.equal(skill.metadata, null)
      // body keeps the raw frontmatter when parsing fails — still loads
      assert.ok(skill.body.includes('not-a-number'))
    })
  })
})
