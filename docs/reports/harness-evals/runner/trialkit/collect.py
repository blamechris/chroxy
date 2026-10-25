"""Collect a finished run's GitHub evidence into the trial's `data/`.

This reproduces the measurement rules G-codex used for October (GRADING.md,
"Measurement rules") so a run's numbers come out of one command instead of a
grader re-deriving them by hand. It writes `data/evidence/<RUN>.json` in the
schema of October's grader evidence, plus the run's metadata in
`data/runs.json`, which `measures.py` reads.

Two conventions matter more than any single number:

- "Could not check" is never folded into "nothing found". Red CI on the base is
  `None` unless `ci.yml` at T0 provably runs on push to the base, and an
  unreadable trigger gives `None`, never `False`.
- Everything counted is counted inside the run's window (first command to
  report merge, or to the end/cap), because branch names recur across runs.
"""
import base64
import json
import math
import os
import re
from datetime import timedelta

from . import state as state_mod
from . import queue_text, timeutil, workflow
from .gh import FixtureGitHub, GitHubError, RecordingGitHub

CI_PATH = '.github/workflows/ci.yml'
NOT_RECORDED = 'not recorded'
COPILOT_LOGINS = ('copilot-pull-request-reviewer[bot]', 'copilot')
ITEM = re.compile(r'\bTrial-Item:\s*[`*]*\s*(Q\d{2})\b')
CLOSES = re.compile(r'\bTrial-Closes:\s*#?(\d+)\b')
CLOSING_KEYWORD = re.compile(r'\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b\s*:?\s*#\d+', re.I)
BODY_REF = re.compile(r'(?<![\w/])#(\d+)\b')
# The Claude merge gate's own pattern (scripts/require-review-before-merge.sh), case-sensitive like its jq
# test. It does not bind Codex runs, whose review comments say "approve" or "clean", so it is recorded as
# a separate count and is not what the review column uses.
DISPOSITION = re.compile(r'Code Review|Review Comments Addressed|LGTM|Approve|Verdict')
SMOKE_LEAD = re.compile(r'^[\W_]*(?:\w+[\W_]+){0,3}smoke\b', re.I)
TIMELINE_EVENTS = ('cross-referenced', 'mentioned', 'referenced', 'connected')
RED = ('failure', 'timed_out', 'startup_failure')
MANUAL_FIELDS = ('workers', 'approvals', 'compactions', 'waves', 'incidents')
# the manual fields `trialctl evidence` can derive; it fills one only while it is absent or the placeholder
NATIVE_FIELDS = ('approvals', 'compactions', 'workers')

METHODS = (
    'GitHub REST reads only. PRs: pulls?state=all&base=<run base>; per PR the reviews, issue comments, '
    'ci.yml runs and all workflow runs on the head branch, each kept only if created inside the run window '
    '(first command to report merge; the end or the cap when there is no report PR), because branch names '
    "recur across runs, and for a merged PR only up to its merge (the merge's own Repo Relay run is not PR "
    'work). A PR maps to a queue slot through its Trial-Item line (October bodies: Trial-Closes); the report '
    'PR is the unmapped PR that adds the run report. ci_run_count counts distinct ci.yml run IDs and '
    'ci_attempt_count sums run_attempt. Review columns: Copilot non-empty formal review bodies; non-empty '
    'owner-account issue-comment bodies with smoke-only comments excluded (owner_all_comment_bodies keeps '
    'them; owner_gate_pattern_comment_bodies is the subset matching the Claude merge gate pattern). '
    'Report-only PRs are excluded from queue totals. cycle_minutes is created to merged; wall time is the '
    "first command to the last report-PR commit's committer date. diff_added/diff_deleted are the merge "
    "commit's stats against its first parent. Red CI on the base is the failed ci.yml push runs on the base "
    'in the window, and is null unless ci.yml at T0 runs on push to the base. timeline_events lists '
    'cross-reference, mention, reference and connect events on every queue issue inside the window.')


# -- fixtures ------------------------------------------------------------------

def _pick(obj, *keys):
    return {k: obj.get(k) for k in keys if k in obj}


def _user(user):
    return None if user is None else _pick(user, 'login', 'type')


def _trim_pr(pr):
    out = _pick(pr, 'number', 'state', 'title', 'body', 'created_at', 'merged_at', 'closed_at',
                'merge_commit_sha', 'draft')
    out['user'] = _user(pr.get('user'))
    out['head'] = _pick(pr.get('head') or {}, 'ref', 'sha')
    out['base'] = _pick(pr.get('base') or {}, 'ref')
    return out


