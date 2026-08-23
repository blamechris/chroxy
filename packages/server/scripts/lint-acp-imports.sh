#!/usr/bin/env bash
# Wrapper for the Node-based linter. See `lint-acp-imports.mjs` for the
# actual implementation. Kept as a shell entry point so CI can
# `run: scripts/lint-acp-imports.sh` without worrying about the Node
# interpreter path on the runner image.
#
# `--min-files` is a FLOOR, not a count. It only ever fails closed: if the
# walk breaks -- a skip-list entry that swallows a real directory, a checkout
# that resolved to nothing -- the lint would otherwise walk few or zero files
# and report a clean tree, which is indistinguishable from actually being
# clean. packages/server currently has ~897 scannable files (.js/.mjs/.cjs/
# .ts/.mts/.cts/.tsx/.jsx, git-known); 600 leaves headroom for ordinary
# deletions while still catching a collapse -- losing all of src/ (304 files)
# or all of tests/ (574 files) alone would each trip it.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node ./scripts/lint-acp-imports.mjs --min-files 600 "$@"
