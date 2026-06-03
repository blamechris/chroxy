import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseDevContainer,
  validateMounts,
  sanitizeContainerEnv,
  extractMountSource,
} from '../src/devcontainer-config.js'

let tmpDir
let warnings
let infos

const captureLogger = {
  info: (m) => infos.push(m),
  warn: (m) => warnings.push(m),
  error: () => {},
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-dc-cfg-'))
  warnings = []
  infos = []
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('parseDevContainer()', () => {
  it('returns {} when no devcontainer.json is present', () => {
    const config = parseDevContainer(tmpDir, { logger: captureLogger })
    assert.deepEqual(config, {})
    assert.ok(infos.some(m => m.includes('No devcontainer.json found')))
  })

  it('prefers .devcontainer/devcontainer.json over .devcontainer.json sidecar', () => {
    mkdirSync(join(tmpDir, '.devcontainer'), { recursive: true })
    writeFileSync(join(tmpDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({ image: 'A' }))
    writeFileSync(join(tmpDir, '.devcontainer.json'), JSON.stringify({ image: 'B' }))
    const config = parseDevContainer(tmpDir, { logger: captureLogger })
    assert.equal(config.image, 'A')
  })

  it('falls back to .devcontainer.json sidecar when .devcontainer dir is absent', () => {
    writeFileSync(join(tmpDir, '.devcontainer.json'), JSON.stringify({ image: 'sidecar' }))
    const config = parseDevContainer(tmpDir, { logger: captureLogger })
    assert.equal(config.image, 'sidecar')
  })

  it('returns {} on malformed JSON without throwing', () => {
    mkdirSync(join(tmpDir, '.devcontainer'), { recursive: true })
    writeFileSync(join(tmpDir, '.devcontainer', 'devcontainer.json'), '{ this is not json')
    const config = parseDevContainer(tmpDir, { logger: captureLogger })
    assert.deepEqual(config, {})
    assert.ok(warnings.some(m => m.includes('Failed to parse')))
  })

  it('keeps only supported fields and warns on unsupported ones', () => {
    mkdirSync(join(tmpDir, '.devcontainer'), { recursive: true })
    writeFileSync(join(tmpDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      image: 'node:20',
      remoteUser: 'dev',
      postCreateCommand: 'npm install',
      forwardPorts: [3000, '8080:80'],
      mounts: ['source=/proj,target=/workspace,type=bind'],
      containerEnv: { LANG: 'en_US.UTF-8' },
      runArgs: ['--rm'],
      features: { 'ghcr.io/devcontainers/features/python': {} },
    }))
    const config = parseDevContainer(tmpDir, { logger: captureLogger })
    assert.equal(config.image, 'node:20')
    assert.equal(config.remoteUser, 'dev')
    assert.equal(config.postCreateCommand, 'npm install')
    assert.deepEqual(config.forwardPorts, [3000, '8080:80'])
    assert.deepEqual(config.mounts, ['source=/proj,target=/workspace,type=bind'])
    assert.deepEqual(config.containerEnv, { LANG: 'en_US.UTF-8' })
    assert.equal(config.runArgs, undefined)
    assert.equal(config.features, undefined)
    assert.equal(warnings.filter(m => m.includes('unsupported field')).length, 2)
  })

  it('drops empty-string fields and non-array mounts/forwardPorts', () => {
    mkdirSync(join(tmpDir, '.devcontainer'), { recursive: true })
    writeFileSync(join(tmpDir, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      image: '   ',
      remoteUser: '',
      forwardPorts: 'not-an-array',
      mounts: 42,
      containerEnv: ['not', 'an', 'object'],
    }))
    const config = parseDevContainer(tmpDir, { logger: captureLogger })
    assert.equal(config.image, undefined)
    assert.equal(config.remoteUser, undefined)
    assert.equal(config.forwardPorts, undefined)
    assert.equal(config.mounts, undefined)
    assert.equal(config.containerEnv, undefined)
  })

  it('accepts a no-op logger when omitted (no throw)', () => {
    const config = parseDevContainer(tmpDir)
    assert.deepEqual(config, {})
  })
})

describe('validateMounts()', () => {
  it('returns undefined for null/empty input', () => {
    assert.equal(validateMounts(undefined, '/proj'), undefined)
    assert.equal(validateMounts([], '/proj'), undefined)
  })

  it('keeps mounts whose source is inside cwd', () => {
    const result = validateMounts([
      `source=${tmpDir}/sub,target=/workspace/sub,type=bind`,
    ], tmpDir, { logger: captureLogger })
    assert.equal(result.length, 1)
  })

  it('rejects mounts whose source escapes cwd', () => {
    const result = validateMounts([
      'source=/etc/shadow,target=/workspace/shadow,type=bind',
      `source=${tmpDir}/../sibling,target=/workspace/sibling,type=bind`,
    ], tmpDir, { logger: captureLogger })
    assert.equal(result, undefined)
    assert.equal(warnings.length, 2)
    assert.ok(warnings.every(m => m.includes('outside project dir')))
  })

  it('handles short-form `source:target` syntax', () => {
    const result = validateMounts([
      `${tmpDir}/local:/workspace/local`,
    ], tmpDir, { logger: captureLogger })
    assert.equal(result.length, 1)
  })

  it('logs and skips unparseable mount strings', () => {
    const result = validateMounts(['not-a-mount-string'], tmpDir, { logger: captureLogger })
    assert.equal(result, undefined)
    assert.ok(warnings.some(m => m.includes('unparseable')))
  })
})

describe('extractMountSource()', () => {
  it('parses long-form source=...,target=...,type=bind', () => {
    assert.equal(
      extractMountSource('source=/proj/sub,target=/workspace/sub,type=bind'),
      '/proj/sub',
    )
  })

  it('parses short-form source:target', () => {
    assert.equal(extractMountSource('/proj/sub:/workspace/sub'), '/proj/sub')
  })

  it('parses short-form with mount options', () => {
    assert.equal(extractMountSource('/proj/sub:/workspace/sub:ro'), '/proj/sub')
  })

  it('returns null for invalid input', () => {
    assert.equal(extractMountSource('just-a-string'), null)
  })
})

describe('sanitizeContainerEnv()', () => {
  it('returns undefined for null/empty input', () => {
    assert.equal(sanitizeContainerEnv(undefined), undefined)
    assert.equal(sanitizeContainerEnv(null), undefined)
    assert.equal(sanitizeContainerEnv({}), undefined)
  })

  it('keeps POSIX-valid env keys', () => {
    const result = sanitizeContainerEnv({
      LANG: 'C',
      NODE_OPTIONS: '--max-old-space-size=2048',
      _PRIVATE: '1',
    })
    assert.deepEqual({ ...result }, {
      LANG: 'C',
      NODE_OPTIONS: '--max-old-space-size=2048',
      _PRIVATE: '1',
    })
  })

  it('drops keys with shell-dangerous characters', () => {
    const result = sanitizeContainerEnv({
      'BAD;KEY': 'evil',
      'BAD KEY': 'evil',
      'BAD$KEY': 'evil',
      'GOOD_KEY': 'fine',
    }, { logger: captureLogger })
    assert.deepEqual({ ...result }, { GOOD_KEY: 'fine' })
    assert.equal(warnings.length, 3)
  })

  it('drops keys starting with a digit', () => {
    const result = sanitizeContainerEnv({ '1KEY': 'no', VALID_KEY: 'yes' }, { logger: captureLogger })
    assert.deepEqual({ ...result }, { VALID_KEY: 'yes' })
  })
})
