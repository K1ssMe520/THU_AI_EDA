"""Coder 子 Agent：按计划逐文件生成 RTL。"""

from __future__ import annotations

import json

from ai_eda.model.client import RTL_SYSTEM_PROMPT
from ai_eda.rtl.runner import extract_rtl

from .base import SubAgent
from .common import safe_project_path


class CoderAgent(SubAgent):
    name = "coder"
    title = "03 · Coder"
    node_type = "coder"

    def run(self, effective_spec: str, plan: dict) -> dict:
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
            self.save_context(files=files, plan=plan)
            self.finish(
                event,
                "info",
                response=f"已写入 {module['file']}（{len(rtl)} 字符）。",
                rtl=rtl,
                reasoning=event.get("reasoning"),
                usage=event.get("usage"),
            )
        self.runtime.write_handoff(
            "coder",
            "tester",
            {
                "plan": plan,
                "files": files,
                "file_list": [
                    {"path": path, "bytes": len(content.encode("utf-8"))}
                    for path, content in files.items()
                ],
            },
            label="Coder → Tester：项目 RTL 文件",
        )
        return {"files": files}
