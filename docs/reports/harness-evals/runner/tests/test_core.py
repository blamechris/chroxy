"""Config, rendering, checks, state, the GitHub double and the CLI's own wiring."""
import json
import os
import posixpath
import re
import shutil
import subprocess
import tempfile
import unittest
from collections import Counter

import helpers
from trialkit import checks, cli, config, render, state, timeutil
from trialkit.gh import FixtureGitHub, GitHubError, RecordingGitHub, request_key


class Trial2Roster(unittest.TestCase):
    """The committed trial-2 roster has the design PLAN.md section 3 describes."""

    def setUp(self):
        self.trial = config.load(helpers.TRIAL2, root=helpers.REPO_ROOT)

    def test_two_repeats_per_cell(self):
        counts = Counter(r.cell for r in self.trial.runs)
        self.assertEqual(set(counts), set(self.trial.cells))
        self.assertTrue(all(n == 2 for n in counts.values()), counts)
        for cell in self.trial.cells:
            self.assertEqual(sorted(r.repeat for r in self.trial.runs if r.cell == cell), [1, 2])

    def test_vendors_alternate_at_every_step(self):
        arms = [r.arm for r in self.trial.runs]
        self.assertTrue(all(a != b for a, b in zip(arms, arms[1:])), arms)

    def test_native_goes_first_in_one_block_and_second_in_the_other(self):
        for arm in self.trial.arms:
            firsts = []
            for block in (1, 2):
                in_block = [r for r in self.trial.runs if r.arm == arm and r.block == block]
                self.assertEqual(len(in_block), 2)
                firsts.append(in_block[0].harness.chroxy)
            self.assertEqual(sorted(firsts), [False, True], f'arm {arm}: {firsts}')

    def test_rendered_missions_cannot_reach_main(self):
        # A rendered mission on main would sit in every clone and leave `cut` nothing to commit.
        def ignored(rel):
            return subprocess.run(['git', '-C', helpers.REPO_ROOT, 'check-ignore', '-q', '--no-index', rel]).returncode
        for run in self.trial.runs:
            self.assertEqual(ignored(self.trial.mission_relpath(run)), 0, run.id)
        self.assertEqual(ignored(f'{helpers.TRIAL_REL}/missions/TEMPLATE.md'), 1)

    def test_the_queue_snapshot_cut_writes_can_be_committed(self):
        # `cut` writes it beside trial.json and the supervisor commits the two together; an ignored one would never arrive.
        rel = f'{helpers.TRIAL_REL}/queue-t0.json'
        ignored = subprocess.run(['git', '-C', helpers.REPO_ROOT, 'check-ignore', '-q', '--no-index', rel]).returncode
        self.assertEqual(ignored, 1)

    def test_bases_are_trial2_namespaced_and_unique(self):
        bases = [r.base for r in self.trial.runs]
        self.assertEqual(len(bases), len(set(bases)))
        self.assertTrue(all(b.startswith('trial/t2-') for b in bases), bases)

    def test_arm_settings_reach_runs(self):
        a = self.trial.run('A-cy-r1')
        self.assertEqual((a.model, a.effort, a.harness.key), ('claude-opus-5-5', 'high', 'cy-claude'))
        b = self.trial.run('B-cx-r2')
        self.assertEqual((b.model, b.effort, b.harness.family), ('gpt-6-astra', 'xhigh', 'codex'))

    def test_blockers_follow_the_harness(self):
        self.assertEqual(self.trial.blockers_for(self.trial.run('B-cy-r1')), [8710, 8743])
        self.assertEqual(self.trial.blockers_for(self.trial.run('A-cy-r2')), [8700, 8741])
        self.assertEqual(self.trial.blockers_for(self.trial.run('A-cd-r1')), [])

    def test_evidence_lives_beside_the_sealed_key_in_the_declared_vault(self):
        paths = self.trial.paths
        self.assertTrue(paths['evidence_dir'].startswith(paths['key_folder'] + '/'))
        self.assertTrue(paths['key_folder'].startswith(paths['evidence_vault'] + '/'))
        for name in ('evidence_dir', 'key_folder', 'evidence_vault'):
            self.assertTrue(paths[name].startswith('~/'), name)

    def test_the_committed_price_table_is_absent_or_valid(self):
        from trialkit import extract
        self.assertIsNone(extract.parse_prices(self.trial.prices)[1])

    def test_unknown_run_names_the_roster(self):
        with self.assertRaises(config.ConfigError) as ctx:
            self.trial.run('A1-cd')
        self.assertIn('A-cd-r1', str(ctx.exception))


