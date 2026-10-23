"""apply-verdicts, disputes and verify-key: what they accept, what they refuse and what they leave untouched."""
import hashlib
import json
import os
import re
import unittest

import helpers
from trialkit import cli, verdicts


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(value, fh, indent=2)


def read_bytes(path):
    with open(path, 'rb') as fh:
        return fh.read()


def merged_pr(number, issue, slot='unset'):
    pr = {'issue': issue, 'pr': number, 'state': 'merged', 'correct_vs_key': None}
    if slot != 'unset':
        pr['slot'] = slot
    return pr


def entry(verdict, checks=None, evidence=''):
    out = {'verdict': verdict, 'evidence': evidence}
    if checks is not None:
        out['checks'] = checks
    return out


class Fixture(unittest.TestCase):
    """A sandbox with two collected runs and two queue slots (Q01 = 9001, Q02 = 9002)."""

    def setUp(self):
        self.box = helpers.Sandbox()
        self.addCleanup(self.box.cleanup)
        self.trial = self.box.trial()
        self.data = os.path.join(self.box.tmp, 'data')
        self.evidence = {
            'A-cd-r1': [merged_pr(101, 9001, 'Q01'), merged_pr(102, 9002, 'Q02'),
                        {'issue': 9002, 'pr': 99, 'state': 'closed', 'slot': 'Q02', 'correct_vs_key': None},
                        {'issue': None, 'pr': 103, 'state': 'merged', 'correct_vs_key': None}],   # the report PR
            'B-cy-r1': [merged_pr(201, 9001), merged_pr(202, 9002)],                                # October-style: no slot
        }
        for run_id, prs in self.evidence.items():
            write_json(os.path.join(self.data, 'evidence', f'{run_id}.json'),
                       {'trial': 't2', 'run': run_id, 'runs': {run_id: {'prs': prs}}})

    def evidence_file(self, run_id):
        return os.path.join(self.data, 'evidence', f'{run_id}.json')

    def snapshot(self):
        return {r: read_bytes(self.evidence_file(r)) for r in self.evidence}

    def verdicts_file(self, runs, grader='G-claude', name='verdicts.json'):
        path = os.path.join(self.box.tmp, name)
        write_json(path, {'grader': grader, 'runs': runs})
        return path

    def full(self, grader='G-claude'):
        return self.verdicts_file({
            'A-cd-r1': {'Q01': entry('yes', {'K1': 'pass', 'K2': 'pass'}, 'ok'), 'Q02': entry('partial', {'K1': 'pass', 'K2': 'fail'}, 'K2 fails')},
            'B-cy-r1': {'Q01': entry('no', {'K1': 'fail'}, 'x'), 'Q02': entry('key-unknown')}}, grader)

    def apply(self, path):
        env = self.box.env()
        code = verdicts.apply_verdicts(self.trial, env, path, data_dir=self.data)
        self.output = env.out.getvalue()
        return code

    def pr_of(self, run_id, number):
        doc = json.loads(read_bytes(self.evidence_file(run_id)))
        return next(p for p in doc['runs'][run_id]['prs'] if p['pr'] == number)


