# Expo SDK 55 native upgrade

The mobile app uses Expo SDK 55 (`expo@55.0.32`, React Native `0.83.10`,
React `19.2.0`). Rebuild the development client before running this version.
The generated `ios/` and `android/` directories are ignored: app configuration
and config plugins remain the sources for Continuous Native Generation (CNG).

## Why SDK 55

This is the first SDK after 54 whose supported dependency graph clears the
image-size and PostCSS advisories tracked in #7178, without transitive overrides
or `npm audit fix --force`:

| SDK line | Published parent path | Result |
| --- | --- | --- |
| Latest 54 (`54.0.38`) | `@expo/metro-config@54.0.17` → `postcss@~8.4.32` | Cannot resolve patched PostCSS 8.5.23 or later |
| 55 (`55.0.32`) | `@expo/metro-config@55.0.27` → `postcss@^8.5.14` | Lock resolves PostCSS 8.5.31 |
| 55 (`55.0.32`) | `@expo/metro@55.1.2` → `metro@0.83.8` | Metro no longer depends on image-size; none remains in the lock |

The former root `expo-font@14.0.12` override is removed. SDK 55 resolves one
native font module, `expo-font@55.0.8`, through Expo's supported ranges.
The app's React and Jest renderer both use `19.2.0`; the dashboard retains its
own React version range. Expo's bundled native-module map is the version source
for the app, rather than the newest individual package releases.

`node-forge@1.4.0` remains the newest published version at the time of this
upgrade and still has an open advisory. This upgrade does not clear that alert
or the separate Agent SDK dependency work.

## Remaining Expo CLI Zod advisory

The SDK 55 CLI introduces a nested `zod@3.25.76` through
`@expo/cli@55.0.37` → `zod@^3.25.76`. It is covered by
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
whose affected range is below `4.6.6`. The latest published SDK 56, 57 and 58
CLIs also require this Zod 3 range; upgrading further does not supply a
supported fix. The root Zod `4.6.7` used by Chroxy's server and protocol remains
patched and unchanged.

In the installed SDK 55 CLI, Zod imports are limited to
`DevToolsPlugin.schema.js` and `createMCPDevToolsExtensionSchema.js`. The array
schemas parse autolinked local development-tool plugin descriptors and results
from locally spawned plugin entry points. MCP command parameters use primitive
string, number and boolean schemas. Querying Expo's actual
`DevToolsPluginManager` for this app returns no plugins. These findings bound
the current inputs to the development-tool integration; they do not remove the
published advisory or prove safety for subsequently installed plugins.

Keep this advisory open under #7178. No dependency override, advisory
suppression or claim of a fully clean audit is part of this upgrade. Treating
this remaining alert as nonblocking requires independent review of that
containment. The upgrade removes the two image-size and four PostCSS advisory
records but introduces this one Zod record in the dependency audit.

## Native compatibility

SDK 55 requires the New Architecture and Xcode 26 or later. The app already
used the default New Architecture setting in SDK 54. Hosted Maestro jobs pin
Xcode 26.2 and an iPhone 16 Pro running iOS 26.2. Use Node 22.13 or later within
the Node 22 line for Expo commands.

The app retains `expo-speech-recognition@3.1.2` and
`expo-live-activity@0.4.2`. Both declare unrestricted Expo/React Native peers,
but their published development manifests target SDK 54; peer declarations
alone do not prove native compatibility. Speech recognition's next major is
for SDK 56. The Live Activity repository was archived in June 2026 and marks
the library deprecated. Its existing native integration remains in this
upgrade, with fresh native compilation required; replacing it with
`expo-widgets` is separate work.

Attachment reads use the documented `expo-file-system/legacy` entry point.
The root `readAsStringAsync` compatibility export throws at runtime. Clipboard
calls use `setStringAsync` and do not use the listener `content` field removed
in SDK 55.

Hosted Metro startup scopes Node's `--dns-result-order=ipv4first` option to
that step and probes `127.0.0.1:8081`. SDK 55 binds `localhost` but normalizes
the advertised launch asset to `127.0.0.1`; an IPv6-first localhost lookup can
otherwise make readiness succeed while the simulator and bundle warmer cannot
reach the IPv4 asset. The warmer still fetches the manifest and its complete
JavaScript launch asset before UI flows start.

