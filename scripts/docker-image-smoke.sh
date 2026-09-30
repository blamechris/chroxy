#!/usr/bin/env bash
# Smoke-start a built Chroxy Docker image (#8133).
#
# The root Dockerfile shipped for months with every server start dying on
# ERR_MODULE_NOT_FOUND: the image never contained packages/protocol or
# packages/store-core, so npm's workspace links in node_modules/@chroxy/ pointed
# at nothing. release.yml built that image and pushed it to GHCR on every
# release, but nothing ever RAN it, so nothing noticed. This script is what
# CI's `Docker Image Smoke` job runs against a freshly built image, and it runs
# locally the same way — including the bounded-execution calls below, which
# use a portable wrapper rather than bare `timeout` (see the note below):
#
#   docker build -t chroxy:local . && bash scripts/docker-image-smoke.sh chroxy:local
#
# Five checks, all against the image as built:
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
# 3. The image's own `claude` CLI (#8145) runs and reports the version the
#    Dockerfile pinned. The pin is read from the image's own
#    `org.chroxy.claude-code.version` label via `docker inspect`, never
#    parsed from the Dockerfile source, so this checks what actually shipped.
#
# 4. GET /dashboard, on the already-running healthy container, returns 200 and
#    serves the actual built dashboard — not just any 200 (#8151). Before
#    #8151 this 404'd ("Dashboard dist directory not found") while the
#    startup banner advertised the URL. Authenticates the same way a real
#    dashboard client does (?token=), using a fixed API_TOKEN this script
#    itself passed to `docker run`, so this never needs to read the
#    auto-generated token back out of the container.
#
# 5. Every THIRD-PARTY dependency the server's OWN package.json declares
#    (`dependencies` + `optionalDependencies`, read from the image's own copy,
#    never this checkout's) resolves inside the image. `@chroxy/*` names are
#    excluded — check 1 already resolves every specifier the server actually
#    imports, subpaths included, which a blind bare-root import here cannot
#    (e.g. `@chroxy/store-core`'s root export is a TypeScript source file the
#    server stage never ships; only `./crypto`'s dist is). This is what
#    catches a lazily-imported dep going missing (#8151): deleting
#    `@kubernetes/client-node` from the image previously still passed the
#    smoke with exit 0, because config.js only imports it when a K8s/Rancher
#    environment backend is actually used. A name this check cannot validly
#    resolve via a bare import — deliberately unsupported here (`node-pty` —
#    no linux prebuild, see the Dockerfile's `CHROXY_PROVIDER` comment), or a
#    package that is real but only usable via a subpath / as a static asset,
#    never as a bare Node import (`@modelcontextprotocol/sdk`, `@xterm/*`) —
#    goes in EXEMPT_JSON below with a reason, checked in BOTH directions:
#    every exempt name must actually be a declared dependency, so a name that
#    stops being one (or a typo) fails loudly instead of silently widening
#    the exemption.
#
# Every docker call that runs something in the image is bounded by
# `run_with_timeout` (scripts/lib/run-with-timeout.sh), so a wedged image
# fails with a message instead of hanging the job. It is NOT bare `timeout`:
# GNU coreutils' `timeout` ships on ubuntu-24.04 (where CI runs this) but on
# NEITHER a stock macOS NOR its Homebrew `coreutils` cask by default (which
# installs the GNU tools prefixed `gtimeout`, precisely so they do not shadow
# BSD's own utilities) — so a bare `timeout` call here previously made the
# "runs locally the same way" claim above false on this Mac: every bounded
# call failed with exit 127 before ever reaching the image. run_with_timeout
# tries `timeout`, then `gtimeout`, then falls back to a `perl` alarm/exec
# implementation that preserves the same exit-124-on-expiry contract this
# script's own `import_rc` check below relies on.
#
# Exit codes: 0 = healthy, 1 = a check failed, 2 = usage error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/run-with-timeout.sh
source "$SCRIPT_DIR/lib/run-with-timeout.sh"

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
  docker rm -f "$NAME" "$NAME-scan" "$NAME-imports" "$NAME-deps" >/dev/null 2>&1 || true
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
SRC_LINES="$(run_with_timeout 60 docker run --rm --name "$NAME-scan" --entrypoint grep "$IMAGE" \
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
run_with_timeout 120 docker run --rm --name "$NAME-imports" -w "$IMAGE_SERVER" "$IMAGE" node --input-type=module -e '
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

