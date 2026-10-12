import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { constants as fsConstants, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  boundedInstructionIdentity,
  compileInstructionPolicy,
  discoverByokInstructionSources,
  inspectInstructionSource,
  loadByokInstructionPolicy,
  readRegularInstructionFile,
} from '../src/instruction-policy.js'
import { openNoFollow } from '../src/ws-file-ops/open-nofollow.js'
import {
  normalizeWindowsFinalPath,
  parseLsofOpenedFilePath,
  resolveOpenedFilePath,
} from '../src/utils/opened-file-path.js'
import { BYOK_SESSION_LOCAL_OPT_KEYS, ClaudeByokSession, buildByokSessionOpts } from '../src/byok-session.js'
import { createAnthropicCompatibleSessionClass } from '../src/anthropic-compatible-session.js'
import { createOpenAiCompatibleSessionClass } from '../src/openai-compatible-session.js'
import { CliSession } from '../src/cli-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { GeminiSession } from '../src/gemini-session.js'
import { SessionManager } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'
import { withEnv } from './test-helpers.js'

const marked = (id, text = 'required text') =>
  `<!-- chroxy-required-rule:start ${id} -->\n${text}\n<!-- chroxy-required-rule:end ${id} -->`

describe('instruction policy compiler', () => {
  it('keeps hashed identities distinct from readable hash-shaped path literals', () => {
    const unsafe = 'café'
    const literal = `sha256-${createHash('sha256').update(unsafe).digest('hex')}`
    const unsafeId = boundedInstructionIdentity('native', unsafe)
    const literalId = boundedInstructionIdentity('native', literal)
    assert.notEqual(unsafeId, literalId)
    assert.match(unsafeId, /^native:sha256-[a-f0-9]{64}$/)
    assert.match(literalId, /^native:sha256-[a-f0-9]{64}$/)
    const longNamespaceId = boundedInstructionIdentity('n'.repeat(128), unsafe)
    assert.match(longNamespaceId, /^identity:sha256-[a-f0-9]{64}$/)
    assert.ok(longNamespaceId.length <= 128)
    assert.equal(boundedInstructionIdentity('project', 'nested/AGENTS.md'), 'project:nested/AGENTS.md')
    assert.throws(() => boundedInstructionIdentity('project', 'bad\0path'), /portable text/)
  })

  it('rejects every unpaired surrogate while accepting pairs and whitespace', () => {
    for (const text of ['\uD800', '\uD801', '\uDBFF', '\uDC00', '\uDFFF']) {
      assert.throws(() => inspectInstructionSource({ id: 'bad', text }), /invalid UTF-16/)
    }
    assert.equal(inspectInstructionSource({ id: 'astral', text: '\uD83D\uDE80' }).requiredRuleIds[0], 'astral')
    assert.equal(inspectInstructionSource({ id: 'space', text: ' \n\t' }).requiredRuleIds[0], 'space')
  })

  it('validates target reserves, count, and duplicate ids without coercion', () => {
    const source = [{ id: 'one', text: 'x' }]
    const valid = compileInstructionPolicy({
      sources: source,
      targets: [{ id: 'valid', budgetBytes: 1024, reservedBytes: 1, requiredRuleIds: ['one'] }],
    })
    assert.equal(valid.valid.budgetBytes, 1024)
    for (const reservedBytes of [-1, 1.5, '1']) {
      assert.throws(() => compileInstructionPolicy({
        sources: source,
        targets: [{ id: 'bad', budgetBytes: 1024, reservedBytes, requiredRuleIds: ['one'] }],
      }), /invalid reserved byte count/)
    }
    assert.throws(() => compileInstructionPolicy({
      sources: source,
      targets: [
        { id: 'same', budgetBytes: 1024, requiredRuleIds: ['one'] },
        { id: 'same', budgetBytes: 1024, requiredRuleIds: ['one'] },
      ],
    }), /duplicate target id 'same'/)
    assert.throws(() => compileInstructionPolicy({
      sources: source,
      targets: Array.from({ length: 33 }, (_, index) => ({ id: `t${index}`, budgetBytes: 1024, requiredRuleIds: ['one'] })),
    }), /target count exceeds 32/)
  })

  it('recognizes standalone fleet classifications and returns exact per-rule ends', () => {
    const text = [
      '# Fleet',
      '<!--default:precedence-->', 'default body',
      '<!--floor:no-agent-attribution-->', 'floor one',
      '<!--floor:explicit-path-staging-->', 'floor two',
      '<!--floor:worktree-by-default-->', 'floor three',
      '<!--floor:no-secrets-in-committed-files-->', 'floor four',
      '<!--floor:seed-written-outside-any-worktree-->', 'floor five',
    ].join('\n')
    const inspected = inspectInstructionSource({ id: 'machine:fleet', text })
    assert.deepEqual(inspected.requiredRuleIds, [
      'precedence', 'no-agent-attribution', 'explicit-path-staging', 'worktree-by-default',
      'no-secrets-in-committed-files', 'seed-written-outside-any-worktree',
    ])
    const result = compileInstructionPolicy({
      sources: [{ id: 'machine:fleet', text }],
      targets: [{ id: 'api', budgetBytes: 8192, requiredRuleIds: inspected.requiredRuleIds }],
    }).api
    assert.deepEqual(result.rules.map(rule => rule.id), inspected.requiredRuleIds)
    for (let index = 0; index < result.rules.length; index++) {
      const next = inspected.rules[index + 1]
      const relativeEnd = next?.startByte ?? Buffer.byteLength(text)
      const sourceStart = result.sources[0].endByte - Buffer.byteLength(text)
      assert.equal(result.rules[index].endByte, sourceStart + relativeEnd)
    }
    assert.equal(result.enforcement, 'instructional')
  })

  it('preserves UTF-8 source order and returns bounded metadata', () => {
    const result = compileInstructionPolicy({
      sources: [{ id: 'one', text: marked('alpha', 'café') }, { id: 'two', text: 'plain' }],
      targets: [{ id: 'api', budgetBytes: 4096, requiredRuleIds: ['alpha', 'two'] }],
    }).api
    assert.ok(result.text.indexOf('café') < result.text.indexOf('plain'))
    assert.deepEqual(result.includedRequiredRuleIds, ['alpha', 'two'])
    assert.equal(result.totalBytes, Buffer.byteLength(result.text, 'utf8'))
    assert.equal(result.sources.at(-1).endByte, result.totalBytes)
  })

  it('rejects zero inputs and malformed required blocks', () => {
    assert.throws(() => compileInstructionPolicy({ sources: [], targets: [] }), /at least one source/)
    assert.throws(() => compileInstructionPolicy({ sources: [{ id: 'one', text: 'x' }], targets: [] }), /at least one target/)
    assert.throws(() => compileInstructionPolicy({ sources: [{ id: 'one', text: 'x' }], targets: [{ id: 't', budgetBytes: 10, requiredRuleIds: [] }] }), /at least one rule/)
    assert.throws(() => compileInstructionPolicy({ sources: [{ id: 'one', text: 'x' }], targets: [{ id: 't', budgetBytes: 10, reservedBytes: -1, requiredRuleIds: ['one'] }] }), /invalid reserved byte count/)
    assert.throws(() => compileInstructionPolicy({ sources: [{ id: 'one', text: '<!-- chroxy-required-rule:start a -->\nx' }], targets: [{ id: 't', budgetBytes: 99, requiredRuleIds: ['a'] }] }), /incomplete/)
    assert.throws(() => compileInstructionPolicy({ sources: [{ id: 'one', text: `${marked('a')}\n${marked('a')}` }], targets: [{ id: 't', budgetBytes: 999, requiredRuleIds: ['a'] }] }), /duplicates required rule/)
    assert.throws(() => compileInstructionPolicy({ sources: [{ id: 'one', text: marked('a') }], targets: [{ id: 't', budgetBytes: 999, requiredRuleIds: ['missing'] }] }), /missing required rule 'missing'/)
  })

  it('fails legibly when a complete late required rule crosses the byte budget', () => {
    assert.throws(() => compileInstructionPolicy({
      sources: [{ id: 'root', text: marked('first') }, { id: 'nested', text: marked('late', 'é'.repeat(100)) }],
      targets: [{ id: 'small', budgetBytes: 620, requiredRuleIds: ['first', 'late'] }],
    }), /target 'small'.*source 'nested'.*required rule 'late'/)
  })

  it('treats the exact UTF-8 byte boundary as inclusive', () => {
    // Keep the probe and boundary budgets in the same decimal-width band so
    // changing the budget cannot change the serialized metadata length.
    const sources = [{ id: 'wide', text: 'é'.repeat(800) }]
    const probe = compileInstructionPolicy({
      sources,
      targets: [{ id: 'probe', budgetBytes: 4096, requiredRuleIds: ['wide'] }],
    }).probe
    assert.doesNotThrow(() => compileInstructionPolicy({
      sources,
      targets: [{ id: 'probe', budgetBytes: probe.totalBytes, requiredRuleIds: ['wide'] }],
    }))
    assert.throws(() => compileInstructionPolicy({
      sources,
      targets: [{ id: 'probe', budgetBytes: probe.totalBytes - 1, requiredRuleIds: ['wide'] }],
    }), /exceeds/)
  })
})

