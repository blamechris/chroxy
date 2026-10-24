"""`trialctl evidence`: keep a finished run's native record and derive its public extract.

The repository is public and a raw transcript holds everything the run read and
said, so it must never land in a work tree. This command copies the run's Claude
Code transcripts, Codex rollouts and (for a Chroxy run) the daemon log lines of
its window into `paths.evidence_dir` on the owner's Mac, writes a SHA-256
manifest beside them, and writes `<data>/native/<RUN>.json`: only the counts,
model names and hashes `extract.py` derives, plus the manifest's digest so the
vault copy can be verified later.

It refuses, writing nothing, when the destination is inside the trial
repository, the run's clone or any git work tree. The owner's private vault may
be declared in `paths.evidence_vault`: it is then the one work tree evidence may
live in and the only place it may go. The copy is staged beside its destination
and moved into place last, and the extract is written after it; a failure on any
path (an I/O error or any other exception) removes the stage, and the copy too if
the extract was not written, so a failure leaves neither behind.

Threat model: an accidental misconfiguration on the owner's own machine (a wrong
path, a link into the repository, a clone that moved), not an adversary with
write access to the home directory. So `evidence_dir` is resolved once and
everything is written under the resolved directory; the destination is checked
before anything is read, again just before staging and again just before the
move; and a link at the target or the stage is refused rather than followed.
"""
import hashlib
import os
import shutil
from datetime import timedelta

from . import checks, extract, native, state, timeutil
from .collect import _write_json
from .launch import START_GRACE, _clone_dir, _inside, _work_tree_above

END_GRACE = timedelta(minutes=10)
DOING = {'destination': 'checking the destination', 'copy': 'reading the staged copy', 'move': 'moving the copy into place',
         'extract': 'writing the extract'}
CLAUDE_DIR, CODEX_DIR, LOG_NAME, MANIFEST = 'claude-projects', 'codex-sessions', 'daemon.log', 'MANIFEST.sha256'


def _path(trial, env, name):
    return trial.local_path(name, env.home)


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _window(st):
    """(start, end, problem) as aware datetimes. The start is the earlier of the send and the first command."""
    start_text = (st.get('start') or {}).get('sent_at')
    first_text = (st.get('verify_start') or {}).get('first_command_at')
    end_text = (st.get('finish') or {}).get('ended_at')
    if not (start_text or first_text) or not end_text:
        return None, None, 'the state records no start or no finish; run `trialctl start` and `trialctl finish` first'
    try:
        stamps = [timeutil.parse_ts(t) for t in (start_text, first_text) if t]
        return min(stamps), timeutil.parse_ts(end_text), None
    except (ValueError, TypeError):
        return None, None, f'cannot read the window ({start_text!r}, {first_text!r}, {end_text!r})'


def resolve_base(path):
    """The directory evidence goes under, every link resolved: it is validated, and written to, as this."""
    return os.path.realpath(os.path.abspath(path))


def stage_path(base, run_id):
    return os.path.join(base, f'.{run_id}.partial')


def _location_problems(trial, env, real, clone_dir):
    """Why a resolved path may not hold raw transcripts."""
    problems = []
    if _inside(real, os.path.realpath(trial.root)):
        problems.append(f'it is inside the trial repository {trial.root}')
    if clone_dir and _inside(real, os.path.realpath(clone_dir)):
        problems.append(f'it is inside the run\'s clone {clone_dir}')
    vault = _path(trial, env, 'evidence_vault')
    private = os.path.realpath(vault) if vault else None
    if private and not _inside(real, private):
        problems.append(f'it is outside the declared vault {vault}')
    here = real
    while True:
        tree = _work_tree_above(here)
        if not tree:
            break
        if tree != private:
            problems.append(f'it is inside the git work tree at {tree}')
        if os.path.dirname(tree) == tree:
            break
        here = os.path.dirname(tree)
    return problems


