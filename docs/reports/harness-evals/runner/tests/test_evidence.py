"""`trialctl evidence`: what it copies, where it refuses to, the manifest and the extract it writes.

Every transcript here is synthetic and lives under the Sandbox's fake HOME; nothing reads the real
~/.claude, ~/.codex or the vault."""
import hashlib
import json
import os
import re
import stat
import unittest
from datetime import datetime, timezone
from unittest import mock

import helpers
from trialkit import cli, evidence, native, state

SENT = '2026-11-02T10:00:00Z'
FIRST = '2026-11-02T10:01:00Z'
ENDED = '2026-11-02T12:00:00Z'
INSIDE = datetime(2026, 11, 2, 11, 0, tzinfo=timezone.utc)
BEFORE = datetime(2026, 11, 2, 8, 0, tzinfo=timezone.utc)
AFTER = datetime(2026, 11, 2, 13, 0, tzinfo=timezone.utc)
SECRET = 'SECRET-SENTINEL-77c1'
KEY = '~/Obsidian/no-it-all/reviews/harness-trial-2'


def jl(*entries):
    return '\n'.join(e if isinstance(e, str) else json.dumps(e) for e in entries) + '\n'


def assistant(mid, model='claude-opus-5-5', out=10, effort='high', tools=()):
    return {'type': 'assistant', 'timestamp': '2026-11-02T10:05:00Z', 'effort': effort,
            'message': {'id': mid, 'model': model, 'content': [{'type': 'tool_use', 'name': 'Bash', 'input': t} for t in tools],
                        'usage': {'input_tokens': 5, 'output_tokens': out, 'cache_read_input_tokens': 100,
                                  'cache_creation_input_tokens': 2}}}


def user(text, **extra):
    return dict({'type': 'user', 'message': {'role': 'user', 'content': text}}, **extra)


def read(path, binary=False):
    with open(path, 'rb') if binary else open(path, encoding='utf-8') as fh:
        return fh.read()


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


class Evidence(unittest.TestCase):
    RUN = 'A-cd-r1'

    def setUp(self):
        self.box = helpers.Sandbox(edit=self.edit)
        self.addCleanup(self.box.cleanup)
        self.trial = self.box.trial()
        self.home = self.box.home
        self.run = self.trial.run(self.RUN)
        self.clone = os.path.join(self.home, 'trial', 't2', self.RUN)
        self.projects = os.path.join(self.home, '.claude', 'projects')
        self.sessions = os.path.join(self.home, '.codex', 'sessions')
        self.vault = os.path.join(self.home, 'Obsidian', 'no-it-all')
        self.evidence_dir = os.path.join(self.vault, 'reviews', 'harness-trial-2', 'evidence')
        self.data = os.path.join(self.box.tmp, 'data')
        self.write_state()

    def edit(self, data):
        """Hook for subclasses to change trial.json."""

    # -- fixtures --------------------------------------------------------------------

    def write_state(self, run=None, **sections):
        body = {'run': run or self.RUN, 'trial': 't2', 'clone': {'dir': self.clone_of(run or self.RUN)},
                'start': {'sent_at': SENT}, 'verify_start': {'first_command_at': FIRST}, 'finish': {'ended_at': ENDED}}
        body.update(sections)
        state.save(self.trial, run or self.RUN, body, home=self.home)

    def clone_of(self, run_id):
        return os.path.join(self.home, 'trial', 't2', run_id)

    def put(self, *parts, text='x\n', when=INSIDE, root=None):
        path = os.path.join(root or self.home, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(text)
        os.utime(path, (when.timestamp(), when.timestamp()))
        return path

    def claude(self, name, *entries, run_id=None, when=INSIDE):
        folder = native.slug(self.clone_of(run_id or self.RUN))
        return self.put('.claude', 'projects', folder, *name.split('/'), text=jl(*entries), when=when)

    def rollout(self, name, *entries, when=INSIDE):
        return self.put('.codex', 'sessions', '2026', '11', '02', name, text=jl(*entries), when=when)

    def run_evidence(self, run_id=None, **kwargs):
        run = self.trial.run(run_id or self.RUN)
        env = self.box.env()
        code = evidence.evidence(self.trial, run, env, data_dir=kwargs.pop('data', self.data), **kwargs)
        self.out = env.out.getvalue()
        return code

    def extract(self, run_id=None):
        with open(os.path.join(self.data, 'native', f'{run_id or self.RUN}.json'), encoding='utf-8') as fh:
            return json.load(fh)

    def tree(self, root):
        found = []
        for dirpath, _dirs, files in os.walk(root):
            found += [os.path.relpath(os.path.join(dirpath, f), root).replace(os.sep, '/') for f in files]
        return sorted(found)

    def retrial(self, **paths):
        """Rewrite trial.json's paths (None deletes one) and reload; `self.run_evidence` uses the new trial."""
        data = json.loads(json.dumps(self.trial.data))
        for name, value in paths.items():
            if value is None:
                data['paths'].pop(name, None)
            else:
                data['paths'][name] = value
        self.box.write_trial(data)
        self.trial = self.box.trial()

    def basic_claude(self):
        self.claude('s1.jsonl', user(f'/prime-directive "Trial run A-cd-r1: go {SECRET}"'),
                    assistant('m1', tools=[{'command': f'echo {SECRET} && git log origin/trial/a1-cd'}]),
                    user('one more thing'), assistant('m2', out=30))
        self.claude('s1/subagents/agent-a.jsonl', assistant('w1', model='claude-sonnet-5-5', out=7))
        self.put('.claude', 'projects', native.slug(self.clone), 's1', 'tool-results', 'out.txt', text='tool output\n')


class Copy(Evidence):
    def test_copies_the_clones_folder_with_subagents_and_other_files_in_the_window(self):
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 0, self.out)
        slug = native.slug(self.clone)
        target = os.path.join(self.evidence_dir, self.RUN)
        self.assertEqual(self.tree(target), sorted([
            f'MANIFEST.sha256', f'claude-projects/{slug}/s1.jsonl', f'claude-projects/{slug}/s1/subagents/agent-a.jsonl',
            f'claude-projects/{slug}/s1/tool-results/out.txt']))

    def test_files_outside_the_window_other_projects_and_links_are_not_copied(self):
        self.basic_claude()
        slug = native.slug(self.clone)
        self.claude('old.jsonl', user('x'), when=BEFORE)
        self.put('.claude', 'projects', native.slug(self.clone_of('A-cy-r1')), 'other.jsonl', text='other run\n')
        self.put('.claude', 'projects', slug, 'secret-target.txt', text=SECRET, root=self.box.tmp, when=INSIDE)
        os.symlink(os.path.join(self.box.tmp, '.claude', 'projects', slug, 'secret-target.txt'),
                   os.path.join(self.projects, slug, 'link.txt'))
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertEqual(self.tree(os.path.join(self.evidence_dir, self.RUN)), sorted([
            'MANIFEST.sha256', f'claude-projects/{slug}/s1.jsonl', f'claude-projects/{slug}/s1/subagents/agent-a.jsonl',
            f'claude-projects/{slug}/s1/tool-results/out.txt']))
        manifest = read(os.path.join(self.evidence_dir, self.RUN, 'MANIFEST.sha256'))
        self.assertFalse(sha(SECRET) in manifest)

    def test_a_file_modified_after_the_window_is_not_copied_and_the_run_is_not_verified(self):
        self.basic_claude()
        self.claude('later.jsonl', user('continued'), when=AFTER)
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertTrue('files after the window' in self.out)
        self.assertFalse(any('later.jsonl' in f for f in self.tree(os.path.join(self.evidence_dir, self.RUN))))

    def test_the_window_edge_is_the_earlier_of_the_send_and_the_first_command_plus_grace(self):
        self.basic_claude()
        just_inside = datetime(2026, 11, 2, 9, 56, tzinfo=timezone.utc)      # the send minus four minutes
        self.claude('early.jsonl', user('x'), when=just_inside)
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertTrue(any('early.jsonl' in f for f in self.tree(os.path.join(self.evidence_dir, self.RUN))))

    def test_no_transcript_in_the_window_fails_and_writes_nothing(self):
        self.claude('old.jsonl', user('x'), when=BEFORE)
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertFalse(os.path.exists(self.evidence_dir))
        self.assertFalse(os.path.exists(self.data))

    def test_a_missing_projects_folder_is_unverified_not_a_clean_empty_run(self):
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertTrue('not a directory' in self.out)
        self.assertFalse(os.path.exists(self.evidence_dir))

    def test_copies_are_private_and_keep_their_modification_time(self):
        self.basic_claude()
        self.run_evidence()
        target = os.path.join(self.evidence_dir, self.RUN)
        copy = os.path.join(target, 'claude-projects', native.slug(self.clone), 's1.jsonl')
        self.assertEqual(stat.S_IMODE(os.stat(copy).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(copy)).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o700)
        self.assertEqual(int(os.path.getmtime(copy)), int(INSIDE.timestamp()))

    def test_no_staging_directory_is_left_behind(self):
        self.basic_claude()
        self.run_evidence()
        self.assertEqual(sorted(os.listdir(self.evidence_dir)), [self.RUN])


