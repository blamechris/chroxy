# Encryption Threat Model

Chroxy's end-to-end encryption design, trust boundaries, and threat analysis.

## 1. Overview

Chroxy is a **self-hosted** remote terminal app. The server daemon runs on the user's own development machine, and the mobile app connects to it through a Cloudflare tunnel. This is fundamentally different from a multi-tenant relay service where a third-party server sits between the user and their tools.

E2E encryption in Chroxy protects data **in transit** through the Cloudflare tunnel. The server decrypts messages because it *is* the user's own machine -- this is by design, not a vulnerability. The encryption layer exists to prevent the tunnel operator (or any network intermediary) from reading the content of WebSocket messages.

## 2. Trust Boundaries

```
                    Trusted                 Untrusted              Trusted
                +--------------+      +------------------+     +-----------+
                |  User's Mac  |      | Cloudflare Tunnel|     | User's    |
                |  (Server)    |<---->|  (Transport)     |<--->| Phone     |
                |              |      |                  |     | (App)     |
                +--------------+      +------------------+     +-----------+
                    Plaintext           Encrypted only           Plaintext
                    (by design)                                  (by design)
```

**User's machine (server)** -- Fully trusted. This is the user's own computer running Claude Code. The server must decrypt messages to process them (route input to Claude, parse output, manage sessions). Physical and logical access to this machine already grants full access to everything Chroxy handles.

**Cloudflare tunnel** -- Untrusted transport. All WebSocket traffic passes through Cloudflare's infrastructure. In Quick Tunnel mode, the URL is random and ephemeral. In Named Tunnel mode, it uses a stable subdomain on the user's Cloudflare-configured domain. Either way, the tunnel operator could theoretically inspect traffic, which is why encryption exists.

**Mobile device (app)** -- Trusted endpoint. The user's personal phone running the Chroxy app. The app generates ephemeral keys, performs the key exchange, and encrypts/decrypts all messages locally.

## 3. Key Exchange (X25519 + HSalsa20)

Chroxy uses the TweetNaCl library (`tweetnacl`) on both the server and mobile app. The key exchange protocol:

1. **Auth phase**: Client authenticates with a pre-shared API token. The server responds with `auth_ok` including `encryption: 'required'` (or `'disabled'` if `--no-encrypt` was used).

2. **Key generation**: Both sides generate ephemeral X25519 keypairs using `nacl.box.keyPair()`. The client sends its public key in a `key_exchange` message. The server generates its own keypair, derives the shared key, and replies with `key_exchange_ok` containing its public key.

3. **Shared key derivation**: Both sides call `nacl.box.before(theirPublicKey, mySecretKey)`, which performs Curve25519 Diffie-Hellman followed by HSalsa20 key derivation to produce a 32-byte shared symmetric key.

4. **Message queuing**: During the key exchange window, the server queues all outbound messages. Once the exchange completes, queued messages are flushed through the encryption layer.

5. **Timeout enforcement**: If the client does not send a `key_exchange` message within the configured timeout (default 10 seconds), the server disconnects the client. The server never downgrades to plaintext -- if encryption is enabled, any non-`key_exchange` message during the pending phase causes immediate disconnection.

### Key Properties

- **Ephemeral keys**: New keypairs are generated for every connection. The server creates a fresh keypair per client session; the app resets encryption state on every new WebSocket connection.
- **Forward secrecy**: Each connection uses unique ephemeral keys. Compromising one session's keys does not reveal past or future session traffic. Keys exist only in memory and are discarded on disconnect.
- **No key persistence**: Neither side stores private keys to disk. Key material lives only in process memory for the duration of the connection.

## 4. Message Encryption (XSalsa20-Poly1305)

After key exchange, all WebSocket messages are encrypted using `nacl.secretbox` (XSalsa20-Poly1305):

