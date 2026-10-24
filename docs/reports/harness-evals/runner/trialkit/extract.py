"""Aggregates from a run's native evidence: what the harness did, never what it said.

`trialctl evidence` copies a run's raw transcripts to the vault; this module reads
those copies and returns the numbers a report needs. The result is committed to
the public repository, so it holds counts, model names, short identifiers and
hashes only: no message text, tool output, command line or file content, and a
path or name that must not be public (another run's branch, the key folder) is
reported as a pattern name, a count and a SHA-256 of the matched string.

Everything here is a pure function over files or text, tolerant of malformed
lines (a transcript copied mid-write can end mid-line). Shapes are those
`native.py` documents; the ones it does not (usage, compaction, user-message
and tool-call records) are noted where they are read.
"""
import hashlib
import json
import os
import re
from collections import Counter
from datetime import date

from . import native, timeutil

SCHEMA = 1
TOKEN_FIELDS = ('input', 'output', 'cache_read', 'cache_write')
# Claude Code's usage keys -> ours. `cache_creation_input_tokens` is the cache write.
CLAUDE_USAGE = {'input_tokens': 'input', 'output_tokens': 'output',
                'cache_read_input_tokens': 'cache_read', 'cache_creation_input_tokens': 'cache_write'}
# User-role entries the harness writes that no person typed: background-task results, injected reminders and
# the output of local commands. (`isMeta` and `isCompactSummary` entries are excluded by flag.)
MACHINE_PROSE = ('<task-notification>', '<system-reminder>', '<local-command-stdout>',
                 '<local-command-stderr>', '<local-command-caveat>')
MAX_TOOLS = 40
MAX_HASHES = 50
# A name that reaches the public extract or the terminal is checked by the rule of its own field, and is recorded
# as OTHER when it fails it. A field with a known set of values takes only those; a model or tool name takes only a
# plain identifier (no path, URL or `:` can pass); and nothing that starts like a credential passes any rule.
# `fullmatch`, because `$` also matches before a trailing newline.
OTHER = '<other>'
EFFORTS = frozenset(('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'))
CLAUDE_MODES = frozenset(('default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk'))
# the daemon's own mode ids (packages/server/src/handler-utils.js, MODE_IDS), which its log names
DAEMON_MODES = frozenset(('approve', 'acceptEdits', 'auto', 'plan'))
APPROVAL_POLICIES = frozenset(('never', 'on-request', 'on-failure', 'untrusted'))
SANDBOXES = frozenset(('read-only', 'workspace-write', 'danger-full-access'))
# packages/server/src/ws-permissions.js, `validDecisions`
DECISIONS = frozenset(('allow', 'deny', 'allowAlways'))
# a model is a known family's name, then lower-case letters, digits and `-`, with a `.` only between two digits
# (`gpt-5.1-codex`, `gemini-2.5-pro`), 2 to 48 characters in all: a hostname or a file name is not one, even one
# that starts with a family's name (`claude.ai`, `codex.auth.json`)
MODEL_NAME = re.compile(r'(?=[a-z0-9.-]{2,48}\Z)(?:claude|gpt|codex|gemini|opus|sonnet|haiku|deepseek|llama|qwen|mistral|o[1-9])'
                        r'(?:[a-z0-9-]|(?<=[0-9])\.(?=[0-9]))*')
TOOL_NAME = re.compile(r'[A-Za-z][A-Za-z0-9_]{0,47}')
SESSION_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,63}')
# what a credential starts with, compared lower-cased: GitHub, OpenAI/Anthropic/Stripe, Slack, AWS, Google, npm, Hugging
# Face, GitLab, and the `eyJ` of a JWT
SECRET_PREFIXES = ('ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_', 'github_pat_', 'sk-', 'sk_', 'xox', 'xapp-', 'akia', 'asia',
                   'aiza', 'npm_', 'hf_', 'glpat-', 'eyj')
# ...and a run of hex digits as long as a token's: 32 for a model or tool name; a session id IS 32 hex digits
# (`randomBytes(16).toString('hex')`, session-manager.js), so only a longer run is a token there
HEX_RUN = re.compile(r'[0-9a-fA-F]{32,}')
SESSION_HEX_RUN = re.compile(r'[0-9a-fA-F]{33,}')


# -- small helpers ---------------------------------------------------------------

def _int(value):
    return value if type(value) is int and value >= 0 else 0


def _empty_tokens():
    return dict.fromkeys(TOKEN_FIELDS, 0)


def _add_tokens(table, model, usage):
    row = table.setdefault(model, _empty_tokens())
    for field in TOKEN_FIELDS:
        row[field] += usage[field]


def _plain(value, pattern, hex_run=HEX_RUN):
    """`value` if it is a string that fully matches `pattern`, does not start like a credential and holds no run of hex
    digits long enough to be one, else OTHER."""
    if (isinstance(value, str) and pattern.fullmatch(value) and not value.lower().startswith(SECRET_PREFIXES)
            and not hex_run.search(value)):
        return value
    return OTHER