class Manifest(Evidence):
    def test_every_file_is_listed_sorted_with_its_sha256_and_the_digest_is_printed_and_recorded(self):
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 0, self.out)
        target = os.path.join(self.evidence_dir, self.RUN)
        text = read(os.path.join(target, 'MANIFEST.sha256'))
        rows = [line.split('  ', 1) for line in text.splitlines()]
        self.assertEqual([r[1] for r in rows], sorted(r[1] for r in rows))
        self.assertEqual(sorted(r[1] for r in rows), [f for f in self.tree(target) if f != 'MANIFEST.sha256'])
        for digest, rel in rows:
            self.assertEqual(digest, hashlib.sha256(read(os.path.join(target, rel), binary=True)).hexdigest(), rel)
        manifest_digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
        self.assertTrue(f'manifest sha256: {manifest_digest}' in self.out)
        found = self.extract()['evidence']
        self.assertEqual((found['manifest_sha256'], found['files']), (manifest_digest, len(rows)))

    def test_a_changed_copy_no_longer_matches_its_manifest(self):
        self.basic_claude()
        self.run_evidence()
        target = os.path.join(self.evidence_dir, self.RUN)
        copy = os.path.join(target, 'claude-projects', native.slug(self.clone), 's1.jsonl')
        manifest = dict(reversed(line.split('  ', 1)) for line in read(os.path.join(target, 'MANIFEST.sha256')).splitlines())
        rel = f'claude-projects/{native.slug(self.clone)}/s1.jsonl'
        self.assertEqual(manifest[rel], hashlib.sha256(read(copy, binary=True)).hexdigest())
        with open(copy, 'a') as fh:
            fh.write('tampered\n')
        self.assertNotEqual(manifest[rel], hashlib.sha256(read(copy, binary=True)).hexdigest())


class Refusals(Evidence):
    """The destination rules. Each case writes nothing and exits 1."""

    def refuse(self, destination, fragment):
        self.retrial(evidence_dir=destination)
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue(fragment in self.out, self.out)
        self.assertFalse(os.path.exists(self.data), 'no extract may be written')

    def test_inside_the_trial_repository(self):
        self.refuse('~/../repo/evidence', 'inside the trial repository')
        self.assertFalse(os.path.exists(os.path.join(self.box.root, 'evidence')))

    def test_inside_any_git_work_tree(self):
        os.makedirs(os.path.join(self.home, 'projects', 'other', '.git'))
        self.refuse('~/projects/other/evidence', 'inside the git work tree')
        self.assertFalse(os.path.exists(os.path.join(self.home, 'projects', 'other', 'evidence')))

    def test_inside_a_work_tree_that_is_a_linked_worktree_file(self):
        os.makedirs(os.path.join(self.home, 'wt'))
        with open(os.path.join(self.home, 'wt', '.git'), 'w') as fh:
            fh.write('gitdir: /elsewhere\n')
        self.refuse('~/wt/sub/evidence', 'inside the git work tree')

    def test_inside_the_runs_clone(self):
        self.refuse('~/trial/t2/A-cd-r1/evidence', 'inside the run\'s clone')

    def test_a_symlink_into_the_repository_is_followed(self):
        os.symlink(self.box.root, os.path.join(self.home, 'linked'))
        self.refuse('~/linked/evidence', 'inside the trial repository')

    def test_an_existing_evidence_directory_is_never_overwritten(self):
        target = os.path.join(self.evidence_dir, self.RUN)
        os.makedirs(target)
        with open(os.path.join(target, 'MANIFEST.sha256'), 'w') as fh:
            fh.write('mine\n')
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue('already exists' in self.out)
        self.assertEqual(read(os.path.join(target, 'MANIFEST.sha256')), 'mine\n')
        self.assertFalse(os.path.exists(self.data))

    def test_an_empty_directory_may_be_used(self):
        os.makedirs(os.path.join(self.evidence_dir, self.RUN))
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 0, self.out)

    def test_an_unset_destination_is_a_configuration_error(self):
        self.retrial(evidence_dir=None)
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 2, self.out)


