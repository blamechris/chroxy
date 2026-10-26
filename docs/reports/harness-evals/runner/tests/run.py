#!/usr/bin/env python3
"""Run the trialctl test suite and fail when too few tests ran.

    python3 docs/reports/harness-evals/runner/tests/run.py

`unittest` exits 0 on a green run whatever the count, so a suite whose files stop
being discovered would pass silently (docs/false-safety-guards.md, #7653). This
runner discovers every `test_*.py` here and exits 1 unless at least MIN_TESTS ran
and none failed. MIN_TESTS is a floor, not today's count.

The total alone hides one file going missing while the rest grow, so every
`test_*.py` also has a floor in MIN_PER_MODULE, and the roster is checked both
ways: a test file with no entry fails (a new file needs one), an entry that names
no file fails, and a module that ran fewer tests than its floor fails. A module's
count is the tests that started, as `testsRun` counts them (a test skipped by a
decorator starts; a class or module whose set-up skips or fails starts none).
"""
import os
import sys
import unittest

MIN_TESTS = 540
# About 60% of each module's count when the floor was set: a lost file, or a module cut below 60%, fails.
# One class of a large module can go missing above its floor; the floor is for a file, not a class.
MIN_PER_MODULE = {
    'test_collect': 67,
    'test_core': 43,
    'test_evidence': 73,
    'test_extract': 72,
    'test_launch': 221,
    'test_measures': 9,
    'test_native': 18,
    'test_queue': 43,
    'test_run': 1,
    'test_status': 2,
    'test_verdicts': 16,
    'test_workflow': 6,
}
HERE = os.path.dirname(os.path.abspath(__file__))


class CountingResult(unittest.TextTestResult):
    """A text result that also counts, in `by_module`, the tests each module started."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.by_module = {}

    def startTest(self, test):
        super().startTest(test)
        module = test.id().split('.')[0]
        self.by_module[module] = self.by_module.get(module, 0) + 1


def floor_problems(counts, files, floors):
    """One line for each test file with no floor, floor with no file, and module under its floor."""
    problems = [f'{name}.py has no entry in MIN_PER_MODULE; add one when adding a test file'
                for name in sorted(files) if name not in floors]
    problems += [f'MIN_PER_MODULE names {name}, which is not a test_*.py file here'
                 for name in sorted(floors) if name not in files]
    problems += [f'{name} ran {counts.get(name, 0)} tests (floor {floor}); its tests were removed or are not discovered'
                 for name, floor in sorted(floors.items()) if name in files and counts.get(name, 0) < floor]
    return problems


def main():
    sys.path.insert(0, os.path.dirname(HERE))
    sys.path.insert(0, HERE)
    suite = unittest.defaultTestLoader.discover(HERE, pattern='test_*.py', top_level_dir=HERE)
    result = unittest.TextTestRunner(verbosity=1, resultclass=CountingResult).run(suite)
    ran = result.testsRun
    if not result.wasSuccessful():
        return 1
    if ran < MIN_TESTS:
        print(f'FAIL: only {ran} tests ran (floor {MIN_TESTS}); discovery is broken or tests were removed',
              file=sys.stderr)
        return 1
    files = {f[:-3] for f in os.listdir(HERE) if f.startswith('test_') and f.endswith('.py')}
    problems = floor_problems(result.by_module, files, MIN_PER_MODULE)
    for problem in problems:
        print(f'FAIL: {problem}', file=sys.stderr)
    if problems:
        return 1
    print(f'{ran} tests ran (floor {MIN_TESTS}); every module ran at least its floor')
    return 0


if __name__ == '__main__':
    sys.exit(main())