class ApplyVerdicts(Fixture):
    def test_sets_the_verdict_and_its_source_on_merged_queue_prs_only(self):
        self.assertEqual(self.apply(self.full()), 0, self.output)
        self.assertEqual(self.pr_of('A-cd-r1', 101)['correct_vs_key'], 'yes')
        self.assertEqual(self.pr_of('A-cd-r1', 102)['correct_vs_key'], 'partial')
        self.assertEqual(self.pr_of('A-cd-r1', 101)['verdict_source'], 'G-claude')
        self.assertEqual(self.pr_of('B-cy-r1', 201)['correct_vs_key'], 'no')
        self.assertEqual(self.pr_of('B-cy-r1', 202)['correct_vs_key'], 'key-unknown')
        self.assertIsNone(self.pr_of('A-cd-r1', 99)['correct_vs_key'])   # closed, unmerged
        self.assertIsNone(self.pr_of('A-cd-r1', 103)['correct_vs_key'])  # the report PR
        self.assertNotIn('verdict_source', self.pr_of('A-cd-r1', 103))
        self.assertIn('set correct_vs_key on 4 merged PR(s) in 2 evidence file(s)', self.output)

    def test_a_pr_without_a_slot_field_is_matched_through_its_issue(self):
        self.apply(self.full())
        self.assertEqual(self.pr_of('B-cy-r1', 201)['correct_vs_key'], 'no')  # issue 9001 is Q01

    def test_a_merged_pr_with_no_verdict_stops_everything_and_writes_nothing(self):
        before = self.snapshot()
        path = self.verdicts_file({'A-cd-r1': {'Q01': entry('yes')},
                                   'B-cy-r1': {'Q01': entry('yes'), 'Q02': entry('yes')}})
        self.assertEqual(self.apply(path), 1)
        self.assertIn('A-cd-r1 Q02 (PR 102)', self.output)
        self.assertIn('nothing written', self.output)
        self.assertEqual(self.snapshot(), before)

    def test_a_collected_run_the_grader_skipped_is_listed_not_ignored(self):
        before = self.snapshot()
        path = self.verdicts_file({'A-cd-r1': {'Q01': entry('yes'), 'Q02': entry('yes')}})
        self.assertEqual(self.apply(path), 1)
        self.assertIn('B-cy-r1 Q01 (PR 201)', self.output)
        self.assertIn('B-cy-r1 Q02 (PR 202)', self.output)
        self.assertEqual(self.snapshot(), before)

    def test_a_verdict_for_a_slot_with_no_merged_pr_is_noted_and_ignored(self):
        path = self.verdicts_file({
            'A-cd-r1': {'Q01': entry('yes'), 'Q02': entry('yes')},
            'B-cy-r1': {'Q01': entry('yes'), 'Q02': entry('yes')}})
        write_json(self.evidence_file('B-cy-r1'), {'runs': {'B-cy-r1': {'prs': [merged_pr(201, 9001)]}}})
        self.assertEqual(self.apply(path), 0, self.output)
        self.assertIn('B-cy-r1 Q02 has a verdict but no merged PR; ignored', self.output)

    def test_applying_again_replaces_the_earlier_verdicts(self):
        self.apply(self.full('G-claude'))
        again = self.verdicts_file({'A-cd-r1': {'Q01': entry('no'), 'Q02': entry('no')},
                                    'B-cy-r1': {'Q01': entry('no'), 'Q02': entry('no')}}, 'G-codex')
        self.assertEqual(self.apply(again), 0)
        pr = self.pr_of('A-cd-r1', 101)
        self.assertEqual((pr['correct_vs_key'], pr['verdict_source']), ('no', 'G-codex'))

    def test_a_run_with_verdicts_but_no_evidence_is_refused(self):
        os.remove(self.evidence_file('B-cy-r1'))
        before = read_bytes(self.evidence_file('A-cd-r1'))
        path = self.verdicts_file({'A-cd-r1': {'Q01': entry('yes'), 'Q02': entry('yes')},
                                   'B-cy-r1': {'Q01': entry('yes')}})
        self.assertEqual(self.apply(path), 2)
        self.assertIn('no collected evidence for B-cy-r1', self.output)
        self.assertEqual(read_bytes(self.evidence_file('A-cd-r1')), before)

    def test_no_evidence_at_all_is_refused(self):
        env = self.box.env()
        code = verdicts.apply_verdicts(self.trial, env, self.full(), data_dir=os.path.join(self.box.tmp, 'empty'))
        self.assertEqual(code, 2)
        self.assertIn('run `trialctl collect` first', env.out.getvalue())

    def test_every_malformed_input_is_exit_2_with_the_reason_and_leaves_the_evidence_alone(self):
        good = {'Q01': entry('yes'), 'Q02': entry('yes')}
        cases = [
            ({'A-cd-r1': {'Q09': entry('yes')}}, 'unknown slot'),
            ({'A-cd-r9': good}, "unknown run 'A-cd-r9'"),
            ({'A-cd-r1': {'Q01': entry('maybe')}}, "verdict 'maybe' is not one of"),
            ({'A-cd-r1': {'Q01': {'checks': {'K1': 'pass'}}}}, 'verdict None'),
            ({'A-cd-r1': {'Q01': entry('yes', {'K1': 'good'})}}, "'good' is not one of pass, partial, fail"),
            ({'A-cd-r1': {'Q01': entry('yes', {'check1': 'pass'})}}, 'must look like K1'),
            ({'A-cd-r1': {'Q01': entry('yes', ['K1'])}}, '"checks" must be an object'),
            ({'A-cd-r1': {'Q01': dict(entry('yes'), evidence=3)}}, '"evidence" must be a string'),
            ({'A-cd-r1': ['Q01']}, 'expected an object of slots'),
            ({'A-cd-r1': {'Q01': 'yes'}}, 'expected an object with "verdict"'),
            ({}, 'at least one run'),
        ]
        before = self.snapshot()
        for runs, fragment in cases:
            code = self.apply(self.verdicts_file(runs))
            self.assertEqual(code, 2, fragment)
            self.assertIn(fragment, self.output)
        self.assertEqual(self.snapshot(), before)

    def test_unreadable_or_misshapen_files_are_exit_2(self):
        bad = os.path.join(self.box.tmp, 'bad.json')
        with open(bad, 'w') as fh:
            fh.write('{not json')
        self.assertEqual(self.apply(bad), 2)
        self.assertIn('cannot read', self.output)
        self.assertEqual(self.apply(os.path.join(self.box.tmp, 'absent.json')), 2)
        with open(bad, 'w') as fh:
            fh.write('[]')
        self.assertEqual(self.apply(bad), 2)
        self.assertIn('top level must be an object', self.output)
        write_json(bad, {'runs': {'A-cd-r1': {}}})
        self.assertEqual(self.apply(bad), 2)
        self.assertIn('"grader" must be a non-empty string', self.output)

    def test_all_the_problems_are_listed_not_just_the_first(self):
        self.apply(self.verdicts_file({'A-cd-r1': {'Q09': entry('yes'), 'Q01': entry('maybe')}, 'Z': {}}))
        self.assertIn('unknown slot', self.output)
        self.assertIn('not one of yes', self.output)
        self.assertIn("unknown run 'Z'", self.output)

    def test_through_the_cli(self):
        env = self.box.env()
        code = cli.main(['--trial', self.box.trial_dir, 'apply-verdicts', self.full(), '--data', self.data], env=env)
        self.assertEqual(code, 0)
        self.assertEqual(self.pr_of('A-cd-r1', 102)['correct_vs_key'], 'partial')