def _trim_event(ev):
    out = _pick(ev, 'event', 'created_at', 'commit_id')
    out['actor'] = _user(ev.get('actor'))
    issue = (ev.get('source') or {}).get('issue')
    if issue is not None:
        src = {'number': issue.get('number')}
        if 'pull_request' in issue:
            src['pull_request'] = {}
        out['source'] = {'issue': src}
    return out


def _trim_run(run):
    return _pick(run, 'id', 'name', 'path', 'head_sha', 'head_branch', 'created_at', 'conclusion',
                 'run_attempt', 'event', 'status')


def _trim_commit_entry(entry):
    commit = entry.get('commit') or {}
    return {'sha': entry.get('sha'),
            'commit': {'committer': _pick(commit.get('committer') or {}, 'date')}}


def _workflow_head(content):
    """A workflow file's base64 content cut before its `jobs:` key: the trigger the collector reads is
    all above it, and the jobs are most of the 170 KB GitHub returns for ci.yml."""
    text = base64.b64decode(content).decode('utf-8')
    match = re.search(r'^jobs:', text, re.M)
    if match:
        text = text[:match.start()]
    return base64.b64encode(text.encode('utf-8')).decode('ascii')


def trim_fixture(request, response):
    """Keep only the fields `collect` reads, so recorded fixtures stay small (bodies are kept)."""
    path = request.split('?', 1)[0]
    if response is None:
        return None
    if re.search(r'/pulls$', path):
        return [_trim_pr(p) for p in response]
    if re.search(r'/pulls/\d+/reviews$', path):
        return [dict(_pick(r, 'id', 'body', 'state', 'submitted_at'), user=_user(r.get('user')))
                for r in response]
    if re.search(r'/issues/\d+/comments$', path):
        return [dict(_pick(c, 'id', 'body', 'created_at'), user=_user(c.get('user'))) for c in response]
    if re.search(r'/issues/\d+/timeline$', path):
        return [_trim_event(e) for e in response]
    if re.search(r'/pulls/\d+/files$', path):
        return [_pick(f, 'filename') for f in response]
    if re.search(r'/pulls/\d+/commits$', path):
        return [_trim_commit_entry(c) for c in response]
    if re.search(r'/actions/runs$', path):
        return [_trim_run(r) for r in response]
    if re.search(r'/commits/[0-9a-f]{7,40}$', path):
        return {'sha': response.get('sha'), 'stats': _pick(response.get('stats') or {}, 'additions', 'deletions'),
                'parents': [_pick(p, 'sha') for p in response.get('parents', [])]}
    if '/contents/' in path:
        if path.endswith('.github/workflows/ci.yml') and response.get('encoding') == 'base64':
            return {'content': _workflow_head(response.get('content') or ''), 'encoding': 'base64'}
        return _pick(response, 'content', 'encoding')
    if '/git/ref/' in path:
        return {'object': _pick(response.get('object') or {}, 'sha')}
    if '/compare/' in path:
        return {'merge_base_commit': _pick(response.get('merge_base_commit') or {}, 'sha')}
    return response


# -- classification ------------------------------------------------------------

class Window:
    """The inclusive span a run's evidence is counted in."""

    def __init__(self, start, end):
        self.start_text, self.end_text = start, end
        self.start, self.end = timeutil.parse_ts(start), timeutil.parse_ts(end)

    def contains(self, value):
        stamp = timeutil.parse_ts(value)
        return stamp is not None and self.start <= stamp <= self.end


def is_copilot(user):
    login = (user or {}).get('login') or ''
    if login.lower() in COPILOT_LOGINS:
        return True
    return (user or {}).get('type') == 'Bot' and 'copilot' in login.lower()


def is_smoke_only(body):
    """A comment that only reports a smoke pass: it names "smoke" within its first four words
    ("Smoke verification", "Final-head smoke re-run", "Real app smoke at ...") and, once its table
    rows are dropped (a smoke table has a `Verdict` header), carries no gate keyword."""
    lines = [line for line in body.splitlines() if line.strip()]
    if not lines or not SMOKE_LEAD.match(lines[0]):
        return False
    prose = '\n'.join(line for line in lines if not line.lstrip().startswith('|'))
    return not DISPOSITION.search(prose)


def map_item(trial, body):
    """(issue, slot, note) for a PR body; note explains an unmapped PR that named something."""
    body = body or ''
    slots = sorted(set(ITEM.findall(body)))
    if len(slots) > 1:
        return None, None, f'names several slots ({", ".join(slots)})'
    if slots:
        issue = trial.issue_for_slot(slots[0])
        if issue is None:
            return None, None, f'names slot {slots[0]}, which is not in the queue'
        return issue, slots[0], None
    closes = sorted(set(CLOSES.findall(body)))
    if len(closes) == 1:
        slot = trial.slot_for_issue(int(closes[0]))
        if slot is not None:
            return slot.issue, slot.slot, None
    return None, None, None


