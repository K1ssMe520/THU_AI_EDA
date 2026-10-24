"""Parser 子 Agent：判断 Spec 是否充分，不充分时请求用户补充。"""

from __future__ import annotations

from .base import SubAgent
from .common import MAX_PARSER_ROUNDS, PARSER_SYSTEM_PROMPT, extract_json_payload


class ParserAgent(SubAgent):
    name = "parser"
    title = "01 · Spec Parser"
    node_type = "parser"

    def run(self, spec_base: str) -> dict:
        supplements = list(self.context.get("supplements", []))
        effective_spec = str(self.context.get("effective_spec") or spec_base)
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
            refined = parsed.get("refined_spec")
            sufficient = parsed.get("sufficient") is True and not missing and not questions
            if isinstance(refined, str) and refined.strip():
                effective_spec = refined.strip()
                if supplements:
                    effective_spec += "\n\n用户补充：\n" + "\n".join(supplements)
            self.save_context(
                spec_base=spec_base,
                supplements=supplements,
                rounds=rounds,
                effective_spec=effective_spec,
                last_result={"sufficient": sufficient, "missing": missing, "questions": questions},
            )
            if sufficient:
                self.finish(
                    event,
                    "info",
                    response="Spec 充分，进入 RTL 规划。",
                    reasoning=event.get("reasoning"),
                    usage=event.get("usage"),
                )
                self.runtime.write_handoff(
                    "parser",
                    "planner",
                    {
                        "effective_spec": effective_spec,
                        "supplements": supplements,
                        "parser_rounds": rounds,
                        "sufficient": True,
                    },
                    label="Parser → Planner：规范化 Spec",
                )
                return {
                    "effective_spec": effective_spec,
                    "supplements": supplements,
                    "rounds": rounds,
                }
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
            effective_spec = effective_spec + "\n\n用户补充：\n" + supplement.strip()
            self.finish(
                event,
                "info",
                response="已收到用户补充：" + supplement.strip(),
                input_response=supplement.strip(),
            )
