/**
 * Fake-WS encrypted-handshake driver (epic #5556, sub-item 6).
 *
 * A self-contained, in-memory WebSocket pair (no network) that drives a REAL
 * client store through the full encrypted-handshake sequence using the REAL
 * store-core crypto (tweetnacl) and the REAL shared handshake primitives:
 *
 *   auth (eager pubkey)
 *     → auth_ok (serverPublicKey + serverKeySig + capabilities)
 *     → encrypted auth_bootstrap burst
 *     → encrypted history_replay_start / …entries… / history_replay_end
 *     → encrypted live delta
 *     → forced flush
 *
 * The crypto is NOT mocked: the fake server holds a real Ed25519 identity
 * keypair and a real X25519 exchange keypair, signs its exchange key with
 * `signExchangeKey`, and encrypts every post-handshake frame with
 * `encrypt(…, DIRECTION_SERVER)`. The client side runs the production decision
 * functions (`decideKeyPinWithPairingIdentity`, `deriveSharedKey`,
 * `deriveConnectionKey`, `decrypt`) and the production replay reconcile/dedup
 * helpers. Only the store WRITES are adapter-injected (per client).
 *
 * The two real clients differ only in their store shape + onmessage glue, so the
 * driver is shared and each client supplies a thin {@link HandshakeStoreAdapter}.
 */

import {
  createKeyPair,
  createSigningKeyPair,
  signExchangeKey,
  deriveSharedKey,
  deriveConnectionKey,
  generateConnectionSalt,
  encrypt,
  decrypt,
  DIRECTION_SERVER,
  DIRECTION_CLIENT,
  type EncryptedEnvelope,
  type KeyPair,
  type SigningKeyPair,
} from '../crypto'
import {
  decideKeyPinWithPairingIdentity,
  decodeEncryptionGate,
  type KeyPinDecision,
} from '../key-pinning'
import {
  resetReplayReconcile,
  recordHistorySeq,
  reconcileReplayStart,
  reconcileReplayEnd,
  replayDedupCache,
} from '../replay-reconcile'
import { isReplayDuplicate, type IncomingReplayEntry } from '../replay-dedup'
import type { ChatMessage } from '../types'

// ---------------------------------------------------------------------------
// Client store adapter — the per-client store surface the handshake touches
// ---------------------------------------------------------------------------

/**
 * A single replayed/live chat entry as the driver applies it to a session. The
 * real clients carry richer ChatMessage shapes; the driver only needs the
 * dedup-relevant fields plus an id to assert order. `type` is a plain string
 * here (not the ChatMessage union) because the driver only routes on the wire
 * value and the dedup helper accepts `messageType: string`.
 */
export interface DriverMessage {
  id: string
  type: string
  content?: string
  timestamp?: number
  tool?: string | null
}

/** A handshake phase, recorded in order so a test can assert the sequence. */
export type HandshakePhase =
  | 'auth-sent'
  | 'auth_ok'
  | 'key-derived'
  | 'auth_bootstrap'
  | 'replay-start'
  | 'replay-entry'
  | 'replay-end'
  | 'live-delta'
  | 'flush'
  | 'refused'

/**
 * The minimal client store the handshake driver writes to. Each client supplies
 * an implementation backed by its real store in the per-client suites; the
 * shared driver test uses the in-memory default ({@link makeMemoryStore}).
 */
export interface HandshakeStoreAdapter {
  /** Mark encryption active (post key-derivation). */
  activateEncryption(): void
  /** Append/replace the session's message list (replay + live). */
  setMessages(sessionId: string, messages: DriverMessage[]): void
  /** Read the session's current messages (for dedup + reconcile). */
  getMessages(sessionId: string): DriverMessage[]
  /** Store the auth_bootstrap burst payload. */
  applyBootstrap(payload: { providers: unknown[]; slashCommands: unknown[]; agents: unknown[] }): void
  /** Record a refusal (bad-sig / pinned-but-unsigned). */
  refuse(decision: Extract<KeyPinDecision, { action: 'refuse' }>): void
  /** Persist a pin-on-first-use identity. */
  pin(identityKey: string): void
}

// ---------------------------------------------------------------------------
// In-memory reference store (used by the shared driver test)
// ---------------------------------------------------------------------------

