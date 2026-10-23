#!/usr/bin/env python3
"""Run the trialctl test suite and fail when too few tests ran.

    python3 docs/reports/harness-evals/runner/tests/run.py

`unittest` exits 0 on a green run whatever the count, so a suite whose files stop
being discovered would pass silently (docs/false-safety-guards.md, #7653). This
runner discovers every `test_*.py` here and exits 1 unless at least MIN_TESTS ran
and none failed. MIN_TESTS is a floor, not today's count.
"""
import os
import sys
import unittest

MIN_TESTS = 300
HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    sys.path.insert(0, os.path.dirname(HERE))
    sys.path.insert(0, HERE)
    suite = unittest.defaultTestLoader.discover(HERE, pattern='test_*.py', top_level_dir=HERE)
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    ran = result.testsRun
    if not result.wasSuccessful():
        return 1
    if ran < MIN_TESTS:
        print(f'FAIL: only {ran} tests ran (floor {MIN_TESTS}); discovery is broken or tests were removed',
              file=sys.stderr)
        return 1
    print(f'{ran} tests ran (floor {MIN_TESTS})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
