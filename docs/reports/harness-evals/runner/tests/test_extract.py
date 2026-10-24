"""The derived extract: aggregates over synthetic transcripts, the isolation patterns, the daemon-log
permission formats (pinned to the server source) and the price table."""
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timezone

import helpers
from trialkit import extract, native

CLONE = '/Users/x/trial/t2/A-cd-r1'
OWN_BASE = 'trial/t2-a-cd-r1'
SECRET = 'SECRET-SENTINEL-3f9a'  # message text, tool output and command lines must never reach an extract


def jl(*entries):
    return '\n'.join(e if isinstance(e, str) else json.dumps(e) for e in entries) + '\n'


# -- Claude Code shapes ---------------------------------------------------------------

def usage(i=0, o=0, r=0, w=0):
    return {'input_tokens': i, 'output_tokens': o, 'cache_read_input_tokens': r, 'cache_creation_input_tokens': w}


def assistant(mid='m1', model='claude-opus-5-5', use=None, effort=None, side=False, uuid=None, tools=()):
    entry = {'type': 'assistant', 'timestamp': '2026-11-02T10:00:01Z',
             'message': {'id': mid, 'role': 'assistant', 'model': model,
                         'content': [{'type': 'tool_use', 'name': 'Bash', 'input': t} for t in tools]}}
    if use is not None:
        entry['message']['usage'] = use
    if effort:
        entry['effort'] = effort
    if side:
        entry['isSidechain'] = True
    if uuid:
        entry['uuid'] = uuid
    return entry


def user(content, uuid=None, **extra):
    entry = {'type': 'user', 'message': {'role': 'user', 'content': content}}
    if uuid:
        entry['uuid'] = uuid
    entry.update(extra)
    return entry


def boundary(uuid=None, side=False):
    entry = {'type': 'system', 'subtype': 'compact_boundary', 'content': 'Conversation compacted'}
    if uuid:
        entry['uuid'] = uuid
    if side:
        entry['isSidechain'] = True
    return entry


class TempFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='trialctl-extract-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.count = 0

    def write(self, *entries, name=None):
        self.count += 1
        path = os.path.join(self.tmp, name or f'f{self.count}.jsonl')
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(jl(*entries))
        return path

    def scanner(self):
        return extract.Isolation(OWN_BASE, '~/Obsidian/no-it-all/reviews/harness-trial-2', native.slug_candidates(CLONE))


class ClaudeRoles(unittest.TestCase):
    def test_top_level_sessions_are_coordinators_and_subagent_files_are_workers(self):
        role = extract.claude_role
        self.assertEqual(role('0a1b.jsonl'), 'coordinator')
        self.assertEqual(role('0a1b/subagents/agent-7.jsonl'), 'worker')
        self.assertEqual(role('agent-7.jsonl'), 'worker')
        self.assertIsNone(role('0a1b/tool-results/out.txt'))
        self.assertIsNone(role('0a1b/other/session.jsonl'))
        self.assertEqual(role('0a1b/subagents/task-9.jsonl'), 'worker')


