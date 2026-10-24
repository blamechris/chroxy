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


class ClaudeNamesAndReads(TempFiles):
    def summary(self, *entries, **kwargs):
        return extract.claude_summary([(self.write(*entries), 'coordinator')], self.scanner())

    def test_a_model_effort_or_mode_that_is_not_a_plain_name_is_recorded_as_other(self):
        odd = f'claude-opus-5-5 {SECRET} /Users/x/p'
        s = self.summary(assistant('m1', model=odd, effort=f'high {SECRET}', use=usage(o=3)),
                         assistant('m2', model='claude-opus-5-5\n', use=usage(o=1)),
                         assistant('m3', model='claude-opus-5-5', effort='high', use=usage(o=2)),
                         user('hi', permissionMode=f'auto {SECRET}'), user('again', permissionMode='plan'))
        self.assertEqual(s['coordinator']['turns'], {'<other>': 2, 'claude-opus-5-5': 1})
        self.assertEqual(s['coordinator']['efforts'], {'<other>': 1, 'high': 1})
        self.assertEqual(s['coordinator']['permission_modes'], ['<other>', 'plan'])
        self.assertEqual(sorted(s['tokens']['by_model']), ['<other>', 'claude-opus-5-5'])
        self.assertFalse(SECRET in json.dumps(s))

    def test_a_worker_model_that_is_not_a_plain_name_is_recorded_as_other(self):
        files = [(self.write(assistant('m1', use=usage(o=1))), 'coordinator'),
                 (self.write(assistant('w1', model='x' * 65, use=usage(o=1))), 'worker')]
        s = extract.claude_summary(files, self.scanner())
        self.assertEqual(s['workers']['turns'], {'<other>': 1})

    def test_the_synthetic_marker_is_still_not_a_turn(self):
        self.assertEqual(self.summary(assistant('m1', model='<synthetic>', use=usage(o=9)))['coordinator']['turns'], {})

    def test_a_model_is_a_known_familys_name_in_lower_case(self):
        for name in ('claude-opus-5-5', 'gpt-6-astra', 'claude-sonnet-4-5-20250929', 'gpt-5.1-codex', 'o3', 'o4-mini', 'o1-preview', 'o9',
                     'codex-mini-latest', 'gemini-2.5-pro', 'opus', 'sonnet', 'haiku', 'deepseek-chat', 'llama3.1-70b', 'qwen2.5-coder',
                     'mistral-large', 'claude-' + 'x' * 41, 'gpt-' + 'f' * 31):
            self.assertEqual(extract.safe_model(name), name)
        for name in ('/private/probe/value', 'https://example.com/x', 'anthropic:claude-opus', 'us.anthropic/claude-sonnet',
                     'Claude-Opus', 'claude opus', 'claude-opus\n', 'claude-' + 'x' * 42, 'x', '', '-opus', 'caf\u00e9', '<synthetic>',
                     'o0', 'o', 'gp', None, 7, ['x']):
            self.assertEqual(extract.safe_model(name), '<other>', repr(name))

    def test_a_model_that_is_a_host_a_file_or_not_a_family_is_other_however_plain(self):
        for name in ('internal.corp.example.com', 'secrets.env', 'localhost', 'my-model', 'prod-db-password', 'glpat-abc123def456',
                     'xapp-1-a0123', 'deepsea', 'cloud-opus', 'a' * 40):
            self.assertEqual(extract.safe_model(name), '<other>', name)

    def test_a_character_that_is_not_in_a_models_alphabet_is_refused_in_the_middle_of_a_family_name(self):
        for name in ('claude-Opus-5', 'gpt-5-Codex', 'claude/opus', 'claude:opus', 'claude_opus', 'claude\\opus', 'claude;opus', 'claude opus', 'gpt@5', 'gpt(5)', 'gpt-5\t'):
            self.assertEqual(extract.safe_model(name), '<other>', repr(name))

    def test_a_tool_is_a_letter_then_word_characters(self):
        for name in ('Bash', 'Edit', 'mcp__chroxy__list_files', 'NotebookEdit', 'Skill', 'T' * 48, 'f' * 31):
            self.assertEqual(extract.safe_tool(name), name)
        for name in ('unknown tool', 'mcp__my-server__tool', '/bin/sh', 'Bash(rm -rf /)', 'Bash\n', '1Bash', 'T' * 49, '', None):
            self.assertEqual(extract.safe_tool(name), '<other>', repr(name))

    def test_a_character_that_is_not_a_word_character_is_refused_inside_a_tool_name(self):
        for name in ('Bash/x', 'a:b', 'a.b', 'a\\b', 'a-b', 'a b', 'a;b', 'a$b', 'a@b', 'a=b', 'a\tb'):
            self.assertEqual(extract.safe_tool(name), '<other>', repr(name))

    def test_a_session_id_is_alphanumeric_with_hyphens(self):
        for name in ('s-1', '0a1b2c3d4e5f60718293a4b5c6d7e8f9', 'abandoned', '3f2a9c1e-77aa-4b5e-9d11-0c9a1b2c3d4e', 's' * 64):
            self.assertEqual(extract.safe_session(name), name)
        for name in ('/Users/x/s', 's 1', 's_1', 's-1\n', '-s', '', 'x' * 65, None):
            self.assertEqual(extract.safe_session(name), '<other>', repr(name))

    def test_a_character_that_is_not_alphanumeric_or_a_hyphen_is_refused_inside_a_session_id(self):
        for name in ('s/x', 's:1', 's.1', 's\\1', 's_1', 's 1', 's;1', 's@1', 's=1'):
            self.assertEqual(extract.safe_session(name), '<other>', repr(name))

    def test_nothing_that_starts_like_a_credential_passes_a_rule_it_would_otherwise_match(self):
        tools = ('ghp_ABCdef123456', 'gho_x1', 'ghs_x1', 'ghu_x1', 'ghr_x1', 'github_pat_11ABC', 'sk_live_abc123', 'sk_test_abc123',
                 'npm_abc123', 'hf_abc123', 'AIzaSyABC123', 'ASIAABCDEFGH', 'eyJhbGciOiJIUzI1NiJ9', 'xoxb', 'xoxp123',
                 'AKIAABCDEFGHIJKLMNOP', 'akiaabcdef')
        for name in tools:
            self.assertTrue(extract.TOOL_NAME.fullmatch(name), name)                # the pattern alone would let it through
            self.assertEqual(extract.safe_tool(name), '<other>', name)
        sessions = ('sk-proj-abc123def456', 'SK-PROJ-ABC', 'sk-ant-api03-xyz', 'glpat-abcdef123456', 'xapp-1-A0123', 'xoxb-123',
                    'AKIAABCDEFGHIJKLMNOP', 'ASIAABCDEFGH', 'AIzaSyABC123', 'eyJhbGciOiJIUzI1NiJ9', 'Eyj-upper')
        for name in sessions:
            self.assertTrue(extract.SESSION_ID.fullmatch(name), name)
            self.assertEqual(extract.safe_session(name), '<other>', name)
        self.assertEqual(extract.safe_tool('Skill'), 'Skill')       # `sk` alone is not the prefix `sk-` or `sk_`

    def test_a_run_of_hex_digits_as_long_as_a_token_is_refused_in_every_name_field(self):
        token = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'              # 40 hex digits
        self.assertEqual((extract.safe_tool(token), extract.safe_tool('f' * 32), extract.safe_tool('Bash' + 'f' * 32)), ('<other>',) * 3)
        self.assertEqual((extract.safe_model('claude-' + token), extract.safe_model('gpt-' + 'f' * 32), extract.safe_model('gpt-' + 'f' * 31)),
                         ('<other>', '<other>', 'gpt-' + 'f' * 31))
        self.assertEqual((extract.safe_session(token), extract.safe_session('f' * 33), extract.safe_session('s-' + token)), ('<other>',) * 3)
        self.assertEqual(extract.safe_tool('f' * 31), 'f' * 31)

    def test_a_session_ids_own_shape_is_kept(self):
        """The daemon makes them `randomBytes(16).toString('hex')`: 32 hex digits, which is why a session may hold 32."""
        self.assertTrue("randomBytes(16).toString('hex')" in read_source('session-manager.js'))
        for name in ('0123456789abcdef0123456789abcdef', 'f' * 32, 'A' * 8 + 'b1' * 12, '3f2a9c1e-77aa-4b5e-9d11-0c9a1b2c3d4e'):
            self.assertEqual(extract.safe_session(name), name)

    def test_a_field_with_known_values_takes_only_those(self):
        for value in ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'):
            self.assertEqual(extract.safe_enum(value, extract.EFFORTS), value)
        for value in ('HIGH', 'ultra', 'high ', '', None, 3, 'xhigh\n'):
            self.assertEqual(extract.safe_enum(value, extract.EFFORTS), '<other>', repr(value))
        self.assertEqual(sorted(extract.CLAUDE_MODES), ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'])
        self.assertEqual(sorted(extract.APPROVAL_POLICIES), ['never', 'on-failure', 'on-request', 'untrusted'])
        self.assertEqual(sorted(extract.SANDBOXES), ['danger-full-access', 'read-only', 'workspace-write'])

    def test_a_value_in_the_wrong_field_is_other(self):
        self.assertEqual((extract.safe_enum('workspace-write', extract.EFFORTS), extract.safe_enum('high', extract.SANDBOXES),
                          extract.safe_enum('allow', extract.CLAUDE_MODES)), ('<other>',) * 3)

    def test_the_decision_and_daemon_mode_sets_are_the_servers(self):
        source = read_source
        self.assertTrue("const validDecisions = ['allow', 'deny', 'allowAlways']" in source('ws-permissions.js'))
        self.assertEqual(sorted(extract.DECISIONS), ['allow', 'allowAlways', 'deny'])
        self.assertTrue("const MODE_IDS = ['approve', 'acceptEdits', 'auto', 'plan']" in source('handler-utils.js'))
        self.assertEqual(sorted(extract.DAEMON_MODES), ['acceptEdits', 'approve', 'auto', 'plan'])

    def test_a_path_shaped_model_reaches_neither_the_turns_nor_the_token_table(self):
        s = self.summary(assistant('m1', model='/private/probe/value', use=usage(o=3)), assistant('m2', model='sk-proj-abc123', use=usage(o=1)))
        self.assertEqual(s['coordinator']['turns'], {'<other>': 2})
        self.assertEqual(list(s['tokens']['by_model']), ['<other>'])
        self.assertFalse('probe' in json.dumps(s) or 'proj' in json.dumps(s))

    def test_lines_read_and_skipped_are_counted_per_file_and_in_total(self):
        good = self.write(assistant('m1', use=usage(o=1)), user('hi'))
        bad = os.path.join(self.tmp, 'bad.jsonl')
        with open(bad, 'w') as fh:
            fh.write(jl(user('a'), '{"type": "assist', '[1, 2]', 'null'))
        s = extract.claude_summary([(good, 'coordinator'), (bad, 'coordinator')], self.scanner())
        self.assertEqual(s['lines'], {'files': 2, 'read': 6, 'malformed': 3, 'unreadable_files': 0, 'unreliable_files': 1})

    def test_one_malformed_line_in_a_long_transcript_is_a_mid_write_tail_not_a_failure(self):
        path = os.path.join(self.tmp, 'long.jsonl')
        with open(path, 'w') as fh:
            fh.write(jl(*[user(f'm{i}') for i in range(200)]) + '{"type": "user", "message": {"con')
        s = extract.claude_summary([(path, 'coordinator')], self.scanner())
        self.assertEqual((s['lines']['malformed'], s['lines']['unreliable_files']), (1, 0))

    def test_a_valid_record_beside_a_truncated_remainder_is_not_a_clean_read(self):
        path = os.path.join(self.tmp, 'mixed.jsonl')
        with open(path, 'w') as fh:
            fh.write(jl(assistant('m1', use=usage(o=5), tools=[{'command': 'ls'}]), '{"type": "assist', '{"ty', '{', '[[['))
        s = extract.claude_summary([(path, 'coordinator')], self.scanner())
        self.assertEqual(s['tokens']['by_model']['claude-opus-5-5']['output'], 5)     # the valid record counted
        self.assertEqual(s['lines']['unreliable_files'], 1)                           # and the remainder is not hidden by it

    def test_the_threshold_is_more_than_five_lines_or_more_than_one_percent(self):
        def tally(lines, bad):
            t = native.Tally()
            t.lines, t.malformed = lines, bad
            return t.unreliable()
        self.assertEqual([tally(1000, 5), tally(1000, 6), tally(400, 4), tally(400, 5), tally(100, 1), tally(100, 2)],
                         [False, True, False, True, False, True])
        self.assertEqual([tally(1, 1), tally(0, 0), tally(3, 3)], [True, True, True],
                         'a file with no usable record at all is not a file that was read, however few lines it has')
        missing = native.Tally()
        list(native.entries(os.path.join(self.tmp, 'absent.jsonl'), missing))
        self.assertTrue(missing.unreadable and missing.unreliable())

    def test_a_pathologically_nested_line_is_a_malformed_line_not_a_crash(self):
        path = os.path.join(self.tmp, 'deep.jsonl')
        with open(path, 'w') as fh:
            fh.write(jl(user('hi'), '[' * 200000 + ']' * 200000, '{"a":' * 200000))
        s = extract.claude_summary([(path, 'coordinator')], self.scanner())
        self.assertEqual((s['lines']['read'], s['lines']['malformed']), (3, 2))

    def test_records_that_parse_but_lack_the_object_their_type_carries_are_unusable(self):
        wrong = [{'type': 'assistant', 'message': None}] * 100
        s = self.summary(assistant('m1', use=usage(o=2), tools=[{'command': 'ls'}]), user('hi'), *wrong)
        self.assertEqual((s['lines']['read'], s['lines']['malformed'], s['lines']['unreliable_files']), (102, 100, 1))
        self.assertEqual(s['tokens']['by_model']['claude-opus-5-5']['output'], 2)       # the valid ones still counted

    def test_each_known_type_needs_its_object_and_other_types_need_nothing(self):
        cases = {'assistant': 'message', 'user': 'message', 'session_meta': 'payload', 'turn_context': 'payload',
                 'event_msg': 'payload', 'response_item': 'payload'}
        for kind, key in cases.items():
            for bad in (None, 'text', ['x'], 7, True):
                tally = native.Tally()
                path = self.write({'type': kind, key: bad}, {'type': kind, key: {}})
                self.assertEqual(len(list(native.entries(path, tally))), 1, (kind, bad))
                self.assertEqual((tally.lines, tally.malformed), (2, 1), (kind, bad))
            tally = native.Tally()
            self.assertEqual(len(list(native.entries(self.write({'type': kind}), tally))), 0, kind)
        tally = native.Tally()
        free = [{'type': t} for t in ('system', 'summary', 'compacted', 'token_usage_record', 'queue-operation', 'something-new')]
        self.assertEqual(len(list(native.entries(self.write(*free), tally))), 6)
        self.assertEqual(tally.malformed, 0)

    def test_wrong_shaped_codex_records_beside_valid_ones_are_not_a_clean_read(self):
        path = self.write(meta(), turn(), counted(10, output=10), *[{'type': 'event_msg', 'payload': None}] * 50)
        s = extract.codex_summary([path], self.scanner())
        self.assertEqual((s['lines']['malformed'], s['lines']['unreliable_files']), (50, 1))
        self.assertEqual(s['tokens']['by_model']['gpt-6-astra']['output'], 10)

    def test_a_file_with_no_usable_record_is_unreliable_beside_a_valid_coordinator(self):
        good = self.write(user('hi'), assistant('m1', use=usage(o=1)))
        empty = os.path.join(self.tmp, 'agent-empty.jsonl')
        open(empty, 'w').close()
        blank = os.path.join(self.tmp, 'agent-blank.jsonl')
        with open(blank, 'w') as fh:
            fh.write('\n\n   \n')
        junk = os.path.join(self.tmp, 'agent-junk.jsonl')
        with open(junk, 'w') as fh:
            fh.write('{"x\n')
        for worker in (empty, blank, junk):
            s = extract.claude_summary([(good, 'coordinator'), (worker, 'worker')], self.scanner())
            self.assertEqual(s['lines']['unreliable_files'], 1, worker)

    def test_a_tool_input_with_a_lone_surrogate_is_hashed_not_a_crash(self):
        scanner = self.scanner()
        extract.claude_summary([(self.write(assistant('m1', use=usage(o=1), tools=[{'command': 'ls ~/.claude/projects/other\ud800'}])),
                                 'coordinator')], scanner)
        hit = scanner.report()['hits'][0]
        self.assertEqual((hit['pattern'], hit['count']), ('claude_projects_other', 1))
        json.dumps(scanner.report())

    def test_inputs_are_counted_once_each_and_only_if_they_hold_text(self):
        s = self.scanner()
        for value in ({'edits': [{'old': 'a', 'new': 'b'}], 'path': 'p'}, 'plain string', {'n': 3, 'flag': True}, None, {}, []):
            s.scan_input(value)
        self.assertEqual(s.report()['tool_inputs_scanned'], 2)      # not 4 strings, and the three without text not at all

    def test_a_renamed_input_field_reads_as_nothing_scanned_not_as_clean(self):
        entry = assistant('m1', use=usage(o=1))
        entry['message']['content'] = [{'type': 'tool_use', 'name': 'Bash', 'arguments': {'command': 'git log trial/a1-cd'}}]
        scanner = self.scanner()
        extract.claude_summary([(self.write(entry), 'coordinator')], scanner)
        self.assertEqual(scanner.report()['tool_inputs_scanned'], 0)


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
        s = self.summary([meta(), turn()], [meta(), turn(model='gpt-a'), turn(model='gpt-b'), counted(10, output=10)])
        self.assertEqual((s['tokens']['rollouts_without_usage'], s['tokens']['mixed_model_rollouts']), (1, 1))
        self.assertEqual(list(s['tokens']['by_model']), ['gpt-b'])

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

    def test_model_effort_policy_and_sandbox_that_are_not_plain_names_are_recorded_as_other(self):
        s = self.summary([meta(), turn(model=f'gpt {SECRET}', effort='x y', approval='on request', sandbox=f'/tmp/{SECRET} x'),
                          turn(), counted(10, output=10)])
        self.assertEqual(s['coordinator']['turns'], {'<other>': 1, 'gpt-6-astra': 1})
        self.assertEqual((s['coordinator']['efforts'], s['coordinator']['approval_policies'], s['coordinator']['sandboxes']),
                         ({'<other>': 1, 'xhigh': 1}, ['<other>', 'on-request'], ['<other>', 'workspace-write']))
        self.assertFalse(SECRET in json.dumps(s))

    def test_a_rollout_that_names_the_thread_it_was_forked_or_resumed_from_withholds_the_totals(self):
        for key in extract.FORK_KEYS:
            s = self.summary([meta(), turn(), counted(900, output=900)],
                             [dict(meta(), payload=dict(meta()['payload'], **{key: 'thread-1'})), turn(), counted(1500, output=600)])
            self.assertEqual((s['tokens']['by_model'], s['tokens']['forked_rollouts']), ({}, 1), key)
            self.assertTrue('withheld' in s['tokens']['unverified'], key)

    def test_the_fork_marker_may_sit_in_the_source(self):
        s = self.summary([meta(), turn(), counted(900, output=900)], [meta(source={'sub': {'forked_from_id': 'p'}}), turn(), counted(5, output=5)])
        self.assertEqual(s['tokens']['forked_rollouts'], 0)       # only the top level and `source` itself are read
        s = self.summary([meta(), turn(), counted(900, output=900)], [dict(meta(), payload=dict(meta()['payload'], source={'forked_from_id': 'p'})),
                                                                     turn(), counted(5, output=5)])
        self.assertEqual(s['tokens']['forked_rollouts'], 1)

    def test_an_empty_marker_is_not_a_fork(self):
        s = self.summary([meta(), turn(), counted(900, output=900)],
                         [dict(meta(), payload=dict(meta()['payload'], forked_from_id=None, resumed_from='')), turn(), counted(5, output=5)])
        self.assertEqual((s['tokens']['forked_rollouts'], sorted(s['tokens']['by_model'])), (0, ['gpt-6-astra']))
        self.assertFalse('unverified' in s['tokens'])

    def test_a_subagent_rollout_alone_is_not_a_fork_but_one_that_replays_its_parent_is(self):
        child = [meta(parent='p'), turn(model='gpt-6-lite')]
        s = self.summary([meta(), turn(), counted(900, input_tokens=600, output=300)], child + [counted(50, output=50)])
        self.assertFalse('unverified' in s['tokens'])
        self.assertEqual(s['tokens']['by_model']['gpt-6-lite']['output'], 50)
        # the child opens with the parent's cumulative record replayed, then carries on
        s = self.summary([meta(), turn(), counted(900, input_tokens=600, output=300)],
                         child + [counted(900, input_tokens=600, output=300), counted(1000, input_tokens=650, output=350)])
        self.assertEqual((s['tokens']['by_model'], s['tokens']['replayed_rollouts']), ({}, 1))
        self.assertTrue('totals withheld' in s['tokens']['unverified'])

    def test_the_same_record_twice_in_one_rollout_is_not_a_replay(self):
        record = {'type': 'token_usage_record', 'payload': {'thread_token_usage': {
            'input_tokens': 600, 'cached_input_tokens': 0, 'output_tokens': 300, 'total_tokens': 900}}}
        s = self.summary([meta(), turn(), counted(900, input_tokens=600, output=300), record])
        self.assertEqual((s['tokens']['replayed_rollouts'], 'unverified' in s['tokens']), (0, False))

    def test_a_stale_final_record_is_reported_beside_the_totals(self):
        s = self.summary([meta(), turn(), counted(2000, output=500), counted(1000, output=300)])
        self.assertEqual(s['tokens']['stale_final_rollouts'], 1)

    def test_codex_lines_are_tallied_per_rollout(self):
        path = os.path.join(self.tmp, 'bad-rollout.jsonl')
        with open(path, 'w') as fh:
            fh.write(jl(meta(), turn(), counted(10, output=10), '{"type": "event_msg', 'not json'))
        s = extract.codex_summary([path], self.scanner())
        self.assertEqual(s['lines'], {'files': 1, 'read': 5, 'malformed': 2, 'unreadable_files': 0, 'unreliable_files': 1})

    def test_a_call_whose_arguments_string_is_nested_too_deep_to_parse_is_scanned_as_text(self):
        deep = '[' * 200000 + 'trial/other-run' + ']' * 200000
        s = self.summary([meta(), turn(), call(arguments=deep), counted(10, output=10)])
        self.assertEqual(s['tokens']['by_model']['gpt-6-astra']['output'], 10)
        report = self.scan.report()
        self.assertEqual(report['tool_inputs_scanned'], 1)
        self.assertEqual([h['pattern'] for h in report['hits']], ['other_trial_branch'])

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


def http_pair(second, rid, decision, via='sdk'):
    """The two lines the server writes for ONE request answered over HTTP: the plain `resolved:` line (from the
    pending-permission callback, ws-permissions.js:481, or permission-manager.js:1115) and then the HTTP one
    (ws-permissions.js:790)."""
    return [at(second, 'INFO', 'ws', f'Permission {rid} resolved: {decision}'),
            at(second, 'INFO', 'ws', f'Permission {rid} resolved via HTTP: {decision} ({via})')]


class Permissions(unittest.TestCase):
    def count(self, *lines):
        return extract.permissions('\n'.join(lines) + '\n')

    def test_outcomes_are_counted_by_how_the_log_says_they_ended(self):
        p = self.count(
            at(1, 'INFO', 'ws', 'Permission request perm-a: Bash'),
            at(2, 'INFO', 'ws', 'Permission perm-a resolved: allow'),
            at(3, 'INFO', 'sdk-session', 'Permission request perm-b-1-1: Write', as_json=True),
            *http_pair(4, 'perm-b-1-1', 'deny'),
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
        self.assertEqual(p['unresolved_requests'], 0)           # perm-e: the switch allowed it
        self.assertEqual(p['auto_mode_switch_allowed'], 1)
        self.assertEqual(p['resolved'], {'allow': 1})
        self.assertEqual(p['resolved_by_http'], {'deny': 1})
        self.assertEqual((p['timed_out'], p['connection_closed'], p['late_responses'], p['floor_forced']), (1, 1, 1, 1))
        self.assertEqual(p['without_prompt'], {'rule_allow': 1, 'rule_deny': 1, 'cap_denied': 1,
                                               'auto_mode_switch_unmatched': 2, 'outcomes_without_request': 0})
        self.assertEqual(p['decided_by'], {'human': 1, 'automatic': 2, 'unattributed': 1})

    def test_a_request_answered_over_http_is_one_outcome_a_human_one(self):
        """The server logs `resolved: <decision>` and then `resolved via HTTP: <decision> (<via>)` for the same id."""
        p = self.count(at(1, 'INFO', 'ws', 'Permission request perm-a: Bash'), *http_pair(2, 'perm-a', 'allow'))
        self.assertEqual(p['decided_by'], {'human': 1, 'automatic': 0, 'unattributed': 0})
        self.assertEqual((p['resolved'], p['resolved_by_http']), ({}, {'allow': 1}))
        self.assertEqual(p['unresolved_requests'], 0)

    def test_the_http_line_decides_who_answered_whichever_comes_first(self):
        first = self.count(at(1, 'INFO', 'ws', 'Permission request p: Bash'), *http_pair(2, 'p', 'deny'))
        second = self.count(at(1, 'INFO', 'ws', 'Permission request p: Bash'), *reversed(http_pair(2, 'p', 'deny')))
        self.assertEqual(first['decided_by'], second['decided_by'])
        self.assertEqual(first['decided_by'], {'human': 1, 'automatic': 0, 'unattributed': 0})

    def test_every_request_has_exactly_one_outcome(self):
        lines = []
        for n in range(1, 13):
            lines.append(at(n, 'INFO', 'ws', f'Permission request p{n}: Bash'))
        lines += http_pair(20, 'p1', 'allow') + http_pair(21, 'p2', 'deny') + http_pair(22, 'p3', 'allowAlways')
        lines += [at(23, 'INFO', 'ws', 'Permission p4 resolved: allow'), at(24, 'INFO', 'ws', 'Permission p5 resolved: deny'),
                  at(25, 'INFO', 'ws', 'Permission p6 timed out, auto-denying'), at(26, 'INFO', 'ws', 'Permission p7 timed out, auto-denying'),
                  at(27, 'INFO', 'ws', 'Permission p8 connection closed by client'),
                  at(28, 'INFO', 'x', 'Auto-allowed 2 pending permission(s) on auto mode switch'),
                  at(29, 'INFO', 'x', 'Permission rule matched for Bash: allow'),
                  at(30, 'INFO', 'ws', 'Permission p4 resolved: allow'), at(31, 'INFO', 'ws', 'Permission p6 timed out, auto-denying')]
        p = self.count(*lines)
        by = p['decided_by']
        self.assertEqual(p['requests'], 12)
        self.assertEqual(by['human'] + by['unattributed'] + p['timed_out'] + p['connection_closed'] + p['auto_mode_switch_allowed']
                         + p['unresolved_requests'], p['requests'])
        self.assertEqual((by, p['unresolved_requests']), ({'human': 3, 'unattributed': 2, 'automatic': 4}, 2))

    def test_decided_by_never_exceeds_the_prompted_requests(self):
        p = self.count(at(1, 'INFO', 'ws', 'Permission request p1: Bash'),
                       *[at(n, 'INFO', 'x', 'Permission rule matched for Bash: allow') for n in range(2, 8)],
                       at(8, 'INFO', 'x', 'Pending-permission cap (2) reached — auto-denying perm-z'),
                       at(9, 'INFO', 'x', 'Auto-allowed 5 pending permission(s) on auto mode switch'))
        self.assertEqual(p['requests'], 1)
        self.assertTrue(sum(p['decided_by'].values()) <= p['requests'], p['decided_by'])
        self.assertEqual(p['decided_by'], {'human': 0, 'automatic': 1, 'unattributed': 0})
        self.assertEqual(p['without_prompt'], {'rule_allow': 6, 'rule_deny': 0, 'cap_denied': 1,
                                               'auto_mode_switch_unmatched': 4, 'outcomes_without_request': 0})

    def test_an_outcome_with_no_request_line_is_counted_apart(self):
        p = self.count(*http_pair(1, 'old', 'allow'), at(3, 'INFO', 'ws', 'Permission old2 timed out, auto-denying'))
        self.assertEqual((p['requests'], p['decided_by']), (0, {'human': 0, 'automatic': 0, 'unattributed': 0}))
        self.assertEqual(p['without_prompt']['outcomes_without_request'], 2)

    def test_a_request_logged_twice_is_one_request(self):
        p = self.count(at(1, 'INFO', 'ws', 'Permission request perm-a: Bash'), at(2, 'INFO', 'ws', 'Permission request perm-a: Bash'))
        self.assertEqual(p['requests'], 1)

    def test_unrelated_and_malformed_lines_are_ignored(self):
        p = self.count('garbage', '{"not": "a log', at(1, 'INFO', 'ws', 'Permission mode change from c1 on session s: default → auto at x'),
                       at(2, 'INFO', 'ws', 'MCP trust request perm-m: server'), at(3, 'INFO', 'ws', 'Question q timed out, auto-denying'))
        self.assertEqual((p['requests'], p['decided_by']), (0, {'human': 0, 'automatic': 0, 'unattributed': 0}))

    def test_permission_lines_this_reader_does_not_know_are_counted(self):
        p = self.count(at(1, 'INFO', 'ws', 'Permission request perm-a: Bash'), at(2, 'INFO', 'ws', 'Permission request'),
                       at(3, 'INFO', 'ws', 'Permission perm-a resolved maybe'), at(4, 'INFO', 'ws', 'permission request perm-b: Edit'),
                       at(5, 'INFO', 'ws', 'Permission perm-c got an answer: allow'), at(6, 'INFO', 'ws', 'Pending-permission count 7'),
                       at(7, 'INFO', 'ws', 'Permission rule matched for Bash: ask'))
        self.assertEqual(p['unrecognized_lines'], 6)

    def test_lines_that_open_like_a_permission_message_but_are_not_an_outcome_are_not_unknown(self):
        p = self.count(at(1, 'INFO', 'ws', 'Permission request perm-a: Bash'), at(2, 'DEBUG', 'ws', 'Permission floor clear for Bash'),
                       at(3, 'INFO', 'ws', 'Permission mode change from c1 on session s: approve → auto at x'),
                       at(4, 'INFO', 'ws', 'Permission mode changed to auto'), at(5, 'INFO', 'ws', 'Permission mode changed to plan, restarting process'),
                       at(6, 'INFO', 'ws', 'Permission rules updated by c1 on session s: 2 session rule(s)'),
                       at(7, 'WARN', 'ws', 'Permission audit sink threw: boom'),
                       at(8, 'DEBUG', 'ws', 'Permission perm-a released, but the deny response write failed (socket likely gone): EPIPE'),
                       at(9, 'WARN', 'ws', 'Rate limited POST /permission from 1.2.3.4'), at(10, 'INFO', 'ws', 'Loaded 3 persistent permission rule(s) across 1 project(s)'),
                       at(11, 'WARN', 'ws', 'permission-mode sidecar cleanup failed: EACCES'),
                       at(12, 'INFO', 'ws', 'Re-sending pending permission perm-a to reconnected client (4s remaining)'),
                       at(13, 'INFO', 'x', 'Auto-allowed 1 pending permission(s) on auto mode switch'))
        self.assertEqual(p['unrecognized_lines'], 0)

    def test_every_not_an_outcome_line_is_one_the_server_writes(self):
        for name, line in (('ws-permissions.js', "log.debug(`Permission floor clear for ${hookData.tool_name}`)"),
                           ('ws-permissions.js', "released, but the deny response write failed"),
                           ('cli-session.js', "info(`Permission mode changed to ${mode}, restarting process`)"),
                           ('sdk-session.js', "info(`Permission mode changed to ${mode}`)"),
                           ('claude-tui-session.js', "log.info(`Permission mode changed to ${mode} (sidecar updated, no PTY restart)`)"),
                           ('handlers/settings-handlers.js', "_pmLog.info(`Permission mode change from ${client.id} on session"),
                           ('handlers/settings-handlers.js', "info(`Permission rules updated by ${client.id} on session"),
                           ('permission-manager.js', "this._logWarn(`Permission audit sink threw: ${err?.message || err}`)")):
            self.assertTrue(line in read_source(name), f'{name} no longer holds {line!r}')

    def test_the_note_says_what_the_log_cannot_show(self):
        self.assertTrue('short-circuits' in extract.permissions('')['note'])

    def test_a_tool_or_decision_that_is_not_a_plain_name_is_recorded_as_other(self):
        odd = 'Bash /Users/x/secret-project --token=abc'
        p = self.count(at(1, 'INFO', 'ws', f'Permission request p1: {odd}'), at(2, 'INFO', 'ws', 'Permission p1 resolved: all\u00f6w'),
                       at(3, 'INFO', 'ws', 'Permission request p2: mcp__chroxy__list_files'),
                       *http_pair(4, 'p2', 'allow!'))
        self.assertEqual(p['requests_by_tool'], {'<other>': 1, 'mcp__chroxy__list_files': 1})
        self.assertEqual((p['resolved'], p['resolved_by_http']), ({'<other>': 1}, {'<other>': 1}))
        self.assertFalse('secret-project' in json.dumps(p))


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

    def test_no_tokens_at_all_is_not_a_zero_dollar_bill(self):
        self.assertEqual(extract.cost({}, TABLE), ('n/a', 'no token totals to price'))

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

    def test_approvals_name_what_was_decided_with_no_prompt_apart_from_the_prompted_ones(self):
        permission = extract.permissions('\n'.join([
            at(1, 'INFO', 'ws', 'Permission request p: Bash'), *http_pair(2, 'p', 'allow'),
            at(3, 'INFO', 'x', 'Permission rule matched for Bash: allow'), at(4, 'INFO', 'x', 'Permission rule matched for Bash: allow')]) + '\n')
        self.assertEqual(extract.runs_row(self.summary(), permission, 'x')['approvals'],
                         '1 prompted: 1 human, 0 unattributed, 0 automatic; 2 decided with no prompt (daemon log)')

    def test_approvals_only_when_there_was_a_daemon_log(self):
        permission = extract.permissions(at(1, 'INFO', 'ws', 'Permission request p: Bash') + '\n'
                                         + at(2, 'INFO', 'ws', 'Permission p resolved: allow') + '\n')
        row = extract.runs_row(self.summary(), permission, 'x')
        self.assertEqual(row['approvals'], '1 prompted: 0 human, 1 unattributed, 0 automatic (daemon log)')
        self.assertEqual(extract.runs_row(self.summary(), extract.permissions(''), 'x')['approvals'], '0 prompted (daemon log)')


if __name__ == '__main__':
    unittest.main()