def destination_problems(trial, env, base, run_id, clone_dir):
    """Why `<base>/<run_id>` and the stage beside it may not hold raw transcripts, as sentences (empty when they may).

    `base` is `resolve_base(evidence_dir)`: the base itself, the target and the stage are all checked, so a link
    that points somewhere else cannot move the stage into the repository while the final target looks fine. A
    `base` that no longer resolves to itself has changed since it was resolved, which is a problem too."""
    target, stage = os.path.join(base, run_id), stage_path(base, run_id)
    real = os.path.realpath(base)
    problems = [] if real == base else [f'{base} now resolves to {real}: a link or a parent directory changed']
    for path in (real, os.path.realpath(target), os.path.realpath(stage)):
        problems += [p for p in _location_problems(trial, env, path, clone_dir) if p not in problems]
    for path in (target, stage):
        if os.path.islink(path):
            problems.append(f'{path} is a symbolic link; evidence is never written through one')
    if os.path.lexists(target) and not os.path.islink(target) and (not os.path.isdir(target) or os.listdir(target)):
        problems.append(f'{target} already exists; evidence is written once, so move it aside to write it again')
    return problems


def _make_private_dirs(path):
    """Create `path` and any missing parent with mode 0700 (`os.makedirs(mode=)` leaves the parents at the umask)."""
    missing = []
    here = path
    while not os.path.isdir(here):
        missing.append(here)
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    for part in reversed(missing):
        try:
            os.mkdir(part, 0o700)
        except FileExistsError:
            if not os.path.isdir(part):
                raise


# -- what to copy -----------------------------------------------------------------------

def _walk(root):
    for dirpath, dirs, files in os.walk(root):  # followlinks is off: a link is never followed
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(dirpath, name)
            if not os.path.islink(path):
                yield path


def _in_window(path, floor, ceil):
    """'in', 'late' (modified after the window) or 'out' (before it, or unreadable)."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return 'out'
    if mtime < floor.timestamp():
        return 'out'
    return 'late' if mtime > ceil.timestamp() else 'in'


def _claude_files(trial, env, clone_dir, floor, ceil):
    """([(source, rel)], [late sources], problem): every file below the clone's project folder in the window."""
    projects = _path(trial, env, 'claude_projects')
    if not projects or not os.path.isdir(projects):
        return [], [], f'paths.claude_projects ({projects}) is not a directory'
    found, late = [], []
    for name in native.slug_candidates(clone_dir):
        for path in _walk(os.path.join(projects, name)):
            where = _in_window(path, floor, ceil)
            if where == 'in':
                found.append((path, os.path.relpath(path, projects).replace(os.sep, '/')))
            elif where == 'late':
                late.append(path)
    return found, late, None


def _codex_files(trial, env, clone_dir, floor, ceil):
    """([(source, rel)], [late sources], problem): every rollout whose working directory is the clone or below it."""
    sessions = _path(trial, env, 'codex_sessions')
    if not sessions or not os.path.isdir(sessions):
        return [], [], f'paths.codex_sessions ({sessions}) is not a directory'
    found, late = [], []
    for path in _walk(sessions):
        name = os.path.basename(path)
        if not (name.startswith('rollout-') and name.endswith('.jsonl')):
            continue
        where = _in_window(path, floor, ceil)
        if where == 'out':
            continue
        meta = native._codex_meta(path)
        cwd = meta.get('cwd') if meta else None
        if not isinstance(cwd, str) or not native._within(cwd, clone_dir):
            continue
        if where == 'in':
            found.append((path, os.path.relpath(path, sessions).replace(os.sep, '/')))
        else:
            late.append(path)
    return found, late, None


def _log_paths(path):
    """The daemon log and its rotations, oldest first (`chroxy.3.log` ... `chroxy.1.log`, `chroxy.log`)."""
    base, ext = os.path.splitext(path)
    rotated = [f'{base}.{n}{ext}' for n in range(9, 0, -1) if os.path.exists(f'{base}.{n}{ext}')]
    return rotated + [path]


