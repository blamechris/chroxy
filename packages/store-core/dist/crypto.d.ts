/** Direction byte for nonce construction — prevents nonce reuse across send directions */
export declare const DIRECTION_SERVER = 0;
export declare const DIRECTION_CLIENT = 1;
export interface KeyPair {
    publicKey: string;
    secretKey: Uint8Array;
}
export interface EncryptedEnvelope {
    type: 'encrypted';
    d: string;
    n: number;
}
export interface EncryptionState {
    sharedKey: Uint8Array;
    sendNonce: number;
    recvNonce: number;
}
/**
 * Wire up a platform-specific random bytes generator.
 * Must be called once at startup on platforms where TweetNaCl's
 * auto-detection fails (e.g. React Native / JSC).
 *
 * @param getRandomBytes - function returning n random bytes (e.g. expo-crypto's getRandomBytes)
 */
export declare function initPRNG(getRandomBytes: (n: number) => Uint8Array): void;
/**
 * Generate an ephemeral X25519 keypair for key exchange.
 */
export declare function createKeyPair(): KeyPair;
export interface SigningKeyPair {
    publicKey: string;
    secretKey: Uint8Array;
}
/**
 * Generate a long-lived Ed25519 identity (signing) keypair. The server
 * persists this across restarts (keychain / state dir); the public half is the
 * value pinned by clients at pairing time.
 */
export declare function createSigningKeyPair(): SigningKeyPair;
/**
 * #5604 — domain-separation label for the exchange-key signature. The identity
 * key today signs ONLY the exchange key, so the bare 32 bytes are unambiguous;
 * but if the key is ever reused to sign another payload (rotation statements,
 * capability grants, …) a context-free signature invites cross-protocol
 * confusion. Prefixing this versioned ASCII label binds a signature to "this is
 * an exchange key" so it can never be replayed as another statement. `v1` marks
 * the scheme so a future change can bump it.
 *
 * Rollout is a compat ramp (see `verifyExchangeKeySignature`): the verifier
 * accepts BOTH the bare and domain-separated forms now, so the signer can flip
 * to the domain-separated form in a later release without forcing already-pinned
 * clients to re-pair.
 */
export declare const EXCHANGE_KEY_SIG_DOMAIN_V1 = "chroxy-exchange-key-v1:";
/**
 * Sign an ephemeral exchange public key (base64) with the identity secret key.
 * Returns the detached signature as base64. The signed message is the RAW bytes
 * of the exchange public key (decoded from base64), so both sides sign/verify
 * over identical bytes regardless of base64 canonicalisation.
 *
 * `opts.domainSeparated` (#5604) prepends `EXCHANGE_KEY_SIG_DOMAIN_V1` to the
 * signed bytes. Defaults to `false` (bare form) so existing callers — and the
 * live wire format — are unchanged until the compat ramp flips the signer; the
 * accept-both verifier ships first.
 *
 * @param exchangePublicKeyBase64 - the per-connection X25519 public key to bind
 * @param identitySecretKey - the 64-byte Ed25519 secret key
 * @param opts.domainSeparated - sign the domain-separated payload (default false)
 * @returns base64-encoded 64-byte detached signature
 */
export declare function signExchangeKey(exchangePublicKeyBase64: string, identitySecretKey: Uint8Array, opts?: {
    domainSeparated?: boolean;
}): string;
/**
 * Verify that `signatureBase64` is a valid Ed25519 signature over
 * `exchangePublicKeyBase64`, produced by the holder of the secret key matching
 * `identityPublicKeyBase64` (the pinned identity key). Returns true on a valid
 * signature, false on any mismatch / malformed input. NEVER throws — a bad or
 * absent signature is a verification FAILURE the caller must treat as a refusal,
 * not an exception to swallow.
 *
 * #5604 — accepts a signature over EITHER the bare exchange-key bytes (today's
 * signer) OR the domain-separated payload (`EXCHANGE_KEY_SIG_DOMAIN_V1` ++ bytes,
 * the form the signer flips to in a later release). Both require the identity
 * secret to produce, so accepting both does not weaken pinning — it only lets
 * the signer migrate without forcing already-pinned clients to re-pair. A future
 * release can drop the bare branch once the signer no longer emits it.
 *
 * @param exchangePublicKeyBase64 - the per-connection X25519 public key offered
 * @param signatureBase64 - the detached signature offered by the server
 * @param identityPublicKeyBase64 - the PINNED identity public key to verify against
 */
export declare function verifyExchangeKeySignature(exchangePublicKeyBase64: string, signatureBase64: string, identityPublicKeyBase64: string): boolean;
/**
 * #5616 — domain-separation label for an identity-key ROTATION statement: the
 * OLD identity secret signs the NEW identity PUBLIC key so a pinned client can
 * chain its pin forward (reinstall / machine migration / #5229 master-key
 * rotation) instead of refusing + forcing a manual re-pair.
 *
 * This is a SECOND statement the identity key signs (the first being the
 * exchange key, #5604), so domain separation is mandatory: without it a rotation
 * cert (old signs new-identity-bytes) and an exchange-key signature (identity
 * signs exchange-key-bytes) could be confused if their byte lengths ever
 * coincided. Both labels are versioned ASCII; this scheme is domain-separated
 * from the START (unlike the exchange-key ramp), since there is no legacy bare
 * rotation-cert wire format to stay compatible with — it's a new message.
 */
