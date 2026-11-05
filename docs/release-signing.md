# Release Signing

This document describes the GitHub Actions secrets used by `release.yml` to sign, notarize, and publish the Tauri desktop builds. The release workflow is designed to **degrade gracefully** — if a given secret is unset, the corresponding signing/notarization step is skipped automatically and the build still produces an unsigned artifact.

## Tauri updater signing (cross-platform)

Used by both macOS and Windows desktop jobs to sign the auto-update payloads and publish the update feed (`latest.json`).

| Secret | Required? | Notes |
|--------|-----------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Required (paired with password) | The full minisign-style private key as emitted by `cargo tauri signer generate -w` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Required (paired with key) | **Must be non-empty.** Empty-password keys trip Windows `minisign-verify` on `windows-latest` runners. |

Both must be set and non-empty for signing to run. If either is missing, the workflow passes `-c '{"bundle":{"createUpdaterArtifacts":false}}'` to `cargo tauri build` to suppress the updater bundle entirely. The MSI / DMG / `.app` still build and upload; the `.sig` / `latest.json` outputs do not. The committed `plugins.updater.pubkey` in `tauri.conf.json` remains untouched — only the runtime artifact generation is skipped.

### Artifact layout (Tauri v2, `createUpdaterArtifacts: true`)

The updater payload is whatever the platform installer is, plus a detached signature:

| Platform | Payload | Signature |
|----------|---------|-----------|
| macOS | `*.app.tar.gz` (one universal archive, used for both `darwin-aarch64` and `darwin-x86_64`) | `*.app.tar.gz.sig` |
| Windows | the raw `*.msi` | `*.msi.sig` |

There is no `.msi.zip` (that is the `"v1Compatible"` layout). A `.sig` file is the base64 of a minisign signature box, and that same string is the `signature` field in `latest.json`.

### Cross-platform feed assembly

`cargo tauri build` writes the payload and its `.sig` but **never** a `latest.json` (that file comes from `tauri-action` or by hand). So each desktop job builds its own fragment with `scripts/build-updater-feed.mjs` from the payload and `.sig`, pointing at the tag's release asset (`https://github.com/<repo>/releases/download/v<version>/<file>`), then verifies it in-job (see below). Asset file names must stay within `[A-Za-z0-9._-]`: GitHub renames other characters on upload, which would make the feed URL a 404, and `build-updater-feed.mjs` refuses them. Each fragment contains only the platform entries that job built. The `github-release` job then downloads both artifacts and runs `scripts/merge-updater-feeds.mjs` to combine them into a single `artifacts/updater/latest.json` whose `platforms` map covers `darwin-aarch64`, `darwin-x86_64`, and `windows-x86_64`. The merged file is what gets attached to the GitHub Release and consumed by the auto-updater endpoint configured in `tauri.conf.json`. If updater signing is disabled for one of the jobs (e.g. signing secrets are only configured for macOS), the merge step still publishes the surviving platform; if neither job produced a feed, no `latest.json` is attached and installed clients keep their existing update endpoint until the next release.

### Release-time verification gate

`scripts/verify-updater-feed.mjs` checks a feed the way an installed client does: for every `platforms` entry it finds the asset the URL names (exactly one match by file name), then verifies the embedded signature over those bytes against the `plugins.updater.pubkey` committed in `tauri.conf.json`, using `scripts/lib/minisign-verify.mjs` (pure Node). It also checks the trusted-comment signature.

The verifier **never accepts a signature the Tauri updater client rejects**. It parses encodings exactly as strictly as the client: canonical base64 only (no whitespace, no non-zero trailing bits, correct padding), strict UTF-8, Rust `lines()` splitting with blank lines never skipped (fields are positional). It is **deliberately stricter** than the client in three ways: only the prehashed `ED` signature algorithm is accepted (the client also takes legacy `Ed`), the `untrusted comment:` / `trusted comment: ` prefixes are required, and an identity or all-zero public key is refused. It does not claim to be "exactly what the client checks"; the differential check against the client's own crates lives in the PR evidence, and the unit tests pin each strictness.

