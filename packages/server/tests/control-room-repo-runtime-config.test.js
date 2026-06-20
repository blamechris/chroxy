/**
 * #6139 (epic #5530) — per-repo runtime config survey (read-only).
 *
 * Unit-tests the pure survey module with injected fs/devcontainer seams so it
 * never touches a real working tree or parses a real devcontainer.json:
 *   - inspectRepo: devcontainer/compose detection, the image a repo would run +
 *     the allowlist verdict, and the never-throws degradation path.
 *   - effectiveAllowlist: config override vs the built-in default (incl. an
 *     explicit empty array = deny-all).
 *   - surveyRepoRuntimeConfig: effective backend + source, the isolation
 *     constant, summary counts, empty/degraded inputs.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import {
  surveyRepoRuntimeConfig,
  inspectRepo,
  effectiveAllowlist,
  summarizeRepoRuntime,
  ISOLATION_DEFAULT,
  DEFAULT_ENV_IMAGE,
} from '../src/control-room/repo-runtime-config.js'
import { DEFAULT_ALLOWED_DOCKER_IMAGES } from '../src/docker-image-allowlist.js'

/** existsSync stub: true only for the exact absolute paths in `present`. */
function existsStub(present) {
  const set = new Set(present)
  return (p) => set.has(p)
}

describe('#6139 DEFAULT_ENV_IMAGE pin', () => {
  it('matches environment-manager.js DEFAULT_IMAGE (node:22-slim) — guards against drift', () => {
    assert.equal(DEFAULT_ENV_IMAGE, 'node:22-slim')
  })
})

describe('#6139 effectiveAllowlist', () => {
  it('uses the built-in default when config has no allowedDockerImages', () => {
    const a = effectiveAllowlist({})
    assert.equal(a.source, 'default')
    assert.deepEqual(a.patterns, DEFAULT_ALLOWED_DOCKER_IMAGES)
  })

  it('uses a config override when allowedDockerImages is an array', () => {
    const a = effectiveAllowlist({ allowedDockerImages: ['mycorp/*'] })
    assert.equal(a.source, 'config')
    assert.deepEqual(a.patterns, ['mycorp/*'])
  })

  it('treats an explicit empty array as a (deny-all) config override', () => {
    const a = effectiveAllowlist({ allowedDockerImages: [] })
    assert.equal(a.source, 'config')
    assert.deepEqual(a.patterns, [])
  })
})

describe('#6139 inspectRepo', () => {
  const repo = { name: 'app', path: '/repos/app' }

  it('detects a devcontainer + its image, with the allowlist verdict', () => {
    const dcPath = join('/repos/app', '.devcontainer', 'devcontainer.json')
    const entry = inspectRepo(repo, {
      allowlistPatterns: DEFAULT_ALLOWED_DOCKER_IMAGES,
      _existsSync: existsStub([dcPath]),
      _parseDevContainer: () => ({ image: 'node:22' }),
    })
    assert.equal(entry.devcontainer.present, true)
    assert.equal(entry.devcontainer.path, dcPath)
    assert.equal(entry.image, 'node:22')
    assert.equal(entry.imageSource, 'devcontainer')
    assert.equal(entry.imageAllowed, true)
    assert.equal(entry.error, null)
  })

  it('falls back to the default image (and its allowlist verdict) with no devcontainer', () => {
    const entry = inspectRepo(repo, {
      allowlistPatterns: DEFAULT_ALLOWED_DOCKER_IMAGES,
      _existsSync: existsStub([]),
      _parseDevContainer: () => ({}),
    })
    assert.equal(entry.devcontainer.present, false)
    assert.equal(entry.devcontainer.path, null)
    assert.equal(entry.image, DEFAULT_ENV_IMAGE)
    assert.equal(entry.imageSource, 'default')
    assert.equal(entry.imageAllowed, true) // node:22-slim matches node:*
  })

  it('marks a devcontainer image NOT in the allowlist as denied', () => {
    const dcPath = join('/repos/app', '.devcontainer', 'devcontainer.json')
    const entry = inspectRepo(repo, {
      allowlistPatterns: ['node:*'],
      _existsSync: existsStub([dcPath]),
      _parseDevContainer: () => ({ image: 'evil/backdoor:latest' }),
    })
    assert.equal(entry.imageAllowed, false)
  })

  it('detects compose from a devcontainer dockerComposeFile', () => {
    const dcPath = join('/repos/app', '.devcontainer', 'devcontainer.json')
    const entry = inspectRepo(repo, {
      _existsSync: existsStub([dcPath]),
      _parseDevContainer: () => ({ dockerComposeFile: ['docker-compose.yml', 'docker-compose.override.yml'] }),
    })
    assert.equal(entry.compose.present, true)
    assert.deepEqual(entry.compose.files, ['docker-compose.yml', 'docker-compose.override.yml'])
  })

  it('detects compose from a repo-root compose file when the devcontainer names none', () => {
    const composePath = join('/repos/app', 'compose.yaml')
    const entry = inspectRepo(repo, {
      _existsSync: existsStub([composePath]),
      _parseDevContainer: () => ({}),
    })
    assert.equal(entry.compose.present, true)
    assert.deepEqual(entry.compose.files, ['compose.yaml'])
  })

  it('reports no compose when neither source has one', () => {
    const entry = inspectRepo(repo, { _existsSync: existsStub([]), _parseDevContainer: () => ({}) })
    assert.equal(entry.compose.present, false)
    assert.deepEqual(entry.compose.files, [])
  })

  it('degrades to an error entry (never throws) when devcontainer parsing blows up', () => {
    const dcPath = join('/repos/app', '.devcontainer', 'devcontainer.json')
    const entry = inspectRepo(repo, {
      _existsSync: existsStub([dcPath]),
      _parseDevContainer: () => { throw new Error('boom parsing') },
    })
    assert.match(entry.error, /boom parsing/)
    assert.equal(entry.image, null)
    assert.equal(entry.imageAllowed, null)
    assert.equal(entry.devcontainer.present, false)
  })

  it('errors a repo with no path', () => {
    const entry = inspectRepo({ name: 'x', path: '' }, {})
    assert.match(entry.error, /no path/)
  })
})