- **Algorithm**: XSalsa20 stream cipher with Poly1305 MAC (authenticated encryption)
- **Key**: 32-byte shared key from the X25519 key exchange
- **Nonce construction**: 24-byte nonce built from a direction byte (0x00 for server, 0x01 for client) and a monotonically incrementing counter (little-endian uint64). This prevents nonce reuse between send directions.
- **Envelope format**: `{ type: 'encrypted', d: '<base64 ciphertext>', n: <nonce counter> }`
- **Replay detection**: The receiver tracks the expected nonce counter. If the received nonce does not match the expected value, decryption is rejected and the connection is closed.
- **Tamper detection**: Poly1305 MAC verification fails on any modification to the ciphertext, causing immediate connection termination.

### What Gets Encrypted

After key exchange, **every** WebSocket message is encrypted in both directions:

- User input and Claude's responses (code, explanations, terminal output)
- Permission prompts and approval/denial decisions
- File contents, directory listings, diff output
- Session management commands (create, switch, destroy)
- Model and permission mode changes
- Status updates (cost, token usage, context window)
- Agent lifecycle events (spawn, complete)
- Plan mode interactions (approval, feedback)

## 5. What Encryption Protects Against

- **Tunnel operator eavesdropping**: Cloudflare (or any infrastructure between server and app) sees only encrypted envelopes. Application-level message types and content are encrypted. However, the outer envelope (`type: 'encrypted'`, nonce counter `n`) and traffic metadata (frame sizes, timing) remain observable.
- **Network MITM on the tunnel segment**: An attacker who can intercept tunnel traffic cannot read or modify messages without the shared key.
- **Passive network monitoring**: ISPs, Wi-Fi operators, or other network-level observers on either side of the tunnel see only encrypted WebSocket frames.

## 6. What Encryption Does NOT Protect Against

- **Physical access to the server**: The server is the user's own machine. Anyone with access to it already has access to the source code, Claude Code sessions, and everything else. Server-side decryption is a feature -- the server processes messages to function.
- **Compromised mobile device**: If the phone is compromised, the attacker has access to the decrypted messages in app memory, the API token stored in secure storage, and the plaintext UI.
- **Compromised server process**: If the server process is compromised, the attacker has the shared key in memory and can decrypt traffic. But at that point they also have direct access to Claude Code.
- **API token theft**: The API token authenticates the connection. If stolen, an attacker can connect and complete a key exchange. The token is transmitted in the initial `auth` message before encryption is active (see Limitations below).
- **Side-channel attacks**: Encrypted message sizes and timing patterns may leak information about message types or content length.

## 7. Comparison with Relay-Based Tools

Relay-based tools (where a third-party server mediates between user and AI) face fundamentally different trust requirements:

| Aspect | Relay-Based Tool | Chroxy (Self-Hosted) |
|--------|-----------------|---------------------|
| Server operator | Third party | The user |
| Server decryption | Potential privacy risk | Expected behavior |
| Data at rest | On third-party infrastructure | On user's own machine |
| Trust requirement | Must trust the relay operator | Trust only yourself |
| Attack surface | Relay is high-value target | Single-tenant, internet-facing via tunnel (auth token + E2E) |

Chroxy's architecture means:
- No third-party server ever has access to conversation data
- The tunnel is a dumb pipe -- encrypted bytes pass through, nothing is stored or logged at the application layer
- Server-side decryption is not a vulnerability because the server IS the user's machine

## 8. Known Limitations and Mitigations

### Auth Token Transmitted Before Encryption

The `auth` message containing the API token is sent in plaintext at the application layer over the WebSocket. When connecting through the Cloudflare tunnel, this WebSocket runs over `wss://` (TLS). However, when connecting directly over local WiFi via LAN discovery, the connection uses `ws://` (no TLS) and the token is visible to anyone who can sniff traffic on that network. The key exchange happens *after* successful authentication.

**Mitigation**: When using the Cloudflare tunnel (or any `wss://` URL), TLS provides transport-layer encryption for the auth token. On unencrypted `ws://` LAN connections, the auth token is exposed to local network sniffing -- such connections should only be used on trusted networks. The application-layer E2E encryption adds a second layer specifically to protect against the tunnel operator, but does not protect the auth token itself since it is sent before the key exchange completes.

### Trust On First Use (TOFU)

