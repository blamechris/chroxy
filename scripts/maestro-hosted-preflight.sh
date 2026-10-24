#!/bin/bash
# Verify the hosted macOS image still has the toolchain Expo SDK 54 needs.
# Keep this before npm ci: a missing Simulator.app otherwise fails after pods.
set -euo pipefail

if [ -z "${DEVELOPER_DIR:-}" ] || [ ! -d "$DEVELOPER_DIR/Applications/Simulator.app" ]; then
  echo "::error::Xcode 16.4 Simulator.app is missing under DEVELOPER_DIR=${DEVELOPER_DIR:-unset}" >&2
  exit 1
fi

xcode_version="$(xcodebuild -version | head -1)"
if [ "$xcode_version" != 'Xcode 16.4' ]; then
  echo "::error::Expected Xcode 16.4, found $xcode_version (DEVELOPER_DIR=$DEVELOPER_DIR)" >&2
  exit 1
fi

# Expo's prerequisite uses this LaunchServices lookup, not just simctl.
if ! simulator_id="$(osascript -e 'id of app "Simulator"' 2>&1)" ||
   [ "$simulator_id" != 'com.apple.iphonesimulator' ]; then
  echo "::error::Expo cannot resolve Simulator.app through LaunchServices: $simulator_id" >&2
  exit 1
fi

if ! devices_json="$(xcrun simctl list devices available -j)"; then
  echo '::error::simctl could not list available devices' >&2
  exit 1
fi
device="$(jq -er '[.devices["com.apple.CoreSimulator.SimRuntime.iOS-18-5"][]? | select(.name == "iPhone 16 Pro" and .isAvailable == true)][0].udid // empty' <<< "$devices_json")" || {
  echo '::error::No available iPhone 16 Pro with iOS 18.5 on this runner' >&2
  exit 1
}

echo "DEVICE=$device" >> "${GITHUB_ENV:?GITHUB_ENV must be set}"
echo "Using $xcode_version and iPhone 16 Pro / iOS 18.5 ($device)"
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b