describe('#6139 summarizeRepoRuntime', () => {
  it('counts devcontainer/compose/denied/errored buckets', () => {
    const s = summarizeRepoRuntime([
      { devcontainer: { present: true }, compose: { present: true }, imageAllowed: true },
      { devcontainer: { present: false }, compose: { present: false }, imageAllowed: false },
      { error: 'unreadable' },
    ])
    assert.deepEqual(s, { total: 3, withDevcontainer: 1, withCompose: 1, imagesDenied: 1, errored: 1 })
  })
})

describe('#6139 surveyRepoRuntimeConfig', () => {
  const fixedNow = () => new Date('2026-06-19T12:00:00.000Z')

  it('reports the default backend + isolation constant for an empty repo set', () => {
    const snap = surveyRepoRuntimeConfig({ repoSet: [], config: {}, _now: fixedNow })
    assert.equal(snap.backend, 'docker')
    assert.equal(snap.backendSource, 'default')
    assert.equal(snap.isolation, ISOLATION_DEFAULT)
    assert.equal(snap.allowlist.source, 'default')
    assert.deepEqual(snap.repos, [])
    assert.equal(snap.summary.total, 0)
    assert.equal(snap.generatedAt, '2026-06-19T12:00:00.000Z')
  })

  it('reports a config-driven backend as source "config"', () => {
    const snap = surveyRepoRuntimeConfig({
      repoSet: [],
      config: { environments: { backend: 'k8s' } },
      _now: fixedNow,
    })
    assert.equal(snap.backend, 'k8s')
    assert.equal(snap.backendSource, 'config')
  })

  it('a backend typo falls back to docker with source "default"', () => {
    const snap = surveyRepoRuntimeConfig({
      repoSet: [],
      config: { environments: { backend: 'kubernetez' } },
      _now: fixedNow,
    })
    assert.equal(snap.backend, 'docker')
    assert.equal(snap.backendSource, 'default')
  })

  it('inspects each repo in the set and rolls up the summary', () => {
    const appDc = join('/repos/app', '.devcontainer', 'devcontainer.json')
    const snap = surveyRepoRuntimeConfig({
      repoSet: [
        { name: 'app', path: '/repos/app' },
        { name: 'lib', path: '/repos/lib' },
      ],
      config: {},
      _existsSync: existsStub([appDc]),
      _parseDevContainer: (cwd) => (cwd === '/repos/app' ? { image: 'python:3.12' } : {}),
      _now: fixedNow,
    })
    assert.equal(snap.repos.length, 2)
    assert.equal(snap.repos[0].devcontainer.present, true)
    assert.equal(snap.repos[0].image, 'python:3.12')
    assert.equal(snap.repos[1].devcontainer.present, false)
    assert.equal(snap.repos[1].image, DEFAULT_ENV_IMAGE)
    assert.equal(snap.summary.total, 2)
    assert.equal(snap.summary.withDevcontainer, 1)
  })
})
