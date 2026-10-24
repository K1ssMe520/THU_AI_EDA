"""Tester 子 Agent：编译项目、运行教师 TB、评估面积 / 功耗。"""

from __future__ import annotations

from ai_eda.config import TASKS_ROOT
from ai_eda.rtl.runner import save_report, test_rtl

from .base import SubAgent
from .common import combine_files, report_feedback, report_summary

AGENT_TASK_DIR = TASKS_ROOT / "stream_filter"


class TesterAgent(SubAgent):
    name = "tester"
    title = "04 · Tester"
    node_type = "tester"

    def run(self, plan: dict, files: dict[str, str], attempt: int) -> dict:
        combined_path = self.runtime.run_dir / "generated.sv"
        combined_path.write_text(combine_files(files), encoding="utf-8")
        tester_dir = self.runtime.run_dir / f"tester-{attempt:02d}"
        tester_dir.mkdir(exist_ok=True)
        prompt = (
            f"第 {attempt} 轮测试：编译 {len(files)} 个项目文件并运行固定教师 TB，"
            "同时生成功耗活动与综合面积。"
        )
        event = self.runtime.begin_event(
            "tester", self.node_type, f"{self.title}（第 {attempt} 轮）", prompt, attempt
        )
        report = test_rtl(
            task_name="agent_stream_filter",
            testbench_path=AGENT_TASK_DIR / "tb.sv",
            testbench_top="tb_agent_stream_filter",
            rtl_path=combined_path,
            power_testbench_path=AGENT_TASK_DIR / "power_tb.sv",
            power_testbench_top="tb_power_agent_stream_filter",
            run_dir=tester_dir,
        )
        self.check_cancel()
        save_report(tester_dir, report)
        save_report(self.runtime.run_dir, report)
        self.save_context(
            attempts=int(self.context.get("attempts", 0)) + 1,
            plan=plan,
            files=files,
            last_report=report,
        )
        payload = {
            "attempt": attempt,
            "report": report,
            "summary": report_summary(report),
            "feedback": report_feedback(report),
            "file_list": [
                {"path": path, "bytes": len(content.encode("utf-8"))}
                for path, content in files.items()
            ],
        }
        if report.get("passed"):
            self.runtime.write_handoff(
                "tester",
                "summary",
                payload,
                attempt=attempt,
                label="Tester → Summary：最终验收结果",
            )
        else:
            self.runtime.write_handoff(
                "tester",
                "modifier",
                payload,
                attempt=attempt,
                label="Tester → Modifier：失败报告",
            )
        self.finish(
            event,
            "passed" if report.get("passed") else "failed",
            response=report_summary(report),
            report=report,
            feedback=report_feedback(report),
        )
        return report
