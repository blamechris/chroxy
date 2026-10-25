"""The collector against October's real GitHub responses, and the rules it must keep.

`OctoberGolden` (B1-cx, Codex desktop) and `OctoberGoldenA1` (A1-cd, Claude desktop, whose owner
comments include smoke-only ones) replay recorded responses (fixtures/october/github-<run>, taken
through collect's own --record path) and require the evidence to equal what G-codex computed by hand
for every field measures.py reads. The synthetic tests use an in-memory GitHub and the trial-2 sandbox.
"""
import base64
import io
import json
import os
import re
import shutil
import tempfile
import unittest

import helpers
from trialkit import collect, config
from trialkit.env import Env
from trialkit.gh import GitHubError

OCT_FX = os.path.join(helpers.FIXTURES, 'october')
START = '2026-11-02T10:00:00Z'


def read_json(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(value, fh, indent=2)


# -- October golden ------------------------------------------------------------

class OctoberBox:
    """A throwaway repo root holding October's trial.json, the way it sits in the repository."""

    def __init__(self, trial_file='trial.json'):
        self.tmp = tempfile.mkdtemp(prefix='trialctl-oct-')
        self.root = os.path.join(self.tmp, 'repo')
        self.trial_dir = os.path.join(self.root, 'docs', 'reports', 'harness-evals', 'trial')
        os.makedirs(os.path.join(self.root, '.git'))
        os.makedirs(self.trial_dir)
        shutil.copy(os.path.join(OCT_FX, trial_file), os.path.join(self.trial_dir, 'trial.json'))
        self.data = os.path.join(self.tmp, 'data')
        self.out = io.StringIO()

    def trial(self):
        return config.load(self.trial_dir, root=self.root)

    def env(self):
        return Env(runner=helpers.ScriptedRunner(), github_factory=lambda repo: None, now=lambda: helpers.FIXED_NOW,
                   environ={'HOME': self.tmp, 'PATH': os.environ.get('PATH', '')}, out=self.out, system='Darwin')


class GoldenComparisons:
    """The comparisons every recorded October run must pass; subclasses name the run and its files."""
    RUN = TRIAL_FILE = EVIDENCE = None
    # every field measures.py reads, per PR
    PR_FIELDS = ('issue', 'state', 'merged_at', 'cycle_minutes', 'copilot_review_bodies',
                 'owner_review_comment_bodies', 'owner_all_comment_bodies', 'diff_added', 'diff_deleted',
                 'forbidden_closing_keyword', 'pr_body_issue_references')
    # the rest of the October PR record that collect also reproduces
    PR_EXTRA = ('head_branch', 'head_sha', 'opened_at', 'merge_sha', 'owner_formal_review_bodies',
                'review_comment_ids', 'copilot_review_ids', 'ci_run_count', 'ci_attempt_count',
                'all_pr_workflow_run_count')
    RUN_FIELDS = ('start', 'queue_cutoff', 'report_merged_or_cutoff', 'queue_ci_runs', 'queue_ci_attempts',
                  'queue_all_pr_workflow_runs')
    RUN_EXTRA = ('base_tip', 'T0', 'wall_minutes', 'base_push_actions', 'merged_queue_prs', 'merged_ci_runs',
                 'median_cycle_minutes', 'p90_cycle_minutes', 'wall_to_report_commit_minutes')

    @classmethod
    def setUpClass(cls):
        cls.box = OctoberBox(cls.TRIAL_FILE)
        cls.trial = cls.box.trial()
        cls.code = collect.collect(cls.trial, cls.trial.run(cls.RUN), cls.box.env(),
                                   state_file=os.path.join(OCT_FX, f'state-{cls.RUN}.json'), data_dir=cls.box.data,
                                   fixtures_dir=os.path.join(OCT_FX, f'github-{cls.RUN}'))
        cls.doc = read_json(os.path.join(cls.box.data, 'evidence', f'{cls.RUN}.json'))
        cls.mine = cls.doc['runs'][cls.RUN]
        cls.october = read_json(os.path.join(helpers.OCTOBER, 'data', cls.EVIDENCE))['runs'][cls.RUN]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.box.tmp, ignore_errors=True)

    def test_collect_succeeds_from_fixtures_alone(self):
        self.assertEqual(self.code, 0, self.box.out.getvalue())

    def test_run_level_fields_equal_the_october_evidence(self):
        for key in self.RUN_FIELDS + self.RUN_EXTRA:
            # queue_cutoff exists only where the supervisor set one (B1-cx); absent on both sides otherwise
            self.assertEqual(self.mine.get(key), self.october.get(key), key)
        self.assertIn('start', self.mine)
        self.assertEqual(self.mine['report_last_commit']['committer_date'],
                         self.october['report_last_commit']['committer_date'])
        self.assertEqual(self.mine['report_last_commit']['sha'], self.october['report_last_commit']['sha'])

    def test_every_pr_matches_by_number(self):
        mine = {p['pr']: p for p in self.mine['prs']}
        october = {p['pr']: p for p in self.october['prs']}
        self.assertEqual(sorted(mine), sorted(october))
        for number, theirs in october.items():
            for key in self.PR_FIELDS:
                self.assertIn(key, theirs)
                self.assertEqual(mine[number][key], theirs[key], f'PR {number} {key}')
            for key in self.PR_EXTRA:
                if key in theirs:  # October left the workflow count off the report PR
                    self.assertEqual(mine[number][key], theirs[key], f'PR {number} {key}')

    def test_ci_runs_are_the_same_runs(self):
        for theirs in self.october['prs']:
            mine = next(p for p in self.mine['prs'] if p['pr'] == theirs['pr'])
            self.assertEqual(sorted(r['id'] for r in mine['ci_runs']), sorted(r['id'] for r in theirs['ci_runs']))
            self.assertEqual(sorted((r['id'], r['conclusion'], r['run_attempt']) for r in mine['ci_runs']),
                             sorted((r['id'], r['conclusion'], r['run_attempt']) for r in theirs['ci_runs']))


