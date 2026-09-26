#!/usr/bin/env bash
# Wrapper for the Node-based linter. See `lint-nofollow-nonblock.mjs` for the
# actual implementation. Kept as a shell entry point so CI can
# `run: scripts/lint-nofollow-nonblock.sh` without worrying about the Node
# interpreter path on the runner image.
#
# `--min-files` is a FLOOR, not a count (see docs/false-safety-guards.md — a
# walk that resolves to zero or few files must fail loudly, not report a
# clean tree). The two default trees are 330 (packages/server/src) + 5
# (packages/claude-hooks/src) = 335 files today (`git ls-files -- packages/
# server/src packages/claude-hooks/src | grep -c '\.js$'`); 280 leaves
# headroom for ordinary deletions while still catching a collapse of either
# tree.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node ./scripts/lint-nofollow-nonblock.mjs --min-files 280 "$@"
