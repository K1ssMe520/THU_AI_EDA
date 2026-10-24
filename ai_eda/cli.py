"""Prompt RTL 实验的参数化命令行入口。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from ai_eda.config import PROJECT_ROOT, PROMPTS_ROOT, TASKS_ROOT
from ai_eda.rtl.runner import retest_run, run_prompt_experiment, summarize_task


# 教师发布任务时在此登记公开材料；不使用 task.json。
TASKS = {
    "classroom_seq1011": {
        "directory": "classroom_seq1011",
        "testbench_top": "tb_classroom_seq1011",
        "power_testbench_top": "tb_power_classroom_seq1011",
    },
    "homework_aes128": {
        "directory": "homework_aes128",
        "testbench_top": "tb_homework_aes128",
        "power_testbench_top": "tb_power_homework_aes128",
    },
}


def _path_from_project(value: str) -> Path:
    """将相对路径解释为项目顶层下的路径。"""
    path = Path(value)
    return path if path.is_absolute() else PROJECT_ROOT / path


def _task_paths(task_name: str) -> tuple[Path, Path, str]:
    task = TASKS[task_name]
    task_dir = TASKS_ROOT / task["directory"]
    return task_dir / "spec.md", task_dir / "tb.sv", task["testbench_top"]


def _power_paths(task_name: str) -> tuple[Path | None, str | None]:
    task = TASKS[task_name]
    power_testbench_top = task.get("power_testbench_top")
    if not power_testbench_top:
        return None, None
    task_dir = TASKS_ROOT / task["directory"]
    return task_dir / "power_tb.sv", power_testbench_top


def _print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def _add_task_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--task", required=True, choices=sorted(TASKS), help="要运行或汇总的课程任务")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI EDA 单次 Prompt RTL 生成实验")
    subcommands = parser.add_subparsers(dest="command", required=True)

    run_parser = subcommands.add_parser("run", help="生成一次 RTL 并执行教师测试")
    _add_task_argument(run_parser)
    run_parser.add_argument("--prompt", required=True, help="相对路径以 content/prompts/ 为根目录")
    run_parser.add_argument("--run-id", required=True, help="本次实验的唯一编号")
    run_parser.add_argument("--temperature", type=float, default=0.2)
    run_parser.add_argument("--max-tokens", type=int, default=4096)
    run_parser.add_argument("--thinking", action="store_true", help="启用模型思考模式")
    run_parser.add_argument("--reasoning-effort", choices=("low", "high", "max"), default="high")
    run_parser.add_argument("--timeout-seconds", type=int, default=20)

    retest_parser = subcommands.add_parser("retest", help="重跑已有实验记录的教师测试")
    retest_parser.add_argument("--run-dir", required=True, help="运行记录目录，可使用相对项目根目录的路径")

    summary_parser = subcommands.add_parser("summarize", help="汇总一个任务的全部实验记录")
    _add_task_argument(summary_parser)

    serve_parser = subcommands.add_parser("serve", help="启动本地可视化工作台")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8000)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "run":
        spec_path, testbench_path, testbench_top = _task_paths(args.task)
        power_testbench_path, power_testbench_top = _power_paths(args.task)
        prompt_path = Path(args.prompt)
        if not prompt_path.is_absolute():
            prompt_path = PROMPTS_ROOT / prompt_path
        run_dir, report = run_prompt_experiment(
            task_name=args.task,
            spec_path=spec_path,
            testbench_path=testbench_path,
            testbench_top=testbench_top,
            power_testbench_path=power_testbench_path,
            power_testbench_top=power_testbench_top,
            prompt_path=prompt_path,
            run_id=args.run_id,
            temperature=args.temperature,
            max_tokens=args.max_tokens,
            thinking=args.thinking,
            reasoning_effort=args.reasoning_effort,
            timeout_seconds=args.timeout_seconds,
        )
        _print_json({"run_dir": run_dir, "report": report})
        return 0 if report["passed"] else 1

    if args.command == "retest":
        _print_json(retest_run(_path_from_project(args.run_dir)))
        return 0

    if args.command == "summarize":
        _print_json(summarize_task(args.task))
        return 0

    if args.command == "serve":
        from ai_eda.web.server import serve

        serve(args.host, args.port)
        return 0

    raise AssertionError(f"未知命令：{args.command}")