class OctoberGolden(GoldenComparisons, unittest.TestCase):
    RUN, TRIAL_FILE, EVIDENCE = 'B1-cx', 'trial.json', 'G-codex-EVIDENCE-B.json'

    def test_known_differences_from_october(self):
        # 1. October's strict verdicts were typed in by the grader; collect leaves the field for apply-verdicts.
        self.assertEqual(self.october['strict_key_delivered'], 8)
        self.assertIsNone(self.mine['strict_key_delivered'])
        self.assertTrue(all(p['correct_vs_key'] is None for p in self.mine['prs']))
        # 2. October kept GitHub's newest-first order for ci_runs; collect sorts oldest first.
        pr = next(p for p in self.mine['prs'] if p['pr'] == 8672)
        self.assertEqual([r['conclusion'] for r in pr['ci_runs']], ['failure', 'success'])
        self.assertEqual([r['conclusion'] for r in next(p for p in self.october['prs'] if p['pr'] == 8672)['ci_runs']],
                         ['success', 'failure'])
        # 3. October gave the report PR no workflow count; collect has one.
        report = next(p for p in self.mine['prs'] if p['pr'] == 8673)
        self.assertEqual(report['all_pr_workflow_run_count'], 3)
        self.assertNotIn('all_pr_workflow_run_count', next(p for p in self.october['prs'] if p['pr'] == 8673))

    def test_the_merge_gate_pattern_alone_does_not_reproduce_the_review_column(self):
        # The Claude merge gate's pattern (Code Review|...|Approve|Verdict) matches 2 of the 16 owner review
        # bodies G-codex counted in this Codex run, whose comments say "approve" and "clean". The review column
        # therefore counts every non-smoke owner comment, as October did; the pattern count is kept apart.
        queue = [p for p in self.mine['prs'] if p['issue'] is not None]
        self.assertEqual(sum(p['owner_review_comment_bodies'] for p in queue), 16)
        self.assertEqual(sum(p['owner_gate_pattern_comment_bodies'] for p in queue), 2)

    def test_the_closed_unmerged_pr_and_the_report_pr_are_handled_as_october_did(self):
        by = {p['pr']: p for p in self.mine['prs']}
        self.assertEqual((by[8671]['state'], by[8671]['merged_at'], by[8671]['cycle_minutes']), ('closed', None, None))
        self.assertIsNone(by[8671]['diff_added'])
        self.assertEqual((by[8673]['issue'], by[8673]['slot'], by[8673]['state']), (None, None, 'merged'))
        self.assertEqual({by[8671]['issue'], by[8672]['issue']}, {8303})
        self.assertEqual(self.mine['merged_queue_prs'], 9)  # the report PR is not a queue PR

    def test_trial_closes_bodies_map_to_slots(self):
        by = {p['pr']: p for p in self.mine['prs']}
        self.assertEqual((by[8662]['issue'], by[8662]['slot']), (7771, 'Q03'))
        self.assertEqual((by[8666]['issue'], by[8666]['slot']), (8233, 'Q01'))

    def test_new_run_level_fields(self):
        # ci.yml at T0 runs on push to main only, so red CI on the base is not observable: null, not 0.
        self.assertIs(self.mine['ci_push_observable'], False)
        self.assertIsNone(self.mine['red_ci_on_base'])
        self.assertEqual(self.mine['base_push_ci'], [])
        october_events = read_json(os.path.join(helpers.OCTOBER, 'data', 'G-codex-EVIDENCE-A.json'))[
            'observed_trial_timeline_events']
        queue = {s.issue for s in self.trial.slots}
        expected = [e for e in october_events
                    if self.mine['start'] <= e['at'] <= self.mine['report_merged_or_cutoff'] and e['issue'] in queue]
        self.assertEqual(len(expected), 1)
        self.assertEqual(self.mine['timeline_events'], [
            {'issue': expected[0]['issue'], 'event': 'cross-referenced', 'at': expected[0]['at'],
             'actor': expected[0]['actor'], 'source_pr': expected[0]['source_pr'], 'source_in_run': True}])

    def test_runs_json_and_tiebreaks_are_created(self):
        runs = read_json(os.path.join(self.box.data, 'runs.json'))
        self.assertEqual(runs['queue'], [8233, 8215, 7771, 8595, 8364, 8282, 8277, 8567, 8303, 7815])
        self.assertEqual(runs['T0'], '932bd3a4ef40bc9634cab390e6cf0facadd801d7')
        self.assertEqual((runs['order'], runs['evidence_files']), (['B1-cx'], ['evidence/B1-cx.json']))
        self.assertEqual(runs['cells'], {'B-native': {'arm': 'B', 'harness': 'CX - Codex desktop app',
                                                      'role': 'controlled native'}})
        meta = runs['runs']['B1-cx']
        self.assertEqual((meta['arm'], meta['cell'], meta['repeat'], meta['block']), ('B', 'B-native', 1, 1))
        self.assertEqual((meta['coordinator'], meta['date'], meta['send']), ('gpt-6-astra / xhigh', '2026-10-18',
                                                                             '2026-10-18T18:32:41Z'))
        self.assertEqual(read_json(os.path.join(self.box.data, 'tiebreaks.json')),
                         {'source': 'none yet', 'overrides': [], 'conventions': {}})

    def test_evidence_header(self):
        self.assertEqual((self.doc['trial'], self.doc['run']), ('october', 'B1-cx'))
        self.assertEqual(self.doc['collected_at_utc'], '2026-11-02T12:00:00Z')
        self.assertIn('window', self.doc['methods'])

    def test_a_replay_that_misses_a_request_fails_loudly(self):
        tmp = tempfile.mkdtemp(prefix='trialctl-oct-partial-')
        self.addCleanup(shutil.rmtree, tmp, True)
        src = os.path.join(OCT_FX, 'github-B1-cx')
        for name in os.listdir(src):
            if 'issues_8662_comments' not in name:
                shutil.copy(os.path.join(src, name), tmp)
        box = OctoberBox()
        self.addCleanup(shutil.rmtree, box.tmp, True)
        trial = box.trial()
        code = collect.collect(trial, trial.run(self.RUN), box.env(), state_file=os.path.join(OCT_FX, 'state-B1-cx.json'),
                               data_dir=box.data, fixtures_dir=tmp)
        self.assertEqual(code, 2)
        self.assertIn('no fixture for', box.out.getvalue())
        self.assertFalse(os.path.exists(os.path.join(box.data, 'evidence')))


class OctoberGoldenA1(GoldenComparisons, unittest.TestCase):
    RUN, TRIAL_FILE, EVIDENCE = 'A1-cd', 'trial-A1-cd.json', 'G-codex-EVIDENCE-A.json'

    def test_the_smoke_only_owner_comments_are_excluded_as_october_did(self):
        # A Claude run's PRs carry owner smoke-evidence comments beside the review comments; G-codex excluded
        # them by hand. Five PRs differ, one comment each, and the field comparisons above pin every count.
        by = {p['pr']: p for p in self.mine['prs']}
        differ = {n: (p['owner_review_comment_bodies'], p['owner_all_comment_bodies'])
                  for n, p in by.items() if p['owner_review_comment_bodies'] != p['owner_all_comment_bodies']}
        self.assertEqual(differ, {8632: (1, 2), 8633: (1, 2), 8635: (1, 2), 8639: (2, 3), 8640: (1, 2)})

    def test_the_report_pr_and_queue_totals(self):
        by = {p['pr']: p for p in self.mine['prs']}
        self.assertEqual((by[8642]['issue'], by[8642]['state']), (None, 'merged'))
        self.assertEqual((self.mine['merged_queue_prs'], self.mine['queue_ci_runs'],
                          self.mine['queue_all_pr_workflow_runs']), (10, 21, 53))


# -- an in-memory GitHub for the synthetic scenarios ---------------------------

REPO = 'blamechris/chroxy'
P = f'repos/{REPO}/'


class FakeGitHub:
    """Routes are (regex on the path after repos/<repo>/, response or callable(params)); first match wins."""
    repo = REPO

    def __init__(self):
        self.routes = []
        self.requests = []

    def route(self, pattern, response):
        self.routes.append((re.compile(pattern), response))
        return self

    def repo_path(self, suffix):
        return f'{P}{suffix.lstrip("/")}'

    def _answer(self, path, params):
        self.requests.append((path, dict(params or {})))
        short = path.split(P, 1)[-1]
        for pattern, response in self.routes:
            if pattern.search(short):
                result = response(dict(params or {})) if callable(response) else response
                if isinstance(result, Exception):
                    raise result
                return result
        raise GitHubError(f'unscripted request {short}', 404)

    def get(self, path, params=None):
        return self._answer(path, params)

    def list(self, path, params=None, key=None):
        return self._answer(path, params)

    def asked(self, pattern):
        return [p for p, _ in self.requests if re.search(pattern, p)]


def pr(number, body, created, merged=None, closed=None, ref=None):
    return {'number': number, 'state': 'closed' if (merged or closed) else 'open', 'body': body,
            'created_at': created, 'merged_at': merged, 'closed_at': merged or closed,
            'merge_commit_sha': f'm{number}' if merged else None,
            'head': {'ref': ref or f'br/{number}', 'sha': f'h{number}'},
            'user': {'login': 'blamechris', 'type': 'User'}}


def wf(run_id, created, path='.github/workflows/ci.yml', conclusion='success', attempt=1, event='pull_request'):
    return {'id': run_id, 'name': 'CI' if path.endswith('ci.yml') else 'Other', 'path': path, 'head_sha': 'h',
            'created_at': created, 'conclusion': conclusion, 'run_attempt': attempt, 'event': event,
            'status': 'completed'}


def review(review_id, login, body, at, user_type='User', state='COMMENTED'):
    return {'id': review_id, 'user': {'login': login, 'type': user_type}, 'body': body, 'state': state,
            'submitted_at': at}


def comment(comment_id, login, body, at):
    return {'id': comment_id, 'user': {'login': login, 'type': 'User'}, 'body': body, 'created_at': at}


COPILOT = 'copilot-pull-request-reviewer[bot]'
CI_PUSH_MAIN = 'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n'
CI_PUSH_TRIAL = "name: CI\non:\n  push:\n    branches: [main, 'trial/**']\n  pull_request:\n"


def ci_contents(text):
    return {'content': base64.b64encode(text.encode()).decode(), 'encoding': 'base64'}


