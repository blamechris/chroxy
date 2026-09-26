#!/usr/bin/env bash
# Wrapper for the Node-based linter. See `lint-argv-sinks.mjs` for the actual
# implementation. Kept as a shell entry point so CI can
# `run: scripts/lint-argv-sinks.sh` without worrying about the Node
# interpreter path on the runner image.
#
# `--min-files` is a FLOOR, not a count (see docs/false-safety-guards.md — a
# walk that resolves to zero or few files must fail loudly, not report a
# clean tree). packages/server/src is 328 files today (`git ls-files --
# packages/server/src | grep -c '\.js$'`); 250 leaves headroom for ordinary
# deletions while still catching a collapse (losing environments/ or
# built-in-tools/ alone would each trip it).
set -euo pipefail
cd "$(dirname "$0")/.."
exec node ./scripts/lint-argv-sinks.mjs --min-files 250 "$@"