EVALS_REL = posixpath.dirname(helpers.TRIAL_REL)
OCTOBER_CANDIDATES = f'{EVALS_REL}/trial/queue-candidates.md'


def tracked_files(root=helpers.REPO_ROOT, under=EVALS_REL):
    """The paths git tracks below `under`. A git failure and an empty listing both raise: a scan over
    "nothing" must not be able to read as "nothing found" (docs/false-safety-guards.md)."""
    p = subprocess.run(['git', '-C', root, 'ls-files', '-z', '--', under], capture_output=True, text=True)
    if p.returncode != 0:
        raise AssertionError(f'git ls-files {under} failed in {root} (exit {p.returncode}): {p.stderr.strip()[:200]}')
    paths = [x for x in p.stdout.split('\0') if x]
    if not paths:
        raise AssertionError(f'git ls-files {under} listed nothing in {root}, so there is nothing to scan')
    return paths


def notes_outside_trial_2(paths):
    """The tracked Markdown notes below `docs/reports/harness-evals/` that are not trial 2's own. Data files
    (`.csv`, `.json`) hold issue-list metadata, not notes, and are out of scope."""
    return [p for p in paths if p.endswith('.md') and not p.startswith(f'{helpers.TRIAL_REL}/')]


def queue_mentions(issues, rels, root=helpers.REPO_ROOT):
    """(path, line number, issue) for each line of each file that names a queue issue as `#N` or as a bare whole
    word. A file that cannot be read raises, so an unreadable note is not a clean one."""
    pattern = re.compile(r'\b(' + '|'.join(str(n) for n in issues) + r')\b')
    found = []
    for rel in rels:
        with open(os.path.join(root, rel), encoding='utf-8') as fh:
            for number, line in enumerate(fh, 1):
                found += [(rel, number, int(m.group(1))) for m in pattern.finditer(line)]
    return found


