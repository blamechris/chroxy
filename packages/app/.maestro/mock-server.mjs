/**
 * Lightweight mock WebSocket server for Maestro E2E tests.
 * Speaks enough of the Chroxy protocol to land on SessionScreen.
 *
 * Usage: node mock-server.mjs [--port 9876]
 */

import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'
const { encodeBase64, decodeBase64 } = naclUtil

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '9876', 10)
const API_TOKEN = 'test-token-maestro'
// #6019: opt-in token that steers a connection onto the encrypted handshake.
const ENCRYPTED_TOKEN = 'test-token-maestro-encrypted'
let seqCounter = 0
// #4201: per-trigger counter so repeated `show-todos` inputs don't collide
// on a single fixed id (which would cause React-key duplicates + stuck
// pending tool_use rows because tool_result only patches the first match).
let showTodosCounter = 0
// #4260: per-trigger counter for the partial-summary fixture mirrors
// the same pattern used by `show-todos` — repeated invocations need
// unique ids so React keys + tool_result patching stay independent.
let showBashPartialCounter = 0
// #4697: per-trigger counter for the AskUserQuestion fixtures. Same
// rationale as `show-todos` / `show-bash-partial` — repeated
// invocations on the same session need unique toolUseIds so the
// app's user_question handler doesn't collide on a fixed id.
let showAskUserQuestionCounter = 0

// #5468: connection counter — incremented once per `auth` message, used only
// for the marker's text ("mock reconnect #N") + the [mock] Auth #N log line.
let connectionCounter = 0
// #5468: marker gate. The app reconnects incidentally during dev-client setup
// (auth #1 → drop → auth #2) BEFORE the flow sends `simulate-disconnect`, so a
// plain "counter ≥ 2" gate would emit the marker from that setup churn and the
// RED test (ws.terminate() commented out) would still pass vacuously. Instead
// we arm this flag ONLY when `simulate-disconnect` is received, and emit the
// marker on the next auth — so the marker is reachable ONLY via a genuine
// deliberate drop + reconnect. With the drop disabled there is no reconnect,
// the flag stays consumed/unset, and reconnect.yaml fails at the assertion.
let sawSimulateDisconnect = false

// #5699: timed reconnect-hold. `simulate-disconnect-hold` drops the socket AND
// makes the HTTP health endpoint return 503 for RECONNECT_HOLD_MS, so the app's
// pre-WS health check keeps failing and the reconnect ladder stays in the
// `reconnecting` phase — a STABLE disconnected window the
// permission-disconnected-noop flow can assert against. The plain
// `simulate-disconnect` window is ~1s (the mock health stays 200, so the app
// re-dials almost immediately — see reconnect.yaml's "~1-in-3 catch rate"
// note), too racy to tap a button inside. The hold self-releases (health 200
// again) well before the ladder's 10-rung give-up (~59s → terminal
// server_down), so the app auto-reconnects and the flow leaves the app usable
// for the next run-all flow. reconnectHoldUntil is an absolute epoch-ms
// deadline; 0 means "no hold active".
const RECONNECT_HOLD_MS = 10000
let reconnectHoldUntil = 0

// #5469: per-connection counter for `show-stream-stall` hits.
// On the SECOND trigger (within the same connection) the mock emits the
// stall error with a distinguishable detail ("stall re-emission #2") and
// an additional assistant message ("retry-received"). stream-stall-chip.yaml
// hard-asserts that marker after tapping Retry, so a broken
// onRetryStreamStall → sendInput wiring fails the flow instead of passing
// vacuously because the first chip already satisfies the `id: stream-stall-chip`
// extendedWaitUntil.
let showStreamStallCounter = 0

// #6019: E2E key_exchange / eager-handshake support.
//
// The mock server maintains an ephemeral X25519 keypair per process (not
// per connection — the Maestro flow doesn't test key rotation, only the
// basic handshake path). On receiving a `key_exchange` message from the
// client it derives the shared key using DH, sends `key_exchange_ok`, and
// wraps all subsequent outbound messages in the `{ type:'encrypted', d, n }`
// envelope the app's `case 'encrypted'` handler decrypts. Because the mock
// starts the encrypted session with a fixed `sendNonce = 0` and increments
// it on every frame, the app's nonce-equality guard is satisfied.
//
// Crypto primitives mirror the store-core crypto.ts implementation:
//   - X25519 DH via nacl.box.before
//   - XSalsa20-Poly1305 secretbox via nacl.secretbox / nacl.secretbox.open
//   - Nonce: [direction_byte, counter_LE_8bytes, ...15_zero_bytes]
//   - Connection sub-key: SHA-512(sharedKey ∥ saltBytes)[0:32]
//   - Direction: 0x00 = server→client, 0x01 = client→server

const NONCE_LENGTH = 24
const DIRECTION_SERVER = 0x00
const DIRECTION_CLIENT = 0x01
const CONNECTION_SALT_BYTES = 32

// Generate a static server keypair for this process lifetime. A real server
// persists this as its identity keypair; for the mock we regenerate on restart,
// which is fine — the Maestro flow doesn't test pinning.
const SERVER_KEYPAIR = nacl.box.keyPair()
const SERVER_PUBLIC_KEY_B64 = encodeBase64(SERVER_KEYPAIR.publicKey)

/**
 * Build a 24-byte nonce matching store-core crypto.ts nonceFromCounter:
 *   byte 0: direction (0x00 = server, 0x01 = client)
 *   bytes 1-8: counter little-endian
 *   bytes 9-23: zero-padded
 */
function nonceFromCounter(n, direction) {
  const nonce = new Uint8Array(NONCE_LENGTH)
  nonce[0] = direction
  let val = n
  for (let i = 1; i <= 8; i++) {
    nonce[i] = val & 0xff
    val = Math.floor(val / 256)
  }
  return nonce
}

/**
 * Derive the per-connection sub-key: SHA-512(sharedKey ∥ saltBytes)[0:32].
 * Matches store-core deriveConnectionKey exactly.
 */
function deriveConnectionKey(sharedKey, saltBase64) {
  const saltBytes = decodeBase64(saltBase64)
  const input = new Uint8Array(sharedKey.length + saltBytes.length)
  input.set(sharedKey, 0)
  input.set(saltBytes, sharedKey.length)
  const hash = nacl.hash(input)
  return hash.slice(0, nacl.secretbox.keyLength)
}

/**
 * Encrypt a JSON payload using XSalsa20-Poly1305 for the encrypted session.
 * Returns the `{ type:'encrypted', d, n }` wire envelope.
 */
function encryptFrame(payload, sharedKey, nonceCounter) {
  const nonce = nonceFromCounter(nonceCounter, DIRECTION_SERVER)
  const messageBytes = new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8'))
  const ciphertext = nacl.secretbox(messageBytes, new Uint8Array(nonce), new Uint8Array(sharedKey))
  return {
    type: 'encrypted',
    d: encodeBase64(ciphertext),
    n: nonceCounter,
  }
}

function send(ws, msg) {
  seqCounter++
  ws.send(JSON.stringify({ ...msg, seq: seqCounter }))
}

const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    // #5699: while a reconnect-hold is active, fail health so the app's pre-WS
    // health check keeps the reconnect ladder in `reconnecting` (stable
    // disconnected window for permission-disconnected-noop.yaml).
    if (Date.now() < reconnectHoldUntil) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'down', reason: 'reconnect-hold' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', mode: 'cli', hostname: 'mock-server', version: '0.1.0-test' }))
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ noServer: true })

httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', (ws) => {
  console.log('[mock] Client connected')
  seqCounter = 0
  showStreamStallCounter = 0

  // Per-connection encryption state. Populated after key_exchange handshake.
  let encryptedSession = null  // { sharedKey: Uint8Array, sendNonce: number, recvNonce: number }

  /**
   * Send a message: if an encrypted session is active, wrap in the encrypted
   * envelope; otherwise send plaintext. This mirrors the post-handshake
   * behaviour of the production ws-server.js.
   */
  function secureSend(ws, msg) {
    seqCounter++
    if (encryptedSession) {
      const envelope = encryptFrame({ ...msg, seq: seqCounter }, encryptedSession.sharedKey, encryptedSession.sendNonce)
      encryptedSession.sendNonce++
      ws.send(JSON.stringify(envelope))
    } else {
      ws.send(JSON.stringify({ ...msg, seq: seqCounter }))
    }
  }

  ws.on('message', (raw) => {
    let msg
    try {
      // #6019: if an encrypted session is active, each inbound message is an
      // `{ type:'encrypted', d, n }` envelope — decrypt it first. The client
      // uses DIRECTION_CLIENT nonces; the server uses DIRECTION_SERVER nonces
      // (both per store-core crypto.ts direction constants).
      const parsed = JSON.parse(raw.toString())
      if (encryptedSession && parsed.type === 'encrypted') {
        // #6019: decrypt with the wire nonce the client stamped (`parsed.n`),
        // matching store-core's contract (the client's send counter), rather
        // than blindly trusting our local recvNonce. Validate monotonicity so a
        // replayed/out-of-order frame is rejected like production does.
        const clientNonceCounter = typeof parsed.n === 'number' ? parsed.n : encryptedSession.recvNonce
        if (clientNonceCounter !== encryptedSession.recvNonce) {
          console.error(`[mock] Nonce mismatch — expected ${encryptedSession.recvNonce}, got ${clientNonceCounter}`)
          return
        }
        const nonce = nonceFromCounter(clientNonceCounter, DIRECTION_CLIENT)
        const ciphertext = new Uint8Array(decodeBase64(parsed.d))
        const plaintext = nacl.secretbox.open(ciphertext, new Uint8Array(nonce), new Uint8Array(encryptedSession.sharedKey))
        if (!plaintext) {
          console.error('[mock] Decryption failed — MAC mismatch or wrong key')
          return
        }
        encryptedSession.recvNonce++
        msg = JSON.parse(Buffer.from(plaintext).toString('utf8'))
      } else {
        msg = parsed
      }
    } catch {
      return
    }

    switch (msg.type) {
      case 'auth': {
        // #6019: accept the encryption opt-in token too. A client connecting
        // with `test-token-maestro-encrypted` is steered onto the
        // encryption:'required' handshake path below; the standard token keeps
        // encryption disabled so all other flows are unaffected.
        if (msg.token !== API_TOKEN && msg.token !== ENCRYPTED_TOKEN) {
          send(ws, { type: 'auth_fail', reason: 'invalid token' })
          ws.close()
          return
        }

        // #5468: increment the per-process connection counter. The mock server
        // is NOT restarted between flows in run-all.yaml, so the counter
        // monotonically tracks total auth completions in this server process.
        connectionCounter++
        console.log(`[mock] Auth #${connectionCounter}`)

        // #6019: check for eager key exchange fields sent alongside auth.
        // The app sends `{ ..., eagerPublicKey, eagerSalt }` in its `auth`
        // message when it has pre-generated an ephemeral keypair (onopen →
        // prepareEagerKeyExchange). If present, the server performs the DH
        // NOW and includes its own public key in `auth_ok.serverPublicKey`,
        // allowing the client to derive the shared key without a
        // key_exchange round trip.
        //
        // The mock supports BOTH eager and discrete handshake:
        //   - Eager: client sends eagerPublicKey+eagerSalt → server echoes
        //     serverPublicKey in auth_ok → client derives key immediately.
        //   - Discrete: client sends no eager fields → auth_ok has
        //     encryption:'required' + no serverPublicKey → client sends
        //     key_exchange → server replies key_exchange_ok → shared key derived.
        //
        // For the key-exchange E2E flow we always advertise
        // encryption:'required' so that the app is forced through the
        // cryptographic handshake path. Flows that don't set the token to
        // 'test-token-maestro-encrypted' keep the existing 'disabled' path
        // so all other flows are unaffected.
        //
        // NOTE (assumption for on-device verification): the app generates its
        // eager keypair in socket.onopen before sending auth, so eagerPublicKey
        // is expected to be present. If the on-device run shows the mock
        // sending key_exchange_ok but the app timing out, it's likely the app
        // is not sending eagerPublicKey — check the discrete fallback path in
        // the app (which sends a standalone `key_exchange` message) and ensure
        // the mock's `case 'key_exchange'` handler below resolves it.
        const useEncryption = (msg.token === ENCRYPTED_TOKEN)

        let eagerSharedKey = null
        let eagerServerPublicKey = null

        // #6019: production honors the eager path only when BOTH eagerPublicKey
        // AND eagerSalt are present (ws-auth.js). Require both here too —
        // deriving without the salt would produce a key the app never computes.
        if (useEncryption && msg.eagerPublicKey && msg.eagerSalt) {
          // Derive the shared key from the client's eager public key and our
          // secret. This mirrors ws-server.js key exchange logic.
          try {
            const clientPub = decodeBase64(msg.eagerPublicKey)
            const rawShared = nacl.box.before(clientPub, SERVER_KEYPAIR.secretKey)
            eagerSharedKey = deriveConnectionKey(rawShared, msg.eagerSalt)
            eagerServerPublicKey = SERVER_PUBLIC_KEY_B64
            console.log('[mock] Eager key exchange — shared key derived')
          } catch (err) {
            console.warn('[mock] Eager key derivation failed:', err.message)
            eagerSharedKey = null
          }
        }

        // Build the auth_ok payload. For encrypted sessions include the
        // server's public key so the client can perform eager derivation.
        // NOTE: the mock does NOT supply a real `serverKeySig` (Ed25519
        // identity signature over the exchange key). The app only enforces
        // signature verification when a pin is already stored for this server
        // URL. In the Maestro flow clearState:true wipes SecureStore on every
        // run, so the connection is always unpinned and the signature check is
        // skipped (TOFU — Trust On First Use). If a future flow intentionally
        // tests pinned-identity verification, the mock will need a real Ed25519
        // signing keypair.
        send(ws, {
          type: 'auth_ok',
          clientId: 'mock-client-1',
          serverMode: 'cli',
          serverVersion: '0.1.0-test',
          latestVersion: null,
          serverCommit: 'abc1234',
          cwd: '/tmp/mock-project',
          connectedClients: [],
          encryption: useEncryption ? 'required' : 'disabled',
          ...(eagerServerPublicKey ? { serverPublicKey: eagerServerPublicKey, serverKeySig: null } : {}),
        })

        if (eagerSharedKey) {
          // Encryption is now active — post-auth burst uses secureSend.
          encryptedSession = { sharedKey: eagerSharedKey, sendNonce: 0, recvNonce: 0 }
          console.log('[mock] Encrypted session started (eager)')
        } else if (useEncryption) {
          // Discrete path: wait for key_exchange from the client before
          // sending the post-auth burst. The `case 'key_exchange'` handler
          // below sets up encryptedSession and then calls the burst.
          console.log('[mock] Waiting for discrete key_exchange from client')
          break
        }

        // Send the post-auth burst (for non-encrypted sessions or after
        // the eager handshake established encryption).
        sendPostAuthBurst(ws, secureSend)

        // #5468: emit the reconnect marker only on the reconnect that FOLLOWS a
        // deliberate `simulate-disconnect` (see `sawSimulateDisconnect`). Sent
        // via secureSend so it lands in the correct session (encrypted or not).
        // NOTE: emitted as `messageType: 'response'` (a Chat-tab bubble), NOT
        // 'system' — buildChatViewMessages filters `type: 'system'` OFF the Chat
        // tab (they live on the System tab), so a system marker is invisible to
        // reconnect.yaml which asserts on Chat.
        if (sawSimulateDisconnect) {
          sawSimulateDisconnect = false
          secureSend(ws, {
            type: 'message',
            messageType: 'response',
            content: `mock reconnect #${connectionCounter}`,
            timestamp: Date.now(),
            sessionId: 'mock-sess-1',
          })
        }
        break
      }

      // #6019: discrete key_exchange — client sends its ephemeral X25519
      // public key after auth_ok (when eager path was not used or the eager
      // derivation failed on the client). The server DH-exchanges, derives the
      // shared key, replies with key_exchange_ok carrying the server's public
      // key, then emits the post-auth burst encrypted.
      case 'key_exchange': {
        if (!msg.publicKey) {
          console.error('[mock] key_exchange missing publicKey')
          ws.close()
          break
        }
        try {
          const clientPub = decodeBase64(msg.publicKey)
          const rawShared = nacl.box.before(clientPub, SERVER_KEYPAIR.secretKey)
          const sharedKey = msg.salt
            ? deriveConnectionKey(rawShared, msg.salt)
            : new Uint8Array(rawShared)
          // Reply PLAINTEXT — encryption activates after this frame, for
          // subsequent messages (mirrors production ws-server.js behaviour).
          send(ws, {
            type: 'key_exchange_ok',
            publicKey: SERVER_PUBLIC_KEY_B64,
            // No serverKeySig — see note in auth handler above.
            serverKeySig: null,
          })
          encryptedSession = { sharedKey, sendNonce: 0, recvNonce: 0 }
          console.log('[mock] Encrypted session started (discrete key_exchange)')
          // Now send the post-auth burst encrypted.
          sendPostAuthBurst(ws, secureSend)
          if (sawSimulateDisconnect) {
            sawSimulateDisconnect = false
            // Chat-tab bubble (see note on the eager-path marker above) — not
            // 'system', which is filtered off the Chat tab.
            secureSend(ws, {
              type: 'message',
              messageType: 'response',
              content: `mock reconnect #${connectionCounter}`,
              timestamp: Date.now(),
              sessionId: 'mock-sess-1',
            })
          }
        } catch (err) {
          console.error('[mock] key_exchange DH failed:', err.message)
          ws.close()
        }
        break
      }

      case 'mode':
        // Acknowledge mode switch
        console.log(`[mock] Client mode: ${msg.mode}`)
        break

      case 'list_slash_commands':
        secureSend(ws, { type: 'slash_commands', commands: [] })
        break

      case 'list_agents':
        secureSend(ws, { type: 'agent_list', agents: [] })
        break

      case 'ping':
        secureSend(ws, { type: 'pong' })
        break

      case 'browse_files': {
        const requestedPath = msg.path || null
        // Treat an explicit request for the project root the same as no path:
        // FileBrowser's navigateUp sends the parentPath ('/tmp/mock-project'),
        // so Back from a subdirectory must resolve to the root listing —
        // otherwise it falls into the empty-listing fallback and the
        // session-file-browser flow's post-Back package.json assert fails.
        if (!requestedPath || requestedPath === '/tmp/mock-project') {
          // Root directory
          secureSend(ws, {
            type: 'file_listing',
            path: '/tmp/mock-project',
            parentPath: null,
            entries: [
              { name: 'src', isDirectory: true, size: null },
              { name: 'docs', isDirectory: true, size: null },
              { name: 'package.json', isDirectory: false, size: 1234 },
              { name: 'README.md', isDirectory: false, size: 567 },
            ],
            error: null,
          })
        } else if (requestedPath === 'src' || requestedPath.endsWith('/src')) {
          secureSend(ws, {
            type: 'file_listing',
            path: '/tmp/mock-project/src',
            parentPath: '/tmp/mock-project',
            entries: [
              { name: 'index.js', isDirectory: false, size: 2048 },
              { name: 'utils.js', isDirectory: false, size: 512 },
            ],
            error: null,
          })
        } else {
          secureSend(ws, {
            type: 'file_listing',
            path: requestedPath,
            parentPath: '/tmp/mock-project',
            entries: [],
            error: null,
          })
        }
        break
      }

      case 'read_file':
        secureSend(ws, {
          type: 'file_content',
          path: msg.path,
          content: '// Mock file content\nconsole.log("Hello from mock server")\n',
          language: 'javascript',
          size: 58,
          truncated: false,
          error: null,
        })
        break

      // #6800 follow-up: the DiffViewer requests `get_diff` when the Changes
      // viewer opens; answer with a small canned diff so the Maestro
      // diff-comment flow can exercise the inline-comment path (tap a line →
      // comment → submit) end-to-end. Mirrors the production wire shape — a
      // PTY/SDK server replies with a `diff_result` carrying validated
      // DiffFile[] (see packages/store-core/src/handlers/git.ts handleDiffResult
      // + isDiffFile; malformed elements are dropped fail-soft). One modified
      // file with a single hunk (context / deletion / addition / addition /
      // context) is enough to render the `diff-line-<i>` touch targets the flow
      // taps, and its `deriveLineNumber` values match the dashboard fixture so
      // the composed prompt is byte-identical across clients.
      case 'get_diff':
        secureSend(ws, {
          type: 'diff_result',
          sessionId: 'mock-sess-1',
          files: [
            {
              path: 'src/utils/helper.ts',
              status: 'modified',
              additions: 2,
              deletions: 1,
              hunks: [
                {
                  header: '@@ -10,5 +10,6 @@',
                  lines: [
                    { type: 'context', content: 'const x = 1' },
                    { type: 'deletion', content: 'const y = 2' },
                    { type: 'addition', content: 'const y = 3' },
                    { type: 'addition', content: 'const z = 4' },
                    { type: 'context', content: 'export { x }' },
                  ],
                },
              ],
            },
          ],
          error: null,
        })
        break

      case 'input': {
        const text = msg.data || ''
        console.log(`[mock] Input: "${text}"`)

        // #4701: trigger phrase 'show-terminal' emits a synthetic `raw`
        // terminal-data envelope so the Maestro `terminal-view.yaml`
        // flow can exercise the TerminalView WebView render on a real
        // simulator. Mirrors the production wire shape — PTY-mode
        // servers stream PTY output as `{ type: 'raw', data: '...' }`
        // (see packages/server/src/ws-server.js terminal forwarding +
        // packages/app/src/store/message-handler.ts `case 'raw'`).
        // The handler calls `appendTerminalData(data)` which both
        // updates `terminalRawBuffer` and forwards to the WebView via
        // the `terminalWrite` imperative callback wired in
        // SessionScreen.useEffect when `viewMode === 'terminal'`.
        // We emit ANSI escape colors so the output is visually
        // distinguishable in screenshots without polluting the
        // `assertVisible` text comparison done downstream — Maestro's
        // matcher reads accessibility text, not pixel content, and
        // the WebView's xterm.js layer isn't introspectable anyway,
        // so the test only asserts the `terminal-view` testID is
        // present (the render path itself is what we're pinning).
        if (text.trim() === 'show-terminal') {
          // Trip a CR + carriage return so xterm renders cleanly,
          // then a styled line + reset.
          secureSend(ws, {
            type: 'raw',
            sessionId: 'mock-sess-1',
            data: '\r\n\x1b[32mmaestro-terminal-fixture\x1b[0m\r\n$ ',
          })
          break
        }

        // #4701: trigger phrase 'simulate-disconnect' abruptly tears
        // down the WebSocket from the server side after a 1s delay so
        // the Maestro `reconnect.yaml` flow can exercise the
        // ConnectionPhase `connected → reconnecting → connected`
        // transition on a real RN runtime. Production scenario —
        // Cloudflare tunnel drops + the client auto-reconnects via
        // `AUTO_RECONNECT_DELAY` (see packages/app/src/store/
        // connection.ts socket.onclose). The 1s delay gives the
        // client time to ack the input before the close lands, and
        // mirrors the production case where the server is still
        // processing the in-flight request when the tunnel drops.
        //
        // Use `ws.terminate()` (not `ws.close(1006, ...)`) — close code
        // 1006 is reserved by RFC 6455 and must not be sent in a Close
        // frame; the `ws` library throws on it (which we'd swallow via
        // the try/catch, leaving the socket open and the flow
        // hanging). `terminate()` rips the TCP socket without a Close
        // frame, which is exactly what an abrupt tunnel drop looks
        // like — the client observes a 1006 close code locally.
        if (text.trim() === 'simulate-disconnect') {
          // #5468: arm the marker for the reconnect that follows the drop. Set
          // it here (not inside the timeout) so it's armed regardless of timing.
          sawSimulateDisconnect = true
          setTimeout(() => {
            console.log('[mock] simulate-disconnect — terminating WS')
            try { ws.terminate() } catch {}
          }, 1000)
          break
        }

        // #5699: like simulate-disconnect, but ALSO holds the HTTP health
        // endpoint down (503) for RECONNECT_HOLD_MS so the reconnect ladder
        // can't re-dial immediately — a stable disconnected window the
        // permission-disconnected-noop flow taps a permission button inside.
        // The hold self-releases so the app auto-reconnects afterwards.
        if (text.trim() === 'simulate-disconnect-hold') {
          reconnectHoldUntil = Date.now() + RECONNECT_HOLD_MS
          setTimeout(() => {
            console.log(
              `[mock] simulate-disconnect-hold — terminating WS; health 503 for ${RECONNECT_HOLD_MS}ms`,
            )
            try { ws.terminate() } catch {}
          }, 1000)
          break
        }

        // #4507 / #5469: trigger phrase 'show-stream-stall' emits a recoverable
        // `error{code:'stream_stall'}` so the Maestro stream-stall-chip
        // flow can exercise the StreamStallChip render + retry path on
        // a real simulator. Mirrors the production wire shape — see
        // packages/server/src/event-normalizer.js `error:` builder, which
        // wraps the emitter's `{ message, code }` into the
        // `{ type: 'message', messageType: 'error', content, code,
        // timestamp }` envelope clients consume via
        // store-core/handlers/index.ts handleMessage. Once dispatched,
        // ChatView's chip-routing in MessageBubble.tsx (#4496) lights up
        // `StreamStallChip` because `msg.code === 'stream_stall'`, and
        // because this is the tail message of the conversation
        // ChatView wires `onRetryStreamStall` to resend the prior
        // user_input — i.e. tapping Retry pumps the *previous* user
        // input back through `sendInput`, which adds a local
        // optimistic user_input bubble and (here) loops back into this
        // input handler. We deliberately do NOT emit any `agent_busy`
        // or `stream_start` for the stall — the server's
        // `_handleStreamStall` clears busy state via
        // `_emitInterruptedTurnResult` and then emits the error, so the
        // chip lands while the session is idle (retry-able).
        //
        // #5469: track per-connection hits. On the SECOND hit, emit an
        // additional detail string ("stall re-emission #2") and a
        // follow-up assistant message ("retry-received") so the flow can
        // hard-assert that tapping Retry actually caused a resend. Without
        // this marker the post-Retry assert passes vacuously because the
        // FIRST chip (emitted before Retry was tapped) already satisfies
        // `id: stream-stall-chip`.
        if (text.trim() === 'show-stream-stall') {
          showStreamStallCounter++
          const isReEmission = showStreamStallCounter >= 2
          secureSend(ws, {
            type: 'message',
            messageType: 'error',
            content: isReEmission
              ? 'Stream stalled — no response for 5 minutes. Try sending again. (stall re-emission #2)'
              : 'Stream stalled — no response for 5 minutes. Try sending again.',
            code: 'stream_stall',
            timestamp: Date.now(),
            sessionId: 'mock-sess-1',
          })
          if (isReEmission) {
            // Emit a normal assistant message that the flow can hard-assert
            // as proof that the retry wire round-tripped. testID for this
            // assistant bubble: the stream_start/delta/stream_end triple
            // produces a `response` ChatMessage which renders in ChatView
            // as a regular message bubble — Maestro can assert on its text.
            const retryMsgId = `msg-retry-marker-${Date.now()}`
            secureSend(ws, { type: 'stream_start', messageId: retryMsgId, sessionId: 'mock-sess-1' })
            secureSend(ws, { type: 'stream_delta', messageId: retryMsgId, delta: 'retry-received', sessionId: 'mock-sess-1' })
            secureSend(ws, { type: 'stream_end', messageId: retryMsgId, sessionId: 'mock-sess-1' })
            secureSend(ws, { type: 'result', cost: 0.001, duration: 100, usage: {}, sessionId: 'mock-sess-1' })
            secureSend(ws, { type: 'agent_idle', sessionId: 'mock-sess-1' })
          }
          break
        }

        // #4195: trigger-phrase 'show-todos' emits a synthetic TodoWrite
        // tool_use + tool_result so the Maestro chat-todolist flow can
        // exercise the structured TodoList renderer end-to-end. This
        // uses the existing WS protocol (no app-side debug menu needed)
        // — same path production tool messages take, so the test pins
        // the real render path. Future structured renderers can add a
        // sibling trigger here (e.g. 'show-readlines' for the planned
        // tool_input_delta work in #4081).
        //
        // Tool-only turn — no stream_start/stream_delta/stream_end pair.
        // Pre-#4195-Copilot-fix this branch wrapped the tool events with
        // a stream_start/stream_end on a SEPARATE messageId from the
        // tool_start's, which left a phantom empty assistant bubble in
        // the chat history (the stream_start handler creates an empty
        // `response` ChatMessage regardless of subsequent content). Real
        // tool-only turns from the server elide stream_* entirely.
        if (text.trim() === 'show-todos') {
          secureSend(ws, { type: 'agent_busy', sessionId: 'mock-sess-1' })
          // #4201: ids are stable within the test but unique per trigger
          // so repeated `show-todos` invocations don't collide on React
          // keys (handleToolStart appends, doesn't replace, outside
          // history replay) and tool_result patches each tool_use
          // independently. Maestro's selector uses the "tool-todowrite-mock-"
          // prefix with a regex so it still matches the latest entry.
          showTodosCounter += 1
          const toolUseId = `tu-todowrite-mock-${showTodosCounter}`
          const toolMessageId = `tool-todowrite-mock-${showTodosCounter}`
          secureSend(ws, {
            type: 'tool_start',
            sessionId: 'mock-sess-1',
            tool: 'TodoWrite',
            input: { todos: [
              { id: 't1', content: 'Wrote helper', status: 'completed' },
              { id: 't2', content: 'Running tests', status: 'in_progress' },
              { id: 't3', content: 'Address review', status: 'pending' },
            ] },
            messageId: toolMessageId,
            toolUseId,
          })
          // Canonical TodoWrite executor format from
          // packages/server/src/byok-tool-executor.js runTodoWrite —
          // see #4179 / #4194 (mobile renderer). Matched by
          // packages/app/src/components/chat/TodoList.tsx parseTodoList.
          const todoResult = [
            'Todo list (3 items): 1 in progress, 1 pending, 1 completed',
            '  [x] Wrote helper (t1)',
            '  [~] Running tests (t2)',
            '  [ ] Address review (t3)',
          ].join('\n')
          secureSend(ws, {
            type: 'tool_result',
            sessionId: 'mock-sess-1',
            toolUseId,
            result: todoResult,
          })
          secureSend(ws, { type: 'result', cost: 0.001, duration: 100, usage: {}, sessionId: 'mock-sess-1' })
          secureSend(ws, { type: 'agent_idle', sessionId: 'mock-sess-1' })
          break
        }

        // #4260: trigger phrase 'show-bash-partial' emits a streaming
        // Bash `tool_use` with a `toolInputPartial` that exercises the
        // mobile ToolBubble's #4243 field-priority extraction path on
        // the real RN runtime. The collapsed bubble should surface the
        // extracted `command` ("ls -la /tmp") rather than the truncated
        // raw JSON ("{"command":"ls -la /t...").
        //
        // Mirrors the production wire path: `tool_start` carries the
        // placeholder content (tool name) while `input` is empty, and
        // the in-flight buffer is shipped via `tool_input_delta` chunks
        // — see store-core/handlers/index.ts handleToolInputDelta which
        // appends each `partialJson` onto `toolInputPartial`. Once the
        // accumulated buffer reaches a parseable `}` the bubble's
        // `getPartialSummary` flips from raw-JSON-slice to the extracted
        // field. No `tool_result` is emitted — we want the bubble to
        // stay in the streaming-collapsed state for the assertion.
        if (text.trim() === 'show-bash-partial') {
          secureSend(ws, { type: 'agent_busy', sessionId: 'mock-sess-1' })
          showBashPartialCounter += 1
          const toolUseId = `tu-bash-partial-mock-${showBashPartialCounter}`
          const toolMessageId = `tool-bash-partial-mock-${showBashPartialCounter}`
          secureSend(ws, {
            type: 'tool_start',
            sessionId: 'mock-sess-1',
            tool: 'Bash',
            // Empty input — handleToolStart falls back to `content = tool`,
            // which is the placeholder state the #4243 partial-priority
            // path is meant to override.
            input: {},
            messageId: toolMessageId,
            toolUseId,
          })
          // Stream the JSON in chunks. The accumulator concatenates each
          // `partialJson` onto `toolInputPartial`. The final chunk closes
          // the brace, making the buffer parseable for
          // `getPartialSummary`. Mid-stream chunks remain unparseable —
          // that's expected and is handled by `tryParseCompleteJson`'s
          // parseability gate.
          const partials = [
            '{"comm',
            'and":"',
            'ls -la /tmp"}',
          ]
          for (const partialJson of partials) {
            secureSend(ws, {
              type: 'tool_input_delta',
              sessionId: 'mock-sess-1',
              messageId: toolMessageId,
              toolUseId,
              partialJson,
            })
          }
          // Do NOT emit `tool_result` — the assertion targets the
          // streaming collapsed-preview render, not the result-arrived
          // path. Leave the agent busy so the bubble stays in-flight.
          break
        }

        // #4696: trigger phrase 'show-plan-approval' emits a `plan_ready`
        // wire message so the Maestro plan-approval flow can exercise the
        // PlanApprovalCard render + Approve/Deny paths on a real simulator.
        // Mirrors the production wire shape — see
        // packages/server/src/event-normalizer.js `plan_ready` builder which
        // ships `{ type: 'plan_ready', allowedPrompts }` after the CLI
        // session detects ExitPlanMode (cli-session.js#L883). The mobile
        // handler is store-core/handlers/index.ts handlePlanReady (mapped
        // in packages/app/src/store/message-handler.ts `case 'plan_ready'`)
        // which flips `isPlanPending` true + stores prompts. ChatView then
        // mounts PlanApprovalCard at the bottom of the message list.
        //
        // Tapping Approve calls handleApprovePlan in SessionScreen — it
        // sends the canonical PLAN_APPROVAL_MESSAGE ('Go ahead with the
        // plan') back through `sendInput`, which loops into this `input`
        // handler. The default branch echoes it back as a normal assistant
        // response, satisfying the post-approval assertion. We do NOT emit
        // anything else here for the plan_ready trigger — `agent_busy` is
        // not set because plan-ready arrives at end-of-turn (the prior
        // turn that produced the plan already cleared busy via `result`).
        if (text.trim() === 'show-plan-approval') {
          secureSend(ws, {
            type: 'plan_ready',
            sessionId: 'mock-sess-1',
            allowedPrompts: [
              { tool: 'Bash', prompt: 'npm test' },
              { tool: 'Edit', prompt: 'src/index.js' },
            ],
          })
          break
        }

        // #4697: trigger phrase 'show-ask-user-question' emits a
        // single-question AskUserQuestion `user_question` wire event so
        // the Maestro ask-user-question{,-deny} flows can exercise the
        // approve/deny round-trip on a real RN runtime. This is the
        // *exact surface* of the v0.9.x prompt-delivery wedges
        // (#4668 / #4679 / #4687 / #4648 / #4669) — server-side
        // regression coverage is locked in, but the mobile app had
        // zero E2E coverage for the approve/deny round-trip until
        // #4697. Mirrors `show-todos` / `show-bash-partial` counter
        // pattern so repeated triggers don't collide on a fixed
        // toolUseId (which would let the user_question handler skip
        // the second emission entirely).
        //
        // Wire shape matches the server's `user_question` envelope —
        // see `packages/server/src/ws-server.js`
        // `{ type:'user_question', toolUseId, questions }` and
        // `packages/store-core/src/handlers/index.ts handleUserQuestion`
        // which normalizes `questions[0]` into the legacy single-
        // question `content` + `options` on the prompt ChatMessage.
        //
        // Wire payload emits `{ label: 'approve' | 'deny' }` per option;
        // `handleUserQuestion` normalizes each option to `{ label, value }`
        // where `value === label` (see normalizeQuestion in
        // packages/store-core/src/handlers/index.ts). MessageBubble's
        // testID `approval-button-<value>` therefore resolves to
        // `approval-button-approve` / `approval-button-deny` — the
        // canonical Maestro selectors documented in the per-flow
        // headers. (Production AskUserQuestion option labels come from
        // the model and are usually capitalized; the lowercase here is
        // a deliberate fixture choice so the testID format matches the
        // canonical selectors exactly.)
        if (text.trim() === 'show-ask-user-question') {
          showAskUserQuestionCounter += 1
          const toolUseId = `tu-askuserquestion-mock-${showAskUserQuestionCounter}`
          // NOTE: option labels are deliberately lowercase ('approve' /
          // 'deny') so the MessageBubble testID `approval-button-<value>`
          // (value === label, see handleUserQuestion normalizeQuestion)
          // resolves to the canonical `approval-button-approve` /
          // `approval-button-deny` selectors documented in the flow
          // headers. Production AskUserQuestion options come from the
          // model and are usually capitalized — the testID format works
          // regardless because the assertion targets the test fixture
          // by exact match.
          secureSend(ws, {
            type: 'user_question',
            sessionId: 'mock-sess-1',
            toolUseId,
            questions: [
              {
                question: 'Should I run the deploy script?',
                options: [
                  { label: 'approve' },
                  { label: 'deny' },
                ],
              },
            ],
          })
          break
        }

        // #4877: trigger phrase 'show-ask-other' emits a single-question
        // AskUserQuestion so the Maestro ask-question-other-freeform flow
        // can exercise the Other → freeform send-path on a real RN
        // runtime. Mirrors the production wire shape `show-ask-user-question`
        // uses, but with model-supplied option labels that are distinct
        // from 'approve'/'deny' so the synthesized Other sentinel is the
        // obvious target — and so the post-answer freeform text bubble
        // can't be confused with a regular option label.
        //
        // The store-core `handleUserQuestion` normalizer appends the
        // synthetic OTHER_OPTION_VALUE option to every single-select
        // question that has at least one real option (see
        // packages/store-core/src/handlers/index.ts ~L3680). The Maestro
        // flow therefore taps `approval-button-__chroxy_other__` to drop
        // the MessageBubble into freetext mode, types a freeform answer,
        // and submits via `approval-freetext-send` — the testIDs that
        // landed with PR #4864.
        //
        // The freeform shape `{otherLabel, freeformText}` is forwarded
        // by SessionScreen.handleSelectOption to `sendUserQuestionResponse`,
        // which serializes `{type:'user_question_response', answer:<label>,
        // freeformText:<typed>, toolUseId}` on the wire. Mock handler
        // `case 'user_question_response'` logs the payload so a maintainer
        // can eyeball the wire shape in `[mock]` output; the Maestro
        // assertion targets the answered-state render (the typed text
        // renders in `styles.promptFreetextAnswered` after submit).
        if (text.trim() === 'show-ask-other') {
          showAskUserQuestionCounter += 1
          const toolUseId = `tu-askuserquestion-other-mock-${showAskUserQuestionCounter}`
          secureSend(ws, {
            type: 'user_question',
            sessionId: 'mock-sess-1',
            toolUseId,
            questions: [
              {
                question: 'Which environment should I deploy to?',
                options: [
                  { label: 'production' },
                  { label: 'staging' },
                ],
              },
            ],
          })
          break
        }

        // #4762 / #4973: trigger phrase 'show-multi-question' emits the
        // mixed wedge shape #4735 / #4604 Chunk B require coverage for —
        // single-select + multi-select + with-Other in one payload. Both
        // the dashboard's MultiQuestionForm AND the mobile React Native
        // MultiQuestionForm (#4973) render all N questions inline for
        // SDK-mode sessions (#4760 / #4731 lifted the suppression). The
        // mock session reports `provider: 'claude-sdk'`, so chat-multi-
        // question.yaml drives the full interactive form: tap every
        // `question-multi-option-<idx>-<value>`, submit via
        // `question-multi-submit`, and assert the post-answer summary
        // chip's comma-joined multi-select labels.
        //
        // The mixed shape exercises three independent wire branches
        // in a single payload:
        //   - Q[0]: single-select with model-supplied 'Other' label —
        //     normalizeQuestion's `modelSuppliedOther` path (see
        //     packages/store-core/src/handlers/index.ts:3670) preserves
        //     it with `value === label` ("Other") rather than appending
        //     the synthetic OTHER_OPTION_VALUE sentinel — so the testID
        //     resolves to `approval-button-Other`, not
        //     `approval-button-__chroxy_other__`.
        //   - Q[1]: multi-select (`multiSelect: true`) — Other
        //     sentinel is intentionally NOT appended (see
        //     normalizeQuestion's `isMultiSelect` branch); a regression
        //     that flipped the gate would surface as an extra option
        //     when downstream renderers iterate Q[1].
        //   - Q[2]: single-select with synthetic 'Other' (no model-
        //     supplied entry) — handleUserQuestion appends the
        //     OTHER_OPTION_VALUE sentinel automatically.
        //
        // toolUseId reuses the multi-question counter so repeated
        // triggers don't collide (same rationale as
        // show-ask-user-question-multi above).
        if (text.trim() === 'show-multi-question') {
          showAskUserQuestionCounter += 1
          const toolUseId = `tu-multi-question-mock-${showAskUserQuestionCounter}`
          secureSend(ws, {
            type: 'user_question',
            sessionId: 'mock-sess-1',
            toolUseId,
            questions: [
              // Q[0] — single-select with model-supplied 'Other'.
              // Lowercase 'approve' / 'deny' so the
              // `approval-button-<value>` testID matches the canonical
              // selectors used by the existing ask-user-question flows.
              {
                question: 'Q1 — deploy to production?',
                options: [
                  { label: 'approve' },
                  { label: 'deny' },
                  { label: 'Other' },
                ],
              },
              // Q[1] — multi-select. The Other sentinel is deliberately
              // NOT appended by normalizeQuestion for multi-select
              // questions (multi-select forms produced by claude SDK
              // never include a free-text fallback).
              {
                question: 'Q2 — which areas to verify?',
                multiSelect: true,
                options: [
                  { label: 'app' },
                  { label: 'server' },
                  { label: 'dashboard' },
                ],
              },
              // Q[2] — single-select with synthetic 'Other' (no model-
              // supplied entry; handleUserQuestion appends the
              // OTHER_OPTION_VALUE sentinel automatically).
              {
                question: 'Q3 — rollback strategy?',
                options: [
                  { label: 'auto-rollback' },
                  { label: 'manual-rollback' },
                ],
              },
            ],
          })
          break
        }

        // #4697 Chunk B: 4-question multi-question form mirrors the
        // shape #4604 Chunk B pinned at the server level. The mobile
        // MessageBubble currently renders only `questions[0]` (the
        // legacy single-question shape), so this flow asserts that
        // (a) the prompt bubble lands without dropping the message,
        // (b) Q[0]'s options ('approve' / 'deny') render correctly,
        // and (c) the answered state round-trips. When the mobile
        // multi-question UI lands, this flow can extend to iterate
        // `approval-question-<index>` for N>1.
        //
        // Wire payload: each option is `{ label: <string> }`; the
        // store-core normalizer (handleUserQuestion) maps each option
        // to `{ label, value }` with `value === label`. Q[0] uses
        // lowercase 'approve' / 'deny' so the `approval-button-<value>`
        // selector matches Q[0]; subsequent questions use distinct
        // labels per question so the multi-question test can prove
        // every entry hydrated correctly (asserted by content).
        if (text.trim() === 'show-ask-user-question-multi') {
          showAskUserQuestionCounter += 1
          const toolUseId = `tu-askuserquestion-multi-mock-${showAskUserQuestionCounter}`
          // Q[0] uses lowercase 'approve' / 'deny' to keep the canonical
          // selector match with the single-question flow. Subsequent
          // questions use distinct labels so the multi-question test
          // can assert that the wire payload preserved every question
          // (a regression in handleUserQuestion's normalizedAll filter
          // would drop entries and we'd see fewer labels round-trip).
          secureSend(ws, {
            type: 'user_question',
            sessionId: 'mock-sess-1',
            toolUseId,
            questions: [
              {
                question: 'Q1 — deploy to production?',
                options: [
                  { label: 'approve' },
                  { label: 'deny' },
                ],
              },
              {
                question: 'Q2 — notify the on-call channel?',
                options: [
                  { label: 'yes-notify' },
                  { label: 'no-notify' },
                ],
              },
              {
                question: 'Q3 — wait for code-freeze ack?',
                options: [
                  { label: 'wait' },
                  { label: 'skip' },
                ],
              },
              {
                question: 'Q4 — rollback strategy?',
                options: [
                  { label: 'auto-rollback' },
                  { label: 'manual-rollback' },
                ],
              },
            ],
          })
          break
        }

        // Default: simulate a normal text-only assistant response.
        const messageId = `msg-${Date.now()}`
        secureSend(ws, { type: 'stream_start', messageId, sessionId: 'mock-sess-1' })
        secureSend(ws, { type: 'agent_busy', sessionId: 'mock-sess-1' })
        // #6019: prefix the reply with a marker ONLY when the session is actually
        // encrypted. This is what makes key-exchange.yaml non-vacuous — the
        // marker round-trips only if: encrypted token accepted → handshake →
        // app encrypts the input → mock DECRYPTS it (reaching this handler) →
        // mock re-encrypts the reply → app decrypts + renders. Asserting the
        // plain echo of the user's own input would pass on an unencrypted
        // session too (the bug this replaces).
        const encMarker = encryptedSession ? 'encrypted-session-ok ' : ''
        const response = `${encMarker}I received your message: "${text}". This is a mock response for E2E testing.`
        // Send as a single delta for simplicity
        secureSend(ws, { type: 'stream_delta', messageId, delta: response, sessionId: 'mock-sess-1' })
        secureSend(ws, { type: 'stream_end', messageId, sessionId: 'mock-sess-1' })
        secureSend(ws, { type: 'result', cost: 0.001, duration: 100, usage: {}, sessionId: 'mock-sess-1' })
        secureSend(ws, { type: 'agent_idle', sessionId: 'mock-sess-1' })
        break
      }

      case 'register_push_token':
        // Silently accept
        break

      // #4697: ack the AskUserQuestion approve/deny tap. The app's
      // `sendUserQuestionResponse` flips `answered` locally on a
      // successful socket write (see SessionScreen handleSelectOption),
      // so no server reply is strictly required to advance the UI —
      // but logging here gives the mock a visible audit trail and
      // keeps the wire trace consistent with the production handler
      // path (ws-server.js processes `user_question_response` /
      // `permission_response` symmetrically).
      case 'user_question_response':
        // #4877: log `freeformText` alongside `answer` so the Other →
        // freeform send-path's wire shape is visible in the mock audit
        // trail. When the user picks the synthesized Other option,
        // `sendUserQuestionResponse` serializes the wire payload
        // `{answer:<otherLabel>, freeformText:<typed>, toolUseId}` —
        // the dashboard parity shape pinned by PR #4864.
        console.log(`[mock] user_question_response: answer="${msg.answer}" freeformText="${msg.freeformText || ''}" toolUseId="${msg.toolUseId || ''}"`)
        break

      case 'permission_response':
        // Wire shape per packages/app/src/store/connection.ts:
        // `{ type: 'permission_response', requestId, decision }`.
        console.log(`[mock] permission_response: requestId="${msg.requestId || ''}" decision="${msg.decision || ''}"`)
        break

      case 'request_session_context':
        secureSend(ws, {
          type: 'session_context',
          sessionId: 'mock-sess-1',
          gitBranch: 'main',
          gitDirty: 0,
          gitAhead: 0,
          projectName: 'mock-project',
        })
        break

      default:
        console.log(`[mock] Unhandled: ${msg.type}`)
    }
  })

  ws.on('close', () => {
    console.log('[mock] Client disconnected')
  })
})

