"""tests/run.py's per-module floors: the roster checked both ways, and the count of tests each module started."""
import io
import unittest

import run


class FloorProblems(unittest.TestCase):
    def test_a_roster_that_matches_the_files_and_counts_has_no_problem(self):
        self.assertEqual(run.floor_problems({'test_a': 3}, {'test_a'}, {'test_a': 2}), [])

    def test_each_way_the_roster_can_be_wrong_is_one_problem(self):
        problems = run.floor_problems({'test_a': 1, 'test_b': 5}, {'test_a', 'test_b'}, {'test_a': 2, 'test_c': 1})
        self.assertEqual(problems, [
            'test_b.py has no entry in MIN_PER_MODULE; add one when adding a test file',
            'MIN_PER_MODULE names test_c, which is not a test_*.py file here',
            'test_a ran 1 tests (floor 2); its tests were removed or are not discovered'])


class CountingResultCounts(unittest.TestCase):
    def test_a_module_counts_the_tests_it_started_and_a_skipped_class_none(self):
        class Two(unittest.TestCase):
            def test_one(self):
                pass

            @unittest.skip('a skipped test still starts, as testsRun counts it')
            def test_two(self):
                pass

        class SkippedSetUp(unittest.TestCase):
            @classmethod
            def setUpClass(cls):
                raise unittest.SkipTest('the class set-up skips, so none of its tests starts')

            def test_three(self):
                pass

        load = unittest.defaultTestLoader.loadTestsFromTestCase
        suite = unittest.TestSuite([load(Two), load(SkippedSetUp)])
        result = unittest.TextTestRunner(stream=io.StringIO(), resultclass=run.CountingResult).run(suite)
        self.assertEqual(result.by_module, {'test_run': 2})
        self.assertEqual(result.testsRun, 2)
