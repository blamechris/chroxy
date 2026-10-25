"""The launch side of a run: gate, cut, clone, preflight, prepare, start, verify-start, finish.

October lost days to runs that started at the wrong effort or on the wrong
model and nobody read it back. Every function here therefore does one of two
things: checks a precondition before the send, or reads the applied settings
back from the harness's own record after it. Each returns an exit code
(checks.exit_code: 0 all passed, 1 a check failed, 2 something could not be
checked), and "could not check" is never folded into a pass.

The only writes are the run's clone, the run's state file, `trial.json`'s T0
(via config.save_t0), the queue's text digests at T0 (`queue-t0.json`, via
queue_text.write) and, with `cut --push`, a git push of a new base branch.
Everything else reads: harness files, daemon logs, GitHub, `--version`.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import tempfile
from datetime import timedelta

from . import checks, config, native, queue_text, render, state, timeutil, workflow
from .gh import GitHubError

SHA = re.compile(r'^[0-9a-f]{40}$')
SEMVER = re.compile(r'(\d+)\.(\d+)\.(\d+)')
DEPLOY_LABEL = 'com.chroxy.deploy'
START_GRACE = timedelta(minutes=5)

# meter -> (allowance key in trial.json, 'min' = reading must be at least, 'max' = at most)
FLOORS = {
    'codex_weekly_left': ('codex_weekly_left_min', 'min'),
    'claude_5h_used': ('claude_5h_used_max', 'max'),
    'claude_weekly_used': ('claude_weekly_used_max', 'max'),
}


# -- plumbing ------------------------------------------------------------------

def _env(env, extra=None):
    """The process environment for a subprocess: this Env's HOME, never a prompt for credentials."""
    out = dict(env.environ)
    out['HOME'] = env.home
    out.setdefault('GIT_TERMINAL_PROMPT', '0')
    if extra:
        out.update(extra)
    return out


def _run(env, argv, cwd=None, extra=None):
    return env.runner.run(argv, cwd=cwd, env=_env(env, extra))


def _git(env, cwd, *args):
    return _run(env, ['git', *args], cwd=cwd)


def _tail(result, limit=300):
    text = (result.stderr or result.stdout or '').strip()
    return text[-limit:] if text else f'exit {result.returncode}'


def _path(trial, env, name):
    return trial.local_path(name, env.home)


def _load(trial, run, env, state_file):
    return state.load(trial, run.id, override=state_file, home=env.home)


def _save(trial, run, env, data, state_file):
    return state.save(trial, run.id, data, override=state_file, home=env.home, now=env.now)


def _at(env):
    return timeutil.iso(env.now())


def _clone_dir(trial, run, env, st):
    recorded = (st.get('clone') or {}).get('dir')
    if recorded:
        return os.path.abspath(env.expand(recorded))
    return trial.clone_dir(run, env.home)


def _worst(codes):
    if 1 in codes:
        return 1
    return 2 if any(codes) else 0


def _dicts(results):
    return [c.as_dict() for c in results]


def _load_json(path):
    """(data, 'ok' | 'missing' | 'bad')."""
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh), 'ok'
    except FileNotFoundError:
        return None, 'missing'
    except (OSError, ValueError):
        return None, 'bad'


def _sha256(path):
    try:
        with open(path, 'rb') as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None


def _blob_id(data):
    """The git object id of `data` as a blob, so file bytes can be compared with a committed file."""
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def _semver(text):
    m = SEMVER.search(text or '')
    return tuple(int(g) for g in m.groups()) if m else None


def _live_check(trial, run, env):
    name = 'no other run live'
    try:
        live = state.live_runs(trial, exclude=run.id, home=env.home)
    except (OSError, ValueError) as exc:
        return checks.unverified(name, f'cannot read the other runs\' state files: {exc}')
    if live:
        return checks.failed(name, f'{", ".join(live)} started and has not finished; runs never overlap')
    return checks.passed(name, 'no other run has a start without a finish')


# -- gate ----------------------------------------------------------------------

def _issue_state(gh, number):
    try:
        issue = gh.get(gh.repo_path(f'issues/{number}'))
    except (GitHubError, ValueError) as exc:
        return None, str(exc)
    value = issue.get('state') if isinstance(issue, dict) else None
    if value in ('open', 'closed'):
        return value, None
    return None, f'unexpected response for issue {number}'


def _blocker_check(gh, number, accept_open, accepted):
    name = f'blocker #{number}'
    value, error = _issue_state(gh, number)
    if error:
        return checks.unverified(name, error)
    if value == 'closed':
        return checks.passed(name, 'closed')
    if number in accept_open:
        accepted[str(number)] = accept_open[number]
        return checks.passed(name, f'open, accepted: {accept_open[number]}')
    return checks.failed(name, f'open; close it, or accept it with --accept-open {number}=REASON')


def _queue_checks(trial, gh):
    if not trial.slots:
        return [checks.failed('queue non-empty', f'the queue is empty ({trial.queue_status or "no status"})')]
    out = [checks.passed('queue non-empty', f'{len(trial.slots)} slots')]
    for slot in trial.slots:
        name = f'queue {slot.slot} #{slot.issue}'
        value, error = _issue_state(gh, slot.issue)
        if error:
            out.append(checks.unverified(name, error))
        elif value == 'closed':
            out.append(checks.failed(name, 'queue item already closed'))
        else:
            out.append(checks.passed(name, 'open'))
    return out


def _ci_check(trial, run, gh):
    name = 'ci.yml runs on the base'
    if not trial.t0:
        return checks.unverified(name, 'no T0 recorded, so ci.yml at T0 cannot be read')
    try:
        reply = gh.get(gh.repo_path('contents/.github/workflows/ci.yml'), {'ref': trial.t0})
        text = base64.b64decode(reply['content']).decode('utf-8')
    except (GitHubError, KeyError, TypeError, ValueError) as exc:
        return checks.unverified(name, f'cannot read ci.yml at T0: {exc}')
    try:
        patterns = workflow.push_branches(text)
    except workflow.WorkflowParseError as exc:
        return checks.unverified(name, f'cannot read the push trigger: {exc}')
    shown = 'every branch' if patterns is None else json.dumps(patterns)
    if workflow.branch_covered(run.base, patterns):
        return checks.passed(name, f'a push to {run.base} matches {shown}')
    return checks.failed(name, f'push branches {shown} do not cover {run.base}: red CI on the base would not be observable')


def _record_override(overrides, entry, env):
    """Append `entry` (with the time) unless the same acceptance is already recorded."""
    if entry not in [{k: o.get(k) for k in entry} for o in overrides]:
        overrides.append(dict(entry, at=_at(env)))


def gate(trial, run, env, accept_open, state_file, accept_changed=None):
    st = _load(trial, run, env, state_file)
    gh = env.github(trial.repo)
    accept_open = dict(accept_open or {})
    accept_changed = dict(accept_changed or {})
    blockers = trial.blockers_for(run)
    accepted, accepted_changed, results = {}, {}, []
    for number in blockers:
        results.append(_blocker_check(gh, number, accept_open, accepted))
    for number in sorted(set(accept_open) - set(blockers)):
        env.print(f'note: --accept-open {number} ignored; it is not a blocker for {run.id}')
    results += _queue_checks(trial, gh)
    results += queue_text.gate_checks(trial, gh, accept_changed, accepted_changed)
    for slot in sorted(set(accept_changed) - {s.slot for s in trial.slots}):
        env.print(f'note: --accept-changed {slot} ignored; it is not a queue slot')
    if trial.t0:
        results.append(checks.passed('T0 set', trial.t0))
    else:
        results.append(checks.failed('T0 set', 'trial.json records no t0; cut the bases first'))
    results.append(_ci_check(trial, run, gh))
    results.append(_live_check(trial, run, env))
    st['gate'] = {'at': _at(env), 't0': trial.t0, 'checks': _dicts(results), 'accepted_open': accepted,
                  'accepted_changed': accepted_changed}
    overrides = st.setdefault('overrides', [])
    for number, reason in accepted.items():
        _record_override(overrides, {'kind': 'accept-open', 'issue': int(number), 'reason': reason}, env)
    for slot, acceptance in accepted_changed.items():
        _record_override(overrides, {'kind': 'accept-changed', 'slot': slot, **acceptance}, env)
    _save(trial, run, env, st, state_file)
    env.print(checks.render(results, f'gate {run.id}'))
    return checks.exit_code(results)


