import { getRandomBytes } from 'expo-crypto'
import { initPRNG } from '@chroxy/store-core'

// React Native's JSC runtime has neither browser crypto.getRandomValues nor
// Node.js require('crypto'), so TweetNaCl's auto-init fails with "no PRNG".
// Explicitly wire up expo-crypto's native random bytes generator.
initPRNG((n: number) => getRandomBytes(n))

export type {
  KeyPair,
  EncryptedEnvelope,
  EncryptionState,
} from '@chroxy/store-core'

export {
  DIRECTION_SERVER,
  DIRECTION_CLIENT,
  createKeyPair,
  deriveSharedKey,
  nonceFromCounter,
  encrypt,
  decrypt,
} from '@chroxy/store-core'
