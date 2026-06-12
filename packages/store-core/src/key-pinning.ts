/**
 * Shared E2E key-pinning decision logic (#5536).
 *
 * The transport key exchange is pure TOFU: the client accepts whatever
 * ephemeral exchange public key the server sends on every connect, so a MITM
 * who can swap that key relays the whole session undetected. To pin server
 * identity we convey the daemon's LONG-LIVED Ed25519 identity public key
 * out-of-band at pairing time (in the QR / pairing-code, a trusted channel) and
 * store it on the connection record. On every handshake the server signs its
 * ephemeral exchange key with the identity secret; the client verifies that
 * signature against the PINNED identity key.
 *
 * Both clients (mobile app + dashboard) run the exact SAME decision tree, so it
 * lives here once. The app and dashboard differ only in *where* the pinned key
 * is stored (SecureStore vs. the localStorage server registry) and *how* the
 * refusal surfaces — those are the caller's effects.
 *
 * ## The decision tree (per handshake, both eager and discrete paths)
 *
 *   pinnedIdentityKey present?
 *     ├─ yes → server sent a signature?
 *     │         ├─ yes → verify(sig over exchangeKey, pinnedKey)
 *     │         │         ├─ ok    → CONNECT (identity confirmed)
 *     │         │         └─ fail  → REFUSE  (MITM / wrong daemon / rotated key)
 *     │         └─ no  → REFUSE (pinned but unsigned — downgrade attempt: a MITM
 *     │                  cannot produce a valid sig, so it would strip the field
 *     │                  to force us back to TOFU; refusing closes that door)
 *     └─ no  → unpinned record (legacy / paired before this change)
 *               ├─ server sent a sig + key → PIN-ON-FIRST-USE (capture the
 *               │   identity now; trust continuity — same TOFU exposure as before,
 *               │   but every subsequent connect is verified)
 *               └─ no sig → CONNECT, stay unpinned (old daemon; pure TOFU as before)
 *
 * ## Why refuse a pinned-but-unsigned handshake
 *
 * Once a client has pinned an identity, the ONLY reason a connection would
 * arrive without a signature is (a) the daemon rotated/lost its identity key, or
 * (b) a MITM stripped the signature to downgrade us to TOFU. We cannot tell
 * these apart on the wire, and a silent fall-through to TOFU would let any
 * active attacker defeat pinning by simply deleting the field. So we fail
 * closed: the user must re-pair (which re-pins the new identity) to proceed.
 * This is the standard "no silent downgrade" rule from the key-exchange design
 * (the server already refuses to downgrade encryption to plaintext).
 */

import { verifyExchangeKeySignature } from './crypto'

/** What the caller should do with a handshake, given the pin state. */
export type KeyPinDecision =
  /** Proceed with the handshake; identity is confirmed or this is an old/unpinned daemon. */
  | { action: 'connect'; reason: 'verified' | 'unpinned-no-identity' }
  /** Proceed AND store `identityKey` as the newly-pinned identity (TOFU first-use). */
  | { action: 'pin-and-connect'; reason: 'pin-on-first-use'; identityKey: string }
  /** Abort the connection; the offered key failed verification against the pin. */
  | {
      action: 'refuse'
      reason: 'signature-mismatch' | 'pinned-but-unsigned' | 'pinned-but-unencrypted'
      message: string
    }

/** Inputs to the pin decision — the pinned key (if any) + what the server offered. */
export interface KeyPinInput {
  /** The identity public key pinned for this connection record, or null if unpinned. */
  pinnedIdentityKey: string | null
  /** The ephemeral exchange public key the server offered this handshake. */
  exchangePublicKey: string
  /** The server's signature over `exchangePublicKey`, or null if it sent none. */
  serverKeySig: string | null
}

/**
 * The user-facing refusal copy for a key-pin mismatch. A single shared constant
 * so both clients show identical, specific wording — a distinct error state, not
 * a generic "connection failed" that a retry loop would silently bounce off.
 */
export const KEY_PIN_MISMATCH_MESSAGE =
  "Server identity changed — refused to connect. The daemon's encryption key " +
  "doesn't match the one you paired with. This can happen if the server was " +
  "reinstalled or its identity key rotated — or it could be a network " +
  'impersonation attempt. Re-pair (scan a fresh QR / enter a new pairing code) ' +
  'to trust the new identity.'

