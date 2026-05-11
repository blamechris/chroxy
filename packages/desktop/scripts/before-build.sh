#!/usr/bin/env bash
# before-build.sh — Cross-platform beforeBuildCommand for cargo tauri build.
#
# Called from tauri.conf.json's `beforeBuildCommand`. Runs from the
# `packages/desktop` directory (Tauri's invocation cwd).
#
# This script exists so the same bash invocation works on every host
# Tauri targets — macOS/Linux use the system bash, Windows uses Git
# Bash (preinstalled on GitHub `windows-latest` runners and on most
# dev boxes that have `git` installed). Tauri's underlying shell
# differs per platform (sh on POSIX, cmd.exe on Windows), so wrapping
# the actual work in a bash script means we don't have to maintain
# per-platform overlays in tauri.conf.json.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DASHBOARD_DIR="$(cd "$DESKTOP_DIR/../dashboard" && pwd)"

cd "$DASHBOARD_DIR"
TAURI_ENV_PLATFORM= npm run build

cd "$DESKTOP_DIR"
bash scripts/bundle-server.sh