def _daemon_slice(trial, env, start, end):
    """(lines, text, check, why): the daemon log lines inside the window, and whether they can be taken as data.

    `lines` is None when the log cannot be read. `why` is None on a pass and otherwise a short reason that holds no
    path, for the public extract: a log that is not a pass yields no permission counts at all."""
    name = 'daemon log'
    path = _path(trial, env, 'daemon_log')
    if not path:
        return None, None, checks.unverified(name, 'paths.daemon_log is not set in trial.json'), 'the daemon log path is not set'
    text = ''
    try:
        for part in _log_paths(path):
            with open(part, encoding='utf-8', errors='replace') as fh:
                text += fh.read()
    except OSError as exc:
        return None, None, checks.unverified(name, f'cannot read {path}: {exc}'), 'the daemon log could not be read'
    lines = extract.slice_log(text, start, end)
    stamps = [s for s, _m in native.log_entries(text) if s]
    try:
        oldest = timeutil.parse_ts(stamps[0]) if stamps else None
    except ValueError:
        oldest = None
    if oldest is None:
        return lines, '\n'.join(lines), checks.unverified(name, f'{path} has no timestamped line'), \
            'the daemon log has no line with a readable timestamp'
    if oldest > start:
        return lines, '\n'.join(lines), checks.unverified(
            name, f'the oldest retained line is {timeutil.iso(oldest)}, after the window start {timeutil.iso(start)}: '
                  f'rotation has dropped the beginning of the run'), 'the daemon log was rotated past the window start'
    if not lines:
        return lines, '', checks.unverified(name, f'no line of {path} falls in the window'), 'no daemon log line falls in the window'
    return lines, '\n'.join(lines), checks.passed(name, f'{len(lines)} line(s) in the window'), None


def _session(st):
    """The Chroxy session id the last session-phase preflight recorded, or None."""
    for entry in reversed(st.get('preflight') or []):
        if isinstance(entry, dict) and entry.get('phase') == 'session':
            sid = (entry.get('facts') or {}).get('session')
            if isinstance(sid, str) and sid:
                return sid
    return None


def _daemon_facts(session, text):
    """What the log says of the session; the names are the extract's plain identifiers or `<other>`."""
    found = native.session_findings(text, session) if session else None
    return {'session': extract.safe_session(session) if session else None,
            'model': extract.safe_model(found['model'][0]) if found and found['model'] else None,
            'permission_mode': extract.safe_enum(found['mode'][0], extract.DAEMON_MODES) if found and found['mode'] else None,
            'interrupts': len(found['interrupts']) if found else None}


# -- staging ------------------------------------------------------------------------------

def _private_tree(root):
    for dirpath, dirs, files in os.walk(root):
        os.chmod(dirpath, 0o700)
        for name in files:
            os.chmod(os.path.join(dirpath, name), 0o600)


def _stage(stage, entries, log_text):
    """Copy `entries` ([(source, rel)]) and the log slice into `stage`; returns the sorted [(sha256, rel)]."""
    if os.path.lexists(stage):
        shutil.rmtree(stage)  # a leftover of a crashed run of this command: ours, and only ever copies
    os.makedirs(stage, mode=0o700)
    for source, rel in entries:
        dest = os.path.join(stage, *rel.split('/'))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(source, dest)
    if log_text is not None:
        with open(os.path.join(stage, LOG_NAME), 'w', encoding='utf-8') as fh:
            fh.write(log_text + ('\n' if log_text else ''))
    rows = []
    for dirpath, _dirs, files in os.walk(stage):
        for name in files:
            full = os.path.join(dirpath, name)
            rows.append((_sha256_file(full), os.path.relpath(full, stage).replace(os.sep, '/')))
    rows.sort(key=lambda row: row[1])
    manifest = ''.join(f'{sha}  {rel}\n' for sha, rel in rows)
    with open(os.path.join(stage, MANIFEST), 'w', encoding='utf-8') as fh:
        fh.write(manifest)
    _private_tree(stage)
    return rows, hashlib.sha256(manifest.encode('utf-8')).hexdigest()


# -- the command ------------------------------------------------------------------------------

def _derive(trial, run, env, stage, rows, clone_dir, permission_text):
    """(summary, permissions, isolation report, label) read from the staged copies, so the extract describes
    exactly what the manifest holds. `permission_text` is the daemon-log slice, or None when it cannot be taken
    as data (then there are no permission counts, not zero ones)."""
    scanner = extract.Isolation(run.base, _path(trial, env, 'key_folder'), native.slug_candidates(clone_dir))
    if run.harness.family == 'claude':
        files = []
        for _sha, rel in rows:
            if rel.startswith(CLAUDE_DIR + '/') and rel.count('/') >= 2:
                role = extract.claude_role(rel.split('/', 2)[2])
                if role:
                    files.append((os.path.join(stage, *rel.split('/')), role))
        summary, label = extract.claude_summary(files, scanner), 'subagent transcript(s)'
    else:
        paths = [os.path.join(stage, *rel.split('/')) for _sha, rel in rows
                 if rel.startswith(CODEX_DIR + '/') and rel.endswith('.jsonl')]
        summary, label = extract.codex_summary(paths, scanner), 'subagent rollout(s)'
    permission = extract.permissions(permission_text) if permission_text is not None else None
    return summary, permission, scanner.report(), label


