"""固定 Agent 流程的受限 EDA 自动设计执行器。

固定流水线：Parser → RTL Planner → Coder → Tester → Modifier（失败回环）。
- Parser 判断 Spec 是否充分；不充分时通过 ``request_input`` 回调暂停并等待用户补充；
- Planner 输出模块与文件计划；
- Coder 按计划逐文件生成 RTL；
- Tester 编译全部文件、运行固定教师 TB 并评估面积 / 功耗；
- Modifier 在 Tester 失败时修改 RTL，然后回到 Tester，最多 3 轮测试。

网页只展示固定流程与运行过程；Skill / function calling 暂不接入本流程。
"""

from __future__ import annotations

import json
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .api import RTL_SYSTEM_PROMPT, ModelClient
from .runner import PROJECT_ROOT, _run_component, extract_rtl, save_report, test_rtl
from .tooling import build_tool_definitions, execute_tool, list_skills, tool_catalog
from agent_optimization.subagents.base import RunContext
from agent_optimization.subagents.coder import CoderAgent
from agent_optimization.subagents.modifier import ModifierAgent
from agent_optimization.subagents.parser import ParserAgent
from agent_optimization.subagents.planner import PlannerAgent
from agent_optimization.subagents.tester import TesterAgent

AGENT_ROOT = PROJECT_ROOT / "agent_optimization"
AGENT_DEFINITION_PATH = AGENT_ROOT / "agents" / "simple_eda_agent.json"
AGENT_DESIGNS_ROOT = AGENT_ROOT / "agents" / "designs"
AGENT_RUNS_ROOT = AGENT_ROOT / "runs"
AGENT_TASK_DIR = AGENT_ROOT / "tasks" / "rise_edge"
AGENT_TASK_SPEC_PATH = AGENT_TASK_DIR / "spec.md"
NODE_TYPES = {"model", "verify"}
MAX_MODEL_TOOLS = 12
NODE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
DESIGN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
AGENT_TASK_NAME = "agent_rise_edge"
MAX_STEPS = 40
MAX_RETRIES = 5
EventSink = Callable[[dict[str, Any]], None]