class OctoberNotesStayOutOfTheTree(unittest.TestCase):
    """Every clone carries the whole tree, so a note about a queue item that sits in it is read by accident, mission
    rule or no mission rule: a repo-wide grep for the item's symbol finds it (#8794)."""

    def setUp(self):
        self.trial = config.load(helpers.TRIAL2, root=helpers.REPO_ROOT)
        self.issues = [s.issue for s in self.trial.slots]

    def test_the_october_candidate_read_is_not_tracked(self):
        self.assertFalse(OCTOBER_CANDIDATES in tracked_files(),
                         f'{OCTOBER_CANDIDATES} is tracked: it holds selection, rationale and risk notes on queue '
                         'items, and belongs in the private key folder, not in a clone')

    def test_no_note_outside_trial_2_names_a_queue_issue(self):
        self.assertTrue(self.issues, 'trial-2 records no queue slots, so there is no issue to look for')
        notes = notes_outside_trial_2(tracked_files())
        # The scan must reach the October tree and the runner's own docs, or an empty result means nothing.
        for anchor in (f'{EVALS_REL}/trial/queue.md', f'{EVALS_REL}/runner/README.md'):
            self.assertTrue(anchor in notes, f'{anchor} is not among the {len(notes)} notes scanned')
        found = queue_mentions(self.issues, notes)
        self.assertFalse(found, f'{len(found)} mention(s) of a trial-2 queue issue outside trial-2/ '
                                f'(path, line, issue): {found[:10]}')

    def test_the_scan_sees_the_forms_a_note_would_use(self):
        tmp = tempfile.mkdtemp(prefix='trialctl-notes-')
        self.addCleanup(shutil.rmtree, tmp, True)
        files = {'a.md': 'rejected #9001: too large\n', 'b.md': 'first line\nbare 9001 here\nsee issues/9001.\n',
                 'c.md': 'issue 19001 and 90010 and v9001a and x9001 are other numbers\n',
                 'd.md': 'other issue #9999 only\n'}
        for name, text in files.items():
            with open(os.path.join(tmp, name), 'w', encoding='utf-8') as fh:
                fh.write(text)
        self.assertEqual(queue_mentions([9001, 4242], ['a.md', 'b.md', 'c.md', 'd.md'], root=tmp),
                         [('a.md', 1, 9001), ('b.md', 2, 9001), ('b.md', 3, 9001)])

    def test_only_markdown_outside_trial_2_is_scanned(self):
        listing = [f'{EVALS_REL}/trial/queue.md', f'{EVALS_REL}/data/runs-2026-10-17.csv',
                   f'{EVALS_REL}/data/raw/runs.json', f'{helpers.TRIAL_REL}/PLAN.md',
                   f'{helpers.TRIAL_REL}/missions/TEMPLATE.md', f'{EVALS_REL}/runner/README.md',
                   f'{EVALS_REL}/trial-20/notes.md']
        self.assertEqual(notes_outside_trial_2(listing),
                         [f'{EVALS_REL}/trial/queue.md', f'{EVALS_REL}/runner/README.md', f'{EVALS_REL}/trial-20/notes.md'])

    def test_a_note_that_cannot_be_read_fails_the_scan(self):
        with self.assertRaises(OSError):
            queue_mentions([9001], ['no-such-note.md'], root=tempfile.gettempdir())

    def test_a_git_failure_or_an_empty_listing_fails_instead_of_finding_nothing(self):
        tmp = tempfile.mkdtemp(prefix='trialctl-notes-')
        self.addCleanup(shutil.rmtree, tmp, True)
        with self.assertRaises(AssertionError) as missing:
            tracked_files(root=os.path.join(tmp, 'no-such-directory'))
        self.assertIn('failed', str(missing.exception))
        with self.assertRaises(AssertionError) as empty:
            tracked_files(under=f'{EVALS_REL}/no-such-directory')
        self.assertIn('listed nothing', str(empty.exception))


class ConfigValidation(unittest.TestCase):
    def check_rejects(self, edit, fragment):
        box = helpers.Sandbox(edit=edit)
        self.addCleanup(box.cleanup)
        with self.assertRaises(config.ConfigError) as ctx:
            box.trial()
        self.assertIn(fragment, str(ctx.exception))

    def test_duplicate_run(self):
        self.check_rejects(lambda d: d['runs'].append(dict(d['runs'][0])), 'duplicate')

    def test_base_outside_trial_namespace(self):
        def edit(d):
            d['runs'][0]['base'] = 'main'
        self.check_rejects(edit, 'trial/ branch')

    def test_a_base_ci_yml_excludes_from_push_ci_is_refused(self):
        def edit(d):
            d['runs'][0]['base'] = 'trial/t2-retrieval-r1'
        self.check_rejects(edit, 'from push CI')

    def test_unknown_cell(self):
        def edit(d):
            d['runs'][0]['cell'] = 'C-native'
        self.check_rejects(edit, 'unknown cell')

    def test_unknown_blocker_harness(self):
        def edit(d):
            d['blockers']['cy-gemini'] = [1]
        self.check_rejects(edit, 'unknown harness')

    def test_duplicate_slot_issue(self):
        def edit(d):
            d['queue']['slots'].append({'slot': 'Q03', 'issue': 9001, 'title': 'dup'})
        self.check_rejects(edit, 'duplicate')

    def test_wrong_schema(self):
        def edit(d):
            d['schema'] = 2
        self.check_rejects(edit, 'schema')

    def test_save_t0_refuses_to_change_a_recorded_t0(self):
        box = helpers.Sandbox()
        self.addCleanup(box.cleanup)
        trial = box.trial()
        config.save_t0(trial, 'a' * 40)
        config.save_t0(trial, 'a' * 40)  # same value is fine
        with self.assertRaises(config.ConfigError):
            config.save_t0(trial, 'b' * 40)
        self.assertEqual(box.trial().t0, 'a' * 40)

    def test_save_t0_changes_one_line_of_the_committed_layout(self):
        box = helpers.Sandbox()
        self.addCleanup(box.cleanup)
        path = os.path.join(box.trial_dir, 'trial.json')
        with open(os.path.join(helpers.TRIAL2, 'trial.json'), encoding='utf-8') as fh:
            original = fh.read()
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(original)
        config.save_t0(box.trial(), 'c' * 40)
        with open(path, encoding='utf-8') as fh:
            after = fh.read()
        changed = [(a, b) for a, b in zip(original.splitlines(), after.splitlines()) if a != b]
        self.assertEqual(len(original.splitlines()), len(after.splitlines()))
        self.assertEqual(changed, [('  "t0": null,', f'  "t0": "{"c" * 40}",')])


