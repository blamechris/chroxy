"""Load and validate a trial's `trial.json` and resolve its runs.

A trial directory holds `trial.json` (the roster, queue, harnesses and paths),
`missions/TEMPLATE.md`, `graders/GRADER-PROMPT.md` and `data/`. Everything the
runner does is derived from that one file, so a second trial is a second
directory, not a second copy of the scripts.
"""
import json
import os
import re
from dataclasses import dataclass, field

SCHEMA = 1
FAMILIES = ('claude', 'codex')
RUN_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]*$')
BASE = re.compile(r'^trial/[a-z0-9][a-z0-9./-]*$')
SLOT = re.compile(r'^Q\d{2}$')
QUEUE_RULE_KEYS = {'exclude_labels': str, 'reserved': int, 'exclude_issues': int}


class ConfigError(Exception):
    """trial.json is missing, malformed or inconsistent."""


@dataclass(frozen=True)
class Harness:
    key: str
    code: str
    label: str
    family: str
    chroxy: bool
    invocation: str
    model_aliases: tuple = ()
    expect: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Run:
    id: str
    cell: str
    arm: str
    role: str
    repeat: int
    block: int
    base: str
    model: str
    effort: str
    harness: Harness


@dataclass(frozen=True)
class Slot:
    slot: str
    issue: int
    title: str
    type: str = ''


class Trial:
    """A loaded trial. `root` is the repository root the trial lives in."""

    def __init__(self, path, data, root):
        self.path = os.path.abspath(path)
        self.dir = os.path.dirname(self.path)
        self.root = os.path.abspath(root)
        self.data = data
        self.id = data['id']
        self.repo = data['repo']
        self.trial_dir = data['trial_dir']
        self.t0 = data.get('t0')
        self.cap_hours = data.get('cap_hours', 12)
        self.github_login = data.get('github_login')
        self.paths = data.get('paths', {})
        self.versions = data.get('versions', {})
        self.allowance = data.get('allowance', {})
        self.blockers = {k: list(v) for k, v in data.get('blockers', {}).items()}
        self.prices = data.get('prices')
        self.queue_rules = _queue_rules(data.get('queue_rules'))
        self.harnesses = {k: _harness(k, v) for k, v in data['harnesses'].items()}
        self.cells = {c['id']: c for c in data['cells']}
        self.arms = data['arms']
        self.contrasts = data.get('contrasts', [])
        self.queue_status = data['queue'].get('status', '')
        self.slots = [Slot(s['slot'], int(s['issue']), s['title'], s.get('type', ''))
                      for s in data['queue'].get('slots', [])]
        self.runs = [self._run(r) for r in data['runs']]
        self._validate()

    def _run(self, r):
        cell = self.cells.get(r.get('cell'))
        if cell is None:
            raise ConfigError(f"run {r.get('id')!r}: unknown cell {r.get('cell')!r}")
        arm = self.arms.get(cell['arm'])
        if arm is None:
            raise ConfigError(f"cell {cell['id']!r}: unknown arm {cell['arm']!r}")
        harness = self.harnesses.get(cell['harness'])
        if harness is None:
            raise ConfigError(f"cell {cell['id']!r}: unknown harness {cell['harness']!r}")
        return Run(id=r['id'], cell=cell['id'], arm=cell['arm'], role=cell.get('role', ''),
                   repeat=int(r['repeat']), block=int(r['block']), base=r['base'],
                   model=r.get('model', arm['model']), effort=r.get('effort', arm['effort']),
                   harness=harness)

    def _validate(self):
        if self.data.get('schema') != SCHEMA:
            raise ConfigError(f"schema must be {SCHEMA}, got {self.data.get('schema')!r}")
        seen_ids, seen_bases = set(), set()
        for run in self.runs:
            if not RUN_ID.match(run.id):
                raise ConfigError(f'run id {run.id!r} must be letters, digits and hyphens')
            if not BASE.match(run.base):
                raise ConfigError(f'run {run.id}: base {run.base!r} must be a lower-case trial/ branch')
            if 'eval' in run.base[len('trial/'):]:
                # ci.yml's push trigger excludes the graders' `trial/*eval*` branches; a base named so
                # would get no CI on its merges, and "red CI on the base" would be unobservable.
                raise ConfigError(f'run {run.id}: base {run.base!r} contains "eval"; ci.yml excludes `trial/*eval*` '
                                  'from push CI, and no base may come near that pattern')
            if run.id in seen_ids or run.base in seen_bases:
                raise ConfigError(f'run {run.id}: duplicate run id or base branch')
            seen_ids.add(run.id)
            seen_bases.add(run.base)
        for h in self.harnesses.values():
            if h.family not in FAMILIES:
                raise ConfigError(f'harness {h.key}: family must be one of {FAMILIES}')
        slots, issues = set(), set()
        for s in self.slots:
            if not SLOT.match(s.slot) or s.slot in slots or s.issue in issues:
                raise ConfigError(f'queue slot {s.slot!r} / issue {s.issue}: malformed or duplicate')
            slots.add(s.slot)
            issues.add(s.issue)
        for c in self.contrasts:
            for k in ('native', 'chroxy'):
                if c.get(k) not in self.cells:
                    raise ConfigError(f'contrast {c}: unknown cell {c.get(k)!r}')
        for key in self.blockers:
            if key not in self.harnesses and key != 'all':
                raise ConfigError(f'blockers: unknown harness {key!r}')

    # -- lookups -------------------------------------------------------------

    def run(self, run_id):
        for run in self.runs:
            if run.id == run_id:
                return run
        raise ConfigError(f'no run {run_id!r} in {self.path} (runs: {", ".join(r.id for r in self.runs)})')

    def slot_for_issue(self, issue):
        for s in self.slots:
            if s.issue == issue:
                return s
        return None

    def issue_for_slot(self, slot):
        for s in self.slots:
            if s.slot == slot:
                return s.issue
        return None

    def blockers_for(self, run):
        return sorted(set(self.blockers.get('all', [])) | set(self.blockers.get(run.harness.key, [])))

    def local_path(self, name, home=None):
        """A configured local path with `~` expanded (against `home` when given), or None if unset."""
        value = self.paths.get(name)
        if not value:
            return None
        if home and (value == '~' or value.startswith('~/')):
            return home + value[1:]
        return os.path.expanduser(value)

    def repo_path(self, *parts):
        """A path inside the repository, relative to the trial directory."""
        return os.path.join(self.root, self.trial_dir, *parts)

    def mission_relpath(self, run):
        return f'{self.trial_dir}/missions/{run.id}.md'

    def report_relpath(self, run):
        return f'{self.trial_dir}/runs/{run.id}/REPORT.md'

    def clone_dir(self, run, home=None):
        root = self.local_path('clone_root', home)
        if not root:
            raise ConfigError('paths.clone_root is not set')
        return os.path.join(root, run.id)

    def repo_url(self):
        return f'https://github.com/{self.repo}'

    def clone_source(self, home=None):
        """Where clones come from: `paths.clone_source` (tests point it at a local repo), else GitHub."""
        return self.local_path('clone_source', home) or self.repo_url()