class ClaudeTurnsAndTokens(TempFiles):
    def summary(self, coordinator=(), workers=()):
        files = [(self.write(*coordinator), 'coordinator')]
        files += [(self.write(*w), 'worker') for w in workers]
        self.scan = self.scanner()
        return extract.claude_summary(files, self.scan)

    def test_blocks_of_one_message_are_one_turn_and_usage_is_counted_once(self):
        s = self.summary([
            assistant('m1', effort='high', use=usage(i=10, o=5, r=100, w=7)),
            assistant('m1', effort='high', use=usage(i=10, o=240, r=100, w=7)),   # a later block carries the final output
            assistant('m2', effort='high', use=usage(i=3, o=50, r=300)),
            assistant('m3', model='claude-sonnet-5-5', effort='medium', use=usage(i=1, o=1))])
        self.assertEqual(s['coordinator']['turns'], {'claude-opus-5-5': 2, 'claude-sonnet-5-5': 1})
        self.assertEqual(s['coordinator']['efforts'], {'high': 2, 'medium': 1})
        self.assertEqual(s['tokens']['by_model']['claude-opus-5-5'],
                         {'input': 13, 'output': 290, 'cache_read': 400, 'cache_write': 7})
        self.assertEqual(s['tokens']['by_model']['claude-sonnet-5-5']['output'], 1)

    def test_the_largest_value_of_each_field_wins_whatever_the_order(self):
        for order in ((240, 5), (5, 240)):
            s = self.summary([assistant('m1', use=usage(i=1, o=order[0])), assistant('m1', use=usage(i=9, o=order[1]))])
            self.assertEqual(s['tokens']['by_model']['claude-opus-5-5']['output'], 240, order)
            self.assertEqual(s['tokens']['by_model']['claude-opus-5-5']['input'], 9, order)

    def test_the_same_message_in_two_files_is_counted_once_where_it_first_appears(self):
        both = [assistant('m1', use=usage(o=40))]
        s = self.summary(both, workers=[both])
        self.assertEqual(s['tokens']['by_model']['claude-opus-5-5']['output'], 40)
        self.assertEqual(s['tokens']['by_role']['coordinator']['claude-opus-5-5']['output'], 40)
        self.assertEqual(s['tokens']['by_role']['workers'], {})
        self.assertEqual((s['coordinator']['turns'], s['workers']['turns']), ({'claude-opus-5-5': 1}, {}))

    def test_synthetic_models_and_entries_without_a_model_are_not_turns(self):
        s = self.summary([assistant('m1', model='<synthetic>', use=usage(o=9)), {'type': 'assistant', 'message': {}},
                          {'type': 'assistant'}])
        self.assertEqual((s['coordinator']['turns'], s['tokens']['by_model']), ({}, {}))

    def test_workers_come_from_subagent_files_and_inline_sidechains(self):
        s = self.summary([assistant('m1', use=usage(o=1)),
                          assistant('s1', model='claude-sonnet-5-5', side=True, use=usage(o=2))],
                         workers=[[assistant('w1', model='claude-sonnet-5-5', use=usage(o=4)),
                                   assistant('w2', model='claude-haiku-5', use=usage(o=8))]])
        self.assertEqual(s['coordinator']['turns'], {'claude-opus-5-5': 1})
        self.assertEqual(s['workers']['turns'], {'claude-haiku-5': 1, 'claude-sonnet-5-5': 2})
        self.assertEqual(s['workers']['transcripts'], 1)
        self.assertEqual(s['tokens']['by_model']['claude-sonnet-5-5']['output'], 6)

    def test_an_entry_with_usage_but_no_message_id_is_counted_and_reported(self):
        entry = assistant(use=usage(o=5))
        del entry['message']['id']
        s = self.summary([entry, entry])
        self.assertEqual(s['tokens']['messages_without_id'], 2)
        self.assertEqual(s['tokens']['by_model']['claude-opus-5-5']['output'], 10)

    def test_malformed_lines_are_skipped(self):
        path = os.path.join(self.tmp, 'bad.jsonl')
        with open(path, 'w') as fh:
            fh.write(jl(assistant('m1', use=usage(o=3)), '{"type": "assist', 'not json'))
        s = extract.claude_summary([(path, 'coordinator')], self.scanner())
        self.assertEqual(s['tokens']['by_model']['claude-opus-5-5']['output'], 3)


class ClaudeHumansAndEvents(TempFiles):
    def summary(self, *entries):
        return extract.claude_summary([(self.write(*entries), 'coordinator')], self.scanner())

    def test_messages_after_the_first_exclude_everything_a_person_did_not_type(self):
        s = self.summary(
            user('/prime-directive "Trial run A-cd-r1: follow m.md"'),                     # the invocation
            user([{'type': 'text', 'text': 'Base directory for this skill: /x'}], isMeta=True),
            user([{'type': 'tool_result', 'tool_use_id': 't', 'content': 'out'}]),
            user('<task-notification>agent done</task-notification>'),
            user('<system-reminder>hi</system-reminder>'),
            user('This session is being continued from a summary', isCompactSummary=True),
            user('please also do X'),                                                       # 1
            user([{'type': 'image', 'source': {}}]),                                        # 2: an attachment alone
            user('side question', isSidechain=True),
            user([{'type': 'text', 'text': '[Request interrupted by user]'}]),
            user('and then Y'))                                                             # 3
        self.assertEqual((s['human_messages_total'], s['human_messages_after_first']), (4, 3))
        self.assertEqual(s['interrupts'], 1)

    def test_an_empty_transcript_has_no_messages_and_the_count_does_not_go_negative(self):
        s = self.summary(assistant('m1', use=usage(o=1)))
        self.assertEqual((s['human_messages_total'], s['human_messages_after_first']), (0, 0))

    def test_a_replayed_entry_counts_once(self):
        s = self.summary(user('first', uuid='u1'), user('again', uuid='u2'), user('again', uuid='u2'),
                         user([{'type': 'text', 'text': '[Request interrupted by user for tool use]'}], uuid='u3'),
                         user([{'type': 'text', 'text': '[Request interrupted by user for tool use]'}], uuid='u3'),
                         boundary('c1'), boundary('c1'))
        self.assertEqual((s['human_messages_total'], s['interrupts'], s['compactions']['coordinator']), (2, 1, 1))

    def test_the_first_message_is_the_one_of_the_earliest_transcript(self):
        late = self.write(user('later session, first words', uuid='b1', ), user('second', uuid='b2'), name='b.jsonl')
        early = self.write({'timestamp': '2026-11-02T09:00:00Z', 'type': 'user', 'uuid': 'a1',
                            'message': {'role': 'user', 'content': 'the invocation'}}, name='a.jsonl')
        s = extract.claude_summary([(late, 'coordinator'), (early, 'coordinator')], self.scanner())
        self.assertEqual((s['human_messages_total'], s['human_messages_after_first']), (3, 2))

    def test_compactions_split_by_role(self):
        files = [(self.write(boundary(), boundary(side=True)), 'coordinator'), (self.write(boundary()), 'worker')]
        s = extract.claude_summary(files, self.scanner())
        self.assertEqual(s['compactions'], {'coordinator': 1, 'workers': 2})

    def test_permission_modes_are_listed_once_each(self):
        s = self.summary(user('hi', permissionMode='auto'), user('again', permissionMode='auto'),
                         user('then', permissionMode='default'))
        self.assertEqual(s['coordinator']['permission_modes'], ['auto', 'default'])

    def test_no_message_text_reaches_the_summary(self):
        s = self.summary(user(f'the invocation {SECRET}'), user(f'another {SECRET}'),
                         user([{'type': 'tool_result', 'tool_use_id': 't', 'content': SECRET}]),
                         assistant('m1', use=usage(o=1), tools=[{'command': f'echo {SECRET}'}]))
        self.assertFalse(SECRET in json.dumps(s))