class Scenario(unittest.TestCase):
    """A run with a mapped merged PR, a mapped closed PR, a Trial-Closes PR and a report PR."""
    report_path = 'docs/reports/harness-evals/trial-2/runs/A-cd-r1/REPORT.md'

    def setUp(self):
        self.box = helpers.Sandbox()
        self.addCleanup(self.box.cleanup)
        self.state_dir = os.path.join(self.box.home, 'trial', 't2', 'state')
        self.write_state({'start': {'sent_at': START}})

    def write_state(self, body):
        body = dict(body, run='A-cd-r1', trial='t2')
        write_json(os.path.join(self.state_dir, 'A-cd-r1.json'), body)

    def github(self, ci_text=CI_PUSH_MAIN, push_runs=(), edit=None):
        runs = {
            'br/101': [wf(1, '2026-11-02T10:06:00Z'),                                  # in window
                       wf(2, '2026-10-30T09:00:00Z'),                                  # an earlier run reused the name
                       wf(3, '2026-11-03T01:00:00Z'),                                  # long after the window
                       wf(4, '2026-11-02T10:07:00Z', path='.github/workflows/repo-relay.yml'),
                       wf(5, '2026-11-02T10:36:00Z', path='.github/workflows/repo-relay.yml')],  # after the merge
            'br/102': [wf(6, '2026-11-02T10:20:00Z', conclusion='failure', attempt=2),
                       wf(7, '2026-11-02T10:40:00Z', conclusion='cancelled')],
            'br/103': [wf(8, '2026-11-02T10:50:00Z')],
            'br/104': [wf(9, '2026-11-02T11:20:00Z')],
        }
        fake = FakeGitHub()
        prs = [pr(101, 'Fix.\n\nTrial-Item: Q01\n', '2026-11-02T10:05:00Z', merged='2026-11-02T10:35:00Z'),
               pr(102, 'Tried.\n\nTrial-Item: Q02\nFixes #123\nsee #9002 and #77 and #77', '2026-11-02T10:10:00Z',
                  closed='2026-11-02T10:45:00Z'),
               pr(103, 'Trial-Closes: 9001\n', '2026-11-02T10:48:00Z', merged='2026-11-02T10:55:00Z'),
               pr(104, 'Report.\n', '2026-11-02T11:00:00Z', merged='2026-11-02T11:30:00Z')]
        if edit:
            edit(prs, runs)
        fake.route(r'^pulls$', prs)
        fake.route(r'^pulls/101/reviews$', [
            review(11, COPILOT, 'Copilot found nothing.', '2026-11-02T10:08:00Z', 'Bot'),
            review(12, COPILOT, '', '2026-11-02T10:09:00Z', 'Bot'),                       # blank: excluded
            review(13, 'blamechris', 'Owner formal review text', '2026-11-02T10:30:00Z'),
            review(14, COPILOT, 'Late Copilot review', '2026-11-04T00:00:00Z', 'Bot'),    # outside the window
            review(15, 'someone-else', 'A third party', '2026-11-02T10:31:00Z')])
        fake.route(r'^issues/101/comments$', [
            comment(21, 'blamechris', 'Independent review: approve, no blockers.', '2026-11-02T10:20:00Z'),
            comment(22, 'blamechris', '### Smoke (isolated daemon)\n| step | Verdict |\n|---|---|\n| load | PASS |',
                    '2026-11-02T10:25:00Z'),
            comment(23, 'blamechris', '   ', '2026-11-02T10:26:00Z'),
            comment(24, 'someone-else', 'LGTM', '2026-11-02T10:27:00Z'),
            comment(25, 'blamechris', 'LGTM, merging', '2026-11-02T10:34:00Z'),
            comment(26, 'blamechris', 'Afterword added days later', '2026-11-06T10:00:00Z')])  # outside the window
        fake.route(r'^issues/\d+/comments$', [])
        fake.route(r'^pulls/\d+/reviews$', [])
        fake.route(r'^pulls/104/files$', [{'filename': 'README.md'}, {'filename': self.report_path}])
        fake.route(r'^pulls/\d+/files$', [{'filename': 'packages/server/src/x.js'}])
        fake.route(r'^pulls/104/commits$', [
            {'sha': 'c1', 'commit': {'committer': {'date': '2026-11-02T11:10:00Z'}}},
            {'sha': 'c2', 'commit': {'committer': {'date': '2026-11-02T11:25:00Z'}}}])
        fake.route(r'^actions/runs$', lambda params: (push_runs if params.get('event') == 'push'
                                                      else runs.get(params.get('branch'), [])))
        fake.route(r'^commits/m101$', {'stats': {'additions': 30, 'deletions': 4}})
        fake.route(r'^commits/m103$', {'stats': {'additions': 5, 'deletions': 5}})
        fake.route(r'^commits/m104$', {'stats': {'additions': 50, 'deletions': 0}})
        fake.route(r'^commits/m\d+$', {'stats': {'additions': 1, 'deletions': 1}})
        fake.route(r'^git/ref/heads/', {'object': {'sha': 'basetip'}})
        fake.route(r'^compare/main\.\.\.', {'merge_base_commit': {'sha': 'T0FROMCOMPARE'}})
        fake.route(r'^contents/\.github/workflows/ci\.yml$', ci_contents(ci_text))
        fake.route(r'^issues/9001/timeline$', [
            {'event': 'cross-referenced', 'created_at': '2026-11-02T10:12:00Z', 'actor': {'login': 'Copilot'},
             'source': {'issue': {'number': 101, 'pull_request': {}}}},
            {'event': 'cross-referenced', 'created_at': '2026-11-02T10:13:00Z', 'actor': {'login': 'Copilot'},
             'source': {'issue': {'number': 999, 'pull_request': {}}}},        # a PR of some other run
            {'event': 'labeled', 'created_at': '2026-11-02T10:14:00Z', 'actor': {'login': 'blamechris'}},
            {'event': 'mentioned', 'created_at': '2026-10-20T10:14:00Z', 'actor': {'login': 'blamechris'}},
            {'event': 'referenced', 'created_at': '2026-11-02T10:15:00Z', 'actor': {'login': 'blamechris'}}])
        fake.route(r'^issues/\d+/timeline$', [])
        return fake

    def collect(self, github=None, data=None, **kwargs):
        env = self.box.env(github=github or self.github())
        trial = self.box.trial()
        self.data = data or os.path.join(self.box.tmp, 'data')
        self.code = collect.collect(trial, trial.run('A-cd-r1'), env, data_dir=self.data, **kwargs)
        self.output = env.out.getvalue()
        path = os.path.join(self.data, 'evidence', 'A-cd-r1.json')
        self.run_obj = read_json(path)['runs']['A-cd-r1'] if os.path.exists(path) else None
        return self.run_obj

    def pr_of(self, number):
        return next(p for p in self.run_obj['prs'] if p['pr'] == number)


class Mapping(Scenario):
    def test_trial_item_trial_closes_and_unmapped(self):
        ev = self.collect()
        self.assertEqual(self.code, 0, self.output)
        self.assertEqual([(p['pr'], p['issue'], p['slot']) for p in ev['prs']],
                         [(101, 9001, 'Q01'), (102, 9002, 'Q02'), (103, 9001, 'Q01'), (104, None, None)])

    def test_a_trial_item_naming_an_unknown_slot_is_unmapped_and_not_taken_for_a_closes(self):
        def edit(prs, runs):
            prs[0]['body'] = 'Trial-Item: Q07\nTrial-Closes: 9001\n'
        ev = self.collect(self.github(edit=edit))
        self.assertIsNone(self.pr_of(101)['issue'])
        self.assertIn('Q07', self.output)
        self.assertNotIn('maps to no queue slot', self.output)  # already said why; not said twice
        self.assertEqual(ev['merged_queue_prs'], 1)

    def test_a_trial_closes_naming_a_non_queue_issue_is_unmapped(self):
        def edit(prs, runs):
            prs[2]['body'] = 'Trial-Closes: 4242\n'
        self.collect(self.github(edit=edit))
        self.assertIsNone(self.pr_of(103)['issue'])

    def test_a_body_naming_two_slots_is_unmapped(self):
        def edit(prs, runs):
            prs[0]['body'] = 'Trial-Item: Q01\nTrial-Item: Q02\n'
        self.collect(self.github(edit=edit))
        self.assertIsNone(self.pr_of(101)['issue'])
        self.assertIn('several slots', self.output)

    def test_a_bare_issue_number_in_the_body_does_not_map(self):
        def edit(prs, runs):
            prs[0]['body'] = 'This is about #9001 and 9001.'
        self.collect(self.github(edit=edit))
        self.assertIsNone(self.pr_of(101)['issue'])


