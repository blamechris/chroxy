"""`trialctl queue-candidates`: every rule against an in-memory backlog, and the committed queue_rules."""
import json
import os
import re
import unittest

import helpers
from trialkit import candidates as queue_mod, cli, config
from trialkit.gh import GitHubError

REPO = 'blamechris/chroxy'
BLOCKERS = (8710, 8743, 8741, 8700)


def issue(number, title='an issue', labels=(), body='', user='blamechris', created='2026-10-20T08:00:00Z', **extra):
    return dict({'number': number, 'title': title, 'state': 'open', 'user': {'login': user}, 'created_at': created,
                 'labels': [{'name': name} for name in labels], 'body': body}, **extra)


def pull(number, title='a pr'):
    return dict(issue(number, title), pull_request={'url': 'x'})


def xref(number, state='open', pr=True, repo=REPO):
    source = {'number': number, 'state': state, 'repository': {'full_name': repo}}
    if pr:
        source['pull_request'] = {'url': 'x'}
    return {'event': 'cross-referenced', 'source': {'type': 'issue', 'issue': source}}


class Backlog:
    """The GitHub reads queue-candidates makes, answered from dictionaries. An unscripted request is a 404."""
    repo = REPO

    def __init__(self, *issues):
        self.issues = list(issues)
        self.timelines = {}   # issue number -> events, or an exception
        self.pulls = {}       # pr number -> (base ref, head ref)
        self.trial_branches = []
        self.base_prs = {}    # branch -> [pr numbers]
        self.files = {}       # pr number -> [file names]
        self.failures = {}    # request path suffix -> exception
        self.requests = []

    def repo_path(self, suffix):
        return f'repos/{self.repo}/{suffix.lstrip("/")}'

    def _answer(self, path, params):
        self.requests.append((path, dict(params or {})))
        short = path.split(f'repos/{self.repo}/', 1)[-1]
        for suffix, error in self.failures.items():
            if short.endswith(suffix):
                raise error
        if short == 'issues':
            return self.issues
        match = re.fullmatch(r'issues/(\d+)/timeline', short)
        if match:
            value = self.timelines.get(int(match.group(1)), [])
            if isinstance(value, Exception):
                raise value
            return value
        match = re.fullmatch(r'pulls/(\d+)', short)
        if match and int(match.group(1)) in self.pulls:
            base, head = self.pulls[int(match.group(1))]
            return {'number': int(match.group(1)), 'base': {'ref': base}, 'head': {'ref': head}}
        if short == 'git/matching-refs/heads/trial/':
            return [{'ref': f'refs/heads/{b}'} for b in self.trial_branches]
        if short == 'pulls':
            return [{'number': n} for n in self.base_prs.get((params or {}).get('base'), [])]
        match = re.fullmatch(r'pulls/(\d+)/files', short)
        if match:
            return [{'filename': f} for f in self.files.get(int(match.group(1)), [])]
        raise GitHubError(f'unscripted request {short}', 404)

    def get(self, path, params=None):
        return self._answer(path, params)

    def list(self, path, params=None, key=None):
        return self._answer(path, params)

    def asked(self, pattern):
        return [p for p, _ in self.requests if re.search(pattern, p)]


class Queue(unittest.TestCase):
    def setUp(self):
        self.box = helpers.Sandbox(edit=self.edit)
        self.addCleanup(self.box.cleanup)
        self.trial = self.box.trial()

    def edit(self, data):
        data['queue_rules'] = {'exclude_labels': ['epic', 'Needs-Dogfood'], 'reserved': [8609], 'exclude_issues': [7001]}
        data['github_login'] = 'blamechris'
        data['blockers'] = {'cy-codex': [8710, 8743], 'cy-claude': [8741, 8700]}

    def scan(self, backlog):
        return queue_mod.scan(self.trial, backlog, backlog.issues)

    def verdict(self, backlog, number):
        result = self.scan(backlog)
        for key in ('rejected', 'unverified'):
            for row in result[key]:
                if row['number'] == number:
                    return row['rule'], row['detail']
        return ('candidate', None) if any(c['number'] == number for c in result['candidates']) else (None, None)

    def rule_of(self, *issues, number=None, setup=None):
        backlog = Backlog(*issues)
        if setup:
            setup(backlog)
        return self.verdict(backlog, number or issues[0]['number'])[0]


