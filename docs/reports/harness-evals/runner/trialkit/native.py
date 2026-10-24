"""Read what the harness wrote about itself: Claude Code transcripts, Codex rollouts, the daemon log.

`verify-start` has to read the applied model, effort and mode back from the
harness's own record, because the October runs that went wrong (run 3 at the
wrong effort, run 5 on the wrong model) were set up by hand and never read
back. Everything here is a pure function over text or a file: it opens
nothing for writing, tolerates malformed lines (a transcript being appended to
can end mid-line) and reports what it saw rather than judging it, so the
checks that judge live in launch.py and these stay testable on synthetic
fixtures.

Shapes (verified on Claude Code 2.1.308 and Codex CLI 0.163):
  Claude  {"type":"assistant","timestamp":..,"effort":"high","entrypoint":..,"message":{"model":..}}
          {"type":"user","permissionMode":"auto","message":{"content":[{"type":"tool_result",..}]}}
  Codex   {"type":"session_meta","payload":{"cwd","cli_version","originator","source","parent_thread_id"}}
          {"type":"turn_context","payload":{"model","effort","approval_policy","sandbox_policy":{"type"}}}
  daemon  `<ISO> [INFO] [ws] <message>`, or JSON `{"ts","level","component","msg"}`
"""
import json
import os
import re

# The mission's first command prints this line. The command text itself holds
# `run=%s`, so the run id must start with a letter or digit and every value must
# exclude `%`; otherwise the transcript's echo of the command would count as the
# command having run.
PROBE = re.compile(
    r'TRIAL-PROBE run=([A-Za-z0-9][A-Za-z0-9-]*) effort=([^\s%]+) entrypoint=([^\s%]+) '
    r'app=([^\s%]+) at=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)')

INTERRUPT_MARK = '[Request interrupted by user'
LOG_LINE = re.compile(r'^(\S+) \[([A-Za-z]+)\] \[([^\]]*)\] (.*)$')


# -- small helpers -----------------------------------------------------------

def slug(path):
    """Claude Code's project folder name: every non-alphanumeric character becomes `-`."""
    return re.sub(r'[^A-Za-z0-9]', '-', path)


def slug_candidates(path):
    """The folder names to try for `path`: as given, and with symlinks resolved (macOS /var vs /private/var)."""
    out = []
    for candidate in (os.path.abspath(path), os.path.realpath(path)):
        name = slug(candidate)
        if name not in out:
            out.append(name)
    return out


# A transcript copied while it is written can end mid-line, so a line or two is tolerated; more than this many
# lines, or more than this share of them, and a count read from the file is a lower bound of unknown size.
MAX_MALFORMED = 5
MAX_MALFORMED_SHARE = 0.01


# The key a record of a known type must carry as an object. A line that parses but lacks it (the format changed, or a
# line is not what it claims) is as unreadable as a truncated one, and is counted with them.
REQUIRED_OBJECT = {'assistant': 'message', 'user': 'message', 'session_meta': 'payload', 'turn_context': 'payload',
                   'event_msg': 'payload', 'response_item': 'payload'}


class Tally:
    """What reading one JSONL file saw: its non-blank lines, the ones that were not a usable record (not a JSON
    object, or a known type without the object it must carry), and whether it could be opened at all."""

    def __init__(self):
        self.lines = 0
        self.malformed = 0
        self.unreadable = False

    def unreliable(self):
        """True when too much of the file was skipped, or none of it could be read, to trust a count from it. A file
        with no usable record at all (empty, or every line skipped) is unreliable however few lines it has."""
        return (self.unreadable or self.lines - self.malformed <= 0 or self.malformed > MAX_MALFORMED
                or self.malformed > self.lines * MAX_MALFORMED_SHARE)


def _lines(path, tally=None):
    try:
        with open(path, encoding='utf-8', errors='replace') as fh:
            for raw in fh:
                raw = raw.strip()
                if raw:
                    if tally is not None:
                        tally.lines += 1
                    yield raw
    except OSError:
        if tally is not None:
            tally.unreadable = True


def _loads(raw):
    try:
        value = json.loads(raw)
    except (ValueError, RecursionError):  # a pathologically nested line is a malformed one
        return None
    return value if isinstance(value, dict) else None


def _shaped(entry):
    key = REQUIRED_OBJECT.get(entry.get('type'))
    return key is None or isinstance(entry.get(key), dict)


def entries(path, tally=None):
    """The usable records of a JSONL file (JSON objects whose known type carries its object); every other line is
    skipped and, with a `tally`, counted."""
    for raw in _lines(path, tally):
        entry = _loads(raw)
        if entry is None or not _shaped(entry):
            if tally is not None:
                tally.malformed += 1
            continue
        yield entry


def _add(items, value):
    if value is not None and value not in items:
        items.append(value)