# Fixed rather than auto-generated (the entrypoint would otherwise mint a
# fresh uuid and write it ONLY to the container's own config.json) so check 4
# below can authenticate a dashboard request without reaching into the
# container to read it back.
DASHBOARD_TOKEN="chroxy-smoke-test-dashboard-token"

echo "== Starting $IMAGE (tunnel off) and waiting up to ${TIMEOUT_SECONDS}s for: $HC_CMD"
docker run -d --name "$NAME" \
  -e ANTHROPIC_API_KEY=sk-ant-smoke-test-not-a-real-key \
  -e CHROXY_TUNNEL=none \
  -e PORT="$PORT" \
  -e API_TOKEN="$DASHBOARD_TOKEN" \
  "$IMAGE" start >/dev/null || fail "could not start a container from $IMAGE"

deadline=$((SECONDS + TIMEOUT_SECONDS))
until run_with_timeout "$HC_TIMEOUT_S" docker exec "$NAME" sh -c "$HC_CMD" >/dev/null 2>&1; do
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

# --- 3. The image's own claude CLI runs and reports the pinned version -----
# Read the pin from the image's OWN label (baked in by the root Dockerfile,
# #8145) rather than parsing the Dockerfile here — this checks what shipped,
# not what the source says should ship. `start` above ran preflight for real
# (no `--skip-checks`): if `claude` were missing or unusable the container
# would already have failed to become healthy, so this check is confirming
# the SPECIFIC version, not merely presence.
CLAUDE_LABEL_VERSION="$(docker inspect -f '{{index .Config.Labels "org.chroxy.claude-code.version"}}' "$IMAGE" 2>/dev/null)"
[ -n "$CLAUDE_LABEL_VERSION" ] \
  || fail "image carries no org.chroxy.claude-code.version label — cannot verify the installed claude CLI's version against the pin"

echo "== Checking the image's claude CLI reports the pinned version ($CLAUDE_LABEL_VERSION)"
set +e
CLAUDE_VERSION_OUT="$(run_with_timeout 30 docker run --rm --entrypoint claude "$IMAGE" --version 2>&1)"
claude_version_rc=$?
set -e
[ "$claude_version_rc" -ne 124 ] || fail "claude --version timed out after 30s inside $IMAGE"
[ "$claude_version_rc" -eq 0 ] || fail "claude --version exited $claude_version_rc inside $IMAGE: $CLAUDE_VERSION_OUT"
# EXACT first-token compare, not a substring match: `claude --version` prints
# "X.Y.Z (Claude Code)", and a substring `grep -qF` against the pin would let
# a label of "2.1.28" pass against a reported "2.1.280" (the shorter string is
# contained in the longer one) — the opposite direction a version check must
# never be wrong in (#8145 review). `${var%%[[:space:]]*}` takes everything
# before the first whitespace, so a stray leading/trailing space in either
# value cannot produce a false mismatch either.
CLAUDE_VERSION_REPORTED="${CLAUDE_VERSION_OUT%%[[:space:]]*}"
[ "$CLAUDE_VERSION_REPORTED" = "$CLAUDE_LABEL_VERSION" ] \
  || fail "claude --version reported '$CLAUDE_VERSION_REPORTED', not the pinned '$CLAUDE_LABEL_VERSION': $CLAUDE_VERSION_OUT"

echo "== claude CLI OK: $CLAUDE_VERSION_OUT"

