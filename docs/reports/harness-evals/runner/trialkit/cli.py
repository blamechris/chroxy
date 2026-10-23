"""`trialctl` command line. Each subcommand is a thin wrapper over a module function
that takes the loaded trial, the run(s) and an `Env`, and returns an exit code."""
import argparse
import os
import sys

from . import config, render
from .env import Env

RUNNER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_TRIAL = os.path.join(os.path.dirname(RUNNER_DIR), 'trial-2')


def _meters(values):
    meters = {}
    for item in values or []:
        key, sep, value = item.partition('=')
        if not sep:
            raise SystemExit(f'--meter expects KEY=PERCENT, got {item!r}')
        try:
            meters[key] = float(value)
        except ValueError:
            raise SystemExit(f'--meter {key}: {value!r} is not a number') from None
    return meters


def _accept_open(values):
    accepted = {}
    for item in values or []:
        number, sep, reason = item.partition('=')
        if not sep or not number.isdigit() or not reason.strip():
            raise SystemExit(f'--accept-open expects ISSUE=REASON, got {item!r}')
        accepted[int(number)] = reason.strip()
    return accepted


def build_parser():
    p = argparse.ArgumentParser(prog='trialctl', description='Prepare, check and collect controlled harness trial runs.')
    p.add_argument('--trial', default=os.environ.get('TRIALCTL_TRIAL', DEFAULT_TRIAL),
                   help='trial directory or trial.json (default: $TRIALCTL_TRIAL, else ../trial-2)')
    sub = p.add_subparsers(dest='command', required=True)

    s = sub.add_parser('render', help='render missions (and grader prompts) from trial.json')
    s.add_argument('runs', nargs='*', help='run ids (default: all)')
    s.add_argument('--graders', action='store_true', help='also render graders/G-claude.md and G-codex.md')

    sub.add_parser('key-template', help='print the structured answer-key template for the queue')

    s = sub.add_parser('gate', help='entry gate: blockers closed, CI trigger at T0, no other run live')
    s.add_argument('run')
    s.add_argument('--accept-open', action='append', metavar='ISSUE=REASON')
    s.add_argument('--state')

    s = sub.add_parser('cut', help='cut base branches at T0 with the mission as the only commit')
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument('--run', action='append', dest='runs')
    g.add_argument('--all', action='store_true')
    s.add_argument('--t0', required=True)
    s.add_argument('--push', action='store_true', help='push the bases (default: build them locally and print)')
    s.add_argument('--repo-dir', help='local checkout to cut from (default: the repository holding the trial)')

    s = sub.add_parser('clone', help='fresh clone of the run base outside the daemon checkout')
    s.add_argument('run')
    s.add_argument('--dest')
    s.add_argument('--skip-install', action='store_true')
    s.add_argument('--state')

    s = sub.add_parser('preflight', help='check the clone and the harness settings before the send')
    s.add_argument('run')
    s.add_argument('--phase', choices=('pre', 'session'), default='pre')
    s.add_argument('--session', help='Chroxy session id (session phase)')
    s.add_argument('--state')

    s = sub.add_parser('prepare', help='gate + clone + preflight, then print the launch card')
    s.add_argument('run')
    s.add_argument('--accept-open', action='append', metavar='ISSUE=REASON')
    s.add_argument('--skip-install', action='store_true')
    s.add_argument('--state')

    s = sub.add_parser('start', help='record the usage readings and the send; refuses below the allowance floor')
    s.add_argument('run')
    s.add_argument('--meter', action='append', metavar='KEY=PERCENT')
    s.add_argument('--override', metavar='REASON')
    s.add_argument('--sent-at')
    s.add_argument('--state')

    s = sub.add_parser('verify-start', help='read the applied model, effort and mode back from the native transcript')
    s.add_argument('run')
    s.add_argument('--since')
    s.add_argument('--state')

    s = sub.add_parser('finish', help='record the end readings and the stop cause')
    s.add_argument('run')
    s.add_argument('--meter', action='append', metavar='KEY=PERCENT')
    s.add_argument('--cost')
    s.add_argument('--ended-at')
    s.add_argument('--stop')
    s.add_argument('--state')

    s = sub.add_parser('status', help='read-only view of a live run from GitHub (check-run.sh for any trial)')
    s.add_argument('run')
    s.add_argument('--state')

    s = sub.add_parser('collect', help="collect a finished run's GitHub evidence into data/")
    s.add_argument('run')
    s.add_argument('--state')
    s.add_argument('--data')
    s.add_argument('--record', metavar='DIR', help='also write the GitHub responses to DIR as fixtures')
    s.add_argument('--fixtures', metavar='DIR', help='read GitHub responses from DIR instead of the network')

    s = sub.add_parser('apply-verdicts', help="fold a grader's verdicts.json into the evidence")
    s.add_argument('verdicts')
    s.add_argument('--data')

    s = sub.add_parser('disputes', help="list the items where two graders' verdicts differ")
    s.add_argument('a')
    s.add_argument('b')
    s.add_argument('--markdown', action='store_true')

    s = sub.add_parser('verify-key', help='check an unsealed key against KEY-COMMITMENT.md')
    s.add_argument('key')
    return p


