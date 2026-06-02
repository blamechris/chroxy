#!/usr/bin/env bash
# Wrapper for the Node-based linter. See `lint-logger-session-scoping.mjs`
# for the actual implementation. Kept as a shell entry point so CI can
# `run: scripts/lint-logger-session-scoping.sh` without worrying about
# the Node interpreter path on the runner image.
#
# Issue #4792 — durable follow-up to #4787 / #4793.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node ./scripts/lint-logger-session-scoping.mjs "$@"