class Rendering(unittest.TestCase):
    def setUp(self):
        self.box = helpers.Sandbox()
        self.addCleanup(self.box.cleanup)
        self.trial = self.box.trial()

    def test_every_mission_renders_with_no_placeholder_left(self):
        for run in self.trial.runs:
            text = render.mission(self.trial, run)
            self.assertFalse(re.search(r'\{\{?[A-Z_]+\}?\}', text), run.id)
            self.assertIn(f'`{run.base}`', text)
            self.assertIn(self.trial.mission_relpath(run), text)
            self.assertIn(self.trial.report_relpath(run), text)
            self.assertIn('| `Q01` | #9001 |', text)
            self.assertIn("TRIAL-PROBE run=%s", text)
            self.assertIn(f"'{run.id}'", text)

    def rule_5(self, run):
        text = render.mission(self.trial, run)
        start, end = text.index('5. **Isolation.**'), text.index('6. **Stop conditions.**')
        return ' '.join(text[start:end].split())

    def test_rule_5_forbids_main_and_other_prs_and_the_earlier_trials_records(self):
        for run in self.trial.runs:
            rule = self.rule_5(run)
            for fragment in (f'any branch other than `{run.base}` and the branches you push for your own PRs',
                             'not `main`, which moves on after T0', 'no other `trial/*` branch (the October ones included)',
                             'Do not open the diff, body or comments of a PR you did not open',
                             'Do not read anything under `docs/reports/harness-evals/` other than this mission file'):
                self.assertTrue(fragment in rule, f'{run.id}: rule 5 lacks {fragment!r}')

    def test_the_files_rule_5_allows_under_harness_evals_are_the_ones_the_isolation_scan_allows(self):
        from trialkit import extract
        for run in self.trial.runs:
            rule = self.rule_5(run)
            named = set(re.findall(r'`([^`\s]*harness-evals/[^`\s]+)`', rule))
            self.assertEqual(named, {self.trial.mission_relpath(run), self.trial.report_relpath(run)}, run.id)
            report = self.trial.report_relpath(run)
            scanner = extract.Isolation(run.base, None, (), own_paths=(self.trial.mission_relpath(run), report, os.path.dirname(report)))
            for path in sorted(named) + [os.path.dirname(report) + '/']:
                scanner.scan(f'cat {path}')
            self.assertEqual(scanner.report()['hits'], [], run.id)
            scanner.scan('ls docs/reports/harness-evals/')
            self.assertEqual([h['pattern'] for h in scanner.report()['hits']], ['harness_evals_other'], run.id)

    def test_repeats_differ_only_in_run_fields(self):
        r1, r2 = self.trial.run('A-cd-r1'), self.trial.run('A-cd-r2')
        m1, m2 = render.mission(self.trial, r1), render.mission(self.trial, r2)
        self.assertNotEqual(m1, m2)
        self.assertEqual(m1, m2.replace(r2.base, r1.base).replace(r2.id, r1.id))

    def test_slot_rule_replaces_trial_closes(self):
        text = render.mission(self.trial, self.trial.run('B-cy-r1'))
        self.assertIn('Trial-Item: Q0N', text)
        self.assertNotIn('Trial-Closes', text)

    def test_empty_queue_refuses(self):
        box = helpers.Sandbox(slots=[])
        self.addCleanup(box.cleanup)
        with self.assertRaises(render.RenderError) as ctx:
            render.mission(box.trial(), box.trial().runs[0])
        self.assertIn('queue is empty', str(ctx.exception))

    def test_unfilled_invocation_field_refuses(self):
        def edit(d):
            d['harnesses']['cd']['invocation'] += ' {CLONE_PATH}'
        box = helpers.Sandbox(edit=edit)
        self.addCleanup(box.cleanup)
        with self.assertRaises(render.RenderError):
            render.mission(box.trial(), box.trial().run('A-cd-r1'))

    def test_unknown_template_placeholder_refuses(self):
        path = os.path.join(self.box.trial_dir, 'missions', 'TEMPLATE.md')
        with open(path, 'a', encoding='utf-8') as fh:
            fh.write('\n{{NOT_A_FIELD}}\n')
        with self.assertRaises(render.RenderError):
            render.mission(self.trial, self.trial.runs[0])

    def test_grader_prompt(self):
        text = render.grader(self.trial, 'G-claude', 'claude', 'B')
        self.assertFalse(re.search(r'\{\{[A-Z_]+\}\}', text))
        for run in self.trial.runs:
            self.assertIn(f'`{run.id}`', text)
        self.assertIn('trial/t2-eval-claude', text)
        self.assertIn('Q01 = #9001', text)
        with self.assertRaises(render.RenderError):
            render.grader(self.trial, 'G-claude', 'claude', 'C')

    def test_key_template_has_a_section_per_slot(self):
        text = render.key_template(self.trial)
        self.assertEqual(len(re.findall(r'^## Q\d\d — #\d+', text, re.M)), 2)
        self.assertIn('| Check | Pass when | Partial when | Fail when |', text)

    def test_cli_render_writes_every_mission_and_both_graders(self):
        env = self.box.env()
        code = cli.main(['--trial', self.box.trial_dir, 'render', '--graders'], env=env)
        self.assertEqual(code, 0)
        for run in self.trial.runs:
            self.assertTrue(os.path.exists(os.path.join(self.box.root, self.trial.mission_relpath(run))))
        for gid in ('G-claude', 'G-codex'):
            self.assertTrue(os.path.exists(os.path.join(self.box.trial_dir, 'graders', f'{gid}.md')))

    def test_cli_accepts_trial_before_or_after_the_subcommand(self):
        before = cli.build_parser().parse_args(['--trial', self.box.trial_dir, 'verify-key', 'K.md'])
        after = cli.build_parser().parse_args(['verify-key', 'K.md', '--trial', self.box.trial_dir])
        self.assertEqual((before.trial, before.key), (self.box.trial_dir, 'K.md'))
        self.assertEqual((after.trial, after.key), (self.box.trial_dir, 'K.md'))
        # Not repeated after the subcommand: the top-level value (or its default) stands.
        self.assertEqual(cli.build_parser().parse_args(['--trial', 'X', 'key-template']).trial, 'X')
        rendered = render.grader(self.trial, 'G-codex', 'codex', 'A')
        command = re.search(r'trialctl\.py (.+?verify-key [^`]+)`', rendered, re.S).group(1).split()
        args = cli.build_parser().parse_args(command)
        self.assertEqual((args.command, args.trial), ('verify-key', self.trial.trial_dir))

    def test_cli_reports_config_errors_with_exit_2(self):
        code = cli.main(['--trial', os.path.join(self.box.tmp, 'missing'), 'key-template'], env=self.box.env())
        self.assertEqual(code, 2)


