import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ALLOWED_DOCKER_IMAGES,
  imageMatchesAllowlist,
  validateDockerImage,
} from '../src/docker-image-allowlist.js'

/**
 * Unit tests for the Docker image allowlist — 2026-04-11 audit
 * Adversary A7 fix. Closes the create_environment attacker-controlled-
 * image attack path.
 */

describe('imageMatchesAllowlist', () => {
  it('matches exact image references', () => {
    assert.equal(imageMatchesAllowlist('node:22-slim', ['node:22-slim']), true)
    assert.equal(imageMatchesAllowlist('node:22-slim', ['node:18']), false)
  })

  it('matches prefix-with-trailing-star patterns', () => {
    assert.equal(imageMatchesAllowlist('node:22', ['node:*']), true)
    assert.equal(imageMatchesAllowlist('node:22-slim', ['node:*']), true)
    assert.equal(imageMatchesAllowlist('nodex:22', ['node:*']), false,
      'prefix must include the colon — nodex is a distinct image')
  })

  it('handles multi-segment paths with wildcards', () => {
    const pattern = 'mcr.microsoft.com/devcontainers/*'
    assert.equal(imageMatchesAllowlist('mcr.microsoft.com/devcontainers/base:ubuntu', [pattern]), true)
    assert.equal(imageMatchesAllowlist('mcr.microsoft.com/devcontainers/python', [pattern]), true)
    assert.equal(imageMatchesAllowlist('mcr.microsoft.com/other/image', [pattern]), false)
    assert.equal(imageMatchesAllowlist('attacker.evil/devcontainers/base', [pattern]), false,
      'must not allow an arbitrary registry just because the path-tail matches')
  })

  it('returns false for empty / non-string inputs', () => {
    assert.equal(imageMatchesAllowlist('', ['node:*']), false)
    assert.equal(imageMatchesAllowlist(null, ['node:*']), false)
    assert.equal(imageMatchesAllowlist(undefined, ['node:*']), false)
    assert.equal(imageMatchesAllowlist(42, ['node:*']), false)
  })

  it('returns false for empty or non-array patterns', () => {
    assert.equal(imageMatchesAllowlist('node:22', []), false)
    assert.equal(imageMatchesAllowlist('node:22', null), false)
  })

  it('skips malformed entries in the pattern list', () => {
    const patterns = [null, '', 'node:*']
    assert.equal(imageMatchesAllowlist('node:22', patterns), true)
  })
})

describe('validateDockerImage — 2026-04-11 audit Adversary A7', () => {
  it('returns null when image is undefined (caller gets the manager default)', () => {
    assert.equal(validateDockerImage(undefined), null)
    assert.equal(validateDockerImage(''), null)
  })

  it('uses DEFAULT_ALLOWED_DOCKER_IMAGES when config is null', () => {
    for (const image of ['node:22', 'python:3.11-slim', 'ubuntu:24.04', 'alpine:3']) {
      assert.equal(validateDockerImage(image, null), null, `default allowlist should cover ${image}`)
    }
  })

  it('rejects attacker-controlled images via the default allowlist', () => {
    const err = validateDockerImage('attacker.registry.example/evil-payload:latest', null)
    assert.ok(err, 'attacker image must be rejected')
    assert.match(err, /not in the allowlist/)
    assert.match(err, /allowedDockerImages/, 'error must mention the config field')
  })

  it('honors config.allowedDockerImages override (allow custom internal registry)', () => {
    const config = { allowedDockerImages: ['my-company.internal/*'] }
    assert.equal(validateDockerImage('my-company.internal/devbox:latest', config), null)
    const err = validateDockerImage('node:22', config)
    assert.ok(err, 'config.allowedDockerImages REPLACES the default, does not merge')
  })

  it('rejects every image when config.allowedDockerImages is an empty array (fail-closed)', () => {
    const config = { allowedDockerImages: [] }
    const err = validateDockerImage('node:22', config)
    assert.ok(err, 'empty allowlist should reject all')
    assert.equal(validateDockerImage(undefined, config), null)
  })

  it('DEFAULT_ALLOWED_DOCKER_IMAGES includes the main devcontainer sources', () => {
    assert.ok(DEFAULT_ALLOWED_DOCKER_IMAGES.includes('mcr.microsoft.com/devcontainers/*'))
    assert.ok(DEFAULT_ALLOWED_DOCKER_IMAGES.includes('ghcr.io/devcontainers/*'))
    assert.ok(DEFAULT_ALLOWED_DOCKER_IMAGES.includes('node:*'))
    assert.ok(DEFAULT_ALLOWED_DOCKER_IMAGES.includes('python:*'))
  })

  it('exact tag in config pattern does not match a different tag', () => {
    const config = { allowedDockerImages: ['node:22-slim', 'python:3.12'] }
    assert.equal(validateDockerImage('node:22-slim', config), null)
    assert.equal(validateDockerImage('python:3.12', config), null)
    const err = validateDockerImage('node:18-slim', config)
    assert.ok(err, 'exact match must not match a different tag')
  })
})
