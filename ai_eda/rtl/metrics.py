"""基于 Yosys 映射与 OpenROAD/OpenSTA 的面积和功耗估算。"""

from __future__ import annotations

import importlib.util
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


def _top_module(rtl_path: Path) -> str:
    match = re.search(r"\bmodule\s+([A-Za-z_]\w*)\s*\(", rtl_path.read_text(encoding="utf-8"))
    if not match:
        raise ValueError("无法从 RTL 中确定顶层模块名")
    return match.group(1)


def _library_path() -> Path | None:
    if importlib.util.find_spec("vpadanalyzer") is None:
        return None
    from vpadanalyzer import config

    return Path(config.__file__).with_name("gscl45nm.lib")


def _sta_executable() -> str | None:
    """优先使用本项目安装的独立 OpenSTA，再接受用户 PATH 中的 sta。"""
    local_sta = Path(__file__).resolve().parents[2] / ".tools" / "opensta" / "bin" / "sta"
    if local_sta.is_file() and local_sta.stat().st_mode & 0o111:
        return str(local_sta)
    return shutil.which("sta")


def _sta_safe_netlist(netlist_path: Path) -> Path:
    """把 Yosys 网表转换成 OpenSTA 的 Verilog 解析器能接受的写法。

    Yosys 会把模块内 function 的局部变量写成带源文件路径的转义标识符
    （例如 ``\\func$1/path/file.sv:12$3.c``），并给整型循环变量生成
    ``wire signed``。OpenSTA 的解析器对这两类写法都不兼容。这里统一把
    转义标识符重命名为 ``\\esc_N``，并去掉网表内部的 ``signed`` 关键字；
    标准单元网表本身不依赖有符号性，因此不影响功耗分析。
    """
    text = netlist_path.read_text(encoding="utf-8")
    rename: dict[str, str] = {}

    def replace_identifier(match: re.Match[str]) -> str:
        token = match.group(0)
        if token not in rename:
            rename[token] = f"\\esc_{len(rename)} "
        return rename[token]

    text = re.sub(r"\\[^\s]+", replace_identifier, text)
    text = re.sub(r"\b(wire|reg)\s+signed\b", r"\1", text)
    safe_path = netlist_path.with_name("mapped_sta.v")
    safe_path.write_text(text, encoding="utf-8")
    return safe_path


def _mapped_netlist(rtl_path: Path, library_path: Path, top_module: str, work_dir: Path) -> tuple[Path, float]:
    """将 RTL 映射为标准单元网表，并返回 Liberty 面积。"""
    netlist_path = work_dir / "mapped.v"
    script_path = work_dir / "synth.ys"
    script_path.write_text(
        "\n".join(
            (
                f'read_verilog -sv "{rtl_path.resolve()}"',
                f"hierarchy -check -top {top_module}",
                "proc; opt; fsm; opt; memory; opt",
                "techmap; opt",
                f'dfflibmap -liberty "{library_path}"',
                f'abc -liberty "{library_path}"',
                f'stat -liberty "{library_path}"',
                f'write_verilog -noattr "{netlist_path}"',
            )
        )
        + "\n",
        encoding="utf-8",
    )
    result = subprocess.run(["yosys", "-s", str(script_path)], text=True, capture_output=True, check=False)
    output = result.stdout + result.stderr
    match = re.search(r"Chip area for module '\\?[^']+':\s*([0-9.]+)", output)
    if result.returncode != 0 or match is None or not netlist_path.is_file():
        raise RuntimeError(f"Yosys 未能完成标准单元映射。\n{output[-4000:]}")
    return _sta_safe_netlist(netlist_path), float(match.group(1))


def _parse_power_report(report: str) -> dict[str, float] | None:
    """解析 OpenSTA `report_power` 的总计行；单位由 OpenSTA 固定为 W。"""
    matches = re.findall(
        r"(?im)^\s*total\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)(?:\s+[0-9.eE+-]+%)?\s*$",
        report,
    )
    if not matches:
        return None
    internal, switching, leakage, total = (float(value) for value in matches[-1])
    return {
        "internal_power_w": internal,
        "switching_power_w": switching,
        "dynamic_power_w": internal + switching,
        "leakage_power_w": leakage,
        "total_power_w": total,
    }