# -- cut -----------------------------------------------------------------------

def _first_sha(listing, ref):
    """The object id `git ls-remote` lists for exactly `ref` (it matches by tail, so other refs can come back)."""
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == ref and SHA.match(parts[0]):
            return parts[0]
    return None


def _inspect_base(env, repo, trial, run, sha, t0, want):
    """('ok' | 'bad' | 'unknown', why): is `sha` T0 plus the rendered mission and nothing else?"""
    rel = trial.mission_relpath(run)
    parents = _git(env, repo, 'rev-list', '--parents', '-n', '1', sha)
    if not parents.ok:
        return 'unknown', f'cannot inspect {sha[:12]} ({_tail(parents)}); fetch origin first'
    ids = parents.stdout.split()
    if ids[1:] != [t0]:
        return 'bad', f'{sha[:12]} has parents {[i[:12] for i in ids[1:]]}, not exactly T0 {t0[:12]}'
    diff = _git(env, repo, 'diff', '--name-only', '--no-renames', t0, sha)
    if not diff.ok:
        return 'unknown', f'cannot diff {sha[:12]} against T0 ({_tail(diff)})'
    paths = [p for p in diff.stdout.splitlines() if p]
    if paths != [rel]:
        return 'bad', f'{sha[:12]} differs from T0 in {paths}, not only {rel}'
    blob = _git(env, repo, 'rev-parse', f'{sha}:{rel}')
    if not blob.ok:
        return 'unknown', f'cannot read {rel} at {sha[:12]} ({_tail(blob)})'
    if blob.stdout.strip() != _blob_id(want):
        return 'bad', f'the mission at {sha[:12]} differs from the one rendered from trial.json now'
    return 'ok', ''