def _discard(*paths):
    """Remove each path that exists; returns a sentence for each that could not be removed (never silent)."""
    left = []
    for path in paths:
        if not os.path.lexists(path):
            continue
        try:
            if os.path.isdir(path) and not os.path.islink(path):
                shutil.rmtree(path)
            else:
                os.unlink(path)
        except OSError as exc:
            left.append(f'{path}: {exc}')
    return left


def _refuse(env, results, title, check):
    results.append(check)
    env.print(checks.render(results, title))
    return checks.exit_code(results)


def evidence(trial, run, env, state_file=None, data_dir=None):
    """Preserve a finished run's native record and write its extract; 0 when every check passed, else 1 or 2."""
    st = state.load(trial, run.id, override=state_file, home=env.home)
    start, end, problem = _window(st)
    if problem:
        env.print(f'evidence {run.id}: {problem}')
        return 1
    configured = _path(trial, env, 'evidence_dir')
    if not configured:
        env.print('evidence: paths.evidence_dir is not set in trial.json')
        return 2
    base = resolve_base(configured)   # validated and written to as this, never through the configured spelling
    clone_dir = _clone_dir(trial, run, env, st)
    target, stage = os.path.join(base, run.id), stage_path(base, run.id)
    problems = destination_problems(trial, env, base, run.id, clone_dir)
    if problems:
        env.print(checks.render([checks.failed('destination', '; '.join(problems))],
                                f'evidence {run.id}: refused, nothing written (a raw transcript must stay out of the repository)'))
        return 1
    family = run.harness.family
    floor, ceil = start - START_GRACE, end + END_GRACE
    found, late, why = (_claude_files if family == 'claude' else _codex_files)(trial, env, clone_dir, floor, ceil)
    label = 'claude transcripts' if family == 'claude' else 'codex rollouts'
    title = f'evidence {run.id}: nothing written'
    if why:
        return _refuse(env, [], title, checks.unverified(label, why))
    if not found:
        return _refuse(env, [], title, checks.failed(
            label, f'none under {clone_dir} modified between {timeutil.iso(floor)} and {timeutil.iso(ceil)}'))
    results = [checks.passed(label, f'{len(found)} file(s)')]
    if late:
        results.append(checks.unverified('files after the window', f'{len(late)} file(s) modified after {timeutil.iso(ceil)} '
                                                                   f'were not copied: the session may have been continued'))
    log_lines = log_text = None
    log_trusted, log_why = False, 'not a Chroxy run: there is no daemon log'
    session = _session(st)
    if run.harness.chroxy:
        log_lines, log_text, check, log_why = _daemon_slice(trial, env, start, end)
        results.append(check)
        log_trusted = check.status == checks.PASS
        if session is None:
            results.append(checks.unverified('session id', 'no session-phase preflight recorded one, so the daemon facts have no session'))
    top = CLAUDE_DIR if family == 'claude' else CODEX_DIR
    path = os.path.join(data_dir or trial.repo_path('data'), 'native', f'{run.id}.json')
    failure = None
    phase, staged, moved, written = 'destination', False, False, False
    try:
        # the destination is looked at again here, and again before the move: reading the transcripts took time
        problems = destination_problems(trial, env, base, run.id, clone_dir)
        if problems:
            failure = checks.failed('destination', '; '.join(problems))
        else:
            phase = 'copy'
            _make_private_dirs(base)
            staged = True
            rows, digest = _stage(stage, [(src, f'{top}/{rel}') for src, rel in found], log_text)
            summary, permission, isolation, workers_label = _derive(
                trial, run, env, stage, rows, clone_dir, log_text if log_trusted else None)
            doc = _build(trial, run, env, results, summary, permission, isolation, workers_label,
                         dict(window=(start, end), digest=digest, files=len(rows), session=session, log_lines=log_lines,
                              log_text=log_text, log_trusted=log_trusted, log_why=log_why))
            phase = 'destination'
            problems = destination_problems(trial, env, base, run.id, clone_dir)
            if problems:
                failure = checks.failed('destination', '; '.join(problems))
            else:
                phase = 'move'
                os.replace(stage, target)
                moved = True
                phase = 'extract'
                _write_json(path, doc)
                written = True
    except OSError as exc:
        failure = checks.failed('extract' if phase == 'extract' else 'copy',
                                {'move': f'cannot move the staged copy to {target}: {exc}',
                                 'extract': f'cannot write {path}: {exc}'}.get(phase, str(exc)))
    except Exception as exc:  # noqa: BLE001 -- anything at all: the stage holds raw transcripts and must go
        # the class only: the message of a parse error can quote the line that caused it
        failure = checks.failed('extract' if phase == 'extract' else 'derive', f'{type(exc).__name__} while {DOING[phase]}')
    finally:
        left = _discard(*([stage] if staged and not moved else []), *([target] if moved and not written else []),
                        *([path + '.tmp'] if phase == 'extract' and not written else []))
    if left:
        results.append(checks.failed('cleanup', 'could not remove ' + '; '.join(left) + ': remove it by hand'))
    if failure or left:
        if failure:
            results.append(failure)
        env.print(checks.render(results, title))
        return checks.exit_code(results)
    results.append(checks.passed('manifest', f'{doc["evidence"]["files"]} file(s) listed, sha256 {doc["evidence"]["manifest_sha256"][:12]}'))
    env.print(checks.render(results, f'evidence {run.id}'))
    env.print(f'  evidence: {target}')
    env.print(f'  manifest sha256: {doc["evidence"]["manifest_sha256"]}')
    env.print(f'  extract: {path}')
    cost, cost_note = doc['cost'], doc['cost_note']
    env.print('  cost: ' + (f'${cost["usd"]:.2f} (prices as of {cost["as_of"]})' if cost != 'n/a' else f'n/a ({cost_note})'))
    for hit in doc['isolation']['hits']:
        env.print(f'  isolation: {hit["pattern"]} x{hit["count"]} ({hit["distinct"]} distinct)')
    return checks.exit_code(results)


