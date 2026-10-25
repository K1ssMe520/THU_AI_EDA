"""Tester 子 Agent：编译项目、运行教师 TB、评估面积 / 功耗。"""

from __future__ import annotations

from pathlib import Path

from ai_eda.agent.projects import get_project
from ai_eda.rtl.runner import save_report, test_rtl

from .base import SubAgent
from .common import combine_files, report_feedback, report_summary



class TesterAgent(SubAgent):
    name = "tester"
    title = "04 · Tester"
    node_type = "tester"

    def run(self, input_handoff: Path, attempt: int) -> Path:
        incoming = self.runtime.read_handoff(input_handoff)["payload"]
        artifacts = incoming.get("artifacts") or {}
        spec_ref = artifacts.get("spec")
        plan_ref = artifacts.get("plan")
        manifest_ref = artifacts.get("rtl_manifest")
        if not all(isinstance(ref, str) for ref in (spec_ref, plan_ref, manifest_ref)):
            raise ValueError("Tester 输入缺少 Spec、Plan 或 RTL manifest artifact")
        plan = self.runtime.read_json_artifact(plan_ref)
        manifest = self.runtime.read_json_artifact(manifest_ref)
        if not isinstance(plan, dict):
            raise ValueError("Plan artifact 格式无效")
        entries = manifest.get("files") if isinstance(manifest, dict) else None
        if not isinstance(entries, list) or not entries:
            raise ValueError("RTL manifest 格式无效")
        files: dict[str, str] = {}
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not isinstance(entry.get("artifact"), str):
                raise ValueError("RTL manifest 含有无效文件引用")
            files[entry["path"]] = self.runtime.read_text_artifact(entry["artifact"])
        combined_ref = self.runtime.write_text_artifact(
            f"generated_attempt{attempt}.sv", combine_files(files)
        )
        combined_path = self.runtime.run_dir / combined_ref
        tester_dir = self.runtime.run_dir / f"tester-{attempt:02d}"
        tester_dir.mkdir(exist_ok=True)
        prompt = (
            f"第 {attempt} 轮测试：编译 {len(files)} 个项目文件并运行固定教师 TB，"
            "同时生成功耗活动与综合面积。"
        )
        event = self.runtime.begin_event(
            "tester", self.node_type, f"{self.title}（第 {attempt} 轮）", prompt, attempt
        )
        project = self.runtime.options.get("project") or get_project()
        report = test_rtl(
            task_name=project["task_name"],
            testbench_path=project["testbench_path"],
            testbench_top=project["testbench_top"],
            rtl_path=combined_path,
            power_testbench_path=project["power_testbench_path"],
            power_testbench_top=project["power_testbench_top"],
            expected_cpu_level=project.get("expected_cpu_level"),
            rtl_top_module=plan.get("top_module"),
            timeout_seconds=int(project.get("timeout_seconds", 20)),
            run_dir=tester_dir,
        )
        self.check_cancel()
        report_path = save_report(tester_dir, report)
        self.save_context(
            attempts=int(self.context.get("attempts", 0)) + 1,
            plan_ref=plan_ref,
            rtl_manifest_ref=manifest_ref,
        )
        report_ref = self.runtime.artifact_ref(report_path)
        self.finish(
            event,
            "passed" if report.get("passed") else "failed",
            response=report_summary(report),
            report=report,
            feedback=report_feedback(report),
        )
        target = "summary" if report.get("passed") else "modifier"
        label = "Tester → Summary：最终验收报告 artifact" if report.get("passed") else "Tester → Modifier：失败报告 artifact"
        return self.runtime.write_handoff(
            "tester",
            target,
            {
                "attempt": attempt,
                "summary": report_summary(report),
                "artifacts": {
                    "spec": spec_ref,
                    "plan": plan_ref,
                    "rtl_manifest": manifest_ref,
                    "report": report_ref,
                    "combined_rtl": combined_ref,
                },
            },
            attempt=attempt,
            label=label,
        )
