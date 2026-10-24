"""`trialctl queue-candidates`: PLAN.md section 4's mechanical filters over the open backlog.

The queue for a trial is ten issues the owner picks from a read-only exploration
of the survivors. This applies the filters that need no judgement and names, for
every issue it drops, the one rule that dropped it (the first that applies, in
the order below, cheapest first, so GitHub is asked about an issue's timeline
only when nothing it already holds rules it out):

    not-owner         not filed by trial.github_login
    listed            in queue_rules.exclude_issues (an earlier trial's queue); every later rule is also
                      applied to it, and the output says which would also have rejected it, or "only the list"
    reserved          in queue_rules.reserved
    blocker           a defect the trial's entry gate waits on
    label             carries a queue_rules.exclude_labels label
    structure         an epic's parent or child (sub-issues)
    scope             its body mentions .claude/, .github/workflows or docs/reports/harness-evals/
    mentions-blocked  its body mentions a reserved or blocking issue
    trial-files       its body names a file that a PR into a trial/* branch changed (those PRs come from the
                      PR list, so a PR whose base branch was since deleted still counts)
    open-pr           an open PR cross-references it
    connected-pr      a PR is connected to it
    trial-xref        a PR into (or from) a trial/* branch cross-references it
    unverified        GitHub could not answer, so it is neither a candidate nor ruled out

"Could not check" is never a candidate: it is listed as `unverified` and the
command exits 2. That includes an empty answer where one cannot be: no PR into a
`trial/*` branch at all, or a PR whose base branch GitHub did not report, means
`trial-files` and `trial-xref` cannot be applied, so no issue they would have
cleared is a candidate. Only GET requests are made.
"""
import json
import re

from .gh import GitHubError

OUT_OF_SCOPE = ('.claude/', '.github/workflows', 'docs/reports/harness-evals/')
PACKAGE_LABELS = ('server', 'app', 'dashboard', 'desktop', 'protocol')
# type guess from labels, first match wins (a flaky-test issue is labelled `bug` and `testing`)
TYPE_LABELS = (('test', ('testing',)), ('bug', ('bug', 'type: bug')), ('feature', ('enhancement',)),
               ('tech-debt', ('tech-debt', 'type: tech-debt', 'refactor', 'cleanup')),
               ('docs', ('docs', 'documentation')))
ACCEPTANCE = re.compile(r'^[ \t]*(?:#{1,6}[ \t]+|\*\*|__)?acceptance(?:[ \t]+criteria)?\b', re.I | re.M)
ISSUE_REF = re.compile(r'(?<![\w/])#(\d+)\b|/issues/(\d+)\b')
# `dir/file.ext`, `file.ext`, optionally followed by `:12`, `:12-20` or `#L12`; not inside a URL or a longer path
PATH = re.compile(r'(?<![\w/.@:-])((?:[\w@.\-]+/)*[\w@\-][\w@.\-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::\d+(?:-\d+)?|#L\d+)?(?![\w/@-])')
# bare file names too common to say anything about a subject
COMMON_NAMES = frozenset(('package.json', 'package-lock.json', 'README.md', 'index.js', 'index.ts', 'index.tsx',
                          'CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md', 'tsconfig.json'))
RULES = ('not-owner', 'listed', 'reserved', 'blocker', 'label', 'structure', 'scope', 'mentions-blocked',
         'trial-files', 'open-pr', 'connected-pr', 'trial-xref', 'unverified')


def label_names(item):
    return [(label.get('name') if isinstance(label, dict) else str(label)) for label in item.get('labels') or []]


def type_guess(labels):
    lowered = {name.lower() for name in labels}
    for guess, names in TYPE_LABELS:
        if lowered & set(names):
            return guess
    return '?'


def mentioned_numbers(body):
    return {int(a or b) for a, b in ISSUE_REF.findall(body or '')}


def mentioned_paths(body):
    """The file paths a body names, without line suffixes, in order of first appearance."""
    seen = []
    for match in PATH.finditer(body or ''):
        token = match.group(1)
        if token not in seen:
            seen.append(token)
    return seen


def scope_hit(body):
    lowered = (body or '').lower()
    return next((mark for mark in OUT_OF_SCOPE if mark in lowered), None)