def safe_enum(value, allowed):
    """`value` if it is one of the `allowed` values of its field, else OTHER."""
    return value if isinstance(value, str) and value in allowed else OTHER


def safe_model(value):
    return _plain(value, MODEL_NAME)


def safe_tool(value):
    return _plain(value, TOOL_NAME)


def safe_session(value):
    return _plain(value, SESSION_ID, SESSION_HEX_RUN)


def _sorted_counts(counter):
    return {key: counter[key] for key in sorted(counter)}


def _strings(value, depth=0):
    """Every string inside a JSON value (a tool call's input)."""
    if isinstance(value, str):
        yield value
    elif depth < 24 and isinstance(value, dict):
        for item in value.values():
            yield from _strings(item, depth + 1)
    elif depth < 24 and isinstance(value, list):
        for item in value:
            yield from _strings(item, depth + 1)


def _stamp_of(path, limit=40):
    """The first timestamp in a transcript, to put several of them in the order they began."""
    for index, raw in enumerate(native._lines(path)):
        if index >= limit:
            break
        entry = native._loads(raw)
        if not entry:
            continue
        stamp = entry.get('timestamp')
        if isinstance(stamp, str):
            return stamp
        payload = entry.get('payload')
        if isinstance(payload, dict) and isinstance(payload.get('timestamp'), str):
            return payload['timestamp']
    return ''


def sha256_text(text):
    # `surrogatepass`: a lone surrogate in a tool input (a JSON `\ud800`) is hashed, not an exception
    return hashlib.sha256(text.encode('utf-8', 'surrogatepass')).hexdigest()


# -- isolation patterns -------------------------------------------------------------

# A branch ref: `trial/<name>`, optionally behind `origin/`, `refs/heads/`, `refs/remotes/<remote>/`. It must not
# sit inside a longer path, or `docs/reports/harness-evals/trial/data` (a directory) would read as a branch.
BRANCH = re.compile(r'(?<![\w\-/])(?:(?:refs/)?(?:heads|remotes/[\w.\-]+)/|(?:origin|upstream)/)?'
                    r'(trial/[a-z0-9][a-z0-9._-]*(?:/[a-z0-9._-]+)*)')
FILE_EXT = re.compile(r'\.(?:md|json|js|ts|tsx|py|sh|ya?ml|txt|toml|enc)$')
# what sits under docs/reports/harness-evals/trial*/: `trial/data` there is a directory, not a branch
TRIAL_DIRS = ('data', 'scripts', 'graders', 'handoffs', 'missions', 'runs', 'mailbox')
KEY_FILE = re.compile(r'(?<![\w.-])KEY\.md(?:\.enc)?(?![\w-])')
NEXT_SEED = re.compile(r'(?<![\w.-])NEXT-[A-Za-z0-9][\w.\-]*\.md\b')
CLAUDE_STORE = re.compile(r'\.claude/projects(?:/([^/\s\'"\\]+))?')
CODEX_STORE = re.compile(r'\.codex/(?:archived_)?sessions\b')


class Isolation:
    """Scans tool inputs for the places a run must not look, keeping only a pattern name, a count and hashes.

    `own_base` is the run's own base branch; `key_folder` the sealed key's folder; `own_slugs` the names Claude
    Code gives the run's clone under `~/.claude/projects/`."""

    def __init__(self, own_base, key_folder=None, own_slugs=()):
        self.own_base = own_base
        self.own_slugs = tuple(own_slugs)
        name = os.path.basename((key_folder or '').rstrip('/'))
        self.key_name = re.compile(r'(?<![\w-])' + re.escape(name) + r'(?![\w-])') if name else None
        self.scanned = 0
        self.hits = {}

    @property
    def patterns(self):
        names = ['other_trial_branch', 'key_file', 'next_seed', 'claude_projects_other', 'codex_sessions']
        if self.key_name:
            names.insert(1, 'key_folder')
        return names

    def _hit(self, name, matched):
        self.hits.setdefault(name, Counter())[matched] += 1

    def _own_slug(self, folder):
        for slug in self.own_slugs:
            if folder.startswith(slug) and not re.match(r'[A-Za-z0-9-]', folder[len(slug):len(slug) + 1] or ' '):
                return True
        return False

    def scan_input(self, value):
        """Scan one tool input (a string, or JSON holding strings). It counts once, however many strings it holds,
        and only if it holds one: a field that was renamed reads as no input, not as an input with nothing in it."""
        found = False
        for text in _strings(value):
            found = True
            self._scan_text(text)
        self.scanned += found

    scan = scan_input

    def _scan_text(self, text):
        for match in BRANCH.finditer(text):
            branch = match.group(1).rstrip('.')
            if branch == self.own_base or FILE_EXT.search(branch) or branch.split('/')[1] in TRIAL_DIRS:
                continue
            self._hit('other_trial_branch', branch)
        if self.key_name:
            for match in self.key_name.finditer(text):
                self._hit('key_folder', match.group(0))
        for match in KEY_FILE.finditer(text):
            self._hit('key_file', match.group(0))
        for match in NEXT_SEED.finditer(text):
            self._hit('next_seed', match.group(0))
        for match in CLAUDE_STORE.finditer(text):
            if match.group(1) is None or not self._own_slug(match.group(1)):
                self._hit('claude_projects_other', match.group(0))
        for match in CODEX_STORE.finditer(text):
            self._hit('codex_sessions', match.group(0))

    def report(self):
        hits = []
        for name in self.patterns:
            seen = self.hits.get(name)
            if not seen:
                continue
            hashes = sorted(sha256_text(matched) for matched in seen)
            hits.append({'pattern': name, 'count': sum(seen.values()), 'distinct': len(hashes),
                         'sha256': hashes[:MAX_HASHES]})
        return {'tool_inputs_scanned': self.scanned, 'patterns_checked': self.patterns, 'hits': hits}


# -- Claude Code ---------------------------------------------------------------------

def claude_role(rel):
    """'coordinator' for a top-level session transcript, 'worker' for a subagent's, else None.

    `rel` is the path below the clone's project folder. Subagents live in `<session>/subagents/agent-*.jsonl`
    (older versions: `agent-*.jsonl` beside the session)."""
    parts = rel.replace(os.sep, '/').split('/')
    if not parts[-1].endswith('.jsonl'):
        return None
    if parts[-1].startswith('agent-') or 'subagents' in parts[:-1]:
        return 'worker'
    return 'coordinator' if len(parts) == 1 else None


def _claude_human(entry):
    """True for a user entry a person typed: not a tool result, a summary or a machine notice (an interrupt is
    told apart before this is asked)."""
    if entry.get('type') != 'user' or entry.get('isSidechain') or entry.get('isMeta') or entry.get('isCompactSummary'):
        return False
    prose, _results = native._user_parts(entry)
    message = entry.get('message')
    content = message.get('content') if isinstance(message, dict) else None
    has_image = isinstance(content, list) and any(isinstance(b, dict) and b.get('type') == 'image' for b in content)
    text = '\n'.join(prose).strip()
    if not text and not has_image:
        return False
    return not text.startswith(MACHINE_PROSE)


def claude_summary(files, scanner):
    """Aggregates over Claude Code transcripts. `files` is a list of (path, role), role 'coordinator' or 'worker'.

    Turns are distinct assistant `message.id`s (Claude Code writes one entry per content block). Token usage is
    deduplicated by message id too, taking the largest value of each field, because an early block of a streamed
    message can carry a partial output count. People, interrupts and compactions are counted once per entry
    `uuid`, so a resumed session that replays history does not count it twice."""
    turns = {'coordinator': Counter(), 'workers': Counter()}
    efforts, modes = Counter(), []
    messages = {}      # message id -> [role, model, usage], from the first file it appears in
    anonymous = []     # (role, model, usage) for entries with no message id
    seen_uuid, seen_turn = set(), set()
    people = {'total': 0, 'interrupts': 0, 'compactions': {'coordinator': 0, 'workers': 0}}
    ordered = sorted((f for f in files if f[1] == 'coordinator'), key=lambda f: (_stamp_of(f[0]), f[0]))
    ordered += sorted((f for f in files if f[1] != 'coordinator'), key=lambda f: f[0])
    reads = []
    for path, file_role in ordered:
        reads.append(native.Tally())
        for entry in native.entries(path, reads[-1]):
            role = 'workers' if file_role == 'worker' or entry.get('isSidechain') else 'coordinator'
            kind = entry.get('type')
            if kind == 'assistant':
                _claude_assistant(entry, role, turns, efforts, messages, anonymous, seen_turn, scanner)
            elif kind == 'system' and entry.get('subtype') == 'compact_boundary':
                if _first_time(entry, seen_uuid):
                    people['compactions'][role] += 1
            elif role == 'coordinator' and kind == 'user':
                mode = entry.get('permissionMode')
                if isinstance(mode, str) and safe_enum(mode, CLAUDE_MODES) not in modes:
                    modes.append(safe_enum(mode, CLAUDE_MODES))
                prose, _results = native._user_parts(entry)
                if any(text.lstrip().startswith(native.INTERRUPT_MARK) for text in prose):
                    if _first_time(entry, seen_uuid):
                        people['interrupts'] += 1
                elif _claude_human(entry) and _first_time(entry, seen_uuid):
                    people['total'] += 1
    tokens = {'coordinator': {}, 'workers': {}}
    for role, model, usage in messages.values():
        _add_tokens(tokens[role], model, usage)
    for role, model, usage in anonymous:
        _add_tokens(tokens[role], model, usage)
    return {
        'turn_unit': 'assistant response (distinct message id)',
        'coordinator': {'transcripts': sum(1 for f in files if f[1] == 'coordinator'),
                        'turns': _sorted_counts(turns['coordinator']), 'efforts': _sorted_counts(efforts),
                        'permission_modes': modes},
        'workers': {'transcripts': sum(1 for f in files if f[1] == 'worker'), 'turns': _sorted_counts(turns['workers'])},
        'tokens': _token_report(tokens, len(anonymous)),
        'human_messages_total': people['total'],
        'human_messages_after_first': max(people['total'] - 1, 0),
        'interrupts': people['interrupts'],
        'compactions': people['compactions'],
        'lines': line_report(reads),
    }