class ClaudeIsolationScan(TempFiles):
    def scan(self, *entries):
        scanner = self.scanner()
        extract.claude_summary([(self.write(*entries), 'coordinator')], scanner)
        return scanner.report()

    def test_tool_inputs_are_scanned_and_nothing_else(self):
        prose = assistant('m0', use=usage(o=1))
        prose['message']['content'] = [{'type': 'text', 'text': 'I will not read trial/a1-cd or NEXT-x.md'}]
        report = self.scan(
            user('look at trial/a1-cd and KEY.md'),
            user([{'type': 'tool_result', 'tool_use_id': 't', 'content': 'trial/a1-cd KEY.md'}]),
            prose,
            assistant('m1', use=usage(o=1), tools=[{'command': 'git log origin/trial/a1-cd'}, {'file_path': '/x/KEY.md.enc'}]))
        self.assertEqual(report['tool_inputs_scanned'], 2)
        self.assertEqual({h['pattern']: h['count'] for h in report['hits']}, {'other_trial_branch': 1, 'key_file': 1})

    def test_nested_input_values_are_reached(self):
        report = self.scan(assistant('m1', use=usage(o=1), tools=[{'edits': [{'old': 'x', 'new': 'cat NEXT-chroxy.md'}]}]))
        self.assertEqual([h['pattern'] for h in report['hits']], ['next_seed'])

    def test_a_clean_run_reports_what_it_checked(self):
        report = self.scan(assistant('m1', use=usage(o=1), tools=[{'command': 'npm test'}]))
        self.assertEqual(report['hits'], [])
        self.assertEqual(report['tool_inputs_scanned'], 1)
        self.assertIn('claude_projects_other', report['patterns_checked'])

    def test_no_tool_input_is_reported_as_zero_scanned_not_as_clean(self):
        self.assertEqual(self.scan(user('hi'))['tool_inputs_scanned'], 0)


