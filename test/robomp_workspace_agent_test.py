from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "integrations" / "robomp" / "workspace_agent.py"
SPEC = importlib.util.spec_from_file_location("robomp_workspace_agent", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WorkspaceAgentTests(unittest.TestCase):
    def test_normalizes_request_and_deduplicates_context(self) -> None:
        result = MODULE.normalize_request({
            "version": 1,
            "operation": "ask",
            "issue": "owner/repo#12",
            "question": " Explain this change. ",
            "context": [
                {"kind": "file", "reference": "src/main.py"},
                {"kind": "file", "reference": "src/main.py"},
                {"kind": "commit", "reference": "a1b2c3d4"},
            ],
        })
        self.assertEqual(result["question"], "Explain this change.")
        self.assertEqual(result["context"], [
            {"kind": "issue", "reference": "owner/repo#12"},
            {"kind": "file", "reference": "src/main.py"},
            {"kind": "commit", "reference": "a1b2c3d4"},
        ])
        prompt = MODULE.build_prompt(result)
        self.assertIn("file: src/main.py", prompt)
        self.assertIn(MODULE.QUESTION_START, prompt)
        self.assertIn("Explain this change.", prompt)

    def test_rejects_unbounded_or_reserved_requests(self) -> None:
        base = {
            "version": 1,
            "operation": "ask",
            "issue": "owner/repo#12",
            "question": "question",
        }
        with self.assertRaisesRegex(MODULE.WorkspaceAssistantError, "repository-relative"):
            MODULE.normalize_request({
                **base,
                "context": [{"kind": "artifact", "reference": "../../secret"}],
            })
        with self.assertRaisesRegex(MODULE.WorkspaceAssistantError, "reserved transport marker"):
            MODULE.normalize_request({
                **base,
                "question": f"{MODULE.QUESTION_START}nested",
            })
        with self.assertRaisesRegex(MODULE.WorkspaceAssistantError, "version must be 1"):
            MODULE.normalize_request({**base, "version": True})

    def test_builds_reviewable_owner_mutations_without_executing_them(self) -> None:
        triage = MODULE.normalize_proposal({
            "action": "trigger.triage",
            "reason": "The issue is ready for another pass.",
        }, issue="owner/repo#12")
        self.assertEqual(triage["mutation"], {
            "version": 1,
            "action": "trigger.triage",
            "issue": "owner/repo#12",
        })
        audit = MODULE.normalize_proposal({
            "action": "audit.dream",
            "reason": "Inspect the repository.",
            "focus": "Authentication paths",
        }, issue="owner/repo#12")
        self.assertEqual(audit["mutation"]["repository"], "owner/repo")
        self.assertEqual(audit["mutation"]["focus"], "Authentication paths")
        with self.assertRaisesRegex(MODULE.WorkspaceAssistantError, "deliveryId"):
            MODULE.normalize_proposal({
                "action": "trigger.cancel",
                "reason": "Stop it.",
            }, issue="owner/repo#12")

    def test_resolves_selected_issue_run_file_and_artifact_context(self) -> None:
        with tempfile.TemporaryDirectory(prefix="robomp-assistant-context-") as raw:
            root = Path(raw)
            repo = root / "repo"
            artifacts = root / "artifacts"
            repo.mkdir()
            artifacts.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.invalid"], check=True)
            (repo / "src").mkdir()
            (repo / "src" / "main.py").write_text("print('one')\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "src/main.py"], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "initial"], check=True)
            (repo / "src" / "main.py").write_text("print('two')\n", encoding="utf-8")
            (artifacts / "report.md").write_text("# Result\nPassed.\n", encoding="utf-8")

            issue_row = SimpleNamespace(
                state="working",
                classification="bug",
                branch="robomp/12-fix",
                pr_number=27,
            )
            event_row = SimpleNamespace(
                issue_key="owner/repo#12",
                event_type="issues",
                state="failed",
                attempts=2,
            )
            database = SimpleNamespace(
                get_issue=lambda key: issue_row if key == "owner/repo#12" else None,
                get_event=lambda delivery: event_row if delivery == "delivery-1" else None,
            )
            request = MODULE.normalize_request({
                "version": 1,
                "operation": "ask",
                "issue": "owner/repo#12",
                "question": "What happened?",
                "context": [
                    {"kind": "file", "reference": "src/main.py"},
                    {"kind": "diff", "reference": "src/main.py"},
                    {"kind": "run", "reference": "delivery-1"},
                    {"kind": "artifact", "reference": "report.md"},
                ],
            })
            evidence = []
            details = MODULE.context_details(
                request,
                database=database,
                repo_dir=repo,
                workspace=SimpleNamespace(artifacts_dir=artifacts),
                evidence=evidence,
            )

        rendered = "\n".join(details)
        self.assertIn("state=working", rendered)
        self.assertIn("run delivery-1: type=issues; state=failed; attempts=2", rendered)
        self.assertIn("# Result", rendered)
        self.assertIn("src/main.py", rendered)
        self.assertIn("print('two')", rendered)
        self.assertIn("recent commits", rendered)
        self.assertEqual(evidence[0]["id"], "E1")
        self.assertEqual(evidence[0]["path"], "src/main.py")
        self.assertIn("[E1] src/main.py:1", rendered)

    def test_builds_bounded_opaque_diff_evidence(self) -> None:
        diff = """diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,4 @@ function main() {
   const a = 1
-  return a
+  const b = 2
+  return a + b
 }
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,2 @@
-# Old
+# New
 body
"""
        evidence = MODULE.build_diff_evidence(diff)
        self.assertEqual([item["id"] for item in evidence["items"]], ["E1", "E2"])
        self.assertEqual([item["path"] for item in evidence["items"]], ["src/app.ts", "README.md"])
        self.assertEqual(evidence["items"][0]["startLine"], 10)
        self.assertGreaterEqual(evidence["items"][0]["endLine"], 12)
        self.assertIn("const b = 2", evidence["items"][0]["text"])
        self.assertIn("[E1] src/app.ts:10-", MODULE.serialize_diff_evidence(evidence))
        clipped = MODULE.build_diff_evidence(diff, max_chars=60)
        self.assertEqual(len(clipped["items"]), 1)
        self.assertEqual(clipped["omitted"], 1)
        binary = MODULE.build_diff_evidence("diff --git a/x.png b/x.png\nBinary files differ\n")
        self.assertEqual(binary["items"], [])

    def test_collects_only_existing_repository_line_citations(self) -> None:
        with tempfile.TemporaryDirectory(prefix="robomp-assistant-sources-") as raw:
            root = Path(raw)
            source = root / "src" / "module.py"
            source.parent.mkdir()
            source.write_text("one\ntwo\nthree\n", encoding="utf-8")
            result = MODULE.collect_sources(
                "See src/module.py:2-3, src/module.py:2-3, ../secret:1, and missing.py:1.",
                root,
            )
        self.assertEqual(result, [{
            "id": "S1",
            "path": "src/module.py",
            "startLine": 2,
            "endLine": 3,
            "label": "src/module.py:2-3",
            "excerpt": "two\nthree",
        }])

    def test_collects_only_owner_supplied_opaque_evidence_ids(self) -> None:
        evidence = [{
            "id": "E1",
            "path": "src/module.py",
            "startLine": 8,
            "endLine": 10,
            "text": "@@ -8,2 +8,3 @@\n+fixed",
        }]
        result = MODULE.collect_sources("The selected change is supported by [E1], not [E9].", Path("."), evidence)
        self.assertEqual(result, [{
            "id": "E1",
            "path": "src/module.py",
            "startLine": 8,
            "endLine": 10,
            "label": "src/module.py:8-10",
            "excerpt": "@@ -8,2 +8,3 @@\n+fixed",
        }])


if __name__ == "__main__":
    unittest.main()
