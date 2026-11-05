/**
 * Tests for the Tauri updater feed tooling (#8906, #8917):
 *   scripts/lib/minisign-verify.mjs, build-updater-feed.mjs, verify-updater-feed.mjs
 *
 * Fixtures under fixtures/updater-feed/ were produced by `cargo tauri signer
 * generate` + `cargo tauri signer sign` (tauri-cli 2.10.0); only PUBLIC keys
 * are committed. See fixtures/updater-feed/README.md for the exact commands.
 * The verifier is checked against that real tool output, not against a signer
 * written alongside it. Signatures carrying a `version:` trusted comment (which
 * this CLI version does not emit) come from a throwaway key made in-test.
 */

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash, generateKeyPairSync, sign as edSign} from 'node:crypto'
import {verifyTauriSignature, trustedCommentVersion} from '../lib/minisign-verify.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FIX = join(here, 'fixtures', 'updater-feed')
const BUILD = join(here, '..', 'build-updater-feed.mjs')
const VERIFY = join(here, '..', 'verify-updater-feed.mjs')

const read = (name) => readFileSync(join(FIX, name))
const text = (name) => read(name).toString('utf8').trim()
const PUB_A = text('key-a.pub')
const PUB_B = text('key-b.pub')
const SIG = text('payload.msi.sig')
const PAYLOAD = read('payload.msi')

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const unbox = (sigB64) => Buffer.from(sigB64, 'base64').toString('utf8').split('\n')
const rebox = (lines) => Buffer.from(lines.join('\n'), 'utf8').toString('base64')

function flipByte(buf, i) {
  const c = Buffer.from(buf)
  c[i] ^= 0x01
  return c
}

/** Make a minisign `ED` signature box with a throwaway Ed25519 key. */
function ephemeralSigner(trustedComment) {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519')
  const rawPub = publicKey.export({format: 'der', type: 'spki'}).subarray(-32)
  const keyId = Buffer.from('0102030405060708', 'hex')
  const pubBox = rebox([
    'untrusted comment: minisign public key: test',
    Buffer.concat([Buffer.from('Ed'), keyId, rawPub]).toString('base64'),
  ])
  return {
    pubkey: pubBox,
    sign(payload) {
      const sig = edSign(null, createHash('blake2b512').update(payload).digest(), privateKey)
      const global = edSign(null, Buffer.concat([sig, Buffer.from(trustedComment)]), privateKey)
      return rebox([
        'untrusted comment: signature from test key',
        Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64'),
        `trusted comment: ${trustedComment}`,
        global.toString('base64'),
      ]) + ''
    },
  }
}

// ---------------------------------------------------------------- verifier

test('verify: real tauri signature over the untouched payload verifies', () => {
  const r = verifyTauriSignature(PUB_A, SIG, PAYLOAD)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.reason, null)
  assert.ok(/^timestamp:\d+\tfile:payload\.msi$/.test(r.trustedComment))
})

test('verify: the signature algorithm in the fixture is prehashed ED', () => {
  const body = Buffer.from(unbox(SIG)[1], 'base64')
  assert.equal(body.toString('latin1', 0, 2), 'ED')
})

test('verify: one flipped payload byte is rejected', () => {
  const r = verifyTauriSignature(PUB_A, SIG, flipByte(PAYLOAD, 10))
  assert.equal(r.ok, false)
  assert.ok(/payload signature/.test(r.reason), r.reason)
})

test('verify: bytes appended after signing are rejected (the #8906 shape)', () => {
  const authenticoded = read('payload-authenticode.msi')
  assert.ok(authenticoded.length > PAYLOAD.length)
  assert.ok(authenticoded.subarray(0, PAYLOAD.length).equals(PAYLOAD))
  const stale = verifyTauriSignature(PUB_A, SIG, authenticoded)
  assert.equal(stale.ok, false)
  // ...and re-signing the mutated file (what release.yml now does) verifies
  const fresh = verifyTauriSignature(PUB_A, text('payload-authenticode.msi.sig'), authenticoded)
  assert.equal(fresh.ok, true, fresh.reason)
})

