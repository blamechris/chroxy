"""The text of the queue's issues, frozen at T0 and compared by `gate`.

A run reads its queue issues from GitHub while it works. An edit, or a new comment, between run 1 and run 8 changes
the task for the later runs, and nothing recorded or checked it (#8794). When `cut` records T0 it also writes
`<trial dir>/queue-t0.json`: for each slot, the issue number and a digest of its title, its body and its comments.
`gate` reads the issues again and fails, naming the slot and the part, when a digest differs. `--accept-changed` records
the digests of the text it accepted, and `finish` reads the issues once more and records, per slot, whether the text
changed since T0 and since the text the run's gate let through: a gate only sees the text before its own run, so an
edit made after the last gate was never caught.

Only the task text is digested: the title, the body ('' for none) and, for each comment in id order, its id, its
author's login and its body. Labels, assignees, state, milestone and `updated_at` are not the task and are left out
(`gate` reads the state of each queue issue in its own check). The file holds digests and counts, never text.

Nothing here writes to GitHub, and the snapshot is never overwritten: a later `cut` (one per base, each just before
its run) leaves it alone. Nor is a missing one taken again once a run has started: that text may have moved since T0, and
every later gate would pass it.
"""
import hashlib
import json
import os
import re
import tempfile

from . import checks
from .gh import GitHubError

FILE = 'queue-t0.json'
LATE = 'a snapshot taken after a run began holds the text as it is then, which may have moved since T0, and every later gate would pass it'
DIGEST = re.compile(r'^[0-9a-f]{64}$')
DIGEST_KEYS = ('title_sha256', 'body_sha256', 'comments_sha256')
TEXT_KEYS = DIGEST_KEYS + ('comments',)  # what read_slot records of a slot's text, besides the issue number
UNCHANGED, CHANGED, NOT_VERIFIED = 'unchanged', 'changed', 'unverified'


class QueueTextError(Exception):
    """The queue's text could not be read, or the snapshot cannot be written."""


def path(trial):
    return trial.repo_path(FILE)


def _digest(value):
    """SHA-256 of a string, or of any other JSON value in its canonical form (sorted keys, no padding)."""
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(text.encode('utf-8', 'surrogatepass')).hexdigest()


def _maybe_text(value):
    return isinstance(value, str) or value is None


def read_slot(gh, slot):
    """The snapshot entry for one slot, read from GitHub now. Raises QueueTextError when the issue or its comments
    cannot be read or do not have the shape this reads: a partial read is never a digest."""
    where = f'{slot.slot} #{slot.issue}'
    try:
        issue = gh.get(gh.repo_path(f'issues/{slot.issue}'))
        listed = gh.list(gh.repo_path(f'issues/{slot.issue}/comments'))
    except (GitHubError, ValueError) as exc:
        raise QueueTextError(f'cannot read {where}: {exc}') from exc
    if not (isinstance(issue, dict) and isinstance(issue.get('title'), str) and 'body' in issue and _maybe_text(issue['body'])):
        raise QueueTextError(f'cannot read {where}: the issue came back without a title and a body')
    rows, seen = [], set()
    for comment in listed or []:
        if not (isinstance(comment, dict) and type(comment.get('id')) is int and 'body' in comment and _maybe_text(comment['body'])):
            raise QueueTextError(f'cannot read {where}: a comment came back without an id and a body')
        if comment['id'] in seen:
            raise QueueTextError(f'cannot read {where}: comment {comment["id"]} was listed twice (it moved between pages); read again')
        seen.add(comment['id'])
        user = comment.get('user')
        login = user.get('login') if isinstance(user, dict) and isinstance(user.get('login'), str) else None
        rows.append({'id': comment['id'], 'user': login, 'body': comment.get('body') or ''})
    rows.sort(key=lambda row: row['id'])
    return {'issue': slot.issue, 'title_sha256': _digest(issue['title']), 'body_sha256': _digest(issue.get('body') or ''),
            'comments_sha256': _digest(rows), 'comments': len(rows)}


