"""Agent 流程定义、运行记录、handoff 与设计变体的读写。"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ai_eda.agent.projects import DEFAULT_PROJECT_ID, get_project, list_projects, project_public
from ai_eda.config import (
    AGENT_CONTENT_ROOT,
    AGENT_FLOW_PATH,
    AGENT_RUNS_ROOT,
)
from ai_eda.model.client import ModelClient
from ai_eda.rtl.runner import _run_component

HANDOFF_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

AGENT_DEFINITION_PATH = AGENT_FLOW_PATH
AGENT_DESIGNS_ROOT = AGENT_CONTENT_ROOT / "designs"
NODE_TYPES = {"model", "verify"}
NODE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
DESIGN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
MAX_RETRIES = 5
HANDOFF_ARTIFACT_PREVIEW_CHARS = 80_000

HANDOFF_ARTIFACT_TITLES = {
    "spec": "冻结 Spec",
    "parser_result": "Spec 解析结果",
    "plan": "RTL 实现计划",
    "rtl_manifest": "RTL 文件清单",
    "report": "验收报告",
    "combined_rtl": "组合 RTL",
}

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



def agent_task_spec(project_id: str | None = None) -> str:
    """选定项目的公开 Spec。"""
    return Path(get_project(project_id)["spec_path"]).read_text(encoding="utf-8")



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



def agent_state_payload(project_id: str | None = None) -> dict[str, Any]:
    """Agent 页面初始状态：项目列表、当前项目与 Spec。"""
    project = get_project(project_id)
    return {
        "project": project_public(project),
        "projects": list_projects(),
        "spec": agent_task_spec(project["id"]),
    }



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
    project_id: str | None = None,
) -> dict[str, Any]:
    project = get_project(project_id)
    payload: dict[str, Any] = {
        "run_id": run_id,
        "run_dir": str(run_dir),
        "project_id": project["id"],
        "project": project_public(project),
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
    project_id: str | None = None,
) -> None:
    project = get_project(project_id)
    metadata = {
        "run_id": run_id,
        "project_id": project["id"],
        "project_title": project["title"],
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


def _handoff_artifact_preview(
    run_dir: Path,
    reference: Any,
    *,
    key: str,
    title: str | None = None,
) -> dict[str, Any] | None:
    """安全读取 handoff artifact，供界面展示；执行流程仍只传递引用。"""
    if not isinstance(reference, str) or not reference.strip():
        return None
    root = run_dir.resolve()
    path = (root / reference).resolve()
    if root not in path.parents or not path.is_file():
        return None
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    truncated = len(content) > HANDOFF_ARTIFACT_PREVIEW_CHARS
    if truncated:
        content = content[:HANDOFF_ARTIFACT_PREVIEW_CHARS]
    return {
        "key": key,
        "title": title or HANDOFF_ARTIFACT_TITLES.get(key, key.replace("_", " ")),
        "content": content,
        "truncated": truncated,
    }


def _handoff_artifact_previews(run_dir: Path, payload: Any) -> list[dict[str, Any]]:
    """将交接中引用的文本 artifact 展开为只读预览，供人工审阅。"""
    if not isinstance(payload, dict):
        return []
    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, dict):
        return []
    previews: list[dict[str, Any]] = []
    seen: set[str] = set()
    manifest_payload: Any = None
    for key, reference in artifacts.items():
        preview = _handoff_artifact_preview(run_dir, reference, key=str(key))
        if preview is None:
            continue
        previews.append(preview)
        seen.add(str(reference))
        if key == "rtl_manifest" and not preview["truncated"]:
            try:
                manifest_payload = json.loads(preview["content"])
            except json.JSONDecodeError:
                pass

    # RTL manifest 本身只列出地址；为审阅者继续展开其中实际交接的 RTL 文本。
    entries = manifest_payload.get("files") if isinstance(manifest_payload, dict) else None
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            reference = entry.get("artifact")
            if not isinstance(reference, str) or reference in seen:
                continue
            preview = _handoff_artifact_preview(
                run_dir,
                reference,
                key="rtl_file",
                title=f"RTL · {entry.get('path') or '未命名文件'}",
            )
            if preview is not None:
                previews.append(preview)
                seen.add(reference)
    return previews



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
                "artifact_previews": _handoff_artifact_previews(run_dir, record.get("payload")),
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
    payload.setdefault("project_id", DEFAULT_PROJECT_ID)
    try:
        project = get_project(payload["project_id"])
    except ValueError:
        payload["project_id"] = DEFAULT_PROJECT_ID
        project = get_project(DEFAULT_PROJECT_ID)
    payload.setdefault("project", project_public(project))
    payload.setdefault("spec", agent_task_spec(project["id"]))
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



def list_agent_runs(project_id: str | None = None, limit: int = 40) -> list[dict[str, Any]]:
    """按时间倒序列出 Agent 运行摘要，可按项目过滤。"""
    if limit <= 0:
        return []
    selected_project = get_project(project_id)["id"] if project_id else None
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
        if selected_project and payload.get("project_id", DEFAULT_PROJECT_ID) != selected_project:
            continue
        events = payload.get("events") or []
        report = payload.get("report") or {}
        attempts = max((int(event.get("attempt", 1)) for event in events), default=1)
        total_tokens = sum(
            int((event.get("usage") or {}).get("total_tokens") or 0) for event in events
        )
        metrics = report.get("metrics") or {}
        capability = report.get("cpu_capability") or {}
        benchmarks = ((report.get("performance") or {}).get("benchmarks") or [])
        measured = [
            item for item in benchmarks
            if isinstance(item, dict)
            and isinstance(item.get("cycles"), (int, float))
            and isinstance(item.get("instructions"), (int, float))
            and item["cycles"] > 0 and item["instructions"] > 0
        ]
        total_cycles = sum(float(item["cycles"]) for item in measured)
        total_instructions = sum(float(item["instructions"]) for item in measured)
        summaries.append(
            {
                "run_id": payload["run_id"],
                "project_id": payload.get("project_id", DEFAULT_PROJECT_ID),
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
                "cpu_level": capability.get("verified_level", capability.get("observed_level", capability.get("level"))),
                "cpu_cpi": round(total_cycles / total_instructions, 6) if total_instructions else None,
                "cpu_ipc": round(total_instructions / total_cycles, 6) if total_cycles else None,
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



def clear_agent_runs(project_id: str | None = None) -> int:
    """清空指定项目（或全部）的 Agent 运行记录。"""
    if not AGENT_RUNS_ROOT.is_dir():
        return 0
    selected_project = get_project(project_id)["id"] if project_id else None
    deleted = 0
    for path in AGENT_RUNS_ROOT.iterdir():
        if not path.is_dir():
            continue
        if selected_project:
            try:
                payload = load_agent_run(path.name)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            if payload.get("project_id", DEFAULT_PROJECT_ID) != selected_project:
                continue
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
