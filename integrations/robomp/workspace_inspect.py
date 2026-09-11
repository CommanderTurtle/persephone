#!/usr/bin/env python3
"""Read one native RoboOMP issue workspace for the Persephone owner UI.

The helper runs inside the RoboOMP container.  It performs bounded, read-only
SQLite, Git, session-directory, and artifact-directory inspection and emits one
versioned JSON document.  It does not contact GitHub or mutate a worktree.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from typing import Any


ISSUE_REFERENCE = re.compile(
    r"^(?P<owner>[A-Za-z0-9_.-]+)/(?P<repo>[A-Za-z0-9_.-]+)#(?P<number>[1-9][0-9]*)$"
)
SENSITIVE_KEY = re.compile(
    r"(?:authorization|cookie|password|secret|token|api[_-]?key|credential)", re.I
)
MAX_TEXT = 500_000
MAX_FIELD = 30_000


def bounded_text(value: str | None, maximum: int = MAX_FIELD) -> str | None:
    if value is None or len(value) <= maximum:
        return value
    removed = len(value) - maximum
    return f"{value[:maximum]}\n… {removed} characters omitted"


def decode_json(value: str | None) -> Any:
    if value is None:
        return None
    try:
        return redact(json.loads(value))
    except (json.JSONDecodeError, TypeError):
        return bounded_text(value)


def redact(value: Any, key: str = "") -> Any:
    if SENSITIVE_KEY.search(key):
        return "[configured]" if value not in (None, "", False) else None
    if isinstance(value, dict):
        return {str(item): redact(content, str(item)) for item, content in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value[:500]]
    if isinstance(value, str):
        return bounded_text(value)
    return value


def run_git(repo: Path, arguments: list[str], timeout: float = 10.0) -> dict[str, Any]:
    environment = os.environ.copy()
    environment.update(
        {
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "safe.directory",
            "GIT_CONFIG_VALUE_0": str(repo),
        }
    )
    try:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=repo,
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"ok": False, "status": None, "output": "", "error": str(error)}
    output = completed.stdout
    if len(output) > MAX_TEXT:
        output = f"{output[:MAX_TEXT]}\n… {len(completed.stdout) - MAX_TEXT} characters omitted"
    return {
        "ok": completed.returncode == 0,
        "status": completed.returncode,
        "output": output.rstrip(),
        "error": bounded_text(completed.stderr.strip(), 10_000) or None,
    }


class ReadOnlyDatabase:
    def __init__(self, filename: Path) -> None:
        self.filename = filename
        self.connection: sqlite3.Connection | None = None
        self.tables: set[str] = set()
        if not filename.is_file():
            return
        uri = f"file:{filename.as_posix()}?mode=ro"
        self.connection = sqlite3.connect(uri, uri=True)
        self.connection.row_factory = sqlite3.Row
        self.tables = {
            str(row[0])
            for row in self.connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
            )
        }

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()

    def one(self, table: str, sql: str, params: tuple[Any, ...]) -> dict[str, Any] | None:
        rows = self.all(table, sql, params, 1)
        return rows[0] if rows else None

    def all(
        self,
        table: str,
        sql: str,
        params: tuple[Any, ...],
        limit: int,
    ) -> list[dict[str, Any]]:
        if self.connection is None or table not in self.tables:
            return []
        rows = self.connection.execute(sql, (*params, limit)).fetchall()
        return [dict(row) for row in rows]


def directory_manifest(directory: Path, limit: int) -> dict[str, Any]:
    if not directory.is_dir():
        return {"exists": False, "entries": [], "truncated": False}
    entries: list[dict[str, Any]] = []
    truncated = False
    for item in sorted(directory.rglob("*"), key=lambda entry: entry.as_posix()):
        if len(entries) >= limit:
            truncated = True
            break
        try:
            if item.is_symlink():
                kind = "symlink"
                size = 0
            elif item.is_dir():
                continue
            elif item.is_file():
                kind = "file"
                size = item.stat().st_size
            else:
                continue
            stat = item.lstat()
            entries.append(
                {
                    "path": item.relative_to(directory).as_posix(),
                    "kind": kind,
                    "size": size,
                    "modifiedAt": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(),
                }
            )
        except OSError:
            continue
    return {"exists": True, "entries": entries, "truncated": truncated}


def git_snapshot(repo: Path, limit: int) -> dict[str, Any]:
    if not (repo / ".git").exists():
        return {"exists": False}
    branch = run_git(repo, ["branch", "--show-current"])
    head = run_git(repo, ["rev-parse", "HEAD"])
    remote_head = run_git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
    base_ref = remote_head["output"] if remote_head["ok"] else ""
    merge_base = run_git(repo, ["merge-base", "HEAD", base_ref]) if base_ref else {"ok": False, "output": ""}
    base = str(merge_base.get("output") or "")

    log = run_git(
        repo,
        [
            "log",
            f"--max-count={limit}",
            "--date=iso-strict",
            "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e",
        ],
    )
    commits = []
    if log["ok"]:
        for record in str(log["output"]).split("\x1e"):
            fields = record.strip().split("\x1f")
            if len(fields) == 6:
                commits.append(
                    dict(
                        zip(
                            ("hash", "shortHash", "author", "email", "date", "subject"),
                            fields,
                            strict=True,
                        )
                    )
                )

    refs = run_git(
        repo,
        [
            "for-each-ref",
            f"--count={limit}",
            "--sort=-committerdate",
            "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(committerdate:iso-strict)",
            "refs/heads",
            "refs/remotes/origin",
        ],
    )
    branches = []
    if refs["ok"]:
        for line in str(refs["output"]).splitlines():
            fields = line.split("\0")
            if len(fields) == 4:
                branches.append(dict(zip(("name", "hash", "upstream", "date"), fields, strict=True)))

    comparison = f"{base}...HEAD" if base else "HEAD"
    committed_names = run_git(repo, ["diff", "--name-status", comparison]) if base else {"ok": True, "output": ""}
    working_names = run_git(repo, ["diff", "--name-status", "HEAD"])
    untracked = run_git(repo, ["ls-files", "--others", "--exclude-standard"])
    files: list[dict[str, str]] = []
    seen: set[str] = set()
    for source, label in ((committed_names, "committed"), (working_names, "working")):
        if not source.get("ok"):
            continue
        for line in str(source.get("output") or "").splitlines():
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            filename = parts[-1]
            identity = f"{label}:{filename}"
            if identity not in seen:
                files.append({"state": parts[0], "path": filename, "scope": label})
                seen.add(identity)
    if untracked["ok"]:
        for filename in str(untracked["output"]).splitlines():
            identity = f"untracked:{filename}"
            if filename and identity not in seen:
                files.append({"state": "?", "path": filename, "scope": "untracked"})
                seen.add(identity)

    committed_diff = run_git(repo, ["diff", "--no-ext-diff", "--unified=3", comparison]) if base else {"ok": True, "output": ""}
    working_diff = run_git(repo, ["diff", "--no-ext-diff", "--unified=3", "HEAD"])
    status = run_git(repo, ["status", "--short", "--branch", "--untracked-files=all"])
    return {
        "exists": True,
        "branch": branch["output"] if branch["ok"] else None,
        "head": head["output"] if head["ok"] else None,
        "baseRef": base_ref or None,
        "mergeBase": base or None,
        "status": status,
        "branches": branches,
        "commits": commits,
        "files": files[: max(limit * 4, 200)],
        "diff": {
            "committed": committed_diff,
            "working": working_diff,
        },
    }


def database_snapshot(database: ReadOnlyDatabase, key: str, repo: str, number: int, limit: int) -> dict[str, Any]:
    issue = database.one("issues", "SELECT * FROM issues WHERE key=? LIMIT ?", (key,))
    indexed = database.one(
        "issue_index",
        "SELECT repo,number,is_pr,title,body,state,state_reason,merged_at,author,labels_json,comments,created_at,updated_at,html_url FROM issue_index WHERE repo=? AND number=? LIMIT ?",
        (repo, number),
    )
    if indexed:
        indexed["body"] = bounded_text(indexed.get("body"))
        indexed["labels"] = decode_json(indexed.pop("labels_json", None))
    events = database.all(
        "events",
        "SELECT delivery_id,event_type,repo,issue_key,received_at,state,attempts,last_error,started_at,finished_at,model FROM events WHERE issue_key=? ORDER BY received_at DESC LIMIT ?",
        (key,),
        limit,
    )
    tools = database.all(
        "tool_calls",
        "SELECT id,issue_key,tool,args_json,result_json,error,ts FROM tool_calls WHERE issue_key=? ORDER BY id DESC LIMIT ?",
        (key,),
        limit,
    )
    for tool in tools:
        tool["arguments"] = decode_json(tool.pop("args_json", None))
        tool["result"] = decode_json(tool.pop("result_json", None))
        tool["error"] = bounded_text(tool.get("error"))
    comments = database.all(
        "pr_review_comments",
        "SELECT id,issue_key,path,line,side,start_line,start_side,body,created_at FROM pr_review_comments WHERE issue_key=? ORDER BY id DESC LIMIT ?",
        (key,),
        limit,
    )
    for comment in comments:
        comment["body"] = bounded_text(comment.get("body"))
    return {"issue": issue, "indexed": indexed, "events": events, "toolCalls": tools, "reviewComments": comments}


def inspect(issue_reference: str, limit: int, data_root: Path) -> dict[str, Any]:
    match = ISSUE_REFERENCE.fullmatch(issue_reference)
    if match is None:
        raise ValueError("issue must be owner/repository#123")
    owner = match.group("owner")
    repository = match.group("repo")
    number = int(match.group("number"))
    repo_full = f"{owner}/{repository}"
    issue_key = f"{repo_full}#{number}"
    workspace = data_root / "workspaces" / f"{owner}__{repository}__{number}"
    database = ReadOnlyDatabase(data_root / "robomp.sqlite")
    try:
        db = database_snapshot(database, issue_key, repo_full, number, limit)
    finally:
        database.close()
    return {
        "schemaVersion": "robomp.issue.workspace.v1",
        "generatedAt": datetime.now(UTC).isoformat(),
        "reference": issue_reference,
        "workspace": {
            "exists": workspace.is_dir(),
            "key": workspace.name,
            "git": git_snapshot(workspace / "repo", limit),
            "session": directory_manifest(workspace / ".omp-session", limit),
            "context": directory_manifest(workspace / "context", limit),
            "artifacts": directory_manifest(workspace / "artifacts", limit),
        },
        "database": db,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect one RoboOMP issue workspace without modifying it.")
    parser.add_argument("issue", help="owner/repository#123")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--data-root", type=Path, default=Path("/data"), help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    if not 1 <= arguments.limit <= 200:
        parser.error("--limit must be from 1 to 200")
    print(json.dumps(inspect(arguments.issue, arguments.limit, arguments.data_root), indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, sqlite3.Error, ValueError) as error:
        print(json.dumps({"schemaVersion": "robomp.issue.workspace.error.v1", "error": str(error)}))
        raise SystemExit(1) from error
