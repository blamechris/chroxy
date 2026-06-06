/**
 * #5253 — Control Room self-hosted runner survey.
 *
 * Pins the parse/classify/orchestrate behaviour the WS handler + dashboard
 * build on:
 *   - .runner parsing (incl. the UTF-8 BOM GitHub writes) → agentName/gitHubUrl
 *   - .service → service-manager identity (launchd plist path / systemd unit)
 *   - launchctl + systemctl output → running / pid / lastExitCode
 *   - probeService tolerance (unloaded service → not running)
 *   - gitHubUrl → owner/repo (repo, org, orgs/<org>) + runner-settings URL +
 *     gh api path
 *   - gh api runners JSON → name→view map (labels as strings or {name})
 *   - classifyRunner across every verdict bucket
 *   - surveyRunners end-to-end: grouping by target, multiple runners per repo,
 *     gh enrichment on/off, missing root, summary tally, schema validity
 *
 * NEVER calls real launchctl/systemctl/gh or touches the real home dir — all
 * fs + command output is canned via the `_readdir` / `_readFile` / `_execFile`
 * injection seams.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServerRunnerStatusSnapshotSchema } from '@chroxy/protocol'
import {
  surveyRunners,
  parseRunnerConfig,
  parseServiceIdentity,
  parseLaunchctlList,
  parseSystemctlShow,
  probeService,
  parseGithubTarget,
  buildRunnersUrl,
  ghRunnersApiPath,
  parseGhRunners,
  classifyRunner,
} from '../src/control-room/runners.js'

// A Dirent-like for the injected readdir seam.
const dirent = (name, isDir = true) => ({ name, isDirectory: () => isDir })

describe('control-room/runners — parseRunnerConfig', () => {
  it('parses a BOM-prefixed .runner (the shape GitHub writes)', () => {
    const text = '﻿' + JSON.stringify({ agentName: 'medlens-mac-arm64', gitHubUrl: 'https://github.com/blamechris/medlens' })
    const cfg = parseRunnerConfig(text)
    assert.equal(cfg.agentName, 'medlens-mac-arm64')
    assert.equal(cfg.gitHubUrl, 'https://github.com/blamechris/medlens')
  })

  it('returns null for absent / unparseable input', () => {
    assert.equal(parseRunnerConfig(null), null)
    assert.equal(parseRunnerConfig('{not json'), null)
    assert.equal(parseRunnerConfig('"a string"'), null)
  })

  it('nulls missing/empty fields', () => {
    const cfg = parseRunnerConfig(JSON.stringify({ agentName: '' }))
    assert.equal(cfg.agentName, null)
    assert.equal(cfg.gitHubUrl, null)
  })
})

describe('control-room/runners — parseServiceIdentity', () => {
  it('reads a macOS LaunchAgent plist path → launchd label', () => {
    const s = parseServiceIdentity('/Users/x/Library/LaunchAgents/actions.runner.blamechris-medlens.medlens-mac-arm64.plist\n')
    assert.deepEqual(s, { manager: 'launchd', label: 'actions.runner.blamechris-medlens.medlens-mac-arm64' })
  })

  it('reads a systemd unit name → systemd label (stem)', () => {
    const s = parseServiceIdentity('actions.runner.o-r.host.service')
    assert.deepEqual(s, { manager: 'systemd', label: 'actions.runner.o-r.host' })
  })

  it('treats absent/empty as no service', () => {
    assert.deepEqual(parseServiceIdentity(null), { manager: 'none', label: null })
    assert.deepEqual(parseServiceIdentity('   '), { manager: 'none', label: null })
  })
})

describe('control-room/runners — parseLaunchctlList', () => {
  it('reports running with a live PID', () => {
    const out = '{\n\t"Label" = "actions.runner.x";\n\t"LastExitStatus" = 0;\n\t"PID" = 1778;\n}'
    assert.deepEqual(parseLaunchctlList(out), { running: true, pid: 1778, lastExitCode: 0 })
  })

  it('reports stopped (loaded, no PID) and keeps the last exit code', () => {
    const out = '{\n\t"Label" = "actions.runner.x";\n\t"LastExitStatus" = 1;\n}'
    assert.deepEqual(parseLaunchctlList(out), { running: false, pid: null, lastExitCode: 1 })
  })

  it('handles empty output', () => {
    assert.deepEqual(parseLaunchctlList(''), { running: false, pid: null, lastExitCode: null })
  })
})

describe('control-room/runners — parseSystemctlshow', () => {
  it('reads active state + main pid + exit status', () => {
    const out = 'ActiveState=active\nMainPID=4242\nExecMainStatus=0\n'
    assert.deepEqual(parseSystemctlShow(out), { running: true, pid: 4242, lastExitCode: 0 })
  })

  it('reports inactive with a non-zero last exit', () => {
    const out = 'ActiveState=failed\nMainPID=0\nExecMainStatus=1\n'
    assert.deepEqual(parseSystemctlShow(out), { running: false, pid: null, lastExitCode: 1 })
  })
})

describe('control-room/runners — probeService', () => {
  it('launchd: runs launchctl list and parses it', async () => {
    const calls = []
    const exec = async (file, args) => {
      calls.push([file, ...args])
      return { stdout: '\t"PID" = 99;\n\t"LastExitStatus" = 0;\n' }
    }
    const r = await probeService(exec, { manager: 'launchd', label: 'lbl' })
    assert.deepEqual(r, { running: true, pid: 99, lastExitCode: 0 })
    assert.deepEqual(calls[0], ['launchctl', 'list', 'lbl'])
  })

  it('returns stopped when the probe command throws (service not loaded)', async () => {
    const exec = async () => { throw new Error('Could not find service') }
    const r = await probeService(exec, { manager: 'launchd', label: 'lbl' })
    assert.deepEqual(r, { running: false, pid: null, lastExitCode: null })
  })

  it('returns stopped for a no-service identity without execing', async () => {
    let called = false
    const exec = async () => { called = true; return { stdout: '' } }
    const r = await probeService(exec, { manager: 'none', label: null })
    assert.equal(called, false)
    assert.deepEqual(r, { running: false, pid: null, lastExitCode: null })
  })
})

describe('control-room/runners — parseGithubTarget / urls', () => {
  it('parses a repo URL', () => {
    assert.deepEqual(parseGithubTarget('https://github.com/blamechris/medlens'), { owner: 'blamechris', repo: 'medlens' })
  })
  it('strips .git and trailing slash', () => {
    assert.deepEqual(parseGithubTarget('https://github.com/o/r.git/'), { owner: 'o', repo: 'r' })
  })
  it('parses an org URL (bare and orgs/ form)', () => {
    assert.deepEqual(parseGithubTarget('https://github.com/acme'), { owner: 'acme', repo: null })
    assert.deepEqual(parseGithubTarget('https://github.com/orgs/acme'), { owner: 'acme', repo: null })
  })
  it('nulls a non-GitHub URL', () => {
    assert.deepEqual(parseGithubTarget('https://gitlab.com/o/r'), { owner: null, repo: null })
    assert.deepEqual(parseGithubTarget(null), { owner: null, repo: null })
  })
  it('builds repo + org runner-settings URLs accepted by the schema', () => {
    assert.equal(buildRunnersUrl({ owner: 'o', repo: 'r' }), 'https://github.com/o/r/settings/actions/runners')
    assert.equal(buildRunnersUrl({ owner: 'acme', repo: null }), 'https://github.com/organizations/acme/settings/actions/runners')
    assert.equal(buildRunnersUrl({ owner: null, repo: null }), null)
  })
  it('builds the gh api path for repo + org', () => {
    assert.equal(ghRunnersApiPath({ owner: 'o', repo: 'r' }), 'repos/o/r/actions/runners')
    assert.equal(ghRunnersApiPath({ owner: 'acme', repo: null }), 'orgs/acme/actions/runners')
    assert.equal(ghRunnersApiPath({ owner: null, repo: null }), null)
  })
})

describe('control-room/runners — parseGhRunners', () => {
  it('maps name → view, normalising labels from {name} objects', () => {
    const json = JSON.stringify({
      total_count: 1,
      runners: [{ name: 'medlens-mac-arm64', os: 'macOS', status: 'online', busy: true, labels: [{ name: 'self-hosted' }, { name: 'ARM64' }] }],
    })
    const map = parseGhRunners(json)
    const v = map.get('medlens-mac-arm64')
    assert.equal(v.status, 'online')
    assert.equal(v.busy, true)
    assert.equal(v.os, 'macOS')
    assert.deepEqual(v.labels, ['self-hosted', 'ARM64'])
  })

  it('accepts a bare array and string labels', () => {
    const map = parseGhRunners(JSON.stringify([{ name: 'n', status: 'offline', busy: false, labels: ['x'] }]))
    assert.deepEqual(map.get('n').labels, ['x'])
    assert.equal(map.get('n').status, 'offline')
  })

  it('returns an empty map on null / unparseable / wrong shape', () => {
    assert.equal(parseGhRunners(null).size, 0)
    assert.equal(parseGhRunners('{bad').size, 0)
    assert.equal(parseGhRunners(JSON.stringify({ nope: 1 })).size, 0)
  })
})

describe('control-room/runners — classifyRunner', () => {
  const svc = (over = {}) => ({ manager: 'launchd', label: 'l', running: true, ...over })
  it('unregistered when no service', () => {
    assert.equal(classifyRunner({ manager: 'none', label: null, running: false }, null), 'unregistered')
  })
  it('stopped when not running', () => {
    assert.equal(classifyRunner(svc({ running: false }), { status: 'online', busy: false }), 'stopped')
  })
  it('busy when running + online + busy', () => {
    assert.equal(classifyRunner(svc(), { status: 'online', busy: true }), 'busy')
  })
  it('idle when running + online + not busy', () => {
    assert.equal(classifyRunner(svc(), { status: 'online', busy: false }), 'idle')
  })
  it('idle when running but no GitHub view (locally healthy)', () => {
    assert.equal(classifyRunner(svc(), null), 'idle')
  })
  it('offline when running locally but GitHub says offline (mismatch)', () => {
    assert.equal(classifyRunner(svc(), { status: 'offline', busy: false }), 'offline')
  })
})

describe('control-room/runners — surveyRunners (end-to-end)', () => {
  // A fake host: two repos, one with two runners (one running+busy, one
  // stopped), one with a single unregistered install.
  const files = {
    '/root/actions-runner-medlens/.runner': '﻿' + JSON.stringify({ agentName: 'medlens-mac-arm64', gitHubUrl: 'https://github.com/blamechris/medlens' }),
    '/root/actions-runner-medlens/.service': '/x/LaunchAgents/actions.runner.blamechris-medlens.medlens-mac-arm64.plist',
    '/root/actions-runner-aa/.runner': JSON.stringify({ agentName: 'aa-1', gitHubUrl: 'https://github.com/blamechris/archery-apprentice' }),
    '/root/actions-runner-aa/.service': '/x/LaunchAgents/actions.runner.blamechris-archery-apprentice.aa-1.plist',
    '/root/actions-runner-aa2/.runner': JSON.stringify({ agentName: 'aa-2', gitHubUrl: 'https://github.com/blamechris/archery-apprentice' }),
    '/root/actions-runner-aa2/.service': '/x/LaunchAgents/actions.runner.blamechris-archery-apprentice.aa-2.plist',
    '/root/actions-runner-orphan/.runner': JSON.stringify({ agentName: 'orphan', gitHubUrl: 'https://github.com/blamechris/orphan' }),
    // no .service for orphan → unregistered
    '/root/not-a-runner/readme.txt': 'hi', // dir without .runner → skipped
  }

  const readdir = async (root) => {
    assert.equal(root, '/root')
    return [
      dirent('actions-runner-medlens'),
      dirent('actions-runner-aa'),
      dirent('actions-runner-aa2'),
      dirent('actions-runner-orphan'),
      dirent('not-a-runner'),
      dirent('a-file', false), // not a directory → ignored
    ]
  }
  const readFile = async (p) => {
    if (p in files) return files[p]
    const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err
  }

  // launchctl: medlens + aa-1 running; aa-2 stopped (loaded, no PID).
  const runningLabels = new Set([
    'actions.runner.blamechris-medlens.medlens-mac-arm64',
    'actions.runner.blamechris-archery-apprentice.aa-1',
  ])
  const ghByRepo = {
    'repos/blamechris/medlens/actions/runners': JSON.stringify({ runners: [{ name: 'medlens-mac-arm64', os: 'macOS', status: 'online', busy: true, labels: [{ name: 'self-hosted' }] }] }),
    'repos/blamechris/archery-apprentice/actions/runners': JSON.stringify({ runners: [
      { name: 'aa-1', os: 'macOS', status: 'online', busy: false, labels: [{ name: 'self-hosted' }] },
      { name: 'aa-2', os: 'macOS', status: 'offline', busy: false, labels: [] },
    ] }),
    'repos/blamechris/orphan/actions/runners': JSON.stringify({ runners: [] }),
  }
  const execFile = async (file, args) => {
    if (file === 'launchctl') {
      const label = args[1]
      if (runningLabels.has(label)) return { stdout: `\t"PID" = 100;\n\t"LastExitStatus" = 0;\n` }
      return { stdout: `\t"LastExitStatus" = 0;\n` } // loaded, stopped
    }
    if (file === 'gh') {
      const path = args[1]
      if (path in ghByRepo) return { stdout: ghByRepo[path] }
      throw new Error('not found')
    }
    throw new Error(`unexpected exec ${file}`)
  }

  const baseOpts = () => ({
    root: '/root',
    _readdir: readdir,
    _readFile: readFile,
    _execFile: execFile,
    _now: () => new Date('2026-06-06T12:00:00.000Z'),
  })

  it('groups runners by repo and classifies each verdict', async () => {
    const snap = await surveyRunners(baseOpts())
    assert.equal(snap.generatedAt, '2026-06-06T12:00:00.000Z')
    assert.equal(snap.root, '/root')

    const byName = Object.fromEntries(snap.repos.map(r => [r.name, r]))
    // archery-apprentice has two runners grouped together.
    const aa = byName['archery-apprentice']
    assert.ok(aa)
    assert.equal(aa.runners.length, 2)
    assert.equal(aa.runnersUrl, 'https://github.com/blamechris/archery-apprentice/settings/actions/runners')
    const aaByName = Object.fromEntries(aa.runners.map(r => [r.name, r]))
    assert.equal(aaByName['aa-1'].verdict, 'idle')
    assert.equal(aaByName['aa-1'].service.pid, 100)
    assert.equal(aaByName['aa-2'].verdict, 'stopped') // not running locally
    assert.equal(aaByName['aa-2'].service.running, false)

    // medlens: running + online + busy → busy.
    assert.equal(byName['medlens'].runners[0].verdict, 'busy')
    assert.equal(byName['medlens'].runners[0].busy, true)
    assert.deepEqual(byName['medlens'].runners[0].labels, ['self-hosted'])

    // orphan: no .service → unregistered.
    assert.equal(byName['orphan'].runners[0].verdict, 'unregistered')
    assert.equal(byName['orphan'].runners[0].service.manager, 'none')
  })

  it('summary tally matches the per-runner verdicts', async () => {
    const snap = await surveyRunners(baseOpts())
    assert.equal(snap.summary.total, 4)
    assert.equal(snap.summary.busy, 1)
    assert.equal(snap.summary.idle, 1)
    assert.equal(snap.summary.stopped, 1)
    assert.equal(snap.summary.unregistered, 1)
    assert.equal(snap.summary.offline, 0)
  })

  it('produces a schema-valid snapshot', async () => {
    const snap = await surveyRunners(baseOpts())
    const parsed = ServerRunnerStatusSnapshotSchema.safeParse({ type: 'runner_status_snapshot', ...snap })
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  })

  it('includeGithub:false skips gh and leaves GitHub fields null (local-only)', async () => {
    let ghCalled = false
    const exec = async (file, args) => {
      if (file === 'gh') { ghCalled = true }
      return execFile(file, args)
    }
    const snap = await surveyRunners({ ...baseOpts(), _execFile: exec, includeGithub: false })
    assert.equal(ghCalled, false)
    const medlens = snap.repos.find(r => r.name === 'medlens')
    assert.equal(medlens.runners[0].githubStatus, null)
    assert.equal(medlens.runners[0].busy, null)
    // Running locally with no GitHub view → idle (not busy, since busy is unknown).
    assert.equal(medlens.runners[0].verdict, 'idle')
  })

  it('returns an empty snapshot when the root does not exist', async () => {
    const snap = await surveyRunners({
      ...baseOpts(),
      _readdir: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
    })
    assert.deepEqual(snap.repos, [])
    assert.equal(snap.summary.total, 0)
  })

  it('does not let a single failing gh call sink the survey', async () => {
    const exec = async (file, args) => {
      if (file === 'gh') throw new Error('gh: HTTP 403')
      return execFile(file, args)
    }
    const snap = await surveyRunners({ ...baseOpts(), _execFile: exec })
    // Local service state still classifies them; GitHub fields fall back to null.
    const aa = snap.repos.find(r => r.name === 'archery-apprentice')
    const aa1 = aa.runners.find(r => r.name === 'aa-1')
    assert.equal(aa1.verdict, 'idle') // running locally, no gh view
    assert.equal(aa1.githubStatus, null)
  })
})
