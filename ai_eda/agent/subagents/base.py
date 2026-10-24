"""子 Agent 基类与运行上下文。

每个子 Agent 有独立的 Python 文件、独立 context.json 和独立输出目录；
子 Agent 之间只通过 handoffs/ 下的 JSON 文件交互。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable

from common.api import RTL_SYSTEM_PROMPT, ModelClient


class RunContext:
    def __init__(
        self,
        *,
        run_dir: Path,
        options: dict[str, Any],
        begin_event: Callable[..., dict[str, Any]],
        finish_event: Callable[..., None],
        persist: Callable[..., None],
        emit: Callable[[dict[str, Any]], None],
        check_cancel: Callable[[], None],
        request_input: Callable[[dict[str, Any]], str] | None,
    ) -> None:
        self.run_dir = run_dir
        self.options = options
        self.begin_event = begin_event
        self.finish_event = finish_event
        self.persist = persist
        self.emit = emit
        self.check_cancel = check_cancel
        self.request_input = request_input
        self.handoffs_dir = run_dir / "handoffs"
        self.handoffs_dir.mkdir(parents=True, exist_ok=True)

    def make_client(self) -> ModelClient:
        return ModelClient(**self.options)

    def call_model(self, event: dict[str, Any], prompt: str, system_prompt: str) -> dict[str, Any]:
        result = self.make_client().generate_once_detail(prompt, system_prompt)
        self.check_cancel()
        answer = result.get("answer") or ""
        reasoning = result.get("reasoning")
        artifact_dir = self.run_dir / f"step-{event['step']:02d}-{event['node_id']}"
        artifact_dir.mkdir(exist_ok=True)
        (artifact_dir / "prompt.md").write_text(prompt, encoding="utf-8")
        (artifact_dir / "raw_response.txt").write_text(answer, encoding="utf-8")
        if reasoning:
            (artifact_dir / "reasoning.txt").write_text(reasoning, encoding="utf-8")
        event["response"] = answer
        event["raw_response"] = answer
        event["reasoning"] = reasoning
        event["usage"] = result.get("usage")
        return result

    def mark_waiting(self, event: dict[str, Any], request: dict[str, Any]) -> None:
        event["status"] = "waiting_input"
        event["input_request"] = request
        self.persist()
        self.emit(json.loads(json.dumps(event, ensure_ascii=False)))

    def write_handoff(
        self,
        source: str,
        target: str,
        payload: Any,
        *,
        attempt: int | None = None,
        label: str = "",
    ) -> Path:
        """写出 source→target 的交接文件；保留 latest 与按 attempt 的历史。"""
        edge_id = f"{source}_to_{target}"
        record = {
            "edge_id": edge_id,
            "source": source,
            "target": target,
            "attempt": attempt,
            "label": label,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "payload": payload,
        }
        latest = self.handoffs_dir / f"{edge_id}.json"
        latest.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if attempt is not None:
            history = self.handoffs_dir / f"{edge_id}_attempt{attempt}.json"
            history.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return latest


class SubAgent:
    name = "subagent"
    title = "SubAgent"
    node_type = "model"

    def __init__(self, context: RunContext) -> None:
        self.runtime = context
        self.base_dir = context.run_dir / "agents" / self.name
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.context_path = self.base_dir / "context.json"
        self.context: dict[str, Any] = self.load_context()

    def load_context(self) -> dict[str, Any]:
        if not self.context_path.is_file():
            return {}
        try:
            payload = json.loads(self.context_path.read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def save_context(self, **updates: Any) -> None:
        self.context.update(updates)
        self.context_path.write_text(
            json.dumps(self.context, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def check_cancel(self) -> None:
        self.runtime.check_cancel()

    def finish(self, event: dict[str, Any], status: str, **fields: Any) -> None:
        self.runtime.finish_event(event, status, **fields)
