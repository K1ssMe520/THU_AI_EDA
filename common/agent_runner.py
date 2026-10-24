"""可视化 Agent 工作台的最小 EDA 自动设计执行器。"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .api import DEFAULT_SYSTEM_PROMPT, ModelClient
from .runner import PROJECT_ROOT, extract_rtl, save_report, test_rtl

AGENT_ROOT = PROJECT_ROOT / "agent_optimization"
AGENT_DEFINITION_PATH = AGENT_ROOT / "agents" / "simple_eda_agent.json"
AGENT_RUNS_ROOT = AGENT_ROOT / "runs"
AGENT_TASK_DIR = AGENT_ROOT / "tasks" / "rise_edge"
NODE_TYPES = {"spec", "model", "verify", "report"}
NODE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,31}$")


def load_agent_graph() -> dict[str, Any]:
    """读取默认 Agent 图。"""
    return json.loads(AGENT_DEFINITION_PATH.read_text(encoding="utf-8"))


def validate_agent_graph(graph: Any) -> dict[str, Any]:
    """验证可执行的受限线性工作流，避免网页成为任意脚本执行器。"""
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
            raise ValueError("Agent 节点类型无效")
        title, prompt = node.get("title"), node.get("prompt")
        if not isinstance(title, str) or not isinstance(prompt, str):
            raise ValueError("Agent 节点必须包含标题和 Prompt")
        if len(prompt) > 30_000:
            raise ValueError("单个节点 Prompt 过长")
        nodes[node_id] = {
            "id": node_id,
            "type": node["type"],
            "title": title.strip()[:100],
            "prompt": prompt,
            "x": max(0, min(float(node.get("x", 0)), 4000)),
            "y": max(0, min(float(node.get("y", 0)), 4000)),
        }

    entry = graph.get("entry")
    if entry not in nodes:
        raise ValueError("Agent 入口节点不存在")
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
            raise ValueError("最小 Agent 工作流中每个节点只能有一个后继")
        if target in incoming:
            raise ValueError("最小 Agent 工作流中每个节点只能有一个前驱")
        outgoing[source] = target
        incoming.add(target)
        edges.append({"from": source, "to": target})
    return {
        "name": graph["name"].strip()[:100],
        "entry": entry,
        "nodes": list(nodes.values()),
        "edges": edges,
    }


def save_agent_graph(graph: dict[str, Any]) -> dict[str, Any]:
    """原子保存用户构建的 Agent 图。"""
    clean = validate_agent_graph(graph)
    temporary_path = AGENT_DEFINITION_PATH.with_suffix(".tmp")
    temporary_path.write_text(json.dumps(clean, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_path.replace(AGENT_DEFINITION_PATH)
    return clean


def _render_prompt(template: str, context: dict[str, str]) -> str:
    rendered = template
    for key, value in context.items():
        rendered = rendered.replace("{" + key + "}", value)
    return rendered


def _report_summary(report: dict[str, Any] | None) -> str:
    if report is None:
        return "验证尚未执行。"
    return f"教师 TB {'通过' if report.get('passed') else '失败'}（阶段：{report.get('stage', 'unknown')}）。"


def run_agent(
    graph: dict[str, Any],
    *,
    thinking: bool = False,
    reasoning_effort: str = "high",
    temperature: float = 0.2,
    max_tokens: int = 4096,
) -> dict[str, Any]:
    """从入口开始按连线执行受限的 Agent 节点。"""
    graph = validate_agent_graph(graph)
    if reasoning_effort not in {"low", "high", "max"}:
        raise ValueError("reasoning_effort 无效")

    run_id = f"agent-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}"
    run_dir = AGENT_RUNS_ROOT / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    (run_dir / "graph.json").write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    nodes = {node["id"]: node for node in graph["nodes"]}
    next_nodes = {edge["from"]: edge["to"] for edge in graph["edges"]}
    context: dict[str, str] = {"spec": "", "previous": "", "rtl": "", "tb_result": ""}
    events: list[dict[str, Any]] = []
    report: dict[str, Any] | None = None
    current = graph["entry"]
    visited: set[str] = set()

    while current:
        if current in visited:
            raise ValueError("Agent 图存在循环；最小执行器只支持无环流程")
        visited.add(current)
        if len(visited) > 16:
            raise ValueError("Agent 图执行步数超过限制")
        node = nodes[current]
        rendered_prompt = _render_prompt(node["prompt"], context)
        event: dict[str, Any] = {
            "node_id": node["id"],
            "node_type": node["type"],
            "title": node["title"],
            "prompt": rendered_prompt,
        }

        if node["type"] == "spec":
            context["spec"] = rendered_prompt
            event["response"] = "规格已注入 Agent 上下文。"
        elif node["type"] == "model":
            client = ModelClient(
                temperature=temperature,
                max_tokens=max_tokens,
                thinking=thinking,
                reasoning_effort=reasoning_effort,
            )
            model_result = client.generate_once_detail(rendered_prompt, DEFAULT_SYSTEM_PROMPT)
            answer = model_result["answer"] or ""
            reasoning = model_result["reasoning"]
            rtl = extract_rtl(answer)
            (run_dir / "generated.sv").write_text(rtl, encoding="utf-8")
            (run_dir / "raw_response.txt").write_text(answer, encoding="utf-8")
            if reasoning:
                (run_dir / "reasoning.txt").write_text(reasoning, encoding="utf-8")
            context["rtl"] = rtl
            context["previous"] = answer
            event.update({"response": answer, "reasoning": reasoning, "rtl": rtl})
        elif node["type"] == "verify":
            if not context["rtl"]:
                raise ValueError("验证节点前必须有模型生成 RTL")
            report = test_rtl(
                task_name="agent_rise_edge",
                testbench_path=AGENT_TASK_DIR / "tb.sv",
                testbench_top="tb_agent_rise_edge",
                rtl_path=run_dir / "generated.sv",
                power_testbench_path=AGENT_TASK_DIR / "power_tb.sv",
                power_testbench_top="tb_power_agent_rise_edge",
                run_dir=run_dir,
            )
            save_report(run_dir, report)
            context["tb_result"] = _report_summary(report)
            context["previous"] = context["tb_result"]
            event.update({"response": context["tb_result"], "report": report})
        else:  # report
            response = rendered_prompt + "\n\n" + _report_summary(report)
            context["previous"] = response
            event["response"] = response

        events.append(event)
        current = next_nodes.get(current, "")

    payload = {"run_id": run_id, "run_dir": str(run_dir), "events": events, "report": report}
    (run_dir / "events.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload
