"""The ci.yml push-trigger reader, against the real workflow and the spellings it must refuse."""
import os
import unittest

import helpers
from trialkit.workflow import WorkflowParseError, branch_covered, push_branches


class PushTrigger(unittest.TestCase):
    def test_the_real_ci_yml_runs_on_push_to_main_and_every_trial_base(self):
        # PLAN.md P3 (#8758): a merge into a trial base must run CI, or "red CI on the base" is not
        # observable; the graders' eval branches must not. The bases come from trial-2's roster, not a
        # hand-written list, so a run added to trial.json is covered or this goes red.
        from trialkit import config
        with open(os.path.join(helpers.REPO_ROOT, '.github', 'workflows', 'ci.yml'), encoding='utf-8') as fh:
            patterns = push_branches(fh.read())
        self.assertIsInstance(patterns, list)
        self.assertTrue(branch_covered('main', patterns))
        trial = config.load(helpers.TRIAL2, root=helpers.REPO_ROOT)
        self.assertGreaterEqual(len(trial.runs), 8)
        uncovered = [r.base for r in trial.runs if not branch_covered(r.base, patterns)]
        self.assertEqual(uncovered, [])
        for branch in (f'trial/{trial.id}-eval', f'trial/{trial.id}-eval-claude', f'trial/{trial.id}-eval-codex',
                       'trial/eval', 'trial/eval-claude'):
            self.assertFalse(branch_covered(branch, patterns), branch)
        self.assertFalse(branch_covered('feature/x', patterns))

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
