"""Render missions, grader prompts and the answer-key template from trial.json.

Templates use `{{FIELD}}` placeholders; a harness's invocation text uses
`{FIELD}` so it can sit inside a mission without colliding. Rendering refuses
to leave a placeholder unfilled and refuses an empty queue, because a mission
without a queue is not launchable and would otherwise render cleanly.
"""
import os
import re

PLACEHOLDER = re.compile(r'\{\{[A-Z_]+\}\}')


class RenderError(Exception):
    pass


def _fill(text, fields, what):
    for key, value in fields.items():
        text = text.replace('{{' + key + '}}', str(value))
    left = sorted(set(PLACEHOLDER.findall(text)))
    if left:
        raise RenderError(f'{what}: unfilled placeholder(s) {", ".join(left)}')
    return text


def _read(path):
    try:
        with open(path, encoding='utf-8') as fh:
            return fh.read()
    except OSError as exc:
        raise RenderError(f'cannot read template {path}: {exc}') from exc


def queue_markdown(trial):
    if not trial.slots:
        raise RenderError(f'the queue is empty ({trial.queue_status or "no status"}); select it before rendering')
    rows = ['| Slot | Issue | Title | Type |', '|---|---|---|---|']
    for s in trial.slots:
        rows.append(f'| `{s.slot}` | #{s.issue} | {s.title} | {s.type} |')
    return '\n'.join(rows)


def invocation(trial, run):
    text = run.harness.invocation
    fields = {'RUN_ID': run.id, 'MISSION': trial.mission_relpath(run), 'BASE_BRANCH': run.base,
              'MODEL': run.model, 'EFFORT': run.effort, 'TRIAL_DIR': trial.trial_dir}
    for key, value in fields.items():
        text = text.replace('{' + key + '}', value)
    left = re.findall(r'\{[A-Z_]+\}', text)
    if left:
        raise RenderError(f'{run.id}: unfilled invocation field(s) {", ".join(sorted(set(left)))}')
    return text


def mission(trial, run):
    template = _read(trial.repo_path('missions', 'TEMPLATE.md'))
    fields = {
        'TRIAL_ID': trial.id, 'RUN_ID': run.id, 'HARNESS': run.harness.label, 'MODEL': run.model,
        'EFFORT': run.effort, 'BASE_BRANCH': run.base, 'QUEUE': queue_markdown(trial),
        'INVOCATION': invocation(trial, run), 'REPORT_PATH': trial.report_relpath(run),
        'MISSION_PATH': trial.mission_relpath(run), 'CAP_HOURS': trial.cap_hours,
        'KEY_FOLDER': trial.paths.get('key_folder', ''),
    }
    return _fill(template, fields, f'mission {run.id}')


def write_missions(trial, runs):
    written = []
    for run in runs:
        text = mission(trial, run)
        path = os.path.join(trial.root, trial.mission_relpath(run))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(text)
        written.append(path)
    return written


def run_roster(trial):
    lines = []
    for run in trial.runs:
        lines.append(f'- `{run.id}` — {run.harness.label}; {run.model} / {run.effort}; '
                     f'{run.role}, repeat {run.repeat}; base `{run.base}`; report `{trial.report_relpath(run)}`')
    return '\n'.join(lines)


def grader(trial, grader_id, slug, first_arm):
    if first_arm not in trial.arms:
        raise RenderError(f'first arm {first_arm!r} is not one of {", ".join(sorted(trial.arms))}')
    template = _read(trial.repo_path('graders', 'GRADER-PROMPT.md'))
    fields = {
        'TRIAL_ID': trial.id, 'TRIAL_DIR': trial.trial_dir, 'GRADER_ID': grader_id, 'GRADER_SLUG': slug,
        'FIRST_ARM': first_arm, 'RUN_ROSTER': run_roster(trial), 'KEY_BRANCH': f'trial/{trial.id}-eval',
        'EVAL_BRANCH': f'trial/{trial.id}-eval-{slug}', 'KEY_FOLDER': trial.paths.get('key_folder', ''),
        'SLOTS': ', '.join(f'{s.slot} = #{s.issue}' for s in trial.slots) or '(queue not selected)',
    }
    return _fill(template, fields, f'grader {grader_id}')


def key_template(trial):
    if not trial.slots:
        raise RenderError('the queue is empty; the key template needs the selected slots')
    out = [f'# Sealed key — harness trial {trial.id}', '',
           'One section per slot. Every acceptance check states when it passes, when it is partial',
           'and when it fails, in terms a grader can decide from the diff and the tests alone.',
           '"Readings to rule out" names every second reading of a word such as "unchanged",',
           '"when" or "both" (October rulings T1–T4).', '']
    for s in trial.slots:
        out += [f'## {s.slot} — #{s.issue} {s.title}', '',
                '- Expected root cause:', '- Fix already known (yes/no):', '',
                '| Check | Pass when | Partial when | Fail when |', '|---|---|---|---|',
                '| K1 | | | |', '| K2 | | | |', '',
                '- Readings to rule out:', '']
    return '\n'.join(out)
