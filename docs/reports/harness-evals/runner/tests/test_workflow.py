"""The ci.yml push-trigger reader, against the real workflow and the spellings it must refuse."""
import os
import unittest

import helpers
from trialkit.workflow import WorkflowParseError, branch_covered, push_branches


class PushTrigger(unittest.TestCase):
    def test_the_real_ci_yml_runs_on_push_to_main_only(self):
        with open(os.path.join(helpers.REPO_ROOT, '.github', 'workflows', 'ci.yml'), encoding='utf-8') as fh:
            patterns = push_branches(fh.read())
        self.assertEqual(patterns, ['main'])
        self.assertTrue(branch_covered('main', patterns))
        self.assertFalse(branch_covered('trial/t2-a-cd-r1', patterns))

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

    def test_unreadable_spellings_raise(self):
        for text in ('name: x\n', 'on:\n  push:\n    branches-ignore: [x]\n',
                     'on:\n  push:\n    branches: [main\n', 'on:\n  push: {branches: [main]}\n'):
            with self.assertRaises(WorkflowParseError, msg=text):
                push_branches(text)


if __name__ == '__main__':
    unittest.main()
