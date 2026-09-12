from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


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


if __name__ == "__main__":
    unittest.main()
