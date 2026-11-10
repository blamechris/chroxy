import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { dirname, join, relative, sep } from 'node:path'
import {
  buildPackageTreeManifest,
  classifyResolvedBinary,
  findEnclosingPackageRoot,
} from '../src/utils/binary-package-manifest.js'

// These paths are in-memory keys only. No fixture discovers or reads a real
// installation, resolves optional dependencies, or imports the provenance gate.
const virtual = join(sep, 'virtual', 'npm-root-layout')
const metadataPath = root => join(root, 'package.json')
const optionalDependencies = Object.freeze({ 'fixture-native': '1.0.0' })

function metadataFs(records, { aliases = [], dangling = [] } = {}) {
  const files = new Map(records.map(([path, value]) => [
    path, typeof value === 'string' ? value : JSON.stringify(value),
  ]))
  const links = new Map(aliases)
  const missingTargets = new Set(dangling)
  const before = JSON.stringify([...files])
  const calls = { exists: [], read: [], realpath: [], unexpected: [] }
  const trap = operation => () => {
    calls.unexpected.push(operation)
    throw new Error(`unexpected synthetic ${operation}`)
  }
  const seams = {
    existsSync(path) {
      calls.exists.push(path)
      return files.has(path)
    },
    readFileSync(path, encoding) {
      calls.read.push(path)
      assert.equal(encoding, 'utf8')
      assert.equal(files.has(path), true, 'only mapped metadata may be read')
      return files.get(path)
    },
    realpathSync(path) {
      calls.realpath.push(path)
      if (missingTargets.has(path)) throw new Error('synthetic dangling target')
      return links.get(path) ?? path
    },
    openSync: trap('openSync'),
    readSync: trap('readSync'),
    closeSync: trap('closeSync'),
    statSync: trap('statSync'),
    readdirSync: trap('readdirSync'),
    readlinkSync: trap('readlinkSync'),
    createRequire: trap('createRequire'),
  }
  return {
    files, seams, calls,
    assertUnchanged() {
      assert.equal(JSON.stringify([...files]), before, 'metadata is not mutated')
      assert.equal(calls.unexpected.length, 0, 'no unexpected filesystem seam')
    },
  }
}

function launcherFixture(shape) {
  const root = join(virtual, 'node_modules', ...shape.install)
  const entry = join(root, ...shape.entry)
  const decoyRoot = dirname(entry)
  const rootMetadata = Object.freeze({
    name: 'fixture-published-name',
    version: '1.2.3',
    ...shape.claim,
    optionalDependencies,
  })
  const decoyMetadata = Object.freeze({
    name: 'fixture-decoy',
    main: shape.entry.at(-1),
    optionalDependencies: { 'wrong-native': '9.0.0' },
  })
  const alias = join(virtual, 'external-bin', 'fixture-launcher')
  const packageBin = join(root, 'bin', 'linked-entry')
  const aliases = shape.symlink ? [[alias, entry], [packageBin, entry]] : []
  const fs = metadataFs([
    [metadataPath(root), rootMetadata],
    [metadataPath(decoyRoot), decoyMetadata],
  ], { aliases })
  return { root, entry, decoyRoot, rootMetadata, fs, input: shape.symlink ? alias : entry }
}

const launcherShapes = [
  { name: 'bin map', install: ['alias-install'], entry: ['bin', 'codex.js'], claim: { bin: { codex: 'bin/codex.js' } } },
  { name: 'bin string', install: ['@fixtures', 'string-cli'], entry: ['bin', 'run.mjs'], claim: { bin: 'bin/run.mjs' } },
  { name: './-prefixed bin', install: ['dot-cli'], entry: ['bin', 'run.cjs'], claim: { bin: { run: './bin/run.cjs' } } },
  { name: 'symlinked bin', install: ['@fixtures', 'linked-cli'], entry: ['scripts', 'run.mjs'], claim: { bin: { run: 'bin/linked-entry' } }, symlink: true },
  { name: 'main-only entry', install: ['@fixtures', 'main-cli'], entry: ['lib', 'index.cjs'], claim: { main: 'lib/index.cjs' } },
  { name: 'gemini bundle', install: ['gemini-cli'], entry: ['bundle', 'gemini.js'], claim: { bin: { gemini: 'bundle/gemini.js' } } },
]

