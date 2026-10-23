"""Read-only view of a live run from GitHub: `check-run.sh` for any trial.

October's `check-run.sh` derives the base as `trial/<run id>` and reads October's
queue, so it cannot watch a trial-2 run. This prints the same things from
`trial.json` (base tip, commits since T0, the base's PRs, the queue issues that
must stay untouched, the main tip, whether the run report has landed) and flags
what the mission forbids in a PR: a closing keyword, an issue number in the
title or body, a body with no `Trial-Item:` slot. It uses no model and writes
nothing; it exits 2 only when GitHub cannot be read.
"""
import re

from . import state as run_state
from .gh import GitHubError
from .timeutil import parse_ts

CLOSING = re.compile(r'\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b\s*:?\s*#\d+', re.I)
ITEM = re.compile(r'^\s*Trial-Item:\s*(Q\d{2})\s*$', re.M)


def pr_flags(trial, pr, is_report):
    """Mission rule 3 violations visible in a PR's title and body."""
    title, body = pr.get('title') or '', pr.get('body') or ''
    flags = []
    if CLOSING.search(title) or CLOSING.search(body):
        flags.append('closing keyword')
    for s in trial.slots:
        if re.search(rf'(?<![\d.]){s.issue}(?!\d)', f'{title}\n{body}'):
            flags.append(f'issue number {s.issue} for {s.slot}')
    if not is_report and not ITEM.search(body):
        flags.append('no Trial-Item slot')
    return flags


def status(trial, run, env, state_file=None):
    gh = env.github(trial.repo)
    repo = gh.repo_path
    started = None
    try:
        started = parse_ts(((run_state.load(trial, run.id, override=state_file, home=env.home) or {})
                            .get('start') or {}).get('sent_at'))
    except (OSError, ValueError):
        pass
    try:
        t0 = trial.t0 or gh.get(repo(f'compare/main...{run.base}'))['merge_base_commit']['sha']
        env.print(f'== {run.id}   base={run.base}   T0={t0[:8]}   checked {env.now().strftime("%Y-%m-%dT%H:%M:%SZ")}')
        tip = gh.get(repo(f'branches/{run.base}'))['commit']
        env.print('-- base tip')
        env.print(f'{tip["sha"][:8]}  {tip["commit"]["committer"]["date"]}  {tip["commit"]["message"].splitlines()[0]}')
        env.print('-- commits on the base since T0 (oldest first)')
        for c in gh.get(repo(f'compare/{t0}...{run.base}')).get('commits', []):
            env.print(f'{c["sha"][:8]}  {c["commit"]["committer"]["date"]}  {c["commit"]["message"].splitlines()[0]}')
        env.print(f'-- pull requests with base {run.base} (all states)')
        report = trial.report_relpath(run)
        for pr in gh.list(repo('pulls'), {'state': 'all', 'base': run.base}):
            item = ITEM.search(pr.get('body') or '')
            is_report = not item and ('report' in (pr.get('title') or '').lower() or report in (pr.get('body') or ''))
            state = 'merged' if pr.get('merged_at') else pr['state']
            flags = pr_flags(trial, pr, is_report)
            env.print(f'{pr["number"]}  {state}{" draft" if pr.get("draft") else ""}  '
                      f'{item.group(1) if item else "--"}  created {pr["created_at"]}  '
                      f'merged {pr.get("merged_at") or "-"}  {pr["title"]}'
                      + (f'   !! {", ".join(flags)}' if flags else ''))
        env.print('-- queue issues (must stay untouched: no comments, labels or closures during a run)')
        for s in trial.slots:
            i = gh.get(repo(f'issues/{s.issue}'))
            touched = started and parse_ts(i['updated_at']) and parse_ts(i['updated_at']) > started
            env.print(f'{s.slot} #{i["number"]}  {i["state"]}  comments={i["comments"]}  updated {i["updated_at"]}  '
                      f'labels={",".join(l["name"] for l in i.get("labels", []))}'
                      + ('   !! updated after the send' if touched else ''))
        main = gh.get(repo('branches/main'))['commit']
        env.print('-- main tip (a change here must not reach the daemon during a run)')
        env.print(f'{main["sha"][:8]}  {main["commit"]["committer"]["date"]}')
        env.print('-- run report on the base?')
        try:
            gh.get(repo(f'contents/{report}'), {'ref': run.base})
            env.print(f'yes: {report} is on {run.base} (the run is over)')
        except GitHubError as exc:
            if exc.status != 404:
                raise
            env.print('no report yet')
    except GitHubError as exc:
        env.print(f'GitHub read failed: {exc}')
        return 2
    return 0