def main(argv=None, env=None):
    args = build_parser().parse_args(argv)
    env = env or Env.default()
    try:
        trial = config.load(args.trial)
        return dispatch(trial, args, env)
    except (config.ConfigError, render.RenderError, ValueError) as exc:
        print(f'trialctl: {exc}', file=sys.stderr)
        return 2


def dispatch(trial, args, env):
    c = args.command
    if c == 'render':
        runs = [trial.run(r) for r in args.runs] if args.runs else trial.runs
        for path in render.write_missions(trial, runs):
            env.print('wrote', os.path.relpath(path, trial.root))
        if args.graders:
            for gid, slug, first in (('G-claude', 'claude', 'B'), ('G-codex', 'codex', 'A')):
                path = trial.repo_path('graders', f'{gid}.md')
                with open(path, 'w', encoding='utf-8') as fh:
                    fh.write(render.grader(trial, gid, slug, first))
                env.print('wrote', os.path.relpath(path, trial.root))
        return 0
    if c == 'key-template':
        env.print(render.key_template(trial))
        return 0
    if c in ('gate', 'cut', 'clone', 'preflight', 'prepare', 'start', 'verify-start', 'finish'):
        from . import launch
        if c == 'cut':
            runs = trial.runs if args.all else [trial.run(r) for r in args.runs]
            return launch.cut(trial, runs, env, t0=args.t0, push=args.push, repo_dir=args.repo_dir)
        run = trial.run(args.run)
        if c == 'gate':
            return launch.gate(trial, run, env, accept_open=_accept_open(args.accept_open), state_file=args.state)
        if c == 'clone':
            return launch.clone(trial, run, env, dest=args.dest, skip_install=args.skip_install, state_file=args.state)
        if c == 'preflight':
            return launch.preflight(trial, run, env, phase=args.phase, session=args.session, state_file=args.state)
        if c == 'prepare':
            return launch.prepare(trial, run, env, accept_open=_accept_open(args.accept_open),
                                  skip_install=args.skip_install, state_file=args.state)
        if c == 'start':
            return launch.start(trial, run, env, meters=_meters(args.meter), override=args.override,
                                sent_at=args.sent_at, state_file=args.state)
        if c == 'verify-start':
            return launch.verify_start(trial, run, env, since=args.since, state_file=args.state)
        return launch.finish(trial, run, env, meters=_meters(args.meter), cost=args.cost,
                             ended_at=args.ended_at, stop=args.stop, state_file=args.state)
    if c == 'status':
        from . import status
        return status.status(trial, trial.run(args.run), env, state_file=args.state)
    if c == 'collect':
        from . import collect
        return collect.collect(trial, trial.run(args.run), env, state_file=args.state, data_dir=args.data,
                               record_dir=args.record, fixtures_dir=args.fixtures)
    from . import verdicts
    if c == 'apply-verdicts':
        return verdicts.apply_verdicts(trial, env, args.verdicts, data_dir=args.data)
    if c == 'disputes':
        return verdicts.disputes(trial, env, args.a, args.b, markdown=args.markdown)
    return verdicts.verify_key(trial, env, args.key)
