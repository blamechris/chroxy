"""gate, cut, clone, preflight, prepare, start, verify-start and finish.

Real temporary git repositories stand in for GitHub (a bare origin holding a T0
commit that carries the trial-2 directory); every other tool (node, gh, claude,
codex, npm, launchctl) is answered by a scripted runner, and every harness file
is written under the sandbox's fake HOME. Nothing here reads or writes the
developer's own home, daemon, transcripts or GitHub.
"""
import base64
import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from datetime import timedelta
from unittest import mock

import helpers
import test_collect
from helpers import ScriptedRunner, argv_starts
from test_native import assistant, jl, meta, tool_result, turn, user
from trialkit import cli, collect, config, launch, native, queue_text, render, state, timeutil
from trialkit.gh import GitHubError

CI_OK = "name: CI\non:\n  push:\n    branches: [main, 'trial/**']\n  pull_request:\n"
CI_MAIN_ONLY = "name: CI\non:\n  push:\n    branches: [main]\n"
PROMPTS = {'prime-directive.md': 'prime directive prompt\n', 'full-review.md': 'full review prompt\n'}
SHA_D = 'd' * 40
SNAPSHOT_AT = '2026-11-02T09:00:00Z'
# Spelled out here, not read from queue_text: a test built from the constant it checks passes whatever the constant says.
LATE = ('a snapshot taken after a run began holds the text as it is then, which may have moved since T0, and every later gate would '
        'pass it')
WRONG_STATE = "if a run state there is wrong, such as a dry run's start or a file that cannot be read, repair or move it first"
STATES = 'by the run states in ~/trial/t2/state'
OPUS, ASTRA = 'claude-opus-5-5', 'gpt-6-astra'


class Runner(ScriptedRunner):
    """ScriptedRunner that can also perform a fake tool's side effect (writing files) when a call matches."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.actions = []

    def act(self, predicate, fn):
        self.actions.append((predicate, fn))
        return self

    def run(self, argv, cwd=None, env=None, timeout=None, input=None):
        for predicate, fn in self.actions:
            if predicate(argv):
                fn(argv, cwd, env)
        return super().run(argv, cwd=cwd, env=env, timeout=timeout, input=input)

    def ran(self, *prefix):
        return [c for c in self.calls if c['argv'][:len(prefix)] == list(prefix)]


def comment(cid, body='a comment', user='alice'):
    return {'id': cid, 'user': {'login': user}, 'body': body}


class FakeGitHub:
    """The issues the gate and `cut` read. Each issue has a state, a title, a body and comments; the title and body
    default to a text of the issue's number, and the comments to one comment. A value that is an Exception is raised
    when that part is read (`comments={9002: GitHubError(...)}` fails only the comments listing)."""
    repo = 'blamechris/chroxy'

    def __init__(self, issues=None, ci=CI_OK, default='closed', titles=None, bodies=None, comments=None):
        self.issues = {9001: 'open', 9002: 'open'}
        self.issues.update(issues or {})
        self.titles = dict(titles or {})
        self.bodies = dict(bodies or {})
        self.comments = dict(comments or {})
        self.ci = ci
        self.default = default
        self.requests = []

    def repo_path(self, suffix):
        return f'repos/{self.repo}/{suffix.lstrip("/")}'

    def get(self, path, params=None):
        self.requests.append((path, dict(params or {})))
        m = re.search(r'/issues/(\d+)$', path)
        if m:
            number = int(m.group(1))
            value = self.issues.get(number, self.default)
            if isinstance(value, Exception):
                raise value
            title = self.titles.get(number, f'title of {number}')
            body = self.bodies.get(number, f'body of {number}')
            for part in (title, body):
                if isinstance(part, Exception):
                    raise part
            return {'number': number, 'state': value, 'title': title, 'body': body}
        if path.endswith('contents/.github/workflows/ci.yml'):
            if isinstance(self.ci, Exception):
                raise self.ci
            return {'content': base64.encodebytes(self.ci.encode()).decode(), 'encoding': 'base64'}
        raise GitHubError(f'unexpected request {path}', 404)

    def list(self, path, params=None, key=None):
        self.requests.append((path, dict(params or {})))
        m = re.search(r'/issues/(\d+)/comments$', path)
        if m:
            number = int(m.group(1))
            value = self.comments.get(number, [comment(number * 10 + 1)])
            if isinstance(value, Exception):
                raise value
            return [dict(c) for c in value]
        raise GitHubError(f'unexpected request {path}', 404)


_TEMPLATE = {}


def _template():
    """Build once per run of the suite: a bare origin whose main is T0 (the pristine trial-2 directory plus a
    ci.yml) and a seed work tree on it. Each test copies them, which costs far less than rebuilding them."""
    if not _TEMPLATE:
        root = tempfile.mkdtemp(prefix='trialctl-template-')
        origin, seed = os.path.join(root, 'origin.git'), os.path.join(root, 'seed')
        os.makedirs(origin)
        os.makedirs(seed)
        helpers.git(origin, 'init', '--bare', '-b', 'main')
        helpers.git(seed, 'init', '-b', 'main')
        shutil.copytree(helpers.TRIAL2, os.path.join(seed, helpers.TRIAL_REL))
        os.makedirs(os.path.join(seed, '.github', 'workflows'))
        with open(os.path.join(seed, '.github', 'workflows', 'ci.yml'), 'w') as fh:
            fh.write(CI_OK)
        helpers.git(seed, 'add', '--', '.github/workflows/ci.yml', helpers.TRIAL_REL)
        helpers.git(seed, 'commit', '-m', 'T0 commit')
        helpers.git(seed, 'remote', 'add', 'origin', origin)
        helpers.git(seed, 'push', 'origin', 'main')
        _TEMPLATE.update(root=root, origin=origin, seed=seed, t0=helpers.git(seed, 'rev-parse', 'HEAD'))
    return _TEMPLATE


def tearDownModule():
    if _TEMPLATE:
        shutil.rmtree(_TEMPLATE['root'], ignore_errors=True)
        _TEMPLATE.clear()


class Rig:
    """A sandbox whose clone source is a real bare origin: main is T0, a seed work tree can cut from it."""

    def __init__(self, test, record_t0=True, slots=helpers.SLOTS):
        self.box = helpers.Sandbox(slots=slots)
        test.addCleanup(self.box.cleanup)
        template = _template()
        self.origin = os.path.join(self.box.tmp, 'origin.git')
        self.seed = os.path.join(self.box.tmp, 'seed')
        shutil.copytree(template['origin'], self.origin)
        shutil.copytree(template['seed'], self.seed)
        helpers.git(self.seed, 'remote', 'set-url', 'origin', self.origin)
        self.t0 = template['t0']
        with open(os.path.join(self.box.trial_dir, 'trial.json'), encoding='utf-8') as fh:
            data = json.load(fh)
        data['paths'].update(clone_source=self.origin, codex_app_cli='~/codex-app')
        self.box.write_trial(data)
        self.trial = self.box.trial()
        self.github = FakeGitHub()
        if record_t0:
            config.save_t0(self.trial, self.t0)
            queue_text.write(self.trial, queue_text.snapshot(self.trial, self.github, self.t0, lambda: SNAPSHOT_AT))
        self.write_home('.gitconfig', '[user]\n\tname = Chris Test\n\temail = chris@example.com\n')
        os.makedirs(os.path.join(self.box.home, 'chroxy'))

    # -- locations
    def home(self, *parts):
        return os.path.join(self.box.home, *parts)

    def write_home(self, rel, text):
        path = self.home(rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(text)
        return path

    def run(self, rid):
        return self.trial.run(rid)

    def clone_dir(self, rid):
        return self.trial.clone_dir(self.run(rid), self.box.home)

    def state(self, rid):
        return state.load(self.trial, rid, home=self.box.home)

    def save_state(self, rid, **sections):
        data = {'run': rid, 'trial': self.trial.id}
        data.update(sections)
        return state.save(self.trial, rid, data, home=self.box.home, now=lambda: helpers.FIXED_NOW)

    def env(self, runner=None, github=None):
        return self.box.env(runner=runner or Runner(), github=github or self.github)

    def branch(self, base):
        return helpers.git(self.origin, 'for-each-ref', '--format=%(objectname)', f'refs/heads/{base}')

    # -- steps, with the real code
    def cut(self, *ids, push=True, runner=None):
        env = self.env(runner)
        code = launch.cut(self.trial, [self.run(i) for i in ids], env, t0=self.t0, push=push, repo_dir=self.seed)
        assert code == 0, env.out.getvalue()
        return env

    def clone(self, rid):
        env = self.env()
        code = launch.clone(self.trial, self.run(rid), env, dest=None, skip_install=True, state_file=None)
        assert code == 0, env.out.getvalue()
        return self.clone_dir(rid)

    # -- harness files
    def claude_settings(self, effort='high', model=OPUS):
        body = {'modelSettings': {model: {'effortLevel': effort}}} if effort else {}
        return self.write_home('.claude/settings.json', json.dumps(body))

    def daemon_config(self, allow=True):
        return self.write_home('.chroxy/config.json', json.dumps({'allowAutoPermissionMode': allow}))

    def install_prompts(self, prompts=PROMPTS):
        for name, text in prompts.items():
            self.write_home(f'.codex/prompts/{name}', text)


QUIET = '{"total_count": 0, "workflow_runs": []}\n'


def ci_runs_argv(rig, status):
    return ['gh', 'api', '-X', 'GET', f'repos/{rig.trial.repo}/actions/workflows/ci.yml/runs',
            '-f', f'status={status}', '-f', 'per_page=20']


def ci_reply(*runs, total=None):
    return json.dumps({'total_count': len(runs) if total is None else total,
                       'workflow_runs': [{'id': i, 'head_branch': b} for i, b in runs]}) + '\n'


def toolbox(rig, node='v22.11.0\n', login='blamechris\n', claude='2.1.308 (Claude Code)\n',
            launchctl='PID\tStatus\tLabel\n-\t0\tcom.apple.example\n', daemon=SHA_D + '\n',
            codex='codex-cli 0.163.0\n', codex_app='codex-cli 0.163.0\n', prompts=PROMPTS, compile_rc=0,
            ci_queued=QUIET, ci_running=QUIET):
    """A runner answering every external tool a preflight asks. A value of None leaves that tool unscripted (127)."""
    r = Runner()
    node_bin = rig.trial.local_path('node_bin', rig.box.home)
    app = rig.trial.local_path('codex_app_cli', rig.box.home)
    daemon_dir = rig.trial.local_path('daemon_checkout', rig.box.home)
    scripted = [
        (node, lambda a: a[0] == os.path.join(node_bin, 'node') and a[1:] == ['--version']),
        (login, argv_starts('gh', 'api', 'user')),
        (claude, argv_starts('claude', '--version')),
        (launchctl, argv_starts('launchctl', 'list')),
        (daemon, lambda a: a[:3] == ['git', '-C', daemon_dir]),
        (codex, argv_starts('codex', '--version')),
        (codex_app, lambda a: a[0] == app and a[1:] == ['--version']),
        # Only the exact request is answered: a wrong workflow path, status or page size goes unscripted
        # (127, UNVERIFIED), so the quiet-fleet tests fail on the request, not just on the reply.
        (ci_queued, lambda a: a == ci_runs_argv(rig, 'queued')),
        (ci_running, lambda a: a == ci_runs_argv(rig, 'in_progress')),
    ]
    for value, predicate in scripted:
        if value is not None:
            r.on(predicate, 0, value)
    compile_call = lambda a: a[:2] == ['node', 'scripts/compile-skill-targets.mjs']

    def compile_prompts(argv, cwd, env):
        base = os.path.join(env['HOME'], '.codex', 'prompts')
        os.makedirs(base, exist_ok=True)
        for name, text in (prompts or {}).items():
            with open(os.path.join(base, name), 'w') as fh:
                fh.write(text)

    if compile_rc == 0:
        r.act(compile_call, compile_prompts)
    r.on(compile_call, compile_rc, '', '' if compile_rc == 0 else 'compile exploded')
    return r


def statuses(st, phase='pre'):
    entry = [e for e in st['preflight'] if e['phase'] == phase][-1]
    return {c['name']: c['status'] for c in entry['checks']}


def details(st, phase='pre'):
    entry = [e for e in st['preflight'] if e['phase'] == phase][-1]
    return {c['name']: c['detail'] for c in entry['checks']}


def plant_unreadable_state(rig, rid, how):
    """Put something the state reader cannot read where run `rid`'s state file belongs: corrupt JSON, JSON that is not
    a state, a directory (which fails in open() rather than in the parser), or a valid state in a folder that cannot be
    searched. Returns the undo."""
    path = state.state_path(rig.trial, rid, home=rig.box.home)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if how == 'directory':
        os.makedirs(path)
        return lambda: os.rmdir(path)
    if how == 'folder without permission':
        rig.save_state(rid, start={'sent_at': '2026-11-02T10:00:00Z'})
        os.chmod(os.path.dirname(path), 0)
        return lambda: (os.chmod(os.path.dirname(path), 0o755), os.remove(path))
    with open(path, 'w') as fh:
        fh.write('[]' if how == 'not a state' else '{truncated')
    return lambda: os.remove(path)


@contextlib.contextmanager
def without(trial, bag, key):
    """The loaded trial with one setting removed: `trial.<bag>[key]`, or the attribute `trial.<key>` when bag is None."""
    if bag is None:
        saved = getattr(trial, key)
        setattr(trial, key, None)
        try:
            yield
        finally:
            setattr(trial, key, saved)
        return
    values = getattr(trial, bag)
    saved = values.pop(key)  # a KeyError here means the case names a setting trial.json does not carry: a bad test
    try:
        yield
    finally:
        values[key] = saved


class LaunchCase(unittest.TestCase):
    def setUp(self):
        self.rig = Rig(self)

    def prep(self, rid):
        """Cut the run's base, clone it, and write every harness file a correct preflight expects."""
        self.rig.cut(rid)
        self.rig.clone(rid)
        run = self.rig.run(rid)
        if run.harness.family == 'claude':
            self.rig.claude_settings(run.effort, run.model)
        else:
            self.rig.install_prompts()
        if run.harness.chroxy:
            self.rig.daemon_config()
        return run

    def pre(self, rid, runner=None, system=None, phase='pre', session=None):
        env = self.rig.env(runner or toolbox(self.rig))
        if system:
            env.system = system
        code = launch.preflight(self.rig.trial, self.rig.run(rid), env, phase, session, None)
        return code, env.out.getvalue(), self.rig.state(rid)

    def assertStatus(self, got, name, status):
        self.assertEqual(got.get(name), status, f'{name}: {got}')


# -- gate --------------------------------------------------------------------------

class Gate(LaunchCase):
    def go(self, rid='B-cy-r1', gh=None, accept=None):
        gh = gh or FakeGitHub()
        env = self.rig.env(github=gh)
        code = launch.gate(self.rig.trial, self.rig.run(rid), env, accept or {}, None)
        return code, env.out.getvalue(), gh

    def test_everything_closed_open_and_covered_passes_and_is_recorded(self):
        code, out, gh = self.go()
        self.assertEqual(code, 0, out)
        gate = self.rig.state('B-cy-r1')['gate']
        self.assertEqual(gate['at'], '2026-11-02T12:00:00Z')
        names = [c['name'] for c in gate['checks']]
        self.assertEqual(names[:2], ['blocker #8710', 'blocker #8743'])
        self.assertTrue(all(c['status'] == 'PASS' for c in gate['checks']), gate['checks'])
        self.assertEqual(gate['accepted_open'], {})
        self.assertIn(('repos/blamechris/chroxy/contents/.github/workflows/ci.yml', {'ref': self.rig.t0}), gh.requests)

    def test_an_open_blocker_refuses(self):
        code, out, _ = self.go(gh=FakeGitHub(issues={8710: 'open'}))
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+blocker #8710')
        self.assertIn('--accept-open 8710=REASON', out)

    def test_an_open_blocker_is_accepted_with_a_reason_and_the_reason_is_recorded(self):
        code, out, _ = self.go(gh=FakeGitHub(issues={8710: 'open'}), accept={8710: 'fix lands after the trial'})
        self.assertEqual(code, 0, out)
        self.assertIn('open, accepted: fix lands after the trial', out)
        st = self.rig.state('B-cy-r1')
        self.assertEqual(st['gate']['accepted_open'], {'8710': 'fix lands after the trial'})
        self.assertEqual([(o['kind'], o['issue'], o['reason']) for o in st['overrides']],
                         [('accept-open', 8710, 'fix lands after the trial')])
        self.go(gh=FakeGitHub(issues={8710: 'open'}), accept={8710: 'fix lands after the trial'})
        self.assertEqual(len(self.rig.state('B-cy-r1')['overrides']), 1, 'the same acceptance is not recorded twice')

    def test_accepting_an_issue_that_is_not_a_blocker_changes_nothing(self):
        code, out, _ = self.go(gh=FakeGitHub(issues={8710: 'open'}), accept={1234: 'x'})
        self.assertEqual(code, 1)
        self.assertIn('--accept-open 1234 ignored', out)

    def test_a_github_error_on_a_blocker_is_unverified_not_a_pass(self):
        code, out, _ = self.go(gh=FakeGitHub(issues={8710: GitHubError('rate limited', 403)}))
        self.assertEqual(code, 2)
        self.assertRegex(out, r'UNVERIFIED\s+blocker #8710')

    def test_a_run_without_blockers_checks_none(self):
        _code, out, _ = self.go('A-cd-r1')
        self.assertNotIn('blocker #', out)

    def test_an_empty_queue_fails(self):
        self.rig = Rig(self, slots=[])
        code, out, _ = self.go()
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+queue non-empty')

    def test_a_queue_item_already_closed_fails(self):
        code, out, _ = self.go(gh=FakeGitHub(issues={9002: 'closed'}))
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+queue Q02 #9002\s+queue item already closed')

    def test_a_github_error_on_a_queue_item_is_unverified(self):
        code, out, _ = self.go(gh=FakeGitHub(issues={9001: GitHubError('boom', 500)}))
        self.assertEqual(code, 2)
        self.assertRegex(out, r'UNVERIFIED\s+queue Q01')

    def test_no_t0_fails_and_ci_cannot_be_read(self):
        self.rig = Rig(self, record_t0=False)
        code, out, gh = self.go()
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+T0 set')
        self.assertRegex(out, r'UNVERIFIED\s+ci.yml runs on the base')
        self.assertFalse([r for r in gh.requests if 'ci.yml' in r[0]])

    def test_ci_that_does_not_run_on_the_base_fails(self):
        code, out, _ = self.go(gh=FakeGitHub(ci=CI_MAIN_ONLY))
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+ci.yml runs on the base')
        self.assertIn('red CI on the base would not be observable', out)

    def test_ci_that_runs_on_every_push_passes(self):
        code, out, _ = self.go(gh=FakeGitHub(ci='on:\n  push:\n  pull_request:\n'))
        self.assertEqual(code, 0, out)

    def test_an_unreadable_ci_trigger_is_unverified(self):
        code, out, _ = self.go(gh=FakeGitHub(ci='on:\n  push:\n    branches-ignore: [x]\n'))
        self.assertEqual(code, 2)
        self.assertRegex(out, r'UNVERIFIED\s+ci.yml runs on the base')

    def test_ci_missing_at_t0_is_unverified(self):
        code, out, _ = self.go(gh=FakeGitHub(ci=GitHubError('Not Found', 404)))
        self.assertEqual(code, 2)
        self.assertIn('cannot read ci.yml at T0', out)

    def test_another_live_run_fails_and_is_named(self):
        self.rig.save_state('A-cd-r1', start={'sent_at': '2026-11-02T10:00:00Z'})
        code, out, _ = self.go()
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+no other run live\s+A-cd-r1')

    def test_a_finished_run_is_not_live(self):
        self.rig.save_state('A-cd-r1', start={'sent_at': 'x'}, finish={'ended_at': 'y'})
        code, out, _ = self.go()
        self.assertEqual(code, 0, out)

    def test_another_runs_unreadable_state_is_unverified_not_a_pass(self):
        for how in ('corrupt', 'directory'):
            with self.subTest(how):
                undo = plant_unreadable_state(self.rig, 'A-cd-r1', how)
                code, out, _ = self.go()
                undo()
                self.assertEqual(code, 2, out)
                self.assertRegex(out, r'UNVERIFIED\s+no other run live\s+cannot read the other runs\' state files')
                self.assertNotRegex(out, r'PASS\s+no other run live')


# -- gate: the queue's text since T0 --------------------------------------------------

def sha256_of(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def snapshot_path(rig):
    return os.path.join(rig.box.trial_dir, 'queue-t0.json')


def file_bytes(path):
    with open(path, 'rb') as fh:
        return fh.read()


def snapshot_file(rig):
    with open(snapshot_path(rig), encoding='utf-8') as fh:
        return json.load(fh)


def slot_named(rig, name):
    return next(slot for slot in rig.trial.slots if slot.slot == name)


def plant_unreadable_snapshot(rig, how):
    """Put something the snapshot reader cannot read where queue-t0.json belongs. Returns the undo."""
    path = snapshot_path(rig)
    if os.path.isfile(path):
        os.remove(path)
    if how == 'directory':
        os.makedirs(path)
        return lambda: os.rmdir(path)
    with open(path, 'w') as fh:
        fh.write('{truncated')
    return lambda: os.remove(path)


def edit_snapshot(rig, edit):
    data = snapshot_file(rig)
    edit(data)
    with open(snapshot_path(rig), 'w', encoding='utf-8') as fh:
        json.dump(data, fh)


class GateQueueText(LaunchCase):
    """`gate` compares each queue issue's title, body and comments with the digests `cut` wrote at T0 (the Rig
    writes them when it records T0, from the same default issues the gate reads back)."""

    def go(self, gh=None, accept_changed=None, rid='B-cy-r1'):
        gh = gh or FakeGitHub()
        env = self.rig.env(github=gh)
        code = launch.gate(self.rig.trial, self.rig.run(rid), env, {}, None, accept_changed=accept_changed)
        return code, env.out.getvalue(), gh

    def text_checks(self, rid='B-cy-r1'):
        return {c['name']: c for c in self.rig.state(rid)['gate']['checks'] if c['name'].startswith('queue text')}

    def test_unchanged_text_passes_for_every_slot_and_is_recorded(self):
        code, out, _ = self.go()
        self.assertEqual(code, 0, out)
        self.assertRegex(out, r'PASS\s+queue text Q01 #9001\s+title, body and 1 comment\(s\) unchanged since the T0 snapshot of 2026-11-02T09:00:00Z')
        self.assertRegex(out, r'PASS\s+queue text Q02 #9002')
        checks_ = self.text_checks()
        self.assertEqual(sorted(checks_), ['queue text Q01 #9001', 'queue text Q02 #9002'])
        self.assertTrue(all(c['status'] == 'PASS' for c in checks_.values()), checks_)

    def test_the_text_checks_come_after_the_queue_checks(self):
        self.go()
        names = [c['name'] for c in self.rig.state('B-cy-r1')['gate']['checks']]
        self.assertEqual(names.index('queue text Q01 #9001'), names.index('queue Q02 #9002') + 1)

    def test_an_edited_body_fails_naming_the_slot_and_only_the_body(self):
        code, out, _ = self.go(gh=FakeGitHub(bodies={9002: 'the body, edited after T0'}))
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text Q02 #9002\s+changed since the T0 snapshot of 2026-11-02T09:00:00Z: body;')
        self.assertIn('--accept-changed Q02=REASON', out)
        self.assertRegex(out, r'PASS\s+queue text Q01 #9001')
        self.assertFalse('edited after T0' in out, 'the changed text itself is never printed')
        self.assertNotRegex(out, r'Q02 #9002\s+changed[^\n]*title')

    def test_an_edited_title_fails_naming_the_slot_and_the_title(self):
        code, out, _ = self.go(gh=FakeGitHub(titles={9001: 'a new title'}))
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text Q01 #9001\s+changed since the T0 snapshot of \S+: title;')
        self.assertRegex(out, r'PASS\s+queue text Q02 #9002')

    def test_title_and_body_changed_together_are_both_named(self):
        _code, out, _ = self.go(gh=FakeGitHub(titles={9001: 'new'}, bodies={9001: 'new'}))
        self.assertRegex(out, r'FAIL\s+queue text Q01 #9001\s+changed since the T0 snapshot of \S+: title, body;')

    def test_an_added_comment_fails_with_the_counts_before_and_after(self):
        extra = [comment(90011), comment(90019, 'a late comment', 'bob')]
        code, out, _ = self.go(gh=FakeGitHub(comments={9001: extra}))
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text Q01 #9001\s+changed since the T0 snapshot of \S+: comments \(1 -> 2\);')
        self.assertFalse('late comment' in out)

    def test_an_edited_comment_fails_though_the_count_is_the_same(self):
        code, out, _ = self.go(gh=FakeGitHub(comments={9002: [comment(90021, 'edited after T0')]}))
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text Q02 #9002\s+changed since the T0 snapshot of \S+: comments \(1, text changed\);')

    def test_a_comment_posted_under_another_login_or_removed_fails(self):
        code, out, _ = self.go(gh=FakeGitHub(comments={9001: [comment(90011, 'a comment', 'mallory')]}))
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text Q01 #9001\s+changed since the T0 snapshot of \S+: comments \(1, text changed\);')
        code, out, _ = self.go(gh=FakeGitHub(comments={9001: []}))
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text Q01 #9001\s+changed since the T0 snapshot of \S+: comments \(1 -> 0\);')

    def test_what_is_not_the_task_text_is_not_compared(self):
        class Noisy(FakeGitHub):
            def get(self, path, params=None):
                reply = super().get(path, params)
                if path.endswith('/issues/9001'):
                    reply.update(labels=[{'name': 'new-label'}], assignees=[{'login': 'x'}], updated_at='2026-11-05T00:00:00Z')
                return reply

        code, out, _ = self.go(gh=Noisy())
        self.assertEqual(code, 0, out)

    def test_a_missing_snapshot_fails_and_nothing_is_compared(self):
        os.remove(snapshot_path(self.rig))
        code, out, gh = self.go()
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text at T0\s+queue-t0.json is missing')
        self.assertIn('if T0 was recorded without it, run `cut` again', out, 'before a run, `cut` is the way to write it')
        self.assertNotRegex(out, r'queue text Q0')
        self.assertFalse([r for r in gh.requests if r[0].endswith('/comments')], 'no text was read without a baseline')

    def missing_after(self, started):
        return (f'queue-t0.json is missing from docs/reports/harness-evals/trial-2 and {started}: put the committed file back (pull the '
                f'commit that added it with trial.json\'s t0, or restore it) and run the gate again ({WRONG_STATE}). Do not run `cut` to '
                f'write it now: {LATE}')

    def test_a_missing_snapshot_once_a_run_has_started_is_never_advised_to_be_cut(self):
        # #8808: after a start, a snapshot taken now may hold text that moved since T0, and every later gate would pass it.
        os.remove(snapshot_path(self.rig))
        sent = {'sent_at': '2026-11-02T10:00:00Z'}
        for runs, started in (({'A-cd-r1': {'start': sent}}, f'A-cd-r1 has started, {STATES}'),
                              ({'A-cd-r1': {'start': sent, 'finish': {'ended_at': '2026-11-02T11:00:00Z'}}}, f'A-cd-r1 has started, {STATES}'),
                              ({'B-cy-r1': {'start': sent}}, f'B-cy-r1 has started, {STATES}'),
                              ({'A-cy-r1': {'start': sent, 'finish': {}}, 'A-cd-r1': {'start': sent, 'finish': {}}},
                               f'A-cd-r1, A-cy-r1 have started, {STATES}')):
            with self.subTest(started=started, runs=sorted(runs)):
                for rid in ('A-cd-r1', 'A-cy-r1', 'B-cy-r1'):
                    path = state.state_path(self.rig.trial, rid, home=self.rig.box.home)
                    if os.path.exists(path):
                        os.remove(path)
                for rid, sections in runs.items():
                    self.rig.save_state(rid, **sections)
                code, out, _ = self.go()
                self.assertEqual(code, 1, out)
                self.assertEqual(self.text_checks()['queue text at T0']['detail'], self.missing_after(started))
                self.assertNotIn('run `cut` again', out)

    def gate_elsewhere(self, rid, **sections):
        """The real gate for `rid`, with its own state kept outside paths.state_dir (`--state-file`); the queue-text-at-T0 detail."""
        own = os.path.join(self.rig.box.tmp, 'elsewhere', f'{rid}.json')
        state.save(self.rig.trial, rid, {'run': rid, 'trial': self.rig.trial.id, **sections}, override=own, home=self.rig.box.home)
        env = self.rig.env(github=FakeGitHub())
        code = launch.gate(self.rig.trial, self.rig.run(rid), env, {}, own)
        self.assertEqual(code, 1, env.out.getvalue())
        return {c['name']: c['detail'] for c in state.load(self.rig.trial, rid, override=own)['gate']['checks']}['queue text at T0']

    def test_the_gate_s_own_start_counts_wherever_its_state_file_is_and_runs_are_named_in_roster_order(self):
        os.remove(snapshot_path(self.rig))
        self.assertEqual(self.gate_elsewhere('B-cy-r1', start={'sent_at': '2026-11-02T10:00:00Z'}), self.missing_after(f'B-cy-r1 has started, {STATES}'))
        self.rig.save_state('A-cy-r1', start={'sent_at': '2026-11-02T10:00:00Z'}, finish={})
        self.assertEqual(self.gate_elsewhere('B-cy-r1', start={'sent_at': '2026-11-02T10:00:00Z'}),
                         self.missing_after(f'B-cy-r1, A-cy-r1 have started, {STATES}'), 'trial.json lists B-cy-r1 before A-cy-r1')

    def test_a_run_state_that_cannot_be_read_cannot_rule_out_a_start(self):
        os.remove(snapshot_path(self.rig))
        for how in ('corrupt', 'directory', 'not a state', 'folder without permission'):
            with self.subTest(how):
                if how == 'folder without permission' and os.geteuid() == 0:
                    self.skipTest('root reads a folder whatever its mode')
                undo = plant_unreadable_state(self.rig, 'A-cd-r1', how)
                detail = self.gate_elsewhere('B-cy-r1')
                undo()
                head, tail = detail.split(' (', 1)
                self.assertEqual(head, "queue-t0.json is missing from docs/reports/harness-evals/trial-2 and a run state in ~/trial/t2/state "
                                       "cannot be read")
                self.assertTrue(tail.endswith(f'), so a started run cannot be ruled out: put the committed file back (pull the commit that '
                                              f'added it with trial.json\'s t0, or restore it) and run the gate again ({WRONG_STATE}). Do '
                                              f'not run `cut` to write it now: {LATE}'), detail)

    def test_a_snapshot_taken_at_another_t0_fails(self):
        edit_snapshot(self.rig, lambda d: d.update(t0='f' * 40))
        code, out, _ = self.go()
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text at T0\s+queue-t0.json was taken at T0 ffffffffffff, trial.json records ' + self.rig.t0[:12])

    def test_a_slot_with_no_entry_fails_naming_the_slot(self):
        edit_snapshot(self.rig, lambda d: d['slots'].pop('Q02'))
        code, out, _ = self.go()
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text Q02 #9002\s+queue-t0.json has no entry for Q02')
        self.assertRegex(out, r'PASS\s+queue text Q01 #9001')

    def test_a_slot_whose_issue_is_not_the_recorded_one_fails_naming_the_slot(self):
        edit_snapshot(self.rig, lambda d: d['slots']['Q01'].update(issue=1234))
        code, out, _ = self.go()
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text Q01 #9001\s+Q01 is issue 9001 in trial.json but 1234 in queue-t0.json')

    def test_a_slot_the_trial_no_longer_has_fails(self):
        edit_snapshot(self.rig, lambda d: d['slots'].update(Q09=dict(d['slots']['Q01'], issue=9009)))
        code, out, _ = self.go()
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text at T0\s+queue-t0.json holds Q09, which trial.json no longer has')

    def test_a_malformed_entry_fails_naming_the_slot(self):
        for how in (lambda d: d['slots']['Q01'].pop('body_sha256'), lambda d: d['slots']['Q01'].update(title_sha256='not a digest'),
                    lambda d: d['slots']['Q01'].update(comments='1'), lambda d: d['slots'].update(Q01=[])):
            with self.subTest():
                self.setUp()
                edit_snapshot(self.rig, how)
                code, out, _ = self.go()
                self.assertEqual(code, 1, out)
                self.assertRegex(out, r'FAIL\s+queue text Q01 #9001\s+queue-t0.json holds a malformed entry for Q01')

    def test_a_file_that_is_not_a_snapshot_fails_and_one_that_cannot_be_read_is_unverified(self):
        with open(snapshot_path(self.rig), 'w') as fh:
            fh.write('[]')
        code, out, _ = self.go()
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text at T0\s+queue-t0.json is not a snapshot')
        for how in ('corrupt', 'directory'):
            with self.subTest(how):
                undo = plant_unreadable_snapshot(self.rig, how)
                code, out, _ = self.go()
                undo()
                self.assertEqual(code, 2, out)
                self.assertRegex(out, r'UNVERIFIED\s+queue text at T0\s+cannot read ')
                self.assertNotRegex(out, r'PASS\s+queue text')

    def test_no_t0_leaves_one_unverified_check_and_reads_no_text(self):
        self.rig = Rig(self, record_t0=False)
        code, out, gh = self.go()
        self.assertEqual(code, 1)     # 'T0 set' fails as it always did
        self.assertRegex(out, r'UNVERIFIED\s+queue text at T0\s+no T0 recorded')
        self.assertEqual(sorted(self.text_checks()), ['queue text at T0'])
        self.assertFalse([r for r in gh.requests if r[0].endswith('/comments')])

    def test_an_empty_queue_has_no_text_to_compare_and_fails(self):
        self.rig = Rig(self, slots=[])
        code, out, _ = self.go()
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+queue text at T0\s+the queue has no slots')

    def test_a_github_error_reading_the_comments_is_unverified_never_a_pass(self):
        code, out, _ = self.go(gh=FakeGitHub(comments={9002: GitHubError('rate limited', 403)}))
        self.assertEqual(code, 2, out)
        self.assertRegex(out, r'UNVERIFIED\s+queue text Q02 #9002\s+cannot read Q02 #9002: rate limited')
        self.assertRegex(out, r'PASS\s+queue text Q01 #9001')
        self.assertNotRegex(out, r'PASS\s+queue text Q02')

    def test_a_reply_this_cannot_read_is_unverified(self):
        for comments in ([{'id': 'x', 'body': 'b'}], [{'id': 7}], [comment(7), comment(7)]):
            with self.subTest(comments=comments):
                code, out, _ = self.go(gh=FakeGitHub(comments={9001: comments}))
                self.assertEqual(code, 2, out)
                self.assertRegex(out, r'UNVERIFIED\s+queue text Q01 #9001\s+cannot read Q01 #9001: ')

    def test_an_edit_is_accepted_for_its_slot_with_a_reason_and_the_acceptance_is_recorded(self):
        gh = FakeGitHub(bodies={9002: 'edited to fix a typo'})
        reason = 'a typo fix, no change of meaning'
        code, out, _ = self.go(gh=gh, accept_changed={'Q02': reason})
        self.assertEqual(code, 0, out)
        self.assertRegex(out, r'PASS\s+queue text Q02 #9002\s+changed since T0 \(body\), accepted: a typo fix, no change of meaning')
        st = self.rig.state('B-cy-r1')
        accepted = {'reason': reason, **queue_text.read_slot(gh, slot_named(self.rig, 'Q02'))}
        self.assertEqual(st['gate']['accepted_changed'], {'Q02': accepted})
        self.assertEqual(accepted['body_sha256'], sha256_of('edited to fix a typo'), 'the digests are those of the text accepted')
        self.assertNotEqual(accepted['body_sha256'], snapshot_file(self.rig)['slots']['Q02']['body_sha256'])
        self.assertEqual([{k: o[k] for k in o if k != 'at'} for o in st['overrides']], [{'kind': 'accept-changed', 'slot': 'Q02', **accepted}])
        self.assertEqual(st['overrides'][0]['at'], '2026-11-02T12:00:00Z')
        self.go(gh=gh, accept_changed={'Q02': reason})
        self.assertEqual(len(self.rig.state('B-cy-r1')['overrides']), 1, 'the same acceptance is not recorded twice')

    def test_two_different_edits_accepted_under_one_reason_are_two_acceptances(self):
        reason = 'the owner fixed a typo'
        self.go(gh=FakeGitHub(bodies={9002: 'the first edit'}), accept_changed={'Q02': reason})
        self.go(gh=FakeGitHub(bodies={9002: 'the second edit'}), accept_changed={'Q02': reason})
        st = self.rig.state('B-cy-r1')
        self.assertEqual([(o['kind'], o['slot'], o['reason'], o.get('body_sha256')) for o in st['overrides']],
                         [('accept-changed', 'Q02', reason, sha256_of('the first edit')),
                          ('accept-changed', 'Q02', reason, sha256_of('the second edit'))])
        self.assertEqual(st['gate']['accepted_changed']['Q02']['body_sha256'], sha256_of('the second edit'), 'the gate holds the latest')
        self.go(gh=FakeGitHub(bodies={9002: 'the first edit'}), accept_changed={'Q02': reason})
        self.assertEqual(len(self.rig.state('B-cy-r1')['overrides']), 2, 'an edit accepted before is not recorded again')

    def test_an_acceptance_covers_only_its_own_slot(self):
        code, out, _ = self.go(gh=FakeGitHub(bodies={9001: 'x', 9002: 'y'}), accept_changed={'Q02': 'fine'})
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text Q01 #9001')
        self.assertRegex(out, r'PASS\s+queue text Q02 #9002\s+changed since T0 \(body\), accepted')

    def test_accepting_a_slot_that_did_not_change_records_nothing(self):
        code, out, _ = self.go(accept_changed={'Q01': 'not needed'})
        self.assertEqual(code, 0, out)
        self.assertRegex(out, r'PASS\s+queue text Q01 #9001\s+title, body and 1 comment\(s\) unchanged')
        st = self.rig.state('B-cy-r1')
        self.assertEqual((st['gate']['accepted_changed'], st['overrides']), ({}, []))

    def test_accepting_a_slot_the_queue_does_not_have_is_a_note_and_changes_nothing(self):
        code, out, _ = self.go(gh=FakeGitHub(bodies={9001: 'x'}), accept_changed={'Q99': 'x'})
        self.assertEqual(code, 1, out)
        self.assertIn('--accept-changed Q99 ignored; it is not a queue slot', out)
        self.assertEqual(self.rig.state('B-cy-r1')['overrides'], [])

    def test_an_acceptance_does_not_stand_in_for_a_missing_baseline(self):
        os.remove(snapshot_path(self.rig))
        code, out, _ = self.go(accept_changed={'Q01': 'x', 'Q02': 'x'})
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text at T0\s+queue-t0.json is missing')

    def test_the_command_line_takes_the_acceptance_for_gate_and_prepare(self):
        args = cli.build_parser().parse_args(['gate', 'B-cy-r1', '--accept-changed', 'Q03=owner fixed a typo', '--accept-changed', 'Q04=x'])
        self.assertEqual(cli._accept_changed(args.accept_changed), {'Q03': 'owner fixed a typo', 'Q04': 'x'})
        args = cli.build_parser().parse_args(['prepare', 'B-cy-r1', '--accept-changed', 'Q03=reason'])
        self.assertEqual(cli._accept_changed(args.accept_changed), {'Q03': 'reason'})
        self.assertEqual(cli._accept_changed(None), {})

    def test_a_malformed_acceptance_is_rejected_as_a_malformed_accept_open_is(self):
        for bad in ('Q03', 'Q03=', 'Q03=  ', '=reason', 'q03=reason', 'Q3=reason', 'Q003=reason', '9001=reason', 'Q03 reason'):
            with self.subTest(bad), self.assertRaises(SystemExit) as ctx:
                cli._accept_changed([bad])
            self.assertIn('--accept-changed expects SLOT=REASON', str(ctx.exception))
        with self.assertRaises(SystemExit):
            cli._accept_open(['not-a-number=reason'])

    def test_gate_on_the_command_line_uses_the_acceptance(self):
        gh = FakeGitHub(bodies={9001: 'edited'})
        state_file = os.path.join(self.rig.box.tmp, 'gate-state.json')

        def cli_gate(*extra):
            env = self.rig.env(github=gh)
            code = cli.main(['--trial', self.rig.box.trial_dir, 'gate', 'B-cy-r1', '--state', state_file, *extra], env=env)
            return code, env.out.getvalue()

        code, out = cli_gate()
        self.assertEqual(code, 1, out)
        code, out = cli_gate('--accept-changed', 'Q01=the owner agreed to the new wording')
        self.assertEqual(code, 0, out)
        self.assertIn('accepted: the owner agreed to the new wording', out)

    def test_prepare_on_the_command_line_hands_the_acceptance_to_the_gate(self):
        with mock.patch.object(launch, 'prepare', return_value=0) as prepare:
            code = cli.main(['--trial', self.rig.box.trial_dir, 'prepare', 'B-cy-r1', '--accept-changed', 'Q02=reason'], env=self.rig.env())
        self.assertEqual(code, 0)
        self.assertEqual(prepare.call_args.kwargs['accept_changed'], {'Q02': 'reason'})


# -- cut ---------------------------------------------------------------------------

class Cut(unittest.TestCase):
    def setUp(self):
        self.rig = Rig(self, record_t0=False)

    def cut(self, *ids, t0=None, push=False, runner=None, github=None):
        env = self.rig.env(runner, github)
        code = launch.cut(self.rig.trial, [self.rig.run(i) for i in ids], env, t0=t0 or self.rig.t0,
                          push=push, repo_dir=self.rig.seed)
        return code, env.out.getvalue()

    def worktrees(self):
        return helpers.git(self.rig.seed, 'worktree', 'list').splitlines()

    def test_without_push_it_builds_prints_the_command_and_pushes_nothing(self):
        code, out = self.cut('A-cd-r1')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), '')
        sha = re.search(r'built ([0-9a-f]{40})', out).group(1)
        self.assertIn(f'git -C {self.rig.seed} push origin {sha}:refs/heads/trial/t2-a-cd-r1', out)
        self.assertEqual(helpers.git(self.rig.seed, 'cat-file', '-t', sha), 'commit')
        self.assertEqual(len(self.worktrees()), 1)
        self.assertEqual(self.rig.box.trial().t0, self.rig.t0, 'T0 is recorded even when nothing is pushed')

    def test_push_refuses_an_origin_that_is_not_the_trial_repository(self):
        # The seed's origin is the configured clone source; point it somewhere else and nothing is pushed.
        other = os.path.join(self.rig.box.tmp, 'other.git')
        helpers.git(self.rig.box.tmp, 'clone', '--bare', '-q', self.rig.origin, other)
        helpers.git(self.rig.seed, 'remote', 'set-url', 'origin', other)
        code, out = self.cut('A-cd-r1', push=True)
        self.assertEqual(code, 2, out)
        self.assertIn(f'not {self.rig.trial.repo}; nothing fetched, recorded or pushed', out)
        self.assertEqual(helpers.git(other, 'for-each-ref', 'refs/heads/trial'), '')
        self.assertIsNone(self.rig.box.trial().t0, 'a refused push records no T0')

    def test_push_reads_the_push_url_not_the_fetch_url(self):
        # remote.origin.pushurl sends the push elsewhere while `git remote get-url origin` still shows the trial repo.
        other = os.path.join(self.rig.box.tmp, 'other.git')
        helpers.git(self.rig.box.tmp, 'clone', '--bare', '-q', self.rig.origin, other)
        helpers.git(self.rig.seed, 'config', 'remote.origin.pushurl', other)
        code, out = self.cut('A-cd-r1', push=True)
        self.assertEqual(code, 2, out)
        self.assertEqual(helpers.git(other, 'for-each-ref', 'refs/heads/trial'), '')
        self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), '')

    def test_the_trial_repository_is_recognised_in_its_github_spellings(self):
        env = self.rig.env()
        for url in ('https://github.com/blamechris/chroxy', 'https://github.com/blamechris/chroxy.git',
                    'git@github.com:blamechris/chroxy.git', 'ssh://git@github.com/blamechris/chroxy.git'):
            self.assertTrue(launch._origin_is_trial_repo(self.rig.trial, env, url), url)
        for url in ('https://github.com/someone/chroxy', 'https://github.com/blamechris/chroxy-fork.git',
                    'https://gitlab.com/blamechris/chroxy', '/tmp/elsewhere.git', ''):
            self.assertFalse(launch._origin_is_trial_repo(self.rig.trial, env, url), url)

    def test_push_cuts_one_commit_over_t0_that_adds_only_the_rendered_mission(self):
        code, out = self.cut('A-cd-r1', 'B-cy-r1', push=True)
        self.assertEqual(code, 0, out)
        for rid in ('A-cd-r1', 'B-cy-r1'):
            run = self.rig.run(rid)
            tip = self.rig.branch(run.base)
            self.assertRegex(tip, r'^[0-9a-f]{40}$')
            self.assertEqual(helpers.git(self.rig.origin, 'rev-parse', f'{tip}^'), self.rig.t0)
            self.assertEqual(helpers.git(self.rig.origin, 'diff', '--name-only', self.rig.t0, tip),
                             self.rig.trial.mission_relpath(run))
            shown = subprocess.run(['git', 'show', f'{tip}:{self.rig.trial.mission_relpath(run)}'], cwd=self.rig.origin,
                                   capture_output=True, text=True).stdout
            self.assertEqual(shown, render.mission(self.rig.trial, run))
            self.assertEqual(helpers.git(self.rig.origin, 'log', '-1', '--format=%B', tip), f'docs(trial): mission for {rid}')
        self.assertEqual(len(self.worktrees()), 1)
        self.assertEqual(self.rig.box.trial().t0, self.rig.t0)

    def test_commit_has_no_attribution_trailer(self):
        self.cut('A-cd-r1', push=True)
        body = helpers.git(self.rig.origin, 'log', '-1', '--format=%B', self.rig.branch('trial/t2-a-cd-r1'))
        self.assertNotRegex(body.lower(), r'co-authored|generated|claude|anthropic')

    def test_cutting_again_recognises_the_base_it_made(self):
        self.cut('A-cd-r1', push=True)
        tip = self.rig.branch('trial/t2-a-cd-r1')
        code, out = self.cut('A-cd-r1', push=True)
        self.assertEqual(code, 0, out)
        self.assertIn('already cut', out)
        self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), tip)

    def amend_remote(self, base, files=None, content=None):
        """Rewrite the base on origin the way a stray hand-edit would."""
        wt = os.path.join(self.rig.box.tmp, 'edit')
        helpers.git(self.rig.seed, 'worktree', 'add', '-f', '--detach', wt, self.rig.branch(base))
        rel = self.rig.trial.mission_relpath(self.rig.run('A-cd-r1'))
        if content is not None:
            with open(os.path.join(wt, rel), 'w') as fh:
                fh.write(content)
        for name in files or []:
            with open(os.path.join(wt, name), 'w') as fh:
                fh.write('x\n')
        helpers.git(wt, 'add', '--', rel, *(files or []))
        helpers.git(wt, 'commit', '--amend', '-m', 'edited')
        helpers.git(wt, 'push', '--force', 'origin', f'HEAD:refs/heads/{base}')
        helpers.git(self.rig.seed, 'worktree', 'remove', '--force', wt)

    def test_a_base_with_another_mission_is_a_fail_and_is_not_rewritten(self):
        self.cut('A-cd-r1', push=True)
        self.amend_remote('trial/t2-a-cd-r1', content='some other mission\n')
        tip = self.rig.branch('trial/t2-a-cd-r1')
        code, out = self.cut('A-cd-r1', push=True)
        self.assertEqual(code, 1)
        self.assertIn('differs from the one rendered', out)
        self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), tip)

    def test_a_base_that_changes_more_than_the_mission_is_a_fail(self):
        self.cut('A-cd-r1', push=True)
        self.amend_remote('trial/t2-a-cd-r1', files=['stray.txt'])
        code, out = self.cut('A-cd-r1', push=True)
        self.assertEqual(code, 1)
        self.assertIn('stray.txt', out)

    def test_a_base_whose_parent_is_not_t0_is_a_fail(self):
        self.cut('A-cd-r1', push=True)
        helpers.git(self.rig.seed, 'fetch', 'origin')
        helpers.git(self.rig.seed, 'commit', '--allow-empty', '-m', 'moves main on')
        helpers.git(self.rig.seed, 'push', 'origin', 'main')
        new_t0 = helpers.git(self.rig.seed, 'rev-parse', 'HEAD')
        helpers.git(self.rig.seed, 'worktree', 'add', '--detach', os.path.join(self.rig.box.tmp, 'wt2'), self.rig.branch('trial/t2-a-cd-r1'))
        helpers.git(os.path.join(self.rig.box.tmp, 'wt2'), 'commit', '--allow-empty', '-m', 'second commit')
        helpers.git(os.path.join(self.rig.box.tmp, 'wt2'), 'push', 'origin', 'HEAD:refs/heads/trial/t2-a-cd-r1')
        helpers.git(self.rig.seed, 'worktree', 'remove', '--force', os.path.join(self.rig.box.tmp, 'wt2'))
        code, out = self.cut('A-cd-r1', t0=self.rig.t0, push=True)
        self.assertEqual(code, 1)
        self.assertIn('not exactly T0', out)
        self.assertNotEqual(new_t0, self.rig.t0)

    def test_a_short_or_malformed_t0_is_refused(self):
        for bad in (self.rig.t0[:12], 'z' * 40, '', self.rig.t0 + '0'):
            code, out = self.cut('A-cd-r1', t0=bad or ' ')
            self.assertEqual(code, 2, bad)
            self.assertIn('40-character', out)
        self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), '')

    def test_a_t0_that_is_not_on_origin_main_is_refused_and_nothing_is_recorded(self):
        helpers.git(self.rig.seed, 'commit', '--allow-empty', '-m', 'local only')
        local_only = helpers.git(self.rig.seed, 'rev-parse', 'HEAD')
        code, out = self.cut('A-cd-r1', t0=local_only, push=True)
        self.assertEqual(code, 2)
        self.assertIn('not an ancestor of origin/main', out)
        self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), '')
        self.assertIsNone(self.rig.box.trial().t0)

    def test_a_t0_unknown_to_git_is_refused(self):
        code, out = self.cut('A-cd-r1', t0='1' * 40, push=True)
        self.assertEqual(code, 2)
        self.assertIn('refusing', out)

    def test_a_different_recorded_t0_is_refused(self):
        config.save_t0(self.rig.trial, 'a' * 40)
        code, out = self.cut('A-cd-r1', push=True)
        self.assertEqual(code, 2)
        self.assertIn('already records t0', out)
        self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), '')

    def test_an_empty_queue_cannot_be_cut(self):
        self.rig = Rig(self, record_t0=False, slots=[])
        code, out = self.cut('A-cd-r1', push=True)
        self.assertEqual(code, 2)
        self.assertIn('queue is empty', out)
        self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), '')

    def test_the_worktree_is_removed_when_the_commit_fails(self):
        runner = Runner().on(lambda a: a[:2] == ['git', 'commit'], 1, '', 'boom')
        code, out = self.cut('A-cd-r1', push=True, runner=runner)
        self.assertEqual(code, 1)
        self.assertIn('git commit failed', out)
        work = runner.ran('git', 'worktree', 'add')[0]['argv'][-2]
        self.assertFalse(os.path.exists(work))
        self.assertFalse(os.path.exists(os.path.dirname(work)))
        self.assertEqual(len(self.worktrees()), 1)

    def test_the_worktree_is_removed_by_remove_even_if_prune_does_nothing(self):
        runner = Runner().on(lambda a: a[:3] == ['git', 'worktree', 'prune'], 0, '')
        code, out = self.cut('A-cd-r1', push=True, runner=runner)
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.worktrees()), 1)

    def test_the_worktree_is_still_gone_when_remove_fails(self):
        runner = Runner().on(lambda a: a[:3] == ['git', 'worktree', 'remove'], 1, '', 'locked')
        code, out = self.cut('A-cd-r1', push=True, runner=runner)
        self.assertEqual(code, 0, out)
        work = runner.ran('git', 'worktree', 'add')[0]['argv'][-2]
        self.assertFalse(os.path.exists(os.path.dirname(work)))
        self.assertEqual(len(self.worktrees()), 1, 'the leftover registration is pruned')

    def test_a_rejected_push_is_a_fail_and_the_worktree_is_still_removed(self):
        runner = Runner().on(lambda a: a[:2] == ['git', 'push'], 1, '', 'remote rejected')
        code, out = self.cut('A-cd-r1', push=True, runner=runner)
        self.assertEqual(code, 1)
        self.assertIn('git push failed', out)
        self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), '')
        self.assertEqual(len(self.worktrees()), 1)

    def test_a_push_that_did_not_land_is_not_reported_as_pushed(self):
        runner = Runner().on(lambda a: a[:2] == ['git', 'push'], 0, '', '')
        code, out = self.cut('A-cd-r1', push=True, runner=runner)
        self.assertEqual(code, 1)
        self.assertIn('origin lists', out)

    def test_an_unreachable_origin_is_unverified_not_a_pass(self):
        runner = Runner().on(lambda a: a[:2] == ['git', 'ls-remote'], 128, '', 'network down')
        code, out = self.cut('A-cd-r1', push=True, runner=runner)
        self.assertEqual(code, 2)
        self.assertRegex(out, r'UNVERIFIED\s+base trial/t2-a-cd-r1')

    def test_a_commit_that_does_not_read_back_as_built_is_a_fail_and_is_never_pushed(self):
        """The self-check between building the base and pushing it: whatever it cannot confirm or finds wrong is a
        FAIL (not an UNVERIFIED, not a PASS), and the push command is not run."""
        other = 'f' * 40
        rel = self.rig.trial.mission_relpath(self.rig.run('A-cd-r1'))
        parents = lambda a: a[:3] == ['git', 'rev-list', '--parents']
        diff = lambda a: a[:3] == ['git', 'diff', '--name-only']
        blob = lambda a: a[:2] == ['git', 'rev-parse'] and ':' in a[2]
        cases = {
            'parents unreadable': (parents, 128, '', 'fatal: bad object', 'cannot inspect'),
            'wrong parent': (parents, 0, f'{other} {other}\n', '', 'not exactly T0'),
            'diff unreadable': (diff, 128, '', 'fatal: bad revision', 'cannot diff'),
            'a path besides the mission': (diff, 0, f'{rel}\nstray.txt\n', '', 'differs from T0 in'),
            'mission blob unreadable': (blob, 128, '', 'fatal: bad path', 'cannot read'),
            'another mission': (blob, 0, other + '\n', '', 'differs from the one rendered'),
        }
        for label, (predicate, rc, stdout, stderr, fragment) in cases.items():
            with self.subTest(label):
                runner = Runner().on(predicate, rc, stdout, stderr)
                code, out = self.cut('A-cd-r1', push=True, runner=runner)
                self.assertEqual(code, 1, out)
                self.assertRegex(out, r'FAIL\s+base trial/t2-a-cd-r1\s+built [0-9a-f]{12} but ')
                self.assertIn(fragment, out)
                self.assertIn('nothing pushed', out)
                self.assertNotRegex(out, r'(PASS|UNVERIFIED)\s+base ')
                self.assertEqual(runner.ran('git', 'push'), [], 'the push was not attempted')
                self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), '')
                self.assertEqual(len(self.worktrees()), 1, 'the worktree is removed')

    def test_a_step_of_building_the_base_that_fails_is_a_fail_and_pushes_nothing(self):
        cases = {
            'worktree add': (argv_starts('git', 'worktree', 'add'), 128, '', 'fatal: cannot create', 'git worktree add failed'),
            'add': (argv_starts('git', 'add'), 1, '', 'index.lock exists', 'git add failed'),
            'reading the new commit': (lambda a: a == ['git', 'rev-parse', 'HEAD'], 128, '', 'fatal: bad HEAD', 'cannot read the new commit'),
            'a new commit that is not an object id': (lambda a: a == ['git', 'rev-parse', 'HEAD'], 0, 'not-a-sha\n', '', 'cannot read the new commit'),
        }
        for label, (predicate, rc, stdout, stderr, fragment) in cases.items():
            with self.subTest(label):
                runner = Runner().on(predicate, rc, stdout, stderr)
                code, out = self.cut('A-cd-r1', push=True, runner=runner)
                self.assertEqual(code, 1, out)
                self.assertRegex(out, r'FAIL\s+base trial/t2-a-cd-r1\s+' + fragment)
                self.assertEqual(runner.ran('git', 'push'), [])
                self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), '')
                self.assertEqual(len(self.worktrees()), 1, 'whatever was added is removed')

    def test_an_existing_base_that_cannot_be_inspected_is_unverified_and_left_alone(self):
        self.cut('A-cd-r1', push=True)
        tip = self.rig.branch('trial/t2-a-cd-r1')
        cases = {
            'parents': (lambda a: a[:3] == ['git', 'rev-list', '--parents'], 'cannot inspect'),
            'diff': (lambda a: a[:3] == ['git', 'diff', '--name-only'], 'cannot diff'),
            'mission blob': (lambda a: a[:2] == ['git', 'rev-parse'] and ':' in a[2], 'cannot read'),
        }
        for label, (predicate, fragment) in cases.items():
            with self.subTest(label):
                runner = Runner().on(predicate, 128, '', 'fatal: unreadable')
                code, out = self.cut('A-cd-r1', push=True, runner=runner)
                self.assertEqual(code, 2, out)
                self.assertRegex(out, r'UNVERIFIED\s+base trial/t2-a-cd-r1\s+exists on origin but ' + fragment)
                self.assertIn('it is not rewritten here', out)
                self.assertEqual(runner.ran('git', 'worktree', 'add'), [], 'nothing was rebuilt')
                self.assertEqual(runner.ran('git', 'push'), [])
                self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), tip)