# --- 4. GET /dashboard serves the built dashboard, not a 404 ----------------
# The already-running, already-healthy container from check 2. curl runs
# INSIDE the container (the image has curl — see the Dockerfile's "System
# dependencies" step) rather than against a published host port, because this
# script never publishes one. Marker is the dashboard's own <title>, taken
# from packages/dashboard/index.html / the built output — not just "some 200",
# which a stock 404 handler could also produce if this check were looser.
echo "== Checking GET /dashboard serves the built dashboard"
set +e
DASH_STATUS="$(run_with_timeout 15 docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' \
  "http://localhost:${PORT}/dashboard?token=${DASHBOARD_TOKEN}")"
dash_status_rc=$?
DASH_BODY="$(run_with_timeout 15 docker exec "$NAME" curl -s \
  "http://localhost:${PORT}/dashboard?token=${DASHBOARD_TOKEN}")"
dash_body_rc=$?
set -e
[ "$dash_status_rc" -ne 124 ] && [ "$dash_body_rc" -ne 124 ] \
  || fail "GET /dashboard timed out after 15s inside $IMAGE"
[ "$dash_status_rc" -eq 0 ] && [ "$dash_body_rc" -eq 0 ] \
  || fail "GET /dashboard inside $IMAGE could not be completed (curl exit $dash_status_rc/$dash_body_rc)"
[ "$DASH_STATUS" = "200" ] \
  || fail "GET /dashboard returned HTTP $DASH_STATUS, not 200 (dashboard dist missing or auth rejected the smoke token?)"
grep -qF '<title>Chroxy Dashboard</title>' <<<"$DASH_BODY" \
  || fail "GET /dashboard returned 200 but the body doesn't contain the dashboard's own <title>Chroxy Dashboard</title> marker — served the wrong thing, or an empty/placeholder page"

echo "== Dashboard OK: HTTP 200, marker found"

# --- 5. Every server dependency (not just @chroxy/*) resolves in the image -
# Read the NAME list from the image's own packages/server/package.json (never
# this checkout's) — same "ask the shipped artifact" principle as checks 2/3.
# `@chroxy/*` names are filtered out here: check 1 above already resolves
# every @chroxy/* specifier the server ACTUALLY imports, including subpaths
# (e.g. `@chroxy/store-core/crypto`) — testing the bare `@chroxy/store-core`
# root here would fail even in a correct image, because that root export
# resolves to a TypeScript source file the server stage never copies (only
# `./crypto`'s built dist is shipped; the server has no reason to ship the
# other). Check 1 is the precise tool for workspace packages; this check's
# job is everything else.
echo "== Reading the image's own server dependency list"
set +e
DEP_JSON="$(run_with_timeout 30 docker run --rm --entrypoint node "$IMAGE" -e "
  const pkg = JSON.parse(require('fs').readFileSync('$IMAGE_SERVER/package.json', 'utf8'));
  const names = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ].filter((n) => !n.startsWith('@chroxy/'));
  process.stdout.write(JSON.stringify(names));
")"
dep_json_rc=$?
set -e
[ "$dep_json_rc" -ne 124 ] || fail "reading the image's server package.json timed out after 30s"
[ "$dep_json_rc" -eq 0 ] || fail "could not read packages/server/package.json's dependencies inside $IMAGE (exit $dep_json_rc): $DEP_JSON"

