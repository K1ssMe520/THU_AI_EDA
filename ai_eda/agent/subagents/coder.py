"""Coder 子 Agent：按计划逐文件生成 RTL。"""

from __future__ import annotations

import json
from pathlib import Path

from ai_eda.model.client import RTL_SYSTEM_PROMPT
from ai_eda.rtl.runner import extract_rtl

from .base import SubAgent
from .common import safe_project_path


class CoderAgent(SubAgent):
    name = "coder"
    title = "03 · Coder"
    node_type = "coder"

    def run(self, planner_handoff: Path) -> Path:
        incoming = self.runtime.read_handoff(planner_handoff)["payload"]
        artifacts = incoming.get("artifacts") or {}
        spec_ref = artifacts.get("spec")
        plan_ref = artifacts.get("plan")
        if not isinstance(spec_ref, str) or not isinstance(plan_ref, str):
            raise ValueError("Planner → Coder handoff 缺少 Spec 或 Plan artifact")
        effective_spec = self.runtime.read_text_artifact(spec_ref)
        plan = self.runtime.read_json_artifact(plan_ref)
        if not isinstance(plan, dict):
            raise ValueError("Plan artifact 格式无效")
        files: dict[str, str] = {}
        for module in plan["modules"]:
            prompt = (
                f"请实现项目中模块 `{module['name']}`，写入文件 `{module['file']}`。"
                "只输出该文件的完整 SystemVerilog RTL，不要输出 Markdown 围栏或解释。\n\n"
                "项目计划：\n"
                f"{json.dumps(plan, ensure_ascii=False, indent=2)}\n\n"
                f"Spec：\n{effective_spec}\n\n"
                f"本模块说明：{module['description']}\n{module['interfaces']}"
            )
            event = self.runtime.begin_event(
                "coder", self.node_type, f"{self.title} · {module['name']}", prompt
            )
            result = self.runtime.call_model(event, prompt, RTL_SYSTEM_PROMPT)
            rtl = extract_rtl(result.get("answer") or "")
            if not rtl.strip() or "module" not in rtl:
                raise ValueError(f"Coder 没有为 {module['name']} 生成有效 RTL")
            target = safe_project_path(self.runtime.run_dir, module["file"])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(rtl, encoding="utf-8")
            files[module["file"]] = rtl
            artifact_dir = self.runtime.run_dir / f"step-{event['step']:02d}-{event['node_id']}"
            (artifact_dir / "generated.sv").write_text(rtl, encoding="utf-8")
            self.save_context(plan_ref=plan_ref, last_file=self.runtime.artifact_ref(target))
            self.finish(
                event,
                "info",
                response=f"已写入 {module['file']}（{len(rtl)} 字符）。",
                rtl=rtl,
                reasoning=event.get("reasoning"),
                usage=event.get("usage"),
            )
        manifest = {
            "files": [
                {
                    "path": path,
                    "artifact": self.runtime.artifact_ref(
                        safe_project_path(self.runtime.run_dir, path)
                    ),
                    "bytes": len(content.encode("utf-8")),
                }
                for path, content in files.items()
            ]
        }
        manifest_ref = self.runtime.write_json_artifact("rtl_manifest.json", manifest)
        self.save_context(plan_ref=plan_ref, rtl_manifest_ref=manifest_ref)
        return self.runtime.write_handoff(
            "coder",
            "tester",
            {
                "artifacts": {
                    "spec": spec_ref,
                    "plan": plan_ref,
                    "rtl_manifest": manifest_ref,
                },
            },
            label="Coder → Tester：RTL manifest",
        )