export interface MemoryStore extends HandshakeStoreAdapter {
  readonly state: {
    encryptionActive: boolean
    sessions: Record<string, DriverMessage[]>
    bootstrap: { providers: unknown[]; slashCommands: unknown[]; agents: unknown[] } | null
    refusal: Extract<KeyPinDecision, { action: 'refuse' }> | null
    pinnedIdentity: string | null
  }
}

export function makeMemoryStore(): MemoryStore {
  const state: MemoryStore['state'] = {
    encryptionActive: false,
    sessions: {},
    bootstrap: null,
    refusal: null,
    pinnedIdentity: null,
  }
  return {
    state,
    activateEncryption: () => {
      state.encryptionActive = true
    },
    setMessages: (sid, msgs) => {
      state.sessions[sid] = msgs
    },
    getMessages: (sid) => state.sessions[sid] ?? [],
    applyBootstrap: (payload) => {
      state.bootstrap = payload
    },
    refuse: (decision) => {
      state.refusal = decision
    },
    pin: (identityKey) => {
      state.pinnedIdentity = identityKey
    },
  }
}

// ---------------------------------------------------------------------------
// Fake server — holds the real keys + emits the wire frames
// ---------------------------------------------------------------------------

export interface FakeServerOptions {
  /** Omit the server identity signature (old daemon / downgrade simulation). */
  omitSignature?: boolean
  /** Sign with a DIFFERENT identity key than the one the client pinned (MITM). */
  forgeSignature?: boolean
}

export interface ReplayEntrySpec {
  sessionId: string
  message: DriverMessage
  historySeq: number
}

/**
 * Builds the server-side handshake frames. Holds a real identity keypair (the
 * public half is what a client pins) and a real per-connection exchange keypair.
 */
export class FakeHandshakeServer {
  readonly identity: SigningKeyPair
  /** A different identity used to forge a bad signature (MITM scenario). */
  private readonly forgedIdentity: SigningKeyPair
  readonly exchange: KeyPair
  readonly salt: string
  private sendNonce = 0
  private sharedKey: Uint8Array | null = null

  constructor(private readonly opts: FakeServerOptions = {}) {
    this.identity = createSigningKeyPair()
    this.forgedIdentity = createSigningKeyPair()
    this.exchange = createKeyPair()
    this.salt = generateConnectionSalt()
  }

  /** The identity public key the client should pin (out-of-band, at pairing). */
  get identityPublicKey(): string {
    return this.identity.publicKey
  }

  /** Derive the server's shared/connection key from the CLIENT's eager pubkey. */
  keyExchangeWithClient(clientPublicKey: string): void {
    const raw = deriveSharedKey(clientPublicKey, this.exchange.secretKey)
    this.sharedKey = deriveConnectionKey(raw, this.salt)
  }

  /** The auth_ok frame: serverPublicKey + serverKeySig + capabilities. */
  authOk(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const serverKeySig = this.opts.omitSignature
      ? null
      : signExchangeKey(
          this.exchange.publicKey,
          this.opts.forgeSignature ? this.forgedIdentity.secretKey : this.identity.secretKey,
        )
    return {
      type: 'auth_ok',
      serverPublicKey: this.exchange.publicKey,
      ...(serverKeySig ? { serverKeySig } : {}),
      salt: this.salt,
      encryption: 'required',
      capabilities: { authBootstrap: true },
      availablePermissionModes: [{ id: 'default', label: 'Default' }],
      ...extra,
    }
  }

  /** Encrypt a post-handshake frame with the derived key (DIRECTION_SERVER). */
  encryptFrame(payload: Record<string, unknown>): EncryptedEnvelope {
    if (!this.sharedKey) throw new Error('keyExchangeWithClient must run before encryptFrame')
    const env = encrypt(JSON.stringify(payload), this.sharedKey, this.sendNonce, DIRECTION_SERVER)
    this.sendNonce++
    return env
  }
}

// ---------------------------------------------------------------------------
// Client side — runs the production decision + decrypt + reconcile path
// ---------------------------------------------------------------------------

export interface HandshakeClientOptions {
  /** The identity key the client has already pinned for this connection, if any. */
  pinnedIdentityKey?: string | null
  /** The pairing-time identity captured from the QR/pairing code, if any. */
  pairingIdentityKey?: string | null
}

