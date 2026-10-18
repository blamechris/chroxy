#!/usr/bin/env python3
"""Render the trial missions from TEMPLATE.md + runs.json + queue.json.

Usage: python3 render_missions.py            (from any cwd)
Writes ../missions/<RUN_ID>.md for every run. Re-run after changing the queue
so all four missions stay identical except for their run fields. T0 is not
rendered: a clone cut from T0 cannot contain its own SHA, so the template
derives it with git merge-base instead.
"""
import json, pathlib

here = pathlib.Path(__file__).resolve().parent
trial = here.parent
template = (trial / 'missions' / 'TEMPLATE.md').read_text()
runs = json.loads((here / 'runs.json').read_text())
queue = json.loads((here / 'queue.json').read_text())

if queue['issues']:
    queue_md = '\n'.join(
        f"- #{i['number']} — {i['title']}" + (f" _(type: {i['type']})_" if i.get('type') else '')
        for i in queue['issues'])
else:
    queue_md = f"**{queue['status']}**"

for run in runs['runs']:
    fields = {
        'RUN_ID': run['id'], 'HARNESS': run['harness'], 'MODEL': run['model'],
        'EFFORT': run['effort'], 'BASE_BRANCH': run['base'],
        'QUEUE': queue_md, 'INVOCATION': run['invocation'],
    }
    out = template
    for k, v in fields.items():
        out = out.replace('{{' + k + '}}', v)
    assert '{{' not in out, f"unfilled placeholder in {run['id']}"
    (trial / 'missions' / f"{run['id']}.md").write_text(out)
    print('wrote', run['id'])