def line_report(reads):
    """What reading the files saw, from their `native.Tally` objects: counts only. A file with too many skipped
    lines (or none readable) is `unreliable`: a count taken from it may be far short."""
    return {'files': len(reads), 'read': sum(t.lines for t in reads), 'malformed': sum(t.malformed for t in reads),
            'unreadable_files': sum(1 for t in reads if t.unreadable),
            'unreliable_files': sum(1 for t in reads if t.unreliable())}


def _first_time(entry, seen):
    uuid = entry.get('uuid')
    if not isinstance(uuid, str):
        return True
    if uuid in seen:
        return False
    seen.add(uuid)
    return True


def _claude_assistant(entry, role, turns, efforts, messages, anonymous, seen_turn, scanner):
    message = entry.get('message')
    if not isinstance(message, dict):
        return
    model = message.get('model')
    content = message.get('content')
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get('type') == 'tool_use':
                scanner.scan_input(block.get('input'))
    if not isinstance(model, str) or model == '<synthetic>':
        return
    model = safe_model(model)
    mid = message.get('id') if isinstance(message.get('id'), str) else None
    if mid is None or mid not in seen_turn:
        if mid is not None:
            seen_turn.add(mid)
        turns[role][model] += 1
        if role == 'coordinator' and isinstance(entry.get('effort'), str):
            efforts[safe_enum(entry['effort'], EFFORTS)] += 1
    usage = message.get('usage')
    if not isinstance(usage, dict):
        return
    fresh = {ours: _int(usage.get(theirs)) for theirs, ours in CLAUDE_USAGE.items()}
    if mid is None:
        anonymous.append((role, model, fresh))
        return
    previous = messages.get(mid)
    if previous is not None:
        fresh = {f: max(fresh[f], previous[2][f]) for f in TOKEN_FIELDS}
        role, model = previous[0], previous[1]
    messages[mid] = [role, model, fresh]


def _token_report(by_role, anonymous=0):
    total = {}
    for table in by_role.values():
        for model, row in table.items():
            _add_tokens(total, model, row)
    return {'by_model': {m: total[m] for m in sorted(total)},
            'by_role': {role: {m: table[m] for m in sorted(table)} for role, table in by_role.items()},
            'messages_without_id': anonymous}


# -- Codex ---------------------------------------------------------------------------

CODEX_CALLS = ('function_call', 'custom_tool_call', 'local_shell_call')


def _codex_usage(info):
    """Our token fields from a Codex `TokenUsage`. Its `input_tokens` already includes the cached part and its
    `output_tokens` the reasoning part, so the uncached input is the difference and nothing is added twice."""
    if not isinstance(info, dict):
        return None
    cached = _int(info.get('cached_input_tokens'))
    return {'input': max(_int(info.get('input_tokens')) - cached, 0), 'output': _int(info.get('output_tokens')),
            'cache_read': cached, 'cache_write': 0}, _int(info.get('total_tokens'))


def _codex_snapshots(entry):
    """Cumulative usage records in one rollout line: `event_msg.token_count` (`info.total_token_usage`) and the
    `token_usage_record` line (`thread_token_usage`). Both are running totals for the thread."""
    payload = entry.get('payload') if isinstance(entry.get('payload'), dict) else {}
    if entry.get('type') == 'event_msg' and payload.get('type') == 'token_count':
        info = payload.get('info')
        found = _codex_usage(info.get('total_token_usage')) if isinstance(info, dict) else None
        return ('token_count', found) if found else None
    if entry.get('type') == 'token_usage_record':
        found = _codex_usage(payload.get('thread_token_usage') or entry.get('thread_token_usage'))
        return ('token_usage_record', found) if found else None
    return None


def _codex_calls(entry, scanner):
    payload = entry.get('payload') if isinstance(entry.get('payload'), dict) else {}
    if entry.get('type') != 'response_item' or payload.get('type') not in CODEX_CALLS:
        return
    values = []
    for field in ('arguments', 'input', 'action'):
        value = payload.get(field)
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except (ValueError, RecursionError):
                pass
        values.append(value)
    scanner.scan_input(values)   # one call is one input, whichever of its fields carry the text


# `session_meta` keys that say a rollout continues, or was copied from, another thread. A rollout like that can
# open with the parent's cumulative usage records replayed, which a sum over rollouts would then count twice.
FORK_KEYS = ('forked_from', 'forked_from_id', 'resumed_from')


