#!/usr/bin/env python3
"""trialctl — prepare, check and collect controlled harness trial runs.

    python3 docs/reports/harness-evals/runner/trialctl.py --trial docs/reports/harness-evals/trial-2 <command> ...

Standard library only, no model calls. See README.md beside this file.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from trialkit.cli import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
