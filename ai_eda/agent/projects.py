"""Agent 任务项目注册表：每个项目有独立的 Spec / TB / Tester 配置。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ai_eda.config import TASKS_ROOT

DEFAULT_PROJECT_ID = "stream_filter"

_PROJECTS: dict[str, dict[str, Any]] = {
    "stream_filter": {
        "id": "stream_filter",
        "title": "当前项目：同步字节流缓冲器",
        "description": "8 字节同步 FIFO + 16-bit 校验和，验证数据前递与多文件 RTL 生成。",
        "spec_path": TASKS_ROOT / "stream_filter" / "spec.md",
        "testbench_path": TASKS_ROOT / "stream_filter" / "tb.sv",
        "testbench_top": "tb_agent_stream_filter",
        "power_testbench_path": TASKS_ROOT / "stream_filter" / "power_tb.sv",
        "power_testbench_top": "tb_power_agent_stream_filter",
        "task_name": "agent_stream_filter",
    },
    "rv32i5": {
        "id": "rv32i5",
        "title": "课后作业：RV32I 五级流水线处理器",
        "description": "RV32I 五级流水线，包含数据前递、load-use、分支 flush 与 ECALL 停机。",
        "spec_path": TASKS_ROOT / "homework_rv32i5" / "spec.md",
        "testbench_path": TASKS_ROOT / "homework_rv32i5" / "tb.sv",
        "testbench_top": "tb_agent_rv32i5",
        "power_testbench_path": TASKS_ROOT / "homework_rv32i5" / "power_tb.sv",
        "power_testbench_top": "tb_power_agent_rv32i5",
        "task_name": "agent_rv32i5",
    },
}


def get_project(project_id: str | None = None) -> dict[str, Any]:
    """返回一个项目配置；未知项目回退到默认项目。"""
    key = project_id or DEFAULT_PROJECT_ID
    project = _PROJECTS.get(key)
    if project is None:
        raise ValueError(f"未知 Agent 项目：{project_id}")
    return dict(project)


def list_projects() -> list[dict[str, str]]:
    """返回给前端展示的项目元数据，不暴露内部路径。"""
    return [
        {"id": item["id"], "title": item["title"], "description": item["description"]}
        for item in _PROJECTS.values()
    ]


def project_public(project: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": project["id"],
        "title": project["title"],
        "description": project["description"],
    }


def project_spec(project_id: str | None = None) -> str:
    project = get_project(project_id)
    return Path(project["spec_path"]).read_text(encoding="utf-8")