for (const shape of launcherShapes) {
  test(`prefers full npm root over claiming decoy for ${shape.name}`, () => {
    const fixture = launcherFixture(shape)
    const { root, entry, rootMetadata, fs, input } = fixture
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const result = classifyResolvedBinary(input, fs.seams)
      assert.equal(result.kind, 'launcher')
      assert.equal(result.packageRoot, root)
      assert.equal(result.entryPath, entry)
      assert.equal(result.packageJson.name, 'fixture-published-name')
      assert.equal(result.packageJson.version, '1.2.3')
      assert.deepEqual(result.packageJson.optionalDependencies, { 'fixture-native': '1.0.0' })
      assert.deepEqual(result.packageJson, rootMetadata)
    }
    assert.equal(fs.calls.exists.length, 2, 'one preferred metadata query per call')
    assert.equal(fs.calls.read.length, 2, 'one preferred metadata read per call')
    fs.assertUnchanged()
  })
}

test('canonical .bin alias selects the target install rather than its own directory', () => {
  const root = join(virtual, 'node_modules', '@fixtures', 'aliased-cli')
  const entry = join(root, 'bin', 'run.js')
  const alias = join(virtual, 'node_modules', '.bin', 'run')
  const fs = metadataFs([
    [metadataPath(root), { name: 'different-published-name', bin: 'bin/run.js' }],
    [metadataPath(dirname(entry)), { name: 'decoy', main: 'run.js' }],
    [metadataPath(dirname(alias)), { name: 'alias-marker', bin: 'run' }],
  ], { aliases: [[alias, entry]] })
  const result = classifyResolvedBinary(alias, fs.seams)
  assert.equal(result.kind, 'launcher')
  assert.equal(result.packageRoot, root)
  assert.equal(result.entryPath, entry)
  assert.equal(result.packageJson.name, 'different-published-name')
  assert.equal(fs.calls.read.includes(metadataPath(dirname(alias))), false)
  fs.assertUnchanged()
})

for (const install of [['dependency'], ['@nested', 'dependency']]) {
  const label = install.length === 1 ? 'unscoped' : 'scoped'
  test(`nearest nested ${label} install wins over a claiming outer owner`, () => {
    const outer = join(virtual, 'node_modules', '@outer', 'application')
    const root = join(outer, 'node_modules', ...install)
    const entry = join(root, 'bin', 'run.js')
    const fs = metadataFs([
      [metadataPath(outer), { name: 'outer-owner', bin: relative(outer, entry) }],
      [metadataPath(root), { name: 'inner-owner', bin: 'bin/run.js' }],
      [metadataPath(dirname(entry)), { name: 'decoy', main: 'run.js' }],
    ])
    const result = classifyResolvedBinary(entry, fs.seams)
    assert.equal(result.kind, 'launcher')
    assert.equal(result.packageRoot, root)
    assert.equal(result.packageJson.name, 'inner-owner')
    assert.equal(fs.calls.read.includes(metadataPath(outer)), false)
    fs.assertUnchanged()
  })
}

test('scoped package named node_modules is not mistaken for an install container', () => {
  const root = join(virtual, 'node_modules', '@fixtures', 'node_modules')
  const entry = join(root, 'bin', 'run.js')
  const fs = metadataFs([
    [metadataPath(root), { name: '@fixtures/node_modules', bin: 'bin/run.js' }],
    [metadataPath(dirname(entry)), { name: 'decoy', main: 'run.js' }],
  ])
  const result = classifyResolvedBinary(entry, fs.seams)
  assert.equal(result.packageRoot, root)
  assert.equal(result.packageJson.name, '@fixtures/node_modules')
  fs.assertUnchanged()
})

test('nested dependency below a scoped package named node_modules owns its entry', () => {
  const outer = join(virtual, 'node_modules', '@fixtures', 'node_modules')
  const root = join(outer, 'node_modules', '@inner', 'dependency')
  const entry = join(root, 'bin', 'run.js')
  const fs = metadataFs([
    [metadataPath(outer), { name: '@fixtures/node_modules', bin: relative(outer, entry) }],
    [metadataPath(root), { name: '@inner/dependency', bin: 'bin/run.js' }],
    [metadataPath(dirname(entry)), { name: 'decoy', main: 'run.js' }],
  ])
  const result = classifyResolvedBinary(entry, fs.seams)
  assert.equal(result.packageRoot, root)
  assert.equal(result.packageJson.name, '@inner/dependency')
  fs.assertUnchanged()
})