def snapshot(trial, gh, t0, now):
    """{'t0', 'at', 'slots'} for every slot, read before anything is recorded; `now()` gives "at" once the reads are
    done. Every slot is tried, so one refusal names all of the unreadable ones."""
    slots, problems = {}, []
    for slot in trial.slots:
        try:
            slots[slot.slot] = read_slot(gh, slot)
        except QueueTextError as exc:
            problems.append(str(exc))
    if problems:
        raise QueueTextError('; '.join(problems))
    return {'t0': t0, 'at': now(), 'slots': slots}


def load(trial):
    """(data, 'ok') | (None, 'missing') | (None, 'unreadable') | (None, 'malformed')."""
    try:
        with open(path(trial), encoding='utf-8') as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return None, 'missing'
    except (OSError, ValueError):
        return None, 'unreadable'
    if not (isinstance(data, dict) and isinstance(data.get('t0'), str) and isinstance(data.get('slots'), dict)):
        return None, 'malformed'
    return data, 'ok'


def plan(trial, gh, t0, now, started=None):
    """What `cut` must write for this T0: None when the snapshot already exists for it, else the snapshot read now.

    An existing snapshot is never replaced: the same T0 leaves it as it is (and reads nothing from GitHub, so the
    cuts after the first need no network); another T0, or a file that cannot be read, refuses. So does a missing file
    once `started` says which runs of the trial have started (#8808). Raises QueueTextError."""
    existing, status = load(trial)
    if status == 'ok':
        if existing['t0'] == t0:
            return None
        raise QueueTextError(f'{FILE} was taken at T0 {existing["t0"][:12]}, not {t0[:12]}; it is never overwritten')
    if status != 'missing':
        raise QueueTextError(f'{FILE} exists but is {status}; it is never overwritten, so remove it by hand if it is wrong')
    if started:
        raise QueueTextError(f'{FILE} is missing and {started}: it is not taken now, because {LATE}. Put the committed file back, then cut again')
    return snapshot(trial, gh, t0, now)


def write(trial, data):
    """Write the snapshot whole or not at all: the complete text goes to a temporary file beside it, and is linked
    into place only if nothing is there, so a failure leaves no partial file and an existing one is never replaced."""
    text = json.dumps(data, indent=2, ensure_ascii=False) + '\n'
    if json.loads(text) != data:
        raise QueueTextError(f'writing {FILE} would change what was read; refusing')
    target = path(trial)
    handle, temp = tempfile.mkstemp(prefix=f'.{FILE}.', dir=os.path.dirname(target))
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as fh:
            fh.write(text)
        os.chmod(temp, 0o644)  # mkstemp makes it 0600; the file is committed like its neighbours
        try:
            os.link(temp, target)
        except FileExistsError:
            raise QueueTextError(f'{FILE} appeared while it was being written; it is never overwritten') from None
    finally:
        os.unlink(temp)


# -- gate -----------------------------------------------------------------------

def _entry_problem(slot, entry):
    """Why a recorded entry cannot be compared with `slot`, or None."""
    if entry is None:
        return f'{FILE} has no entry for {slot.slot}'
    if not (isinstance(entry, dict) and type(entry.get('issue')) is int and type(entry.get('comments')) is int
            and all(isinstance(entry.get(k), str) and DIGEST.match(entry[k]) for k in DIGEST_KEYS)):
        return f'{FILE} holds a malformed entry for {slot.slot}'
    if entry['issue'] != slot.issue:
        return f'{slot.slot} is issue {slot.issue} in trial.json but {entry["issue"]} in {FILE}'
    return None


def _changed_parts(then, now):
    parts = []
    if then['title_sha256'] != now['title_sha256']:
        parts.append('title')
    if then['body_sha256'] != now['body_sha256']:
        parts.append('body')
    if then['comments_sha256'] != now['comments_sha256']:
        edited = then['comments'] == now['comments']
        parts.append(f'comments ({then["comments"]}, text changed)' if edited else f'comments ({then["comments"]} -> {now["comments"]})')
    return parts


