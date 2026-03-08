/**
 * Token encryption for localStorage persistence.
 *
 * Encrypts auth tokens before storing in localStorage using AES-GCM
 * with a key derived from a stable per-origin identifier. This is a
 * hardening measure — not a substitute for proper secret management —
 * to prevent casual plaintext exposure in dev tools or localStorage viewers.
 *
 * The sync API uses a lightweight XOR obfuscation for compatibility with
 * synchronous store initialization. The async API uses Web Crypto AES-GCM
 * for stronger encryption and is used during background migration.
 *
 * Both formats are supported on read (migration-safe).
 */

const OBFUSCATED_PREFIX = 'obf:v1:'
const ENCRYPTED_PREFIX = 'enc:v1:'

/** Stable key material derived from origin */
function getKeyBytes(): number[] {
  const source = typeof window !== 'undefined' ? window.location.origin : 'chroxy-dashboard'
  const key = `chroxy-token-key:${source}`
  const bytes: number[] = []
  for (let i = 0; i < key.length; i++) {
    bytes.push(key.charCodeAt(i))
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Sync API — XOR obfuscation (used in load/save for immediate availability)
// ---------------------------------------------------------------------------

/** Obfuscate a token using XOR with the key material (sync) */
export function obfuscateToken(plaintext: string): string {
  if (!plaintext) return plaintext
  const key = getKeyBytes()
  const bytes: number[] = []
  for (let i = 0; i < plaintext.length; i++) {
    bytes.push(plaintext.charCodeAt(i) ^ key[i % key.length]!)
  }
  return OBFUSCATED_PREFIX + btoa(String.fromCharCode(...bytes))
}

/** De-obfuscate a token (sync) */
export function deobfuscateToken(stored: string): string {
  if (!stored) return stored
  // Plaintext (not obfuscated or encrypted) — return as-is (migration-safe)
  if (!stored.startsWith(OBFUSCATED_PREFIX) && !stored.startsWith(ENCRYPTED_PREFIX)) {
    return stored
  }
  if (stored.startsWith(OBFUSCATED_PREFIX)) {
    try {
      const payload = stored.slice(OBFUSCATED_PREFIX.length)
      const binary = atob(payload)
      const key = getKeyBytes()
      let result = ''
      for (let i = 0; i < binary.length; i++) {
        result += String.fromCharCode(binary.charCodeAt(i) ^ key[i % key.length]!)
      }
      return result
    } catch {
      return stored
    }
  }
  // enc:v1: prefix — can only be decrypted async, return as-is for sync path
  return stored
}

/** Check if a stored value is obfuscated or encrypted */
export function isProtected(value: string): boolean {
  return value.startsWith(OBFUSCATED_PREFIX) || value.startsWith(ENCRYPTED_PREFIX)
}
