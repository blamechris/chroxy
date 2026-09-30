#!/usr/bin/env bash
# Smoke-start a built Chroxy Docker image (#8133).
#
# The root Dockerfile shipped for months with every server start dying on
# ERR_MODULE_NOT_FOUND: the image never contained packages/protocol or
# packages/store-core, so npm's workspace links in node_modules/@chroxy/ pointed
# at nothing. Nothing built the image, so nothing noticed. This script is what
# CI's `Docker Image` job runs against a freshly built image, and it can be run
# locally the same way:
#
#   docker build -t chroxy:local . && bash scripts/docker-image-smoke.sh chroxy:local
#
# Two checks, both against the image as built, not the source tree:
#
# 1. Every `@chroxy/*` specifier the server imports resolves inside the image.
#    The list is DERIVED from packages/server/src on every run, never typed
#    here: a hand-kept list beside a growing set is how a new workspace import
#    would slip past (docs/false-safety-guards.md). Finding zero specifiers is
#    a failure, not a pass — a scan that matches nothing proves nothing.
#
# 2. The entrypoint's real `start` path reaches a healthy daemon. Health is
#    judged by running the image's OWN HEALTHCHECK command inside the container
#    (read back with `docker inspect`), so this checks the probe Docker itself
#    would run, including that its tools exist in the image.
#
# `--skip-checks` is passed to `start` because the image has no `claude` CLI
# yet, and preflight refuses to start without one (#8145). Drop it when #8145
# lands.
#
# Exit codes: 0 = healthy, 1 = a check failed, 2 = usage error.
set -euo pipefail

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  echo "usage: $0 <image>" >&2
  exit 2
fi

REPO_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
SERVER_SRC="$REPO_ROOT/packages/server/src"
TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-60}"
PORT=8765
NAME="chroxy-smoke-$$"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "no such image: $IMAGE (build it first)"

# --- 1. Every @chroxy/* specifier the server imports resolves in the image ---
# Matches static `from '…'` (import and re-export) and dynamic `import('…')`.
# `|| true`: grep exits 1 on zero matches, and zero is handled explicitly below.
SPECS="$(grep -rhoE "(from |import\()['\"]@chroxy/[a-z0-9_-]+(/[a-z0-9_./-]+)?['\"]" "$SERVER_SRC" \
  | grep -oE "@chroxy/[a-z0-9_./-]+" | sort -u || true)"
if [ -z "$SPECS" ]; then
  fail "found zero @chroxy/* imports under $SERVER_SRC — the scan matched nothing, which proves nothing"
fi

echo "== Resolving $(echo "$SPECS" | wc -l | tr -d ' ') @chroxy/* specifier(s) inside $IMAGE"
# Run from the server package so bare specifiers resolve exactly as the
# server's own imports do. $SPECS is intentionally unquoted: one argv each.
# shellcheck disable=SC2086
docker run --rm -w /app/packages/server "$IMAGE" node --input-type=module -e '
  for (const spec of process.argv.slice(1)) {
    await import(spec)
    console.log("  resolved " + spec)
  }
' $SPECS || fail "a @chroxy/* specifier the server imports does not resolve inside the image"

# --- 2. The entrypoint's `start` reaches a healthy daemon -------------------
HC_KIND="$(docker inspect -f '{{index .Config.Healthcheck.Test 0}}' "$IMAGE" 2>/dev/null)" \
  || fail "image has no HEALTHCHECK to run"
[ "$HC_KIND" = "CMD-SHELL" ] || fail "unexpected HEALTHCHECK form '$HC_KIND' (expected CMD-SHELL)"
HC_CMD="$(docker inspect -f '{{index .Config.Healthcheck.Test 1}}' "$IMAGE")"

echo "== Starting $IMAGE (tunnel off) and waiting up to ${TIMEOUT_SECONDS}s for: $HC_CMD"
docker run -d --name "$NAME" \
  -e ANTHROPIC_API_KEY=sk-ant-smoke-test-not-a-real-key \
  -e CHROXY_TUNNEL=none \
  -e PORT="$PORT" \
  "$IMAGE" start --skip-checks >/dev/null || fail "could not start a container from $IMAGE"

deadline=$((SECONDS + TIMEOUT_SECONDS))
until docker exec "$NAME" sh -c "$HC_CMD" >/dev/null 2>&1; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
    docker logs "$NAME" >&2 || true
    fail "container exited before becoming healthy (logs above)"
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    docker logs "$NAME" >&2 || true
    fail "container not healthy after ${TIMEOUT_SECONDS}s (logs above)"
  fi
  sleep 1
done

echo "== Healthy: the image's HEALTHCHECK passed"
