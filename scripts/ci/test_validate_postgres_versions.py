"""Regression tests for PostgreSQL CI version policy."""

import unittest
from pathlib import Path

from validate_postgres_versions import validate_workflow


WORKFLOW_PATH = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"


class PostgresVersionValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workflow = WORKFLOW_PATH.read_text()

    def test_current_workflow_preserves_14_to_16_coverage(self) -> None:
        self.assertEqual(validate_workflow(self.workflow), ("14", "15", "16"))

    def test_rejects_api_matrix_that_drops_oldest_version(self) -> None:
        changed = self.workflow.replace('["14", "15", "16"]', '["15", "16"]', 1)
        with self.assertRaisesRegex(
            ValueError, r"api-tests matrix uses \['15', '16'\].*matrix uses \['14', '15', '16'\]"
        ):
            validate_workflow(changed)

    def test_rejects_dropped_compatibility_floor(self) -> None:
        prefix, separator, compatibility = self.workflow.partition(
            "  database-runner-compatibility:"
        )
        changed = prefix + separator + compatibility.replace(
            '["14", "15", "16"]', '["15", "16"]', 1
        )
        with self.assertRaisesRegex(
            ValueError, r"policy supports \['14', '15', '16'\].*matrix uses \['15', '16'\]"
        ):
            validate_workflow(changed)

    def test_rejects_missing_middle_version(self) -> None:
        changed = self.workflow.replace('["14", "15", "16"]', '["14", "16"]', 2)
        with self.assertRaisesRegex(ValueError, "PostgreSQL CI version mismatch"):
            validate_workflow(changed)

    def test_rejects_missing_api_matrix(self) -> None:
        changed = self.workflow.replace(
            'postgres-version: ["14", "15", "16"]',
            'other-version: ["14", "15", "16"]',
            1,
        )
        with self.assertRaisesRegex(ValueError, "Expected one api-tests PostgreSQL matrix"):
            validate_workflow(changed)

    def test_rejects_missing_compatibility_matrix(self) -> None:
        prefix, separator, compatibility = self.workflow.partition(
            "  database-runner-compatibility:"
        )
        changed = prefix + separator + compatibility.replace(
            'postgres-version: ["14", "15", "16"]',
            'other-version: ["14", "15", "16"]',
            1,
        )
        with self.assertRaisesRegex(
            ValueError, "Expected one database-runner-compatibility PostgreSQL matrix"
        ):
            validate_workflow(changed)

    def test_rejects_matrix_that_does_not_control_service_image(self) -> None:
        changed = self.workflow.replace(
            "image: postgres:${{ matrix.postgres-version }}",
            "image: postgres:16",
            1,
        )
        with self.assertRaisesRegex(ValueError, "must run every matrix PostgreSQL version"):
            validate_workflow(changed)

    def test_rejects_api_job_without_version_label(self) -> None:
        changed = self.workflow.replace(
            "CI_TEST_DATABASE_VERSION: ${{ matrix.postgres-version }}",
            "CI_TEST_DATABASE_VERSION: 16",
            1,
        )
        with self.assertRaisesRegex(ValueError, "must label failures"):
            validate_workflow(changed)

    def test_rejects_parallel_clerk_matrix(self) -> None:
        changed = self.workflow.replace("max-parallel: 1", "max-parallel: 3", 1)
        with self.assertRaisesRegex(ValueError, "serialize its shared Clerk"):
            validate_workflow(changed)


if __name__ == "__main__":
    unittest.main()