#!/usr/bin/env python3
"""Compute the PROTOCOL.md section 6 measures for the controlled harness trial.

Reads only the committed inputs in ../data (see ../data/PROVENANCE.md) and prints
the tables embedded in ../REPORT.md. No network access; run from the repository root:

    python3 docs/reports/harness-evals/trial/scripts/measures.py
"""
import json
import math
import os
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
ORDER = ['A1-cd', 'A2c-cy-claude', 'A2-cy-claude', 'A2b-cy-claude',
         'B1-cx', 'B2c-cy-codex', 'B2b-cy-codex', 'B2-cy-codex']


def load(name):
    with open(os.path.join(DATA, name), encoding='utf-8') as fh:
        return json.load(fh)


def parse_ts(value):
    if not value:
        return None
    value = value.replace('Z', '+00:00')
    if '.' in value:
        head, tail = value.split('.', 1)
        frac = ''.join(ch for ch in tail if ch.isdigit())[:6]
        tz = tail[len(''.join(ch for ch in tail if ch.isdigit())):]
        value = f'{head}.{frac.ljust(6, "0")}{tz}'
    return datetime.fromisoformat(value).astimezone(timezone.utc)


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


def main():
    ev = {}
    for name in ('G-codex-EVIDENCE-A.json', 'G-codex-EVIDENCE-B.json'):
        ev.update(load(name)['runs'])
    runs = load('runs.json')
    tiebreaks = load('tiebreaks.json')
    queue = runs['queue']
    rows = {}
    for run in ORDER:
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
    print('## Table 1 — delivery and time (section 6 measures)\n')
    print('| Run | Role | Merged | Delivered (merged and correct) | Partial | Not delivered | Wall clock: first command to last report commit | to report PR merged | Queue done |')
    print('|---|---|---|---|---|---|---|---|---|')
    for run in ORDER:
        r = rows[run]
        print(f"| {run} | {r['meta']['role']} | {r['merged']} | **{r['delivered']}** | {', '.join(map(str, r['partial'])) or '—'} | {', '.join(map(str, r['undelivered'])) or '—'} | {hm(r['wall_commit'])} | {hm(r['wall_merge'])} | {hm(r['wall_queue'])} |")
    print('\n## Table 2 — PR cycle, CI and review (run-window conventions)\n')
    print('| Run | PR cycle median / p90 (min, n) | `ci.yml` runs on queue PRs (attempts) | All workflow runs | Copilot review bodies | Owner disposition bodies (all owner comments) | Closed unmerged / left open | Diff on merged PRs (+/−) | Closing keyword | `#N` in PR bodies |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for run in ORDER:
        r = rows[run]
        med = f"{r['cycle_median']:.1f} / {r['cycle_p90']:.1f} (n = {r['n_cycles']})" if r['cycle_median'] is not None else '—'
        print(f"| {run} | {med} | {r['ci_runs']} ({r['ci_attempts']}) | {r['all_workflow_runs']} | {r['copilot_bodies']} | {r['owner_disposition_bodies']} ({r['owner_all_comments']}) | {len(r['closed_unmerged'])} / {len(r['left_open'])} | +{r['added']} / −{r['deleted']} | {r['closing_keywords']} | {', '.join(r['body_refs']) or 'none'} |")
    print('\n## Table 3 — cost, allowance, approvals, compactions\n')
    print('| Run | Coordinator | Cost | Allowance | Human approvals | Compactions | Waves | Stop |')
    print('|---|---|---|---|---|---|---|---|')
    for run in ORDER:
        m = rows[run]['meta']
        print(f"| {run} | {m['coordinator']} | {m['cost']} | {m['allowance']} | {m['approvals']} | {m['compactions']} | {m['waves']} | {m['stop']} |")
    print('\n## Paired contrasts\n')
    for arm, native, chroxy in (('A', 'A1-cd', 'A2c-cy-claude'), ('B', 'B1-cx', 'B2c-cy-codex')):
        a, b = rows[native], rows[chroxy]
        print(f"- Arm {arm}: {native} {a['delivered']} delivered in {hm(a['wall_commit'])} (cycle median {a['cycle_median']:.1f} min) vs {chroxy} {b['delivered']} delivered in {hm(b['wall_commit'])} (cycle median {b['cycle_median']:.1f} min); wall-clock gap {b['wall_commit'] - a['wall_commit']:.1f} min to the report commit, {b['wall_merge'] - a['wall_merge']:.1f} min to the report merge.")
    with open(os.path.join(DATA, 'measures-output.json'), 'w', encoding='utf-8') as fh:
        json.dump({run: {k: v for k, v in rows[run].items() if k != 'meta'} for run in ORDER}, fh, indent=2, sort_keys=True)
    print('\n(measures-output.json written beside the inputs)')


if __name__ == '__main__':
    main()
