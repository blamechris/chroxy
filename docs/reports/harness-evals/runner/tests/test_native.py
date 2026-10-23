"""Transcript, rollout and daemon-log parsing, on synthetic files written by the tests."""
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from trialkit import native

CLONE = '/Users/x/trial/t2/A-cd-r1'
SINCE = datetime(2026, 11, 2, 11, 55, tzinfo=timezone.utc)


def jl(*entries):
    return '\n'.join(e if isinstance(e, str) else json.dumps(e) for e in entries) + '\n'


def assistant(model='claude-opus-5-5', effort=None, ts='2026-11-02T12:00:01Z', **extra):
    entry = {'type': 'assistant', 'timestamp': ts, 'message': {'model': model, 'role': 'assistant', 'content': []}}
    if effort is not None:
        entry['effort'] = effort
    entry.update(extra)
    return entry


def user(content, **extra):
    entry = {'type': 'user', 'message': {'role': 'user', 'content': content}}
    entry.update(extra)
    return entry


def tool_result(text, as_list=True):
    body = [{'type': 'text', 'text': text}] if as_list else text
    return user([{'type': 'tool_result', 'tool_use_id': 't1', 'content': body}])


PROBE_LINE = 'TRIAL-PROBE run=A-cd-r1 effort=high entrypoint=claude-desktop app=1.4.2 at=2026-11-02T12:00:05Z'
PROBE_CMD = ("printf 'TRIAL-PROBE run=%s effort=%s entrypoint=%s app=%s at=%s\\n' 'A-cd-r1' "
             "\"${CLAUDE_EFFORT:-unset}\" \"${CLAUDE_CODE_ENTRYPOINT:-unset}\"")