class Disputes(Fixture):
    def pair(self):
        a = self.verdicts_file({
            'A-cd-r1': {'Q01': entry('yes', {'K1': 'pass', 'K2': 'pass', 'K10': 'pass'}, 'a says fine'),
                        'Q02': entry('partial', {'K1': 'pass'})},
            'B-cy-r1': {'Q01': entry('no', {'K1': 'fail'}), 'Q02': entry('yes')}}, 'G-claude', 'a.json')
        b = self.verdicts_file({
            'A-cd-r1': {'Q01': entry('partial', {'K1': 'pass', 'K2': 'fail', 'K10': 'partial'}, 'b | disagrees\non K2'),
                        'Q02': entry('partial', {'K1': 'pass'})},
            'B-cy-r1': {'Q01': entry('no', {'K1': 'fail'})}}, 'G-codex', 'b.json')
        return a, b

    def run_disputes(self, a, b, markdown=False):
        env = self.box.env()
        code = verdicts.disputes(self.trial, env, a, b, markdown=markdown)
        return code, env.out.getvalue()

    def test_text_lists_every_difference_and_counts_them(self):
        code, out = self.run_disputes(*self.pair())
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0], 'disputes: A = G-claude, B = G-codex')
        self.assertIn('A-cd-r1 Q01 verdict: A=yes B=partial', lines)
        self.assertIn('A-cd-r1 Q01 K2: A=pass B=fail', lines)
        self.assertIn('A-cd-r1 Q01 K10: A=pass B=partial', lines)
        self.assertIn('B-cy-r1 Q02 verdict: A=yes B=(not graded)', lines)
        self.assertNotIn('A-cd-r1 Q02', out)  # agreed on verdict and checks
        self.assertNotIn('K1:', out)
        self.assertEqual(lines[-1], '4 difference(s)')
        self.assertLess(lines.index('A-cd-r1 Q01 K2: A=pass B=fail'), lines.index('A-cd-r1 Q01 K10: A=pass B=partial'))

    def test_the_verdict_row_carries_both_graders_evidence(self):
        _, out = self.run_disputes(*self.pair())
        self.assertIn('A: a says fine / B: b | disagrees on K2', out)

    def test_markdown_is_a_table_with_escaped_pipes(self):
        code, out = self.run_disputes(*self.pair(), markdown=True)
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0], '| Run | Slot | Item | A = G-claude | B = G-codex | Evidence |')
        self.assertEqual(lines[1], '|---|---|---|---|---|---|')
        self.assertTrue(any(l.startswith('| A-cd-r1 | Q01 | verdict | yes | partial |') for l in lines))
        self.assertIn('b \\| disagrees', out)
        self.assertEqual(sum(1 for l in lines if re.match(r'^\| (A|B)-', l)), 4)
        self.assertEqual(lines[-1], '4 difference(s)')

    def test_no_difference(self):
        a, _ = self.pair()
        code, out = self.run_disputes(a, a)
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines()[-1], '0 difference(s)')

    def test_a_malformed_file_is_exit_2(self):
        a, b = self.pair()
        write_json(b, {'grader': 'G-codex', 'runs': {'NOPE': {}}})
        code, out = self.run_disputes(a, b)
        self.assertEqual(code, 2)
        self.assertIn("unknown run 'NOPE'", out)
        self.assertEqual(self.run_disputes(a, os.path.join(self.box.tmp, 'absent.json'))[0], 2)

    def test_through_the_cli(self):
        a, b = self.pair()
        env = self.box.env()
        self.assertEqual(cli.main(['--trial', self.box.trial_dir, 'disputes', a, b, '--markdown'], env=env), 0)
        self.assertIn('4 difference(s)', env.out.getvalue())


