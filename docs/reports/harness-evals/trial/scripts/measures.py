#!/usr/bin/env python3
"""Compute the PROTOCOL.md section 6 measures for a controlled harness trial.

Reads only the committed inputs in a data directory (default ../data, October's;
see ../data/PROVENANCE.md) and prints the tables embedded in ../REPORT.md. No
network access; run from the repository root:

    python3 docs/reports/harness-evals/trial/scripts/measures.py
    python3 docs/reports/harness-evals/trial/scripts/measures.py --data docs/reports/harness-evals/trial-2/data

October's `runs.json` has no `order`, `evidence_files` or `cells`, so the October
constants below apply and the output is exactly what it was. A data directory
written by `trialctl collect` carries them, and then the per-cell table, the
red-CI table and the per-contrast lines are printed as well.

A merged queue PR with no grader verdict (`correct_vs_key` null) is "ungraded":
the run stops with exit 1 rather than count it as not delivered, unless
`--allow-ungraded` says the gap is intended.
"""
import argparse
import json
import math
import os
import re
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
ORDER = ['A1-cd', 'A2c-cy-claude', 'A2-cy-claude', 'A2b-cy-claude',
         'B1-cx', 'B2c-cy-codex', 'B2b-cy-codex', 'B2-cy-codex']
EVIDENCE_FILES = ['G-codex-EVIDENCE-A.json', 'G-codex-EVIDENCE-B.json']
OCTOBER_CONTRASTS = (('A', 'A1-cd', 'A2c-cy-claude'), ('B', 'B1-cx', 'B2c-cy-codex'))


def load(name, data=None):
    with open(os.path.join(data or DATA, name), encoding='utf-8') as fh:
        return json.load(fh)


def parse_ts(value):
    """Parse an ISO-8601 UTC timestamp, with or without fractional seconds.

    The fraction is cut to microseconds and the offset is kept intact; a value
    with no offset is taken as UTC, never as the host's local time, so the
    output does not depend on the machine the script runs on.
    """
    if not value:
        return None
    value = value.replace('Z', '+00:00')
    if '.' in value:
        head, tail = value.split('.', 1)
        match = re.match(r'(\d*)(.*)$', tail)
        frac, tz = match.group(1), match.group(2)
        value = f'{head}.{frac[:6].ljust(6, "0")}{tz}'
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _selfcheck():
    """Fail loudly if the parser ever drifts; runs under every TZ identically."""
    expect = datetime(2026, 10, 19, 19, 18, 0, 437000, tzinfo=timezone.utc)
    assert parse_ts('2026-10-19T19:18:00.437Z') == expect, 'fractional Z timestamp'
    assert parse_ts('2026-10-19T19:18:00.437000+00:00') == expect, 'fractional +00:00 timestamp'
    assert parse_ts('2026-10-19T19:18:00Z') == expect.replace(microsecond=0), 'whole-second timestamp'
    assert parse_ts('2026-10-18T20:55:44.226162Z').microsecond == 226162, 'microseconds kept'


def minutes(a, b):
    ta, tb = parse_ts(a), parse_ts(b)
    if ta is None or tb is None:
        return None
    return (tb - ta).total_seconds() / 60.0


def hm(mins):
    if mins is None:
        return 'n/a'
    whole = int(round(mins))
    return f'{whole // 60} h {whole % 60:02d} min'


def median(values):
    vals = sorted(values)
    if not vals:
        return None
    n = len(vals)
    return vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2


def p90_nearest_rank(values):
    vals = sorted(values)
    if not vals:
        return None
    return vals[max(0, math.ceil(0.9 * len(vals)) - 1)]


def final_verdict(run, pr, tiebreaks):
    verdict = pr.get('correct_vs_key')
    for ov in tiebreaks['overrides']:
        if ov['issue'] != pr.get('issue'):
            continue
        if ov['runs'] == 'all' or run in ov['runs']:
            if pr.get('state') == 'merged':
                verdict = ov['verdict']
    return verdict


