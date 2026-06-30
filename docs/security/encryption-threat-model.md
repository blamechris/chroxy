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

### Eager Key Exchange (#5555)

As a latency optimisation, the client may fold its half of the handshake into the `auth` message: it generates the ephemeral keypair + salt up front and sends `eagerPublicKey` + `eagerSalt` alongside the token. When the server honours this (encryption required, both fields present and well-formed), it derives the shared key inline and returns its own ephemeral public key as `serverPublicKey` in the **plaintext** `auth_ok` frame, then activates encryption for every subsequent frame. This collapses the two-round-trip handshake into one — replay starts a full RTT earlier.

**The eager path is cryptographically identical to the discrete `key_exchange`.** It uses the same `nacl.box` Curve25519 DH (step 3) and the same per-connection salt sub-key derivation; only the transport timing of the two public keys changes (one frame instead of two). It is fully backward compatible in both directions: an old client that omits the eager fields, or a new client talking to an old server that omits `serverPublicKey`, falls back to the discrete `key_exchange` with no behavioural change. The server still refuses to downgrade to plaintext, still queues nothing-until-keyed on the discrete fallback, and still enforces the key-exchange timeout when the eager path was not taken.

**Interaction with key pinning (#5536).** The eager path carries the same identity machinery as the discrete handshake: when the daemon has a pinned identity it also signs the eager `serverPublicKey` and ships the detached signature as `serverKeySig` in the (plaintext) `auth_ok` frame. A pinned client verifies that signature against its pinned identity key *before* deriving the shared key from `serverPublicKey` — identical to the discrete `key_exchange_ok` check, only one frame earlier. So moving the server's exchange key into `auth_ok` neither widens nor narrows the trust model: an attacker who relays the frame still cannot forge a signature over a swapped exchange key. See §3.1 for the full construction. (Before #5536 this section noted the eager path was "neither improved nor worsened" — it now carries the pin signature on the same frame.)

### Key Properties

- **Ephemeral exchange keys**: New X25519 keypairs are generated for every connection. The server creates a fresh exchange keypair per client session; the app resets encryption state on every new WebSocket connection.
- **Forward secrecy**: Each connection uses unique ephemeral exchange keys. Compromising one session's keys does not reveal past or future session traffic. Exchange keys exist only in memory and are discarded on disconnect.
- **No exchange-key persistence**: Neither side stores ephemeral *exchange* private keys to disk. Exchange key material lives only in process memory for the duration of the connection. (The separate long-lived **identity** key — §3.1 — IS persisted; it never participates in DH and signs only.)

### 3.1 Server Identity Key (#5536) — pinning the daemon

Until #5536 the key exchange above was pure **Trust On First Use**: the client accepted whatever exchange public key the server sent on *every* connect, with no way to tell the real daemon from a man-in-the-middle who relayed (and re-keyed) the handshake. Identity rested entirely on the URL — TLS for `wss://`, *nothing* for LAN `ws://`.

#5536 gives the daemon a **stable cryptographic identity** that clients pin out-of-band at pairing time, using a signature construction over the existing primitives (no new crypto dependency):

1. **Long-lived identity key.** On first run the daemon mints an **Ed25519** signing keypair (`nacl.sign`, already part of the `tweetnacl` dependency) and persists it across restarts — in the OS keychain under a dedicated service (`chroxy-identity-key`), or a `0600` `~/.chroxy/server-identity.json` file where no keychain is available (the same honest fallback the credential store uses). The key is minted only when encryption is on and auth is required (`--no-auth` / `--no-encrypt` carry no pinning surface). It is generated once and reused on every restart, so a returning daemon keeps the identity its clients pinned.

2. **The identity public key rides the pairing channel.** The pairing channel (a QR scanned in person, or a pairing code read off the host screen) is the trust root — it already conveys the URL + pairing id out-of-band. The daemon's identity public key is appended to every pairing URL as `?idk=<base64>` (QR, `/pairing-code` response, `chroxy://` deep link, session-bound and approval-gated share links). Clients capture it and **pin it on the saved connection record** (app SecureStore, dashboard server registry). Old clients ignore the extra param.

3. **Per-connection exchange keys are signed by the identity key.** On every handshake — both the eager path (`serverPublicKey` in `auth_ok`, #5555) and the discrete path (`key_exchange_ok`) — the server signs its ephemeral exchange public key with the identity *secret* key and ships the detached signature as `serverKeySig`. A client that pinned the identity verifies `serverKeySig` over the offered exchange key against the **pinned identity public key** *before* deriving the shared key. A MITM who swaps the exchange key cannot forge a signature without the identity secret, so the swap is detected and the connection is **refused** with a distinct, specific "server identity changed" error (not a silent retry loop).

**What this buys.** It binds each ephemeral exchange key to the daemon's pinned identity, so the exchange key travelling in the clear over the (possibly un-TLS'd `ws://`) wire is no longer blindly trusted. This gives `ws://` LAN connections real server identity and closes the LAN-MITM key-relay window for any client that paired in person.

**Trust continuity / pin-on-first-use.** A connection record that was paired *before* #5536 (or to a daemon with no identity, e.g. `--no-encrypt`) carries no pinned key and stays TOFU. On the first post-upgrade connect that presents a signed identity, the client **pins on first use** — adopting the identity advertised over the trusted pairing channel. The first such connect is the same TOFU exposure that existed before pinning; every connect after it is verified. A client that *did* capture a pairing-time identity verifies the very first handshake against it, so even the first connect is protected when the pairing channel conveyed an `idk`.

**No silent downgrade.** Once a client has a pinned identity, a handshake that arrives *without* a signature is refused, not silently accepted as TOFU — otherwise a MITM could defeat pinning by simply stripping `serverKeySig`. The only way past a refusal is to **re-pair** (scan a fresh QR / enter a new code), which re-pins the new identity. This mirrors the existing "server never downgrades encryption to plaintext" rule.

**No plaintext downgrade either (#5614).** The signature check above only runs once encryption is negotiated — both clients reach it *inside* the `auth.encryption === 'required'` branch of the `auth_ok` handler. That left one downgrade cell open: a MITM could forge a plaintext `auth_ok` with `encryption: 'none'` (or omit the field) to route a pinned client down the *unencrypted* branch, which skipped the pin check entirely and dropped the user onto an unverified session — defeating pinning with a single flipped field. #5614 closes the cell by gating the encryption mode itself: at the **top** of the `auth_ok` handler, *before* the encryption branch, a connection that carries **any** pinned identity (a committed pin, or a pairing-time identity captured this dial) **refuses any `auth_ok` whose `encryption` is not `'required'`**. It fails closed down the same distinct "server identity changed / refused" path as a signature mismatch — never a fall-through to an unencrypted socket. The gate is a single shared decision (`decodeEncryptionGate` in `store-core/key-pinning.ts`) consumed identically by both clients on both the eager and discrete paths, so it cannot be bypassed on one path. Unpinned connections are unchanged: they keep TOFU with encryption optional (a plaintext `auth_ok` from an old / `--no-encrypt` daemon is still accepted).

**The daemon must not silently rotate its identity (#5615).** A pinned client treats *any* identity change as a potential impersonation. That makes the daemon's identity-key load path security-critical: if a transient OS-keychain hiccup (locked keychain / interaction-not-allowed) were read as "no key stored", the daemon would mint a **fresh** identity and every already-pinned client would see a false "network impersonation" alert on the next connect — a self-inflicted brick indistinguishable from a real MITM. `getOrCreateServerIdentity` therefore distinguishes three cases on the keychain read: **(a) keychain absent / nothing stored** — genuine first run, minting is correct; **(b) keychain present but the read FAILED** (locked / errored) — the daemon does **not** mint a replacement (which would rotate the pinned identity); it raises a distinct `IdentityUnavailableError` and, by default, **refuses to start** so the operator unlocks the keychain and the *same* identity loads (an escape hatch, `CHROXY_ALLOW_UNPINNED_BOOT=1`, lets an operator who knows no clients are pinned boot once with pinning disabled — the server then signs nothing and clients see TOFU, *not* a false impersonation alert); **(c) a malformed stored value** — treated as absent and re-minted, the long-standing behaviour, kept deliberately distinct from (b). Because the OS keychain APIs collapse "not found" and "locked" inconsistently, the heuristic is best-effort and **fails safe toward NOT rotating**: macOS keys "absent" strictly to the `errSecItemNotFound` (44) exit code and treats every other failure as a read error; Linux hosts with no `secret-tool`/libsecret backend use the documented `0600` file fallback, while a reachable `secret-tool` backend still keys "absent" to an empty-stderr exit-1 and treats anything else as a read error (`keychain.getTokenStatus`).

**Candidly, what is NOT covered.** Pinning is only as strong as the pairing channel: a client that connects by typing a raw `ws://`/`wss://` URL (never scanning a QR or pasting a `chroxy://?…idk=` URL) has no pairing-time identity to adopt and pins on first use — the first connect remains TOFU. Authenticated key *rotation* is out of scope: rotating the daemon's identity requires an explicit re-pair (the pinned client correctly refuses the new key until re-paired). And the construction binds *identity*, not *liveness* — it does not by itself defend against replay of a whole past handshake transcript (the existing nonce/replay protections in §4 cover in-session replay).

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

**Residual risk and operator guidance.** Once a candidate is verified, an attacker who can ARP-spoof or otherwise MITM the local segment *and* impersonate the daemon's IP could attempt to capture the plaintext token on a subsequent LAN connect. **#5536 substantially narrows this**: a client that paired in person pinned the daemon's identity, so an impersonator's swapped exchange key fails signature verification and the connection is refused *before* the post-handshake traffic — the impersonation is detected rather than silently relayed. The auth token itself is still sent *before* the key exchange completes, so the residual exposure is the **first** connect of a record that never pinned an identity (paired pre-#5536, or via a raw `ws://` URL with no `idk`) — the same TOFU-class first-use window described under "Trust On First Use" below. For environments where even that is not acceptable, the mitigations are unchanged: pair in person so the identity is pinned from the start, bind the daemon to loopback and use the tunnel only (`--host 127.0.0.1`), rotate the token on suspicion of compromise, and avoid LAN mode on untrusted networks. The manual override (ServerPicker / manual entry) always lets the user pin the tunnel.

### Trust On First Use (TOFU) — now pinned at pairing (#5536)

**Pinned daemons.** Since #5536, a client that paired in person (scanned a QR / read a pairing code) pins the daemon's long-lived Ed25519 identity key (conveyed as `?idk=` over the trusted pairing channel) and verifies the server's *signed* exchange key against it on every connect (§3.1). A MITM who relays and re-keys the exchange is detected — the signature won't verify under the pinned identity — and the connection is refused. This holds on `ws://` as well as `wss://`, giving LAN connections real server identity.

**Residual TOFU window.** Pinning is bootstrapped over the pairing channel, so a residual TOFU window remains in exactly two cases: (1) a connection record paired *before* #5536 / to a daemon with no identity (it stays TOFU and pins on first use after upgrade — trust continuity); and (2) a connection started by typing a raw `ws://`/`wss://` URL that never carried an `idk` (no pairing-time identity to adopt → pin on first use). In both cases the *first* connect carries the pre-#5536 TOFU exposure, and every connect after it is verified.

**Mitigation for the residual window**: The Cloudflare tunnel provides TLS termination at both ends, so the first-connect window on `wss://` still requires compromising Cloudflare's infrastructure or the tunnel daemon to relay the key exchange. For Quick Tunnels the URL is random and ephemeral; for Named Tunnels the user controls DNS. To eliminate the window, pair in person (scan the QR) so the identity is pinned from a trusted channel before the first connect.

### Key Verification UX

The app and dashboard do not surface raw key fingerprints for manual comparison, but #5536 gives both a distinct, specific **"server identity changed"** error state (a shared message constant) when a pinned identity fails verification — a loud refusal, not a silent retry loop. The user resolves it by re-pairing (scanning a fresh QR / entering a new pairing code), which re-pins the new identity.

**Mitigation**: In Chroxy's threat model the primary adversary is a passive eavesdropper on the tunnel; active MITM is now additionally defeated by pinning for any in-person-paired client. The self-hosted nature means the attack surface is much smaller than a multi-tenant service.

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
| Key exchange MITM | Session hijack | **#5536:** pinned daemon identity (Ed25519) signs each exchange key; pinned clients verify against the pairing-time `idk` and refuse a swap. Plus TLS through the Cloudflare tunnel and ephemeral keys (forward secrecy). Residual TOFU only on the first connect of an unpinned/raw-URL record. |
| Server impersonation / key swap on `ws://` LAN | Token capture + session hijack | **#5536:** identity pinning gives `ws://` real server identity — a hostile LAN box's swapped exchange key fails signature verification and is refused. Bounded to the first connect of records that never paired in person. |
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
| **Identity key (#5536)** — sign/verify primitives | `@chroxy/store-core` `crypto.ts` (`createSigningKeyPair` / `signExchangeKey` / `verifyExchangeKeySignature`) | same shared module |
| **Identity key (#5536)** — persistence | `packages/server/src/server-identity.js` (keychain `chroxy-identity-key` / `0600` `~/.chroxy/server-identity.json`) | pinned on the saved record: app SecureStore (`pinnedIdentityKey`), dashboard server registry (`ServerEntry.pinnedIdentityKey`) |
| **Identity key (#5536)** — signing on the wire | `ws-auth.js` (discrete `key_exchange_ok.serverKeySig`) + `ws-history.js` (eager `auth_ok.serverKeySig`); identity rides the pairing URL `?idk=` (`pairing.js`) | pin-or-refuse decision: `@chroxy/store-core` `key-pinning.ts` (`decideKeyPinWithPairingIdentity`) used by both clients' `message-handler` |
| **Identity key (#5536)** — tests | `tests/server-identity.test.js`, `tests/pairing-identity-key.test.js`, `tests/ws-auth.test.js`, `tests/ws-history.test.js` | `store-core/src/key-pinning.test.ts`, `store-core/src/crypto.test.ts` |
