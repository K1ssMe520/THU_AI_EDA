"""本地 HTML 工作台的受限 HTTP 服务。"""

from __future__ import annotations

import json
import mimetypes
import shutil
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from ai_eda.agent.orchestrator import run_agent
from ai_eda.agent.projects import DEFAULT_PROJECT_ID, get_project, project_public
from ai_eda.agent.runs import (
    DESIGN_ID_PATTERN,
    AgentCancelled,
    agent_state_payload,
    clear_agent_runs,
    delete_agent_design,
    delete_agent_run,
    list_agent_designs,
    list_agent_handoffs,
    list_agent_runs,
    load_agent_design,
    load_agent_graph,
    load_agent_handoff,
    load_agent_run,
    save_agent_design,
    save_agent_graph,
)
from ai_eda.config import (
    PROJECT_ROOT,
    PROMPTS_ROOT,
    PROMPT_RUNS_ROOT,
    TASKS_ROOT,
    WEB_ROOT as STATIC_WEB_ROOT,
)
from ai_eda.model.client import DEFAULT_SYSTEM_PROMPT, ModelClient
from ai_eda.prompt.param_lab import describe as describe_param_lab
from ai_eda.prompt.param_lab import run_demo as run_param_demo
from ai_eda.rtl.runner import (
    _run_component,
    evaluate_metrics,
    retest_run,
    run_testbench,
    run_prompt_experiment,
    save_generation_run,
    summarize_task,
)

WEB_ROOT = STATIC_WEB_ROOT
RUNS_ROOT = PROMPT_RUNS_ROOT
TASK_ID = "classroom_seq1011"
TASK_DIR = TASKS_ROOT / TASK_ID
PROMPT_ROOT = PROMPTS_ROOT / "classroom"

HOMEWORK_TASK_ID = "homework_aes128"
HOMEWORK_TASK_TITLE = "课后作业：单模块 AES-128 加密核"
HOMEWORK_TASK_DIR = TASKS_ROOT / HOMEWORK_TASK_ID
HOMEWORK_PROMPT_PATH = PROMPTS_ROOT / "homework" / "H1_custom.md"
HOMEWORK_TESTBENCH_TOP = "tb_homework_aes128"
HOMEWORK_POWER_TESTBENCH_TOP = "tb_power_homework_aes128"

_AGENT_JOBS: dict[str, dict[str, Any]] = {}
_AGENT_JOBS_LOCK = threading.Lock()
_MAX_AGENT_JOBS = 24
_FINISHED_JOB_STATES = {"completed", "failed", "cancelled"}

PROMPTS: dict[str, dict[str, str]] = {
    "p1": {
        "file": "P1_oral_request.md",
        "title": "P1 · 口头需求",
        "description": "一句话口头描述，未限定输出格式：观察回答是否可被稳定提取。",
    },
    "p2": {
        "file": "P2_interface_and_output.md",
        "title": "P2 · 接口与输出约束",
        "description": "固定模块接口并只输出 Verilog：RTL 可提取并接入 TB，但握手与复位细节仍未定义。",
    },
    "p3": {
        "file": "P3_handshake_and_reset.md",
        "title": "P3 · 握手与复位",
        "description": "补充 valid/ready 握手与复位逻辑；输出延迟、吞吐、反压与同步复位细节仍未定义。",
    },
    "p4": {
        "file": "P4_incremental_clarification.md",
        "title": "P4 · 增量补充",
        "description": "根据 P3 运行结果补充一拍延迟、反压保持与同步复位等细节。",
    },
    "p5": {
        "file": "P5_cot_low_area.md",
        "title": "P5 · 思维链 / 面积优化",
        "description": "单独思维链小节指导最小状态机与低面积/低功耗实现。",
    },
}


def _prompt_path(prompt_id: str) -> Path:
    definition = PROMPTS.get(prompt_id)
    if definition is None:
        raise ValueError("未知 Prompt 条件")
    return PROMPT_ROOT / definition["file"]


def _query_value(parsed: Any, name: str, default: str | None = None) -> str | None:
    values = parse_qs(getattr(parsed, "query", "")).get(name)
    return values[0] if values else default


def _project_id_from_request(request: dict[str, Any]) -> str:
    project_id = request.get("project_id") or DEFAULT_PROJECT_ID
    if not isinstance(project_id, str):
        raise ValueError("project_id 必须是字符串")
    return get_project(project_id)["id"]


