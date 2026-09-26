// derive-server-lockfile.test.mjs — coverage for
// packages/desktop/scripts/derive-server-lockfile.mjs (#7324).
//
// Run:
//   node --test packages/desktop/scripts/__tests__/derive-server-lockfile.test.mjs
//
// Synthetic fixtures cover the placement algorithm's edge cases in
// isolation (i-vi below); the last describe block derives from the REPO'S
// OWN root package-lock.json + packages/server/package.json and checks the
// result against an INDEPENDENTLY written resolution walk — not against
// deriveServerLockfile's own internals — so the test cannot pass merely by
// agreeing with itself.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveServerLockfile } from '../derive-server-lockfile.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')

const WORKSPACE = 'packages/server'

function baseLock(extraPackages = {}) {
  return {
    name: 'chroxy',
    version: '0.11.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'chroxy', version: '0.11.0' },
      [WORKSPACE]: { name: '@chroxy/server', version: '0.11.0' },
      ...extraPackages,
    },
  }
}

function stagedPkg(overrides = {}) {
  return { name: '@chroxy/server', version: '0.11.0', license: 'MIT', ...overrides }
}

// An INDEPENDENT resolution walk, written from scratch rather than reusing
// deriveServerLockfile's own resolveReal/ancestors — so agreement between
// the two actually means something. Mirrors real Node module resolution:
// walk up from `loc`, trying `<loc>/node_modules/<name>` at each level.
function independentResolve(packages, loc, name) {
  let cur = loc
  for (;;) {
    const candidate = cur === '' ? `node_modules/${name}` : `${cur}/node_modules/${name}`
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) {
      let entry = packages[candidate]
      let key = candidate
      const seen = new Set()
      while (entry && entry.link === true) {
        if (seen.has(key)) throw new Error(`circular link at ${key}`)
        seen.add(key)
        key = entry.resolved
        entry = packages[key]
      }
      return { key, entry }
    }
    if (cur === '') return null
    // Peel the last node_modules/<segment> off `cur` to go up one level.
    const idx = cur.lastIndexOf('node_modules/')
    if (idx === -1) {
      cur = ''
    } else {
      cur = idx === 0 ? '' : cur.slice(0, idx - 1)
    }
  }
}


// The WHOLE production closure, walked in both trees at once (PR #7982 review,
// S2). From each paired (root-lockfile location, derived location), every
// dependency the ROOT entry declares is resolved in both trees with
// independentResolve, and must land on the same instance (version + integrity).
// This checks transitive placement independently of the derivation's own
// verifyClosure — which was the only thing catching C1.
function depsOf(entry) {
  const out = []
  for (const n of Object.keys(entry.dependencies || {})) out.push([n, false])
  for (const n of Object.keys(entry.optionalDependencies || {})) out.push([n, true])
  const meta = entry.peerDependenciesMeta || {}
  for (const n of Object.keys(entry.peerDependencies || {})) out.push([n, meta[n] && meta[n].optional === true])
  return out
}

function pairedWalk(rootPackages, derivedPackages, topDeps) {
  const mismatches = []
  const seen = new Set()
  const queue = [{ rootLoc: WORKSPACE, outLoc: '', deps: topDeps }]
  let edges = 0
  while (queue.length > 0) {
    const { rootLoc, outLoc, deps } = queue.shift()
    for (const [name, optional] of deps) {
      const expected = independentResolve(rootPackages, rootLoc, name)
      if (!expected) {
        if (!optional) mismatches.push(`${rootLoc} -> ${name}: missing from the ROOT lockfile`)
        continue
      }
      edges += 1
      const actual = independentResolve(derivedPackages, outLoc, name)
      const where = outLoc || '<root>'
      if (!actual) {
        mismatches.push(`${where} -> ${name}: does not resolve in the derived lockfile`)
        continue
      }
      if (actual.entry.version !== expected.entry.version || actual.entry.integrity !== expected.entry.integrity) {
        mismatches.push(`${where} -> ${name}: derived ${actual.entry.version}, root ${expected.entry.version}`)
        continue
      }
      const pair = `${expected.key}|${actual.key}`
      if (seen.has(pair)) continue
      seen.add(pair)
      queue.push({ rootLoc: expected.key, outLoc: actual.key, deps: depsOf(expected.entry) })
    }
  }
  return { mismatches, edges }
}