class CutQueueText(unittest.TestCase):
    """`cut` records the queue's text digests with T0 (queue-t0.json), reading everything before anything is recorded."""

    def setUp(self):
        self.rig = Rig(self, record_t0=False)

    def cut(self, *ids, github=None, push=False, t0=None):
        env = self.rig.env(github=github)
        code = launch.cut(self.rig.trial, [self.rig.run(i) for i in ids], env, t0=t0 or self.rig.t0, push=push, repo_dir=self.rig.seed)
        return code, env.out.getvalue()

    def assertNothingRecorded(self):
        self.assertIsNone(self.rig.box.trial().t0, 'T0 was recorded')
        self.assertFalse(os.path.exists(snapshot_path(self.rig)), 'a snapshot was written')

    def test_it_writes_the_digests_of_every_slot_with_t0(self):
        code, out = self.cut('A-cd-r1')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.rig.box.trial().t0, self.rig.t0)
        data = snapshot_file(self.rig)
        self.assertEqual(sorted(data), ['at', 'slots', 't0'])
        self.assertEqual((data['t0'], data['at']), (self.rig.t0, '2026-11-02T12:00:00Z'))
        self.assertEqual(list(data['slots']), ['Q01', 'Q02'])
        for slot, number in (('Q01', 9001), ('Q02', 9002)):
            self.assertEqual(data['slots'][slot], {
                'issue': number, 'title_sha256': sha256_of(f'title of {number}'), 'body_sha256': sha256_of(f'body of {number}'),
                'comments_sha256': sha256_of(canonical([{'id': number * 10 + 1, 'user': 'alice', 'body': 'a comment'}])), 'comments': 1})
        with open(snapshot_path(self.rig), encoding='utf-8') as fh:
            text = fh.read()
        self.assertFalse('title of' in text or 'body of' in text or 'a comment' in text, 'the file holds digests, never text')
        self.assertIn('queue-t0.json', out)
        self.assertNotIn('note:', out, 'the cut that records T0 takes the snapshot at T0')

    def test_it_reads_each_slots_issue_and_comments_once_however_many_bases_are_cut(self):
        gh = FakeGitHub()
        code, out = self.cut('A-cd-r1', 'B-cy-r1', github=gh)
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(p for p, _ in gh.requests),
                         sorted([f'repos/blamechris/chroxy/issues/{n}' for n in (9001, 9002)]
                                + [f'repos/blamechris/chroxy/issues/{n}/comments' for n in (9001, 9002)]))

    def test_the_text_is_read_whatever_the_issue_state_and_hashed_as_the_gate_will_read_it(self):
        gh = FakeGitHub(titles={9001: 'Überschrift — ünïcode'}, bodies={9001: None, 9002: 'line one\r\nline two'},
                        comments={9001: [comment(30, 'second', 'bob'), comment(5, 'first ✓', 'alice')],
                                  9002: [{'id': 8, 'user': None, 'body': None}]})
        code, out = self.cut('A-cd-r1', github=gh)
        self.assertEqual(code, 0, out)
        one, two = snapshot_file(self.rig)['slots']['Q01'], snapshot_file(self.rig)['slots']['Q02']
        self.assertEqual(one['title_sha256'], sha256_of('Überschrift — ünïcode'))
        self.assertEqual(one['body_sha256'], sha256_of(''), 'a null body is the empty string')
        self.assertEqual(one['comments_sha256'], sha256_of(canonical([{'id': 5, 'user': 'alice', 'body': 'first ✓'},
                                                                      {'id': 30, 'user': 'bob', 'body': 'second'}])))
        self.assertEqual(two['body_sha256'], sha256_of('line one\r\nline two'))
        self.assertEqual(two['comments_sha256'], sha256_of(canonical([{'id': 8, 'user': None, 'body': ''}])))
        self.assertEqual((one['comments'], two['comments']), (2, 1))

    def test_a_snapshot_taken_in_a_different_order_of_comments_is_the_same_snapshot(self):
        a, b = comment(1, 'x'), comment(2, 'y')
        env_a, env_b = FakeGitHub(comments={9001: [a, b]}), FakeGitHub(comments={9001: [b, a]})
        slot = self.rig.trial.slots[0]
        self.assertEqual(queue_text.read_slot(env_a, slot), queue_text.read_slot(env_b, slot))

    def test_one_unreadable_comments_listing_refuses_the_cut_and_records_nothing(self):
        code, out = self.cut('A-cd-r1', github=FakeGitHub(comments={9002: GitHubError('HTTP 502', 502)}), push=True)
        self.assertEqual(code, 2, out)
        self.assertIn('cut: refusing:', out)
        self.assertIn('cannot read Q02 #9002', out)
        self.assertNotIn('Q01 #9001', out)
        self.assertNothingRecorded()
        self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), '', 'nothing was pushed')
        self.assertEqual(len(helpers.git(self.rig.seed, 'worktree', 'list').splitlines()), 1, 'no base was even built')

    def test_an_unreadable_issue_refuses_the_cut_and_every_unreadable_slot_is_named(self):
        gh = FakeGitHub(issues={9001: GitHubError('HTTP 404', 404)}, comments={9002: GitHubError('HTTP 500', 500)})
        code, out = self.cut('A-cd-r1', github=gh)
        self.assertEqual(code, 2, out)
        self.assertIn('cannot read Q01 #9001', out)
        self.assertIn('cannot read Q02 #9002', out)
        self.assertNothingRecorded()

    def test_a_reply_that_is_not_an_issue_refuses_the_cut(self):
        gh = FakeGitHub(comments={9001: [{'id': 4}]})
        code, out = self.cut('A-cd-r1', github=gh)
        self.assertEqual(code, 2, out)
        self.assertIn('cannot read Q01 #9001', out)
        self.assertNothingRecorded()

    def test_an_existing_snapshot_for_the_same_t0_is_left_alone_and_nothing_is_read(self):
        self.assertEqual(self.cut('A-cd-r1')[0], 0)
        before = file_bytes(snapshot_path(self.rig))
        gh = FakeGitHub(bodies={9001: 'edited since', 9002: 'edited since'})
        code, out = self.cut('B-cy-r1', github=gh)
        self.assertEqual(code, 0, out)
        self.assertEqual(file_bytes(snapshot_path(self.rig)), before)
        self.assertEqual(gh.requests, [], 'the later cut needs no network')
        self.assertNotIn('queue text at T0 recorded', out)

    def test_a_recorded_t0_with_no_snapshot_gets_one_whose_time_says_when_it_was_read(self):
        config.save_t0(self.rig.trial, self.rig.t0)
        self.assertFalse(os.path.exists(snapshot_path(self.rig)))
        code, out = self.cut('A-cd-r1')
        self.assertEqual(code, 0, out)
        data = snapshot_file(self.rig)
        self.assertEqual((data['t0'], data['at']), (self.rig.t0, '2026-11-02T12:00:00Z'))
        self.assertIn("note: T0 was recorded without queue-t0.json, so its text was read now, after T0. No run state in ~/trial/t2/state "
                      "records a start; `cut` reads only this machine's run states, so if a run has started elsewhere, remove this snapshot "
                      "and put the committed one back", out)

    def test_a_recorded_t0_with_no_snapshot_once_a_run_has_started_is_refused_not_taken(self):
        # #8808: each base is cut just before its run, so a lost snapshot would otherwise be retaken, late, by the next routine cut.
        config.save_t0(self.rig.trial, self.rig.t0)
        self.rig.save_state('A-cd-r1', start={'sent_at': '2026-11-02T10:00:00Z'}, finish={'ended_at': '2026-11-02T11:00:00Z'})
        gh = FakeGitHub()
        code, out = self.cut('B-cy-r1', github=gh, push=True)
        self.assertEqual(code, 2, out)
        self.assertIn(f'cut: refusing: queue-t0.json is missing and A-cd-r1 has started, {STATES}: it is not taken now, because {LATE}. '
                      f'Put the committed file back, then cut again ({WRONG_STATE})', out)
        self.assertFalse(os.path.exists(snapshot_path(self.rig)))
        self.assertEqual(gh.requests, [], 'no text was read')
        self.assertEqual(self.rig.branch(self.rig.run('B-cy-r1').base), '', 'no base was cut')
        queue_text.write(self.rig.trial, {'t0': self.rig.t0, 'at': SNAPSHOT_AT, 'slots': {}})
        code, out = self.cut('B-cy-r1', github=gh, push=True)
        self.assertEqual(code, 0, out)
        self.assertNotEqual(self.rig.branch(self.rig.run('B-cy-r1').base), '', 'with the file back, the routine cut goes ahead')

    def test_a_run_state_that_cannot_be_read_refuses_a_missing_snapshot_too(self):
        config.save_t0(self.rig.trial, self.rig.t0)
        for how in ('corrupt', 'folder without permission'):
            with self.subTest(how):
                if how == 'folder without permission' and os.geteuid() == 0:
                    self.skipTest('root reads a folder whatever its mode')
                undo = plant_unreadable_state(self.rig, 'A-cd-r1', how)
                code, out = self.cut('B-cy-r1')
                undo()
                self.assertEqual(code, 2, out)
                self.assertIn('cut: refusing: queue-t0.json is missing and a run state in ~/trial/t2/state cannot be read (', out)
                self.assertIn(f'), so a started run cannot be ruled out: it is not taken now, because {LATE}. Put the committed file back, '
                              f'then cut again ({WRONG_STATE})', out)
                self.assertFalse(os.path.exists(snapshot_path(self.rig)))

    def test_the_cut_that_records_t0_takes_the_snapshot_whatever_starts_the_state_folder_holds(self):
        # Before T0 no run of the trial can have started (its base is cut from T0): a start there is a dry run's (PLAN step 5).
        self.rig.save_state('A-cd-r1', start={'sent_at': '2026-11-01T10:00:00Z'}, finish={'ended_at': '2026-11-01T10:30:00Z'})
        code, out = self.cut('A-cd-r1')
        self.assertEqual(code, 0, out)
        self.assertEqual(snapshot_file(self.rig)['t0'], self.rig.t0)
        self.assertNotIn('note:', out)

    def test_a_snapshot_taken_at_another_t0_refuses_and_is_never_overwritten(self):
        queue_text.write(self.rig.trial, {'t0': 'a' * 40, 'at': '2026-10-30T00:00:00Z', 'slots': {}})
        before = file_bytes(snapshot_path(self.rig))
        code, out = self.cut('A-cd-r1', push=True)
        self.assertEqual(code, 2, out)
        self.assertIn('queue-t0.json was taken at T0 aaaaaaaaaaaa', out)
        self.assertIn('never overwritten', out)
        self.assertIsNone(self.rig.box.trial().t0)
        self.assertEqual(file_bytes(snapshot_path(self.rig)), before)
        self.assertEqual(self.rig.branch('trial/t2-a-cd-r1'), '')

    def test_a_snapshot_that_cannot_be_read_refuses_and_is_left_where_it_is(self):
        for how in ('corrupt', 'directory'):
            with self.subTest(how):
                undo = plant_unreadable_snapshot(self.rig, how)
                code, out = self.cut('A-cd-r1')
                undo()
                self.assertEqual(code, 2, out)
                self.assertIn('queue-t0.json exists but is unreadable', out)
                self.assertIsNone(self.rig.box.trial().t0)
        with open(snapshot_path(self.rig), 'w') as fh:
            fh.write('[]')
        code, out = self.cut('A-cd-r1')
        self.assertEqual(code, 2, out)
        self.assertIn('exists but is malformed', out)
        self.assertEqual(file_bytes(snapshot_path(self.rig)), b'[]')

    def test_a_different_recorded_t0_is_still_refused_first_and_no_text_is_read(self):
        config.save_t0(self.rig.trial, 'a' * 40)
        gh = FakeGitHub()
        code, out = self.cut('A-cd-r1', github=gh)
        self.assertEqual(code, 2, out)
        self.assertIn('already records t0', out)
        self.assertEqual(gh.requests, [])
        self.assertFalse(os.path.exists(snapshot_path(self.rig)))

    def test_a_snapshot_that_cannot_be_written_after_t0_is_recorded_says_so_and_a_second_cut_writes_it(self):
        with mock.patch.object(queue_text, 'write', side_effect=OSError('disk full')):
            code, out = self.cut('A-cd-r1')
        self.assertEqual(code, 2, out)
        self.assertIn('T0 is recorded but queue-t0.json could not be written (disk full)', out)
        self.assertEqual(self.rig.box.trial().t0, self.rig.t0)
        self.assertFalse(os.path.exists(snapshot_path(self.rig)))
        self.rig.trial = self.rig.box.trial()
        code, out = self.cut('A-cd-r1')
        self.assertEqual(code, 0, out)
        self.assertEqual(snapshot_file(self.rig)['t0'], self.rig.t0)

    def test_a_refused_push_or_t0_records_no_snapshot(self):
        code, out = self.cut('A-cd-r1', t0='1' * 40)
        self.assertEqual(code, 2, out)
        self.assertNothingRecorded()
        code, out = self.cut('A-cd-r1', t0='z' * 40)
        self.assertEqual(code, 2, out)
        self.assertNothingRecorded()


class QueueTextFile(unittest.TestCase):
    """queue_text.write: whole or not at all, and never over a file that is there."""

    def setUp(self):
        self.rig = Rig(self, record_t0=False)
        self.data = {'t0': self.rig.t0, 'at': SNAPSHOT_AT, 'slots': {}}

    def leftovers(self):
        return [n for n in os.listdir(self.rig.box.trial_dir) if n.startswith('.queue-t0.json')]

    def test_it_writes_the_file_and_leaves_no_temporary_one(self):
        queue_text.write(self.rig.trial, self.data)
        self.assertEqual(snapshot_file(self.rig), self.data)
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(os.stat(snapshot_path(self.rig)).st_mode & 0o777, 0o644)

    def test_it_never_replaces_a_file_that_is_there(self):
        queue_text.write(self.rig.trial, self.data)
        with self.assertRaises(queue_text.QueueTextError):
            queue_text.write(self.rig.trial, dict(self.data, at='2099-01-01T00:00:00Z'))
        self.assertEqual(snapshot_file(self.rig)['at'], SNAPSHOT_AT)
        self.assertEqual(self.leftovers(), [])

    def test_a_failure_while_putting_it_in_place_leaves_no_file_and_no_temporary_one(self):
        with mock.patch.object(os, 'link', side_effect=OSError('no hard links here')):
            with self.assertRaises(OSError):
                queue_text.write(self.rig.trial, self.data)
        self.assertFalse(os.path.exists(snapshot_path(self.rig)))
        self.assertEqual(self.leftovers(), [])

    def test_a_snapshot_that_would_not_read_back_as_written_is_refused(self):
        with self.assertRaises(queue_text.QueueTextError):
            queue_text.write(self.rig.trial, {'t0': self.rig.t0, 'at': 'x', 'slots': {1: {}}})   # an int key reads back as a string
        self.assertFalse(os.path.exists(snapshot_path(self.rig)))
        self.assertEqual(self.leftovers(), [])


class QueueTextReads(unittest.TestCase):
    """queue_text.read_slot: the shapes it accepts and the ones it refuses."""
    SLOT = config.Slot('Q01', 9001, 'a title')

    def read(self, **kwargs):
        return queue_text.read_slot(FakeGitHub(**kwargs), self.SLOT)

    def test_a_missing_body_key_or_title_is_a_refusal_not_an_empty_text(self):
        class Bare(FakeGitHub):
            def __init__(self, drop):
                super().__init__()
                self.drop = drop

            def get(self, path, params=None):
                reply = super().get(path, params)
                reply.pop(self.drop, None)
                return reply

        for drop in ('title', 'body'):
            with self.subTest(drop), self.assertRaises(queue_text.QueueTextError):
                queue_text.read_slot(Bare(drop), self.SLOT)

    def test_a_comment_listing_that_returns_one_comment_twice_is_a_refusal(self):
        with self.assertRaises(queue_text.QueueTextError) as ctx:
            self.read(comments={9001: [comment(3), comment(3)]})
        self.assertIn('comment 3 was listed twice', str(ctx.exception))

    def test_a_reply_that_is_not_json_is_a_refusal(self):
        with self.assertRaises(queue_text.QueueTextError) as ctx:
            self.read(comments={9001: ValueError('Expecting value')})
        self.assertIn('Expecting value', str(ctx.exception))

    def test_the_comment_author_is_part_of_the_digest_and_a_deleted_account_reads_as_none(self):
        a = self.read(comments={9001: [comment(1, 'x', 'alice')]})['comments_sha256']
        b = self.read(comments={9001: [comment(1, 'x', 'bob')]})['comments_sha256']
        ghost = self.read(comments={9001: [{'id': 1, 'user': None, 'body': 'x'}]})['comments_sha256']
        nokey = self.read(comments={9001: [{'id': 1, 'body': 'x'}]})['comments_sha256']
        self.assertEqual(len({a, b, ghost}), 3)
        self.assertEqual(ghost, nokey)


class FirstSha(unittest.TestCase):
    def test_only_the_exact_ref_counts(self):
        sha = 'a' * 40
        listing = f'{"b" * 40}\trefs/heads/other/refs/heads/trial/x\n{sha}\trefs/heads/trial/x\n'
        self.assertEqual(launch._first_sha(listing, 'refs/heads/trial/x'), sha)
        self.assertIsNone(launch._first_sha(f'{"b" * 40}\trefs/heads/other/refs/heads/trial/x\n', 'refs/heads/trial/x'))
        self.assertIsNone(launch._first_sha('', 'refs/heads/trial/x'))
        self.assertIsNone(launch._first_sha('zzzz\trefs/heads/trial/x\n', 'refs/heads/trial/x'))


# -- clone -------------------------------------------------------------------------