class CheapRules(Queue):
    def test_a_plain_owner_issue_is_a_candidate_with_its_facts(self):
        body = '## Summary\nx\n\n## Acceptance criteria\n- a test\n'
        result = self.scan(Backlog(issue(9001, 'doctor port', ['bug', 'server', 'ux'], body, created='2026-10-04T07:50:20Z')))
        self.assertEqual(result['candidates'], [{'number': 9001, 'title': 'doctor port', 'labels': ['bug', 'server', 'ux'],
                                                 'created': '2026-10-04', 'type': 'bug', 'packages': ['server'],
                                                 'has_acceptance_criteria': True}])
        self.assertEqual((result['counts'], result['scanned']), ({}, {'issues': 1, 'pull_requests': 0}))

    def test_pull_requests_in_the_listing_are_counted_but_never_candidates(self):
        result = self.scan(Backlog(issue(9001), pull(9002)))
        self.assertEqual(([c['number'] for c in result['candidates']], result['scanned']), ([9001], {'issues': 1, 'pull_requests': 1}))

    def test_not_filed_by_the_owner(self):
        self.assertEqual(self.rule_of(issue(9001, user='renovate[bot]')), 'not-owner')

    def test_the_earlier_queue_and_the_reserved_issue(self):
        self.assertEqual(self.rule_of(issue(7001)), 'listed')
        self.assertEqual(self.rule_of(issue(8609)), 'reserved')

    def test_a_blocker_of_either_harness(self):
        for number in BLOCKERS:
            self.assertEqual(self.rule_of(issue(number)), 'blocker', number)

    def test_excluded_labels_match_whatever_the_case(self):
        self.assertEqual(self.rule_of(issue(9001, labels=['server', 'EPIC'])), 'label')
        self.assertEqual(self.rule_of(issue(9001, labels=['needs-dogfood'])), 'label')
        self.assertEqual(self.rule_of(issue(9001, labels=['server', 'bug'])), 'candidate')

    def test_epics_children_and_parents_by_their_structure_fields(self):
        self.assertEqual(self.rule_of(issue(9001, sub_issues_summary={'total': 2, 'completed': 0})), 'structure')
        self.assertEqual(self.rule_of(issue(9001, parent_issue_url='https://api.github.com/repos/x/y/issues/1')), 'structure')
        self.assertEqual(self.rule_of(issue(9001, sub_issues_summary={'total': 0}, parent_issue_url=None)), 'candidate')

    def test_each_out_of_scope_path_in_the_body(self):
        for mention in ('edit `.claude/commands/x.md`', 'the .github/workflows/ci.yml job', 'update docs/reports/harness-evals/trial/README.md',
                        'see ~/.claude/settings.json', 'in .CLAUDE/ lower case'):
            self.assertEqual(self.rule_of(issue(9001, body=mention)), 'scope', mention)
        self.assertEqual(self.rule_of(issue(9001, body='the claude directory and github workflows are fine')), 'candidate')

    def test_mentioning_a_blocker_or_the_reserved_issue_but_not_an_ordinary_one(self):
        for body in ('depends on #8710', 'see https://github.com/blamechris/chroxy/issues/8743', 'related to #8609 (reserved)'):
            self.assertEqual(self.rule_of(issue(9001, body=body)), 'mentions-blocked', body)
        self.assertEqual(self.rule_of(issue(9001, body='refs #9001 and #9002')), 'candidate')
        self.assertEqual(self.rule_of(issue(9001, body='the 8710 timeout')), 'candidate')

    def test_the_first_rule_that_applies_names_the_issue(self):
        both = issue(9001, labels=['epic'], body='.claude/x', user='someone')
        self.assertEqual(self.rule_of(both), 'not-owner')
        self.assertEqual(self.rule_of(issue(9001, labels=['epic'], body='.claude/x')), 'label')

    def test_type_guess_and_packages_come_from_labels(self):
        guess = queue_mod.type_guess
        self.assertEqual([guess(l) for l in (['bug', 'testing'], ['type: bug'], ['enhancement', 'app'], ['tech-debt'], ['docs'], ['ux'])],
                         ['test', 'bug', 'feature', 'tech-debt', 'docs', '?'])

    def test_acceptance_criteria_in_the_headings_and_leads_the_backlog_uses(self):
        for body in ('## Acceptance', '## Acceptance criteria\n- x', '**Acceptance:** a test', 'Acceptance: a test', '### acceptance Criteria'):
            self.assertTrue(queue_mod.ACCEPTANCE.search(body), body)
        for body in ('no such section', 'the acceptance of this was discussed', '## Scope and acceptance', ''):
            self.assertFalse(queue_mod.ACCEPTANCE.search(body), body)


class TimelineRules(Queue):
    def test_an_open_pr_that_cross_references_it(self):
        def setup(b):
            b.timelines[9001] = [xref(5, 'open')]
        self.assertEqual(self.rule_of(issue(9001), setup=setup), 'open-pr')

    def test_a_closed_pr_or_a_plain_issue_or_another_repository_does_not_rule_it_out(self):
        def setup(b):
            b.timelines[9001] = [xref(5, 'closed'), xref(6, 'open', pr=False), xref(7, 'open', repo='someone/else')]
            b.pulls[5] = ('main', 'fix/x')
        self.assertEqual(self.rule_of(issue(9001), setup=setup), 'candidate')

    def test_a_connected_pr(self):
        def setup(b):
            b.timelines[9001] = [{'event': 'connected'}]
        self.assertEqual(self.rule_of(issue(9001), setup=setup), 'connected-pr')

    def test_a_connection_that_was_removed_is_not_one(self):
        def setup(b):
            b.timelines[9001] = [{'event': 'connected'}, {'event': 'disconnected'}]
        self.assertEqual(self.rule_of(issue(9001), setup=setup), 'candidate')

    def test_a_pr_into_a_trial_branch_even_if_closed(self):
        def setup(b):
            b.timelines[9001] = [xref(5, 'closed')]
            b.pulls[5] = ('trial/a1-cd', 'fix/x')
        rule, detail = self.verdict(self.backlog(setup), 9001)
        self.assertEqual(rule, 'trial-xref')
        self.assertTrue('#5' in detail and 'trial/a1-cd' in detail)

    def test_a_pr_from_a_trial_branch(self):
        def setup(b):
            b.timelines[9001] = [xref(5, 'closed')]
            b.pulls[5] = ('main', 'trial/eval')
        self.assertEqual(self.verdict(self.backlog(setup), 9001)[0], 'trial-xref')

    def test_a_merged_pr_into_main_is_fine(self):
        def setup(b):
            b.timelines[9001] = [xref(5, 'closed')]
            b.pulls[5] = ('main', 'fix/x')
        self.assertEqual(self.verdict(self.backlog(setup), 9001)[0], 'candidate')

    def test_a_pr_base_is_fetched_once_however_many_issues_it_mentions(self):
        b = self.backlog(lambda b: (b.timelines.update({9001: [xref(5, 'closed')], 9002: [xref(5, 'closed')]}), b.pulls.update({5: ('main', 'x')})))
        self.scan(b)
        self.assertEqual(len(b.asked(r'pulls/5$')), 1)

    def backlog(self, setup, *issues):
        b = Backlog(*(issues or [issue(9001), issue(9002)]))
        setup(b)
        return b

    def test_a_timeline_github_cannot_answer_is_unverified_and_never_a_candidate(self):
        b = self.backlog(lambda b: b.timelines.update({9001: GitHubError('HTTP 502', 502)}))
        result = self.scan(b)
        self.assertEqual([c['number'] for c in result['candidates']], [9002])
        self.assertEqual([(r['number'], r['rule']) for r in result['unverified']], [(9001, 'unverified')])
        self.assertEqual(result['counts'], {'unverified': 1})

    def test_a_source_pr_github_cannot_answer_is_unverified_too(self):
        b = self.backlog(lambda b: b.timelines.update({9001: [xref(5, 'closed')]}))     # no pulls/5 scripted: a 404
        self.assertEqual(self.verdict(b, 9001)[0], 'unverified')