class IsolationPatterns(unittest.TestCase):
    def setUp(self):
        self.s = self.fresh()

    @staticmethod
    def fresh():
        return extract.Isolation(OWN_BASE, '~/Obsidian/no-it-all/reviews/harness-trial-2', native.slug_candidates(CLONE))

    def hits(self, *texts):
        scanner = self.fresh()
        for text in texts:
            scanner.scan(text)
        return {h['pattern']: h['count'] for h in scanner.report()['hits']}

    def test_other_trial_branches_in_every_spelling_but_not_the_runs_own(self):
        self.assertEqual(self.hits('git log trial/a1-cd', 'git show origin/trial/t2-b-cy-r1:README.md',
                                   'refs/heads/trial/dry-cx', 'refs/remotes/origin/trial/eval', 'git checkout trial/b2c-cy-codex.',
                                   'git diff main..trial/eval-claude'),
                         {'other_trial_branch': 6})
        self.assertEqual(self.hits('git log trial/eval'), {'other_trial_branch': 1})

    def test_the_runs_own_base_is_not_a_hit_but_a_longer_name_is(self):
        self.assertEqual(self.hits(f'git push origin {OWN_BASE}', f'git log origin/{OWN_BASE}'), {})
        self.assertEqual(self.hits(f'git log {OWN_BASE}0'), {'other_trial_branch': 1})

    def test_repository_directories_named_trial_are_not_branches(self):
        self.assertEqual(self.hits('cat docs/reports/harness-evals/trial/data/runs.json', 'ls trial/data', 'cat trial/scripts/measures.py',
                                   'less trial/README.md', 'cat trial/queue-candidates.md', 'python3 trial/scripts/run-all.py'), {})
        self.assertEqual(self.hits('ls some/dir/trial/a1-cd', 'cat ../trial/b1-cx/x', 'ls mytrial/a1-cd', 'ls -trial/a1-cd'), {})

    def test_the_key_folder_in_any_spelling(self):
        self.assertEqual(self.hits('cat ~/Obsidian/no-it-all/reviews/harness-trial-2/KEY.md.enc',
                                   'ls /Users/x/Obsidian/no-it-all/reviews/harness-trial-2/evidence',
                                   'cd reviews/harness-trial-2'),
                         {'key_folder': 3, 'key_file': 1})
        self.assertEqual(self.hits('echo harness-trial-20 harness-trial-2x'), {})

    def test_key_files_but_not_the_committed_commitment(self):
        self.assertEqual(self.hits('cat KEY.md', 'cat docs/x/KEY.md.enc', 'cat KEY-COMMITMENT.md', 'cat MYKEY.md', 'KEY.mdx'),
                         {'key_file': 2})

    def test_next_seeds(self):
        self.assertEqual(self.hits('cat ~/Obsidian/handoffs/NEXT-chroxy.md', 'NEXT-fleet-topic.md', 'NEXT.md', 'NEXTX-a.md'),
                         {'next_seed': 2})

    def test_another_projects_native_folder_but_not_the_runs_own(self):
        own = native.slug(CLONE)
        self.assertEqual(self.hits(f'ls ~/.claude/projects/{own}', f'cat ~/.claude/projects/{own}/s.jsonl;',
                                   'ls ~/.claude/projects/-Users-x-chroxy', 'ls ~/.claude/projects', f'ls ~/.claude/projects/{own}-2'),
                         {'claude_projects_other': 3})

    def test_the_codex_store(self):
        self.assertEqual(self.hits('ls ~/.codex/sessions', 'find ~/.codex/archived_sessions -name x', 'ls ~/.codex/prompts'),
                         {'codex_sessions': 2})

    def test_the_report_holds_a_hash_and_never_the_string(self):
        for text in ('git log trial/a1-cd', 'git log trial/a1-cd', 'cat NEXT-chroxy.md'):
            self.s.scan(text)
        report = self.s.report()
        branch = next(h for h in report['hits'] if h['pattern'] == 'other_trial_branch')
        self.assertEqual((branch['count'], branch['distinct']), (2, 1))
        self.assertEqual(branch['sha256'], [extract.sha256_text('trial/a1-cd')])
        text = json.dumps(report)
        self.assertFalse('a1-cd' in text or 'NEXT-chroxy' in text)

    def test_without_a_key_folder_that_pattern_is_not_claimed_as_checked(self):
        s = extract.Isolation(OWN_BASE, None, ())
        self.assertFalse('key_folder' in s.patterns)
        self.assertTrue('key_folder' in self.s.patterns)


# -- Codex shapes -----------------------------------------------------------------------

def meta(cwd=CLONE, source='cli', parent=None, ts='2026-11-02T10:00:00Z'):
    payload = {'cwd': cwd, 'cli_version': '0.163.0', 'originator': 'codex_cli_rs', 'source': source}
    if parent:
        payload['parent_thread_id'] = parent
    return {'timestamp': ts, 'type': 'session_meta', 'payload': payload}


def turn(model='gpt-6-astra', effort='xhigh', approval='on-request', sandbox='workspace-write'):
    return {'type': 'turn_context', 'payload': {'model': model, 'effort': effort, 'approval_policy': approval,
                                                'sandbox_policy': {'type': sandbox}}}


def event(kind, **payload):
    return {'type': 'event_msg', 'payload': dict(payload, type=kind)}


def counted(total_tokens, input_tokens=0, cached=0, output=0, reasoning=0):
    return event('token_count', info={'total_token_usage': {
        'input_tokens': input_tokens, 'cached_input_tokens': cached, 'output_tokens': output,
        'reasoning_output_tokens': reasoning, 'total_tokens': total_tokens}})


def call(kind='function_call', **fields):
    return {'type': 'response_item', 'payload': dict({'type': kind}, **fields)}