def _slot_check(slot, entry, gh, taken, accept_changed, accepted):
    name = f'queue text {slot.slot} #{slot.issue}'
    problem = _entry_problem(slot, entry)
    if problem:
        return checks.failed(name, problem)
    try:
        now = read_slot(gh, slot)
    except QueueTextError as exc:
        return checks.unverified(name, str(exc))
    parts = _changed_parts(entry, now)
    if not parts:
        return checks.passed(name, f'title, body and {now["comments"]} comment(s) unchanged since the T0 snapshot of {taken}')
    shown = ', '.join(parts)
    if slot.slot in accept_changed:
        accepted[slot.slot] = {'reason': accept_changed[slot.slot], **now}  # the text accepted, as digests: `finish` compares with it
        return checks.passed(name, f'changed since T0 ({shown}), accepted: {accept_changed[slot.slot]}')
    return checks.failed(name, f'changed since the T0 snapshot of {taken}: {shown}; runs would read different text. '
                               f'Restore it, or accept it with --accept-changed {slot.slot}=REASON')


def _baseline(trial, after_run=False, started=None):
    """The T0 snapshot a comparison starts from: (data, taken, None), or (None, None, the Check saying why there is none).
    `taken` is when the text was read. Used by `gate` (where a bad baseline is a failure) and `finish` (where it is not).
    `after_run` is set by `finish`: a missing file must then not be written again by `cut`, whose snapshot would be the
    text as it is after the run, so the end text would be compared with itself. `started` is set by `gate` to say which
    runs of the trial have started, when any has: its advice for a missing file is then not to `cut` either (#8808)."""
    name = 'queue text at T0'
    if not trial.t0:
        return None, None, checks.unverified(name, 'no T0 recorded, so the queue text at T0 cannot be compared')
    data, status = load(trial)
    if status == 'missing' and after_run:
        return None, None, checks.failed(name, f'{FILE} is missing from {trial.trial_dir}: put the committed file back and run `finish` again '
                                               f'(runner README, "When `finish` recorded `unverified` slots"). Do not run `cut` to write it '
                                               f'now: a snapshot taken after the run compares the end text with itself')
    if status == 'missing' and started:
        return None, None, checks.failed(name, f'{FILE} is missing from {trial.trial_dir} and {started}: put the committed file back (pull the '
                                               f'commit that added it with trial.json\'s t0, or restore it) and run the gate again. Do not run '
                                               f'`cut` to write it now: {LATE}')
    if status == 'missing':
        return None, None, checks.failed(name, f'{FILE} is missing from {trial.trial_dir}: `cut` writes it with T0 and the supervisor commits it '
                                               f'with trial.json\'s t0. Pull that commit, or, if T0 was recorded without it, run `cut` again '
                                               f'(the snapshot\'s "at" then says when the text was read)')
    if status == 'unreadable':
        return None, None, checks.unverified(name, f'cannot read {path(trial)}')
    if status == 'malformed':
        return None, None, checks.failed(name, f'{FILE} is not a snapshot (it needs "t0" and "slots")')
    if data['t0'] != trial.t0:
        return None, None, checks.failed(name, f'{FILE} was taken at T0 {data["t0"][:12]}, trial.json records {trial.t0[:12]}')
    return data, data.get('at') if isinstance(data.get('at'), str) else 'an unrecorded time', None


def gate_checks(trial, gh, accept_changed, accepted, started=None):
    """The gate's checks that each queue issue's text is what `cut` recorded at T0. `accept_changed` maps a slot to
    the reason the owner accepts its change; for each slot it was used for, `accepted` gets the reason and the digests of
    the text accepted. `started` says which runs of the trial have started, or None when none has."""
    if not trial.slots:
        return [checks.failed('queue text at T0', 'the queue has no slots, so there is no text to compare')]
    data, taken, problem = _baseline(trial, started=started)
    if problem:
        return [problem]
    out = []
    extra = sorted(set(data['slots']) - {slot.slot for slot in trial.slots})
    if extra:
        out.append(checks.failed('queue text at T0', f'{FILE} holds {", ".join(extra)}, which trial.json no longer has'))
    for slot in trial.slots:
        out.append(_slot_check(slot, data['slots'].get(slot.slot), gh, taken, accept_changed, accepted))
    return out


# -- finish ---------------------------------------------------------------------