def _flatten(content):
    """The text of a tool_result's `content`, which is a string or a list of blocks."""
    if isinstance(content, str):
        return [content]
    out = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, str):
                out.append(block)
            elif isinstance(block, dict) and isinstance(block.get('text'), str):
                out.append(block['text'])
    return out


def _user_parts(entry):
    """(prose, tool-result texts) of a user entry: what was said to the model, and what tools returned."""
    message = entry.get('message')
    content = message.get('content') if isinstance(message, dict) else None
    prose, results = [], []
    if isinstance(content, str):
        prose.append(content)
    elif isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get('type') == 'text' and isinstance(block.get('text'), str):
                prose.append(block['text'])
            elif block.get('type') == 'tool_result':
                results.extend(_flatten(block.get('content')))
    return prose, results


def parse_probes(text):
    """Every TRIAL-PROBE line in `text`, as dicts of run, effort, entrypoint, app and at."""
    return [{'run': m.group(1), 'effort': m.group(2), 'entrypoint': m.group(3), 'app': m.group(4),
             'at': m.group(5)} for m in PROBE.finditer(text)]


def parse_probe(text):
    """The first TRIAL-PROBE line in `text`, or None."""
    found = parse_probes(text)
    return found[0] if found else None


def _within(path, root):
    for a, b in ((os.path.abspath(path), os.path.abspath(root)),
                 (os.path.realpath(path), os.path.realpath(root))):
        if a == b or a.startswith(b.rstrip(os.sep) + os.sep):
            return True
    return False


# -- Claude Code transcripts -------------------------------------------------

def _asked_for(path, pattern):
    for raw in _lines(path):
        entry = _loads(raw)
        if not entry or entry.get('type') != 'user' or entry.get('isSidechain'):
            continue
        prose, _results = _user_parts(entry)
        if any(pattern.search(text) for text in prose):
            return True
    return False


def find_claude_transcript(projects_dir, clone_dir, run_id, since):
    """The coordinator transcript of `run_id` in the clone's project folder, or None.

    Top-level `*.jsonl` files only (a subagent's transcript is a different file
    and may quote the invocation), modified at or after `since` (an aware
    datetime, or None), with a user message holding `Trial run <run_id>`. The
    newest match wins."""
    pattern = re.compile(r'Trial run ' + re.escape(run_id) + r'(?![A-Za-z0-9-])')
    best = None
    for name in slug_candidates(clone_dir):
        folder = os.path.join(projects_dir, name)
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            continue
        for fname in names:
            path = os.path.join(folder, fname)
            if not fname.endswith('.jsonl') or fname.startswith('agent-') or not os.path.isfile(path):
                continue
            mtime = os.path.getmtime(path)
            if since is not None and mtime < since.timestamp():
                continue
            if _asked_for(path, pattern) and (best is None or mtime > best[0]):
                best = (mtime, path)
    return best[1] if best else None


def claude_summary(path):
    """What a Claude Code transcript says was applied, as lists of distinct values in order of appearance.

    The coordinator is what the trial fixes; entries marked `isSidechain` (an
    inline subagent) are counted apart, so a worker on another model cannot
    fail a check about the coordinator."""
    s = {'models': [], 'efforts': [], 'permission_modes': [], 'entrypoints': [], 'versions': [],
         'sidechain_models': [], 'probes': [], 'interrupts': 0, 'assistant_entries': 0,
         'first_timestamp': None, 'entries': 0, 'malformed': 0}
    for raw in _lines(path):
        entry = _loads(raw)
        if entry is None:
            s['malformed'] += 1
            continue
        s['entries'] += 1
        stamp = entry.get('timestamp')
        if s['first_timestamp'] is None and isinstance(stamp, str):
            s['first_timestamp'] = stamp
        side = bool(entry.get('isSidechain'))
        if not side:
            for key, bucket in (('permissionMode', 'permission_modes'), ('entrypoint', 'entrypoints'),
                                ('version', 'versions')):
                value = entry.get(key)
                if isinstance(value, str):
                    _add(s[bucket], value)
        kind = entry.get('type')
        if kind == 'assistant':
            message = entry.get('message')
            model = message.get('model') if isinstance(message, dict) else None
            if isinstance(model, str) and model != '<synthetic>':
                _add(s['sidechain_models'] if side else s['models'], model)
            if not side:
                s['assistant_entries'] += 1
                if isinstance(entry.get('effort'), str):
                    _add(s['efforts'], entry['effort'])
        elif kind == 'user':
            prose, results = _user_parts(entry)
            if not side and any(text.lstrip().startswith(INTERRUPT_MARK) for text in prose):
                s['interrupts'] += 1
            for text in results:
                for probe in parse_probes(text):
                    if probe not in s['probes']:
                        s['probes'].append(probe)
    return s


# -- Codex rollouts ----------------------------------------------------------

