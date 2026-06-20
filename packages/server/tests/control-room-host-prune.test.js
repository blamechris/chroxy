import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  surveyHostPrune,
  runHostPrune,
  parseContainerLines,
  parseImageLines,
  trackedResources,
  sumBytes,
  CHROXY_CONTAINER_PREFIX,
  PRUNABLE_CONTAINER_STATES,
} from '../src/control-room/host-prune.js'

/**
 * Tests for the #6140 host prune guardrails survey + action (epic #5530).
 *
 * Everything is stubbed via an injected `_execFile` so no real docker is needed.
 * The survey/action are chroxy-scoped (name prefix + image repos) and ORPHAN-only
 * (tracked env resources excluded) — the tests assert both guards hold.
 */

/**
 * Build an execFile stub that dispatches on the docker subcommand. `ps` and
 * `images` return canned stdout; `rm`/`rmi` resolve unless their id is in
 * `failIds`. Records every call for assertions.
 */
function execStub({ psOut = '', imagesOut = {}, failIds = new Set(), psError = null } = {}) {
  const calls = []
  const fn = async (cmd, args) => {
    calls.push({ cmd, args: [...args] })
    const sub = args[0]
    if (sub === 'ps') {
      if (psError) throw psError instanceof Error ? psError : new Error(psError)
      return { stdout: psOut }
    }
    if (sub === 'images') {
      const repo = args[1]
      return { stdout: imagesOut[repo] ?? '' }
    }
    if (sub === 'rm' || sub === 'rmi') {
      const id = args[args.length - 1]
      if (failIds.has(id)) throw new Error(`no such ${sub === 'rm' ? 'container' : 'image'}: ${id}`)
      return { stdout: '' }
    }
    return { stdout: '' }
  }
  fn.calls = calls
  return fn
}

const NOW = () => new Date('2026-06-19T12:00:00.000Z')

describe('parseContainerLines()', () => {
  it('keeps only chroxy-prefixed, prunable-state rows and parses the writable size', () => {
    const out = parseContainerLines([
      'aaa\tchroxy-env-foo\texited\t12.5MB (virtual 1.2GB)',
      'bbb\tchroxy-env-bar\tcreated\t0B (virtual 1.2GB)',
      'ccc\tchroxy-env-run\trunning\t5MB (virtual 1GB)',     // running → excluded
      'ddd\tsome-other\texited\t9MB (virtual 1GB)',           // not chroxy → excluded
      'eee\tmy-chroxy-env-trap\texited\t3MB (virtual 1GB)',   // contains but doesn't start with prefix → excluded
    ].join('\n'))
    assert.deepEqual(out.map((c) => c.id), ['aaa', 'bbb'])
    assert.equal(out[0].sizeBytes, 12_500_000)
    assert.equal(out[1].sizeBytes, 0)
  })

  it('trusted: accepts a non-chroxy-named row (label-identified, #6155)', () => {
    // The label-filtered docker query already proved membership, so a row whose
    // name doesn't follow the legacy prefix is still kept.
    const out = parseContainerLines('zzz\tweird-name\texited\t1MB (virtual 2MB)', { trusted: true })
    assert.deepEqual(out.map((c) => c.id), ['zzz'])
    // running is still excluded even when trusted (prunable-state gate stays).
    assert.deepEqual(parseContainerLines('zzz\tweird-name\trunning\t1MB', { trusted: true }), [])
  })
})

describe('parseImageLines()', () => {
  it('keeps only chroxy image repos and builds repo:tag refs', () => {
    const out = parseImageLines([
      'img1\tchroxy-env\tfoo-123\t1.2GB',
      'img2\tchroxy-byok-snap\tabc-1\t800MB',
      'img3\tnode\t22-slim\t900MB',           // non-chroxy → excluded
      'img4\tchroxy-env\t<none>\t100MB',       // dangling → ref falls back to repo
    ].join('\n'))
    assert.deepEqual(out.map((i) => i.ref), ['chroxy-env:foo-123', 'chroxy-byok-snap:abc-1', 'chroxy-env'])
    assert.equal(out[0].sizeBytes, 1_200_000_000)
  })

  it('trusted: accepts an image in a non-chroxy repo (label-identified, #6155)', () => {
    // A label-filtered docker query can return an image whose repository isn't in
    // the legacy set — trusted keeps it (membership proven by the label).
    const out = parseImageLines('imgX\tmy-custom-repo\tv1\t50MB', { trusted: true })
    assert.deepEqual(out.map((i) => i.ref), ['my-custom-repo:v1'])
  })
})

describe('trackedResources()', () => {
  it('collects full + short container ids and image refs', () => {
    const t = trackedResources([
      { containerId: 'abcdef0123456789abc', image: 'chroxy-env:live-1' },
      { containerId: '', image: '' },
    ])
    assert.ok(t.containerIds.has('abcdef0123456789abc'))
    assert.ok(t.containerIds.has('abcdef012345'))
    assert.ok(t.imageRefs.has('chroxy-env:live-1'))
  })
})