## Runtime versions and updates

`runtimeVersion.policy` is now `fingerprint`. Expo derives the runtime from
native inputs, including native dependencies and configuration. Existing SDK 54
builds use runtime `0.11.7`; a fingerprint runtime cannot match that version.
New SDK 55 JavaScript updates therefore require a new compatible native build,
even though the monorepo's product version remains `0.11.7`.

Build and test the new client before publishing updates. An OTA update alone
does not perform this SDK migration. Keep the generated native directories out
of commits and regenerate them when changing the SDK. For a clean native
rebuild, remove only this checkout's generated `packages/app/ios` and
`packages/app/android` directories, then run the appropriate command:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm ci
cd packages/app
npx expo install --check
npx expo-doctor@1.18.18
npx expo run:ios
# Or, with an Android SDK and JDK configured:
npx expo run:android
```

Pinned Expo Doctor improves from 15/17 to 16/17 checks in this upgrade. The
remaining warning is the existing unmaintained `expo-live-activity` metadata;
no additional warning suppression is introduced.

## Hosted development-client startup

The hosted iOS job resolves the current fingerprint once after installation,
checks that the installed app uses `file:fingerprint`, and compares the result
with `EXUpdates.bundle/fingerprint` in that actual installed app. Preparation
fails before Metro starts if either fingerprint is missing, malformed or
mismatched. Only a matching value is published as a workflow step output.

The Metro step explicitly enables reuse of that exact iOS runtime through
`app.config.js`. The marker and verified value are scoped to that step; both
are required before launch. Ordinary configuration, production builds and
updates retain the automatic fingerprint policy and the existing remote EAS
version authority. The immutable CI checkout must be rebuilt if native inputs
change before starting another Metro session.

This avoids [Expo's uncached per-request fingerprint calculation](https://github.com/expo/expo/issues/46415),
which exceeded the iOS dev launcher's ten-second manifest timeout on the hosted
runner. It uses Expo's dynamic configuration and runtime-version interfaces;
no vendor package is patched.

The development menu's floating Tools button defaults to off on both platforms
so it cannot cover header controls. iOS uses its Info.plist preference; the
Android config plugin writes the supported application metadata preference.
Shake, gesture and keyboard menu access remain enabled;
the Tools button can still be enabled from the menu. The shared Maestro
password-sheet helper declines only the observed `Save Password?` prompt after
manual fixture-token entry, before requiring the existing authenticated UI.

The hosted job uses the standard `macos-15-intel` image while retaining Xcode
26.2 and iOS 26.2. GitHub lists this image as four Intel CPUs and 14 GB RAM,
compared with three M1 CPUs and 7 GB for `macos-15`. This is a controlled
host-environment correction after repeated native launch, manifest-request and
XCTest startup delays; the artifacts do not prove memory pressure caused them.
The upgraded app client passed all 26 flows locally without retries before
this runner/diagnostic correction.
The hosted Intel build and complete flow inventory remain required acceptance.

Three narrow Expo DEBUG namespaces record manifest, runtime-resolver and device
persistence phases. A one-shot hardware/memory snapshot after bundle warmup
records the loaded host immediately before Maestro. Each command has a
five-second ceiling; the snapshot adds no background monitor. The readiness helper rejects the
exact Expo project-load error before treating Reload as a development-menu
action, then still requires a real app anchor.

## References

- [GitHub hosted runner hardware](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Intel macOS 15 image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md)
- [SDK 55 release notes](https://expo.dev/changelog/sdk-55)
- [Incremental SDK upgrade instructions](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/)
- [Runtime policies and incompatible updates](https://docs.expo.dev/eas-update/runtime-versions/)
- [SDK 55 FileSystem API and legacy entry point](https://docs.expo.dev/versions/v55.0.0/sdk/filesystem/)
- [Speech recognition releases](https://github.com/jamsch/expo-speech-recognition/blob/main/CHANGELOG.md)
- [Live Activity library status](https://github.com/software-mansion-labs/expo-live-activity)