export declare const IDENTITY_ROTATION_DOMAIN_V1 = "chroxy-identity-rotation-v1:";
/**
 * Sign an identity-rotation cert: the OLD identity secret signs the NEW identity
 * public key (domain-separated). A pinned client presented this cert at handshake
 * can verify the new identity was authorised by the identity it already trusts,
 * and chain its pin forward without a manual re-pair (#5616).
 *
 * The cert alone is NOT sufficient to accept a rotation — the verifier must ALSO
 * confirm the new identity signed the live exchange key (proving the server holds
 * the new secret, not just a replayed cert). See `verifyIdentityRotation` +
 * `decideKeyPin`'s rotation branch.
 *
 * @param newIdentityPublicKeyBase64 - the NEW identity Ed25519 public key (base64)
 * @param oldIdentitySecretKey - the 64-byte OLD identity Ed25519 secret key
 * @returns base64-encoded 64-byte detached rotation cert
 */
export declare function signIdentityRotation(newIdentityPublicKeyBase64: string, oldIdentitySecretKey: Uint8Array): string;
/**
 * Verify an identity-rotation cert: that `certBase64` is a valid signature over
 * the NEW identity public key, produced by the holder of the OLD (pinned)
 * identity secret. Returns true on a valid cert, false on any mismatch /
 * malformed input. NEVER throws — an invalid cert is a verification FAILURE the
 * caller must treat as "no valid rotation", not an exception to swallow.
 *
 * Only the domain-separated form is accepted (this statement type never had a
 * bare wire form), so a context-free signature — or an exchange-key signature
 * replayed as a rotation cert — cannot pass.
 *
 * @param newIdentityPublicKeyBase64 - the NEW identity Ed25519 public key offered
 * @param certBase64 - the rotation cert offered by the server
 * @param oldIdentityPublicKeyBase64 - the PINNED (old) identity public key to verify against
 */
export declare function verifyIdentityRotation(newIdentityPublicKeyBase64: string, certBase64: string, oldIdentityPublicKeyBase64: string): boolean;
/**
 * Derive a shared symmetric key from the other side's public key and our secret key.
 */
export declare function deriveSharedKey(theirPubBase64: string, mySecretKey: Uint8Array): Uint8Array;
/**
 * Build a 24-byte nonce from a direction byte and integer counter.
 * Byte 0 is direction (0=server, 1=client), bytes 1-8 are counter (little-endian).
 */
export declare function nonceFromCounter(n: number, direction: number): Uint8Array;
/**
 * Encrypt a JSON string using XSalsa20-Poly1305.
 */
export declare function encrypt(jsonString: string, sharedKey: Uint8Array, nonceCounter: number, direction: number): EncryptedEnvelope;
/**
 * Decrypt an encrypted envelope and return the parsed JSON object.
 *
 * **Replay protection contract:**
 * This function enforces strict equality between `envelope.n` and `expectedNonce`,
 * which prevents replay attacks when the caller advances `expectedNonce` by one after
 * each successful decryption. The replay protection guarantee holds only if:
 *
 * 1. The caller increments `expectedNonce` (e.g. `recvNonce++`) immediately after
 *    each successful `decrypt()` call.
 * 2. `expectedNonce` is never reset to a value ≤ a previously accepted counter
 *    without also rotating the shared key (i.e. performing a new key exchange).
 *
 * Violating rule 1 allows a captured frame to be replayed. Violating rule 2 opens
 * a counter-reset attack after a reconnect.
 *
 * @param envelope      - The received encrypted frame.
 * @param sharedKey     - Symmetric key derived from the X25519 key exchange.
 * @param expectedNonce - The next counter value the receiver expects. Must be
 *                        exactly `envelope.n`; any deviation throws an Error whose
 *                        message starts with `'Unexpected nonce: got <n>, expected <e>'`.
 * @param direction     - Directional byte (DIRECTION_SERVER or DIRECTION_CLIENT)
 *                        used to namespace the nonce and prevent cross-direction replays.
 * @throws {Error} `'Unexpected nonce: got <n>, expected <e>'` when `envelope.n !== expectedNonce`
 * @throws {Error} `'Decryption failed: message tampered or wrong key'` when MAC verification fails
 * @throws {Error} `'Decryption failed: plaintext is not valid JSON'` when the verified plaintext does not parse as JSON
 * @throws {TypeError} `'decrypt: envelope.d must be a base64 string'` / `'decrypt: envelope.n must be a number'`
 */
export declare function decrypt(envelope: EncryptedEnvelope, sharedKey: Uint8Array, expectedNonce: number, direction: number): Record<string, unknown>;
/**
 * Generate a fresh 32-byte random salt for a new connection.
 * The salt must be exchanged during the handshake so both sides can derive
 * the same per-connection sub-key via deriveConnectionKey().
 *
 * @returns base64-encoded 32 random bytes
 */
export declare function generateConnectionSalt(): string;
/**
 * Derive a per-connection sub-key from the long-lived DH shared key and a
 * fresh random salt.  Uses SHA-512(sharedKey ∥ saltBytes) and takes the
 * first 32 bytes as the XSalsa20-Poly1305 key.
 *
 * Because each connection uses a unique salt, the nonce counter can safely
 * start at 0 for every connection without risking nonce reuse under the
 * same key.
 *
 * @param sharedKey  - 32-byte DH shared key from deriveSharedKey()
 * @param saltBase64 - base64-encoded 32-byte salt from generateConnectionSalt()
 * @returns 32-byte derived key (first half of SHA-512 output)
 */
export declare function deriveConnectionKey(sharedKey: Uint8Array, saltBase64: string): Uint8Array;