def _forked(meta):
    """True when a `session_meta` payload names the thread it was forked or resumed from (at the top, or in `source`)."""
    for holder in (meta, meta.get('source')):
        if isinstance(holder, dict) and any(holder.get(key) for key in FORK_KEYS):
            return True
    return False


def _codex_rollout(path, scanner):
    """One rollout's contribution: turns, settings, the cumulative-usage maximum and the people-events.

    `records` is the set of cumulative usage records it holds: the same record in two rollouts is a replay."""
    r = {'turns': Counter(), 'efforts': Counter(), 'policies': [], 'sandboxes': [], 'models': [],
         'best': None, 'last': None, 'source': None, 'messages': 0, 'interrupts': 0,
         'compacted': 0, 'compaction_items': 0, 'context_compacted': 0,
         'forked': False, 'records': set(), 'tally': native.Tally()}
    met = False
    for entry in native.entries(path, r['tally']):
        _codex_calls(entry, scanner)
        payload = entry.get('payload') if isinstance(entry.get('payload'), dict) else {}
        kind = entry.get('type')
        if kind == 'session_meta' and not met:
            met = True
            r['forked'] = _forked(payload)
        elif kind == 'turn_context':
            model = payload.get('model')
            if isinstance(model, str):
                model = safe_model(model)
                r['turns'][model] += 1
                if model not in r['models']:
                    r['models'].append(model)
            if isinstance(payload.get('effort'), str):
                r['efforts'][safe_enum(payload['effort'], EFFORTS)] += 1
            if isinstance(payload.get('approval_policy'), str) and safe_enum(payload['approval_policy'], APPROVAL_POLICIES) not in r['policies']:
                r['policies'].append(safe_enum(payload['approval_policy'], APPROVAL_POLICIES))
            sandbox = payload.get('sandbox_policy')
            sandbox = sandbox.get('type') if isinstance(sandbox, dict) else sandbox
            if isinstance(sandbox, str) and safe_enum(sandbox, SANDBOXES) not in r['sandboxes']:
                r['sandboxes'].append(safe_enum(sandbox, SANDBOXES))
        elif kind == 'compacted':
            r['compacted'] += 1
        elif kind == 'response_item' and payload.get('type') == 'compaction':
            r['compaction_items'] += 1
        elif kind == 'event_msg':
            sub = payload.get('type')
            if sub == 'user_message':
                r['messages'] += 1
            elif sub == 'turn_aborted':
                r['interrupts'] += 1
            elif sub == 'context_compacted':
                r['context_compacted'] += 1
        snap = _codex_snapshots(entry)
        if snap:
            source, (usage, total) = snap
            if total or any(usage.values()):
                r['records'].add((tuple(usage[f] for f in TOKEN_FIELDS), total))
            r['last'] = total
            if r['best'] is None or total >= r['best'][1]:
                r['best'], r['source'] = (usage, total), source
    return r


def codex_summary(paths, scanner):
    """Aggregates over Codex rollouts (coordinator and subagents).

    The token total of a rollout is the largest cumulative usage record it holds, not the last one: the final
    `token_count` of a rollout can be stale, below an earlier record (the October review found ten of 14
    roots so), and `stale_final_rollouts` counts the rollouts where it was. A rollout that used several models
    is priced at the last one and counted in `mixed_model_rollouts`."""
    roles = {'coordinator': [], 'workers': []}
    for path in paths:
        meta = native._codex_meta(path)
        roles['coordinator' if meta and native.is_coordinator(meta) else 'workers'].append(path)
    roles['coordinator'].sort(key=lambda p: (_stamp_of(p), p))
    turns = {'coordinator': Counter(), 'workers': Counter()}
    efforts, policies, sandboxes = Counter(), [], []
    tokens = {'coordinator': {}, 'workers': {}}
    totals = {'messages': 0, 'interrupts': 0}
    compactions = {'coordinator': 0, 'workers': 0}
    stale = mixed = without_usage = forked = replayed = 0
    sources, owners, reads = Counter(), {}, []
    for role, listed in roles.items():
        for path in listed:
            r = _codex_rollout(path, scanner)
            reads.append(r['tally'])
            forked += r['forked']
            # a record already seen in another rollout was replayed into this one (or the other way round)
            replayed += any([owners.setdefault(rec, path) != path for rec in r['records']])
            turns[role].update(r['turns'])
            compactions[role] += max(r['compacted'], r['compaction_items'], r['context_compacted'])
            if role == 'coordinator':
                efforts.update(r['efforts'])
                totals['messages'] += r['messages']
                totals['interrupts'] += r['interrupts']
                for value, bucket in ((r['policies'], policies), (r['sandboxes'], sandboxes)):
                    bucket.extend(v for v in value if v not in bucket)
            if r['best'] is None or not r['models']:
                without_usage += 1
                continue
            sources[r['source']] += 1
            mixed += len(r['models']) > 1
            stale += r['last'] is not None and r['last'] < r['best'][1]
            _add_tokens(tokens[role], r['models'][-1], r['best'][0])
    report = _token_report(tokens)
    report.update({'rollouts_without_usage': without_usage, 'stale_final_rollouts': stale,
                   'mixed_model_rollouts': mixed, 'sources': _sorted_counts(sources),
                   'forked_rollouts': forked, 'replayed_rollouts': replayed})
    if forked or replayed:
        # a sum over rollouts that replay one another's records counts them twice, and the part that does is not
        # known: no total is better than a wrong one (the vault copy holds the records to work it out by hand)
        report.update({'by_model': {}, 'by_role': {'coordinator': {}, 'workers': {}},
                       'unverified': f'{forked} forked or resumed rollout(s), {replayed} sharing usage records '
                                     f'with another rollout: totals withheld'})
    return {
        'turn_unit': 'turn_context entry (one per turn)',
        'coordinator': {'transcripts': len(roles['coordinator']), 'turns': _sorted_counts(turns['coordinator']),
                        'efforts': _sorted_counts(efforts), 'approval_policies': policies, 'sandboxes': sandboxes},
        'workers': {'transcripts': len(roles['workers']), 'turns': _sorted_counts(turns['workers'])},
        'tokens': report,
        'human_messages_total': totals['messages'],
        'human_messages_after_first': max(totals['messages'] - 1, 0),
        'interrupts': totals['interrupts'],
        'compactions': compactions,
        'lines': line_report(reads),
    }


