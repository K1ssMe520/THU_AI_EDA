"""Agent 可调用工具库。

所有工具都通过 JSON 参数调用，并返回 JSON 可序列化结果：
- run_testbench / synthesize_area / estimate_power：封装课程已有的教师 TB、
  Yosys 面积评估与 OpenSTA 功耗评估；
- skill_<name>：调用 ``agent_optimization/skills/`` 下由用户维护的 Python
  小程序，用于复杂算术、查表等不适合直接交给大模型的计算。

工具本身只接受 RTL 文本或 skill 参数，不接受任意 shell 命令与路径。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from .metrics import synthesize_metrics
from .runner import PROJECT_ROOT, test_rtl

AGENT_ROOT = PROJECT_ROOT / "agent_optimization"
AGENT_TASK_DIR = AGENT_ROOT / "tasks" / "rise_edge"
SKILLS_ROOT = AGENT_ROOT / "skills"
SKILLS_MANIFEST = SKILLS_ROOT / "manifest.json"

MAX_RTL_BYTES = 200_000
MAX_SKILL_OUTPUT = 100_000
SKILL_TIMEOUT_SECONDS = 15

RTL_ARGS = {
    "type": "object",
    "properties": {
        "rtl": {
            "type": "string",
            "description": "完整的 SystemVerilog 模块源码（包含 module rise_edge 及 endmodule）",
        }
    },
    "required": ["rtl"],
    "additionalProperties": False,
}

BUILTIN_TOOL_DEFINITIONS: dict[str, dict[str, Any]] = {
    "run_testbench": {
        "type": "function",
        "function": {
            "name": "run_testbench",
            "description": (
                "编译并运行本 Agent 任务的固定教师 testbench（rise_edge），返回是否通过、"
                "失败阶段和具体检查结果。适合在给出最终 RTL 前验证自己的候选实现。"
            ),
            "parameters": RTL_ARGS,
        },
    },
    "synthesize_area": {
        "type": "function",
        "function": {
            "name": "synthesize_area",
            "description": (
                "用 Yosys 将候选 RTL 映射到课程 45nm 标准单元库，返回 chip area。"
                "只做面积评估，不运行功能 TB。"
            ),
            "parameters": RTL_ARGS,
        },
    },
    "estimate_power": {
        "type": "function",
        "function": {
            "name": "estimate_power",
            "description": (
                "运行固定功耗测试平台生成活动 VCD，再交给 OpenSTA 估算 internal/"
                "switching/leakage/total power，并返回面积。"
            ),
            "parameters": RTL_ARGS,
        },
    },
}


# ---------------------------------------------------------------- skills ----

def _skill_name(name: Any) -> str:
    if not isinstance(name, str) or not name:
        raise ValueError("Skill 名称不能为空")
    if not name[0].islower() or not all(
        character.islower() or character.isdigit() or character == "_"
        for character in name
    ):
        raise ValueError("Skill 名称必须以小写字母开头，只包含小写字母、数字和下划线")
    if len(name) > 32:
        raise ValueError("Skill 名称不能超过 32 个字符")
    return name


def _skill_entry(name: str) -> Path:
    return SKILLS_ROOT / f"{_skill_name(name)}.py"


def _load_manifest() -> dict[str, Any]:
    if not SKILLS_MANIFEST.is_file():
        return {"skills": []}
    try:
        payload = json.loads(SKILLS_MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"skills/manifest.json 不是合法 JSON：{error}") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("skills"), list):
        raise ValueError("skills/manifest.json 格式无效")
    return payload


def _save_manifest(payload: dict[str, Any]) -> None:
    temporary = SKILLS_MANIFEST.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(SKILLS_MANIFEST)


def list_skills() -> list[dict[str, Any]]:
    """返回已注册的 skills（含 entry 是否存在）。"""
    skills: list[dict[str, Any]] = []
    for item in _load_manifest().get("skills", []):
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        try:
            name = _skill_name(name)
        except ValueError:
            continue
        entry = str(item.get("entry") or f"{name}.py")
        record = {
            "name": name,
            "title": str(item.get("title") or name),
            "description": str(item.get("description") or ""),
            "entry": entry,
            "parameters": item.get("parameters")
            or {"type": "object", "properties": {}, "additionalProperties": False},
            "available": (SKILLS_ROOT / entry).is_file(),
        }
        skills.append(record)
    return skills


def load_skill(name: str) -> dict[str, Any]:
    skill = next((item for item in list_skills() if item["name"] == name), None)
    if skill is None:
        raise FileNotFoundError(f"Skill 不存在：{name}")
    entry = SKILLS_ROOT / skill["entry"]
    skill = dict(skill)
    skill["code"] = entry.read_text(encoding="utf-8") if entry.is_file() else ""
    return skill


def save_skill(
    name: Any,
    *,
    title: Any = None,
    description: Any = None,
    code: Any = None,
    parameters: Any = None,
) -> dict[str, Any]:
    name = _skill_name(name)
    if not isinstance(code, str) or not code.strip():
        raise ValueError("Skill 的 Python 代码不能为空")
    if len(code.encode("utf-8")) > MAX_RTL_BYTES:
        raise ValueError("Skill 代码不能超过 200 KB")
    if parameters is not None and not isinstance(parameters, dict):
        raise ValueError("parameters 必须是 JSON Schema 对象")
    SKILLS_ROOT.mkdir(parents=True, exist_ok=True)
    entry = _skill_entry(name)
    entry.write_text(code, encoding="utf-8")

    manifest = _load_manifest()
    skills = [item for item in manifest.get("skills", []) if item.get("name") != name]
    skills.append(
        {
            "name": name,
            "title": str(title or name),
            "description": str(description or ""),
            "entry": entry.name,
            "parameters": parameters
            or {"type": "object", "properties": {}, "additionalProperties": False},
        }
    )
    manifest["skills"] = skills
    _save_manifest(manifest)
    return load_skill(name)


def delete_skill(name: str) -> None:
    name = _skill_name(name)
    manifest = _load_manifest()
    remaining = [item for item in manifest.get("skills", []) if item.get("name") != name]
    if len(remaining) == len(manifest.get("skills", [])):
        raise FileNotFoundError(f"Skill 不存在：{name}")
    manifest["skills"] = remaining
    _save_manifest(manifest)
    entry = _skill_entry(name)
    if entry.is_file():
        entry.unlink()


def skill_tool_name(name: str) -> str:
    return f"skill_{name}"


def _skill_tool_definition(skill: dict[str, Any]) -> dict[str, Any]:
    parameters = skill.get("parameters")
    if not isinstance(parameters, dict):
        parameters = {"type": "object", "properties": {}, "additionalProperties": False}
    return {
        "type": "function",
        "function": {
            "name": skill_tool_name(skill["name"]),
            "description": (
                f"调用本地 Python skill「{skill.get('title') or skill['name']}」："
                f"{skill.get('description') or ''}"
            ).strip(),
            "parameters": parameters,
        },
    }


def tool_catalog() -> dict[str, Any]:
    """给网页端展示的工具 + skills 目录。"""
    return {
        "builtin": [
            {
                "name": name,
                "title": {
                    "run_testbench": "教师 TB 仿真",
                    "synthesize_area": "Yosys 面积",
                    "estimate_power": "OpenSTA 功耗",
                }[name],
                "description": definition["function"]["description"],
            }
            for name, definition in BUILTIN_TOOL_DEFINITIONS.items()
        ],
        "skills": list_skills(),
    }


def build_tool_definitions(names: list[str]) -> list[dict[str, Any]]:
    """把节点启用的工具名转换成 OpenAI-compatible function 定义。"""
    definitions: list[dict[str, Any]] = []
    for name in names:
        if name in BUILTIN_TOOL_DEFINITIONS:
            definitions.append(BUILTIN_TOOL_DEFINITIONS[name])
            continue
        if isinstance(name, str) and name.startswith("skill_"):
            skill_name = name.removeprefix("skill_")
            skill = next(
                (item for item in list_skills() if item["name"] == skill_name), None
            )
            if skill is not None and skill.get("available"):
                definitions.append(_skill_tool_definition(skill))
    return definitions


# --------------------------------------------------------------- execute ----

def _report_payload(report: dict[str, Any]) -> dict[str, Any]:
    checks = report.get("checks") or []
    return {
        "passed": report.get("passed"),
        "stage": report.get("stage"),
        "checks": checks[:8],
        "check_count": len(checks),
        "stderr": (report.get("stderr") or "")[-2000:] if not report.get("passed") else "",
    }


def _metrics_payload(metrics: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "status",
        "reason",
        "area",
        "area_unit",
        "cell_count",
        "power_status",
        "power_reason",
        "internal_power_w",
        "switching_power_w",
        "leakage_power_w",
        "total_power_w",
    )
    return {key: metrics.get(key) for key in keys if key in metrics}


def _prepare_rtl(arguments: dict[str, Any], directory: Path) -> Path:
    rtl = arguments.get("rtl")
    if not isinstance(rtl, str) or "module" not in rtl:
        raise ValueError("工具参数 rtl 必须是完整的 SystemVerilog 模块源码")
    if len(rtl.encode("utf-8")) > MAX_RTL_BYTES:
        raise ValueError("RTL 超过 200 KB 限制")
    rtl_path = directory / "generated.sv"
    rtl_path.write_text(rtl, encoding="utf-8")
    return rtl_path


def _run_skill(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    skill = next((item for item in list_skills() if skill_tool_name(item["name"]) == name), None)
    if skill is None:
        raise FileNotFoundError(f"Skill 不存在：{name}")
    entry = (SKILLS_ROOT / skill["entry"]).resolve()
    if SKILLS_ROOT.resolve() not in entry.parents:
        raise ValueError("Skill 路径不在 skills 目录内")
    if not entry.is_file():
        raise FileNotFoundError(f"Skill 文件不存在：{entry.name}")
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper()
        not in {"DEEPSEEK_API_KEY", "DSV3_KEY", "LLM_API_KEY", "OPENAI_API_KEY"}
    }
    try:
        completed = subprocess.run(
            [sys.executable, str(entry)],
            input=json.dumps(arguments, ensure_ascii=False),
            text=True,
            capture_output=True,
            cwd=str(SKILLS_ROOT),
            env=environment,
            timeout=SKILL_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"Skill 执行超时（>{SKILL_TIMEOUT_SECONDS}s）") from error
    stdout = (completed.stdout or "")[-MAX_SKILL_OUTPUT:]
    stderr = (completed.stderr or "")[-4000:]
    try:
        payload = json.loads(stdout)
        if isinstance(payload, dict):
            return payload
        return {"ok": True, "output": payload}
    except json.JSONDecodeError:
        return {
            "ok": completed.returncode == 0,
            "output": stdout,
            "stderr": stderr,
            "returncode": completed.returncode,
        }


def execute_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """执行一个工具调用；异常也会转成可回填给模型的结构。"""
    if not isinstance(arguments, dict):
        arguments = {}
    try:
        if name in {"run_testbench", "synthesize_area", "estimate_power"}:
            with tempfile.TemporaryDirectory(prefix="ai_eda_agent_tool_") as temp_dir:
                directory = Path(temp_dir)
                rtl_path = _prepare_rtl(arguments, directory)
                if name == "synthesize_area":
                    return _metrics_payload(synthesize_metrics(rtl_path))
                if name == "run_testbench":
                    report = test_rtl(
                        task_name="agent_rise_edge",
                        testbench_path=AGENT_TASK_DIR / "tb.sv",
                        testbench_top="tb_agent_rise_edge",
                        rtl_path=rtl_path,
                    )
                    return _report_payload(report)
                report = test_rtl(
                    task_name="agent_rise_edge",
                    testbench_path=AGENT_TASK_DIR / "tb.sv",
                    testbench_top="tb_agent_rise_edge",
                    rtl_path=rtl_path,
                    power_testbench_path=AGENT_TASK_DIR / "power_tb.sv",
                    power_testbench_top="tb_power_agent_rise_edge",
                    run_dir=directory,
                )
                return {
                    "passed": report.get("passed"),
                    "stage": report.get("stage"),
                    "metrics": _metrics_payload(report.get("metrics") or {}),
                }
        if isinstance(name, str) and name.startswith("skill_"):
            return _run_skill(name, arguments)
        return {"ok": False, "error": f"未知工具：{name}"}
    except Exception as error:  # noqa: BLE001 - 工具错误需要回填给模型
        return {"ok": False, "error": str(error)}
