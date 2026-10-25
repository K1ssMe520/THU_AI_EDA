"""RTL 生成与验证的函数式实验接口。"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ai_eda.config import PROJECT_ROOT, PROMPT_RUNS_ROOT, TASKS_ROOT
from ai_eda.model.client import DEFAULT_SYSTEM_PROMPT, ModelClient
from ai_eda.rtl.metrics import synthesize_metrics

RUNS_ROOT = PROMPT_RUNS_ROOT


def _cpu_feature_compile_flags(rtl_path: Path) -> list[str]:
    """仅在 rv32i5 顶层真的声明特征输出时启用扩展 TB 接口。"""
    source = rtl_path.read_text(encoding="utf-8")
    source = re.sub(r'/\*.*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"', " ", source, flags=re.DOTALL)
    module = re.search(r"\bmodule\s+rv32i5\b(.*?)\bendmodule\b", source, flags=re.DOTALL)
    if module and re.search(
        r"\boutput\b(?:(?!\b(?:input|output|inout)\b)[^;)])*\bdbg_features\b",
        module.group(1),
        flags=re.DOTALL,
    ):
        return ["-DRV32I_FEATURE_PORTS"]
    return []


def parse_testbench_output(output: str) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """解析教师 TB 输出的机器可读 trace 与失败检查。"""
    trace: list[dict[str, Any]] = []
    checks: list[dict[str, str]] = []
    for line in output.splitlines():
        if line.startswith("AI_EDA_TRACE|"):
            event: dict[str, Any] = {}
            for field in line.split("|")[1:]:
                key, separator, value = field.partition("=")
                if not separator:
                    continue
                event[key] = int(value) if key == "cycle" and value.isdigit() else value
            trace.append(event)
        elif line.startswith("CHECK: "):
            name, separator, detail = line[7:].partition(" — ")
            checks.append({"name": name, "detail": detail if separator else ""})
    return trace, checks


def _testbench_fields(line: str) -> dict[str, Any]:
    """读取 TB 的 key=value 协议，同时保留名称与状态字符串。"""
    fields: dict[str, Any] = {}
    for field in line.split("|")[1:]:
        key, separator, value = field.partition("=")
        if not separator or not key:
            continue
        value = value.strip()
        if re.fullmatch(r"-?\d+", value):
            fields[key] = int(value)
        elif re.fullmatch(r"-?\d+\.\d+(?:[eE][+-]?\d+)?", value):
            fields[key] = float(value)
        else:
            fields[key] = value
    return fields


def parse_cpu_testbench_output(output: str) -> dict[str, Any]:
    """汇总公共 CPU TB 的层级、测试组和性能，旧 TB 无输出时返回空对象。"""
    capability: dict[str, Any] = {}
    suites: list[dict[str, Any]] = []
    benchmarks: list[dict[str, Any]] = []
    for line in output.splitlines():
        if line.startswith("AI_EDA_CAPABILITY|"):
            capability.update(_testbench_fields(line))
        elif line.startswith("AI_EDA_SUITE|"):
            suite = _testbench_fields(line)
            for key in ("passed", "skipped"):
                if key in suite:
                    suite[key] = suite[key] in (1, True, "true", "PASS", "pass")
            suites.append(suite)
        elif line.startswith("AI_EDA_PERF|"):
            benchmark = _testbench_fields(line)
            cycles = benchmark.get("cycles")
            instructions = benchmark.get("instructions")
            if isinstance(cycles, (int, float)) and cycles > 0 and isinstance(instructions, (int, float)) and instructions > 0:
                benchmark["cpi"] = round(cycles / instructions, 6)
                benchmark["ipc"] = round(instructions / cycles, 6)
            benchmarks.append(benchmark)
    result: dict[str, Any] = {}
    if capability:
        for name in ("declared", "verified", "expected"):
            if name in capability:
                capability.setdefault(f"{name}_level", capability[name])
        result["cpu_capability"] = capability
    if suites:
        result["test_suites"] = suites
    if benchmarks:
        result["performance"] = {"benchmarks": benchmarks}
    return result


def sha256_text(text: str) -> str:
    """返回文本的 SHA-256，便于记录实验输入与输出。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def extract_rtl(model_output: str) -> str:
    """从模型输出中确定性地取出 Verilog/SystemVerilog 代码。"""
    match = re.search(r"```(?:systemverilog|verilog|sv)?\s*\n(.*?)```", model_output, re.DOTALL | re.IGNORECASE)
    return (match.group(1) if match else model_output).strip() + "\n"


