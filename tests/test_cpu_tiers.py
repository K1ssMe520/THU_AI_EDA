"""四个 RV32I 作业层级的注册表、Spec 与拆分 TB 文件一致性检查。"""

from pathlib import Path
import unittest

from ai_eda.agent.projects import get_project, list_projects
from ai_eda.config import TASKS_ROOT

ROOT = Path(__file__).resolve().parents[1]
TASK = TASKS_ROOT / "homework_rv32i5"


class CpuTierTests(unittest.TestCase):
    def test_four_tiers_are_registered_and_point_to_existing_specs(self):
        projects = {item["id"]: item for item in list_projects()}
        expected = {
            "rv32i5": 0,
            "rv32i5_cache": 1,
            "rv32i5_predict": 2,
            "rv32i5_ooo": 3,
        }
        for project_id, level in expected.items():
            self.assertIn(project_id, projects)
            project = get_project(project_id)
            self.assertEqual(project["expected_cpu_level"], level)
            self.assertTrue(project["spec_path"].is_file(), project["spec_path"])
            self.assertEqual(project["testbench_path"], TASK / "tb.sv")
            self.assertEqual(project["power_testbench_path"], TASK / "power_tb.sv")

    def test_advanced_specs_define_override_interface_and_capabilities(self):
        expected = {
            "cache.md": ("## A. 高级层统一接口", "3'b001"),
            "predict.md": ("## C. L2", "3'b011"),
            "ooo.md": ("## D. L3", "3'b111"),
        }
        for name, markers in expected.items():
            text = (TASK / "specs" / name).read_text(encoding="utf-8")
            self.assertIn("实现接口以 §A 为准", text)
            for marker in markers:
                self.assertIn(marker, text)

    def test_shared_tb_is_split_into_existing_include_files(self):
        entry = (TASK / "tb.sv").read_text(encoding="utf-8")
        self.assertIn('`include "tb/setup.svh"', entry)
        self.assertIn("module tb_homework_rv32i5", entry)
        self.assertIn("module tb_agent_rv32i5", entry)
        for name in (
            "setup.svh", "assembler.svh", "harness.svh", "base_alu.svh",
            "base_memory.svh", "base_control.svh", "dft.svh",
            "extensions.svh", "benchmarks.svh", "run.svh",
        ):
            self.assertTrue((TASK / "tb" / name).is_file(), name)
        self.assertIn("test_t13_dft", entry + (TASK / "tb" / "run.svh").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