describe('sumBytes()', () => {
  it('treats null sizes as 0', () => {
    assert.equal(sumBytes([{ sizeBytes: 5 }, { sizeBytes: null }, { sizeBytes: 10 }]), 15)
  })
})

// All survey/run calls inject listByokSnapshots so they never read the real
// ~/.chroxy/snapshots/ sidecar dir (the default). Empty = no retained BYOK snaps.
const NO_BYOK = () => []

describe('surveyHostPrune()', () => {
  it('reports chroxy-scoped orphan containers + images with a reclaimable estimate', async () => {
    const _execFile = execStub({
      psOut: 'aaa\tchroxy-env-foo\texited\t10MB (virtual 1GB)',
      imagesOut: {
        'chroxy-env': 'img1\tchroxy-env\tfoo-1\t1GB',
        'chroxy-byok-snap': 'img2\tchroxy-byok-snap\tabc-1\t500MB',
      },
    })
    const snap = await surveyHostPrune({ listEnvironments: () => [], listByokSnapshots: NO_BYOK, _execFile, _now: NOW })
    assert.equal(snap.dockerAvailable, true)
    assert.equal(snap.summary.containerCount, 1)
    // No sidecar → the chroxy-byok-snap image is a true orphan, so both images prune.
    assert.equal(snap.summary.imageCount, 2)
    assert.equal(snap.summary.reclaimableBytes, 10_000_000 + 1_000_000_000 + 500_000_000)
    assert.equal(snap.generatedAt, '2026-06-19T12:00:00.000Z')
  })

  it('unions the label-identified set with the legacy name/repo set, deduped (#6155)', async () => {
    // A bespoke exec that returns DIFFERENT rows for the label query vs the legacy
    // query, so we can prove: (a) a labeled container with a non-conventional name
    // is found via the label path, (b) a legacy unlabeled chroxy-env-* container is
    // found via the name path, (c) one returned by BOTH is deduped to a single row.
    const calls = []
    const _execFile = async (_cmd, args) => {
      calls.push(args)
      if (args[0] === 'ps') {
        if (args.includes('label=com.chroxy.managed=true')) {
          return { stdout: [
            'labeledX\trenamed-by-user\texited\t1MB (virtual 9MB)',     // labeled, non-conventional name
            'bothid00\tchroxy-env-both\texited\t2MB (virtual 9MB)',     // labeled AND conventional
          ].join('\n') }
        }
        // legacy name query
        return { stdout: [
          'bothid00\tchroxy-env-both\texited\t2MB (virtual 9MB)',       // same as above → dedup
          'legacyId0\tchroxy-env-old\texited\t3MB (virtual 9MB)',       // unlabeled legacy
        ].join('\n') }
      }
      if (args[0] === 'images') {
        if (args.includes('label=com.chroxy.managed=true')) {
          return { stdout: 'limg\tmy-custom\tv1\t10MB' }                // labeled, non-chroxy repo
        }
        return { stdout: args[1] === 'chroxy-env' ? 'rimg\tchroxy-env\told-1\t20MB' : '' }
      }
      return { stdout: '' }
    }
    const snap = await surveyHostPrune({ listEnvironments: () => [], listByokSnapshots: NO_BYOK, _execFile, _now: NOW })
    assert.deepEqual(snap.containers.map((c) => c.id).sort(), ['bothid00', 'labeledX', 'legacyId0'])
    assert.equal(snap.summary.containerCount, 3) // deduped (bothid00 once)
    assert.deepEqual(snap.images.map((i) => i.id).sort(), ['limg', 'rimg'])
  })

  it('excludes containers + images tracked by a live env (orphan-only)', async () => {
    const _execFile = execStub({
      psOut: [
        'live123456789\tchroxy-env-live\texited\t10MB (virtual 1GB)',
        'orphanaaa\tchroxy-env-orphan\texited\t5MB (virtual 1GB)',
      ].join('\n'),
      imagesOut: {
        'chroxy-env': 'imglive\tchroxy-env\tlive-1\t1GB\nimgorph\tchroxy-env\torph-1\t200MB',
        'chroxy-byok-snap': '',
      },
    })
    const snap = await surveyHostPrune({
      listEnvironments: () => [{ containerId: 'live123456789abcdef', image: 'chroxy-env:live-1' }],
      listByokSnapshots: NO_BYOK,
      _execFile,
      _now: NOW,
    })
    assert.deepEqual(snap.containers.map((c) => c.id), ['orphanaaa'])
    assert.deepEqual(snap.images.map((i) => i.ref), ['chroxy-env:orph-1'])
  })

  it('excludes a retained per-env SNAPSHOT image (env.snapshots[]), not just env.image', async () => {
    const _execFile = execStub({
      psOut: '',
      imagesOut: {
        'chroxy-env': 'imgsnap\tchroxy-env\tlive-100\t1GB\nimgorph\tchroxy-env\tdead-200\t300MB',
        'chroxy-byok-snap': '',
      },
    })
    const snap = await surveyHostPrune({
      // env on base image node:22-slim, with a saved snapshot chroxy-env:live-100.
      listEnvironments: () => [{
        containerId: 'c1', image: 'node:22-slim',
        snapshots: [{ id: 'snap-1', image: 'chroxy-env:live-100' }],
      }],
      listByokSnapshots: NO_BYOK,
      _execFile,
      _now: NOW,
    })
    // The saved snapshot is excluded; only the genuine orphan remains.
    assert.deepEqual(snap.images.map((i) => i.ref), ['chroxy-env:dead-200'])
  })

  it('excludes a sidecar-backed BYOK snapshot image; prunes a sidecar-less one', async () => {
    const _execFile = execStub({
      psOut: '',
      imagesOut: {
        'chroxy-env': '',
        'chroxy-byok-snap': 'imgkeep\tchroxy-byok-snap\tkeep-1\t1GB\nimgorph\tchroxy-byok-snap\torph-1\t500MB',
      },
    })
    const snap = await surveyHostPrune({
      listEnvironments: () => [],
      listByokSnapshots: () => [{ tag: 'chroxy-byok-snap:keep-1' }],
      _execFile,
      _now: NOW,
    })
    assert.deepEqual(snap.images.map((i) => i.ref), ['chroxy-byok-snap:orph-1'])
  })

  it('FAILS CLOSED: skips image pruning entirely when the BYOK sidecar store is unreadable', async () => {
    const _execFile = execStub({
      psOut: 'aaa\tchroxy-env-foo\texited\t10MB (virtual 1GB)',
      imagesOut: { 'chroxy-env': 'img1\tchroxy-env\tfoo-1\t1GB', 'chroxy-byok-snap': '' },
    })
    const snap = await surveyHostPrune({
      listEnvironments: () => [],
      listByokSnapshots: () => { throw new Error('snapshots dir unreadable') },
      _execFile,
      _now: NOW,
    })
    assert.equal(snap.summary.containerCount, 1) // containers still surveyed
    assert.deepEqual(snap.images, [])            // images skipped — no false orphans
    assert.match(snap.note, /image pruning skipped/i)
  })

  it('degrades to dockerAvailable:false when docker ps fails', async () => {
    const _execFile = execStub({ psError: 'Cannot connect to the Docker daemon' })
    const snap = await surveyHostPrune({ listByokSnapshots: NO_BYOK, _execFile, _now: NOW })
    assert.equal(snap.dockerAvailable, false)
    assert.match(snap.note, /docker is unavailable/)
    assert.deepEqual(snap.containers, [])
    assert.deepEqual(snap.images, [])
  })

  it('queries by the managed label first, then the legacy name/repo filters (#6155)', async () => {
    const _execFile = execStub({ psOut: '', imagesOut: {} })
    await surveyHostPrune({ listByokSnapshots: NO_BYOK, _execFile, _now: NOW })
    const psCalls = _execFile.calls.filter((c) => c.args[0] === 'ps')
    // Two container queries: label-identified first, then the legacy name prefix.
    assert.equal(psCalls.length, 2)
    assert.ok(psCalls[0].args.includes('label=com.chroxy.managed=true'), 'label ps query first')
    assert.ok(psCalls.some((c) => c.args.includes('name=chroxy-env')), 'legacy name ps query present')
    for (const ps of psCalls) {
      assert.ok(ps.args.includes('--size'))
      assert.ok(ps.args.includes('status=exited'))
      assert.ok(ps.args.includes('status=created'))
      assert.ok(ps.args.includes('status=dead'))
    }
    // Image queries: one label-filtered (any repo) + the two legacy per-repo lists.
    const imageCalls = _execFile.calls.filter((c) => c.args[0] === 'images')
    assert.ok(imageCalls.some((c) => c.args.includes('label=com.chroxy.managed=true')), 'label images query present')
    const repos = imageCalls.filter((c) => c.args[1] !== '--filter').map((c) => c.args[1])
    assert.deepEqual(repos.sort(), ['chroxy-byok-snap', 'chroxy-env'])
  })
})

