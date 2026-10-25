"""Parser / Planner / Coder / Tester / Modifier 共用的协议与工具函数。"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

PARSER_SYSTEM_PROMPT = """You are the Spec Parser of a digital IC design agent.
Decide whether the given design spec (plus any user supplements and previous parser addendum) is sufficient to implement and verify the design.
If anything is missing or ambiguous (ports, protocol timing, reset, latency, file/module structure, test expectations), list it.

Your job is to SUPPLEMENT and CORRECT the original spec, never to summarize or replace it.
Keep every original requirement intact; any new or corrected requirement belongs in spec_addendum.
Return ONLY a JSON object with this schema:
{"sufficient": true|false, "missing": ["..."], "questions": ["..."], "spec_addendum": "only the additional/corrected requirements in Markdown; empty string if none"}
Do not put the full original spec in spec_addendum. Do not return Markdown fences or extra text."""

PLANNER_SYSTEM_PROMPT = """You are the RTL Planner of a digital IC design agent.
Given the frozen spec, plan the project module and file structure. The agent will write each file separately.
Return ONLY a JSON object:
{"project_name": "...", "top_module": "...", "modules": [{"name": "module_name", "file": "rtl/module_name.sv", "description": "...", "interfaces": "..."}], "notes": "..."}
Use only relative paths ending in .sv. Every module must be implementable in one file. Do not return Markdown fences or extra text."""

MODIFIER_SYSTEM_PROMPT = """You are the RTL Modifier of a digital IC design agent.
You are given the frozen spec, the project plan, the current RTL files, and the failing teacher TB report.
Fix the RTL. Return ONLY a JSON object:
{"files": [{"path": "rtl/foo.sv", "content": "full SystemVerilog file content"}], "notes": "..."}
You may return only the files that need changes; include a complete file content for each returned path.
Do not return Markdown fences or extra text."""

MAX_PARSER_ROUNDS = 3
MAX_TEST_ATTEMPTS = 3
SV_PATH_PATTERN = re.compile(r"^[A-Za-z0-9_./-]+\.sv$")
MODULE_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def extract_json_payload(text: str) -> dict[str, Any]:
    """从模型回答中提取第一个 JSON 对象（兼容 ```json 围栏）。"""
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        payload = json.loads(raw)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        try:
            payload = json.loads(raw[start : end + 1])
            if isinstance(payload, dict):
                return payload
        except json.JSONDecodeError:
            pass
    raise ValueError("模型没有返回合法的 JSON 对象")


def safe_project_path(run_dir: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError("RTL 文件路径不能为空")
    relative = relative.strip().replace("\\", "/")
    if not SV_PATH_PATTERN.fullmatch(relative):
        raise ValueError(f"RTL 文件路径必须是相对 .sv 路径：{relative}")
    project_root = (run_dir / "project").resolve()
    candidate = (project_root / relative).resolve()
    if project_root not in candidate.parents:
        raise ValueError(f"RTL 文件路径越出项目目录：{relative}")
    return candidate


def validate_plan(payload: dict[str, Any]) -> dict[str, Any]:
    modules = payload.get("modules")
    if not isinstance(modules, list) or not modules:
        raise ValueError("Planner 没有返回 modules 列表")
    clean_modules: list[dict[str, str]] = []
    seen_names: set[str] = set()
    seen_files: set[str] = set()
    for item in modules:
        if not isinstance(item, dict):
            raise ValueError("Planner 的 module 条目格式无效")
        name = item.get("name")
        file = item.get("file")
        if not isinstance(name, str) or not MODULE_NAME_PATTERN.fullmatch(name):
            raise ValueError("Planner 返回了非法模块名")
        if name in seen_names:
            raise ValueError(f"Planner 重复声明模块：{name}")
        if not isinstance(file, str):
            raise ValueError("Planner 的模块缺少 file")
        file = file.strip().replace("\\", "/")
        if not SV_PATH_PATTERN.fullmatch(file):
            raise ValueError(f"Planner 返回了非法文件路径：{file}")
        if file in seen_files:
            raise ValueError(f"Planner 重复声明文件：{file}")
        seen_names.add(name)
        seen_files.add(file)
        clean_modules.append(
            {
                "name": name,
                "file": file,
                "description": str(item.get("description") or "")[:500],
                "interfaces": str(item.get("interfaces") or "")[:1000],
            }
        )
    top_module = payload.get("top_module") or clean_modules[0]["name"]
    if not isinstance(top_module, str) or top_module not in seen_names:
        raise ValueError("Planner 的 top_module 不在 modules 中")
    return {
        "project_name": str(payload.get("project_name") or "agent_project")[:100],
        "top_module": top_module,
        "modules": clean_modules,
        "notes": str(payload.get("notes") or "")[:2000],
    }


def validate_modifier_files(payload: dict[str, Any], plan: dict[str, Any]) -> dict[str, str]:
    files = payload.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("Modifier 没有返回 files 列表")
    allowed = {module["file"] for module in plan["modules"]}
    clean: dict[str, str] = {}
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("Modifier 的 file 条目格式无效")
        path = item.get("path")
        content = item.get("content")
        normalized = path.strip().replace("\\", "/") if isinstance(path, str) else ""
        if normalized not in allowed:
            raise ValueError(f"Modifier 返回了计划之外的文件：{path}")
        if not isinstance(content, str) or "module" not in content:
            raise ValueError(f"Modifier 为 {path} 返回的内容不是 RTL")
        clean[normalized] = content
    return clean


def combine_files(files: dict[str, str]) -> str:
    return "\n\n".join(f"// file: {path}\n{content}" for path, content in files.items()) + "\n"


def stage_label(stage: str | None) -> str:
    return {"compile": "编译", "simulation": "仿真"}.get(stage or "", stage or "未知阶段")


def report_summary(report: dict[str, Any] | None) -> str:
    if report is None:
        return "验证尚未执行。"
    if report.get("passed"):
        return f"教师 TB 通过（{stage_label(report.get('stage'))}）。"
    checks = report.get("checks") or []
    failed = "、".join(item.get("name", "检查") for item in checks[:4])
    suffix = f"，失败检查：{failed}" if failed else ""
    return f"教师 TB 失败（{stage_label(report.get('stage'))}）{suffix}。"


def trace_mismatches(report: dict[str, Any]) -> list[str]:
    messages: list[str] = []
    for row in report.get("trace") or []:
        differences = []
        for key, value in row.items():
            if not key.startswith("expected_"):
                continue
            actual_key = key.removeprefix("expected_")
            actual = row.get(actual_key)
            if actual is None:
                actual = row.get(f"out_{actual_key}")
            if actual is not None and str(actual) != str(value):
                differences.append(f"{actual_key}={actual}（期望 {value}）")
        if differences:
            label = row.get("event") or row.get("case") or "sample"
            messages.append(f"cycle {row.get('cycle', '?')} · {label}: " + "，".join(differences))
    return messages[:6]


def report_feedback(report: dict[str, Any] | None) -> str:
    if report is None:
        return "上一轮尚未执行验证。"
    if report.get("passed"):
        return "上一轮教师 TB 已通过；请保持当前功能并完成后续步骤。"
    lines = [report_summary(report)]
    mismatches = trace_mismatches(report)
    if mismatches:
        lines.append("失败周期：")
        lines.extend(f"- {item}" for item in mismatches)
    checks = report.get("checks") or []
    if checks:
        lines.append("失败检查：")
        lines.extend(f"- {item.get('name')}: {item.get('detail', '')}".rstrip(": ") for item in checks[:8])
    if report.get("stage") == "compile":
        detail = (report.get("stderr") or report.get("stdout") or "").strip()
        if detail:
            lines.append("编译输出（末尾）：")
            lines.append(detail[-3000:])
    return "\n".join(lines)


def project_feedback(files: dict[str, str], plan: dict[str, Any], report: dict[str, Any]) -> str:
    lines = [report_summary(report), "当前项目文件："]
    lines.extend(f"- {path} ({len(content)} chars)" for path, content in files.items())
    lines.append("计划模块：")
    lines.extend(f"- {module['name']} -> {module['file']}" for module in plan["modules"])
    lines.append("")
    lines.append(report_feedback(report))
    return "\n".join(lines)
