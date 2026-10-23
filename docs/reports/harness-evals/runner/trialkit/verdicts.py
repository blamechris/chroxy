"""Grader verdicts: fold them into the evidence, diff two graders, verify the sealed key.

A grader writes `verdicts.json` beside GRADING.md:

    {"grader": "G-claude", "runs": {"<RUN>": {"Q01": {"verdict": "yes",
        "checks": {"K1": "pass"}, "evidence": "..."}}}}

Nothing here guesses. An unknown run, slot or value is refused with the reason,
a merged PR with no verdict stops `apply_verdicts` before it writes anything, and
a commitment that cannot be parsed is exit 2, never a pass.
"""
import hashlib
import json
import os
import re

VERDICTS = ('yes', 'partial', 'no', 'key-unknown')
CHECK_RESULTS = ('pass', 'partial', 'fail')
CHECK_ID = re.compile(r'^K\d+$')
SHOWN_PROBLEMS = 20
EVIDENCE_WIDTH = 160


def _read_json(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def _write_json(path, value):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(value, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, path)


def _report(env, title, problems):
    env.print(f'{title}:')
    for problem in problems[:SHOWN_PROBLEMS]:
        env.print(f'  {problem}')
    if len(problems) > SHOWN_PROBLEMS:
        env.print(f'  ... and {len(problems) - SHOWN_PROBLEMS} more')


def load_verdicts(trial, path):
    """(document, problems): the parsed file and every reason it cannot be used."""
    try:
        doc = _read_json(path)
    except (OSError, ValueError) as exc:
        return None, [f'cannot read {path}: {exc}']
    problems = []
    if not isinstance(doc, dict):
        return None, [f'{path}: the top level must be an object with "grader" and "runs"']
    if not isinstance(doc.get('grader'), str) or not doc['grader'].strip():
        problems.append('"grader" must be a non-empty string')
    runs = doc.get('runs')
    if not isinstance(runs, dict) or not runs:
        problems.append('"runs" must be an object with at least one run')
        return None, problems
    known = {r.id for r in trial.runs}
    for run_id, slots in runs.items():
        if run_id not in known:
            problems.append(f'unknown run {run_id!r} (trial {trial.id} has: {", ".join(sorted(known))})')
            continue
        if not isinstance(slots, dict):
            problems.append(f'{run_id}: expected an object of slots')
            continue
        for slot, entry in slots.items():
            where = f'{run_id} {slot}'
            if trial.issue_for_slot(slot) is None:
                problems.append(f'{where}: unknown slot (queue: {", ".join(s.slot for s in trial.slots)})')
                continue
            if not isinstance(entry, dict):
                problems.append(f'{where}: expected an object with "verdict"')
                continue
            if entry.get('verdict') not in VERDICTS:
                problems.append(f'{where}: verdict {entry.get("verdict")!r} is not one of {", ".join(VERDICTS)}')
            checks = entry.get('checks', {})
            if not isinstance(checks, dict):
                problems.append(f'{where}: "checks" must be an object')
            else:
                for check, result in checks.items():
                    if not CHECK_ID.match(str(check)):
                        problems.append(f'{where}: check id {check!r} must look like K1')
                    if result not in CHECK_RESULTS:
                        problems.append(f'{where} {check}: {result!r} is not one of {", ".join(CHECK_RESULTS)}')
            if 'evidence' in entry and not isinstance(entry['evidence'], str):
                problems.append(f'{where}: "evidence" must be a string')
    return (None, problems) if problems else (doc, [])


def _evidence_files(data):
    root = os.path.join(data, 'evidence')
    if not os.path.isdir(root):
        return []
    return sorted(os.path.join(root, name) for name in os.listdir(root) if name.endswith('.json'))


def _merged_queue_prs(trial, run_obj):
    """(pr, slot) for each merged PR that maps to a queue issue."""
    out = []
    for pr in run_obj.get('prs', []):
        if pr.get('state') != 'merged' or pr.get('issue') is None:
            continue
        slot = pr.get('slot') or getattr(trial.slot_for_issue(pr['issue']), 'slot', None)
        if slot is not None:
            out.append((pr, slot))
    return out


def apply_verdicts(trial, env, verdicts_path, data_dir=None):
    """Set `correct_vs_key` on every merged queue PR; all or nothing. 0 applied, 1 incomplete, 2 invalid."""
    doc, problems = load_verdicts(trial, verdicts_path)
    if problems:
        _report(env, f'apply-verdicts: {verdicts_path} is not usable', problems)
        return 2
    data = data_dir or trial.repo_path('data')
    loaded = {}
    for path in _evidence_files(data):
        try:
            evidence = _read_json(path)
        except (OSError, ValueError) as exc:
            env.print(f'apply-verdicts: cannot read {path}: {exc}')
            return 2
        for run_id, run_obj in (evidence.get('runs') or {}).items():
            loaded[run_id] = (path, evidence, run_obj)
    if not loaded:
        env.print(f'apply-verdicts: no evidence under {os.path.join(data, "evidence")}; run `trialctl collect` first')
        return 2
    absent = [r for r in doc['runs'] if r not in loaded]
    if absent:
        env.print(f'apply-verdicts: no collected evidence for {", ".join(absent)}; run `trialctl collect` first')
        return 2
    missing, applied, ignored = [], 0, []
    for run_id, (path, evidence, run_obj) in loaded.items():
        given = doc['runs'].get(run_id, {})
        merged = _merged_queue_prs(trial, run_obj)
        for pr, slot in merged:
            if slot not in given:
                missing.append(f'{run_id} {slot} (PR {pr["pr"]})')
        ignored += [f'{run_id} {slot}' for slot in given if slot not in {s for _, s in merged}]
    if missing:
        _report(env, f'apply-verdicts: {len(missing)} merged queue PR(s) have no verdict in {doc["grader"]}; '
                     'nothing written', missing)
        return 1
    touched = {}
    for run_id, (path, evidence, run_obj) in loaded.items():
        given = doc['runs'].get(run_id, {})
        for pr, slot in _merged_queue_prs(trial, run_obj):
            pr['correct_vs_key'] = given[slot]['verdict']
            pr['verdict_source'] = doc['grader']
            applied += 1
            touched[path] = evidence
    for path, evidence in touched.items():
        _write_json(path, evidence)
    for item in ignored:
        env.print(f'  note: {item} has a verdict but no merged PR; ignored')
    env.print(f'apply-verdicts: {doc["grader"]}: set correct_vs_key on {applied} merged PR(s) in '
              f'{len(touched)} evidence file(s)')
    return 0


# -- disputes ------------------------------------------------------------------

def _flat(text):
    text = ' '.join((text or '').split())
    return text if len(text) <= EVIDENCE_WIDTH else text[:EVIDENCE_WIDTH - 3] + '...'


def _cell(text):
    return text.replace('|', '\\|')


def _differences(trial, a, b):
    """(run, slot, item, a_value, b_value, evidence) for every place the two graders differ."""
    roster = [r.id for r in trial.runs]
    runs = [r for r in roster if r in a['runs'] or r in b['runs']]
    slot_order = [s.slot for s in trial.slots]
    rows = []
    for run_id in runs:
        left, right = a['runs'].get(run_id, {}), b['runs'].get(run_id, {})
        for slot in [s for s in slot_order if s in left or s in right]:
            ea, eb = left.get(slot), right.get(slot)
            va = ea['verdict'] if ea else '(not graded)'
            vb = eb['verdict'] if eb else '(not graded)'
            evidence = f'A: {_flat((ea or {}).get("evidence"))} / B: {_flat((eb or {}).get("evidence"))}'
            if va != vb:
                rows.append((run_id, slot, 'verdict', va, vb, evidence))
            if not ea or not eb:
                continue
            ca, cb = ea.get('checks', {}), eb.get('checks', {})
            for check in sorted(set(ca) | set(cb), key=lambda k: int(k[1:])):
                if ca.get(check) != cb.get(check):
                    rows.append((run_id, slot, check, ca.get(check, '-'), cb.get(check, '-'), evidence))
    return rows


def disputes(trial, env, a_path, b_path, markdown=False):
    """Print where two graders' verdicts or checks differ. 0 whatever the count, 2 for a malformed file."""
    docs = []
    for path in (a_path, b_path):
        doc, problems = load_verdicts(trial, path)
        if problems:
            _report(env, f'disputes: {path} is not usable', problems)
            return 2
        docs.append(doc)
    a, b = docs
    rows = _differences(trial, a, b)
    if markdown:
        env.print(f'| Run | Slot | Item | A = {_cell(a["grader"])} | B = {_cell(b["grader"])} | Evidence |')
        env.print('|---|---|---|---|---|---|')
        for run_id, slot, item, va, vb, evidence in rows:
            env.print(f'| {run_id} | {slot} | {item} | {_cell(va)} | {_cell(vb)} | {_cell(evidence)} |')
    else:
        env.print(f'disputes: A = {a["grader"]}, B = {b["grader"]}')
        for run_id, slot, item, va, vb, evidence in rows:
            env.print(f'{run_id} {slot} {item}: A={va} B={vb}')
            if item == 'verdict':
                env.print(f'    {evidence}')
    env.print(f'{len(rows)} difference(s)')
    return 0


# -- key commitment ------------------------------------------------------------

def parse_commitment(text):
    """(sha256, size) read from the commitment's table; either is None when it is not a real value."""
    digest = size = None
    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if not line.lstrip().startswith('|') or len(cells) < 2:
            continue
        label, value = cells[0], cells[1]
        if re.search(r'sha-?256', label, re.I):
            match = re.search(r'\b[0-9a-fA-F]{64}\b', value)
            digest = match.group(0).lower() if match else None
        elif label.lower().strip('`') == 'size':
            match = re.search(r'\d[\d,]*', value)
            size = int(match.group(0).replace(',', '')) if match else None
    return digest, size


def verify_key(trial, env, key_path):
    """Compare an unsealed key with KEY-COMMITMENT.md. 0 match, 1 mismatch, 2 cannot be checked."""
    commitment = os.path.join(trial.dir, 'KEY-COMMITMENT.md')
    try:
        with open(commitment, encoding='utf-8') as fh:
            digest, size = parse_commitment(fh.read())
    except OSError as exc:
        env.print(f'verify-key: cannot read {commitment}: {exc}')
        return 2
    if digest is None or size is None:
        env.print(f'verify-key: {commitment} has no usable "SHA-256 of KEY.md" and "Size" rows '
                  f'(sha256 {"found" if digest else "missing"}, size {"found" if size is not None else "missing"}); '
                  'the key is not sealed, so nothing can be verified')
        return 2
    try:
        with open(env.expand(key_path), 'rb') as fh:
            content = fh.read()
    except OSError as exc:
        env.print(f'verify-key: cannot read the key {key_path}: {exc}')
        return 2
    actual = hashlib.sha256(content).hexdigest()
    same_digest, same_size = actual == digest, len(content) == size
    env.print(f'verify-key: {commitment}')
    env.print(f'  sha256  committed {digest}  actual {actual}  {"match" if same_digest else "MISMATCH"}')
    env.print(f'  size    committed {size}  actual {len(content)}  {"match" if same_size else "MISMATCH"}')
    if same_digest and same_size:
        env.print('  -> the key is the one sealed')
        return 0
    env.print('  -> MISMATCH: not the sealed key; report it as an incident and grade nothing from it')
    return 1