class Clone(LaunchCase):
    def setUp(self):
        super().setUp()
        self.rig.cut('A-cd-r1')

    def clone(self, dest=None, skip_install=True, runner=None, rid='A-cd-r1'):
        env = self.rig.env(runner)
        code = launch.clone(self.rig.trial, self.rig.run(rid), env, dest, skip_install, None)
        return code, env.out.getvalue(), env

    def test_clones_the_base_sets_the_identity_and_records_it(self):
        code, out, _ = self.clone()
        self.assertEqual(code, 0, out)
        dest = self.rig.clone_dir('A-cd-r1')
        self.assertTrue(os.path.exists(os.path.join(dest, self.rig.trial.mission_relpath(self.rig.run('A-cd-r1')))))
        self.assertEqual(helpers.git(dest, 'rev-parse', 'HEAD'), self.rig.branch('trial/t2-a-cd-r1'))
        self.assertEqual(helpers.git(dest, 'config', '--local', 'user.name'), 'Chris Test')
        self.assertEqual(helpers.git(dest, 'config', '--local', 'user.email'), 'chris@example.com')
        self.assertIn('Chris Test <chris@example.com>', out)
        rec = self.rig.state('A-cd-r1')['clone']
        self.assertEqual(rec['dir'], '~/trial/t2/A-cd-r1')
        self.assertEqual((rec['base_tip'], rec['installed'], rec['identity']),
                         (self.rig.branch('trial/t2-a-cd-r1'), False, {'name': 'Chris Test', 'email': 'chris@example.com'}))
        self.assertEqual(rec['at'], '2026-11-02T12:00:00Z')

    def test_installs_with_npm_ci_under_the_configured_node(self):
        runner = Runner().on(argv_starts('npm', 'ci', '--no-audit', '--no-fund'), 0, 'added 1 package')
        code, out, _ = self.clone(skip_install=False, runner=runner)
        self.assertEqual(code, 0, out)
        call = runner.ran('npm')[0]
        self.assertEqual(call['cwd'], self.rig.clone_dir('A-cd-r1'))
        self.assertTrue(call['env']['PATH'].startswith('/opt/homebrew/opt/node@22/bin' + os.pathsep))
        self.assertEqual(call['env']['HOME'], self.rig.box.home)
        self.assertTrue(self.rig.state('A-cd-r1')['clone']['installed'])

    def test_a_failed_install_is_a_fail_but_the_clone_is_recorded(self):
        runner = Runner().on(argv_starts('npm', 'ci'), 1, '', 'EACCES')
        code, out, _ = self.clone(skip_install=False, runner=runner)
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+npm ci')
        self.assertFalse(self.rig.state('A-cd-r1')['clone']['installed'])

    def test_a_tree_the_install_dirtied_is_a_fail(self):
        def dirty(argv, cwd, env):
            with open(os.path.join(cwd, 'stray.txt'), 'w') as fh:
                fh.write('x')

        runner = Runner().on(argv_starts('npm', 'ci'), 0, 'ok').act(argv_starts('npm', 'ci'), dirty)
        code, out, _ = self.clone(skip_install=False, runner=runner)
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+clone clean')

    def test_a_head_that_moved_during_setup_is_a_fail(self):
        def commit(argv, cwd, env):
            helpers.git(cwd, 'commit', '--allow-empty', '-m', 'a lifecycle script committed')

        runner = Runner().on(argv_starts('npm', 'ci'), 0, 'ok').act(argv_starts('npm', 'ci'), commit)
        code, out, _ = self.clone(skip_install=False, runner=runner)
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+HEAD is origin base')

    def assertRefused(self, dest, fragment, **kw):
        runner = Runner()
        code, out, _ = self.clone(dest=dest, runner=runner, **kw)
        self.assertEqual(code, 1, out)
        self.assertIn(fragment, out)
        self.assertEqual(runner.ran('git', 'clone'), [], 'nothing was cloned')
        self.assertNotIn('clone', self.rig.state('A-cd-r1'))

    def test_a_non_empty_destination_is_refused_and_left_alone(self):
        dest = self.rig.home('trial', 'busy')
        os.makedirs(dest)
        with open(os.path.join(dest, 'keep.txt'), 'w') as fh:
            fh.write('mine')
        self.assertRefused(dest, 'exists and is not empty')
        self.assertEqual(os.listdir(dest), ['keep.txt'])

    def test_an_empty_existing_destination_is_fine(self):
        dest = self.rig.home('trial', 'empty')
        os.makedirs(dest)
        code, out, _ = self.clone(dest=dest)
        self.assertEqual(code, 0, out)

    def test_a_destination_inside_the_daemon_checkout_is_refused(self):
        self.assertRefused(self.rig.home('chroxy', 'trial', 'A-cd-r1'), 'inside the daemon checkout')
        self.assertFalse(os.path.exists(self.rig.home('chroxy', 'trial')))

    def test_a_destination_inside_the_trial_repository_is_refused(self):
        self.assertRefused(os.path.join(self.rig.box.root, 'scratch', 'A-cd-r1'), 'inside the trial repository')

    def test_a_destination_inside_another_git_work_tree_is_refused(self):
        outer = self.rig.home('work')
        os.makedirs(os.path.join(outer, '.git'))
        self.assertRefused(os.path.join(outer, 'nested', 'A-cd-r1'), f'git work tree at {os.path.realpath(outer)}')

    def test_a_symlink_into_the_daemon_checkout_does_not_get_around_the_rule(self):
        link = self.rig.home('shortcut')
        os.symlink(self.rig.home('chroxy'), link)
        self.assertRefused(os.path.join(link, 'A-cd-r1'), 'inside the daemon checkout')

    def test_without_a_git_identity_nothing_is_written(self):
        os.remove(self.rig.home('.gitconfig'))
        runner = Runner()
        code, out, _ = self.clone(runner=runner)
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+git identity')
        self.assertEqual(runner.ran('git', 'clone'), [])
        self.assertFalse(os.path.exists(self.rig.clone_dir('A-cd-r1')))

    def test_a_base_that_is_not_on_origin_fails_the_clone(self):
        code, out, _ = self.clone(rid='B-cy-r1')
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+git clone')

    def test_a_refused_destination_is_reported_as_a_fail(self):
        dest = self.rig.home('trial', 'busy')
        os.makedirs(dest)
        with open(os.path.join(dest, 'keep.txt'), 'w') as fh:
            fh.write('mine')
        code, out, _ = self.clone(dest=dest)
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+destination\s+.*exists and is not empty')
        self.assertNotRegex(out, r'PASS\s+destination')

    def test_an_identity_that_cannot_be_set_in_the_clone_is_a_fail_and_the_clone_is_not_recorded(self):
        runner = Runner().on(argv_starts('git', 'config', 'user.name'), 1, '', 'could not lock config file')
        code, out, _ = self.clone(runner=runner)
        self.assertEqual(code, 1)
        self.assertRegex(out, r'FAIL\s+clone identity\s+git config user.name: could not lock config file')
        self.assertNotIn('clone', self.rig.state('A-cd-r1'))

    def test_a_status_that_cannot_be_read_after_setup_is_unverified_not_clean(self):
        runner = Runner().on(argv_starts('git', 'status', '--porcelain'), 128, '', 'fatal: not a git repository')
        code, out, _ = self.clone(runner=runner)
        self.assertEqual(code, 2, out)
        self.assertRegex(out, r'UNVERIFIED\s+clone clean\s+fatal: not a git repository')
        self.assertNotRegex(out, r'PASS\s+clone clean')
        self.assertIn('not usable as it is', out)

    # -- the clone knows no branch but its base (#8794)

    BASE = 'trial/t2-a-cd-r1'

    def remote_refs(self, clone_dir):
        listing = helpers.git(clone_dir, 'for-each-ref', '--format=%(refname)', 'refs/remotes')
        return listing.splitlines()

    def test_the_clone_holds_the_base_as_its_only_remote_tracking_ref(self):
        self.rig.cut('B-cy-r1')           # origin now holds main and two bases
        heads = helpers.git(self.rig.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').splitlines()
        self.assertEqual(sorted(heads), ['main', self.BASE, 'trial/t2-b-cy-r1'], 'the source must hold other branches for this to prove anything')
        code, out, _ = self.clone()
        self.assertEqual(code, 0, out)
        dest = self.rig.clone_dir('A-cd-r1')
        self.assertEqual(self.remote_refs(dest), [f'refs/remotes/origin/{self.BASE}'])
        self.assertEqual(helpers.git(dest, 'config', '--get-all', 'remote.origin.fetch'),
                         f'+refs/heads/{self.BASE}:refs/remotes/origin/{self.BASE}')
        for other in ('origin/main', 'origin/trial/t2-b-cy-r1'):
            self.assertNotEqual(subprocess.run(['git', '-C', dest, 'rev-parse', '--verify', '-q', other],
                                               capture_output=True).returncode, 0, f'{other} is known to the clone')
        self.assertRegex(out, r'PASS\s+clone refs\s+only refs/remotes/origin/trial/t2-a-cd-r1')

    def test_the_clone_command_is_single_branch(self):
        runner = Runner()
        code, out, _ = self.clone(runner=runner)
        self.assertEqual(code, 0, out)
        argv = runner.ran('git', 'clone')[0]['argv']
        self.assertEqual(argv[:5], ['git', 'clone', '--branch', self.BASE, '--single-branch'])

    def test_a_clone_that_fetched_every_branch_fails_naming_what_it_should_not_know(self):
        class Unfiltered(Runner):
            def run(self, argv, cwd=None, env=None, timeout=None, input=None):
                if argv[:2] == ['git', 'clone']:
                    argv = [a for a in argv if a != '--single-branch']
                return super().run(argv, cwd=cwd, env=env, timeout=timeout, input=input)

        self.rig.cut('B-cy-r1')
        code, out, _ = self.clone(runner=Unfiltered())
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+clone refs\s+extra remote-tracking ref\(s\): .*refs/remotes/origin/main')
        self.assertIn('refs/remotes/origin/trial/t2-b-cy-r1', out)
        self.assertIn('remote.origin.fetch is', out)
        self.assertIn('remove the clone and run `trialctl clone A-cd-r1` again', out)
        self.assertIn('not usable as it is', out)

    def test_a_clone_whose_refs_cannot_be_listed_is_unverified_not_clean(self):
        runner = Runner().on(argv_starts('git', 'for-each-ref'), 128, '', 'fatal: bad object')
        code, out, _ = self.clone(runner=runner)
        self.assertEqual(code, 2, out)
        self.assertRegex(out, r'UNVERIFIED\s+clone refs\s+cannot list the remote-tracking refs: fatal: bad object')
        self.assertNotRegex(out, r'PASS\s+clone refs')


# -- preflight, before the send ------------------------------------------------------

class PreflightClaudeNative(LaunchCase):
    def setUp(self):
        super().setUp()
        self.run_ = self.prep('A-cd-r1')

    def test_everything_correct_passes_and_the_facts_are_recorded(self):
        code, out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 0, out)
        self.assertTrue(all(s == 'PASS' for s in statuses(st).values()), statuses(st))
        self.assertEqual(set(statuses(st)), {'clone exists', 'clone clean', 'clone matches origin', 'clone refs', 'base shape', 'mission file',
                                             'clone identity', 'node version', 'gh login', 'CI fleet quiet',
                                             'no other run live', 'effort setting', 'claude version'})
        entry = st['preflight'][-1]
        settings = self.rig.home('.claude', 'settings.json')
        with open(settings, 'rb') as fh:
            self.assertEqual(entry['facts']['claude_settings_sha256'], hashlib.sha256(fh.read()).hexdigest())
        self.assertEqual(entry['facts']['head'], self.rig.branch('trial/t2-a-cd-r1'))
        self.assertEqual((entry['phase'], entry['at'], entry['facts']['claude_version']), ('pre', '2026-11-02T12:00:00Z', '2.1.308'))
        self.assertEqual(entry['facts']['clone_dir'], '~/trial/t2/A-cd-r1')

    def test_running_ci_fails_the_quiet_fleet_check(self):
        # A freshly cut base's own push run, or another PR's, loads the runners the subject machine hosts.
        busy = toolbox(self.rig, ci_running=ci_reply((40120273200, 'trial/t2-a-cd-r1')))
        code, out, st = self.pre('A-cd-r1', runner=busy)
        self.assertEqual(code, 1, out)
        self.assertStatus(statuses(st), 'CI fleet quiet', 'FAIL')
        self.assertIn('40120273200 trial/t2-a-cd-r1 (in_progress)', details(st)['CI fleet quiet'])
        self.assertEqual(st['preflight'][-1]['facts']['ci_busy'], ['40120273200 trial/t2-a-cd-r1 (in_progress)'])

    def test_queued_ci_fails_the_quiet_fleet_check(self):
        busy = toolbox(self.rig, ci_queued=ci_reply((41, 'feat/x')))
        code, out, st = self.pre('A-cd-r1', runner=busy)
        self.assertEqual(code, 1, out)
        self.assertIn('41 feat/x (queued)', details(st)['CI fleet quiet'])

    def test_more_runs_than_one_page_are_counted_from_total_count(self):
        busy = toolbox(self.rig, ci_running=ci_reply((1, 'a'), total=57))
        code, out, st = self.pre('A-cd-r1', runner=busy)
        self.assertEqual(code, 1, out)
        self.assertIn('… 56 more in_progress', details(st)['CI fleet quiet'])

    def test_an_unreadable_runs_listing_leaves_the_quiet_fleet_check_unverified(self):
        for reply in (None, 'not json\n', '{"a": 1}\n', '{"total_count": "3"}\n', '[]\n'):
            with self.subTest(reply):
                code, out, st = self.pre('A-cd-r1', runner=toolbox(self.rig, ci_queued=reply))
                self.assertEqual(code, 2, out)
                self.assertStatus(statuses(st), 'CI fleet quiet', 'UNVERIFIED')

    def test_queued_runs_seen_before_an_unreadable_second_listing_are_a_fail(self):
        runner = toolbox(self.rig, ci_queued=ci_reply((41, 'feat/x')), ci_running=None)
        code, out, st = self.pre('A-cd-r1', runner=runner)
        self.assertEqual(code, 1, out)
        self.assertIn('41 feat/x (queued)', details(st)['CI fleet quiet'])
        self.assertIn('cannot list in_progress', details(st)['CI fleet quiet'])

    def test_each_run_adds_a_preflight_entry(self):
        self.pre('A-cd-r1')
        self.pre('A-cd-r1')
        self.assertEqual(len(self.rig.state('A-cd-r1')['preflight']), 2)

    def test_a_missing_effort_level_fails_the_october_run_3_case(self):
        self.rig.claude_settings(effort=None)
        code, out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'effort setting', 'FAIL')
        self.assertIn('is not set', details(st)['effort setting'])

    def test_a_wrong_effort_level_fails(self):
        self.rig.claude_settings(effort='medium')
        code, _out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'effort setting', 'FAIL')
        self.assertIn("'medium'", details(st)['effort setting'])

    def test_an_effort_level_set_for_another_model_does_not_count(self):
        self.rig.claude_settings(effort='high', model='claude-sonnet-5-5')
        _code, _out, st = self.pre('A-cd-r1')
        self.assertStatus(statuses(st), 'effort setting', 'FAIL')

    def test_a_missing_settings_file_fails_and_unreadable_json_is_unverified(self):
        os.remove(self.rig.home('.claude', 'settings.json'))
        code, _out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'effort setting', 'FAIL')
        self.rig.write_home('.claude/settings.json', '{not json')
        code, _out, st = self.pre('A-cd-r1')
        self.assertStatus(statuses(st), 'effort setting', 'UNVERIFIED')

    def test_an_old_claude_fails_and_an_unreadable_version_is_unverified(self):
        _c, _o, st = self.pre('A-cd-r1', toolbox(self.rig, claude='2.1.279 (Claude Code)\n'))
        self.assertStatus(statuses(st), 'claude version', 'FAIL')
        _c, _o, st = self.pre('A-cd-r1', toolbox(self.rig, claude='2.1.280\n'))
        self.assertStatus(statuses(st), 'claude version', 'PASS')
        _c, _o, st = self.pre('A-cd-r1', toolbox(self.rig, claude='dev build\n'))
        self.assertStatus(statuses(st), 'claude version', 'UNVERIFIED')
        _c, _o, st = self.pre('A-cd-r1', toolbox(self.rig, claude=None))
        self.assertStatus(statuses(st), 'claude version', 'UNVERIFIED')

    def test_a_dirty_clone_fails(self):
        with open(os.path.join(self.rig.clone_dir('A-cd-r1'), 'stray.txt'), 'w') as fh:
            fh.write('x')
        code, _out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'clone clean', 'FAIL')

    # -- `clone refs`: the clone knows no branch but its base (#8794)

    BASE = 'trial/t2-a-cd-r1'

    def in_clone(self, *args):
        return helpers.git(self.rig.clone_dir('A-cd-r1'), *args)

    def assertRefsFail(self, fragment):
        code, out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 1, out)
        self.assertStatus(statuses(st), 'clone refs', 'FAIL')
        detail = details(st)['clone refs']
        self.assertIn(fragment, detail)
        self.assertIn('remove the clone and run `trialctl clone A-cd-r1` again', detail)
        return detail

    def test_the_clone_made_by_trialctl_passes_the_refs_check(self):
        _code, _out, st = self.pre('A-cd-r1')
        self.assertStatus(statuses(st), 'clone refs', 'PASS')

    def test_another_remote_tracking_branch_fails_the_refs_check_and_names_it(self):
        self.in_clone('fetch', 'origin', 'main:refs/remotes/origin/main')
        detail = self.assertRefsFail('extra remote-tracking ref(s): refs/remotes/origin/main')
        self.assertNotIn(f'refs/remotes/origin/{self.BASE},', detail)

    def test_a_ref_of_another_remote_fails_the_refs_check(self):
        self.in_clone('update-ref', 'refs/remotes/upstream/main', 'HEAD')
        self.assertRefsFail('refs/remotes/upstream/main')

    def test_a_wider_fetch_refspec_fails_the_refs_check_and_shows_the_refspecs(self):
        self.in_clone('config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
        detail = self.assertRefsFail('remote.origin.fetch is')
        self.assertIn('+refs/heads/*:refs/remotes/origin/*', detail)

    def test_a_clone_with_no_fetch_refspec_fails_the_refs_check(self):
        self.in_clone('config', '--unset-all', 'remote.origin.fetch')
        self.assertRefsFail('remote.origin.fetch is []')

    def test_a_clone_that_lost_its_base_ref_fails_the_refs_check(self):
        self.in_clone('update-ref', '-d', f'refs/remotes/origin/{self.BASE}')
        self.assertRefsFail(f'refs/remotes/origin/{self.BASE} is not among the remote-tracking refs')

    def test_origin_head_is_fine_when_it_points_at_the_base_and_not_otherwise(self):
        self.in_clone('symbolic-ref', 'refs/remotes/origin/HEAD', f'refs/remotes/origin/{self.BASE}')
        _code, _out, st = self.pre('A-cd-r1')
        self.assertStatus(statuses(st), 'clone refs', 'PASS')
        self.in_clone('fetch', 'origin', 'main:refs/remotes/origin/main')
        self.in_clone('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
        self.assertRefsFail('refs/remotes/origin/HEAD -> refs/remotes/origin/main')

    def test_refs_or_a_refspec_that_cannot_be_read_leave_the_check_unverified(self):
        runner = toolbox(self.rig).on(argv_starts('git', 'for-each-ref'), 128, '', 'fatal: corrupt')
        code, out, st = self.pre('A-cd-r1', runner=runner)
        self.assertEqual(code, 2, out)
        self.assertStatus(statuses(st), 'clone refs', 'UNVERIFIED')
        self.assertIn('fatal: corrupt', details(st)['clone refs'])
        runner = toolbox(self.rig).on(argv_starts('git', 'config', '--get-all', 'remote.origin.fetch'), 128, '', 'fatal: bad config')
        code, out, st = self.pre('A-cd-r1', runner=runner)
        self.assertEqual(code, 2, out)
        self.assertStatus(statuses(st), 'clone refs', 'UNVERIFIED')
        self.assertIn('fatal: bad config', details(st)['clone refs'])

    def push_second_commit(self):
        d = self.rig.clone_dir('A-cd-r1')
        helpers.git(d, 'commit', '--allow-empty', '-m', 'an extra commit')
        helpers.git(d, 'push', 'origin', 'HEAD')

    def test_a_second_commit_over_t0_fails_the_base_shape(self):
        self.push_second_commit()
        code, out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'base shape', 'FAIL')
        self.assertIn('2 commits over T0', details(st)['base shape'])
        self.assertStatus(statuses(st), 'clone matches origin', 'PASS')

    def test_a_changed_path_besides_the_mission_fails_the_base_shape(self):
        d = self.rig.clone_dir('A-cd-r1')
        with open(os.path.join(d, 'extra.txt'), 'w') as fh:
            fh.write('x')
        helpers.git(d, 'add', '--', 'extra.txt')
        helpers.git(d, 'commit', '--amend', '--no-edit')
        helpers.git(d, 'push', '--force', 'origin', 'HEAD')
        _code, _out, st = self.pre('A-cd-r1')
        self.assertStatus(statuses(st), 'base shape', 'FAIL')
        self.assertIn('extra.txt', details(st)['base shape'])

    def test_a_local_commit_not_on_origin_fails_the_origin_match(self):
        d = self.rig.clone_dir('A-cd-r1')
        helpers.git(d, 'commit', '--allow-empty', '-m', 'local only')
        _code, _out, st = self.pre('A-cd-r1')
        self.assertStatus(statuses(st), 'clone matches origin', 'FAIL')
        self.assertStatus(statuses(st), 'base shape', 'FAIL')

    def test_a_branch_gone_from_origin_fails_the_origin_match(self):
        helpers.git(self.rig.origin, 'update-ref', '-d', 'refs/heads/trial/t2-a-cd-r1')
        _code, _out, st = self.pre('A-cd-r1')
        self.assertStatus(statuses(st), 'clone matches origin', 'FAIL')

    def test_a_mission_that_differs_from_the_rendered_one_fails_though_the_shape_is_right(self):
        d = self.rig.clone_dir('A-cd-r1')
        with open(os.path.join(d, self.rig.trial.mission_relpath(self.run_)), 'a') as fh:
            fh.write('an extra rule\n')
        helpers.git(d, 'commit', '--amend', '-a', '--no-edit')
        helpers.git(d, 'push', '--force', 'origin', 'HEAD')
        code, _out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'base shape', 'PASS')
        self.assertStatus(statuses(st), 'mission file', 'FAIL')

    def test_a_changed_identity_fails_and_a_missing_record_is_unverified(self):
        d = self.rig.clone_dir('A-cd-r1')
        helpers.git(d, 'config', 'user.email', 'daemon@example.com')
        _code, _out, st = self.pre('A-cd-r1')
        self.assertStatus(statuses(st), 'clone identity', 'FAIL')
        self.assertIn('daemon@example.com', details(st)['clone identity'])
        helpers.git(d, 'config', 'user.email', 'chris@example.com')
        data = self.rig.state('A-cd-r1')
        del data['clone']
        state.save(self.rig.trial, 'A-cd-r1', data, home=self.rig.box.home)
        _code, _out, st = self.pre('A-cd-r1')
        self.assertStatus(statuses(st), 'clone identity', 'UNVERIFIED')

    def test_the_wrong_node_fails_and_a_missing_node_is_unverified(self):
        code, _out, st = self.pre('A-cd-r1', toolbox(self.rig, node='v20.11.1\n'))
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'node version', 'FAIL')
        code, _out, st = self.pre('A-cd-r1', toolbox(self.rig, node=None))
        self.assertEqual(code, 2)
        self.assertStatus(statuses(st), 'node version', 'UNVERIFIED')

    def test_the_wrong_github_account_fails_and_an_unavailable_one_is_unverified(self):
        code, _out, st = self.pre('A-cd-r1', toolbox(self.rig, login='someone-else\n'))
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'gh login', 'FAIL')
        code, _out, st = self.pre('A-cd-r1', toolbox(self.rig, login=None))
        self.assertStatus(statuses(st), 'gh login', 'UNVERIFIED')

    def test_another_live_run_fails(self):
        self.rig.save_state('B-cx-r1', start={'sent_at': 'x'})
        code, _out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'no other run live', 'FAIL')
        self.assertIn('B-cx-r1', details(st)['no other run live'])

    def test_no_t0_leaves_the_base_shape_unverified(self):
        self.rig.trial.t0 = None
        code, _out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 2)
        self.assertStatus(statuses(st), 'base shape', 'UNVERIFIED')

    def test_a_t0_the_clone_does_not_contain_fails_the_base_shape(self):
        self.rig.trial.t0 = '1' * 40
        _code, _out, st = self.pre('A-cd-r1')
        self.assertStatus(statuses(st), 'base shape', 'FAIL')

    def test_a_missing_clone_fails_and_skips_the_checks_that_need_it(self):
        shutil.rmtree(self.rig.clone_dir('A-cd-r1'))
        code, out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'clone exists', 'FAIL')
        self.assertNotIn('base shape', statuses(st))
        self.assertIn('trialctl clone A-cd-r1', out)

    def test_an_origin_that_cannot_be_listed_leaves_the_origin_match_unverified(self):
        runner = toolbox(self.rig).on(argv_starts('git', 'ls-remote'), 128, '', 'network down')
        code, _out, st = self.pre('A-cd-r1', runner)
        self.assertEqual(code, 2)
        self.assertStatus(statuses(st), 'clone matches origin', 'UNVERIFIED')
        self.assertIn('cannot compare with origin', details(st)['clone matches origin'])
        self.assertIn('network down', details(st)['clone matches origin'])

    def test_a_status_that_cannot_be_read_leaves_the_clone_clean_check_unverified(self):
        runner = toolbox(self.rig).on(argv_starts('git', 'status', '--porcelain'), 128, '', 'fatal: index file corrupt')
        code, _out, st = self.pre('A-cd-r1', runner)
        self.assertEqual(code, 2)
        self.assertStatus(statuses(st), 'clone clean', 'UNVERIFIED')
        self.assertIn('index file corrupt', details(st)['clone clean'])

    def test_a_head_that_cannot_be_read_leaves_the_origin_match_unverified(self):
        runner = toolbox(self.rig).on(lambda a: a == ['git', 'rev-parse', 'HEAD'], 128, '', 'fatal: bad HEAD')
        code, _out, st = self.pre('A-cd-r1', runner)
        self.assertEqual(code, 2)
        self.assertStatus(statuses(st), 'clone matches origin', 'UNVERIFIED')
        self.assertIn('cannot compare with origin', details(st)['clone matches origin'])
        self.assertIsNone(st['preflight'][-1]['facts']['head'])

    def test_a_diff_against_t0_that_cannot_be_read_leaves_the_base_shape_unverified(self):
        runner = toolbox(self.rig).on(argv_starts('git', 'diff', '--name-only'), 128, '', 'fatal: bad revision')
        code, _out, st = self.pre('A-cd-r1', runner)
        self.assertEqual(code, 2)
        self.assertStatus(statuses(st), 'base shape', 'UNVERIFIED')
        self.assertIn('cannot diff against T0', details(st)['base shape'])
        self.assertIn('bad revision', details(st)['base shape'])
        self.assertStatus(statuses(st), 'clone matches origin', 'PASS')

    def test_a_mission_that_cannot_be_rendered_for_the_comparison_is_unverified(self):
        os.remove(self.rig.trial.repo_path('missions', 'TEMPLATE.md'))
        code, _out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 2)
        self.assertStatus(statuses(st), 'mission file', 'UNVERIFIED')
        self.assertIn('cannot render the mission to compare', details(st)['mission file'])
        self.assertIn('TEMPLATE.md', details(st)['mission file'])

    def test_a_mission_file_missing_from_the_clone_fails_the_mission_check(self):
        rel = self.rig.trial.mission_relpath(self.run_)
        os.remove(os.path.join(self.rig.clone_dir('A-cd-r1'), rel))
        code, _out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'mission file', 'FAIL')
        self.assertIn(f'{rel} is missing from the clone', details(st)['mission file'])
        self.assertStatus(statuses(st), 'base shape', 'PASS')

    def test_another_runs_unreadable_state_leaves_the_live_check_unverified(self):
        for how in ('corrupt', 'directory'):
            with self.subTest(how):
                undo = plant_unreadable_state(self.rig, 'B-cx-r1', how)
                code, _out, st = self.pre('A-cd-r1')
                undo()
                self.assertEqual(code, 2)
                self.assertStatus(statuses(st), 'no other run live', 'UNVERIFIED')
                self.assertIn('cannot read the other runs\' state files', details(st)['no other run live'])