class TrialChanges:
    """The PRs into `trial/*` branches and the files they changed, each fetched once and only when needed.

    The PRs come from the repository's PR list (`pulls?state=all`, every page), keeping those whose base branch
    starts with `trial/`: a PR stays in that list after its base branch is deleted, which the branch refs do not.
    An empty answer is not an answer: with no PR into a `trial/*` branch (or one whose base GitHub did not report)
    nothing can be said about what they changed, so `ensure` raises and the rules that need them are unverified."""

    def __init__(self, gh):
        self.gh = gh
        self.prs = None     # PR number -> base branch
        self.files = None   # file path -> [(pr number, base branch)]
        self.error = None

    @property
    def branches(self):
        return sorted(set((self.prs or {}).values()))

    def ensure(self):
        """Load the trial PR list once; raises GitHubError when it is unknown or empty."""
        if self.prs is None and self.error is None:
            try:
                prs, unreadable = {}, 0
                for pr in self.gh.list(self.gh.repo_path('pulls'), {'state': 'all'}):
                    base = (pr.get('base') or {}).get('ref')
                    if not isinstance(base, str) or not base:
                        unreadable += 1
                    elif base.startswith('trial/'):
                        prs[pr['number']] = base
                if unreadable:
                    self.error = f'{unreadable} PR(s) in the PR list have no readable base branch, so the PRs into trial/* branches are not known'
                elif not prs:
                    self.error = 'no PR into a trial/* branch was found, so what they changed is not known'
                else:
                    self.prs = prs
            except (GitHubError, KeyError, TypeError, AttributeError) as exc:
                self.error = f'could not list the PRs into trial/* branches: {exc}'
        if self.error:
            raise GitHubError(self.error)

    def _load_files(self):
        if self.files is None:
            try:
                index = {}
                for number, branch in self.prs.items():
                    for entry in self.gh.list(self.gh.repo_path(f'pulls/{number}/files')):
                        # a renamed file is a changed file under both its names
                        for name in (entry['filename'], entry.get('previous_filename')):
                            if isinstance(name, str) and name:
                                index.setdefault(name, []).append((number, branch))
                self.files = index
            except (GitHubError, KeyError, TypeError) as exc:
                self.error = f'could not list the files changed on trial/* branches: {exc}'
                raise GitHubError(self.error)

    def find(self, token):
        """[(path, pr, branch)] for the changed files a body's `token` names. Raises GitHubError if unknown."""
        found = []
        if '/' not in token and token in COMMON_NAMES:
            return found
        self.ensure()
        self._load_files()
        for path, prs in self.files.items():
            if path == token or path.endswith('/' + token):
                found.extend((path, pr, branch) for pr, branch in prs)
        return found


class Verdicts:
    """Per-issue answers from GitHub, each asked for at most once."""

    def __init__(self, gh, repo):
        self.gh = gh
        self.repo = repo
        self.pr_refs = {}

    def timeline(self, number):
        return self.gh.list(self.gh.repo_path(f'issues/{number}/timeline'))

    def pr_branches(self, number):
        """(base, head) branch names of PR `number`. Raises GitHubError when either is not reported: a name that
        is missing is not a name that is not `trial/*`."""
        if number not in self.pr_refs:
            pr = self.gh.get(self.gh.repo_path(f'pulls/{number}'))
            base, head = ((pr.get(side) or {}).get('ref') if isinstance(pr, dict) else None for side in ('base', 'head'))
            if not (isinstance(base, str) and base and isinstance(head, str) and head):
                raise GitHubError(f'PR #{number} reports no readable base or head branch')
            self.pr_refs[number] = (base, head)
        return self.pr_refs[number]

    def same_repo(self, source_issue):
        full = (source_issue.get('repository') or {}).get('full_name')
        if not full:
            url = source_issue.get('repository_url') or ''
            full = '/'.join(url.rstrip('/').split('/')[-2:]) if url else None
        return full is None or full == self.repo

    def timeline_rule(self, number):
        """(rule, detail) from an issue's timeline, or None when nothing rules it out."""
        events = self.timeline(number)
        connected = 0
        sources = []
        for event in events:
            kind = event.get('event')
            if kind == 'connected':
                connected += 1
            elif kind == 'disconnected':
                connected -= 1
            elif kind == 'cross-referenced':
                issue = (event.get('source') or {}).get('issue') or {}
                if 'pull_request' in issue and self.same_repo(issue) and issue.get('number') is not None:
                    sources.append(issue)
        for issue in sources:
            if issue.get('state') == 'open':
                return 'open-pr', f'open PR #{issue["number"]} cross-references it'
        if connected > 0:
            return 'connected-pr', f'{connected} PR(s) are connected to it'
        unknown = None
        for issue in sources:
            try:
                base, head = self.pr_branches(issue['number'])
            except GitHubError as exc:
                unknown = unknown or exc   # another source PR may still settle it
                continue
            for ref in (base, head):
                if ref.startswith('trial/'):
                    return 'trial-xref', f'PR #{issue["number"]} ({head} -> {base}) cross-references it'
        if unknown:
            raise unknown
        return None


