#!/bin/bash
# Build and install without launching. Local use defaults to the Debug client;
# the explicit bundled CI variant embeds its Release JavaScript and assets.
set -euo pipefail

project_dir="${1:?pass the Expo app directory}"
: "${DEVICE:?DEVICE must be set by the simulator preflight}"
: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"

if [ "${CHROXY_MAESTRO_RUNTIME_CACHE+x}" = x ] || [ "${CHROXY_MAESTRO_RUNTIME_VERSION+x}" = x ]; then
  echo '::error::Retired Maestro runtime inputs must be removed' >&2
  exit 1
fi
configuration=Debug
prebuild_args=(--platform ios)
build_args=()
if [ "${CHROXY_MAESTRO_BUILD_MODE+x}" = x ]; then
  if [ "$CHROXY_MAESTRO_BUILD_MODE" != bundled ] || { [ "${CI:-}" != 1 ] && [ "${CI:-}" != true ]; }; then
    echo '::error::Bundled build requires explicit bundled mode and CI' >&2
    exit 1
  fi
  configuration=Release
  prebuild_args=(--clean --platform ios)
  build_args=(CODE_SIGNING_ALLOWED=NO)
fi

cd "$project_dir"
npx expo prebuild "${prebuild_args[@]}"

workspace="$PWD/ios/Chroxy.xcworkspace"
if [ ! -d "$workspace" ]; then
  echo "::error::Expo prebuild did not create $workspace" >&2
  exit 1
fi

derived_data="$RUNNER_TEMP/chroxy-maestro-derived-data"
# Release runs Expo's generated export:embed build phase. Never launch Metro.
RCT_NO_LAUNCH_PACKAGER=true xcodebuild \
  -workspace "$workspace" -scheme Chroxy -configuration "$configuration" \
  -destination "id=$DEVICE" -derivedDataPath "$derived_data" "${build_args[@]+"${build_args[@]}"}" build

app="$derived_data/Build/Products/$configuration-iphonesimulator/Chroxy.app"
if [ ! -d "$app" ] || [ ! -f "$app/Info.plist" ]; then
  echo "::error::Xcode build did not produce the $configuration simulator app at $app" >&2
  exit 1
fi

bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$app/Info.plist")"
if [ "$bundle_id" != 'com.blamechris.chroxy' ]; then
  echo "::error::Unexpected built app bundle ID: $bundle_id" >&2
  exit 1
fi

xcrun simctl install "$DEVICE" "$app"
installed_app="$(xcrun simctl get_app_container "$DEVICE" "$bundle_id" app)"
if [ ! -d "$installed_app" ]; then
  echo "::error::simctl did not confirm the installed app container" >&2
  exit 1
fi
echo "Installed $bundle_id on $DEVICE without launching it"