class PreflightCodexNative(LaunchCase):
    def setUp(self):
        super().setUp()
        self.prep('B-cx-r1')

    def test_everything_correct_passes(self):
        code, out, st = self.pre('B-cx-r1')
        self.assertEqual(code, 0, out)
        self.assertEqual(statuses(st)['codex prompts'], 'PASS')
        self.assertEqual(statuses(st)['codex roster parity'], 'PASS')
        self.assertNotIn('effort setting', statuses(st))
        self.assertNotIn('daemon commit', statuses(st))
        facts = st['preflight'][-1]['facts']
        self.assertEqual((facts['codex_version'], facts['codex_app_version']), ('codex-cli 0.163.0', 'codex-cli 0.163.0'))

    def test_prompts_are_compiled_from_the_clone_into_a_scratch_home(self):
        runner = toolbox(self.rig)
        self.pre('B-cx-r1', runner)
        call = runner.ran('node', 'scripts/compile-skill-targets.mjs', '--targets', 'codex')[0]
        self.assertEqual(call['cwd'], self.rig.clone_dir('B-cx-r1'))
        self.assertNotEqual(call['env']['HOME'], self.rig.box.home)
        self.assertFalse(os.path.exists(call['env']['HOME']), 'the scratch home is removed')
        self.assertTrue(call['env']['PATH'].startswith('/opt/homebrew/opt/node@22/bin'))

    def test_a_prompt_that_differs_from_the_installed_one_fails_and_is_named(self):
        self.rig.write_home('.codex/prompts/prime-directive.md', 'an older compile\n')
        code, _out, st = self.pre('B-cx-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'codex prompts', 'FAIL')
        self.assertIn('prime-directive.md', details(st)['codex prompts'])
        self.assertNotIn('full-review.md', details(st)['codex prompts'])

    def test_a_prompt_missing_from_the_install_fails_and_is_named(self):
        os.remove(self.rig.home('.codex', 'prompts', 'full-review.md'))
        _code, _out, st = self.pre('B-cx-r1')
        self.assertStatus(statuses(st), 'codex prompts', 'FAIL')
        self.assertIn('missing', details(st)['codex prompts'])
        self.assertIn('full-review.md', details(st)['codex prompts'])

    def test_an_extra_installed_prompt_the_clone_does_not_compile_is_not_a_failure(self):
        self.rig.write_home('.codex/prompts/my-own.md', 'mine\n')
        _code, _out, st = self.pre('B-cx-r1')
        self.assertStatus(statuses(st), 'codex prompts', 'PASS')

    def test_a_compiler_that_writes_nothing_is_a_fail_not_a_vacuous_pass(self):
        _code, _out, st = self.pre('B-cx-r1', toolbox(self.rig, prompts={}))
        self.assertStatus(statuses(st), 'codex prompts', 'FAIL')
        self.assertIn('wrote no prompts', details(st)['codex prompts'])

    def test_a_compiler_that_fails_is_unverified(self):
        code, _out, st = self.pre('B-cx-r1', toolbox(self.rig, compile_rc=1))
        self.assertEqual(code, 2)
        self.assertStatus(statuses(st), 'codex prompts', 'UNVERIFIED')

    def test_a_cli_older_than_the_app_fails_the_roster_parity(self):
        code, _out, st = self.pre('B-cx-r1', toolbox(self.rig, codex='codex-cli 0.150.0\n'))
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'codex roster parity', 'FAIL')
        self.assertIn('0.150.0', details(st)['codex roster parity'])

    def test_an_app_cli_that_cannot_run_is_unverified(self):
        code, _out, st = self.pre('B-cx-r1', toolbox(self.rig, codex_app=None))
        self.assertEqual(code, 2)
        self.assertStatus(statuses(st), 'codex roster parity', 'UNVERIFIED')
        _code, _out, st = self.pre('B-cx-r1', toolbox(self.rig, codex=None))
        self.assertStatus(statuses(st), 'codex roster parity', 'UNVERIFIED')

    def test_an_installed_prompt_that_cannot_be_read_is_unverified_not_a_difference(self):
        installed = self.rig.home('.codex', 'prompts', 'full-review.md')
        os.remove(installed)
        os.makedirs(installed)  # a directory where the prompt file belongs: open() fails, but not with "not found"
        code, _out, st = self.pre('B-cx-r1')
        self.assertEqual(code, 2)
        self.assertStatus(statuses(st), 'codex prompts', 'UNVERIFIED')
        self.assertIn('cannot read ~/.codex/prompts/full-review.md', details(st)['codex prompts'])  # state stores ~ for the home
        self.assertNotIn('missing', details(st)['codex prompts'])

    def test_a_missing_clone_leaves_the_prompt_check_unverified(self):
        shutil.rmtree(self.rig.clone_dir('B-cx-r1'))
        runner = toolbox(self.rig)
        code, _out, st = self.pre('B-cx-r1', runner)
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'clone exists', 'FAIL')
        self.assertStatus(statuses(st), 'codex prompts', 'UNVERIFIED')
        self.assertIn('no clone to compile the prompts from', details(st)['codex prompts'])
        self.assertEqual(runner.ran('node', 'scripts/compile-skill-targets.mjs'), [], 'the compiler was not run')


class PreflightChroxy(LaunchCase):
    def test_claude_in_chroxy_passes_with_the_chroxy_checks(self):
        self.prep('A-cy-r1')
        code, out, st = self.pre('A-cy-r1')
        self.assertEqual(code, 0, out)
        for name in ('allowAutoPermissionMode', 'deploy agent unloaded', 'daemon commit', 'effort setting'):
            self.assertStatus(statuses(st), name, 'PASS')
        self.assertEqual(st['preflight'][-1]['facts']['daemon_commit'], SHA_D)

    def test_codex_in_chroxy_has_both_the_codex_and_the_chroxy_checks(self):
        self.prep('B-cy-r1')
        code, out, st = self.pre('B-cy-r1')
        self.assertEqual(code, 0, out)
        for name in ('codex prompts', 'codex roster parity', 'allowAutoPermissionMode', 'deploy agent unloaded', 'daemon commit'):
            self.assertStatus(statuses(st), name, 'PASS')

    def test_auto_not_allowed_in_the_daemon_config_fails(self):
        self.prep('A-cy-r1')
        self.rig.daemon_config(allow=False)
        code, _out, st = self.pre('A-cy-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'allowAutoPermissionMode', 'FAIL')
        os.remove(self.rig.home('.chroxy', 'config.json'))
        _code, _out, st = self.pre('A-cy-r1')
        self.assertStatus(statuses(st), 'allowAutoPermissionMode', 'FAIL')
        self.rig.write_home('.chroxy/config.json', '{oops')
        _code, _out, st = self.pre('A-cy-r1')
        self.assertStatus(statuses(st), 'allowAutoPermissionMode', 'UNVERIFIED')

    def test_a_loaded_deploy_agent_fails(self):
        self.prep('A-cy-r1')
        listing = 'PID\tStatus\tLabel\n-\t0\tcom.chroxy.deploy\n'
        code, _out, st = self.pre('A-cy-r1', toolbox(self.rig, launchctl=listing))
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'deploy agent unloaded', 'FAIL')
        self.assertIn('launchctl bootout', details(st)['deploy agent unloaded'])

    def test_launchctl_off_macos_or_failing_is_unverified(self):
        self.prep('A-cy-r1')
        code, _out, st = self.pre('A-cy-r1', system='Linux')
        self.assertEqual(code, 2)
        self.assertStatus(statuses(st), 'deploy agent unloaded', 'UNVERIFIED')
        _code, _out, st = self.pre('A-cy-r1', toolbox(self.rig, launchctl=None))
        self.assertStatus(statuses(st), 'deploy agent unloaded', 'UNVERIFIED')

    def other_run_recorded(self, commit):
        self.rig.save_state('B-cy-r1', gate=passing_gate(self.rig), preflight=[{'phase': 'pre', 'at': 'x', 'checks': [], 'facts': {'daemon_commit': commit}}])

    def test_a_daemon_commit_different_from_another_runs_fails(self):
        self.prep('A-cy-r1')
        self.other_run_recorded('e' * 40)
        code, _out, st = self.pre('A-cy-r1')
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st), 'daemon commit', 'FAIL')
        self.assertIn('B-cy-r1 recorded eeeeeeeeeeee', details(st)['daemon commit'])

    def test_the_same_daemon_commit_as_another_run_passes(self):
        self.prep('A-cy-r1')
        self.other_run_recorded(SHA_D)
        code, out, st = self.pre('A-cy-r1')
        self.assertEqual(code, 0, out)
        self.assertIn('same as B-cy-r1', details(st)['daemon commit'])

    def test_an_unreadable_daemon_checkout_is_unverified(self):
        self.prep('A-cy-r1')
        _code, _out, st = self.pre('A-cy-r1', toolbox(self.rig, daemon=None))
        self.assertStatus(statuses(st), 'daemon commit', 'UNVERIFIED')

    def test_an_unreadable_state_of_another_run_makes_the_commit_check_unverified(self):
        self.prep('A-cy-r1')
        self.rig.save_state('B-cy-r1')
        with open(state.state_path(self.rig.trial, 'B-cy-r1', home=self.rig.box.home), 'w') as fh:
            fh.write('{truncated')
        _code, _out, st = self.pre('A-cy-r1')
        self.assertStatus(statuses(st), 'daemon commit', 'UNVERIFIED')

    def test_native_runs_skip_the_chroxy_checks(self):
        self.prep('A-cd-r1')
        _code, _out, st = self.pre('A-cd-r1')
        self.assertNotIn('daemon commit', statuses(st))
        self.assertNotIn('deploy agent unloaded', statuses(st))


# -- preflight, session phase --------------------------------------------------------

class PreflightSession(LaunchCase):
    LOG = ('2026-11-02T11:59:00.000Z [INFO] [ws] Model change from c1 on session s-1: opus\n'
           '2026-11-02T11:59:30.000Z [INFO] [ws] Permission mode change from c1 on session s-1: default → auto at 2026-11-02T11:59:30.000Z\n')

    def go(self, rid='A-cy-r1', log=LOG, session='s-1'):
        if log is not None:
            self.rig.write_home('.chroxy/logs/chroxy.log', log)
        return self.pre(rid, phase='session', session=session)

    def test_correct_model_mode_and_no_interrupt_pass(self):
        code, out, st = self.go()
        self.assertEqual(code, 0, out)
        self.assertEqual(statuses(st, 'session'), {'session model': 'PASS', 'session permission mode': 'PASS', 'session interrupt': 'PASS'})
        self.assertEqual(st['preflight'][-1]['facts']['model'], 'opus')

    def test_the_default_model_instead_of_the_alias_fails(self):
        code, out, st = self.go(log=self.LOG.replace(': opus', ': sonnet'))
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st, 'session'), 'session model', 'FAIL')

    def test_only_the_last_model_change_counts(self):
        log = self.LOG.replace(': opus', ': sonnet') + '2026-11-02T11:59:40.000Z [INFO] [ws] Model change from c1 on session s-1: claude-opus-5-5\n'
        code, out, _ = self.go(log=log)
        self.assertEqual(code, 0, out)

    def test_another_sessions_lines_are_ignored(self):
        log = self.LOG + '2026-11-02T11:59:45.000Z [INFO] [ws] Model change from c1 on session s-2: haiku\n'
        code, out, _ = self.go(log=log)
        self.assertEqual(code, 0, out)

    def test_a_permission_mode_other_than_auto_fails(self):
        _code, _out, st = self.go(log=self.LOG.replace('→ auto', '→ acceptEdits'))
        self.assertStatus(statuses(st, 'session'), 'session permission mode', 'FAIL')

    def test_an_interrupt_line_for_the_session_fails(self):
        log = self.LOG + '2026-11-02T11:59:50.000Z [INFO] [ws] Interrupt from c1 to session s-1\n'
        code, out, st = self.go(log=log)
        self.assertEqual(code, 1)
        self.assertStatus(statuses(st, 'session'), 'session interrupt', 'FAIL')
        self.assertIn('11:59:50', details(st, 'session')['session interrupt'])

    def test_an_interrupt_of_another_session_does_not_fail_this_one(self):
        log = self.LOG + '2026-11-02T11:59:50.000Z [INFO] [ws] Interrupt from c1 to session s-2\n'
        code, out, _ = self.go(log=log)
        self.assertEqual(code, 0, out)

    def test_the_json_log_format_is_read_the_same_way(self):
        def rec(ts, msg):
            return json.dumps({'ts': ts, 'level': 'info', 'component': 'ws', 'msg': msg}, ensure_ascii=False)
        log = '\n'.join([rec('t1', 'Model change from c1 on session s-1: opus'),
                         rec('t2', 'Permission mode change from c1 on session s-1: default → auto at x'),
                         rec('t3', 'Interrupt from c1 to session s-1')]) + '\n'
        code, _out, st = self.go(log=log)
        self.assertEqual(code, 1)
        self.assertEqual(statuses(st, 'session'), {'session model': 'PASS', 'session permission mode': 'PASS', 'session interrupt': 'FAIL'})

    def test_no_model_or_mode_line_is_unverified_not_a_pass(self):
        code, _out, st = self.go(log='2026-11-02T11:59:00.000Z [INFO] [supervisor] Server ready\n')
        self.assertEqual(code, 2)
        self.assertEqual(statuses(st, 'session'), {'session model': 'UNVERIFIED', 'session permission mode': 'UNVERIFIED', 'session interrupt': 'PASS'})

    def test_a_missing_log_is_unverified_throughout(self):
        code, _out, st = self.go(log=None)
        self.assertEqual(code, 2)
        self.assertEqual(set(statuses(st, 'session').values()), {'UNVERIFIED'})

    def test_it_needs_a_session_id(self):
        code, out, st = self.go(session=None)
        self.assertEqual(code, 2)
        self.assertIn('--session', out)
        self.assertNotIn('preflight', st)

    def test_it_applies_only_to_chroxy_runs(self):
        code, out, st = self.go(rid='A-cd-r1')
        self.assertEqual(code, 2)
        self.assertIn('not a Chroxy run', out)
        self.assertNotIn('preflight', st)

    def test_the_codex_in_chroxy_model_alias(self):
        log = self.LOG.replace(': opus', ': gpt-6-astra')
        code, out, _ = self.go(rid='B-cy-r1', log=log)
        self.assertEqual(code, 0, out)
        code, out, _ = self.go(rid='B-cy-r1', log=self.LOG)
        self.assertEqual(code, 1)


# -- prepare -----------------------------------------------------------------------

class Prepare(LaunchCase):
    def go(self, rid='A-cd-r1', gh=None, runner=None, accept_changed=None):
        env = self.rig.env(runner or toolbox(self.rig), github=gh or FakeGitHub())
        code = launch.prepare(self.rig.trial, self.rig.run(rid), env, {}, True, None, accept_changed=accept_changed)
        return code, env.out.getvalue(), env

    def test_queue_text_edited_since_t0_stops_before_the_clone_unless_the_change_is_accepted(self):
        self.rig.cut('A-cd-r1')
        self.rig.claude_settings()
        edited = FakeGitHub(bodies={9001: 'edited since T0'})
        runner = toolbox(self.rig)
        code, out, _ = self.go(gh=edited, runner=runner)
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'FAIL\s+queue text Q01 #9001')
        self.assertEqual(runner.ran('git', 'clone'), [], 'the gate stopped it before the clone')
        self.assertNotIn('LAUNCH CARD', out)
        code, out, _ = self.go(gh=edited, accept_changed={'Q01': 'a typo fix'})
        self.assertEqual(code, 0, out)
        self.assertIn('LAUNCH CARD A-cd-r1', out)
        self.assertEqual([o['kind'] for o in self.rig.state('A-cd-r1')['overrides']], ['accept-changed'])

    def test_gate_clone_preflight_then_the_launch_card(self):
        self.rig.cut('A-cd-r1')
        self.rig.claude_settings()
        code, out, env = self.go()
        self.assertEqual(code, 0, out)
        run = self.rig.run('A-cd-r1')
        self.assertIn('LAUNCH CARD A-cd-r1', out)
        self.assertIn(render.invocation(self.rig.trial, run).splitlines()[0], out)
        self.assertIn(f'{run.model} / {run.effort}', out)
        self.assertIn(run.base, out)
        self.assertIn(self.rig.clone_dir('A-cd-r1'), out)
        self.assertIn('trialctl start A-cd-r1 --meter claude_5h_used=<percent> --meter claude_weekly_used=<percent>', out)
        self.assertIn('trialctl verify-start A-cd-r1', out)
        self.assertIn('dependencies NOT installed', out)
        st = self.rig.state('A-cd-r1')
        self.assertTrue(st['gate'] and st['clone'] and st['preflight'])

    def test_a_chroxy_card_also_names_the_session_phase_and_codex_asks_for_its_meter(self):
        self.rig.cut('B-cy-r1')
        self.rig.install_prompts()
        self.rig.daemon_config()
        code, out, _ = self.go('B-cy-r1')
        self.assertEqual(code, 0, out)
        self.assertIn('trialctl preflight B-cy-r1 --phase session --session <the new session', out)
        self.assertIn('--meter codex_weekly_left=<percent>', out)

    def test_a_failed_gate_stops_before_the_clone(self):
        self.rig.cut('B-cy-r1')
        runner = toolbox(self.rig)
        code, out, _ = self.go('B-cy-r1', gh=FakeGitHub(issues={8710: 'open'}), runner=runner)
        self.assertEqual(code, 1)
        self.assertEqual(runner.ran('git', 'clone'), [])
        self.assertFalse(os.path.exists(self.rig.clone_dir('B-cy-r1')))
        self.assertNotIn('LAUNCH CARD', out)

    def test_a_failed_preflight_prints_no_launch_card(self):
        self.rig.cut('A-cd-r1')
        code, out, _ = self.go()  # no ~/.claude/settings.json: the effort setting fails
        self.assertEqual(code, 1)
        self.assertNotIn('LAUNCH CARD', out)
        self.assertIn('NOT READY', out)

    def test_unverified_checks_give_exit_2_with_a_card_and_a_warning(self):
        self.rig.cut('A-cd-r1')
        self.rig.claude_settings()
        code, out, _ = self.go(runner=toolbox(self.rig, claude=None))
        self.assertEqual(code, 2)
        self.assertIn('LAUNCH CARD', out)
        self.assertIn('NOT FULLY VERIFIED', out)

    def test_an_existing_clone_in_state_is_not_cloned_again(self):
        self.rig.cut('A-cd-r1')
        self.rig.claude_settings()
        self.go()
        runner = toolbox(self.rig)
        code, out, _ = self.go(runner=runner)
        self.assertEqual(code, 0, out)
        self.assertEqual(runner.ran('git', 'clone'), [])
        self.assertIn('already present', out)


# -- start -------------------------------------------------------------------------

def passing_preflight():
    return [{'phase': 'pre', 'at': '2026-11-02T11:30:00Z', 'checks': [{'name': 'a', 'status': 'PASS', 'detail': ''}], 'facts': {}}]


def passing_gate(rig, at='2026-11-02T11:00:00Z'):
    return {'at': at, 't0': rig.t0, 'checks': [{'name': 'g', 'status': 'PASS', 'detail': ''}], 'accepted_open': {}}