def _cut_one(trial, run, env, repo, t0, want, push):
    name = f'base {run.base}'
    listing = _git(env, repo, 'ls-remote', 'origin', f'refs/heads/{run.base}')
    if not listing.ok:
        return checks.unverified(name, f'cannot list origin\'s branches: {_tail(listing)}')
    existing = _first_sha(listing.stdout, f'refs/heads/{run.base}')
    if existing:
        verdict, why = _inspect_base(env, repo, trial, run, existing, t0, want)
        if verdict == 'ok':
            return checks.passed(name, f'already cut at {existing[:12]}')
        make = checks.failed if verdict == 'bad' else checks.unverified
        return make(name, f'exists on origin but {why}; it is not rewritten here')
    rel = trial.mission_relpath(run)
    tmp = tempfile.mkdtemp(prefix='trialctl-cut-')
    work = os.path.join(tmp, 'wt')
    added = False
    try:
        r = _git(env, repo, 'worktree', 'add', '--detach', work, t0)
        if not r.ok:
            return checks.failed(name, f'git worktree add failed: {_tail(r)}')
        added = True
        target = os.path.join(work, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as fh:
            fh.write(want)
        # -f: rendered missions are gitignored on main (trial-2/missions/.gitignore); the base is where one belongs.
        r = _git(env, work, 'add', '-f', '--', rel)
        if not r.ok:
            return checks.failed(name, f'git add failed: {_tail(r)}')
        r = _git(env, work, 'commit', '-m', f'docs(trial): mission for {run.id}')
        if not r.ok:
            return checks.failed(name, f'git commit failed: {_tail(r)}')
        r = _git(env, work, 'rev-parse', 'HEAD')
        sha = r.stdout.strip()
        if not r.ok or not SHA.match(sha):
            return checks.failed(name, f'cannot read the new commit: {_tail(r)}')
        verdict, why = _inspect_base(env, repo, trial, run, sha, t0, want)
        if verdict != 'ok':
            return checks.failed(name, f'built {sha[:12]} but {why}; nothing pushed')
        command = f'git -C {repo} push origin {sha}:refs/heads/{run.base}'
        if not push:
            return checks.passed(name, f'built {sha}, not pushed (re-run with --push, or: {command})')
        r = _git(env, work, 'push', 'origin', f'HEAD:refs/heads/{run.base}')
        if not r.ok:
            return checks.failed(name, f'git push failed: {_tail(r)}')
        back = _git(env, repo, 'ls-remote', 'origin', f'refs/heads/{run.base}')
        listed = _first_sha(back.stdout, f'refs/heads/{run.base}')
        if listed != sha:
            return checks.failed(name, f'pushed {sha[:12]} but origin lists {listed} afterwards')
        return checks.passed(name, f'pushed {sha}')
    finally:
        if added:
            _git(env, repo, 'worktree', 'remove', '--force', work)
        shutil.rmtree(tmp, ignore_errors=True)
        _git(env, repo, 'worktree', 'prune')


def _origin_is_trial_repo(trial, env, url):
    """True when `url` names trial.repo on GitHub (https or ssh, with or without .git), or is the
    configured `paths.clone_source` (a local repository in tests)."""
    source = _path(trial, env, 'clone_source')
    if source and os.path.realpath(env.expand(url)) == os.path.realpath(source):
        return True
    match = re.match(r'^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+?)(?:\.git)?/?$', url)
    return bool(match) and match.group(1).lower() == trial.repo.lower()


def cut(trial, runs, env, t0, push, repo_dir):
    repo = os.path.abspath(env.expand(repo_dir)) if repo_dir else trial.root
    t0 = (t0 or '').strip().lower()
    if not SHA.match(t0):
        env.print(f'cut: refusing: T0 must be a full 40-character commit SHA, got {t0!r}')
        return 2
    if push:
        # The push URL, not the fetch URL: `remote.origin.pushurl` or `pushInsteadOf` can send a push
        # somewhere `get-url` does not show. Checked before anything is fetched or T0 is recorded.
        url = _git(env, repo, 'remote', 'get-url', '--push', 'origin')
        pushes_to = url.stdout.strip() if url.ok else ''
        if not pushes_to or not _origin_is_trial_repo(trial, env, pushes_to):
            env.print(f'cut: refusing: origin pushes to {pushes_to or "an unreadable URL"}, not {trial.repo}; nothing fetched, recorded or pushed')
            return 2
    fetched = _git(env, repo, 'fetch', 'origin')
    if not fetched.ok:
        env.print(f'cut: refusing: git fetch origin failed in {repo}: {_tail(fetched)}')
        return 2
    ancestor = _git(env, repo, 'merge-base', '--is-ancestor', t0, 'origin/main')
    if not ancestor.ok:
        reason = 'is not an ancestor of origin/main' if ancestor.returncode == 1 else f'cannot be checked ({_tail(ancestor)})'
        env.print(f'cut: refusing: T0 {t0} {reason}')
        return 2
    try:
        missions = {run.id: render.mission(trial, run).encode('utf-8') for run in runs}
        config.check_t0(trial, t0)
        # The queue's text is read before anything is recorded: a slot that cannot be read refuses the cut, with
        # no T0 and no snapshot written. None when the snapshot already exists for this T0 (a later cut).
        frozen = queue_text.plan(trial, env.github(trial.repo), t0, lambda: _at(env))
        config.save_t0(trial, t0)
    except (render.RenderError, config.ConfigError, queue_text.QueueTextError) as exc:
        env.print(f'cut: refusing: {exc}')
        return 2
    if frozen:
        try:
            queue_text.write(trial, frozen)
        except (OSError, queue_text.QueueTextError) as exc:
            env.print(f'cut: refusing: T0 is recorded but {queue_text.FILE} could not be written ({exc}); '
                      f'nothing was cut. Run cut again once that is fixed: it writes the snapshot then')
            return 2
        env.print(f'queue text at T0 recorded in {os.path.relpath(queue_text.path(trial), trial.root)} '
                  f'({len(frozen["slots"])} slots); commit it with trial.json\'s t0')
    results = [_cut_one(trial, run, env, repo, t0, missions[run.id], push) for run in runs]
    env.print(checks.render(results, f'cut at T0 {t0[:12]} ({"pushing" if push else "local build only"})'))
    return checks.exit_code(results)


# -- clone ---------------------------------------------------------------------

def _inside(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _work_tree_above(path):
    """The nearest directory at or above `path` holding a `.git`, or None."""
    here = path
    while True:
        if os.path.exists(os.path.join(here, '.git')):
            return here
        parent = os.path.dirname(here)
        if parent == here:
            return None
        here = parent


def _destination_problems(trial, env, target):
    problems = []
    if os.path.lexists(target) and (not os.path.isdir(target) or os.listdir(target)):
        problems.append(f'{target} exists and is not empty')
    real = os.path.realpath(target)
    daemon = _path(trial, env, 'daemon_checkout')
    if daemon and _inside(real, os.path.realpath(daemon)):
        problems.append(f'it is inside the daemon checkout {daemon}')
    if _inside(real, os.path.realpath(trial.root)):
        problems.append(f'it is inside the trial repository {trial.root}')
    tree = _work_tree_above(real)
    if tree:
        problems.append(f'it is inside the git work tree at {tree}')
    return problems


def _identity(env):
    values = {}
    for key in ('user.name', 'user.email'):
        r = _git(env, None, 'config', '--global', '--get', key)
        values[key] = r.stdout.strip() if r.ok else ''
    if not values['user.name'] or not values['user.email']:
        return None, 'the global git config has no user.name / user.email, so the clone would commit as nobody in particular'
    return {'name': values['user.name'], 'email': values['user.email']}, None


def _node_path(trial, env):
    node_bin = _path(trial, env, 'node_bin')
    if not node_bin:
        return None
    return node_bin + os.pathsep + env.environ.get('PATH', '')


def clone(trial, run, env, dest, skip_install, state_file):
    st = _load(trial, run, env, state_file)
    target = os.path.abspath(env.expand(dest)) if dest else trial.clone_dir(run, env.home)
    refusals = []
    problems = _destination_problems(trial, env, target)
    if problems:
        refusals.append(checks.failed('destination', '; '.join(problems)))
    identity, why = _identity(env)
    if why:
        refusals.append(checks.failed('git identity', why))
    if refusals:
        env.print(checks.render(refusals, f'clone {run.id}: refused, nothing written'))
        return 1
    source = trial.clone_source(env.home)
    # --single-branch: a plain `--branch` clone still fetches every remote branch, so a fix that lands on main after T0
    # would be one `git log origin/main` away (#8794).
    r = _run(env, ['git', 'clone', '--branch', run.base, '--single-branch', source, target])
    if not r.ok:
        env.print(checks.render([checks.failed('git clone', f'{source} {run.base} -> {target}: {_tail(r)}')],
                                f'clone {run.id}'))
        return 1
    for key, value in (('user.name', identity['name']), ('user.email', identity['email'])):
        r = _git(env, target, 'config', key, value)
        if not r.ok:
            env.print(checks.render([checks.failed('clone identity', f'git config {key}: {_tail(r)}')], f'clone {run.id}'))
            return 1
    env.print(f'identity for {run.id}: {identity["name"]} <{identity["email"]}>')
    results = [checks.passed('git clone', f'{run.base} -> {target}'), _refs_check(env, run, target)]
    installed = False
    if skip_install:
        results.append(checks.passed('npm ci', 'skipped (--skip-install)'))
    else:
        extra = {'PATH': _node_path(trial, env)} if _node_path(trial, env) else None
        r = _run(env, ['npm', 'ci', '--no-audit', '--no-fund'], cwd=target, extra=extra)
        installed = r.ok
        results.append(checks.passed('npm ci', 'installed') if r.ok else checks.failed('npm ci', _tail(r)))
    status = _git(env, target, 'status', '--porcelain')
    if not status.ok:
        results.append(checks.unverified('clone clean', _tail(status)))
    elif status.stdout.strip():
        results.append(checks.failed('clone clean', f'untracked or modified files after setup: {status.stdout.strip()[:200]}'))
    else:
        results.append(checks.passed('clone clean', 'git status is empty'))
    head = _git(env, target, 'rev-parse', 'HEAD').stdout.strip()
    tip = _git(env, target, 'rev-parse', f'origin/{run.base}').stdout.strip()
    if head and head == tip:
        results.append(checks.passed('HEAD is origin base', head[:12]))
    else:
        results.append(checks.failed('HEAD is origin base', f'HEAD {head[:12] or "?"} vs origin/{run.base} {tip[:12] or "?"}'))
    st['clone'] = {'dir': target, 'base_tip': head, 'identity': identity, 'installed': installed, 'at': _at(env)}
    _save(trial, run, env, st, state_file)
    env.print(checks.render(results, f'clone {run.id}'))
    if checks.exit_code(results):
        env.print(f'clone {run.id}: not usable as it is; fix the failure above, or remove {target} and run clone again')
    return checks.exit_code(results)


# -- preflight -----------------------------------------------------------------

def _clone_checks(trial, run, env, st, clone_dir, facts):
    facts['clone_dir'] = clone_dir
    if not os.path.exists(os.path.join(clone_dir, '.git')):
        return [checks.failed('clone exists', f'{clone_dir} is not a git clone; run `trialctl clone {run.id}`')]
    out = [checks.passed('clone exists', clone_dir)]
    head = _git(env, clone_dir, 'rev-parse', 'HEAD')
    head_sha = head.stdout.strip() if head.ok else ''
    facts['head'] = head_sha or None
    status = _git(env, clone_dir, 'status', '--porcelain')
    if not status.ok:
        out.append(checks.unverified('clone clean', _tail(status)))
    elif status.stdout.strip():
        lines = status.stdout.strip().splitlines()
        out.append(checks.failed('clone clean', f'{len(lines)} changed or untracked path(s), first: {lines[0]}'))
    else:
        out.append(checks.passed('clone clean', 'git status is empty'))
    out.append(_origin_check(run, env, clone_dir, head_sha))
    out.append(_refs_check(env, run, clone_dir))
    out.append(_base_shape(trial, run, env, clone_dir))
    out.append(_mission_check(trial, run, clone_dir))
    out.append(_identity_check(env, st, clone_dir))
    return out


def _origin_check(run, env, clone_dir, head_sha):
    name = 'clone matches origin'
    listing = _git(env, clone_dir, 'ls-remote', 'origin', f'refs/heads/{run.base}')
    if not listing.ok or not head_sha:
        return checks.unverified(name, f'cannot compare with origin: {_tail(listing)}')
    tip = _first_sha(listing.stdout, f'refs/heads/{run.base}')
    if tip is None:
        return checks.failed(name, f'origin has no branch {run.base}')
    if tip == head_sha:
        return checks.passed(name, f'HEAD {head_sha[:12]} is origin\'s {run.base}')
    return checks.failed(name, f'HEAD is {head_sha[:12]} but origin\'s {run.base} is {tip[:12]}')


def _refs_check(env, run, clone_dir):
    """The clone knows no branch but its base: the only remote-tracking ref is origin/<base> (origin/HEAD too, when it
    points at the base) and the only fetch refspec is the base's own. A run that can list another branch can read what
    landed on it after T0 (#8794). Cloned with --single-branch; this reads what is actually there, so a clone made some
    other way, or one that has since fetched another branch, fails too."""
    name = 'clone refs'
    base = f'refs/remotes/origin/{run.base}'
    want = f'+refs/heads/{run.base}:{base}'
    again = f'remove the clone and run `trialctl clone {run.id}` again'
    refs = _git(env, clone_dir, 'for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes')
    if not refs.ok:
        return checks.unverified(name, f'cannot list the remote-tracking refs: {_tail(refs)}')
    configured = _git(env, clone_dir, 'config', '--get-all', 'remote.origin.fetch')
    if not configured.ok and configured.returncode != 1:   # exit 1 is "no such key", which is an answer
        return checks.unverified(name, f'cannot read remote.origin.fetch: {_tail(configured)}')
    seen, extra = [], []
    for line in refs.stdout.splitlines():
        ref, _sep, target = line.strip().partition(' ')
        seen.append(ref)
        if ref != base and not (ref == 'refs/remotes/origin/HEAD' and target == base):
            extra.append(ref + (f' -> {target}' if target else ''))
    refspecs = [x for x in configured.stdout.splitlines() if x.strip()] if configured.ok else []
    problems = []
    if base not in seen:
        problems.append(f'{base} is not among the remote-tracking refs {seen}')
    if extra:
        problems.append(f'extra remote-tracking ref(s): {", ".join(extra)}')
    if refspecs != [want]:
        problems.append(f'remote.origin.fetch is {refspecs}, expected exactly [{want!r}]')
    if problems:
        return checks.failed(name, f'{"; ".join(problems)}; {again}')
    return checks.passed(name, f'only {base} (fetch refspec {want})')


def _base_shape(trial, run, env, clone_dir):
    name = 'base shape'
    t0 = trial.t0
    if not t0:
        return checks.unverified(name, 'trial.json records no t0')
    count = _git(env, clone_dir, 'rev-list', '--count', f'{t0}..HEAD')
    if not count.ok:
        return checks.failed(name, f'T0 {t0[:12]} is not in this clone\'s history ({_tail(count)})')
    diff = _git(env, clone_dir, 'diff', '--name-only', '--no-renames', t0, 'HEAD')
    if not diff.ok:
        return checks.unverified(name, f'cannot diff against T0: {_tail(diff)}')
    rel = trial.mission_relpath(run)
    paths = [p for p in diff.stdout.splitlines() if p]
    problems = []
    if count.stdout.strip() != '1':
        problems.append(f'{count.stdout.strip()} commits over T0, expected exactly 1 (the mission)')
    if paths != [rel]:
        problems.append(f'changed paths {paths}, expected only {rel}')
    if problems:
        return checks.failed(name, '; '.join(problems))
    return checks.passed(name, f'one commit over T0 {t0[:12]}, touching only {rel}')


def _mission_check(trial, run, clone_dir):
    name = 'mission file'
    rel = trial.mission_relpath(run)
    try:
        want = render.mission(trial, run).encode('utf-8')
    except render.RenderError as exc:
        return checks.unverified(name, f'cannot render the mission to compare: {exc}')
    try:
        with open(os.path.join(clone_dir, rel), 'rb') as fh:
            got = fh.read()
    except OSError:
        return checks.failed(name, f'{rel} is missing from the clone')
    if got == want:
        return checks.passed(name, f'{rel} is byte-equal to the rendered mission ({len(want)} bytes)')
    return checks.failed(name, f'{rel} differs from the mission rendered from trial.json now')


def _identity_check(env, st, clone_dir):
    name = 'clone identity'
    recorded = (st.get('clone') or {}).get('identity')
    if not recorded:
        return checks.unverified(name, 'state records no clone identity (the clone was not made by trialctl clone)')
    seen = {}
    for key in ('user.name', 'user.email'):
        r = _git(env, clone_dir, 'config', '--get', key)
        seen[key] = r.stdout.strip() if r.ok else ''
    want = f'{recorded.get("name")} <{recorded.get("email")}>'
    got = f'{seen["user.name"] or "?"} <{seen["user.email"] or "?"}>'
    if got == want:
        return checks.passed(name, want)
    return checks.failed(name, f'the clone commits as {got}, the clone step recorded {want}')


def _node_check(trial, env, facts):
    name = 'node version'
    want = trial.versions.get('node_major')
    node_bin = _path(trial, env, 'node_bin')
    if want is None or not node_bin:
        return checks.unverified(name, 'versions.node_major or paths.node_bin is not set in trial.json')
    r = _run(env, [os.path.join(node_bin, 'node'), '--version'])
    m = re.match(r'v?(\d+)\.', r.stdout.strip()) if r.ok else None
    if not m:
        return checks.unverified(name, f'cannot read `node --version` from {node_bin}: {_tail(r)}')
    facts['node_version'] = r.stdout.strip()
    if int(m.group(1)) == int(want):
        return checks.passed(name, f'{r.stdout.strip()} (major {want} required)')
    return checks.failed(name, f'{r.stdout.strip()} in {node_bin}, major {want} required')


def _login_check(trial, env, facts):
    name = 'gh login'
    if not trial.github_login:
        return checks.unverified(name, 'trial.json has no github_login')
    r = _run(env, ['gh', 'api', 'user', '--jq', '.login'])
    login = r.stdout.strip()
    if not r.ok or not login:
        return checks.unverified(name, f'cannot read the logged-in GitHub user: {_tail(r)}')
    facts['gh_login'] = login
    if login == trial.github_login:
        return checks.passed(name, login)
    return checks.failed(name, f'gh is logged in as {login}, the trial expects {trial.github_login}')


def _ci_quiet_check(trial, env, facts):
    """No ci.yml run queued or in progress in the repository. Trial PRs and merges run CI on the same
    self-hosted runners the subject machine hosts (the macOS runner, the Docker Linux members), so a run
    sent while other CI is queued starts on a loaded fleet; a freshly cut base's own push run is one.
    The workflow and status are filtered by GitHub and read through `total_count`, so the answer covers
    every matching run, not only the first page."""
    name = 'CI fleet quiet'
    busy = []
    for status in ('queued', 'in_progress'):
        r = _run(env, ['gh', 'api', '-X', 'GET', f'repos/{trial.repo}/actions/workflows/ci.yml/runs',
                       '-f', f'status={status}', '-f', 'per_page=20'])
        try:
            reply = json.loads(r.stdout) if r.ok else None
        except ValueError:
            reply = None
        count = reply.get('total_count') if isinstance(reply, dict) else None
        if not isinstance(count, int) or isinstance(count, bool):
            why = f'cannot list {status} CI runs: {_tail(r) or "unreadable reply"}'
            # Runs already seen are a known FAIL; only an empty picture is "cannot tell".
            return checks.failed(name, f'{", ".join(busy)}; and {why}') if busy else checks.unverified(name, why)
        if count:
            shown = [f'{x.get("id")} {x.get("head_branch")} ({status})' for x in reply.get('workflow_runs') or []
                     if isinstance(x, dict)]
            busy += shown or [f'{count} run(s) ({status})']
            if count > len(shown):
                busy.append(f'… {count - len(shown)} more {status}')
    facts['ci_busy'] = busy
    if busy:
        return checks.failed(name, f'ci.yml run(s) queued or running: {", ".join(busy[:6])}; wait for them before the send')
    return checks.passed(name, 'no ci.yml run queued or in progress')


def _effort_setting(trial, run, env, facts):
    name = 'effort setting'
    path = _path(trial, env, 'claude_settings')
    if not path:
        return checks.unverified(name, 'paths.claude_settings is not set in trial.json')
    facts['claude_settings_sha256'] = _sha256(path)
    data, status = _load_json(path)
    if status == 'bad':
        return checks.unverified(name, f'{path} is not readable JSON')
    got = None
    if isinstance(data, dict) and isinstance(data.get('modelSettings'), dict):
        entry = data['modelSettings'].get(run.model)
        got = entry.get('effortLevel') if isinstance(entry, dict) else None
    where = f'modelSettings.{run.model}.effortLevel in {path}'
    if got == run.effort:
        return checks.passed(name, f'{where} is {got}')
    if got is None:
        return checks.failed(name, f'{where} is not set, so Claude Code would run at its own default effort, not {run.effort}')
    return checks.failed(name, f'{where} is {got!r}, the run needs {run.effort!r}')


def _claude_version(trial, env, facts):
    name = 'claude version'
    minimum = trial.versions.get('claude_min')
    r = _run(env, ['claude', '--version'])
    seen = _semver(r.stdout) if r.ok else None
    if seen is None:
        return checks.unverified(name, f'cannot read `claude --version`: {_tail(r)}')
    facts['claude_version'] = '.'.join(map(str, seen))
    if _semver(minimum) is None:
        return checks.unverified(name, f'versions.claude_min is not set in trial.json (claude is {facts["claude_version"]})')
    if seen >= _semver(minimum):
        return checks.passed(name, f'{facts["claude_version"]} >= {minimum}')
    return checks.failed(name, f'{facts["claude_version"]} is older than the minimum {minimum}')


def _files_under(root):
    out = []
    for dirpath, _dirs, files in os.walk(root):
        for fname in files:
            out.append(os.path.relpath(os.path.join(dirpath, fname), root))
    return sorted(out)


def _codex_prompts(trial, env, clone_dir):
    """Compile the clone's Codex prompts into a scratch HOME and compare them with the installed ones."""
    name = 'codex prompts'
    installed = _path(trial, env, 'codex_prompts')
    if not installed:
        return checks.unverified(name, 'paths.codex_prompts is not set in trial.json')
    if not os.path.isdir(clone_dir):
        return checks.unverified(name, 'there is no clone to compile the prompts from')
    scratch = tempfile.mkdtemp(prefix='trialctl-codex-home-')
    try:
        extra = {'HOME': scratch}
        if _node_path(trial, env):
            extra['PATH'] = _node_path(trial, env)
        r = _run(env, ['node', 'scripts/compile-skill-targets.mjs', '--targets', 'codex'], cwd=clone_dir, extra=extra)
        if not r.ok:
            return checks.unverified(name, f'the prompt compiler failed in the clone: {_tail(r)}')
        made = _files_under(os.path.join(scratch, '.codex', 'prompts'))
        if not made:
            return checks.failed(name, 'the prompt compiler wrote no prompts, so there is nothing to compare')
        missing, differ = [], []
        for rel in made:
            ours = os.path.join(scratch, '.codex', 'prompts', rel)
            theirs = os.path.join(installed, rel)
            try:
                with open(ours, 'rb') as a, open(theirs, 'rb') as b:
                    if a.read() != b.read():
                        differ.append(rel)
            except FileNotFoundError:
                missing.append(rel)
            except OSError as exc:
                return checks.unverified(name, f'cannot read {theirs}: {exc}')
        if missing or differ:
            parts = []
            if missing:
                parts.append(f'missing from {installed}: {", ".join(missing)}')
            if differ:
                parts.append(f'different from the clone\'s: {", ".join(differ)}')
            return checks.failed(name, '; '.join(parts) + f'; recompile: cd {clone_dir} && node scripts/compile-skill-targets.mjs --targets codex')
        return checks.passed(name, f'{len(made)} prompt(s) byte-equal to {installed}')
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def _codex_parity(trial, env, facts):
    name = 'codex roster parity'
    app = _path(trial, env, 'codex_app_cli')
    if not app:
        return checks.unverified(name, 'paths.codex_app_cli is not set in trial.json')
    path_cli = _run(env, ['codex', '--version'])
    app_cli = _run(env, [app, '--version'])
    if not app_cli.ok or not app_cli.stdout.strip():
        return checks.unverified(name, f'cannot run the Codex app\'s CLI at {app}: {_tail(app_cli)}')
    if not path_cli.ok or not path_cli.stdout.strip():
        return checks.unverified(name, f'cannot run `codex --version` from PATH: {_tail(path_cli)}')
    facts['codex_version'] = path_cli.stdout.strip()
    facts['codex_app_version'] = app_cli.stdout.strip()
    if facts['codex_version'] == facts['codex_app_version']:
        return checks.passed(name, f'PATH codex and the app CLI are both {facts["codex_version"]} (#8609)')
    return checks.failed(name, f'PATH codex is {facts["codex_version"]} but the app CLI is {facts["codex_app_version"]}: '
                               f'Chroxy would see another model roster (#8609)')


def _auto_check(trial, env):
    name = 'allowAutoPermissionMode'
    path = _path(trial, env, 'daemon_config')
    if not path:
        return checks.unverified(name, 'paths.daemon_config is not set in trial.json')
    data, status = _load_json(path)
    if status == 'bad':
        return checks.unverified(name, f'{path} is not readable JSON')
    value = data.get('allowAutoPermissionMode') if isinstance(data, dict) else None
    if value is True:
        return checks.passed(name, f'true in {path}')
    return checks.failed(name, f'{value!r} in {path}; unattended Auto needs true (#8619)')


def _deploy_check(env):
    name = 'deploy agent unloaded'
    if env.system != 'Darwin':
        return checks.unverified(name, f'launchctl is macOS only; this host is {env.system}')
    r = _run(env, ['launchctl', 'list'])
    if not r.ok or not r.stdout.strip():
        return checks.unverified(name, f'cannot read `launchctl list`: {_tail(r)}')
    if DEPLOY_LABEL in r.stdout:
        return checks.failed(name, f'{DEPLOY_LABEL} is loaded; it restarts the daemon under a live session (October run 2). '
                                   f'Unload it: launchctl bootout gui/$UID ~/Library/LaunchAgents/{DEPLOY_LABEL}.plist')
    return checks.passed(name, f'{DEPLOY_LABEL} is not in `launchctl list`')


def _recorded_daemon_commits(trial, run, env):
    seen, unreadable = {}, []
    for other in trial.runs:
        if other.id == run.id:
            continue
        path = state.state_path(trial, other.id, home=env.home)
        if not os.path.exists(path):
            continue
        try:
            data = state.load(trial, other.id, home=env.home)
        except (OSError, ValueError):
            unreadable.append(other.id)
            continue
        for entry in reversed(data.get('preflight') or []):
            commit = (entry.get('facts') or {}).get('daemon_commit') if entry.get('phase') == 'pre' else None
            if commit:
                seen[other.id] = commit
                break
    return seen, unreadable


def _daemon_commit(trial, run, env, facts):
    name = 'daemon commit'
    checkout = _path(trial, env, 'daemon_checkout')
    if not checkout:
        return checks.unverified(name, 'paths.daemon_checkout is not set in trial.json')
    r = _run(env, ['git', '-C', checkout, 'rev-parse', 'HEAD'])
    sha = r.stdout.strip()
    if not r.ok or not SHA.match(sha):
        return checks.unverified(name, f'cannot read the daemon checkout\'s HEAD: {_tail(r)}')
    facts['daemon_commit'] = sha
    others, unreadable = _recorded_daemon_commits(trial, run, env)
    differ = {rid: commit for rid, commit in others.items() if commit != sha}
    if differ:
        shown = ', '.join(f'{rid} recorded {commit[:12]}' for rid, commit in sorted(differ.items()))
        return checks.failed(name, f'the daemon is at {sha[:12]} but {shown}; the harness version must stay constant across the trial')
    if unreadable:
        return checks.unverified(name, f'{sha[:12]}, but the state of {", ".join(unreadable)} is unreadable')
    note = f'same as {", ".join(sorted(others))}' if others else 'first recorded'
    return checks.passed(name, f'{sha[:12]} ({note})')


def _preflight_session(trial, run, env, session, st, state_file):
    if not run.harness.chroxy:
        env.print(f'preflight --phase session: {run.id} is not a Chroxy run ({run.harness.label}); nothing to read from the daemon log')
        return 2
    if not session:
        env.print('preflight --phase session needs --session <the new session\'s id>')
        return 2
    path = _path(trial, env, 'daemon_log')
    facts = {'session': session, 'daemon_log': path}
    names = ('session model', 'session permission mode', 'session interrupt')
    results = []
    try:
        if not path:
            raise OSError('paths.daemon_log is not set in trial.json')
        with open(path, encoding='utf-8', errors='replace') as fh:
            text = fh.read()
    except (OSError, TypeError) as exc:
        where = f' {path}' if path else ''
        results = [checks.unverified(n, f'cannot read the daemon log{where}: {exc}') for n in names]
    else:
        found = native.session_findings(text, session)
        facts['model'] = found['model'][0] if found['model'] else None
        facts['permission_mode'] = found['mode'][0] if found['mode'] else None
        facts['interrupts'] = found['interrupts']
        aliases = list(run.harness.model_aliases)
        if found['model'] is None:
            results.append(checks.unverified(names[0], f'no "Model change" line for session {session} in {path}: the header was not '
                                                       f'changed, or this is not the daemon\'s log (verify-start reads the applied model)'))
        elif found['model'][0] in aliases:
            results.append(checks.passed(names[0], f'{found["model"][0]} (at {found["model"][1]})'))
        else:
            results.append(checks.failed(names[0], f'the last model change for session {session} is {found["model"][0]}, '
                                                   f'expected one of {aliases}'))
        if found['mode'] is None:
            results.append(checks.unverified(names[1], f'no "Permission mode change" line for session {session}: if Auto was chosen '
                                                       f'at creation the daemon does not log it'))
        elif found['mode'][0] == 'auto':
            results.append(checks.passed(names[1], f'auto (at {found["mode"][1]})'))
        else:
            results.append(checks.failed(names[1], f'the last permission mode change for session {session} is {found["mode"][0]}, expected auto'))
        if found['interrupts']:
            results.append(checks.failed(names[2], f'{len(found["interrupts"])} "Interrupt from" line(s) for session {session}, '
                                                   f'first at {found["interrupts"][0]}: the first turn was aborted'))
        else:
            results.append(checks.passed(names[2], f'no "Interrupt from" line for session {session}'))
    st.setdefault('preflight', []).append({'phase': 'session', 'at': _at(env), 'checks': _dicts(results), 'facts': facts})
    _save(trial, run, env, st, state_file)
    env.print(checks.render(results, f'preflight session {run.id}'))
    return checks.exit_code(results)


def preflight(trial, run, env, phase, session, state_file):
    st = _load(trial, run, env, state_file)
    if phase == 'session':
        return _preflight_session(trial, run, env, session, st, state_file)
    facts = {}
    clone_dir = _clone_dir(trial, run, env, st)
    results = _clone_checks(trial, run, env, st, clone_dir, facts)
    results.append(_node_check(trial, env, facts))
    results.append(_login_check(trial, env, facts))
    results.append(_ci_quiet_check(trial, env, facts))
    results.append(_live_check(trial, run, env))
    if run.harness.family == 'claude':
        results.append(_effort_setting(trial, run, env, facts))
        results.append(_claude_version(trial, env, facts))
    else:
        results.append(_codex_prompts(trial, env, clone_dir))
        results.append(_codex_parity(trial, env, facts))
    if run.harness.chroxy:
        results.append(_auto_check(trial, env))
        results.append(_deploy_check(env))
        results.append(_daemon_commit(trial, run, env, facts))
    st.setdefault('preflight', []).append({'phase': 'pre', 'at': _at(env), 'checks': _dicts(results), 'facts': facts})
    _save(trial, run, env, st, state_file)
    env.print(checks.render(results, f'preflight {run.id}'))
    return checks.exit_code(results)


# -- prepare -------------------------------------------------------------------

def _required_meters(run):
    return ['codex_weekly_left'] if run.harness.family == 'codex' else ['claude_5h_used', 'claude_weekly_used']


def _meter_flags(run):
    return ' '.join(f'--meter {k}=<percent>' for k in _required_meters(run))


def prepare(trial, run, env, accept_open, skip_install, state_file, accept_changed=None):
    codes = [gate(trial, run, env, accept_open, state_file, accept_changed)]
    if codes[0] == 1:
        env.print(f'prepare {run.id}: the entry gate failed; nothing was cloned. Fix it above, or accept an open blocker knowingly.')
        return 1
    st = _load(trial, run, env, state_file)
    recorded = (st.get('clone') or {}).get('dir')
    if recorded and os.path.isdir(env.expand(recorded)):
        env.print(f'clone: already present at {env.expand(recorded)}; not cloning again')
    else:
        codes.append(clone(trial, run, env, None, skip_install, state_file))
    codes.append(preflight(trial, run, env, 'pre', None, state_file))
    code = _worst(codes)
    if code == 1:
        env.print(f'prepare {run.id}: NOT READY. Fix the FAILs above and run `trialctl prepare {run.id}` again.')
        return 1
    st = _load(trial, run, env, state_file)
    h = run.harness
    card = [f'LAUNCH CARD {run.id}',
            f'  harness   {h.label}',
            f'  model     {run.model} / {run.effort}',
            f'  base      {run.base}',
            f'  clone     {_clone_dir(trial, run, env, st)}'
            + ('' if (st.get('clone') or {}).get('installed') else '  (dependencies NOT installed)'),
            '  invocation:']
    card += ['    ' + line for line in render.invocation(trial, run).splitlines()]
    card.append('  then:')
    if h.chroxy:
        card.append(f'    trialctl preflight {run.id} --phase session --session <the new session\'s id>')
    card.append(f'    trialctl start {run.id} {_meter_flags(run)}')
    card.append(f'    trialctl verify-start {run.id}      (within ten minutes of the send)')
    env.print('\n'.join(card))
    if code == 2:
        env.print(f'prepare {run.id}: NOT FULLY VERIFIED. Resolve the UNVERIFIED checks above, or proceed knowingly.')
    return code


# -- start ---------------------------------------------------------------------

def _latest_pre(st, phase='pre'):
    for entry in reversed(st.get('preflight') or []):
        if entry.get('phase') == phase:
            return entry
    return None


def _not_passed(entry):
    """The names and statuses of a recorded step's checks that did not pass; ['no checks recorded'] if none ran."""
    if not entry.get('checks'):
        return ['no checks recorded']
    return [f'{c.get("name")} {c.get("status")}' for c in entry['checks'] if c.get('status') != checks.PASS]


def _instant(value):
    """The moment an ISO-8601 timestamp names, or None when `value` is missing or cannot be read (a value that is no text, no
    timestamp, or so near the end of the calendar that its UTC time is out of range, such as 9999-12-31T23:59:59-05:00)."""
    try:
        return timeutil.parse_ts(value)
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def _out_of_order(step, entry, again, base, base_entry, base_again):
    """[] when recorded step `entry` ran at or after `base_entry`, else the one problem saying why it cannot be placed after it.
    The two `at` times are compared as moments, not as strings: `timeutil.iso` writes no fraction, or one of three or six
    digits, and `Z` sorts above `.`, so as text a preflight half a second after a whole-second gate is older than it (#8805).
    A time that cannot be read places its step nowhere, which is not after the other. `again` and `base_again` say what to run
    when the step's own time, or the base's, is the one to record anew."""
    at, base_at = entry.get('at'), base_entry.get('at')
    mine, theirs = _instant(at), _instant(base_at)
    if mine is None:
        return [f'the {step}\'s time ({at!r}) cannot be read, so it cannot be placed after the {base}; {again}']
    if theirs is None:
        return [f'the {base}\'s time ({base_at!r}) cannot be read, so the {step} cannot be placed after it; {base_again}']
    if mine < theirs:
        return [f'the {step} is older than the {base}; {again}']
    return []


def _order_problems(trial, run, st):
    """What the recorded steps say about sending now: the gate passed at this T0, then a pre-send
    preflight passed, then (Chroxy) the session-phase preflight passed. `start` is the step that
    commits the run, so it is the one that reads them; running clone, preflight and start by hand
    must not skip the gate (the wired-to-some-callers shape, #7262)."""
    problems = []
    gate = st.get('gate')
    if not gate:
        problems.append('no entry gate is recorded; run `trialctl gate` (or `prepare`)')
    else:
        if gate.get('t0') != trial.t0:
            problems.append(f'the gate was recorded at T0 {str(gate.get("t0"))[:12]}, not the current {str(trial.t0)[:12]}; run it again')
        bad = _not_passed(gate)
        if bad:
            problems.append(f'the entry gate ({gate.get("at")}) did not pass: {", ".join(bad)}')
    pre = _latest_pre(st)
    if pre is None:
        problems.append('no pre-send preflight is recorded; run `trialctl preflight` (or `prepare`)')
    else:
        bad = _not_passed(pre)
        if bad:
            problems.append(f'the latest preflight ({pre.get("at")}) did not pass: {", ".join(bad)}')
        if gate:
            problems.extend(_out_of_order('latest preflight', pre, 'run `trialctl preflight` again',
                                          'gate', gate, 'run `trialctl gate`, then `trialctl preflight`, again'))
    if run.harness.chroxy:
        session = _latest_pre(st, 'session')
        if session is None:
            problems.append('no session-phase preflight is recorded; run `trialctl preflight --phase session --session <id>`')
        else:
            bad = _not_passed(session)
            if bad:
                problems.append(f'the session-phase preflight ({session.get("at")}) did not pass: {", ".join(bad)}')
            if pre:
                problems.extend(_out_of_order('session-phase preflight', session, 'run it again',
                                              'pre-send preflight', pre, 'run `trialctl preflight`, then the session phase, again'))
    return problems


def start(trial, run, env, meters, override, sent_at, state_file):
    st = _load(trial, run, env, state_file)
    meters = dict(meters or {})
    required = _required_meters(run)
    missing = [k for k in required if k not in meters]
    if missing:
        env.print(f'start {run.id}: usage reading(s) missing: {", ".join(missing)}. Read them from the usage page and pass '
                  + ' '.join(f'--meter {k}=<percent>' for k in missing))
        return 2
    bad = {k: v for k, v in meters.items() if not 0 <= v <= 100}
    if bad:
        env.print(f'start {run.id}: a usage reading must be a percentage from 0 to 100, got {bad}')
        return 2
    sent = _at(env)
    if sent_at:
        try:
            sent = timeutil.iso(timeutil.parse_ts(sent_at))
        except ValueError:
            env.print(f'start {run.id}: --sent-at {sent_at!r} is not an ISO-8601 timestamp')
            return 2
    if st.get('finish'):
        env.print(f'start {run.id}: refused, this run already finished at {st["finish"].get("ended_at")}. A repeat is a '
                  f'new roster entry (its own id and base, added to trial.json by PR), never a second start of this one.')
        return 1
    try:
        live = state.live_runs(trial, exclude=run.id, home=env.home)
    except (OSError, ValueError) as exc:
        env.print(f'start {run.id}: refused, the other runs\' state files cannot be read ({exc}), so an overlap cannot be ruled out')
        return 1
    if live:
        env.print(f'start {run.id}: refused, {", ".join(live)} started and has not finished; runs never overlap')
        return 1
    problems = _order_problems(trial, run, st)
    for meter in required:
        key, kind = FLOORS[meter]
        limit = trial.allowance.get(key)
        value = meters[meter]
        if limit is None:
            problems.append(f'allowance.{key} is not set in trial.json, so {meter} cannot be checked')
        elif kind == 'min' and value < limit:
            problems.append(f'{meter} is {value:g}, below the floor of {limit:g} (every run starts on a fresh allowance)')
        elif kind == 'max' and value > limit:
            problems.append(f'{meter} is {value:g}, above the ceiling of {limit:g}')
    if st.get('start'):
        problems.append(f'a start is already recorded at {st["start"].get("sent_at")}; re-recording replaces it')
    if problems and not override:
        env.print(f'start {run.id}: refused')
        for problem in problems:
            env.print(f'  - {problem}')
        env.print('Fix them, or pass --override REASON to proceed knowingly (the reason is recorded in the run\'s state).')
        return 1
    previous = st.get('start')
    st['start'] = {'sent_at': sent, 'meters': meters, 'override': override or None}
    if previous:
        st['start']['replaces'] = previous
    if run.harness.family == 'claude':
        # The baseline `finish` compares against: taken at the send, so a later preflight re-run cannot move it.
        settings = _path(trial, env, 'claude_settings')
        st['start']['claude_settings_sha256'] = _sha256(settings) if settings else None
    if override:
        st.setdefault('overrides', []).append({'kind': 'start', 'reason': override, 'bypassed': problems, 'at': _at(env)})
    _save(trial, run, env, st, state_file)
    env.print(f'start {run.id}: recorded sent_at {sent}; meters ' + ', '.join(f'{k}={v:g}' for k, v in sorted(meters.items())))
    if override:
        env.print(f'  override recorded: {override}')
    env.print(f'You can send the invocation now. Then run `trialctl verify-start {run.id}` within ten minutes.')
    return 0


# -- verify-start --------------------------------------------------------------

def _one_of(name, observed, expected, empty_detail, what):
    """PASS when every observed value is the expected one; UNVERIFIED when nothing was observed."""
    if not observed:
        return checks.unverified(name, empty_detail)
    if set(observed) <= {expected}:
        return checks.passed(name, f'{what} {expected}')
    return checks.failed(name, f'observed {", ".join(map(str, observed))}, expected {expected}')


def _verify_claude(trial, run, env, clone_dir, since):
    projects = _path(trial, env, 'claude_projects')
    if not projects:
        return [checks.unverified('transcript found', 'paths.claude_projects is not set in trial.json')], {}, None, None
    found = native.find_claude_transcript(projects, clone_dir, run.id, since)
    if not found:
        folders = ', '.join(os.path.join(projects, s) for s in native.slug_candidates(clone_dir))
        return ([checks.failed('transcript found', f'no transcript in {folders} modified since {timeutil.iso(since)} has a user message '
                                                   f'"Trial run {run.id}": the session is in another folder, was never sent, or is '
                                                   f'not up yet (re-run once the first reply has arrived)')], {}, None, None)
    s = native.claude_summary(found)
    expect = run.harness.expect
    mine = [p for p in s['probes'] if p['run'] == run.id]
    foreign = [p for p in s['probes'] if p['run'] != run.id]
    efforts, source = s['efforts'], 'transcript entries'
    if not efforts and mine and mine[0]['effort'] != 'unset':
        efforts, source = [mine[0]['effort']], 'the TRIAL-PROBE line'
    results = [checks.passed('transcript found', os.path.relpath(found, projects)),
               _one_of('model', s['models'], run.model, 'the transcript has no assistant message yet, so no model is on record', 'every reply came from'),
               _one_of('effort', efforts, run.effort,
                       'neither the transcript entries nor the TRIAL-PROBE line record an effort (an older Claude Code, and the probe '
                       'has not run or printed unset)', f'per {source}:')]
    if expect.get('permission_mode'):
        results.append(_one_of('permission mode', s['permission_modes'], expect['permission_mode'],
                               'no permissionMode in the transcript yet', 'permissionMode on every entry:'))
    if expect.get('entrypoint'):
        results.append(_one_of('entrypoint', s['entrypoints'], expect['entrypoint'], 'no entrypoint in the transcript yet', 'entrypoint on every entry:'))
    if foreign and not mine:
        results.append(checks.failed('probe', f'the TRIAL-PROBE line names run {foreign[0]["run"]}, not {run.id}'))
    elif mine:
        p = mine[0]
        results.append(checks.passed('probe', f'run={p["run"]} effort={p["effort"]} entrypoint={p["entrypoint"]} app={p["app"]} at={p["at"]}'))
    else:
        results.append(checks.unverified('probe', 'no TRIAL-PROBE line in a tool result yet: the mission\'s first command has not run'))
    if s['interrupts']:
        results.append(checks.failed('no interrupt', f'{s["interrupts"]} "[Request interrupted by user]" entry(ies): the turn was aborted (October run 5)'))
    else:
        results.append(checks.passed('no interrupt', 'no interrupted-by-user entry'))
    applied = {'model': s['models'], 'effort': efforts, 'effort_source': source, 'permission_mode': s['permission_modes'],
               'entrypoint': s['entrypoints'], 'cli_version': s['versions'], 'worker_models': s['sidechain_models'],
               'probe': mine[0] if mine else None}
    first = mine[0]['at'] if mine else s['first_timestamp']
    return results, applied, os.path.relpath(found, projects), first


def _verify_codex(trial, run, env, clone_dir, since):
    sessions = _path(trial, env, 'codex_sessions')
    if not sessions:
        return [checks.unverified('rollout found', 'paths.codex_sessions is not set in trial.json')], {}, None, None
    found = native.find_codex_rollout(sessions, clone_dir, since)
    if not found:
        return ([checks.failed('rollout found', f'no coordinator rollout under {sessions} modified since {timeutil.iso(since)} has '
                                                f'cwd {clone_dir}: the session is in another folder, was never sent, or is not up yet '
                                                f'(re-run once the first turn has started)')], {}, None, None)
    s = native.codex_summary(found)
    expect = run.harness.expect
    mine = [p for p in s['probes'] if p['run'] == run.id]
    foreign = [p for p in s['probes'] if p['run'] != run.id]
    results = [checks.passed('rollout found', os.path.relpath(found, sessions)),
               _one_of('model', s['models'], run.model, 'the rollout has no turn_context yet, so no model is on record', 'every turn ran on'),
               _one_of('effort', s['efforts'], run.effort, 'the rollout has no turn_context effort yet', 'every turn ran at')]
    if expect.get('sandbox'):
        results.append(_one_of('sandbox', s['sandboxes'], expect['sandbox'], 'no sandbox_policy in the rollout yet', 'sandbox on every turn:'))
    if foreign and not mine:
        results.append(checks.failed('probe', f'the TRIAL-PROBE line names run {foreign[0]["run"]}, not {run.id}'))
    elif mine:
        p = mine[0]
        results.append(checks.passed('probe', f'run={p["run"]} at={p["at"]}'))
    else:
        results.append(checks.unverified('probe', 'no TRIAL-PROBE line in the rollout (optional for Codex, but without it the first command is unconfirmed)'))
    if s['interrupts']:
        results.append(checks.failed('no interrupt', f'{s["interrupts"]} aborted turn(s) in the rollout: the turn was interrupted'))
    else:
        results.append(checks.passed('no interrupt', 'no aborted turn'))
    applied = {'model': s['models'], 'effort': s['efforts'], 'sandbox': s['sandboxes'], 'approval_policy': s['approval_policies'],
               'cli_version': s['cli_version'], 'originator': s['originator'], 'probe': mine[0] if mine else None}
    first = mine[0]['at'] if mine else s['first_timestamp']
    return results, applied, os.path.relpath(found, sessions), first


def verify_start(trial, run, env, since, state_file):
    st = _load(trial, run, env, state_file)
    started = st.get('start')
    if not started:
        env.print(f'verify-start {run.id}: no start is recorded; run `trialctl start {run.id}` first')
        return 1
    try:
        if since:
            floor = timeutil.parse_ts(since)
        else:
            floor = timeutil.parse_ts(started.get('sent_at')) - START_GRACE
    except (ValueError, TypeError):
        env.print(f'verify-start {run.id}: cannot read the time to search from ({since or started.get("sent_at")!r})')
        return 2
    clone_dir = _clone_dir(trial, run, env, st)
    reader = _verify_claude if run.harness.family == 'claude' else _verify_codex
    results, applied, record, first = reader(trial, run, env, clone_dir, floor)
    st['verify_start'] = {'at': _at(env), 'checks': _dicts(results), 'applied': applied, 'transcript': record,
                          'first_command_at': first}
    _save(trial, run, env, st, state_file)
    env.print(checks.render(results, f'verify-start {run.id} (searching from {timeutil.iso(floor)})'))
    wrong = [c for c in results if c.status == checks.FAIL]
    if wrong:
        env.print('STOP: ' + '; '.join(f'{c.name}: {c.detail}' for c in wrong)
                  + f'. Stop run {run.id} and record a setup incident.')
    return checks.exit_code(results)


# -- finish --------------------------------------------------------------------

def _first_send(st):
    """When the run was first sent: the `sent_at` of the earliest start, following `replaces` back through re-recorded
    starts, or None when no start is recorded or the earliest has none."""
    started = st.get('start')
    while isinstance(started, dict) and isinstance(started.get('replaces'), dict):
        started = started['replaces']
    return started.get('sent_at') if isinstance(started, dict) else None


def _acceptances_ignored(st):
    """Why the recorded gate's acceptances cannot stand for the text the run started on, or None when they can. They can
    when no start or no gate is recorded (nothing says the gate came late) and when the gate is at or before the first send,
    ordered as moments, not as strings. A time that cannot be read puts the gate nowhere, so it is not before the send."""
    if not (st.get('start') and st.get('gate')):
        return None
    gate = st['gate'] if isinstance(st['gate'], dict) else {}
    at, sent = gate.get('at'), _first_send(st)
    gate_time, sent_time = _instant(at), _instant(sent)
    if gate_time is None or sent_time is None:
        return (f'the recorded gate\'s time ({at!r}) or the first send\'s ({sent!r}) cannot be read, so the gate cannot be placed before '
                f'the send; its acceptances are not used and the queue text is compared with T0 only')
    if gate_time > sent_time:
        return (f'the recorded gate ({at}) is later than the first send ({sent}), so the text it let through or accepted '
                f'is not the text the run started on; the queue text is compared with T0 only')
    return None


def finish(trial, run, env, meters, cost, ended_at, stop, state_file):
    st = _load(trial, run, env, state_file)
    ended = _at(env)
    if ended_at:
        try:
            ended = timeutil.iso(timeutil.parse_ts(ended_at))
        except ValueError:
            env.print(f'finish {run.id}: --ended-at {ended_at!r} is not an ISO-8601 timestamp')
            return 2
    record = {'ended_at': ended, 'meters': dict(meters or {}), 'cost': cost, 'stop': stop}
    previous = st.get('finish')
    if previous:
        was = previous.get('ended_at') if isinstance(previous, dict) else None
        if was and _instant(was) is None:
            moved = f'; its ended_at ({was!r}) cannot be read, so the new one ({ended}) cannot be checked against it'
        elif was and _instant(was) != _instant(ended):
            moved = f'; ended_at moves from {was} to {ended} (pass --ended-at {was} to keep it)'
        else:
            moved = ''
        env.print(f'note: a finish is already recorded; this one replaces it, and the earlier record is kept under finish.replaces{moved}')
    if not st.get('start'):
        env.print(f'warning: no start is recorded for {run.id}; recording the finish anyway')
    if run.harness.family == 'claude':
        settings = _path(trial, env, 'claude_settings')
        now_hash = _sha256(settings) if settings else None
        started = st.get('start') or {}
        while 'claude_settings_sha256' in (started.get('replaces') or {}):
            started = started['replaces']  # the first send's baseline: a re-recorded start must not reset it
        pre = _latest_pre(st)
        if 'claude_settings_sha256' in started:
            known, before = True, started['claude_settings_sha256']
        elif pre is not None and 'claude_settings_sha256' in pre.get('facts', {}):
            known, before = True, pre['facts']['claude_settings_sha256']
        else:
            known, before = False, None
        record['settings_sha256'] = now_hash
        if known and before is None and now_hash is None:
            known = False  # unreadable at both ends: no evidence either way, not "unchanged"
        if not known:
            record['settings_changed'] = None
            env.print('note: no settings hash was recorded at the start or by a preflight, so a change to ~/.claude/settings.json cannot be ruled out')
        else:
            record['settings_changed'] = now_hash != before
            if record['settings_changed']:
                env.print(f'WARNING: {settings} changed during the run (hash {str(before)[:12]} -> {str(now_hash)[:12]}). '
                          f'An isolated preview daemon once wrote a hook into it (#8704); inspect it before trusting the run\'s settings.')
    gate_record = st.get('gate') if isinstance(st.get('gate'), dict) else {}
    accepted, ignored = gate_record.get('accepted_changed'), _acceptances_ignored(st)
    if ignored:
        accepted = None
        env.print(f'note: {ignored}')
    results, slots = queue_text.finish_checks(trial, env.github(trial.repo), accepted, ignored)
    record['queue_text'] = {'at': _at(env), 'slots': slots}
    if ignored:
        record['queue_text']['acceptances_ignored'] = ignored
    if previous:
        # A re-run (to read an unverified slot again, say) keeps what the earlier finish saw, as `start.replaces` does:
        # a slot it found changed must stay on record when the edit is reverted before the re-read (#8802).
        record['replaces'] = previous
    st['finish'] = record
    _save(trial, run, env, st, state_file)
    env.print(checks.render(results, f'queue text at the end of {run.id}'))
    changed = [slot for slot, seen in slots.items() if seen['since_gate'] == queue_text.CHANGED]
    if changed:
        env.print(f'WARNING: the text of {", ".join(changed)} differs from what this run\'s gate let through, so the run may have read more than one '
                  f'version of it; a grader must know which. A new comment is either a breach of mission rule 4 (the run may not comment on an '
                  f'issue) or somebody else\'s.')
    env.print(f'finish {run.id}: recorded ended_at {ended}')
    return 0
