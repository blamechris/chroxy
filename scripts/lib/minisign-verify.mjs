/**
 * minisign-verify.mjs — pure-Node verification of a Tauri updater signature.
 *
 * Tauri signs updater payloads with minisign (the `ED` prehashed variant) and
 * hands the box text around base64-encoded twice over: `plugins.updater.pubkey`
 * in tauri.conf.json is base64(public key box), and a `.sig` file (and the
 * `signature` field of `latest.json`) is base64(signature box). This module
 * is a release gate (#8906, #8917): it NEVER accepts a signature the Tauri
 * updater client (minisign-verify + base64 STANDARD + strict UTF-8) rejects.
 * It is deliberately STRICTER than the client in three ways:
 *   - only the prehashed `ED` signature algorithm is accepted (the client
 *     also takes legacy `Ed`), and the public key algorithm must be `Ed`;
 *   - the `untrusted comment:` / `trusted comment: ` prefixes are required;
 *   - any small-order public key (identity, all-zero, ...) is refused up front.
 * Encoding is parsed the way the client does and no looser: base64 must be
 * canonical (no whitespace, no non-zero trailing bits, correct padding), text
 * must be strict UTF-8, lines split like Rust `str::lines()`, and blank lines
 * are NEVER skipped because the fields are positional.
 *
 * Box layouts (minisign):
 *   public key : "untrusted comment: ..." \n base64( 'Ed' | keyId[8] | pk[32] )
 *   signature  : "untrusted comment: ..." \n base64( 'ED' | keyId[8] | sig[64] )
 *                "trusted comment: <text>" \n base64( globalSig[64] )
 *   `sig` signs BLAKE2b-512(payload); `globalSig` signs sig ‖ trustedComment.
 *
 * Never throws on malformed input: returns {ok:false, reason}.
 */

import {createHash, createPublicKey, verify} from 'node:crypto'

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const TRUSTED_PREFIX = 'trusted comment: '
const UNTRUSTED_PREFIX = 'untrusted comment:'
const UTF8 = new TextDecoder('utf-8', {fatal: true})

/** Canonical base64 only: whitespace, bad padding and non-zero trailing bits all fail the round trip. */
function decodeBase64(text) {
  if (typeof text !== 'string' || text === '') return null
  const buf = Buffer.from(text, 'base64')
  return buf.toString('base64') === text ? buf : null
}

/** Strict UTF-8 decode; null when the bytes are not valid UTF-8. */
function decodeUtf8(buf) {
  try {
    return UTF8.decode(buf)
  } catch {
    return null
  }
}

/**
 * Split like Rust `str::lines()`: on `\n`, one trailing `\r` stripped from each
 * newline-terminated line, a single trailing empty element dropped, blank
 * lines kept (positions matter).
 */
function boxLines(text) {
  const parts = text.split('\n')
  const terminated = parts.length - 1
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.map((l, i) => (i < terminated && l.endsWith('\r') ? l.slice(0, -1) : l))
}

// Encodings (little-endian y, sign bit cleared) of every Ed25519 point of order dividing 8,
// libsodium's blocklist: y = 0, 1, p-1, the two order-8 y values, and the non-canonical
// y = p and y = p+1. The unit test re-derives these with the group law.
const SMALL_ORDER_Y = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
].map((h) => Buffer.from(h, 'hex'))

function isSmallOrderKey(key) {
  const masked = Buffer.from(key)
  masked[31] &= 0x7f
  return SMALL_ORDER_Y.some((y) => y.equals(masked))
}

