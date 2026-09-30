#!/usr/bin/env bash
# Smoke-start a built Chroxy Docker image (#8133).
#
# The root Dockerfile shipped for months with every server start dying on
# ERR_MODULE_NOT_FOUND: the image never contained packages/protocol or
# packages/store-core, so npm's workspace links in node_modules/@chroxy/ pointed
# at nothing. release.yml built that image and pushed it to GHCR on every
# release, but nothing ever RAN it, so nothing noticed. This script is what
# CI's `Docker Image Smoke` job runs against a freshly built image, and it runs
# locally the same way:
#
#   docker build -t chroxy:local . && bash scripts/docker-image-smoke.sh chroxy:local
#
# Two checks, both against the image as built:
#
# 1. Every `@chroxy/*` specifier the server imports resolves inside the image.
#    The specifiers are read from the image's OWN copy of packages/server/src on
#    every run, never typed here: a hand-kept list beside a growing set is how a
#    new workspace import would slip past (docs/false-safety-guards.md). Two
#    ways this could pass while proving nothing are both failures instead:
#    finding zero specifiers, and a quoted `@chroxy/...` on a code line in a
#    form the extractor does not recognise (a template literal, a multi-line
#    `import(`, ...), which fails naming the line rather than being skipped.
#
# 2. The entrypoint's real `start` path reaches a healthy daemon. Health is
#    judged by running the image's OWN HEALTHCHECK command inside the container
#    (read back with `docker inspect`), under the image's own probe timeout, so
#    this checks the probe Docker itself would run, including that its tools
#    exist in the image.
#
# Every docker call that runs something in the image is bounded by `timeout`,
# so a wedged image fails with a message instead of hanging the job.
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

TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-60}"
PORT=8765
NAME="chroxy-smoke-$$"
IMAGE_SERVER=/app/packages/server

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  docker rm -f "$NAME" "$NAME-scan" "$NAME-imports" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# grep that reads "no match" (exit 1) as empty output but a real error (exit 2)
# as a failure: an erroring filter must never look like "nothing found".
grep_or_empty() { grep "$@" || [ $? -eq 1 ]; }

docker version >/dev/null 2>&1 || fail "cannot reach Docker (no docker CLI on PATH, or no daemon running)"
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "no such image: $IMAGE (build it first)"

# --- 1. Every @chroxy/* specifier the server imports resolves in the image ---
# Every line of the image's server JavaScript that quotes an @chroxy/ specifier
# (JS only: src/ also holds Markdown design notes that name packages in prose).
set +e
SRC_LINES="$(timeout 60 docker run --rm --name "$NAME-scan" --entrypoint grep "$IMAGE" \
  -rhE --include='*.js' --include='*.mjs' --include='*.cjs' "['\"\`]@chroxy/" "$IMAGE_SERVER/src")"
scan_rc=$?
set -e
[ "$scan_rc" -le 1 ] || fail "could not scan $IMAGE_SERVER/src inside $IMAGE (exit $scan_rc)"

# Code lines only: JSDoc (`* @param {import('@chroxy/x').T}`) and // comments
# name types and prose, not runtime imports.
CODE_LINES="$(printf '%s\n' "$SRC_LINES" | grep_or_empty -vE '^[[:space:]]*(//|/\*|\*)')" \
  || fail "internal: comment filter errored"

# Static `from`, side-effect `import '…'`, dynamic `import(…)` and `require(…)`.
IMPORT_RE="(^|[^A-Za-z0-9_\$.])(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]@chroxy/[A-Za-z0-9_-]+(/[A-Za-z0-9_./-]+)?['\"]"

UNRECOGNISED="$(printf '%s\n' "$CODE_LINES" | grep_or_empty -vE "$IMPORT_RE" | grep_or_empty -E "['\"\`]@chroxy/")" \
  || fail "internal: unrecognised-form filter errored"
if [ -n "$UNRECOGNISED" ]; then
  printf '%s\n' "$UNRECOGNISED" >&2
  fail "the line(s) above quote an @chroxy/ specifier in a form this script cannot check — use a plain static or import('…') specifier"
fi

SPECS="$(printf '%s\n' "$CODE_LINES" | grep_or_empty -oE "$IMPORT_RE" \
  | grep_or_empty -oE "@chroxy/[A-Za-z0-9_./-]+" | sort -u)" \
  || fail "internal: specifier extraction errored"
if [ -z "$SPECS" ]; then
  fail "found zero @chroxy/* imports under $IMAGE_SERVER/src in $IMAGE — the scan matched nothing, which proves nothing"
fi

echo "== Resolving $(printf '%s\n' "$SPECS" | wc -l | tr -d ' ') @chroxy/* specifier(s) inside $IMAGE"
# Run from the server package so bare specifiers resolve exactly as the
# server's own imports do. $SPECS is intentionally unquoted: one argv each.
set +e
# shellcheck disable=SC2086
timeout 120 docker run --rm --name "$NAME-imports" -w "$IMAGE_SERVER" "$IMAGE" node --input-type=module -e '
  for (const spec of process.argv.slice(1)) {
    await import(spec)
    console.log("  resolved " + spec)
  }
' $SPECS
import_rc=$?
set -e
[ "$import_rc" -ne 124 ] || fail "resolving the @chroxy/* specifiers timed out after 120s"
[ "$import_rc" -eq 0 ] || fail "a @chroxy/* specifier the server imports does not resolve inside the image"

# --- 2. The entrypoint's `start` reaches a healthy daemon -------------------
HC_KIND="$(docker inspect -f '{{index .Config.Healthcheck.Test 0}}' "$IMAGE" 2>/dev/null)" \
  || fail "image has no HEALTHCHECK to run"
[ "$HC_KIND" = "CMD-SHELL" ] || fail "unexpected HEALTHCHECK form '$HC_KIND' (expected CMD-SHELL)"
HC_CMD="$(docker inspect -f '{{index .Config.Healthcheck.Test 1}}' "$IMAGE")"
# The probe's own timeout, in nanoseconds; Docker's default is 30s when unset.
HC_TIMEOUT_NS="$(docker inspect -f '{{json .Config.Healthcheck.Timeout}}' "$IMAGE")"
case "$HC_TIMEOUT_NS" in ''|*[!0-9]*) fail "unreadable HEALTHCHECK timeout '$HC_TIMEOUT_NS'" ;; esac
if [ "$HC_TIMEOUT_NS" -gt 0 ]; then
  HC_TIMEOUT_S=$(( (HC_TIMEOUT_NS + 999999999) / 1000000000 ))
else
  HC_TIMEOUT_S=30
fi

echo "== Starting $IMAGE (tunnel off) and waiting up to ${TIMEOUT_SECONDS}s for: $HC_CMD"
docker run -d --name "$NAME" \
  -e ANTHROPIC_API_KEY=sk-ant-smoke-test-not-a-real-key \
  -e CHROXY_TUNNEL=none \
  -e PORT="$PORT" \
  "$IMAGE" start --skip-checks >/dev/null || fail "could not start a container from $IMAGE"

deadline=$((SECONDS + TIMEOUT_SECONDS))
until timeout "${HC_TIMEOUT_S}s" docker exec "$NAME" sh -c "$HC_CMD" >/dev/null 2>&1; do
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
