"""Read-only GitHub access through the `gh` CLI, plus a fixture-backed double.

Only GET requests are issued. `get` returns one response; `list` follows
pagination and flattens the pages (for endpoints that wrap their array, such as
`/actions/runs` -> `workflow_runs`, pass `key`). `FixtureGitHub` serves recorded
responses keyed by the request, and `RecordingGitHub` writes them, so the
collector's tests run against real October responses with no network.
"""
import hashlib
import json
import os
import re
from urllib.parse import urlencode

from .proc import Runner


class GitHubError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def request_key(path, params=None, key=None):
    query = urlencode(sorted((params or {}).items()))
    return f'{path.lstrip("/")}?{query}' + (f'#{key}' if key else '')


def fixture_name(request):
    """A file name for a request. Long requests keep a prefix and gain a digest of
    the whole request, so two that share the prefix cannot collide."""
    name = re.sub(r'[^A-Za-z0-9._-]+', '_', request).strip('_')
    if len(name) > 180:
        name = name[:160] + '-' + hashlib.sha256(request.encode('utf-8')).hexdigest()[:16]
    return name + '.json'


class GitHub:
    def __init__(self, repo, runner=None):
        self.repo = repo
        self.runner = runner or Runner()

    def repo_path(self, suffix):
        return f'repos/{self.repo}/{suffix.lstrip("/")}'

    def _call(self, path, params, paginate):
        argv = ['gh', 'api', '-X', 'GET', path]
        for k, v in sorted((params or {}).items()):
            argv += ['-f', f'{k}={v}']
        if paginate:
            argv += ['--paginate', '--slurp']
        r = self.runner.run(argv, timeout=300)
        if not r.ok:
            match = re.search(r'HTTP (\d{3})', r.stderr)
            raise GitHubError(f'gh api {path} failed: {r.stderr.strip()[:300]}',
                              int(match.group(1)) if match else None)
        return json.loads(r.stdout) if r.stdout.strip() else None

    def get(self, path, params=None):
        return self._call(path, params, paginate=False)

    def list(self, path, params=None, key=None):
        params = dict(params or {})
        params.setdefault('per_page', 100)
        pages = self._call(path, params, paginate=True) or []
        out = []
        for page in pages:
            items = page.get(key, []) if key else page
            if not isinstance(items, list):
                raise GitHubError(f'{path}: expected a list in each page, got {type(items).__name__}')
            out.extend(items)
        return out


class FixtureGitHub:
    """Serves responses recorded by `RecordingGitHub`; an unrecorded request fails."""

    def __init__(self, directory, repo='blamechris/chroxy'):
        self.dir = directory
        self.repo = repo
        self.requests = []

    def repo_path(self, suffix):
        return f'repos/{self.repo}/{suffix.lstrip("/")}'

    def _load(self, request):
        self.requests.append(request)
        path = os.path.join(self.dir, fixture_name(request))
        if not os.path.exists(path):
            raise GitHubError(f'no fixture for {request} ({os.path.basename(path)})', 404)
        with open(path, encoding='utf-8') as fh:
            entry = json.load(fh)
        if entry.get('status') and entry['status'] >= 400:
            raise GitHubError(f'recorded HTTP {entry["status"]} for {request}', entry['status'])
        return entry['response']

    def get(self, path, params=None):
        return self._load(request_key(path, params))

    def list(self, path, params=None, key=None):
        params = dict(params or {})
        params.setdefault('per_page', 100)
        return self._load(request_key(path, params, key))


class RecordingGitHub:
    """Wraps a real client and writes each response (optionally trimmed) to `directory`."""

    def __init__(self, inner, directory, trim=None):
        self.inner = inner
        self.repo = inner.repo
        self.dir = directory
        self.trim = trim or (lambda request, response: response)
        os.makedirs(directory, exist_ok=True)

    def repo_path(self, suffix):
        return self.inner.repo_path(suffix)

    def _save(self, request, response, status=None):
        entry = {'request': request, 'response': self.trim(request, response)}
        if status:
            entry['status'] = status
        with open(os.path.join(self.dir, fixture_name(request)), 'w', encoding='utf-8') as fh:
            json.dump(entry, fh, indent=1, sort_keys=True, ensure_ascii=False)
            fh.write('\n')

    def _wrap(self, request, call):
        try:
            response = call()
        except GitHubError as exc:
            if exc.status:
                self._save(request, None, exc.status)
            raise
        self._save(request, response)
        return response

    def get(self, path, params=None):
        return self._wrap(request_key(path, params), lambda: self.inner.get(path, params))

    def list(self, path, params=None, key=None):
        params = dict(params or {})
        params.setdefault('per_page', 100)
        return self._wrap(request_key(path, params, key), lambda: self.inner.list(path, params, key))