/**
 * The user-facing refusal copy for a pinned connection that arrived WITHOUT
 * encryption (#5614). Distinct enough that the UI/log can tell it apart from a
 * signature mismatch, but the same "refused — possible impersonation" framing so
 * the user treats it as the security event it is.
 */
export const KEY_PIN_DOWNGRADE_MESSAGE =
  'Refused to connect — this server you paired with did not negotiate ' +
  'encryption. A paired (pinned) connection must be end-to-end encrypted; an ' +
  'unencrypted handshake here means the server lost its identity key, or a ' +
  'network attacker is trying to downgrade you to plaintext to bypass identity ' +
  'verification. Re-pair (scan a fresh QR / enter a new pairing code) if the ' +
  'server was genuinely reinstalled.'

/**
 * #5614 — the encryption-mode gate for the eager `auth_ok` frame, evaluated
 * BEFORE the per-path pin check (which only runs once encryption is negotiated).
 *
 * The pin verification ({@link decideKeyPin}) is reached only when the server
 * asks for encryption. A MITM who forges a plaintext `auth_ok` with
 * `encryption:'none'` (or omits the field) would therefore skip the pin check
 * entirely and drop the client onto an unencrypted, UNVERIFIED session —
 * defeating #5536 with a one-field downgrade. This gate closes that cell: if the
 * connection carries ANY pinned identity (a committed pin from a prior connect,
 * OR a pairing-time identity captured this dial), the ONLY acceptable handshake
 * is `encryption:'required'`. Anything else fails closed — same refusal posture
 * as a pin mismatch, never a silent fall-through to plaintext.
 *
 * Unpinned connections are unaffected: they keep TOFU (encryption optional),
 * exactly as before. The caller invokes this at the TOP of its `auth_ok` handler
 * — before it branches on `encryption === 'required'` — so the gate cannot be
 * bypassed on either the eager or the discrete path.
 *
 * @returns `{ action: 'refuse', ... }` when a pinned connection is unencrypted,
 *          else `{ action: 'connect', reason: 'verified' }` to continue (the
 *          real pin check still runs inside the encryption branch). Pure; no I/O.
 */
export function decodeEncryptionGate(input: {
  /** The committed pin for this connection record, or null. */
  pinnedIdentityKey: string | null
  /** Identity captured at pairing time this dial but not yet committed, or null. */
  pairingIdentityKey: string | null
  /** The `encryption` field from the `auth_ok` frame (server-advertised mode). */
  encryptionMode: string | null | undefined
}): Extract<KeyPinDecision, { action: 'refuse' }> | { action: 'connect'; reason: 'verified' } {
  const isPinned = Boolean(input.pinnedIdentityKey || input.pairingIdentityKey)
  if (isPinned && input.encryptionMode !== 'required') {
    return {
      action: 'refuse',
      reason: 'pinned-but-unencrypted',
      message: KEY_PIN_DOWNGRADE_MESSAGE,
    }
  }
  return { action: 'connect', reason: 'verified' }
}

/**
 * The shared pin-or-TOFU decision. Pure: no I/O, no store reads. The caller
 * supplies the pinned key from its own store and the offered key/sig from the
 * handshake frame, then acts on the returned decision (open vs. close the
 * socket, persist the newly-pinned key, surface the refusal).
 *
 * NEVER throws — `verifyExchangeKeySignature` already swallows malformed input
 * and returns false, which maps to a refusal here.
 */
