"""The outside world a command touches, gathered so tests can replace it.

Commands take an `Env` instead of calling subprocess, the clock, `os.environ`
or GitHub directly. `Env.default()` is the real machine; tests build one with a
fake runner, a fixed clock, a temporary home and a `FixtureGitHub`.
"""
import os
import platform
import sys
from dataclasses import dataclass, field

from . import timeutil
from .gh import GitHub
from .proc import Runner


@dataclass
class Env:
    runner: Runner
    github_factory: object  # callable(repo) -> client with get/list/repo_path
    now: object = timeutil.now
    environ: dict = field(default_factory=lambda: dict(os.environ))
    out: object = field(default_factory=lambda: sys.stdout)  # resolved per Env, not at import
    system: str = platform.system()

    @classmethod
    def default(cls):
        runner = Runner()
        return cls(runner=runner, github_factory=lambda repo: GitHub(repo, runner))

    def github(self, repo):
        return self.github_factory(repo)

    def print(self, *parts):
        print(*parts, file=self.out)

    @property
    def home(self):
        return self.environ.get('HOME') or os.path.expanduser('~')

    def expand(self, path):
        """Expand a leading `~` against this Env's HOME (not the process's)."""
        if path and (path == '~' or path.startswith('~/')):
            return self.home + path[1:]
        return path