test('verify: a flipped byte in the signature is rejected', () => {
  const lines = unbox(SIG)
  const body = Buffer.from(lines[1], 'base64')
  lines[1] = flipByte(body, 20).toString('base64')
  const r = verifyTauriSignature(PUB_A, rebox(lines), PAYLOAD)
  assert.equal(r.ok, false)
  assert.ok(/payload signature/.test(r.reason), r.reason)
})

test('verify: an altered trusted comment is rejected by the global signature', () => {
  const lines = unbox(SIG)
  lines[2] = lines[2].replace('file:payload.msi', 'file:evil.msi')
  const r = verifyTauriSignature(PUB_A, rebox(lines), PAYLOAD)
  assert.equal(r.ok, false)
  assert.ok(/trusted comment/.test(r.reason), r.reason)
})

test('verify: another key pair\'s public key is rejected on the key id', () => {
  const r = verifyTauriSignature(PUB_B, SIG, PAYLOAD)
  assert.equal(r.ok, false)
  assert.ok(/key id/.test(r.reason), r.reason)
})

test('verify: same key id but a different key still fails the signature check', () => {
  // Splice key B's key bytes under key A's id so only the Ed25519 math can object.
  const lines = unbox(PUB_B)
  const bBody = Buffer.from(lines[1], 'base64')
  const aBody = Buffer.from(unbox(PUB_A)[1], 'base64')
  const spliced = Buffer.concat([aBody.subarray(0, 10), bBody.subarray(10)])
  const pub = rebox([lines[0], spliced.toString('base64')])
  const r = verifyTauriSignature(pub, SIG, PAYLOAD)
  assert.equal(r.ok, false)
  assert.ok(/payload signature/.test(r.reason), r.reason)
})

test('verify: malformed inputs are rejected without throwing', () => {
  const cases = [
    [PUB_A, '', PAYLOAD],
    [PUB_A, 'not base64 !!!', PAYLOAD],
    [PUB_A, b64('garbage'), PAYLOAD],
    [PUB_A, undefined, PAYLOAD],
    [PUB_A, null, PAYLOAD],
    [PUB_A, SIG, 'not a buffer'],
    [PUB_A, SIG.slice(0, 40), PAYLOAD],
    ['', SIG, PAYLOAD],
    [undefined, SIG, PAYLOAD],
    [b64('untrusted comment: x\nAAAA'), SIG, PAYLOAD],
    [b64('only one line'), SIG, PAYLOAD],
  ]
  for (const [pub, sig, payload] of cases) {
    let r
    assert.doesNotThrow(() => { r = verifyTauriSignature(pub, sig, payload) })
    assert.equal(r.ok, false)
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0)
  }
})

test('verify: a non-ED algorithm is rejected with an explicit reason', () => {
  const lines = unbox(SIG)
  const body = Buffer.from(lines[1], 'base64')
  body.write('Ed', 0, 'latin1')
  lines[1] = body.toString('base64')
  const r = verifyTauriSignature(PUB_A, rebox(lines), PAYLOAD)
  assert.equal(r.ok, false)
  assert.ok(/unsupported signature algorithm/.test(r.reason), r.reason)
})

test('verify: signatures from an independent signer with a version comment verify', () => {
  const s = ephemeralSigner('timestamp:1\tfile:x.msi\tversion:9.9.9')
  const sig = s.sign(PAYLOAD)
  const r = verifyTauriSignature(s.pubkey, sig, PAYLOAD)
  assert.equal(r.ok, true, r.reason)
  assert.equal(trustedCommentVersion(r.trustedComment), '9.9.9')
  assert.equal(verifyTauriSignature(s.pubkey, sig, flipByte(PAYLOAD, 3)).ok, false)
})

test('trustedCommentVersion: absent or non-string yields null', () => {
  assert.equal(trustedCommentVersion('timestamp:1\tfile:x'), null)
  assert.equal(trustedCommentVersion(undefined), null)
})

// ------------------------------------------------------------- build script

function scratch() {
  return mkdtempSync(join(tmpdir(), 'updater-feed-test-'))
}

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', timeout: 30000})
  return {status: r.status, stdout: r.stdout, stderr: r.stderr}
}