class AgentCancelled(RuntimeError):
    """用户主动停止 Agent 运行时抛出。"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _write_json(path: Path, payload: Any) -> None:
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary_path.replace(path)


def load_agent_graph() -> dict[str, Any]:
    """读取默认 Agent 图；旧版 Spec/Report 节点会自动迁移掉。"""
    return normalize_agent_graph(
        json.loads(AGENT_DEFINITION_PATH.read_text(encoding="utf-8"))
    )


def agent_task_spec() -> str:
    """固定输入：Agent 任务的公开 Spec。"""
    return AGENT_TASK_SPEC_PATH.read_text(encoding="utf-8")


def _allowed_tool_names() -> set[str]:
    catalog = tool_catalog()
    names = {item["name"] for item in catalog["builtin"]}
    names.update(f"skill_{item['name']}" for item in catalog["skills"] if item.get("available"))
    return names


def normalize_agent_graph(graph: Any) -> dict[str, Any]:
    """兼容旧图：移除 Spec/Report 节点，保留 Model/Verify 主链与重试。"""
    if not isinstance(graph, dict):
        return graph
    raw_nodes = graph.get("nodes") if isinstance(graph.get("nodes"), list) else []
    raw_edges = graph.get("edges") if isinstance(graph.get("edges"), list) else []
    by_id = {
        node.get("id"): node
        for node in raw_nodes
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    if not by_id:
        return graph
    next_from: dict[str, str] = {}
    for edge in raw_edges:
        if not isinstance(edge, dict):
            continue
        source, target = edge.get("from"), edge.get("to")
        if source in by_id and target in by_id:
            next_from[source] = target

    entry = graph.get("entry")
    order: list[str] = []
    seen: set[str] = set()
    current = entry if entry in by_id else None
    while current and current not in seen:
        seen.add(current)
        order.append(current)
        current = next_from.get(current)
    # 不在主链上的节点也保留，避免用户图被静默删除
    for node_id in by_id:
        if node_id not in seen:
            order.append(node_id)
            seen.add(node_id)

    kept = [node_id for node_id in order if by_id[node_id].get("type") in NODE_TYPES]
    if not kept:
        kept = [
            node_id
            for node_id in order
            if by_id[node_id].get("type") in {"model", "verify"}
        ]
    if not kept:
        # 没有可用节点时构造一个默认 Model，保证图仍可运行
        kept = ["designer"]
        by_id["designer"] = {
            "id": "designer",
            "type": "model",
            "title": "01 · RTL Designer",
            "prompt": "根据以下冻结规格生成可编译的 SystemVerilog RTL，只输出模块源码。\n\n{spec}\n\n当前为第 {attempt} 轮。\n{verify_feedback}",
            "x": 72,
            "y": 120,
        }
        order = ["designer"]

    nodes: list[dict[str, Any]] = []
    for node_id in kept:
        node = dict(by_id[node_id])
        node.pop("retry", None)
        if node.get("type") == "model":
            raw_tools = node.get("tools")
            node["tools"] = (
                [name for name in raw_tools if isinstance(name, str)]
                if isinstance(raw_tools, list)
                else []
            )
        nodes.append(node)

    edges: list[dict[str, str]] = []
    for index in range(len(nodes) - 1):
        edges.append({"from": nodes[index]["id"], "to": nodes[index + 1]["id"]})
    # 迁移旧 Verify 节点的重试目标
    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict):
            continue
        node_id = raw_node.get("id")
        retry = raw_node.get("retry")
        if node_id not in kept or not isinstance(retry, dict):
            continue
        target = retry.get("target")
        if target in kept:
            for node in nodes:
                if node["id"] == node_id:
                    node["retry"] = {"target": target, "max": retry.get("max", 2)}
                    break
    return {
        "name": str(graph.get("name") or "Agent 设计流程"),
        "entry": nodes[0]["id"],
        "nodes": nodes,
        "edges": edges,
    }


def agent_state_payload() -> dict[str, Any]:
    """Agent 页面初始状态：固定 Spec（Skill / function calling 暂不接入）。"""
    return {"spec": agent_task_spec()}


def _normalize_retry(
    node: dict[str, Any], node_id: str, nodes: dict[str, dict[str, Any]], order: list[str]
) -> dict[str, Any] | None:
    retry = node.get("retry")
    if retry is None:
        return None
    if node.get("type") != "verify":
        raise ValueError("只有 Verify 节点可以配置失败重试")
    if not isinstance(retry, dict):
        raise ValueError("重试配置格式无效")
    target = retry.get("target")
    maximum = retry.get("max", 1)
    if not isinstance(target, str) or target not in nodes:
        raise ValueError("重试目标节点不存在")
    if nodes[target]["type"] != "model":
        raise ValueError("重试目标必须是 Model 节点")
    if isinstance(maximum, bool) or not isinstance(maximum, int) or not 1 <= maximum <= MAX_RETRIES:
        raise ValueError(f"重试次数必须在 1 到 {MAX_RETRIES} 之间")
    if node_id not in order or target not in order or order.index(target) >= order.index(node_id):
        raise ValueError("重试目标必须位于当前 Verify 节点之前")
    return {"target": target, "max": maximum}


def validate_agent_graph(graph: Any) -> dict[str, Any]:
    """验证可执行的受限工作流，避免网页成为任意脚本执行器。"""
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
        raise ValueError("Agent 图必须包含 nodes 数组")
    if not isinstance(graph.get("edges"), list):
        raise ValueError("Agent 图必须包含 edges 数组")
    if not isinstance(graph.get("name"), str) or not graph["name"].strip():
        raise ValueError("Agent 图缺少名称")
    if not 1 <= len(graph["nodes"]) <= 16:
        raise ValueError("Agent 图节点数必须在 1 到 16 之间")

    nodes: dict[str, dict[str, Any]] = {}
    for node in graph["nodes"]:
        if not isinstance(node, dict):
            raise ValueError("Agent 节点格式无效")
        node_id = node.get("id")
        if not isinstance(node_id, str) or not NODE_ID_PATTERN.fullmatch(node_id) or node_id in nodes:
            raise ValueError("Agent 节点 ID 无效或重复")
        if node.get("type") not in NODE_TYPES:
            raise ValueError("Agent 节点类型无效；Spec 与 Summary 已改为固定输入/输出")
        title, prompt = node.get("title"), node.get("prompt")
        if not isinstance(title, str) or not isinstance(prompt, str):
            raise ValueError("Agent 节点必须包含标题和 Prompt")
        if len(prompt) > 30_000:
            raise ValueError("单个节点 Prompt 过长")
        try:
            x = max(0.0, min(float(node.get("x", 0)), 4000))
            y = max(0.0, min(float(node.get("y", 0)), 4000))
        except (TypeError, ValueError) as error:
            raise ValueError("Agent 节点坐标无效") from error
        clean_node = {
            "id": node_id,
            "type": node["type"],
            "title": title.strip()[:100],
            "prompt": prompt,
            "x": x,
            "y": y,
        }
        if node["type"] == "model":
            raw_tools = node.get("tools", [])
            if not isinstance(raw_tools, list) or any(
                not isinstance(name, str) for name in raw_tools
            ):
                raise ValueError("Model 节点的 tools 必须是字符串数组")
            allowed = _allowed_tool_names()
            tools = []
            for name in raw_tools:
                if name in allowed and name not in tools:
                    tools.append(name)
            if len(tools) > MAX_MODEL_TOOLS:
                raise ValueError(f"单个 Model 节点最多启用 {MAX_MODEL_TOOLS} 个工具")
            clean_node["tools"] = tools
        nodes[node_id] = clean_node

    entry = graph.get("entry")
    if entry not in nodes:
        raise ValueError("Agent 入口节点不存在")
    if nodes[entry]["type"] != "model":
        raise ValueError("Agent 入口必须是 Model 节点")

    outgoing: dict[str, str] = {}
    incoming: set[str] = set()
    edges: list[dict[str, str]] = []
    for edge in graph["edges"]:
        if not isinstance(edge, dict):
            raise ValueError("Agent 连线格式无效")
        source, target = edge.get("from"), edge.get("to")
        if source not in nodes or target not in nodes or source == target:
            raise ValueError("Agent 连线引用了不存在的节点")
        if source in outgoing:
            raise ValueError("每个节点只能有一个后继；分支请使用 Verify 的重试配置")
        if target in incoming:
            raise ValueError("每个节点只能有一个前驱")
        outgoing[source] = target
        incoming.add(target)
        edges.append({"from": source, "to": target})

    order: list[str] = []
    current: str | None = entry
    while current and current not in order:
        order.append(current)
        current = outgoing.get(current)

    for raw_node in graph["nodes"]:
        node_id = raw_node["id"]
        retry = _normalize_retry(raw_node, node_id, nodes, order)
        if retry is not None:
            nodes[node_id]["retry"] = retry
    model_positions = [index for index, node_id in enumerate(order) if nodes[node_id]["type"] == "model"]
    if not model_positions:
        raise ValueError("Agent 图至少需要一个 Model 节点")
    for node_id in order:
        if nodes[node_id]["type"] == "verify" and not any(
            nodes[order[index]]["type"] == "model" for index in range(order.index(node_id))
        ):
            raise ValueError("Verify 节点之前必须先有 Model 节点")

    return {
        "name": graph["name"].strip()[:100],
        "entry": entry,
        "nodes": list(nodes.values()),
        "edges": edges,
    }


def save_agent_graph(graph: dict[str, Any]) -> dict[str, Any]:
    """原子保存用户构建的 Agent 图（自动迁移旧版 Spec/Report 节点）。"""
    clean = validate_agent_graph(normalize_agent_graph(graph))
    _write_json(AGENT_DEFINITION_PATH, clean)
    return clean


def _render_prompt(template: str, context: dict[str, Any]) -> str:
    """替换已知变量；未知变量保持原样，便于发现 Prompt 拼写错误。"""
    return re.sub(
        r"\{([a-z_]+)\}",
        lambda match: str(context.get(match.group(1), match.group(0))),
        template,
    )


def _stage_label(stage: str | None) -> str:
    return {"compile": "编译", "simulation": "仿真"}.get(stage or "", stage or "未知阶段")


def _report_summary(report: dict[str, Any] | None) -> str:
    if report is None:
        return "验证尚未执行。"
    if report.get("passed"):
        return f"教师 TB 通过（{_stage_label(report.get('stage'))}）。"
    checks = report.get("checks") or []
    failed = "、".join(item.get("name", "检查") for item in checks[:4])
    suffix = f"，失败检查：{failed}" if failed else ""
    return f"教师 TB 失败（{_stage_label(report.get('stage'))}）{suffix}。"


def _event_status(node_type: str, report: dict[str, Any] | None) -> str:
    if node_type == "verify" and report is not None:
        return "passed" if report.get("passed") else "failed"
    return "info"


def _check_cancel(cancel_event: Any) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise AgentCancelled("Agent 运行已取消。")


def _run_payload(
    *,
    run_id: str,
    run_dir: Path,
    graph: dict[str, Any],
    events: list[dict[str, Any]],
    status: str,
    started_at: str,
    finished_at: str | None = None,
    report: dict[str, Any] | None = None,
    result: dict[str, Any] | None = None,
    spec: str | None = None,
    error: str | None = None,
    design_id: str | None = None,
    design_name: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "run_id": run_id,
        "run_dir": str(run_dir),
        "graph": graph,
        "status": status,
        "started_at": started_at,
        "updated_at": _now(),
        "events": events,
        "report": report,
        "result": result,
        "spec": spec,
    }
    if finished_at:
        payload["finished_at"] = finished_at
    if error:
        payload["error"] = error
    if design_id:
        payload["design_id"] = design_id
    if design_name:
        payload["design_name"] = design_name
    return payload


def _write_metadata(
    run_dir: Path,
    *,
    graph: dict[str, Any],
    run_id: str,
    status: str,
    started_at: str,
    finished_at: str,
    attempts: int,
    temperature: float,
    max_tokens: int,
    thinking: bool,
    reasoning_effort: str,
    design_id: str | None = None,
    design_name: str | None = None,
) -> None:
    metadata = {
        "run_id": run_id,
        "agent_name": graph["name"],
        "status": status,
        "started_at": started_at,
        "finished_at": finished_at,
        "attempts": attempts,
        "model": ModelClient.MODEL_NAME,
        "base_url": ModelClient.BASE_URL,
        "temperature": None if thinking else temperature,
        "max_tokens": max_tokens,
        "thinking": thinking,
        "reasoning_effort": reasoning_effort if thinking else None,
        "generation_mode": "agent_workflow_with_optional_retry",
    }
    if design_id:
        metadata["design_id"] = design_id
    if design_name:
        metadata["design_name"] = design_name
    _write_json(run_dir / "metadata.json", metadata)


def run_agent(
    graph: dict[str, Any],
    *,
    thinking: bool = False,
    reasoning_effort: str = "high",
    temperature: float = 0.2,
    max_tokens: int = 4096,
    on_event: EventSink | None = None,
    cancel_event: Any = None,
    design_id: str | None = None,
    design_name: str | None = None,
    request_input: Callable[[dict[str, Any]], str] | None = None,
) -> dict[str, Any]:
    """编排独立子 Agent：Parser → Planner → Coder → Tester ⇄ Modifier。

    每个子 Agent 有独立的 Python 文件、context.json 与输出目录；它们之间只通过
    ``handoffs/<source>_to_<target>.json`` 交换数据。网页只通过 run payload 与
    handoff API 读取过程和交接内容。
    """
    graph = load_agent_graph()
    if reasoning_effort not in {"low", "high", "max"}:
        raise ValueError("reasoning_effort 无效")
    spec_base = agent_task_spec()
    run_id = f"agent-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}"
    run_dir = AGENT_RUNS_ROOT / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    _write_json(run_dir / "graph.json", graph)
    (run_dir / "project").mkdir(exist_ok=True)

    events: list[dict[str, Any]] = []
    started_at = _now()
    started_clock = time.perf_counter()
    current_status = "running"
    final_report: dict[str, Any] | None = None
    final_result: dict[str, Any] | None = None
    effective_spec = spec_base
    parser_result: dict[str, Any] = {}
    plan: dict[str, Any] | None = None
    files: dict[str, str] = {}
    tester_attempts = 0

    def persist(status: str = "running", error: str | None = None) -> None:
        _write_json(
            run_dir / "events.json",
            _run_payload(
                run_id=run_id,
                run_dir=run_dir,
                graph=graph,
                events=events,
                status=status,
                started_at=started_at,
                report=final_report,
                result=final_result,
                spec=effective_spec,
                error=error,
                design_id=design_id,
                design_name=design_name,
            ),
        )

    def emit(event: dict[str, Any]) -> None:
        if on_event is not None:
            on_event(json.loads(json.dumps(event, ensure_ascii=False)))

    def begin_event(
        node_id: str, node_type: str, title: str, prompt: str, attempt: int = 1
    ) -> dict[str, Any]:
        event: dict[str, Any] = {
            "run_id": run_id,
            "step": len(events) + 1,
            "node_id": node_id,
            "node_type": node_type,
            "title": title,
            "prompt": prompt,
            "status": "running",
            "attempt": attempt,
            "started_at": _now(),
            "_started_clock": time.perf_counter(),
        }
        events.append(event)
        persist()
        emit(event)
        return event

    def finish_event(event: dict[str, Any], status: str, **fields: Any) -> None:
        event.update(fields)
        event["status"] = status
        event["duration_ms"] = round(
            (time.perf_counter() - event.get("_started_clock", time.perf_counter())) * 1000
        )
        event.pop("_started_clock", None)
        event["finished_at"] = _now()
        persist()
        emit(event)

    def check_cancel() -> None:
        _check_cancel(cancel_event)

    persist()
    try:
        context = RunContext(
            run_dir=run_dir,
            options={
                "temperature": temperature,
                "max_tokens": max_tokens,
                "thinking": thinking,
                "reasoning_effort": reasoning_effort,
            },
            begin_event=begin_event,
            finish_event=finish_event,
            persist=persist,
            emit=emit,
            check_cancel=check_cancel,
            request_input=request_input,
        )
        context.write_handoff(
            "spec",
            "parser",
            {"task": "rise_edge", "spec": spec_base},
            label="固定 Spec → Parser",
        )

        parser = ParserAgent(context)
        parser_result = parser.run(spec_base)
        effective_spec = parser_result["effective_spec"]

        planner = PlannerAgent(context)
        plan = planner.run(effective_spec)

        coder = CoderAgent(context)
        coder_result = coder.run(effective_spec, plan)
        files = coder_result["files"]

        tester = TesterAgent(context)
        modifier = ModifierAgent(context)
        while True:
            tester_attempts += 1
            report = tester.run(plan, files, tester_attempts)
            final_report = report
            if report.get("passed"):
                break
            if tester_attempts >= 3:
                break
            check_cancel()
            changed = modifier.run(
                effective_spec, plan, files, report, tester_attempts
            )
            files.update(changed)

        if final_report is None:
            raise ValueError("Tester 没有产出验收报告")
        passed = bool(final_report.get("passed"))
        final_result = {
            "passed": passed,
            "stage": final_report.get("stage"),
            "summary": _report_summary(final_report),
            "metrics": final_report.get("metrics") or {},
            "spec": effective_spec,
            "plan": plan,
            "files": [
                {"path": path, "bytes": len(content.encode("utf-8"))}
                for path, content in files.items()
            ],
            "parser_rounds": parser_result.get("rounds", 1),
            "supplements": parser_result.get("supplements", []),
            "tester_attempts": tester_attempts,
        }
        _write_json(run_dir / "result.json", final_result)
        context.write_handoff(
            "tester",
            "summary",
            {
                "result": final_result,
                "report": final_report,
                "summary": _report_summary(final_report),
            },
            attempt=tester_attempts,
            label="Tester → Summary：最终验收结果",
        )
        current_status = "passed" if passed else "failed"
    except AgentCancelled as error:
        current_status = "cancelled"
        for pending in events:
            if pending.get("status") in {"running", "waiting_input"}:
                pending.update(
                    {"status": "cancelled", "finished_at": _now(), "error": str(error)}
                )
        payload = _run_payload(
            run_id=run_id,
            run_dir=run_dir,
            graph=graph,
            events=events,
            status=current_status,
            started_at=started_at,
            finished_at=_now(),
            report=final_report,
            result=final_result,
            spec=effective_spec,
            error=str(error),
            design_id=design_id,
            design_name=design_name,
        )
        payload["duration_ms"] = round((time.perf_counter() - started_clock) * 1000)
        _write_json(run_dir / "events.json", payload)
        try:
            _write_metadata(
                run_dir,
                graph=graph,
                run_id=run_id,
                status=current_status,
                started_at=started_at,
                finished_at=payload["finished_at"],
                attempts=tester_attempts or 1,
                temperature=temperature,
                max_tokens=max_tokens,
                thinking=thinking,
                reasoning_effort=reasoning_effort,
                design_id=design_id,
                design_name=design_name,
            )
        except Exception:
            pass
        raise
    except Exception as error:
        current_status = "failed"
        for pending in events:
            if pending.get("status") in {"running", "waiting_input"}:
                pending.update(
                    {"status": "failed", "finished_at": _now(), "error": str(error)}
                )
        payload = _run_payload(
            run_id=run_id,
            run_dir=run_dir,
            graph=graph,
            events=events,
            status=current_status,
            started_at=started_at,
            finished_at=_now(),
            report=final_report,
            result=final_result,
            spec=effective_spec,
            error=str(error),
            design_id=design_id,
            design_name=design_name,
        )
        payload["duration_ms"] = round((time.perf_counter() - started_clock) * 1000)
        _write_json(run_dir / "events.json", payload)
        try:
            _write_metadata(
                run_dir,
                graph=graph,
                run_id=run_id,
                status=current_status,
                started_at=started_at,
                finished_at=payload["finished_at"],
                attempts=tester_attempts or 1,
                temperature=temperature,
                max_tokens=max_tokens,
                thinking=thinking,
                reasoning_effort=reasoning_effort,
                design_id=design_id,
                design_name=design_name,
            )
        except Exception:
            pass
        raise

    payload = _run_payload(
        run_id=run_id,
        run_dir=run_dir,
        graph=graph,
        events=events,
        status=current_status,
        started_at=started_at,
        finished_at=_now(),
        report=final_report,
        result=final_result,
        spec=effective_spec,
        design_id=design_id,
        design_name=design_name,
    )
    payload["duration_ms"] = round((time.perf_counter() - started_clock) * 1000)
    _write_json(run_dir / "events.json", payload)
    _write_metadata(
        run_dir,
        graph=graph,
        run_id=run_id,
        status=current_status,
        started_at=started_at,
        finished_at=payload["finished_at"],
        attempts=tester_attempts or 1,
        temperature=temperature,
        max_tokens=max_tokens,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
        design_id=design_id,
        design_name=design_name,
    )
    return payload


HANDOFF_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def _agent_run_dir(run_id: str) -> Path:
    run_id = _run_component(run_id, "run_id")
    root = AGENT_RUNS_ROOT.resolve()
    run_dir = (root / run_id).resolve()
    if root not in run_dir.parents or not run_dir.is_dir():
        raise FileNotFoundError("Agent 运行记录不存在")
    return run_dir


def _read_handoff_record(path: Path) -> dict[str, Any] | None:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict):
        return None
    edge_id = record.get("edge_id")
    if not isinstance(edge_id, str) or not HANDOFF_ID_PATTERN.fullmatch(edge_id):
        return None
    return record


def list_agent_handoffs(run_id: str) -> dict[str, Any]:
    run_dir = _agent_run_dir(run_id)
    handoff_dir = run_dir / "handoffs"
    groups: dict[str, list[dict[str, Any]]] = {}
    if handoff_dir.is_dir():
        for path in sorted(handoff_dir.glob("*.json")):
            record = _read_handoff_record(path)
            if record is None:
                continue
            edge_id = record["edge_id"]
            attempt = record.get("attempt")
            groups.setdefault(edge_id, []).append(
                {
                    "file": path.name,
                    "attempt": attempt if isinstance(attempt, int) else None,
                    "created_at": record.get("created_at"),
                    "label": record.get("label") or "",
                    "source": record.get("source"),
                    "target": record.get("target"),
                    "bytes": path.stat().st_size,
                }
            )
    edges = []
    for edge_id, items in groups.items():
        latest = max(
            items,
            key=lambda item: (item.get("attempt") or 0, item.get("created_at") or ""),
        )
        edges.append(
            {
                "edge_id": edge_id,
                "source": latest.get("source"),
                "target": latest.get("target"),
                "label": latest.get("label"),
                "attempts": len(items),
                "latest_attempt": latest.get("attempt"),
                "updated_at": latest.get("created_at"),
                "bytes": latest.get("bytes"),
            }
        )
    edges.sort(key=lambda item: (item.get("source") or "", item.get("target") or ""))
    return {"run_id": run_id, "edges": edges}


def load_agent_handoff(run_id: str, edge_id: str) -> dict[str, Any]:
    if not isinstance(edge_id, str) or not HANDOFF_ID_PATTERN.fullmatch(edge_id):
        raise ValueError("handoff edge_id 无效")
    run_dir = _agent_run_dir(run_id)
    handoff_dir = run_dir / "handoffs"
    if not handoff_dir.is_dir():
        raise FileNotFoundError("该运行尚未产生 handoff")
    items: list[dict[str, Any]] = []
    for path in sorted(handoff_dir.glob("*.json")):
        record = _read_handoff_record(path)
        if record is None or record.get("edge_id") != edge_id:
            continue
        items.append(
            {
                "file": path.name,
                "attempt": record.get("attempt"),
                "created_at": record.get("created_at"),
                "label": record.get("label") or "",
                "source": record.get("source"),
                "target": record.get("target"),
                "payload": record.get("payload"),
            }
        )
    if not items:
        raise FileNotFoundError(f"没有找到 handoff：{edge_id}")
    items.sort(key=lambda item: (item.get("attempt") or 0, item.get("created_at") or ""))
    return {"run_id": run_id, "edge_id": edge_id, "items": items}


def _normalize_run_payload(payload: dict[str, Any], run_dir: Path) -> dict[str, Any]:
    """兼容早期 run 记录，并补齐状态、时间与事件字段。"""
    report = payload.get("report")
    status = payload.get("status")
    if status not in {"running", "completed", "passed", "failed", "cancelled"}:
        if report is None:
            status = "completed"
        else:
            status = "passed" if report.get("passed") else "failed"
        payload["status"] = status
    started_at = payload.get("started_at")
    if not started_at:
        started_at = datetime.fromtimestamp(run_dir.stat().st_mtime, timezone.utc).isoformat(timespec="milliseconds")
        payload["started_at"] = started_at
    payload["updated_at"] = payload.get("updated_at") or started_at
    events = payload.get("events") or []
    for index, event in enumerate(events):
        event.setdefault("step", index + 1)
        event.setdefault("attempt", 1)
        if "status" not in event:
            event_report = event.get("report")
            if event_report is not None:
                event["status"] = "passed" if event_report.get("passed") else "failed"
            else:
                event["status"] = "info"
    if not payload.get("duration_ms") and payload.get("finished_at"):
        try:
            payload["duration_ms"] = int(
                (datetime.fromisoformat(payload["finished_at"]) - datetime.fromisoformat(started_at)).total_seconds() * 1000
            )
        except ValueError:
            pass
    payload.setdefault("run_dir", str(run_dir))
    payload.setdefault("run_id", run_dir.name)
    payload.setdefault("design_id", None)
    payload.setdefault("design_name", None)
    payload.setdefault("spec", agent_task_spec())
    if isinstance(payload.get("graph"), dict):
        payload["graph"] = normalize_agent_graph(payload["graph"])
    if not isinstance(payload.get("result"), dict):
        report = payload.get("report") or {}
        metrics = report.get("metrics") or {}
        payload["result"] = {
            "passed": bool(report.get("passed")),
            "stage": report.get("stage"),
            "summary": _report_summary(report) if report else "未生成最终结果。",
            "metrics": metrics,
            "spec": payload["spec"],
        }
    return payload


def load_agent_run(run_id: str) -> dict[str, Any]:
    """读取一次保存的 Agent 运行记录。"""
    run_id = _run_component(run_id, "run_id")
    run_dir = (AGENT_RUNS_ROOT / run_id).resolve()
    root = AGENT_RUNS_ROOT.resolve()
    if root not in run_dir.parents or not run_dir.is_dir():
        raise FileNotFoundError("Agent 运行记录不存在")
    events_path = run_dir / "events.json"
    if not events_path.is_file():
        raise FileNotFoundError("Agent 运行记录缺少 events.json")
    payload = json.loads(events_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Agent 运行记录格式无效")
    return _normalize_run_payload(payload, run_dir)


def list_agent_runs(limit: int = 40) -> list[dict[str, Any]]:
    """按时间倒序列出 Agent 运行摘要。"""
    if limit <= 0:
        return []
    if not AGENT_RUNS_ROOT.is_dir():
        return []
    candidates = sorted(
        (path for path in AGENT_RUNS_ROOT.iterdir() if path.is_dir()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    summaries: list[dict[str, Any]] = []
    for run_dir in candidates[: max(limit * 2, limit)]:
        try:
            payload = load_agent_run(run_dir.name)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        events = payload.get("events") or []
        report = payload.get("report") or {}
        attempts = max((int(event.get("attempt", 1)) for event in events), default=1)
        total_tokens = sum(
            int((event.get("usage") or {}).get("total_tokens") or 0) for event in events
        )
        metrics = report.get("metrics") or {}
        summaries.append(
            {
                "run_id": payload["run_id"],
                "agent_name": (payload.get("graph") or {}).get("name", "Agent"),
                "design_id": payload.get("design_id"),
                "design_name": payload.get("design_name"),
                "status": payload.get("status", "completed"),
                "started_at": payload.get("started_at"),
                "duration_ms": payload.get("duration_ms"),
                "event_count": len(events),
                "attempts": attempts,
                "total_tokens": total_tokens or None,
                "area": metrics.get("area"),
                "area_unit": metrics.get("area_unit"),
                "total_power_w": metrics.get("total_power_w") if metrics.get("power_status") == "ok" else None,
                "report_passed": report.get("passed"),
                "error": payload.get("error"),
            }
        )
        if len(summaries) >= limit:
            break
    return summaries


def delete_agent_run(run_id: str) -> None:
    """删除单次运行记录，路径限制在 Agent runs 目录内。"""
    run_id = _run_component(run_id, "run_id")
    root = AGENT_RUNS_ROOT.resolve()
    run_dir = (root / run_id).resolve()
    if root not in run_dir.parents or not run_dir.is_dir():
        raise FileNotFoundError("Agent 运行记录不存在")
    shutil.rmtree(run_dir)


def clear_agent_runs() -> int:
    """清空全部 Agent 运行记录。"""
    if not AGENT_RUNS_ROOT.is_dir():
        return 0
    deleted = 0
    for path in AGENT_RUNS_ROOT.iterdir():
        if path.is_dir():
            shutil.rmtree(path)
            deleted += 1
    return deleted


def _design_path(design_id: str) -> Path:
    if not isinstance(design_id, str) or not DESIGN_ID_PATTERN.fullmatch(design_id):
        raise ValueError("design_id 无效")
    return AGENT_DESIGNS_ROOT / f"{design_id}.json"


def list_agent_designs() -> list[dict[str, Any]]:
    """列出设计空间中保存的 Agent 图变体。"""
    if not AGENT_DESIGNS_ROOT.is_dir():
        return []
    designs: list[dict[str, Any]] = []
    paths = sorted(
        AGENT_DESIGNS_ROOT.glob("*.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for path in paths:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(record, dict) or not isinstance(record.get("name"), str):
            continue
        design_id = record.get("id") or path.stem
        if not isinstance(design_id, str) or not DESIGN_ID_PATTERN.fullmatch(design_id):
            continue
        graph = record.get("graph") or {}
        nodes = graph.get("nodes") if isinstance(graph, dict) else []
        edges = graph.get("edges") if isinstance(graph, dict) else []
        if not isinstance(nodes, list):
            nodes = []
        if not isinstance(edges, list):
            edges = []
        designs.append(
            {
                "id": design_id,
                "name": record["name"][:100],
                "description": str(record.get("description") or "")[:300],
                "node_count": len(nodes),
                "edge_count": len(edges),
                "retry_count": sum(
                    1 for node in nodes if isinstance(node, dict) and node.get("retry")
                ),
                "created_at": record.get("created_at"),
                "updated_at": record.get("updated_at"),
            }
        )
    return designs


def load_agent_design(design_id: str) -> dict[str, Any]:
    """读取一个保存的设计变体。"""
    path = _design_path(design_id)
    if not path.is_file():
        raise FileNotFoundError("Agent 设计不存在")
    record = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or not isinstance(record.get("name"), str):
        raise ValueError("Agent 设计记录格式无效")
    record["id"] = design_id
    record["graph"] = validate_agent_graph(normalize_agent_graph(record.get("graph")))
    return record


def save_agent_design(
    *,
    name: str,
    graph: dict[str, Any],
    description: str = "",
    design_id: str | None = None,
) -> dict[str, Any]:
    """把当前图保存为设计空间中的命名变体；提供 design_id 时更新该变体。"""
    if not isinstance(name, str) or not name.strip():
        raise ValueError("设计名称不能为空")
    clean_name = name.strip()[:100]
    clean_graph = validate_agent_graph(normalize_agent_graph(graph))
    if not isinstance(description, str):
        raise ValueError("设计说明必须是字符串")
    clean_description = description.strip()[:300]
    now = _now()
    created_at = now
    if design_id is not None:
        existing = load_agent_design(design_id)
        created_at = existing.get("created_at") or now
    else:
        base = f"design-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}"
        design_id = base
        suffix = 2
        while _design_path(design_id).exists():
            design_id = f"{base}-{suffix}"
            suffix += 1
    AGENT_DESIGNS_ROOT.mkdir(parents=True, exist_ok=True)
    record = {
        "id": design_id,
        "name": clean_name,
        "description": clean_description,
        "created_at": created_at,
        "updated_at": now,
        "graph": clean_graph,
    }
    _write_json(_design_path(design_id), record)
    return record


def delete_agent_design(design_id: str) -> None:
    """删除一个保存的设计变体。"""
    path = _design_path(design_id)
    if not path.is_file():
        raise FileNotFoundError("Agent 设计不存在")
    path.unlink()
