#!/usr/bin/env python3
"""Validate concurrency isolation for jobs that use the shared Clerk tenant."""

import re
import sys
from pathlib import Path


def validate_workflow(workflow: str) -> dict[str, dict[str, str | bool | None]]:
    jobs: dict[str, dict[str, str | bool | None]] = {}
    current_job = None

    for line in workflow.splitlines():
        job_match = re.match(r"^  ([A-Za-z0-9_-]+):$", line)
        if job_match:
            current_job = job_match.group(1)
            jobs[current_job] = {
                "uses_clerk": False,
                "group": None,
                "cancel_in_progress": None,
            }
            continue

        if current_job is None:
            continue

        if re.match(r"^      CLERK_[A-Za-z0-9_]+:", line):
            jobs[current_job]["uses_clerk"] = True
        elif re.match(r"^      group:", line):
            jobs[current_job]["group"] = line.split(":", 1)[1].strip()
        elif re.match(r"^      cancel-in-progress:", line):
            jobs[current_job]["cancel_in_progress"] = line.split(":", 1)[1].strip()

    clerk_jobs = {
        name: settings
        for name, settings in jobs.items()
        if settings["uses_clerk"]
    }

    if len(clerk_jobs) < 2:
        raise ValueError(
            "Expected at least two Clerk-using jobs, found "
            f"{len(clerk_jobs)}: {', '.join(clerk_jobs) or 'none'}"
        )

    missing_concurrency = [
        name
        for name, settings in clerk_jobs.items()
        if settings["group"] is None or settings["cancel_in_progress"] is None
    ]
    if missing_concurrency:
        raise ValueError(
            "Clerk-using jobs must define concurrency settings: "
            + ", ".join(missing_concurrency)
        )

    required_jobs = {"api-tests", "cleanup-abandoned-test-users"}
    missing_required_jobs = required_jobs - clerk_jobs.keys()
    if missing_required_jobs:
        raise ValueError(
            "Expected Clerk-using jobs are missing: "
            + ", ".join(sorted(missing_required_jobs))
        )

    if clerk_jobs["api-tests"]["group"] == clerk_jobs[
        "cleanup-abandoned-test-users"
    ]["group"]:
        details = ", ".join(
            f"{name}={settings['group']}" for name, settings in clerk_jobs.items()
        )
        raise ValueError(
            "API tests and scheduled cleanup must use separate Clerk "
            "concurrency groups: " + details
        )

    cancellation_enabled = [
        name
        for name, settings in clerk_jobs.items()
        if settings["cancel_in_progress"].lower() != "false"
    ]
    if cancellation_enabled:
        raise ValueError(
            "Clerk-using jobs must keep cancel-in-progress disabled: "
            + ", ".join(cancellation_enabled)
        )

    return clerk_jobs


def main() -> int:
    workflow_path = (
        Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".github/workflows/ci.yml")
    )
    try:
        clerk_jobs = validate_workflow(workflow_path.read_text())
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1

    print("Validated Clerk concurrency for: " + ", ".join(clerk_jobs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