class VerifyKey(unittest.TestCase):
    KEY = b'# Sealed key\n\nK1 passes when the port is read from config.\n'

    def setUp(self):
        self.box = helpers.Sandbox()
        self.addCleanup(self.box.cleanup)
        self.trial = self.box.trial()
        self.key = os.path.join(self.box.home, 'KEY.md')
        with open(self.key, 'wb') as fh:
            fh.write(self.KEY)

    def commit(self, content=None, size=None):
        """Write a commitment in October's shape, with the digest and size of `content`."""
        with open(os.path.join(helpers.OCTOBER, 'KEY-COMMITMENT.md'), encoding='utf-8') as fh:
            text = fh.read()
        content = self.KEY if content is None else content
        text = re.sub(r'`[0-9a-f]{64}`', f'`{hashlib.sha256(content).hexdigest()}`', text)
        text = re.sub(r'\| Size \| \d+ bytes \|', f'| Size | {len(content) if size is None else size} bytes |', text)
        with open(os.path.join(self.trial.dir, 'KEY-COMMITMENT.md'), 'w', encoding='utf-8') as fh:
            fh.write(text)

    def verify(self, path=None):
        env = self.box.env()
        code = verdicts.verify_key(self.trial, env, path or self.key)
        return code, env.out.getvalue()

    def test_a_matching_key(self):
        self.commit()
        code, out = self.verify()
        self.assertEqual(code, 0, out)
        self.assertIn('the key is the one sealed', out)
        self.assertNotIn('MISMATCH', out)

    def test_one_changed_byte_keeps_the_size_and_breaks_the_digest(self):
        self.commit()
        changed = self.KEY.replace(b'passes', b'passed')
        self.assertEqual(len(changed), len(self.KEY))
        with open(self.key, 'wb') as fh:
            fh.write(changed)
        code, out = self.verify()
        self.assertEqual(code, 1)
        digest_row = next(l for l in out.splitlines() if l.lstrip().startswith('sha256'))
        size_row = next(l for l in out.splitlines() if l.lstrip().startswith('size'))
        self.assertTrue(digest_row.endswith('MISMATCH'))
        self.assertTrue(size_row.endswith('match'))
        self.assertIn('report it as an incident', out)

    def test_a_wrong_size_alone_is_a_mismatch(self):
        self.commit(size=len(self.KEY) + 1)
        code, out = self.verify()
        self.assertEqual(code, 1)
        self.assertTrue(next(l for l in out.splitlines() if l.lstrip().startswith('size')).endswith('MISMATCH'))

    def test_a_commitment_that_is_not_sealed_is_exit_2_not_a_pass(self):
        # trial 2's own commitment says "not sealed yet" in both rows
        code, out = self.verify()
        self.assertEqual(code, 2)
        self.assertIn('not sealed', out)

    def test_a_missing_commitment_or_key_is_exit_2(self):
        self.commit()
        self.assertEqual(self.verify(os.path.join(self.box.home, 'absent.md'))[0], 2)
        os.remove(os.path.join(self.trial.dir, 'KEY-COMMITMENT.md'))
        code, out = self.verify()
        self.assertEqual(code, 2)
        self.assertIn('cannot read', out)

    def test_a_tilde_in_the_key_path_is_this_envs_home(self):
        self.commit()
        self.assertEqual(self.verify('~/KEY.md')[0], 0)

    def test_octobers_real_commitment_parses_to_its_digest_and_size(self):
        with open(os.path.join(helpers.OCTOBER, 'KEY-COMMITMENT.md'), encoding='utf-8') as fh:
            digest, size = verdicts.parse_commitment(fh.read())
        self.assertEqual(digest, 'fb5599f33ddac7eb230b7edc29f0fefd5b3be7c39c746bf5dcd7055d24d40f23')
        self.assertEqual(size, 7782)

    def test_other_digest_like_text_is_not_taken_for_the_digest(self):
        digest, size = verdicts.parse_commitment(
            '| Field | Value |\n|---|---|\n| Sealed at (UTC) | `' + 'a' * 64 + '` |\n| SHA-256 of `KEY.md` | pending |\n| Size | 12 |\n')
        self.assertIsNone(digest)
        self.assertEqual(size, 12)

    def test_through_the_cli(self):
        self.commit()
        env = self.box.env()
        self.assertEqual(cli.main(['--trial', self.box.trial_dir, 'verify-key', self.key], env=env), 0)


if __name__ == '__main__':
    unittest.main()