class CodexSummary(TempFiles):
    def summary(self, *rollouts):
        paths = [self.write(*entries) for entries in rollouts]
        self.scan = self.scanner()
        return extract.codex_summary(paths, self.scan)

    def test_coordinator_and_subagent_rollouts_are_told_apart(self):
        s = self.summary([meta(), turn(), turn(effort='high')],
                         [meta(source={'subagent': {'thread_spawn': {}}}), turn(model='gpt-6-lite', effort='low')],
                         [meta(parent='p1'), turn(model='gpt-6-lite', effort='low'), turn(model='gpt-6-lite', effort='low')])
        self.assertEqual(s['coordinator']['turns'], {'gpt-6-astra': 2})
        self.assertEqual(s['coordinator']['efforts'], {'high': 1, 'xhigh': 1})
        self.assertEqual((s['coordinator']['approval_policies'], s['coordinator']['sandboxes']),
                         (['on-request'], ['workspace-write']))
        self.assertEqual(s['workers']['turns'], {'gpt-6-lite': 3})
        self.assertEqual((s['coordinator']['transcripts'], s['workers']['transcripts']), (1, 2))

    def test_tokens_split_cached_input_and_do_not_add_reasoning_twice(self):
        s = self.summary([meta(), turn(), counted(1500, input_tokens=1000, cached=600, output=500, reasoning=300)])
        self.assertEqual(s['tokens']['by_model']['gpt-6-astra'],
                         {'input': 400, 'output': 500, 'cache_read': 600, 'cache_write': 0})

    def test_a_stale_final_record_does_not_hide_the_larger_total_before_it(self):
        s = self.summary([meta(), turn(), counted(900, input_tokens=600, output=300), counted(2000, input_tokens=1500, output=500),
                          counted(1000, input_tokens=700, output=300)])
        self.assertEqual(s['tokens']['by_model']['gpt-6-astra']['output'], 500)
        self.assertEqual(s['tokens']['stale_final_rollouts'], 1)

    def test_a_final_record_that_is_the_largest_is_not_stale(self):
        s = self.summary([meta(), turn(), counted(900, output=300), counted(2000, output=500)])
        self.assertEqual((s['tokens']['by_model']['gpt-6-astra']['output'], s['tokens']['stale_final_rollouts']), (500, 0))

    def test_the_thread_usage_record_is_a_source_too(self):
        record = {'type': 'token_usage_record', 'payload': {'thread_token_usage': {
            'input_tokens': 5000, 'cached_input_tokens': 1000, 'output_tokens': 800, 'total_tokens': 5800}}}
        s = self.summary([meta(), turn(), counted(900, output=300), record])
        self.assertEqual(s['tokens']['by_model']['gpt-6-astra'], {'input': 4000, 'output': 800, 'cache_read': 1000, 'cache_write': 0})
        self.assertEqual(s['tokens']['sources'], {'token_usage_record': 1})

    def test_workers_are_totalled_by_their_own_model(self):
        s = self.summary([meta(), turn(), counted(100, output=100)],
                         [meta(parent='p'), turn(model='gpt-6-lite'), counted(50, output=50)])
        self.assertEqual(s['tokens']['by_model'], {'gpt-6-astra': {'input': 0, 'output': 100, 'cache_read': 0, 'cache_write': 0},
                                                   'gpt-6-lite': {'input': 0, 'output': 50, 'cache_read': 0, 'cache_write': 0}})
        self.assertEqual(s['tokens']['by_role']['workers'], {'gpt-6-lite': {'input': 0, 'output': 50, 'cache_read': 0, 'cache_write': 0}})

    def test_a_rollout_without_usage_is_reported_and_one_with_two_models_is_priced_at_the_last(self):
        s = self.summary([meta(), turn()], [meta(), turn(model='a'), turn(model='b'), counted(10, output=10)])
        self.assertEqual((s['tokens']['rollouts_without_usage'], s['tokens']['mixed_model_rollouts']), (1, 1))
        self.assertEqual(list(s['tokens']['by_model']), ['b'])

    def test_people_events_come_from_coordinator_rollouts(self):
        s = self.summary([meta(), turn(), event('user_message', message=SECRET), event('user_message', message='again'),
                          event('turn_aborted', reason='interrupted'), event('agent_message', message='hi')],
                         [meta(parent='p'), turn(), event('user_message', message='spawn prompt'), event('turn_aborted')])
        self.assertEqual((s['human_messages_total'], s['human_messages_after_first'], s['interrupts']), (2, 1, 1))
        self.assertFalse(SECRET in json.dumps(s))

    def test_a_compaction_is_counted_once_however_many_records_it_leaves(self):
        both = [meta(), turn(), {'type': 'compacted', 'payload': {'message': SECRET}}, event('context_compacted'),
                call('compaction')]
        s = self.summary(both, both[:2] + [{'type': 'compacted', 'payload': {}}] * 2,
                         [meta(parent='p'), turn(), event('context_compacted')])
        self.assertEqual(s['compactions'], {'coordinator': 3, 'workers': 1})

    def test_tool_arguments_are_scanned_in_each_call_shape(self):
        s = self.summary([meta(), turn(),
                          call(arguments=json.dumps({'cmd': 'git log trial/a1-cd', 'workdir': '/x'}), name='shell'),
                          call('custom_tool_call', input='cat KEY.md'),
                          call('local_shell_call', action={'command': ['ls', '~/.codex/sessions']}),
                          event('exec_command_begin', command='cat NEXT-chroxy.md'),
                          {'type': 'response_item', 'payload': {'type': 'function_call_output', 'output': 'trial/b1-cx',
                                                                'input': 'trial/b1-cx'}}])
        hits = {h['pattern']: h['count'] for h in self.scan.report()['hits']}
        self.assertEqual(hits, {'other_trial_branch': 1, 'key_file': 1, 'codex_sessions': 1})

    def test_a_missing_rollout_set_is_an_empty_summary_not_a_crash(self):
        s = extract.codex_summary([], self.scanner())
        self.assertEqual((s['coordinator']['transcripts'], s['tokens']['by_model']), (0, {}))