class Vault(Evidence):
    """The private vault is a git work tree and the one the owner may name; no other is allowed."""

    def setUp(self):
        super().setUp()
        os.makedirs(os.path.join(self.vault, '.git'))
        self.basic_claude()

    def test_the_declared_vault_is_accepted(self):
        self.assertEqual(self.run_evidence(), 0, self.out)

    def test_without_the_declaration_the_same_destination_is_refused(self):
        self.retrial(evidence_vault=None)
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue('inside the git work tree' in self.out)

    def test_a_repository_inside_the_vault_is_still_refused(self):
        os.makedirs(os.path.join(self.evidence_dir, '.git'))
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue(os.path.realpath(self.evidence_dir) in self.out)

    def test_a_different_declared_vault_does_not_cover_this_one(self):
        self.retrial(evidence_vault='~/Elsewhere')
        self.assertEqual(self.run_evidence(), 1, self.out)

    def test_a_vault_that_sits_inside_another_work_tree_is_refused_though_it_is_the_nearest(self):
        os.makedirs(os.path.join(self.home, 'Obsidian', '.git'))          # an outer repository around the vault's own
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue(os.path.realpath(os.path.join(self.home, 'Obsidian')) in self.out)

    def test_a_vault_inside_the_repository_is_still_refused(self):
        inside = os.path.join(self.box.root, 'vault')
        os.makedirs(os.path.join(inside, '.git'))
        self.retrial(evidence_dir=os.path.join(inside, 'ev'), evidence_vault=inside)
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue('inside the trial repository' in self.out)


class State(Evidence):
    def test_a_run_that_has_not_finished_is_refused(self):
        self.write_state(finish=None)
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue('finish' in self.out)

    def test_a_run_with_no_state_is_refused(self):
        self.assertEqual(self.run_evidence('B-cx-r1'), 1, self.out)

    def test_an_unreadable_time_is_refused(self):
        self.write_state(finish={'ended_at': 'later'})
        self.assertEqual(self.run_evidence(), 1, self.out)

    def test_the_clone_comes_from_the_state_or_the_configured_root(self):
        self.write_state(clone=None)
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 0, self.out)       # clone_root/<RUN> is where basic_claude put it


class Extract(Evidence):
    def test_claude_extract_has_counts_and_hashes_and_no_text(self):
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 0, self.out)
        doc = self.extract()
        self.assertEqual((doc['run'], doc['harness'], doc['family'], doc['chroxy']), (self.RUN, 'cd', 'claude', False))
        self.assertEqual(doc['window'], {'start': SENT, 'end': ENDED})
        self.assertEqual(doc['coordinator']['turns'], {'claude-opus-5-5': 2})
        self.assertEqual(doc['coordinator']['efforts'], {'high': 2})
        self.assertEqual(doc['workers']['turns'], {'claude-sonnet-5-5': 1})
        self.assertEqual(doc['tokens']['by_model']['claude-opus-5-5'], {'input': 10, 'output': 40, 'cache_read': 200, 'cache_write': 4})
        self.assertEqual(doc['people']['human_messages_after_first'], 1)
        self.assertEqual(doc['runs_row'], {'compactions': 0, 'workers': '1 subagent transcript(s): claude-sonnet-5-5 x1'})
        self.assertEqual([h['pattern'] for h in doc['isolation']['hits']], ['other_trial_branch'])
        self.assertEqual(doc['permissions'], None)
        text = json.dumps(doc)
        self.assertFalse(SECRET in text)
        self.assertFalse(self.home in text or self.box.tmp in text, 'no absolute path may reach the public extract')
        self.assertFalse('a1-cd' in text)

    def test_the_extract_is_written_to_the_trial_data_by_default(self):
        self.basic_claude()
        env = self.box.env()
        self.assertEqual(evidence.evidence(self.trial, self.run, env), 0, env.out.getvalue())
        self.assertTrue(os.path.exists(self.trial.repo_path('data', 'native', f'{self.RUN}.json')))

    def test_cost_is_n_a_without_a_price_table_and_priced_with_one(self):
        self.basic_claude()
        self.run_evidence()
        self.assertEqual((self.extract()['cost'], self.extract()['cost_note']), ('n/a', 'trial.json has no price table'))
        self.assertTrue('cost: n/a' in self.out)

    def test_the_extract_describes_what_the_manifest_holds(self):
        self.basic_claude()
        self.run_evidence()
        slug = native.slug(self.clone)
        copy = os.path.join(self.evidence_dir, self.RUN, 'claude-projects', slug, 's1.jsonl')
        with open(copy, encoding='utf-8') as fh:
            self.assertTrue(SECRET in fh.read(), 'the vault copy keeps the raw text')

    def test_a_transcript_with_no_usage_or_tool_inputs_is_unverified_not_clean(self):
        self.claude('s1.jsonl', user('Trial run A-cd-r1: go'), {'type': 'assistant', 'message': {'model': 'claude-opus-5-5', 'id': 'm1'}})
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertTrue(re.search(r'UNVERIFIED\s+token totals', self.out), self.out)
        self.assertTrue(re.search(r'UNVERIFIED\s+isolation scan', self.out), self.out)
        self.assertEqual(self.extract()['isolation']['tool_inputs_scanned'], 0)

    def test_an_extract_that_cannot_be_written_takes_the_copy_back(self):
        self.basic_claude()
        with open(self.data, 'w') as fh:                        # a file where the data directory should be
            fh.write('in the way\n')
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue(re.search(r'FAIL\s+extract', self.out), self.out)
        self.assertFalse(os.path.exists(os.path.join(self.evidence_dir, self.RUN)))
        self.assertEqual(os.listdir(self.evidence_dir), [])


