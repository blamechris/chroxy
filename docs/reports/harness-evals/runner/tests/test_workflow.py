"""The ci.yml push-trigger reader, against the real workflow and the spellings it must refuse."""
import os
import unittest

import helpers
from trialkit.workflow import WorkflowParseError, branch_covered, push_branches


class PushTrigger(unittest.TestCase):
    def test_the_real_ci_yml_parses_and_runs_on_push_to_main(self):
        # Only what holds before and after the trial's push-trigger change (PLAN.md P3); coverage of
        # trial bases is exercised on synthetic workflows below.
        with open(os.path.join(helpers.REPO_ROOT, '.github', 'workflows', 'ci.yml'), encoding='utf-8') as fh:
            patterns = push_branches(fh.read())
        self.assertIsInstance(patterns, list)
        self.assertIn('main', patterns)
        self.assertTrue(branch_covered('main', patterns))

    def test_trial_trigger_with_eval_branches_excluded(self):
        text = "name: CI\non:\n  push:\n    branches: [main, 'trial/**', '!trial/*eval*']\n  pull_request:\n"
        patterns = push_branches(text)
        self.assertEqual(patterns, ['main', 'trial/**', '!trial/*eval*'])
        self.assertTrue(branch_covered('trial/t2-b-cy-r2', patterns))
        self.assertFalse(branch_covered('trial/t2-eval-claude', patterns))
        self.assertFalse(branch_covered('feature/x', patterns))

    def test_block_list_and_comments(self):
        text = "on:\n  push:\n    branches:\n      - main   # default\n      - \"trial/**\"\n  workflow_dispatch:\n"
        self.assertEqual(push_branches(text), ['main', 'trial/**'])

    def test_push_without_filter_covers_everything(self):
        self.assertIsNone(push_branches('on:\n  push:\n  pull_request:\n'))
        self.assertIsNone(push_branches('on: [push, pull_request]\n'))
        self.assertTrue(branch_covered('trial/x', None))

    def test_no_push_trigger(self):
        self.assertEqual(push_branches('on:\n  pull_request:\n'), [])
        self.assertFalse(branch_covered('main', []))

    def test_single_star_does_not_cross_a_slash(self):
        self.assertFalse(branch_covered('trial/t2/a', ['trial/*']))
        self.assertTrue(branch_covered('trial/t2/a', ['trial/**']))

    def test_other_push_filters_raise_rather_than_read_as_every_branch(self):
        for text in ('on:\n  push:\n    tags: [v*]\n',
                     'on:\n  push:\n    paths: [src/**]\n',
                     'on:\n  push:\n    branches: [main]\n    paths-ignore: [docs/**]\n',
                     'on:\n  push:\n    tags-ignore:\n      - x\n'):
            with self.assertRaises(WorkflowParseError, msg=text):
                push_branches(text)

    def test_a_push_key_under_another_event_is_not_the_push_trigger(self):
        text = 'on:\n  workflow_run:\n    workflows: [CI]\n    push:\n      branches: [main]\n  pull_request:\n'
        self.assertEqual(push_branches(text), [])

    def test_patterns_outside_the_supported_grammar_raise(self):
        for pattern in ('trial/t?-x', 'trial/t2+', 'trial/[ab]*'):
            with self.assertRaises(WorkflowParseError, msg=pattern):
                branch_covered('trial/t2-x', [pattern])

    def test_unsupported_patterns_raise_at_parse_time_where_callers_catch(self):
        with self.assertRaises(WorkflowParseError):
            push_branches("on:\n  push:\n    branches: [main, 'trial/t?-*']\n")
        with self.assertRaises(WorkflowParseError):
            push_branches("on:\n  push:\n    branches: ['!release/[0-9]*']\n")

    def test_unreadable_spellings_raise(self):
        for text in ('name: x\n', 'on:\n  push:\n    branches-ignore: [x]\n',
                     'on:\n  push:\n    branches: [main\n', 'on:\n  push: {branches: [main]}\n', 'on:\n'):
            with self.assertRaises(WorkflowParseError, msg=text):
                push_branches(text)


if __name__ == '__main__':
    unittest.main()
