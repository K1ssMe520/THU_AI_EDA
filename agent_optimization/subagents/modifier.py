"""Modifier 子 Agent：根据 Tester 失败报告修改 RTL。"""

from __future__ import annotations

import json

from .base import SubAgent
from .common import (
    MODIFIER_SYSTEM_PROMPT,
    extract_json_payload,
    project_feedback,
    safe_project_path,
    validate_modifier_files,
)


class ModifierAgent(SubAgent):
    name = "modifier"
    title = "05 · Modifier"
    node_type = "modifier"

    def run(
        self,
        effective_spec: str,
        plan: dict,
        files: dict[str, str],
        report: dict,
        attempt: int,
    ) -> dict[str, str]:
        prompt = (
            "Tester 未通过。请根据失败报告修复当前 RTL 项目文件。"
            "只返回需要修改文件的 JSON（完整文件内容），不要改模块/文件结构。\n\n"
            f"项目计划：\n{json.dumps(plan, ensure_ascii=False, indent=2)}\n\n"
            f"当前文件：\n{json.dumps(files, ensure_ascii=False, indent=2)}\n\n"
            f"失败报告：\n{project_feedback(files, plan, report)}\n\n"
            f"Spec：\n{effective_spec}\n\n"
            "请只返回约定的 JSON 对象。"
        )
        event = self.runtime.begin_event(
            "modifier", self.node_type, f"{self.title}（第 {attempt} 轮）", prompt, attempt
        )
        result = self.runtime.call_model(event, prompt, MODIFIER_SYSTEM_PROMPT)
        try:
            changed = validate_modifier_files(
                extract_json_payload(result.get("answer") or ""), plan
            )
        except ValueError as error:
            raise ValueError(f"Modifier 修复无效：{error}") from error
        for relative, content in changed.items():
            target = safe_project_path(self.runtime.run_dir, relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            artifact_dir = self.runtime.run_dir / f"step-{event['step']:02d}-{event['node_id']}"
            (artifact_dir / "generated.sv").write_text(content, encoding="utf-8")
        notes = ""
        try:
            notes = str(extract_json_payload(result.get("answer") or "").get("notes") or "")
        except ValueError:
            pass
        self.save_context(
            attempts=int(self.context.get("attempts", 0)) + 1,
            plan=plan,
            files=changed,
            notes=notes,
        )
        self.runtime.write_handoff(
            "modifier",
            "tester",
            {
                "attempt": attempt,
                "changed_files": changed,
                "changed_paths": list(changed),
                "notes": notes,
            },
            attempt=attempt,
            label="Modifier → Tester：修复后的 RTL 文件",
        )
        self.finish(
            event,
            "info",
            response=f"修改了 {len(changed)} 个文件：" + "、".join(changed),
            reasoning=event.get("reasoning"),
            usage=event.get("usage"),
        )
        return changed