class ReportPr(Scenario):
    def test_the_report_pr_is_the_unmapped_pr_that_adds_the_run_report(self):
        ev = self.collect()
        self.assertEqual(ev['report_merged_or_cutoff'], '2026-11-02T11:30:00Z')
        self.assertEqual(ev['report_last_commit'], {'sha': 'c2', 'committer_date': '2026-11-02T11:25:00Z'})
        self.assertEqual(ev['wall_minutes'], 90.0)
        self.assertEqual(ev['wall_to_report_commit_minutes'], 85.0)
        self.assertIn('report PR: #104', self.output)

    def test_files_are_fetched_only_for_unmapped_prs(self):
        fake = self.github()
        self.collect(fake)
        self.assertEqual(fake.asked(r'pulls/\d+/files'), [P + 'pulls/104/files'])
        self.assertEqual(fake.asked(r'pulls/\d+/commits'), [P + 'pulls/104/commits'])

    def test_an_unmapped_pr_that_is_not_the_report_is_flagged_and_does_not_end_the_window(self):
        def edit(prs, runs):
            prs.append(pr(105, 'Stray.\n', '2026-11-02T11:40:00Z', merged='2026-11-02T11:45:00Z'))
        fake = self.github(edit=edit)
        ev = self.collect(fake)
        self.assertEqual(ev['report_merged_or_cutoff'], '2026-11-02T11:30:00Z')
        self.assertIn('PR 105 maps to no queue slot and is not the report PR', self.output)
        self.assertEqual(self.pr_of(105)['issue'], None)

    def test_no_report_pr_uses_the_recorded_end(self):
        self.write_state({'start': {'sent_at': START}, 'finish': {'ended_at': '2026-11-02T10:58:00Z'}})
        fake = self.github(edit=lambda prs, runs: prs.pop())
        ev = self.collect(fake)
        self.assertEqual(ev['report_merged_or_cutoff'], '2026-11-02T10:58:00Z')
        self.assertIsNone(ev['report_last_commit'])
        self.assertIsNone(ev['wall_to_report_commit_minutes'])
        self.assertIn('no PR adds', self.output)

    def test_no_report_pr_and_no_end_falls_back_to_the_cap(self):
        fake = self.github(edit=lambda prs, runs: prs.pop())
        ev = self.collect(fake)
        self.assertEqual(ev['report_merged_or_cutoff'], '2026-11-02T22:00:00Z')  # start + cap_hours 12
        self.assertEqual(ev['wall_minutes'], 720.0)

    def test_the_cap_follows_trial_json(self):
        box = helpers.Sandbox(edit=lambda d: d.update(cap_hours=2))
        self.addCleanup(box.cleanup)
        write_json(os.path.join(box.home, 'trial', 't2', 'state', 'A-cd-r1.json'),
                   {'run': 'A-cd-r1', 'trial': 't2', 'start': {'sent_at': START}})
        fake = self.github(edit=lambda prs, runs: prs.pop())
        env = box.env(github=fake)
        trial = box.trial()
        data = os.path.join(box.tmp, 'data')
        self.assertEqual(collect.collect(trial, trial.run('A-cd-r1'), env, data_dir=data), 0)
        ev = read_json(os.path.join(data, 'evidence', 'A-cd-r1.json'))['runs']['A-cd-r1']
        self.assertEqual(ev['report_merged_or_cutoff'], '2026-11-02T12:00:00Z')


class WindowAndCounts(Scenario):
    def test_runs_outside_the_window_are_not_counted(self):
        self.collect()
        p = self.pr_of(101)
        self.assertEqual([r['id'] for r in p['ci_runs']], [1])  # 2 is earlier, 3 is after the window
        self.assertEqual((p['ci_run_count'], p['ci_attempt_count']), (1, 1))
        # the relay run after the merge is the merge's own, not PR work
        self.assertEqual([r['id'] for r in p['all_pr_workflow_runs']], [1, 4])

    def test_attempts_are_summed_separately_from_distinct_runs(self):
        ev = self.collect()
        p = self.pr_of(102)
        self.assertEqual((p['ci_run_count'], p['ci_attempt_count']), (2, 3))
        self.assertEqual((ev['queue_ci_runs'], ev['queue_ci_attempts'], ev['merged_ci_runs']), (4, 5, 2))
        self.assertEqual(ev['queue_all_pr_workflow_runs'], 5)

    def test_a_closed_unmerged_pr_is_counted_in_the_queue_totals(self):
        self.collect()
        p = self.pr_of(102)
        self.assertEqual((p['state'], p['issue']), ('closed', 9002))
        self.assertEqual([r['id'] for r in p['ci_runs']], [6, 7])

    def test_review_columns(self):
        self.collect()
        p = self.pr_of(101)
        self.assertEqual(p['copilot_review_bodies'], 1)  # the blank body and the out-of-window review are excluded
        self.assertEqual(p['copilot_review_ids'], [11])
        self.assertEqual(p['owner_formal_review_bodies'], 1)
        self.assertEqual(p['owner_all_comment_bodies'], 3)  # blank and third-party comments never count
        self.assertEqual(p['owner_review_comment_bodies'], 2)  # the smoke comment is excluded
        self.assertEqual(p['review_comment_ids'], [21, 25])
        self.assertEqual(p['excluded_smoke_only_comment_ids'], [22])
        self.assertEqual(p['owner_gate_pattern_comment_bodies'], 1)  # only "LGTM, merging" matches the Claude gate pattern

    def test_cycle_diff_and_summary_numbers(self):
        ev = self.collect()
        p = self.pr_of(101)
        self.assertEqual((p['opened_at'], p['merged_at'], p['merge_sha']), ('2026-11-02T10:05:00Z', '2026-11-02T10:35:00Z', 'm101'))
        self.assertEqual(p['cycle_minutes'], 30.0)
        self.assertEqual((p['diff_added'], p['diff_deleted']), (30, 4))
        closed = self.pr_of(102)
        self.assertEqual((closed['cycle_minutes'], closed['merge_sha'], closed['diff_added']), (None, None, None))
        self.assertEqual(ev['median_cycle_minutes'], 18.5)  # PRs 101 (30 min) and 103 (7 min) merged
        self.assertEqual(ev['p90_cycle_minutes'], 30.0)
        self.assertEqual(ev['merged_queue_prs'], 2)

    def test_closing_keywords_and_body_references(self):
        self.collect()
        p = self.pr_of(102)
        self.assertTrue(p['forbidden_closing_keyword'])
        self.assertEqual(p['pr_body_issue_references'], ['123', '9002', '77'])
        self.assertFalse(self.pr_of(101)['forbidden_closing_keyword'])
        self.assertEqual(self.pr_of(101)['pr_body_issue_references'], [])

    def test_the_branch_query_asks_for_the_prs_head_branch(self):
        fake = self.github()
        self.collect(fake)
        asked = [params for path, params in fake.requests if path.endswith('actions/runs') and 'event' not in params]
        self.assertEqual(sorted(p['branch'] for p in asked), ['br/101', 'br/102', 'br/103', 'br/104'])


class Timeline(Scenario):
    def test_events_in_the_window_with_their_source(self):
        ev = self.collect()
        self.assertEqual(ev['timeline_events'], [
            {'issue': 9001, 'event': 'cross-referenced', 'at': '2026-11-02T10:12:00Z', 'actor': 'Copilot',
             'source_pr': 101, 'source_in_run': True},
            {'issue': 9001, 'event': 'cross-referenced', 'at': '2026-11-02T10:13:00Z', 'actor': 'Copilot',
             'source_pr': 999, 'source_in_run': False},
            {'issue': 9001, 'event': 'referenced', 'at': '2026-11-02T10:15:00Z', 'actor': 'blamechris',
             'source_pr': None, 'source_in_run': False}])  # labeled and the pre-window mention are dropped
        self.assertIn('2 from outside this run', self.output)

    def test_every_queue_issue_is_scanned(self):
        fake = self.github()
        self.collect(fake)
        self.assertEqual(sorted(fake.asked(r'timeline$')),
                         [P + 'issues/9001/timeline', P + 'issues/9002/timeline'])


