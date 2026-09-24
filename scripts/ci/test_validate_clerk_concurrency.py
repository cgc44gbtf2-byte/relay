"""Regression tests for the CI Clerk concurrency policy."""

import unittest
from pathlib import Path

from validate_clerk_concurrency import validate_workflow


WORKFLOW_PATH = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"


class ClerkConcurrencyValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workflow = WORKFLOW_PATH.read_text()

    def test_current_workflow_is_valid(self) -> None:
        jobs = validate_workflow(self.workflow)

        self.assertIn("api-tests", jobs)
        self.assertIn("cleanup-abandoned-test-users", jobs)

    def test_rejects_matching_concurrency_groups(self) -> None:
        api_group = (
            "group: ${{ github.repository }}-clerk-api-test-environment"
        )
        cleanup_group = (
            "group: ${{ github.repository }}-clerk-cleanup-test-environment"
        )
        self.assertIn(api_group, self.workflow)
        unsafe_workflow = self.workflow.replace(api_group, cleanup_group, 1)

        with self.assertRaisesRegex(
            ValueError, "must use separate Clerk concurrency groups"
        ):
            validate_workflow(unsafe_workflow)

    def test_rejects_enabled_cancellation(self) -> None:
        safe_setting = "cancel-in-progress: false"
        self.assertIn(safe_setting, self.workflow)
        unsafe_workflow = self.workflow.replace(
            safe_setting, "cancel-in-progress: true", 1
        )

        with self.assertRaisesRegex(
            ValueError, "keep cancel-in-progress disabled"
        ):
            validate_workflow(unsafe_workflow)


if __name__ == "__main__":
    unittest.main()