class Start(LaunchCase):
    CLAUDE_OK = {'claude_5h_used': 5.0, 'claude_weekly_used': 30.0}

    def go(self, rid='A-cd-r1', meters=None, override=None, sent_at=None):
        env = self.rig.env()
        code = launch.start(self.rig.trial, self.rig.run(rid), env, meters if meters is not None else self.CLAUDE_OK,
                            override, sent_at, None)
        return code, env.out.getvalue()

    def test_records_the_send_and_the_readings(self):
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        code, out = self.go()
        self.assertEqual(code, 0, out)
        self.assertIn('send the invocation now', out)
        self.assertEqual(self.rig.state('A-cd-r1')['start'],
                         {'sent_at': '2026-11-02T12:00:00Z', 'meters': self.CLAUDE_OK, 'override': None,
                          'claude_settings_sha256': None})

    def test_a_given_send_time_is_normalised_and_a_bad_one_is_refused(self):
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        code, _out = self.go(sent_at='2026-11-02T11:58:30+00:00')
        self.assertEqual(code, 0)
        self.assertEqual(self.rig.state('A-cd-r1')['start']['sent_at'], '2026-11-02T11:58:30Z')
        code, out = self.go(sent_at='lunchtime')
        self.assertEqual(code, 2)

    def test_refuses_without_a_preflight_and_with_a_failed_one(self):
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('no pre-send preflight', out)
        self.assertNotIn('start', self.rig.state('A-cd-r1'))
        bad = passing_preflight()
        bad[0]['checks'].append({'name': 'effort setting', 'status': 'FAIL', 'detail': ''})
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=bad)
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('effort setting FAIL', out)

    def test_an_unverified_preflight_is_not_a_passed_one(self):
        pre = passing_preflight()
        pre[0]['checks'].append({'name': 'node version', 'status': 'UNVERIFIED', 'detail': ''})
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=pre)
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('node version UNVERIFIED', out)

    def test_only_the_latest_pre_preflight_counts_and_a_session_phase_is_not_one(self):
        bad = passing_preflight()[0]
        bad['checks'][0]['status'] = 'FAIL'
        later_pass = dict(passing_preflight()[0], at='2026-11-02T11:45:00Z')
        session = {'phase': 'session', 'at': 'y', 'checks': [{'name': 's', 'status': 'FAIL', 'detail': ''}], 'facts': {}}
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=[bad, later_pass, session])
        code, out = self.go()
        self.assertEqual(code, 0, out)

    def test_an_override_goes_past_a_failed_preflight_and_is_recorded(self):
        bad = passing_preflight()
        bad[0]['checks'][0]['status'] = 'FAIL'
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=bad)
        code, out = self.go(override='owner checked it by hand')
        self.assertEqual(code, 0, out)
        st = self.rig.state('A-cd-r1')
        self.assertEqual(st['start']['override'], 'owner checked it by hand')
        self.assertEqual(st['overrides'][-1]['kind'], 'start')
        self.assertIn('did not pass', st['overrides'][-1]['bypassed'][0])

    def test_a_codex_run_at_60_percent_is_refused_and_at_100_is_started(self):
        self.rig.save_state('B-cx-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        code, out = self.go('B-cx-r1', {'codex_weekly_left': 60.0})
        self.assertEqual(code, 1)
        self.assertIn('codex_weekly_left is 60, below the floor of 100', out)
        self.assertNotIn('start', self.rig.state('B-cx-r1'))
        code, out = self.go('B-cx-r1', {'codex_weekly_left': 99.9})
        self.assertEqual(code, 1)
        code, out = self.go('B-cx-r1', {'codex_weekly_left': 100.0})
        self.assertEqual(code, 0, out)
        self.assertEqual(self.rig.state('B-cx-r1')['start']['meters'], {'codex_weekly_left': 100.0})

    def test_the_override_lets_a_low_allowance_through_and_says_what_it_bypassed(self):
        self.rig.save_state('B-cx-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        code, out = self.go('B-cx-r1', {'codex_weekly_left': 60.0}, override='owner applied a reset')
        self.assertEqual(code, 0, out)
        recorded = self.rig.state('B-cx-r1')['overrides'][-1]
        self.assertEqual(recorded['reason'], 'owner applied a reset')
        self.assertIn('codex_weekly_left is 60', recorded['bypassed'][0])

    def test_claude_meters_above_the_ceilings_are_refused(self):
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        code, out = self.go(meters={'claude_5h_used': 25.0, 'claude_weekly_used': 30.0})
        self.assertEqual(code, 1)
        self.assertIn('claude_5h_used is 25, above the ceiling of 20', out)
        code, out = self.go(meters={'claude_5h_used': 5.0, 'claude_weekly_used': 71.0})
        self.assertEqual(code, 1)
        self.assertIn('claude_weekly_used', out)
        code, _ = self.go(meters={'claude_5h_used': 20.0, 'claude_weekly_used': 70.0})
        self.assertEqual(code, 0)

    def test_missing_meters_exit_2_and_name_the_flags_to_pass(self):
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        code, out = self.go(meters={'claude_5h_used': 5.0})
        self.assertEqual(code, 2)
        self.assertIn('--meter claude_weekly_used=<percent>', out)
        self.assertNotIn('--meter claude_5h_used', out)
        code, out = self.go('B-cx-r1', meters={})
        self.assertEqual(code, 2)
        self.assertIn('--meter codex_weekly_left=<percent>', out)
        self.assertNotIn('start', self.rig.state('A-cd-r1'))

    def test_the_override_cannot_stand_in_for_a_reading(self):
        code, _out = self.go(meters={}, override='no time')
        self.assertEqual(code, 2)

    def test_a_reading_outside_0_to_100_is_refused(self):
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        code, out = self.go(meters={'claude_5h_used': 600.0, 'claude_weekly_used': 30.0})
        self.assertEqual(code, 2)

    def test_another_live_run_refuses_even_with_an_override(self):
        self.rig.save_state('B-cx-r1', start={'sent_at': 'x'})
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        code, out = self.go(override='please')
        self.assertEqual(code, 1)
        self.assertIn('B-cx-r1', out)

    def test_a_second_start_is_refused_unless_overridden(self):
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        self.go()
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('already recorded', out)
        code, out = self.go(override='typed the wrong reading', sent_at='2026-11-02T12:01:00Z')
        self.assertEqual(code, 0, out)
        start = self.rig.state('A-cd-r1')['start']
        self.assertEqual((start['sent_at'], start['replaces']['sent_at']), ('2026-11-02T12:01:00Z', '2026-11-02T12:00:00Z'))

    def test_start_reads_the_gate_not_only_prepare(self):
        # Running clone, preflight and start by hand must not skip the entry gate.
        self.rig.save_state('A-cd-r1', preflight=passing_preflight())
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('no entry gate is recorded', out)
        failed = passing_gate(self.rig)
        failed['checks'].append({'name': 'blocker #8741', 'status': 'FAIL', 'detail': 'open'})
        self.rig.save_state('A-cd-r1', gate=failed, preflight=passing_preflight())
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('blocker #8741 FAIL', out)
        unverified = passing_gate(self.rig)
        unverified['checks'].append({'name': 'ci.yml runs on the base', 'status': 'UNVERIFIED', 'detail': ''})
        self.rig.save_state('A-cd-r1', gate=unverified, preflight=passing_preflight())
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('ci.yml runs on the base UNVERIFIED', out)

    def test_a_gate_that_saw_the_queue_text_change_does_not_let_a_run_start(self):
        env = self.rig.env(github=FakeGitHub(bodies={9002: 'edited since T0'}))
        self.assertEqual(launch.gate(self.rig.trial, self.rig.run('A-cd-r1'), env, {}, None), 1)
        st = self.rig.state('A-cd-r1')
        self.rig.save_state('A-cd-r1', gate=st['gate'], preflight=[dict(passing_preflight()[0], at='2026-11-02T12:30:00Z')])
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('queue text Q02 #9002 FAIL', out)
        self.assertNotIn('start', self.rig.state('A-cd-r1'))

    def test_a_gate_recorded_at_another_t0_or_after_the_preflight_does_not_count(self):
        stale = dict(passing_gate(self.rig), t0='f' * 40)
        self.rig.save_state('A-cd-r1', gate=stale, preflight=passing_preflight())
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('not the current', out)
        late = passing_gate(self.rig, at='2026-11-02T11:45:00Z')  # the preflight is 11:30
        self.rig.save_state('A-cd-r1', gate=late, preflight=passing_preflight())
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('older than the gate', out)

    def order(self, rid, gate_at, pre_at, session_at=None):
        """Start `rid` from a passing gate, preflight and (when given) session phase recorded at those times."""
        preflight = [dict(passing_preflight()[0], at=pre_at)]
        if session_at is not None:
            preflight.append({'phase': 'session', 'at': session_at, 'facts': {}, 'checks': [{'name': 's', 'status': 'PASS', 'detail': ''}]})
        self.rig.save_state(rid, gate=passing_gate(self.rig, at=gate_at), preflight=preflight)
        return self.go(rid, {'codex_weekly_left': 100.0} if session_at is not None else None)

    def test_the_preflight_is_placed_after_the_gate_as_a_moment_not_as_text(self):
        # `timeutil.iso` drops a zero fraction, and `Z` sorts above `.`: as text, half a second after is older (#8805).
        for gate_at, pre_at, after in (('2026-11-02T11:00:00Z', '2026-11-02T11:00:00.500Z', True),
                                       ('2026-11-02T11:00:00Z', '2026-11-02T10:59:59.500Z', False),
                                       ('2026-11-02T11:00:00.500Z', '2026-11-02T11:00:00Z', False),
                                       ('2026-11-02T11:00:00Z', '2026-11-02T11:00:00+00:00', True)):
            with self.subTest(gate=gate_at, preflight=pre_at):
                code, out = self.order('A-cd-r1', gate_at, pre_at)
                said = 'the latest preflight is older than the gate; run `trialctl preflight` again'
                self.assertEqual((code, said in out), (0, False) if after else (1, True), out)

    def test_the_session_phase_is_placed_after_the_preflight_as_a_moment_not_as_text(self):
        for pre_at, session_at, after in (('2026-11-02T11:30:00Z', '2026-11-02T11:30:00.500Z', True),
                                          ('2026-11-02T11:30:00Z', '2026-11-02T11:29:59.500Z', False),
                                          ('2026-11-02T11:30:00.500Z', '2026-11-02T11:30:00Z', False)):
            with self.subTest(preflight=pre_at, session=session_at):
                code, out = self.order('B-cy-r1', '2026-11-02T11:00:00Z', pre_at, session_at)
                said = 'the session-phase preflight is older than the pre-send preflight; run it again'
                self.assertEqual((code, said in out), (0, False) if after else (1, True), out)

    def test_a_step_time_that_cannot_be_read_is_reported_not_taken_as_in_order(self):
        for gate_at, pre_at, session_at, said in (
                ('2026-11-02T11:00:00Z', 'soon', None, "the latest preflight's time ('soon') cannot be read, so it cannot be placed after the gate; "
                                                       "run `trialctl preflight` again"),
                ('x', '2026-11-02T11:30:00Z', None, "the gate's time ('x') cannot be read, so the latest preflight cannot be placed after it; "
                                                    "run `trialctl gate`, then `trialctl preflight`, again"),
                ('2026-11-02T11:00:00Z', '2026-11-02T11:30:00Z', '',
                 "the session-phase preflight's time ('') cannot be read, so it cannot be placed after the pre-send preflight; run it again"),
                ('2026-11-02T11:00:00Z', '2026-11-02T25:00:00Z', '2026-11-02T11:40:00Z',
                 "the pre-send preflight's time ('2026-11-02T25:00:00Z') cannot be read, so the session-phase preflight cannot be placed after it; "
                 "run `trialctl preflight`, then the session phase, again")):
            with self.subTest(gate=gate_at, preflight=pre_at, session=session_at):
                code, out = self.order('B-cy-r1' if session_at is not None else 'A-cd-r1', gate_at, pre_at, session_at)
                self.assertEqual(code, 1, out)
                self.assertIn(said, out)
                self.assertNotIn('start', self.rig.state('B-cy-r1' if session_at is not None else 'A-cd-r1'))

    def test_a_chroxy_run_needs_a_passing_session_phase_after_the_preflight(self):
        meters = {'codex_weekly_left': 100.0}
        self.rig.save_state('B-cy-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        code, out = self.go('B-cy-r1', meters)
        self.assertEqual(code, 1)
        self.assertIn('no session-phase preflight', out)
        session = {'phase': 'session', 'at': '2026-11-02T11:40:00Z', 'facts': {},
                   'checks': [{'name': 'no interrupt', 'status': 'FAIL', 'detail': ''}]}
        self.rig.save_state('B-cy-r1', gate=passing_gate(self.rig), preflight=passing_preflight() + [session])
        code, out = self.go('B-cy-r1', meters)
        self.assertEqual(code, 1)
        self.assertIn('no interrupt FAIL', out)
        early = dict(session, at='2026-11-02T11:20:00Z', checks=[{'name': 's', 'status': 'PASS', 'detail': ''}])
        self.rig.save_state('B-cy-r1', gate=passing_gate(self.rig), preflight=passing_preflight() + [early])
        code, out = self.go('B-cy-r1', meters)
        self.assertEqual(code, 1)
        self.assertIn('session-phase preflight is older', out)
        good = dict(session, checks=[{'name': 's', 'status': 'PASS', 'detail': ''}])
        self.rig.save_state('B-cy-r1', gate=passing_gate(self.rig), preflight=passing_preflight() + [good])
        code, out = self.go('B-cy-r1', meters)
        self.assertEqual(code, 0, out)

    def test_a_finished_run_cannot_be_started_again_even_with_an_override(self):
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=passing_preflight(),
                            start={'sent_at': '2026-11-02T08:00:00Z'}, finish={'ended_at': '2026-11-02T10:00:00Z'})
        code, out = self.go(override='repeat it')
        self.assertEqual(code, 1)
        self.assertIn('already finished', out)
        self.assertEqual(self.rig.state('A-cd-r1')['start'], {'sent_at': '2026-11-02T08:00:00Z'})

    def test_the_settings_baseline_is_taken_at_the_send(self):
        settings = self.rig.claude_settings('high')
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        self.assertEqual(self.go()[0], 0)
        with open(settings, 'a') as fh:
            fh.write('\n')  # a preview daemon touched it during the run
        st = self.rig.state('A-cd-r1')
        # A later preflight re-run records the changed file as its fact; the baseline must not move with it.
        st['preflight'].append({'phase': 'pre', 'at': '2026-11-02T13:00:00Z', 'checks': [],
                                'facts': {'claude_settings_sha256': launch._sha256(settings)}})
        self.rig.save_state('A-cd-r1', **{k: v for k, v in st.items() if k not in ('run', 'trial', 'updated_at')})
        env = self.rig.env()
        launch.finish(self.rig.trial, self.rig.run('A-cd-r1'), env, {}, None, None, None, None)
        self.assertTrue(self.rig.state('A-cd-r1')['finish']['settings_changed'], env.out.getvalue())

    def test_unreadable_other_state_refuses_rather_than_crashes(self):
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        other = state.state_path(self.rig.trial, 'B-cx-r1', home=self.rig.box.home)
        with open(other, 'w') as fh:
            fh.write('{not json')
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('an overlap cannot be ruled out', out)

    def test_an_allowance_floor_missing_from_trial_json_blocks_rather_than_passes(self):
        self.rig.save_state('A-cd-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        del self.rig.trial.allowance['claude_5h_used_max']
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('allowance.claude_5h_used_max is not set', out)


# -- verify-start ------------------------------------------------------------------

SENT = helpers.FIXED_NOW  # 2026-11-02T12:00:00Z
OK_MTIME = SENT + timedelta(minutes=1)


def claude_transcript(rid='A-cd-r1', model=OPUS, effort='high', mode='auto', entrypoint='claude-desktop',
                      probe=True, probe_effort='high', probe_run=None, extra=()):
    entries = [user(f'/prime-directive "Trial run {rid}: follow m.md exactly"', permissionMode=mode, entrypoint=entrypoint, version='2.1.308'),
               assistant(model=model, effort=effort, entrypoint=entrypoint, version='2.1.308')]
    if probe:
        line = (f'TRIAL-PROBE run={probe_run or rid} effort={probe_effort} entrypoint={entrypoint} '
                f'app=1.4.2 at=2026-11-02T12:00:05Z')
        entries += [tool_result(line), assistant(model=model, effort=effort, ts='2026-11-02T12:00:09Z')]
    return entries + list(extra)


def codex_rollout(clone, rid='B-cx-r1', model=ASTRA, effort='xhigh', sandbox='workspace-write', probe=True, extra=()):
    entries = [meta(cwd=clone), turn(model=model, effort=effort, sandbox=sandbox)]
    if probe:
        entries.append({'type': 'response_item', 'payload': {
            'output': f'TRIAL-PROBE run={rid} effort={effort} entrypoint=unset app=unset at=2026-11-02T12:00:04Z'}})
    return entries + list(extra)


class VerifyStart(LaunchCase):
    def started(self, rid, sent=SENT, **extra):
        self.rig.save_state(rid, start={'sent_at': timeutil.iso(sent), 'meters': {}, 'override': None}, **extra)

    def put_claude(self, rid, entries, mtime=OK_MTIME, name='sess.jsonl'):
        folder = native.slug(os.path.abspath(self.rig.clone_dir(rid)))
        path = self.rig.home('.claude', 'projects', folder, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as fh:
            fh.write(jl(*entries))
        os.utime(path, (mtime.timestamp(), mtime.timestamp()))
        return path

    def put_codex(self, rid, entries, mtime=OK_MTIME, name='rollout-2026-11-02T12-00-00-aaa.jsonl'):
        path = self.rig.home('.codex', 'sessions', '2026', '11', '02', name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as fh:
            fh.write(jl(*entries))
        os.utime(path, (mtime.timestamp(), mtime.timestamp()))
        return path

    def go(self, rid, since=None):
        env = self.rig.env()
        code = launch.verify_start(self.rig.trial, self.rig.run(rid), env, since, None)
        return code, env.out.getvalue(), self.rig.state(rid).get('verify_start')

    def by_name(self, saved):
        return {c['name']: c for c in saved['checks']}

    # claude family
    def test_a_correct_claude_session_passes_and_is_recorded(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript())
        code, out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 0, out)
        self.assertNotIn('STOP', out)
        self.assertEqual(set(c['status'] for c in saved['checks']), {'PASS'})
        self.assertEqual(saved['applied']['model'], [OPUS])
        self.assertEqual(saved['applied']['effort'], ['high'])
        self.assertEqual(saved['applied']['permission_mode'], ['auto'])
        self.assertEqual(saved['applied']['entrypoint'], ['claude-desktop'])
        self.assertEqual(saved['transcript'], native.slug(os.path.abspath(self.rig.clone_dir('A-cd-r1'))) + '/sess.jsonl')
        self.assertEqual(saved['first_command_at'], '2026-11-02T12:00:05Z')
        self.assertEqual(saved['at'], '2026-11-02T12:00:00Z')

    def test_a_sonnet_transcript_for_an_opus_run_stops_the_run_october_run_5(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript(model='claude-sonnet-5-5'))
        code, out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertEqual(self.by_name(saved)['model']['status'], 'FAIL')
        stop = [line for line in out.splitlines() if line.startswith('STOP:')]
        self.assertEqual(len(stop), 1, out)
        self.assertIn('model: observed claude-sonnet-5-5, expected claude-opus-5-5', stop[0])

    def test_a_medium_effort_for_a_high_run_stops_the_run(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript(effort='medium', probe_effort='medium'))
        code, out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertEqual(self.by_name(saved)['effort']['status'], 'FAIL')
        self.assertRegex(out, r'(?m)^STOP: .*effort: observed medium, expected high')

    def test_an_effort_that_changes_mid_session_fails(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript(extra=[assistant(effort='low', ts='2026-11-02T12:05:00Z')]))
        code, _out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertIn('high, low', self.by_name(saved)['effort']['detail'])

    def test_a_transcript_with_neither_effort_nor_probe_is_unverified_and_no_stop(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript(effort=None, probe=False))
        code, out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 2)
        by = self.by_name(saved)
        self.assertEqual((by['effort']['status'], by['probe']['status'], by['model']['status']), ('UNVERIFIED', 'UNVERIFIED', 'PASS'))
        self.assertNotIn('STOP', out)

    def test_effort_falls_back_to_the_probe_when_entries_carry_none(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript(effort=None, probe_effort='high'))
        code, _out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 0)
        self.assertEqual(saved['applied']['effort_source'], 'the TRIAL-PROBE line')
        self.put_claude('A-cd-r1', claude_transcript(effort=None, probe_effort='medium'))
        code, out, _ = self.go('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertIn('STOP:', out)
        self.put_claude('A-cd-r1', claude_transcript(effort=None, probe_effort='unset'))
        code, out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 2)
        self.assertEqual(self.by_name(saved)['effort']['status'], 'UNVERIFIED')

    def test_a_permission_mode_other_than_auto_fails_and_an_unseen_one_is_unverified(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript(mode='default'))
        code, out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertEqual(self.by_name(saved)['permission mode']['status'], 'FAIL')
        entries = claude_transcript()
        for e in entries:
            e.pop('permissionMode', None)
        self.put_claude('A-cd-r1', entries)
        code, _out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 2)
        self.assertEqual(self.by_name(saved)['permission mode']['status'], 'UNVERIFIED')

    def test_the_wrong_entrypoint_fails_for_the_desktop_app(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript(entrypoint='cli'))
        code, _out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertEqual(self.by_name(saved)['entrypoint']['status'], 'FAIL')

    def test_a_chroxy_claude_run_expects_a_mode_but_no_entrypoint(self):
        self.started('A-cy-r1')
        self.put_claude('A-cy-r1', claude_transcript('A-cy-r1', entrypoint='sdk-ts'))
        code, out, saved = self.go('A-cy-r1')
        self.assertEqual(code, 0, out)
        self.assertNotIn('entrypoint', self.by_name(saved))
        self.assertEqual(saved['applied']['entrypoint'], ['sdk-ts'])

    def test_an_interrupted_first_turn_stops_the_run(self):
        self.started('A-cy-r1')
        self.put_claude('A-cy-r1', [user('/prime-directive "Trial run A-cy-r1: follow m.md exactly"', permissionMode='auto'),
                                    user([{'type': 'text', 'text': '[Request interrupted by user]'}])])
        code, out, saved = self.go('A-cy-r1')
        self.assertEqual(code, 1)
        self.assertEqual(self.by_name(saved)['no interrupt']['status'], 'FAIL')
        self.assertEqual(self.by_name(saved)['model']['status'], 'UNVERIFIED')
        self.assertRegex(out, r'(?m)^STOP: no interrupt:')

    def test_a_probe_naming_another_run_fails(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript(probe_run='A-cy-r1'))
        code, _out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertEqual(self.by_name(saved)['probe']['status'], 'FAIL')

    def test_a_worker_on_another_model_does_not_fail_the_coordinator(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript(extra=[assistant(model='claude-sonnet-5-5', effort='low', isSidechain=True)]))
        code, out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 0, out)
        self.assertEqual(saved['applied']['worker_models'], ['claude-sonnet-5-5'])

    def test_no_transcript_is_a_fail_with_a_stop(self):
        self.started('A-cd-r1')
        code, out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertEqual(self.by_name(saved)['transcript found']['status'], 'FAIL')
        self.assertRegex(out, r'(?m)^STOP: transcript found:')
        self.assertIsNone(saved['transcript'])

    def test_a_transcript_asked_for_another_run_is_not_this_runs(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript('A-cy-r1'))
        code, _out, _ = self.go('A-cd-r1')
        self.assertEqual(code, 1)

    def test_the_search_starts_five_minutes_before_the_recorded_send(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript(), mtime=SENT - timedelta(minutes=4))
        self.assertEqual(self.go('A-cd-r1')[0], 0)
        self.put_claude('A-cd-r1', claude_transcript(), mtime=SENT - timedelta(minutes=6))
        self.assertEqual(self.go('A-cd-r1')[0], 1)
        self.assertEqual(self.go('A-cd-r1', since='2026-11-02T11:00:00Z')[0], 0)

    def test_it_needs_a_recorded_start_and_a_readable_since(self):
        code, out, _ = self.go('A-cd-r1')
        self.assertEqual(code, 1)
        self.assertIn('trialctl start A-cd-r1', out)
        self.started('A-cd-r1')
        code, _out, _ = self.go('A-cd-r1', since='whenever')
        self.assertEqual(code, 2)

    def test_the_clone_recorded_in_state_decides_where_to_look(self):
        elsewhere = self.rig.home('elsewhere', 'A-cd-r1')
        self.started('A-cd-r1', clone={'dir': elsewhere})
        folder = native.slug(os.path.abspath(elsewhere))
        path = self.rig.home('.claude', 'projects', folder, 's.jsonl')
        os.makedirs(os.path.dirname(path))
        with open(path, 'w') as fh:
            fh.write(jl(*claude_transcript()))
        os.utime(path, (OK_MTIME.timestamp(), OK_MTIME.timestamp()))
        self.assertEqual(self.go('A-cd-r1')[0], 0)

    # codex family
    def test_a_correct_codex_session_passes(self):
        self.started('B-cx-r1')
        self.put_codex('B-cx-r1', codex_rollout(self.rig.clone_dir('B-cx-r1')))
        code, out, saved = self.go('B-cx-r1')
        self.assertEqual(code, 0, out)
        self.assertEqual((saved['applied']['model'], saved['applied']['effort'], saved['applied']['sandbox']),
                         ([ASTRA], ['xhigh'], ['workspace-write']))
        self.assertEqual((saved['applied']['cli_version'], saved['applied']['originator'], saved['applied']['approval_policy']),
                         ('0.163.0', 'codex_cli_rs', ['on-request']))
        self.assertEqual(saved['transcript'], '2026/11/02/rollout-2026-11-02T12-00-00-aaa.jsonl')
        self.assertEqual(saved['first_command_at'], '2026-11-02T12:00:04Z')

    def test_high_effort_for_an_xhigh_run_stops_the_run(self):
        self.started('B-cx-r1')
        self.put_codex('B-cx-r1', codex_rollout(self.rig.clone_dir('B-cx-r1'), effort='high'))
        code, out, saved = self.go('B-cx-r1')
        self.assertEqual(code, 1)
        self.assertEqual(self.by_name(saved)['effort']['status'], 'FAIL')
        self.assertRegex(out, r'(?m)^STOP: .*effort: observed high, expected xhigh')

    def test_a_wrong_codex_model_or_sandbox_fails(self):
        self.started('B-cx-r1')
        self.put_codex('B-cx-r1', codex_rollout(self.rig.clone_dir('B-cx-r1'), model='gpt-5-codex'))
        code, out, _ = self.go('B-cx-r1')
        self.assertEqual(code, 1)
        self.assertIn('model: observed gpt-5-codex', out)
        self.put_codex('B-cx-r1', codex_rollout(self.rig.clone_dir('B-cx-r1'), sandbox='danger-full-access'))
        code, out, saved = self.go('B-cx-r1')
        self.assertEqual(code, 1)
        self.assertEqual(self.by_name(saved)['sandbox']['status'], 'FAIL')

    def test_a_codex_rollout_without_a_probe_is_unverified_not_a_stop(self):
        self.started('B-cx-r1')
        self.put_codex('B-cx-r1', codex_rollout(self.rig.clone_dir('B-cx-r1'), probe=False))
        code, out, saved = self.go('B-cx-r1')
        self.assertEqual(code, 2)
        self.assertEqual(self.by_name(saved)['probe']['status'], 'UNVERIFIED')
        self.assertNotIn('STOP', out)

    def test_a_subagent_rollout_is_not_taken_for_the_coordinator(self):
        self.started('B-cx-r1')
        clone = self.rig.clone_dir('B-cx-r1')
        self.put_codex('B-cx-r1', codex_rollout(clone), name='rollout-main.jsonl', mtime=OK_MTIME)
        worker = [meta(cwd=clone, source={'subagent': {'thread_spawn': {}}}), turn(model='gpt-6-spark', effort='low')]
        self.put_codex('B-cx-r1', worker, name='rollout-worker.jsonl', mtime=OK_MTIME + timedelta(minutes=2))
        code, out, saved = self.go('B-cx-r1')
        self.assertEqual(code, 0, out)
        self.assertTrue(saved['transcript'].endswith('rollout-main.jsonl'))

    def test_a_rollout_for_another_folder_does_not_count(self):
        self.started('B-cx-r1')
        self.put_codex('B-cx-r1', codex_rollout(self.rig.home('chroxy')))
        code, out, _ = self.go('B-cx-r1')
        self.assertEqual(code, 1)
        self.assertRegex(out, r'(?m)^STOP: rollout found:')

    def test_a_rollout_in_a_subfolder_of_the_clone_counts(self):
        self.started('B-cx-r1')
        self.put_codex('B-cx-r1', codex_rollout(os.path.join(self.rig.clone_dir('B-cx-r1'), 'packages', 'server')))
        self.assertEqual(self.go('B-cx-r1')[0], 0)

    def test_an_aborted_codex_turn_stops_the_run(self):
        self.started('B-cy-r1')
        self.put_codex('B-cy-r1', codex_rollout(self.rig.clone_dir('B-cy-r1'), rid='B-cy-r1',
                                                extra=[{'type': 'event_msg', 'payload': {'type': 'turn_aborted', 'reason': 'interrupted'}}]))
        code, out, _ = self.go('B-cy-r1')
        self.assertEqual(code, 1)
        self.assertRegex(out, r'(?m)^STOP: no interrupt:')

    def test_a_codex_probe_naming_another_run_fails_and_stops_the_run(self):
        self.started('B-cx-r1')
        self.put_codex('B-cx-r1', codex_rollout(self.rig.clone_dir('B-cx-r1'), rid='A-cd-r1'))
        code, out, saved = self.go('B-cx-r1')
        self.assertEqual(code, 1, out)
        probe = self.by_name(saved)['probe']
        self.assertEqual(probe['status'], 'FAIL')
        self.assertIn('names run A-cd-r1, not B-cx-r1', probe['detail'])
        self.assertRegex(out, r'(?m)^STOP: .*probe: the TRIAL-PROBE line names run A-cd-r1')
        self.assertIsNone(saved['applied']['probe'], 'another run\'s probe is not recorded as this run\'s')
        self.assertEqual(saved['first_command_at'], '2026-11-02T12:00:00Z', 'and it does not date this run\'s first command')

    def test_a_probe_naming_another_run_fails_the_claude_check_with_the_same_words(self):
        self.started('A-cd-r1')
        self.put_claude('A-cd-r1', claude_transcript(probe_run='A-cy-r1'))
        code, out, saved = self.go('A-cd-r1')
        self.assertEqual(code, 1, out)
        self.assertIn('names run A-cy-r1, not A-cd-r1', self.by_name(saved)['probe']['detail'])
        self.assertRegex(out, r'(?m)^STOP: .*probe: the TRIAL-PROBE line names run A-cy-r1')


# -- trial.json without a setting ----------------------------------------------------