const topDepsOf = (pkg) => [
  ...Object.keys(pkg.dependencies || {}).map((n) => [n, false]),
  ...Object.keys(pkg.optionalDependencies || {}).map((n) => [n, true]),
]

describe('deriveServerLockfile — hoisted-only (i)', () => {
  it('places a single direct dependency at the new root node_modules', () => {
    const lock = baseLock({
      'node_modules/foo': { version: '1.2.3', resolved: 'https://r/foo-1.2.3.tgz', integrity: 'sha512-foo' },
    })
    const pkg = stagedPkg({ dependencies: { foo: '^1.2.3' } })
    const out = deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE })

    assert.equal(out.lockfileVersion, 3)
    assert.equal(out.requires, true)
    assert.deepEqual(Object.keys(out.packages).sort(), ['', 'node_modules/foo'])
    assert.equal(out.packages['node_modules/foo'].version, '1.2.3')
    assert.equal(out.packages['node_modules/foo'].optional, undefined)
    assert.equal(out.packages[''].dependencies.foo, '^1.2.3')
  })

  it('follows a transitive chain, hoisting each level with no conflicts', () => {
    const lock = baseLock({
      'node_modules/foo': {
        version: '1.0.0',
        resolved: 'https://r/foo-1.0.0.tgz',
        integrity: 'sha512-foo',
        dependencies: { bar: '^2.0.0' },
      },
      'node_modules/bar': { version: '2.0.0', resolved: 'https://r/bar-2.0.0.tgz', integrity: 'sha512-bar' },
    })
    const pkg = stagedPkg({ dependencies: { foo: '^1.0.0' } })
    const out = deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE })

    assert.deepEqual(Object.keys(out.packages).sort(), ['', 'node_modules/bar', 'node_modules/foo'])
    assert.equal(out.packages['node_modules/bar'].version, '2.0.0')
  })
})

describe('deriveServerLockfile — collision nesting (ii)', () => {
  it('nests a hoisted dependency\'s own transitive need when the server\'s direct dep already claimed the root slot', () => {
    // Server directly depends on x@2, which npm nested under
    // packages/server/node_modules/x because the true monorepo root already
    // has x@1 hoisted for some OTHER workspace's sake. Server also directly
    // depends on p@1 (hoisted cleanly), and p itself needs x@^1 — which in
    // the OLD tree resolves to the real root's x@1.
    //
    // After re-rooting: server's OWN x@2 claims the new root's node_modules/x
    // slot (processed first — 'p' < 'x' alphabetically only coincidentally
    // matches; what matters is BOTH are root/depth-0 edges, so whichever's
    // root slot is unclaimed at the time wins the hoist). p's own edge to
    // x@1 then finds the root slot occupied by a DIFFERENT instance (x@2)
    // and must nest its own copy under node_modules/p.
    const lock = baseLock({
      'node_modules/x': { version: '1.0.0', resolved: 'https://r/x-1.0.0.tgz', integrity: 'sha512-x1' },
      [`${WORKSPACE}/node_modules/x`]: { version: '2.0.0', resolved: 'https://r/x-2.0.0.tgz', integrity: 'sha512-x2' },
      'node_modules/p': {
        version: '1.0.0',
        resolved: 'https://r/p-1.0.0.tgz',
        integrity: 'sha512-p1',
        dependencies: { x: '^1.0.0' },
      },
    })
    const pkg = stagedPkg({ dependencies: { x: '^2.0.0', p: '^1.0.0' } })
    const out = deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE })

    assert.deepEqual(Object.keys(out.packages).sort(), [
      '',
      'node_modules/p',
      'node_modules/p/node_modules/x',
      'node_modules/x',
    ])
    assert.equal(out.packages['node_modules/x'].version, '2.0.0', 'server\'s own x@2 keeps the top slot')
    assert.equal(out.packages['node_modules/p/node_modules/x'].version, '1.0.0', 'p gets its own nested x@1')
    assert.equal(out.packages['node_modules/p'].version, '1.0.0')
  })
})

