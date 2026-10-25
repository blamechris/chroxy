#!/bin/bash
# Build and install the Debug dev client without launching it. Maestro opens
# the dev-client link only after Metro's iOS bundle has been warmed.
set -euo pipefail

project_dir="${1:?pass the Expo app directory}"
: "${DEVICE:?DEVICE must be set by the simulator preflight}"
: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"

cd "$project_dir"
npx expo prebuild --platform ios

workspace="$PWD/ios/Chroxy.xcworkspace"
if [ ! -d "$workspace" ]; then
  echo "::error::Expo prebuild did not create $workspace" >&2
  exit 1
fi

derived_data="$RUNNER_TEMP/chroxy-maestro-derived-data"
# Match Expo's simulator defaults: generated workspace/scheme, Debug, selected
# simulator, and no packager launched by the Xcode build phase. Debug simulator
# builds do not set SKIP_BUNDLING in Expo's XcodeBuild.getProcessOptions.
RCT_NO_LAUNCH_PACKAGER=true xcodebuild \
  -workspace "$workspace" -scheme Chroxy -configuration Debug \
  -destination "id=$DEVICE" -derivedDataPath "$derived_data" build

app="$derived_data/Build/Products/Debug-iphonesimulator/Chroxy.app"
if [ ! -d "$app" ] || [ ! -f "$app/Info.plist" ]; then
  echo "::error::Xcode build did not produce the Debug simulator app at $app" >&2
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