def synthesize_metrics(
    rtl_path: Path,
    *,
    vcd_path: Path | None = None,
    vcd_scope: str | None = None,
    top_module: str | None = None,
) -> dict[str, Any]:
    """评估映射面积，并在有 OpenROAD 和 VCD 时估算活动相关功耗。

    面积来自 Yosys 对同一 Liberty 的技术映射；功耗由独立 OpenSTA 读取
    门级网表、Liberty、SDC 与 VCD 后以瓦特报告。没有 LEF/DEF
    或 SPEF 时，这是前布局、无寄生参数的估算，而不是签核结果。
    """
    if shutil.which("yosys") is None:
        return {"status": "unavailable", "reason": "未找到 yosys；无法生成门级网表。"}
    library_path = _library_path()
    if library_path is None:
        return {"status": "unavailable", "reason": "未安装 verilog-pad-analyzer 的 Liberty 库。"}
    if not rtl_path.is_file():
        return {"status": "unavailable", "reason": f"RTL 不存在：{rtl_path}"}

    if top_module is not None and not re.fullmatch(r"[A-Za-z_]\w*", top_module):
        raise ValueError("RTL 顶层模块名无效")
    top_module = top_module or _top_module(rtl_path)
    with tempfile.TemporaryDirectory(prefix="ai_eda_metrics_") as temp_dir:
        work_dir = Path(temp_dir)
        try:
            netlist_path, area = _mapped_netlist(rtl_path, library_path, top_module, work_dir)
        except RuntimeError as error:
            return {"status": "failed", "reason": str(error)}

        metrics: dict[str, Any] = {
            "status": "area_only",
            "library": library_path.name,
            "top_module": top_module,
            "area": area,
            "area_unit": "library area units (gscl45nm)",
            "power_status": "unavailable",
            "power_reason": "需要 OpenSTA、VCD 活动文件与时钟约束。",
            "power_method": "OpenSTA gate-level VCD estimate",
        }
        sta = _sta_executable()
        if sta is None:
            metrics["power_reason"] = "未找到 sta；安装 OpenSTA 后重新运行 retest。"
            return metrics
        if vcd_path is None or not vcd_path.is_file() or not vcd_scope:
            metrics["power_reason"] = "未生成 VCD 活动文件；请重新运行带教师 TB 的实验。"
            return metrics

        sdc_path = work_dir / "clock.sdc"
        # 教师 TB 使用 10 ns 周期；后续可将时钟周期做成任务元数据。
        sdc_path.write_text("create_clock -name clk -period 10 [get_ports clk]\n", encoding="utf-8")
        script_path = work_dir / "power.tcl"
        script_path.write_text(
            "\n".join(
                (
                    f'read_liberty "{library_path}"',
                    f'read_verilog "{netlist_path}"',
                    f"link_design {top_module}",
                    f'read_sdc "{sdc_path}"',
                    f'read_vcd -scope {vcd_scope} "{vcd_path.resolve()}"',
                    "report_power",
                )
            )
            + "\n",
            encoding="utf-8",
        )
        result = subprocess.run([sta, "-exit", str(script_path)], text=True, capture_output=True, check=False)
        output = result.stdout + result.stderr
        power = _parse_power_report(output)
        if result.returncode != 0 or power is None:
            metrics.update({
                "power_status": "failed",
                "power_reason": "OpenSTA 未能完成 VCD 功耗分析。",
                "opensta_output": output[-4000:],
            })
            return metrics
        metrics.update(power)
        metrics.update({"status": "ok", "power_status": "ok", "power_reason": None, "vcd_scope": vcd_scope})
        return metrics


def synthesize_area(rtl_path: Path) -> dict[str, Any]:
    """兼容旧调用；新代码应使用 :func:`synthesize_metrics`。"""
    return synthesize_metrics(rtl_path)