/**
 * The client-side handshake state machine. Mirrors the real onmessage decrypt
 * loop (parse → if encrypted, decrypt with recvNonce then advance) and routes
 * decrypted frames into the shared reconcile/dedup helpers + the store adapter.
 */
export class FakeHandshakeClient {
  readonly keyPair: KeyPair
  private sharedKey: Uint8Array | null = null
  private recvNonce = 0
  /** Send-side nonce for client→server frames — must advance per frame. */
  private sendNonce = 0
  /** Frames observed in plaintext AFTER encryption activated (must stay empty). */
  readonly plaintextAfterActivation: string[] = []
  readonly phases: HandshakePhase[] = []
  private encryptionActive = false

  constructor(
    private readonly store: HandshakeStoreAdapter,
    private readonly opts: HandshakeClientOptions = {},
  ) {
    // The reconcile/dedup helpers keep their cursor + rebuild baseline in
    // module-level state. A fresh `FakeHandshakeClient` models a brand-new
    // connection from a clean slate, so we deliberately clear BOTH here — this is
    // a test-isolation reset (every scenario constructs its own client), NOT the
    // production reconnect path, which retains cursors across reconnects and
    // clears them only on explicit disconnect. The scenarios that assert
    // cross-reconnect cursor behaviour seed it explicitly via `preSeed` + the
    // replay frames rather than relying on a leaked cursor from a prior test.
    resetReplayReconcile({ clearCursors: true })
    this.keyPair = createKeyPair()
  }

  /** Build the eager auth frame (carries our public key up-front). */
  sendAuth(): Record<string, unknown> {
    this.phases.push('auth-sent')
    return { type: 'auth', publicKey: this.keyPair.publicKey }
  }

  /**
   * Process the auth_ok frame: run the pin decision against the offered signed
   * exchange key, then (on connect) derive the shared key and activate
   * encryption. Returns the decision so a test can assert the refusal matrix.
   */
  handleAuthOk(authOk: Record<string, unknown>): KeyPinDecision {
    this.phases.push('auth_ok')
    const exchangePublicKey = authOk.serverPublicKey as string
    const serverKeySig = (authOk.serverKeySig as string | undefined) ?? null

    // #5614 — the plaintext-downgrade gate runs FIRST, exactly as production does
    // (before the encryption branch / pin check). A pinned connection whose
    // auth_ok is not encryption:'required' is refused here, so a MITM can't forge
    // a plaintext auth_ok to skip the pin check below. We read the field exactly
    // as production's parser would: an explicit value passes through; a field that
    // is truly ABSENT arrives as `null` (production's parseRawStringField maps a
    // missing/empty field to null), which is NOT 'required' and so is refused when
    // pinned — faithfully modelling the "MITM omits the field" downgrade shape
    // rather than papering over it with a 'required' default.
    const encryptionMode = (authOk.encryption as string | null | undefined) ?? null
    const gate = decodeEncryptionGate({
      pinnedIdentityKey: this.opts.pinnedIdentityKey ?? null,
      pairingIdentityKey: this.opts.pairingIdentityKey ?? null,
      encryptionMode,
    })
    if (gate.action === 'refuse') {
      this.phases.push('refused')
      this.store.refuse(gate)
      return gate
    }

    const decision = decideKeyPinWithPairingIdentity({
      pinnedIdentityKey: this.opts.pinnedIdentityKey ?? null,
      pairingIdentityKey: this.opts.pairingIdentityKey ?? null,
      exchangePublicKey,
      serverKeySig,
    })

    if (decision.action === 'refuse') {
      this.phases.push('refused')
      this.store.refuse(decision)
      return decision
    }

    if (decision.action === 'pin-and-connect') {
      this.store.pin(decision.identityKey)
    }

    // Derive the shared key from the server's exchange key + our eager secret.
    const raw = deriveSharedKey(exchangePublicKey, this.keyPair.secretKey)
    this.sharedKey = deriveConnectionKey(raw, authOk.salt as string)
    this.encryptionActive = true
    this.store.activateEncryption()
    this.phases.push('key-derived')
    return decision
  }