class RedCi(Scenario):
    @staticmethod
    def push(run_id, sha, created, conclusion='success', path='.github/workflows/ci.yml'):
        return dict(wf(run_id, created, path=path, conclusion=conclusion, event='push'), head_sha=sha)

    # Merges in the scenario: PR 101 (m101), 103 (m103) and the report-like last merge 104 (m104, 11:30,
    # the end of the window). Push runs are matched to merges by commit, so 104's run, which starts
    # after the window closes, still counts.
    PUSHES = [push.__func__(31, 'm101', '2026-11-02T10:35:30Z', 'failure'),
              push.__func__(32, 'm103', '2026-11-02T10:55:30Z'),
              push.__func__(33, 'm103', '2026-11-02T10:55:31Z', 'failure', path='.github/workflows/other.yml'),
              push.__func__(34, 'zzz', '2026-11-02T10:40:00Z', 'failure'),   # a direct push, no merge's
              push.__func__(35, 'm104', '2026-11-02T11:31:00Z')]             # after the window

    def test_observable_counts_failures_per_merge_by_commit(self):
        ev = self.collect(self.github(ci_text=CI_PUSH_TRIAL, push_runs=self.PUSHES))
        self.assertIs(ev['ci_push_observable'], True)
        # 31 failed after PR 101's merge; 34, a failing push that is no merge's, is red CI on the base too.
        self.assertEqual(ev['red_ci_on_base'], 2)
        self.assertEqual([(r['id'], r['pr']) for r in ev['base_push_ci']], [(31, 101), (32, 103), (35, 104)])
        self.assertEqual([r['id'] for r in ev['red_ci_unattributed']], [34])
        self.assertNotIn('red_ci_incomplete', ev)
        self.assertIn('red CI on the base: 2 red (3 merges, 1 other push run(s))', self.output)

    def test_a_rerun_of_a_merge_push_counts_its_latest_attempt(self):
        rerun = [p for p in self.PUSHES if p['id'] != 34] + [self.push(36, 'm101', '2026-11-02T10:45:00Z')]
        ev = self.collect(self.github(ci_text=CI_PUSH_TRIAL, push_runs=rerun))
        self.assertEqual(ev['red_ci_on_base'], 0)

    def test_observable_with_no_failure_is_a_real_zero(self):
        ok = [self.push(41, 'm101', '2026-11-02T10:36:00Z'), self.push(42, 'm103', '2026-11-02T10:56:00Z'),
              self.push(43, 'm104', '2026-11-02T11:31:00Z')]
        ev = self.collect(self.github(ci_text=CI_PUSH_TRIAL, push_runs=ok))
        self.assertEqual((ev['ci_push_observable'], ev['red_ci_on_base']), (True, 0))

    def test_a_merge_without_its_push_run_is_no_count_not_zero(self):
        ev = self.collect(self.github(ci_text=CI_PUSH_TRIAL, push_runs=self.PUSHES[1:2]))
        self.assertIs(ev['ci_push_observable'], True)
        self.assertIsNone(ev['red_ci_on_base'])
        self.assertEqual(ev['red_ci_incomplete'], 'no ci.yml push run on the base for the merge of PR(s) [101, 104]')
        self.assertIn('red CI on the base: no count', self.output)

    def test_a_push_run_still_in_progress_is_no_count(self):
        running = self.PUSHES[:4] + [dict(self.PUSHES[4], conclusion=None, status='in_progress')]
        ev = self.collect(self.github(ci_text=CI_PUSH_TRIAL, push_runs=running))
        self.assertIsNone(ev['red_ci_on_base'])
        self.assertIn('the push run for PR 104 had not finished', ev['red_ci_incomplete'])

    def ok(self, last_conclusion='success', extra=()):
        return [self.push(41, 'm101', '2026-11-02T10:36:00Z'), self.push(42, 'm103', '2026-11-02T10:56:00Z'),
                self.push(43, 'm104', '2026-11-02T11:31:00Z', last_conclusion), *extra]

    def test_a_cancelled_or_skipped_last_run_with_nothing_after_it_is_no_count(self):
        for conclusion in ('cancelled', 'skipped', 'neutral', 'action_required'):
            with self.subTest(conclusion):
                ev = self.collect(self.github(ci_text=CI_PUSH_TRIAL, push_runs=self.ok(conclusion)))
                self.assertIsNone(ev['red_ci_on_base'])
                self.assertIn(f'PR 104 ended {conclusion} and no later push run covers it', ev['red_ci_incomplete'])

    def test_a_cancelled_run_covered_by_a_later_finished_run_counts(self):
        superseded = [self.push(41, 'm101', '2026-11-02T10:36:00Z', 'cancelled'),
                      self.push(42, 'm103', '2026-11-02T10:56:00Z'), self.push(43, 'm104', '2026-11-02T11:31:00Z')]
        ev = self.collect(self.github(ci_text=CI_PUSH_TRIAL, push_runs=superseded))
        self.assertEqual(ev['red_ci_on_base'], 0)
        self.assertNotIn('red_ci_incomplete', ev)

    def test_an_unfinished_push_that_is_no_merge_s_is_no_count(self):
        stray = self.push(44, 'direct', '2026-11-02T11:00:00Z', None)
        ev = self.collect(self.github(ci_text=CI_PUSH_TRIAL, push_runs=self.ok(extra=[stray])))
        self.assertIsNone(ev['red_ci_on_base'])
        self.assertIn('push run 44 (not a merge) had not finished', ev['red_ci_incomplete'])

    def test_not_observable_when_ci_does_not_run_on_push_to_the_base(self):
        ev = self.collect(self.github(ci_text=CI_PUSH_MAIN, push_runs=self.PUSHES))
        self.assertIs(ev['ci_push_observable'], False)
        self.assertIsNone(ev['red_ci_on_base'])  # never a count while unobservable
        self.assertIn('not observable', self.output)

    def test_an_unreadable_trigger_is_null_not_false(self):
        ev = self.collect(self.github(ci_text='on:\n  push:\n    branches-ignore: [x]\n'))
        self.assertIsNone(ev['ci_push_observable'])
        self.assertIsNone(ev['red_ci_on_base'])
        self.assertIn('cannot be read', self.output)

    def test_an_unfetchable_ci_yml_is_null_not_false(self):
        fake = self.github()
        fake.routes.insert(0, (re.compile(r'^contents/'), GitHubError('HTTP 404', 404)))
        ev = self.collect(fake)
        self.assertIsNone(ev['ci_push_observable'])

    def test_t0_comes_from_trial_json_when_set_else_from_the_merge_base(self):
        fake = self.github()
        self.assertEqual(self.collect(fake)['T0'], 'T0FROMCOMPARE')
        self.assertEqual(fake.asked(r'contents/'), [P + 'contents/.github/workflows/ci.yml'])
        self.assertEqual([p for p in fake.requests if p[0].endswith('ci.yml')][0][1], {'ref': 'T0FROMCOMPARE'})
        box = helpers.Sandbox(edit=lambda d: d.update(t0='b' * 40))
        self.addCleanup(box.cleanup)
        write_json(os.path.join(box.home, 'trial', 't2', 'state', 'A-cd-r1.json'),
                   {'run': 'A-cd-r1', 'trial': 't2', 'start': {'sent_at': START}})
        fake2 = self.github()
        trial = box.trial()
        collect.collect(trial, trial.run('A-cd-r1'), box.env(github=fake2), data_dir=os.path.join(box.tmp, 'd'))
        self.assertEqual(fake2.asked(r'compare/'), [])
        self.assertEqual(read_json(os.path.join(box.tmp, 'd', 'runs.json'))['T0'], 'b' * 40)


class FixtureTrim(unittest.TestCase):
    CI = ('name: CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n\n'
          'jobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps: []\n')

    def test_a_recorded_ci_yml_keeps_the_trigger_and_drops_the_jobs(self):
        response = {'content': base64.b64encode(self.CI.encode()).decode(), 'encoding': 'base64', 'sha': 'x'}
        trimmed = collect.trim_fixture('repos/o/r/contents/.github/workflows/ci.yml?ref=abc', response)
        text = base64.b64decode(trimmed['content']).decode()
        self.assertEqual(text, self.CI[:self.CI.index('jobs:')])
        self.assertNotIn('runs-on', text)
        from trialkit.workflow import push_branches
        self.assertEqual(push_branches(text), push_branches(self.CI))

    def test_other_contents_are_kept_whole(self):
        response = {'content': base64.b64encode(b'jobs: x\n').decode(), 'encoding': 'base64'}
        self.assertEqual(collect.trim_fixture('repos/o/r/contents/README.md?ref=abc', response), response)