def _require_file(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"{label}不存在：{resolved}")
    return resolved


def _run_component(value: str, label: str) -> str:
    """校验运行目录名称，避免覆盖操作越出 runs 目录。"""
    if not value.strip() or value in {".", ".."} or Path(value).name != value:
        raise ValueError(f"{label}必须是单个目录名称")
    return value


def _write_run_artifacts(
    *,
    task_name: str,
    spec_path: Path,
    testbench_path: Path,
    testbench_top: str,
    prompt_source: Path,
    run_id: str,
    prompt: str,
    raw_response: str,
    reasoning: str | None,
    temperature: float,
    max_tokens: int,
    thinking: bool,
    reasoning_effort: str,
    timeout_seconds: int,
    generation_mode: str,
    extra_metadata: dict[str, Any] | None = None,
) -> Path:
    """把一次模型结果写成可复现运行目录，不做教师 TB 验收。"""
    task_name = _run_component(task_name, "task_name")
    run_id = _run_component(run_id, "run_id")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds 必须为正数")
    spec_path = _require_file(spec_path, "规格文件")
    testbench_path = _require_file(testbench_path, "测试平台文件")

    run_dir = RUNS_ROOT / task_name / run_id
    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True)

    rtl = extract_rtl(raw_response)
    (run_dir / "prompt.md").write_text(prompt, encoding="utf-8")
    (run_dir / "raw_response.txt").write_text(raw_response, encoding="utf-8")
    if reasoning:
        (run_dir / "reasoning.txt").write_text(reasoning, encoding="utf-8")
    (run_dir / "generated.sv").write_text(rtl, encoding="utf-8")
    metadata = {
        "task_name": task_name,
        "spec_path": str(spec_path),
        "testbench_path": str(testbench_path),
        "testbench_top": testbench_top,
        "timeout_seconds": timeout_seconds,
        "task_spec_sha256": sha256_text(spec_path.read_text(encoding="utf-8")),
        "prompt_source": str(prompt_source),
        "prompt_sha256": sha256_text(prompt),
        "raw_response_sha256": sha256_text(raw_response),
        "reasoning_available": bool(reasoning),
        "rtl_sha256": sha256_text(rtl),
        "model": ModelClient.MODEL_NAME,
        "base_url": ModelClient.BASE_URL,
        "thinking": thinking,
        "reasoning_effort": reasoning_effort if thinking else None,
        "temperature": None if thinking else temperature,
        "max_tokens": max_tokens,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "generation_mode": generation_mode,
    }
    if extra_metadata:
        metadata.update(extra_metadata)
    (run_dir / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return run_dir


def create_run(
    *,
    task_name: str,
    spec_path: Path,
    testbench_path: Path,
    testbench_top: str,
    prompt_path: Path,
    run_id: str,
    temperature: float = 0.2,
    max_tokens: int = 4096,
    thinking: bool = False,
    reasoning_effort: str = "high",
    timeout_seconds: int = 20,
    system_prompt: str | None = None,
) -> Path:
    """单次调用模型，保存 Prompt、原始回答、RTL 与可复现实验信息。

    所有任务信息均由函数参数显式传入；本工程不读取 task.json。
    """
    prompt_path = _require_file(prompt_path, "Prompt 文件")
    prompt = prompt_path.read_text(encoding="utf-8")
    client = ModelClient(
        temperature=temperature,
        max_tokens=max_tokens,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
    )
    model_response = client.generate_once_detail(prompt, system_prompt or DEFAULT_SYSTEM_PROMPT)
    return _write_run_artifacts(
        task_name=task_name,
        spec_path=spec_path,
        testbench_path=testbench_path,
        testbench_top=testbench_top,
        prompt_source=prompt_path,
        run_id=run_id,
        prompt=prompt,
        raw_response=model_response["answer"] or "",
        reasoning=model_response["reasoning"],
        temperature=temperature,
        max_tokens=max_tokens,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
        timeout_seconds=timeout_seconds,
        generation_mode="single_call_no_feedback",
        extra_metadata={"finish_reason": model_response.get("finish_reason")},
    )


def save_generation_run(
    *,
    task_name: str,
    spec_path: Path,
    testbench_path: Path,
    testbench_top: str,
    prompt_path: Path,
    run_id: str,
    raw_response: str,
    reasoning: str | None = None,
    temperature: float = 0.2,
    max_tokens: int = 4096,
    thinking: bool = False,
    reasoning_effort: str = "high",
    timeout_seconds: int = 20,
    finish_reason: str | None = None,
    usage: dict[str, Any] | None = None,
) -> Path:
    """保存一次已经完成的流式模型生成；不自动运行教师 TB。

    学生/教师确认生成结果后，再调用 :func:`retest_run` 或
    :func:`run_prompt_experiment` 的测试部分进行验收。
    """
    prompt_path = _require_file(prompt_path, "Prompt 文件")
    prompt = prompt_path.read_text(encoding="utf-8")
    return _write_run_artifacts(
        task_name=task_name,
        spec_path=spec_path,
        testbench_path=testbench_path,
        testbench_top=testbench_top,
        prompt_source=prompt_path,
        run_id=run_id,
        prompt=prompt,
        raw_response=raw_response,
        reasoning=reasoning,
        temperature=temperature,
        max_tokens=max_tokens,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
        timeout_seconds=timeout_seconds,
        generation_mode="single_call_streamed",
        extra_metadata={
            "finish_reason": finish_reason,
            "usage": usage,
            "tested": False,
        },
    )


def test_rtl(
    *,
    task_name: str,
    testbench_path: Path,
    testbench_top: str,
    rtl_path: Path,
    power_testbench_path: Path | None = None,
    power_testbench_top: str | None = None,
    timeout_seconds: int = 20,
    run_dir: Path | None = None,
    expected_cpu_level: int | None = None,
    rtl_top_module: str | None = None,
) -> dict[str, Any]:
    """用 Icarus Verilog 编译并运行一个 RTL 文件，返回结构化测试报告。"""
    testbench_path = _require_file(testbench_path, "测试平台文件")
    rtl_path = _require_file(rtl_path, "RTL 文件")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds 必须为正数")
    if expected_cpu_level is not None and (type(expected_cpu_level) is not int or expected_cpu_level not in range(4)):
        raise ValueError("expected_cpu_level 必须为 0、1、2 或 3")

    if run_dir is not None:
        metadata_path = run_dir / "metadata.json"
        if metadata_path.is_file():
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            expected_hash = metadata.get("rtl_sha256")
            actual_hash = sha256_text(rtl_path.read_text(encoding="utf-8"))
            if expected_hash and expected_hash != actual_hash:
                raise ValueError("generated.sv 已被修改；请使用独立 RTL 路径测试或重新生成实验记录")

    with tempfile.TemporaryDirectory(prefix="ai_eda_") as temp_dir:
        temp_path = Path(temp_dir)
        executable = temp_path / "simulation.vvp"
        vcd_path = run_dir / "activity.vcd" if run_dir is not None else None
        feature_flags = _cpu_feature_compile_flags(rtl_path)
        compile_result = subprocess.run(
            [
                "iverilog", "-g2012", *feature_flags, "-I", str(testbench_path.parent), "-s", testbench_top, "-o", str(executable),
                str(testbench_path), str(rtl_path),
            ],
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
        if compile_result.returncode != 0:
            trace, checks = parse_testbench_output(compile_result.stdout)
            return {
                "task_name": task_name,
                "rtl_path": str(rtl_path),
                "passed": False,
                "stage": "compile",
                "return_code": compile_result.returncode,
                "stdout": compile_result.stdout,
                "stderr": compile_result.stderr,
                "trace": trace,
                "checks": checks,
            }

        simulation_command = ["vvp", str(executable)]
        if expected_cpu_level is not None:
            simulation_command.append(f"+expected_cpu_level={expected_cpu_level}")
        simulation_result = subprocess.run(
            simulation_command,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
        trace, checks = parse_testbench_output(simulation_result.stdout)
        report = {
            "task_name": task_name,
            "rtl_path": str(rtl_path),
            "passed": simulation_result.returncode == 0,
            "stage": "simulation",
            "return_code": simulation_result.returncode,
            "stdout": simulation_result.stdout,
            "stderr": simulation_result.stderr,
            "trace": trace,
            "checks": checks,
        }
        report.update(parse_cpu_testbench_output(simulation_result.stdout))
        if expected_cpu_level is not None:
            report.setdefault("cpu_capability", {})["expected_level"] = expected_cpu_level
        if any(not suite["passed"] for suite in report.get("test_suites", []) if "passed" in suite and not suite.get("skipped")):
            report["passed"] = False
        if run_dir is not None:
            if power_testbench_path is not None and power_testbench_top is not None:
                power_testbench_path = _require_file(power_testbench_path, "功耗测试平台文件")
                power_executable = temp_path / "power_simulation.vvp"
                power_compile = subprocess.run(
                    ["iverilog", "-g2012", *feature_flags, "-I", str(power_testbench_path.parent), "-s", power_testbench_top, "-o", str(power_executable), str(power_testbench_path), str(rtl_path)],
                    text=True, capture_output=True, timeout=timeout_seconds, check=False,
                )
                if power_compile.returncode == 0:
                    subprocess.run(
                        ["vvp", str(power_executable), f"+vcd={vcd_path.resolve()}"],
                        text=True, capture_output=True, timeout=timeout_seconds, check=False,
                    )
            report["metrics"] = synthesize_metrics(
                rtl_path,
                vcd_path=vcd_path,
                vcd_scope=f"{power_testbench_top}/dut" if power_testbench_top else None,
                top_module=rtl_top_module,
            )
        return report


def save_report(run_dir: Path, report: dict[str, Any]) -> Path:
    """将测试报告保存到实验记录目录。"""
    path = run_dir / "test_report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def run_prompt_experiment(
    *,
    task_name: str,
    spec_path: Path,
    testbench_path: Path,
    testbench_top: str,
    power_testbench_path: Path | None = None,
    power_testbench_top: str | None = None,
    prompt_path: Path,
    run_id: str,
    temperature: float = 0.2,
    max_tokens: int = 4096,
    thinking: bool = False,
    reasoning_effort: str = "high",
    timeout_seconds: int = 20,
    system_prompt: str | None = None,
) -> tuple[Path, dict[str, Any]]:
    """完成一次“单次生成 → 自动验收 → 保存报告”的 Prompt 实验。"""
    run_dir = create_run(
        task_name=task_name,
        spec_path=spec_path,
        testbench_path=testbench_path,
        testbench_top=testbench_top,
        prompt_path=prompt_path,
        run_id=run_id,
        temperature=temperature,
        max_tokens=max_tokens,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
        timeout_seconds=timeout_seconds,
        system_prompt=system_prompt,
    )
    report = test_rtl(
        task_name=task_name,
        testbench_path=testbench_path,
        testbench_top=testbench_top,
        rtl_path=run_dir / "generated.sv",
        power_testbench_path=power_testbench_path,
        power_testbench_top=power_testbench_top,
        timeout_seconds=timeout_seconds,
        run_dir=run_dir,
    )
    save_report(run_dir, report)
    return run_dir, report


POWER_TESTBENCHES = {
    "classroom_seq1011": ("classroom_seq1011", "tb_power_classroom_seq1011"),
    "homework_aes128": ("homework_aes128", "tb_power_homework_aes128"),
}


def _load_run_metadata(run_dir: Path) -> dict[str, Any]:
    metadata_path = run_dir / "metadata.json"
    if not metadata_path.is_file():
        raise FileNotFoundError(f"缺少实验记录：{metadata_path}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    required = ("task_name", "testbench_path", "testbench_top")
    missing = [key for key in required if not metadata.get(key)]
    if missing:
        raise ValueError(f"实验记录缺少必要字段：{', '.join(missing)}")
    return metadata


def _read_report(run_dir: Path) -> dict[str, Any]:
    report_path = run_dir / "test_report.json"
    return (
        json.loads(report_path.read_text(encoding="utf-8"))
        if report_path.is_file()
        else {}
    )


def _checked_rtl(run_dir: Path, metadata: dict[str, Any]) -> Path:
    rtl_path = _require_file(run_dir / "generated.sv", "RTL 文件")
    expected_hash = metadata.get("rtl_sha256")
    actual_hash = sha256_text(rtl_path.read_text(encoding="utf-8"))
    if expected_hash and expected_hash != actual_hash:
        raise ValueError("generated.sv 已被修改；请使用独立 RTL 路径测试或重新生成实验记录")
    return rtl_path


def _power_testbench(task_name: str) -> tuple[Path | None, str | None]:
    definition = POWER_TESTBENCHES.get(task_name)
    if definition is None:
        return None, None
    task_directory, power_testbench_top = definition
    return (
        TASKS_ROOT / task_directory / "power_tb.sv",
        power_testbench_top,
    )


def run_testbench(run_dir: Path) -> dict[str, Any]:
    """只运行功能教师 TB，并保留运行记录里已有的面积/功耗 metric。"""
    metadata = _load_run_metadata(run_dir)
    rtl_path = _checked_rtl(run_dir, metadata)
    report = test_rtl(
        task_name=metadata["task_name"],
        testbench_path=Path(metadata["testbench_path"]),
        testbench_top=metadata["testbench_top"],
        rtl_path=rtl_path,
        timeout_seconds=int(metadata.get("timeout_seconds", 20)),
        expected_cpu_level=metadata.get("expected_cpu_level"),
    )
    previous = _read_report(run_dir)
    if "metrics" in previous:
        report["metrics"] = previous["metrics"]
    save_report(run_dir, report)
    return report


def evaluate_metrics(run_dir: Path) -> dict[str, Any]:
    """只运行功耗活动采样与 Yosys/OpenSTA 评估，并保留已有 TB 结果。"""
    metadata = _load_run_metadata(run_dir)
    rtl_path = _checked_rtl(run_dir, metadata)
    timeout_seconds = int(metadata.get("timeout_seconds", 20))
    power_testbench_path, power_testbench_top = _power_testbench(metadata["task_name"])
    metrics: dict[str, Any]
    with tempfile.TemporaryDirectory(prefix="ai_eda_metrics_run_") as temp_dir:
        temp_path = Path(temp_dir)
        vcd_path = run_dir / "activity.vcd"
        if power_testbench_path is not None and power_testbench_top:
            try:
                resolved_testbench = _require_file(power_testbench_path, "功耗测试平台文件")
                executable = temp_path / "power_simulation.vvp"
                compile_result = subprocess.run(
                    [
                        "iverilog", "-g2012", *_cpu_feature_compile_flags(rtl_path), "-I", str(resolved_testbench.parent), "-s", power_testbench_top, "-o", str(executable),
                        str(resolved_testbench), str(rtl_path),
                    ],
                    text=True, capture_output=True, timeout=timeout_seconds, check=False,
                )
                if compile_result.returncode == 0:
                    subprocess.run(
                        ["vvp", str(executable), f"+vcd={vcd_path.resolve()}"],
                        text=True, capture_output=True, timeout=timeout_seconds, check=False,
                    )
                    metrics = synthesize_metrics(
                        rtl_path,
                        vcd_path=vcd_path,
                        vcd_scope=f"{power_testbench_top}/dut",
                    )
                else:
                    metrics = {
                        "status": "failed",
                        "reason": "功耗测试平台编译失败，无法采样活动。",
                        "stdout": compile_result.stdout[-4000:],
                        "stderr": compile_result.stderr[-4000:],
                    }
            except subprocess.TimeoutExpired:
                metrics = synthesize_metrics(rtl_path)
                metrics["power_status"] = "failed"
                metrics["power_reason"] = "功耗测试平台仿真超时，已回退为仅面积评估。"
        else:
            metrics = synthesize_metrics(rtl_path)
    report = _read_report(run_dir)
    report["metrics"] = metrics
    save_report(run_dir, report)
    return report


def retest_run(run_dir: Path) -> dict[str, Any]:
    """根据实验记录中的显式文件路径，重新执行自动验收。"""
    metadata = _load_run_metadata(run_dir)
    power_testbench_path, power_testbench_top = _power_testbench(metadata["task_name"])
    report = test_rtl(
        task_name=metadata["task_name"],
        testbench_path=Path(metadata["testbench_path"]),
        testbench_top=metadata["testbench_top"],
        rtl_path=run_dir / "generated.sv",
        power_testbench_path=power_testbench_path,
        power_testbench_top=power_testbench_top,
        timeout_seconds=int(metadata.get("timeout_seconds", 20)),
        run_dir=run_dir,
        expected_cpu_level=metadata.get("expected_cpu_level"),
    )
    save_report(run_dir, report)
    return report


def summarize_task(task_name: str) -> list[dict[str, Any]]:
    """汇总一个任务下各次实验的测试结果。"""
    task_run_root = RUNS_ROOT / task_name
    if not task_run_root.exists():
        return []
    summaries: list[dict[str, Any]] = []
    for run_dir in sorted(path for path in task_run_root.iterdir() if path.is_dir()):
        metadata_path = run_dir / "metadata.json"
        report_path = run_dir / "test_report.json"
        if not metadata_path.is_file():
            continue
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.is_file() else {}
        prompt_preview = ""
        prompt_path = run_dir / "prompt.md"
        if prompt_path.is_file():
            for line in prompt_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    prompt_preview = line.strip()
                    break
            if len(prompt_preview) > 80:
                prompt_preview = prompt_preview[:80] + "…"
        summaries.append(
            {
                "run_id": run_dir.name,
                "prompt_source": metadata.get("prompt_source"),
                "prompt_preview": prompt_preview,
                "model": metadata.get("model"),
                "thinking": metadata.get("thinking"),
                "passed": report.get("passed"),
                "stage": report.get("stage"),
            }
        )
    return summaries
