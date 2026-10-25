"""Modifier 子 Agent：根据 Tester 失败报告修改 RTL。"""

from __future__ import annotations

import json
from pathlib import Path

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

    def run(self, tester_handoff: Path, attempt: int) -> Path:
        incoming = self.runtime.read_handoff(tester_handoff)["payload"]
        artifacts = incoming.get("artifacts") or {}
        spec_ref = artifacts.get("spec")
        plan_ref = artifacts.get("plan")
        manifest_ref = artifacts.get("rtl_manifest")
        report_ref = artifacts.get("report")
        if not all(isinstance(ref, str) for ref in (spec_ref, plan_ref, manifest_ref, report_ref)):
            raise ValueError("Tester → Modifier handoff 缺少必需 artifact")
        effective_spec = self.runtime.read_text_artifact(spec_ref)
        plan = self.runtime.read_json_artifact(plan_ref)
        manifest = self.runtime.read_json_artifact(manifest_ref)
        report = self.runtime.read_json_artifact(report_ref)
        entries = manifest.get("files") if isinstance(manifest, dict) else None
        if not isinstance(plan, dict) or not isinstance(report, dict) or not isinstance(entries, list):
            raise ValueError("Modifier 输入 artifact 格式无效")
        files: dict[str, str] = {}
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not isinstance(entry.get("artifact"), str):
                raise ValueError("RTL manifest 含有无效文件引用")
            files[entry["path"]] = self.runtime.read_text_artifact(entry["artifact"])
        base_prompt = (
            "Tester 未通过。请根据失败报告修复当前 RTL 项目文件。"
            "只返回需要修改文件的 JSON（完整文件内容），不要改模块/文件结构。\n\n"
            f"项目计划：\n{json.dumps(plan, ensure_ascii=False, indent=2)}\n\n"
            f"当前文件：\n{json.dumps(files, ensure_ascii=False, indent=2)}\n\n"
            f"失败报告：\n{project_feedback(files, plan, report)}\n\n"
            f"Spec：\n{effective_spec}\n\n"
            "请只返回约定的 JSON 对象。"
        )
        event = self.runtime.begin_event(
            "modifier", self.node_type, f"{self.title}（第 {attempt} 轮）", base_prompt, attempt
        )
        payload: dict = {}
        changed: dict[str, str] = {}
        last_error: ValueError | None = None
        for parse_attempt in range(1, 3):
            prompt = base_prompt
            if parse_attempt > 1:
                prompt += (
                    "\n\n上一次输出不是合法的 Modifier JSON（"
                    f"{last_error}）。请严格只输出一个 JSON 对象，不要解释、Markdown 或多余文本。"
                )
                event["prompt"] = prompt
            result = self.runtime.call_model(event, prompt, MODIFIER_SYSTEM_PROMPT)
            try:
                payload = extract_json_payload(result.get("answer") or "")
                changed = validate_modifier_files(payload, plan)
                last_error = None
                break
            except ValueError as error:
                last_error = error
                event["modifier_validation_error"] = str(error)
                if parse_attempt < 2:
                    continue
        if last_error is not None:
            raise ValueError(
                f"Modifier 修复无效（连续 2 次未返回合法 JSON）：{last_error}"
            ) from last_error
        for relative, content in changed.items():
            target = safe_project_path(self.runtime.run_dir, relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            artifact_dir = self.runtime.run_dir / f"step-{event['step']:02d}-{event['node_id']}"
            (artifact_dir / "generated.sv").write_text(content, encoding="utf-8")
        notes = str(payload.get("notes") or "")
        files.update(changed)
        next_manifest_ref = self.runtime.write_json_artifact(
            f"rtl_manifest_attempt{attempt}.json",
            {
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
            },
        )
        self.save_context(
            attempts=int(self.context.get("attempts", 0)) + 1,
            plan_ref=plan_ref,
            rtl_manifest_ref=next_manifest_ref,
            report_ref=report_ref,
            notes=notes,
        )
        self.finish(
            event,
            "info",
            response=f"修改了 {len(changed)} 个文件：" + "、".join(changed),
            reasoning=event.get("reasoning"),
            usage=event.get("usage"),
        )
        return self.runtime.write_handoff(
            "modifier",
            "tester",
            {
                "attempt": attempt,
                "changed_paths": list(changed),
                "notes": notes,
                "artifacts": {
                    "spec": spec_ref,
                    "plan": plan_ref,
                    "rtl_manifest": next_manifest_ref,
                },
            },
            attempt=attempt,
            label="Modifier → Tester：更新后的 RTL manifest",
        )