def _median(values):
    vals = sorted(values)
    if not vals:
        return None
    n = len(vals)
    return vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2


def _p90(values):
    vals = sorted(values)
    if not vals:
        return None
    return vals[max(0, math.ceil(0.9 * len(vals)) - 1)]


def _stamp_key(item):
    return (item.get('created_at') or '', item.get('id') or 0)


def _run_entry(run, keys):
    return {k: run.get(k) for k in keys}


def count_reviews(trial, reviews, comments, window):
    """Review and comment counts for one PR, inside the window."""
    owner = (trial.github_login or '').lower()
    formal = [r for r in reviews if r.get('state') != 'PENDING' and (r.get('body') or '').strip()
              and window.contains(r.get('submitted_at'))]
    copilot = [r for r in formal if is_copilot(r.get('user'))]
    owner_formal = [r for r in formal if ((r.get('user') or {}).get('login') or '').lower() == owner]
    mine = [c for c in comments if ((c.get('user') or {}).get('login') or '').lower() == owner
            and (c.get('body') or '').strip() and window.contains(c.get('created_at'))]
    smoke = [c for c in mine if is_smoke_only(c['body'])]
    smoke_ids = {c['id'] for c in smoke}
    review = [c for c in mine if c['id'] not in smoke_ids]
    gate = [c for c in review if DISPOSITION.search(c['body'])]
    return {
        'copilot_review_bodies': len(copilot),
        'owner_formal_review_bodies': len(owner_formal),
        'owner_review_comment_bodies': len(review),
        'owner_all_comment_bodies': len(mine),
        'owner_gate_pattern_comment_bodies': len(gate),
        'review_comment_ids': [c['id'] for c in review],
        'copilot_review_ids': [r['id'] for r in copilot],
        'excluded_smoke_only_comment_ids': [c['id'] for c in smoke],
    }


# -- one run -------------------------------------------------------------------

def _load_state(trial, run, env, override):
    """(state, path). With no override the machine's state file is tried, then the committed copy."""
    path = None
    try:
        path = state_mod.state_path(trial, run.id, override, env.home)
    except ValueError:
        pass
    if override is None and (path is None or not os.path.exists(path)):
        path = trial.repo_path('data', 'state', f'{run.id}.json')
    if path is None or not os.path.exists(path):
        return None, path
    return state_mod.load(trial, run.id, override=path, home=env.home), path


def _pr_record(trial, client, window, pr, issue, slot):
    number = pr['number']
    head = pr.get('head') or {}
    merged_at = pr.get('merged_at')
    if merged_at:
        state = 'merged'
    else:
        state = 'closed' if pr.get('state') == 'closed' else 'open'
    reviews = client.list(client.repo_path(f'pulls/{number}/reviews'))
    comments = client.list(client.repo_path(f'issues/{number}/comments'))
    runs = client.list(client.repo_path('actions/runs'), {'branch': head.get('ref')}, key='workflow_runs')
    # A merged PR's own runs end at the merge: the Repo Relay run that the merge itself triggers is not PR work.
    in_window = sorted((r for r in runs if window.contains(r.get('created_at'))
                        and (not merged_at or timeutil.parse_ts(r['created_at']) <= timeutil.parse_ts(merged_at))),
                       key=_stamp_key)
    ci = [r for r in in_window if r.get('path') == CI_PATH]
    ci_entries = [_run_entry(r, ('id', 'head_sha', 'created_at', 'conclusion', 'run_attempt', 'event')) for r in ci]
    all_entries = [_run_entry(r, ('id', 'name', 'path', 'head_sha', 'created_at', 'conclusion', 'run_attempt',
                                  'event')) for r in in_window]
    added = deleted = None
    if merged_at:
        stats = client.get(client.repo_path(f'commits/{pr.get("merge_commit_sha")}')).get('stats') or {}
        added, deleted = stats.get('additions'), stats.get('deletions')
    cycle = timeutil.minutes(pr.get('created_at'), merged_at) if merged_at else None
    body = pr.get('body') or ''
    refs = []
    for ref in BODY_REF.findall(body):
        if ref not in refs:
            refs.append(ref)
    record = {
        'issue': issue, 'slot': slot, 'pr': number, 'state': state,
        'head_branch': head.get('ref'), 'head_sha': head.get('sha'),
        'opened_at': pr.get('created_at'), 'merged_at': merged_at,
        'merge_sha': pr.get('merge_commit_sha') if merged_at else None,
        'cycle_minutes': round(cycle, 3) if cycle is not None else None,
    }
    record.update(count_reviews(trial, reviews, comments, window))
    record.update({
        'ci_runs': ci_entries, 'ci_run_count': len(ci_entries),
        'ci_attempt_count': sum(r.get('run_attempt') or 1 for r in ci_entries),
        'diff_added': added, 'diff_deleted': deleted,
        'pr_body_issue_references': refs,
        'forbidden_closing_keyword': bool(CLOSING_KEYWORD.search(body)),
        'all_pr_workflow_runs': all_entries, 'all_pr_workflow_run_count': len(all_entries),
        'correct_vs_key': None,
    })
    return record