# The checks each runs.json field of the extract depends on: it is written only while every one of them is a pass
RUNS_ROW_NEEDS = {'workers': ('coordinator transcripts', 'transcript lines'),
                  'compactions': ('coordinator transcripts', 'transcript lines', 'human messages')}


def _build(trial, run, env, results, summary, permission, isolation, workers_label, facts):
    """Judge what was read, append the checks, and return the extract document. A figure whose check is not a pass
    is left out of the document (null), never carried as if it were data."""
    start, end = facts['window']
    reads, tok = summary['lines'], summary['tokens']
    why_not = {}     # figure -> why it is not carried
    if summary['coordinator']['transcripts']:
        results.append(checks.passed('coordinator transcripts', f'{summary["coordinator"]["transcripts"]} read'))
    else:
        results.append(checks.unverified('coordinator transcripts', 'none was read, so nothing says what the coordinator did'))
    lines_ok = not reads['unreliable_files'] and reads['read'] > 0
    if lines_ok:
        results.append(checks.passed('transcript lines', f'{reads["read"]} line(s) in {reads["files"]} file(s), {reads["malformed"]} skipped'))
    else:
        results.append(checks.unverified(
            'transcript lines', f'{reads["unreliable_files"]} of {reads["files"]} file(s) had no usable record, or more than '
                                f'{native.MAX_MALFORMED} or {native.MAX_MALFORMED_SHARE:.0%} of their lines unusable '
                                f'({reads["malformed"]} of {reads["read"]} skipped overall, {reads["unreadable_files"]} file(s) not '
                                f'openable): the counts may be short'
            if reads['read'] else 'no line could be read from the copied transcripts'))
        # what was counted is a lower bound of unknown size: not carried, as for a forked rollout
        tok = dict(tok, by_model={}, by_role={'coordinator': {}, 'workers': {}},
                   unverified='transcript lines were not read whole: totals withheld')
        why_not['people'] = 'transcript lines were not read whole'
    by_model = tok['by_model']
    tokens = sum(sum(row.values()) for row in by_model.values())
    if tok.get('unverified'):
        results.append(checks.unverified('token totals', tok['unverified']))
    else:
        results.append(checks.passed('token totals', f'{tokens} token(s) over {len(by_model)} model(s)') if tokens
                       else checks.unverified('token totals', 'no usage record in the transcripts: the format may have changed'))
    missing = tok.get('rollouts_without_usage', 0)
    if missing:
        results.append(checks.unverified('rollout tokens', f'{missing} rollout(s) had no token record or no model, so their usage is '
                                                           f'not in the totals'))
    if not isolation['tool_inputs_scanned']:
        results.append(checks.unverified('isolation scan', 'no tool input found in the transcripts, so nothing was scanned'))
    elif not lines_ok:
        results.append(checks.unverified('isolation scan', f'{isolation["tool_inputs_scanned"]} tool input(s) scanned, but not every '
                                                           f'transcript line was read: no hit proves less than it says'))
    else:
        results.append(checks.passed('isolation scan', f'{isolation["tool_inputs_scanned"]} tool input(s) scanned'))
    if tok.get('unverified'):
        cost, cost_note = 'n/a', 'token totals are not verified'
    else:
        cost, cost_note = extract.cost(by_model, trial.prices)
    if cost_note and trial.prices is not None:
        results.append(checks.unverified('cost', cost_note))
    people = {k: summary[k] for k in ('human_messages_total', 'human_messages_after_first', 'interrupts', 'compactions')}
    if not summary['human_messages_total']:
        # every run opens with its invocation, so none found means the reader failed, not that nobody spoke
        results.append(checks.unverified('human messages', 'none found in the coordinator transcript(s) although the invocation is '
                                                           'one: the people counts are not recorded'))
        people.update(human_messages_total=None, human_messages_after_first=None, interrupts=None, compactions=None)
        why_not.setdefault('people', 'no human message was found, although the invocation is one')
    else:
        results.append(checks.passed('human messages', f'{summary["human_messages_total"]} found'))
    if 'people' in why_not:
        if not lines_ok:
            people = dict.fromkeys(people)
        people['unverified'] = why_not['people']
    if permission is not None:
        if permission['unrecognized_lines']:
            # the daemon says something about permissions this reader does not know: its counts may be short
            results.append(checks.unverified('permission lines', f'{permission["unrecognized_lines"]} line(s) open like a permission '
                                                                 f'message but match none this reader knows'))
            permission = None
            facts = dict(facts, log_why='permission log lines were not recognised')
        else:
            results.append(checks.passed('permission lines', f'{permission["requests"]} request(s), every permission line recognised'))
    notes = []
    if tok.get('stale_final_rollouts'):
        notes.append(f'{tok["stale_final_rollouts"]} rollout(s) ended on a token record below an earlier one; '
                     f'the largest record of each was used')
    daemon = None
    if facts['log_trusted']:
        daemon = dict(_daemon_facts(facts['session'], facts['log_text']), lines_in_window=len(facts['log_lines']))
    statuses = {c.name: c.status for c in results}
    row = extract.runs_row(summary, permission, workers_label)
    runs_row = {k: v for k, v in row.items()
                if k == 'approvals' or all(statuses.get(n) == checks.PASS for n in RUNS_ROW_NEEDS[k])}
    doc = {'schema': extract.SCHEMA, 'trial': trial.id, 'run': run.id, 'harness': run.harness.key, 'family': run.harness.family,
           'chroxy': run.harness.chroxy, 'generated_at': timeutil.iso(env.now()),
           'window': {'start': timeutil.iso(start), 'end': timeutil.iso(end)},
           'turn_unit': summary['turn_unit'], 'coordinator': summary['coordinator'], 'workers': summary['workers'],
           'tokens': tok, 'cost': cost, 'cost_note': cost_note, 'people': people, 'transcript_lines': reads,
           'permissions': permission, 'daemon': daemon, 'isolation': isolation, 'notes': notes,
           'evidence': {'manifest_sha256': facts['digest'], 'files': facts['files']}, 'runs_row': runs_row}
    if permission is None:
        doc['permissions_unavailable'] = facts['log_why']
    # name and status only: the detail text of a check can hold a path
    doc['checks'] = [{'name': c.name, 'status': c.status} for c in results]
    return doc