def _queue_rules(rules):
    """`queue_rules` from trial.json: lists of excluded labels, reserved issues and spent issues.

    An unknown key is refused rather than ignored: a misspelt list would filter
    nothing and `queue-candidates` would look as if it had applied it."""
    if rules is None:
        return {}
    if not isinstance(rules, dict):
        raise ConfigError('queue_rules must be an object')
    for key, value in rules.items():
        kind = QUEUE_RULE_KEYS.get(key)
        if kind is None:
            raise ConfigError(f'queue_rules: unknown key {key!r} (known: {", ".join(sorted(QUEUE_RULE_KEYS))})')
        if not isinstance(value, list) or not all(type(v) is kind for v in value):
            raise ConfigError(f'queue_rules.{key} must be a list of {"strings" if kind is str else "issue numbers"}')
    return {key: list(value) for key, value in rules.items()}


def _harness(key, h):
    return Harness(key=key, code=h['code'], label=h['label'], family=h['family'],
                   chroxy=bool(h.get('chroxy')), invocation=h['invocation'],
                   model_aliases=tuple(h.get('model_aliases', ())), expect=dict(h.get('expect', {})))


def find_root(start):
    """The repository root above `start` (the directory holding `.git`)."""
    here = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(here, '.git')):
            return here
        parent = os.path.dirname(here)
        if parent == here:
            raise ConfigError(f'no git repository above {start}')
        here = parent


def load(path, root=None):
    """Load `trial.json` (or the directory holding it)."""
    if os.path.isdir(path):
        path = os.path.join(path, 'trial.json')
    try:
        with open(path, encoding='utf-8') as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        raise ConfigError(f'cannot read {path}: {exc}') from exc
    for key in ('id', 'repo', 'trial_dir', 'harnesses', 'cells', 'arms', 'queue', 'runs'):
        if key not in data:
            raise ConfigError(f'{path}: missing key {key!r}')
    return Trial(path, data, root or find_root(os.path.dirname(os.path.abspath(path))))


def check_t0(trial, sha):
    """Refuse a T0 that differs from the one trial.json already records. Nothing is written."""
    if trial.t0 and trial.t0 != sha:
        raise ConfigError(f'trial.json already records t0 {trial.t0}; refusing to change it to {sha}')


def save_t0(trial, sha):
    """Record T0 in trial.json, refusing to change one already recorded."""
    check_t0(trial, sha)
    trial.data['t0'] = sha
    with open(trial.path, encoding='utf-8') as fh:
        text = fh.read()
    # Rewrite only the t0 value, so the hand-laid-out file keeps its layout and
    # the commit that records T0 is a one-line diff.
    pattern = re.compile(r'^(\s*"t0"\s*:\s*)(null|"[0-9a-f]*")', re.M)
    if len(pattern.findall(text)) == 1:
        text = pattern.sub(lambda m: f'{m.group(1)}"{sha}"', text)
    else:
        text = json.dumps(trial.data, indent=2, ensure_ascii=False) + '\n'
    if json.loads(text) != trial.data:
        raise ConfigError(f'rewriting t0 in {trial.path} would change more than t0; refusing')
    with open(trial.path, 'w', encoding='utf-8') as fh:
        fh.write(text)
    trial.t0 = sha