def _timeline(trial, client, window, pr_numbers):
    out = []
    for slot in trial.slots:
        for ev in client.list(client.repo_path(f'issues/{slot.issue}/timeline')):
            if ev.get('event') not in TIMELINE_EVENTS or not window.contains(ev.get('created_at')):
                continue
            issue = (ev.get('source') or {}).get('issue') or {}
            source_pr = issue.get('number') if 'pull_request' in issue else None
            out.append({'issue': slot.issue, 'event': ev['event'], 'at': ev['created_at'],
                        'actor': (ev.get('actor') or {}).get('login'), 'source_pr': source_pr,
                        'source_in_run': source_pr in pr_numbers})
    return sorted(out, key=lambda e: (e['at'], e['issue']))


def _sha(client, suffix, *keys):
    """A commit SHA read from a nested response; a response without one is an error, not a blank."""
    value = client.get(client.repo_path(suffix))
    for key in keys:
        value = value.get(key) if isinstance(value, dict) else None
    if not value:
        raise GitHubError(f'{suffix}: the response has no {".".join(keys)}')
    return value


def _push_observable(client, t0, base):
    """Does ci.yml at T0 run on push to the base? None when that cannot be read."""
    if not t0:
        return None
    try:
        entry = client.get(client.repo_path('contents/.github/workflows/ci.yml'), {'ref': t0})
        text = base64.b64decode(entry['content']).decode('utf-8')
        return workflow.branch_covered(base, workflow.push_branches(text))
    except (GitHubError, KeyError, TypeError, ValueError, workflow.WorkflowParseError):
        return None