describe('deriveServerLockfile — optional platform deps (iii)', () => {
  it('keeps os/cpu-restricted optional deps, flagged optional:true', () => {
    const lock = baseLock({
      'node_modules/opt-parent': {
        version: '1.0.0',
        resolved: 'https://r/opt-parent-1.0.0.tgz',
        integrity: 'sha512-op',
        optionalDependencies: { 'plat-linux': '1.0.0', 'plat-darwin': '1.0.0' },
      },
      'node_modules/plat-linux': {
        version: '1.0.0',
        resolved: 'https://r/plat-linux-1.0.0.tgz',
        integrity: 'sha512-pl',
        os: ['linux'],
        optional: true,
      },
      'node_modules/plat-darwin': {
        version: '1.0.0',
        resolved: 'https://r/plat-darwin-1.0.0.tgz',
        integrity: 'sha512-pd',
        os: ['darwin'],
        optional: true,
      },
    })
    const pkg = stagedPkg({ dependencies: { 'opt-parent': '^1.0.0' } })
    const out = deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE })

    assert.equal(out.packages['node_modules/opt-parent'].optional, undefined, 'required parent stays required')
    assert.equal(out.packages['node_modules/plat-linux'].optional, true)
    assert.equal(out.packages['node_modules/plat-linux'].os[0], 'linux')
    assert.equal(out.packages['node_modules/plat-darwin'].optional, true)
    assert.equal(out.packages['node_modules/plat-darwin'].os[0], 'darwin')
  })

  it('derives optional:true from the EDGES, not the source flag (PR #7982 review, S4)', () => {
    // The source entries here carry NO optional flag. If the derivation just
    // copied the source's flag, a platform package would be emitted as REQUIRED
    // and `npm ci` would fail EBADPLATFORM on every other OS.
    const lock = baseLock({
      'node_modules/opt-parent': {
        version: '1.0.0',
        resolved: 'https://r/opt-parent-1.0.0.tgz',
        integrity: 'sha512-op',
        optionalDependencies: { 'plat-win': '1.0.0' },
      },
      'node_modules/plat-win': {
        version: '1.0.0',
        resolved: 'https://r/plat-win-1.0.0.tgz',
        integrity: 'sha512-pw',
        os: ['win32'],
      },
    })
    const pkg = stagedPkg({ dependencies: { 'opt-parent': '^1.0.0' } })
    const out = deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE })
    assert.equal(out.packages['node_modules/plat-win'].optional, true)
    assert.equal(out.packages['node_modules/opt-parent'].optional, undefined)
  })
})

describe('deriveServerLockfile — missing dependencies (iv)', () => {
  it('skips a missing OPTIONAL dependency without throwing', () => {
    const lock = baseLock({
      'node_modules/with-missing-optional': {
        version: '1.0.0',
        resolved: 'https://r/wmo-1.0.0.tgz',
        integrity: 'sha512-wmo',
        optionalDependencies: { 'totally-missing': '1.0.0' },
      },
    })
    const pkg = stagedPkg({ dependencies: { 'with-missing-optional': '^1.0.0' } })
    const out = deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE })

    assert.deepEqual(Object.keys(out.packages).sort(), ['', 'node_modules/with-missing-optional'])
  })

  it('throws with the dependency chain when a REQUIRED dependency is missing', () => {
    const lock = baseLock({
      'node_modules/with-missing-required': {
        version: '1.0.0',
        resolved: 'https://r/wmr-1.0.0.tgz',
        integrity: 'sha512-wmr',
        dependencies: { 'also-missing': '1.0.0' },
      },
    })
    const pkg = stagedPkg({ dependencies: { 'with-missing-required': '^1.0.0' } })

    assert.throws(
      () => deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE }),
      /also-missing/,
    )
  })

  it('throws when the server\'s OWN direct required dependency is missing', () => {
    const lock = baseLock()
    const pkg = stagedPkg({ dependencies: { nope: '^1.0.0' } })
    assert.throws(() => deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE }), /nope/)
  })
})

