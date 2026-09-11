from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "integrations" / "robomp" / "workspace_inspect.py"
SPEC = importlib.util.spec_from_file_location("robomp_workspace_inspect", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WorkspaceInspectTests(unittest.TestCase):
    def fixture(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory(prefix="robomp-workspace-inspect-")
        data = Path(temporary.name)
        workspace = data / "workspaces" / "owner__repo__12"
        repository = workspace / "repo"
        (workspace / ".omp-session").mkdir(parents=True)
        (workspace / "context").mkdir()
        (workspace / "artifacts").mkdir()
        (workspace / "artifacts" / "report.md").write_text("report\n", encoding="utf-8")
        (workspace / ".omp-session" / "state.json").write_text("{}\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        subprocess.run(["git", "-C", str(repository), "config", "user.name", "Test"], check=True)
        subprocess.run(["git", "-C", str(repository), "config", "user.email", "test@example.invalid"], check=True)
        (repository / "README.md").write_text("# fixture\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repository), "add", "README.md"], check=True)
        subprocess.run(["git", "-C", str(repository), "commit", "-qm", "fixture"], check=True)
        (repository / "README.md").write_text("# changed\n", encoding="utf-8")

        connection = sqlite3.connect(data / "robomp.sqlite")
        connection.executescript(
            """
            CREATE TABLE issues (key TEXT PRIMARY KEY, repo TEXT, number INTEGER, branch TEXT,
              session_dir TEXT, pr_number INTEGER, state TEXT, classification TEXT, updated_at TEXT);
            CREATE TABLE events (delivery_id TEXT PRIMARY KEY, event_type TEXT, repo TEXT, issue_key TEXT,
              received_at TEXT, state TEXT, attempts INTEGER, last_error TEXT, started_at TEXT,
              finished_at TEXT, model TEXT);
            CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, issue_key TEXT, tool TEXT, args_json TEXT,
              result_json TEXT, error TEXT, ts TEXT);
            CREATE TABLE pr_review_comments (id INTEGER PRIMARY KEY, issue_key TEXT, path TEXT, line INTEGER,
              side TEXT, start_line INTEGER, start_side TEXT, body TEXT, created_at TEXT);
            CREATE TABLE issue_index (repo TEXT, number INTEGER, is_pr INTEGER, title TEXT, body TEXT,
              state TEXT, state_reason TEXT, merged_at TEXT, author TEXT, labels_json TEXT, comments INTEGER,
              created_at TEXT, updated_at TEXT, html_url TEXT);
            """
        )
        connection.execute(
            "INSERT INTO issues VALUES (?,?,?,?,?,?,?,?,?)",
            ("owner/repo#12", "owner/repo", 12, "robomp/12-fixture", str(workspace / ".omp-session"), None, "working", "bug", "now"),
        )
        connection.execute(
            "INSERT INTO issue_index VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("owner/repo", 12, 0, "Fixture issue", "Body", "open", "", "", "owner", "[]", 0, "now", "now", "https://example.invalid/12"),
        )
        connection.execute(
            "INSERT INTO tool_calls VALUES (?,?,?,?,?,?,?)",
            (1, "owner/repo#12", "read", json.dumps({"path": "README.md", "token": "sensitive"}), json.dumps({"ok": True}), None, "now"),
        )
        connection.commit()
        connection.close()
        return temporary, data

    def test_inspects_git_database_and_files_without_echoing_secrets(self) -> None:
        temporary, data = self.fixture()
        self.addCleanup(temporary.cleanup)
        result = MODULE.inspect("owner/repo#12", 20, data)
        self.assertEqual(result["schemaVersion"], "robomp.issue.workspace.v1")
        self.assertTrue(result["workspace"]["exists"])
        self.assertTrue(result["workspace"]["git"]["exists"])
        self.assertIn("README.md", result["workspace"]["git"]["diff"]["working"]["output"])
        self.assertEqual(result["database"]["issue"]["classification"], "bug")
        self.assertEqual(result["database"]["toolCalls"][0]["arguments"]["token"], "[configured]")
        self.assertEqual(result["workspace"]["artifacts"]["entries"][0]["path"], "report.md")

    def test_rejects_unbounded_issue_references(self) -> None:
        with self.assertRaisesRegex(ValueError, "owner/repository#123"):
            MODULE.inspect("../../etc/passwd", 20, Path("/tmp"))


if __name__ == "__main__":
    unittest.main()
