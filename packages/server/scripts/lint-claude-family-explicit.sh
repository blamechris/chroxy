#!/usr/bin/env bash
# Wrapper for the Node-based linter. See `lint-claude-family-explicit.mjs`
# for the actual implementation. Kept as a shell entry point so CI can
# `run: scripts/lint-claude-family-explicit.sh` without worrying about the
# Node interpreter path on the runner image.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node ./scripts/lint-claude-family-explicit.mjs "$@"