# -- the daemon log ------------------------------------------------------------------

# Each pattern is the message of one log call in packages/server/src, quoted in the comment. The tests pin
# every one to the source line, so a changed message reads as a failing test rather than as a count of zero.
#   ws-permissions.js:331      log.info(`Permission request ${requestId}: ${hookData.tool_name || 'unknown tool'}`)
#   permission-manager.js:853  this._logInfo(`Permission request ${requestId}: ${toolName}`)
REQUEST = re.compile(r'^Permission request (\S+): (.+)$')
#   ws-permissions.js:481      log.info(`Permission ${requestId} resolved: ${decision}`)
#   permission-manager.js:1115 this._logInfo(`Permission ${requestId} resolved: ${decision}`)
# The log does not say who answered: a client over the WebSocket and an automatic responder both land here.
RESOLVED = re.compile(r'^Permission (\S+) resolved: (\S+)$')
#   ws-permissions.js:790      log.info(`Permission ${requestId} resolved via HTTP: ${decision} (${result.via})`)
# The HTTP route is the notification action, which a person taps.
RESOLVED_HTTP = re.compile(r'^Permission (\S+) resolved via HTTP: (\S+) \((\S+)\)$')
#   ws-permissions.js:468      log.info(`Permission ${requestId} timed out, auto-denying`)
#   permission-manager.js:914  this._logInfo(`Permission ${requestId} timed out, auto-denying`)
TIMED_OUT = re.compile(r'^Permission (\S+) timed out, auto-denying$')
#   ws-permissions.js:453      log.info(`Permission ${requestId} connection closed by client`)
CLOSED = re.compile(r'^Permission (\S+) connection closed by client$')
#   ws-permissions.js:797      log.info(`Permission ${requestId} already expired when HTTP response arrived (SDK)`)
LATE = re.compile(r'^Permission (\S+) already expired when HTTP response arrived')
#   ws-permissions.js:619      log.info(`Permission floor forces a prompt for ${hookData?.tool_name || 'unknown tool'} (${reason})`)
# Only the hook-routed pipeline logs the floor; the in-process one does not.
FLOOR = re.compile(r'^Permission floor forces a prompt for (.+) \((.+)\)$')
#   permission-manager.js:796  this._logInfo(`Permission rule matched for ${toolName}: ${ruleDecision}`)
RULE = re.compile(r'^Permission rule matched for (.+): (allow|deny)$')
#   permission-manager.js:825  this._logInfo(`Pending-permission cap (${this._maxPendingPermissions}) reached — auto-denying ${requestId}`)
CAP = re.compile(r'^Pending-permission cap \((\d+)\) reached — auto-denying (\S+)$')
#   permission-manager.js:1411 this._logInfo(`Auto-allowed ${allowed} pending permission(s), denied ...`)
#   permission-manager.js:1415 this._logInfo(`Auto-allowed ${allowed} pending permission(s) on auto mode switch`)
AUTO_SWITCH = re.compile(r'^Auto-allowed (\d+) pending permission\(s\)')