class TrialFileRules(Queue):
    def setup_trial(self, b, changed=None, branches=('trial/a1-cd',)):
        b.trial_branches = list(branches)
        b.base_prs = {'trial/a1-cd': [41, 42]}
        b.files = changed or {41: ['packages/server/src/bind-host.js', 'docs/x.md'], 42: ['packages/store-core/src/model-display.ts']}

    def rule(self, body, **kwargs):
        b = Backlog(issue(9001, body=body))
        self.setup_trial(b, **kwargs)
        return self.verdict(b, 9001)

    def test_a_full_path_a_partial_path_and_a_bare_name_all_find_the_changed_file(self):
        for body in ('see packages/server/src/bind-host.js', 'see server/src/bind-host.js:42', 'see src/bind-host.js#L10',
                     'see `bind-host.js`', 'in bind-host.js, line 3', '(bind-host.js).'):
            rule, detail = self.rule(body)
            self.assertEqual(rule, 'trial-files', body)
            self.assertTrue('PR #41 into trial/a1-cd' in detail, detail)

    def test_a_file_no_trial_pr_changed_passes(self):
        self.assertEqual(self.rule('see packages/server/src/other.js and docs/y.md')[0], 'candidate')

    def test_a_different_directory_with_the_same_ending_is_not_the_file(self):
        self.assertEqual(self.rule('see packages/app/src/xbind-host.js and old-bind-host.js')[0], 'candidate')
        self.assertEqual(self.rule('see packages/app/bind-host.js.bak')[0], 'candidate')
        self.assertEqual(self.rule('see ind-host.js and packages/server/src/bind-host.jsx')[0], 'candidate')

    def test_names_too_common_to_say_anything_are_ignored(self):
        changed = {41: ['packages/server/package.json', 'README.md', 'packages/app/src/index.ts']}
        self.assertEqual(self.rule('bump package.json, README.md and index.ts', changed=changed)[0], 'candidate')
        self.assertEqual(self.rule('edit packages/server/package.json', changed=changed)[0], 'trial-files')

    def test_urls_versions_and_line_suffixes_are_not_paths(self):
        self.assertEqual(queue_mod.mentioned_paths('see https://github.com/blamechris/chroxy/pull/9 v0.11.2 Node 22.5.0 and 1.5'), [])
        self.assertEqual(queue_mod.mentioned_paths('a/b.js:12-20, c.ts#L9 and a/b.js again'), ['a/b.js', 'c.ts'])

    def test_only_prs_into_trial_branches_count(self):
        b = Backlog(issue(9001, body='see bind-host.js'))
        b.trial_branches = []                      # none: a PR into main changing the file is the normal case
        b.files = {1: ['packages/server/src/bind-host.js']}
        self.assertEqual(self.verdict(b, 9001)[0], 'candidate')

    def test_prs_of_every_trial_branch_are_read_once_and_a_pr_listed_twice_is_fetched_once(self):
        b = Backlog(issue(9001, body='see zz.js'), issue(9002, body='see yy.js'))
        self.setup_trial(b, branches=('trial/a1-cd', 'trial/a2-cy'))
        b.base_prs = {'trial/a1-cd': [41, 42], 'trial/a2-cy': [42, 43]}
        b.files = {41: ['a.js'], 42: ['b.js'], 43: ['c.js']}
        self.scan(b)
        self.assertEqual(len(b.asked(r'pulls/41/files')), 1)
        self.assertEqual(len(b.asked(r'pulls/42/files')), 1)
        self.assertEqual(len(b.asked(r'pulls/43/files')), 1)
        self.assertEqual(len(b.asked(r'git/matching-refs')), 1)

    def test_a_file_changed_only_on_the_second_branch_is_found(self):
        b = Backlog(issue(9001, body='see c.js'))
        self.setup_trial(b, branches=('trial/a1-cd', 'trial/a2-cy'))
        b.base_prs = {'trial/a1-cd': [41], 'trial/a2-cy': [43]}
        b.files = {41: ['a.js'], 43: ['pkg/c.js']}
        rule, detail = self.verdict(b, 9001)
        self.assertEqual(rule, 'trial-files')
        self.assertTrue('trial/a2-cy' in detail)

    def test_when_the_trial_prs_cannot_be_read_the_issues_that_name_a_file_are_unverified(self):
        b = Backlog(issue(9001, body='see bind-host.js'), issue(9002, body='no file named here'))
        b.failures['git/matching-refs/heads/trial/'] = GitHubError('HTTP 502', 502)
        result = self.scan(b)
        self.assertEqual([(r['number'], r['rule']) for r in result['unverified']], [(9001, 'unverified')])
        self.assertEqual([c['number'] for c in result['candidates']], [9002])
        self.assertTrue('trial/* branches' in result['unverified'][0]['detail'])

    def test_a_failure_reading_one_prs_files_is_not_read_as_no_files(self):
        b = Backlog(issue(9001, body='see zz.js'))
        self.setup_trial(b)
        b.failures['pulls/42/files'] = GitHubError('HTTP 500', 500)
        self.assertEqual(self.verdict(b, 9001)[0], 'unverified')