class Recollect(Scenario):
    def test_a_second_collect_keeps_the_verdicts_already_applied(self):
        self.collect()
        path = os.path.join(self.data, 'evidence', 'A-cd-r1.json')
        evidence = read_json(path)
        merged = [p for p in evidence['runs']['A-cd-r1']['prs'] if p['state'] == 'merged']
        for p in merged:
            p['correct_vs_key'], p['verdict_source'] = 'yes', 'G-codex'
        write_json(path, evidence)
        again = self.collect()
        self.assertIn(f'kept {len(merged)} grader verdict(s)', self.output)
        kept = {p['pr']: (p['correct_vs_key'], p.get('verdict_source')) for p in again['prs'] if p['state'] == 'merged'}
        self.assertEqual(kept, {p['pr']: ('yes', 'G-codex') for p in merged})

    def test_a_verdict_for_a_pr_no_longer_collected_is_reported(self):
        self.collect()
        path = os.path.join(self.data, 'evidence', 'A-cd-r1.json')
        evidence = read_json(path)
        evidence['runs']['A-cd-r1']['prs'].append({'pr': 999, 'state': 'merged', 'correct_vs_key': 'yes'})
        write_json(path, evidence)
        self.collect()
        self.assertIn('PR(s) [999] had a verdict and are not in this collection', self.output)

    def test_a_previous_evidence_file_of_the_wrong_shape_stops(self):
        path = os.path.join(self.box.tmp, 'data', 'evidence', 'A-cd-r1.json')
        write_json(path, {'runs': {'A-cd-r1': {'prs': ['not a PR record']}}})
        env = self.box.env(github=self.github())
        trial = self.box.trial()
        self.assertEqual(collect.collect(trial, trial.run('A-cd-r1'), env, data_dir=os.path.join(self.box.tmp, 'data')), 2)
        self.assertEqual(read_json(path), {'runs': {'A-cd-r1': {'prs': ['not a PR record']}}})

    def test_an_unreadable_previous_evidence_file_stops_rather_than_overwrites(self):
        path = os.path.join(self.box.tmp, 'data', 'evidence', 'A-cd-r1.json')
        os.makedirs(os.path.dirname(path))
        with open(path, 'w') as fh:
            fh.write('{not json')
        env = self.box.env(github=self.github())
        trial = self.box.trial()
        code = collect.collect(trial, trial.run('A-cd-r1'), env, data_dir=os.path.join(self.box.tmp, 'data'))
        self.assertEqual(code, 2)
        self.assertIn('cannot be read', env.out.getvalue())
        with open(path) as fh:
            self.assertEqual(fh.read(), '{not json')


class StateAndExit(Scenario):
    def test_verify_start_overrides_the_send_as_the_window_start(self):
        self.write_state({'start': {'sent_at': START}, 'verify_start': {'first_command_at': '2026-11-02T09:55:00Z'}})
        ev = self.collect()
        self.assertEqual(ev['start'], '2026-11-02T09:55:00Z')
        self.assertEqual(ev['wall_minutes'], 95.0)

    def test_a_missing_start_is_exit_2_and_writes_nothing(self):
        self.write_state({'gate': {'ok': True}})
        self.assertIsNone(self.collect())
        self.assertEqual(self.code, 2)
        self.assertIn('neither verify_start.first_command_at nor start.sent_at', self.output)
        self.assertFalse(os.path.exists(self.data))

    def test_a_missing_state_file_is_exit_2(self):
        os.remove(os.path.join(self.state_dir, 'A-cd-r1.json'))
        self.collect()
        self.assertEqual(self.code, 2)
        self.assertIn('no state file', self.output)

    def test_an_unparseable_start_is_exit_2_before_any_request(self):
        self.write_state({'start': {'sent_at': 'yesterday-ish'}})
        fake = self.github()
        self.assertIsNone(self.collect(fake))
        self.assertEqual(self.code, 2)
        self.assertIn("'yesterday-ish' in", self.output)
        self.assertEqual(fake.requests, [])

    def test_an_explicit_state_file_that_does_not_exist_is_exit_2(self):
        self.collect(state_file=os.path.join(self.box.tmp, 'nope.json'))
        self.assertEqual(self.code, 2)

    def test_the_committed_copy_is_the_fallback(self):
        os.remove(os.path.join(self.state_dir, 'A-cd-r1.json'))
        committed = os.path.join(self.box.trial_dir, 'data', 'state', 'A-cd-r1.json')
        write_json(committed, {'run': 'A-cd-r1', 'trial': 't2', 'start': {'sent_at': START}})
        ev = self.collect(data=os.path.join(self.box.trial_dir, 'data'))
        self.assertEqual(self.code, 0, self.output)
        self.assertEqual(ev['start'], START)

    def test_the_state_of_another_run_is_exit_2(self):
        write_json(os.path.join(self.state_dir, 'A-cd-r1.json'), {'run': 'B-cy-r1', 'start': {'sent_at': START}})
        self.collect()
        self.assertEqual(self.code, 2)

    def test_a_compare_without_a_merge_base_is_exit_2_not_a_blank_t0(self):
        fake = self.github()
        fake.routes.insert(0, (re.compile(r'^compare/'), {'status': 'diverged'}))
        self.assertIsNone(self.collect(fake))
        self.assertEqual(self.code, 2)
        self.assertIn('merge_base_commit.sha', self.output)

    def test_a_github_error_is_exit_2_and_leaves_no_evidence(self):
        fake = self.github()
        fake.routes.insert(0, (re.compile(r'^pulls/102/reviews$'), GitHubError('gh api failed: HTTP 502', 502)))
        self.assertIsNone(self.collect(fake))
        self.assertEqual(self.code, 2)
        self.assertIn('HTTP 502', self.output)
        self.assertFalse(os.path.exists(os.path.join(self.data, 'evidence')))

    def test_no_owner_login_is_exit_2(self):
        box = helpers.Sandbox(edit=lambda d: d.pop('github_login'))
        self.addCleanup(box.cleanup)
        trial = box.trial()
        env = box.env(github=self.github())
        self.assertEqual(collect.collect(trial, trial.run('A-cd-r1'), env, data_dir=os.path.join(box.tmp, 'd')), 2)
        self.assertIn('github_login', env.out.getvalue())

    def test_an_empty_queue_is_exit_2(self):
        box = helpers.Sandbox(slots=[])
        self.addCleanup(box.cleanup)
        trial = box.trial()
        env = box.env(github=self.github())
        self.assertEqual(collect.collect(trial, trial.run('A-cd-r1'), env, data_dir=os.path.join(box.tmp, 'd')), 2)

    def test_the_state_is_copied_into_data_with_the_home_directory_as_tilde(self):
        self.write_state({'start': {'sent_at': START}, 'clone': {'dir': os.path.join(self.box.home, 'trial', 't2', 'A-cd-r1')}})
        self.collect()
        copied = read_json(os.path.join(self.data, 'state', 'A-cd-r1.json'))
        self.assertEqual(copied['clone']['dir'], '~/trial/t2/A-cd-r1')
        self.assertNotIn(self.box.home, json.dumps(copied))


class QueueTextNotes(Scenario):
    """`finish` records whether the queue's text moved during the run (`finish.queue_text`); collect says so when it did, or when
    it did not look."""
    FINISH = {'ended_at': '2026-11-02T11:40:00Z', 'stop': 'queue exhausted'}

    def seen(self, **slots):
        rows = {slot: dict(row, issue=9001) for slot, row in slots.items()}
        return dict(self.FINISH, queue_text={'at': '2026-11-02T11:40:00Z', 'slots': rows})

    def row(self, since_gate, detail='the detail finish recorded'):
        return {'since_t0': since_gate, 'since_gate': since_gate, 'detail': detail}

    def test_a_finish_that_did_not_read_the_text_again_is_a_note(self):
        self.write_state({'start': {'sent_at': START}, 'finish': self.FINISH})
        self.collect()
        self.assertEqual(self.code, 0, self.output)
        self.assertIn('  note: finish did not re-read the queue text, so an edit during the run cannot be ruled out', self.output)

    def test_a_record_that_is_not_one_is_taken_for_not_having_read_it(self):
        for seen in (None, 'x', [], {}, {'slots': None}, {'slots': []}):
            with self.subTest(seen=seen):
                self.write_state({'start': {'sent_at': START}, 'finish': dict(self.FINISH, queue_text=seen)})
                self.collect()
                self.assertIn('finish did not re-read the queue text', self.output)

    def test_no_finish_no_note(self):
        self.collect()
        self.assertEqual(self.code, 0, self.output)
        self.assertNotIn('queue text', self.output)

    def test_every_slot_unchanged_since_the_gate_is_no_note(self):
        self.write_state({'start': {'sent_at': START}, 'finish': self.seen(Q01=self.row('unchanged'), Q02=self.row('unchanged'))})
        self.collect()
        self.assertEqual(self.code, 0, self.output)
        self.assertNotIn('queue text', self.output)
        self.assertNotIn('re-read', self.output)

    def test_a_slot_changed_or_unverified_since_the_gate_is_named_with_what_finish_recorded(self):
        gate_text = {'since_t0': 'changed', 'since_gate': 'unchanged', 'detail': 'changed since T0 (body), the text this run\'s gate accepted: x'}
        self.write_state({'start': {'sent_at': START}, 'finish': self.seen(
            Q01=self.row('unchanged'), Q02=self.row('changed', 'changed since the T0 snapshot of T: body; so it changed during the run'),
            Q03=self.row('unverified', 'cannot read Q03 #9003: rate limited'), Q04=gate_text)})
        self.collect()
        self.assertEqual(self.code, 0, self.output)
        self.assertIn("  note: queue text Q02: changed since this run's gate (changed since the T0 snapshot of T: body; so it changed during the run)",
                      self.output)
        self.assertIn("  note: queue text Q03: unverified since this run's gate (cannot read Q03 #9003: rate limited)", self.output)
        self.assertNotIn('queue text Q01', self.output)
        self.assertNotIn('queue text Q04', self.output, 'an accepted change that stayed as accepted is no note')
        self.assertNotIn('re-read', self.output)

    def test_a_row_that_is_not_a_record_is_not_unchanged(self):
        self.write_state({'start': {'sent_at': START}, 'finish': self.seen(Q01=self.row('unchanged'))})
        state = read_json(os.path.join(self.state_dir, 'A-cd-r1.json'))
        state['finish']['queue_text']['slots']['Q02'] = 'unchanged'
        write_json(os.path.join(self.state_dir, 'A-cd-r1.json'), state)
        self.collect()
        self.assertIn("  note: queue text Q02: unknown since this run's gate (no detail recorded)", self.output)

    def test_the_notes_change_no_evidence(self):
        without = self.collect()
        self.write_state({'start': {'sent_at': START}, 'finish': self.seen(Q02=self.row('changed'))})
        with_note = self.collect()
        self.assertIn('queue text Q02: changed', self.output)
        self.assertEqual(with_note, without)