# Lines that open like the permission outcomes above but are not one. Any other line that opens that way is a
# permission message this reader does not know (the daemon's wording changed, or the line is damaged), and the counts
# are then not to be trusted: `permissions` reports how many there were.
#   ws-permissions.js:622       log.debug(`Permission floor clear for ${hookData.tool_name}`)
#   ws-permissions.js:1044      log.debug(`Permission ${requestId} released, but the deny response write failed ...`)
#   cli-session.js:2259         log.info(`Permission mode changed to ${mode}, restarting process`)  (and sdk, claude-tui)
#   settings-handlers.js:406    _pmLog.info(`Permission mode change from ${client.id} on session ...`)
#   settings-handlers.js:1137   info(`Permission rules updated by ${client.id} on session ...`)
#   permission-manager.js:719   this._logWarn(`Permission audit sink threw: ${err?.message || err}`)
# A line is taken for a permission message by its first word. One that only mentions permissions later (a rate limit,
# the rule store, hook registration, ...) is not, which is a known limit and deliberate: nearly every real log would
# otherwise be unverified. The guard against a reworded outcome is the tests that pin every message above to the server
# source (`LogFormatsArePinnedToTheServer`, `test_every_not_an_outcome_line_is_one_the_server_writes`).
NOT_OUTCOME = re.compile(r'^Permission (?:floor clear for |mode changed? |rules updated by |audit sink threw: |\S+ released, but )')
PERMISSION_LINE = re.compile(r'^(?:[Pp]ermission |Pending-permission)')

LOG_NOTE = ('Counts cover requests that reached a prompt, one outcome per request id. An Auto-mode allow that '
            'short-circuits (permission-manager.js, `permissionMode === \'auto\'`) writes no log line, and the in-process '
            'pipeline does not log a floored prompt. A request answered over HTTP logs a plain `resolved:` line and then a '
            '`resolved via HTTP:` line; the second decides who answered. The log carries no session id on these lines, so '
            'the slice is every session the daemon ran in the window. A rule match or a pending-permission cap logs no '
            '`Permission request`, so those are counted apart (`without_prompt`); an auto-mode switch allows requests that '
            'were logged, without naming them, so its count is taken from the requests that have no other outcome.')


def slice_log(text, start, end):
    """The log lines whose timestamp is in [start, end] (aware datetimes), original text kept.

    A line with no timestamp (a stack trace's continuation) goes with the line before it."""
    kept, inside = [], False
    for raw, stamp, _message in native.log_records(text):
        if stamp:
            try:
                moment = timeutil.parse_ts(stamp)
            except ValueError:
                moment = None
            if moment is not None:
                inside = start <= moment <= end
        if inside:
            kept.append(raw)
    return kept


def permissions(text):
    """Permission outcomes in a daemon-log slice (see LOG_NOTE for what the log cannot show).

    Each request id has exactly one outcome: answered over HTTP (a person), else resolved by a line that does not
    say who (`unattributed`), else timed out, else its connection closed, else none (`unresolved_requests`).
    `requests == human + unattributed + timed_out + connection_closed + auto_mode_switch_allowed + unresolved`."""
    requests, tools = {}, Counter()
    http, plain, ended, late = {}, {}, {}, set()
    out = Counter()
    unrecognized = 0
    for _stamp, message in native.log_entries(text):
        m = REQUEST.match(message)
        if m:
            if m.group(1) not in requests:
                requests[m.group(1)] = safe_tool(m.group(2))
                tools[requests[m.group(1)]] += 1
            continue
        m = RESOLVED_HTTP.match(message)
        if m:
            http.setdefault(m.group(1), safe_enum(m.group(2), DECISIONS))
            continue
        m = RESOLVED.match(message)
        if m:
            plain.setdefault(m.group(1), safe_enum(m.group(2), DECISIONS))
            continue
        m = TIMED_OUT.match(message)
        if m:
            ended.setdefault(m.group(1), 'timed_out')
            continue
        m = CLOSED.match(message)
        if m:
            ended.setdefault(m.group(1), 'connection_closed')
            continue
        m = CAP.match(message)
        if m:
            out['cap_denied'] += 1
            continue
        m = RULE.match(message)
        if m:
            out['rule_' + m.group(2)] += 1
            continue
        m = AUTO_SWITCH.match(message)
        if m:
            out['auto_mode_switch'] += int(m.group(1))
            continue
        if FLOOR.match(message):
            out['floor_forced'] += 1
            continue
        m = LATE.match(message)
        if m:
            late.add(m.group(1))
        elif PERMISSION_LINE.match(message) and not NOT_OUTCOME.match(message):
            unrecognized += 1
    resolved, by_human, undecided = Counter(), Counter(), 0
    for rid in requests:
        if rid in http:
            by_human[http[rid]] += 1
        elif rid in plain:
            resolved[plain[rid]] += 1
        elif rid in ended:
            out[ended[rid]] += 1
        else:
            undecided += 1
    answered = set(http) | set(plain) | set(ended)
    # the switch allowed requests that were logged and never named: they come out of the ones with no other outcome
    switched = min(out['auto_mode_switch'], undecided)
    undecided -= switched
    return {
        'requests': len(requests),
        'requests_by_tool': {t: tools[t] for t in sorted(tools)[:MAX_TOOLS]},
        'unresolved_requests': undecided,
        'floor_forced': out['floor_forced'],
        'resolved': _sorted_counts(resolved),
        'resolved_by_http': _sorted_counts(by_human),
        'timed_out': out['timed_out'],
        'connection_closed': out['connection_closed'],
        'auto_mode_switch_allowed': switched,
        'late_responses': len(late),
        'unrecognized_lines': unrecognized,
        'without_prompt': {'rule_allow': out['rule_allow'], 'rule_deny': out['rule_deny'],
                           'cap_denied': out['cap_denied'],
                           'auto_mode_switch_unmatched': out['auto_mode_switch'] - switched,
                           'outcomes_without_request': len(answered - set(requests))},
        'decided_by': {'human': sum(by_human.values()), 'automatic': out['timed_out'] + switched,
                       'unattributed': sum(resolved.values())},
        'note': LOG_NOTE,
    }