Options used by the release:

- `--require-platform KEY` (repeatable): the feed must contain that platform. The release job requires `darwin-aarch64`, `darwin-x86_64` and `windows-x86_64`, so a feed that silently lost a platform fails.
- `--expect-url-prefix P`: every url must be `P` followed by exactly the asset name (no further `/`, query or fragment). The desktop jobs pin `https://github.com/<repo>/releases/download/v<version>/`; the release job pins the same with the tag.
- `--expect-version V`: the feed `version` must equal it (the release job passes the tag without the `v`).
- `--require-signed-version`: the signature's trusted comment must carry `version:<feed version>`.

**Version binding.** tauri-cli 2.12 and later write `version:<app version>` into the signature's trusted comment, which stops a validly signed old payload from being replayed under a new version number. `cargo tauri signer sign` drops it unless given `--app-version`. Each desktop job probes the installed CLI once (`Detect signed-version support`), records `SIGNED_VERSION_SUPPORTED`, passes `--app-version` to the Windows re-sign when supported, and adds `--require-signed-version` to its in-job verification only when supported. With an older CLI the signature carries no signed version and the check is skipped (the feed version is still compared to the tag).

**Fail closed.** In `github-release`, when `TAURI_SIGNING_PRIVATE_KEY` and its password are both configured, a missing merged `latest.json` is an error (not a notice) and the verify step adds the required platforms and URL prefix above. Without those secrets there legitimately is no feed, and the step stays a notice. The verification runs in each desktop job right after the fragment is written, and again on the merged feed before the release is created (`scripts/__tests__/updater-feed.test.mjs`, with wiring pinned by `packages/server/tests/release-updater-feed-wiring.test.js`).

### Generating a new key

```bash
cd packages/desktop
cargo tauri signer generate -p 'YOUR_STRONG_PASSWORD' -w ~/.tauri/chroxy-updater.key
```

This writes the encrypted private key to `~/.tauri/chroxy-updater.key` and the public key to `~/.tauri/chroxy-updater.key.pub`.