class RunsJson(Scenario):
    def runs_json(self):
        return read_json(os.path.join(self.data, 'runs.json'))

    def test_first_collect_writes_placeholders_never_zero(self):
        self.collect()
        meta = self.runs_json()['runs']['A-cd-r1']
        for field in ('workers', 'approvals', 'compactions', 'waves', 'incidents', 'stop', 'allowance'):
            self.assertEqual(meta[field], 'not recorded', field)
        self.assertEqual((meta['cost'], meta['send']), ('n/a', START))
        self.assertEqual(meta['coordinator'], 'claude-opus-5-5 / high')
        self.assertEqual(meta['role'], 'controlled native')

    def test_state_facts_reach_the_metadata(self):
        self.write_state({
            'start': {'sent_at': START, 'meters': {'claude_5h': 12.5, 'claude_weekly': 30}},
            'finish': {'cost': '$26.57 SDK-reported', 'stop': 'complete', 'meters': {'claude_weekly': 33}},
            'preflight': [{'phase': 'pre', 'checks': [{'name': 'claude version', 'status': 'PASS', 'detail': '2.1.1'}],
                           'facts': {'claude_version': '2.1.100', 'node_version': '22.5.0'}},
                          {'phase': 'session', 'facts': {'session': 's1', 'model': 'opus'}},
                          {'phase': 'pre', 'facts': {'claude_version': '2.1.296', 'gh_login': 'blamechris'}}],
            'verify_start': {'first_command_at': START, 'applied': {
                'model': ['claude-opus-5-5', 'claude-opus-5-5'], 'effort': ['high'], 'effort_source': 'settings',
                'permission_mode': ['auto'], 'probe': None, 'cli_version': '2.1.296'}}})
        self.collect()
        meta = self.runs_json()['runs']['A-cd-r1']
        self.assertEqual(meta['cost'], '$26.57 SDK-reported')
        self.assertEqual(meta['stop'], 'complete')
        self.assertEqual(meta['allowance'], 'start: claude_5h 12.5%, claude_weekly 30%; end: claude_weekly 33%')
        self.assertIn('claude_version 2.1.296', meta['harness'])  # the later preflight wins
        self.assertNotIn('2.1.100', meta['harness'])
        self.assertIn('node_version 22.5.0', meta['harness'])
        self.assertTrue(meta['harness'].startswith('CD'))
        self.assertEqual(meta['coordinator'],
                         'claude-opus-5-5 / high (applied: model claude-opus-5-5; effort high; permission_mode auto)')

    def test_manual_fields_survive_a_recollect_and_derived_ones_are_rewritten(self):
        self.collect()
        doc = self.runs_json()
        doc['runs']['A-cd-r1'].update({'workers': 'Sonnet 5.5 x3', 'approvals': 2, 'compactions': 0, 'waves': 2,
                                       'incidents': 'disk full', 'stop': 'quota', 'cost': 'stale', 'extra_note': 'keep'})
        doc['grading_cost'] = {'G': 'n/a'}
        write_json(os.path.join(self.data, 'runs.json'), doc)
        self.write_state({'start': {'sent_at': START}, 'finish': {'cost': '$1.00', 'stop': 'complete'}})
        self.collect(data=self.data)
        meta = self.runs_json()['runs']['A-cd-r1']
        self.assertEqual((meta['workers'], meta['approvals'], meta['compactions'], meta['waves'], meta['incidents']),
                         ('Sonnet 5.5 x3', 2, 0, 2, 'disk full'))
        self.assertEqual(meta['stop'], 'quota')  # set by hand: the state's later value does not replace it
        self.assertEqual(meta['cost'], '$1.00')   # derived: rewritten
        self.assertEqual(meta['extra_note'], 'keep')
        self.assertEqual(self.runs_json()['grading_cost'], {'G': 'n/a'})

    def test_a_placeholder_stop_is_filled_from_the_state_on_a_later_collect(self):
        self.collect()
        self.write_state({'start': {'sent_at': START}, 'finish': {'stop': 'complete'}})
        self.collect(data=self.data)
        self.assertEqual(self.runs_json()['runs']['A-cd-r1']['stop'], 'complete')

    def test_order_and_evidence_files_follow_the_roster_for_runs_with_evidence(self):
        self.collect()
        write_json(os.path.join(self.data, 'evidence', 'B-cy-r1.json'), {'runs': {}})
        self.collect(data=self.data)
        doc = self.runs_json()
        self.assertEqual(doc['order'], ['A-cd-r1', 'B-cy-r1'])  # roster order, not alphabetical or by arrival
        self.assertEqual(doc['evidence_files'], ['evidence/A-cd-r1.json', 'evidence/B-cy-r1.json'])
        self.assertEqual(sorted(doc['cells']), ['A-chroxy', 'A-native', 'B-chroxy', 'B-native'])
        self.assertEqual(doc['contrasts'], [{'arm': 'A', 'native': 'A-native', 'chroxy': 'A-chroxy'},
                                            {'arm': 'B', 'native': 'B-native', 'chroxy': 'B-chroxy'}])
        self.assertEqual(doc['queue'], [9001, 9002])

    # -- the native extract (trialctl evidence) -----------------------------------------

    def native(self, row, run='A-cd-r1', data=None):
        data = data or os.path.join(self.box.tmp, 'data')
        write_json(os.path.join(data, 'native', f'{run}.json'), {'run': run, 'runs_row': row})
        return data

    ROW = {'approvals': '4 prompted: 1 human, 3 unattributed, 0 automatic (daemon log)', 'compactions': 2,
           'workers': '3 subagent transcript(s): claude-sonnet-5-5 x14'}

    def test_the_native_extract_fills_the_placeholders(self):
        data = self.native(self.ROW)
        self.collect(data=data)
        meta = self.runs_json()['runs']['A-cd-r1']
        self.assertEqual((meta['approvals'], meta['compactions'], meta['workers']),
                         (self.ROW['approvals'], 2, self.ROW['workers']))
        self.assertEqual((meta['waves'], meta['incidents'], meta['stop']), ('not recorded',) * 3)
        self.assertTrue('approvals filled from the native extract' in self.output)

    def test_a_value_anyone_wrote_is_never_overwritten_not_even_a_zero(self):
        data = self.native(self.ROW)
        self.collect(data=os.path.join(self.box.tmp, 'other'))      # a first run with no extract: placeholders
        doc = self.runs_json()
        doc['runs']['A-cd-r1'].update({'approvals': 0, 'compactions': 'by hand', 'workers': ''})
        write_json(os.path.join(data, 'runs.json'), doc)
        self.collect(data=data)
        meta = self.runs_json()['runs']['A-cd-r1']
        self.assertEqual((meta['approvals'], meta['compactions'], meta['workers']), (0, 'by hand', ''))
        self.assertFalse('filled from the native extract' in self.output)

    def test_a_later_collect_fills_a_placeholder_and_then_leaves_it(self):
        self.collect()
        self.assertEqual(self.runs_json()['runs']['A-cd-r1']['approvals'], 'not recorded')
        self.native(self.ROW, data=self.data)
        self.collect(data=self.data)
        self.assertEqual(self.runs_json()['runs']['A-cd-r1']['compactions'], 2)
        self.native(dict(self.ROW, compactions=9), data=self.data)
        self.collect(data=self.data)
        self.assertEqual(self.runs_json()['runs']['A-cd-r1']['compactions'], 2)

    def test_only_the_three_fields_are_taken(self):
        data = self.native(dict(self.ROW, stop='quota', cost='$1', waves=7, incidents='x'))
        self.collect(data=data)
        meta = self.runs_json()['runs']['A-cd-r1']
        self.assertEqual((meta['stop'], meta['cost'], meta['waves'], meta['incidents']), ('not recorded', 'n/a', 'not recorded', 'not recorded'))

    def test_a_field_the_extract_does_not_know_stays_a_placeholder(self):
        data = self.native({'compactions': 0, 'workers': 'none'})                    # a native run: no daemon log, no approvals
        self.collect(data=data)
        meta = self.runs_json()['runs']['A-cd-r1']
        self.assertEqual((meta['approvals'], meta['compactions'], meta['workers']), ('not recorded', 0, 'none'))

    def test_an_extract_that_cannot_be_used_is_reported_and_changes_nothing(self):
        for body in ('{"truncated', json.dumps({'run': 'B-cy-r1', 'runs_row': self.ROW}), json.dumps({'run': 'A-cd-r1'}),
                     json.dumps(['A-cd-r1']), json.dumps({'run': 'A-cd-r1', 'runs_row': 'oops'})):
            data = os.path.join(self.box.tmp, 'bad')
            os.makedirs(os.path.join(data, 'native'), exist_ok=True)
            with open(os.path.join(data, 'native', 'A-cd-r1.json'), 'w', encoding='utf-8') as fh:
                fh.write(body)
            self.collect(data=data)
            self.assertEqual(self.code, 0, self.output)
            meta = self.runs_json()['runs']['A-cd-r1']
            self.assertEqual((meta['approvals'], meta['compactions'], meta['workers']), ('not recorded',) * 3, body)
            self.assertTrue('native extract' in self.output or 'cannot read' in self.output, (body, self.output))
            os.remove(os.path.join(data, 'runs.json'))

    def test_an_existing_tiebreaks_file_is_left_alone(self):
        data = os.path.join(self.box.tmp, 'data')
        write_json(os.path.join(data, 'tiebreaks.json'), {'source': 'mine', 'overrides': [{'id': 'T1'}]})
        self.collect(data=data)
        self.assertEqual(read_json(os.path.join(data, 'tiebreaks.json'))['source'], 'mine')