# Names this check cannot validly resolve via a plain `import()` of the bare
# specifier — each needs an honest, specific reason, not just "unsupported":
#
#   - node-pty: deliberately unsupported in this image (no linux prebuild —
#     npm ci --ignore-scripts skips the native build; see the Dockerfile's
#     `CHROXY_PROVIDER=claude-sdk` comment). This is the one #8151 asks for
#     by name, and the one this whole check exists to catch a regression on.
#   - @modelcontextprotocol/sdk: its own package.json maps the bare "."
#     export to dist/esm/index.js, a file that does not exist ANYWHERE this
#     package is installed (confirmed outside Docker too) — an upstream
#     packaging gap, not a docker-image one. chroxy only ever imports its
#     documented subpaths (e.g. `@modelcontextprotocol/sdk/server/...`),
#     which resolve fine; this entry exempts the specific bare root import
#     this check would otherwise wrongly attempt.
#   - @xterm/xterm, @xterm/addon-fit: browser-only bundles. http-routes.js
#     serves them as raw asset BYTES (readFileSync of a specific lib/ file
#     path), never `import()`s them as a Node module — and @xterm/xterm's
#     own entry point throws "self is not defined" when evaluated under
#     plain Node (it assumes a browser/webworker global), which is expected,
#     not a sign anything is missing.
#
# The ARRAY (not a bare name list) is what lets the "every exempt name must
# be a real dependency" check below report WHICH name is stale, without
# re-parsing anything.
EXEMPT_JSON='[
  {"name": "node-pty", "reason": "no linux prebuild — npm ci --ignore-scripts skips the native build; the embedded terminal and claude-tui provider are unsupported in this image"},
  {"name": "@modelcontextprotocol/sdk", "reason": "package'"'"'s own bare \".\" export target (dist/esm/index.js) does not exist in the published package on any platform; chroxy only imports its subpaths, which resolve fine"},
  {"name": "@xterm/xterm", "reason": "browser-only bundle served as static asset bytes by http-routes.js, never imported as a Node module; throws '"'"'self is not defined'"'"' under plain Node by design"},
  {"name": "@xterm/addon-fit", "reason": "browser-only bundle served as static asset bytes by http-routes.js, never imported as a Node module; throws '"'"'self is not defined'"'"' under plain Node by design"}
]'

# One node invocation resolves the full set AND does the bidirectional
# exemption check, so there is exactly one source of truth for "the full
# dependency list" inside this run (no separate shell-side re-parse of
# DEP_JSON/EXEMPT_JSON to drift from what node actually iterated).
echo "== Resolving the image's server dependencies (exemptions checked both directions)"
set +e
# shellcheck disable=SC2016
RESOLVE_OUT="$(run_with_timeout 120 docker run --rm --name "$NAME-deps" -w "$IMAGE_SERVER" "$IMAGE" \
  node --input-type=module -e '
    const names = JSON.parse(process.argv[1])
    const exempt = JSON.parse(process.argv[2])
    const exemptNames = new Set(exempt.map((e) => e.name))

    if (names.length === 0) {
      console.error("FAIL: found zero dependencies in packages/server/package.json inside the image — proves nothing")
      process.exit(1)
    }

    // Bidirectional: every EXEMPT name must be a REAL declared dependency —
    // a stale/renamed exemption (the dep was removed, or never existed) must
    // fail loudly rather than silently widen what this check accepts.
    const nameSet = new Set(names)
    const staleExempt = exempt.filter((e) => !nameSet.has(e.name))
    if (staleExempt.length > 0) {
      for (const e of staleExempt) {
        console.error(`FAIL: exemption "${e.name}" is not a declared dependency of packages/server/package.json — remove it or fix the typo`)
      }
      process.exit(1)
    }

    let checked = 0
    let failed = 0
    for (const name of names) {
      if (exemptNames.has(name)) {
        console.log(`  skipped ${name} (exempt: ${exempt.find((e) => e.name === name).reason})`)
        continue
      }
      try {
        await import(name)
        console.log(`  resolved ${name}`)
        checked++
      } catch (err) {
        console.error(`FAIL: dependency "${name}" does not resolve inside the image: ${err.message}`)
        failed++
      }
    }

    if (checked === 0) {
      console.error("FAIL: zero non-exempt dependencies were actually resolved — the floor check above must never pass on nothing checked")
      process.exit(1)
    }
    if (failed > 0) process.exit(1)
    console.log(`== ${checked} dependencies resolved, ${exempt.length} exempted`)
  ' "$DEP_JSON" "$EXEMPT_JSON")"
resolve_rc=$?
set -e
printf '%s\n' "$RESOLVE_OUT"
[ "$resolve_rc" -ne 124 ] || fail "resolving the image's server dependencies timed out after 120s"
[ "$resolve_rc" -eq 0 ] || fail "one or more server dependencies failed to resolve inside $IMAGE (see FAIL lines above)"

echo "== Dependency resolution OK"