def _read_json_body(handler: SimpleHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0 or length > 2_000_000:
        raise ValueError("请求正文大小无效")
    payload = json.loads(handler.rfile.read(length).decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("请求必须是 JSON 对象")
    return payload


def _atomic_write(path: Path, content: str) -> None:
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as temp_file:
        temp_path = Path(temp_file.name)
        temp_file.write(content)
    temp_path.replace(path)


def _run_payload(run_dir: Path, report: dict[str, Any]) -> dict[str, Any]:
    def read_text(name: str) -> str | None:
        path = run_dir / name
        return path.read_text(encoding="utf-8") if path.is_file() else None

    metadata_path = run_dir / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.is_file() else {}
    return {
        "run_id": run_dir.name,
        "run_dir": str(run_dir),
        "prompt": read_text("prompt.md"),
        "reasoning": read_text("reasoning.txt"),
        "answer": read_text("raw_response.txt"),
        "rtl": read_text("generated.sv"),
        "metadata": metadata,
        "report": report,
    }


def _homework_prompt_text() -> str:
    return HOMEWORK_PROMPT_PATH.read_text(encoding="utf-8") if HOMEWORK_PROMPT_PATH.is_file() else ""


def _homework_payload() -> dict[str, Any]:
    """返回课后作业页需要的任务、Spec、学生 Prompt 与运行历史。"""
    return {
        "task": {
            "id": HOMEWORK_TASK_ID,
            "title": HOMEWORK_TASK_TITLE,
            "spec": (HOMEWORK_TASK_DIR / "spec.md").read_text(encoding="utf-8"),
            "prompt_file": str(HOMEWORK_PROMPT_PATH.relative_to(PROJECT_ROOT)),
            "testbench": HOMEWORK_TESTBENCH_TOP,
        },
        "prompt": _homework_prompt_text(),
        "runs": summarize_task(HOMEWORK_TASK_ID),
    }


def _generation_options(
    request: dict[str, Any], *, default_max_tokens: int = 4096
) -> dict[str, Any]:
    """校验流式生成使用的一次模型调用参数。"""
    temperature = float(request.get("temperature", 0.2))
    if not 0 <= temperature <= 2:
        raise ValueError("temperature 必须在 0 到 2 之间")
    max_tokens = int(request.get("max_tokens", default_max_tokens))
    if not 64 <= max_tokens <= 16384:
        raise ValueError("max_tokens 必须在 64 到 16384 之间")
    thinking = bool(request.get("thinking", False))
    reasoning_effort = str(request.get("reasoning_effort", "high"))
    if reasoning_effort not in {"low", "high", "max"}:
        raise ValueError("reasoning_effort 无效")
    return {
        "temperature": temperature,
        "max_tokens": max_tokens,
        "thinking": thinking,
        "reasoning_effort": reasoning_effort,
    }


def _homework_options(request: dict[str, Any]) -> dict[str, Any]:
    thinking = bool(request.get("thinking", False))
    reasoning_effort = str(request.get("reasoning_effort", "high"))
    if reasoning_effort not in {"low", "high", "max"}:
        raise ValueError("reasoning_effort 无效")
    temperature = float(request.get("temperature", 0.2))
    if not 0 <= temperature <= 2:
        raise ValueError("temperature 必须在 0 到 2 之间")
    max_tokens = int(request.get("max_tokens", 8192))
    if not 64 <= max_tokens <= 16384:
        raise ValueError("max_tokens 必须在 64 到 16384 之间")
    return {
        "temperature": temperature,
        "max_tokens": max_tokens,
        "thinking": thinking,
        "reasoning_effort": reasoning_effort,
    }


def _agent_options(request: dict[str, Any]) -> dict[str, Any]:
    thinking = bool(request.get("thinking", True))
    reasoning_effort = str(request.get("reasoning_effort", "low"))
    if reasoning_effort not in {"low", "high", "max"}:
        raise ValueError("reasoning_effort 无效")
    temperature = float(request.get("temperature", 0.2))
    if not 0 <= temperature <= 2:
        raise ValueError("temperature 必须在 0 到 2 之间")
    max_tokens = int(request.get("max_tokens", 30000))
    if not 1 <= max_tokens <= 30000:
        raise ValueError("max_tokens 必须在 1 到 30000 之间")
    max_calls = int(request.get("max_calls", 100))
    if not 1 <= max_calls <= 1000:
        raise ValueError("max_calls 必须在 1 到 1000 之间")
    design_id = request.get("design_id")
    if design_id in (None, ""):
        design_id = None
    elif not isinstance(design_id, str) or not DESIGN_ID_PATTERN.fullmatch(design_id):
        raise ValueError("design_id 无效")
    design_name = request.get("design_name")
    if design_name in (None, ""):
        design_name = None
    elif not isinstance(design_name, str):
        raise ValueError("design_name 必须是字符串")
    else:
        design_name = design_name.strip()[:100] or None
    project_id = _project_id_from_request(request)
    return {
        "thinking": thinking,
        "reasoning_effort": reasoning_effort,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "max_calls": max_calls,
        "design_id": design_id,
        "design_name": design_name,
        "project_id": project_id,
    }


def _job_public_payload(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
        "run_id": job.get("run_id"),
        "project_id": job.get("project_id"),
        "project": (project_public(get_project(job.get("project_id"))) if job.get("project_id") else None),
        "events": job.get("events", []),
        "error": job.get("error"),
        "result": job.get("result"),
        "input_request": job.get("input_request"),
    }


def _prune_agent_jobs() -> None:
    """只保留最近的作业，避免长时间运行时内存无限增长。"""
    with _AGENT_JOBS_LOCK:
        if len(_AGENT_JOBS) <= _MAX_AGENT_JOBS:
            return
        finished = [
            job
            for job in _AGENT_JOBS.values()
            if job["status"] in _FINISHED_JOB_STATES
        ]
        finished.sort(key=lambda job: job["updated_at"])
        for job in finished[: max(0, len(_AGENT_JOBS) - _MAX_AGENT_JOBS)]:
            _AGENT_JOBS.pop(job["job_id"], None)


def _execute_agent_job(job_id: str, options: dict[str, Any]) -> None:
    with _AGENT_JOBS_LOCK:
        job = _AGENT_JOBS.get(job_id)
        if job is None:
            return
        cancel_event = job["cancel_event"]

    def record(event: dict[str, Any]) -> None:
        with _AGENT_JOBS_LOCK:
            target = _AGENT_JOBS.get(job_id)
            if target is None:
                return
            step = event.get("step")
            for index, existing in enumerate(target["events"]):
                if existing.get("step") == step:
                    target["events"][index] = event
                    break
            else:
                target["events"].append(event)
            target["run_id"] = target.get("run_id") or event.get("run_id")
            target["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")

    def request_input(request: dict[str, Any]) -> str:
        with _AGENT_JOBS_LOCK:
            target = _AGENT_JOBS.get(job_id)
            if target is None:
                raise AgentCancelled("Agent 作业已不存在")
            target["input_request"] = request
            target["input_value"] = None
            target["input_event"].clear()
            target["status"] = "waiting_input"
            target["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        while True:
            if cancel_event.is_set():
                raise AgentCancelled("Agent 运行已取消。")
            with _AGENT_JOBS_LOCK:
                target = _AGENT_JOBS.get(job_id)
                if target is None:
                    raise AgentCancelled("Agent 作业已不存在")
                input_event = target["input_event"]
            if input_event.wait(0.2):
                with _AGENT_JOBS_LOCK:
                    target = _AGENT_JOBS.get(job_id)
                    if target is None:
                        raise AgentCancelled("Agent 作业已不存在")
                    value = target["input_value"]
                    target["input_value"] = None
                    target["input_request"] = None
                    target["status"] = "running"
                    target["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                    return str(value or "")

    try:
        run_options = dict(options)
        run_options.update(
            {"on_event": record, "cancel_event": cancel_event, "request_input": request_input}
        )
        result = run_agent(**run_options)
        with _AGENT_JOBS_LOCK:
            target = _AGENT_JOBS.get(job_id)
            if target is not None:
                target.update(
                    {
                        "status": "completed",
                        "run_id": result["run_id"],
                        "events": result["events"],
                        "result": result,
                        "updated_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                    }
                )
    except AgentCancelled as error:
        run_id = None
        with _AGENT_JOBS_LOCK:
            target = _AGENT_JOBS.get(job_id)
            if target is not None:
                target.update(
                    {
                        "status": "cancelled",
                        "error": str(error),
                        "updated_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                    }
                )
                run_id = target.get("run_id")
        if run_id:
            try:
                partial = load_agent_run(str(run_id))
            except (OSError, ValueError, json.JSONDecodeError):
                partial = None
            with _AGENT_JOBS_LOCK:
                target = _AGENT_JOBS.get(job_id)
                if target is not None and partial is not None:
                    target["result"] = partial
                    target["events"] = partial.get("events", target["events"])
    except Exception as error:  # 保留具体错误，前端用于显示失败原因。
        run_id = None
        with _AGENT_JOBS_LOCK:
            target = _AGENT_JOBS.get(job_id)
            if target is not None:
                target.update(
                    {
                        "status": "failed",
                        "error": str(error),
                        "updated_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                    }
                )
                run_id = target.get("run_id")
        if run_id:
            try:
                partial = load_agent_run(str(run_id))
            except (OSError, ValueError, json.JSONDecodeError):
                partial = None
            with _AGENT_JOBS_LOCK:
                target = _AGENT_JOBS.get(job_id)
                if target is not None and partial is not None:
                    target["result"] = partial
                    target["events"] = partial.get("events", target["events"])
    finally:
        _prune_agent_jobs()


class WorkbenchHandler(SimpleHTTPRequestHandler):
    """仅允许访问已登记任务与项目内静态页面的本地服务。"""

    server_version = "AIEDAWorkbench/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        """避免每次自动保存都污染终端；错误仍由客户端显示。"""

    def _send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST) -> None:
        self._send_json({"error": message}, status)

    def _begin_event_stream(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

    def _write_event(self, payload: dict[str, Any]) -> None:
        body = b"data: " + json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n\n"
        self.wfile.write(body)
        self.wfile.flush()

    def _handle_stream_generation(self, kind: str) -> None:
        """流式生成一次模型回答；只保存运行目录，不自动跑 TB/metric。"""
        try:
            request = _read_json_body(self)
            options = _generation_options(
                request, default_max_tokens=4096 if kind == "classroom" else 8192
            )
            if kind == "classroom":
                task_id = TASK_ID
                prompt_id = request.get("prompt_id")
                if not isinstance(prompt_id, str):
                    raise ValueError("缺少 Prompt 条件")
                prompt_path = _prompt_path(prompt_id)
                content = request.get("content")
                if content is not None:
                    if not isinstance(content, str):
                        raise ValueError("Prompt 内容必须是字符串")
                    _atomic_write(prompt_path, content)
                prompt_text = prompt_path.read_text(encoding="utf-8")
                spec_path = TASK_DIR / "spec.md"
                testbench_path = TASK_DIR / "tb.sv"
                testbench_top = "tb_classroom_seq1011"
                run_id = f"web-{prompt_id}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}"
            elif kind == "homework":
                task_id = HOMEWORK_TASK_ID
                content = request.get("content")
                if isinstance(content, str) and content.strip():
                    HOMEWORK_PROMPT_PATH.parent.mkdir(parents=True, exist_ok=True)
                    _atomic_write(HOMEWORK_PROMPT_PATH, content)
                prompt_path = HOMEWORK_PROMPT_PATH
                prompt_text = _homework_prompt_text()
                if len(prompt_text.strip()) < 20:
                    raise ValueError("请先填写一条完整的 Prompt（至少 20 个字符）")
                spec_path = HOMEWORK_TASK_DIR / "spec.md"
                testbench_path = HOMEWORK_TASK_DIR / "tb.sv"
                testbench_top = HOMEWORK_TESTBENCH_TOP
                run_id = f"hw-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}"
            else:
                raise ValueError("未知生成类型")
            client = ModelClient(**options)
        except (ValueError, FileNotFoundError, RuntimeError, json.JSONDecodeError) as error:
            self._send_error_json(str(error))
            return

        self._begin_event_stream()
        final: dict[str, Any] | None = None
        try:
            self._write_event({"type": "start", "run_id": run_id})
            for event in client.stream_once_detail(prompt_text, DEFAULT_SYSTEM_PROMPT):
                if event.get("type") == "done":
                    final = event
                else:
                    self._write_event(event)
            if final is None:
                raise RuntimeError("模型流式响应没有正常结束。")
            run_dir = save_generation_run(
                task_name=task_id,
                spec_path=spec_path,
                testbench_path=testbench_path,
                testbench_top=testbench_top,
                prompt_path=prompt_path,
                run_id=run_id,
                raw_response=final.get("answer") or "",
                reasoning=final.get("reasoning"),
                temperature=options["temperature"],
                max_tokens=options["max_tokens"],
                thinking=options["thinking"],
                reasoning_effort=options["reasoning_effort"],
                finish_reason=final.get("finish_reason"),
                usage=final.get("usage"),
            )
            self._write_event({"type": "done", "run": _run_payload(run_dir, {})})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:  # 保留具体原因，前端显示在运行状态里。
            try:
                self._write_event({"type": "error", "error": str(error)})
            except (BrokenPipeError, ConnectionResetError):
                pass
        finally:
            self.close_connection = True

    def _handle_verify(self) -> None:
        """对已有运行记录单独执行教师 TB、功耗脚本与综合 metric。"""
        try:
            request = _read_json_body(self)
            task_id = request.get("task_id")
            if task_id not in {TASK_ID, HOMEWORK_TASK_ID}:
                raise ValueError("未知任务")
            raw_run_id = request.get("run_id")
            if not isinstance(raw_run_id, str):
                raise ValueError("缺少运行编号")
            run_id = _run_component(raw_run_id, "run_id")
            task_root = (RUNS_ROOT / task_id).resolve()
            run_dir = (task_root / run_id).resolve()
            if task_root not in run_dir.parents or not run_dir.is_dir():
                raise ValueError("运行记录不存在")
            if not (run_dir / "metadata.json").is_file():
                raise ValueError("运行记录缺少 metadata，无法验收")
            mode = str(request.get("mode", "all"))
            if mode not in {"all", "tb", "metrics"}:
                raise ValueError("验收模式无效")
            if mode == "tb":
                report = run_testbench(run_dir)
            elif mode == "metrics":
                report = evaluate_metrics(run_dir)
            else:
                report = retest_run(run_dir)
            self._send_json(_run_payload(run_dir, report))
        except (ValueError, FileNotFoundError, RuntimeError, json.JSONDecodeError) as error:
            self._send_error_json(str(error))
        except Exception as error:  # 保留服务端原因，避免页面只显示泛化错误。
            self._send_error_json(f"TB / metric 运行失败：{error}", HTTPStatus.INTERNAL_SERVER_ERROR)

    def _state(self) -> dict[str, Any]:
        prompts = [
            {
                "id": prompt_id,
                "title": definition["title"],
                "description": definition["description"],
                "content": _prompt_path(prompt_id).read_text(encoding="utf-8"),
            }
            for prompt_id, definition in PROMPTS.items()
        ]
        return {
            "task": {
                "id": TASK_ID,
                "title": "ready-valid 重叠序列检测器",
                "spec": (TASK_DIR / "spec.md").read_text(encoding="utf-8"),
                "prompts": prompts,
            },
            "homework": {"enabled": True, "task_id": HOMEWORK_TASK_ID},
        }

    def _serve_static(self, path: str) -> None:
        relative = "index.html" if path == "/" else unquote(path.lstrip("/"))
        candidate = (WEB_ROOT / relative).resolve()
        if WEB_ROOT.resolve() not in candidate.parents and candidate != WEB_ROOT.resolve():
            self._send_error_json("无效静态资源路径", HTTPStatus.NOT_FOUND)
            return
        if not candidate.is_file():
            self._send_error_json("资源不存在", HTTPStatus.NOT_FOUND)
            return
        content = candidate.read_bytes()
        mime_type, _ = mimetypes.guess_type(candidate.name)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{mime_type or 'application/octet-stream'}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        project_id = _query_value(parsed, "project", DEFAULT_PROJECT_ID)
        try:
            if path == "/api/state":
                self._send_json(self._state())
            elif path == f"/api/tasks/{TASK_ID}/runs":
                self._send_json({"runs": summarize_task(TASK_ID)})
            elif path == "/api/agent/state":
                self._send_json(agent_state_payload(project_id))
            elif path == "/api/agent/graph":
                self._send_json(load_agent_graph())
            elif path == "/api/agent/designs":
                self._send_json({"designs": list_agent_designs()})
            elif path.startswith("/api/agent/designs/"):
                design_id = _run_component(
                    path.removeprefix("/api/agent/designs/"), "design_id"
                )
                self._send_json(load_agent_design(design_id))
            elif path == "/api/homework/state":
                self._send_json(_homework_payload())
            elif path == "/api/homework/runs":
                self._send_json({"runs": summarize_task(HOMEWORK_TASK_ID)})
            elif path.startswith("/api/homework/runs/"):
                run_id = _run_component(path.removeprefix("/api/homework/runs/"), "run_id")
                run_dir = RUNS_ROOT / HOMEWORK_TASK_ID / run_id
                metadata_path = run_dir / "metadata.json"
                if not metadata_path.is_file():
                    self._send_error_json("课后作业运行记录不存在", HTTPStatus.NOT_FOUND)
                    return
                report_path = run_dir / "test_report.json"
                report = (
                    json.loads(report_path.read_text(encoding="utf-8"))
                    if report_path.is_file()
                    else {}
                )
                self._send_json(_run_payload(run_dir, report))
            elif path == "/api/param-lab":
                self._send_json(describe_param_lab())
            elif path == "/api/agent/runs":
                self._send_json({"runs": list_agent_runs(project_id)})
            elif path.startswith("/api/agent/runs/") and path.endswith("/handoffs"):
                run_id = _run_component(
                    path.removeprefix("/api/agent/runs/").removesuffix("/handoffs"),
                    "run_id",
                )
                self._send_json(list_agent_handoffs(run_id))
            elif path.startswith("/api/agent/runs/") and "/handoffs/" in path:
                rest = path.removeprefix("/api/agent/runs/")
                run_id, _, edge_id = rest.partition("/handoffs/")
                run_id = _run_component(run_id, "run_id")
                self._send_json(load_agent_handoff(run_id, edge_id))
            elif path.startswith("/api/agent/runs/"):
                run_id = _run_component(path.removeprefix("/api/agent/runs/"), "run_id")
                self._send_json(load_agent_run(run_id))
            elif path.startswith("/api/agent/jobs/"):
                job_id = _run_component(path.removeprefix("/api/agent/jobs/"), "job_id")
                with _AGENT_JOBS_LOCK:
                    job = _AGENT_JOBS.get(job_id)
                    if job is None:
                        payload = None
                    else:
                        payload = json.loads(
                            json.dumps(_job_public_payload(job), ensure_ascii=False)
                        )
                if payload is None:
                    self._send_error_json("Agent 作业不存在或已过期", HTTPStatus.NOT_FOUND)
                    return
                self._send_json(payload)
            elif path.startswith("/api/prompts/"):
                prompt_id = path.removeprefix("/api/prompts/")
                self._send_json({"id": prompt_id, "content": _prompt_path(prompt_id).read_text(encoding="utf-8")})
            elif path.startswith(f"/api/runs/{TASK_ID}/"):
                run_id = _run_component(path.removeprefix(f"/api/runs/{TASK_ID}/"), "run_id")
                run_dir = RUNS_ROOT / TASK_ID / run_id
                metadata_path = run_dir / "metadata.json"
                if not metadata_path.is_file():
                    self._send_error_json("运行记录不存在", HTTPStatus.NOT_FOUND)
                    return
                report_path = run_dir / "test_report.json"
                report = (
                    json.loads(report_path.read_text(encoding="utf-8"))
                    if report_path.is_file()
                    else {}
                )
                self._send_json(_run_payload(run_dir, report))
            else:
                self._serve_static(path)
        except (ValueError, FileNotFoundError, json.JSONDecodeError) as error:
            self._send_error_json(str(error), HTTPStatus.BAD_REQUEST)

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/homework/prompt":
            try:
                content = _read_json_body(self).get("content")
                if not isinstance(content, str):
                    raise ValueError("Prompt 内容必须是字符串")
                HOMEWORK_PROMPT_PATH.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write(HOMEWORK_PROMPT_PATH, content)
                self._send_json({"ok": True, "saved_at": datetime.now(timezone.utc).isoformat()})
            except (ValueError, OSError, json.JSONDecodeError) as error:
                self._send_error_json(str(error))
            return
        if path == "/api/agent/graph":
            self._send_error_json(
                "Agent 流程固定在 content/agent/simple_eda_agent.json 中；工作台不提供在线编辑。",
                HTTPStatus.FORBIDDEN,
            )
            return
        if path.startswith("/api/prompts/"):
            # 教学阶段的 5 条 Prompt 作为课程材料固定展示，只允许教师直接修改文件。
            self._send_error_json(
                "教学 Prompt 为只读，不能通过工作台修改；请直接在 content/prompts/classroom/ 中维护。",
                HTTPStatus.FORBIDDEN,
            )
            return
        self._send_error_json("未知 API", HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/runs/stream":
            self._handle_stream_generation("classroom")
            return
        if path == "/api/homework/stream":
            self._handle_stream_generation("homework")
            return
        if path == "/api/verify":
            self._handle_verify()
            return
        if path == "/api/homework/run":
            try:
                request = _read_json_body(self)
                content = request.get("content")
                if content is not None:
                    if not isinstance(content, str):
                        raise ValueError("Prompt 内容必须是字符串")
                    if len(content.strip()) < 20:
                        raise ValueError("请先填写一条完整的 Prompt（至少 20 个字符）")
                    HOMEWORK_PROMPT_PATH.parent.mkdir(parents=True, exist_ok=True)
                    _atomic_write(HOMEWORK_PROMPT_PATH, content)
                elif len(_homework_prompt_text().strip()) < 20:
                    raise ValueError("请先在课后作业页面填写 Prompt")
                options = _homework_options(request)
                run_id = f"hw-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}"
                run_dir, report = run_prompt_experiment(
                    task_name=HOMEWORK_TASK_ID,
                    spec_path=HOMEWORK_TASK_DIR / "spec.md",
                    testbench_path=HOMEWORK_TASK_DIR / "tb.sv",
                    testbench_top=HOMEWORK_TESTBENCH_TOP,
                    power_testbench_path=HOMEWORK_TASK_DIR / "power_tb.sv",
                    power_testbench_top=HOMEWORK_POWER_TESTBENCH_TOP,
                    prompt_path=HOMEWORK_PROMPT_PATH,
                    run_id=run_id,
                    **options,
                )
                self._send_json(_run_payload(run_dir, report))
            except (ValueError, FileNotFoundError, RuntimeError, json.JSONDecodeError) as error:
                self._send_error_json(str(error))
            except Exception as error:  # 保留服务端细节，避免网页端因模型/工具异常崩溃。
                self._send_error_json(f"课后作业运行失败：{error}", HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path == "/api/agent/designs":
            try:
                request = _read_json_body(self)
                record = save_agent_design(
                    name=request.get("name", ""),
                    graph=request.get("graph"),
                    description=request.get("description", ""),
                    design_id=request.get("id") or None,
                )
                self._send_json(record, HTTPStatus.CREATED)
            except (ValueError, FileNotFoundError, json.JSONDecodeError) as error:
                self._send_error_json(str(error))
            return
        if path == "/api/agent/jobs":
            try:
                request = _read_json_body(self)
                # Agent 流程固定在代码/JSON 中，网页端只提交运行参数。
                options = _agent_options(request)
                job_id = uuid.uuid4().hex[:12]
                timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                with _AGENT_JOBS_LOCK:
                    _AGENT_JOBS[job_id] = {
                        "job_id": job_id,
                        "project_id": options.get("project_id") or DEFAULT_PROJECT_ID,
                        "status": "running",
                        "created_at": timestamp,
                        "updated_at": timestamp,
                        "run_id": None,
                        "events": [],
                        "error": None,
                        "result": None,
                        "cancel_event": threading.Event(),
                        "input_event": threading.Event(),
                        "input_request": None,
                        "input_value": None,
                    }
                thread = threading.Thread(
                    target=_execute_agent_job,
                    args=(job_id, options),
                    name=f"agent-job-{job_id}",
                    daemon=True,
                )
                thread.start()
                self._send_json({"job_id": job_id, "status": "running"}, HTTPStatus.ACCEPTED)
            except (ValueError, FileNotFoundError, RuntimeError, json.JSONDecodeError) as error:
                self._send_error_json(str(error))
            except Exception as error:
                self._send_error_json(f"无法启动 Agent 作业：{error}", HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path.startswith("/api/agent/jobs/") and path.endswith("/input"):
            job_id = _run_component(
                path.removeprefix("/api/agent/jobs/").removesuffix("/input"), "job_id"
            )
            try:
                response = _read_json_body(self).get("response")
                if not isinstance(response, str) or not response.strip():
                    raise ValueError("补充内容不能为空")
                with _AGENT_JOBS_LOCK:
                    job = _AGENT_JOBS.get(job_id)
                    if job is None:
                        self._send_error_json("Agent 作业不存在或已过期", HTTPStatus.NOT_FOUND)
                        return
                    if job["status"] not in {"waiting_input", "cancelling"}:
                        self._send_error_json("Agent 当前不在等待 Spec 补充", HTTPStatus.CONFLICT)
                        return
                    job["input_value"] = response.strip()
                    job["input_event"].set()
                    job["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                self._send_json({"ok": True, "status": "running"})
            except (ValueError, json.JSONDecodeError) as error:
                self._send_error_json(str(error))
            return
        if path.startswith("/api/agent/jobs/") and path.endswith("/cancel"):
            job_id = _run_component(
                path.removeprefix("/api/agent/jobs/").removesuffix("/cancel"), "job_id"
            )
            with _AGENT_JOBS_LOCK:
                job = _AGENT_JOBS.get(job_id)
                if job is None:
                    self._send_error_json("Agent 作业不存在或已过期", HTTPStatus.NOT_FOUND)
                    return
                if job["status"] in _FINISHED_JOB_STATES:
                    self._send_json({"job_id": job_id, "status": job["status"]})
                    return
                job["cancel_event"].set()
                job["input_event"].set()
                job["status"] = "cancelling"
                job["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
            self._send_json({"job_id": job_id, "status": "cancelling"})
            return
        if path == "/api/agent/run":
            try:
                request = _read_json_body(self)
                options = _agent_options(request)
                result = run_agent(**options)
                self._send_json(result)
            except (ValueError, FileNotFoundError, RuntimeError, json.JSONDecodeError) as error:
                self._send_error_json(str(error))
            except Exception as error:
                self._send_error_json(f"Agent 运行失败：{error}", HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path == "/api/param-lab/run":
            try:
                request = _read_json_body(self)
                demo_id = request.get("demo_id")
                if not isinstance(demo_id, str) or not demo_id:
                    raise ValueError("缺少参数实验编号")
                self._send_json(run_param_demo(demo_id, request))
            except (ValueError, RuntimeError, json.JSONDecodeError) as error:
                self._send_error_json(str(error))
            except Exception as error:  # 保留服务端细节，避免网页端因模型异常崩溃。
                self._send_error_json(f"参数实验失败：{error}", HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path != "/api/runs":
            self._send_error_json("未知 API", HTTPStatus.NOT_FOUND)
            return
        try:
            request = _read_json_body(self)
            if request.get("task_id") != TASK_ID:
                raise ValueError("当前工作台只开放课堂教学任务")
            prompt_id = request.get("prompt_id")
            if not isinstance(prompt_id, str):
                raise ValueError("缺少 Prompt 条件")
            prompt_path = _prompt_path(prompt_id)
            content = request.get("content")
            if content is not None:
                if not isinstance(content, str):
                    raise ValueError("Prompt 内容必须是字符串")
                _atomic_write(prompt_path, content)
            temperature = float(request.get("temperature", 0.2))
            max_tokens = int(request.get("max_tokens", 4096))
            thinking = bool(request.get("thinking", False))
            reasoning_effort = str(request.get("reasoning_effort", "high"))
            if reasoning_effort not in {"low", "high", "max"}:
                raise ValueError("reasoning_effort 无效")
            run_id = f"web-{prompt_id}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}"
            run_dir, report = run_prompt_experiment(
                task_name=TASK_ID,
                spec_path=TASK_DIR / "spec.md",
                testbench_path=TASK_DIR / "tb.sv",
                testbench_top="tb_classroom_seq1011",
                power_testbench_path=TASK_DIR / "power_tb.sv",
                power_testbench_top="tb_power_classroom_seq1011",
                prompt_path=prompt_path,
                run_id=run_id,
                temperature=temperature,
                max_tokens=max_tokens,
                thinking=thinking,
                reasoning_effort=reasoning_effort,
            )
            self._send_json(_run_payload(run_dir, report))
        except (ValueError, FileNotFoundError, RuntimeError, json.JSONDecodeError) as error:
            self._send_error_json(str(error))
        except Exception as error:  # 保留服务端细节，避免网页端因模型/工具异常崩溃。
            self._send_error_json(f"运行失败：{error}", HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_DELETE(self) -> None:  # noqa: N802
        """删除运行记录；路径始终限制在已登记的 runs 目录内。"""
        parsed = urlparse(self.path)
        path = parsed.path
        project_id = _query_value(parsed, "project", DEFAULT_PROJECT_ID)
        if path.startswith("/api/agent/designs/"):
            try:
                design_id = _run_component(
                    path.removeprefix("/api/agent/designs/"), "design_id"
                )
                delete_agent_design(design_id)
                self._send_json({"ok": True, "deleted": design_id})
            except FileNotFoundError as error:
                self._send_error_json(str(error), HTTPStatus.NOT_FOUND)
            except (ValueError, OSError) as error:
                self._send_error_json(str(error))
            return
        if path == "/api/agent/runs":
            try:
                deleted = clear_agent_runs(project_id)
                self._send_json({"ok": True, "deleted": deleted})
            except OSError as error:
                self._send_error_json(str(error), HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path.startswith("/api/agent/runs/"):
            try:
                run_id = _run_component(path.removeprefix("/api/agent/runs/"), "run_id")
                delete_agent_run(run_id)
                self._send_json({"ok": True, "deleted": run_id})
            except FileNotFoundError as error:
                self._send_error_json(str(error), HTTPStatus.NOT_FOUND)
            except (ValueError, OSError) as error:
                self._send_error_json(str(error))
            return
        if path == "/api/homework/runs":
            try:
                homework_root = RUNS_ROOT / HOMEWORK_TASK_ID
                if homework_root.exists():
                    for run_dir in homework_root.iterdir():
                        if run_dir.is_dir():
                            shutil.rmtree(run_dir)
                self._send_json({"ok": True, "deleted": "all"})
            except OSError as error:
                self._send_error_json(str(error), HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path.startswith("/api/homework/runs/"):
            try:
                run_id = _run_component(path.removeprefix("/api/homework/runs/"), "run_id")
                homework_root = (RUNS_ROOT / HOMEWORK_TASK_ID).resolve()
                run_dir = (homework_root / run_id).resolve()
                if homework_root not in run_dir.parents or not run_dir.is_dir():
                    self._send_error_json("课后作业运行记录不存在", HTTPStatus.NOT_FOUND)
                    return
                shutil.rmtree(run_dir)
                self._send_json({"ok": True, "deleted": run_id})
            except (ValueError, OSError) as error:
                self._send_error_json(str(error))
            return
        prefix = f"/api/runs/{TASK_ID}"
        if path != prefix and not path.startswith(prefix + "/"):
            self._send_error_json("未知 API", HTTPStatus.NOT_FOUND)
            return
        try:
            task_run_root = (RUNS_ROOT / TASK_ID).resolve()
            if path == prefix:
                if task_run_root.exists():
                    for run_dir in task_run_root.iterdir():
                        if run_dir.is_dir():
                            shutil.rmtree(run_dir)
                self._send_json({"ok": True, "deleted": "all"})
                return
            run_id = _run_component(path.removeprefix(prefix + "/"), "run_id")
            run_dir = (task_run_root / run_id).resolve()
            if task_run_root not in run_dir.parents or not run_dir.is_dir():
                self._send_error_json("运行记录不存在", HTTPStatus.NOT_FOUND)
                return
            shutil.rmtree(run_dir)
            self._send_json({"ok": True, "deleted": run_id})
        except (ValueError, OSError) as error:
            self._send_error_json(str(error))


def serve(host: str = "127.0.0.1", port: int = 8000) -> None:
    """启动仅绑定本机回环地址的工作台。"""
    if host not in {"127.0.0.1", "localhost"}:
        raise ValueError("为保护本地 API 与 Prompt 文件，服务仅允许绑定 127.0.0.1 或 localhost")
    server = ThreadingHTTPServer((host, port), WorkbenchHandler)
    print(f"AI EDA Workbench: http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