class UnsetInTrialJson(LaunchCase):
    """A check that needs a value trial.json does not carry says UNVERIFIED: it could not be made, which is neither
    a pass (nothing was read) nor a crash. Each case removes one value from the loaded trial and reads back only the
    check that depends on it."""

    # (run, 'paths' | 'versions' | None for a trial attribute, key, the check that reads it, what its detail names)
    PREFLIGHT = [
        ('A-cd-r1', 'paths', 'node_bin', 'node version', 'paths.node_bin'),
        ('A-cd-r1', 'versions', 'node_major', 'node version', 'versions.node_major'),
        ('A-cd-r1', None, 'github_login', 'gh login', 'github_login'),
        ('A-cd-r1', 'paths', 'claude_settings', 'effort setting', 'paths.claude_settings'),
        ('A-cd-r1', 'versions', 'claude_min', 'claude version', 'versions.claude_min'),
        ('B-cx-r1', 'paths', 'codex_prompts', 'codex prompts', 'paths.codex_prompts'),
        ('B-cx-r1', 'paths', 'codex_app_cli', 'codex roster parity', 'paths.codex_app_cli'),
        ('A-cy-r1', 'paths', 'daemon_config', 'allowAutoPermissionMode', 'paths.daemon_config'),
        ('A-cy-r1', 'paths', 'daemon_checkout', 'daemon commit', 'paths.daemon_checkout'),
    ]
    VERIFY = [
        ('A-cd-r1', 'claude_projects', 'transcript found'),
        ('B-cx-r1', 'codex_sessions', 'rollout found'),
    ]

    def test_every_preflight_check_that_reads_a_setting_is_unverified_without_it(self):
        ready = set()
        for rid, bag, key, check, fragment in self.PREFLIGHT:
            with self.subTest(f'{bag or "trial"}.{key}'):
                if rid not in ready:
                    self.prep(rid)
                    ready.add(rid)
                runner = toolbox(self.rig)  # scripted from the full config, before the setting is taken away
                with without(self.rig.trial, bag, key):
                    code, out, st = self.pre(rid, runner)
                self.assertStatus(statuses(st), check, 'UNVERIFIED')
                self.assertIn(fragment, details(st)[check])
                self.assertEqual(code, 2, out)

    def test_the_session_phase_without_a_daemon_log_path_is_unverified_throughout(self):
        with without(self.rig.trial, 'paths', 'daemon_log'):
            code, out, st = self.pre('A-cy-r1', phase='session', session='s-1')
        self.assertEqual(code, 2, out)
        self.assertEqual(statuses(st, 'session'), {'session model': 'UNVERIFIED', 'session permission mode': 'UNVERIFIED',
                                                   'session interrupt': 'UNVERIFIED'})
        self.assertIn('cannot read the daemon log', details(st, 'session')['session model'])
        self.assertIn('paths.daemon_log is not set', details(st, 'session')['session model'])
        self.assertNotIn('None', details(st, 'session')['session model'])

    def test_verify_start_without_the_folder_it_reads_from_is_unverified_and_no_stop(self):
        for rid, key, check in self.VERIFY:
            with self.subTest(key):
                self.rig.save_state(rid, start={'sent_at': timeutil.iso(SENT), 'meters': {}, 'override': None})
                env = self.rig.env()
                with without(self.rig.trial, 'paths', key):
                    code = launch.verify_start(self.rig.trial, self.rig.run(rid), env, None, None)
                saved = self.rig.state(rid)['verify_start']
                self.assertEqual(code, 2, env.out.getvalue())
                self.assertEqual([(c['name'], c['status']) for c in saved['checks']], [(check, 'UNVERIFIED')])
                self.assertIn(f'paths.{key} is not set', saved['checks'][0]['detail'])
                self.assertNotIn('STOP', env.out.getvalue())


# -- finish ------------------------------------------------------------------------

class Finish(LaunchCase):
    def go(self, rid='A-cd-r1', **kw):
        env = self.rig.env()
        args = dict(meters={'claude_5h_used': 41.0}, cost='$12.30', ended_at=None, stop='queue exhausted')
        args.update(kw)
        code = launch.finish(self.rig.trial, self.rig.run(rid), env, args['meters'], args['cost'], args['ended_at'], args['stop'], None)
        return code, env.out.getvalue()

    def settled_run(self, rid='A-cd-r1', body='{"a": 1}'):
        path = self.rig.write_home('.claude/settings.json', body)
        with open(path, 'rb') as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        self.rig.save_state(rid, start={'sent_at': 'x'}, preflight=[{'phase': 'pre', 'at': 'y', 'checks': [],
                                                                       'facts': {'claude_settings_sha256': digest}}])
        return path

    def test_a_settings_file_unreadable_at_both_ends_is_unknown_not_unchanged(self):
        self.rig.save_state('A-cd-r1', start={'sent_at': 'x', 'claude_settings_sha256': None})
        code, out = self.go()
        self.assertEqual(code, 0, out)
        self.assertIsNone(self.rig.state('A-cd-r1')['finish']['settings_changed'])
        self.assertIn('cannot be ruled out', out)

    def test_the_first_send_s_baseline_survives_a_re_recorded_start(self):
        path = self.rig.write_home('.claude/settings.json', '{"a": 1}')
        first = launch._sha256(path)
        with open(path, 'w') as fh:
            fh.write('{"a": 2}')  # changed between the first start and a re-recorded one
        second = launch._sha256(path)
        self.rig.save_state('A-cd-r1', start={'sent_at': 'y', 'claude_settings_sha256': second,
                                              'replaces': {'sent_at': 'x', 'claude_settings_sha256': first}})
        code, out = self.go()
        self.assertTrue(self.rig.state('A-cd-r1')['finish']['settings_changed'], out)

    def test_records_the_end_and_a_run_stops_being_live(self):
        self.settled_run()
        code, out = self.go()
        self.assertEqual(code, 0, out)
        fin = self.rig.state('A-cd-r1')['finish']
        self.assertEqual((fin['ended_at'], fin['meters'], fin['cost'], fin['stop']),
                         ('2026-11-02T12:00:00Z', {'claude_5h_used': 41.0}, '$12.30', 'queue exhausted'))
        self.assertEqual(state.live_runs(self.rig.trial, home=self.rig.box.home), [])

    def test_a_given_end_time_is_normalised_and_a_bad_one_is_refused(self):
        self.settled_run()
        self.assertEqual(self.go(ended_at='2026-11-02T18:30:00+00:00')[0], 0)
        self.assertEqual(self.rig.state('A-cd-r1')['finish']['ended_at'], '2026-11-02T18:30:00Z')
        self.assertEqual(self.go(ended_at='tea time')[0], 2)

    def test_unchanged_settings_are_recorded_as_unchanged(self):
        self.settled_run()
        _code, out = self.go()
        fin = self.rig.state('A-cd-r1')['finish']
        self.assertIs(fin['settings_changed'], False)
        self.assertNotIn('WARNING', out)

    def test_settings_changed_during_the_run_warn_and_are_recorded(self):
        path = self.settled_run()
        with open(path, 'w') as fh:
            fh.write('{"a": 1, "hooks": {"Stop": []}}')
        code, out = self.go()
        self.assertEqual(code, 0)
        self.assertIn('WARNING', out)
        self.assertIn('#8704', out)
        self.assertIs(self.rig.state('A-cd-r1')['finish']['settings_changed'], True)

    def test_settings_deleted_during_the_run_count_as_changed(self):
        path = self.settled_run()
        os.remove(path)
        self.go()
        self.assertIs(self.rig.state('A-cd-r1')['finish']['settings_changed'], True)

    def test_without_a_recorded_hash_the_change_is_unknown_not_unchanged(self):
        self.rig.save_state('A-cd-r1', start={'sent_at': 'x'})
        self.rig.write_home('.claude/settings.json', '{}')
        _code, out = self.go()
        self.assertIsNone(self.rig.state('A-cd-r1')['finish']['settings_changed'])
        self.assertIn('cannot be ruled out', out)

    def test_a_codex_run_records_no_settings_hash(self):
        self.rig.save_state('B-cx-r1', start={'sent_at': 'x'})
        self.go('B-cx-r1', meters={'codex_weekly_left': 50.0})
        self.assertNotIn('settings_changed', self.rig.state('B-cx-r1')['finish'])

    def test_a_finish_without_a_start_warns_but_records(self):
        _code, out = self.go('B-cx-r1', meters={})
        self.assertIn('no start is recorded', out)
        self.assertIn('finish', self.rig.state('B-cx-r1'))

    def test_a_re_run_keeps_every_earlier_record_under_replaces_newest_first(self):
        self.settled_run()
        code, out = self.go(ended_at='2026-11-02T18:30:00Z')
        self.assertEqual(code, 0, out)
        self.assertNotIn('already recorded', out)
        first = self.rig.state('A-cd-r1')['finish']
        self.assertNotIn('replaces', first)
        code, out = self.go(meters={'claude_5h_used': 42.0})
        self.assertEqual(code, 0, out)
        self.assertIn('note: a finish is already recorded; this one replaces it, and the earlier record is kept under finish.replaces; '
                      'ended_at moves from 2026-11-02T18:30:00Z to 2026-11-02T12:00:00Z (pass --ended-at 2026-11-02T18:30:00Z to keep it)', out)
        second = self.rig.state('A-cd-r1')['finish']
        self.assertEqual((second['ended_at'], second['meters'], second['replaces']), ('2026-11-02T12:00:00Z', {'claude_5h_used': 42.0}, first))
        st = self.rig.state('A-cd-r1')
        st['finish']['ended_at'] = '2026-11-02T12:00:00.000+00:00'  # the same moment, as a hand edit or another writer spells it
        self.rig.save_state('A-cd-r1', **{k: v for k, v in st.items() if k not in ('run', 'trial', 'updated_at')})
        second = self.rig.state('A-cd-r1')['finish']
        code, out = self.go(ended_at='2026-11-02T12:00:00Z')
        self.assertIn('kept under finish.replaces', out)
        self.assertNotIn('moves', out, 'the same moment written another way does not move it')
        third = self.rig.state('A-cd-r1')['finish']
        self.assertEqual((third['replaces'], third['replaces']['replaces']), (second, first))
        self.assertEqual(state.live_runs(self.rig.trial, home=self.rig.box.home), [])

    def test_a_re_run_over_a_record_that_is_not_one_keeps_it_and_names_an_end_it_cannot_read(self):
        for earlier, said in (('x', 'kept under finish.replaces\n'), (['x'], 'kept under finish.replaces\n'),
                              ({'ended_at': 'garbage'}, "kept under finish.replaces; its ended_at ('garbage') cannot be read, so the new one "
                                                        "(2026-11-02T12:00:00Z) cannot be checked against it\n")):
            with self.subTest(earlier=earlier):
                self.rig.save_state('A-cd-r1', start={'sent_at': 'x', 'claude_settings_sha256': None}, finish=earlier)
                code, out = self.go()
                self.assertEqual(code, 0, out)
                self.assertIn('note: a finish is already recorded; this one replaces it, and the earlier record is ' + said, out)
                self.assertNotIn('pass --ended-at', out, 'a value finish would refuse is no advice')
                self.assertEqual(self.rig.state('A-cd-r1')['finish']['replaces'], earlier)


# -- finish: the queue's text again ------------------------------------------------

