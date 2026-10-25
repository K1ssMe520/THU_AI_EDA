"""Parser 子 Agent：判断 Spec 是否充分，不充分时请求用户补充。"""

from __future__ import annotations

from pathlib import Path

from .base import SubAgent
from .common import MAX_PARSER_ROUNDS, PARSER_SYSTEM_PROMPT, extract_json_payload


class ParserAgent(SubAgent):
    name = "parser"
    title = "01 · Spec Parser"
    node_type = "parser"

    @staticmethod
    def _compose_spec(spec_base: str, supplements: list[str], addendum: str) -> str:
        """保留原 Spec，并追加用户补充与 Parser 补充/修正。"""
        parts = [spec_base.strip()]
        if supplements:
            parts.append("## 用户补充\n\n" + "\n\n".join(supplements))
        if addendum:
            parts.append("## Parser 补充与修正（优先于上文冲突内容）\n\n" + addendum)
        return "\n\n".join(part for part in parts if part)

    def run(self, input_handoff: Path) -> Path:
        incoming = self.runtime.read_handoff(input_handoff)["payload"]
        artifacts = incoming.get("artifacts") or {}
        spec_ref = artifacts.get("spec")
        if not isinstance(spec_ref, str):
            raise ValueError("Spec → Parser handoff 缺少 spec artifact")
        spec_base = self.runtime.read_text_artifact(spec_ref)
        supplements = list(self.context.get("supplements", []))
        addendum = str(self.context.get("addendum") or "")
        rounds = int(self.context.get("rounds", 0))
        while True:
            rounds += 1
            if rounds > MAX_PARSER_ROUNDS:
                raise ValueError("Spec 补充轮次超过限制，仍未得到充分规格")
            supplement_text = "\n\n".join(supplements) or "（无）"
            prompt = (
                "判断下面的数字电路设计 Spec 是否足以实现、编译并通过教师 TB，"
                "以及是否足以规划模块与文件结构。如果缺少端口、时序、复位、延迟、"
                "测试预期或文件结构等信息，请明确指出并向用户提问。\n\n"
                "固定 Spec：\n"
                f"{spec_base}\n\n"
                "用户补充：\n"
                f"{supplement_text}\n\n"
                "已有 Parser 补充/修正：\n"
                f"{addendum or '（无）'}\n\n"
                "请判断是否充分；只返回补充/修正，不要重写或缩短原 Spec。"
                "请只返回约定的 JSON 对象。"
            )
            event = self.runtime.begin_event("parser", self.node_type, self.title, prompt, rounds)
            result = self.runtime.call_model(event, prompt, PARSER_SYSTEM_PROMPT)
            try:
                parsed = extract_json_payload(result.get("answer") or "")
            except ValueError as error:
                raise ValueError(f"Parser 返回格式无效：{error}") from error
            missing = [str(item)[:500] for item in (parsed.get("missing") or []) if str(item).strip()]
            questions = [str(item)[:500] for item in (parsed.get("questions") or []) if str(item).strip()]
            sufficient = parsed.get("sufficient") is True and not missing and not questions
            # 兼容旧输出：refined_spec 只作为补充内容，不再替换原 Spec。
            addendum_value = parsed.get("spec_addendum")
            if not isinstance(addendum_value, str) or not addendum_value.strip():
                legacy = parsed.get("refined_spec")
                addendum_value = legacy if isinstance(legacy, str) else ""
            if addendum_value.strip():
                addendum = addendum_value.strip()
            effective_spec = self._compose_spec(spec_base, supplements, addendum)
            self.save_context(
                spec_ref=spec_ref,
                supplements=supplements,
                rounds=rounds,
                addendum=addendum,
                last_result={"sufficient": sufficient, "missing": missing, "questions": questions},
            )
            if sufficient:
                effective_spec_ref = self.runtime.write_text_artifact(
                    "effective_spec.md", effective_spec
                )
                parser_result_ref = self.runtime.write_json_artifact(
                    "parser_result.json",
                    {
                        "supplements": supplements,
                        "rounds": rounds,
                        "sufficient": True,
                    },
                )
                self.finish(
                    event,
                    "info",
                    response="Spec 充分，进入 RTL 规划。",
                    reasoning=event.get("reasoning"),
                    usage=event.get("usage"),
                )
                return self.runtime.write_handoff(
                    "parser",
                    "planner",
                    {
                        "artifacts": {
                            "spec": effective_spec_ref,
                            "parser_result": parser_result_ref,
                        },
                    },
                    label="Parser → Planner：冻结 Spec artifact",
                )
            if self.runtime.request_input is None:
                raise ValueError(
                    "Spec 需要用户补充，但当前运行没有交互输入通道："
                    + "；".join(missing or questions)
                )
            request = {
                "prompt": "Parser 判断 Spec 仍不充分，请补充以下信息：",
                "missing": missing,
                "questions": questions,
                "round": rounds,
            }
            self.runtime.mark_waiting(event, request)
            supplement = self.runtime.request_input(request)
            self.check_cancel()
            if not isinstance(supplement, str) or not supplement.strip():
                raise ValueError("用户没有提供有效的 Spec 补充内容")
            supplements.append(supplement.strip())
            effective_spec = self._compose_spec(spec_base, supplements, addendum)
            self.finish(
                event,
                "info",
                response="已收到用户补充：" + supplement.strip(),
                input_response=supplement.strip(),
            )
