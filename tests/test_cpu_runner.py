"""CPU TB 的协议解析与多文件编译集成测试；不调用模型或综合工具。"""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from ai_eda.rtl.runner import (
    _cpu_feature_compile_flags,
    parse_cpu_testbench_output,
    parse_testbench_output,
    test_rtl,
)
from ai_eda.config import TASKS_ROOT


class CpuRunnerTests(unittest.TestCase):
    def test_structured_output_and_legacy_trace(self):
        output = "\n".join([
            "AI_EDA_TRACE|cycle=12|test=base|event=done",
            "CHECK: base — mismatch",
            "AI_EDA_CAPABILITY|level=2|verified_level=1|features=3",
            "AI_EDA_SUITE|name=base|passed=1|checks=15",
            "AI_EDA_SUITE|name=predictor|passed=0|checks=3",
            "AI_EDA_PERF|benchmark=integer_mix|cycles=125|instructions=100|checksum=17",
        ])
        trace, checks = parse_testbench_output(output)
        self.assertEqual(trace[0]["cycle"], 12)
        self.assertEqual(checks[0]["name"], "base")
        result = parse_cpu_testbench_output(output)
        self.assertEqual(result["cpu_capability"]["verified_level"], 1)
        self.assertFalse(result["test_suites"][1]["passed"])
        benchmark = result["performance"]["benchmarks"][0]
        self.assertEqual(benchmark["cpi"], 1.25)
        self.assertEqual(benchmark["ipc"], 0.8)
        self.assertEqual(parse_cpu_testbench_output("LAB_RESULT: PASS"), {})

    def test_only_real_rv32i5_feature_output_enables_interface(self):
        with tempfile.TemporaryDirectory() as directory:
            rtl = Path(directory) / "cpu.sv"
            for source in (
                "// output [2:0] dbg_features\nmodule rv32i5(output done); endmodule",
                "module other(output [2:0] dbg_features); endmodule\nmodule rv32i5(output done); endmodule",
                "module rv32i5(output done); wire [2:0] dbg_features; endmodule",
            ):
                rtl.write_text(source, encoding="utf-8")
                self.assertEqual(_cpu_feature_compile_flags(rtl), [])
            rtl.write_text("module rv32i5(output logic [2:0] dbg_features); endmodule", encoding="utf-8")
            self.assertEqual(_cpu_feature_compile_flags(rtl), ["-DRV32I_FEATURE_PORTS"])

    @unittest.skipUnless(shutil.which("iverilog") and shutil.which("vvp"), "Icarus Verilog unavailable")
    def test_include_macro_plusarg_and_report_integration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tb = root / "tb.sv"
            rtl = root / "cpu.sv"
            (root / "body.svh").write_text(
                'initial begin\n'
                'if (!$value$plusargs("expected_cpu_level=%d", expected)) $fatal(1);\n'
                'if (expected != 2) $fatal(1);\n'
                '$display("AI_EDA_CAPABILITY|level=2|verified_level=2");\n'
                '$display("AI_EDA_SUITE|name=cache|passed=1|checks=4");\n'
                '$display("AI_EDA_PERF|benchmark=smoke|cycles=50|instructions=25");\n'
                '$finish; end\n', encoding="utf-8")
            tb.write_text(
                'module tb; integer expected;\n'
                '`ifndef RV32I_FEATURE_PORTS\ninitial $fatal(1, "missing feature macro");\n`endif\n'
                '`include "body.svh"\nendmodule\n', encoding="utf-8")
            rtl.write_text("module rv32i5(output logic [2:0] dbg_features); assign dbg_features = 3; endmodule", encoding="utf-8")
            report = test_rtl(task_name="cpu_smoke", testbench_path=tb, testbench_top="tb", rtl_path=rtl, expected_cpu_level=2)
            self.assertTrue(report["passed"], report.get("stderr"))
            self.assertEqual(report["cpu_capability"]["expected_level"], 2)
            self.assertEqual(report["performance"]["benchmarks"][0]["cpi"], 2)

    @unittest.skipUnless(shutil.which("iverilog"), "Icarus Verilog unavailable")
    def test_shared_cpu_harness_accepts_legacy_and_extended_interfaces(self):
        base_ports = (
            "input clk, input rst_n, output [31:0] imem_addr, input [31:0] imem_rdata, "
            "output dmem_valid, output dmem_we, output [31:0] dmem_addr, "
            "output [31:0] dmem_wdata, output [3:0] dmem_be, input [31:0] dmem_rdata, "
            "input [4:0] dbg_reg_addr, output [31:0] dbg_reg_data, output halted, output [31:0] exit_code"
        )
        extra_ports = (
            ", output imem_valid, input imem_ready, input dmem_ready, output [2:0] dbg_features, "
            "output dbg_retire_valid, output [31:0] dbg_retire_pc, output [31:0] dbg_retire_insn, "
            "output dbg_bp_resolve, output dbg_bp_mispredict, output dbg_ooo_issue, output dbg_ooo_bypass"
        )
        directory = TASKS_ROOT / "homework_rv32i5"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for advanced in (False, True):
                rtl = root / "cpu.sv"
                rtl.write_text(f"module rv32i5({base_ports}{extra_ports if advanced else ''}); endmodule\n", encoding="utf-8")
                for filename, top in (("tb.sv", "tb_agent_rv32i5"), ("power_tb.sv", "tb_power_agent_rv32i5")):
                    command = ["iverilog", "-g2012", *_cpu_feature_compile_flags(rtl), "-I", str(directory), "-s", top, "-o", str(root / "sim.vvp"), str(directory / filename), str(rtl)]
                    result = subprocess.run(command, text=True, capture_output=True, timeout=20, check=False)
                    self.assertEqual(result.returncode, 0, f"advanced={advanced}, {filename}: {result.stderr}")


if __name__ == "__main__":
    unittest.main()
