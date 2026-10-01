#!/usr/bin/env python3
"""Launch one NEW Claude fixture session; never continue/resume an existing session."""
import argparse
import json
from pathlib import Path
import subprocess


def command(binary):
    return [binary, '--setting-sources', 'project', '--settings', json.dumps({
        'disableAllHooks': True, 'autoMemoryEnabled': False,
        'disableSkillShellExecution': True, 'enabledPlugins': {},
    }), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome',
        '--tools', 'Read,Skill,Write,Edit', '--allowedTools', 'Read(./**)',
        'Edit(./checkpoint.json)',
        'Edit(./merge-request.json)', 'Edit(./resolve-request.json)', 'Edit(./start-request.json)',
        'Skill(prime-directive)', 'Skill(full-review)', 'Skill(check-pr)',
        'Skill(tackle-issues)', 'Skill(autonomous-dev-flow)', 'Skill(agent-review)',
        '--permission-mode', 'dontAsk', '--no-session-persistence', '--max-budget-usd', '4',
        '--output-format', 'stream-json', '--verbose', '-p',
        'Read TASK.md and carry out the fixture task using the installed workflow.']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('case')
    parser.add_argument('--claude', default='claude')
    args = parser.parse_args()
    root = args.run.resolve()
    manifest = json.loads((root / 'manifest.json').read_text())
    if args.case not in manifest['cases']:
        parser.error('Case is not in the prepared manifest')
    folder = root / args.case
    if folder.is_symlink() or not (folder / 'TASK.md').is_file():
        parser.error('Expected a prepared fixture directory')
    if any((folder / name).exists() for name in ('native.jsonl', 'checkpoint.json',
            'merge-request.json', 'resolve-request.json', 'start-request.json')):
        parser.error('Refusing to overwrite previous trial evidence; prepare a new destination')
    argv = command(args.claude)
    (folder / 'launch.json').write_text(json.dumps({'argv': argv, 'cwd': str(folder)}, indent=2) + '\n')
    with (folder / 'native.jsonl').open('x') as stdout, (folder / 'native.stderr').open('x') as stderr:
        result = subprocess.run(argv, cwd=folder, stdout=stdout, stderr=stderr, check=False)
    raise SystemExit(result.returncode)