describe('BYOK instruction discovery', () => {
  it('resolves the actual opened descriptor path and fails closed on malformed probe output', async () => {
    assert.equal(
      parseLsofOpenedFilePath('p42\0\nf7\0n/tmp/opened file\0\n', { pid: 42, fd: 7 }),
      '/tmp/opened file',
    )
    for (const stdout of [
      'p41\0\nf7\0n/tmp/file\0\n',
      'p42\0\nf8\0n/tmp/file\0\n',
      'p42\0\nf7\0',
      `p42\0\nf7\0n/${'x'.repeat(64 * 1024)}\0\n`,
    ]) {
      await assert.rejects(
        resolveOpenedFilePath(7, {
          platform: 'darwin',
          pid: 42,
          runProbe: async () => ({ stdout, stderr: '' }),
        }),
        /opened-file identity probe/,
      )
    }
    await assert.rejects(
      resolveOpenedFilePath(7, {
        platform: 'darwin',
        pid: 42,
        runProbe: async () => { throw new Error('utility unavailable') },
      }),
      /utility unavailable/,
    )
    await assert.rejects(resolveOpenedFilePath(7, { platform: 'unsupported' }), /no supported opened-file path query/)
    assert.equal(normalizeWindowsFinalPath('\\\\?\\C:\\Repo\\AGENTS.md'), 'C:\\Repo\\AGENTS.md')
    assert.equal(normalizeWindowsFinalPath('\\\\?\\UNC\\server\\share\\AGENTS.md'), '\\\\server\\share\\AGENTS.md')
    assert.equal(normalizeWindowsFinalPath('\\\\?\\unc\\Server\\Share\\AGENTS.md'), '\\\\Server\\Share\\AGENTS.md')

    let windowsProbe
    assert.equal(await resolveOpenedFilePath(7, {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      runProbe: async (...args) => {
        windowsProbe = args
        return { stdout: '\\\\?\\C:\\Repo\\AGENTS.md', stderr: '' }
      },
    }), 'C:\\Repo\\AGENTS.md')
    assert.deepEqual(windowsProbe[1].slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    assert.equal(windowsProbe[1].includes('-ExecutionPolicy'), false)
    assert.equal(windowsProbe[2].stdio[0], 7)
  })

  it('reads an ordinary source only after the host proves the opened descriptor path', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-policy-opened-positive-')))
    try {
      const path = join(root, 'AGENTS.md')
      writeFileSync(path, 'OPENED FILE POSITIVE')
      assert.equal(await readRegularInstructionFile(path, { instructionRoot: root }), 'OPENED FILE POSITIVE')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('accepts the actual Windows opened descriptor across canonical temp-path spelling and case', {
    skip: process.platform !== 'win32' ? 'requires the Windows handle query' : false,
  }, async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-policy-opened-win-')))
    let handle
    try {
      const path = join(root, 'AGENTS.md')
      writeFileSync(path, 'WINDOWS OPENED FILE POSITIVE')
      const expectedPath = realpathSync.native(path)
      handle = await openNoFollow(path, fsConstants.O_RDONLY)
      const openedPath = await resolveOpenedFilePath(handle.fd)
      assert.equal(openedPath.toLowerCase(), expectedPath.toLowerCase())
      assert.equal(
        await readRegularInstructionFile(path.toUpperCase(), {
          instructionRoot: root,
          expectedPath,
        }),
        'WINDOWS OPENED FILE POSITIVE',
      )
    } finally {
      await handle?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a restored-parent swap by the opened descriptor path before client construction', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-policy-parent-swap-')))
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-policy-parent-outside-')))
    const parentPath = join(root, 'nested')
    const parked = join(root, 'nested-safe')
    let swaps = 0
    mkdirSync(parentPath)
    writeFileSync(join(parentPath, 'AGENTS.md'), 'SAFE POLICY')
    writeFileSync(join(outside, 'AGENTS.md'), 'OFFROOT SENTINEL')
    const parent = realpathSync.native(parentPath)
    const candidate = realpathSync.native(join(parent, 'AGENTS.md'))

    const swappingOpen = async (path, flags) => {
      const isCandidate = process.platform === 'win32'
        ? path.toLowerCase() === candidate.toLowerCase()
        : path === candidate
      if (!isCandidate) return openNoFollow(path, flags)
      swaps++
      renameSync(parent, parked)
      symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
      let handle
      try {
        handle = await openNoFollow(path, flags)
      } finally {
        rmSync(parent)
        renameSync(parked, parent)
      }
      return handle
    }
    const load = opts => loadByokInstructionPolicy({
      ...opts,
      resolveRepoRoot: async () => root,
      openFile: swappingOpen,
    })
    try {
      const safeSources = await discoverByokInstructionSources({
        cwd: parent,
        machinePath: null,
        resolveRepoRoot: async () => root,
      })
      assert.deepEqual(safeSources.map(source => source.text), ['SAFE POLICY'])
      await assert.rejects(
        discoverByokInstructionSources({
          cwd: parent,
          machinePath: null,
          resolveRepoRoot: async () => root,
          openFile: swappingOpen,
        }),
        /opened outside its verified instruction path/,
      )
      assert.equal(swaps, 1)
      assert.equal(readFileSync(candidate, 'utf8'), 'SAFE POLICY')

      const session = new ClaudeByokSession({
        cwd: parent,
        _instructionPolicyLoader: load,
        _machineInstructionPath: null,
      })
      await assert.rejects(session.start(), /opened outside its verified instruction path/)
      assert.equal(swaps, 2)
      assert.equal(session._client, null)
      await session.destroy()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rechecks the opened descriptor path after the positional read', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-policy-opened-recheck-')))
    const expected = join(root, 'AGENTS.md')
    const outside = join(tmpdir(), 'outside-AGENTS.md')
    writeFileSync(expected, 'safe')
    const expectedReal = realpathSync.native(expected)
    let probe = 0
    const handle = {
      fd: 9,
      async stat() { return { isFile: () => true, size: 4 } },
      async read(buffer, offset, length, position) {
        assert.equal(position, offset)
        if (offset !== 0) return { bytesRead: 0 }
        Buffer.from('safe').copy(buffer, offset, 0, length)
        return { bytesRead: 4 }
      },
      async close() {},
    }
    try {
      await assert.rejects(
        readRegularInstructionFile(expected, {
          instructionRoot: root,
          openFile: async () => handle,
          resolveOpenedPath: async () => ++probe === 1 ? expectedReal : outside,
        }),
        /opened outside its verified instruction path/,
      )
      assert.equal(probe, 2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('loads machine, root, then nested authored sources and compiles them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chroxy-policy-'))
    try {
      const nested = join(root, 'packages', 'app')
      mkdirSync(nested, { recursive: true })
      const machine = join(root, 'fleet.md')
      writeFileSync(machine, 'machine')
      writeFileSync(join(root, 'AGENTS.md'), marked('root-rule'))
      writeFileSync(join(root, 'packages', 'AGENTS.md'), 'nested')
      const sources = await discoverByokInstructionSources({ cwd: nested, machinePath: machine, machineRoot: root, resolveRepoRoot: async () => root })
      assert.deepEqual(sources.map(({ id }) => id), ['machine:fleet', 'project:AGENTS.md', 'project:packages/AGENTS.md'])
      const projection = await loadByokInstructionPolicy({ cwd: nested, machinePath: machine, machineRoot: root, resolveRepoRoot: async () => root })
      assert.ok(projection.text.indexOf('machine') < projection.text.indexOf('root-rule'))
      assert.ok(projection.text.indexOf('root-rule') < projection.text.indexOf('nested'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('uses bounded stable identities for real space, Unicode, and long nested paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chroxy-policy-paths-'))
    try {
      const parts = ['My App', 'café', 'nested-' + 'x'.repeat(90)]
      let directory = root
      writeFileSync(join(root, 'AGENTS.md'), 'ROOT PATH POLICY')
      for (const [index, part] of parts.entries()) {
        directory = join(directory, part)
        mkdirSync(directory)
        writeFileSync(join(directory, 'AGENTS.md'), `NESTED PATH POLICY ${index}`)
      }
      const sources = await discoverByokInstructionSources({
        cwd: directory,
        machinePath: null,
        resolveRepoRoot: async () => root,
      })
      assert.equal(sources[0].id, 'project:AGENTS.md')
      assert.equal(new Set(sources.map(source => source.id)).size, sources.length)
      for (const source of sources) {
        assert.match(source.id, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
        assert.ok(source.id.length <= 128)
      }
      assert.ok(sources.slice(1).every(source => source.id.startsWith('project:sha256-')))
      assert.deepEqual(sources.map(source => source.text), [
        'ROOT PATH POLICY', 'NESTED PATH POLICY 0', 'NESTED PATH POLICY 1', 'NESTED PATH POLICY 2',
      ])
      const projection = await loadByokInstructionPolicy({
        cwd: directory,
        machinePath: null,
        resolveRepoRoot: async () => root,
      })
      assert.deepEqual(projection.includedRequiredRuleIds, sources.map(source => source.id))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('preserves a UTF-8 BOM in delivered bytes, hashes, and bounds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chroxy-policy-bom-'))
    try {
      const raw = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(marked('bom-rule', 'BOM POLICY'), 'utf8'),
      ])
      writeFileSync(join(root, 'AGENTS.md'), raw)
      const sources = await discoverByokInstructionSources({
        cwd: root,
        machinePath: null,
        resolveRepoRoot: async () => root,
      })
      assert.equal(sources[0].text.charCodeAt(0), 0xfeff)
      assert.deepEqual(Buffer.from(sources[0].text, 'utf8'), raw)
      assert.deepEqual(inspectInstructionSource(sources[0]).requiredRuleIds, ['bom-rule'])
      const projection = await loadByokInstructionPolicy({
        cwd: root,
        machinePath: null,
        resolveRepoRoot: async () => root,
      })
      assert.equal(projection.sources[0].bytes, raw.length)
      assert.equal(projection.sources[0].sha256, createHash('sha256').update(raw).digest('hex'))
      assert.ok(projection.text.endsWith(sources[0].text))
      assert.equal(projection.sources[0].endByte, projection.totalBytes)
      assert.equal(projection.totalBytes, Buffer.byteLength(projection.text, 'utf8'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reports no source honestly and refuses symlinks and discovery overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chroxy-policy-empty-'))
    try {
      assert.equal(await loadByokInstructionPolicy({ cwd: root, machinePath: join(root, 'missing'), machineRoot: root, resolveRepoRoot: async () => root }), null)
      writeFileSync(join(root, 'target'), 'secret')
      symlinkSync(join(root, 'target'), join(root, 'AGENTS.md'))
      await assert.rejects(
        discoverByokInstructionSources({ cwd: root, machinePath: null, resolveRepoRoot: async () => root }),
        /uses a symlink|escapes its instruction root/,
      )
      rmSync(join(root, 'AGENTS.md'))
      writeFileSync(join(root, 'AGENTS.override.md'), 'override')
      await assert.rejects(discoverByokInstructionSources({ cwd: root, machinePath: null, resolveRepoRoot: async () => root }), /unsupported discovery override/)
      rmSync(join(root, 'AGENTS.override.md'))
      mkdirSync(join(root, '.codex'))
      writeFileSync(join(root, '.codex', 'config.toml'), 'project_doc_max_bytes = 1')
      await assert.rejects(discoverByokInstructionSources({ cwd: root, machinePath: null, resolveRepoRoot: async () => root }), /unsupported discovery config/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('refuses a FIFO promptly instead of blocking on read', {
    skip: process.platform === 'win32' ? 'POSIX FIFOs are unavailable on win32' : false,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'chroxy-policy-fifo-'))
    try {
      const made = spawnSync('mkfifo', [join(root, 'AGENTS.md')], { timeout: 1000 })
      assert.equal(made.status, 0, made.stderr?.toString())
      let timer
      try {
        await assert.rejects(
          Promise.race([
            discoverByokInstructionSources({ cwd: root, machinePath: null, resolveRepoRoot: async () => root }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('FIFO check timed out')), 1000) }),
          ]),
          /not a regular file/,
        )
      } finally { clearTimeout(timer) }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('uses bounded reads and refuses malformed UTF-8 and parent symlinks', async () => {
    const fakeHandle = {
      async stat() { return { isFile: () => true, size: 0 } },
      async read(buffer, offset, length) {
        const bytes = Buffer.from('12345').subarray(offset, offset + length)
        bytes.copy(buffer, offset)
        return { bytesRead: bytes.length }
      },
      async close() {},
    }
    await assert.rejects(
      readRegularInstructionFile('/virtual/growing', { maxBytes: 4, openFile: async () => fakeHandle }),
      /grew beyond 4 bytes/,
    )

    const root = mkdtempSync(join(tmpdir(), 'chroxy-policy-bad-source-'))
    const outside = mkdtempSync(join(tmpdir(), 'chroxy-policy-outside-'))
    try {
      writeFileSync(join(root, 'AGENTS.md'), Buffer.from([0xff, 0xfe]))
      await assert.rejects(
        discoverByokInstructionSources({ cwd: root, machinePath: null, resolveRepoRoot: async () => root }),
        /not valid UTF-8/,
      )
      rmSync(join(root, 'AGENTS.md'))
      writeFileSync(join(outside, 'AGENTS.md'), 'redirected')
      symlinkSync(outside, join(root, '.fleet'))
      await assert.rejects(
        discoverByokInstructionSources({
          cwd: root,
          machineRoot: root,
          machinePath: join(root, '.fleet', 'AGENTS.md'),
          resolveRepoRoot: async () => root,
        }),
        /escapes its instruction root|uses a symlink/,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('discovers current-directory rules outside Git and propagates Git failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chroxy-policy-no-git-'))
    try {
      writeFileSync(join(root, 'AGENTS.md'), 'current directory policy')
      const sources = await discoverByokInstructionSources({ cwd: root, machinePath: null })
      assert.deepEqual(sources.map(source => source.id), ['project:AGENTS.md'])
      await assert.rejects(
        discoverByokInstructionSources({
          cwd: root,
          machinePath: null,
          resolveRepoRoot: async () => { throw Object.assign(new Error('git tool unavailable'), { code: 'ENOENT' }) },
        }),
        /git tool unavailable/,
      )
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('discovers root and nested rules from a linked worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chroxy-policy-git-'))
    const linked = mkdtempSync(join(tmpdir(), 'chroxy-policy-worktree-'))
    rmSync(linked, { recursive: true, force: true })
    try {
      const run = (args) => spawnSync('git', args, {
        cwd: root, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
      })
      assert.equal(run(['init', '--quiet']).status, 0)
      writeFileSync(join(root, 'AGENTS.md'), 'root policy')
      assert.equal(run(['add', 'AGENTS.md']).status, 0)
      assert.equal(run(['commit', '--quiet', '-m', 'fixture']).status, 0)
      assert.equal(run(['worktree', 'add', '--quiet', '-b', 'fixture-linked', linked]).status, 0)
      const nested = join(linked, 'nested')
      mkdirSync(nested)
      writeFileSync(join(nested, 'AGENTS.md'), 'nested policy')
      const sources = await discoverByokInstructionSources({ cwd: nested, machinePath: null })
      assert.deepEqual(sources.map(source => source.id), ['project:AGENTS.md', 'project:nested/AGENTS.md'])
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', linked], { cwd: root, timeout: 5000 })
      rmSync(root, { recursive: true, force: true })
      rmSync(linked, { recursive: true, force: true })
    }
  })
})

describe('BYOK startup consumer', () => {
  it('preserves the independently enumerated BYOK-local options through compatible factories', () => {
    const expectedLocalKeys = [
      'mcpConfigPath',
      'disabledMcpServers',
      'mcpToolCallTimeoutMs',
      'mcpStartCapMs',
      '_mcpConfigFsync',
      'loadProjectInstructions',
      '_instructionPolicyLoader',
      '_machineInstructionPath',
      '_machineInstructionRoot',
    ]
    assert.deepEqual(BYOK_SESSION_LOCAL_OPT_KEYS, expectedLocalKeys)

    const values = Object.fromEntries(expectedLocalKeys.map((key, index) => [key, index]))
    const forwarded = buildByokSessionOpts(values)
    for (const key of expectedLocalKeys) assert.equal(forwarded[key], values[key], key)

    const OpenAiCompatible = createOpenAiCompatibleSessionClass({
      id: 'instruction-openai-delegation',
      baseUrl: 'http://127.0.0.1:1/v1',
      defaultModel: 'fixture-model',
    })
    const delegated = new OpenAiCompatible({
      cwd: tmpdir(),
      mcpConfigPath: null,
      loadProjectInstructions: true,
    })
    assert.equal(delegated._loadProjectInstructions, true)
    assert.deepEqual(delegated.mcpServers, [])
    delegated.destroy()
  })

  it('does not deliver Chroxy-compiled project policy to native drivers', () => {
    const nativeDrivers = [CliSession, SdkSession, ClaudeTuiSession, CodexAppServerSession, GeminiSession]
    for (const Driver of nativeDrivers) {
      const session = new Driver({
        cwd: tmpdir(),
        loadProjectInstructions: true,
        _instructionPolicyLoader: async () => { throw new Error('native driver invoked BYOK compiler') },
      })
      assert.equal(session.projectInstructions, '', Driver.name)
      assert.equal(session.providerInstructionProjection.status, 'unknown', Driver.name)
      assert.ok(!Driver.customizationDescriptor.chroxyChannels.some(
        channel => channel.content.includes('project-instructions'),
      ), Driver.name)
    }
  })

  it('installs verified policy before preamble/hint/skills and sends it on every API turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chroxy-policy-start-'))
    try {
      const nested = join(root, 'packages', 'app')
      mkdirSync(nested, { recursive: true })
      const machine = join(root, 'fleet.md')
      writeFileSync(machine, marked('machine-rule', 'MACHINE POLICY'))
      writeFileSync(join(root, 'AGENTS.md'), marked('root-rule', 'ROOT POLICY'))
      writeFileSync(join(root, 'packages', 'AGENTS.md'), marked('nested-rule', 'NESTED POLICY'))
      const calls = []
      const session = new ClaudeByokSession({
        cwd: nested, sessionPreamble: 'PREAMBLE',
        _instructionPolicyLoader: opts => loadByokInstructionPolicy({ ...opts, resolveRepoRoot: async () => root }),
        _machineInstructionPath: machine,
        _machineInstructionRoot: root,
      })
      session._client = { messages: { stream: (args) => {
        calls.push(args)
        return {
          async *[Symbol.asyncIterator]() {},
          async finalMessage() { return { stop_reason: 'end_turn', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
        }
      } } }
      await session.start()
      await session.sendMessage('one')
      await session.sendMessage('two')
      assert.equal(calls.length, 2)
      for (const call of calls) {
        assert.ok(/chroxy-instruction-policy compiler=1/.test(call.system))
        assert.ok(call.system.indexOf('MACHINE POLICY') < call.system.indexOf('ROOT POLICY'))
        assert.ok(call.system.indexOf('ROOT POLICY') < call.system.indexOf('NESTED POLICY'))
        assert.ok(call.system.indexOf('NESTED POLICY') < call.system.indexOf('PREAMBLE'))
      }
      assert.equal(session.providerInstructionProjection.status, 'delivered')
      assert.deepEqual(session.providerInstructionProjection.includedRequiredRuleIds, [
        'machine-rule', 'root-rule', 'nested-rule',
      ])
      await session.destroy()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('delivers authored policy from SessionManager through a configured compatible HTTP request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chroxy-policy-manager-'))
    const home = join(root, 'home')
    const project = join(root, 'project')
    const configDir = join(root, 'config')
    const mcpConfigPath = join(root, 'empty-mcp.json')
    mkdirSync(home)
    mkdirSync(project)
    mkdirSync(configDir)
    const source = marked('compatible-manager-rule', 'MANAGER COMPATIBLE POLICY')
    writeFileSync(join(project, 'AGENTS.md'), source)
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }))

    let requestBody = null
    let requestPath = null
    const api = createServer((req, res) => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        requestPath = req.url
        requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const events = [
          { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]
        for (const event of events) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        }
        res.end()
      })
    })

    let manager = null
    try {
      await new Promise((resolve, reject) => {
        api.once('error', reject)
        api.listen(0, '127.0.0.1', resolve)
      })
      const provider = `instruction-compatible-${process.pid}`
      const Provider = createAnthropicCompatibleSessionClass({
        id: provider,
        baseUrl: `http://127.0.0.1:${api.address().port}`,
        defaultModel: 'fixture-model',
      })
      registerProvider(provider, Provider)

      await withEnv({
        HOME: home,
        CHROXY_CONFIG_DIR: configDir,
        CHROXY_CLAUDE_CONFIG: mcpConfigPath,
      }, async () => {
        manager = new SessionManager({
          skipPreflight: true,
          maxSessions: 1,
          defaultCwd: project,
          providerType: provider,
          stateFilePath: join(root, 'session-state.json'),
        })
        const sessionId = manager.createSession({
          cwd: project,
          provider,
          model: 'fixture-model',
        })
        const session = manager.getSession(sessionId).session
        await once(session, 'ready')

        assert.equal(session._loadProjectInstructions, true)
        assert.equal(session.providerInstructionProjection.status, 'delivered')
        assert.deepEqual(session.providerInstructionProjection.includedRequiredRuleIds, ['compatible-manager-rule'])
        assert.deepEqual(session.mcpServers, [])

        await session.sendMessage('exercise the local compatible endpoint')
        assert.ok(requestPath.startsWith('/v1/messages'))
        assert.equal(typeof requestBody?.system, 'string')
        assert.ok(requestBody.system.includes(source))
        assert.ok(requestBody.system.includes('chroxy-instruction-policy compiler=1'))
      })
    } finally {
      manager?.destroyAll()
      await new Promise(resolve => api.close(resolve))
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses startup before model client use when compilation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chroxy-policy-over-budget-'))
    try {
      writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(96 * 1024))
      const session = new ClaudeByokSession({
        cwd: root,
        _instructionPolicyLoader: opts => loadByokInstructionPolicy({ ...opts, resolveRepoRoot: async () => root }),
        _machineInstructionPath: null,
      })
      let used = false
      session._client = { messages: { stream: () => { used = true } } }
      await assert.rejects(session.start(), /exceeds 98304 bytes/)
      assert.equal(used, false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
