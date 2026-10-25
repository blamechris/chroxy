"""Per-run state on the operator's machine: `<paths.state_dir>/<RUN_ID>.json`.

The state file is the run's record of what was prepared, checked and observed:
the clone, every preflight, the send and its allowance readings, the applied
settings read back after the send, and the end readings. It lives outside every
clone (a clone is torn down after the trial), and `trialctl collect` folds it
into the trial's `data/`. Paths under the home directory are written with `~`
so the committed copy does not carry the machine's user name; nothing secret is
ever written here.
"""
import json
import os

from . import timeutil

SECTIONS = ('gate', 'clone', 'preflight', 'start', 'verify_start', 'finish', 'overrides')


def state_path(trial, run_id, override=None, home=None):
    if override:
        if home and (override == '~' or override.startswith('~/')):
            override = home + override[1:]
        return os.path.abspath(os.path.expanduser(override))
    root = trial.local_path('state_dir', home)
    if not root:
        raise ValueError('paths.state_dir is not set in trial.json')
    return os.path.join(root, f'{run_id}.json')


def load(trial, run_id, override=None, home=None):
    path = state_path(trial, run_id, override, home)
    if not os.path.exists(path):
        return {'run': run_id, 'trial': trial.id}
    with open(path, encoding='utf-8') as fh:
        data = json.load(fh)
    if data.get('run') != run_id:
        raise ValueError(f'{path} is the state of run {data.get("run")!r}, not {run_id!r}')
    return data


def save(trial, run_id, data, override=None, home=None, now=None):
    path = state_path(trial, run_id, override, home)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data['updated_at'] = timeutil.iso((now or timeutil.now)())
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(tildify(data, home), fh, indent=2, sort_keys=True, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, path)
    return path


def tildify(value, home=None):
    """Replace the home directory prefix with `~` in every string."""
    home = home or os.path.expanduser('~')
    if isinstance(value, str):
        if value == home:
            return '~'
        return value.replace(home + os.sep, '~' + os.sep)
    if isinstance(value, list):
        return [tildify(v, home) for v in value]
    if isinstance(value, dict):
        return {k: tildify(v, home) for k, v in value.items()}
    return value


def _recorded(trial, exclude=None, home=None):
    """(run id, state) for each run of the trial that has a state file in paths.state_dir. A folder or file that is not
    there holds no state; one that cannot be read (a folder without permission included), or is not a run's state, raises
    OSError or ValueError."""
    root = trial.local_path('state_dir', home)
    if not root:
        return
    for run in trial.runs:
        if run.id == exclude:
            continue
        path = os.path.join(root, f'{run.id}.json')
        try:
            with open(path, encoding='utf-8') as fh:
                data = json.load(fh)
        except FileNotFoundError:
            continue
        if not isinstance(data, dict):
            raise ValueError(f'{path} is not a run state')
        yield run.id, data


def live_runs(trial, exclude=None, home=None):
    """Run ids whose state records a start and no finish (a run in progress)."""
    return [rid for rid, data in _recorded(trial, exclude, home) if data.get('start') and not data.get('finish')]


def started_runs(trial, home=None):
    """Run ids whose state records a start, finished or not."""
    return [rid for rid, data in _recorded(trial, home=home) if data.get('start')]
