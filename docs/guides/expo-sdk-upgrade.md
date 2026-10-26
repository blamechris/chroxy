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

## Hosted bundled acceptance and local development

The hosted iOS gate builds a Release simulator client with Expo's generated
embedded JavaScript and assets. It runs the same canonical 26 flows, assertions,
per-flow limits and built-in retry policy. The standard ARM `macos-15` runner
retains Xcode 26.2 and iOS 26.2. This is a controlled bundled-build environment
change; performance and full hosted acceptance must be measured on this runner.
A one-shot, bounded hardware/memory snapshot records the loaded host immediately
before Maestro.

The explicit CI build variant (`CI=1 CHROXY_MAESTRO_BUILD_MODE=bundled`) changes
only `updates.checkAutomatically` to Expo's supported `NEVER` setting. Updates
remain enabled with the same URL and automatic fingerprint policy. This variant
has its own fingerprint: it exercises the upgraded native module graph and
embedded app behavior, while separate configuration tests verify that ordinary
production/EAS configuration remains unchanged. It does not exercise production
update delivery. Existing remote EAS version authority is unchanged. Invalid
modes and retired runtime-reuse inputs fail before launch.

After installation, the verifier reads the actual app's identity, update policy,
local-only ATS settings, nonempty embedded bundle/manifest and fingerprint
resource. It resolves the current variant's fingerprint and requires an exact
match before publishing the runtime output consumed by the canonical runner.
The bundled launcher requires that verified output and an explicit CI marker.
The workflow verifies port 8081 has no Metro/proxy listener before and after the
suite; it neither starts a development server nor kills an unrelated listener.

Ordinary local helpers and standalone flows retain the development-client
launch default. The SDK 55 CLI still starts an expo-updates runtime resolver
child on every manifest request, even with an explicit runtime value. Hosted
measurements exceeded the native launcher's ten-second timeout after earlier
requests succeeded. The remaining development-client limitation is tracked in
[#8840](https://github.com/blamechris/chroxy/issues/8840); the bundled gate does
not fix or close it. No vendor patch, manifest proxy or runtime-match bypass is
used. Local development can continue with `npx expo run:ios` and Metro. The
existing readiness helper rejects Expo's exact project-load error before
handling a development-menu Reload action and requires a real app anchor.

The development menu's floating Tools button defaults to off on both platforms
so it cannot cover header controls. iOS uses its Info.plist preference; the
Android config plugin writes the supported application metadata preference.
Shake, gesture and keyboard menu access remain enabled; the Tools button can
still be enabled from the menu. The shared Maestro password-sheet helper
declines only the observed `Save Password?` prompt after manual fixture-token
entry, before requiring the existing authenticated UI.

The upgraded app client passed all 26 flows locally without retries before this
bundled acceptance correction. Fresh bundled local and hosted acceptance must
be recorded separately; a successful bundled run does not validate the hosted
development-client path.

## References

- [GitHub hosted runner hardware](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [ARM macOS 15 image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md)
- [SDK 55 release notes](https://expo.dev/changelog/sdk-55)
- [Incremental SDK upgrade instructions](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/)
- [Runtime policies and incompatible updates](https://docs.expo.dev/eas-update/runtime-versions/)
- [SDK 55 FileSystem API and legacy entry point](https://docs.expo.dev/versions/v55.0.0/sdk/filesystem/)
- [Speech recognition releases](https://github.com/jamsch/expo-speech-recognition/blob/main/CHANGELOG.md)
- [Live Activity library status](https://github.com/software-mansion-labs/expo-live-activity)