const ignoredIntermediates = [
  { name: 'nonclaiming named intermediate', value: { name: 'other-owner', main: 'other.js' } },
  { name: 'nameless intermediate marker', value: { type: 'module' } },
  { name: 'malformed intermediate metadata', value: '{broken' },
]
for (const row of ignoredIntermediates) {
  test(`valid npm owner survives a ${row.name}`, () => {
    const root = join(virtual, 'node_modules', 'valid-owner')
    const entry = join(root, 'bin', 'run.js')
    const fs = metadataFs([
      [metadataPath(root), { name: 'valid-owner', bin: 'bin/run.js' }],
      [metadataPath(dirname(entry)), row.value],
    ])
    const found = findEnclosingPackageRoot(entry, fs.seams)
    assert.equal(found.root, root)
    assert.equal(found.packageJson.name, 'valid-owner')
    fs.assertUnchanged()
  })
}

const invalidRoots = [
  { name: 'missing', value: undefined },
  { name: 'malformed', value: '{broken' },
  { name: 'nameless', value: { bin: 'bin/run.js' } },
  { name: 'empty name', value: { name: '', bin: 'bin/run.js' } },
  { name: 'nonclaiming', value: { name: 'invalid-owner', bin: 'bin/other.js' } },
  { name: 'without bin or main', value: { name: 'invalid-owner' } },
  { name: 'null', value: 'null' },
]
for (const row of invalidRoots) {
  test(`invalid npm root ${row.name} preserves the nearest-claim fallback`, () => {
    const root = join(virtual, 'node_modules', 'invalid-layout')
    const entry = join(root, 'bin', 'run.js')
    const decoy = dirname(entry)
    const records = [[metadataPath(decoy), { name: 'legacy-nearest', main: 'run.js' }]]
    if (row.value !== undefined) records.push([metadataPath(root), row.value])
    const fs = metadataFs(records)
    const result = classifyResolvedBinary(entry, fs.seams)
    assert.equal(result.kind, 'launcher')
    assert.equal(result.packageRoot, decoy)
    assert.equal(result.packageJson.name, 'legacy-nearest')
    assert.equal(fs.calls.exists.filter(path => path === metadataPath(root)).length <= 1, true)
    assert.equal(fs.calls.read.filter(path => path === metadataPath(root)).length <= (row.value === undefined ? 0 : 1), true)
    fs.assertUnchanged()
  })
}

test('invalid npm root without a closer claim preserves a further ancestor claim', () => {
  const outer = join(virtual, 'application')
  const root = join(outer, 'node_modules', 'invalid-layout')
  const entry = join(root, 'bin', 'run.js')
  const fs = metadataFs([
    [metadataPath(root), { name: 'nonclaiming-root', main: 'other.js' }],
    [metadataPath(outer), { name: 'legacy-ancestor', main: relative(outer, entry) }],
  ])
  const found = findEnclosingPackageRoot(entry, fs.seams)
  assert.equal(found.root, outer)
  assert.equal(found.packageJson.name, 'legacy-ancestor')
  assert.equal(fs.calls.read.filter(path => path === metadataPath(root)).length, 1)
  fs.assertUnchanged()
})

for (const row of [
  { name: 'empty npm scope', parts: ['node_modules', '@', 'fixture'] },
  { name: 'repeated scope marker', parts: ['node_modules', '@@bad', 'fixture'] },
  { name: 'consecutive reserved node_modules spelling', parts: ['node_modules', 'node_modules'] },
]) {
  test(`invalid layout ${row.name} preserves nearest-claim behavior`, () => {
    const root = join(virtual, ...row.parts)
    const entry = join(root, 'bin', 'run.js')
    const nearest = dirname(entry)
    const fs = metadataFs([
      [metadataPath(root), { name: 'outer-claim', bin: 'bin/run.js' }],
      [metadataPath(nearest), { name: 'nearest-claim', main: 'run.js' }],
    ])
    const found = findEnclosingPackageRoot(entry, fs.seams)
    assert.equal(found.root, nearest)
    assert.equal(found.packageJson.name, 'nearest-claim')
    fs.assertUnchanged()
  })
}

