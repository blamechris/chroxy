import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSemver, compareSemver, isNewer } from '../src/semver.js'

describe('parseSemver', () => {
  it('parses basic version', () => {
    assert.deepEqual(parseSemver('1.2.3'), {
      major: 1, minor: 2, patch: 3, prerelease: null,
    })
  })

  it('strips leading v', () => {
    assert.deepEqual(parseSemver('v0.3.0'), {
      major: 0, minor: 3, patch: 0, prerelease: null,
    })
  })

  it('parses pre-release tag', () => {
    assert.deepEqual(parseSemver('0.3.1-rc.1'), {
      major: 0, minor: 3, patch: 1, prerelease: 'rc.1',
    })
  })

  it('ignores build metadata', () => {
    assert.deepEqual(parseSemver('1.0.0+build.42'), {
      major: 1, minor: 0, patch: 0, prerelease: null,
    })
  })

  it('parses pre-release with build metadata', () => {
    assert.deepEqual(parseSemver('1.0.0-alpha.1+build'), {
      major: 1, minor: 0, patch: 0, prerelease: 'alpha.1',
    })
  })

  it('returns null for invalid input', () => {
    assert.equal(parseSemver('not-a-version'), null)
    assert.equal(parseSemver('1.2'), null)
    assert.equal(parseSemver(''), null)
  })
})

describe('compareSemver', () => {
  it('equal versions return 0', () => {
    assert.equal(compareSemver('1.0.0', '1.0.0'), 0)
    assert.equal(compareSemver('v0.3.0', '0.3.0'), 0)
  })

  it('compares major versions', () => {
    assert.equal(compareSemver('2.0.0', '1.0.0'), 1)
    assert.equal(compareSemver('1.0.0', '2.0.0'), -1)
  })

  it('compares minor versions', () => {
    assert.equal(compareSemver('0.4.0', '0.3.0'), 1)
    assert.equal(compareSemver('0.3.0', '0.4.0'), -1)
  })

  it('compares patch versions', () => {
    assert.equal(compareSemver('0.3.2', '0.3.1'), 1)
    assert.equal(compareSemver('0.3.1', '0.3.2'), -1)
  })

  it('handles multi-digit segments correctly (0.3.10 > 0.3.2)', () => {
    assert.equal(compareSemver('0.3.10', '0.3.2'), 1)
    assert.equal(compareSemver('0.3.2', '0.3.10'), -1)
  })

  it('release > pre-release with same version', () => {
    assert.equal(compareSemver('1.0.0', '1.0.0-alpha'), 1)
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0'), -1)
  })

  it('compares pre-release identifiers numerically', () => {
    assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.1'), 1)
    assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-rc.10'), -1)
  })

  it('compares pre-release identifiers lexically when strings', () => {
    assert.equal(compareSemver('1.0.0-beta', '1.0.0-alpha'), 1)
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1)
  })

  it('numeric pre-release id < string pre-release id', () => {
    assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1)
  })

  it('longer pre-release tuple has higher precedence when prefix matches', () => {
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  })

  it('throws on invalid input', () => {
    assert.throws(() => compareSemver('bad', '1.0.0'), /Invalid semver/)
    assert.throws(() => compareSemver('1.0.0', 'bad'), /Invalid semver/)
  })
})

describe('isNewer', () => {
  it('returns true when first version is newer', () => {
    assert.equal(isNewer('0.4.0', '0.3.0'), true)
    assert.equal(isNewer('0.3.10', '0.3.2'), true)
    assert.equal(isNewer('1.0.0', '1.0.0-rc.1'), true)
  })

  it('returns false when versions are equal', () => {
    assert.equal(isNewer('0.3.0', '0.3.0'), false)
  })

  it('returns false when first version is older', () => {
    assert.equal(isNewer('0.3.0', '0.4.0'), false)
    assert.equal(isNewer('0.3.1-rc.1', '0.3.1'), false)
  })
})