describe('deriveServerLockfile — workspace link in the closure throws (v)', () => {
  it('throws when a transitive dependency resolves through a link:true entry to a workspace package', () => {
    const lock = baseLock({
      'packages/protocol': { name: '@chroxy/protocol', version: '0.11.0' },
      'node_modules/@chroxy/protocol': { resolved: 'packages/protocol', link: true },
      'node_modules/uses-workspace': {
        version: '1.0.0',
        resolved: 'https://r/uw-1.0.0.tgz',
        integrity: 'sha512-uw',
        dependencies: { '@chroxy/protocol': '^0.11.0' },
      },
    })
    const pkg = stagedPkg({ dependencies: { 'uses-workspace': '^1.0.0' } })

    assert.throws(
      () => deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE }),
      /workspace package/,
    )
  })

  it('throws up front if the staged package.json itself still declares a @chroxy/* dependency', () => {
    const lock = baseLock()
    const pkg = stagedPkg({ dependencies: { '@chroxy/protocol': '^0.11.0' } })
    assert.throws(
      () => deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE }),
      /@chroxy\/protocol/,
    )
  })
})

describe('deriveServerLockfile — peerDependencies (vi)', () => {
  it('includes a required peer, and skips a missing optional peer', () => {
    const lock = baseLock({
      'node_modules/has-peer': {
        version: '1.0.0',
        resolved: 'https://r/has-peer-1.0.0.tgz',
        integrity: 'sha512-hp',
        peerDependencies: { 'peer-required': '^1.0.0', 'peer-optional': '^1.0.0' },
        peerDependenciesMeta: { 'peer-optional': { optional: true } },
      },
      'node_modules/peer-required': {
        version: '1.0.0',
        resolved: 'https://r/peer-required-1.0.0.tgz',
        integrity: 'sha512-pr',
      },
      // deliberately no entry for peer-optional anywhere
    })
    const pkg = stagedPkg({ dependencies: { 'has-peer': '^1.0.0' } })
    const out = deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE })

    assert.deepEqual(Object.keys(out.packages).sort(), ['', 'node_modules/has-peer', 'node_modules/peer-required'])
    assert.equal(out.packages['node_modules/peer-required'].optional, undefined)
  })

  it('throws when a REQUIRED peer is missing', () => {
    const lock = baseLock({
      'node_modules/has-required-peer': {
        version: '1.0.0',
        resolved: 'https://r/hrp-1.0.0.tgz',
        integrity: 'sha512-hrp',
        peerDependencies: { 'missing-peer': '^1.0.0' },
      },
    })
    const pkg = stagedPkg({ dependencies: { 'has-required-peer': '^1.0.0' } })
    assert.throws(
      () => deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE }),
      /missing-peer/,
    )
  })
})