  /**
   * The real onmessage decrypt step: an `encrypted` envelope is decrypted with
   * the current recvNonce, which is then advanced. A plaintext frame arriving
   * after activation is recorded as a contract violation.
   */
  receive(frame: EncryptedEnvelope | Record<string, unknown>): Record<string, unknown> | null {
    if ((frame as { type?: unknown }).type === 'encrypted') {
      if (!this.sharedKey) throw new Error('received encrypted frame before key derivation')
      const decrypted = decrypt(
        frame as EncryptedEnvelope,
        this.sharedKey,
        this.recvNonce,
        DIRECTION_SERVER,
      )
      this.recvNonce++
      this.route(decrypted)
      return decrypted
    }
    // Plaintext frame. Allowed only BEFORE activation (auth_ok). After, it's a
    // contract violation (the server must encrypt once keyed).
    if (this.encryptionActive) {
      this.plaintextAfterActivation.push(String((frame as { type?: unknown }).type))
    }
    this.route(frame as Record<string, unknown>)
    return frame as Record<string, unknown>
  }

  /** Route a decrypted frame into the reconcile/dedup helpers + store. */
  private route(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'auth_bootstrap': {
        this.phases.push('auth_bootstrap')
        this.store.applyBootstrap({
          providers: (msg.providers as unknown[]) ?? [],
          slashCommands: (msg.slashCommands as unknown[]) ?? [],
          agents: (msg.agents as unknown[]) ?? [],
        })
        break
      }
      case 'history_replay_start': {
        this.phases.push('replay-start')
        const sid = msg.sessionId as string
        const current = this.store.getMessages(sid)
        reconcileReplayStart(sid, !!msg.fullHistory, current.length, msg.latestSeq)
        break
      }
      case 'history_replay_entry': {
        this.phases.push('replay-entry')
        const sid = msg.sessionId as string
        const entry = msg.entry as DriverMessage
        const current = this.store.getMessages(sid)
        // Dedup the replayed entry against the correct cache window (#5555.4):
        // during a full rebuild only the appended tail, else the whole array.
        const cache = replayDedupCache(sid, current) as ChatMessage[]
        const dupCheck: IncomingReplayEntry = {
          messageType: entry.type,
          messageId: entry.id,
          content: entry.content,
        }
        if (!isReplayDuplicate(cache, dupCheck)) {
          this.store.setMessages(sid, [...current, entry])
        }
        if (typeof msg.historySeq === 'number') recordHistorySeq(sid, msg.historySeq)
        break
      }
      case 'history_replay_end': {
        this.phases.push('replay-end')
        const sid = msg.sessionId as string
        const current = this.store.getMessages(sid)
        const { swappedMessages } = reconcileReplayEnd(sid, current, msg.latestSeq)
        if (swappedMessages) this.store.setMessages(sid, swappedMessages as DriverMessage[])
        break
      }
      case 'stream_delta':
      case 'live_message': {
        this.phases.push('live-delta')
        const sid = msg.sessionId as string
        const entry = msg.entry as DriverMessage
        const current = this.store.getMessages(sid)
        // Live entries dedup against the WHOLE array (a live frame is never part
        // of a rebuild tail). This is the replay-vs-live boundary: a live entry
        // whose id already arrived during replay must not double-append.
        if (!isReplayDuplicate(current as ChatMessage[], {
          messageType: entry.type,
          messageId: entry.id,
          content: entry.content,
        })) {
          this.store.setMessages(sid, [...current, entry])
        }
        break
      }
      case 'flush': {
        this.phases.push('flush')
        break
      }
      default:
        break
    }
  }

  /**
   * A test helper: encrypt a CLIENT→server frame (to assert no-plaintext-out).
   * Advances `sendNonce` per call so repeated frames never reuse a
   * (key, nonce, direction) tuple — the same nonce contract the real client's
   * `wsSend` honours.
   */
  encryptClientFrame(payload: Record<string, unknown>): EncryptedEnvelope {
    if (!this.sharedKey) throw new Error('cannot encrypt before key derivation')
    const env = encrypt(JSON.stringify(payload), this.sharedKey, this.sendNonce, DIRECTION_CLIENT)
    this.sendNonce++
    return env
  }
}
