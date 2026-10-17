#!/usr/bin/env bash
# Regenerate the harness diagnostic from the published inputs.
# Usage: bash scripts/reproduce.sh <workdir>   (run from docs/reports/harness-evals)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:?workdir required}"
mkdir -p "$WORK/data" "$WORK/scripts"
cp "$HERE"/scripts/*.py "$WORK/scripts/"
for f in "$HERE"/data/raw/*; do
  base="$(basename "$f")"
  case "$base" in
    *.gz) gunzip -c "$f" > "$WORK/data/${base%.gz}" ;;
    *)    cp "$f" "$WORK/data/$base" ;;
  esac
done
cd "$WORK"
export HE_REPORT_PATH="$WORK/report.md" HE_METRICS_PATH="$WORK/review-metrics.csv"
python3 -I scripts/build_master.py      > build_master.log
python3 -I scripts/clusters_v2.py       > clusters_v2.log
python3 -I scripts/cluster_issues.py    > cluster_issues.log
python3 -I scripts/runs_table.py        > runs_table.log
python3 -I scripts/review_metrics.py    > review_metrics.log
python3 -I scripts/map_sessions.py      > map_sessions.log
python3 -I scripts/gen_report.py        > gen_report.log
echo "report: $HE_REPORT_PATH"
echo "review metrics: $HE_METRICS_PATH"