test('non-npm script retains the nearest of two claiming ancestors', () => {
  const outer = join(virtual, 'standalone')
  const entry = join(outer, 'bin', 'run.js')
  const nearest = dirname(entry)
  const fs = metadataFs([
    [metadataPath(outer), { name: 'outer-claim', bin: 'bin/run.js' }],
    [metadataPath(nearest), { name: 'nearest-claim', main: 'run.js' }],
  ])
  const found = findEnclosingPackageRoot(entry, fs.seams)
  assert.equal(found.root, nearest)
  assert.equal(found.packageJson.name, 'nearest-claim')
  assert.equal(fs.calls.read.includes(metadataPath(outer)), false)
  fs.assertUnchanged()
})

test('node_modules substring does not override a nearer claimant', () => {
  const outer = join(virtual, 'other_node_modules', 'fixture')
  const entry = join(outer, 'bin', 'run.js')
  const fs = metadataFs([
    [metadataPath(outer), { name: 'outer-owner', bin: 'bin/run.js' }],
    [metadataPath(dirname(entry)), { name: 'nearest-owner', main: 'run.js' }],
  ])
  const result = classifyResolvedBinary(entry, fs.seams)
  assert.equal(result.packageRoot, dirname(entry))
  assert.equal(result.packageJson.name, 'nearest-owner')
  fs.assertUnchanged()
})

for (const layout of ['standalone', 'npm']) {
  test(`a ${layout} script without a claimant keeps native fallback`, () => {
    const home = join(virtual, 'fake-home')
    const root = layout === 'npm' ? join(home, 'node_modules', 'fixture') : join(home, 'tools')
    const entry = join(root, 'bin', 'run.js')
    const fs = metadataFs([
      [metadataPath(home), { name: 'unrelated-home-package', main: 'unrelated.js' }],
      [metadataPath(root), { name: 'nonclaiming-package', bin: 'other.js' }],
      [metadataPath(dirname(entry)), { type: 'module' }],
    ])
    assert.equal(findEnclosingPackageRoot(entry, fs.seams), null)
    assert.equal(classifyResolvedBinary(entry, fs.seams).kind, 'native')
    fs.assertUnchanged()
  })
}

test('dangling bin target keeps the existing joined-path ownership fallback', () => {
  const root = join(virtual, 'node_modules', 'dangling-bin')
  const entry = join(root, 'bin', 'run.js')
  const fs = metadataFs([
    [metadataPath(root), { name: 'dangling-bin', bin: 'bin/run.js' }],
    [metadataPath(dirname(entry)), { name: 'decoy', main: 'run.js' }],
  ], { dangling: [entry] })
  const result = classifyResolvedBinary(entry, fs.seams)
  assert.equal(result.kind, 'launcher')
  assert.equal(result.packageRoot, root)
  assert.equal(result.entryPath, entry)
  fs.assertUnchanged()
})

for (const [label, value] of [['empty', ''], ['null', null], ['undefined', undefined], ['number', 7], ['object', {}]]) {
  test(`invalid ${label} binary input remains native without filesystem queries`, () => {
    const fs = metadataFs([])
    assert.equal(classifyResolvedBinary(value, fs.seams).kind, 'native')
    assert.equal(fs.calls.realpath.length + fs.calls.exists.length + fs.calls.read.length, 0)
    fs.assertUnchanged()
  })
}