class Checks(Evidence):
    """What the extract says about what was verified, and the figures it will not carry when it was not."""

    def test_the_extract_lists_every_check_by_name_and_status_only(self):
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 0, self.out)
        listed = self.extract()['checks']
        self.assertEqual({tuple(sorted(c)) for c in listed}, {('name', 'status')})
        status = {c['name']: c['status'] for c in listed}
        for name in ('claude transcripts', 'transcript lines', 'token totals', 'isolation scan', 'human messages'):
            self.assertEqual(status[name], 'PASS', name)
        self.assertFalse(self.home in json.dumps(listed) or self.box.tmp in json.dumps(listed))

    def test_a_check_that_is_not_a_pass_is_in_the_extract_as_it_was_printed(self):
        self.claude('s1.jsonl', user('Trial run A-cd-r1: go'), {'type': 'assistant', 'message': {'model': 'claude-opus-5-5', 'id': 'm1'}})
        self.run_evidence()
        status = {c['name']: c['status'] for c in self.extract()['checks']}
        self.assertEqual((status['token totals'], status['isolation scan']), ('UNVERIFIED', 'UNVERIFIED'))

    def test_no_human_message_is_a_detector_failure_not_a_run_nobody_spoke_in(self):
        self.claude('s1.jsonl', assistant('m1', tools=[{'command': 'ls'}]),
                    user([{'type': 'tool_result', 'tool_use_id': 't', 'content': 'out'}]), assistant('m2', out=30))
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertTrue(re.search(r'UNVERIFIED\s+human messages', self.out), self.out)
        people = self.extract()['people']
        self.assertEqual((people['human_messages_total'], people['human_messages_after_first'], people['interrupts']), (None, None, None))
        self.assertEqual(people['compactions'], {'coordinator': 0, 'workers': 0})       # another detector: still reported
        self.assertEqual({c['name']: c['status'] for c in self.extract()['checks']}['human messages'], 'UNVERIFIED')

    def test_the_invocation_alone_is_one_message_and_a_pass(self):
        self.claude('s1.jsonl', user('Trial run A-cd-r1: go'), assistant('m1', tools=[{'command': 'ls'}]))
        self.assertEqual(self.run_evidence(), 0, self.out)
        people = self.extract()['people']
        self.assertEqual((people['human_messages_total'], people['human_messages_after_first']), (1, 0))

    def test_worker_transcripts_alone_hold_no_human_message_either(self):
        self.claude('s1/subagents/agent-a.jsonl', user('a spawn prompt'), assistant('w1', model='claude-sonnet-5-5', out=7, tools=[{'command': 'ls'}]))
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertEqual(self.extract()['people']['human_messages_total'], None)

    def test_valid_records_beside_a_truncated_remainder_do_not_report_all_checks_passed(self):
        self.claude('s1.jsonl', user('Trial run A-cd-r1: go'), assistant('m1', tools=[{'command': 'ls'}]),
                    '{"type": "assistant", "message": {"mod', '{"type":', '[', 'not json at all', '{"x": ', '}')
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertTrue(re.search(r'UNVERIFIED\s+transcript lines', self.out), self.out)
        doc = self.extract()
        self.assertEqual(doc['transcript_lines']['unreliable_files'], 1)
        self.assertEqual(doc['runs_row'], {}, 'a count from a transcript that was not read whole fills nothing in runs.json')
        self.assertEqual({c['name']: c['status'] for c in doc['checks']}['transcript lines'], 'UNVERIFIED')
        self.assertTrue(self.extract()['tokens']['by_model'], 'the figures that were read are still shown, flagged by the check')

    def test_a_mid_write_tail_in_a_long_transcript_is_tolerated(self):
        entries = [user('Trial run A-cd-r1: go')] + [assistant(f'm{i}', out=1, tools=[{'command': 'ls'}]) for i in range(150)]
        path = self.claude('s1.jsonl', *entries)
        with open(path, 'a', encoding='utf-8') as fh:
            fh.write('{"type": "assistant", "message": {"mo')
        os.utime(path, (INSIDE.timestamp(), INSIDE.timestamp()))
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertEqual(self.extract()['transcript_lines']['malformed'], 1)

    def test_a_tool_input_with_a_lone_surrogate_is_scanned_and_nothing_raw_is_left_behind(self):
        self.claude('s1.jsonl', user('Trial run A-cd-r1: go'),
                    assistant('m1', tools=[{'command': 'ls ~/.claude/projects/other\ud800 && cat NEXT-x.md\udfff'}]))
        with open(os.path.join(self.projects, native.slug(self.clone), 's1.jsonl'), encoding='utf-8') as fh:
            self.assertTrue('ud800' in fh.read(), 'the fixture carries the escape')
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertEqual(sorted(h['pattern'] for h in self.extract()['isolation']['hits']), ['claude_projects_other', 'next_seed'])
        self.assertEqual(sorted(os.listdir(self.evidence_dir)), [self.RUN])

    def test_the_tool_input_count_is_inputs_not_strings(self):
        self.claude('s1.jsonl', user('Trial run A-cd-r1: go'),
                    assistant('m1', tools=[{'a': 'x', 'b': 'y', 'c': ['z', 'w']}, {'command': 'ls'}]))
        self.run_evidence()
        self.assertEqual(self.extract()['isolation']['tool_inputs_scanned'], 2)


class Cleanup(Evidence):
    """Nothing raw is left in the destination whatever failed, and a failure to clean up is reported, not hidden."""

    def stage(self):
        return os.path.join(self.evidence_dir, f'.{self.RUN}.partial')

    def assert_nothing_kept(self):
        self.assertFalse(os.path.exists(self.stage()), 'the stage holds raw transcripts')
        self.assertFalse(os.path.exists(os.path.join(self.evidence_dir, self.RUN)))
        self.assertFalse(os.path.exists(os.path.join(self.data, 'native')))

    def test_any_exception_while_reading_the_staged_copy_removes_the_stage(self):
        for exc in (RecursionError('too deep'), UnicodeEncodeError('utf-8', 'x', 0, 1, 'surrogates not allowed'), ValueError('x'), KeyError('k')):
            self.basic_claude()
            with mock.patch('trialkit.extract.claude_summary', side_effect=exc):
                self.assertEqual(self.run_evidence(), 1, self.out)
            self.assertTrue(re.search(r'FAIL\s+derive\s+' + type(exc).__name__, self.out), self.out)
            self.assert_nothing_kept()

    def test_the_message_of_the_exception_is_not_printed(self):
        self.basic_claude()
        with mock.patch('trialkit.extract.claude_summary', side_effect=ValueError(f'bad line {SECRET}')):
            self.run_evidence()
        self.assertFalse(SECRET in self.out)

    def test_an_error_while_staging_removes_the_partial_stage(self):
        self.basic_claude()
        with mock.patch('trialkit.evidence._sha256_file', side_effect=OSError('disk full')):
            self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue(re.search(r'FAIL\s+copy\s+disk full', self.out), self.out)
        self.assert_nothing_kept()

    def test_an_exception_after_the_move_takes_the_copy_back_too(self):
        self.basic_claude()
        with mock.patch('trialkit.evidence._write_json', side_effect=TypeError('not serializable')):
            self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue(re.search(r'FAIL\s+extract\s+TypeError', self.out), self.out)
        self.assertEqual(os.listdir(self.evidence_dir), [])

    def test_a_leftover_stage_of_a_crashed_run_is_replaced(self):
        self.basic_claude()
        os.makedirs(os.path.join(self.stage(), 'claude-projects'))
        with open(os.path.join(self.stage(), 'stale.txt'), 'w') as fh:
            fh.write('left by a crash\n')
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertFalse(any('stale.txt' in f for f in self.tree(os.path.join(self.evidence_dir, self.RUN))))

    def test_a_stage_that_cannot_be_removed_is_a_failure_that_names_it(self):
        self.basic_claude()
        real = evidence.shutil.rmtree

        def stubborn(path, *args, **kwargs):
            if os.path.basename(path).endswith('.partial'):
                raise OSError('directory busy')
            return real(path, *args, **kwargs)
        with mock.patch('trialkit.extract.claude_summary', side_effect=RecursionError('x')), \
                mock.patch.object(evidence.shutil, 'rmtree', side_effect=stubborn):
            self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue(re.search(r'FAIL\s+cleanup\s+could not remove .*\.partial: directory busy', self.out), self.out)
        self.assertTrue(re.search(r'FAIL\s+derive', self.out), self.out)
        self.assertTrue(os.path.isdir(self.stage()), 'it is still there, and the output says so')

    def test_missing_parent_directories_are_created_private(self):
        self.basic_claude()
        old = os.umask(0o022)
        try:
            self.assertEqual(self.run_evidence(), 0, self.out)
        finally:
            os.umask(old)
        made = [self.vault, os.path.join(self.vault, 'reviews'), os.path.join(self.vault, 'reviews', 'harness-trial-2'), self.evidence_dir]
        self.assertEqual([stat.S_IMODE(os.stat(d).st_mode) for d in made], [0o700] * 4)