def _gather(trial, run, client, st, start, env):
    """Everything GitHub says about one run, as the October evidence object, plus notes to print."""
    notes = []
    start_text = start
    finish = st.get('finish') or {}
    cutoff = finish.get('queue_cutoff')
    pulls = sorted(client.list(client.repo_path('pulls'), {'state': 'all', 'base': run.base,
                                                           'sort': 'created', 'direction': 'asc'}),
                   key=lambda p: p['number'])
    mapped, unmapped = {}, []
    for pr in pulls:
        issue, slot, note = map_item(trial, pr.get('body'))
        if issue is None:
            unmapped.append(pr)
            if note:
                notes.append(f'PR {pr["number"]} {note}; treated as unmapped')
        else:
            mapped[pr['number']] = (issue, slot)
    report_relpath = trial.report_relpath(run)
    candidates = []
    for pr in unmapped:
        files = client.list(client.repo_path(f'pulls/{pr["number"]}/files'))
        if any(f.get('filename') == report_relpath for f in files):
            candidates.append(pr)
    report_pr = None
    if candidates:
        merged = [p for p in candidates if p.get('merged_at')]
        report_pr = max(merged, key=lambda p: p['merged_at']) if merged else candidates[-1]
    named = {pr['number'] for pr in unmapped if map_item(trial, pr.get('body'))[2]}
    for pr in unmapped:
        if pr is not report_pr and pr['number'] not in named:
            notes.append(f'PR {pr["number"]} maps to no queue slot and is not the report PR')
    if report_pr is None:
        notes.append(f'no PR adds {report_relpath}; wall time to a report commit is unavailable')
    end_text = (report_pr or {}).get('merged_at') or finish.get('ended_at')
    if not end_text:
        end_text = timeutil.iso(timeutil.parse_ts(start_text) + timedelta(hours=trial.cap_hours))
    window = Window(start_text, end_text)

    records = []
    for pr in pulls:
        issue, slot = mapped.get(pr['number'], (None, None))
        records.append(_pr_record(trial, client, window, pr, issue, slot))
    queue = [p for p in records if p['issue'] is not None]
    merged_queue = [p for p in queue if p['state'] == 'merged']
    cycles = [p['cycle_minutes'] for p in merged_queue if p['cycle_minutes'] is not None]

    report_commit = None
    if report_pr is not None:
        commits = client.list(client.repo_path(f'pulls/{report_pr["number"]}/commits'))
        if commits:
            last = commits[-1]
            report_commit = {'sha': last.get('sha'),
                             'committer_date': ((last.get('commit') or {}).get('committer') or {}).get('date')}

    t0 = trial.t0 or _sha(client, f'compare/main...{run.base}', 'merge_base_commit', 'sha')
    base_tip = _sha(client, f'git/ref/heads/{run.base}', 'object', 'sha')
    push_runs = client.list(client.repo_path('actions/runs'), {'branch': run.base, 'event': 'push'},
                            key='workflow_runs')
    push = sorted((r for r in push_runs if window.contains(r.get('created_at'))), key=_stamp_key)
    # Push CI is attributed to merges by commit, not by time: the last merge (the report PR's) ends
    # the window, so the run it triggers always starts after it.
    merge_shas = {p['merge_sha']: p['pr'] for p in records if p.get('state') == 'merged' and p.get('merge_sha')}
    ci_push = sorted((r for r in push_runs if r.get('path') == CI_PATH), key=_stamp_key)
    latest = {}
    for r in ci_push:
        if r.get('head_sha') in merge_shas:
            latest[r['head_sha']] = r
    entry_keys = ('id', 'head_sha', 'created_at', 'conclusion')
    push_ci = [dict(_run_entry(r, entry_keys), pr=merge_shas[sha])
               for sha, r in sorted(latest.items(), key=lambda kv: _stamp_key(kv[1]))]
    # A ci.yml push run on the base that is no merge's (a direct push, a revert) is red CI on the base too.
    unattributed = [_run_entry(r, entry_keys) for r in ci_push
                    if r.get('head_sha') not in merge_shas and window.contains(r.get('created_at'))]
    observable = _push_observable(client, t0, run.base)
    red, red_gap = None, None
    if observable:
        # A count is only a measurement when every merge into the base has a finished verdict: its own
        # push run passed or failed, or, when that run was cancelled or skipped (ci.yml's concurrency
        # group cancels a pending run when the next merge queues one), a later finished push run on the
        # base covers it. Anything else would read as "not red" while nothing was seen.
        finished = ('success',) + RED
        gaps = []
        missing = sorted(pr for sha, pr in merge_shas.items() if sha not in latest)
        if missing:
            gaps.append(f'no ci.yml push run on the base for the merge of PR(s) {missing}')
        for r in push_ci:
            if r.get('conclusion') is None:
                gaps.append(f'the push run for PR {r["pr"]} had not finished')
            elif r['conclusion'] not in finished and not any(
                    x.get('conclusion') in finished and _stamp_key(x) > _stamp_key(r) for x in ci_push):
                gaps.append(f'the push run for PR {r["pr"]} ended {r["conclusion"]} and no later push run covers it')
        for r in unattributed:
            if r.get('conclusion') is None:
                gaps.append(f'push run {r["id"]} (not a merge) had not finished')
        if gaps:
            red_gap = '; '.join(gaps)
        else:
            red = sum(1 for r in push_ci + unattributed if r['conclusion'] in RED)
    wall = timeutil.minutes(start_text, end_text)
    wall_commit = (timeutil.minutes(start_text, report_commit['committer_date'])
                   if report_commit and report_commit.get('committer_date') else None)

    out = {
        'base_tip': base_tip, 'T0': t0, 'start': start_text, 'report_merged_or_cutoff': end_text,
        'wall_minutes': round(wall, 3) if wall is not None else None,
        'base_push_actions': [_run_entry(r, ('id', 'name', 'path', 'head_sha', 'created_at', 'conclusion'))
                              for r in push],
        'merged_queue_prs': len(merged_queue),
        'queue_ci_runs': sum(p['ci_run_count'] for p in queue),
        'queue_ci_attempts': sum(p['ci_attempt_count'] for p in queue),
        'merged_ci_runs': sum(p['ci_run_count'] for p in merged_queue),
        'median_cycle_minutes': _median(cycles), 'p90_cycle_minutes': _p90(cycles),
        'prs': records,
        'queue_all_pr_workflow_runs': sum(p['all_pr_workflow_run_count'] for p in queue),
        'strict_key_delivered': None,
        'report_last_commit': report_commit,
        'wall_to_report_commit_minutes': round(wall_commit, 3) if wall_commit is not None else None,
    }
    if cutoff:
        out['queue_cutoff'] = cutoff
    out['timeline_events'] = _timeline(trial, client, window, {p['number'] for p in pulls})
    out['base_push_ci'] = push_ci
    out['red_ci_on_base'] = red
    out['ci_push_observable'] = observable
    if red_gap:
        out['red_ci_incomplete'] = red_gap
    if unattributed:
        out['red_ci_unattributed'] = unattributed
    return out, report_pr, notes