def _acceptance(slot, entry):
    """The acceptance `gate` recorded for `slot` if `entry` is one (a reason, and the digests of the text accepted for this
    issue), else None. Anything else, such as the bare reason an older gate recorded, accepted no particular text."""
    if isinstance(entry, dict) and isinstance(entry.get('reason'), str) and entry['reason'] and _entry_problem(slot, entry) is None:
        return entry
    return None


def _unread(slot, detail):
    return {'issue': slot.issue, 'since_t0': NOT_VERIFIED, 'since_gate': NOT_VERIFIED, 'detail': detail}


def _end_check(slot, entry, accepted, gh, taken, ignored):
    """(Check, record) for one slot: has its text changed since T0, and since the text this run's gate let through (the
    text it accepted, else the T0 text)? Nothing that cannot be read is called unchanged. `ignored` is set when the run's
    acceptances were not used, which the detail then says in place of "this run's gate passed the T0 text"."""
    name = f'queue text {slot.slot} #{slot.issue}'
    problem = _entry_problem(slot, entry)
    if problem:
        return checks.unverified(name, problem), _unread(slot, problem)
    try:
        now = read_slot(gh, slot)
    except QueueTextError as exc:
        return checks.unverified(name, str(exc)), _unread(slot, str(exc))
    accepted = _acceptance(slot, accepted)
    parts_t0 = _changed_parts(entry, now)
    parts_gate = _changed_parts(accepted or entry, now)
    shown, shown_gate = ', '.join(parts_t0), ', '.join(parts_gate)
    if not parts_gate and not parts_t0:
        detail = f'title, body and {now["comments"]} comment(s) unchanged since the T0 snapshot of {taken}'
    elif not parts_gate:
        detail = f'changed since T0 ({shown}), the text this run\'s gate accepted: {accepted["reason"]}'
    elif not accepted and ignored:
        detail = (f'changed since the T0 snapshot of {taken}: {shown}; this run\'s gate cannot be placed at or before the first send, so its '
                  f'acceptances were not used and the text is compared with T0')
    elif not accepted:
        detail = (f'changed since the T0 snapshot of {taken}: {shown}; this run\'s gate passed the T0 text, so it changed after this run\'s '
                  f'gate (or the run started without a passing gate)')
    elif parts_t0:
        detail = f'changed since the text this run\'s gate accepted ({accepted["reason"]}): {shown_gate}'
    else:
        detail = f'back to the T0 text, but this run\'s gate accepted a changed text ({accepted["reason"]}), so it changed after this run\'s gate'
    record = {'issue': slot.issue, 'since_t0': CHANGED if parts_t0 else UNCHANGED, 'since_gate': CHANGED if parts_gate else UNCHANGED,
              **{k: now[k] for k in TEXT_KEYS}}
    if parts_t0:
        record['parts'] = parts_t0
    if accepted:
        record['accepted'] = accepted['reason']
    record['detail'] = detail
    return (checks.failed if parts_gate else checks.passed)(name, detail), record


def finish_checks(trial, gh, accepted, ignored=None):
    """(checks, {slot: record}) for the queue text as `finish` reads it, to be compared with T0 and with what the run's gate
    let through. `accepted` is the run's recorded `gate.accepted_changed`, whatever shape it has. A run is not judged
    here, so a baseline that cannot be used leaves every slot unverified, without reading any issue. `ignored`, when given, is the
    sentence saying why `accepted` was not passed on, and changes what a changed slot's detail says."""
    if not trial.slots:
        return [checks.unverified('queue text at the end', 'the queue has no slots, so there is no text to compare')], {}
    data, taken, problem = _baseline(trial, after_run=True)
    if problem:
        return [checks.unverified(problem.name, problem.detail)], {slot.slot: _unread(slot, problem.detail) for slot in trial.slots}
    accepted = accepted if isinstance(accepted, dict) else {}
    results, slots = [], {}
    for slot in trial.slots:
        check, slots[slot.slot] = _end_check(slot, data['slots'].get(slot.slot), accepted.get(slot.slot), gh, taken, ignored)
        results.append(check)
    return results, slots
