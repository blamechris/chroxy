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
 * Sign an ephemeral exchange public key (base64) with the identity secret key.
 * Returns the detached signature as base64. The signed message is the RAW bytes
 * of the exchange public key (decoded from base64), so both sides sign/verify
 * over identical bytes regardless of base64 canonicalisation.
 *
 * @param exchangePublicKeyBase64 - the per-connection X25519 public key to bind
 * @param identitySecretKey - the 64-byte Ed25519 secret key
 * @returns base64-encoded 64-byte detached signature
 */
export declare function signExchangeKey(exchangePublicKeyBase64: string, identitySecretKey: Uint8Array): string;
/**
 * Verify that `signatureBase64` is a valid Ed25519 signature over
 * `exchangePublicKeyBase64`, produced by the holder of the secret key matching
 * `identityPublicKeyBase64` (the pinned identity key). Returns true on a valid
 * signature, false on any mismatch / malformed input. NEVER throws — a bad or
 * absent signature is a verification FAILURE the caller must treat as a refusal,
 * not an exception to swallow.
 *
 * @param exchangePublicKeyBase64 - the per-connection X25519 public key offered
 * @param signatureBase64 - the detached signature offered by the server
 * @param identityPublicKeyBase64 - the PINNED identity public key to verify against
 */
export declare function verifyExchangeKeySignature(exchangePublicKeyBase64: string, signatureBase64: string, identityPublicKeyBase64: string): boolean;
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
