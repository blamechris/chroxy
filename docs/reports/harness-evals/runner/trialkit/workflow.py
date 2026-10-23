"""Does a workflow run on push to a branch? Read from `ci.yml`'s `on.push.branches`.

The trial needs CI to run when a PR merges into a trial base, or "red CI on the
base after a merge" is not observable (October REPORT §8). This reads the
trigger without a YAML library: it understands the two list spellings the
repository uses (`branches: [a, 'b/**']` and a `- a` block list) and raises
`WorkflowParseError` on anything else, so an unreadable trigger is reported as
"cannot verify", never as covered. That includes every other filter under
`push:` (`tags`, `paths`, `branches-ignore`, …): each changes whether a branch
push runs the workflow (a `tags`-only trigger runs on no branch push at all),
and reading past one would report coverage that does not exist.

Branch patterns support the subset of GitHub's filter grammar the repository
uses: `*` matches any run of characters except `/`, `**` any run including `/`,
and a leading `!` excludes. Patterns are applied in order and the last one that
matches decides. `?`, `+` and `[...]` mean something different in GitHub's
grammar than in a shell glob, so a pattern using them raises.
"""
import re


class WorkflowParseError(Exception):
    pass


def _indent(line):
    return len(line) - len(line.lstrip(' '))


def _strip_comment(line):
    out, quote = [], None
    for ch in line:
        if quote:
            if ch == quote:
                quote = None
        elif ch in '\'"':
            quote = ch
        elif ch == '#':
            break
        out.append(ch)
    return ''.join(out).rstrip()


def _unquote(item):
    item = item.strip()
    if len(item) >= 2 and item[0] == item[-1] and item[0] in '\'"':
        return item[1:-1]
    return item


def _block(lines, start, parent_indent):
    """Lines after `start` that are indented deeper than `parent_indent`."""
    out = []
    for line in lines[start + 1:]:
        if not line.strip():
            continue
        if _indent(line) <= parent_indent:
            break
        out.append(line)
    return out


def push_branches(text):
    """The `on.push.branches` patterns; None when push runs on every branch; [] when there is no push trigger.
    Every returned pattern is within the supported grammar, so `branch_covered` on the result cannot raise."""
    patterns = _push_branches(text)
    for pattern in patterns or []:
        _glob(pattern[1:] if pattern.startswith('!') else pattern)
    return patterns


def _push_branches(text):
    lines = [_strip_comment(line) for line in text.splitlines()]
    on_idx = next((i for i, line in enumerate(lines) if re.match(r'^(on|"on"|\'on\'):\s*$', line)), None)
    if on_idx is None:
        inline = next((line for line in lines if re.match(r'^(on|"on"|\'on\'):\s*\S', line)), None)
        if inline is None:
            raise WorkflowParseError('no top-level `on:` key')
        value = inline.split(':', 1)[1].strip()
        names = [_unquote(v) for v in value.strip('[]').split(',')] if value.startswith('[') else [_unquote(value)]
        return None if 'push' in names else []
    on_block = _block(lines, on_idx, 0)
    if not on_block:
        raise WorkflowParseError('`on:` has no events under it')
    event_indent = _indent(on_block[0])
    # Only a direct child of `on:` is the push event; a `push:` deeper down belongs to something else.
    push_line = next((line for line in on_block if _indent(line) == event_indent and re.match(r'^\s+push:', line)), None)
    if push_line is None:
        return []
    push_idx = lines.index(push_line)
    rest = push_line.split(':', 1)[1].strip()
    if rest and rest not in ('{}', 'null', '~'):
        raise WorkflowParseError(f'unsupported push trigger spelling: {push_line.strip()!r}')
    push_block = _block(lines, push_idx, _indent(push_line))
    if not push_block:
        return None
    filter_indent = _indent(push_block[0])
    keys = [line.split(':', 1)[0].strip() for line in push_block if _indent(line) == filter_indent]
    others = [k for k in keys if k != 'branches']
    if others:
        raise WorkflowParseError(f'push filter(s) {", ".join(others)} are not supported; they change which branch pushes run it')
    br_line = next(line for line in push_block if _indent(line) == filter_indent)
    value = br_line.split(':', 1)[1].strip()
    if value.startswith('['):
        if not value.endswith(']'):
            raise WorkflowParseError(f'unterminated inline list: {value!r}')
        return [_unquote(v) for v in value[1:-1].split(',') if v.strip()]
    if value:
        return [_unquote(value)]
    items = []
    for line in _block(lines, lines.index(br_line), _indent(br_line)):
        m = re.match(r'^\s+-\s+(.+)$', line)
        if not m:
            raise WorkflowParseError(f'unexpected line in branches list: {line.strip()!r}')
        items.append(_unquote(m.group(1)))
    return items


def _glob(pattern):
    if re.search(r'[?+\[\]]', pattern):
        raise WorkflowParseError(f'branch pattern {pattern!r} uses ?, + or [...], which this reader does not implement')
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith('**', i):
            out.append('.*')
            i += 2
        elif pattern[i] == '*':
            out.append('[^/]*')
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile('^' + ''.join(out) + '$')


def branch_covered(branch, patterns):
    """True when a push to `branch` triggers a workflow with these `branches` patterns."""
    if patterns is None:
        return True
    covered = False
    for pattern in patterns:
        negate = pattern.startswith('!')
        if _glob(pattern[1:] if negate else pattern).match(branch):
            covered = not negate
    return covered