def cheap_rule(trial, item, rules, blocked, ignore_list=False):
    """(rule, detail) from what the issue listing already holds, or None. `ignore_list` skips the `listed` rule, to
    ask what else would have rejected an issue that is on the list."""
    number = item['number']
    login = (item.get('user') or {}).get('login')
    body = item.get('body') or ''
    if login != trial.github_login:
        return 'not-owner', f'filed by {login}'
    if number in rules.get('exclude_issues', ()) and not ignore_list:
        return 'listed', 'in queue_rules.exclude_issues (an earlier trial\'s queue)'
    if number in rules.get('reserved', ()):
        return 'reserved', 'in queue_rules.reserved'
    if number in blocked:
        return 'blocker', 'a defect the entry gate waits on'
    excluded = {name.lower() for name in rules.get('exclude_labels', ())}
    for name in label_names(item):
        if name.lower() in excluded:
            return 'label', f'label {name!r}'
    if (item.get('sub_issues_summary') or {}).get('total') or item.get('parent_issue_url'):
        return 'structure', 'has sub-issues' if (item.get('sub_issues_summary') or {}).get('total') else 'is a sub-issue'
    hit = scope_hit(body)
    if hit:
        return 'scope', f'body mentions {hit}'
    refs = sorted(mentioned_numbers(body) & (blocked | set(rules.get('reserved', ()))))
    if refs:
        return 'mentions-blocked', 'body mentions ' + ', '.join(f'#{n}' for n in refs)
    return None


def _row(item):
    labels = label_names(item)
    return {'number': item['number'], 'title': item.get('title') or '', 'labels': labels,
            'created': (item.get('created_at') or '')[:10], 'type': type_guess(labels),
            'packages': [name for name in PACKAGE_LABELS if name in labels],
            'has_acceptance_criteria': bool(ACCEPTANCE.search(item.get('body') or ''))}


def github_rule(item, changes, verdicts):
    """(rule, detail) for an issue from what GitHub holds, or None when nothing rules it out.

    Raises GitHubError when that is not known: a rule that could not be applied is never a pass. A conclusive hit
    stands even when the other rule could not be applied."""
    unknown = None
    try:
        hit = next(((p, c) for p in mentioned_paths(item.get('body')) for c in changes.find(p)), None)
        if hit:
            token, (path, pr, branch) = hit
            return 'trial-files', f'body names {token}; PR #{pr} into {branch} changed {path}'
        changes.ensure()    # no file named is "none changed" only while the trial PRs are known
    except GitHubError as exc:
        unknown = str(exc)
    try:
        found = verdicts.timeline_rule(item['number'])
    except GitHubError as exc:
        raise GitHubError(f'timeline: {exc}' + (f'; {unknown}' if unknown else ''))
    if found:
        return found
    if unknown:
        raise GitHubError(unknown)
    return None


def scan(trial, gh, items):
    """The whole classification: {'candidates', 'rejected', 'unverified', 'scanned', 'api'}."""
    rules = trial.queue_rules
    blocked = {n for numbers in trial.blockers.values() for n in numbers}
    verdicts, changes = Verdicts(gh, trial.repo), TrialChanges(gh)
    candidates, rejected, unverified = [], [], []
    pulls = sum(1 for item in items if 'pull_request' in item)
    issues = [item for item in items if 'pull_request' not in item]

    def drop(item, rule, detail, into=rejected):
        row = {'number': item['number'], 'title': item.get('title') or '', 'rule': rule, 'detail': detail}
        into.append(row)
        return row

    survivors, listed = [], []
    for item in issues:
        found = cheap_rule(trial, item, rules, blocked)
        if not found:
            survivors.append(item)
        elif found[0] == 'listed':
            listed.append((item, drop(item, *found)))
        else:
            drop(item, *found)
    for item in survivors:
        try:
            found = github_rule(item, changes, verdicts)
        except GitHubError as exc:
            drop(item, 'unverified', str(exc), unverified)
            continue
        if found:
            drop(item, *found)
        else:
            candidates.append(_row(item))
    # an issue on the list is rejected whatever else is true of it; what else is true says whether the list is
    # carrying weight (only the list rejects it) or repeating what the mechanical rules would have said
    for item, row in listed:
        found, note = cheap_rule(trial, item, rules, blocked, ignore_list=True), None
        if not found:
            try:
                found = github_rule(item, changes, verdicts)
            except GitHubError as exc:
                note = str(exc)
        if note:
            row.update(cross_check='unverified', also=None, also_detail=note)
        elif found:
            row.update(cross_check='also-rejected', also=found[0], also_detail=found[1])
        else:
            row.update(cross_check='only-the-list', also=None, also_detail=None)
    candidates.sort(key=lambda c: -c['number'])
    counts = {rule: sum(1 for r in rejected + unverified if r['rule'] == rule) for rule in RULES}
    cross = [row for _item, row in listed]
    return {'repo': trial.repo, 'scanned': {'issues': len(issues), 'pull_requests': pulls},
            'counts': {rule: n for rule, n in counts.items() if n}, 'candidates_total': len(candidates),
            'candidates': candidates, 'rejected': sorted(rejected, key=lambda r: -r['number']),
            'unverified': sorted(unverified, key=lambda r: -r['number']),
            'listed_cross_check': {
                'also_rejected': sorted((r['number'] for r in cross if r['cross_check'] == 'also-rejected'), reverse=True),
                'only_the_list': sorted((r['number'] for r in cross if r['cross_check'] == 'only-the-list'), reverse=True),
                'unverified': sorted((r['number'] for r in cross if r['cross_check'] == 'unverified'), reverse=True)},
            'trial_branches': {'branches': len(changes.branches), 'prs': len(changes.prs or {}),
                               'listed': changes.prs is not None and not changes.error, 'problem': changes.error}}


