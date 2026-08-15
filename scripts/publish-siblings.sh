#!/usr/bin/env bash
#
# publish-siblings.sh — publish @chroxy/protocol, @chroxy/store-core and
# @chroxy/server to npm, in dependency order, gated on the artifacts actually
# working. See docs/release/npm-publish.md.
#
# Order is load-bearing. The server depends on its siblings with a bounded
# range (^X.Y.Z), and a range only resolves against what is ALREADY on the
# registry — so each package has to be live before the next one goes up. This
# script waits for that rather than assuming it, because npm's registry is
# read-through-cached and "just published" is not the same as "resolvable".
#
# npm does not allow republishing a version, and unpublish is barred after 72
# hours, so every check here runs BEFORE anything is sent.
#
# Usage:
#   bash scripts/publish-siblings.sh              # verify, then publish
#   bash scripts/publish-siblings.sh --dry-run    # verify + rehearse, publish nothing
#   bash scripts/publish-siblings.sh --skip-verify  # ONLY if verify was just run by hand
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Error: unknown flag '$arg'" >&2; exit 1 ;;
  esac
done

VERSION=$(node -p "require('./packages/server/package.json').version")
echo "publish-siblings — version $VERSION"
[ "$DRY_RUN" = "1" ] && echo "(--dry-run: nothing will be published)"

# --- preconditions -----------------------------------------------------------

if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is dirty. Publish from a clean checkout of the release commit." >&2
  exit 1
fi

if ! npm whoami >/dev/null 2>&1; then
  echo "Error: not authenticated to npm. Run 'npm login' first (browser flow, works with 2FA)." >&2
  exit 1
fi
echo "  npm user: $(npm whoami)"

# Refuse to re-publish a version that is already live, rather than letting npm
# reject it halfway through the sequence and leave the set half-published.
for pkg in @chroxy/protocol @chroxy/store-core @chroxy/server; do
  if npm view "$pkg@$VERSION" version >/dev/null 2>&1; then
    echo "Error: $pkg@$VERSION is already published. Bump the version first (scripts/bump-version.sh)." >&2
    exit 1
  fi
done
echo "  none of the three are published at $VERSION yet"

# --- the gate ----------------------------------------------------------------

if [ "$SKIP_VERIFY" = "1" ]; then
  echo
  echo "WARNING: skipping artifact verification (--skip-verify)."
  echo "         Only safe if you just ran scripts/verify-publish-artifacts.mjs by hand."
else
  echo
  echo "verifying artifacts before publishing..."
  node scripts/verify-publish-artifacts.mjs
fi

# --- publish -----------------------------------------------------------------

# Wait for a package to become resolvable. `npm publish` returning 0 does not
# mean the next `npm view` will see it — the registry is read-through-cached.
wait_for_registry() {
  local pkg="$1" want="$2" tries=30
  echo -n "  waiting for $pkg@$want to be resolvable"
  while [ "$tries" -gt 0 ]; do
    if [ "$(npm view "$pkg@$want" version 2>/dev/null || true)" = "$want" ]; then
      echo " — live"
      return 0
    fi
    echo -n "."
    sleep 4
    tries=$((tries - 1))
  done
  echo
  echo "Error: $pkg@$want did not become resolvable within ~2 minutes." >&2
  echo "       Do NOT publish the next package until it is — the bounded range will not resolve." >&2
  exit 1
}

publish() {
  local label="$1"; shift
  echo
  echo "publishing $label"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  (dry-run) would run: npm publish $*"
  else
    npm publish "$@" --access public
  fi
}

publish "@chroxy/protocol" -w @chroxy/protocol
[ "$DRY_RUN" = "1" ] || wait_for_registry "@chroxy/protocol" "$VERSION"

echo
echo "building @chroxy/store-core's publishable form"
npm run build:publish -w @chroxy/store-core
publish "@chroxy/store-core" packages/store-core/publish
[ "$DRY_RUN" = "1" ] || wait_for_registry "@chroxy/store-core" "$VERSION"

publish "@chroxy/server" -w @chroxy/server
[ "$DRY_RUN" = "1" ] || wait_for_registry "@chroxy/server" "$VERSION"

echo
if [ "$DRY_RUN" = "1" ]; then
  echo "dry run complete — nothing was published."
else
  echo "published all three at $VERSION."
  echo
  echo "confirm with (--prefer-online matters: npm caches registry metadata and"
  echo "will otherwise hand you the PREVIOUS version and look like a failed publish):"
  echo
  echo "  npm install -g @chroxy/server --prefer-online && chroxy doctor"
fi