class Destination(Evidence):
    """The destination is resolved once, checked on the resolved paths, and checked again before anything moves."""

    def stage(self, base=None):
        return os.path.join(base or self.evidence_dir, f'.{self.RUN}.partial')

    def test_a_run_directory_that_is_a_link_to_a_vault_folder_does_not_hide_a_base_inside_the_repository(self):
        inside = os.path.join(self.box.root, 'evidence')
        os.makedirs(inside)
        vault_dir = os.path.join(self.evidence_dir, 'elsewhere')
        os.makedirs(vault_dir)
        os.symlink(vault_dir, os.path.join(inside, self.RUN))
        self.retrial(evidence_dir=inside, evidence_vault=None)
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue('inside the trial repository' in self.out, self.out)
        self.assertEqual(os.listdir(inside), [self.RUN], 'no stage was written into the repository')
        self.assertEqual(os.listdir(vault_dir), [])
        self.assertFalse(os.path.exists(self.data))

    def test_an_evidence_directory_that_is_a_link_into_the_repository_is_resolved_and_refused(self):
        os.makedirs(os.path.join(self.box.root, 'real-evidence'))
        link = os.path.join(self.home, 'ev-link')
        os.symlink(os.path.join(self.box.root, 'real-evidence'), link)
        self.retrial(evidence_dir=link, evidence_vault=None)
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertEqual(os.listdir(os.path.join(self.box.root, 'real-evidence')), [])

    def test_an_evidence_directory_that_is_a_link_into_the_vault_is_written_through_to_the_real_place(self):
        real = os.path.join(self.vault, 'reviews', 'harness-trial-2', 'real-evidence')
        os.makedirs(real)
        link = os.path.join(self.home, 'ev-link')
        os.symlink(real, link)
        self.retrial(evidence_dir=link)
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertTrue(os.path.isfile(os.path.join(os.path.realpath(real), self.RUN, 'MANIFEST.sha256')))
        self.assertFalse(os.path.islink(os.path.join(real, self.RUN)))

    def test_a_run_directory_that_is_a_link_is_refused_even_to_an_empty_vault_directory(self):
        elsewhere = os.path.join(self.vault, 'reviews', 'harness-trial-2', 'other')
        os.makedirs(elsewhere)
        os.makedirs(self.evidence_dir)
        os.symlink(elsewhere, os.path.join(self.evidence_dir, self.RUN))
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue('is a symbolic link' in self.out, self.out)
        self.assertEqual(os.listdir(elsewhere), [])
        self.assertTrue(os.path.islink(os.path.join(self.evidence_dir, self.RUN)), 'it is refused, not removed')

    def test_a_stage_that_is_a_link_is_refused_and_left_alone(self):
        elsewhere = os.path.join(self.vault, 'reviews', 'harness-trial-2', 'other')
        os.makedirs(elsewhere)
        with open(os.path.join(elsewhere, 'keep.txt'), 'w') as fh:
            fh.write('mine\n')
        os.makedirs(self.evidence_dir)
        os.symlink(elsewhere, self.stage())
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue('is a symbolic link' in self.out, self.out)
        self.assertEqual(os.listdir(elsewhere), ['keep.txt'])
        self.assertTrue(os.path.islink(self.stage()))

    def test_with_a_declared_vault_a_destination_outside_it_is_refused_though_no_work_tree_holds_it(self):
        outside = os.path.join(self.home, 'plain-folder', 'evidence')
        self.retrial(evidence_dir=outside)
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue('outside the declared vault' in self.out, self.out)
        self.assertFalse(os.path.exists(outside))
        self.assertFalse(os.path.exists(os.path.join(self.home, 'plain-folder')))

    def test_a_link_out_of_the_vault_is_outside_it(self):
        os.makedirs(os.path.join(self.home, 'plain-folder'))
        os.makedirs(os.path.dirname(self.evidence_dir))
        os.symlink(os.path.join(self.home, 'plain-folder'), self.evidence_dir)
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue('outside the declared vault' in self.out, self.out)
        self.assertEqual(os.listdir(os.path.join(self.home, 'plain-folder')), [])

    def test_without_a_declared_vault_a_plain_folder_outside_any_work_tree_is_fine(self):
        self.retrial(evidence_dir=os.path.join(self.home, 'plain-folder', 'evidence'), evidence_vault=None)
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 0, self.out)

    def test_the_vault_itself_and_a_folder_deep_in_it_are_inside_it(self):
        self.retrial(evidence_dir=self.vault)
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 0, self.out)

    def test_a_sibling_whose_name_starts_with_the_vaults_is_not_inside_it(self):
        self.retrial(evidence_dir=self.vault + '-other')
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 1, self.out)
        self.assertTrue('outside the declared vault' in self.out)

    # -- checked again before anything moves ------------------------------------------------

    def run_with(self, patched, during):
        """Run evidence with `during()` called right after `patched` (a trialkit.evidence function) returns."""
        original = getattr(evidence, patched)

        def wrapper(*args, **kwargs):
            result = original(*args, **kwargs)
            during()
            return result
        with mock.patch.object(evidence, patched, wrapper):
            return self.run_evidence()

    def test_a_target_that_appears_while_the_files_are_being_found_is_never_written_over(self):
        self.basic_claude()
        target = os.path.join(self.evidence_dir, self.RUN)

        def appears():
            os.makedirs(target, exist_ok=True)
            with open(os.path.join(target, 'mine.txt'), 'w') as fh:
                fh.write('mine\n')
        with mock.patch.object(evidence, '_stage', wraps=evidence._stage) as staged:
            self.assertEqual(self.run_with('_claude_files', appears), 1, self.out)
        self.assertTrue('already exists' in self.out, self.out)
        self.assertEqual(os.listdir(target), ['mine.txt'])
        staged.assert_not_called()      # refused before anything raw was copied, not merely cleaned up after

    def test_a_target_that_appears_while_the_copy_is_being_read_stops_the_move_and_removes_the_stage(self):
        self.basic_claude()
        target = os.path.join(self.evidence_dir, self.RUN)

        def appears():
            os.makedirs(target, exist_ok=True)
            with open(os.path.join(target, 'mine.txt'), 'w') as fh:
                fh.write('mine\n')
        self.assertEqual(self.run_with('_derive', appears), 1, self.out)
        self.assertTrue('already exists' in self.out, self.out)
        self.assertEqual(os.listdir(target), ['mine.txt'])
        self.assertFalse(os.path.exists(self.stage()))
        self.assertFalse(os.path.exists(self.data))

    def test_a_stage_swapped_for_a_link_while_the_copy_is_being_read_stops_the_move(self):
        self.basic_claude()
        elsewhere = os.path.join(self.home, 'elsewhere')
        os.makedirs(elsewhere)

        def swap():
            shutil_rmtree(self.stage())
            os.symlink(elsewhere, self.stage())
        self.assertEqual(self.run_with('_derive', swap), 1, self.out)
        self.assertTrue('is a symbolic link' in self.out, self.out)
        self.assertFalse(os.path.lexists(os.path.join(self.evidence_dir, self.RUN)))
        self.assertEqual(os.listdir(elsewhere), [], 'nothing was written through the link')

    def test_a_work_tree_that_appears_around_the_destination_stops_the_move_and_removes_the_stage(self):
        self.basic_claude()
        parent = os.path.dirname(self.evidence_dir)

        def becomes_a_repository():
            os.makedirs(os.path.join(parent, '.git'))
        self.assertEqual(self.run_with('_derive', becomes_a_repository), 1, self.out)
        self.assertTrue('inside the git work tree' in self.out, self.out)
        self.assertFalse(os.path.exists(self.stage()))
        self.assertFalse(os.path.exists(os.path.join(self.evidence_dir, self.RUN)))
        self.assertFalse(os.path.exists(self.data))

    def test_a_base_that_no_longer_resolves_to_itself_stops_the_move(self):
        self.basic_claude()
        original, base = os.path.realpath, os.path.realpath(self.evidence_dir)

        def realpath(path, *args, **kwargs):
            return os.path.join(self.home, 'moved') if os.fspath(path) == base else original(path, *args, **kwargs)

        def a_parent_is_swapped():       # from here on, the base resolves somewhere else
            patch = mock.patch('os.path.realpath', realpath)
            patch.start()
            self.addCleanup(patch.stop)
        self.assertEqual(self.run_with('_derive', a_parent_is_swapped), 1, self.out)
        self.assertTrue('now resolves to' in self.out, self.out)
        self.assertFalse(os.path.exists(os.path.join(self.evidence_dir, self.RUN)))
        self.assertFalse(os.path.exists(self.stage()))