# -- data files ----------------------------------------------------------------

def _carry_verdicts(path, run_id, ev):
    """Copy `correct_vs_key` / `verdict_source` from an existing evidence file onto the same PRs, so a
    re-collect after `apply-verdicts` does not erase the grading; returns (kept, dropped), dropped being
    the PRs that held a verdict and are no longer in the evidence."""
    if not os.path.exists(path):
        return 0, []
    try:
        with open(path, encoding='utf-8') as fh:
            old = json.load(fh)['runs'][run_id]['prs']
        verdicts = {p['pr']: p for p in old if p.get('correct_vs_key') is not None}
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise ValueError(f'{path} exists but cannot be read ({exc}); move it aside before collecting again') from exc
    kept = 0
    for pr in ev['prs']:
        prior = verdicts.pop(pr['pr'], None)
        if prior:
            pr['correct_vs_key'] = prior['correct_vs_key']
            if 'verdict_source' in prior:
                pr['verdict_source'] = prior['verdict_source']
            kept += 1
    return kept, sorted(verdicts)


def _write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(value, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, path)


def _read_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def _versions(node, found=None):
    """Version facts anywhere in a preflight record, as {name: value}; the latest of a repeated fact wins."""
    found = {} if found is None else found
    if isinstance(node, dict):
        for key, value in node.items():
            if 'version' in str(key).lower() and isinstance(value, (str, int, float)) and not isinstance(value, bool):
                found.setdefault(str(key), value)
            else:
                _versions(value, found)
    elif isinstance(node, list):
        for item in reversed(node):
            _versions(item, found)
    return found


def _meters_text(section):
    meters = (section or {}).get('meters') or (section or {}).get('readings')
    if not isinstance(meters, dict) or not meters:
        return None
    return ', '.join(f'{k} {v:g}%' if isinstance(v, (int, float)) and not isinstance(v, bool) else f'{k} {v}'
                     for k, v in sorted(meters.items()))


def _applied_text(verify_start):
    """What `verify-start` read back from the native transcript: values are lists of everything seen."""
    applied = verify_start.get('applied') if isinstance(verify_start.get('applied'), dict) else {}
    parts = []
    for key in ('model', 'effort', 'permission_mode', 'sandbox', 'approval_policy'):
        value = applied.get(key)
        seen = [] if value in (None, '', []) else value if isinstance(value, list) else [value]
        seen = [str(v) for i, v in enumerate(seen) if v is not None and v not in seen[:i]]
        if seen:
            parts.append(f'{key} {", ".join(seen)}')
    return '; '.join(parts)


def run_metadata(trial, run, st, start_text):
    """The fields of `runs.json` that are derived from the trial and the run's state."""
    harness = run.harness.label
    versions = _versions(st.get('preflight') or {})
    if versions:
        harness += ' (' + '; '.join(f'{k} {v}' for k, v in sorted(versions.items())) + ')'
    coordinator = f'{run.model} / {run.effort}'
    applied = _applied_text(st.get('verify_start') or {})
    if applied:
        coordinator += f' (applied: {applied})'
    finish = st.get('finish') or {}
    meters = [f'{label}: {text}' for label, text in (('start', _meters_text(st.get('start'))),
                                                       ('end', _meters_text(finish))) if text]
    return {
        'arm': run.arm, 'cell': run.cell, 'repeat': run.repeat, 'block': run.block, 'role': run.role,
        'harness': harness, 'coordinator': coordinator, 'base': run.base, 'date': start_text[:10],
        'send': (st.get('start') or {}).get('sent_at'), 'cost': finish.get('cost') or 'n/a',
        'allowance': '; '.join(meters) or NOT_RECORDED,
    }


def native_row(data, run_id):
    """(row, problem): the runs.json fields in `<data>/native/<run>.json`, written by `trialctl evidence`.

    (None, None) when the run has no extract; a problem string when it has one that cannot be used."""
    path = os.path.join(data, 'native', f'{run_id}.json')
    if not os.path.exists(path):
        return None, None
    try:
        doc = _read_json(path, None)
    except (OSError, ValueError) as exc:
        return None, f'cannot read {path}: {exc}'
    row = doc.get('runs_row') if isinstance(doc, dict) else None
    if not isinstance(row, dict) or doc.get('run') != run_id:
        return None, f'{path} is not the native extract of {run_id}; its fields were not used'
    return row, None