class FinishQueueText(LaunchCase):
    """`finish` reads each queue issue again and records, per slot, whether its text changed since T0 and since the text this
    run's gate let through. Each test runs the real `gate` and `start` of a Codex run (it has no settings file to note), then
    finishes with a GitHub whose issues may differ from the ones the gate read."""
    RID = 'B-cx-r1'
    EDITED = 'the body, edited during the run'
    TYPO = 'edited to fix a typo'

    def started(self, gh=None, accept_changed=None, sent_at=None, gate_at=None):
        self.gated(gh, accept_changed, gate_at)
        self.rewrite(preflight=[dict(passing_preflight()[0], at='2026-11-02T12:30:00Z')])
        self.sent(sent_at)

    def gated(self, gh=None, accept_changed=None, at=None):
        """The real `gate`, at `at` (the test clock's 12:00 by default)."""
        env = self.rig.env(github=gh or FakeGitHub())
        if at:
            env.now = lambda: timeutil.parse_ts(at)
        code = launch.gate(self.rig.trial, self.rig.run(self.RID), env, {}, None, accept_changed=accept_changed)
        self.assertEqual(code, 0, env.out.getvalue())

    def sent(self, sent_at=None, override=None):
        env = self.rig.env()
        code = launch.start(self.rig.trial, self.rig.run(self.RID), env, {'codex_weekly_left': 100.0}, override, sent_at, None)
        self.assertEqual(code, 0, env.out.getvalue())

    def finish(self, gh=None):
        gh = gh or FakeGitHub()
        env = self.rig.env(github=gh)
        code = launch.finish(self.rig.trial, self.rig.run(self.RID), env, {'codex_weekly_left': 48.0}, 'n/a', None, 'queue exhausted', None)
        return code, env.out.getvalue(), gh

    def rewrite(self, **sections):
        """Replace sections of the run's state, as a state file from another version of the runner would differ."""
        st = self.rig.state(self.RID)
        st.update(sections)
        self.rig.save_state(self.RID, **{k: v for k, v in st.items() if k not in ('run', 'trial', 'updated_at')})

    def set_accepted(self, accepted_changed):
        self.rewrite(gate=dict(self.rig.state(self.RID)['gate'], accepted_changed=accepted_changed))

    def recorded(self):
        return self.rig.state(self.RID)['finish']

    def seen(self, slot):
        slots = (self.recorded().get('queue_text') or {}).get('slots') or {}
        self.assertIn(slot, slots, 'finish recorded nothing for the slot')
        return slots[slot]

    def assert_text_not_kept(self, out, *texts):
        kept = json.dumps(self.rig.state(self.RID))
        for text in texts:
            self.assertFalse(text in out, f'{text!r} was printed')
            self.assertFalse(text in kept, f'{text!r} was recorded')

    def test_unchanged_text_is_recorded_per_slot_and_passes(self):
        self.started()
        code, out, gh = self.finish()
        self.assertEqual(code, 0, out)
        fin = self.recorded()
        self.assertEqual((fin['ended_at'], fin['meters'], fin['cost'], fin['stop']),
                         ('2026-11-02T12:00:00Z', {'codex_weekly_left': 48.0}, 'n/a', 'queue exhausted'))
        self.assertEqual(fin['queue_text']['at'], '2026-11-02T12:00:00Z')
        self.assertEqual(sorted(fin['queue_text']['slots']), ['Q01', 'Q02'])
        for slot in self.rig.trial.slots:
            now = queue_text.read_slot(gh, slot)
            detail = 'title, body and 1 comment(s) unchanged since the T0 snapshot of 2026-11-02T09:00:00Z'
            self.assertEqual(self.seen(slot.slot), {**now, 'since_t0': 'unchanged', 'since_gate': 'unchanged', 'detail': detail})
        self.assertIn('queue text at the end of B-cx-r1', out)
        self.assertRegex(out, r'PASS\s+queue text Q01 #9001\s+title, body and 1 comment\(s\) unchanged since the T0 snapshot of 2026-11-02T09:00:00Z')
        self.assertRegex(out, r'PASS\s+queue text Q02 #9002')
        self.assertNotIn('WARNING', out)
        self.assertEqual(out.rstrip().splitlines()[-1], 'finish B-cx-r1: recorded ended_at 2026-11-02T12:00:00Z')

    def test_a_body_edited_after_start_is_changed_since_t0_and_since_the_gate(self):
        self.started()
        code, out, gh = self.finish(FakeGitHub(bodies={9002: self.EDITED}))
        self.assertEqual(code, 0, 'a record, not a gate: finish still succeeds')
        fin = self.recorded()
        self.assertEqual((fin['ended_at'], fin['stop'], fin['cost']), ('2026-11-02T12:00:00Z', 'queue exhausted', 'n/a'))
        edited = self.seen('Q02')
        self.assertEqual((edited['since_t0'], edited['since_gate'], edited['parts']), ('changed', 'changed', ['body']))
        self.assertEqual(edited['body_sha256'], sha256_of(self.EDITED))
        self.assertNotIn('accepted', edited)
        self.assertEqual((self.seen('Q01')['since_t0'], self.seen('Q01')['since_gate']), ('unchanged', 'unchanged'))
        self.assertRegex(out, r'FAIL\s+queue text Q02 #9002\s+changed since the T0 snapshot of 2026-11-02T09:00:00Z: body; '
                              r'this run\'s gate passed the T0 text, so it changed after this run\'s gate \(or the run started without a passing gate\)')
        self.assertRegex(out, r'PASS\s+queue text Q01 #9001')
        warning = [line for line in out.splitlines() if line.startswith('WARNING')]
        self.assertEqual(len(warning), 1, out)
        self.assertIn('the text of Q02 differs from what this run\'s gate let through', warning[0])
        self.assertIn('a grader must know which', warning[0])
        self.assertIn('mission rule 4', warning[0])
        self.assertNotIn('Q01', warning[0])
        self.assertEqual(out.rstrip().splitlines()[-1], 'finish B-cx-r1: recorded ended_at 2026-11-02T12:00:00Z')
        self.assert_text_not_kept(out, self.EDITED)

    def test_a_title_edited_during_the_run_is_named(self):
        self.started()
        _code, out, _ = self.finish(FakeGitHub(titles={9001: 'a new title'}))
        self.assertEqual((self.seen('Q01')['since_gate'], self.seen('Q01')['parts']), ('changed', ['title']))
        self.assertRegex(out, r'FAIL\s+queue text Q01 #9001\s+changed since the T0 snapshot of \S+: title;')
        self.assert_text_not_kept(out, 'a new title')

    def test_a_comment_added_during_the_run_is_changed(self):
        self.started()
        late = [comment(90011), comment(90019, 'a late comment', 'bob')]
        _code, out, _ = self.finish(FakeGitHub(comments={9001: late}))
        self.assertEqual((self.seen('Q01')['since_t0'], self.seen('Q01')['since_gate']), ('changed', 'changed'))
        self.assertEqual((self.seen('Q01')['parts'], self.seen('Q01')['comments']), (['comments (1 -> 2)'], 2))
        self.assertRegex(out, r'FAIL\s+queue text Q01 #9001\s+changed since the T0 snapshot of \S+: comments \(1 -> 2\);')
        self.assertIn('WARNING: the text of Q01 differs', out)
        self.assert_text_not_kept(out, 'a late comment')
        _code, out, _ = self.finish(FakeGitHub(comments={9002: [comment(90021, 'edited after the gate')]}))
        self.assertEqual(self.seen('Q02')['parts'], ['comments (1, text changed)'])
        self.assert_text_not_kept(out, 'edited after the gate')

    def test_the_text_of_two_slots_changed_is_one_warning_naming_both(self):
        self.started()
        _code, out, _ = self.finish(FakeGitHub(bodies={9001: 'x', 9002: 'y'}))
        warning = [line for line in out.splitlines() if line.startswith('WARNING')]
        self.assertEqual(len(warning), 1, out)
        self.assertIn('the text of Q01, Q02 differs', warning[0])

    def test_a_github_error_is_unverified_never_unchanged(self):
        self.started()
        for what, gh in (('comments', FakeGitHub(comments={9002: GitHubError('rate limited', 403)})),
                         ('the issue', FakeGitHub(issues={9002: GitHubError('boom', 502)}))):
            with self.subTest(what):
                code, out, _ = self.finish(gh)
                self.assertEqual(code, 0, out)
                row = self.seen('Q02')
                self.assertEqual((row['since_t0'], row['since_gate']), ('unverified', 'unverified'))
                self.assertEqual(sorted(row), ['detail', 'issue', 'since_gate', 'since_t0'], 'nothing is said of the text it could not read')
                self.assertIn('cannot read Q02 #9002', row['detail'])
                self.assertRegex(out, r'UNVERIFIED\s+queue text Q02 #9002\s+cannot read Q02 #9002: ')
                self.assertNotRegex(out, r'PASS\s+queue text Q02')
                self.assertRegex(out, r'PASS\s+queue text Q01 #9001')
                self.assertEqual((self.seen('Q01')['since_t0'], self.seen('Q01')['since_gate']), ('unchanged', 'unchanged'))
                self.assertNotIn('WARNING', out)

    def test_a_reply_it_cannot_read_is_unverified(self):
        self.started()
        for comments in ([{'id': 'x', 'body': 'b'}], [comment(7), comment(7)]):
            with self.subTest(comments=comments):
                _code, out, _ = self.finish(FakeGitHub(comments={9001: comments}))
                self.assertEqual((self.seen('Q01')['since_t0'], self.seen('Q01')['since_gate']), ('unverified', 'unverified'))
                self.assertRegex(out, r'UNVERIFIED\s+queue text Q01 #9001\s+cannot read Q01 #9001: ')

    def test_text_accepted_at_the_gate_and_unchanged_since_passes_with_the_reason(self):
        gh = FakeGitHub(bodies={9002: self.TYPO})
        self.started(gh, accept_changed={'Q02': 'a typo fix'})
        code, out, _ = self.finish(gh)
        self.assertEqual(code, 0, out)
        row = self.seen('Q02')
        self.assertEqual((row['since_t0'], row['since_gate'], row['parts'], row['accepted']), ('changed', 'unchanged', ['body'], 'a typo fix'))
        self.assertEqual(row['detail'], 'changed since T0 (body), the text this run\'s gate accepted: a typo fix')
        self.assertRegex(out, r'PASS\s+queue text Q02 #9002\s+changed since T0 \(body\), the text this run\'s gate accepted: a typo fix')
        self.assertRegex(out, r'PASS\s+queue text Q01 #9001')
        self.assertNotIn('WARNING', out)
        self.assert_text_not_kept(out, self.TYPO)

    def test_text_accepted_at_the_gate_and_then_reverted_to_t0_is_changed_since_the_gate(self):
        self.started(FakeGitHub(bodies={9002: self.TYPO}), accept_changed={'Q02': 'a typo fix'})
        code, out, _ = self.finish(FakeGitHub())
        self.assertEqual(code, 0, out)
        row = self.seen('Q02')
        self.assertEqual((row['since_t0'], row['since_gate'], row['accepted']), ('unchanged', 'changed', 'a typo fix'))
        self.assertNotIn('parts', row)
        self.assertRegex(out, r'FAIL\s+queue text Q02 #9002\s+back to the T0 text, but this run\'s gate accepted a changed text '
                              r'\(a typo fix\), so it changed after this run\'s gate')
        self.assertIn('WARNING: the text of Q02 differs', out)

    def test_text_accepted_at_the_gate_and_then_edited_again_names_what_moved_since_the_gate(self):
        self.started(FakeGitHub(bodies={9002: self.TYPO}), accept_changed={'Q02': 'a typo fix'})
        code, out, _ = self.finish(FakeGitHub(bodies={9002: self.TYPO}, titles={9002: 'and a new title'}))
        self.assertEqual(code, 0, out)
        row = self.seen('Q02')
        self.assertEqual((row['since_t0'], row['since_gate'], row['parts'], row['accepted']),
                         ('changed', 'changed', ['title', 'body'], 'a typo fix'))
        self.assertRegex(out, r'FAIL\s+queue text Q02 #9002\s+changed since the text this run\'s gate accepted \(a typo fix\): title\n')
        self.assertIn('WARNING: the text of Q02 differs', out)
        self.assert_text_not_kept(out, 'and a new title')

    def test_text_edited_and_accepted_by_a_gate_after_the_send_is_not_an_acceptance(self):
        edited = FakeGitHub(bodies={9002: self.TYPO})
        self.started(sent_at='2026-11-02T13:00:00Z')
        self.gated(edited, accept_changed={'Q02': 'a typo fix'}, at='2026-11-02T14:00:00Z')
        self.assertEqual(self.rig.state(self.RID)['gate']['accepted_changed']['Q02']['reason'], 'a typo fix', 'the later gate recorded it')
        code, out, _ = self.finish(edited)
        self.assertEqual(code, 0, out)
        row = self.seen('Q02')
        self.assertEqual((row['since_t0'], row['since_gate'], row['parts']), ('changed', 'changed', ['body']))
        self.assertNotIn('accepted', row)
        self.assertEqual(row['detail'], 'changed since the T0 snapshot of 2026-11-02T09:00:00Z: body; this run\'s gate cannot be placed at or '
                                        'before the first send, so its acceptances were not used and the text is compared with T0')
        self.assertNotIn('passed the T0 text', row['detail'])
        self.assertRegex(out, r'FAIL\s+queue text Q02 #9002\s+changed since the T0 snapshot of .*cannot be placed at or before the first send')
        self.assertIn('WARNING: the text of Q02 differs', out)
        self.assertEqual(self.seen('Q01')['detail'], 'title, body and 1 comment(s) unchanged since the T0 snapshot of 2026-11-02T09:00:00Z')
        ignored = self.recorded()['queue_text']['acceptances_ignored']
        self.assertIn('2026-11-02T14:00:00Z', ignored)
        self.assertIn('2026-11-02T13:00:00Z', ignored)
        self.assertIn(f'note: {ignored}', out.splitlines())
        self.assertEqual((self.seen('Q01')['since_t0'], self.seen('Q01')['since_gate']), ('unchanged', 'unchanged'))

    def test_a_gate_half_a_second_after_a_whole_second_send_has_its_acceptance_ignored(self):
        edited = FakeGitHub(bodies={9002: self.TYPO})
        self.started(edited, accept_changed={'Q02': 'a typo fix'}, sent_at='2026-11-02T12:00:00Z', gate_at='2026-11-02T12:00:00.500Z')
        self.assertEqual(self.rig.state(self.RID)['gate']['at'], '2026-11-02T12:00:00.500Z')
        self.assertEqual(self.rig.state(self.RID)['start']['sent_at'], '2026-11-02T12:00:00Z')
        _code, out, _ = self.finish(edited)
        self.assertEqual((self.seen('Q02')['since_gate'], 'accepted' in self.seen('Q02')), ('changed', False))
        ignored = self.recorded()['queue_text']['acceptances_ignored']
        self.assertIn('2026-11-02T12:00:00.500Z', ignored)
        self.assertIn('is later than the first send', ignored)

    def test_a_gate_half_a_second_before_a_whole_second_send_keeps_its_acceptance(self):
        edited = FakeGitHub(bodies={9002: self.TYPO})
        self.started(edited, accept_changed={'Q02': 'a typo fix'}, sent_at='2026-11-02T12:00:00.500Z')
        self.assertEqual(self.rig.state(self.RID)['gate']['at'], '2026-11-02T12:00:00Z')
        _code, out, _ = self.finish(edited)
        self.assertEqual((self.seen('Q02')['since_gate'], self.seen('Q02')['accepted']), ('unchanged', 'a typo fix'))
        self.assertNotIn('acceptances_ignored', self.recorded()['queue_text'])
        self.assertNotIn('note:', out)

    def test_a_gate_time_that_cannot_be_read_has_its_acceptance_ignored_and_says_why(self):
        edited = FakeGitHub(bodies={9002: self.TYPO})
        for how, at in (('unparseable', 'yesterday-ish'), ('missing', None), ('no text', 5), ('out of range', '9999-12-31T23:59:59-05:00')):
            with self.subTest(how):
                self.setUp()
                self.started(edited, accept_changed={'Q02': 'a typo fix'}, sent_at='2026-11-02T13:00:00Z')
                gate = {k: v for k, v in self.rig.state(self.RID)['gate'].items() if k != 'at'}
                self.rewrite(gate=gate if how == 'missing' else dict(gate, at=at))
                _code, out, _ = self.finish(edited)
                self.assertEqual((self.seen('Q02')['since_gate'], 'accepted' in self.seen('Q02')), ('changed', False))
                ignored = self.recorded()['queue_text']['acceptances_ignored']
                self.assertIn(f'the recorded gate\'s time ({at!r}) or the first send\'s (\'2026-11-02T13:00:00Z\') cannot be read', ignored)
                self.assertIn('so the gate cannot be placed before the send', ignored)
                self.assertIn(f'note: {ignored}', out.splitlines())
                self.assertIn('cannot be placed at or before the first send', self.seen('Q02')['detail'])

    def test_a_first_send_that_cannot_be_read_has_the_acceptance_ignored_and_says_why(self):
        edited = FakeGitHub(bodies={9002: self.TYPO})
        cases = (('no sent_at', lambda start: {k: v for k, v in start.items() if k != 'sent_at'}, None),
                 ('unparseable', lambda start: dict(start, sent_at='lunchtime'), 'lunchtime'),
                 ('no text', lambda start: dict(start, sent_at=7), 7),
                 ('the first of a chain has none', lambda start: dict(start, replaces={'meters': {}}), None),
                 ('a start that is no record', lambda start: 'sent', None))
        for how, edit, shown in cases:
            with self.subTest(how):
                self.setUp()
                self.started(edited, accept_changed={'Q02': 'a typo fix'}, sent_at='2026-11-02T13:00:00Z')
                self.rewrite(start=edit(self.rig.state(self.RID)['start']))
                _code, out, _ = self.finish(edited)
                self.assertEqual((self.seen('Q02')['since_gate'], 'accepted' in self.seen('Q02')), ('changed', False))
                ignored = self.recorded()['queue_text']['acceptances_ignored']
                self.assertIn(f'or the first send\'s ({shown!r}) cannot be read', ignored)
                self.assertIn('2026-11-02T12:00:00Z', ignored)

    def test_without_a_recorded_gate_there_is_nothing_to_place_and_nothing_is_ignored(self):
        self.started()
        for gate in (None, {}):
            with self.subTest(gate=gate):
                self.rewrite(gate=gate, finish=None)  # each a first finish: a re-run notes the record it replaces
                _code, out, _ = self.finish()
                self.assertNotIn('acceptances_ignored', self.recorded()['queue_text'])
                self.assertNotIn('note:', out)

    def test_a_gate_between_the_first_and_second_of_three_sends_is_after_the_first_send(self):
        edited = FakeGitHub(bodies={9002: self.TYPO})
        self.started(sent_at='2026-11-02T12:10:00Z')
        self.gated(edited, accept_changed={'Q02': 'a typo fix'}, at='2026-11-02T12:20:00Z')
        self.sent('2026-11-02T12:30:00Z', override='the send was repeated')
        self.sent('2026-11-02T12:40:00Z', override='and again')
        chain = self.rig.state(self.RID)['start']
        self.assertEqual([chain['sent_at'], chain['replaces']['sent_at'], chain['replaces']['replaces']['sent_at']],
                         ['2026-11-02T12:40:00Z', '2026-11-02T12:30:00Z', '2026-11-02T12:10:00Z'])
        self.assertNotIn('replaces', chain['replaces']['replaces'])
        _code, out, _ = self.finish(edited)
        self.assertEqual((self.seen('Q02')['since_gate'], 'accepted' in self.seen('Q02')), ('changed', False))
        ignored = self.recorded()['queue_text']['acceptances_ignored']
        self.assertIn('2026-11-02T12:20:00Z', ignored)
        self.assertIn('2026-11-02T12:10:00Z', ignored)
        self.assertNotIn('2026-11-02T12:30:00Z', ignored)
        self.assertNotIn('2026-11-02T12:40:00Z', ignored)

    def test_a_gate_after_the_send_that_accepted_nothing_is_noted_too(self):
        self.started(sent_at='2026-11-02T13:00:00Z')
        self.gated(at='2026-11-02T14:00:00Z')
        _code, out, _ = self.finish()
        self.assertIn('acceptances_ignored', self.recorded()['queue_text'])
        self.assertEqual((self.seen('Q01')['since_gate'], self.seen('Q02')['since_gate']), ('unchanged', 'unchanged'))

    def test_an_acceptance_made_before_the_send_counts_whether_the_send_is_at_the_gate_or_later(self):
        for sent_at in (None, '2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z'):
            with self.subTest(sent_at=sent_at):
                self.setUp()
                edited = FakeGitHub(bodies={9002: self.TYPO})
                self.started(edited, accept_changed={'Q02': 'a typo fix'}, sent_at=sent_at)
                _code, out, _ = self.finish(edited)
                self.assertEqual((self.seen('Q02')['since_t0'], self.seen('Q02')['since_gate'], self.seen('Q02')['accepted']),
                                 ('changed', 'unchanged', 'a typo fix'))
                self.assertNotIn('acceptances_ignored', self.recorded()['queue_text'])
                self.assertNotIn('note:', out)

    def test_without_a_recorded_start_an_acceptance_counts(self):
        edited = FakeGitHub(bodies={9002: self.TYPO})
        self.gated(edited, accept_changed={'Q02': 'a typo fix'}, at='2026-11-02T14:00:00Z')
        self.assertNotIn('start', self.rig.state(self.RID))
        _code, out, _ = self.finish(edited)
        self.assertEqual((self.seen('Q02')['since_gate'], self.seen('Q02')['accepted']), ('unchanged', 'a typo fix'))
        self.assertNotIn('acceptances_ignored', self.recorded()['queue_text'])

    def test_a_re_recorded_start_is_measured_from_the_first_send(self):
        edited = FakeGitHub(bodies={9002: self.TYPO})
        self.started(sent_at='2026-11-02T12:10:00Z')
        self.gated(edited, accept_changed={'Q02': 'a typo fix'}, at='2026-11-02T12:20:00Z')   # after the first send, before the second
        self.sent('2026-11-02T12:30:00Z', override='the send was repeated')
        replaced = self.rig.state(self.RID)['start']
        self.assertEqual((replaced['sent_at'], replaced['replaces']['sent_at']), ('2026-11-02T12:30:00Z', '2026-11-02T12:10:00Z'))
        _code, out, _ = self.finish(edited)
        self.assertEqual((self.seen('Q02')['since_gate'], 'accepted' in self.seen('Q02')), ('changed', False))
        ignored = self.recorded()['queue_text']['acceptances_ignored']
        self.assertIn('2026-11-02T12:20:00Z', ignored)
        self.assertIn('2026-11-02T12:10:00Z', ignored)
        self.assertNotIn('2026-11-02T12:30:00Z', ignored)

    def test_an_acceptance_before_the_first_send_survives_a_re_recorded_start(self):
        edited = FakeGitHub(bodies={9002: self.TYPO})
        self.started(edited, accept_changed={'Q02': 'a typo fix'}, sent_at='2026-11-02T12:10:00Z')
        self.sent('2026-11-02T12:30:00Z', override='the send was repeated')
        self.sent('2026-11-02T12:40:00Z', override='and again')
        _code, out, _ = self.finish(edited)
        self.assertEqual((self.seen('Q02')['since_gate'], self.seen('Q02')['accepted']), ('unchanged', 'a typo fix'))
        self.assertNotIn('acceptances_ignored', self.recorded()['queue_text'])

    def test_an_acceptance_is_not_taken_for_another_slot(self):
        gh = FakeGitHub(bodies={9002: self.TYPO})
        self.started(gh, accept_changed={'Q02': 'a typo fix'})
        _code, out, _ = self.finish(FakeGitHub(bodies={9001: 'x', 9002: self.TYPO}))
        self.assertEqual((self.seen('Q01')['since_gate'], self.seen('Q02')['since_gate']), ('changed', 'unchanged'))
        self.assertNotIn('accepted', self.seen('Q01'))

    def test_an_acceptance_the_gate_did_not_record_in_full_is_not_one(self):
        gh = FakeGitHub(bodies={9002: self.EDITED})
        good = {'reason': 'recorded in full', **queue_text.read_slot(gh, slot_named(self.rig, 'Q02'))}
        cases = {'a bare reason, as an older gate recorded it': 'a typo fix', 'a reason alone': {'reason': 'x'},
                 'a digest that is none': dict(good, body_sha256='nope'), 'no count': {k: v for k, v in good.items() if k != 'comments'},
                 'another issue': dict(good, issue=1234), 'a blank reason': dict(good, reason=''),
                 'a reason that is not text': dict(good, reason=5), 'a list': [good]}
        self.started()
        self.set_accepted({'Q02': good})
        self.finish(gh)
        control = self.seen('Q02')
        self.assertEqual((control['since_t0'], control['since_gate'], control['accepted']), ('changed', 'unchanged', 'recorded in full'))
        for how, entry in cases.items():
            with self.subTest(how):
                self.set_accepted({'Q02': entry})
                _code, out, _ = self.finish(gh)
                row = self.seen('Q02')
                self.assertEqual((row['since_t0'], row['since_gate']), ('changed', 'changed'))
                self.assertNotIn('accepted', row)
                self.assertIn('this run\'s gate passed the T0 text', row['detail'])

    def test_a_gate_record_that_is_not_a_record_leaves_every_slot_compared_with_t0(self):
        self.started()
        for gate in (None, 'x', [], {'accepted_changed': None}, {'accepted_changed': 'x'}, {'accepted_changed': []}):
            with self.subTest(gate=gate):
                self.rewrite(gate=gate)
                code, out, _ = self.finish(FakeGitHub(bodies={9002: self.EDITED}))
                self.assertEqual(code, 0, out)
                self.assertEqual((self.seen('Q01')['since_gate'], self.seen('Q02')['since_gate']), ('unchanged', 'changed'))

    def test_a_missing_snapshot_leaves_every_slot_unverified_and_reads_nothing(self):
        self.started()
        os.remove(snapshot_path(self.rig))
        code, out, gh = self.finish(FakeGitHub(bodies={9002: self.EDITED}))
        self.assertEqual(code, 0, out)
        for slot in ('Q01', 'Q02'):
            row = self.seen(slot)
            self.assertEqual((row['since_t0'], row['since_gate']), ('unverified', 'unverified'))
            self.assertIn('queue-t0.json is missing', row['detail'])
            self.assertEqual(sorted(row), ['detail', 'issue', 'since_gate', 'since_t0'])
            # The gate's advice (run `cut` again) would write the end text as the baseline and read every slot as unchanged.
            self.assertIn('put the committed file back and run `finish` again', row['detail'])
            self.assertIn('Do not run `cut` to write it now', row['detail'])
            self.assertNotIn('run `cut` again', row['detail'])
        self.assertRegex(out, r'UNVERIFIED\s+queue text at T0\s+queue-t0.json is missing')
        self.assertNotRegex(out, r'(PASS|FAIL)\s+queue text')
        self.assertEqual(gh.requests, [], 'no text was read without a baseline')
        self.assertNotIn('WARNING', out)

    def test_a_baseline_that_cannot_be_used_is_unverified_in_every_way_gate_calls_it_bad(self):
        self.started()
        for how in ('corrupt', 'directory'):
            with self.subTest(how):
                undo = plant_unreadable_snapshot(self.rig, how)
                _code, out, gh = self.finish()
                undo()
                self.assertEqual((self.seen('Q01')['since_t0'], self.seen('Q02')['since_gate']), ('unverified', 'unverified'))
                self.assertRegex(out, r'UNVERIFIED\s+queue text at T0\s+cannot read ')
                self.assertEqual(gh.requests, [])
        edits = {'not a snapshot': lambda d: d.pop('slots'), 'another T0': lambda d: d.update(t0='f' * 40)}
        for how, edit in edits.items():
            with self.subTest(how):
                self.setUp()
                self.started()
                edit_snapshot(self.rig, edit)
                _code, out, gh = self.finish()
                self.assertEqual((self.seen('Q01')['since_t0'], self.seen('Q02')['since_gate']), ('unverified', 'unverified'))
                self.assertRegex(out, r'UNVERIFIED\s+queue text at T0\s+queue-t0.json ')
                self.assertNotRegex(out, r'FAIL\s+queue text')
                self.assertEqual(gh.requests, [])

    def test_no_t0_leaves_every_slot_unverified(self):
        self.rig = Rig(self, record_t0=False)
        code, out, gh = self.finish()
        self.assertEqual(code, 0, out)
        self.assertEqual((self.seen('Q01')['since_t0'], self.seen('Q02')['since_gate']), ('unverified', 'unverified'))
        self.assertRegex(out, r'UNVERIFIED\s+queue text at T0\s+no T0 recorded')
        self.assertEqual(gh.requests, [])

    def test_a_slot_with_no_entry_in_the_snapshot_is_unverified_and_the_rest_are_read(self):
        self.started()
        edit_snapshot(self.rig, lambda d: d['slots'].pop('Q02'))
        _code, out, gh = self.finish()
        self.assertEqual((self.seen('Q02')['since_t0'], self.seen('Q02')['since_gate']), ('unverified', 'unverified'))
        self.assertIn('queue-t0.json has no entry for Q02', self.seen('Q02')['detail'])
        self.assertRegex(out, r'UNVERIFIED\s+queue text Q02 #9002\s+queue-t0.json has no entry for Q02')
        self.assertRegex(out, r'PASS\s+queue text Q01 #9001')
        self.assertFalse([r for r in gh.requests if '9002' in r[0]], 'nothing is read for a slot with no baseline')

    def test_an_empty_queue_is_unverified_with_no_slots(self):
        self.rig = Rig(self, slots=[])
        code, out, gh = self.finish()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.recorded()['queue_text']['slots'], {})
        self.assertRegex(out, r'UNVERIFIED\s+queue text at the end\s+the queue has no slots')
        self.assertEqual(gh.requests, [])

    def test_a_re_run_after_the_edit_was_reverted_keeps_the_changed_record(self):
        # #8802: the re-read finds the T0 text again; the change the first finish saw must still be in the state, and collect names it.
        self.started()
        _code, out, _ = self.finish(FakeGitHub(bodies={9002: self.EDITED}))
        first = self.recorded()
        self.assertEqual((first['queue_text']['slots']['Q02']['since_t0'], first['queue_text']['slots']['Q02']['since_gate']), ('changed', 'changed'))
        code, out, _ = self.finish()
        self.assertEqual(code, 0, out)
        self.assertIn('kept under finish.replaces', out)
        self.assertEqual((self.seen('Q02')['since_t0'], self.seen('Q02')['since_gate']), ('unchanged', 'unchanged'))
        self.assertEqual(self.recorded()['replaces'], first)
        notes = collect._queue_text_notes(self.rig.trial, self.rig.state(self.RID))
        self.assertEqual(notes, ["queue text Q02: an earlier finish (queue text read at 2026-11-02T12:00:00Z) found it changed since this run's "
                                 f"gate ({first['queue_text']['slots']['Q02']['detail']})"])

    def test_a_re_run_reads_an_unverified_slot_again_and_the_earlier_unverified_is_no_note(self):
        # The README's recovery: the first read failed, a re-run with the same end reads it.
        self.started()
        _code, out, _ = self.finish(FakeGitHub(issues={9002: GitHubError('boom', 502)}))
        self.assertEqual(self.seen('Q02')['since_gate'], 'unverified')
        env = self.rig.env(github=FakeGitHub())
        code = cli.main(['--trial', self.rig.box.trial_dir, 'finish', self.RID, '--ended-at', '2026-11-02T12:00:00Z',
                         '--meter', 'codex_weekly_left=48', '--cost', 'n/a', '--stop', 'queue exhausted'], env=env)
        out = env.out.getvalue()
        self.assertEqual(code, 0, out)
        self.assertNotIn('moves', out)
        fin = self.recorded()
        self.assertEqual((fin['ended_at'], fin['meters'], fin['cost'], fin['stop']), ('2026-11-02T12:00:00Z', {'codex_weekly_left': 48.0}, 'n/a', 'queue exhausted'))
        self.assertEqual((self.seen('Q02')['since_t0'], self.seen('Q02')['since_gate']), ('unchanged', 'unchanged'))
        self.assertEqual(fin['replaces']['queue_text']['slots']['Q02']['since_gate'], 'unverified')
        self.assertEqual(collect._queue_text_notes(self.rig.trial, self.rig.state(self.RID)), [])

    def test_what_finish_records_reaches_collect_s_notes(self):
        # collect's tests write `finish.queue_text` by hand and these assert what `finish` writes, so a key renamed on one side with its own
        # tests stayed green (#8805). Here the real `finish` writes the state the real `collect` reads, and the notes are spelled out.
        self.started(FakeGitHub(bodies={9002: self.TYPO}), accept_changed={'Q02': 'a typo fix'},
                     sent_at='2026-11-02T12:00:00Z', gate_at='2026-11-02T12:00:00.500Z')
        code, out, _ = self.finish(FakeGitHub(bodies={9002: self.EDITED}))
        self.assertEqual(code, 0, out)
        github = test_collect.FakeGitHub()
        for pattern, reply in ((r'^pulls$', []), (r'^issues/\d+/timeline$', []), (r'^git/ref/heads/', {'object': {'sha': 'basetip'}}),
                               (r'^actions/runs$', []), (r'^contents/\.github/workflows/ci\.yml$', test_collect.ci_contents(CI_OK))):
            github.route(pattern, reply)
        env = self.rig.env(github=github)
        code = collect.collect(self.rig.trial, self.rig.run(self.RID), env, data_dir=os.path.join(self.rig.box.tmp, 'data'))
        out = env.out.getvalue()
        self.assertEqual(code, 0, out)
        self.assertEqual([line for line in out.splitlines() if line.startswith('  note: queue text')], [
            '  note: queue text: acceptances ignored at finish (the recorded gate (2026-11-02T12:00:00.500Z) is later than the first send '
            '(2026-11-02T12:00:00Z), so the text it let through or accepted is not the text the run started on; the queue text is compared '
            'with T0 only)',
            "  note: queue text Q02: changed since this run's gate (changed since the T0 snapshot of 2026-11-02T09:00:00Z: body; this run's "
            "gate cannot be placed at or before the first send, so its acceptances were not used and the text is compared with T0)"])

    def test_a_finish_after_a_start_that_was_never_gated_compares_with_t0(self):
        self.rig.save_state(self.RID, start={'sent_at': 'x'})
        _code, out, _ = self.finish(FakeGitHub(bodies={9001: self.EDITED}))
        self.assertEqual((self.seen('Q01')['since_t0'], self.seen('Q01')['since_gate']), ('changed', 'changed'))
        self.assertIn('(or the run started without a passing gate)', out)

    def test_the_command_line_says_finish_records_the_queue_text(self):
        helped = ' '.join(cli.build_parser().format_help().split())
        self.assertIn('record the end readings, the stop cause and the queue text at the end', helped)

    def test_the_command_line_finish_prints_and_records_it(self):
        self.started()
        env = self.rig.env(github=FakeGitHub(bodies={9001: self.EDITED}))
        code = cli.main(['--trial', self.rig.box.trial_dir, 'finish', self.RID, '--meter', 'codex_weekly_left=48', '--stop', 'queue exhausted'], env=env)
        out = env.out.getvalue()
        self.assertEqual(code, 0, out)
        self.assertIn('queue text at the end of B-cx-r1', out)
        self.assertEqual(self.seen('Q01')['since_gate'], 'changed')
        self.assertEqual(self.seen('Q02')['since_gate'], 'unchanged')


# -- the command line reaches these functions with the right arguments ---------------

class CliWiring(LaunchCase):
    def run_cli(self, *argv, runner=None, github=None):
        env = self.rig.env(runner=runner, github=github)
        code = cli.main(['--trial', self.rig.box.trial_dir, *argv], env=env)
        return code, env.out.getvalue()

    def test_gate_with_accept_open(self):
        code, out = self.run_cli('gate', 'B-cy-r1', '--accept-open', '8710=known and accepted', github=FakeGitHub(issues={8710: 'open'}))
        self.assertEqual(code, 0, out)
        self.assertEqual(self.rig.state('B-cy-r1')['gate']['accepted_open'], {'8710': 'known and accepted'})

    def test_cut_all_pushes_every_base(self):
        code, out = self.run_cli('cut', '--all', '--t0', self.rig.t0, '--push', '--repo-dir', self.rig.seed)
        self.assertEqual(code, 0, out)
        for run in self.rig.trial.runs:
            self.assertRegex(self.rig.branch(run.base), r'^[0-9a-f]{40}$', run.base)

    def test_cut_refuses_a_short_t0(self):
        code, out = self.run_cli('cut', '--run', 'A-cd-r1', '--t0', self.rig.t0[:10], '--repo-dir', self.rig.seed)
        self.assertEqual(code, 2)

    def test_clone_dest_and_skip_install(self):
        self.rig.cut('A-cd-r1')
        dest = self.rig.home('elsewhere', 'clone')
        code, out = self.run_cli('clone', 'A-cd-r1', '--dest', dest, '--skip-install')
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isdir(os.path.join(dest, '.git')))
        self.assertEqual(self.rig.state('A-cd-r1')['clone']['dir'], '~/elsewhere/clone')

    def test_preflight_session_flags(self):
        self.rig.write_home('.chroxy/logs/chroxy.log', PreflightSession.LOG)
        code, out = self.run_cli('preflight', 'A-cy-r1', '--phase', 'session', '--session', 's-1', runner=toolbox(self.rig))
        self.assertEqual(code, 0, out)

    def test_start_meter_flags_and_the_state_override(self):
        state_file = os.path.join(self.rig.box.tmp, 'custom-state.json')
        with open(state_file, 'w') as fh:
            json.dump({'run': 'A-cd-r1', 'gate': passing_gate(self.rig), 'preflight': passing_preflight()}, fh)
        code, out = self.run_cli('start', 'A-cd-r1', '--meter', 'claude_5h_used=5', '--meter', 'claude_weekly_used=30.5',
                                 '--sent-at', '2026-11-02T11:59:00Z', '--state', state_file)
        self.assertEqual(code, 0, out)
        with open(state_file) as fh:
            saved = json.load(fh)
        self.assertEqual(saved['start'], {'sent_at': '2026-11-02T11:59:00Z', 'claude_settings_sha256': None,
                                          'meters': {'claude_5h_used': 5.0, 'claude_weekly_used': 30.5}, 'override': None})

    def test_start_override_flag(self):
        self.rig.save_state('B-cx-r1', gate=passing_gate(self.rig), preflight=passing_preflight())
        code, out = self.run_cli('start', 'B-cx-r1', '--meter', 'codex_weekly_left=55', '--override', 'reset applied')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.rig.state('B-cx-r1')['start']['override'], 'reset applied')

    def test_verify_start_since_flag(self):
        self.rig.save_state('B-cx-r1', start={'sent_at': '2026-11-02T12:00:00Z'})
        path = self.rig.home('.codex', 'sessions', '2026', '11', '02', 'rollout-x.jsonl')
        os.makedirs(os.path.dirname(path))
        with open(path, 'w') as fh:
            fh.write(jl(*codex_rollout(self.rig.clone_dir('B-cx-r1'))))
        old = (SENT - timedelta(hours=3)).timestamp()
        os.utime(path, (old, old))
        self.assertEqual(self.run_cli('verify-start', 'B-cx-r1')[0], 1)
        self.assertEqual(self.run_cli('verify-start', 'B-cx-r1', '--since', '2026-11-02T08:00:00Z')[0], 0)

    def test_finish_flags(self):
        self.rig.save_state('B-cx-r1', start={'sent_at': 'x'})
        code, out = self.run_cli('finish', 'B-cx-r1', '--meter', 'codex_weekly_left=48', '--cost', 'n/a',
                                 '--ended-at', '2026-11-02T20:00:00Z', '--stop', 'queue exhausted')
        self.assertEqual(code, 0, out)
        fin = self.rig.state('B-cx-r1')['finish']
        self.assertEqual((fin['meters'], fin['cost'], fin['ended_at'], fin['stop']),
                         ({'codex_weekly_left': 48.0}, 'n/a', '2026-11-02T20:00:00Z', 'queue exhausted'))

    def test_prepare_flags(self):
        self.rig.cut('A-cd-r1')
        self.rig.claude_settings()
        code, out = self.run_cli('prepare', 'A-cd-r1', '--skip-install', runner=toolbox(self.rig), github=FakeGitHub())
        self.assertEqual(code, 0, out)
        self.assertIn('LAUNCH CARD A-cd-r1', out)


if __name__ == '__main__':
    unittest.main()
