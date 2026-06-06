# Credentials At-Rest Encryption

How Chroxy stores provider credentials on disk, and what that encryption does — and does **not** — protect against. Implemented in `packages/server/src/credential-cipher.js` and `credential-store.js` (#5154).

This is distinct from the [transport-layer model](./encryption-threat-model.md), which covers data **in transit** through the Cloudflare tunnel. This document covers data **at rest** in `~/.chroxy/credentials.json`.

## 1. What is stored

`~/.chroxy/credentials.json` holds the highest-value secrets Chroxy persists:

- BYOK provider API keys — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (and the legacy `anthropicApiKey` alias).
- The `CLAUDE_CODE_OAUTH_TOKEN`.

These exist so a GUI launch (Tauri/launchd, `cwd=/`, no shell rc) can authenticate without the operator's shell having exported the vars. The resolution order is always `process.env.<KEY>` → stored credential → unset, so an explicit shell export still wins.

Lower-sensitivity files (`mcp-trust.json`, `notification-prefs.json`, `push-tokens.json`, `byok-compose-state.json`) are **not** covered by this scheme; they remain `0600` plaintext.

## 2. Encryption design (envelope + keychain-backed key)

When an OS keychain is available, the whole JSON blob is encrypted with a random 32-byte data key that lives in the **OS keychain**, not beside the file.

```
~/.chroxy/credentials.json   (mode 0600, retained as defense-in-depth)
  { "v": 1, "alg": "nacl-secretbox", "nonce": "<base64>", "data": "<base64>" }

OS keychain
  service "chroxy-cred-key"  →  the base64 32-byte data key   (one entry)
```

- **Cipher:** `nacl.secretbox` (XSalsa20-Poly1305 AEAD) — the same primitive the transport layer uses; `tweetnacl` is already a dependency.
- **Nonce:** a fresh random 24-byte nonce per write.
- **Integrity:** the Poly1305 tag is verified on open. A wrong key or a flipped byte **fails closed** (the read surfaces a value-free error rather than returning garbage).
- **Keychain backends:** macOS Keychain (`security`) and Linux libsecret (`secret-tool`), via the existing `keychain.js` abstraction. The data-key entry uses a distinct service (`chroxy-cred-key`) from the primary bearer token (`chroxy` / `api-token`), so the two never collide.
- **Mode:** `0600` owner-only is kept even when encrypted — defense-in-depth, and the read path still refuses any other mode.
- **Migration:** `maybeEncryptCredentialsAtRest()` runs once at startup (mirroring the primary-token keychain migration) and encrypts a legacy plaintext file in place when a keychain is present. Best-effort — it never blocks boot.

## 3. Threat model — what this protects against

At-rest encryption raises the bar for an attacker who obtains the **file contents but not the keychain**:

- ✅ A stolen disk image / Time Machine or cloud **backup** that captures `~/.chroxy/` but not the login keychain.
- ✅ An errant `cat`, a shared dotfiles repo, a misconfigured sync tool, or a screen-share that exposes the file.
- ✅ Another local user reading the file **if** they cannot unlock your keychain (note: `0600` already blocks this for non-root users).

## 4. Threat model — what it does NOT protect against

This is the honest part. Encryption only adds real protection because the key is in the OS keychain. It is **not** a defense against an attacker who already controls your user session:

- ❌ **Malware / code running as your user.** It can read the keychain entry (or prompt-fatigue you into allowing it) exactly as Chroxy does, then decrypt. The secrets are recoverable.
- ❌ **A process that can call Chroxy's own code paths.** Decryption is by design available to the server.
- ❌ **root / full disk access on a running machine** with an unlocked keychain.
- ❌ **Key compromise.** Whoever has both the file and the `chroxy-cred-key` keychain entry has the secrets.

The guiding principle: a key stored **beside** the data it protects is obfuscation, not security. That is why Chroxy does **not** invent a machine-derived key (see §5).

## 5. Fallback where no keychain exists

On hosts with no usable keychain — Windows, or headless Linux without `secret-tool` — there is nowhere safe to put the data key. Chroxy deliberately falls back to the prior baseline: **`0600` plaintext**, and logs a one-time warning at startup:

> `~/.chroxy/credentials.json is stored as plaintext — no OS keychain available to encrypt it at rest`

It does **not** derive a key from machine identifiers and "encrypt" with that. Such a key is reconstructible on the same host that holds the file, so it would add only the *appearance* of protection — worse than honest plaintext, because it invites false confidence. Plaintext-`0600` is the same posture every other `~/.chroxy/` secret file uses.

> **Reconciliation (#5230).** #5154's original scope said the keychain-less case should *refuse to store* rather than fall back to plaintext. The shipped behavior — and the recorded maintainer decision — is the `0600` plaintext fallback above, for the reasons in this section: a key stored beside the file is obfuscation not security, refuse-to-store would lock out every Windows / headless-Linux-without-`secret-tool` operator entirely, and it matches the existing primary-token fallback in `keychain.js`. #5154's "refuse to store" wording is superseded by this document.

### Operator escape hatch

`CHROXY_CRED_DISABLE_KEYCHAIN=1` forces the plaintext path even when a keychain is present. Use it only when the keychain is unreliable (e.g. flaky `secret-tool` in a container) and you accept plaintext-at-rest. Setting it does **not** decrypt an already-encrypted file; future writes and the startup migration use plaintext.

**Caution — it disables keychain access entirely, including on read.** If the file is *already encrypted* and you set this flag, the read path can no longer reach the data key, so the store fails closed (`encrypted but its decryption key is unavailable`) and the credentials read as missing until you either unset the flag or re-enter them as plaintext. Only set it on a host whose `credentials.json` is still plaintext, or accept that you must re-enter the credentials.

## 6. Failure modes

- **Lost / different-machine keychain.** If the file is encrypted but the `chroxy-cred-key` entry is missing (restored to a new machine, wiped keychain), the read **fails closed**: it returns no value and surfaces a clear status error (`encrypted but its decryption key is unavailable`), rather than silently treating the repo as having no credentials. The operator re-enters the credentials, which generates a fresh key.
- **Malformed key.** A stored-but-wrong-length keychain entry is replaced on the next `getOrCreateMasterKey`; any prior ciphertext becomes undecryptable (acceptable — a corrupt key already means the secrets are unrecoverable).
- **Crash during write.** Writes are atomic (temp file → `chmod 0600` → rename, with a post-write mode re-check), so a crash leaves the prior file intact.

## 7. Recommendations

- Keep your OS keychain locked when away from the machine.
- Prefer exporting provider keys via your shell (`process.env`) for ephemeral/CI use; the store is for the GUI-launch gap.
- Treat `CHROXY_CRED_DISABLE_KEYCHAIN=1` as you would committing a plaintext secret — only on a host you already trust at the filesystem level.
