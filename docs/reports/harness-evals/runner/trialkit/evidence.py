"""`trialctl evidence`: keep a finished run's native record and derive its public extract.

The repository is public and a raw transcript holds everything the run read and
said, so it must never land in a work tree. This command copies the run's Claude
Code transcripts, Codex rollouts and (for a Chroxy run) the daemon log lines of
its window into `paths.evidence_dir` on the owner's Mac, writes a SHA-256
manifest beside them, and writes `<data>/native/<RUN>.json`: only the counts,
model names and hashes `extract.py` derives, plus the manifest's digest so the
vault copy can be verified later.

It refuses, writing nothing, when the destination is inside the trial
repository, the run's clone or any git work tree (the owner's private vault may
be declared in `paths.evidence_vault`: the one work tree evidence may live in).
The copy is staged beside its destination and moved into place last, and the
extract is written after it, so a failure leaves neither behind.
"""
import hashlib
import os
import shutil
from datetime import timedelta

from . import checks, extract, native, state, timeutil
from .collect import _write_json
from .launch import START_GRACE, _clone_dir, _inside, _work_tree_above

END_GRACE = timedelta(minutes=10)
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


def destination_problems(trial, env, target, clone_dir):
    """Why `target` may not hold raw transcripts, as a list of sentences (empty when it may)."""
    problems = []
    real = os.path.realpath(target)
    if _inside(real, os.path.realpath(trial.root)):
        problems.append(f'it is inside the trial repository {trial.root}')
    if clone_dir and _inside(real, os.path.realpath(clone_dir)):
        problems.append(f'it is inside the run\'s clone {clone_dir}')
    vault = _path(trial, env, 'evidence_vault')
    private = os.path.realpath(vault) if vault else None
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
    if os.path.lexists(target) and (not os.path.isdir(target) or os.listdir(target)):
        problems.append(f'{target} already exists; evidence is written once, so move it aside to write it again')
    return problems


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
    """(lines, text, check): the daemon log lines inside the window. `lines` is None when it cannot be read."""
    name = 'daemon log'
    path = _path(trial, env, 'daemon_log')
    if not path:
        return None, None, checks.unverified(name, 'paths.daemon_log is not set in trial.json')
    text = ''
    try:
        for part in _log_paths(path):
            with open(part, encoding='utf-8', errors='replace') as fh:
                text += fh.read()
    except OSError as exc:
        return None, None, checks.unverified(name, f'cannot read {path}: {exc}')
    lines = extract.slice_log(text, start, end)
    stamps = [s for s, _m in native.log_entries(text) if s]
    try:
        oldest = timeutil.parse_ts(stamps[0]) if stamps else None
    except ValueError:
        oldest = None
    if oldest is None:
        return lines, '\n'.join(lines), checks.unverified(name, f'{path} has no timestamped line')
    if oldest > start:
        return lines, '\n'.join(lines), checks.unverified(
            name, f'the oldest retained line is {timeutil.iso(oldest)}, after the window start {timeutil.iso(start)}: '
                  f'rotation has dropped the beginning of the run')
    if not lines:
        return lines, '', checks.unverified(name, f'no line of {path} falls in the window')
    return lines, '\n'.join(lines), checks.passed(name, f'{len(lines)} line(s) in the window')


def _session(st):
    """The Chroxy session id the last session-phase preflight recorded, or None."""
    for entry in reversed(st.get('preflight') or []):
        if isinstance(entry, dict) and entry.get('phase') == 'session':
            sid = (entry.get('facts') or {}).get('session')
            if isinstance(sid, str) and sid:
                return sid
    return None