def update_runs_json(trial, run, data, st, start_text, t0, notes=None):
    """Create or refresh `data/runs.json`; derived fields are rewritten, manual ones only if absent.

    A manual field the native extract can fill (NATIVE_FIELDS) is filled from it while it is absent or the
    placeholder, and never once anyone has written a value."""
    path = os.path.join(data, 'runs.json')
    doc = _read_json(path, {})
    doc['queue'] = [s.issue for s in trial.slots]
    doc['T0'] = t0
    with_evidence = [r for r in trial.runs if os.path.exists(os.path.join(data, 'evidence', f'{r.id}.json'))]
    doc['order'] = [r.id for r in with_evidence]
    doc['evidence_files'] = [f'evidence/{r.id}.json' for r in with_evidence]
    doc['cells'] = {c['id']: {'arm': c['arm'], 'harness': trial.harnesses[c['harness']].label,
                              'role': c.get('role', '')} for c in trial.data['cells']}
    doc['contrasts'] = trial.contrasts
    runs = doc.setdefault('runs', {})
    old = runs.get(run.id, {})
    entry = run_metadata(trial, run, st, start_text)
    stop_old = old.get('stop')
    stop_state = (st.get('finish') or {}).get('stop')
    for field in MANUAL_FIELDS:
        entry[field] = old[field] if field in old else NOT_RECORDED
    row, problem = native_row(data, run.id)
    if problem and notes is not None:
        notes.append(problem)
    for field in NATIVE_FIELDS:
        if row and field in row and entry[field] == NOT_RECORDED:
            entry[field] = row[field]
            if notes is not None:
                notes.append(f'{field} filled from the native extract: {row[field]}')
    entry['stop'] = stop_old if stop_old and stop_old != NOT_RECORDED else (stop_state or NOT_RECORDED)
    for key, value in old.items():
        entry.setdefault(key, value)
    runs[run.id] = entry
    _write_json(path, doc)
    tiebreaks = os.path.join(data, 'tiebreaks.json')
    if not os.path.exists(tiebreaks):
        _write_json(tiebreaks, {'source': 'none yet', 'overrides': [], 'conventions': {}})
    return path


def _queue_text_notes(trial, st):
    """Notes on whether the queue's text moved during the run, from what `finish` recorded (`finish.queue_text`), for each slot of
    the trial in order. A finish that did not re-read it, acceptances it did not use, a slot it recorded nothing for, a slot it
    recorded that `trial.json` no longer has, and a slot that is changed or could not be read since the run's gate are named;
    none when every slot is unchanged, and none before a finish."""
    finish = st.get('finish')
    if not isinstance(finish, dict):
        return []
    seen = finish.get('queue_text')
    if not (isinstance(seen, dict) and isinstance(seen.get('slots'), dict)):
        return ['finish did not re-read the queue text, so an edit during the run cannot be ruled out']
    notes = []
    if isinstance(seen.get('acceptances_ignored'), str) and seen['acceptances_ignored']:
        notes.append(f'queue text: acceptances ignored at finish ({seen["acceptances_ignored"]})')
    for slot in trial.slots:
        if slot.slot not in seen['slots']:
            notes.append(f'queue text {slot.slot}: not recorded at finish, so an edit during the run cannot be ruled out')
            continue
        row = seen['slots'][slot.slot]
        row = row if isinstance(row, dict) else {}
        if row.get('since_gate') != queue_text.UNCHANGED:
            notes.append(f'queue text {slot.slot}: {row.get("since_gate", "unknown")} since this run\'s gate '
                         f'({row.get("detail", "no detail recorded")})')
    for slot in sorted(set(seen['slots']) - {slot.slot for slot in trial.slots}):
        notes.append(f'queue text {slot}: recorded at finish, but trial.json no longer has the slot')
    return notes