describe('deriveServerLockfile — shadow avoidance (extra, beyond the required six)', () => {
  it('does not let a later nested placement shadow an already-satisfied deep resolution', () => {
    // Server directly depends on a, d, q, sibling. d/q/sibling are ALSO
    // needed (as different instances) by `a`'s own subtree, which forces
    // a's copies of q/d/sibling to nest under node_modules/a instead of
    // hoisting past it — the root slots are already taken.
    //
    //   node_modules/a         (A)                — server's own direct dep
    //   node_modules/d         (D-root)            — server's own direct dep, unrelated to A's
    //   node_modules/q         (Q-root)            — server's own direct dep, unrelated to A's
    //   node_modules/sibling   (Sibling-root)       — server's own direct dep, unrelated to A's
    //   a -> q@own (nests under node_modules/a, since node_modules/q is taken)
    //   q@own -> d@own, sibling@own (both hoist to node_modules/a/*, one level
    //     above q@own itself, since node_modules/a/node_modules/{d,sibling}
    //     are empty but the true root slots are taken)
    //   d@own -> n@1 (walks PAST the empty node_modules/a/node_modules/n up
    //     to a brand new node_modules/n — nothing conflicts yet, so it hoists
    //     all the way and is "satisfied" there for good)
    //   sibling@own -> n@2, a DIFFERENT instance. Naive "nest one level
    //     above the conflict" placement would put n@2 at
    //     node_modules/a/node_modules/n — which sits ON d@own's resolution
    //     path (d@own currently finds n@1 by walking THROUGH that empty
    //     slot) and would silently change what d@own resolves to. The
    //     shadow check must push n@2 down into sibling@own's own slot
    //     instead.
    const lock = baseLock({
      'node_modules/a': {
        version: '1.0.0',
        resolved: 'https://r/a-1.0.0.tgz',
        integrity: 'sha512-a',
        dependencies: { q: '^1.0.0' },
      },
      'node_modules/d': { version: '9.0.0', resolved: 'https://r/d-9.0.0.tgz', integrity: 'sha512-d9' },
      'node_modules/q': { version: '9.0.0', resolved: 'https://r/q-9.0.0.tgz', integrity: 'sha512-q9' },
      'node_modules/sibling': { version: '9.0.0', resolved: 'https://r/sibling-9.0.0.tgz', integrity: 'sha512-sib9' },
      'node_modules/a/node_modules/q': {
        version: '1.0.0',
        resolved: 'https://r/q-own-1.0.0.tgz',
        integrity: 'sha512-q-own',
        dependencies: { d: '^1.0.0', sibling: '^1.0.0' },
      },
      'node_modules/a/node_modules/q/node_modules/d': {
        version: '1.0.0',
        resolved: 'https://r/d-own-1.0.0.tgz',
        integrity: 'sha512-d-own',
        dependencies: { n: '^1.0.0' },
      },
      'node_modules/a/node_modules/q/node_modules/sibling': {
        version: '1.0.0',
        resolved: 'https://r/sibling-own-1.0.0.tgz',
        integrity: 'sha512-sibling-own',
        dependencies: { n: '^2.0.0' },
      },
      'node_modules/n': { version: '1.0.0', resolved: 'https://r/n-1.0.0.tgz', integrity: 'sha512-n1' },
      // The version sibling@own actually needs — a DIFFERENT instance than
      // n@1. Nested directly under sibling@own's own OLD key too, so phase 1
      // resolves sibling@own's edge to THIS instance rather than n@1.
      'node_modules/a/node_modules/q/node_modules/sibling/node_modules/n': {
        version: '2.0.0',
        resolved: 'https://r/n-2.0.0.tgz',
        integrity: 'sha512-n2',
      },
    })
    const pkg = stagedPkg({ dependencies: { a: '^1.0.0', d: '^9.0.0', q: '^9.0.0', sibling: '^9.0.0' } })
    const out = deriveServerLockfile({ rootLock: lock, packageJson: pkg, workspace: WORKSPACE })

    assert.deepEqual(Object.keys(out.packages).sort(), [
      '',
      'node_modules/a',
      'node_modules/a/node_modules/d',
      'node_modules/a/node_modules/q',
      'node_modules/a/node_modules/sibling',
      'node_modules/a/node_modules/sibling/node_modules/n',
      'node_modules/d',
      'node_modules/n',
      'node_modules/q',
      'node_modules/sibling',
    ])
    assert.equal(out.packages['node_modules/d'].version, '9.0.0', "server's own direct d is untouched")
    assert.equal(out.packages['node_modules/q'].version, '9.0.0', "server's own direct q is untouched")
    assert.equal(out.packages['node_modules/sibling'].version, '9.0.0', "server's own direct sibling is untouched")
    assert.equal(out.packages['node_modules/a/node_modules/q'].version, '1.0.0', "a's own q nests under a")
    assert.equal(
      out.packages['node_modules/a/node_modules/d'].version,
      '1.0.0',
      "q's own d hoists to a/, one level above q itself",
    )
    assert.equal(out.packages['node_modules/n'].version, '1.0.0', 'd@own\'s n@1 hoists all the way to the new root')
    assert.equal(
      out.packages['node_modules/a/node_modules/sibling/node_modules/n'].version,
      '2.0.0',
      "sibling@own's conflicting n@2 nests under sibling@own itself, not shadowing d@own's n@1",
    )
  })
})