class RecordingRoundTrip(Scenario):
    def test_recorded_fixtures_replay_to_the_same_evidence(self):
        record = os.path.join(self.box.tmp, 'fx')
        live = self.collect(data=os.path.join(self.box.tmp, 'live'), record_dir=record)
        self.assertEqual(self.code, 0, self.output)
        self.assertTrue(os.listdir(record))
        replay = self.collect(github=FakeGitHub(), data=os.path.join(self.box.tmp, 'replay'), fixtures_dir=record)
        self.assertEqual(self.code, 0, self.output)
        self.assertEqual(replay, live)

    def test_trim_keeps_what_collect_reads_and_drops_the_rest(self):
        fat = [{'number': 5, 'state': 'closed', 'title': 't', 'body': 'b', 'created_at': 'c', 'merged_at': 'm',
                'closed_at': 'x', 'merge_commit_sha': 's', 'draft': False, 'url': 'drop', 'labels': [1, 2],
                'user': {'login': 'u', 'type': 'User', 'avatar_url': 'drop'},
                'head': {'ref': 'r', 'sha': 'h', 'repo': {'huge': 'drop'}}, 'base': {'ref': 'b', 'repo': 'drop'}}]
        out = collect.trim_fixture('repos/o/r/pulls?base=x&state=all', fat)[0]
        self.assertEqual(out['head'], {'ref': 'r', 'sha': 'h'})
        self.assertEqual(out['user'], {'login': 'u', 'type': 'User'})
        self.assertNotIn('url', out)
        self.assertNotIn('labels', out)
        self.assertEqual(out['body'], 'b')
        event = collect.trim_fixture('repos/o/r/issues/1/timeline?per_page=100#',
                                     [{'event': 'cross-referenced', 'created_at': 't', 'actor': {'login': 'a', 'id': 1},
                                       'source': {'type': 'issue', 'issue': {'number': 7, 'title': 'drop',
                                                                              'pull_request': {'url': 'drop'}}}},
                                      {'event': 'labeled', 'created_at': 't', 'actor': None}])
        self.assertEqual(event[0]['source'], {'issue': {'number': 7, 'pull_request': {}}})
        self.assertEqual(event[0]['actor'], {'login': 'a'})
        self.assertIsNone(event[1]['actor'])
        self.assertEqual(collect.trim_fixture('repos/o/r/commits/' + 'a' * 40, {
            'sha': 'x', 'stats': {'additions': 1, 'deletions': 2, 'total': 3}, 'files': ['drop'],
            'parents': [{'sha': 'p', 'url': 'drop'}]}),
            {'sha': 'x', 'stats': {'additions': 1, 'deletions': 2}, 'parents': [{'sha': 'p'}]})
        self.assertIsNone(collect.trim_fixture('repos/o/r/pulls', None))
        self.assertEqual(collect.trim_fixture('repos/o/r/something/else', {'keep': 1}), {'keep': 1})


class Classifiers(unittest.TestCase):
    def test_copilot_by_login_or_by_bot_type(self):
        self.assertTrue(collect.is_copilot({'login': 'copilot-pull-request-reviewer[bot]', 'type': 'Bot'}))
        self.assertTrue(collect.is_copilot({'login': 'Copilot', 'type': 'Bot'}))
        self.assertTrue(collect.is_copilot({'login': 'github-copilot[bot]', 'type': 'Bot'}))
        self.assertFalse(collect.is_copilot({'login': 'copilot-fan', 'type': 'User'}))
        self.assertFalse(collect.is_copilot({'login': 'blamechris', 'type': 'User'}))
        self.assertFalse(collect.is_copilot(None))

    def test_smoke_only_comments(self):
        for body in ('Smoke verification on `abc` used a dashboard.\n\n| Step | Verdict | Head |\n|---|---|---|\n| a | PASS | x |',
                     '### Smoke (isolated preview daemon) - head dc9ed76\n| step | verdict | head |',
                     'Final-head smoke re-run at `a54b`: **PASS**.\n\n| Step | Verdict | Head |\n|---|---|---|',
                     'Real app smoke at 3043ce4 completed manual connection. The changed-feature check failed.'):
            self.assertTrue(collect.is_smoke_only(body), body)

    def test_review_comments_are_not_smoke_only(self):
        for body in ('Independent review at `6c04`: **approve**, no blockers. Smoke is recorded in the description.',
                     '## Code Review\n**Verdict: Approve.** The smoke pass was clean.',
                     'Full review: clean. Final-head real dashboard smoke covers the path.',
                     'Smoke passed. LGTM',
                     '',
                     '| a | b |'):
            self.assertFalse(collect.is_smoke_only(body), body)

    def test_cycle_statistics(self):
        self.assertEqual(collect._median([3, 1, 2]), 2)
        self.assertEqual(collect._median([1, 2, 3, 4]), 2.5)
        self.assertIsNone(collect._median([]))
        self.assertEqual(collect._p90(list(range(1, 10))), 9)    # ceil(0.9 * 9) = 9th
        self.assertEqual(collect._p90(list(range(1, 11))), 9)    # ceil(0.9 * 10) = 9th
        self.assertEqual(collect._p90([5]), 5)
        self.assertIsNone(collect._p90([]))

    def test_closing_keyword_pattern(self):
        for text in ('Closes #12', 'fixes: #3', 'Resolved #9', 'close #1'):
            self.assertTrue(collect.CLOSING_KEYWORD.search(text), text)
        for text in ('Trial-Item: Q01', 'closes the loop', 'prefix #12', 'unclosed #4'):
            self.assertFalse(collect.CLOSING_KEYWORD.search(text), text)


if __name__ == '__main__':
    unittest.main()