class CheckCodes(unittest.TestCase):
    def test_exit_codes(self):
        self.assertEqual(checks.exit_code([]), 2)
        self.assertEqual(checks.exit_code([checks.passed('a')]), 0)
        self.assertEqual(checks.exit_code([checks.passed('a'), checks.unverified('b')]), 2)
        self.assertEqual(checks.exit_code([checks.unverified('b'), checks.failed('c')]), 1)

    def test_render_states_the_verdict(self):
        text = checks.render([checks.passed('a'), checks.failed('b', 'why')], 'title')
        self.assertIn('FAILED', text)
        self.assertIn('1 pass, 1 fail, 0 unverified', text)


class StateFile(unittest.TestCase):
    def setUp(self):
        self.box = helpers.Sandbox(edit=lambda d: d['paths'].update(state_dir='~/state'))
        self.addCleanup(self.box.cleanup)
        self.trial = self.box.trial()

    def test_roundtrip_writes_home_as_tilde(self):
        data = state.load(self.trial, 'A-cd-r1', home=self.box.home)
        data['clone'] = {'dir': os.path.join(self.box.home, 'trial', 't2', 'A-cd-r1')}
        path = state.save(self.trial, 'A-cd-r1', data, home=self.box.home, now=lambda: helpers.FIXED_NOW)
        self.assertTrue(path.startswith(self.box.home))
        with open(path, encoding='utf-8') as fh:
            raw = json.load(fh)
        self.assertEqual(raw['clone']['dir'], '~/trial/t2/A-cd-r1')
        self.assertNotIn(self.box.home, json.dumps(raw))
        self.assertEqual(raw['updated_at'], '2026-11-02T12:00:00Z')

    def test_state_of_another_run_is_refused(self):
        state.save(self.trial, 'A-cd-r1', {'run': 'A-cd-r1'}, home=self.box.home)
        path = state.state_path(self.trial, 'A-cd-r1', home=self.box.home)
        with self.assertRaises(ValueError):
            state.load(self.trial, 'B-cy-r1', override=path)

    def test_live_runs(self):
        state.save(self.trial, 'A-cd-r1', {'run': 'A-cd-r1', 'start': {'sent_at': 'x'}}, home=self.box.home)
        state.save(self.trial, 'B-cy-r1', {'run': 'B-cy-r1', 'start': {'sent_at': 'x'}, 'finish': {'ended_at': 'y'}},
                   home=self.box.home)
        self.assertEqual(state.live_runs(self.trial, home=self.box.home), ['A-cd-r1'])
        self.assertEqual(state.live_runs(self.trial, exclude='A-cd-r1', home=self.box.home), [])