def shutil_rmtree(path):
    import shutil
    shutil.rmtree(path)


class Priced(Evidence):
    def edit(self, data):
        data['prices'] = {'as_of': '2026-11-01', 'source': 'test table',
                          'per_mtok': {'claude-opus-5-5': {'input': 1000000, 'output': 1000000, 'cache_read': 0, 'cache_write': 0},
                                       'claude-sonnet-5-5': {'input': 1000000, 'output': 1000000, 'cache_read': 0, 'cache_write': 0}}}

    def test_cost_is_priced_from_the_table(self):
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 0, self.out)
        cost = self.extract()['cost']
        self.assertEqual(cost['by_model'], {'claude-opus-5-5': 50.0, 'claude-sonnet-5-5': 12.0})
        self.assertEqual(cost['usd'], 62.0)
        self.assertTrue('cost: $62.00' in self.out)

    def test_a_model_name_that_is_not_a_plain_name_reaches_neither_the_extract_nor_the_terminal(self):
        odd = f'claude-opus-5-5 {SECRET} /Users/x/project'
        self.claude('s1.jsonl', user('Trial run A-cd-r1: go'), assistant('m1', model=odd, effort=f'high {SECRET}', tools=[{'command': 'ls'}]))
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertTrue('no price for <other>' in self.out, self.out)
        self.assertFalse(SECRET in self.out or 'project' in self.out)
        self.assertFalse(SECRET in json.dumps(self.extract()))
        self.assertEqual(list(self.extract()['tokens']['by_model']), ['<other>'])

    def test_an_unpriced_model_makes_it_n_a_and_the_command_says_so(self):
        self.claude('s1.jsonl', user('Trial run A-cd-r1: go'), assistant('m1', model='claude-haiku-5', tools=[{'command': 'ls'}]))
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertEqual(self.extract()['cost'], 'n/a')
        self.assertTrue('no price for claude-haiku-5' in self.out)