function stagePayload(dir, name, payloadFile = 'payload.msi', sigFile = 'payload.msi.sig') {
  cpSync(join(FIX, payloadFile), join(dir, name))
  if (sigFile) cpSync(join(FIX, sigFile), join(dir, `${name}.sig`))
  return join(dir, name)
}

const BASE = 'https://github.com/example/chroxy/releases/download/v1.2.3'

test('build: writes the fragment shape merge-updater-feeds expects', () => {
  const dir = scratch()
  try {
    const msi = stagePayload(dir, 'Chroxy_1.2.3_x64_en-US.msi')
    const out = join(dir, 'latest.json')
    const r = run(BUILD, [
      '--version', '1.2.3', '--base-url', `${BASE}/`, '--platform', `windows-x86_64=${msi}`,
      '--notes', 'hello', '--pub-date', '2026-01-02T03:04:05.000Z', '--output', out,
    ])
    assert.equal(r.status, 0, r.stderr)
    const feed = JSON.parse(readFileSync(out, 'utf8'))
    assert.deepEqual(feed, {
      version: '1.2.3',
      notes: 'hello',
      pub_date: '2026-01-02T03:04:05.000Z',
      platforms: {
        'windows-x86_64': {signature: SIG, url: `${BASE}/Chroxy_1.2.3_x64_en-US.msi`},
      },
    })
    // the merge script accepts the fragment unchanged
    const merged = join(dir, 'merged.json')
    const m = run(join(here, '..', 'merge-updater-feeds.mjs'), ['--output', merged, out])
    assert.equal(m.status, 0, m.stderr)
    assert.deepEqual(JSON.parse(readFileSync(merged, 'utf8')).platforms, feed.platforms)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('build: omits notes when none given and defaults pub_date to an ISO time', () => {
  const dir = scratch()
  try {
    const msi = stagePayload(dir, 'a.msi')
    const out = join(dir, 'f.json')
    const r = run(BUILD, ['--version', '1.0.0', '--base-url', BASE, '--platform', `k=${msi}`, '--output', out])
    assert.equal(r.status, 0, r.stderr)
    const feed = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal('notes' in feed, false)
    assert.ok(!Number.isNaN(Date.parse(feed.pub_date)))
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('build: several platforms may share one payload', () => {
  const dir = scratch()
  try {
    const tgz = stagePayload(dir, 'Chroxy.app.tar.gz')
    const out = join(dir, 'f.json')
    const r = run(BUILD, [
      '--version', '1.0.0', '--base-url', BASE,
      '--platform', `darwin-aarch64=${tgz}`, '--platform', `darwin-x86_64=${tgz}`, '--output', out,
    ])
    assert.equal(r.status, 0, r.stderr)
    const feed = JSON.parse(readFileSync(out, 'utf8'))
    assert.deepEqual(Object.keys(feed.platforms).sort(), ['darwin-aarch64', 'darwin-x86_64'])
    assert.equal(feed.platforms['darwin-aarch64'].url, feed.platforms['darwin-x86_64'].url)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('build: a missing .sig fails non-zero and writes nothing', () => {
  const dir = scratch()
  try {
    const msi = stagePayload(dir, 'a.msi', 'payload.msi', null)
    const out = join(dir, 'f.json')
    const r = run(BUILD, ['--version', '1.0.0', '--base-url', BASE, '--platform', `k=${msi}`, '--output', out])
    assert.equal(r.status, 1)
    assert.ok(/missing/.test(r.stderr), r.stderr)
    assert.equal(existsSync(out), false)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('build: an empty .sig fails non-zero', () => {
  const dir = scratch()
  try {
    const msi = stagePayload(dir, 'a.msi')
    writeFileSync(`${msi}.sig`, '\n')
    const r = run(BUILD, ['--version', '1.0.0', '--base-url', BASE, '--platform', `k=${msi}`, '--output', join(dir, 'f.json')])
    assert.equal(r.status, 1)
    assert.ok(/empty/.test(r.stderr), r.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('build: a basename GitHub would rename fails non-zero', () => {
  const dir = scratch()
  try {
    const msi = stagePayload(dir, 'Chroxy 1.2.3 x64.msi')
    const out = join(dir, 'f.json')
    const r = run(BUILD, ['--version', '1.0.0', '--base-url', BASE, '--platform', `k=${msi}`, '--output', out])
    assert.equal(r.status, 1)
    assert.ok(/\[A-Za-z0-9\._-\]/.test(r.stderr), r.stderr)
    assert.equal(existsSync(out), false)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('build: missing required flags are a usage error (exit 2)', () => {
  assert.equal(run(BUILD, ['--version', '1.0.0']).status, 2)
  assert.equal(run(BUILD, ['--bogus']).status, 2)
})

// ------------------------------------------------------------- verify script

/** Stage a release-shaped tree: assets/<nested>/<msi> and a feed pointing at it. */
function stageRelease({feedVersion = '1.2.3', extra = () => {}} = {}) {
  const dir = scratch()
  const assets = join(dir, 'assets')
  mkdirSync(join(assets, 'win'), {recursive: true})
  const msi = stagePayload(join(assets, 'win'), 'Chroxy_1.2.3_x64_en-US.msi')
  const feedPath = join(dir, 'latest.json')
  const b = run(BUILD, ['--version', feedVersion, '--base-url', BASE, '--platform', `windows-x86_64=${msi}`, '--output', feedPath])
  assert.equal(b.status, 0, b.stderr)
  extra({dir, assets, feedPath, msi})
  return {dir, assets, feedPath, msi}
}

function verify(feedPath, assets, pubkey = PUB_A, more = []) {
  return run(VERIFY, ['--feed', feedPath, '--pubkey', pubkey, '--assets', assets, ...more])
}

test('verify-feed: a good feed passes, searching assets recursively', () => {
  const {dir, assets, feedPath} = stageRelease()
  try {
    const r = verify(feedPath, assets, PUB_A, ['--expect-version', '1.2.3'])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(/ok windows-x86_64/.test(r.stdout))
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: --pubkey-from reads plugins.updater.pubkey', () => {
  const {dir, assets, feedPath} = stageRelease()
  try {
    const conf = join(dir, 'tauri.conf.json')
    writeFileSync(conf, JSON.stringify({plugins: {updater: {pubkey: PUB_A}}}))
    const ok = run(VERIFY, ['--feed', feedPath, '--pubkey-from', conf, '--assets', assets])
    assert.equal(ok.status, 0, ok.stderr)
    writeFileSync(conf, JSON.stringify({plugins: {updater: {pubkey: PUB_B}}}))
    const bad = run(VERIFY, ['--feed', feedPath, '--pubkey-from', conf, '--assets', assets])
    assert.equal(bad.status, 1)
    writeFileSync(conf, JSON.stringify({plugins: {}}))
    assert.equal(run(VERIFY, ['--feed', feedPath, '--pubkey-from', conf, '--assets', assets]).status, 1)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: the committed tauri.conf.json pubkey parses as a key', () => {
  const conf = JSON.parse(readFileSync(join(here, '..', '..', 'packages', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const pub = conf.plugins.updater.pubkey
  // A real key must get past key parsing: the failure is the key id, not a malformed box.
  const r = verifyTauriSignature(pub, SIG, PAYLOAD)
  assert.equal(r.ok, false)
  assert.ok(/key id/.test(r.reason), r.reason)
})

test('verify-feed: the #8906 shape (payload changed after signing) fails', () => {
  const {dir, assets, feedPath, msi} = stageRelease({
    extra: ({msi: m}) => writeFileSync(m, Buffer.concat([readFileSync(m), Buffer.from('authenticode')])),
  })
  try {
    const r = verify(feedPath, assets)
    assert.equal(r.status, 1)
    assert.ok(/FAIL windows-x86_64/.test(r.stderr), r.stderr)
    assert.ok(existsSync(msi))
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: every failing platform is listed, passing ones are still checked', () => {
  const {dir, assets, feedPath} = stageRelease({
    extra: ({feedPath: fp, assets: a}) => {
      stagePayload(join(a, 'win'), 'Good.msi')
      const feed = JSON.parse(readFileSync(fp, 'utf8'))
      feed.platforms['windows-aarch64'] = {signature: feed.platforms['windows-x86_64'].signature, url: `${BASE}/Other.msi`}
      feed.platforms['windows-x86_64'].signature = 'AAAA'
      feed.platforms['good'] = {signature: SIG, url: `${BASE}/Good.msi`}
      writeFileSync(fp, JSON.stringify(feed))
      writeFileSync(join(a, 'win', 'Other.msi'), 'tampered')
    },
  })
  try {
    const r = verify(feedPath, assets)
    assert.equal(r.status, 1)
    assert.ok(/FAIL windows-x86_64/.test(r.stderr), r.stderr)
    assert.ok(/FAIL windows-aarch64/.test(r.stderr), r.stderr)
    assert.ok(/ok good/.test(r.stdout))
    assert.ok(!/FAIL good/.test(r.stderr))
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: wrong public key fails', () => {
  const {dir, assets, feedPath} = stageRelease()
  try {
    const r = verify(feedPath, assets, PUB_B)
    assert.equal(r.status, 1)
    assert.ok(/key id/.test(r.stderr), r.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: a missing asset fails', () => {
  const {dir, assets, feedPath} = stageRelease({extra: ({msi}) => rmSync(msi)})
  try {
    const r = verify(feedPath, assets)
    assert.equal(r.status, 1)
    assert.ok(/no asset named/.test(r.stderr), r.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: an ambiguous asset (two files, same name) fails', () => {
  const {dir, assets, feedPath} = stageRelease({
    extra: ({assets: a}) => {
      mkdirSync(join(a, 'dup'), {recursive: true})
      stagePayload(join(a, 'dup'), 'Chroxy_1.2.3_x64_en-US.msi')
    },
  })
  try {
    const r = verify(feedPath, assets)
    assert.equal(r.status, 1)
    assert.ok(/expected exactly one/.test(r.stderr), r.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: --expect-version mismatch fails', () => {
  const {dir, assets, feedPath} = stageRelease({feedVersion: '1.2.2'})
  try {
    const r = verify(feedPath, assets, PUB_A, ['--expect-version', '1.2.3'])
    assert.equal(r.status, 1)
    assert.ok(/does not match expected/.test(r.stderr), r.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: a signed version: in the trusted comment must equal the feed version', () => {
  const s = ephemeralSigner('timestamp:1\tfile:Signed.msi\tversion:1.2.2')
  const dir = scratch()
  try {
    const assets = join(dir, 'assets')
    mkdirSync(assets)
    writeFileSync(join(assets, 'Signed.msi'), PAYLOAD)
    const feedPath = join(dir, 'latest.json')
    const feed = {version: '1.2.3', platforms: {k: {signature: s.sign(PAYLOAD), url: `${BASE}/Signed.msi`}}}
    writeFileSync(feedPath, JSON.stringify(feed))
    const bad = verify(feedPath, assets, s.pubkey)
    assert.equal(bad.status, 1)
    assert.ok(/signed for version/.test(bad.stderr), bad.stderr)
    feed.version = '1.2.2'
    writeFileSync(feedPath, JSON.stringify(feed))
    assert.equal(verify(feedPath, assets, s.pubkey).status, 0)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: a feed with zero platforms is refused', () => {
  const dir = scratch()
  try {
    const feedPath = join(dir, 'latest.json')
    for (const body of [{version: '1.0.0', platforms: {}}, {version: '1.0.0'}, {platforms: null}]) {
      writeFileSync(feedPath, JSON.stringify(body))
      const r = verify(feedPath, dir)
      assert.equal(r.status, 1)
      assert.ok(/no platform entries/.test(r.stderr), r.stderr)
    }
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: unreadable or unparseable feed fails, usage errors exit 2', () => {
  const dir = scratch()
  try {
    assert.equal(verify(join(dir, 'nope.json'), dir).status, 1)
    writeFileSync(join(dir, 'bad.json'), '{not json')
    assert.equal(verify(join(dir, 'bad.json'), dir).status, 1)
    assert.equal(run(VERIFY, []).status, 2)
    assert.equal(run(VERIFY, ['--feed', 'x', '--assets', 'y']).status, 2)
    assert.equal(run(VERIFY, ['--feed', 'x', '--assets', 'y', '--pubkey', 'a', '--pubkey-from', 'b']).status, 2)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})
