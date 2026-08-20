#!/usr/bin/env bash
# Wrapper for the Node-based linter. See `lint-windows-test-exemptions.mjs`
# for the actual implementation. Kept as a shell entry point so CI can
# `run: scripts/lint-windows-test-exemptions.sh` without worrying about the
# Node interpreter path on the runner image.
#
# --min-files is a COLLAPSE floor, not a count: it fails the gate if the walk
# suddenly finds far fewer test files than the suite has (a broken walk, a
# renamed directory, a bad --tests-root), because "walked 3 files, all clean"
# and "walked 553 files, all clean" must not be the same observable outcome.
# 500 sits below today's 553 with room for honest shrinkage.
# The test parses this number back out of this file rather than keeping a
# second copy — a hardcoded copy in the test was proven blind by mutation in
# lint-entry-point-guard.test.js.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node ./scripts/lint-windows-test-exemptions.mjs --min-files 500 "$@"
