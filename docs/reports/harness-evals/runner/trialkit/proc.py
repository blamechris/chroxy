"""Subprocess calls, behind one seam so tests can replace them.

`Runner.run` never raises on a non-zero exit; callers read `returncode` and
decide. A missing executable comes back as returncode 127 with the error in
`stderr`, the shell's own convention, so "the tool is not installed" is a
result a check can report rather than a crash.
"""
import subprocess
from dataclasses import dataclass


@dataclass
class Result:
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self):
        return self.returncode == 0


class Runner:
    def __init__(self, timeout=600):
        self.timeout = timeout

    def run(self, argv, cwd=None, env=None, timeout=None, input=None):
        try:
            p = subprocess.run(argv, cwd=cwd, env=env, input=input, capture_output=True, text=True,
                               timeout=timeout or self.timeout)
        except FileNotFoundError as exc:
            return Result(127, '', str(exc))
        except subprocess.TimeoutExpired as exc:
            return Result(124, exc.stdout or '', f'timed out after {exc.timeout}s')
        return Result(p.returncode, p.stdout, p.stderr)