export function decideKeyPin(input: KeyPinInput): KeyPinDecision {
  const { pinnedIdentityKey, exchangePublicKey, serverKeySig } = input

  // Unpinned record (legacy, or paired before this change).
  if (!pinnedIdentityKey) {
    if (serverKeySig && exchangePublicKey) {
      // The daemon advertises an identity + signed this exchange key. We can't
      // verify the signature (we have nothing pinned to verify against), but the
      // signature does prove the exchange key is internally consistent with SOME
      // identity. Capture that identity now — pin-on-first-use — so every later
      // connect is verified. This is trust continuity: the FIRST connect is the
      // same TOFU exposure that existed before pinning, but it's the only one.
      //
      // We derive the identity to pin from the signature's validity against the
      // exchange key is NOT possible (Ed25519 has no public-key recovery), so the
      // pinned identity must be the one captured at PAIRING time, not here. When
      // there is no pairing-time identity (e.g. a manual ws:// connect that never
      // saw a QR), we cannot pin on first use — there is no authenticated
      // identity to adopt. The caller passes the pairing-time identity (if any)
      // as the would-be pin via `pin-on-first-use` only when it captured one.
      //
      // NOTE: see decideKeyPinWithPairingIdentity below — the pure first-use pin
      // needs the pairing identity, handled by the caller.
      return { action: 'connect', reason: 'unpinned-no-identity' }
    }
    // Old daemon (no identity advertised) — pure TOFU as before.
    return { action: 'connect', reason: 'unpinned-no-identity' }
  }

  // Pinned record but the server sent no signature → downgrade / rotation.
  // Fail closed (see header).
  if (!serverKeySig) {
    return {
      action: 'refuse',
      reason: 'pinned-but-unsigned',
      message: KEY_PIN_MISMATCH_MESSAGE,
    }
  }

  // Pinned + signed → verify the offered exchange key against the pinned identity.
  const ok = verifyExchangeKeySignature(exchangePublicKey, serverKeySig, pinnedIdentityKey)
  if (ok) {
    return { action: 'connect', reason: 'verified' }
  }
  return {
    action: 'refuse',
    reason: 'signature-mismatch',
    message: KEY_PIN_MISMATCH_MESSAGE,
  }
}

/**
 * The full decision INCLUDING pin-on-first-use, which needs the pairing-time
 * identity key (the one captured from the QR / pairing-code `idk=` param) to
 * adopt. This is the canonical entry point the clients call.
 *
 * `pairingIdentityKey` is the identity the client captured at pairing time for
 * this connection but has not yet committed as the pin (first connect after
 * pairing, or a re-pair). When present and the record is still unpinned, we
 * VERIFY the offered exchange signature against it before pinning — so a MITM on
 * the very first connect cannot inject a different identity than the one the
 * trusted pairing channel conveyed. If verification passes we pin it; if it
 * fails we refuse (the first-connect MITM case).
 *
 * Precedence:
 *   - pinnedIdentityKey set        → {@link decideKeyPin} (verify against the pin)
 *   - else pairingIdentityKey set  → verify against pairing key, then pin or refuse
 *   - else                         → unpinned TOFU (old daemon / manual connect)
 */
export function decideKeyPinWithPairingIdentity(input: KeyPinInput & {
  /** Identity captured at pairing time, not yet committed as the pin. */
  pairingIdentityKey: string | null
}): KeyPinDecision {
  const { pinnedIdentityKey, pairingIdentityKey, exchangePublicKey, serverKeySig } = input

  // Already pinned → the strict path.
  if (pinnedIdentityKey) {
    return decideKeyPin({ pinnedIdentityKey, exchangePublicKey, serverKeySig })
  }

  // Not yet pinned, but we have a pairing-time identity to adopt. Verify the
  // offered exchange key against it (closing the first-connect MITM window the
  // trusted pairing channel was meant to prevent), then pin.
  if (pairingIdentityKey) {
    if (!serverKeySig) {
      // We expected this daemon to sign (it advertised an identity at pairing),
      // but the handshake is unsigned → downgrade attempt. Refuse.
      return {
        action: 'refuse',
        reason: 'pinned-but-unsigned',
        message: KEY_PIN_MISMATCH_MESSAGE,
      }
    }
    const ok = verifyExchangeKeySignature(exchangePublicKey, serverKeySig, pairingIdentityKey)
    if (ok) {
      return { action: 'pin-and-connect', reason: 'pin-on-first-use', identityKey: pairingIdentityKey }
    }
    return {
      action: 'refuse',
      reason: 'signature-mismatch',
      message: KEY_PIN_MISMATCH_MESSAGE,
    }
  }

  // No pin, no pairing identity → old daemon or a manual connect that never saw
  // a pairing payload. Pure TOFU, unchanged.
  return { action: 'connect', reason: 'unpinned-no-identity' }
}