def _summary(env, trial, run, ev, report_pr, notes):
    queue = [p for p in ev['prs'] if p['issue'] is not None]
    states = {s: sum(1 for p in queue if p['state'] == s) for s in ('merged', 'closed', 'open')}
    env.print(f'collect {run.id}: window {ev["start"]} -> {ev["report_merged_or_cutoff"]} ({ev["wall_minutes"]} min)')
    env.print(f'  queue PRs: {len(queue)} ({states["merged"]} merged, {states["closed"]} closed, '
              f'{states["open"]} open); report PR: {("#" + str(report_pr["number"])) if report_pr else "none"}')
    env.print(f'  ci.yml runs on queue PRs: {ev["queue_ci_runs"]} ({ev["queue_ci_attempts"]} attempts); '
              f'all PR workflow runs: {ev["queue_all_pr_workflow_runs"]}')
    if ev['ci_push_observable'] and ev['red_ci_on_base'] is None:
        env.print(f'  red CI on the base: no count ({ev.get("red_ci_incomplete")})')
    elif ev['ci_push_observable']:
        others = len(ev.get('red_ci_unattributed') or [])
        env.print(f'  red CI on the base: {ev["red_ci_on_base"]} red ({len(ev["base_push_ci"])} merges'
                  + (f', {others} other push run(s))' if others else ')'))
    else:
        why = 'cannot be read' if ev['ci_push_observable'] is None else 'does not run on push to the base'
        env.print(f'  red CI on the base: not observable (ci.yml at T0 {why})')
    outside = [e for e in ev['timeline_events'] if not e['source_in_run']]
    env.print(f'  timeline events in window: {len(ev["timeline_events"])} ({len(outside)} from outside this run)')
    covered = {p['issue'] for p in queue}
    missing = [f'{s.slot}/#{s.issue}' for s in trial.slots if s.issue not in covered]
    if missing:
        env.print(f'  queue items with no PR: {", ".join(missing)}')
    for note in notes:
        env.print(f'  note: {note}')


def collect(trial, run, env, state_file=None, data_dir=None, record_dir=None, fixtures_dir=None):
    """Collect one run's evidence; 0 on success, 2 when something needed is missing or unreadable."""
    if not trial.github_login:
        env.print('collect: trial.json has no github_login, so owner comments cannot be counted')
        return 2
    if not trial.slots:
        env.print('collect: the queue is empty (trial.json queue.slots), so nothing can be mapped')
        return 2
    try:
        st, st_path = _load_state(trial, run, env, state_file)
    except (OSError, ValueError) as exc:
        env.print(f'collect {run.id}: cannot read the run state: {exc}')
        return 2
    if st is None:
        env.print(f'collect {run.id}: no state file (looked at {st_path}); run `trialctl start` first')
        return 2
    start = (st.get('verify_start') or {}).get('first_command_at') or (st.get('start') or {}).get('sent_at')
    if not start:
        env.print(f'collect {run.id}: {st_path} records neither verify_start.first_command_at nor '
                  'start.sent_at, so the window has no start; run `trialctl start` and `verify-start`')
        return 2
    try:
        timeutil.parse_ts(start)
    except (ValueError, TypeError):
        env.print(f'collect {run.id}: the window start {start!r} in {st_path} is not an ISO-8601 timestamp')
        return 2
    client = FixtureGitHub(fixtures_dir, trial.repo) if fixtures_dir else env.github(trial.repo)
    if record_dir:
        client = RecordingGitHub(client, record_dir, trim=trim_fixture)
    try:
        ev, report_pr, notes = _gather(trial, run, client, st, start, env)
    except (GitHubError, ValueError) as exc:
        env.print(f'collect {run.id}: {exc}')
        return 2
    notes.extend(_queue_text_notes(trial, st))
    data = data_dir or trial.repo_path('data')
    evidence = {'collected_at_utc': timeutil.iso(env.now()), 'trial': trial.id, 'run': run.id,
                'methods': METHODS, 'runs': {run.id: ev}}
    path = os.path.join(data, 'evidence', f'{run.id}.json')
    try:
        kept, dropped = _carry_verdicts(path, run.id, ev)
    except ValueError as exc:
        env.print(f'collect {run.id}: {exc}')
        return 2
    if kept:
        env.print(f'  kept {kept} grader verdict(s) already applied to {os.path.relpath(path, trial.root)}')
    if dropped:
        env.print(f'  WARNING: PR(s) {dropped} had a verdict and are not in this collection; their verdicts are gone')
    _write_json(path, evidence)
    try:
        update_runs_json(trial, run, data, st, start, ev['T0'], notes=notes)
    except (OSError, ValueError) as exc:
        env.print(f'collect {run.id}: cannot update runs.json: {exc}')
        return 2
    committed = os.path.join(data, 'state', f'{run.id}.json')
    wrote = [path, os.path.join(data, 'runs.json')]
    if st_path and os.path.abspath(st_path) != os.path.abspath(committed):
        _write_json(committed, state_mod.tildify(st, env.home))
        wrote.append(committed)
    _summary(env, trial, run, ev, report_pr, notes)
    env.print('  wrote ' + ', '.join(wrote))
    return 0