function parsePublicKey(pubkeyB64) {
  const raw = decodeBase64(pubkeyB64)
  if (!raw) return {reason: 'public key is not canonical base64'}
  const text = decodeUtf8(raw)
  if (text === null) return {reason: 'public key box is not valid UTF-8'}
  const lines = boxLines(text)
  if (lines.length < 2 || !lines[0].startsWith(UNTRUSTED_PREFIX)) {
    return {reason: 'public key box is malformed'}
  }
  const body = decodeBase64(lines[1])
  if (!body || body.length !== 42) return {reason: 'public key body must be 42 bytes'}
  if (body.toString('latin1', 0, 2) !== 'Ed') return {reason: 'public key algorithm is not Ed'}
  const key = body.subarray(10, 42)
  // Small-order points (order dividing 8, including non-canonical y >= p) make every
  // identity-point "signature" verify, so they must never anchor trust. The client masks
  // the sign bit before its identity test, so the comparison here masks it too.
  if (isSmallOrderKey(key)) return {reason: 'public key is a degenerate (small-order) key'}
  return {keyId: body.subarray(2, 10), key}
}

function parseSignature(signatureB64) {
  const raw = decodeBase64(signatureB64)
  if (!raw) return {reason: 'signature is not canonical base64'}
  const text = decodeUtf8(raw)
  if (text === null) return {reason: 'signature box is not valid UTF-8'}
  const lines = boxLines(text)
  if (lines.length < 4 || !lines[0].startsWith(UNTRUSTED_PREFIX) || !lines[2].startsWith(TRUSTED_PREFIX)) {
    return {reason: 'signature box is malformed'}
  }
  const body = decodeBase64(lines[1])
  if (!body || body.length !== 74) return {reason: 'signature body must be 74 bytes'}
  const alg = body.toString('latin1', 0, 2)
  if (alg !== 'ED') return {reason: `unsupported signature algorithm "${alg}" (only prehashed "ED" is supported)`}
  const globalSig = decodeBase64(lines[3])
  if (!globalSig || globalSig.length !== 64) return {reason: 'global signature must be 64 bytes'}
  return {
    keyId: body.subarray(2, 10),
    sig: body.subarray(10, 74),
    trustedComment: lines[2].slice(TRUSTED_PREFIX.length),
    globalSig,
  }
}

function ed25519Verify(rawKey, message, signature) {
  const key = createPublicKey({key: Buffer.concat([SPKI_ED25519_PREFIX, rawKey]), format: 'der', type: 'spki'})
  return verify(null, message, key, signature)
}

/**
 * @param {string} pubkeyB64 base64 of the public key box (tauri.conf.json value)
 * @param {string} signatureB64 base64 of the signature box (.sig / latest.json)
 * @param {Buffer} payload the bytes the updater client will download
 * @returns {{ok: boolean, reason: string|null, trustedComment: string|null}}
 */
export function verifyTauriSignature(pubkeyB64, signatureB64, payload) {
  const fail = (reason, trustedComment = null) => ({ok: false, reason, trustedComment})
  try {
    if (!Buffer.isBuffer(payload)) return fail('payload must be a Buffer')
    const pk = parsePublicKey(pubkeyB64)
    if (pk.reason) return fail(pk.reason)
    const sg = parseSignature(signatureB64)
    if (sg.reason) return fail(sg.reason)

    if (!pk.keyId.equals(sg.keyId)) {
      return fail(`signature key id ${sg.keyId.toString('hex')} does not match public key id ${pk.keyId.toString('hex')}`)
    }
    const digest = createHash('blake2b512').update(payload).digest()
    if (!ed25519Verify(pk.key, digest, sg.sig)) {
      return fail('payload signature does not verify (payload or signature was altered)')
    }
    const globalMessage = Buffer.concat([sg.sig, Buffer.from(sg.trustedComment, 'utf8')])
    if (!ed25519Verify(pk.key, globalMessage, sg.globalSig)) {
      return fail('trusted comment signature does not verify (comment was altered)')
    }
    return {ok: true, reason: null, trustedComment: sg.trustedComment}
  } catch (err) {
    return fail(`verification error: ${err.message}`)
  }
}

/** Extract `version:<v>` from a trusted comment (`k:v` pairs separated by tabs). */
export function trustedCommentVersion(trustedComment) {
  if (typeof trustedComment !== 'string') return null
  for (const part of trustedComment.split('\t')) {
    if (part.startsWith('version:')) return part.slice('version:'.length)
  }
  return null
}
