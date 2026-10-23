"""gate, cut, clone, preflight, prepare, start, verify-start and finish.

Real temporary git repositories stand in for GitHub (a bare origin holding a T0
commit that carries the trial-2 directory); every other tool (node, gh, claude,
codex, npm, launchctl) is answered by a scripted runner, and every harness file
is written under the sandbox's fake HOME. Nothing here reads or writes the
developer's own home, daemon, transcripts or GitHub.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from datetime import timedelta

import helpers
from helpers import ScriptedRunner, argv_starts
from test_native import assistant, jl, meta, tool_result, turn, user
from trialkit import cli, config, launch, native, render, state, timeutil
from trialkit.gh import GitHubError

CI_OK = "name: CI\non:\n  push:\n    branches: [main, 'trial/**']\n  pull_request:\n"
CI_MAIN_ONLY = "name: CI\non:\n  push:\n    branches: [main]\n"
PROMPTS = {'prime-directive.md': 'prime directive prompt\n', 'full-review.md': 'full review prompt\n'}
SHA_D = 'd' * 40
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


class FakeGitHub:
    repo = 'blamechris/chroxy'

    def __init__(self, issues=None, ci=CI_OK, default='closed'):
        self.issues = {9001: 'open', 9002: 'open'}
        self.issues.update(issues or {})
        self.ci = ci
        self.default = default
        self.requests = []

    def repo_path(self, suffix):
        return f'repos/{self.repo}/{suffix.lstrip("/")}'

    def get(self, path, params=None):
        self.requests.append((path, dict(params or {})))
        m = re.search(r'/issues/(\d+)$', path)
        if m:
            value = self.issues.get(int(m.group(1)), self.default)
            if isinstance(value, Exception):
                raise value
            return {'number': int(m.group(1)), 'state': value}
        if path.endswith('contents/.github/workflows/ci.yml'):
            if isinstance(self.ci, Exception):
                raise self.ci
            return {'content': base64.encodebytes(self.ci.encode()).decode(), 'encoding': 'base64'}
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
        if record_t0:
            config.save_t0(self.trial, self.t0)
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
        return self.box.env(runner=runner or Runner(), github=github)

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


def toolbox(rig, node='v22.11.0\n', login='blamechris\n', claude='2.1.308 (Claude Code)\n',
            launchctl='PID\tStatus\tLabel\n-\t0\tcom.apple.example\n', daemon=SHA_D + '\n',
            codex='codex-cli 0.163.0\n', codex_app='codex-cli 0.163.0\n', prompts=PROMPTS, compile_rc=0):
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


# -- cut ---------------------------------------------------------------------------

class Cut(unittest.TestCase):
    def setUp(self):
        self.rig = Rig(self, record_t0=False)

    def cut(self, *ids, t0=None, push=False, runner=None):
        env = self.rig.env(runner)
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


# -- preflight, before the send ------------------------------------------------------

class PreflightClaudeNative(LaunchCase):
    def setUp(self):
        super().setUp()
        self.run_ = self.prep('A-cd-r1')

    def test_everything_correct_passes_and_the_facts_are_recorded(self):
        code, out, st = self.pre('A-cd-r1')
        self.assertEqual(code, 0, out)
        self.assertTrue(all(s == 'PASS' for s in statuses(st).values()), statuses(st))
        self.assertEqual(set(statuses(st)), {'clone exists', 'clone clean', 'clone matches origin', 'base shape', 'mission file',
                                             'clone identity', 'node version', 'gh login', 'no other run live',
                                             'effort setting', 'claude version'})
        entry = st['preflight'][-1]
        settings = self.rig.home('.claude', 'settings.json')
        with open(settings, 'rb') as fh:
            self.assertEqual(entry['facts']['claude_settings_sha256'], hashlib.sha256(fh.read()).hexdigest())
        self.assertEqual(entry['facts']['head'], self.rig.branch('trial/t2-a-cd-r1'))
        self.assertEqual((entry['phase'], entry['at'], entry['facts']['claude_version']), ('pre', '2026-11-02T12:00:00Z', '2.1.308'))
        self.assertEqual(entry['facts']['clone_dir'], '~/trial/t2/A-cd-r1')

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
        self.rig.save_state('B-cy-r1', preflight=[{'phase': 'pre', 'at': 'x', 'checks': [], 'facts': {'daemon_commit': commit}}])

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
    def go(self, rid='A-cd-r1', gh=None, runner=None):
        env = self.rig.env(runner or toolbox(self.rig), github=gh or FakeGitHub())
        code = launch.prepare(self.rig.trial, self.rig.run(rid), env, {}, True, None)
        return code, env.out.getvalue(), env

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


class Start(LaunchCase):
    CLAUDE_OK = {'claude_5h_used': 5.0, 'claude_weekly_used': 30.0}

    def go(self, rid='A-cd-r1', meters=None, override=None, sent_at=None):
        env = self.rig.env()
        code = launch.start(self.rig.trial, self.rig.run(rid), env, meters if meters is not None else self.CLAUDE_OK,
                            override, sent_at, None)
        return code, env.out.getvalue()

    def test_records_the_send_and_the_readings(self):
        self.rig.save_state('A-cd-r1', preflight=passing_preflight())
        code, out = self.go()
        self.assertEqual(code, 0, out)
        self.assertIn('send the invocation now', out)
        self.assertEqual(self.rig.state('A-cd-r1')['start'],
                         {'sent_at': '2026-11-02T12:00:00Z', 'meters': self.CLAUDE_OK, 'override': None})

    def test_a_given_send_time_is_normalised_and_a_bad_one_is_refused(self):
        self.rig.save_state('A-cd-r1', preflight=passing_preflight())
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
        self.rig.save_state('A-cd-r1', preflight=bad)
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('effort setting FAIL', out)

    def test_an_unverified_preflight_is_not_a_passed_one(self):
        pre = passing_preflight()
        pre[0]['checks'].append({'name': 'node version', 'status': 'UNVERIFIED', 'detail': ''})
        self.rig.save_state('A-cd-r1', preflight=pre)
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('node version UNVERIFIED', out)

    def test_only_the_latest_pre_preflight_counts_and_a_session_phase_is_not_one(self):
        bad = passing_preflight()[0]
        bad['checks'][0]['status'] = 'FAIL'
        later_pass = dict(passing_preflight()[0], at='2026-11-02T11:45:00Z')
        session = {'phase': 'session', 'at': 'y', 'checks': [{'name': 's', 'status': 'FAIL', 'detail': ''}], 'facts': {}}
        self.rig.save_state('A-cd-r1', preflight=[bad, later_pass, session])
        code, out = self.go()
        self.assertEqual(code, 0, out)

    def test_an_override_goes_past_a_failed_preflight_and_is_recorded(self):
        bad = passing_preflight()
        bad[0]['checks'][0]['status'] = 'FAIL'
        self.rig.save_state('A-cd-r1', preflight=bad)
        code, out = self.go(override='owner checked it by hand')
        self.assertEqual(code, 0, out)
        st = self.rig.state('A-cd-r1')
        self.assertEqual(st['start']['override'], 'owner checked it by hand')
        self.assertEqual(st['overrides'][-1]['kind'], 'start')
        self.assertIn('did not pass', st['overrides'][-1]['bypassed'][0])

    def test_a_codex_run_at_60_percent_is_refused_and_at_100_is_started(self):
        self.rig.save_state('B-cx-r1', preflight=passing_preflight())
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
        self.rig.save_state('B-cx-r1', preflight=passing_preflight())
        code, out = self.go('B-cx-r1', {'codex_weekly_left': 60.0}, override='owner applied a reset')
        self.assertEqual(code, 0, out)
        recorded = self.rig.state('B-cx-r1')['overrides'][-1]
        self.assertEqual(recorded['reason'], 'owner applied a reset')
        self.assertIn('codex_weekly_left is 60', recorded['bypassed'][0])

    def test_claude_meters_above_the_ceilings_are_refused(self):
        self.rig.save_state('A-cd-r1', preflight=passing_preflight())
        code, out = self.go(meters={'claude_5h_used': 25.0, 'claude_weekly_used': 30.0})
        self.assertEqual(code, 1)
        self.assertIn('claude_5h_used is 25, above the ceiling of 20', out)
        code, out = self.go(meters={'claude_5h_used': 5.0, 'claude_weekly_used': 71.0})
        self.assertEqual(code, 1)
        self.assertIn('claude_weekly_used', out)
        code, _ = self.go(meters={'claude_5h_used': 20.0, 'claude_weekly_used': 70.0})
        self.assertEqual(code, 0)

    def test_missing_meters_exit_2_and_name_the_flags_to_pass(self):
        self.rig.save_state('A-cd-r1', preflight=passing_preflight())
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
        self.rig.save_state('A-cd-r1', preflight=passing_preflight())
        code, out = self.go(meters={'claude_5h_used': 600.0, 'claude_weekly_used': 30.0})
        self.assertEqual(code, 2)

    def test_another_live_run_refuses_even_with_an_override(self):
        self.rig.save_state('B-cx-r1', start={'sent_at': 'x'})
        self.rig.save_state('A-cd-r1', preflight=passing_preflight())
        code, out = self.go(override='please')
        self.assertEqual(code, 1)
        self.assertIn('B-cx-r1', out)

    def test_a_second_start_is_refused_unless_overridden(self):
        self.rig.save_state('A-cd-r1', preflight=passing_preflight())
        self.go()
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn('already recorded', out)
        code, out = self.go(override='typed the wrong reading', sent_at='2026-11-02T12:01:00Z')
        self.assertEqual(code, 0, out)
        start = self.rig.state('A-cd-r1')['start']
        self.assertEqual((start['sent_at'], start['replaces']['sent_at']), ('2026-11-02T12:01:00Z', '2026-11-02T12:00:00Z'))

    def test_an_allowance_floor_missing_from_trial_json_blocks_rather_than_passes(self):
        self.rig.save_state('A-cd-r1', preflight=passing_preflight())
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
            json.dump({'run': 'A-cd-r1', 'preflight': passing_preflight()}, fh)
        code, out = self.run_cli('start', 'A-cd-r1', '--meter', 'claude_5h_used=5', '--meter', 'claude_weekly_used=30.5',
                                 '--sent-at', '2026-11-02T11:59:00Z', '--state', state_file)
        self.assertEqual(code, 0, out)
        with open(state_file) as fh:
            saved = json.load(fh)
        self.assertEqual(saved['start'], {'sent_at': '2026-11-02T11:59:00Z',
                                          'meters': {'claude_5h_used': 5.0, 'claude_weekly_used': 30.5}, 'override': None})

    def test_start_override_flag(self):
        self.rig.save_state('B-cx-r1', preflight=passing_preflight())
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