class Codex(Evidence):
    RUN = 'B-cx-r1'

    def meta(self, cwd=None, **extra):
        payload = dict({'cwd': cwd or self.clone, 'cli_version': '0.163.0', 'source': 'cli'}, **extra)
        return {'timestamp': '2026-11-02T10:00:00Z', 'type': 'session_meta', 'payload': payload}

    def turn(self, model='gpt-6-astra'):
        return {'type': 'turn_context', 'payload': {'model': model, 'effort': 'xhigh', 'approval_policy': 'on-request',
                                                    'sandbox_policy': {'type': 'workspace-write'}}}

    def total(self, output, total):
        return {'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {'total_token_usage': {
            'input_tokens': 100, 'cached_input_tokens': 40, 'output_tokens': output, 'total_tokens': total}}}}

    def fixture(self):
        self.rollout('rollout-2026-11-02T10-00-00-aaa.jsonl', self.meta(), self.turn(), self.total(50, 150),
                     {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': SECRET}},
                     {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'second'}},
                     {'type': 'response_item', 'payload': {'type': 'function_call', 'arguments': json.dumps({'cmd': 'ls ~/.codex/sessions'})}})
        self.rollout('rollout-2026-11-02T10-05-00-bbb.jsonl', self.meta(source={'subagent': {'thread_spawn': {}}}),
                     self.turn('gpt-6-lite'), self.total(5, 105))

    def test_rollouts_whose_working_directory_is_the_clone_or_below_are_copied_with_their_layout(self):
        self.fixture()
        self.rollout('rollout-2026-11-02T10-06-00-ccc.jsonl', self.meta(cwd=self.clone + '/packages/server'), self.turn(), self.total(1, 2))
        self.rollout('rollout-other.jsonl', self.meta(cwd='/Users/x/chroxy'), self.turn())
        self.rollout('rollout-sibling.jsonl', self.meta(cwd=self.clone + '-2'), self.turn())
        self.rollout('rollout-old.jsonl', self.meta(), self.turn(), when=BEFORE)
        self.assertEqual(self.run_evidence(), 0, self.out)
        names = self.tree(os.path.join(self.evidence_dir, self.RUN))
        self.assertEqual(names, ['MANIFEST.sha256'] + [f'codex-sessions/2026/11/02/rollout-2026-11-02T10-0{m}-00-{s}.jsonl'
                                                      for m, s in ((0, 'aaa'), (5, 'bbb'), (6, 'ccc'))])

    def test_codex_extract(self):
        self.fixture()
        self.assertEqual(self.run_evidence(), 0, self.out)
        doc = self.extract()
        self.assertEqual((doc['family'], doc['chroxy'], doc['permissions'], doc['daemon']), ('codex', False, None, None))
        self.assertEqual(doc['coordinator']['turns'], {'gpt-6-astra': 1})
        self.assertEqual((doc['coordinator']['approval_policies'], doc['coordinator']['sandboxes']), (['on-request'], ['workspace-write']))
        self.assertEqual(doc['workers']['turns'], {'gpt-6-lite': 1})
        self.assertEqual(doc['tokens']['by_model']['gpt-6-astra'], {'input': 60, 'output': 50, 'cache_read': 40, 'cache_write': 0})
        self.assertEqual(doc['people']['human_messages_after_first'], 1)
        self.assertEqual([h['pattern'] for h in doc['isolation']['hits']], ['codex_sessions'])
        self.assertEqual(doc['runs_row']['workers'], '1 subagent rollout(s): gpt-6-lite x1')
        self.assertFalse(SECRET in json.dumps(doc))

    def test_a_rollout_with_no_token_record_is_named_rather_than_left_out_of_the_totals(self):
        self.fixture()
        self.rollout('rollout-2026-11-02T10-07-00-ddd.jsonl', self.meta(source={'subagent': {}}), self.turn('gpt-6-lite'))
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertTrue(re.search(r'UNVERIFIED\s+rollout tokens\s+1 rollout', self.out), self.out)
        self.assertEqual(self.extract()['tokens']['rollouts_without_usage'], 1)

    def test_a_forked_rollout_makes_the_token_totals_unverified_and_the_cost_n_a(self):
        self.fixture()
        forked = self.meta(forked_from_id='parent-thread')
        self.rollout('rollout-2026-11-02T10-07-00-eee.jsonl', forked, self.turn(), self.total(500, 650))
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertTrue(re.search(r'UNVERIFIED\s+token totals\s+1 forked or resumed', self.out), self.out)
        doc = self.extract()
        self.assertEqual((doc['tokens']['by_model'], doc['tokens']['by_role']), ({}, {'coordinator': {}, 'workers': {}}))
        self.assertEqual((doc['cost'], doc['cost_note']), ('n/a', 'token totals are not verified'))
        self.assertEqual({c['name']: c['status'] for c in doc['checks']}['token totals'], 'UNVERIFIED')

    def test_a_rollout_that_replays_its_parents_usage_record_does_too(self):
        self.fixture()
        self.rollout('rollout-2026-11-02T10-07-00-fff.jsonl', self.meta(source={'subagent': {}}), self.turn('gpt-6-lite'),
                     self.total(50, 150), self.total(60, 160))
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertEqual(self.extract()['tokens']['replayed_rollouts'], 1)
        self.assertEqual(self.extract()['tokens']['by_model'], {})

    def test_a_stale_final_record_is_a_note_in_the_extract(self):
        self.rollout('rollout-2026-11-02T10-00-00-aaa.jsonl', self.meta(), self.turn(), self.total(50, 150), self.total(40, 120),
                     {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'go'}},
                     {'type': 'response_item', 'payload': {'type': 'function_call', 'arguments': '{"cmd": "ls"}'}})
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertEqual(self.extract()['tokens']['stale_final_rollouts'], 1)
        self.assertEqual(len(self.extract()['notes']), 1)
        self.assertTrue('1 rollout(s) ended on a token record below an earlier one' in self.extract()['notes'][0])

    def test_a_rollout_with_no_user_message_is_unverified_for_the_people_counts(self):
        self.rollout('rollout-2026-11-02T10-00-00-aaa.jsonl', self.meta(), self.turn(), self.total(50, 150))
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertEqual(self.extract()['people']['human_messages_total'], None)

    def test_a_missing_sessions_folder_is_unverified(self):
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertTrue('paths.codex_sessions' in self.out)


LOG = [
    ('09:59:00', 'INFO', 'ws', 'Permission request perm-before: Bash'),                 # before the window
    ('10:02:00', 'INFO', 'ws', 'Model change from c1 on session s-1: opus'),
    ('10:02:05', 'INFO', 'ws', 'Permission mode change from c1 on session s-1: default → auto at 2026-11-02T10:02:05.000Z'),
    ('10:10:00', 'INFO', 'ws', 'Permission request perm-a: Bash'),
    ('10:10:30', 'INFO', 'ws', 'Permission perm-a resolved: allow'),
    ('10:20:00', 'INFO', 'ws', 'Permission request perm-b-1-1: Write'),
    ('10:20:30', 'INFO', 'ws', 'Permission perm-b-1-1 resolved: deny'),                # one request answered over HTTP
    ('10:20:30', 'INFO', 'ws', 'Permission perm-b-1-1 resolved via HTTP: deny (sdk)'),   # logs these two lines
    ('10:30:00', 'INFO', 'ws', 'Interrupt from c1 to session s-1'),
    ('12:30:00', 'INFO', 'ws', 'Permission request perm-after: Bash'),                  # after the window
]


def log_text(rows=LOG, as_json=False):
    out = []
    for hhmmss, level, component, msg in rows:
        stamp = f'2026-11-02T{hhmmss}.000Z'
        out.append(json.dumps({'ts': stamp, 'level': level.lower(), 'component': component, 'msg': msg}) if as_json
                   else f'{stamp} [{level}] [{component}] {msg}')
    return '\n'.join(out) + '\n'


