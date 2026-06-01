# Release Signing

This document describes the GitHub Actions secrets used by `release.yml` to sign, notarize, and publish the Tauri desktop builds. The release workflow is designed to **degrade gracefully** — if a given secret is unset, the corresponding signing/notarization step is skipped automatically and the build still produces an unsigned artifact.

## Tauri updater signing (cross-platform)

Used by both macOS and Windows desktop jobs to sign the auto-update artifacts (`.app.tar.gz.sig`, `.msi.zip.sig`, `latest.json`).

| Secret | Required? | Notes |
|--------|-----------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Required (paired with password) | The full minisign-style private key as emitted by `cargo tauri signer generate -w` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Required (paired with key) | **Must be non-empty.** Empty-password keys trip Windows `minisign-verify` on `windows-latest` runners. |

Both must be set and non-empty for signing to run. If either is missing, the workflow passes `-c '{"bundle":{"createUpdaterArtifacts":false}}'` to `cargo tauri build` to suppress the updater bundle entirely. The MSI / DMG / `.app` still build and upload; the `.sig` / `latest.json` outputs do not. The committed `plugins.updater.pubkey` in `tauri.conf.json` remains untouched — only the runtime artifact generation is skipped.

### Cross-platform feed assembly

The `desktop-macos` and `desktop-windows` jobs each emit their own `latest.json` containing only the platform entries they built. The `github-release` job then downloads both artifacts and runs `scripts/merge-updater-feeds.mjs` to combine them into a single `artifacts/updater/latest.json` whose `platforms` map covers `darwin-aarch64`, `darwin-x86_64`, and `windows-x86_64`. The merged file is what gets attached to the GitHub Release and consumed by the auto-updater endpoint configured in `tauri.conf.json`. If updater signing is disabled for one of the jobs (e.g. signing secrets are only configured for macOS), the merge step still publishes the surviving platform; if neither job produced a feed, no `latest.json` is attached and installed clients keep their existing update endpoint until the next release.

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
