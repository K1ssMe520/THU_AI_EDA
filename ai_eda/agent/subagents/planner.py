"""RTL Planner 子 Agent：规划模块与文件结构。"""

from __future__ import annotations

import json

from .base import SubAgent
from .common import PLANNER_SYSTEM_PROMPT, extract_json_payload, validate_plan


class PlannerAgent(SubAgent):
    name = "planner"
    title = "02 · RTL Planner"
    node_type = "planner"

    def run(self, effective_spec: str) -> dict:
        prompt = (
            "根据下面的 Spec 规划 RTL 项目的模块与文件结构。每个模块必须能由一个文件独立实现；"
            "所有模块最终会一起用教师 TB 编译验收。\n\n"
            f"Spec：\n{effective_spec}\n\n"
            "请只返回约定的 JSON 对象。"
        )
        event = self.runtime.begin_event("planner", self.node_type, self.title, prompt)
        result = self.runtime.call_model(event, prompt, PLANNER_SYSTEM_PROMPT)
        try:
            plan = validate_plan(extract_json_payload(result.get("answer") or ""))
        except ValueError as error:
            raise ValueError(f"Planner 规划无效：{error}") from error
        self.save_context(spec=effective_spec, plan=plan)
        (self.runtime.run_dir / "plan.json").write_text(
            json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        self.runtime.write_handoff(
            "planner",
            "coder",
            plan,
            label="Planner → Coder：模块 / 文件计划",
        )
        self.finish(
            event,
            "info",
            response=json.dumps(plan, ensure_ascii=False, indent=2),
            reasoning=event.get("reasoning"),
            usage=event.get("usage"),
        )
        return plan
