#!/usr/bin/env bash
# Wrapper for the Node-based linter. See `lint-entry-point-guard.mjs` for the
# actual implementation. Kept as a shell entry point so CI can
# `run: scripts/lint-entry-point-guard.sh` without worrying about the Node
# interpreter path on the runner image.
#
# The walk is REPO-WIDE, not packages/server — a fourth hand-rolled guard is
# just as likely to appear in `scripts/` or another package, and two of the
# three sanctioned copies are outside `src/` already (#7235).
#
# `--min-files` is a FLOOR, not a count. It only ever fails closed: if the walk
# breaks — a skip-list entry that swallows a real directory, a checkout that
# resolved to nothing — the lint would otherwise walk few or zero files and
# report a clean tree, which is indistinguishable from actually being clean.
# The tree walks ~1970 files today; 1500 leaves room for ordinary deletions
# while still catching a collapse.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node ./scripts/lint-entry-point-guard.mjs --min-files 1500 "$@"
