#!/usr/bin/env bash
#
# Lint: no fallback-less var(--foo) referencing an undefined CSS custom property.
#
# #6420. Catches the #6416 bug class: when the whole --color-* token namespace
# was undefined, var(--color-surface) silently resolved to transparent and the
# Cmd+K palette was unreadable — no error, just a wrong colour. A static guard
# flags any var(--foo) reference (without a fallback) whose --foo is defined
# nowhere, so the bug class fails at CI time instead of via visual regression.
#
# A var() WITH a fallback (var(--foo, x)) is ALWAYS safe and is ignored — the
# fallback is exactly the "defined elsewhere or this default" escape hatch.
#
# Comments are stripped before scanning (mirrors lint-no-raw-color-literals.sh
# / #6423) so a JSDoc reference like `a var(--token) colour` in a .tsx comment
# is not mistaken for a real, broken reference.
#
# Pure grep/comm + perl (for comment stripping) — no deps. CI runs it under bash.

set -euo pipefail

cd "$(dirname "$0")/.."

ROOT="packages/dashboard/src"

command -v perl >/dev/null 2>&1 || {
  echo "::error::lint-undefined-css-vars.sh requires perl (used to strip comments)"
  exit 1
}

# Grandfathered: short semantic vars referenced (fallback-less) in components.css
# that the theme does not define (it defines suffixed forms like --accent-blue).
# These pre-date the lint and need a theme-author decision to resolve — tracked
# in https://github.com/blamechris/chroxy/issues/6444. The list only FREEZES the
# known backlog; any NEW undefined reference is still caught. Shrink it as #6444
# is worked.
ALLOW="--accent --accent-yellow --bg-active --bg-hover --border --border-muted --error --text-bright --text-tertiary"

# Comment-stripped content of every styling file, as one stream (// line + /* */
# block comments, the latter across newlines via /s). Over-stripping a // inside
# a string only drops a candidate (false-negative) — safe for this guard.
stripped="$(find "$ROOT" \( -name '*.css' -o -name '*.ts' -o -name '*.tsx' \) -type f -print0 \
  | xargs -0 perl -0777 -pe 's{//[^\n]*}{}g; s{/\*.*?\*/}{}gs' 2>/dev/null)"

# Defined props: `--foo:` (CSS / inline object), setProperty('--foo'), '--foo':
defined="$(printf '%s' "$stripped" \
  | grep -oE -- "--[a-zA-Z0-9-]+[[:space:]]*:|setProperty\(['\"]--[a-zA-Z0-9-]+|['\"]--[a-zA-Z0-9-]+['\"][[:space:]]*:" \
  | grep -oE -- "--[a-zA-Z0-9-]+" | sort -u)"

# Fallback-less references: var(--foo) but NOT var(--foo, …).
refs="$(printf '%s' "$stripped" \
  | grep -oE "var\(--[a-zA-Z0-9-]+[[:space:]]*\)" \
  | grep -oE -- "--[a-zA-Z0-9-]+" | sort -u)"

# Known = defined ∪ grandfathered. Undefined = fallback-less refs minus known.
known="$(printf '%s\n' "$defined"; printf '%s\n' $ALLOW)"
known="$(printf '%s\n' "$known" | sort -u)"
undefined="$(comm -23 <(printf '%s\n' "$refs") <(printf '%s\n' "$known") | grep -v '^$' || true)"

if [ -n "$undefined" ]; then
  echo "::error::var(--…) references an undefined CSS custom property with no fallback:"
  printf '%s\n' "$undefined" | sed 's/^/    /'
  echo "  Fix one of: define it (packages/dashboard/src/theme), add a fallback"
  echo "  (var(--x, <value>)), or — if intentional/pre-existing — add it to ALLOW"
  echo "  in scripts/lint-undefined-css-vars.sh (and track it under #6444)."
  exit 1
fi

echo "OK — every fallback-less var(--…) resolves to a defined custom property ($(printf '%s\n' $ALLOW | grep -c .) grandfathered, tracked in #6444)."
