#!/usr/bin/env bash
# Wrapper for the Node-based linter. See `lint-config-dir.mjs` for the actual
# implementation. Kept as a shell entry point so CI can
# `run: scripts/lint-config-dir.sh` without worrying about the Node interpreter
# path on the runner image.
#
# `--min-files` is a FLOOR, not a count (#7239). It only ever fails closed: if
# the walk breaks — a renamed source root, a filter that stops matching, a
# scan-roots edit that silently resolves to nothing — the lint would otherwise
# scan few or zero files and report a clean tree, which is indistinguishable
# from actually being clean. The tree scans ~304 files today; 250 leaves room
# for ordinary deletions while still catching a collapse.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node ./scripts/lint-config-dir.mjs --min-files 250 "$@"