def _codex_meta(path):
    """The first session_meta payload of a rollout (it is the first line; a few are allowed for)."""
    for index, raw in enumerate(_lines(path)):
        if index >= 20:
            break
        entry = _loads(raw)
        if entry and entry.get('type') == 'session_meta' and isinstance(entry.get('payload'), dict):
            return entry['payload']
    return None


def is_coordinator(meta):
    """False for a subagent's rollout: `source` is {"subagent": ..} or the rollout has a parent thread."""
    source = meta.get('source')
    if isinstance(source, dict) and 'subagent' in source:
        return False
    if isinstance(source, str) and 'subagent' in source.lower().replace('_', '').replace('-', ''):
        return False
    return not meta.get('parent_thread_id')


def find_codex_rollout(sessions_dir, clone_dir, since):
    """The coordinator rollout whose working directory is the clone (or below it), or None. Newest wins."""
    best = None
    for dirpath, _dirs, files in os.walk(sessions_dir):
        for fname in sorted(files):
            if not (fname.startswith('rollout-') and fname.endswith('.jsonl')):
                continue
            path = os.path.join(dirpath, fname)
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if since is not None and mtime < since.timestamp():
                continue
            meta = _codex_meta(path)
            if not meta or not is_coordinator(meta):
                continue
            cwd = meta.get('cwd')
            if isinstance(cwd, str) and _within(cwd, clone_dir) and (best is None or mtime > best[0]):
                best = (mtime, path)
    return best[1] if best else None


def codex_summary(path):
    """What a Codex rollout says was applied. The probe is read from the raw lines, because the shape
    that carries a command's output is not one this module needs to know."""
    s = {'models': [], 'efforts': [], 'approval_policies': [], 'sandboxes': [], 'cli_version': None,
         'originator': None, 'cwd': None, 'probes': [], 'interrupts': 0, 'turns': 0,
         'first_timestamp': None, 'entries': 0, 'malformed': 0}
    for raw in _lines(path):
        entry = _loads(raw)
        if entry is None:
            s['malformed'] += 1
            continue
        s['entries'] += 1
        stamp = entry.get('timestamp')
        if s['first_timestamp'] is None and isinstance(stamp, str):
            s['first_timestamp'] = stamp
        payload = entry.get('payload') if isinstance(entry.get('payload'), dict) else {}
        kind = entry.get('type')
        if kind == 'session_meta' and s['cwd'] is None:
            s['cwd'] = payload.get('cwd')
            s['cli_version'] = payload.get('cli_version')
            s['originator'] = payload.get('originator')
        elif kind == 'turn_context':
            s['turns'] += 1
            for key, bucket in (('model', 'models'), ('effort', 'efforts'), ('approval_policy', 'approval_policies')):
                if isinstance(payload.get(key), str):
                    _add(s[bucket], payload[key])
            sandbox = payload.get('sandbox_policy')
            if isinstance(sandbox, dict):
                sandbox = sandbox.get('type')
            if isinstance(sandbox, str):
                _add(s['sandboxes'], sandbox)
        elif kind == 'event_msg' and payload.get('type') == 'turn_aborted':
            s['interrupts'] += 1
        for probe in parse_probes(raw):
            if probe not in s['probes']:
                s['probes'].append(probe)
    return s


# -- the daemon log ----------------------------------------------------------

def log_records(text):
    """(line, timestamp, message) for each non-blank log line, in either the text or the JSON format.

    A line that is neither (a stack trace's continuation) has no timestamp and is its own message."""
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith('{'):
            obj = _loads(line)
            if obj is not None and isinstance(obj.get('msg'), str):
                yield raw, obj.get('ts'), obj['msg']
                continue
        match = LOG_LINE.match(line)
        yield (raw, match.group(1), match.group(4)) if match else (raw, None, line)


def log_entries(text):
    """(timestamp, message) for each log line, in either the text or the JSON format."""
    for _raw, stamp, message in log_records(text):
        yield stamp, message


def session_findings(text, session_id):
    """What the daemon log says about one Chroxy session.

    `model` and `mode` are the last `Model change` and `Permission mode change`
    for that session id as (value, timestamp), or None when there is none;
    `interrupts` lists the timestamps of every `Interrupt from .. to session`."""
    sid = re.escape(session_id)
    model_re = re.compile(rf'Model change from \S+ on session {sid}: (\S+)')
    mode_re = re.compile(rf'Permission mode change from \S+ on session {sid}: \S+ \u2192 (\S+)')
    interrupt_re = re.compile(rf'Interrupt from \S+ to session {sid}(?![\w-])')
    found = {'model': None, 'mode': None, 'interrupts': []}
    for stamp, message in log_entries(text):
        m = model_re.search(message)
        if m:
            found['model'] = (m.group(1), stamp)
        m = mode_re.search(message)
        if m:
            found['mode'] = (m.group(1), stamp)
        if interrupt_re.search(message):
            found['interrupts'].append(stamp or '')
    return found
