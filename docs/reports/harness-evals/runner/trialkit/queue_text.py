"""The text of the queue's issues, frozen at T0 and compared by `gate`.

A run reads its queue issues from GitHub while it works. An edit, or a new comment, between run 1 and run 8 changes
the task for the later runs, and nothing recorded or checked it (#8794). When `cut` records T0 it also writes
`<trial dir>/queue-t0.json`: for each slot, the issue number and a digest of its title, its body and its comments.
`gate` reads the issues again and fails, naming the slot and the part, when a digest differs.

Only the task text is digested: the title, the body ('' for none) and, for each comment in id order, its id, its
author's login and its body. Labels, assignees, state, milestone and `updated_at` are not the task and are left out
(`gate` reads the state of each queue issue in its own check). The file holds digests and counts, never text.

Nothing here writes to GitHub, and the snapshot is never overwritten: a later `cut` (one per base, each just before
its run) leaves it alone.
"""
import hashlib
import json
import os
import re
import tempfile

from . import checks
from .gh import GitHubError

FILE = 'queue-t0.json'
DIGEST = re.compile(r'^[0-9a-f]{64}$')


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


def plan(trial, gh, t0, now):
    """What `cut` must write for this T0: None when the snapshot already exists for it, else the snapshot read now.

    An existing snapshot is never replaced: the same T0 leaves it as it is (and reads nothing from GitHub, so the
    cuts after the first need no network); another T0, or a file that cannot be read, refuses. Raises QueueTextError."""
    existing, status = load(trial)
    if status == 'ok':
        if existing['t0'] == t0:
            return None
        raise QueueTextError(f'{FILE} was taken at T0 {existing["t0"][:12]}, not {t0[:12]}; it is never overwritten')
    if status != 'missing':
        raise QueueTextError(f'{FILE} exists but is {status}; it is never overwritten, so remove it by hand if it is wrong')
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
            and all(isinstance(entry.get(k), str) and DIGEST.match(entry[k])
                    for k in ('title_sha256', 'body_sha256', 'comments_sha256'))):
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
        accepted[slot.slot] = accept_changed[slot.slot]
        return checks.passed(name, f'changed since T0 ({shown}), accepted: {accept_changed[slot.slot]}')
    return checks.failed(name, f'changed since the T0 snapshot of {taken}: {shown}; runs would read different text. '
                               f'Restore it, or accept it with --accept-changed {slot.slot}=REASON')


def gate_checks(trial, gh, accept_changed, accepted):
    """The gate's checks that each queue issue's text is what `cut` recorded at T0. `accept_changed` maps a slot to
    the reason the owner accepts its change; the slots it was used for are added to `accepted`."""
    name = 'queue text at T0'
    if not trial.slots:
        return [checks.failed(name, 'the queue has no slots, so there is no text to compare')]
    if not trial.t0:
        return [checks.unverified(name, 'no T0 recorded, so the queue text at T0 cannot be compared')]
    data, status = load(trial)
    if status == 'missing':
        return [checks.failed(name, f'{FILE} is missing from {trial.trial_dir}: `cut` writes it with T0 and the supervisor commits it '
                                    f'with trial.json\'s t0. Pull that commit, or, if T0 was recorded without it, run `cut` again '
                                    f'(the snapshot\'s "at" then says when the text was read)')]
    if status == 'unreadable':
        return [checks.unverified(name, f'cannot read {path(trial)}')]
    if status == 'malformed':
        return [checks.failed(name, f'{FILE} is not a snapshot (it needs "t0" and "slots")')]
    if data['t0'] != trial.t0:
        return [checks.failed(name, f'{FILE} was taken at T0 {data["t0"][:12]}, trial.json records {trial.t0[:12]}')]
    taken = data.get('at') if isinstance(data.get('at'), str) else 'an unrecorded time'
    out = []
    extra = sorted(set(data['slots']) - {slot.slot for slot in trial.slots})
    if extra:
        out.append(checks.failed(name, f'{FILE} holds {", ".join(extra)}, which trial.json no longer has'))
    for slot in trial.slots:
        out.append(_slot_check(slot, data['slots'].get(slot.slot), gh, taken, accept_changed, accepted))
    return out
