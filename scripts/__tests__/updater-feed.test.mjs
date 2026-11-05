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
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
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

// Box pieces, each an exact line of the real fixtures (no trailing-newline artefacts).
const boxText = (b64) => Buffer.from(b64, 'base64').toString('utf8')
const boxOf = (b64) => {
  const t = boxText(b64)
  return (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n')
}
const PL = boxOf(PUB_A)
const SL = boxOf(SIG)

/** Flip the last significant base64 symbol to one with the same top bits but non-zero trailing bits. */
function tweakTrailingBits(b64) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const m = b64.match(/^(.*)(.)(=+)$/)
  assert.ok(m, `no padding to tweak in ${b64.slice(0, 12)}...`)
  return m[1] + A[A.indexOf(m[2]) ^ 1] + m[3]
}

/** A pubkey box whose OUTER base64 is padded (so it has trailing bits to abuse). */
function paddedPubBox() {
  for (let n = 0; n < 4; n++) {
    const outer = b64([`untrusted comment: ${'k'.repeat(n)}`, PL[1]].join('\n'))
    if (outer.endsWith('=')) return outer
  }
  throw new Error('could not build a padded pubkey box')
}

const body = (b64s) => Buffer.from(b64s, 'base64')
const withAlg = (b64s, alg) => Buffer.concat([Buffer.from(alg, 'latin1'), body(b64s).subarray(2)]).toString('base64')
const sigWith = (...replacements) => b64(SL.map((l, i) => (i in Object.fromEntries(replacements) ? Object.fromEntries(replacements)[i] : l)).join('\n'))
const pubWith = (...replacements) => b64(PL.map((l, i) => (i in Object.fromEntries(replacements) ? Object.fromEntries(replacements)[i] : l)).join('\n'))
const withBytes = (bytes) => Buffer.from(bytes).toString('base64')
const identityKey = Buffer.concat([Buffer.from('Ed'), body(PL[1]).subarray(2, 10), Buffer.from([1]), Buffer.alloc(31)]).toString('base64')
const zeroKey = Buffer.concat([Buffer.from('Ed'), body(PL[1]).subarray(2, 10), Buffer.alloc(32)]).toString('base64')
const invalidUtf8 = (line1, rest) => Buffer.concat([Buffer.from(line1), Buffer.from([0xff, 0xfe]), Buffer.from('\n' + rest)]).toString('base64')

