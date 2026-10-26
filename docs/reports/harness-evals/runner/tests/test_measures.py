"""measures.py: October's output pinned byte for byte, and the data-driven trial-2 mode.

Every run uses `--data <temp dir>`: the script writes measures-output.json beside its inputs,
so a test must never point it at the committed October data.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import helpers

MEASURES = os.path.join(helpers.OCTOBER, 'scripts', 'measures.py')
STDOUT_FIXTURE = os.path.join(helpers.FIXTURES, 'october', 'measures-stdout.txt')


def read_bytes(path):
    with open(path, 'rb') as fh:
        return fh.read()


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(value, fh, indent=2)


def run_measures(data, *flags):
    return subprocess.run([sys.executable, MEASURES, '--data', data, *flags], capture_output=True, text=True,
                          cwd=helpers.REPO_ROOT)


class OctoberIsPinned(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='trialctl-measures-')
        cls.data = os.path.join(cls.tmp, 'data')
        shutil.copytree(os.path.join(helpers.OCTOBER, 'data'), cls.data)
        os.remove(os.path.join(cls.data, 'measures-output.json'))
        cls.committed = os.path.join(helpers.OCTOBER, 'data', 'measures-output.json')
        cls.committed_mtime = os.stat(cls.committed).st_mtime_ns
        cls.result = run_measures(cls.data)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_exits_zero_with_nothing_on_stderr(self):
        self.assertEqual(self.result.returncode, 0, self.result.stderr)
        self.assertEqual(self.result.stderr, '')

    def test_stdout_is_the_committed_october_output(self):
        with open(STDOUT_FIXTURE, encoding='utf-8') as fh:
            self.assertEqual(self.result.stdout, fh.read())

    def test_measures_output_json_is_byte_identical_to_the_committed_file(self):
        self.assertEqual(read_bytes(os.path.join(self.data, 'measures-output.json')),
                         read_bytes(os.path.join(helpers.OCTOBER, 'data', 'measures-output.json')))

    def test_october_has_no_cell_tables_and_none_ungraded(self):
        self.assertNotIn('Table 4', self.result.stdout)
        self.assertNotIn('Table 5', self.result.stdout)
        self.assertNotIn('ungraded', self.result.stdout)

    def test_the_committed_october_data_was_not_touched(self):
        self.assertEqual(os.stat(self.committed).st_mtime_ns, self.committed_mtime)


def pr(number, issue, cycle, verdict='yes', state='merged'):
    merged = '2026-11-02T11:00:00Z' if state == 'merged' else None
    return {'issue': issue, 'pr': number, 'state': state, 'merged_at': merged,
            'cycle_minutes': cycle if state == 'merged' else None, 'copilot_review_bodies': 1,
            'owner_review_comment_bodies': 1, 'owner_all_comment_bodies': 1, 'diff_added': 10, 'diff_deleted': 2,
            'forbidden_closing_keyword': False, 'pr_body_issue_references': [], 'ci_run_count': 1,
            'correct_vs_key': verdict if state == 'merged' else None}


def run_evidence(report_minutes, cycles, verdicts=('yes', 'yes'), observable=None, red=None, pushes=0, others=0):
    start = '2026-11-02T10:00:00Z'
    prs = [pr(100 + i, 9001 + i, c, v) for i, (c, v) in enumerate(zip(cycles, verdicts))]
    prs.append(pr(98, 9002, None, state='closed'))                                     # closed, never graded
    prs.append({'issue': None, 'pr': 99, 'state': 'merged', 'merged_at': '2026-11-02T12:00:00Z',
                'cycle_minutes': 5, 'correct_vs_key': None})                           # the report PR
    commit = None
    if report_minutes is not None:
        hours, minutes = divmod(report_minutes, 60)
        commit = {'sha': 'abc', 'committer_date': f'2026-11-02T{10 + hours:02d}:{minutes:02d}:00Z'}
    ev = {'start': start, 'report_merged_or_cutoff': '2026-11-02T13:00:00Z', 'queue_ci_runs': 4,
          'queue_ci_attempts': 4, 'queue_all_pr_workflow_runs': 9, 'report_last_commit': commit, 'prs': prs,
          'base_push_ci': [{'id': i, 'conclusion': 'success'} for i in range(pushes)]}
    if others:
        ev['red_ci_unattributed'] = [{'id': 500 + i, 'conclusion': 'success'} for i in range(others)]
    if observable is not None:
        ev['ci_push_observable'] = observable
        ev['red_ci_on_base'] = red
    return ev


class TrialTwoMode(unittest.TestCase):
    """Two cells (A-native, A-chroxy) of two repeats each, with one contrast."""
    RUNS = {
        'A-cd-r1': ('A-native', 1, run_evidence(100, (20, 40), ('yes', 'yes'), observable=False, red=0)),
        'A-cd-r2': ('A-native', 2, run_evidence(120, (30, 50), ('yes', 'partial'))),
        'A-cy-r1': ('A-chroxy', 1, run_evidence(60, (10, 20), ('yes', 'yes'), observable=True, red=1, pushes=3,
                                                others=2)),
        'A-cy-r2': ('A-chroxy', 2, run_evidence(80, (20, 30), ('yes', 'yes'), observable=True, red=0, pushes=2)),
    }

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='trialctl-measures2-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.data = os.path.join(self.tmp, 'data')
        self.write(self.RUNS)

    def write(self, runs):
        meta = {}
        for run_id, (cell, repeat, ev) in runs.items():
            write_json(os.path.join(self.data, 'evidence', f'{run_id}.json'), {'runs': {run_id: ev}})
            meta[run_id] = {'arm': 'A', 'cell': cell, 'repeat': repeat, 'block': repeat, 'role': 'controlled',
                            'harness': 'h', 'coordinator': 'claude-opus-5-5 / high', 'cost': 'n/a',
                            'allowance': 'not recorded', 'approvals': 'not recorded', 'compactions': 'not recorded',
                            'waves': 'not recorded', 'stop': 'complete'}
        write_json(os.path.join(self.data, 'runs.json'), {
            'queue': [9001, 9002], 'T0': 'x', 'order': list(runs),
            'evidence_files': [f'evidence/{r}.json' for r in runs],
            'cells': {'A-native': {'arm': 'A', 'harness': 'CD', 'role': 'controlled native'},
                      'A-chroxy': {'arm': 'A', 'harness': 'CY', 'role': 'controlled Chroxy'}},
            'contrasts': [{'arm': 'A', 'native': 'A-native', 'chroxy': 'A-chroxy'}], 'runs': meta})
        write_json(os.path.join(self.data, 'tiebreaks.json'), {'source': 'none yet', 'overrides': [], 'conventions': {}})

    def lines(self, result):
        return result.stdout.splitlines()

    def test_clean_run_prints_the_october_tables_then_the_cell_tables(self):
        result = run_measures(self.data)
        self.assertEqual(result.returncode, 0, result.stderr)
        text = result.stdout
        positions = [text.index(h) for h in ('## Table 1', '## Table 2', '## Table 3', '## Table 4', '## Table 5',
                                              '## Paired contrasts')]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('| A-cd-r1 | controlled | 2 | **2** |', text)

    def test_table_4_lists_each_repeat_and_the_median_across_repeats(self):
        lines = self.lines(run_measures(self.data))
        self.assertIn('| A-native | A-cd-r1 | 1 | 2 | 1 h 40 min (100.0 min) | 30.0 |', lines)
        self.assertIn('| A-native | A-cd-r2 | 2 | 1 | 2 h 00 min (120.0 min) | 40.0 |', lines)
        self.assertIn('| **A-native** | **median of 2** | | **1.5** | **1 h 50 min (110.0 min)** | **35.0** |', lines)
        self.assertIn('| A-chroxy | A-cy-r1 | 1 | 2 | 1 h 00 min (60.0 min) | 15.0 |', lines)
        self.assertIn('| **A-chroxy** | **median of 2** | | **2** | **1 h 10 min (70.0 min)** | **20.0** |', lines)

    def test_contrast_lines_compare_the_cell_medians_not_the_october_pair(self):
        text = run_measures(self.data).stdout
        line = next(l for l in text.splitlines() if l.startswith('- Arm A:'))
        self.assertIn('A-native (median of 2) 1.5 delivered in 1 h 50 min (cycle median 35.0 min)', line)
        self.assertIn('vs A-chroxy (median of 2) 2 delivered in 1 h 10 min (cycle median 20.0 min)', line)
        self.assertIn('gap (A-chroxy minus A-native): delivered +0.5, -40.0 min to the report commit, '
                      'cycle median -15.0 min.', line)
        self.assertNotIn('A1-cd', text)
        self.assertEqual(sum(1 for l in text.splitlines() if l.startswith('- Arm ')), 1)

    def test_a_cell_median_with_a_missing_repeat_is_not_computed_over_the_rest(self):
        runs = dict(self.RUNS)
        runs['A-cd-r2'] = ('A-native', 2, run_evidence(None, (30, 50), ('yes', 'yes')))
        self.write(runs)
        result = run_measures(self.data)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = self.lines(result)
        self.assertIn('| A-native | A-cd-r2 | 2 | 2 | n/a | 40.0 |', lines)
        self.assertIn('| **A-native** | **median of 2** | | **2** | **n/a** | **35.0** |', lines)
        line = next(l for l in lines if l.startswith('- Arm A:'))
        self.assertIn('delivered +0', line)
        self.assertNotIn('min to the report commit', line)  # no wall gap from one repeat

    def test_red_ci_is_not_observable_unless_observable_and_never_a_zero(self):
        lines = self.lines(run_measures(self.data))
        self.assertIn('| Run | Merge push runs of `ci.yml` on the base | Other push runs of `ci.yml` on the base | '
                      'Red CI on the base |', lines)
        # observable False, with a stored 0
        self.assertIn('| A-cd-r1 | not observable | not observable | not observable |', lines)
        # observability never recorded
        self.assertIn('| A-cd-r2 | not observable | not observable | not observable |', lines)
        self.assertIn('| A-cy-r1 | 3 | 2 | 1 |', lines)  # three merge runs, two other push runs, red once
        self.assertIn('| A-cy-r2 | 2 | 0 | 0 |', lines)

    def test_observable_but_unknown_red_count_is_not_a_zero(self):
        runs = dict(self.RUNS)
        runs['A-cy-r2'] = ('A-chroxy', 2, run_evidence(80, (20, 30), observable=True, red=None, pushes=2))
        self.write(runs)
        self.assertIn('| A-cy-r2 | not observable | not observable | not observable |', self.lines(run_measures(self.data)))

    def test_per_run_json_gains_cell_and_red_ci_keys_in_this_mode_only(self):
        run_measures(self.data)
        out = json.loads(read_bytes(os.path.join(self.data, 'measures-output.json')))
        self.assertEqual(list(out), list(self.RUNS))
        self.assertEqual((out['A-cy-r1']['cell'], out['A-cy-r1']['repeat']), ('A-chroxy', 1))
        self.assertEqual((out['A-cy-r1']['ci_push_observable'], out['A-cy-r1']['red_ci_on_base']), (True, 1))
        self.assertEqual((out['A-cy-r1']['base_push_runs'], out['A-cy-r1']['other_push_runs']), (3, 2))
        self.assertEqual((out['A-cd-r1']['ci_push_observable'], out['A-cd-r1']['red_ci_on_base']), (False, None))
        october = json.loads(read_bytes(os.path.join(helpers.OCTOBER, 'data', 'measures-output.json')))
        self.assertNotIn('cell', october['A1-cd'])

    def ungrade(self, run_id, index=0):
        cell, repeat, ev = self.RUNS[run_id]
        ev = json.loads(json.dumps(ev))
        ev['prs'][index]['correct_vs_key'] = None
        runs = dict(self.RUNS)
        runs[run_id] = (cell, repeat, ev)
        self.write(runs)

    def test_a_merged_queue_pr_with_no_verdict_stops_the_run_with_exit_1(self):
        self.ungrade('A-cy-r2', 1)
        result = run_measures(self.data)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertIn('1 merged queue PR(s) have no grader verdict', result.stderr)
        self.assertIn('A-cy-r2 PR 101 (issue 9002)', result.stderr)
        self.assertIn('nothing printed or written', result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.data, 'measures-output.json')))

    def test_allow_ungraded_prints_and_counts_the_gap_as_not_delivered(self):
        self.ungrade('A-cy-r2', 1)
        result = run_measures(self.data, '--allow-ungraded')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('A-cy-r2 PR 101 (issue 9002)', result.stderr)  # still told
        self.assertIn('ungraded merged queue PRs counted as not delivered: A-cy-r2 PR 101', result.stdout)
        self.assertIn('| A-chroxy | A-cy-r2 | 2 | 1 | 1 h 20 min (80.0 min) | 25.0 |', self.lines(result))
        self.assertTrue(os.path.exists(os.path.join(self.data, 'measures-output.json')))

    def test_closed_prs_and_the_report_pr_without_verdicts_are_not_ungraded(self):
        # every run in the clean data set carries a closed PR and a report PR with correct_vs_key null
        result = run_measures(self.data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')

    def test_the_guard_also_covers_a_run_in_the_first_cell(self):
        self.ungrade('A-cd-r1', 0)
        result = run_measures(self.data)
        self.assertEqual(result.returncode, 1)
        self.assertIn('A-cd-r1 PR 100 (issue 9001)', result.stderr)


if __name__ == '__main__':
    unittest.main()
