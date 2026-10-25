"""Shared test scaffolding: a throwaway repository holding a copy of trial 2,
a scripted subprocess runner and an Env wired to both."""
import io
import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone

from trialkit import config
from trialkit.env import Env
from trialkit.proc import Result

RUNNER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVALS_DIR = os.path.dirname(RUNNER_DIR)
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(EVALS_DIR)))
TRIAL2 = os.path.join(EVALS_DIR, 'trial-2')
OCTOBER = os.path.join(EVALS_DIR, 'trial')
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
TRIAL_REL = 'docs/reports/harness-evals/trial-2'

SLOTS = [
    {'slot': 'Q01', 'issue': 9001, 'title': 'first queue issue', 'type': 'bug, server'},
    {'slot': 'Q02', 'issue': 9002, 'title': 'second queue issue', 'type': 'feature, dashboard'},
]

FIXED_NOW = datetime(2026, 11, 2, 12, 0, 0, tzinfo=timezone.utc)


class Sandbox:
    """A temporary repo root with trial 2 copied in, a fake HOME and local paths."""

    def __init__(self, slots=SLOTS, edit=None):
        self.tmp = tempfile.mkdtemp(prefix='trialctl-test-')
        self.root = os.path.join(self.tmp, 'repo')
        self.home = os.path.join(self.tmp, 'home')
        os.makedirs(os.path.join(self.root, '.git'))
        os.makedirs(self.home)
        self.trial_dir = os.path.join(self.root, TRIAL_REL)
        shutil.copytree(TRIAL2, self.trial_dir)
        with open(os.path.join(self.trial_dir, 'trial.json'), encoding='utf-8') as fh:
            data = json.load(fh)
        data['queue']['slots'] = list(slots)
        if slots:
            data['queue']['size'] = len(slots)  # an empty queue keeps trial 2's own size
        data['queue']['status'] = 'set for tests'
        data['paths'] = {k: v for k, v in data['paths'].items()}
        if edit:
            edit(data)
        self.write_trial(data)

    def write_trial(self, data):
        with open(os.path.join(self.trial_dir, 'trial.json'), 'w', encoding='utf-8') as fh:
            json.dump(data, fh, indent=2)

    def trial(self):
        return config.load(self.trial_dir, root=self.root)

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def env(self, runner=None, github=None):
        out = io.StringIO()
        environ = {'HOME': self.home, 'PATH': os.environ.get('PATH', '')}
        return Env(runner=runner or ScriptedRunner(), github_factory=lambda repo: github,
                   now=lambda: FIXED_NOW, environ=environ, out=out, system='Darwin')


class ScriptedRunner:
    """Answers subprocess calls from a list of (predicate, Result) rules; records every call.

    An unmatched call returns 127, so a test that forgot to script a command sees
    a failure rather than a silent success."""

    def __init__(self, rules=None, passthrough=('git',)):
        self.rules = list(rules or [])
        self.calls = []
        self.passthrough = passthrough

    def on(self, predicate, returncode=0, stdout='', stderr=''):
        self.rules.append((predicate, Result(returncode, stdout, stderr)))
        return self

    def run(self, argv, cwd=None, env=None, timeout=None, input=None):
        self.calls.append({'argv': list(argv), 'cwd': cwd, 'env': env})
        for predicate, result in self.rules:
            if predicate(argv):
                return result
        if argv and argv[0] in self.passthrough:
            p = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout or 120)
            return Result(p.returncode, p.stdout, p.stderr)
        return Result(127, '', f'unscripted command: {argv}')


def argv_starts(*prefix):
    return lambda argv: list(argv[:len(prefix)]) == list(prefix)


def git(cwd, *args, env=None):
    base = {'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 't@example.com',
            'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 't@example.com',
            'HOME': cwd, 'PATH': os.environ.get('PATH', ''), 'GIT_CONFIG_NOSYSTEM': '1'}
    base.update(env or {})
    p = subprocess.run(['git', *args], cwd=cwd, env=base, capture_output=True, text=True)
    if p.returncode != 0:
        raise AssertionError(f'git {args} failed: {p.stderr}')
    return p.stdout.strip()