class FakeInner:
    repo = 'o/r'

    def repo_path(self, suffix):
        return f'repos/o/r/{suffix}'

    def get(self, path, params=None):
        if path.endswith('missing'):
            raise GitHubError('nope', 404)
        return {'path': path, 'params': params}

    def list(self, path, params=None, key=None):
        return [{'n': 1}, {'n': 2}]


class GitHubDouble(unittest.TestCase):
    def test_recorded_responses_replay(self):
        box = helpers.Sandbox()
        self.addCleanup(box.cleanup)
        rec = RecordingGitHub(FakeInner(), box.tmp + '/fx')
        self.assertEqual(rec.list('repos/o/r/pulls', {'state': 'all'}), [{'n': 1}, {'n': 2}])
        rec.get('repos/o/r/pulls/7')
        with self.assertRaises(GitHubError):
            rec.get('repos/o/r/missing')
        fx = FixtureGitHub(box.tmp + '/fx', repo='o/r')
        self.assertEqual(fx.list('repos/o/r/pulls', {'state': 'all'}), [{'n': 1}, {'n': 2}])
        self.assertEqual(fx.get('repos/o/r/pulls/7')['path'], 'repos/o/r/pulls/7')
        with self.assertRaises(GitHubError) as ctx:
            fx.get('repos/o/r/missing')
        self.assertEqual(ctx.exception.status, 404)
        with self.assertRaises(GitHubError):
            fx.get('repos/o/r/never-recorded')

    def test_request_key_is_order_independent(self):
        self.assertEqual(request_key('a', {'x': 1, 'y': 2}), request_key('/a', {'y': 2, 'x': 1}))


class Timestamps(unittest.TestCase):
    def test_parse_matches_measures(self):
        self.assertEqual(timeutil.iso(timeutil.parse_ts('2026-10-19T19:18:00.437Z')), '2026-10-19T19:18:00.437Z')
        self.assertEqual(timeutil.iso(timeutil.parse_ts('2026-10-19T19:18:00')), '2026-10-19T19:18:00Z')
        self.assertAlmostEqual(timeutil.minutes('2026-10-18T04:07:01Z', '2026-10-18T05:52:42Z'), 105.6833, places=3)


if __name__ == '__main__':
    unittest.main()