# -- the daemon log ------------------------------------------------------------------------

SERVER_SRC = os.path.join(helpers.REPO_ROOT, 'packages', 'server', 'src')
# (pattern, source file, the log call copied from it, a message that call writes)
PINNED = (
    ('request', 'ws-permissions.js', "log.info(`Permission request ${requestId}: ${hookData.tool_name || 'unknown tool'}`)",
     'Permission request perm-5b1c: Bash'),
    ('request', 'permission-manager.js', 'this._logInfo(`Permission request ${requestId}: ${toolName}`)',
     'Permission request perm-ab12-1-1760000000000: Edit'),
    ('resolved', 'ws-permissions.js', 'log.info(`Permission ${requestId} resolved: ${decision}`)', 'Permission perm-5b1c resolved: allow'),
    ('resolved', 'permission-manager.js', 'this._logInfo(`Permission ${requestId} resolved: ${decision}`)',
     'Permission perm-ab12-1-1760000000000 resolved: allowAlways'),
    ('resolved_http', 'ws-permissions.js', 'log.info(`Permission ${requestId} resolved via HTTP: ${decision} (${result.via})`)',
     'Permission perm-ab12-2-1760000000001 resolved via HTTP: deny (sdk)'),
    ('timed_out', 'ws-permissions.js', 'log.info(`Permission ${requestId} timed out, auto-denying`)',
     'Permission perm-5b1c timed out, auto-denying'),
    ('timed_out', 'permission-manager.js', 'this._logInfo(`Permission ${requestId} timed out, auto-denying`)',
     'Permission perm-ab12-3-1760000000002 timed out, auto-denying'),
    ('closed', 'ws-permissions.js', 'log.info(`Permission ${requestId} connection closed by client`)',
     'Permission perm-5b1c connection closed by client'),
    ('late', 'ws-permissions.js', 'log.info(`Permission ${requestId} already expired when HTTP response arrived (SDK)`)',
     'Permission perm-ab12-3-1760000000002 already expired when HTTP response arrived (SDK)'),
    ('floor', 'ws-permissions.js', "log.info(`Permission floor forces a prompt for ${hookData?.tool_name || 'unknown tool'} (${reason})`)",
     'Permission floor forces a prompt for Write (floor predicate)'),
    ('rule', 'permission-manager.js', 'this._logInfo(`Permission rule matched for ${toolName}: ${ruleDecision}`)',
     'Permission rule matched for Bash: allow'),
    ('cap', 'permission-manager.js',
     'this._logInfo(`Pending-permission cap (${this._maxPendingPermissions}) reached — auto-denying ${requestId}`)',
     'Pending-permission cap (1000) reached — auto-denying perm-ab12-9-1760000000009'),
    ('switch', 'permission-manager.js', 'this._logInfo(`Auto-allowed ${allowed} pending permission(s) on auto mode switch`)',
     'Auto-allowed 3 pending permission(s) on auto mode switch'),
    ('switch', 'permission-manager.js', '`Auto-allowed ${allowed} pending permission(s), denied ${deniedMcpTrust} MCP trust prompt(s)',
     'Auto-allowed 2 pending permission(s), denied 1 MCP trust prompt(s), preserved 0 protected-path prompt(s), '
     'and preserved 1 not-delegable prompt(s) on auto mode switch'),
)
PATTERNS = {'request': extract.REQUEST, 'resolved': extract.RESOLVED, 'resolved_http': extract.RESOLVED_HTTP,
            'timed_out': extract.TIMED_OUT, 'closed': extract.CLOSED, 'late': extract.LATE, 'floor': extract.FLOOR,
            'rule': extract.RULE, 'cap': extract.CAP, 'switch': extract.AUTO_SWITCH}


def read_source(name):
    with open(os.path.join(SERVER_SRC, name), encoding='utf-8') as fh:
        return fh.read()


class LogFormatsArePinnedToTheServer(unittest.TestCase):
    def test_every_pinned_log_call_is_still_in_the_source(self):
        for pattern, name, line, _sample in PINNED:
            self.assertTrue(line in read_source(name), f'{pattern}: {name} no longer holds {line!r}; update extract.py')

    def test_every_pattern_matches_a_message_the_pinned_call_writes(self):
        for pattern, _name, _line, sample in PINNED:
            self.assertIsNotNone(PATTERNS[pattern].match(sample), f'{pattern}: {sample!r}')

    def test_every_pattern_in_the_module_is_pinned(self):
        self.assertEqual(sorted({p for p, _n, _l, _s in PINNED}), sorted(PATTERNS))

    def test_the_patterns_do_not_match_each_others_messages(self):
        for pattern, _name, _line, sample in PINNED:
            matched = sorted(p for p, rx in PATTERNS.items() if rx.match(sample))
            self.assertEqual(matched, [pattern], sample)


