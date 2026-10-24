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
    ('10:20:30', 'INFO', 'ws', 'Permission perm-b-1-1 resolved via HTTP: deny (sdk)'),
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
        self.assertEqual(len(copied), 7)
        self.assertFalse(any('perm-before' in line or 'perm-after' in line for line in copied))
        doc = self.extract()
        self.assertEqual(doc['permissions']['requests'], 2)
        self.assertEqual(doc['permissions']['decided_by'], {'human': 1, 'automatic': 0, 'unattributed': 1})
        self.assertEqual(doc['daemon'], {'session': 's-1', 'model': 'opus', 'permission_mode': 'auto', 'interrupts': 1,
                                         'lines_in_window': 7})
        self.assertEqual(doc['runs_row']['approvals'], '2 prompted: 1 human, 1 unattributed, 0 automatic (daemon log)')

    def test_the_json_log_format_is_read_too(self):
        self.put_log(log_text(as_json=True))
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertEqual(self.extract()['permissions']['requests'], 2)

    def test_rotated_logs_are_read_oldest_first(self):
        self.put_log(log_text([r for r in LOG if r[0] < '10:15:00']), 'chroxy.1.log')
        self.put_log(log_text([r for r in LOG if r[0] >= '10:15:00']))
        self.assertEqual(self.run_evidence(), 0, self.out)
        self.assertEqual(self.extract()['daemon']['lines_in_window'], 7)

    def test_a_log_that_rotated_past_the_start_of_the_run_is_unverified(self):
        self.put_log(log_text([r for r in LOG if r[0] >= '10:15:00']))
        self.assertEqual(self.run_evidence(), 2, self.out)
        self.assertTrue('rotation has dropped' in self.out)
        self.assertEqual(self.extract()['permissions']['requests'], 1)

    def test_an_unreadable_log_is_unverified_and_leaves_the_permission_fields_empty(self):
        self.assertEqual(self.run_evidence(), 2, self.out)
        doc = self.extract()
        self.assertEqual((doc['permissions'], doc['daemon']), (None, None))
        self.assertFalse('approvals' in doc['runs_row'])
        self.assertFalse(os.path.exists(os.path.join(self.evidence_dir, self.RUN, 'daemon.log')))

    def test_a_log_with_nothing_in_the_window_is_unverified(self):
        self.put_log(log_text([LOG[0], LOG[-1]]))
        self.assertEqual(self.run_evidence(), 2, self.out)

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