describe('runHostPrune()', () => {
  it('removes only the surveyed orphan ids and tallies removed counts + bytes', async () => {
    const _execFile = execStub({
      psOut: 'aaa\tchroxy-env-foo\texited\t10MB (virtual 1GB)',
      imagesOut: { 'chroxy-env': 'img1\tchroxy-env\tfoo-1\t1GB', 'chroxy-byok-snap': '' },
    })
    const res = await runHostPrune({ kind: 'all', listEnvironments: () => [], listByokSnapshots: NO_BYOK, _execFile, _now: NOW })
    assert.equal(res.removedContainers, 1)
    assert.equal(res.removedImages, 1)
    assert.equal(res.reclaimedBytes, 10_000_000 + 1_000_000_000)
    assert.deepEqual(res.failures, [])
    // The exact ids removed are the surveyed ones.
    assert.ok(_execFile.calls.some((c) => c.args[0] === 'rm' && c.args.includes('aaa')))
    assert.ok(_execFile.calls.some((c) => c.args[0] === 'rmi' && c.args.includes('img1')))
  })

  it('kind=containers removes only containers; kind=images only images', async () => {
    const mk = () => execStub({
      psOut: 'aaa\tchroxy-env-foo\texited\t10MB (virtual 1GB)',
      imagesOut: { 'chroxy-env': 'img1\tchroxy-env\tfoo-1\t1GB', 'chroxy-byok-snap': '' },
    })
    const e1 = mk()
    const r1 = await runHostPrune({ kind: 'containers', listEnvironments: () => [], listByokSnapshots: NO_BYOK, _execFile: e1, _now: NOW })
    assert.equal(r1.removedContainers, 1)
    assert.equal(r1.removedImages, 0)
    assert.ok(!e1.calls.some((c) => c.args[0] === 'rmi'))

    const e2 = mk()
    const r2 = await runHostPrune({ kind: 'images', listEnvironments: () => [], listByokSnapshots: NO_BYOK, _execFile: e2, _now: NOW })
    assert.equal(r2.removedContainers, 0)
    assert.equal(r2.removedImages, 1)
    assert.ok(!e2.calls.some((c) => c.args[0] === 'rm'), 'kind=images never invokes docker rm (containers)')
  })

  it('records a per-resource failure without aborting the rest', async () => {
    const _execFile = execStub({
      psOut: 'aaa\tchroxy-env-foo\texited\t10MB (virtual 1GB)',
      imagesOut: { 'chroxy-env': 'img1\tchroxy-env\tfoo-1\t1GB', 'chroxy-byok-snap': '' },
      failIds: new Set(['img1']),
    })
    const res = await runHostPrune({ kind: 'all', listEnvironments: () => [], listByokSnapshots: NO_BYOK, _execFile, _now: NOW })
    assert.equal(res.removedContainers, 1)
    assert.equal(res.removedImages, 0)
    assert.equal(res.failures.length, 1)
    assert.match(res.failures[0].error, /no such image/)
  })

  it('does nothing when docker is unavailable', async () => {
    const _execFile = execStub({ psError: 'daemon down' })
    const res = await runHostPrune({ kind: 'all', listByokSnapshots: NO_BYOK, _execFile, _now: NOW })
    assert.equal(res.dockerAvailable, false)
    assert.equal(res.removedContainers, 0)
    assert.equal(res.removedImages, 0)
  })

  it('never removes a tracked (live-env) container even if stopped', async () => {
    const _execFile = execStub({
      psOut: 'live12345678\tchroxy-env-live\texited\t10MB (virtual 1GB)',
      imagesOut: {},
    })
    const res = await runHostPrune({
      kind: 'all',
      listEnvironments: () => [{ containerId: 'live12345678abc' }],
      listByokSnapshots: NO_BYOK,
      _execFile,
      _now: NOW,
    })
    assert.equal(res.removedContainers, 0)
    assert.ok(!_execFile.calls.some((c) => c.args[0] === 'rm'))
  })

  it('never rmi a retained snapshot image (env.snapshots[] or BYOK sidecar)', async () => {
    const _execFile = execStub({
      psOut: '',
      imagesOut: {
        'chroxy-env': 'imgenvsnap\tchroxy-env\tsaved-1\t1GB',
        'chroxy-byok-snap': 'imgbyok\tchroxy-byok-snap\tkeep-1\t1GB',
      },
    })
    const res = await runHostPrune({
      kind: 'all',
      listEnvironments: () => [{ containerId: 'c1', image: 'node:22-slim', snapshots: [{ image: 'chroxy-env:saved-1' }] }],
      listByokSnapshots: () => [{ tag: 'chroxy-byok-snap:keep-1' }],
      _execFile,
      _now: NOW,
    })
    assert.equal(res.removedImages, 0)
    assert.ok(!_execFile.calls.some((c) => c.args[0] === 'rmi'), 'no retained snapshot is rmi-d')
  })
})

describe('constants', () => {
  it('exposes the chroxy container prefix + prunable states', () => {
    assert.equal(CHROXY_CONTAINER_PREFIX, 'chroxy-env-')
    assert.deepEqual([...PRUNABLE_CONTAINER_STATES].sort(), ['created', 'dead', 'exited'])
  })
})
