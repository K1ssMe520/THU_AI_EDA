"""本地 HTML 工作台的受限 HTTP 服务。"""

from __future__ import annotations

import json
import mimetypes
import shutil
import tempfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from .agent_runner import AGENT_RUNS_ROOT, load_agent_graph, run_agent, save_agent_graph
from .runner import PROJECT_ROOT, RUNS_ROOT, _run_component, run_prompt_experiment, summarize_task

WEB_ROOT = PROJECT_ROOT / "web"
TASK_ID = "classroom_seq1011"
TASK_DIR = PROJECT_ROOT / "prompt_optimization" / "tasks" / TASK_ID
PROMPT_ROOT = PROJECT_ROOT / "prompt_optimization" / "prompts" / "classroom"
PROMPTS: dict[str, dict[str, str]] = {
    "p1": {
        "file": "P1_contract.md",
        "title": "P1 · 完整功能契约",
        "description": "单一、自包含的功能与协议规格。",
    },
    "p2": {
        "file": "P2_interface_and_arithmetic.md",
        "title": "P2 · 接口与时序",
        "description": "以条目形式固定接口、时序与输出边界。",
    },
    "p3": {
        "file": "P3_timing_and_backpressure.md",
        "title": "P3 · 协议契约",
        "description": "明确握手、反压、重叠匹配与同步复位。",
    },
    "p3_1": {
        "file": "P3_1_sync_reset_clarification.md",
        "title": "P3.1 · 同步复位",
        "description": "独立强调同步复位的边沿语义。",
    },
    "p4": {
        "file": "P4_full_contract.md",
        "title": "P4 · 最小 FSM / 面积",
        "description": "在完整契约下约束状态实现与无效翻转。",
    },
}


def _prompt_path(prompt_id: str) -> Path:
    definition = PROMPTS.get(prompt_id)
    if definition is None:
        raise ValueError("未知 Prompt 条件")
    return PROMPT_ROOT / definition["file"]


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
            "homework": {"enabled": False},
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
        path = urlparse(self.path).path
        try:
            if path == "/api/state":
                self._send_json(self._state())
            elif path == f"/api/tasks/{TASK_ID}/runs":
                self._send_json({"runs": summarize_task(TASK_ID)})
            elif path == "/api/agent/graph":
                self._send_json(load_agent_graph())
            elif path.startswith("/api/agent/runs/"):
                run_id = _run_component(path.removeprefix("/api/agent/runs/"), "run_id")
                event_path = AGENT_RUNS_ROOT / run_id / "events.json"
                if not event_path.is_file():
                    self._send_error_json("Agent 运行记录不存在", HTTPStatus.NOT_FOUND)
                    return
                self._send_json(json.loads(event_path.read_text(encoding="utf-8")))
            elif path.startswith("/api/prompts/"):
                prompt_id = path.removeprefix("/api/prompts/")
                self._send_json({"id": prompt_id, "content": _prompt_path(prompt_id).read_text(encoding="utf-8")})
            elif path.startswith(f"/api/runs/{TASK_ID}/"):
                run_id = _run_component(path.removeprefix(f"/api/runs/{TASK_ID}/"), "run_id")
                run_dir = RUNS_ROOT / TASK_ID / run_id
                report_path = run_dir / "test_report.json"
                if not report_path.is_file():
                    self._send_error_json("运行记录不存在", HTTPStatus.NOT_FOUND)
                    return
                self._send_json(_run_payload(run_dir, json.loads(report_path.read_text(encoding="utf-8"))))
            else:
                self._serve_static(path)
        except (ValueError, FileNotFoundError, json.JSONDecodeError) as error:
            self._send_error_json(str(error), HTTPStatus.BAD_REQUEST)

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/agent/graph":
            try:
                self._send_json(save_agent_graph(_read_json_body(self)))
            except (ValueError, FileNotFoundError, json.JSONDecodeError) as error:
                self._send_error_json(str(error))
            return
        if not path.startswith("/api/prompts/"):
            self._send_error_json("未知 API", HTTPStatus.NOT_FOUND)
            return
        try:
            prompt_id = path.removeprefix("/api/prompts/")
            content = _read_json_body(self).get("content")
            if not isinstance(content, str):
                raise ValueError("Prompt 内容必须是字符串")
            _atomic_write(_prompt_path(prompt_id), content)
            self._send_json({"ok": True, "saved_at": datetime.now(timezone.utc).isoformat()})
        except (ValueError, FileNotFoundError, json.JSONDecodeError) as error:
            self._send_error_json(str(error))

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/agent/run":
            try:
                request = _read_json_body(self)
                graph = request.get("graph")
                if graph is None:
                    graph = load_agent_graph()
                graph = save_agent_graph(graph)
                result = run_agent(
                    graph,
                    thinking=bool(request.get("thinking", False)),
                    reasoning_effort=str(request.get("reasoning_effort", "high")),
                    temperature=float(request.get("temperature", 0.2)),
                    max_tokens=int(request.get("max_tokens", 4096)),
                )
                self._send_json(result)
            except (ValueError, FileNotFoundError, RuntimeError, json.JSONDecodeError) as error:
                self._send_error_json(str(error))
            except Exception as error:
                self._send_error_json(f"Agent 运行失败：{error}", HTTPStatus.INTERNAL_SERVER_ERROR)
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
        """删除当前课堂任务的实验记录；路径始终限制在该任务 runs 目录内。"""
        path = urlparse(self.path).path
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