# -- cost ----------------------------------------------------------------------------

def parse_prices(prices):
    """(table, problem). `prices` in trial.json is null (no table, no problem) or

        {"as_of": "2026-11-01", "source": "<where the rates came from>",
         "per_mtok": {"<model>": {"input": 5, "output": 25, "cache_read": 0.5, "cache_write": 6.25}}}

    in dollars per million tokens; `cache_read` and `cache_write` may be left out of a model that has none."""
    if prices is None:
        return None, None
    if not isinstance(prices, dict):
        return None, 'prices must be an object'
    try:
        date.fromisoformat(str(prices.get('as_of')))
    except ValueError:
        return None, 'prices.as_of must be an ISO date (YYYY-MM-DD)'
    if not isinstance(prices.get('source'), str) or not prices['source'].strip():
        return None, 'prices.source must say where the rates came from'
    per = prices.get('per_mtok')
    if not isinstance(per, dict) or not per:
        return None, 'prices.per_mtok must map a model name to its rates'
    for model, rates in per.items():
        if not isinstance(rates, dict) or any(k not in TOKEN_FIELDS for k in rates):
            return None, f'prices.per_mtok[{model!r}] must be an object keyed by {", ".join(TOKEN_FIELDS)}'
        for field in ('input', 'output'):
            if field not in rates:
                return None, f'prices.per_mtok[{model!r}] has no {field} rate'
        if any(type(v) not in (int, float) or v < 0 for v in rates.values()):
            return None, f'prices.per_mtok[{model!r}] rates must be non-negative numbers'
    return prices, None


def cost(by_model, prices):
    """(cost, note). `cost` is 'n/a' unless every model with tokens is priced by a valid, dated table."""
    table, problem = parse_prices(prices)
    if problem:
        return 'n/a', problem
    if table is None:
        return 'n/a', 'trial.json has no price table'
    if not by_model:
        return 'n/a', 'no token totals to price'   # an empty sum is not a $0.00 bill
    usd, rows, unpriced = 0.0, {}, []
    for model, tokens in by_model.items():
        rates = table['per_mtok'].get(model)
        if rates is None or any(tokens[f] and f not in rates for f in TOKEN_FIELDS):
            unpriced.append(model)
            continue
        rows[model] = round(sum(tokens[f] * rates.get(f, 0) for f in TOKEN_FIELDS) / 1_000_000, 4)
        usd += rows[model]
    if unpriced:
        return 'n/a', f'no price for {", ".join(sorted(unpriced))}'
    return {'usd': round(usd, 4), 'by_model': rows, 'as_of': table['as_of'], 'source': table['source']}, None


# -- the row collect folds into runs.json -------------------------------------------

def runs_row(summary, permission, workers_label):
    """The three runs.json fields the extract can fill; a field it cannot know is left out (`permission` is None
    when the daemon log could not be verified, so `approvals` is then absent and `collect` leaves it alone)."""
    row = {}
    compactions = summary['compactions']
    row['compactions'] = compactions['coordinator'] if not compactions['workers'] else (
        f'{compactions["coordinator"]} (+{compactions["workers"]} in workers)')
    workers = summary['workers']
    if workers['transcripts']:
        parts = ', '.join(f'{model} x{n}' for model, n in workers['turns'].items())
        row['workers'] = f'{workers["transcripts"]} {workers_label}' + (f': {parts}' if parts else '')
    else:
        row['workers'] = 'none'
    if permission is not None:
        by = permission['decided_by']
        prompted = f'{permission["requests"]} prompted'
        text = (f'{prompted}: {by["human"]} human, {by["unattributed"]} unattributed, '
                f'{by["automatic"]} automatic') if any(by.values()) else prompted
        apart = sum(permission['without_prompt'][k] for k in ('rule_allow', 'rule_deny', 'cap_denied', 'auto_mode_switch_unmatched'))
        row['approvals'] = text + (f'; {apart} decided with no prompt' if apart else '') + ' (daemon log)'
    return row