def fmt_wall(mins):
    return 'n/a' if mins is None else f'{hm(mins)} ({mins:.1f} min)'


def cell_median(values):
    """Median across repeats; None if any repeat lacks the value (a gap is not a smaller sample)."""
    return None if not values or any(v is None for v in values) else median(values)


def cell_summary(rows, order, runs, cell):
    members = sorted((r for r in order if runs['runs'][r].get('cell') == cell),
                     key=lambda r: runs['runs'][r].get('repeat', 0))
    pick = lambda key: [rows[r][key] for r in members]
    return {'runs': members, 'delivered': cell_median(pick('delivered')),
            'wall': cell_median(pick('wall_commit')), 'cycle': cell_median(pick('cycle_median'))}


def signed(value, unit=''):
    return f'{value:+.1f}{unit}'


def print_cell_tables(rows, order, runs):
    print('\n## Table 4 — per cell (each repeat, then the median across repeats)\n')
    print('| Cell | Run | Repeat | Delivered | Wall clock to last report commit | PR cycle median (min) |')
    print('|---|---|---|---|---|---|')
    for cell in runs['cells']:
        s = cell_summary(rows, order, runs, cell)
        for run in s['runs']:
            r = rows[run]
            cyc = f"{r['cycle_median']:.1f}" if r['cycle_median'] is not None else '—'
            print(f"| {cell} | {run} | {runs['runs'][run].get('repeat', '')} | {r['delivered']} | {fmt_wall(r['wall_commit'])} | {cyc} |")
        if not s['runs']:
            print(f'| {cell} | (no run collected) | | n/a | n/a | — |')
            continue
        cyc = f"{s['cycle']:.1f}" if s['cycle'] is not None else '—'
        dlv = f"{s['delivered']:g}" if s['delivered'] is not None else 'n/a'
        print(f"| **{cell}** | **median of {len(s['runs'])}** | | **{dlv}** | **{fmt_wall(s['wall'])}** | **{cyc}** |")
    print('\n## Table 5 — red CI on the base after a merge\n')
    print('| Run | Merge push runs of `ci.yml` on the base | Other push runs of `ci.yml` on the base | Red CI on the base |')
    print('|---|---|---|---|')
    for run in order:
        r = rows[run]
        if r['ci_push_observable'] is True and r['red_ci_on_base'] is not None:
            print(f"| {run} | {r['base_push_runs']} | {r['other_push_runs']} | {r['red_ci_on_base']} |")
        else:
            print(f'| {run} | not observable | not observable | not observable |')


def print_contrasts(rows, order, runs):
    print('\n## Paired contrasts\n')
    for c in runs.get('contrasts', []):
        a, b = (cell_summary(rows, order, runs, c['native']), cell_summary(rows, order, runs, c['chroxy']))
        def side(name, s):
            cyc = f"{s['cycle']:.1f} min" if s['cycle'] is not None else 'n/a'
            dlv = f"{s['delivered']:g}" if s['delivered'] is not None else 'n/a'
            return f"{name} (median of {len(s['runs'])}) {dlv} delivered in {hm(s['wall'])} (cycle median {cyc})"
        gaps = []
        if a['delivered'] is not None and b['delivered'] is not None:
            gaps.append(f"delivered {signed(b['delivered'] - a['delivered'])}")
        if a['wall'] is not None and b['wall'] is not None:
            gaps.append(f"{signed(b['wall'] - a['wall'])} min to the report commit")
        if a['cycle'] is not None and b['cycle'] is not None:
            gaps.append(f"cycle median {signed(b['cycle'] - a['cycle'])} min")
        gap = f"; gap ({c['chroxy']} minus {c['native']}): {', '.join(gaps)}." if gaps else '; no gap can be computed.'
        print(f"- Arm {c['arm']}: {side(c['native'], a)} vs {side(c['chroxy'], b)}{gap}")


