#!/usr/bin/env python3
"""Owner-side OMP assistant for an existing RoboOMP issue workspace.

The browser never receives a shell or filesystem handle.  Persephone passes a
validated request to this helper inside the RoboOMP container; the helper then
opens a separate OMP session in the issue worktree.  Only read-oriented OMP
tools are exposed.  Selected Git state is resolved by this owner process, so
requested changes become typed owner proposals instead of repository writes.
"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Mapping


SCHEMA_VERSION = "persephone.robomp.assistant.v1"
MAX_REQUEST_BYTES = 1_000_000
MAX_QUESTION_CHARS = 32_000
MAX_CONTEXT_ITEMS = 16
MAX_MESSAGES = 80
MAX_MESSAGE_CHARS = 32_000
MAX_SOURCES = 32
MAX_CONTEXT_DETAIL_CHARS = 4_000
QUESTION_START = "<diogenes-roboomp-question>"
QUESTION_END = "</diogenes-roboomp-question>"
ISSUE_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[1-9][0-9]*$")
SAFE_PATH_RE = re.compile(r"^[^\x00\r\n]+$")
REVISION_RE = re.compile(r"^[0-9a-fA-F]{4,40}$")
SOURCE_RE = re.compile(r"(?<![A-Za-z0-9_./-])([A-Za-z0-9_.@+/-]+):(\d+)(?:-(\d+))?")
CONTEXT_KINDS = frozenset({"issue", "diff", "file", "commit", "pull_request", "run", "log", "artifact"})
PROPOSAL_ACTIONS = frozenset({
    "trigger.triage",
    "trigger.retry",
    "trigger.cancel",
    "issue.cleanup",
    "audit.dream",
})


class WorkspaceAssistantError(RuntimeError):
    """A request cannot be handled inside the selected RoboOMP workspace."""


def _record(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WorkspaceAssistantError(f"{field} must be an object")
    return dict(value)


def _text(value: object, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
        raise WorkspaceAssistantError(f"{field} must be a non-empty string of at most {maximum} characters")
    return value.strip()


def normalize_request(value: object) -> dict[str, Any]:
    payload = _record(value, "request")
    if type(payload.get("version")) is not int or payload.get("version") != 1:
        raise WorkspaceAssistantError("request version must be 1")
    operation = payload.get("operation", "ask")
    if operation not in {"ask", "history"}:
        raise WorkspaceAssistantError("operation must be ask or history")
    issue = _text(payload.get("issue"), "issue", 500)
    if not ISSUE_RE.fullmatch(issue):
        raise WorkspaceAssistantError("issue must be owner/repository#123")

    question = ""
    if operation == "ask":
        question = _text(payload.get("question"), "question", MAX_QUESTION_CHARS)
        if QUESTION_START in question or QUESTION_END in question:
            raise WorkspaceAssistantError("question contains a reserved transport marker")

    raw_context = payload.get("context", [])
    if not isinstance(raw_context, list) or len(raw_context) > MAX_CONTEXT_ITEMS:
        raise WorkspaceAssistantError(f"context must contain at most {MAX_CONTEXT_ITEMS} items")
    context: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for index, raw in enumerate(raw_context):
        item = _record(raw, f"context[{index}]")
        kind = _text(item.get("kind"), f"context[{index}].kind", 40)
        if kind not in CONTEXT_KINDS:
            raise WorkspaceAssistantError(f"unsupported context kind: {kind}")
        reference = _text(item.get("reference", issue if kind == "issue" else None), f"context[{index}].reference", 4_000)
        if kind in {"file", "diff", "artifact"}:
            if not SAFE_PATH_RE.fullmatch(reference) or Path(reference).is_absolute() or ".." in Path(reference).parts:
                raise WorkspaceAssistantError(f"context[{index}].reference must be a repository-relative path")
        elif kind == "commit" and not REVISION_RE.fullmatch(reference):
            raise WorkspaceAssistantError(f"context[{index}].reference must be a commit hash")
        elif kind == "issue" and reference != issue:
            raise WorkspaceAssistantError("issue context must match the selected issue")
        elif kind == "pull_request" and not re.fullmatch(r"#[1-9][0-9]*", reference):
            raise WorkspaceAssistantError("pull_request context must be #123")
        elif kind in {"run", "log"} and (len(reference) > 500 or not SAFE_PATH_RE.fullmatch(reference)):
            raise WorkspaceAssistantError(f"context[{index}].reference is invalid")
        key = (kind, reference)
        if key not in seen:
            seen.add(key)
            context.append({"kind": kind, "reference": reference})

    if ("issue", issue) not in seen:
        context.insert(0, {"kind": "issue", "reference": issue})
    return {
        "version": 1,
        "operation": operation,
        "issue": issue,
        "question": question,
        "context": context,
    }


def build_prompt(request: Mapping[str, Any], details: list[str] | None = None) -> str:
    selections = "\n".join(
        f"- {item['kind']}: {item['reference']}"
        for item in request["context"]
    )
    detail_text = ""
    if details:
        detail_text = "\n\nOwner-resolved context:\n" + "\n".join(f"- {item}" for item in details)
    return (
        "The operator selected the following owner-validated context in the Diogenes RoboOMP workspace:\n"
        f"{selections}{detail_text}\n\n"
        "Inspect the repository and its Git history with the available tools before answering. "
        "Cite repository evidence as `path:line` whenever a file supports a claim. "
        "Do not say that a write, Git operation, retry, cancellation, cleanup, or audit occurred. "
        "If one of those owner operations would help, call propose_roboomp_action; the operator will review it separately.\n\n"
        f"{QUESTION_START}\n{request['question']}\n{QUESTION_END}"
    )


def _git_output(repo_dir: Path, arguments: list[str], *, maximum: int = MAX_CONTEXT_DETAIL_CHARS) -> str:
    """Return bounded, read-only Git evidence without exposing a shell."""
    env = os.environ.copy()
    env["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_dir), "--no-pager", *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            env=env,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"Git evidence unavailable: {exc}"
    rendered = result.stdout.strip()
    if not rendered:
        rendered = "(no output)"
    if len(rendered) > maximum:
        rendered = f"{rendered[:maximum]}\n… [owner output truncated]"
    if result.returncode != 0:
        return f"Git exited {result.returncode}:\n{rendered}"
    return rendered


def context_details(
    request: Mapping[str, Any],
    *,
    database: object,
    repo_dir: Path,
    workspace: object,
) -> list[str]:
    details: list[str] = []
    issue = str(request["issue"])
    for item in request["context"]:
        kind = str(item["kind"])
        reference = str(item["reference"])
        if kind == "issue":
            row = database.get_issue(issue)
            if row is not None:
                details.append(
                    f"issue {issue}: state={row.state}; classification={row.classification or 'unclassified'}; "
                    f"branch={row.branch or 'not created'}; pull_request={row.pr_number or 'none'}"
                )
            status = _git_output(repo_dir, ["status", "--short", "--branch"])
            history = _git_output(repo_dir, ["log", "-8", "--oneline", "--decorate"], maximum=2_000)
            details.append(f"repository status for {issue}:\n{status}\nrecent commits:\n{history}")
        elif kind == "file":
            details.append(f"file {reference}: inspect {repo_dir / reference} with repository read tools")
        elif kind == "diff":
            target = "the complete worktree" if reference == "." else reference
            path_args = [] if reference == "." else ["--", reference]
            diff = _git_output(
                repo_dir,
                ["diff", "--no-ext-diff", "--no-color", "--unified=3", *path_args],
            )
            details.append(f"current Git diff for {target}:\n{diff}")
        elif kind == "commit":
            commit = _git_output(
                repo_dir,
                [
                    "show",
                    "--no-ext-diff",
                    "--no-color",
                    "--format=fuller",
                    "--stat",
                    "--patch",
                    "--unified=3",
                    reference,
                    "--",
                ],
            )
            details.append(f"commit {reference}:\n{commit}")
        elif kind == "pull_request":
            details.append(f"pull request {reference}: associated with {issue}")
        elif kind == "run":
            row = database.get_event(reference)
            if row is not None and row.issue_key == issue:
                details.append(
                    f"run {reference}: type={row.event_type}; state={row.state}; attempts={row.attempts}"
                )
        elif kind == "artifact":
            artifact_root = Path(getattr(workspace, "artifacts_dir")).resolve()
            candidate = (artifact_root / reference).resolve()
            try:
                candidate.relative_to(artifact_root)
            except ValueError:
                continue
            if candidate.is_file():
                try:
                    excerpt = candidate.read_text(encoding="utf-8", errors="replace")[:MAX_CONTEXT_DETAIL_CHARS]
                except OSError:
                    excerpt = ""
                if excerpt:
                    details.append(f"artifact {reference} excerpt:\n{excerpt}")
                else:
                    details.append(f"artifact {reference}: binary or empty artifact at {candidate}")
        elif kind == "log":
            details.append(f"log {reference}: operator-selected RoboOMP runtime log reference")
    return details


def normalize_proposal(value: object, *, issue: str) -> dict[str, Any]:
    payload = _record(value, "proposal")
    action = _text(payload.get("action"), "proposal.action", 80)
    if action not in PROPOSAL_ACTIONS:
        raise WorkspaceAssistantError(f"unsupported proposal action: {action}")
    reason = _text(payload.get("reason"), "proposal.reason", 2_000)
    repository = issue.split("#", 1)[0]
    mutation: dict[str, Any] = {"version": 1, "action": action}
    if action in {"trigger.triage", "issue.cleanup"}:
        mutation["issue"] = issue
    elif action == "trigger.retry":
        proposed_issue = payload.get("issue")
        delivery_id = payload.get("deliveryId")
        if proposed_issue not in {None, "", issue}:
            raise WorkspaceAssistantError("retry proposal issue must match the selected issue")
        if isinstance(delivery_id, str) and delivery_id.strip():
            mutation["deliveryId"] = _text(delivery_id, "proposal.deliveryId", 500)
        else:
            mutation["issue"] = issue
    elif action == "trigger.cancel":
        mutation["deliveryId"] = _text(payload.get("deliveryId"), "proposal.deliveryId", 500)
    elif action == "audit.dream":
        mutation["repository"] = repository
        focus = payload.get("focus")
        if isinstance(focus, str) and focus.strip():
            mutation["focus"] = _text(focus, "proposal.focus", 2_000)
    encoded = json.dumps(mutation, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {
        "id": hashlib.sha256(f"{encoded}\n{reason}".encode("utf-8")).hexdigest()[:16],
        "mutation": mutation,
        "reason": reason,
    }


def collect_sources(answer: str, repo_dir: Path) -> list[dict[str, Any]]:
    root = repo_dir.resolve()
    sources: list[dict[str, Any]] = []
    seen: set[tuple[str, int, int]] = set()
    for match in SOURCE_RE.finditer(answer):
        relative = match.group(1).lstrip("./")
        try:
            candidate = (root / relative).resolve()
            candidate.relative_to(root)
        except (OSError, ValueError):
            continue
        if not candidate.is_file():
            continue
        start = int(match.group(2))
        end = int(match.group(3) or start)
        if start < 1 or end < start or end - start > 200:
            continue
        excerpt = ""
        found_end = False
        try:
            selected: list[str] = []
            with candidate.open("r", encoding="utf-8", errors="replace") as stream:
                for number, line in enumerate(stream, 1):
                    if number < start:
                        continue
                    if number > end:
                        found_end = True
                        break
                    selected.append(line.rstrip("\r\n"))
                else:
                    found_end = end <= start + len(selected) - 1
            if not selected or not found_end:
                continue
            excerpt = "\n".join(selected)[:1_200]
        except OSError:
            continue
        key = (relative, start, end)
        if key in seen:
            continue
        seen.add(key)
        sources.append({
            "id": f"S{len(sources) + 1}",
            "path": relative,
            "startLine": start,
            "endLine": end,
            "label": f"{relative}:{start}" + (f"-{end}" if end != start else ""),
            "excerpt": excerpt,
        })
        if len(sources) >= MAX_SOURCES:
            break
    return sources


def _message_text(message: object) -> str:
    from omp_rpc import message_text

    text = message_text(message) or ""
    if getattr(message, "role", "") == "user":
        start = text.find(QUESTION_START)
        end = text.find(QUESTION_END, start + len(QUESTION_START))
        if start >= 0 and end >= 0:
            text = text[start + len(QUESTION_START):end].strip()
    return text[:MAX_MESSAGE_CHARS]


def _messages(values: object) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for message in list(values)[-MAX_MESSAGES:]:
        role = str(getattr(message, "role", ""))
        if role not in {"user", "assistant"}:
            continue
        text = _message_text(message)
        if text:
            result.append({"role": role, "content": text})
    return result


def _jsonable(value: object) -> object:
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _workspace(request: Mapping[str, Any]) -> tuple[object, object, Path, int | None, object]:
    from robomp.config import get_settings
    from robomp.db import get_database
    from robomp.sandbox import SandboxManager, Workspace

    settings = get_settings()
    settings.ensure_paths()
    database = get_database(settings.sqlite_path)
    row = database.get_issue(str(request["issue"]))
    if row is None:
        raise WorkspaceAssistantError(f"RoboOMP has not indexed {request['issue']}")
    root = SandboxManager(settings.workspace_root).workspace_root(row.repo, row.number)
    repo_dir = root / "repo"
    if not (repo_dir / ".git").exists():
        raise WorkspaceAssistantError(f"RoboOMP has no issue worktree for {request['issue']}")
    assistant_session = root / ".omp-ade-session"
    assistant_session.mkdir(mode=0o770, exist_ok=True)
    stat = repo_dir.stat()
    slot_uid = stat.st_uid if os.geteuid() == 0 and stat.st_uid != 0 else None
    if os.geteuid() == 0:
        os.chown(assistant_session, stat.st_uid, stat.st_gid)
        assistant_session.chmod(0o770)
    workspace = Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=assistant_session,
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch=row.branch or "",
        repo_full_name=row.repo,
        issue_number=row.number,
    )
    return settings, database, repo_dir, slot_uid, workspace


def run_request(request: Mapping[str, Any]) -> dict[str, Any]:
    from omp_rpc import RpcClient, ToolExecutionEndEvent, ToolExecutionStartEvent, host_tool
    from robomp.host_tools import _git_identity_env
    from robomp.sandbox import _prepare_slot_runtime_env, _safe_directory_env
    from robomp.worker import _build_extra_env

    settings, database, repo_dir, slot_uid, workspace = _workspace(request)
    lock_path = workspace.root / ".omp-ade.lock"
    lock_path.touch(mode=0o660, exist_ok=True)
    lock_stream = lock_path.open("r+")
    try:
        fcntl.flock(lock_stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        lock_stream.close()
        raise WorkspaceAssistantError("this issue assistant already has an active turn") from exc

    proposals: list[dict[str, Any]] = []
    tool_starts: dict[str, dict[str, Any]] = {}
    tool_activity: list[dict[str, Any]] = []

    def execute_proposal(args: dict[str, Any], _context: object) -> str:
        proposal = normalize_proposal(args, issue=str(request["issue"]))
        if not any(item["id"] == proposal["id"] for item in proposals):
            proposals.append(proposal)
        return "Proposal recorded for operator review. Nothing was executed."

    proposal_tool = host_tool(
        name="propose_roboomp_action",
        label="Propose RoboOMP action",
        description=(
            "Record one typed RoboOMP owner action for the operator to review. "
            "This never executes the action. Use trigger.triage, trigger.retry, "
            "trigger.cancel, issue.cleanup, or audit.dream."
        ),
        parameters={
            "type": "object",
            "additionalProperties": False,
            "required": ["action", "reason"],
            "properties": {
                "action": {"type": "string", "enum": sorted(PROPOSAL_ACTIONS)},
                "reason": {"type": "string", "minLength": 1, "maxLength": 2_000},
                "issue": {"type": "string"},
                "deliveryId": {"type": "string"},
                "focus": {"type": "string"},
            },
        },
        execute=execute_proposal,
    )

    def on_tool_start(event: ToolExecutionStartEvent) -> None:
        tool_starts[event.tool_call_id] = {
            "id": event.tool_call_id,
            "name": event.tool_name,
            "intent": event.intent,
        }

    def on_tool_end(event: ToolExecutionEndEvent) -> None:
        activity = tool_starts.pop(event.tool_call_id, {
            "id": event.tool_call_id,
            "name": event.tool_name,
            "intent": None,
        })
        activity["status"] = "error" if event.is_error else "complete"
        tool_activity.append(activity)

    env = _build_extra_env(settings)
    env.update(_prepare_slot_runtime_env(workspace, slot_uid))
    env.update(_safe_directory_env(repo_dir))
    env.update(_git_identity_env(settings.resolved_author_name, settings.git_author_email))
    prior = any(workspace.session_dir.glob("*.jsonl"))
    extra_args = [
        "--approval-mode",
        "always-ask",
        "--tools",
        "read,grep,glob",
    ]
    if prior:
        extra_args.append("--continue")
    model = settings.pick_model()
    system_prompt = (
        "You are the read-oriented repository assistant inside Persephone's RoboOMP ADE. "
        "Use the issue worktree and the selected context. You have repository read, grep, and glob tools; "
        "selected Git state is included by Persephone. Direct writes, shell execution, and Git mutations "
        "are unavailable. Use propose_roboomp_action when "
        "one of its owner actions is appropriate. Never fabricate a path, line, action result, or tool result."
    )
    try:
        with RpcClient(
            executable=settings.omp_command,
            cwd=repo_dir,
            session_dir=workspace.session_dir,
            env=env,
            no_session=False,
            no_title=True,
            model=model,
            provider=settings.provider,
            thinking=settings.thinking_level if settings.thinking_level != "off" else None,
            append_system_prompt=system_prompt,
            custom_tools=[proposal_tool],
            request_timeout=settings.request_timeout_seconds,
            startup_timeout=60.0,
            max_event_history=50_000,
            extra_args=extra_args,
            user=slot_uid,
            group=slot_uid if slot_uid is not None else None,
            extra_groups=["omp"] if slot_uid is not None else None,
        ) as client:
            client.install_headless_ui(confirm=False)
            client.on_tool_execution_start(on_tool_start)
            client.on_tool_execution_end(on_tool_end)
            answer = ""
            if request["operation"] == "ask":
                turn = client.prompt_and_wait(
                    build_prompt(
                        request,
                        context_details(
                            request,
                            database=database,
                            repo_dir=repo_dir,
                            workspace=workspace,
                        ),
                    ),
                    timeout=settings.task_timeout_seconds + settings.task_timeout_hard_grace_seconds,
                )
                answer = turn.require_assistant_text()
            state = client.get_state()
            stats = client.get_session_stats()
            messages = _messages(client.get_messages())
            if not answer:
                answer = next((item["content"] for item in reversed(messages) if item["role"] == "assistant"), "")
            return {
                "schemaVersion": SCHEMA_VERSION,
                "operation": request["operation"],
                "issue": request["issue"],
                "answer": answer,
                "messages": messages,
                "sources": collect_sources(answer, repo_dir),
                "proposals": proposals,
                "toolActivity": tool_activity[-100:],
                "tools": [tool.name for tool in state.dump_tools],
                "model": _jsonable(state.model),
                "thinking": state.thinking_level,
                "usage": _jsonable(stats),
                "session": {"id": state.session_id, "resumed": prior},
            }
    finally:
        try:
            fcntl.flock(lock_stream.fileno(), fcntl.LOCK_UN)
        finally:
            lock_stream.close()


def read_stdin_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise WorkspaceAssistantError("request exceeds the 1 MB owner limit")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WorkspaceAssistantError("request must be UTF-8 JSON") from exc
    return normalize_request(value)


def main() -> int:
    try:
        result = run_request(read_stdin_request())
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:  # noqa: BLE001 - fixed JSON CLI error boundary
        print(json.dumps({"schemaVersion": f"{SCHEMA_VERSION}.error", "error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