class TempDir(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='trialctl-native-')
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, *parts, text, mtime=None):
        path = os.path.join(self.tmp, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(text)
        stamp = (mtime or SINCE + timedelta(minutes=10)).timestamp()
        os.utime(path, (stamp, stamp))
        return path


class Slug(unittest.TestCase):
    def test_every_non_alphanumeric_becomes_a_dash(self):
        self.assertEqual(native.slug('/Users/x/trial/t2/A-cd-r1'), '-Users-x-trial-t2-A-cd-r1')
        self.assertEqual(native.slug('/a b/c_d.e'), '-a-b-c-d-e')

    def test_candidates_cover_a_symlinked_path_once(self):
        tmp = tempfile.mkdtemp(prefix='trialctl-slug-')
        self.addCleanup(shutil.rmtree, tmp, True)
        real = os.path.join(tmp, 'real')
        link = os.path.join(tmp, 'link')
        os.makedirs(real)
        os.symlink(real, link)
        self.assertEqual(len(native.slug_candidates(link)), 2)
        self.assertEqual(len(native.slug_candidates(real)), len(set(native.slug_candidates(real))))


class Probe(unittest.TestCase):
    def test_the_printed_line_parses(self):
        p = native.parse_probe(f'noise\n{PROBE_LINE}\nmore')
        self.assertEqual(p, {'run': 'A-cd-r1', 'effort': 'high', 'entrypoint': 'claude-desktop', 'app': '1.4.2',
                             'at': '2026-11-02T12:00:05Z'})

    def test_the_command_text_does_not_match(self):
        self.assertIsNone(native.parse_probe(PROBE_CMD))
        self.assertIsNone(native.parse_probe('TRIAL-PROBE run=%s effort=high entrypoint=x app=y at=2026-11-02T12:00:05Z'))

    def test_a_probe_with_an_unfilled_value_or_a_bad_time_does_not_match(self):
        self.assertIsNone(native.parse_probe('TRIAL-PROBE run=A-cd-r1 effort=%s entrypoint=x app=y at=2026-11-02T12:00:05Z'))
        self.assertIsNone(native.parse_probe('TRIAL-PROBE run=A-cd-r1 effort=high entrypoint=x app=y at=yesterday'))

    def test_unset_values_parse_and_several_lines_are_all_found(self):
        text = PROBE_LINE + '\n' + PROBE_LINE.replace('A-cd-r1', 'B-cx-r2').replace('effort=high', 'effort=unset')
        found = native.parse_probes(text)
        self.assertEqual([p['run'] for p in found], ['A-cd-r1', 'B-cx-r2'])
        self.assertEqual(found[1]['effort'], 'unset')


class ClaudeSummary(TempDir):
    def summarize(self, *entries):
        return native.claude_summary(self.write('t.jsonl', text=jl(*entries)))

    def test_collects_models_efforts_modes_and_entrypoints(self):
        s = self.summarize(
            user('Trial run A-cd-r1: follow x', permissionMode='auto', entrypoint='claude-desktop', version='2.1.308'),
            assistant(effort='high', entrypoint='claude-desktop', version='2.1.308'),
            assistant(model='<synthetic>', effort='high'),
            assistant(effort='high', ts='2026-11-02T12:00:09Z'),
            user([{'type': 'text', 'text': 'more'}], permissionMode='auto'))
        self.assertEqual(s['models'], ['claude-opus-5-5'])
        self.assertEqual(s['efforts'], ['high'])
        self.assertEqual(s['permission_modes'], ['auto'])
        self.assertEqual(s['entrypoints'], ['claude-desktop'])
        self.assertEqual(s['versions'], ['2.1.308'])
        self.assertEqual(s['assistant_entries'], 3)
        self.assertEqual(s['first_timestamp'], '2026-11-02T12:00:01Z')

    def test_a_second_model_or_effort_is_listed(self):
        s = self.summarize(assistant(model='claude-sonnet-5-5', effort='medium'), assistant(effort='high'))
        self.assertEqual(s['models'], ['claude-sonnet-5-5', 'claude-opus-5-5'])
        self.assertEqual(s['efforts'], ['medium', 'high'])

    def test_sidechain_entries_are_kept_apart(self):
        s = self.summarize(assistant(), assistant(model='claude-sonnet-5-5', effort='low', isSidechain=True))
        self.assertEqual(s['models'], ['claude-opus-5-5'])
        self.assertEqual(s['sidechain_models'], ['claude-sonnet-5-5'])
        self.assertEqual(s['efforts'], [])

    def test_older_versions_without_effort_leave_it_empty(self):
        self.assertEqual(self.summarize(assistant()) ['efforts'], [])

    def test_probe_is_read_from_tool_results_in_both_content_shapes(self):
        for as_list in (True, False):
            s = self.summarize(tool_result(PROBE_LINE, as_list))
            self.assertEqual([p['at'] for p in s['probes']], ['2026-11-02T12:00:05Z'], as_list)

    def test_the_probe_command_in_an_assistant_entry_is_not_a_probe(self):
        entry = assistant()
        entry['message']['content'] = [{'type': 'tool_use', 'name': 'Bash', 'input': {'command': PROBE_CMD}}]
        self.assertEqual(self.summarize(entry)['probes'], [])

    def test_interrupt_marker_in_user_prose(self):
        s = self.summarize(user('Trial run A-cd-r1: go'), user([{'type': 'text', 'text': '[Request interrupted by user]'}]))
        self.assertEqual(s['interrupts'], 1)
        self.assertEqual(self.summarize(tool_result('[Request interrupted by user]'))['interrupts'], 0)

    def test_malformed_lines_are_counted_and_skipped(self):
        path = self.write('m.jsonl', text=jl(assistant(effort='high'), '{"type": "assistant", "mess', 'not json', '[1, 2]'))
        s = native.claude_summary(path)
        self.assertEqual((s['models'], s['entries'], s['malformed']), (['claude-opus-5-5'], 1, 3))

    def test_a_missing_file_summarises_as_empty(self):
        s = native.claude_summary(os.path.join(self.tmp, 'absent.jsonl'))
        self.assertEqual((s['entries'], s['models']), (0, []))


class FindClaudeTranscript(TempDir):
    def setUp(self):
        super().setUp()
        self.projects = os.path.join(self.tmp, 'projects')
        self.folder = native.slug(CLONE)

    def put(self, name, run='A-cd-r1', mtime=None, folder=None, **extra):
        text = jl(user(f'/prime-directive "Trial run {run}: follow m.md exactly"', **extra))
        return self.write('projects', folder or self.folder, name, text=text, mtime=mtime)

    def test_finds_the_file_that_was_asked_for_this_run(self):
        path = self.put('s1.jsonl')
        self.assertEqual(native.find_claude_transcript(self.projects, CLONE, 'A-cd-r1', SINCE), path)

    def test_other_runs_old_files_subagents_and_other_folders_are_ignored(self):
        self.put('other.jsonl', run='A-cy-r1')
        self.put('old.jsonl', mtime=SINCE - timedelta(minutes=1))
        self.put('agent-9.jsonl')
        self.write('projects', self.folder, 'sess', 'subagents', 'agent-1.jsonl',
                   text=jl(user('Trial run A-cd-r1: nested')))
        self.put('elsewhere.jsonl', folder='-Users-x-chroxy')
        self.assertIsNone(native.find_claude_transcript(self.projects, CLONE, 'A-cd-r1', SINCE))

    def test_run_id_is_matched_whole(self):
        self.put('s1.jsonl', run='A-cd-r10')
        self.assertIsNone(native.find_claude_transcript(self.projects, CLONE, 'A-cd-r1', SINCE))
        self.assertIsNotNone(native.find_claude_transcript(self.projects, CLONE, 'A-cd-r10', SINCE))

    def test_tool_results_that_quote_the_run_do_not_count(self):
        text = jl(user('hello'), tool_result('Trial run A-cd-r1: follow'))
        self.write('projects', self.folder, 'quote.jsonl', text=text)
        self.assertIsNone(native.find_claude_transcript(self.projects, CLONE, 'A-cd-r1', SINCE))

    def test_newest_of_several_wins(self):
        self.put('a.jsonl', mtime=SINCE + timedelta(minutes=5))
        b = self.put('b.jsonl', mtime=SINCE + timedelta(minutes=9))
        self.assertEqual(native.find_claude_transcript(self.projects, CLONE, 'A-cd-r1', SINCE), b)


def meta(cwd=CLONE, source='cli', parent=None, ts='2026-11-02T12:00:00Z'):
    payload = {'cwd': cwd, 'cli_version': '0.163.0', 'originator': 'codex_cli_rs', 'source': source}
    if parent:
        payload['parent_thread_id'] = parent
    return {'timestamp': ts, 'type': 'session_meta', 'payload': payload}


def turn(model='gpt-6-astra', effort='xhigh', sandbox='workspace-write', approval='on-request'):
    return {'type': 'turn_context', 'payload': {'model': model, 'effort': effort, 'approval_policy': approval,
                                                'sandbox_policy': {'type': sandbox}}}


class Codex(TempDir):
    def rollout(self, *entries, name='rollout-2026-11-02T12-00-00-abc.jsonl', mtime=None):
        return self.write('sessions', '2026', '11', '02', name, text=jl(*entries), mtime=mtime)

    def test_finds_the_coordinator_rollout_for_the_clone_and_below(self):
        path = self.rollout(meta(), turn())
        self.assertEqual(native.find_codex_rollout(os.path.join(self.tmp, 'sessions'), CLONE, SINCE), path)
        self.rollout(meta(cwd=CLONE + '/packages/server'), name='rollout-b.jsonl')
        self.assertIsNotNone(native.find_codex_rollout(os.path.join(self.tmp, 'sessions'), CLONE, SINCE))

    def test_subagents_other_folders_and_old_files_are_ignored(self):
        self.rollout(meta(source={'subagent': {'thread_spawn': {}}}), name='rollout-sub.jsonl')
        self.rollout(meta(parent='parent-1'), name='rollout-child.jsonl')
        self.rollout(meta(cwd='/Users/x/chroxy'), name='rollout-other.jsonl')
        self.rollout(meta(cwd=CLONE + '-2'), name='rollout-sibling.jsonl')
        self.rollout(meta(), name='rollout-old.jsonl', mtime=SINCE - timedelta(hours=1))
        self.write('sessions', 'notes.jsonl', text=jl(meta()))
        self.assertIsNone(native.find_codex_rollout(os.path.join(self.tmp, 'sessions'), CLONE, SINCE))

    def test_summary(self):
        path = self.rollout(meta(), turn(), turn(effort='high'),
                            {'type': 'response_item', 'payload': {'output': PROBE_LINE.replace('A-cd-r1', 'B-cx-r1')}},
                            '{"truncated')
        s = native.codex_summary(path)
        self.assertEqual((s['models'], s['efforts'], s['sandboxes'], s['approval_policies']),
                         (['gpt-6-astra'], ['xhigh', 'high'], ['workspace-write'], ['on-request']))
        self.assertEqual((s['cli_version'], s['originator'], s['cwd']), ('0.163.0', 'codex_cli_rs', CLONE))
        self.assertEqual([p['run'] for p in s['probes']], ['B-cx-r1'])
        self.assertEqual((s['turns'], s['malformed']), (2, 1))

    def test_turn_aborted_is_an_interrupt(self):
        path = self.rollout(meta(), turn(), {'type': 'event_msg', 'payload': {'type': 'turn_aborted', 'reason': 'interrupted'}})
        self.assertEqual(native.codex_summary(path)['interrupts'], 1)

    def test_sandbox_policy_may_be_a_bare_string(self):
        entry = turn()
        entry['payload']['sandbox_policy'] = 'read-only'
        self.assertEqual(native.codex_summary(self.rollout(meta(), entry))['sandboxes'], ['read-only'])


class DaemonLog(unittest.TestCase):
    def text(self, *lines):
        return '\n'.join(lines) + '\n'

    def test_text_format_last_change_wins_and_other_sessions_are_ignored(self):
        log = self.text(
            '2026-11-02T11:50:00.100Z [INFO] [ws] Model change from c1 on session abc: sonnet',
            '2026-11-02T11:50:05.200Z [INFO] [ws] Model change from c1 on session abc: opus',
            '2026-11-02T11:50:06.000Z [INFO] [ws] Model change from c1 on session zzz: haiku',
            '2026-11-02T11:50:07.000Z [INFO] [ws] Permission mode change from c1 on session abc: default → auto at 2026-11-02T11:50:07.000Z',
            '2026-11-02T11:50:08.000Z [INFO] [ws] Interrupt from c1 to session zzz',
            '2026-11-02T11:50:09.000Z [INFO] [supervisor] Server ready')
        f = native.session_findings(log, 'abc')
        self.assertEqual(f['model'], ('opus', '2026-11-02T11:50:05.200Z'))
        self.assertEqual(f['mode'], ('auto', '2026-11-02T11:50:07.000Z'))
        self.assertEqual(f['interrupts'], [])

    def test_json_format(self):
        def rec(ts, msg):
            return json.dumps({'ts': ts, 'level': 'info', 'component': 'ws', 'msg': msg})
        log = self.text(rec('t1', 'Model change from c1 on session abc: gpt-6-astra'),
                        rec('t2', 'Permission mode change from c1 on session abc: auto → default at x'),
                        rec('t3', 'Interrupt from c1 to session abc'))
        f = native.session_findings(log, 'abc')
        self.assertEqual((f['model'], f['mode'], f['interrupts']), (('gpt-6-astra', 't1'), ('default', 't2'), ['t3']))

    def test_session_ids_match_whole_and_regex_characters_are_literal(self):
        log = self.text('t [INFO] [ws] Interrupt from c to session abc-2', 't [INFO] [ws] Model change from c on session abcd: opus')
        f = native.session_findings(log, 'abc')
        self.assertEqual((f['model'], f['interrupts']), (None, []))
        self.assertEqual(native.session_findings(self.text('t [INFO] [ws] Interrupt from c to session a.c'), 'abc')['interrupts'], [])

    def test_unparseable_lines_do_not_stop_the_scan(self):
        log = self.text('garbage', '{"not": "a log record"', '', 't [INFO] [ws] Interrupt from c1 to session abc')
        self.assertEqual(len(native.session_findings(log, 'abc')['interrupts']), 1)


if __name__ == '__main__':
    unittest.main()
