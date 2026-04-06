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
