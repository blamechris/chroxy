"""`trialctl status`: the read-only live view, and the mission-rule flags it raises."""
import unittest

import helpers
from trialkit import state, status
from trialkit.gh import GitHubError

T0 = 'a' * 40


def commit(sha, date, message):
    return {'sha': sha, 'commit': {'committer': {'date': date}, 'message': message}}


class DictGitHub:
    """GET responses keyed by path; `list` returns the stored list."""

    def __init__(self, responses):
        self.responses = responses
        self.repo = 'blamechris/chroxy'

    def repo_path(self, suffix):
        return f'repos/{self.repo}/{suffix}'

    def get(self, path, params=None):
        key = path + (f'?ref={params["ref"]}' if params and 'ref' in params else '')
        if key not in self.responses:
            raise GitHubError(f'404 {key}', 404)
        value = self.responses[key]
        if isinstance(value, GitHubError):
            raise value
        return value

    def list(self, path, params=None, key=None):
        return self.get(path)


class Status(unittest.TestCase):
    def setUp(self):
        self.box = helpers.Sandbox(edit=lambda d: (d.update(t0=T0), d['paths'].update(state_dir='~/state')))
        self.addCleanup(self.box.cleanup)
        self.trial = self.box.trial()
        self.run = self.trial.run('A-cd-r1')
        r = 'repos/blamechris/chroxy/'
        self.responses = {
            r + 'branches/trial/t2-a-cd-r1': {'commit': commit('b' * 40, '2026-11-02T10:00:00Z', 'feat: x (#9100)')},
            r + f'compare/{T0}...trial/t2-a-cd-r1': {'commits': [commit('c' * 40, '2026-11-02T09:00:00Z', 'docs(trial): mission for A-cd-r1')]},
            r + 'pulls': [
                {'number': 9100, 'state': 'closed', 'merged_at': '2026-11-02T10:00:00Z', 'created_at': '2026-11-02T09:30:00Z',
                 'title': 'fix(server): doctor port', 'body': 'Trial-Item: Q01\n\nSummary.'},
                {'number': 9101, 'state': 'open', 'merged_at': None, 'created_at': '2026-11-02T09:40:00Z',
                 'title': 'feat(dashboard): thing for 9002', 'body': 'Closes #9002'},
                {'number': 9102, 'state': 'open', 'merged_at': None, 'created_at': '2026-11-02T11:00:00Z',
                 'title': 'docs(trial): run report for A-cd-r1', 'body': 'Adds the report.'},
            ],
            r + 'issues/9001': {'number': 9001, 'state': 'open', 'comments': 0, 'updated_at': '2026-11-01T00:00:00Z', 'labels': []},
            r + 'issues/9002': {'number': 9002, 'state': 'open', 'comments': 1, 'updated_at': '2026-11-02T09:45:00Z',
                                'labels': [{'name': 'bug'}]},
            r + 'branches/main': {'commit': commit('d' * 40, '2026-11-01T00:00:00Z', 'main')},
        }
        state.save(self.trial, self.run.id, {'run': self.run.id, 'start': {'sent_at': '2026-11-02T09:00:00Z'}},
                   home=self.box.home)

    def output(self, responses):
        env = self.box.env(github=DictGitHub(responses))
        code = status.status(self.trial, self.run, env)
        return code, env.out.getvalue()

    def test_prints_the_live_view_and_flags_rule_breaks(self):
        code, out = self.output(self.responses)
        self.assertEqual(code, 0)
        self.assertIn('base=trial/t2-a-cd-r1', out)
        self.assertIn('docs(trial): mission for A-cd-r1', out)
        line_ok = next(l for l in out.splitlines() if l.startswith('9100'))
        self.assertNotIn('!!', line_ok)
        self.assertIn('Q01', line_ok)
        line_bad = next(l for l in out.splitlines() if l.startswith('9101'))
        self.assertIn('closing keyword', line_bad)
        self.assertIn('issue number 9002 for Q02', line_bad)
        self.assertIn('no Trial-Item slot', line_bad)
        report = next(l for l in out.splitlines() if l.startswith('9102'))
        self.assertNotIn('!!', report)
        self.assertIn('Q02 #9002', out)
        self.assertIn('!! updated after the send', next(l for l in out.splitlines() if l.startswith('Q02')))
        self.assertNotIn('!!', next(l for l in out.splitlines() if l.startswith('Q01')))
        self.assertIn('no report yet', out)

    def test_report_on_the_base(self):
        responses = dict(self.responses)
        responses[f'repos/blamechris/chroxy/contents/{self.trial.report_relpath(self.run)}?ref={self.run.base}'] = {'sha': 'e'}
        code, out = self.output(responses)
        self.assertEqual(code, 0)
        self.assertIn('the run is over', out)

    def test_github_failure_exits_2(self):
        responses = dict(self.responses)
        responses['repos/blamechris/chroxy/branches/main'] = GitHubError('HTTP 502', 502)
        code, out = self.output(responses)
        self.assertEqual(code, 2)
        self.assertIn('GitHub read failed', out)

    def test_a_report_probe_error_other_than_404_is_a_failure(self):
        responses = dict(self.responses)
        responses[f'repos/blamechris/chroxy/contents/{self.trial.report_relpath(self.run)}?ref={self.run.base}'] = \
            GitHubError('HTTP 403', 403)
        code, _ = self.output(responses)
        self.assertEqual(code, 2)


if __name__ == '__main__':
    unittest.main()
