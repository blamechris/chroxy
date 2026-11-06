#!/usr/bin/env bash
# check-derived-lockfile.sh — prove at PR time that `npm ci` accepts the
# lockfile the desktop bundle derives (#7985).
#
# bundle-server.sh stages packages/server's package.json (strip @chroxy/*,
# devDependencies, postinstall), derives a standalone lockfile from the root
# one, then runs `npm ci`. Until now the only place that last step ran was the
# release build: bundle-server.test.sh stubs npm, and the derivation tests
# check placement, not npm's acceptance. A lockfile that is internally
# consistent but out of sync with the staged package.json (leftover
# devDependencies, a missing root-entry field) passed every PR check and then
# failed the release.
#
# This script repeats the stage -> derive steps with the SAME code
# bundle-server.sh runs (strip-server-package-json.mjs and
# derive-server-lockfile.mjs — not a re-typed copy of what they do), in a
# throwaway directory, then runs the same `npm ci` flags as the release plus
# --dry-run --offline.
#
# CACHE (measured, #7985): `npm ci --dry-run --offline` does not read the npm
# cache — it resolves entirely from the lockfile. With a fresh empty --cache it
# accepts the real derived lockfile in ~0.5 s and the cache dir ends up holding
# only npm's _logs. So the cache is pinned to an empty directory created here:
# the result cannot depend on the runner's ~/.npm (no cache-miss flake on the
# self-hosted pool, no stale-cache false green). An ENOTCACHED failure is NOT a
# cache problem here: it is what an out-of-sync lockfile looks like offline
# (npm must resolve a dependency the lockfile does not pin, tries the registry,
# --offline forbids it), so it is reported as a rejection with an explanatory
# note, and the cache can never be the cause because it is always empty.
#
# NOT VERIFIED: integrity hashes and `resolved` URLs — a dry run never fetches
# tarballs, so a lockfile with a wrong hash or URL still passes this check.
#
# Usage: check-derived-lockfile.sh [REPO_ROOT]
#   REPO_ROOT defaults to the checkout this script lives in; tests pass a
#   fixture monorepo. Exit 0 = npm accepted the lockfile; non-zero = it did not
#   (or the check could not run) — never "found nothing, so fine".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${1:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
SERVER_PKG="$REPO_ROOT/packages/server/package.json"
ROOT_LOCK="$REPO_ROOT/package-lock.json"

for f in "$SERVER_PKG" "$ROOT_LOCK"; do
  if [ ! -f "$f" ]; then
    echo "[check-derived-lockfile] ERROR: missing input $f" >&2
    exit 2
  fi
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/stage"
CACHE="$WORK/npm-cache"
mkdir -p "$STAGE" "$CACHE"

cp "$SERVER_PKG" "$STAGE/package.json"
node "$SCRIPT_DIR/strip-server-package-json.mjs" "$STAGE/package.json"
node "$SCRIPT_DIR/derive-server-lockfile.mjs" \
  --root-lock "$ROOT_LOCK" \
  --package-json "$STAGE/package.json" \
  --workspace packages/server \
  --out "$STAGE/package-lock.json"

if [ ! -s "$STAGE/package-lock.json" ]; then
  echo "[check-derived-lockfile] ERROR: derivation produced no lockfile" >&2
  exit 2
fi

# Capture to a file and test npm's own exit status: a pipe would report the
# last stage's status, not npm's.
NPM_OUT="$WORK/npm.out"
rc=0
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --dry-run --offline \
  --no-audit --no-fund --cache "$CACHE") >"$NPM_OUT" 2>&1 || rc=$?

if [ "$rc" -ne 0 ]; then
  cat "$NPM_OUT" >&2
  echo "[check-derived-lockfile] ERROR: npm ci rejected the derived server lockfile (exit $rc) — it is out of sync with the staged package.json. This would fail the release build." >&2
  if grep -q 'ENOTCACHED' "$NPM_OUT"; then
    echo "[check-derived-lockfile] note: ENOTCACHED here means npm had to RESOLVE a dependency the lockfile does not pin (it tried the registry and --offline forbade it), not that a cache was missing — the cache is always a fresh empty directory." >&2
  fi
  exit 1
fi

echo "[check-derived-lockfile] OK: npm ci accepts the derived server lockfile"
