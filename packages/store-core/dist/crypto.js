import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
const { encodeBase64, decodeBase64 } = naclUtil;
const NONCE_LENGTH = 24;
const MAX_NONCE_COUNTER = 2 ** 48;
const CONNECTION_SALT_BYTES = 32;
/** Direction byte for nonce construction — prevents nonce reuse across send directions */
export const DIRECTION_SERVER = 0x00;
export const DIRECTION_CLIENT = 0x01;
/**
 * Wire up a platform-specific random bytes generator.
 * Must be called once at startup on platforms where TweetNaCl's
 * auto-detection fails (e.g. React Native / JSC).
 *
 * @param getRandomBytes - function returning n random bytes (e.g. expo-crypto's getRandomBytes)
 */
export function initPRNG(getRandomBytes) {
    nacl.setPRNG((x, n) => {
        const bytes = getRandomBytes(n);
        x.set(bytes);
    });
}
/**
 * Generate an ephemeral X25519 keypair for key exchange.
 */
export function createKeyPair() {
    const kp = nacl.box.keyPair();
    return { publicKey: encodeBase64(kp.publicKey), secretKey: kp.secretKey };
}
/**
 * Derive a shared symmetric key from the other side's public key and our secret key.
 */
export function deriveSharedKey(theirPubBase64, mySecretKey) {
    if (typeof theirPubBase64 !== 'string' || theirPubBase64.trim().length === 0) {
        throw new Error('Invalid peer public key: expected a non-empty base64 string');
    }
    let theirPub;
    try {
        theirPub = decodeBase64(theirPubBase64);
    }
    catch {
        throw new Error('Invalid peer public key: not valid base64');
    }
    if (theirPub.length !== nacl.box.publicKeyLength) {
        throw new Error(`Invalid peer public key: expected length ${nacl.box.publicKeyLength}, got ${theirPub.length}`);
    }
    // Wrap in Uint8Array to ensure compatibility across environments (Node.js Buffer, jsdom, etc.)
    return new Uint8Array(nacl.box.before(theirPub, mySecretKey));
}
/**
 * Build a 24-byte nonce from a direction byte and integer counter.
 * Byte 0 is direction (0=server, 1=client), bytes 1-8 are counter (little-endian).
 */
export function nonceFromCounter(n, direction) {
    if (n > MAX_NONCE_COUNTER) {
        throw new Error('Nonce counter exhausted — reconnect required for new key exchange');
    }
    const nonce = new Uint8Array(NONCE_LENGTH);
    nonce[0] = direction;
    let val = n;
    for (let i = 1; i <= 8; i++) {
        nonce[i] = val & 0xff;
        val = Math.floor(val / 256);
    }
    return nonce;
}
/**
 * Encrypt a JSON string using XSalsa20-Poly1305.
 */
export function encrypt(jsonString, sharedKey, nonceCounter, direction) {
    const nonce = nonceFromCounter(nonceCounter, direction);
    // Ensure pure Uint8Array (not Buffer or jsdom subclass) for tweetnacl compatibility
    const messageBytes = new Uint8Array(new TextEncoder().encode(jsonString));
    const ciphertext = nacl.secretbox(new Uint8Array(messageBytes), new Uint8Array(nonce), new Uint8Array(sharedKey));
    return {
        type: 'encrypted',
        d: encodeBase64(ciphertext),
        n: nonceCounter,
    };
}
/**
 * Decrypt an encrypted envelope and return the parsed JSON object.
 */
export function decrypt(envelope, sharedKey, expectedNonce, direction) {
    if (typeof envelope.d !== 'string') {
        throw new TypeError('decrypt: envelope.d must be a base64 string');
    }
    if (typeof envelope.n !== 'number') {
        throw new TypeError('decrypt: envelope.n must be a number');
    }
    if (envelope.n !== expectedNonce) {
        throw new Error(`Unexpected nonce: got ${envelope.n}, expected ${expectedNonce}`);
    }
    const nonce = nonceFromCounter(envelope.n, direction);
    const ciphertext = new Uint8Array(decodeBase64(envelope.d));
    const plaintext = nacl.secretbox.open(ciphertext, new Uint8Array(nonce), new Uint8Array(sharedKey));
    if (!plaintext) {
        throw new Error('Decryption failed: message tampered or wrong key');
    }
    return JSON.parse(new TextDecoder().decode(plaintext));
}
/**
 * Generate a fresh 32-byte random salt for a new connection.
 * The salt must be exchanged during the handshake so both sides can derive
 * the same per-connection sub-key via deriveConnectionKey().
 *
 * @returns base64-encoded 32 random bytes
 */
export function generateConnectionSalt() {
    return encodeBase64(nacl.randomBytes(CONNECTION_SALT_BYTES));
}
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
export function deriveConnectionKey(sharedKey, saltBase64) {
    if (!(sharedKey instanceof Uint8Array) || sharedKey.length !== nacl.secretbox.keyLength) {
        throw new Error(`Invalid shared key: expected ${nacl.secretbox.keyLength}-byte Uint8Array, got ${sharedKey instanceof Uint8Array ? sharedKey.length : typeof sharedKey}`);
    }
    if (typeof saltBase64 !== 'string' || saltBase64.trim().length === 0) {
        throw new Error('Invalid connection salt: expected a non-empty base64 string');
    }
    let saltBytes;
    try {
        saltBytes = decodeBase64(saltBase64);
    }
    catch {
        throw new Error('Invalid connection salt: not valid base64');
    }
    if (saltBytes.length !== CONNECTION_SALT_BYTES) {
        throw new Error(`Invalid connection salt: expected ${CONNECTION_SALT_BYTES} bytes, got ${saltBytes.length}`);
    }
    // Concatenate sharedKey ∥ saltBytes and hash with SHA-512.
    const input = new Uint8Array(sharedKey.length + saltBytes.length);
    input.set(sharedKey, 0);
    input.set(saltBytes, sharedKey.length);
    const hash = nacl.hash(input);
    // Return the first 32 bytes as the sub-key.
    return hash.slice(0, nacl.secretbox.keyLength);
}