class DaemonLog:
    """The checks every Chroxy run shares; the subclasses put a transcript for their harness in place."""

    def put_log(self, text=None, name='chroxy.log'):
        return self.put('.chroxy', 'logs', name, text=text or log_text(), when=AFTER)

    def test_the_log_lines_of_the_window_are_copied_and_counted(self):
        self.put_log()
        self.assertEqual(self.run_evidence(), 0, self.out)
        copied = read(os.path.join(self.evidence_dir, self.RUN, 'daemon.log')).splitlines()
        self.assertEqual(len(copied), 8)
        self.assertFalse(any('perm-before' in line or 'perm-after' in line for line in copied))
        doc = self.extract()
        self.assertEqual(doc['permissions']['requests'], 2)
        self.assertEqual(doc['permissions']['decided_by'], {'human': 1, 'automatic': 0, 'unattributed': 1})
        self.assertEqual(doc['daemon'], {'session': 's-1', 'model': 'opus', 'permission_mode': 'auto', 'interrupts': 1,
                                         'lines_in_window': 8})
        self.assertEqual(doc['runs_row']['approvals'], '2 prompted: 1 human, 1 unattributed, 0 automatic (daemon log)')

    def test_the_json_log_format_is_read_too(self):
        self.put_log(log_text(as_json=True))
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertEqual(self.extract()['permissions']['requests'], 2)

    def test_rotated_logs_are_read_oldest_first(self):
        self.put_log(log_text([r for r in LOG if r[0] < '10:15:00']), 'chroxy.1.log')
        self.put_log(log_text([r for r in LOG if r[0] >= '10:15:00']))
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertEqual(self.extract()['daemon']['lines_in_window'], 8)

    def assert_no_permission_data(self, reason):
        """The extract holds no permission figure from a log that was not verified, and says why."""
        doc = self.extract()
        self.assertEqual((doc['permissions'], doc['daemon']), (None, None))
        self.assertTrue(reason in doc['permissions_unavailable'], doc['permissions_unavailable'])
        self.assertFalse('approvals' in doc['runs_row'], doc['runs_row'])
        status = {c['name']: c['status'] for c in doc['checks']}
        self.assertEqual(status['daemon log'], 'UNVERIFIED')
        self.assertTrue(re.search(r'UNVERIFIED\s+daemon log', self.out), self.out)

    def test_a_log_that_rotated_past_the_start_of_the_run_gives_no_permission_data(self):
        self.put_log(log_text([r for r in LOG if r[0] >= '10:15:00']))
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertTrue('rotation has dropped' in self.out)
        self.assert_no_permission_data('rotated past the window start')

    def test_a_log_with_nothing_in_the_window_gives_no_permission_data_not_zero_counts(self):
        self.put_log(log_text([LOG[0], LOG[-1]]))
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assert_no_permission_data('no daemon log line falls in the window')

    def test_an_unparseable_log_gives_no_permission_data_not_zero_counts(self):
        self.put_log('this is not a daemon log\n\x00\x01 binary \xff junk\nPermission request perm-x: Bash\n')
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assert_no_permission_data('no line with a readable timestamp')
        self.assertFalse('0 prompted' in json.dumps(self.extract()))

    def test_a_log_whose_timestamps_are_all_unreadable_gives_no_permission_data(self):
        self.put_log('not-a-time [INFO] [ws] Permission request perm-x: Bash\nnot-a-time [INFO] [ws] Permission perm-x resolved: allow\n')
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assert_no_permission_data('readable timestamp')

    def test_collect_leaves_approvals_alone_when_the_log_was_not_verified(self):
        from trialkit import collect
        self.put_log(log_text([r for r in LOG if r[0] >= '10:15:00']))
        self.run_evidence()
        row, problem = collect.native_row(self.data, self.RUN)
        self.assertEqual(problem, None)
        self.assertFalse('approvals' in row)
        st = state.load(self.trial, self.RUN, home=self.home)
        collect.update_runs_json(self.trial, self.run, self.data, st, SENT, '2026-11-02T09:00:00Z')
        with open(os.path.join(self.data, 'runs.json'), encoding='utf-8') as fh:
            meta = json.load(fh)['runs'][self.RUN]
        self.assertEqual(meta['approvals'], 'not recorded')
        self.assertTrue('compactions' in meta and meta['compactions'] != 'not recorded')     # what was verified still fills

    def test_a_verified_log_still_fills_approvals(self):
        from trialkit import collect
        self.put_log()
        self.run_evidence()
        st = state.load(self.trial, self.RUN, home=self.home)
        collect.update_runs_json(self.trial, self.run, self.data, st, SENT, '2026-11-02T09:00:00Z')
        with open(os.path.join(self.data, 'runs.json'), encoding='utf-8') as fh:
            self.assertEqual(json.load(fh)['runs'][self.RUN]['approvals'],
                             '2 prompted: 1 human, 1 unattributed, 0 automatic (daemon log)')

    def test_an_unreadable_log_is_unverified_and_leaves_the_permission_fields_empty(self):
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assert_no_permission_data('could not be read')
        self.assertFalse(os.path.exists(os.path.join(self.evidence_dir, self.RUN, 'daemon.log')))
        self.assertFalse(self.box.tmp in json.dumps(self.extract()), 'the reason holds no path')

    def test_names_taken_from_the_log_are_plain_identifiers_or_other(self):
        self.put_log(log_text([r for r in LOG if 'Model change' not in r[3] and 'mode change' not in r[3]] + [
            ('10:02:00', 'INFO', 'ws', 'Model change from c1 on session s-1: opus;curl'),
            ('10:02:05', 'INFO', 'ws', 'Permission mode change from c1 on session s-1: default → auto!x at 2026-11-02T10:02:05.000Z')]))
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertEqual((self.extract()['daemon']['model'], self.extract()['daemon']['permission_mode']), ('<other>', '<other>'))

    def test_the_last_session_phase_preflight_names_the_session(self):
        self.write_state(preflight=[{'phase': 'session', 'facts': {'session': 'abandoned'}}, {'phase': 'pre', 'facts': {}},
                                    {'phase': 'session', 'facts': {'session': 's-1'}}, {'phase': 'pre', 'facts': {}}])
        self.put_log()
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertEqual((self.extract()['daemon']['session'], self.extract()['daemon']['model']), ('s-1', 'opus'))

    def test_without_a_recorded_session_the_daemon_facts_are_empty_and_say_so(self):
        self.write_state(preflight=[])
        self.put_log()
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertEqual(self.extract()['daemon']['session'], None)
        self.assertTrue('session id' in self.out)


class ChroxyClaudeRun(DaemonLog, Evidence):
    RUN = 'A-cy-r1'

    def setUp(self):
        super().setUp()
        self.claude('s1.jsonl', user('Trial run A-cy-r1: go'), assistant('m1', tools=[{'command': 'ls'}]))
        self.write_state(preflight=[{'phase': 'pre', 'facts': {}}, {'phase': 'session', 'facts': {'session': 's-1'}}])


class ChroxyCodexRun(DaemonLog, Evidence):
    RUN = 'B-cy-r1'

    def setUp(self):
        super().setUp()
        self.rollout('rollout-2026-11-02T10-00-00-aaa.jsonl',
                     {'timestamp': '2026-11-02T10:00:00Z', 'type': 'session_meta', 'payload': {'cwd': self.clone, 'source': 'cli'}},
                     {'type': 'turn_context', 'payload': {'model': 'gpt-6-astra', 'effort': 'xhigh'}},
                     {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Trial run B-cy-r1: go'}},
                     {'type': 'response_item', 'payload': {'type': 'function_call', 'arguments': '{"cmd": "ls"}'}},
                     {'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {'total_token_usage': {
                         'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15}}}})
        self.write_state(preflight=[{'phase': 'session', 'facts': {'session': 's-1'}}])


class NativeRun(Evidence):
    def test_a_native_run_copies_no_daemon_log_even_when_one_exists(self):
        self.put('.chroxy', 'logs', 'chroxy.log', text=log_text(), when=AFTER)
        self.basic_claude()
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertFalse(os.path.exists(os.path.join(self.evidence_dir, self.RUN, 'daemon.log')))


class Cli(Evidence):
    def test_the_command_is_wired_and_exits_with_the_checks_code(self):
        self.basic_claude()
        env = self.box.env()
        code = cli.main(['--trial', self.box.trial_dir, 'evidence', self.RUN, '--data', self.data], env=env)
        self.assertEqual(code, 0, env.out.getvalue())
        self.assertTrue(os.path.exists(os.path.join(self.data, 'native', f'{self.RUN}.json')))

    def test_an_unknown_run_is_a_config_error(self):
        code = cli.main(['--trial', self.box.trial_dir, 'evidence', 'Z-nope'], env=self.box.env())
        self.assertEqual(code, 2)


if __name__ == '__main__':
    unittest.main()
