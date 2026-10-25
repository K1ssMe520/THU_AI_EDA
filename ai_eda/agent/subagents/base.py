"""固定流水线的子 Agent 基类与运行上下文。

交接记录只保存小型消息与 artifact 引用；RTL、Spec、Plan 和测试报告均落盘一次，
由接收方按引用读取，避免在 handoff 中复制大文本。
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ai_eda.model.client import RTL_SYSTEM_PROMPT, ModelClient


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
        max_calls: int = 100,
    ) -> None:
        self.run_dir = run_dir
        self.options = options
        self.begin_event = begin_event
        self.finish_event = finish_event
        self.persist = persist
        self.emit = emit
        self.check_cancel = check_cancel
        self.request_input = request_input
        self.max_calls = int(max_calls)
        self.model_calls = 0
        self.handoffs_dir = run_dir / "handoffs"
        self.handoffs_dir.mkdir(parents=True, exist_ok=True)
        self.artifacts_dir = run_dir / "artifacts"
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)

    def make_client(self) -> ModelClient:
        model_keys = ("temperature", "max_tokens", "thinking", "reasoning_effort")
        return ModelClient(**{key: self.options[key] for key in model_keys if key in self.options})

    def call_model(self, event: dict[str, Any], prompt: str, system_prompt: str) -> dict[str, Any]:
        """流式调用模型，并把 reasoning / answer 增量实时推给工作台。"""
        if self.max_calls > 0 and self.model_calls >= self.max_calls:
            raise ValueError(
                f"Agent 模型调用次数已达到上限（{self.max_calls} 次），"
                "请提高调用上限或缩小任务规模。"
            )
        self.model_calls += 1
        event["call_index"] = self.model_calls
        client = self.make_client()
        answer_parts: list[str] = []
        reasoning_parts: list[str] = []
        usage: dict[str, Any] | None = None
        finish_reason: str | None = None
        last_emit = 0.0
        last_persist = 0.0
        event["streaming"] = True
        event["reasoning"] = ""
        event["response"] = ""
        for chunk in client.stream_once_detail(prompt, system_prompt):
            self.check_cancel()
            kind = chunk.get("type")
            if kind == "reasoning":
                reasoning_parts.append(str(chunk.get("text") or ""))
            elif kind == "answer":
                answer_parts.append(str(chunk.get("text") or ""))
            elif kind == "done":
                answer_parts = [str(chunk.get("answer") or "")]
                reasoning_parts = [str(chunk.get("reasoning") or "")]
                usage = chunk.get("usage")
                finish_reason = chunk.get("finish_reason")
            event["reasoning"] = "".join(reasoning_parts)
            event["response"] = "".join(answer_parts)
            now = time.monotonic()
            if now - last_emit >= 0.12:
                self.emit(json.loads(json.dumps(event, ensure_ascii=False)))
                last_emit = now
            if now - last_persist >= 1.0:
                self.persist()
                last_persist = now
        self.check_cancel()
        answer = "".join(answer_parts)
        reasoning = "".join(reasoning_parts) or None
        result = {
            "answer": answer,
            "reasoning": reasoning,
            "usage": usage,
            "finish_reason": finish_reason,
        }
        artifact_dir = self.run_dir / f"step-{event['step']:02d}-{event['node_id']}"
        artifact_dir.mkdir(exist_ok=True)
        (artifact_dir / "prompt.md").write_text(prompt, encoding="utf-8")
        (artifact_dir / "raw_response.txt").write_text(answer, encoding="utf-8")
        if reasoning:
            (artifact_dir / "reasoning.txt").write_text(reasoning, encoding="utf-8")
        event["response"] = answer
        event["raw_response"] = answer
        event["reasoning"] = reasoning
        event["usage"] = usage
        event["streaming"] = False
        return result

    def mark_waiting(self, event: dict[str, Any], request: dict[str, Any]) -> None:
        event["status"] = "waiting_input"
        event["input_request"] = request
        self.persist()
        self.emit(json.loads(json.dumps(event, ensure_ascii=False)))

    def artifact_ref(self, path: Path) -> str:
        """把运行目录内的文件转换为可在 handoff 中传递的相对引用。"""
        resolved = path.resolve()
        root = self.run_dir.resolve()
        if root not in resolved.parents:
            raise ValueError("artifact 必须位于当前运行目录")
        return str(resolved.relative_to(root))

    def _resolve_ref(self, reference: str, *, directory: Path | None = None) -> Path:
        if not isinstance(reference, str) or not reference.strip():
            raise ValueError("artifact 引用不能为空")
        root = (directory or self.run_dir).resolve()
        path = (root / reference).resolve()
        if root not in path.parents:
            raise ValueError("artifact 引用越出运行目录")
        return path

    def write_text_artifact(self, name: str, content: str) -> str:
        path = self._resolve_ref(name, directory=self.artifacts_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return self.artifact_ref(path)

    def write_json_artifact(self, name: str, payload: Any) -> str:
        return self.write_text_artifact(name, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    def read_text_artifact(self, reference: str) -> str:
        path = self._resolve_ref(reference)
        if not path.is_file():
            raise FileNotFoundError(f"artifact 不存在：{reference}")
        return path.read_text(encoding="utf-8")

    def read_json_artifact(self, reference: str) -> Any:
        try:
            return json.loads(self.read_text_artifact(reference))
        except json.JSONDecodeError as error:
            raise ValueError(f"artifact 不是合法 JSON：{reference}") from error

    def write_handoff(
        self,
        source: str,
        target: str,
        payload: dict[str, Any],
        *,
        attempt: int | None = None,
        label: str = "",
    ) -> Path:
        """写出不可变交接消息；大内容必须通过 payload.artifacts 传递引用。"""
        if not isinstance(payload, dict):
            raise ValueError("handoff payload 必须是对象")
        edge_id = f"{source}_to_{target}"
        record = {
            "schema_version": 1,
            "edge_id": edge_id,
            "source": source,
            "target": target,
            "attempt": attempt,
            "label": label,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "payload": payload,
        }
        suffix = f"_attempt{attempt}" if attempt is not None else ""
        path = self.handoffs_dir / f"{edge_id}{suffix}.json"
        if path.exists():
            raise ValueError(f"handoff 已存在，拒绝覆盖：{path.name}")
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return path

    def read_handoff(self, path: Path) -> dict[str, Any]:
        """读取并校验由上游 Agent 明确传来的 handoff。"""
        resolved = path.resolve()
        root = self.handoffs_dir.resolve()
        if root not in resolved.parents or not resolved.is_file():
            raise ValueError("handoff 路径无效")
        try:
            record = json.loads(resolved.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"handoff 不是合法 JSON：{path.name}") from error
        if not isinstance(record, dict) or record.get("schema_version") != 1:
            raise ValueError(f"handoff schema 不兼容：{path.name}")
        if not isinstance(record.get("payload"), dict):
            raise ValueError(f"handoff 缺少 payload：{path.name}")
        return record


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