def at(second, level, component, msg, as_json=False):
    stamp = f'2026-11-02T10:00:{second:02d}.000Z'
    if as_json:
        return json.dumps({'ts': stamp, 'level': level.lower(), 'component': component, 'msg': msg})
    return f'{stamp} [{level}] [{component}] {msg}'


class Permissions(unittest.TestCase):
    def count(self, *lines):
        return extract.permissions('\n'.join(lines) + '\n')

    def test_outcomes_are_counted_by_how_the_log_says_they_ended(self):
        p = self.count(
            at(1, 'INFO', 'ws', 'Permission request perm-a: Bash'),
            at(2, 'INFO', 'ws', 'Permission perm-a resolved: allow'),
            at(3, 'INFO', 'sdk-session', 'Permission request perm-b-1-1: Write', as_json=True),
            at(4, 'INFO', 'sdk-session', 'Permission perm-b-1-1 resolved via HTTP: deny (sdk)', as_json=True),
            at(5, 'INFO', 'ws', 'Permission request perm-c: Bash'),
            at(6, 'INFO', 'ws', 'Permission perm-c timed out, auto-denying'),
            at(7, 'INFO', 'ws', 'Permission request perm-d: Read'),
            at(8, 'INFO', 'ws', 'Permission perm-d connection closed by client'),
            at(9, 'INFO', 'ws', 'Permission request perm-e: Edit'),
            at(10, 'INFO', 'ws', 'Permission floor forces a prompt for Edit (floor predicate)'),
            at(11, 'INFO', 'x', 'Permission rule matched for Bash: allow'),
            at(12, 'INFO', 'x', 'Permission rule matched for Bash: deny'),
            at(13, 'INFO', 'x', 'Pending-permission cap (2) reached — auto-denying perm-z'),
            at(14, 'INFO', 'x', 'Auto-allowed 3 pending permission(s) on auto mode switch'),
            at(15, 'INFO', 'ws', 'Permission perm-c already expired when HTTP response arrived (SDK)'),
            at(16, 'DEBUG', 'ws', 'Permission floor clear for Bash'))
        self.assertEqual(p['requests'], 5)
        self.assertEqual(p['requests_by_tool'], {'Bash': 2, 'Edit': 1, 'Read': 1, 'Write': 1})
        self.assertEqual(p['unresolved_requests'], 1)          # perm-e
        self.assertEqual(p['resolved'], {'allow': 1})
        self.assertEqual(p['resolved_by_http'], {'deny': 1})
        self.assertEqual((p['timed_out'], p['connection_closed'], p['late_responses'], p['floor_forced']), (1, 1, 1, 1))
        self.assertEqual(p['automatic'], {'rule_allow': 1, 'rule_deny': 1, 'cap_denied': 1, 'auto_mode_switch_allowed': 3})
        self.assertEqual(p['decided_by'], {'human': 1, 'automatic': 7, 'unattributed': 1})

    def test_a_request_logged_twice_is_one_request(self):
        p = self.count(at(1, 'INFO', 'ws', 'Permission request perm-a: Bash'), at(2, 'INFO', 'ws', 'Permission request perm-a: Bash'))
        self.assertEqual(p['requests'], 1)

    def test_unrelated_and_malformed_lines_are_ignored(self):
        p = self.count('garbage', '{"not": "a log', at(1, 'INFO', 'ws', 'Permission mode change from c1 on session s: default → auto at x'),
                       at(2, 'INFO', 'ws', 'MCP trust request perm-m: server'), at(3, 'INFO', 'ws', 'Question q timed out, auto-denying'))
        self.assertEqual((p['requests'], p['decided_by']), (0, {'human': 0, 'automatic': 0, 'unattributed': 0}))

    def test_the_note_says_what_the_log_cannot_show(self):
        self.assertTrue('short-circuits' in extract.permissions('')['note'])


class SliceLog(unittest.TestCase):
    START = datetime(2026, 11, 2, 10, 0, 5, tzinfo=timezone.utc)
    END = datetime(2026, 11, 2, 10, 0, 9, tzinfo=timezone.utc)

    def test_lines_inside_the_window_in_both_formats_and_continuations_travel_with_their_line(self):
        lines = [at(4, 'INFO', 'ws', 'before'), at(5, 'INFO', 'ws', 'at the start'), at(6, 'ERROR', 'ws', 'boom'),
                 '    at stack frame', at(7, 'INFO', 'ws', 'json line', as_json=True), at(9, 'INFO', 'ws', 'at the end'),
                 at(10, 'INFO', 'ws', 'after'), '    tail of after']
        kept = extract.slice_log('\n'.join(lines) + '\n', self.START, self.END)
        self.assertEqual(kept, [lines[1], lines[2], lines[3], lines[4], lines[5]])

    def test_an_empty_log_slices_to_nothing(self):
        self.assertEqual(extract.slice_log('', self.START, self.END), [])


# -- cost --------------------------------------------------------------------------------------

TABLE = {'as_of': '2026-11-01', 'source': 'vendor price pages, read 2026-11-01',
         'per_mtok': {'claude-opus-5-5': {'input': 5, 'output': 25, 'cache_read': 0.5, 'cache_write': 6.25},
                      'gpt-6-astra': {'input': 2, 'output': 10, 'cache_read': 0.2}}}


def tokens(i=0, o=0, r=0, w=0):
    return {'input': i, 'output': o, 'cache_read': r, 'cache_write': w}


class Cost(unittest.TestCase):
    def test_no_table_is_n_a_with_the_reason(self):
        self.assertEqual(extract.cost({'m': tokens(o=1)}, None), ('n/a', 'trial.json has no price table'))

    def test_priced_by_model_per_million_tokens(self):
        value, note = extract.cost({'claude-opus-5-5': tokens(1_000_000, 2_000_000, 10_000_000, 1_000_000),
                                    'gpt-6-astra': tokens(500_000, 100_000, 1_000_000)}, TABLE)
        self.assertIsNone(note)
        self.assertEqual(value['by_model'], {'claude-opus-5-5': 66.25, 'gpt-6-astra': 2.2})
        self.assertEqual((value['usd'], value['as_of']), (68.45, '2026-11-01'))

    def test_one_unpriced_model_makes_the_whole_cost_n_a(self):
        value, note = extract.cost({'claude-opus-5-5': tokens(o=1), 'claude-haiku-5': tokens(o=1)}, TABLE)
        self.assertEqual((value, note), ('n/a', 'no price for claude-haiku-5'))

    def test_a_cache_write_with_no_cache_write_rate_is_unpriced_but_zero_tokens_are_fine(self):
        self.assertEqual(extract.cost({'gpt-6-astra': tokens(w=5)}, TABLE)[0], 'n/a')
        self.assertNotEqual(extract.cost({'gpt-6-astra': tokens(o=5)}, TABLE)[0], 'n/a')

    def test_a_malformed_table_is_refused_with_a_reason(self):
        def broken(**edit):
            table = json.loads(json.dumps(TABLE))
            table.update(edit)
            return table
        cases = {'not an object': 'prices must be an object', }
        self.assertEqual(extract.cost({}, 'cheap')[1], cases['not an object'])
        for table, fragment in ((broken(as_of='yesterday'), 'as_of'), (broken(as_of=None), 'as_of'), (broken(source=' '), 'source'),
                                (broken(per_mtok={}), 'per_mtok'), (broken(per_mtok={'m': {'input': 1}}), 'output'),
                                (broken(per_mtok={'m': {'input': 1, 'output': -2}}), 'non-negative'),
                                (broken(per_mtok={'m': {'input': 1, 'output': 2, 'cache': 3}}), 'keyed by'),
                                (broken(per_mtok={'m': {'input': '1', 'output': 2}}), 'non-negative')):
            value, note = extract.cost({'m': tokens(o=1)}, table)
            self.assertEqual(value, 'n/a')
            self.assertTrue(fragment in note, (fragment, note))


class RunsRow(unittest.TestCase):
    def summary(self, workers=0, turns=None, compactions=(0, 0)):
        return {'compactions': {'coordinator': compactions[0], 'workers': compactions[1]},
                'workers': {'transcripts': workers, 'turns': turns or {}}}

    def test_fields_the_extract_knows(self):
        row = extract.runs_row(self.summary(2, {'claude-sonnet-5-5': 14}, (1, 0)), None, 'subagent transcript(s)')
        self.assertEqual(row, {'compactions': 1, 'workers': '2 subagent transcript(s): claude-sonnet-5-5 x14'})

    def test_no_workers_and_worker_compactions(self):
        row = extract.runs_row(self.summary(0, None, (0, 2)), None, 'x')
        self.assertEqual((row['workers'], row['compactions']), ('none', '0 (+2 in workers)'))

    def test_approvals_only_when_there_was_a_daemon_log(self):
        permission = extract.permissions(at(1, 'INFO', 'ws', 'Permission request p: Bash') + '\n'
                                         + at(2, 'INFO', 'ws', 'Permission p resolved: allow') + '\n')
        row = extract.runs_row(self.summary(), permission, 'x')
        self.assertEqual(row['approvals'], '1 prompted: 0 human, 1 unattributed, 0 automatic (daemon log)')
        self.assertEqual(extract.runs_row(self.summary(), extract.permissions(''), 'x')['approvals'], '0 prompted (daemon log)')


if __name__ == '__main__':
    unittest.main()