class RequestOrder(Queue):
    """Cheap rules first: GitHub is not asked about an issue a listing field already rules out."""

    def test_no_timeline_is_read_for_an_issue_a_cheap_rule_drops(self):
        b = Backlog(issue(9001, labels=['epic']), issue(9002, user='bot'), issue(7001), issue(9003, body='.claude/x'), issue(9004))
        self.scan(b)
        self.assertEqual(b.asked(r'timeline'), ['repos/blamechris/chroxy/issues/9004/timeline'])

    def test_trial_prs_are_not_listed_when_no_surviving_issue_names_a_file(self):
        b = Backlog(issue(9001, body='no files here'), issue(9002, labels=['epic'], body='see bind-host.js'))
        self.scan(b)
        self.assertEqual(b.asked(r'matching-refs|/pulls'), [])

    def test_trial_files_rule_runs_before_any_timeline_call(self):
        b = Backlog(issue(9001, body='see bind-host.js'))
        b.trial_branches = ['trial/a1-cd']
        b.base_prs = {'trial/a1-cd': [41]}
        b.files = {41: ['packages/server/src/bind-host.js']}
        self.scan(b)
        self.assertEqual(b.asked(r'timeline'), [])


class Output(Queue):
    def command(self, backlog, *args):
        env = self.box.env(github=backlog)
        code = cli.main(['--trial', self.box.trial_dir, 'queue-candidates', *args], env=env)
        return code, env.out.getvalue()

    def backlog(self):
        b = Backlog(*[issue(9000 + n, f'issue {n}', ['bug']) for n in range(1, 6)], issue(8609, 'reserved one'), issue(7001, 'old queue'))
        return b

    def test_json_has_the_counts_the_candidates_and_the_reason_for_every_rejection(self):
        code, out = self.command(self.backlog(), '--json')
        doc = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual((doc['repo'], doc['scanned']), (REPO, {'issues': 7, 'pull_requests': 0}))
        self.assertEqual(doc['counts'], {'listed': 1, 'reserved': 1})
        self.assertEqual(sorted((r['number'], r['rule']) for r in doc['rejected']), [(7001, 'listed'), (8609, 'reserved')])
        self.assertEqual([c['number'] for c in doc['candidates']], [9005, 9004, 9003, 9002, 9001])   # newest first
        self.assertEqual(doc['candidates_total'], 5)
        self.assertEqual(doc['unverified'], [])

    def test_limit_shortens_the_list_but_not_the_scan(self):
        code, out = self.command(self.backlog(), '--json', '--limit', '2')
        doc = json.loads(out)
        self.assertEqual(([c['number'] for c in doc['candidates']], doc['candidates_total'], len(doc['rejected'])), ([9005, 9004], 5, 2))
        code, text = self.command(self.backlog(), '--limit', '2')
        self.assertTrue('candidates (2 of 5):' in text)

    def test_the_table_names_each_rejection_and_its_rule(self):
        code, text = self.command(self.backlog())
        self.assertEqual(code, 0)
        self.assertTrue('rejected by rule: listed 1, reserved 1' in text)
        self.assertTrue(re.search(r'#7001\s+listed:', text) and re.search(r'#8609\s+reserved:', text))
        self.assertTrue(re.search(r'#9005\s+2026-10-20\s+bug', text))

    def test_unverified_issues_make_the_exit_code_2_and_are_listed(self):
        b = self.backlog()
        b.timelines[9003] = GitHubError('HTTP 502', 502)
        code, text = self.command(b)
        self.assertEqual(code, 2)
        self.assertTrue(re.search(r'unverified \(GitHub could not answer.*\n\s+#9003', text))

    def test_a_failed_listing_is_exit_2_with_no_table(self):
        b = self.backlog()
        b.failures['issues'] = GitHubError('HTTP 500', 500)
        code, text = self.command(b)
        self.assertEqual(code, 2)
        self.assertTrue('cannot list the open issues' in text and 'candidates (' not in text)

    def test_no_owner_login_means_the_owner_filter_cannot_run(self):
        data = json.loads(json.dumps(self.trial.data))
        del data['github_login']
        self.box.write_trial(data)
        code, text = self.command(self.backlog())
        self.assertEqual(code, 2)
        self.assertTrue('github_login' in text)

    def test_limit_below_one_is_refused(self):
        self.assertEqual(self.command(self.backlog(), '--limit', '0')[0], 2)