def main(argv=None):
    args = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    args.add_argument('--data', default=DATA, help='data directory (default: ../data beside this script)')
    args.add_argument('--allow-ungraded', action='store_true',
                      help='print the tables although merged queue PRs have no grader verdict (counted as not delivered)')
    opts = args.parse_args(argv)
    data = opts.data
    _selfcheck()
    runs = load('runs.json', data)
    order = runs.get('order') or ORDER
    ev = {}
    for name in runs.get('evidence_files') or EVIDENCE_FILES:
        ev.update(load(name, data)['runs'])
    tiebreaks = load('tiebreaks.json', data)
    queue = runs['queue']
    cells = bool(runs.get('cells'))
    rows = {}
    ungraded = []
    for run in order:
        e = ev[run]
        meta = runs['runs'][run]
        queue_prs = [p for p in e['prs'] if p.get('issue') in queue]
        merged = [p for p in queue_prs if p.get('state') == 'merged']
        closed_unmerged = [p for p in queue_prs if p.get('state') == 'closed']
        left_open = [p for p in queue_prs if p.get('state') == 'open']
        verdicts = {}
        for p in merged:
            verdicts[p['issue']] = final_verdict(run, p, tiebreaks)
        delivered = sorted(i for i, v in verdicts.items() if v == 'yes')
        partial = sorted(i for i, v in verdicts.items() if v == 'partial')
        undelivered = sorted(i for i in queue if i not in verdicts)
        ungraded += [(run, p['pr'], p['issue']) for p in merged if p.get('correct_vs_key') is None]
        cycles = [p['cycle_minutes'] for p in merged if p.get('cycle_minutes') is not None]
        report_commit = (e.get('report_last_commit') or {}).get('committer_date')
        last_merge = max((p['merged_at'] for p in merged), default=None)
        rows[run] = {
            'run': run, 'meta': meta,
            'start': e['start'], 'queue_done': e.get('queue_cutoff') or last_merge,
            'report_commit': report_commit, 'end': e['report_merged_or_cutoff'],
            'wall_commit': minutes(e['start'], report_commit) if report_commit else None,
            'wall_merge': minutes(e['start'], e['report_merged_or_cutoff']) if report_commit else None,
            'wall_queue': minutes(e['start'], e.get('queue_cutoff') or last_merge) if last_merge else None,
            'merged': len(merged), 'delivered': len(delivered), 'partial': partial,
            'undelivered': undelivered, 'closed_unmerged': [p['pr'] for p in closed_unmerged],
            'left_open': [p['pr'] for p in left_open],
            'cycle_median': median(cycles), 'cycle_p90': p90_nearest_rank(cycles), 'n_cycles': len(cycles),
            'ci_runs': e['queue_ci_runs'], 'ci_attempts': e['queue_ci_attempts'],
            'all_workflow_runs': e['queue_all_pr_workflow_runs'],
            'copilot_bodies': sum(p.get('copilot_review_bodies') or 0 for p in queue_prs),
            'owner_disposition_bodies': sum(p.get('owner_review_comment_bodies') or 0 for p in queue_prs),
            'owner_all_comments': sum(p.get('owner_all_comment_bodies') or 0 for p in queue_prs),
            'added': sum(p.get('diff_added') or 0 for p in merged),
            'deleted': sum(p.get('diff_deleted') or 0 for p in merged),
            'closing_keywords': sum(1 for p in queue_prs if p.get('forbidden_closing_keyword')),
            'body_refs': sorted({r for p in queue_prs for r in (p.get('pr_body_issue_references') or [])}),
        }
        if cells:
            observable = e.get('ci_push_observable')
            rows[run].update({'cell': meta.get('cell'), 'repeat': meta.get('repeat'),
                              'ci_push_observable': observable,
                              'red_ci_on_base': e.get('red_ci_on_base') if observable is True else None,
                              'base_push_runs': len(e.get('base_push_ci') or []),
                              'other_push_runs': len(e.get('red_ci_unattributed') or [])})
    if ungraded:
        listing = ', '.join(f'{run} PR {pr} (issue {issue})' for run, pr, issue in ungraded)
        print(f'measures: {len(ungraded)} merged queue PR(s) have no grader verdict (correct_vs_key is null): {listing}',
              file=sys.stderr)
        if not opts.allow_ungraded:
            print('measures: apply the verdicts (`trialctl apply-verdicts`) or pass --allow-ungraded; nothing printed or written',
                  file=sys.stderr)
            return 1
    print('## Table 1 — delivery and time (section 6 measures)\n')
    print('| Run | Role | Merged | Delivered (merged and correct) | Partial | Not delivered | Wall clock: first command to last report commit | to report PR merged | Queue done |')
    print('|---|---|---|---|---|---|---|---|---|')
    for run in order:
        r = rows[run]
        print(f"| {run} | {r['meta']['role']} | {r['merged']} | **{r['delivered']}** | {', '.join(map(str, r['partial'])) or '—'} | {', '.join(map(str, r['undelivered'])) or '—'} | {hm(r['wall_commit'])} | {hm(r['wall_merge'])} | {hm(r['wall_queue'])} |")
    print('\n## Table 2 — PR cycle, CI and review (run-window conventions)\n')
    print('| Run | PR cycle median / p90 (min, n) | `ci.yml` runs on queue PRs (attempts) | All workflow runs | Copilot review bodies | Owner disposition bodies (all owner comments) | Closed unmerged / left open | Diff on merged PRs (+/−) | Closing keyword | `#N` in PR bodies |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for run in order:
        r = rows[run]
        med = f"{r['cycle_median']:.1f} / {r['cycle_p90']:.1f} (n = {r['n_cycles']})" if r['cycle_median'] is not None else '—'
        print(f"| {run} | {med} | {r['ci_runs']} ({r['ci_attempts']}) | {r['all_workflow_runs']} | {r['copilot_bodies']} | {r['owner_disposition_bodies']} ({r['owner_all_comments']}) | {len(r['closed_unmerged'])} / {len(r['left_open'])} | +{r['added']} / −{r['deleted']} | {r['closing_keywords']} | {', '.join(r['body_refs']) or 'none'} |")
    print('\n## Table 3 — cost, allowance, approvals, compactions\n')
    print('| Run | Coordinator | Cost | Allowance | Human approvals | Compactions | Waves | Stop |')
    print('|---|---|---|---|---|---|---|---|')
    for run in order:
        m = rows[run]['meta']
        print(f"| {run} | {m['coordinator']} | {m['cost']} | {m['allowance']} | {m['approvals']} | {m['compactions']} | {m['waves']} | {m['stop']} |")
    if cells:
        print_cell_tables(rows, order, runs)
        print_contrasts(rows, order, runs)
    else:
        print_october_contrasts(rows)
    if ungraded:
        print(f"\n(ungraded merged queue PRs counted as not delivered: {', '.join(f'{run} PR {pr}' for run, pr, _ in ungraded)})")
    with open(os.path.join(data, 'measures-output.json'), 'w', encoding='utf-8') as fh:
        json.dump({run: {k: v for k, v in rows[run].items() if k != 'meta'} for run in order}, fh, indent=2, sort_keys=True)
    print('\n(measures-output.json written beside the inputs)')
    return 0


def print_october_contrasts(rows):
    print('\n## Paired contrasts\n')
    for arm, native, chroxy in OCTOBER_CONTRASTS:
        a, b = rows[native], rows[chroxy]
        print(f"- Arm {arm}: {native} {a['delivered']} delivered in {hm(a['wall_commit'])} (cycle median {a['cycle_median']:.1f} min) vs {chroxy} {b['delivered']} delivered in {hm(b['wall_commit'])} (cycle median {b['cycle_median']:.1f} min); wall-clock gap {b['wall_commit'] - a['wall_commit']:.1f} min to the report commit, {b['wall_merge'] - a['wall_merge']:.1f} min to the report merge.")


if __name__ == '__main__':
    sys.exit(main())
