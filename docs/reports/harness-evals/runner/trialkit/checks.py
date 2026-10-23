"""Check results and their exit codes.

Every check is PASS, FAIL or UNVERIFIED. UNVERIFIED means the check could not
be made (a file is missing, a command failed, the platform has no such tool);
it is never folded into PASS, because "could not check" and "nothing wrong"
must stay distinguishable (docs/false-safety-guards.md). Exit codes: 0 when
every check passed, 1 when any failed, 2 when none failed but some could not
be verified.
"""
from dataclasses import dataclass, asdict

PASS, FAIL, UNVERIFIED = 'PASS', 'FAIL', 'UNVERIFIED'


@dataclass
class Check:
    name: str
    status: str
    detail: str = ''

    def as_dict(self):
        return asdict(self)


def passed(name, detail=''):
    return Check(name, PASS, detail)


def failed(name, detail=''):
    return Check(name, FAIL, detail)


def unverified(name, detail=''):
    return Check(name, UNVERIFIED, detail)


def exit_code(checks):
    if not checks:
        return 2  # nothing checked is not a pass
    statuses = {c.status for c in checks}
    if FAIL in statuses:
        return 1
    if UNVERIFIED in statuses:
        return 2
    return 0


def render(checks, title=None):
    lines = [title] if title else []
    width = max((len(c.name) for c in checks), default=0)
    for c in checks:
        lines.append(f'  {c.status:<10} {c.name:<{width}}  {c.detail}'.rstrip())
    code = exit_code(checks)
    verdict = {0: 'all checks passed', 1: 'FAILED', 2: 'not verified'}[code]
    counts = {s: sum(1 for c in checks if c.status == s) for s in (PASS, FAIL, UNVERIFIED)}
    lines.append(f'  -> {verdict} ({counts[PASS]} pass, {counts[FAIL]} fail, {counts[UNVERIFIED]} unverified)')
    return '\n'.join(lines)
