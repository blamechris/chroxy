// Browser environments have crypto.getRandomValues available natively,
// so TweetNaCl's PRNG auto-initialises correctly without extra setup.
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
