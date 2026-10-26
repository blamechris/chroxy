"""One bounded native Settings comparison, never an app-suite acceptance run."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ['RUNNER_TEMP']) / 'maestro-diagnostics'
OUT.mkdir(parents=True, exist_ok=True)
DEVICE = os.environ['DEVICE']
assert re.fullmatch(r'[0-9A-Fa-f-]{36}', DEVICE)
START = time.monotonic()
DEADLINE = START + 1200
RESULT = {'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
          'device': DEVICE, 'scope': 'Settings-only diagnostic; no application acceptance', 'commands': []}


def save():
    (OUT / 'result.json').write_text(json.dumps(RESULT, indent=2) + '\n')


def run(label, args, ceiling=240):
    remaining = DEADLINE - time.monotonic()
    assert remaining > 30, 'diagnostic deadline reached'
    limit = min(ceiling, int(remaining - 20))
    target = OUT / (label + '.log')
    start = time.monotonic()
    with target.open('w') as log:
        proc = subprocess.Popen(args, cwd=OUT, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = proc.wait(timeout=limit)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
            code = 124
    entry = {'label': label, 'exit': code, 'seconds': round(time.monotonic() - start, 3), 'ceiling': limit}
    RESULT['commands'].append(entry)
    save()
    print(json.dumps(entry), flush=True)
    print(target.read_text(errors='replace')[-2500:], flush=True)
    return code


def flow(label, text):
    path = OUT / (label + '.yaml')
    path.write_text(text)
    return run(label, ['maestro', 'test', '--device', DEVICE, '--test-output-dir', str(OUT / label),
                       '--debug-output', str(OUT / label), str(path)], 300)


def hierarchy(label):
    assert run(label, ['maestro', '--device', DEVICE, 'hierarchy'], 60) == 0
    text = (OUT / (label + '.log')).read_text()
    tree = json.loads(text[text.index('{'):])
    (OUT / (label + '.json')).write_text(json.dumps(tree, indent=2) + '\n')
    observed = []

    def walk(node, parents):
        attrs = node.get('attributes', {})
        if attrs.get('resource-id') in {'AUTOFILL', 'DICTIONARY', 'AutoFillToggle'}:
            observed.append({'attributes': attrs, 'parents': [p.get('attributes', {}) for p in parents[-4:]]})
        for child in node.get('children', []):
            walk(child, parents + [node])

    walk(tree, [])
    RESULT[label] = observed
    save()
    print('OBSERVED_GEOMETRY ' + json.dumps(observed), flush=True)
    assert run(label + '-screen', ['xcrun', 'simctl', 'io', DEVICE, 'screenshot', str(OUT / (label + '.png'))], 30) == 0
    return observed


original = (ROOT / 'packages/app/.maestro/setup/disable-password-autofill.yaml').read_text()
old_tap = '      - tapOn:\n          id: AUTOFILL\n          index: 0'
assert original.count(old_tap) == 1
candidate = original.replace(old_tap, '      - waitForAnimationToEnd:\n          timeout: 10000\n' + old_tap)
RESULT['sources'] = {name: hashlib.sha256(text.encode()).hexdigest() for name, text in [('original', original), ('candidate', candidate)]}
RESULT['baseline_exit'] = flow('original', original)
hierarchy('after-original')

# Observe the complete General hierarchy without a coordinate-based tap.
general = '''appId: com.apple.Preferences
name: Observe General page geometry
---
- launchApp
- repeat:
    times: 3
    commands:
      - runFlow:
          when:
            visible:
              id: BackButton
          commands:
            - tapOn:
                id: BackButton
            - waitForAnimationToEnd
- tapOn:
    id: com.apple.settings.general
- assertVisible:
    id: AUTOFILL
- takeScreenshot: general-before-selector-comparison
'''
assert flow('general-observation', general) == 0
hierarchy('general-geometry')

RESULT['candidate_exit'] = flow('candidate', candidate)
if RESULT['candidate_exit'] != 0:
    hierarchy('after-candidate-failure')
    raise AssertionError('settled navigation did not establish OFF')
observed = hierarchy('after-candidate')
assert any(x['attributes'].get('resource-id') == 'AutoFillToggle' and x['attributes'].get('checked') == 'false' for x in observed)
assert flow('candidate-already-off', candidate) == 0

# Native negative control: leave the setting ON and remove only the switch tap.
restore = '''appId: com.apple.Preferences
name: Restore ON for the native negative control
---
- assertVisible:
    id: AutoFillToggle
    checked: false
- tapOn:
    id: AutoFillToggle
    point: 88%,50%
- waitForAnimationToEnd
- assertVisible:
    id: AutoFillToggle
    checked: true
'''
assert flow('restore-on', restore) == 0
tap = '      - tapOn:\n          id: AutoFillToggle\n          point: 88%,50%\n'
assert candidate.count(tap) == 1
mutant = candidate.replace(tap, '')
RESULT['deleted_switch_tap_exit'] = flow('deleted-switch-tap', mutant)
assert RESULT['deleted_switch_tap_exit'] == 1, 'negative control must fail its assertion, not time out/crash'
negative = hierarchy('after-deleted-tap')
assert any(x['attributes'].get('resource-id') == 'AutoFillToggle' and x['attributes'].get('checked') == 'true' for x in negative)
assert 'Assertion is false' in (OUT / 'deleted-switch-tap.log').read_text()
assert flow('restored-candidate', candidate) == 0
final = hierarchy('final-off')
assert any(x['attributes'].get('resource-id') == 'AutoFillToggle' and x['attributes'].get('checked') == 'false' for x in final)
RESULT.update(completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
              seconds=round(time.monotonic() - START, 3), candidate_controls_passed=True)
save()
print('SETTINGS_DIAGNOSTIC_COMPLETE', flush=True)
