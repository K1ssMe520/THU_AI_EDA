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
        "title": "RV32I · L0 基础五级流水线",
        "description": "基础 RV32I 五级流水线：前递、load-use、分支 flush；与进阶层共用教师 TB 和性能基准。",
        "spec_path": TASKS_ROOT / "homework_rv32i5" / "spec.md",
        "testbench_path": TASKS_ROOT / "homework_rv32i5" / "tb.sv",
        "testbench_top": "tb_agent_rv32i5",
        "power_testbench_path": TASKS_ROOT / "homework_rv32i5" / "power_tb.sv",
        "power_testbench_top": "tb_power_agent_rv32i5",
        "task_name": "agent_rv32i5",
        "expected_cpu_level": 0,
    },
}

# 四个项目只选择不同的设计要求；教师测试入口及性能口径保持一致。
for _project_id, _level, _title, _description, _spec_file in (
    (
        "rv32i5_cache", 1, "RV32I · L1 I/D Cache",
        "基础流水线 + 分离 I/D Cache：缓存命中、冲突替换、字节写与 miss 停顿。", "cache.md",
    ),
    (
        "rv32i5_predict", 2, "RV32I · L2 Cache + 分支预测",
        "I/D Cache + 动态分支预测：BTB/BHT、预测训练、误预测恢复与错误路径副作用隔离。", "predict.md",
    ),
    (
        "rv32i5_ooo", 3, "RV32I · L3 Cache + 预测 + 乱序",
        "缓存与预测 + 重命名、乱序执行、ROB 顺序提交，验证内存顺序与精确恢复。", "ooo.md",
    ),
):
    _PROJECTS[_project_id] = {
        **_PROJECTS["rv32i5"],
        "id": _project_id,
        "title": _title,
        "description": _description,
        "spec_path": TASKS_ROOT / "homework_rv32i5" / "specs" / _spec_file,
        "expected_cpu_level": _level,
    }


def get_project(project_id: str | None = None) -> dict[str, Any]:
    """返回一个项目配置；未知项目回退到默认项目。"""
    key = project_id or DEFAULT_PROJECT_ID
    project = _PROJECTS.get(key)
    if project is None:
        raise ValueError(f"未知 Agent 项目：{project_id}")
    return dict(project)


def list_projects() -> list[dict[str, Any]]:
    """返回给前端展示的项目元数据，不暴露内部路径。"""
    return [project_public(item) for item in _PROJECTS.values()]


def project_public(project: dict[str, Any]) -> dict[str, Any]:
    public = {
        "id": project["id"],
        "title": project["title"],
        "description": project["description"],
    }
    if "expected_cpu_level" in project:
        public["expected_cpu_level"] = project["expected_cpu_level"]
        public["cpu_level_label"] = {
            0: "L0 · 基础流水线",
            1: "L1 · I/D Cache",
            2: "L2 · Cache + 分支预测",
            3: "L3 · Cache + 预测 + 乱序",
        }[project["expected_cpu_level"]]
    return public


def project_spec(project_id: str | None = None) -> str:
    project = get_project(project_id)
    return Path(project["spec_path"]).read_text(encoding="utf-8")