describe('deriveServerLockfile — a nested conflict never lands in its parent\'s own node_modules (PR #7982 review, C1)', () => {
  // The real shape from this repo's root lockfile (packages/app's closure):
  // send@0.19.2 needs ms@2.1.3 (hoisted) and debug@2.6.9; debug@2.6.9 needs
  // ms@2.0.0. npm nests that ms under send/node_modules/debug. The first
  // placer hoisted it into send/node_modules/ms instead, which is the first
  // place Node looks from send — so send loaded ms@2.0.0.
  const e = (v) => ({ version: v, resolved: `https://registry.example/${v}.tgz`, integrity: `sha512-${v}` })
  const rootLock = baseLock({
    'node_modules/send': { ...e('send-0.19.2'), dependencies: { debug: '2.6.9', ms: '2.1.3' } },
    'node_modules/ms': e('ms-2.1.3'),
    'node_modules/debug': e('debug-4.4.0'),
    'node_modules/send/node_modules/debug': { ...e('debug-2.6.9'), dependencies: { ms: '2.0.0' } },
    'node_modules/send/node_modules/debug/node_modules/ms': e('ms-2.0.0'),
  })
  const pkg = stagedPkg({ dependencies: { send: '0.19.2', debug: '*' } })

  it('send still resolves ms@2.1.3, and debug@2.6.9 gets its own ms@2.0.0', () => {
    const out = deriveServerLockfile({ rootLock, packageJson: pkg, workspace: WORKSPACE })
    assert.equal(independentResolve(out.packages, 'node_modules/send', 'ms').entry.version, 'ms-2.1.3')
    assert.equal(independentResolve(out.packages, 'node_modules/send/node_modules/debug', 'ms').entry.version, 'ms-2.0.0')
    assert.equal(out.packages['node_modules/send/node_modules/ms'], undefined, 'nothing may sit in send\'s own ms slot')
  })

  it('the whole closure matches the root lockfile edge for edge', () => {
    const out = deriveServerLockfile({ rootLock, packageJson: pkg, workspace: WORKSPACE })
    const { mismatches, edges } = pairedWalk(rootLock.packages, out.packages, topDepsOf(pkg))
    assert.ok(edges >= 5, `non-vacuity: the walk must visit the fixture's edges (got ${edges})`)
    assert.deepEqual(mismatches, [])
  })
})

describe('deriveServerLockfile — real repo data', () => {
  const rootLock = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package-lock.json'), 'utf8'))
  const serverPkgRaw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/server/package.json'), 'utf8'))

  // Mirror bundle-server.sh's staging steps: strip @chroxy/* deps, drop
  // devDependencies and the postinstall script.
  const stagedServerPkg = JSON.parse(JSON.stringify(serverPkgRaw))
  for (const dep of Object.keys(stagedServerPkg.dependencies || {})) {
    if (dep.startsWith('@chroxy/')) delete stagedServerPkg.dependencies[dep]
  }
  delete stagedServerPkg.devDependencies
  if (stagedServerPkg.scripts) delete stagedServerPkg.scripts.postinstall

  it('has a workspace entry for packages/server', () => {
    assert.ok(rootLock.packages && rootLock.packages[WORKSPACE], 'root lockfile must have a packages/server entry')
  })

  it('resolves every production dependency to the version the root lockfile gives it, with no @chroxy/* entries', () => {
    const out = deriveServerLockfile({ rootLock, packageJson: stagedServerPkg, workspace: WORKSPACE })

    const names = [
      ...Object.keys(stagedServerPkg.dependencies || {}),
      ...Object.keys(stagedServerPkg.optionalDependencies || {}),
    ]
    assert.ok(names.length > 5, `expected several production dependencies, found ${names.length}`)

    for (const name of names) {
      const expected = independentResolve(rootLock.packages, WORKSPACE, name)
      assert.ok(expected, `independent walk found no root-lockfile entry for "${name}"`)

      // Resolve the SAME name inside the derived lockfile's own tree, using
      // the same from-scratch walk (now against `out.packages`, rooted at "").
      const actual = independentResolve(out.packages, '', name)
      assert.ok(actual, `"${name}" does not resolve in the derived lockfile`)
      assert.equal(actual.entry.version, expected.entry.version, `"${name}" version mismatch`)
      assert.equal(actual.entry.resolved, expected.entry.resolved, `"${name}" resolved mismatch`)
      assert.equal(actual.entry.integrity, expected.entry.integrity, `"${name}" integrity mismatch`)
    }

    for (const key of Object.keys(out.packages)) {
      if (key === '') continue // the root entry IS @chroxy/server itself — that's the package being bundled
      assert.ok(!key.includes('node_modules/@chroxy/'), `unexpected workspace entry: ${key}`)
      const entry = out.packages[key]
      if (entry && entry.name) {
        assert.ok(!entry.name.startsWith('@chroxy/'), `entry at "${key}" names a workspace package: ${entry.name}`)
      }
    }
  })

  it('the WHOLE production closure matches the root lockfile edge for edge (PR #7982 review, S2)', () => {
    const out = deriveServerLockfile({ rootLock, packageJson: stagedServerPkg, workspace: WORKSPACE })
    const { mismatches, edges } = pairedWalk(rootLock.packages, out.packages, topDepsOf(stagedServerPkg))
    assert.ok(edges >= 100, `non-vacuity: the server closure has hundreds of edges (walked ${edges})`)
    assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} edge(s) differ`)
  })

  it('an ordinary upstream bump still derives: a new major nested under claude-agent-sdk (PR #7982 review, C1)', () => {
    // Exactly as npm records it: @anthropic-ai/claude-agent-sdk starts depending
    // on json-schema-to-ts@^4 while @anthropic-ai/sdk stays on ^3. The first
    // placer failed VERIFY on this — a required check blocking a Renovate PR.
    const bumped = JSON.parse(JSON.stringify(rootLock))
    const p = bumped.packages
    const cas = 'node_modules/@anthropic-ai/claude-agent-sdk'
    assert.ok(p[cas] && p['node_modules/json-schema-to-ts'], 'premise: the root lockfile carries claude-agent-sdk and a hoisted json-schema-to-ts')
    p[cas] = { ...p[cas], dependencies: { ...p[cas].dependencies, 'json-schema-to-ts': '^4.0.0' } }
    p[`${cas}/node_modules/json-schema-to-ts`] = {
      version: '4.0.0',
      resolved: 'https://registry.npmjs.org/json-schema-to-ts/-/json-schema-to-ts-4.0.0.tgz',
      integrity: 'sha512-hypothetical',
      license: 'MIT',
    }
    const out = deriveServerLockfile({ rootLock: bumped, packageJson: stagedServerPkg, workspace: WORKSPACE })
    const { mismatches } = pairedWalk(bumped.packages, out.packages, topDepsOf(stagedServerPkg))
    assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} edge(s) differ`)
  })
})