/**
 * Send the standard post-auth burst (session_list, status, models, etc.).
 * Extracted so both the eager and discrete encryption paths can share the
 * same sequence. `sendFn` is the connection-scoped `secureSend` closure so
 * the burst goes through the correct (plain or encrypted) channel.
 */
function sendPostAuthBurst(ws, sendFn) {
  sendFn(ws, { type: 'server_mode', mode: 'cli' })
  sendFn(ws, { type: 'status', connected: true })
  sendFn(ws, {
    type: 'session_list',
    sessions: [{
      sessionId: 'mock-sess-1',
      name: 'Mock Session',
      cwd: '/tmp/mock-project',
      type: 'cli',
      // #4701: report `hasTerminal: true` so the SessionScreen
      // mode toggle includes the Terminal button (which the
      // terminal-view.yaml flow taps). Existing flows do not
      // assert on the absence of the Term button, so flipping
      // this default is safe.
      hasTerminal: true,
      model: 'sonnet',
      permissionMode: 'approve',
      isBusy: false,
      createdAt: Date.now(),
      conversationId: null,
      provider: 'claude-sdk',
      capabilities: {},
    }],
  })
  sendFn(ws, {
    type: 'session_switched',
    sessionId: 'mock-sess-1',
    name: 'Mock Session',
    cwd: '/tmp/mock-project',
    conversationId: null,
  })
  sendFn(ws, {
    type: 'available_models',
    models: [
      { id: 'sonnet', name: 'Sonnet', description: 'Fast and capable' },
      { id: 'opus', name: 'Opus', description: 'Most capable' },
    ],
  })
  sendFn(ws, {
    type: 'available_permission_modes',
    modes: [
      { id: 'approve', label: 'Approve' },
      { id: 'auto', label: 'Auto' },
      { id: 'plan', label: 'Plan' },
    ],
  })
  sendFn(ws, { type: 'claude_ready', sessionId: 'mock-sess-1' })
  sendFn(ws, { type: 'model_changed', model: 'sonnet', sessionId: 'mock-sess-1' })
  sendFn(ws, { type: 'permission_mode_changed', mode: 'approve', sessionId: 'mock-sess-1' })
}

httpServer.listen(PORT, () => {
  console.log(`[mock] Chroxy mock server listening on port ${PORT}`)
  console.log(`[mock] Token: ${API_TOKEN}`)
  console.log(`[mock] Health: http://localhost:${PORT}/`)
  console.log(`[mock] WebSocket: ws://localhost:${PORT}`)
})