for (const row of [
  { name: 'native magic', bytes: [0x7f, 0x45], expected: 'native' },
  { name: 'short file', bytes: [0x23], expected: 'native' },
  { name: 'shebang script', bytes: [0x23, 0x21], expected: 'launcher' },
]) {
  test(`extensionless ${row.name} preserves classification through fake read seams`, () => {
    const root = join(virtual, 'node_modules', 'extensionless')
    const entry = join(root, 'bin', 'run')
    const fs = metadataFs([[metadataPath(root), { name: 'extensionless', bin: 'bin/run' }]])
    const io = []
    const result = classifyResolvedBinary(entry, {
      ...fs.seams,
      openSync(path, flags) {
        assert.equal(path, entry)
        assert.equal(flags, 'r')
        io.push('open')
        return 73
      },
      readSync(fd, buffer, offset, length, position) {
        assert.equal(fd, 73)
        assert.equal(offset, 0)
        assert.equal(length, 2)
        assert.equal(position, 0)
        row.bytes.forEach((byte, index) => { buffer[index] = byte })
        io.push('read')
        return row.bytes.length
      },
      closeSync(fd) {
        assert.equal(fd, 73)
        io.push('close')
      },
    })
    assert.equal(result.kind, row.expected)
    assert.equal(io.join(','), 'open,read,close')
    if (row.expected === 'launcher') assert.equal(result.packageRoot, root)
    else assert.equal(fs.calls.exists.length, 0)
    fs.assertUnchanged()
  })
}

function manifestFs(metadataFiles, entry, sibling) {
  const files = new Map(metadataFiles)
  files.set(entry, 'synthetic launcher')
  files.set(sibling, 'synthetic sibling before')
  const hashes = []
  const unexpected = []
  const directories = new Set()
  for (const path of files.keys()) {
    let dir = dirname(path)
    while (!directories.has(dir)) {
      directories.add(dir)
      const parent = dirname(dir)
      if (dir === parent) break
      dir = parent
    }
  }
  const trap = operation => () => {
    unexpected.push(operation)
    throw new Error(`unexpected synthetic ${operation}`)
  }
  return {
    files, hashes, unexpected,
    hashFile(path) {
      assert.equal(files.has(path), true, 'only synthetic files may be hashed')
      hashes.push(path)
      return createHash('sha256').update(files.get(path)).digest('hex')
    },
    seams: {
      realpathSync(path) {
        assert.equal(files.has(path) || directories.has(path), true)
        return path
      },
      readdirSync(dir, options) {
        assert.equal(directories.has(dir), true)
        assert.equal(options.withFileTypes, true)
        const children = new Map()
        for (const path of [...directories, ...files.keys()]) {
          if (path === dir || dirname(path) !== dir) continue
          children.set(path, {
            name: relative(dir, path),
            isSymbolicLink: () => false,
            isDirectory: () => directories.has(path),
            isFile: () => files.has(path),
          })
        }
        return [...children.values()]
      },
      statSync(path) {
        assert.equal(files.has(path), true)
        return { size: Buffer.byteLength(files.get(path)) }
      },
      readlinkSync: trap('readlinkSync'),
      readFileSync: trap('readFileSync'),
      existsSync: trap('existsSync'),
      openSync: trap('openSync'),
      readSync: trap('readSync'),
      closeSync: trap('closeSync'),
      createRequire: trap('createRequire'),
    },
  }
}

for (const row of [
  { name: 'native subtree', shape: launcherShapes[0], sibling: ['native', 'runtime.bin'] },
  { name: 'gemini chunk', shape: launcherShapes[5], sibling: ['chunks', 'chunk.js'] },
]) {
  test(`selected root manifest detects a changed sibling ${row.name}`, () => {
    const fixture = launcherFixture(row.shape)
    const { root, entry, fs } = fixture
    const sibling = join(root, ...row.sibling)
    const tree = manifestFs(fs.files, entry, sibling)
    function digest() {
      const selected = classifyResolvedBinary(entry, fs.seams)
      assert.equal(selected.kind, 'launcher')
      const result = buildPackageTreeManifest({
        packageRoot: selected.packageRoot,
        entryPath: selected.entryPath,
        hashFile: tree.hashFile,
        maxFiles: 20,
        maxBytes: 4096,
      }, tree.seams)
      assert.equal(result.capped, false)
      assert.equal(result.unreadable, false)
      assert.equal(result.error, null)
      assert.equal(typeof result.digest, 'string')
      return result.digest
    }
    const before = digest()
    assert.equal(digest(), before, 'repeat manifest is stable')
    tree.files.set(sibling, 'synthetic sibling changed')
    assert.notEqual(digest(), before, 'sibling content contributes to the tree digest')
    assert.equal(tree.hashes.filter(path => path === sibling).length, 3)
    assert.equal(tree.unexpected.length, 0)
    fs.assertUnchanged()
  })
}