There is no certificate pinning or out-of-band key verification. The client trusts that the server's public key in `key_exchange_ok` is authentic. A MITM who can intercept the initial key exchange could perform a relay attack.

**Mitigation**: The Cloudflare tunnel provides TLS termination at both ends. An attacker would need to compromise Cloudflare's infrastructure or the tunnel daemon itself to intercept the key exchange. For Quick Tunnels, the URL is random and ephemeral, limiting the attack window. For Named Tunnels, the user controls the DNS configuration.

### No Key Verification UI

The app does not display key fingerprints or provide a mechanism for users to verify key authenticity out-of-band.

**Mitigation**: In Chroxy's threat model, the primary adversary is a passive eavesdropper on the tunnel. Active MITM attacks require significantly more capability (tunnel infrastructure compromise), and the self-hosted nature means the attack surface is much smaller than a multi-tenant service.

### Single API Token

A single static API token is used for authentication. The token is generated during `chroxy init` and persisted in `~/.chroxy/config.json`. If leaked, it grants full access until the token is regenerated (by re-running `chroxy init` or manually updating the config).

**Mitigation**: Tokens are generated using `crypto.randomUUID()`. Auth rate limiting with exponential backoff (1s, 2s, 4s, ... up to 60s) protects against brute-force attempts. Failed auth entries are pruned after 5 minutes. Token comparison uses constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks. On suspicion of compromise, regenerate the token and re-pair devices.

### Encryption Can Be Disabled

The `--no-encrypt` flag disables E2E encryption entirely (intended for local development and testing only).

**Mitigation**: The `auth_ok` message includes `encryption: 'disabled'` so the app knows the connection is unencrypted. The flag is documented as intended for local development and testing only. This flag should never be used over a public tunnel.

## 9. Attack Vectors and Mitigations

| Attack Vector | Risk | Mitigation |
|--------------|------|------------|
| Tunnel eavesdropping | Data exposure | E2E encryption (XSalsa20-Poly1305) on all post-handshake messages |
| Brute-force auth | Unauthorized access | Exponential backoff rate limiting (up to 60s), constant-time token comparison |
| Replay attacks | Message injection | Monotonic nonce counters with strict expected-value checking; direction bytes prevent cross-direction replay |
| Message tampering | Data integrity | Poly1305 MAC on every message; tamper causes decryption failure and connection close |
| Nonce reuse | Crypto weakness | Direction byte (0x00/0x01) ensures server and client nonce spaces never overlap; monotonic counters prevent reuse within a direction |
| Key exchange MITM | Session hijack | TLS through Cloudflare tunnel protects the key exchange; ephemeral keys limit blast radius |
| Downgrade attack | Plaintext exposure | Server refuses non-`key_exchange` messages when encryption is pending; timeout forces disconnect |
| Stale connection hijack | Session takeover | Server-side WebSocket ping/pong keepalive detects dead connections; auth timeout (10s) prevents lingering unauthenticated sockets |
| Token extraction from QR code | Unauthorized access | QR code contains a persisted auth token; protect physical/visual access to the QR; rotate/regenerate the token on suspicion of compromise |
| Compromised Cloudflare account | Tunnel hijack (Named Tunnels) | E2E encryption still protects message content even if tunnel routing is compromised |

## 10. Implementation Reference

| Component | Server | App |
|-----------|--------|-----|
| Crypto module | `packages/server/src/crypto.js` | `packages/app/src/utils/crypto.ts` |
| Key exchange | `packages/server/src/ws-server.js` (`_handleMessage`) | `packages/app/src/store/connection.ts` |
| Message encrypt/decrypt | `_send()` in `ws-server.js` | `wsSend()` / `onmessage` in `connection.ts` |
| Library | `tweetnacl` + `tweetnacl-util` | `tweetnacl` + `tweetnacl-util` |
| Tests | `packages/server/tests/crypto.test.js` | `packages/app/src/__tests__/utils/crypto.test.ts` |
| Config flag | `--no-encrypt` / `CHROXY_NO_ENCRYPT` | N/A (responds to server's `encryption` field) |