// [label, pubkey, signature, expected reason]. Every row must be refused for ITS reason.
const REJECTS = [
  // outer base64 (feed signature / tauri.conf pubkey)
  ['sig: trailing newline', PUB_A, SIG + '\n', /signature is not canonical base64/],
  ['sig: leading space', PUB_A, ' ' + SIG, /signature is not canonical base64/],
  ['sig: embedded whitespace', PUB_A, SIG.slice(0, 20) + ' ' + SIG.slice(20), /signature is not canonical base64/],
  ['sig: non-zero trailing bits', PUB_A, tweakTrailingBits(SIG), /signature is not canonical base64/],
  ['sig: unpadded', PUB_A, SIG.replace(/=+$/, ''), /signature is not canonical base64/],
  ['sig: url-safe alphabet', PUB_A, SIG.replace(/\+/g, '-').replace(/\//g, '_') + '-', /signature is not canonical base64/],
  ['sig: empty', PUB_A, '', /signature is not canonical base64/],
  ['sig: undefined', PUB_A, undefined, /signature is not canonical base64/],
  ['sig: null', PUB_A, null, /signature is not canonical base64/],
  ['sig: not base64 at all', PUB_A, 'not base64 !!!', /signature is not canonical base64/],
  ['pub: trailing newline', PUB_A + '\n', SIG, /public key is not canonical base64/],
  ['pub: leading space', ' ' + PUB_A, SIG, /public key is not canonical base64/],
  ['pub: non-zero trailing bits', tweakTrailingBits(paddedPubBox()), SIG, /public key is not canonical base64/],
  ['pub: empty', '', SIG, /public key is not canonical base64/],
  ['pub: undefined', undefined, SIG, /public key is not canonical base64/],
  // inner boxes: whitespace on each line, blank lines in each position
  ['sig box: key line trailing space', PUB_A, sigWith([1, SL[1] + ' ']), /signature body must be 74 bytes|signature box is malformed/],
  ['sig box: global line trailing space', PUB_A, sigWith([3, SL[3] + ' ']), /global signature must be 64 bytes/],
  ['sig box: key line leading space', PUB_A, sigWith([1, ' ' + SL[1]]), /signature body must be 74 bytes/],
  ['pub box: key line trailing space', b64(PL[0] + '\n' + PL[1] + ' '), SIG, /public key body must be 42 bytes/],
  ['pub box: key line leading space', b64(PL[0] + '\n ' + PL[1]), SIG, /public key body must be 42 bytes/],
  ['sig box: blank first line', PUB_A, b64('\n' + SL.join('\n')), /signature box is malformed/],
  ['sig box: blank line after comment', PUB_A, b64([SL[0], '', SL[1], SL[2], SL[3]].join('\n')), /signature body must be 74 bytes|signature box is malformed/],
  ['sig box: blank line before trusted comment', PUB_A, b64([SL[0], SL[1], '', SL[2], SL[3]].join('\n')), /signature box is malformed/],
  ['sig box: blank line before global sig', PUB_A, b64([SL[0], SL[1], SL[2], '', SL[3]].join('\n')), /global signature must be 64 bytes/],
  ['pub box: blank first line', b64('\n' + PL.join('\n')), SIG, /public key box is malformed/],
  ['pub box: blank line between comment and key', b64([PL[0], '', PL[1]].join('\n')), SIG, /public key body must be 42 bytes/],
  // inner base64: non-zero trailing bits
  ['sig box: key line trailing bits', PUB_A, sigWith([1, tweakTrailingBits(SL[1])]), /signature body must be 74 bytes/],
  ['sig box: global line trailing bits', PUB_A, sigWith([3, tweakTrailingBits(SL[3])]), /global signature must be 64 bytes/],
  // strict UTF-8
  ['sig box: invalid UTF-8', PUB_A, invalidUtf8('untrusted comment: ', SL.slice(1).join('\n')), /signature box is not valid UTF-8/],
  ['pub box: invalid UTF-8', invalidUtf8('untrusted comment: ', PL[1]), SIG, /public key box is not valid UTF-8/],
  // structure
  ['sig box: only garbage', PUB_A, b64('garbage'), /signature box is malformed/],
  ['sig box: too few lines', PUB_A, b64(SL.slice(0, 3).join('\n')), /signature box is malformed/],
  ['sig box: wrong untrusted prefix', PUB_A, sigWith([0, 'foo']), /signature box is malformed/],
  ['sig box: wrong trusted prefix', PUB_A, sigWith([2, 'Trusted comment: x']), /signature box is malformed/],
  ['pub box: one line', b64('only one line'), SIG, /public key box is malformed/],
  ['pub box: wrong prefix', b64('foo\n' + PL[1]), SIG, /public key box is malformed/],
  ['sig box: body too short', PUB_A, sigWith([1, withBytes(body(SL[1]).subarray(0, 73))]), /signature body must be 74 bytes/],
  ['sig box: body too long', PUB_A, sigWith([1, withBytes(Buffer.concat([body(SL[1]), Buffer.from([0])]))]), /signature body must be 74 bytes/],
  ['pub box: body too short', pubWith([1, withBytes(body(PL[1]).subarray(0, 41))]), SIG, /public key body must be 42 bytes/],
  ['pub box: body too long', pubWith([1, withBytes(Buffer.concat([body(PL[1]), Buffer.from([0])]))]), SIG, /public key body must be 42 bytes/],
  ['sig box: global sig too short', PUB_A, sigWith([3, withBytes(body(SL[3]).subarray(0, 63))]), /global signature must be 64 bytes/],
  ['sig box: global sig too long', PUB_A, sigWith([3, withBytes(Buffer.concat([body(SL[3]), Buffer.from([0])]))]), /global signature must be 64 bytes/],
  ['sig box: global sig line empty (box truncated)', PUB_A, sigWith([3, '']), /signature box is malformed/],
  // algorithms and keys
  ['sig: legacy Ed algorithm', PUB_A, sigWith([1, withAlg(SL[1], 'Ed')]), /unsupported signature algorithm "Ed"/],
  ['sig: unknown algorithm', PUB_A, sigWith([1, withAlg(SL[1], 'XX')]), /unsupported signature algorithm "XX"/],
  ['pub: ED algorithm', pubWith([1, withAlg(PL[1], 'ED')]), SIG, /public key algorithm is not Ed/],
  ['pub: identity key', pubWith([1, identityKey]), SIG, /degenerate/],
  ['pub: all-zero key', pubWith([1, zeroKey]), SIG, /degenerate/],
  ['pub: other key pair', PUB_B, SIG, /key id/],
  ['sig: trusted comment emptied', PUB_A, sigWith([2, 'trusted comment: ']), /trusted comment signature/],
]

test('verify: every malformed or non-canonical input is rejected for its own reason, without throwing', () => {
  for (const [label, pub, sig, reason] of REJECTS) {
    let r
    assert.doesNotThrow(() => { r = verifyTauriSignature(pub, sig, PAYLOAD) }, label)
    assert.equal(r.ok, false, `${label} was accepted`)
    assert.ok(reason.test(r.reason), `${label}: reason "${r.reason}" does not match ${reason}`)
  }
})

test('verify: a non-Buffer payload is refused with its own reason', () => {
  for (const bad of ['not a buffer', null, undefined, new Uint8Array(3)]) {
    const r = verifyTauriSignature(PUB_A, SIG, bad)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'payload must be a Buffer')
  }
})

test('verify: an unexpected throw inside verification is contained as ok:false', () => {
  // Passes Buffer.isBuffer (prototype check) but throws when hashed: reaches the outer catch.
  const hostile = Object.create(Buffer.prototype)
  let r
  assert.doesNotThrow(() => { r = verifyTauriSignature(PUB_A, SIG, hostile) })
  assert.equal(r.ok, false)
  assert.ok(/^verification error: /.test(r.reason), r.reason)
})

test('verify: CRLF line endings and trailing lines inside the boxes are tolerated like the client', () => {
  // Rust lines() strips "\r\n"; the client reads only the leading lines it needs.
  const crlf = b64(SL.join('\r\n') + '\r\n')
  assert.equal(verifyTauriSignature(PUB_A, crlf, PAYLOAD).ok, true)
  const extra = b64(SL.join('\n') + '\nextra line\n')
  assert.equal(verifyTauriSignature(PUB_A, extra, PAYLOAD).ok, true)
  const pubCrlf = b64(PL.join('\r\n') + '\r\n')
  assert.equal(verifyTauriSignature(pubCrlf, SIG, PAYLOAD).ok, true)
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

test('verify: a non-ASCII trusted comment is signed over its UTF-8 bytes', () => {
  const s = ephemeralSigner('timestamp:1\tfile:caf\u00e9-\u2713.msi\tversion:2.0.0')
  const r = verifyTauriSignature(s.pubkey, s.sign(PAYLOAD), PAYLOAD)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.trustedComment, 'timestamp:1\tfile:caf\u00e9-\u2713.msi\tversion:2.0.0')
})

test('trustedCommentVersion: only a field that STARTS with version: counts', () => {
  assert.equal(trustedCommentVersion('timestamp:1\tversion:1.2.3\tfile:x'), '1.2.3')
  assert.equal(trustedCommentVersion('timestamp:1\tfile:app-version:9.9.9.msi'), null)
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
    assert.ok(readFileSync(out, 'utf8').endsWith('}\n'), 'feed file ends with a newline')
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

test('build: each missing required flag is a usage error (exit 2), others present', () => {
  const dir = scratch()
  try {
    const msi = stagePayload(dir, 'a.msi')
    const full = [
      ['--version', '1.0.0'], ['--base-url', BASE], ['--platform', `k=${msi}`], ['--output', join(dir, 'f.json')],
    ]
    assert.equal(run(BUILD, full.flat()).status, 0)
    for (let drop = 0; drop < full.length; drop++) {
      const args = full.filter((_, i) => i !== drop).flat()
      const r = run(BUILD, args)
      assert.equal(r.status, 2, `dropping ${full[drop][0]} gave exit ${r.status}`)
      assert.ok(r.stderr.includes(`${full[drop][0]} is required`) || r.stderr.includes('at least one --platform'), r.stderr)
    }
    assert.equal(run(BUILD, ['--bogus']).status, 2)
    // a flag with its value missing
    const noValue = run(BUILD, ['--version'])
    assert.equal(noValue.status, 2)
    assert.ok(/--version requires a value/.test(noValue.stderr), noValue.stderr)
    // malformed --platform specs
    for (const spec of ['nokv', '=path', 'key=']) {
      assert.equal(run(BUILD, ['--version', '1', '--base-url', BASE, '--platform', spec, '--output', join(dir, 'x.json')]).status, 2, spec)
    }
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('build: a duplicate --platform key is an error even when the first entry was bad', () => {
  const dir = scratch()
  try {
    const msi = stagePayload(dir, 'a.msi')
    const out = join(dir, 'f.json')
    const dup = run(BUILD, ['--version', '1.0.0', '--base-url', BASE, '--platform', `k=${msi}`, '--platform', `k=${msi}`, '--output', out])
    assert.equal(dup.status, 1)
    assert.ok(/more than once/.test(dup.stderr), dup.stderr)
    assert.equal(existsSync(out), false)
    const bad = join(dir, 'b.msi') // no .sig: first entry fails, the repeat must still be reported
    writeFileSync(bad, 'x')
    const dup2 = run(BUILD, ['--version', '1.0.0', '--base-url', BASE, '--platform', `k=${bad}`, '--platform', `k=${msi}`, '--output', out])
    assert.equal(dup2.status, 1)
    assert.ok(/more than once/.test(dup2.stderr), dup2.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
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
    for (const plugins of [{}, {updater: {pubkey: ''}}, {updater: {pubkey: 5}}]) {
      writeFileSync(conf, JSON.stringify({plugins}))
      const none = run(VERIFY, ['--feed', feedPath, '--pubkey-from', conf, '--assets', assets])
      assert.equal(none.status, 1)
      assert.ok(/has no plugins\.updater\.pubkey/.test(none.stderr), none.stderr)
    }
    const noConf = run(VERIFY, ['--feed', feedPath, '--pubkey-from', join(dir, 'missing.json'), '--assets', assets])
    assert.equal(noConf.status, 1)
    assert.ok(/could not read config/.test(noConf.stderr), noConf.stderr)
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

test('verify-feed: unreadable or unparseable feed fails', () => {
  const dir = scratch()
  try {
    const missing = verify(join(dir, 'nope.json'), dir)
    assert.equal(missing.status, 1)
    assert.ok(/could not read feed/.test(missing.stderr), missing.stderr)
    writeFileSync(join(dir, 'bad.json'), '{not json')
    const bad = verify(join(dir, 'bad.json'), dir)
    assert.equal(bad.status, 1)
    assert.ok(/could not read feed/.test(bad.stderr), bad.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: each missing required flag is a usage error (exit 2), others present', () => {
  const {dir, assets, feedPath} = stageRelease()
  try {
    const full = [['--feed', feedPath], ['--pubkey', PUB_A], ['--assets', assets]]
    assert.equal(run(VERIFY, full.flat()).status, 0)
    for (let drop = 0; drop < full.length; drop++) {
      const r = run(VERIFY, full.filter((_, i) => i !== drop).flat())
      assert.equal(r.status, 2, `dropping ${full[drop][0]} gave exit ${r.status}`)
    }
    assert.equal(run(VERIFY, [...full.flat(), '--pubkey-from', 'x']).status, 2)
    assert.equal(run(VERIFY, [...full.flat(), '--bogus']).status, 2)
    assert.equal(run(VERIFY, [...full.flat(), '--require-platform']).status, 2)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: an entry with a url but no signature, or a signature but no url, fails', () => {
  const {dir, assets, feedPath} = stageRelease()
  try {
    const good = JSON.parse(readFileSync(feedPath, 'utf8'))
    const entry = good.platforms['windows-x86_64']
    const feed = {...good, platforms: {nosig: {url: entry.url}, nourl: {signature: entry.signature}, ok: entry}}
    writeFileSync(feedPath, JSON.stringify(feed))
    const r = verify(feedPath, assets)
    assert.equal(r.status, 1)
    assert.ok(/FAIL nosig: entry has no signature/.test(r.stderr), r.stderr)
    assert.ok(/FAIL nourl: entry has no url/.test(r.stderr), r.stderr)
    assert.ok(!/FAIL ok/.test(r.stderr))
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: asset matching is by exact basename, not a suffix', () => {
  const {dir, assets, feedPath} = stageRelease({
    extra: ({assets: a, feedPath: fp}) => {
      const feed = JSON.parse(readFileSync(fp, 'utf8'))
      feed.platforms['windows-x86_64'].url = `${BASE}/a.msi`
      writeFileSync(fp, JSON.stringify(feed))
      stagePayload(join(a, 'win'), 'Chroxy_a.msi')
    },
  })
  try {
    const r = verify(feedPath, assets)
    assert.equal(r.status, 1)
    assert.ok(/no asset named "a\.msi"/.test(r.stderr), r.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: a %-encoded url basename and a ?query are resolved to the real asset name', () => {
  const {dir, assets, feedPath} = stageRelease({
    extra: ({assets: a, feedPath: fp}) => {
      const feed = JSON.parse(readFileSync(fp, 'utf8'))
      feed.platforms['enc'] = {...feed.platforms['windows-x86_64'], url: `${BASE}/Chroxy%20x.msi`}
      feed.platforms['query'] = {...feed.platforms['windows-x86_64'], url: `${BASE}/Chroxy_1.2.3_x64_en-US.msi?download=1#frag`}
      writeFileSync(fp, JSON.stringify(feed))
      stagePayload(join(a, 'win'), 'Chroxy x.msi')
    },
  })
  try {
    const r = verify(feedPath, assets)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(/ok enc: Chroxy x\.msi/.test(r.stdout), r.stdout)
    assert.ok(/ok query: Chroxy_1\.2\.3_x64_en-US\.msi/.test(r.stdout), r.stdout)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: --require-platform passes when present, fails (naming the key) when absent', () => {
  const {dir, assets, feedPath} = stageRelease()
  try {
    assert.equal(verify(feedPath, assets, PUB_A, ['--require-platform', 'windows-x86_64']).status, 0)
    const r = verify(feedPath, assets, PUB_A, ['--require-platform', 'windows-x86_64', '--require-platform', 'darwin-aarch64', '--require-platform', 'darwin-x86_64'])
    assert.equal(r.status, 1)
    assert.ok(/FAIL darwin-aarch64: required platform is missing/.test(r.stderr), r.stderr)
    assert.ok(/FAIL darwin-x86_64: required platform is missing/.test(r.stderr), r.stderr)
    assert.ok(!/FAIL windows-x86_64/.test(r.stderr))
    // inherited Object keys are not platforms
    assert.equal(verify(feedPath, assets, PUB_A, ['--require-platform', 'toString']).status, 1)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: --expect-url-prefix requires prefix + exactly the asset name', () => {
  const {dir, assets, feedPath} = stageRelease()
  try {
    assert.equal(verify(feedPath, assets, PUB_A, ['--expect-url-prefix', `${BASE}/`]).status, 0)
    const wrong = verify(feedPath, assets, PUB_A, ['--expect-url-prefix', 'https://evil.example/releases/'])
    assert.equal(wrong.status, 1)
    assert.ok(/does not start with expected prefix/.test(wrong.stderr), wrong.stderr)
    // prefix is a strict prefix of the url's directory: remainder contains a slash
    const deeper = verify(feedPath, assets, PUB_A, ['--expect-url-prefix', 'https://github.com/example/chroxy/'])
    assert.equal(deeper.status, 1)
    assert.ok(/exactly the asset name/.test(deeper.stderr), deeper.stderr)
    // a query or fragment after the name is not "exactly the asset name"
    const feed = JSON.parse(readFileSync(feedPath, 'utf8'))
    feed.platforms['windows-x86_64'].url += '?x=1'
    writeFileSync(feedPath, JSON.stringify(feed))
    const q = verify(feedPath, assets, PUB_A, ['--expect-url-prefix', `${BASE}/`])
    assert.equal(q.status, 1)
    assert.ok(/exactly the asset name/.test(q.stderr), q.stderr)
    // url that is only the prefix
    feed.platforms['windows-x86_64'].url = `${BASE}/`
    writeFileSync(feedPath, JSON.stringify(feed))
    assert.equal(verify(feedPath, assets, PUB_A, ['--expect-url-prefix', `${BASE}/`]).status, 1)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: --require-signed-version needs a signed version: equal to the feed version', () => {
  // tauri-cli 2.10 build signatures carry no version: so the real fixture must fail the option
  const {dir, assets, feedPath} = stageRelease()
  try {
    const none = verify(feedPath, assets, PUB_A, ['--require-signed-version'])
    assert.equal(none.status, 1)
    assert.ok(/carries no signed version/.test(none.stderr), none.stderr)
    assert.equal(verify(feedPath, assets, PUB_A).status, 0)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
  const s = ephemeralSigner('timestamp:1\tfile:Signed.msi\tversion:1.2.3')
  const d2 = scratch()
  try {
    const a2 = join(d2, 'assets')
    mkdirSync(a2)
    writeFileSync(join(a2, 'Signed.msi'), PAYLOAD)
    const fp = join(d2, 'latest.json')
    const feed = {version: '1.2.3', platforms: {k: {signature: s.sign(PAYLOAD), url: `${BASE}/Signed.msi`}}}
    writeFileSync(fp, JSON.stringify(feed))
    assert.equal(verify(fp, a2, s.pubkey, ['--require-signed-version']).status, 0)
    feed.version = '1.2.4'
    writeFileSync(fp, JSON.stringify(feed))
    const bad = verify(fp, a2, s.pubkey, ['--require-signed-version'])
    assert.equal(bad.status, 1)
    assert.ok(/signed for version/.test(bad.stderr), bad.stderr)
  } finally {
    rmSync(d2, {recursive: true, force: true})
  }
})

test('verify-feed: an unreadable assets directory fails with its own message', () => {
  const {dir, feedPath} = stageRelease()
  try {
    const r = verify(feedPath, join(dir, 'no-such-assets'))
    assert.equal(r.status, 1)
    assert.ok(/could not read assets directory/.test(r.stderr), r.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: a url with a trailing slash names no asset', () => {
  const {dir, assets, feedPath} = stageRelease({
    extra: ({feedPath: fp}) => {
      const feed = JSON.parse(readFileSync(fp, 'utf8'))
      feed.platforms['windows-x86_64'].url += '/'
      writeFileSync(fp, JSON.stringify(feed))
    },
  })
  try {
    const r = verify(feedPath, assets)
    assert.equal(r.status, 1)
    assert.ok(/no asset named ""/.test(r.stderr), r.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: a numeric feed version is not loosely equal to the expected string', () => {
  const {dir, assets, feedPath} = stageRelease({
    extra: ({feedPath: fp}) => {
      const feed = JSON.parse(readFileSync(fp, 'utf8'))
      feed.version = 123
      writeFileSync(fp, JSON.stringify(feed))
    },
  })
  try {
    const r = verify(feedPath, assets, PUB_A, ['--expect-version', '123'])
    assert.equal(r.status, 1)
    assert.ok(/does not match expected/.test(r.stderr), r.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('verify-feed: a symlink named like the asset is not an asset', { skip: process.platform === 'win32' }, () => {
  const {dir, assets, feedPath, msi} = stageRelease()
  try {
    const target = join(dir, 'real.msi')
    cpSync(msi, target)
    rmSync(msi)
    symlinkSync(target, join(assets, 'win', 'Chroxy_1.2.3_x64_en-US.msi'))
    const r = verify(feedPath, assets)
    assert.equal(r.status, 1)
    assert.ok(/no asset named/.test(r.stderr), r.stderr)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})