def _daemon_facts(session, text):
    found = native.session_findings(text, session) if session else None
    return {'session': session,
            'model': found['model'][0] if found and found['model'] else None,
            'permission_mode': found['mode'][0] if found and found['mode'] else None,
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

def _derive(trial, run, env, stage, rows, clone_dir, log_text):
    """(summary, permissions, isolation report, label) read from the staged copies, so the extract describes
    exactly what the manifest holds."""
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
    permission = extract.permissions(log_text) if log_text is not None else None
    return summary, permission, scanner.report(), label


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
    base = _path(trial, env, 'evidence_dir')
    if not base:
        env.print('evidence: paths.evidence_dir is not set in trial.json')
        return 2
    base = os.path.abspath(base)
    clone_dir = _clone_dir(trial, run, env, st)
    target = os.path.join(base, run.id)
    problems = destination_problems(trial, env, target, clone_dir)
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
    session = _session(st)
    if run.harness.chroxy:
        log_lines, log_text, check = _daemon_slice(trial, env, start, end)
        results.append(check)
        if session is None:
            results.append(checks.unverified('session id', 'no session-phase preflight recorded one, so the daemon facts have no session'))
    top = CLAUDE_DIR if family == 'claude' else CODEX_DIR
    stage = os.path.join(base, f'.{run.id}.partial')
    os.makedirs(base, mode=0o700, exist_ok=True)
    try:
        rows, digest = _stage(stage, [(src, f'{top}/{rel}') for src, rel in found], log_text)
        summary, permission, isolation, workers_label = _derive(trial, run, env, stage, rows, clone_dir, log_text)
    except OSError as exc:
        shutil.rmtree(stage, ignore_errors=True)
        return _refuse(env, results, title, checks.failed('copy', str(exc)))
    by_model = summary['tokens']['by_model']
    tokens = sum(sum(row.values()) for row in by_model.values())
    results.append(checks.passed('token totals', f'{tokens} token(s) over {len(by_model)} model(s)') if tokens
                   else checks.unverified('token totals', 'no usage record in the transcripts: the format may have changed'))
    missing = summary['tokens'].get('rollouts_without_usage', 0)
    if missing:
        results.append(checks.unverified('rollout tokens', f'{missing} rollout(s) had no token record or no model, so their usage is '
                                                           f'not in the totals'))
    results.append(checks.passed('isolation scan', f'{isolation["tool_inputs_scanned"]} tool input(s) scanned')
                   if isolation['tool_inputs_scanned']
                   else checks.unverified('isolation scan', 'no tool input found in the transcripts, so nothing was scanned'))
    cost, cost_note = extract.cost(by_model, trial.prices)
    if cost_note and trial.prices is not None:
        results.append(checks.unverified('cost', cost_note))
    people = {k: summary[k] for k in ('human_messages_total', 'human_messages_after_first', 'interrupts', 'compactions')}
    daemon = dict(_daemon_facts(session, log_text), lines_in_window=len(log_lines)) if log_lines is not None else None
    doc = {'schema': extract.SCHEMA, 'trial': trial.id, 'run': run.id, 'harness': run.harness.key, 'family': family,
           'chroxy': run.harness.chroxy, 'generated_at': timeutil.iso(env.now()),
           'window': {'start': timeutil.iso(start), 'end': timeutil.iso(end)},
           'turn_unit': summary['turn_unit'], 'coordinator': summary['coordinator'], 'workers': summary['workers'],
           'tokens': summary['tokens'], 'cost': cost, 'cost_note': cost_note, 'people': people,
           'permissions': permission, 'daemon': daemon, 'isolation': isolation,
           'evidence': {'manifest_sha256': digest, 'files': len(rows)},
           'runs_row': extract.runs_row(summary, permission, workers_label)}
    path = os.path.join(data_dir or trial.repo_path('data'), 'native', f'{run.id}.json')
    try:
        os.replace(stage, target)
    except OSError as exc:
        shutil.rmtree(stage, ignore_errors=True)
        return _refuse(env, results, title, checks.failed('copy', f'cannot move the staged copy to {target}: {exc}'))
    try:
        _write_json(path, doc)
    except OSError as exc:
        shutil.rmtree(target, ignore_errors=True)
        return _refuse(env, results, title, checks.failed('extract', f'cannot write {path}: {exc}'))
    results.append(checks.passed('manifest', f'{len(rows)} file(s) listed, sha256 {digest[:12]}'))
    env.print(checks.render(results, f'evidence {run.id}'))
    env.print(f'  evidence: {target}')
    env.print(f'  manifest sha256: {digest}')
    env.print(f'  extract: {path}')
    env.print('  cost: ' + (f'${cost["usd"]:.2f} (prices as of {cost["as_of"]})' if cost != 'n/a' else f'n/a ({cost_note})'))
    for hit in isolation['hits']:
        env.print(f'  isolation: {hit["pattern"]} x{hit["count"]} ({hit["distinct"]} distinct)')
    return checks.exit_code(results)