class CommittedRules(unittest.TestCase):
    """trial-2's own queue_rules, as the runner will read them."""

    def setUp(self):
        self.trial = config.load(helpers.TRIAL2, root=helpers.REPO_ROOT)

    def test_the_spent_queue_is_exactly_octobers_ten(self):
        with open(os.path.join(helpers.OCTOBER, 'scripts', 'queue.json'), encoding='utf-8') as fh:
            october = [i['number'] for i in json.load(fh)['issues']]
        self.assertEqual(len(october), 10)
        self.assertEqual(sorted(self.trial.queue_rules['exclude_issues']), sorted(october))

    def test_the_codex_admission_issue_and_the_runner_issues_are_reserved(self):
        self.assertTrue({8609, 8757, 8759} <= set(self.trial.queue_rules['reserved']))

    def test_every_excluded_label_exists_on_the_repository(self):
        labels = set(self.trial.queue_rules['exclude_labels'])
        # the label set as listed on 2026-10-24; a typo here would filter nothing
        known = {'app', 'audit-finding', 'backlog-deferred', 'blocked:developer-program', 'bug', 'cleanup', 'dashboard', 'desktop',
                 'docs', 'documentation', 'duplicate', 'durability', 'enhancement', 'epic', 'from-review', 'good first issue',
                 'help wanted', 'ide', 'invalid', 'needs-dogfood', 'performance', 'protocol', 'question', 'refactor', 'roadmap',
                 'security', 'server', 'stale', 'subtask', 'tech-debt', 'testing', 'ux', 'wontfix'}
        self.assertEqual(sorted(labels - known), [])

    def test_the_trials_blockers_are_not_in_the_queue_lists(self):
        blockers = {n for numbers in self.trial.blockers.values() for n in numbers}
        listed = set(self.trial.queue_rules['exclude_issues']) | set(self.trial.queue_rules['reserved'])
        self.assertEqual(blockers & listed, set())


class RuleConfig(unittest.TestCase):
    def reject(self, rules, fragment):
        box = helpers.Sandbox(edit=lambda d: d.__setitem__('queue_rules', rules))
        self.addCleanup(box.cleanup)
        with self.assertRaises(config.ConfigError) as ctx:
            box.trial()
        self.assertTrue(fragment in str(ctx.exception), str(ctx.exception))

    def test_a_misspelt_key_is_refused_rather_than_ignored(self):
        self.reject({'reserverd': [1]}, "unknown key 'reserverd'")

    def test_wrong_types_are_refused(self):
        self.reject({'reserved': ['8609']}, 'issue numbers')
        self.reject({'exclude_issues': [True]}, 'issue numbers')
        self.reject({'exclude_labels': [7]}, 'strings')
        self.reject({'exclude_labels': 'epic'}, 'strings')
        self.reject(['epic'], 'must be an object')

    def test_absent_rules_are_empty(self):
        box = helpers.Sandbox(edit=lambda d: d.pop('queue_rules'))
        self.addCleanup(box.cleanup)
        self.assertEqual(box.trial().queue_rules, {})


if __name__ == '__main__':
    unittest.main()