### Updating the secrets

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/chroxy-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body 'YOUR_STRONG_PASSWORD'
```

Skip the next paragraph if you are only setting a password on an existing key — the pubkey in `tauri.conf.json` stays valid. Only update the pubkey if you generated a fresh keypair.

If you regenerated the keypair (not just changed the password), also update the `plugins.updater.pubkey` field in `packages/desktop/src-tauri/tauri.conf.json` with the contents of `~/.tauri/chroxy-updater.key.pub` (base64-encoded, single line). Commit that change — it ships with the app and is what the auto-updater uses to verify updates. **⚠ Rotating the keypair invalidates auto-update for any already-installed app**; only do this pre-1.0 or as part of a planned forced-reinstall release.

## macOS code signing & notarization

Used by the `desktop-macos` job to produce a Gatekeeper-trusted, notarized `.dmg` and `.app`.

| Secret | Required for notarization | Notes |
|--------|---------------------------|-------|
| `APPLE_SIGNING_IDENTITY` | Recommended | E.g. `Developer ID Application: Your Name (TEAMID)`. Defaults to `-` (adhoc signing) when unset. |
| `APPLE_TEAM_ID` | Yes | 10-char team ID from https://developer.apple.com/account |
| `APPLE_ID` | Yes | Your Apple Developer account email |
| `APPLE_PASSWORD` | Yes | **App-specific password** from https://account.apple.com/account/manage → Sign-in and Security → App-Specific Passwords. NOT your Apple ID password. |
| `APPLE_CERTIFICATE` | Yes (for non-adhoc signing) | base64-encoded `.p12` export of your Developer ID Application certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Yes (paired with above) | The password you set when exporting the `.p12` from Keychain |

**All five of `APPLE_TEAM_ID`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_CERTIFICATE`, and `APPLE_CERTIFICATE_PASSWORD` must be set and non-empty for notarization to run.** If any are missing, the workflow skips the notarization environment entirely and the build produces an adhoc-signed artifact (which won't pass Gatekeeper on a fresh-installed Mac, but is fine for local installs and CI smoke tests). `APPLE_SIGNING_IDENTITY` defaults to `-` (adhoc signing) when unset, regardless of the other secrets.

### Getting your Team ID

Log in to https://developer.apple.com/account — your 10-character Team ID is shown in the top-right under your name and in **Membership Details**.

### Generating an app-specific password

1. Sign in to https://account.apple.com/account/manage
2. Click **Sign-in and Security** → **App-Specific Passwords**
3. Generate a new one labeled e.g. "Chroxy CI Notarization"
4. Copy the `xxxx-xxxx-xxxx-xxxx` value immediately (it's only shown once)

### Exporting your Developer ID certificate

1. Open **Keychain Access** on macOS
2. Find **Developer ID Application: Your Name (TEAMID)** under "login" keychain
3. Right-click → **Export** → save as `.p12`, set a password during export
4. Base64-encode for the secret:
   - **macOS** (BSD `base64`): `base64 -i cert.p12 | pbcopy`
   - **Linux** (GNU `base64`): `base64 -w0 cert.p12 | xclip -selection clipboard`

### Setting the secrets

```bash
gh secret set APPLE_TEAM_ID --body 'ABCD123456'
gh secret set APPLE_ID --body 'your@email.com'
gh secret set APPLE_PASSWORD --body 'xxxx-xxxx-xxxx-xxxx'
gh secret set APPLE_SIGNING_IDENTITY --body 'Developer ID Application: Your Name (ABCD123456)'
gh secret set APPLE_CERTIFICATE < <(base64 -i ~/path/to/cert.p12)
gh secret set APPLE_CERTIFICATE_PASSWORD --body 'your-p12-password'
```

## Windows Authenticode code signing (SmartScreen)

Used by the `desktop-windows` job to Authenticode-sign the standalone `.msi` so a
first-time install no longer trips the Windows SmartScreen "Windows protected your
PC" dialog (#3808). This is **separate from Tauri updater signing** above: the
updater secrets minisign the auto-update payload (`.msi.sig`), while these
secrets Authenticode-sign the installer that Windows itself trusts.

We use [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)
(~$10/mo, key managed by Azure — no cert files or HSM to handle) via the official
`azure/trusted-signing-action`.

| Secret | Required? | Notes |
|--------|-----------|-------|
| `AZURE_TENANT_ID` | Yes | Directory (tenant) ID of the Entra ID tenant holding the signing App Registration |
| `AZURE_CLIENT_ID` | Yes | Application (client) ID of that App Registration |
| `AZURE_CLIENT_SECRET` | Yes | A client secret generated for the App Registration |
| `TRUSTED_SIGNING_ENDPOINT` | Yes | Region endpoint of the Trusted Signing account, e.g. `https://eus.codesigning.azure.net` |
| `TRUSTED_SIGNING_ACCOUNT` | Yes | The Trusted Signing **account** name |
| `TRUSTED_SIGNING_CERT_PROFILE` | Yes | The **certificate profile** name within that account |

**All six must be set and non-empty for signing to run.** If any is missing, the
`Detect Authenticode signing` step sets `SIGN_ENABLED=false` and the `Sign MSI`
step is skipped — the MSI still builds and uploads, just unsigned (SmartScreen
warning persists, as it does today). No partial state.

**Ordering.** With `createUpdaterArtifacts: true` the Windows updater payload is the
raw `.msi`, so Authenticode signing (which rewrites the file) must come *before* the
updater signature is final. The job therefore runs: build (minisigns the `.msi`) ->
`Sign MSI (Azure Trusted Signing)` -> `Re-sign MSI for the updater`
(`cargo tauri signer sign` overwrites `.msi.sig` over the Authenticode-signed bytes)
-> write and verify the feed (the re-sign passes `--app-version` when the CLI supports it). The re-sign step runs only when both updater signing and
Authenticode signing are enabled; if only updater signing is on, the build's signature
is already correct. The in-job verification fails the job if the `.msi` in the feed does
not match its signature (the failure #8906 describes).

> **Known gap:** only the `.msi` container is Authenticode-signed. The executables
> packaged *inside* the MSI are not signed by this job; that would require moving
> signing into Tauri's `bundle.windows.signCommand` so each binary is signed during
> bundling. The updater payload and the downloaded installer are now the same
> Authenticode-signed file.

### One-time Azure setup

1. Create a **Trusted Signing account** in the Azure portal (Trusted Signing →
   Create), choosing the region nearest your CI. Note the account name and the
   account endpoint shown on the overview page.
2. Complete **identity validation** (Public Trust → add an Identity Validation
   request). This is the gate that takes time — an organization validation can
   take a few business days. SmartScreen reputation only applies once validation
   is approved.
3. Create a **Certificate Profile** (Public Trust type) under the account. Note
   its name.
4. Create an **App Registration** in Entra ID, generate a **client secret**, and
   note the tenant ID + client ID.
5. Grant that App Registration the **Trusted Signing Certificate Profile Signer**
   role on the Trusted Signing account (Access control (IAM) → Add role
   assignment), so it's allowed to sign with the profile.

### Setting the secrets

```bash
gh secret set AZURE_TENANT_ID --body '00000000-0000-0000-0000-000000000000'
gh secret set AZURE_CLIENT_ID --body '00000000-0000-0000-0000-000000000000'
gh secret set AZURE_CLIENT_SECRET --body 'your-client-secret'
gh secret set TRUSTED_SIGNING_ENDPOINT --body 'https://eus.codesigning.azure.net'
gh secret set TRUSTED_SIGNING_ACCOUNT --body 'your-signing-account'
gh secret set TRUSTED_SIGNING_CERT_PROFILE --body 'your-cert-profile'
```

### Rotating the cert / credentials

The certificate itself is managed and auto-renewed by Azure — there is no `.p12`
or HSM key to rotate. What expires is the **App Registration client secret**: when
it lapses, regenerate it in Entra ID and re-run `gh secret set AZURE_CLIENT_SECRET`.
Nothing in the repo changes.

### Verifying

After approval + secrets are set, dispatch a release and confirm the
`Detect Authenticode signing` step logs `signing enabled`. On a clean Windows 11
box, download the released `.msi` and confirm it installs without the SmartScreen
"Windows protected your PC" dialog; `signtool verify /pa chroxy_*.msi` (or
right-click → Properties → Digital Signatures) should show a valid Microsoft ID
Verified CS chain.

## Discord notifications (optional)

Used by `repo-relay.yml` to mirror PR / issue / release events to Discord.

| Secret | Required? | Notes |
|--------|-----------|-------|
| `DISCORD_BOT_TOKEN` | Yes (for relay to fire) | Bot token from the Discord Developer Portal |
| `DISCORD_CHANNEL_PRS` | Yes | Channel ID for PR notifications |
| `DISCORD_CHANNEL_ISSUES` | Optional | Defaults to `DISCORD_CHANNEL_PRS` |
| `DISCORD_CHANNEL_RELEASES` | Optional | Defaults to `DISCORD_CHANNEL_PRS` |

## Verifying the setup

After setting any secrets, dispatch the release workflow manually to verify:

```bash
gh workflow run release.yml --ref main -f confirm=release
```

Then watch the run and look for the "Configure signing env" step output. It logs which signing/notarization paths are enabled or disabled, with the reason if disabled.
