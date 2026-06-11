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

### Auto-Preferring the Direct LAN Path (#5518)

When the phone shares a network with the daemon, the mobile app can dial the daemon directly over `ws://<lan-ip>:<port>` instead of hairpinning every byte through a Cloudflare colo. A connection record may carry *both* endpoints -- a `ws://` LAN candidate and the `wss://` tunnel -- and the app races a cheap unauthenticated `GET /health` probe at connect time (and on network change) to pick the local path when it answers, falling back to the tunnel otherwise. The selection logic lives in `packages/app/src/utils/endpoint-selector.ts`.

**Security determination -- what changes and why it is acceptable.** Direct `ws://` LAN mode is the same transport posture already analysed above (and in [bearer-token-authority.md §10](bearer-token-authority.md#10-lan-bind-unauthenticated-surface-5356)); auto-preferring it does not introduce a *new* transport, but it does make the `ws://` path the default whenever it is reachable, so the trade-off must be stated explicitly:

- **Message content is still E2E-encrypted on `ws://`.** The XSalsa20-Poly1305 layer (§4) wraps *every* post-handshake message identically on `ws://` and `wss://`. Chat input, Claude's output, terminal data, permission prompts, file contents, and session-management commands are all ciphertext on the local wire exactly as they are through the tunnel. LAN mode does **not** expose message content to a local sniffer.
- **What IS exposed on the local network** is precisely what §6 and §8 already enumerate for the `ws://` case, now realised by default rather than only on manual LAN connect:
  - **The auth token, in plaintext**, because it is sent in the `auth` message *before* key exchange (see "Auth Token Transmitted Before Encryption" above). On `wss://` TLS hides it; on `ws://` a sniffer on the same L2 segment can read it. This is the one materially new exposure of routine LAN-prefer, and it is the reason the gating below is strict.
  - **Traffic metadata**: the `encrypted` envelope, the nonce counter `n`, frame sizes, and timing. The same side-channel surface §6 calls out for the tunnel, minus Cloudflare's TLS wrapper -- a local observer additionally sees the `/health` and `/ws` URLs and the daemon's LAN IP/port. None of this reveals message content.
  - **The unauthenticated `/health` fingerprint** (`{ status, mode, version }`) -- already reachable by any device on a non-loopback bind ([bearer-token-authority.md §10](bearer-token-authority.md#10-lan-bind-unauthenticated-surface-5356)); the probe adds no exposure the subnet did not already have.

**The token must never reach an unverified box -- the identity gate.** `/health` is unauthenticated, so a hostile box on the subnet can answer `{ status: 'ok' }`. A `/health` answer therefore proves *that some chroxy is listening*, not *which* daemon it is -- it is not identity. The token is the only thing that distinguishes the real daemon, and we refuse to leak it to a decoy. Two rules enforce this:

1. **Auto-prefer only a token-verified LAN candidate.** A LAN endpoint is marked `lanVerified` only after a full auth + key-exchange handshake against that exact `ws://` URL has *succeeded with this record's token* -- i.e. the real daemon accepted the token, which nothing else can do. That association is established only by a user-initiated connection (selecting a LAN-scan result and entering the token, or scanning a daemon-issued `ws://` QR), never by a blind subnet scan. An unverified candidate is never probed and never dialed; the app falls back to the tunnel. A token rotation clears the flag, since the old verification was earned by a different credential.
2. **The probe carries no secret.** Endpoint selection issues only `GET /health` -- no `Authorization` header. The token travels later, on the URL the selector returns, and for the LAN path only ever a verified one.

**Residual risk and operator guidance.** Once a candidate is verified, an attacker who can ARP-spoof or otherwise MITM the local segment *and* impersonate the daemon's IP could capture the plaintext token on a subsequent LAN connect (the same TOFU-class risk as any `ws://` use; see "Trust On First Use" below). This is bounded to attackers with active L2 control of a network the user has explicitly trusted by connecting over LAN. For environments where that is not acceptable, the mitigations are unchanged: bind the daemon to loopback and use the tunnel only (`--host 127.0.0.1`), rotate the token on suspicion of compromise, and avoid LAN mode on untrusted networks. The manual override (ServerPicker / manual entry) always lets the user pin the tunnel.

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