def render(result, limit):
    shown = result['candidates'][:limit] if limit else result['candidates']
    s = result['scanned']
    lines = [f'queue-candidates {result["repo"]}: scanned {s["issues"]} open issue(s) and {s["pull_requests"]} PR(s); '
             f'{result["candidates_total"]} candidate(s), {len(result["rejected"])} rejected, '
             f'{len(result["unverified"])} unverified',
             'rejected by rule: ' + (', '.join(f'{rule} {n}' for rule, n in result['counts'].items()) or 'none')]
    tb = result['trial_branches']
    if tb['listed']:
        lines.append(f'trial/* base branches read: {tb["branches"]}, PRs into them: {tb["prs"]}')
    elif tb['problem']:
        lines.append(f'trial/* PRs NOT read: {tb["problem"]}')
    cross = result['listed_cross_check']
    if any(cross.values()):
        lines.append(f'on the list (queue_rules.exclude_issues): {len(cross["also_rejected"])} also rejected by a rule, '
                     f'{len(cross["only_the_list"])} only by the list'
                     + (f', {len(cross["unverified"])} not cross-checked' if cross['unverified'] else ''))
    lines.append('')
    lines.append(f'candidates ({len(shown)} of {result["candidates_total"]}):' if limit else f'candidates ({len(shown)}):')
    for c in shown:
        lines.append(f'  #{c["number"]:<5} {c["created"]}  {c["type"]:<9} {",".join(c["packages"]) or "-":<18} '
                     f'{"AC" if c["has_acceptance_criteria"] else "--"}  {c["title"][:90]}')
        extra = [label for label in c['labels'] if label not in c['packages']]
        if extra:
            lines.append(f'         labels: {", ".join(extra)}')
    if result['unverified']:
        lines += ['', 'unverified (GitHub could not answer; neither a candidate nor ruled out):']
        lines += [f'  #{r["number"]:<5} {r["detail"]}' for r in result['unverified']]
    lines += ['', 'rejected:']
    for r in result['rejected']:
        lines.append(f'  #{r["number"]:<5} {r["rule"]}: {r["detail"]}')
        if r['rule'] == 'listed':
            lines.append('         ' + {'only-the-list': 'only the list rejects it',
                                        'also-rejected': f'also {r["also"]}: {r["also_detail"]}',
                                        'unverified': f'NOT cross-checked: {r["also_detail"]}'}[r['cross_check']])
    return '\n'.join(lines)


def queue_candidates(trial, env, as_json=False, limit=None):
    """Print the candidates and the rejections; 0 when GitHub answered everything, 2 otherwise."""
    if not trial.github_login:
        env.print('queue-candidates: trial.json has no github_login, so "filed by the owner" cannot be applied')
        return 2
    if limit is not None and limit < 1:
        env.print('queue-candidates: --limit must be at least 1')
        return 2
    gh = env.github(trial.repo)
    try:
        items = gh.list(gh.repo_path('issues'), {'state': 'open'})
    except GitHubError as exc:
        env.print(f'queue-candidates: cannot list the open issues: {exc}')
        return 2
    result = scan(trial, gh, items)
    if limit:
        result = dict(result, candidates=result['candidates'][:limit])
    env.print(json.dumps(result, indent=2, ensure_ascii=False) if as_json else render(result, limit))
    return 2 if result['unverified'] or result['listed_cross_check']['unverified'] else 0
