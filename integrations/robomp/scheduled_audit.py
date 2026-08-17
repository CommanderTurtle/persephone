#!/usr/bin/env python3
"""Create one bounded RoboOMP audit issue from inside the GitHub proxy.

The helper intentionally owns no agent behavior.  It only performs the one
GitHub mutation that native RoboOMP does not expose: seeding an enhancement
issue for its existing manual-triage path.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import json
import os
import re
import sys

import httpx


REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TITLE_PREFIX = "[Persephone audit]"


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"scheduled audit: {message}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create one proposal-only audit issue unless one is already open."
    )
    parser.add_argument("repository", help="GitHub owner/repository")
    parser.add_argument(
        "--focus",
        default="",
        help="Optional bounded area to inspect; this does not authorize implementation.",
    )
    args = parser.parse_args()

    if not REPOSITORY.fullmatch(args.repository):
        fail("repository must be owner/name")

    token = os.environ.get("GITHUB_TOKEN", "").strip()
    expected_login = os.environ.get("ROBOMP_BOT_LOGIN", "").strip()
    if not token:
        fail("GITHUB_TOKEN is unavailable in the credential proxy")
    if not expected_login:
        fail("ROBOMP_BOT_LOGIN is unavailable in the credential proxy")

    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "persephone-robomp-scheduled-audit",
    }
    with httpx.Client(
        base_url="https://api.github.com", headers=headers, timeout=30.0
    ) as client:
        identity = client.get("/user")
        identity.raise_for_status()
        actual_login = str(identity.json().get("login", ""))
        if actual_login.casefold() != expected_login.casefold():
            fail(
                f"token belongs to {actual_login or '(unknown)'}, expected {expected_login}"
            )

        issues = client.get(
            f"/repos/{args.repository}/issues",
            params={"state": "open", "creator": actual_login, "per_page": 100},
        )
        issues.raise_for_status()
        for issue in issues.json():
            if "pull_request" not in issue and str(issue.get("title", "")).startswith(
                TITLE_PREFIX
            ):
                print(
                    json.dumps(
                        {
                            "created": False,
                            "number": issue["number"],
                            "url": issue["html_url"],
                            "reason": "an open Persephone audit already exists",
                        }
                    )
                )
                return 0

        focus = args.focus.strip()
        focus_block = (
            f"\n\nBounded focus requested by the operator: **{focus}**" if focus else ""
        )
        body = (
            "Perform one bounded repository audit and identify one concrete, "
            "evidence-backed improvement. Comment with the rationale, exact files, "
            "risk analysis, and verification plan. This issue is proposal-only: do "
            "not edit, push, or open a pull request until a configured maintainer "
            "explicitly directs `@Persephone implement` in this issue. Prefer no "
            "proposal over speculative churn."
            f"{focus_block}\n\n"
            "This issue was seeded by Persephone's local scheduler and is processed "
            "by native RoboOMP."
        )
        created = client.post(
            f"/repos/{args.repository}/issues",
            json={
                "title": f"{TITLE_PREFIX} {datetime.now(UTC):%Y-%m-%d}",
                "body": body,
            },
        )
        created.raise_for_status()
        issue = created.json()
        print(
            json.dumps(
                {
                    "created": True,
                    "number": issue["number"],
                    "url": issue["html_url"],
                }
            )
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except httpx.HTTPStatusError as exc:
        response = exc.response
        detail = response.text[:1000].replace("\n", " ")
        print(
            f"scheduled audit: GitHub returned {response.status_code}: {detail}",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc
