/**
 * minisign-verify.mjs — pure-Node verification of a Tauri updater signature.
 *
 * Tauri signs updater payloads with minisign (the `ED` prehashed variant) and
 * hands the box text around base64-encoded twice over: `plugins.updater.pubkey`
 * in tauri.conf.json is base64(public key box), and a `.sig` file (and the
 * `signature` field of `latest.json`) is base64(signature box). This module
 * checks exactly what the Tauri updater client checks, so a release can refuse
 * to publish a feed that installed clients would reject (#8906, #8917).
 *
 * Box layouts (minisign):
 *   public key : "untrusted comment: ..." \n base64( 'Ed' | keyId[8] | pk[32] )
 *   signature  : "untrusted comment: ..." \n base64( 'ED' | keyId[8] | sig[64] )
 *                "trusted comment: <text>" \n base64( globalSig[64] )
 *   `sig` signs BLAKE2b-512(payload); `globalSig` signs sig ‖ trustedComment.
 *
 * Only the `ED` (prehashed) algorithm is accepted: it is the one tauri's
 * signer emits, and the one the committed fixtures exercise. Anything else is
 * rejected with an explicit reason rather than handled by an untested branch.
 *
 * Never throws on malformed input: returns {ok:false, reason}.
 */

import {createHash, createPublicKey, verify} from 'node:crypto'

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const TRUSTED_PREFIX = 'trusted comment: '

function decodeBase64(text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (t === '' || t.length % 4 !== 0 || !STRICT_BASE64.test(t)) return null
  return Buffer.from(t, 'base64')
}

function boxLines(text) {
  return text.split(/\r?\n/).filter((l) => l !== '')
}

function parsePublicKey(pubkeyB64) {
  const raw = decodeBase64(pubkeyB64)
  if (!raw) return {reason: 'public key is not valid base64'}
  const lines = boxLines(raw.toString('utf8'))
  if (lines.length < 2 || !lines[0].startsWith('untrusted comment:')) {
    return {reason: 'public key box is malformed'}
  }
  const body = decodeBase64(lines[1])
  if (!body || body.length !== 42) return {reason: 'public key body must be 42 bytes'}
  if (body.toString('latin1', 0, 2) !== 'Ed') return {reason: 'public key algorithm is not Ed'}
  return {keyId: body.subarray(2, 10), key: body.subarray(10, 42)}
}

function parseSignature(signatureB64) {
  const raw = decodeBase64(signatureB64)
  if (!raw) return {reason: 'signature is not valid base64'}
  const lines = boxLines(raw.toString('utf8'))
  if (lines.length < 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith(TRUSTED_PREFIX)) {
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
