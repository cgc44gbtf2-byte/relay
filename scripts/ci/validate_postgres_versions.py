#!/usr/bin/env python3
"""Enforce the PostgreSQL versions supported by the CI database runner."""

import json
import re
import sys
from pathlib import Path


# Change this tuple when changing the supported runner range; keep it contiguous.
SUPPORTED_VERSIONS = ("14", "15", "16")


def job_body(workflow: str, name: str) -> str:
    jobs = list(re.finditer(r"^  ([A-Za-z0-9_-]+):\s*$", workflow, re.MULTILINE))
    matches = [
        (index, match)
        for index, match in enumerate(jobs)
        if match.group(1) == name
    ]
    if len(matches) != 1:
        raise ValueError(f"Expected one {name} job, found {len(matches)}")
    index, match = matches[0]
    end = jobs[index + 1].start() if index + 1 < len(jobs) else len(workflow)
    return workflow[match.end():end]


def one_value(body: str, pattern: str, label: str) -> str:
    matches = re.findall(pattern, body, re.MULTILINE)
    if len(matches) != 1:
        raise ValueError(f"Expected one {label}, found {len(matches)}")
    return matches[0].strip()


def validate_workflow(workflow: str) -> tuple[str, ...]:
    expected = SUPPORTED_VERSIONS
    if tuple(range(int(expected[0]), int(expected[-1]) + 1)) != tuple(
        map(int, expected)
    ):
        raise ValueError(f"Supported PostgreSQL versions must be contiguous: {expected}")

    api = job_body(workflow, "api-tests")
    image = one_value(api, r"^        image:\s*(.+)$", "api-tests PostgreSQL image")
    baseline_match = re.fullmatch(r"postgres:([0-9]+)", image)
    if not baseline_match:
        raise ValueError(
            f"api-tests PostgreSQL image must pin a major version; found {image!r}"
        )
    baseline = baseline_match.group(1)

    compatibility = job_body(workflow, "database-runner-compatibility")
    raw_matrix = one_value(
        compatibility,
        r"^        postgres-version:\s*(.+)$",
        "database-runner-compatibility PostgreSQL matrix",
    )
    try:
        versions = json.loads(raw_matrix)
    except json.JSONDecodeError as error:
        raise ValueError(
            f"PostgreSQL matrix must be a JSON-style list of major versions: {raw_matrix}"
        ) from error
    if not isinstance(versions, list) or any(
        not isinstance(version, str) or not re.fullmatch(r"[0-9]+", version)
        for version in versions
    ):
        raise ValueError(f"Invalid PostgreSQL matrix versions: {versions!r}")
    matrix_image = one_value(
        compatibility, r"^        image:\s*(.+)$", "compatibility PostgreSQL image"
    )
    if matrix_image != "postgres:${{ matrix.postgres-version }}":
        raise ValueError(
            "Compatibility job must run every matrix PostgreSQL version; "
            f"image uses {matrix_image!r}"
        )

    if baseline != expected[-1] or versions != list(expected):
        raise ValueError(
            "PostgreSQL CI version mismatch: policy supports "
            f"{list(expected)} (baseline {expected[-1]}); "
            f"api-tests uses {baseline}; "
            f"database-runner-compatibility matrix uses {versions}. "
            "Update the policy and both jobs together."
        )
    return expected


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".github/workflows/ci.yml")
    try:
        versions = validate_workflow(path.read_text())
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    print(f"Validated PostgreSQL CI versions: {', '.join(versions)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())